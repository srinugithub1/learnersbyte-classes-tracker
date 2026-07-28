/**
 * End-to-end test for sitting an exam: the time gate, per-question locking,
 * marking, and what the student and admin can see afterwards.
 *
 *   node server.js               (in one terminal)
 *   node test/attempt.test.js    (in another)
 *
 * Creates a throwaway batch, student and exam prefixed "E2E", then removes them.
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
const studentEmail = `e2e-exam-${stamp}@example.test`;

/**
 * Today's date on the *server's* clock. toISOString() is UTC, so before 05:30
 * in Asia/Calcutta it would name yesterday and every exam would read as closed.
 */
function localToday() {
  const n = new Date();
  return `${n.getFullYear()}-${pad(n.getMonth() + 1)}-${pad(n.getDate())}`;
}

/** A HH:MM string `minutes` from now, clamped inside today. */
function clockFromNow(minutes) {
  const now = new Date();
  const mins = Math.min(Math.max(now.getHours() * 60 + now.getMinutes() + minutes, 0), 1439);
  return `${pad(Math.floor(mins / 60))}:${pad(mins % 60)}`;
}

const QUESTIONS = [
  { type: 'mcq', questionText: 'Which planet is closest to the Sun?',
    options: [{ key: 'A', text: 'Venus' }, { key: 'B', text: 'Mercury' }, { key: 'C', text: 'Earth' }],
    correctAnswer: 'B', marks: 2 },
  { type: 'fill', questionText: 'The capital of France is ____.', correctAnswer: 'Paris', marks: 2 },
  { type: 'fill', questionText: 'Water boils at ____ degrees Celsius.', correctAnswer: '100', marks: 2 },
  { type: 'mcq', questionText: 'Which of these is a mammal?',
    options: [{ key: 'A', text: 'Shark' }, { key: 'B', text: 'Dolphin' }],
    correctAnswer: 'B', marks: 2 },
];

(async function run() {
  const admin = browser();
  const student = browser();
  let batchId; let examId; let futureExamId; let clockExamId; let studentId; let attemptId;

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
    body: { name: `E2E Exam Sit ${stamp}`, course: 'E2E', classStart: '09:00', classEnd: '10:00',
      classDays: [0, 1, 2, 3, 4, 5, 6] },
  });
  batchId = res.data.batch && res.data.batch.id;
  ok('batch created', res.status === 201, JSON.stringify(res.data));

  res = await student('/api/auth/signup', {
    method: 'POST',
    body: { name: 'E2E Exam Taker', email: studentEmail, phone: '9876543210',
      password: 'Secret123', confirmPassword: 'Secret123' },
  });
  studentId = res.data.user && res.data.user.id;
  ok('student signed up', res.status === 201);
  res = await student('/api/student/profile', { method: 'POST', body: { batchId } });
  ok('student joined the batch', res.status === 200);

  /* -------------------------------------------------------- the gate --- */
  section('start time gate');

  // An exam that opens in two hours.
  res = await admin('/api/admin/exams', {
    method: 'POST',
    body: { batchId, title: `E2E Future ${stamp}`, examDate: localToday(),
      startTime: clockFromNow(120), totalQuestions: 4, totalMarks: 8,
      secondsPerQuestion: 30, questionMode: 'both' },
  });
  futureExamId = res.data.exam.id;
  await admin('/api/admin/exams/questions', { method: 'POST', body: { examId: futureExamId, questions: QUESTIONS } });
  await admin('/api/admin/exams/update', { method: 'POST', body: { id: futureExamId, status: 'published' } });

  res = await student('/api/student/exam/start', { method: 'POST', body: { examId: futureExamId } });
  ok('an exam that has not opened cannot be started', res.status === 409, `got ${res.status}`);
  ok('and it says when it opens', /opens on/i.test(res.data.error || ''), res.data.error);

  // An exam that opened five minutes ago.
  res = await admin('/api/admin/exams', {
    method: 'POST',
    body: { batchId, title: `E2E Live ${stamp}`, examDate: localToday(),
      startTime: clockFromNow(-5), totalQuestions: 4, totalMarks: 8,
      secondsPerQuestion: 30, questionMode: 'both',
      instructions: 'Answer every question. Each one locks after 30 seconds.' },
  });
  examId = res.data.exam.id;
  ok('live exam created', res.status === 201, JSON.stringify(res.data));

  res = await student('/api/student/exam/start', { method: 'POST', body: { examId } });
  ok('an unpublished exam cannot be started', res.status === 409, `got ${res.status}`);

  await admin('/api/admin/exams/questions', { method: 'POST', body: { examId, questions: QUESTIONS } });
  await admin('/api/admin/exams/update', { method: 'POST', body: { id: examId, status: 'published' } });

  /* ------------------------------------------------------- the paper --- */
  section('the question paper');
  res = await student('/api/student/exams');
  ok('the student sees released exams', res.data.exams.length >= 2);
  const listed = res.data.exams.find((e) => e.id === examId);
  ok('the live exam shows as open', listed && listed.window.phase === 'open', listed && listed.window.phase);
  ok('the instructions come through', listed && /locks after 30 seconds/.test(listed.instructions));
  const upcoming = res.data.exams.find((e) => e.id === futureExamId);
  ok('the future exam shows as upcoming', upcoming && upcoming.window.phase === 'upcoming');

  res = await student('/api/student/exam/start', { method: 'POST', body: { examId } });
  ok('the student can start', res.status === 200, JSON.stringify(res.data).slice(0, 160));
  attemptId = res.data.attempt.id;
  const paper = res.data.questions;
  ok('all four questions arrive', paper.length === 4);
  ok('THE ANSWER KEY IS NOT SENT', !JSON.stringify(paper).includes('correctAnswer'));
  ok('and no answer text leaks either',
    !JSON.stringify(paper).includes('Paris') && !JSON.stringify(paper).includes('"100"'));
  ok('per-question time is included', paper[0].seconds === 30);
  ok('options are included for the MCQ', paper[0].options.length === 3);

  res = await student('/api/student/exam/start', { method: 'POST', body: { examId } });
  ok('starting twice resumes the same attempt', res.data.attempt.id === attemptId);

  /* ------------------------------------------------------- answering --- */
  section('answering');
  res = await student('/api/student/exam/answer', {
    method: 'POST', body: { attemptId, questionId: paper[0].id, answer: 'A' },
  });
  ok('an answer saves', res.status === 200 && res.data.answer.answer === 'A');

  res = await student('/api/student/exam/answer', {
    method: 'POST', body: { attemptId, questionId: paper[0].id, answer: 'B' },
  });
  ok('an unlocked answer can be changed', res.data.answer.answer === 'B');

  res = await student('/api/student/exam/answer', {
    method: 'POST', body: { attemptId, questionId: paper[1].id, answer: 'paris  ', lock: true },
  });
  ok('the timer can lock an answer', res.data.answer.locked === true);

  res = await student('/api/student/exam/answer', {
    method: 'POST', body: { attemptId, questionId: paper[1].id, answer: 'Berlin' },
  });
  ok('A LOCKED ANSWER CANNOT BE CHANGED', res.data.answer.answer.trim() === 'paris',
    `got "${res.data.answer.answer}"`);
  ok('and the attempt to change it is refused outright', res.status === 409, `got ${res.status}`);

  await student('/api/student/exam/answer', {
    method: 'POST', body: { attemptId, questionId: paper[2].id, answer: '50' },
  });
  // paper[3] is deliberately left unanswered.

  res = await student('/api/student/exam/answer', {
    method: 'POST', body: { attemptId, questionId: '00000000-0000-0000-0000-000000000000', answer: 'x' },
  });
  ok('an answer for a foreign question is refused', res.status === 400);

  const outsider = browser();
  await outsider('/api/auth/signup', {
    method: 'POST',
    body: { name: 'E2E Outsider', email: `e2e-outsider-${stamp}@example.test`, phone: '9812345678',
      password: 'Secret123', confirmPassword: 'Secret123' },
  });
  res = await outsider('/api/student/exam/answer', {
    method: 'POST', body: { attemptId, questionId: paper[0].id, answer: 'C' },
  });
  ok('another student cannot answer into this attempt', res.status === 403);

  res = await student('/api/student/exam/start', { method: 'POST', body: { examId } });
  const resumed = res.data.questions;
  ok('answers survive a reload', resumed[0].yourAnswer === 'B');
  ok('the locked flag survives a reload', resumed[1].locked === true);

  /* ----------------------------------------------------- the real clock --- */
  // The countdown a student sees is drawn by their browser, so it can be paused
  // or edited in DevTools. These checks prove that buys them nothing: the server
  // stamps when it served the question and refuses anything that arrives late.
  section('the server keeps the clock');

  res = await admin('/api/admin/exams', {
    method: 'POST',
    body: { batchId, title: `E2E Clock ${stamp}`, examDate: localToday(),
      // 5s is the shortest the app allows, which keeps this test quick.
      startTime: clockFromNow(-1), totalQuestions: 2, totalMarks: 4,
      secondsPerQuestion: 5, questionMode: 'both' },
  });
  ok('short-timer exam created', res.status === 201, JSON.stringify(res.data));
  clockExamId = res.data.exam.id;
  await admin('/api/admin/exams/questions', {
    method: 'POST',
    body: { examId: clockExamId, questions: [QUESTIONS[0], QUESTIONS[1]] },
  });
  await admin('/api/admin/exams/update', { method: 'POST', body: { id: clockExamId, status: 'published' } });

  res = await student('/api/student/exam/start', { method: 'POST', body: { examId: clockExamId } });
  const clockAttempt = res.data.attempt.id;
  const timed = res.data.questions;
  ok('a fresh question has its full time', timed[0].remaining === 5, `got ${timed[0].remaining}`);
  ok('and no open time until it is served', timed[0].openedAt === null);

  res = await student('/api/student/exam/open', {
    method: 'POST', body: { attemptId: clockAttempt, questionId: timed[0].id },
  });
  ok('opening a question starts the server clock', res.status === 200 && Boolean(res.data.openedAt));
  const firstOpen = res.data.openedAt;

  res = await student('/api/student/exam/open', {
    method: 'POST', body: { attemptId: clockAttempt, questionId: timed[0].id },
  });
  ok('RE-OPENING DOES NOT RESTART THE COUNTDOWN', res.data.openedAt === firstOpen,
    `${firstOpen} -> ${res.data.openedAt}`);

  res = await student('/api/student/exam/answer', {
    method: 'POST', body: { attemptId: clockAttempt, questionId: timed[0].id, answer: 'B' },
  });
  ok('an answer inside the time is kept', res.status === 200 && res.data.answer.answer === 'B');

  // Wait out the 2 seconds plus the latency allowance, then answer as a tampered
  // browser would: its countdown never reached zero, so it never asked to lock.
  await new Promise((r) => setTimeout(r, (5 + 3 + 1) * 1000));

  res = await student('/api/student/exam/answer', {
    method: 'POST', body: { attemptId: clockAttempt, questionId: timed[0].id, answer: 'A' },
  });
  ok('A LATE ANSWER IS REFUSED EVEN IF THE BROWSER NEVER LOCKED', res.status === 409, `got ${res.status}`);
  ok('and the answer given in time is what stands', res.data.answer.answer === 'B',
    `got "${res.data.answer.answer}"`);
  ok('and the question is now locked', res.data.answer.locked === true);

  // A question served but never answered must also close on time, so a student
  // cannot leave one open and come back to it later.
  await student('/api/student/exam/open', {
    method: 'POST', body: { attemptId: clockAttempt, questionId: timed[1].id },
  });
  await new Promise((r) => setTimeout(r, (5 + 3 + 1) * 1000));
  res = await student('/api/student/exam/answer', {
    method: 'POST', body: { attemptId: clockAttempt, questionId: timed[1].id, answer: 'Paris' },
  });
  ok('a question left open still closes on time', res.status === 409, `got ${res.status}`);

  res = await student('/api/student/exam/start', { method: 'POST', body: { examId: clockExamId } });
  ok('a reload shows both questions locked',
    res.data.questions.every((q) => q.locked === true));
  ok('and no time left on them', res.data.questions.every((q) => q.remaining === 0));

  res = await student('/api/student/exam/submit', { method: 'POST', body: { attemptId: clockAttempt } });
  ok('the timed exam marks only what arrived in time',
    res.data.totals.correctCount === 1 && res.data.totals.unansweredCount === 1,
    JSON.stringify(res.data.totals));

  /* --------------------------------------------------------- marking --- */
  section('marking');
  res = await student('/api/student/exam/submit', { method: 'POST', body: { attemptId } });
  ok('the exam submits', res.status === 201, JSON.stringify(res.data).slice(0, 200));

  const t = res.data.totals;
  ok('two correct (B and paris)', t.correctCount === 2, `got ${t.correctCount}`);
  ok('one wrong (50)', t.wrongCount === 1, `got ${t.wrongCount}`);
  ok('one unanswered', t.unansweredCount === 1, `got ${t.unansweredCount}`);
  ok('score is 4 of 8', t.score === 4 && t.totalMarks === 8, `got ${t.score}/${t.totalMarks}`);
  ok('percent is 50', t.percent === 50);
  ok('fill answers ignore case and spacing',
    res.data.results[1].isCorrect === true);
  ok('the marked paper now shows the answers',
    res.data.results[1].correctAnswer === 'Paris');

  res = await student('/api/student/exam/submit', { method: 'POST', body: { attemptId } });
  ok('submitting twice does not re-mark', res.status === 200 && res.data.already === true);
  ok('and the score is unchanged', res.data.totals.score === 4);

  res = await student('/api/student/exam/answer', {
    method: 'POST', body: { attemptId, questionId: paper[3].id, answer: 'B' },
  });
  ok('no answering after submission', res.status === 409);

  /* ------------------------------------------- what the student sees --- */
  section('student report');
  res = await student('/api/student/exam/history');
  // Two sittings by now: the main paper and the short-timer one.
  ok('both exams appear in their history', res.data.attempts.length === 2,
    `got ${res.data.attempts.length}`);
  const mine = res.data.attempts.find((a) => a.examId === examId);
  ok('the exam appears in their history', Boolean(mine));
  ok('with the score', mine && mine.score === 4 && mine.percent === 50,
    mine && `${mine.score} / ${mine.percent}%`);
  ok('and the breakdown', mine && mine.correctCount === 2 && mine.wrongCount === 1);

  res = await student(`/api/student/exam/result?attemptId=${attemptId}`);
  ok('they can reopen the marked paper', res.status === 200 && res.data.results.length === 4);

  res = await outsider(`/api/student/exam/result?attemptId=${attemptId}`);
  ok("another student cannot read someone else's paper", res.status === 403);

  res = await student('/api/student/exams');
  const done = res.data.exams.find((e) => e.id === examId);
  ok('the exam list shows it as completed', done.window.phase === 'completed');
  ok('and cannot be started again', done.window.canStart === false);

  /* --------------------------------------------- what the admin sees --- */
  section('admin report');
  res = await admin(`/api/admin/exam/results?examId=${examId}`);
  ok('admin sees results for the exam', res.status === 200);
  const row = res.data.rows.find((r) => r.student.id === studentId);
  ok('our student is listed', Boolean(row));
  ok('with their score', row.score === 4 && row.percent === 50);
  ok('and their breakdown', row.correctCount === 2 && row.wrongCount === 1 && row.unansweredCount === 1);
  ok('the summary counts submissions', res.data.summary.submitted === 1);
  ok('the average is right', res.data.summary.average === 50);

  res = await admin('/api/admin/exam/scores');
  ok('admin sees every score', res.data.attempts.some((a) => a.id === attemptId));
  const scored = res.data.attempts.find((a) => a.id === attemptId);
  ok('with the student attached', scored.student && scored.student.email === studentEmail);
  ok('and the exam attached', scored.exam && scored.exam.id === examId);

  res = await admin(`/api/student/exam/result?attemptId=${attemptId}`);
  ok("admin can open a student's marked paper", res.status === 200 && res.data.results.length === 4);

  /* --------------------------------------------------------- cleanup --- */
  section('cleanup');
  for (const id of [examId, futureExamId, clockExamId]) {
    await admin('/api/admin/exams/delete', { method: 'POST', body: { id } });
  }
  const students = await admin('/api/admin/students?search=e2e-');
  for (const s of students.data.students) {
    await admin('/api/admin/student/delete', { method: 'POST', body: { id: s.id } });
  }
  await admin('/api/admin/batches/delete', { method: 'POST', body: { id: batchId } });

  const left = await admin('/api/admin/exams');
  ok('test exams removed', !left.data.exams.some((e) => String(e.title).startsWith('E2E ')));
  const batchesLeft = await admin('/api/admin/batches');
  ok('test batch removed', !batchesLeft.data.batches.some((b) => b.name.startsWith('E2E ')));
  const usersLeft = await admin('/api/admin/students?search=e2e-');
  ok('test students removed', usersLeft.data.students.length === 0);

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exitCode = fail ? 1 : 0;
})().catch((err) => {
  console.error('\n  Test run crashed:', err.message);
  process.exitCode = 1;
});
