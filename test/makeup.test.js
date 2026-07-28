/**
 * End-to-end test for missed exams and makeup papers.
 *
 *   node server.js              (in one terminal)
 *   node test/makeup.test.js    (in another)
 *
 * The point of the design is that a makeup is a SEPARATE paper released only to
 * named students, so the questions cannot reach anyone who already sat the
 * original. The checks in capitals are the ones that prove it.
 *
 * Creates a throwaway batch, three students and three exams prefixed "E2E",
 * then removes them.
 */

const BASE = process.env.BASE || 'http://localhost:3000';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'teacher@udayan.local';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Teach1234';

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

/** Today on the server's clock — toISOString() is UTC and names yesterday
 *  before 05:30 in Asia/Calcutta. */
function localToday() {
  const n = new Date();
  return `${n.getFullYear()}-${pad(n.getMonth() + 1)}-${pad(n.getDate())}`;
}
function clockFromNow(minutes) {
  const now = new Date();
  const mins = Math.min(Math.max(now.getHours() * 60 + now.getMinutes() + minutes, 0), 1439);
  return `${pad(Math.floor(mins / 60))}:${pad(mins % 60)}`;
}

const QUESTIONS = [
  { type: 'mcq', questionText: 'Which planet is closest to the Sun?',
    options: [{ key: 'A', text: 'Venus' }, { key: 'B', text: 'Mercury' }],
    correctAnswer: 'B', marks: 2 },
  { type: 'fill', questionText: 'The capital of France is ____.', correctAnswer: 'Paris', marks: 2 },
];
const MAKEUP_QUESTIONS = [
  { type: 'mcq', questionText: 'Which gas do plants take in?',
    options: [{ key: 'A', text: 'Oxygen' }, { key: 'B', text: 'Carbon dioxide' }],
    correctAnswer: 'B', marks: 2 },
  { type: 'fill', questionText: 'The largest ocean is the ____ Ocean.', correctAnswer: 'Pacific', marks: 2 },
];

(async function run() {
  const admin = browser();
  const sat = browser();       // sat the original
  const missed = browser();    // missed it — the one asking
  const other = browser();     // also in the batch, did not miss anything

  let batchId; let originalId; let makeupId; let closedId;
  let missedUserId; let satUserId; let otherUserId;

  const signUp = async (client, name, email) => {
    const res = await client('/api/auth/signup', {
      method: 'POST',
      body: { name, email, phone: '9876543210', password: 'Secret123', confirmPassword: 'Secret123' },
    });
    await client('/api/student/profile', { method: 'POST', body: { batchId } });
    return res.data.user && res.data.user.id;
  };

  section('setup');
  let res = await admin('/api/auth/login', { method: 'POST', body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
  if (res.status !== 200) {
    console.error(`\n  Cannot log in as ${ADMIN_EMAIL}. Is the server running?\n`);
    process.exitCode = 1;
    return;
  }
  ok('admin logged in', true);

  res = await admin('/api/admin/batches', {
    method: 'POST',
    body: { name: `E2E Makeup ${stamp}`, course: 'E2E', classStart: '09:00', classEnd: '10:00',
      classDays: [0, 1, 2, 3, 4, 5, 6] },
  });
  batchId = res.data.batch && res.data.batch.id;
  ok('batch created', res.status === 201, JSON.stringify(res.data));

  satUserId = await signUp(sat, 'E2E Sat It', `e2e-sat-${stamp}@example.test`);
  missedUserId = await signUp(missed, 'E2E Missed It', `e2e-missed-${stamp}@example.test`);
  otherUserId = await signUp(other, 'E2E Other One', `e2e-other-${stamp}@example.test`);
  ok('three students joined the batch', Boolean(satUserId && missedUserId && otherUserId));

  /* ------------------------------------------------------ a closed paper --- */
  section('a paper that has closed');

  // Opened well before now and long since shut: 2 questions x 5s + 30 min grace.
  res = await admin('/api/admin/exams', {
    method: 'POST',
    body: { batchId, title: `E2E Original ${stamp}`, examDate: localToday(),
      startTime: clockFromNow(-90), totalQuestions: 2, totalMarks: 4,
      secondsPerQuestion: 5, questionMode: 'both' },
  });
  originalId = res.data.exam.id;
  ok('original exam created', res.status === 201, JSON.stringify(res.data));
  ok('it defaults to the whole batch', res.data.exam.audience === 'batch');

  await admin('/api/admin/exams/questions', { method: 'POST', body: { examId: originalId, questions: QUESTIONS } });
  await admin('/api/admin/exams/update', { method: 'POST', body: { id: originalId, status: 'published' } });

  res = await missed('/api/student/exams');
  let row = res.data.exams.find((e) => e.id === originalId);
  ok('the closed paper is visible to the batch', Boolean(row));
  ok('and it reads as closed', row && row.window.phase === 'closed', row && row.window.phase);
  ok('AND IT IS MARKED AS MISSED', row && row.missed === true);
  ok('with no request on it yet', row && row.makeup === null);

  res = await missed('/api/student/exam/start', { method: 'POST', body: { examId: originalId } });
  ok('a closed paper cannot be started', res.status === 409, `got ${res.status}`);

  /* ------------------------------------------------------- asking to sit --- */
  section('the student asks');

  res = await missed('/api/student/exam/makeup', {
    method: 'POST', body: { examId: originalId, reason: 'I was unwell and could not attend.' },
  });
  ok('the request is accepted', res.status === 201, JSON.stringify(res.data).slice(0, 160));
  ok('and starts as pending', res.data.makeup.status === 'pending');

  res = await missed('/api/student/exam/makeup', {
    method: 'POST', body: { examId: originalId, reason: 'asking twice' },
  });
  ok('ASKING TWICE IS REFUSED', res.status === 409, `got ${res.status}`);

  res = await missed('/api/student/exams');
  row = res.data.exams.find((e) => e.id === originalId);
  ok('the student can see their request', row && row.makeup && row.makeup.status === 'pending');
  ok('and their own reason back', row && /unwell/.test(row.makeup.reason));

  // A paper that has NOT closed cannot be requested.
  res = await admin('/api/admin/exams', {
    method: 'POST',
    body: { batchId, title: `E2E Live ${stamp}`, examDate: localToday(),
      startTime: clockFromNow(5), totalQuestions: 2, totalMarks: 4,
      secondsPerQuestion: 60, questionMode: 'both' },
  });
  closedId = res.data.exam.id;
  await admin('/api/admin/exams/questions', { method: 'POST', body: { examId: closedId, questions: QUESTIONS } });
  await admin('/api/admin/exams/update', { method: 'POST', body: { id: closedId, status: 'published' } });

  res = await missed('/api/student/exam/makeup', { method: 'POST', body: { examId: closedId, reason: 'x' } });
  ok('an exam that is still open cannot be requested', res.status === 409, `got ${res.status}`);

  /* ------------------------------------------------------ the teacher sees --- */
  section('the teacher sees it');

  res = await admin('/api/admin/makeups');
  const waiting = res.data.requests.filter((r) => r.examId === originalId);
  ok('the request reaches the teacher', waiting.length === 1);
  ok('with the student attached', waiting[0].student && /Missed It/.test(waiting[0].student.name));
  ok('and the reason', /unwell/.test(waiting[0].reason));
  ok('the pending count is right', res.data.pendingCount >= 1);

  res = await admin(`/api/admin/exam/results?examId=${originalId}`);
  const missedRow = res.data.rows.find((r) => r.student.id === missedUserId);
  ok('the results screen flags them as missed', missedRow && missedRow.missed === true);
  ok('and shows they have asked', missedRow && missedRow.makeupStatus === 'pending');
  ok('the summary counts the misses', res.data.summary.missed === 3, `got ${res.data.summary.missed}`);
  ok('and who is waiting on a decision', res.data.summary.awaitingDecision === 1);

  /* -------------------------------------------------- the makeup paper --- */
  section('the makeup paper');

  res = await admin('/api/admin/exams', {
    method: 'POST',
    body: { batchId, title: `E2E Makeup Paper ${stamp}`, examDate: localToday(),
      startTime: clockFromNow(-5), totalQuestions: 2, totalMarks: 4,
      secondsPerQuestion: 60, questionMode: 'both',
      audience: 'selected', studentIds: [missedUserId], missedExamId: originalId },
  });
  makeupId = res.data.exam.id;
  ok('the makeup paper is created', res.status === 201, JSON.stringify(res.data).slice(0, 200));
  ok('and is restricted', res.data.exam.audience === 'selected');

  await admin('/api/admin/exams/questions', { method: 'POST', body: { examId: makeupId, questions: MAKEUP_QUESTIONS } });
  await admin('/api/admin/exams/update', { method: 'POST', body: { id: makeupId, status: 'published' } });

  res = await admin(`/api/admin/exam/participants?examId=${makeupId}`);
  ok('only the one student is named on it', res.data.participants.length === 1);
  ok('and it is the right student', res.data.participants[0].userId === missedUserId);

  res = await admin('/api/admin/makeups');
  const decided = res.data.requests.find((r) => r.examId === originalId && r.userId === missedUserId);
  ok('creating it approved the request', decided && decided.status === 'approved');
  ok('and linked it to the new paper', decided && decided.makeupExamId === makeupId);

  /* ------------------------------------------------- who can see the paper --- */
  section('who can see the makeup paper');

  res = await missed('/api/student/exams');
  ok('THE STUDENT WHO MISSED SEES THE MAKEUP PAPER',
    res.data.exams.some((e) => e.id === makeupId));
  const mk = res.data.exams.find((e) => e.id === makeupId);
  ok('and it is open for them', mk && mk.window.phase === 'open', mk && mk.window.phase);

  res = await sat('/api/student/exams');
  ok('THE STUDENT WHO SAT THE ORIGINAL CANNOT SEE IT',
    !res.data.exams.some((e) => e.id === makeupId));

  res = await other('/api/student/exams');
  ok('NOBODY ELSE IN THE BATCH CAN SEE IT',
    !res.data.exams.some((e) => e.id === makeupId));

  res = await other('/api/student/exam/start', { method: 'POST', body: { examId: makeupId } });
  ok('AND THEY CANNOT START IT BY GUESSING THE ID', res.status === 403, `got ${res.status}`);

  res = await sat('/api/student/exam/start', { method: 'POST', body: { examId: makeupId } });
  ok('nor can the student who already sat the original', res.status === 403, `got ${res.status}`);

  /* --------------------------------------------------- sitting the makeup --- */
  section('sitting the makeup');

  res = await missed('/api/student/exam/start', { method: 'POST', body: { examId: makeupId } });
  ok('the student can start it', res.status === 200, JSON.stringify(res.data).slice(0, 160));
  const attemptId = res.data.attempt.id;
  const paper = res.data.questions;
  ok('the questions are the NEW ones', /gas do plants/.test(paper[0].questionText));
  ok('the answer key is still not sent', !JSON.stringify(paper).includes('correctAnswer'));

  await missed('/api/student/exam/answer', {
    method: 'POST', body: { attemptId, questionId: paper[0].id, answer: 'B' },
  });
  await missed('/api/student/exam/answer', {
    method: 'POST', body: { attemptId, questionId: paper[1].id, answer: 'pacific' },
  });

  res = await missed('/api/student/exam/submit', { method: 'POST', body: { attemptId } });
  ok('it submits and marks', res.status === 201, JSON.stringify(res.data).slice(0, 160));
  ok('both correct', res.data.totals.correctCount === 2, JSON.stringify(res.data.totals));
  ok('full marks', res.data.totals.score === 4 && res.data.totals.percent === 100);

  res = await missed('/api/student/exam/history');
  ok('the makeup score is in their report',
    res.data.attempts.some((a) => a.examId === makeupId && a.score === 4));

  res = await admin(`/api/admin/exam/results?examId=${makeupId}`);
  ok('the teacher sees the makeup result', res.data.rows.length === 1);
  ok('only the named student is listed', res.data.rows[0].student.id === missedUserId);
  ok('with their score', res.data.rows[0].percent === 100);

  res = await admin('/api/admin/exam/scores');
  ok('and it appears in the overall scores',
    res.data.attempts.some((a) => a.exam && a.exam.id === makeupId));

  /* ------------------------------------------------------------ declining --- */
  section('declining a request');

  res = await other('/api/student/exam/makeup', {
    method: 'POST', body: { examId: originalId, reason: 'I forgot about it.' },
  });
  ok('another student can also ask', res.status === 201);
  const toReject = res.data.makeup.id;

  res = await admin('/api/admin/makeups/reject', {
    method: 'POST', body: { id: toReject, note: 'You were marked absent without informing us.' },
  });
  ok('the teacher can decline it', res.status === 200);
  ok('and it records the decision', res.data.makeup.status === 'rejected');

  res = await admin('/api/admin/makeups/reject', { method: 'POST', body: { id: toReject, note: 'again' } });
  ok('a decided request cannot be decided twice', res.status === 409, `got ${res.status}`);

  res = await other('/api/student/exams');
  row = res.data.exams.find((e) => e.id === originalId);
  ok('the student sees it was declined', row && row.makeup.status === 'rejected');
  ok('with the teacher note', row && /without informing/.test(row.makeup.decisionNote));

  res = await other('/api/student/exam/makeup', { method: 'POST', body: { examId: originalId, reason: 'please' } });
  ok('and cannot simply ask again', res.status === 409, `got ${res.status}`);

  /* --------------------------------------------------------------- cleanup --- */
  section('cleanup');
  for (const id of [originalId, makeupId, closedId]) {
    await admin('/api/admin/exams/delete', { method: 'POST', body: { id } });
  }
  const students = await admin('/api/admin/students?search=e2e-');
  for (const s of students.data.students) {
    await admin('/api/admin/student/delete', { method: 'POST', body: { id: s.id } });
  }
  await admin('/api/admin/batches/delete', { method: 'POST', body: { id: batchId } });

  const left = await admin('/api/admin/exams');
  ok('test exams removed', !left.data.exams.some((e) => String(e.title).startsWith('E2E ')));
  const batches = await admin('/api/admin/batches');
  ok('test batch removed', !batches.data.batches.some((b) => String(b.name).startsWith('E2E ')));

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exitCode = fail ? 1 : 0;
})().catch((err) => {
  console.error('\n  Test run crashed:', err.message, '\n');
  process.exitCode = 1;
});
