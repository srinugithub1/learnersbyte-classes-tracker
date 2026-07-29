/**
 * Exam end time and pass marks, against a RUNNING server and the real database.
 *
 *   node server.js
 *   node test/endtime.test.js
 *
 * Needs supabase/migration-exam-window.sql to have been run.
 *
 * Everything it makes is prefixed "E2E"/"e2e-" and deleted at the end.
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
const clock = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const today = () => {
  const n = new Date();
  return `${n.getFullYear()}-${pad(n.getMonth() + 1)}-${pad(n.getDate())}`;
};
const shift = (minutes) => {
  const d = new Date();
  d.setMinutes(d.getMinutes() + minutes);
  return d;
};

(async function run() {
  const admin = browser();
  const student = browser();
  let batchId = null;
  let studentId = null;
  const examIds = [];

  try {
    section('setup');
    let res = await admin('/api/auth/login', {
      method: 'POST',
      body: {
        email: process.env.ADMIN_EMAIL || 'teacher@udayan.local',
        password: process.env.ADMIN_PASSWORD || 'Teach1234',
      },
    });
    if (res.status !== 200) {
      console.error(`\n  Cannot log in as admin at ${BASE}. Start the server first.\n`);
      process.exitCode = 1;
      return;
    }
    ok('admin logged in', true);

    res = await admin('/api/admin/batches', {
      method: 'POST',
      body: {
        name: `E2E EndTime ${stamp}`, course: 'E2E',
        classStart: '10:00', classEnd: '11:00', classDays: [0, 1, 2, 3, 4, 5, 6],
      },
    });
    ok('batch created', res.status === 201, JSON.stringify(res.data));
    batchId = res.data.batch && res.data.batch.id;

    const email = `e2e-endtime-${stamp}@example.test`;
    res = await admin('/api/admin/students', {
      method: 'POST',
      body: { email, name: 'E2E EndTime', password: 'Sturdy1234', phone: '9999999999' },
    });
    ok('student created', res.status === 201, JSON.stringify(res.data));
    studentId = res.data.student.id;
    await admin('/api/admin/student/update', { method: 'POST', body: { id: studentId, batchId } });
    res = await student('/api/auth/login', {
      method: 'POST', body: { email, password: 'Sturdy1234' },
    });
    ok('student logged in', res.status === 200, JSON.stringify(res.data));

    /* ------------------------------------------------------------ refusals */
    section('bad windows are refused');

    const makeExam = (extra) => admin('/api/admin/exams', {
      method: 'POST',
      body: {
        batchId,
        title: `E2E Paper ${stamp}`,
        examDate: today(),
        startTime: '10:00',
        totalQuestions: 2,
        totalMarks: 10,
        secondsPerQuestion: 60,
        questionMode: 'fill',
        ...extra,
      },
    });

    res = await makeExam({ endTime: '09:00' });
    ok('an end time before the start is refused', res.status === 400, JSON.stringify(res.data));
    res = await makeExam({ endTime: '10:00' });
    ok('an end time equal to the start is refused', res.status === 400);
    res = await makeExam({ endTime: 'later' });
    ok('a nonsense end time is refused', res.status === 400);
    res = await makeExam({ passMarks: 11 });
    ok('pass marks above the total are refused', res.status === 400, JSON.stringify(res.data));
    res = await makeExam({ passMarks: -1 });
    ok('negative pass marks are refused', res.status === 400);

    /* -------------------------------------------------------- a live paper */
    section('a paper with a finish time');

    // Opened five minutes ago, shuts in five minutes.
    res = await makeExam({
      startTime: clock(shift(-5)),
      endTime: clock(shift(5)),
      passMarks: 6,
    });
    ok('an exam with an end time is accepted', res.status === 201, JSON.stringify(res.data));
    const exam = res.data.exam;
    examIds.push(exam.id);
    ok('the end time comes back', exam.endTime === clock(shift(5)), exam.endTime);
    ok('the pass mark comes back', exam.passMarks === 6, String(exam.passMarks));

    res = await admin('/api/admin/exams/questions', {
      method: 'POST',
      body: {
        examId: exam.id,
        questions: [
          { type: 'fill', questionText: 'Water is ____ at room temperature.', correctAnswer: 'liquid', marks: 5, seconds: 60 },
          { type: 'fill', questionText: 'The sun rises in the ____.', correctAnswer: 'east', marks: 5, seconds: 60 },
        ],
      },
    });
    ok('questions saved', res.status === 200, JSON.stringify(res.data));
    res = await admin('/api/admin/exams/update', {
      method: 'POST', body: { id: exam.id, status: 'published' },
    });
    ok('exam published', res.status === 200, JSON.stringify(res.data));

    res = await student('/api/student/exams');
    const listed = res.data.exams.find((e) => e.id === exam.id);
    ok('the student sees it', Boolean(listed));
    ok('the window says the finish is fixed', listed && listed.window.fixedEnd === true);
    ok('and reports seconds left', listed && listed.window.secondsLeft > 0 && listed.window.secondsLeft <= 300,
      listed && String(listed.window.secondsLeft));
    ok('the paper is open', listed && listed.window.phase === 'open', listed && listed.window.phase);

    res = await student('/api/student/exam/start', { method: 'POST', body: { examId: exam.id } });
    ok('the student can start it', res.status === 200, JSON.stringify(res.data));
    const attemptId = res.data.attempt.id;
    const questions = res.data.questions;

    res = await student('/api/student/exam/open', {
      method: 'POST', body: { attemptId, questionId: questions[0].id },
    });
    ok('opening a question also reports the paper clock',
      res.status === 200 && typeof res.data.examSecondsLeft === 'number',
      JSON.stringify(res.data));

    res = await student('/api/student/exam/answer', {
      method: 'POST', body: { attemptId, questionId: questions[0].id, answer: 'liquid' },
    });
    ok('an answer is accepted while the paper is open', res.status === 200, JSON.stringify(res.data));

    /* -------------------------------------------- the finish time arrives */
    section('when the end time passes');

    // Rather than wait, move the finish into the past.
    res = await admin('/api/admin/exams/update', {
      method: 'POST', body: { id: exam.id, endTime: clock(shift(-1)) },
    });
    ok('the teacher can move the finish time', res.status === 200, JSON.stringify(res.data));

    res = await student('/api/student/exam/answer', {
      method: 'POST', body: { attemptId, questionId: questions[1].id, answer: 'east' },
    });
    ok('a later answer is refused', res.status === 409, JSON.stringify(res.data));
    ok('and says the exam is over', res.data.examOver === true, JSON.stringify(res.data));

    res = await student('/api/student/exam/submit', { method: 'POST', body: { attemptId } });
    ok('the paper was already submitted for them', res.status === 200 && res.data.already === true,
      JSON.stringify(res.data && res.data.totals));
    ok('only the answer given in time was marked', res.data.totals.score === 5,
      String(res.data.totals.score));
    ok('the second question counts as unanswered', res.data.totals.unansweredCount === 1,
      String(res.data.totals.unansweredCount));
    ok('and the pass mark is applied', res.data.totals.passMarks === 6);
    ok('5 out of 10 does not reach a pass mark of 6', res.data.totals.passed === false);

    res = await student('/api/student/exams');
    const after = res.data.exams.find((e) => e.id === exam.id);
    ok('the list shows it as submitted', after && after.attempt.status === 'submitted');
    ok('with the pass verdict', after && after.attempt.passed === false);

    res = await admin(`/api/admin/exam/results?examId=${encodeURIComponent(exam.id)}`);
    ok('the teacher sees the pass mark', res.data.summary.passMarks === 6, JSON.stringify(res.data.summary));
    const row = res.data.rows.find((r) => r.student.id === studentId);
    ok('and the student as not passed', row && row.passed === false);

    /* -------------------------------------------------- a paper already shut */
    section('a paper that shut before anyone started');

    res = await makeExam({ startTime: clock(shift(-90)), endTime: clock(shift(-60)) });
    const shut = res.data.exam;
    examIds.push(shut.id);
    await admin('/api/admin/exams/questions', {
      method: 'POST',
      body: {
        examId: shut.id,
        questions: [{ type: 'fill', questionText: 'Ice is ____.', correctAnswer: 'solid', marks: 10, seconds: 60 }],
      },
    });
    await admin('/api/admin/exams/update', { method: 'POST', body: { id: shut.id, status: 'published' } });

    res = await student('/api/student/exam/start', { method: 'POST', body: { examId: shut.id } });
    ok('a shut paper cannot be started', res.status === 409, JSON.stringify(res.data));

    res = await student('/api/student/exams');
    const closed = res.data.exams.find((e) => e.id === shut.id);
    ok('and it reads as closed', closed && closed.window.phase === 'closed');
    ok('with no late-start grace, unlike an open-ended paper', closed && closed.window.canStart === false);

    /* --------------------------------------------- an open-ended paper still works */
    section('nothing changes for a paper with no end time');

    res = await makeExam({ startTime: clock(shift(-2)) });
    const plain = res.data.exam;
    examIds.push(plain.id);
    ok('an exam with no end time is still accepted', res.status === 201, JSON.stringify(res.data));
    ok('and stores no end time', plain.endTime === '' || plain.endTime === null, String(plain.endTime));
    ok('and no pass mark', plain.passMarks === null, String(plain.passMarks));

    await admin('/api/admin/exams/questions', {
      method: 'POST',
      body: {
        examId: plain.id,
        questions: [{ type: 'fill', questionText: 'Fire is ____.', correctAnswer: 'hot', marks: 10, seconds: 600 }],
      },
    });
    await admin('/api/admin/exams/update', { method: 'POST', body: { id: plain.id, status: 'published' } });

    res = await student('/api/student/exams');
    const openEnded = res.data.exams.find((e) => e.id === plain.id);
    ok('its window is not fixed', openEnded && openEnded.window.fixedEnd === false);
    ok('and it is open', openEnded && openEnded.window.phase === 'open', openEnded && openEnded.window.phase);
  } finally {
    section('cleanup');
    for (const id of examIds) {
      const res = await admin('/api/admin/exams/delete', { method: 'POST', body: { id } });
      ok('exam removed', res.status === 200);
    }
    if (studentId) {
      const res = await admin('/api/admin/student/delete', { method: 'POST', body: { id: studentId } });
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
