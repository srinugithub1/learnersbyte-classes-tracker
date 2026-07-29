/**
 * Filling in past attendance over a RANGE of dates.
 *
 *   node server.js                (in one terminal)
 *   node test/backfill.test.js    (in another)
 *
 * Creates a throwaway batch that meets every weekday and two students, then
 * checks that the gaps list shows only the students who are missing a present
 * or late mark, and that a range-wide save actually lands. Everything it makes
 * is prefixed "E2E"/"e2e-" and deleted at the end.
 */

const BASE = process.env.BASE || 'http://localhost:3000';

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? ` — ${extra}` : ''}`); }
};
const section = (t) => console.log(`\n== ${t} ==`);

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
const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Days back from today, on the local clock — never toISOString(), which is UTC. */
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return iso(d);
}

(async function run() {
  const admin = browser();
  let batchId = null;
  const studentIds = [];

  try {
    section('setup');
    const adminEmail = process.env.ADMIN_EMAIL || 'teacher@udayan.local';
    const adminPassword = process.env.ADMIN_PASSWORD || 'Teach1234';
    let res = await admin('/api/auth/login', {
      method: 'POST', body: { email: adminEmail, password: adminPassword },
    });
    if (res.status !== 200) {
      console.error(`\n  Cannot log in as admin at ${BASE}. Start the server first.\n`);
      process.exitCode = 1;
      return;
    }
    ok('admin logged in', true);

    // Meets every day of the week, so every date in the range is a class day.
    res = await admin('/api/admin/batches', {
      method: 'POST',
      body: {
        name: `E2E Backfill ${stamp}`, course: 'E2E',
        classStart: '10:00', classEnd: '11:00', classDays: [0, 1, 2, 3, 4, 5, 6],
      },
    });
    ok('daily batch created', res.status === 201, JSON.stringify(res.data));
    batchId = res.data.batch && res.data.batch.id;

    for (const tag of ['a', 'b']) {
      res = await admin('/api/admin/students', {
        method: 'POST',
        body: {
          email: `e2e-fill-${tag}-${stamp}@example.test`,
          name: `E2E Fill ${tag.toUpperCase()}`,
          password: 'Sturdy1234', phone: '9999999999',
        },
      });
      ok(`student ${tag} created`, res.status === 201, JSON.stringify(res.data));
      const id = res.data.student.id;
      studentIds.push(id);
      res = await admin('/api/admin/student/update', { method: 'POST', body: { id, batchId } });
      ok(`student ${tag} joined the batch`, res.status === 200);
    }
    const [alpha, beta] = studentIds;

    const from = daysAgo(4);
    const to = daysAgo(2);          // a three-day range, all in the past
    const mid = daysAgo(3);
    const range = `from=${from}&to=${to}&batchId=${batchId}`;
    const mine = (rows) => rows.filter((r) => studentIds.includes(r.student.id));

    /* ------------------------------------------------------------- listing */
    section('who is missing');
    res = await admin(`/api/admin/attendance/gaps?${range}`);
    ok('gaps endpoint answers', res.status === 200, JSON.stringify(res.data));
    ok('every student-day is listed while nothing is recorded',
      mine(res.data.rows).length === 6, `got ${mine(res.data.rows).length}`);
    ok('rows carry the date they belong to',
      mine(res.data.rows).every((r) => r.date >= from && r.date <= to));
    ok('rows are sorted by date', res.data.rows.every((r, i, all) =>
      i === 0 || all[i - 1].date <= r.date));
    ok('unrecorded days count as missing, not absent',
      mine(res.data.rows).every((r) => r.status === null));

    /* ------------------------------------------------- saving across dates */
    section('mass update across the range');
    const entries = [];
    for (const date of [from, mid, to]) entries.push({ userId: alpha, date, status: 'present' });
    entries.push({ userId: beta, date: from, status: 'late' });
    entries.push({ userId: beta, date: mid, status: 'absent' });

    res = await admin('/api/admin/attendance/bulk', { method: 'POST', body: { entries } });
    ok('a save spanning three dates is accepted', res.status === 200, JSON.stringify(res.data));
    ok('all five records saved', res.data.saved === 5, `got ${res.data.saved}`);
    ok('nothing was rejected', res.data.problems.length === 0, JSON.stringify(res.data.problems));
    ok('the reply reports the span it covered', res.data.from === from && res.data.to === to);

    res = await admin(`/api/admin/attendance/gaps?${range}`);
    const left = mine(res.data.rows);
    ok('students now present or late drop off the list', left.length === 2, `got ${left.length}`);
    ok('the one marked absent is still listed',
      left.some((r) => r.student.id === beta && r.date === mid && r.status === 'absent'));
    ok('the day never recorded is still listed',
      left.some((r) => r.student.id === beta && r.date === to && r.status === null));
    ok('a present student is gone from the list',
      !left.some((r) => r.student.id === alpha));

    /* ------------------------------------------------- start date moves back */
    section('the report follows the back-fill');
    res = await admin(`/api/admin/students?batchId=${batchId}`);
    const alphaRow = res.data.students.find((s) => s.id === alpha);
    ok('the student start date moved back to the earliest filled day',
      alphaRow && alphaRow.attendanceFrom === from, `got ${alphaRow && alphaRow.attendanceFrom}`);

    /* --------------------------------------------------------- re-saving */
    section('saving twice is safe');
    res = await admin('/api/admin/attendance/bulk', {
      method: 'POST',
      body: { entries: [
        { userId: alpha, date: from, status: 'present' },
        { userId: alpha, date: from, status: 'late' },      // same day twice
      ] },
    });
    ok('a repeated student-day does not break the save', res.status === 200, JSON.stringify(res.data));
    res = await admin(`/api/admin/attendance/gaps?${range}`);
    ok('the last instruction wins and the day is still not a gap',
      !mine(res.data.rows).some((r) => r.student.id === alpha && r.date === from));

    /* ------------------------------------------------------------ refusals */
    section('bad input is refused');
    res = await admin(`/api/admin/attendance/gaps?from=${to}&to=${from}`);
    ok('a backwards range is refused', res.status === 400, JSON.stringify(res.data));

    const tomorrow = (() => { const d = new Date(); d.setDate(d.getDate() + 1); return iso(d); })();
    res = await admin(`/api/admin/attendance/gaps?from=${from}&to=${tomorrow}`);
    ok('a range reaching into the future is refused', res.status === 400);

    res = await admin(`/api/admin/attendance/gaps?from=2020-01-01&to=${to}`);
    ok('a range longer than 92 days is refused', res.status === 400);

    res = await admin('/api/admin/attendance/bulk', {
      method: 'POST', body: { entries: [{ userId: alpha, date: tomorrow, status: 'present' }] },
    });
    ok('a future date is refused', res.status === 400);

    res = await admin('/api/admin/attendance/bulk', {
      method: 'POST', body: { entries: [{ userId: alpha, date: from, status: 'maybe' }] },
    });
    ok('an unknown status is refused', res.status === 400);

    const anon = browser();
    res = await anon(`/api/admin/attendance/gaps?${range}`);
    ok('a logged-out visitor gets nothing', res.status === 401 || res.status === 403);

    /* ------------------------------------------------------------- clearing */
    section('clearing a record');
    res = await admin('/api/admin/attendance/bulk', {
      method: 'POST',
      body: { entries: [{ userId: alpha, date: mid, status: 'clear' }] },
    });
    ok('a record can be cleared', res.status === 200 && res.data.cleared === 1,
      JSON.stringify(res.data));
    res = await admin(`/api/admin/attendance/gaps?${range}`);
    ok('the cleared day comes back as a gap',
      mine(res.data.rows).some((r) => r.student.id === alpha && r.date === mid));
  } finally {
    section('cleanup');
    for (const id of studentIds) {
      const res = await admin('/api/admin/student/delete', { method: 'POST', body: { id } });
      ok('student removed', res.status === 200);
    }
    if (batchId) {
      const res = await admin('/api/admin/batches/delete', { method: 'POST', body: { id: batchId } });
      ok('batch removed', res.status === 200);
    }
    console.log(`\n  ${pass} passed, ${fail} failed\n`);
    process.exitCode = fail ? 1 : 0;
  }
})();
