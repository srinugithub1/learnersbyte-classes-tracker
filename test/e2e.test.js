/**
 * End-to-end test against a RUNNING server and the real Supabase database.
 *
 *   node server.js            (in one terminal)
 *   node test/e2e.test.js     (in another)
 *
 * Creates throwaway accounts and a batch prefixed "E2E"/"e2e-", exercises every
 * route, then deletes everything it made. Safe to run against a live project.
 */

const BASE = process.env.BASE || 'http://localhost:3000';

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? ` — ${extra}` : ''}`); }
};
const section = (t) => console.log(`\n== ${t} ==`);

function report() {
  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exitCode = fail ? 1 : 0;
}

/** A tiny cookie-aware fetch, one jar per "browser". */
function browser() {
  let cookie = '';
  return async function call(pathname, { method = 'GET', body } = {}) {
    const res = await fetch(BASE + pathname, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'manual',
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const text = await res.text();
    let data = null;
    if (text) { try { data = JSON.parse(text); } catch { data = text; } }
    return { status: res.status, data };
  };
}

const stamp = Date.now();
const studentEmail = `e2e-student-${stamp}@example.test`;
const otherEmail = `e2e-other-${stamp}@example.test`;
const batchName = `E2E Batch ${stamp}`;
const pad = (n) => String(n).padStart(2, '0');

/**
 * Today on the *server's* clock. toISOString() is UTC, so before 05:30 in
 * Asia/Calcutta it names yesterday and an override would land on the wrong day.
 */
function localToday() {
  const n = new Date();
  return `${n.getFullYear()}-${pad(n.getMonth() + 1)}-${pad(n.getDate())}`;
}

(async function run() {
  const anon = browser();
  const student = browser();
  const other = browser();
  const admin = browser();

  /* ------------------------------------------------------------ reachable */
  section('server');
  const health = await anon('/api/auth/me');
  if (health.status !== 200) {
    console.error(`\n  Cannot reach ${BASE} — start the server first (node server.js).\n`);
    process.exitCode = 1;
    return;
  }
  ok('server is up and reports no session', health.data.user === null);

  /* --------------------------------------------------------------- signup */
  section('signup and login');
  let res = await student('/api/auth/signup', {
    method: 'POST',
    body: { name: 'E2E Student', email: studentEmail, phone: '9876543210',
      password: 'Secret123', confirmPassword: 'Secret123' },
  });
  ok('student can sign up', res.status === 201, JSON.stringify(res.data));
  const studentId = res.data.user && res.data.user.id;
  ok('signup returns a reg. no.', Boolean(res.data.user && res.data.user.regNo));
  ok('password hash is never returned', !JSON.stringify(res.data).includes('scrypt$'));

  res = await anon('/api/auth/signup', {
    method: 'POST',
    body: { name: 'Dupe', email: studentEmail, phone: '9876543210',
      password: 'Secret123', confirmPassword: 'Secret123' },
  });
  ok('duplicate email is refused', res.status === 409);

  res = await anon('/api/auth/signup', {
    method: 'POST',
    body: { name: 'Weak', email: `e2e-weak-${stamp}@example.test`, phone: '9876543210',
      password: 'abc', confirmPassword: 'abc' },
  });
  ok('weak password is refused', res.status === 400);

  res = await anon('/api/auth/login', { method: 'POST', body: { email: studentEmail, password: 'WRONG' } });
  ok('wrong password is refused', res.status === 401);
  ok('login error does not reveal whether the email exists', /incorrect/i.test(res.data.error || ''));

  res = await student('/api/auth/me');
  ok('session cookie keeps the student logged in', res.data.user && res.data.user.email === studentEmail);

  /* ---------------------------------------------------------- access ctrl */
  section('access control');
  res = await anon('/api/student/dashboard');
  ok('anonymous cannot read a dashboard', res.status === 401);
  res = await anon('/api/admin/overview');
  ok('anonymous cannot read admin data', res.status === 401);
  res = await student('/api/admin/overview');
  ok('a student cannot read admin data', res.status === 403);
  res = await student('/api/admin/students');
  ok('a student cannot list all students', res.status === 403);

  /* --------------------------------------------------------------- admin */
  section('batches (teacher-managed)');
  const adminEmail = process.env.ADMIN_EMAIL || 'teacher@udayan.local';
  const adminPassword = process.env.ADMIN_PASSWORD || 'Teach1234';
  res = await admin('/api/auth/login', { method: 'POST', body: { email: adminEmail, password: adminPassword } });
  ok('admin can log in', res.status === 200, JSON.stringify(res.data));
  if (res.status !== 200) {
    console.error('\n  Cannot continue without an admin login. Check ADMIN_EMAIL / ADMIN_PASSWORD in .env.\n');
    report();
    return;
  }
  ok('admin role is correct', res.data.user.role === 'admin');

  const now = new Date();
  const todayDow = now.getDay();

  // A window around "right now" that never crosses midnight — class times are
  // times of day, so 23:50 + 55 min would wrap to 00:45 and read as backwards.
  const nowMins = now.getHours() * 60 + now.getMinutes();
  const startMins = Math.max(0, nowMins - 5);
  const endMins = Math.max(Math.min(1439, nowMins + 55), startMins + 10);
  const clock = (mins) => `${pad(Math.floor(Math.min(mins, 1439) / 60))}:${pad(Math.min(mins, 1439) % 60)}`;

  res = await admin('/api/admin/batches', {
    method: 'POST',
    body: { name: batchName, course: 'E2E Course',
      classStart: clock(startMins), classEnd: clock(endMins), classDays: [todayDow] },
  });
  ok('admin can create a batch', res.status === 201, JSON.stringify(res.data));
  const batchId = res.data.batch && res.data.batch.id;

  res = await admin('/api/admin/batches', {
    method: 'POST',
    body: { name: batchName, course: 'Dup', classStart: '10:00', classEnd: '11:00', classDays: [1] },
  });
  ok('duplicate batch name is refused', res.status === 409);

  res = await admin('/api/admin/batches', {
    method: 'POST',
    body: { name: `E2E Backwards ${stamp}`, course: 'X',
      classStart: '11:00', classEnd: '10:00', classDays: [1] },
  });
  ok('end-before-start is refused', res.status === 400);

  res = await admin('/api/admin/batches', {
    method: 'POST',
    body: { name: `E2E Nodays ${stamp}`, course: 'X',
      classStart: '10:00', classEnd: '11:00', classDays: [] },
  });
  ok('a batch with no class days is refused', res.status === 400);

  res = await student('/api/admin/batches', {
    method: 'POST',
    body: { name: 'hack', course: 'x', classStart: '10:00', classEnd: '11:00', classDays: [1] },
  });
  ok('a student cannot create a batch', res.status === 403);

  /* -------------------------------------------------- student picks batch */
  section('student picks a batch');
  res = await student('/api/student/dashboard');
  ok('new student has no batch yet', res.data.user.batchId === null);
  ok('cannot mark before a batch is chosen', res.data.window.canMark === false);
  ok('the batch list is offered', Array.isArray(res.data.batches) && res.data.batches.length >= 1);
  ok('grace is reported as 15 minutes', res.data.graceMinutes === 15);

  // Daily marking can be switched off (ATTENDANCE_ENABLED=false). When it is,
  // the server refuses every mark, so these assertions would fail for a reason
  // that is not a bug — report them as skipped instead of red.
  const MARKING_ON = res.data.features ? res.data.features.attendance !== false : true;
  if (!MARKING_ON) {
    console.log('  --    attendance marking is switched off; skipping the marking checks');
  }

  res = await student('/api/student/attendance', { method: 'POST' });
  if (MARKING_ON) ok('marking without a batch is refused', res.status === 409);
  else ok('marking is refused while it is switched off', res.status === 403, `got ${res.status}`);

  res = await student('/api/student/profile', { method: 'POST', body: { batchId } });
  ok('student can join a batch', res.status === 200, JSON.stringify(res.data));
  ok('the batch timetable comes with it',
    Boolean(res.data.user.batch) && res.data.user.batch.course === 'E2E Course');

  res = await student('/api/student/profile', { method: 'POST', body: { batchId } });
  ok('student cannot switch batch themselves', res.status === 409);

  res = await student('/api/admin/batches/update', {
    method: 'POST', body: { id: batchId, classStart: '01:00', classEnd: '02:00' },
  });
  ok('a student cannot edit the batch timetable', res.status === 403);

  /* ---------------------------------------------------------- attendance */
  section('attendance');
  if (MARKING_ON) {
    res = await student('/api/student/attendance', { method: 'POST' });
    ok('student can mark attendance', res.status === 201, JSON.stringify(res.data));
    const firstStatus = res.data.record && res.data.record.status;
    ok('status is present within the 15 min grace', firstStatus === 'present', `got ${firstStatus}`);

    res = await student('/api/student/attendance', { method: 'POST' });
    ok('second click does not create a second record', res.data.already === true);
    ok('duplicate returns the original status', res.data.record.status === firstStatus);

    res = await student('/api/student/dashboard');
    ok('dashboard shows today as marked', res.data.todayMark !== null);
    ok('report counts one present day', res.data.report.present === 1);
    ok('report shows 100%', res.data.report.percent === 100);
  } else {
    // Marking is switched off. Prove the switch holds, then let the teacher
    // record the day so the rest of the run has something to report on.
    res = await student('/api/student/attendance', { method: 'POST' });
    ok('a student cannot mark while it is switched off', res.status === 403, `got ${res.status}`);
    ok('and is told why', /paused/i.test(res.data.error || ''), res.data.error);

    res = await admin('/api/admin/attendance', {
      method: 'POST', body: { userId: studentId, date: localToday(), status: 'present' },
    });
    ok('but the teacher can still record it', res.status === 200, JSON.stringify(res.data));

    res = await student('/api/student/dashboard');
    ok('and the student sees it', res.data.todayMark !== null);
    ok('report counts one present day', res.data.report.present === 1);
  }

  /* --------------------------------------------------------------- admin */
  section('admin');
  res = await admin('/api/admin/overview');
  ok('admin sees the overview', res.status === 200);
  ok('overview includes our student', res.data.rows.some((r) => r.student.email === studentEmail));
  const row = res.data.rows.find((r) => r.student.email === studentEmail);
  ok('student shows as present today', Boolean(row) && row.today.status === 'present');
  ok('overview carries the batch name', Boolean(row) && row.student.batchName === batchName);

  res = await admin('/api/admin/students?search=e2e-student');
  ok('admin can search students', res.data.students.length >= 1);
  ok('search results carry no password hash', !JSON.stringify(res.data).includes('scrypt$'));

  res = await admin(`/api/admin/students?batchId=${batchId}`);
  ok('admin can filter students by batch', res.data.students.length === 1);

  res = await admin('/api/admin/attendance', {
    method: 'POST',
    body: { userId: studentId, date: localToday(), status: 'late' },
  });
  ok('admin can override a status', res.status === 200);

  res = await student('/api/student/dashboard');
  ok('override is visible to the student', res.data.todayMark.status === 'late');
  ok('override is attributed to the teacher', res.data.todayMark.source === 'admin');

  res = await admin('/api/admin/attendance', {
    method: 'POST', body: { userId: studentId, date: '2099-01-01', status: 'present' },
  });
  ok('future dates are refused', res.status === 400);

  res = await admin('/api/admin/student/update', {
    method: 'POST', body: { id: studentId, name: 'E2E Student Renamed' },
  });
  ok('admin can edit a student', res.status === 200 && res.data.student.name === 'E2E Student Renamed');

  res = await admin(`/api/admin/student?id=${studentId}`);
  ok('admin can open one student record', res.status === 200 && res.data.report !== undefined);

  res = await admin('/api/admin/log');
  ok('activity log lists records', Array.isArray(res.data.entries) && res.data.entries.length >= 1);

  const csv = await admin('/api/admin/export.csv');
  ok('CSV export works', csv.status === 200 && String(csv.data).startsWith('"Reg. No."'));
  ok('CSV contains our student', String(csv.data).includes('E2E Student Renamed'));
  ok('CSV carries the batch name', String(csv.data).includes(batchName));

  /* --------------------------------------------------------- batch admin */
  section('batch management');
  res = await admin('/api/admin/batches');
  ok('admin lists batches with student counts',
    res.data.batches.some((b) => b.id === batchId && b.studentCount === 1));

  res = await admin('/api/admin/batches/update', {
    method: 'POST', body: { id: batchId, course: 'E2E Course Renamed' },
  });
  ok('admin can edit a batch', res.status === 200 && res.data.batch.course === 'E2E Course Renamed');

  res = await student('/api/student/dashboard');
  ok('the edit reaches the student straight away', res.data.user.batch.course === 'E2E Course Renamed');

  res = await admin('/api/admin/student/batch', {
    method: 'POST', body: { userId: studentId, batchId: null },
  });
  ok('admin can remove a student from a batch', res.status === 200 && res.data.student.batchId === null);

  res = await student('/api/student/dashboard');
  ok('a student with no batch cannot mark', res.data.window.canMark === false);

  res = await admin('/api/admin/student/batch', {
    method: 'POST', body: { userId: studentId, batchId },
  });
  ok('admin can move a student back in', res.status === 200 && res.data.student.batchId === batchId);

  /* ----------------------------------------------------- forgot password */
  section('forgot password');
  res = await other('/api/auth/signup', {
    method: 'POST',
    body: { name: 'E2E Other', email: otherEmail, phone: '9812345678',
      password: 'Secret123', confirmPassword: 'Secret123' },
  });
  const otherId = res.data.user && res.data.user.id;

  res = await anon('/api/auth/forgot', { method: 'POST', body: { email: otherEmail } });
  ok('forgot request succeeds', res.status === 200);
  const link = res.data.resetUrl || '';
  const token = link.split('token=')[1] || '';
  ok('a reset link is produced', Boolean(token));

  res = await anon('/api/auth/forgot', { method: 'POST', body: { email: 'nobody-here@example.test' } });
  ok('unknown email gives the same answer (no account probing)', res.status === 200 && !res.data.resetUrl);

  res = await anon('/api/auth/reset', {
    method: 'POST', body: { token: 'wrong-token', password: 'NewPass123', confirmPassword: 'NewPass123' },
  });
  ok('a bad token is refused', res.status === 400);

  res = await anon('/api/auth/reset', {
    method: 'POST', body: { token, password: 'NewPass123', confirmPassword: 'NewPass123' },
  });
  ok('the real token resets the password', res.status === 200, JSON.stringify(res.data));

  res = await anon('/api/auth/reset', {
    method: 'POST', body: { token, password: 'Another123', confirmPassword: 'Another123' },
  });
  ok('the token cannot be reused', res.status === 400);

  const relogin = browser();
  res = await relogin('/api/auth/login', { method: 'POST', body: { email: otherEmail, password: 'NewPass123' } });
  ok('the new password works', res.status === 200);
  res = await anon('/api/auth/login', { method: 'POST', body: { email: otherEmail, password: 'Secret123' } });
  ok('the old password no longer works', res.status === 401);

  /* --------------------------------------------------------- change pass */
  section('change password');
  res = await student('/api/auth/change-password', {
    method: 'POST',
    body: { currentPassword: 'WRONG', newPassword: 'Brandnew123', confirmPassword: 'Brandnew123' },
  });
  ok('wrong current password is refused', res.status === 401);

  res = await student('/api/auth/change-password', {
    method: 'POST',
    body: { currentPassword: 'Secret123', newPassword: 'Brandnew123', confirmPassword: 'Brandnew123' },
  });
  ok('password change works', res.status === 200);

  /* -------------------------------------------------------------- logout */
  section('logout');
  await student('/api/auth/logout', { method: 'POST' });
  res = await student('/api/student/dashboard');
  ok('logout ends the session', res.status === 401);

  /* ------------------------------------------------------------- cleanup */
  section('cleanup');
  let removed = 0;
  for (const id of [studentId, otherId]) {
    if (!id) continue;
    const del = await admin('/api/admin/student/delete', { method: 'POST', body: { id } });
    if (del.status === 200) removed++;
  }
  ok('test accounts deleted', removed === 2, `removed ${removed}`);

  const after = await admin('/api/admin/students?search=e2e-');
  ok('no test accounts left behind', after.data.students.length === 0);

  if (batchId) {
    const del = await admin('/api/admin/batches/delete', { method: 'POST', body: { id: batchId } });
    ok('test batch deleted', del.status === 200);
  }
  const left = await admin('/api/admin/batches');
  ok('no test batches left behind', !left.data.batches.some((b) => b.name.startsWith('E2E ')));

  report();
})().catch((err) => {
  console.error('\n  Test run crashed:', err.message);
  process.exitCode = 1;
});
