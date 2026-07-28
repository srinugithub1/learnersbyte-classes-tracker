/**
 * Learner's Byte — attendance and exam portal server.
 *
 *   node server.js        ->  http://localhost:3000
 *
 * Two portals share one API:
 *   students  — sign up, log in, set their class details once, mark attendance
 *               each day, and see their own report.
 *   admins    — everything, for every student.
 *
 * Data lives in Supabase (store.js). Passwords are scrypt hashes (auth.js).
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

require('./env').loadEnv();

const store = require('./store');
const auth = require('./auth');
const sched = require('./schedule');
const parse = require('./parse');
const grading = require('./grading');
const zone = require('./zone');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

/** Base64 inflates by ~4/3, so this allows roughly a 12 MB question paper. */
const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;
const MAX_UPLOAD_BODY = Math.ceil(MAX_UPLOAD_BYTES * 1.4);

/* ------------------------------------------------------------- utilities */

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

function readBody(req, limit = 1e6) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > limit) reject(new Error('That file is too large.'));
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { reject(new Error('Invalid JSON.')); }
    });
    req.on('error', reject);
  });
}

const clientIp = (req) =>
  (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;

function fail(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  throw err;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function cleanEmail(value) {
  const email = String(value || '').trim();
  if (!EMAIL_RE.test(email)) fail('Please enter a valid email address.');
  if (email.length > 160) fail('Email address is too long.');
  return email;
}

function cleanText(value, label, { max = 120, required = true } = {}) {
  const text = String(value ?? '').trim();
  if (!text && required) fail(`${label} is required.`);
  if (text.length > max) fail(`${label} must be under ${max} characters.`);
  return text;
}

/** Validates a batch form. `partial` allows editing only some fields. */
function readBatchInput(body, { partial = false } = {}) {
  const out = {};
  const has = (key) => body[key] !== undefined;

  if (!partial || has('name')) out.name = cleanText(body.name, 'Batch name', { max: 60 });
  if (!partial || has('course')) out.course = cleanText(body.course, 'Course', { max: 80, required: !partial });
  if (has('notes')) out.notes = cleanText(body.notes, 'Notes', { max: 300, required: false });
  if (has('isActive')) out.isActive = Boolean(body.isActive);

  if (!partial || has('classStart') || has('classEnd')) {
    const classStart = cleanText(body.classStart, 'Class start time', { max: 5 });
    const classEnd = cleanText(body.classEnd, 'Class end time', { max: 5 });
    const startMins = sched.toMinutes(classStart);
    const endMins = sched.toMinutes(classEnd);
    if (startMins === null || endMins === null) fail('Please enter valid class times.');
    if (endMins <= startMins) fail('Class end time must be after the start time.');
    out.classStart = classStart;
    out.classEnd = classEnd;
  }

  if (!partial || has('classDays')) {
    const days = Array.isArray(body.classDays)
      ? [...new Set(body.classDays.map(Number))].filter((d) => d >= 0 && d <= 6).sort((a, b) => a - b)
      : [];
    if (!days.length) fail('Pick at least one class day.');
    out.classDays = days;
  }
  return out;
}

/* -------------------------------------------------------------- sessions */

async function currentUser(req) {
  const cookies = auth.parseCookies(req.headers.cookie);
  const session = auth.readSession(cookies[auth.COOKIE_NAME]);
  if (!session) return null;
  const user = await store.getUser(session.uid);
  if (!user || !user.isActive) return null;
  return user;
}

async function requireUser(req) {
  const user = await currentUser(req);
  if (!user) fail('Please log in to continue.', 401);
  return user;
}

async function requireAdmin(req) {
  const user = await requireUser(req);
  if (user.role !== 'admin') fail('Admin access only.', 403);
  return user;
}

/**
 * The checks every "student touches a question" route needs, in one place:
 * the attempt exists, it belongs to this student, it is still open, and the
 * question really is part of that exam.
 */
async function requireAttemptQuestion(req) {
  const user = await requireUser(req);
  const body = await readBody(req);

  const attempt = await store.findAttempt({ id: body.attemptId });
  if (!attempt) fail('That attempt was not found.', 404);
  if (attempt.userId !== user.id) fail('That attempt is not yours.', 403);
  if (attempt.status === 'submitted') fail('You have already submitted this exam.', 409);

  const questions = await store.listQuestions(attempt.examId);
  const question = questions.find((q) => q.id === body.questionId);
  if (!question) fail('That question is not in this exam.', 400);

  return { user, body, attempt, question, questions };
}

/* --------------------------------------------------------------- helpers */

/** Everything the student portal needs to draw itself. */
async function studentSnapshot(user) {
  const marks = await store.listAttendance({ userId: user.id });
  const report = sched.buildReport(user, marks);
  const window = sched.currentWindow(user);
  const todayMark = marks.find((m) => m.date === window.date) || null;
  // Only needed on the "choose your batch" screen.
  const batches = user.batchId ? [] : await store.listBatches({ activeOnly: true });
  return { user, window, todayMark, report, batches, graceMinutes: sched.GRACE_MINUTES };
}

/* --------------------------------------------------------------- routing */

const routes = {

  /* ============================================================== AUTH === */

  'POST /api/auth/signup': async (req, res) => {
    const body = await readBody(req);
    const email = cleanEmail(body.email);
    const name = cleanText(body.name, 'Full name', { max: 80 });
    const phone = cleanText(body.phone, 'Phone number', { max: 20 });
    if (!/^[0-9+\-\s()]{7,20}$/.test(phone)) fail('Please enter a valid phone number.');

    const problem = auth.passwordProblem(body.password);
    if (problem) fail(problem);
    if (body.password !== body.confirmPassword) fail('The two passwords do not match.');

    if (await store.findByEmail(email)) {
      fail('An account with that email already exists. Try logging in instead.', 409);
    }

    const user = await store.createUser({
      email,
      passwordHash: auth.hashPassword(body.password),
      role: 'student',
      name,
      phone,
    });

    send(res, 201, { user }, { 'Set-Cookie': auth.sessionCookie(auth.signSession({ userId: user.id, role: user.role })) });
  },

  'POST /api/auth/login': async (req, res) => {
    const body = await readBody(req);
    const email = String(body.email || '').trim();
    const record = await store.findCredentials(email);

    // Same message and roughly the same work either way, so this cannot be
    // used to discover which email addresses have accounts.
    const ok = record && auth.verifyPassword(body.password || '', record.password_hash);
    if (!ok) fail('Email or password is incorrect.', 401);
    if (record.is_active === false) fail('This account has been deactivated. Please contact your teacher.', 403);

    await store.touchLogin(record.id);
    const user = await store.getUser(record.id);
    send(res, 200, { user }, {
      'Set-Cookie': auth.sessionCookie(auth.signSession({ userId: user.id, role: user.role })),
    });
  },

  'POST /api/auth/logout': (req, res) => {
    send(res, 200, { ok: true }, { 'Set-Cookie': auth.clearCookie() });
  },

  'GET /api/auth/me': async (req, res) => {
    const user = await currentUser(req);
    if (!user) return send(res, 200, { user: null });
    send(res, 200, { user });
  },

  'POST /api/auth/change-password': async (req, res) => {
    const user = await requireUser(req);
    const body = await readBody(req);
    const record = await store.findCredentials(user.email);
    if (!record || !auth.verifyPassword(body.currentPassword || '', record.password_hash)) {
      fail('Your current password is incorrect.', 401);
    }
    const problem = auth.passwordProblem(body.newPassword);
    if (problem) fail(problem);
    if (body.newPassword !== body.confirmPassword) fail('The two passwords do not match.');

    await store.updateUser(user.id, { passwordHash: auth.hashPassword(body.newPassword) });
    await store.invalidateResets(user.id);
    send(res, 200, { ok: true, message: 'Password changed.' });
  },

  /* --- forgot password ---------------------------------------------------
     No email is sent (no mail server is configured). A reset link is created
     and shown to an admin in the Teacher portal, who hands it to the student.
     Swap in SMTP later and the only change is where `resetUrl` goes.        */

  'POST /api/auth/forgot': async (req, res) => {
    const body = await readBody(req);
    const email = String(body.email || '').trim();
    const user = await store.findByEmail(email);

    // Always the same reply, so this cannot be used to test which emails exist.
    const reply = {
      ok: true,
      message: 'If that email has an account, a reset link has been created. ' +
        'Ask your teacher for it — they can see pending requests in the Teacher portal.',
    };
    if (!user) return send(res, 200, reply);

    const { token, tokenHash, expiresAt } = auth.newResetToken();
    await store.createReset({ userId: user.id, tokenHash, expiresAt });

    const base = `http://${req.headers.host || `localhost:${PORT}`}`;
    const resetUrl = `${base}/reset.html?token=${token}`;
    console.log(`\n  * Password reset requested by ${user.email}`);
    console.log(`    ${resetUrl}`);
    console.log(`    (valid for ${auth.RESET_TTL_MINUTES} minutes)\n`);

    // In local/dev use the link is returned so a solo teacher is not stuck.
    send(res, 200, { ...reply, resetUrl: process.env.SHOW_RESET_LINK === 'false' ? undefined : resetUrl });
  },

  'POST /api/auth/reset': async (req, res) => {
    const body = await readBody(req);
    const token = String(body.token || '');
    if (!token) fail('This reset link is not valid.');

    const record = await store.findReset(auth.hashResetToken(token));
    if (!record) fail('This reset link is not valid.');
    if (record.used_at) fail('This reset link has already been used.');
    if (new Date(record.expires_at) < new Date()) fail('This reset link has expired. Please request a new one.');

    const problem = auth.passwordProblem(body.password);
    if (problem) fail(problem);
    if (body.password !== body.confirmPassword) fail('The two passwords do not match.');

    await store.updateUser(record.user_id, { passwordHash: auth.hashPassword(body.password) });
    await store.consumeReset(record.id);
    await store.invalidateResets(record.user_id);
    send(res, 200, { ok: true, message: 'Password updated. You can log in now.' });
  },

  /* =========================================================== STUDENT === */

  'GET /api/student/dashboard': async (req, res) => {
    const user = await requireUser(req);
    send(res, 200, await studentSnapshot(user));
  },

  /* The batches a student can choose from. */
  'GET /api/student/batches': async (req, res) => {
    await requireUser(req);
    send(res, 200, { batches: await store.listBatches({ activeOnly: true }) });
  },

  /* Students pick a batch — that is all. The timetable comes with it, so a
     student can never set their own class time to dodge a late mark. Chosen
     once; only a teacher can move someone to a different batch afterwards. */
  'POST /api/student/profile': async (req, res) => {
    const user = await requireUser(req);
    if (user.batchId) {
      fail('You are already in a batch. Ask your teacher if you need to move.', 409);
    }
    const { batchId } = await readBody(req);
    if (!batchId) fail('Please choose your batch.');

    const batch = await store.getBatch(batchId);
    if (!batch) fail('That batch no longer exists. Pick another one.', 404);
    if (!batch.isActive) fail('That batch is not running at the moment. Pick another one.');

    const updated = await store.updateUser(user.id, { batchId });
    send(res, 200, { user: updated, message: `You joined ${batch.name}.` });
  },

  /* Name and phone stay editable by the student. */
  'POST /api/student/contact': async (req, res) => {
    const user = await requireUser(req);
    const body = await readBody(req);
    const name = cleanText(body.name, 'Full name', { max: 80 });
    const phone = cleanText(body.phone, 'Phone number', { max: 20 });
    if (!/^[0-9+\-\s()]{7,20}$/.test(phone)) fail('Please enter a valid phone number.');
    send(res, 200, { user: await store.updateUser(user.id, { name, phone }) });
  },

  'POST /api/student/attendance': async (req, res) => {
    const user = await requireUser(req);
    if (user.role === 'admin') fail('Admin accounts do not mark attendance.', 400);

    const window = sched.currentWindow(user);
    if (!window.canMark) fail(window.message, 409);

    const { record, already } = await store.markAttendance({
      userId: user.id,
      date: window.date,
      status: window.wouldBe,
      ip: clientIp(req),
      source: 'self',
    });

    const snapshot = await studentSnapshot(user);
    send(res, already ? 200 : 201, {
      ...snapshot,
      already,
      record,
      message: already
        ? `You were already marked ${record.status.toUpperCase()} today at ${new Date(record.markedAt).toLocaleTimeString()}.`
        : record.status === 'late'
          ? 'Marked LATE — your class had already started.'
          : 'Marked PRESENT. See you in class!',
    });
  },

  'GET /api/student/report': async (req, res, url) => {
    const user = await requireUser(req);
    const marks = await store.listAttendance({
      userId: user.id,
      from: url.searchParams.get('from') || undefined,
      to: url.searchParams.get('to') || undefined,
    });
    send(res, 200, {
      user,
      report: sched.buildReport(user, marks, {
        from: url.searchParams.get('from') || undefined,
        to: url.searchParams.get('to') || undefined,
      }),
    });
  },

  /* ---------------------------------------------------- student exams --- */

  /* Every exam released to this student, with its window.

     A paper reaches a student in one of two ways: it went to the whole batch,
     or the teacher named them on it. Makeup papers use the second, which is
     what stops a student who already sat the original from ever seeing it. */
  'GET /api/student/exams': async (req, res) => {
    const user = await requireUser(req);
    if (!user.batchId) return send(res, 200, { exams: [] });

    const [exams, mine, makeups] = await Promise.all([
      store.listExams({ batchId: user.batchId }),
      store.examIdsFor(user.id),
      store.listMakeups({ userId: user.id }),
    ]);
    const makeupByExam = new Map(makeups.map((m) => [m.examId, m]));

    const out = [];
    for (const exam of exams) {
      if (exam.status !== 'published') continue;
      if (exam.audience === 'selected' && !mine.has(exam.id)) continue;

      const questions = await store.listQuestions(exam.id);
      const attempt = await store.findAttempt({ examId: exam.id, userId: user.id });
      const window = grading.examWindow(exam, questions.length, attempt);
      const request = makeupByExam.get(exam.id) || null;

      out.push({
        ...exam,
        questionCount: questions.length,
        marksTotal: Math.round(questions.reduce((s, q) => s + q.marks, 0) * 100) / 100,
        window,
        // Missed = the paper shut and they never started it. Derived, not stored.
        missed: window.phase === 'closed' && !attempt,
        makeup: request
          ? {
            id: request.id, status: request.status, reason: request.reason,
            decisionNote: request.decisionNote, makeupExamId: request.makeupExamId,
            createdAt: request.createdAt, decidedAt: request.decidedAt,
          }
          : null,
        attempt: attempt
          ? {
            id: attempt.id, status: attempt.status, score: attempt.score,
            totalMarks: attempt.totalMarks, percent: attempt.percent,
            correctCount: attempt.correctCount, wrongCount: attempt.wrongCount,
            unansweredCount: attempt.unansweredCount, submittedAt: attempt.submittedAt,
          }
          : null,
      });
    }
    send(res, 200, { exams: out });
  },

  /* Start (or resume) an attempt. The paper comes back WITHOUT the answers. */
  'POST /api/student/exam/start': async (req, res) => {
    const user = await requireUser(req);
    if (user.role === 'admin') fail('Admin accounts do not sit exams.', 400);
    const { examId } = await readBody(req);

    const exam = await store.getExam(examId);
    if (!exam) fail('Exam not found.', 404);
    if (exam.batchId !== user.batchId) fail('This exam is not for your batch.', 403);
    if (exam.audience === 'selected') {
      const named = await store.examIdsFor(user.id);
      if (!named.has(exam.id)) fail('This exam was not released to you.', 403);
    }

    const questions = await store.listQuestions(exam.id);
    let attempt = await store.findAttempt({ examId: exam.id, userId: user.id });

    const window = grading.examWindow(exam, questions.length, attempt);
    if (!window.canStart) fail(window.message, 409);

    if (!attempt) {
      attempt = await store.startAttempt({
        examId: exam.id,
        userId: user.id,
        questionCount: questions.length,
        totalMarks: Math.round(questions.reduce((s, q) => s + q.marks, 0) * 100) / 100,
      });
    }

    const saved = await store.listAnswers(attempt.id);
    const byQuestion = new Map(saved.map((a) => [a.questionId, a]));

    send(res, 200, {
      exam: { ...exam, questionCount: questions.length },
      attempt: { id: attempt.id, status: attempt.status, startedAt: attempt.startedAt },
      window,
      questions: questions.map((q) => {
        const answer = byQuestion.get(q.id);
        const clock = grading.questionTimeLeft(q, answer ? answer.openedAt : null);
        return {
          ...grading.forStudent(q),
          yourAnswer: answer ? answer.answer : '',
          // Time already spent counts on a resume, and an expired question is
          // shut whether or not the browser got round to saying so.
          locked: answer ? answer.locked || clock.expired : false,
          openedAt: clock.openedAt,
          remaining: clock.remaining,
        };
      }),
    });
  },

  /* The student has reached a question — the server stamps the clock and says
     how long is left. Calling it again never restarts the countdown. */
  'POST /api/student/exam/open': async (req, res) => {
    const { attempt, question } = await requireAttemptQuestion(req);

    const row = await store.openQuestion(attempt.id, question.id);
    const clock = grading.questionTimeLeft(question, row.openedAt);

    send(res, 200, {
      questionId: question.id,
      openedAt: clock.openedAt,
      remaining: clock.remaining,
      total: clock.total,
      locked: row.locked || clock.expired,
    });
  },

  /* Save one answer.
     The deadline is checked against the SERVER's clock, using the moment the
     server itself served the question. The browser countdown is only a display,
     so pausing or editing it in DevTools buys no extra time. */
  'POST /api/student/exam/answer': async (req, res) => {
    const { attempt, question, body } = await requireAttemptQuestion(req);
    const { answer, lock } = body;

    const existing = await store.findAnswer(attempt.id, question.id);
    const clock = grading.questionTimeLeft(question, existing ? existing.openedAt : null);

    // Already shut, or shut by the server's own clock. Either way the stored
    // answer stands and this new one is thrown away.
    if ((existing && existing.locked) || clock.expired) {
      const shut = await store.saveAnswer({
        attemptId: attempt.id,
        questionId: question.id,
        answer: existing ? existing.answer : '',
        locked: true,
      });
      send(res, 409, {
        error: 'Time is up for this question — your answer is locked.',
        answer: { questionId: question.id, answer: shut.answer, locked: true, remaining: 0 },
      });
      return;
    }

    const saved = await store.saveAnswer({
      attemptId: attempt.id,
      questionId: question.id,
      answer: String(answer ?? '').slice(0, 2000),
      // The browser may ask to lock, but running out of time is the server's call.
      locked: Boolean(lock) || clock.remaining <= 0,
    });
    send(res, 200, {
      answer: {
        questionId: question.id,
        answer: saved.answer,
        locked: saved.locked,
        remaining: clock.remaining,
      },
    });
  },

  /* Submit and mark. Grading happens here, on the server. */
  'POST /api/student/exam/submit': async (req, res) => {
    const user = await requireUser(req);
    const { attemptId } = await readBody(req);

    const attempt = await store.findAttempt({ id: attemptId });
    if (!attempt) fail('That attempt was not found.', 404);
    if (attempt.userId !== user.id) fail('That attempt is not yours.', 403);

    const questions = await store.listQuestions(attempt.examId);

    if (attempt.status === 'submitted') {
      const answers = await store.listAnswers(attempt.id);
      const { results } = grading.gradeAttempt(questions, new Map(answers.map((a) => [a.questionId, a])));
      return send(res, 200, {
        already: true,
        attempt,
        results,
        totals: {
          score: attempt.score, totalMarks: attempt.totalMarks, percent: attempt.percent,
          correctCount: attempt.correctCount, wrongCount: attempt.wrongCount,
          unansweredCount: attempt.unansweredCount, questionCount: attempt.questionCount,
        },
      });
    }

    const answers = await store.listAnswers(attempt.id);
    const { results, totals } = grading.gradeAttempt(
      questions, new Map(answers.map((a) => [a.questionId, a]))
    );

    for (const result of results) {
      if (result.answerId) {
        await store.gradeAnswer(result.answerId, {
          isCorrect: result.isCorrect,
          marksAwarded: result.marksAwarded,
        });
      }
    }
    const finished = await store.finishAttempt(attempt.id, totals);

    send(res, 201, { already: false, attempt: finished, results, totals });
  },

  /* The full marked paper, once submitted. */
  'GET /api/student/exam/result': async (req, res, url) => {
    const user = await requireUser(req);
    const attempt = await store.findAttempt({ id: url.searchParams.get('attemptId') });
    if (!attempt) fail('That attempt was not found.', 404);
    if (attempt.userId !== user.id && user.role !== 'admin') fail('That attempt is not yours.', 403);
    if (attempt.status !== 'submitted') fail('That exam has not been submitted yet.', 409);

    const questions = await store.listQuestions(attempt.examId);
    const answers = await store.listAnswers(attempt.id);
    const { results } = grading.gradeAttempt(questions, new Map(answers.map((a) => [a.questionId, a])));
    send(res, 200, { attempt, results });
  },

  /* Every exam this student has sat — feeds the Report tab. */
  'GET /api/student/exam/history': async (req, res) => {
    const user = await requireUser(req);
    const attempts = await store.listAttempts({ userId: user.id });
    send(res, 200, { attempts: attempts.filter((a) => a.status === 'submitted') });
  },

  /* Ask the teacher for a second chance at a paper that was missed.

     Only a paper the student genuinely missed can be requested: it must have
     closed, and they must never have started it. That is checked here rather
     than trusted from the browser. */
  'POST /api/student/exam/makeup': async (req, res) => {
    const user = await requireUser(req);
    if (user.role === 'admin') fail('Admin accounts do not sit exams.', 400);
    const { examId, reason } = await readBody(req);

    const exam = await store.getExam(examId);
    if (!exam) fail('Exam not found.', 404);
    if (exam.batchId !== user.batchId) fail('This exam is not for your batch.', 403);
    if (exam.audience === 'selected') {
      fail('This is already a makeup paper. Please speak to your teacher.', 400);
    }

    const questions = await store.listQuestions(exam.id);
    const attempt = await store.findAttempt({ examId: exam.id, userId: user.id });
    if (attempt) fail('You have already opened this exam.', 409);

    const window = grading.examWindow(exam, questions.length, attempt);
    if (window.phase !== 'closed') {
      fail('This exam has not closed yet — you can still sit it.', 409);
    }

    const existing = await store.findMakeup({ examId: exam.id, userId: user.id });
    if (existing && existing.status === 'pending') {
      fail('You have already asked. Your teacher has not decided yet.', 409);
    }
    if (existing && existing.status === 'approved') {
      fail('Your teacher has already approved a makeup paper for you.', 409);
    }
    if (existing && existing.status === 'rejected') {
      fail('Your teacher has already declined this request.', 409);
    }

    const made = await store.createMakeup({
      examId: exam.id,
      userId: user.id,
      reason: cleanText(reason, 'Reason', { max: 500, required: false }),
      source: 'student',
    });
    send(res, 201, { makeup: made });
  },

  /* ============================================================= ADMIN === */

  'GET /api/admin/overview': async (req, res, url) => {
    await requireAdmin(req);
    const today = sched.localDate();
    const from = url.searchParams.get('from') || undefined;
    const to = url.searchParams.get('to') || undefined;

    const students = await store.listUsers({ role: 'student' });
    const marks = await store.listAttendance({ from, to });
    const byUser = new Map();
    for (const m of marks) {
      if (!byUser.has(m.userId)) byUser.set(m.userId, []);
      byUser.get(m.userId).push(m);
    }

    const rows = students.map((student) => {
      const report = sched.buildReport(student, byUser.get(student.id) || [], { from, to });
      const todayMark = (byUser.get(student.id) || []).find((m) => m.date === today) || null;
      const window = sched.currentWindow(student);
      return {
        student,
        today: todayMark
          ? { status: todayMark.status, markedAt: todayMark.markedAt, source: todayMark.source }
          : { status: window.phase === 'not-class-day' ? 'no-class' : 'pending', markedAt: null, source: null },
        present: report.present,
        late: report.late,
        absent: report.absent,
        total: report.total,
        percent: report.percent,
        streak: report.streak,
        lastSeen: report.lastSeen,
      };
    });

    const totals = rows.reduce((acc, r) => ({
      present: acc.present + r.present,
      late: acc.late + r.late,
      absent: acc.absent + r.absent,
      total: acc.total + r.total,
    }), { present: 0, late: 0, absent: 0, total: 0 });

    // Day-by-day totals across all students, for the trend chart.
    const dayMap = new Map();
    for (const student of students) {
      const report = sched.buildReport(student, byUser.get(student.id) || [], { from, to });
      for (const d of report.daily) {
        if (!dayMap.has(d.date)) dayMap.set(d.date, { date: d.date, present: 0, late: 0, absent: 0, total: 0 });
        const bucket = dayMap.get(d.date);
        bucket[d.status]++;
        bucket.total++;
      }
    }
    const daily = [...dayMap.values()].sort((a, b) => a.date.localeCompare(b.date))
      .map((d) => ({ ...d, percent: d.total ? Math.round(((d.present + d.late) / d.total) * 1000) / 10 : 0 }));

    send(res, 200, {
      today,
      totals: {
        ...totals,
        percent: totals.total ? Math.round(((totals.present + totals.late) / totals.total) * 1000) / 10 : 0,
      },
      counts: {
        students: students.length,
        markedToday: rows.filter((r) => r.today.status === 'present' || r.today.status === 'late').length,
        atRisk: rows.filter((r) => r.total > 0 && r.percent < 75).length,
      },
      rows,
      daily,
    });
  },

  'GET /api/admin/students': async (req, res, url) => {
    await requireAdmin(req);
    send(res, 200, {
      students: await store.listUsers({
        role: url.searchParams.get('role') || undefined,
        batchId: url.searchParams.get('batchId') || undefined,
        search: url.searchParams.get('search') || undefined,
      }),
    });
  },

  /* ------------------------------------------------------------ batches -- */

  'GET /api/admin/batches': async (req, res) => {
    await requireAdmin(req);
    const batches = await store.listBatches();
    const students = await store.listUsers({ role: 'student' });
    send(res, 200, {
      batches: batches.map((b) => ({
        ...b,
        studentCount: students.filter((s) => s.batchId === b.id).length,
      })),
      unassigned: students.filter((s) => !s.batchId).length,
    });
  },

  'POST /api/admin/batches': async (req, res) => {
    await requireAdmin(req);
    send(res, 201, { batch: await store.createBatch(readBatchInput(await readBody(req))) });
  },

  'POST /api/admin/batches/update': async (req, res) => {
    await requireAdmin(req);
    const body = await readBody(req);
    const batch = await store.getBatch(body.id);
    if (!batch) fail('Batch not found.', 404);
    send(res, 200, { batch: await store.updateBatch(batch.id, readBatchInput(body, { partial: true })) });
  },

  'POST /api/admin/batches/delete': async (req, res) => {
    await requireAdmin(req);
    const { id } = await readBody(req);
    const batch = await store.getBatch(id);
    if (!batch) fail('Batch not found.', 404);

    // Deleting is allowed, but the teacher should know who it strands.
    const members = await store.countBatchMembers(id);
    await store.deleteBatch(id);
    send(res, 200, {
      ok: true,
      message: members
        ? `Batch deleted. ${members} student${members === 1 ? '' : 's'} now need a new batch.`
        : 'Batch deleted.',
    });
  },

  /* Move a student to another batch (or out of one). */
  'POST /api/admin/student/batch': async (req, res) => {
    await requireAdmin(req);
    const { userId, batchId } = await readBody(req);
    const student = await store.getUser(userId);
    if (!student) fail('Student not found.', 404);

    if (batchId) {
      const batch = await store.getBatch(batchId);
      if (!batch) fail('Batch not found.', 404);
    }
    send(res, 200, { student: await store.updateUser(userId, { batchId: batchId || null }) });
  },

  'GET /api/admin/student': async (req, res, url) => {
    await requireAdmin(req);
    const student = await store.getUser(url.searchParams.get('id'));
    if (!student) fail('Student not found.', 404);
    const marks = await store.listAttendance({ userId: student.id });
    send(res, 200, { student, report: sched.buildReport(student, marks), marks });
  },

  'POST /api/admin/students': async (req, res) => {
    await requireAdmin(req);
    const body = await readBody(req);
    const email = cleanEmail(body.email);
    const name = cleanText(body.name, 'Full name', { max: 80 });
    const problem = auth.passwordProblem(body.password);
    if (problem) fail(problem);
    if (await store.findByEmail(email)) fail('An account with that email already exists.', 409);

    const created = await store.createUser({
      email,
      passwordHash: auth.hashPassword(body.password),
      role: body.role === 'admin' ? 'admin' : 'student',
      name,
      phone: cleanText(body.phone, 'Phone number', { max: 20, required: false }),
    });
    send(res, 201, { student: created });
  },

  'POST /api/admin/student/update': async (req, res) => {
    const admin = await requireAdmin(req);
    const body = await readBody(req);
    const target = await store.getUser(body.id);
    if (!target) fail('Student not found.', 404);

    const changes = {};
    if (body.name !== undefined) changes.name = cleanText(body.name, 'Full name', { max: 80 });
    if (body.phone !== undefined) changes.phone = cleanText(body.phone, 'Phone number', { max: 20, required: false });
    if (body.email !== undefined) changes.email = cleanEmail(body.email);
    if (body.batchId !== undefined) {
      if (body.batchId && !(await store.getBatch(body.batchId))) fail('Batch not found.', 404);
      changes.batchId = body.batchId || null;
    }
    if (body.isActive !== undefined) {
      if (target.id === admin.id && !body.isActive) fail('You cannot deactivate your own account.');
      changes.isActive = !!body.isActive;
    }
    if (body.role !== undefined && ['student', 'admin'].includes(body.role)) {
      if (target.id === admin.id && body.role !== 'admin') fail('You cannot remove your own admin access.');
      if (target.role === 'admin' && body.role !== 'admin' && (await store.countAdmins()) <= 1) {
        fail('This is the only admin account — promote someone else first.');
      }
      changes.role = body.role;
    }
    if (body.newPassword) {
      const problem = auth.passwordProblem(body.newPassword);
      if (problem) fail(problem);
      changes.passwordHash = auth.hashPassword(body.newPassword);
      await store.invalidateResets(target.id);
    }

    send(res, 200, { student: await store.updateUser(target.id, changes) });
  },

  'POST /api/admin/student/delete': async (req, res) => {
    const admin = await requireAdmin(req);
    const { id } = await readBody(req);
    if (id === admin.id) fail('You cannot delete your own account.');
    const target = await store.getUser(id);
    if (!target) fail('Student not found.', 404);
    if (target.role === 'admin' && (await store.countAdmins()) <= 1) {
      fail('This is the only admin account — create another admin first.');
    }
    await store.deleteUser(id);
    send(res, 200, { ok: true });
  },

  /* -------------------------------------------------------------- exams -- */

  'GET /api/admin/exams': async (req, res, url) => {
    await requireAdmin(req);
    send(res, 200, {
      exams: await store.listExams({ batchId: url.searchParams.get('batchId') || undefined }),
    });
  },

  'GET /api/admin/exam': async (req, res, url) => {
    await requireAdmin(req);
    const exam = await store.getExam(url.searchParams.get('id'));
    if (!exam) fail('Exam not found.', 404);
    send(res, 200, { exam, questions: await store.listQuestions(exam.id) });
  },

  /* Step 1 of the wizard: the exam settings. Questions come later. */
  'POST /api/admin/exams': async (req, res) => {
    const admin = await requireAdmin(req);
    const body = await readBody(req);

    const batch = await store.getBatch(body.batchId);
    if (!batch) fail('Please choose a batch.');

    const examDate = String(body.examDate || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(examDate)) fail('Please pick a valid exam date.');
    const startTime = String(body.startTime || '').slice(0, 5);
    if (sched.toMinutes(startTime) === null) fail('Please pick a valid exam time.');

    const totalQuestions = Number(body.totalQuestions);
    if (!Number.isInteger(totalQuestions) || totalQuestions < 1 || totalQuestions > 200) {
      fail('Total questions must be a whole number between 1 and 200.');
    }
    const totalMarks = Number(body.totalMarks);
    if (!Number.isFinite(totalMarks) || totalMarks <= 0 || totalMarks > 10000) {
      fail('Total marks must be a positive number.');
    }
    const secondsPerQuestion = Number(body.secondsPerQuestion);
    if (!Number.isInteger(secondsPerQuestion) || secondsPerQuestion < 5 || secondsPerQuestion > 3600) {
      fail('Time per question must be between 5 and 3600 seconds.');
    }
    if (!['fill', 'mcq', 'both'].includes(body.questionMode)) fail('Pick a question style.');

    // A paper is either for the whole batch or for named students (a makeup).
    const audience = body.audience === 'selected' ? 'selected' : 'batch';
    let studentIds = [];
    if (audience === 'selected') {
      const inBatch = await store.listUsers({ role: 'student', batchId: batch.id });
      const allowed = new Set(inBatch.map((s) => s.id));
      studentIds = [...new Set(body.studentIds || [])].filter((id) => allowed.has(id));
      if (!studentIds.length) fail('Choose at least one student for this paper.');
    }

    const exam = await store.createExam({
      batchId: batch.id,
      title: cleanText(body.title, 'Exam title', { max: 120, required: false }),
      examDate,
      startTime,
      totalQuestions,
      totalMarks,
      secondsPerQuestion,
      questionMode: body.questionMode,
      instructions: cleanText(body.instructions, 'Instructions', { max: 2000, required: false }),
      audience,
      source: body.source === 'upload' ? 'upload' : 'manual',
      createdBy: admin.id,
    });

    if (audience === 'selected') {
      await store.setParticipants(exam.id, studentIds, admin.id);
      // Tie the chosen students' requests to this paper, creating a record for
      // anyone the teacher added directly without being asked.
      for (const userId of studentIds) {
        const existing = body.missedExamId
          ? await store.findMakeup({ examId: body.missedExamId, userId })
          : null;
        if (existing) {
          await store.decideMakeup(existing.id, {
            status: 'approved',
            makeupExamId: exam.id,
            decisionNote: cleanText(body.decisionNote, 'Note', { max: 500, required: false }),
            decidedBy: admin.id,
          });
        } else if (body.missedExamId) {
          const made = await store.createMakeup({
            examId: body.missedExamId, userId, reason: '', source: 'teacher',
          });
          await store.decideMakeup(made.id, {
            status: 'approved', makeupExamId: exam.id, decidedBy: admin.id,
          });
        }
      }
    }

    send(res, 201, { exam, studentIds });
  },

  /* ----------------------------------------------- makeups (teacher) --- */

  /* Everyone waiting on a decision, plus recent decisions for context. */
  'GET /api/admin/makeups': async (req, res, url) => {
    await requireAdmin(req);
    const status = url.searchParams.get('status') || undefined;
    const requests = await store.listMakeups(status ? { status } : {});

    // Attach the replacement paper so the teacher can see what was given.
    const papers = new Map();
    for (const r of requests) {
      if (r.makeupExamId && !papers.has(r.makeupExamId)) {
        papers.set(r.makeupExamId, await store.getExam(r.makeupExamId));
      }
    }
    send(res, 200, {
      requests: requests.map((r) => ({
        ...r,
        makeupExam: r.makeupExamId ? papers.get(r.makeupExamId) : null,
      })),
      pendingCount: requests.filter((r) => r.status === 'pending').length,
    });
  },

  /* Turn a request down, with a reason the student will see. */
  'POST /api/admin/makeups/reject': async (req, res) => {
    const admin = await requireAdmin(req);
    const { id, note } = await readBody(req);
    const request = await store.findMakeup({ id });
    if (!request) fail('That request was not found.', 404);
    if (request.status !== 'pending') fail('That request has already been decided.', 409);

    send(res, 200, {
      makeup: await store.decideMakeup(request.id, {
        status: 'rejected',
        decisionNote: cleanText(note, 'Note', { max: 500, required: false }),
        decidedBy: admin.id,
      }),
    });
  },

  /* Point an approved request at a makeup paper that already exists, and add
     the student to it. Used when several students share one makeup paper. */
  'POST /api/admin/makeups/assign': async (req, res) => {
    const admin = await requireAdmin(req);
    const { id, makeupExamId, note } = await readBody(req);

    const request = await store.findMakeup({ id });
    if (!request) fail('That request was not found.', 404);

    const paper = await store.getExam(makeupExamId);
    if (!paper) fail('That makeup paper was not found.', 404);
    if (paper.id === request.examId) fail('That is the paper they missed — pick a different one.', 400);
    if (paper.audience !== 'selected') {
      fail('That paper is released to the whole batch. Pick a makeup paper instead.', 400);
    }

    const existing = await store.listParticipants(paper.id);
    await store.setParticipants(
      paper.id,
      [...existing.map((p) => p.userId), request.userId],
      admin.id,
    );

    send(res, 200, {
      makeup: await store.decideMakeup(request.id, {
        status: 'approved',
        makeupExamId: paper.id,
        decisionNote: cleanText(note, 'Note', { max: 500, required: false }),
        decidedBy: admin.id,
      }),
    });
  },

  /* Who is named on a restricted paper. */
  'GET /api/admin/exam/participants': async (req, res, url) => {
    await requireAdmin(req);
    const exam = await store.getExam(url.searchParams.get('examId'));
    if (!exam) fail('Exam not found.', 404);
    send(res, 200, { exam, participants: await store.listParticipants(exam.id) });
  },

  'POST /api/admin/exams/update': async (req, res) => {
    await requireAdmin(req);
    const body = await readBody(req);
    const exam = await store.getExam(body.id);
    if (!exam) fail('Exam not found.', 404);

    const changes = {};
    if (body.title !== undefined) changes.title = cleanText(body.title, 'Exam title', { max: 120, required: false });
    if (body.instructions !== undefined) changes.instructions = cleanText(body.instructions, 'Instructions', { max: 2000, required: false });
    if (body.status !== undefined) {
      if (!['draft', 'published'].includes(body.status)) fail('Bad status.');
      if (body.status === 'published') {
        const questions = await store.listQuestions(exam.id);
        if (!questions.length) fail('Add the questions before publishing this exam.');
      }
      changes.status = body.status;
    }
    send(res, 200, { exam: await store.updateExam(exam.id, changes) });
  },

  'POST /api/admin/exams/delete': async (req, res) => {
    await requireAdmin(req);
    const { id } = await readBody(req);
    if (!(await store.getExam(id))) fail('Exam not found.', 404);
    await store.deleteExam(id);
    send(res, 200, { ok: true });
  },

  /* Step 2: save the question set (from the manual editor or the review
     screen after an upload). Replaces whatever was there before. */
  'POST /api/admin/exams/questions': async (req, res) => {
    await requireAdmin(req);
    const body = await readBody(req);
    const exam = await store.getExam(body.examId);
    if (!exam) fail('Exam not found.', 404);
    if (!Array.isArray(body.questions) || !body.questions.length) fail('Add at least one question.');
    if (body.questions.length > 200) fail('An exam can have at most 200 questions.');

    const cleaned = body.questions.map((q, i) => {
      const position = i + 1;
      const type = q.type === 'mcq' ? 'mcq' : 'fill';
      const questionText = String(q.questionText || '').trim();
      if (!questionText) fail(`Question ${position} needs its text.`);
      if (questionText.length > 2000) fail(`Question ${position} is too long.`);

      let options = [];
      if (type === 'mcq') {
        options = (Array.isArray(q.options) ? q.options : [])
          .map((o, index) => ({
            key: String(o.key || String.fromCharCode(65 + index)).trim().toUpperCase().slice(0, 2),
            text: String(o.text || '').trim().slice(0, 500),
          }))
          .filter((o) => o.text);
        if (options.length < 2) fail(`Question ${position} needs at least two options.`);
      }

      const correctAnswer = String(q.correctAnswer || '').trim();
      if (!correctAnswer) fail(`Question ${position} needs its answer.`);
      if (type === 'mcq' && !options.some((o) => o.key === correctAnswer.toUpperCase())) {
        fail(`Question ${position}: the answer must be one of its option letters.`);
      }

      const marks = Number(q.marks);
      return {
        type,
        questionText,
        options,
        correctAnswer: type === 'mcq' ? correctAnswer.toUpperCase() : correctAnswer,
        marks: Number.isFinite(marks) && marks >= 0 ? marks : 1,
        seconds: exam.secondsPerQuestion,
      };
    });

    const questions = await store.replaceQuestions(exam.id, cleaned);
    const changes = { totalQuestions: questions.length };
    if (body.sourceFilename) {
      changes.source = 'upload';
      changes.sourceFilename = String(body.sourceFilename).slice(0, 200);
    }
    await store.updateExam(exam.id, changes);
    send(res, 200, {
      questions,
      exam: await store.getExam(exam.id),
      message: `${questions.length} question${questions.length === 1 ? '' : 's'} saved.`,
    });
  },

  /* Upload a question paper and read the questions + answers out of it. The
     result is returned for review — nothing is stored until the teacher
     confirms it on the next screen. */
  'POST /api/admin/exams/parse': async (req, res) => {
    await requireAdmin(req);
    const body = await readBody(req, MAX_UPLOAD_BODY);

    const filename = String(body.filename || 'upload');
    if (!body.contentBase64) fail('No file was received.');

    let buffer;
    try {
      buffer = Buffer.from(String(body.contentBase64), 'base64');
    } catch {
      fail('That file could not be read.');
    }
    if (!buffer.length) fail('That file is empty.');
    if (buffer.length > MAX_UPLOAD_BYTES) fail('That file is larger than 12 MB.');

    let text;
    try {
      text = parse.extractText(buffer, filename);
    } catch (err) {
      fail(err.message);
    }

    const mode = ['fill', 'mcq', 'both'].includes(body.mode) ? body.mode : 'both';
    const { questions, warnings } = parse.parseQuestions(text, { mode });

    send(res, 200, {
      filename,
      questions,
      warnings,
      textPreview: text.slice(0, 4000),
      characters: text.length,
    });
  },

  /* Every student's score for one exam, plus who has not sat it. */
  'GET /api/admin/exam/results': async (req, res, url) => {
    await requireAdmin(req);
    const exam = await store.getExam(url.searchParams.get('examId'));
    if (!exam) fail('Exam not found.', 404);

    const [questions, attempts, batchStudents, makeups, participants] = await Promise.all([
      store.listQuestions(exam.id),
      store.listAttempts({ examId: exam.id }),
      store.listUsers({ role: 'student', batchId: exam.batchId }),
      store.listMakeups({ examId: exam.id }),
      exam.audience === 'selected' ? store.listParticipants(exam.id) : Promise.resolve(null),
    ]);

    // A restricted paper is only "missed" by the students it was given to.
    const named = participants ? new Set(participants.map((p) => p.userId)) : null;
    const students = named ? batchStudents.filter((s) => named.has(s.id)) : batchStudents;

    const byUser = new Map(attempts.map((a) => [a.userId, a]));
    const askedBy = new Map(makeups.map((m) => [m.userId, m]));
    const window = grading.examWindow(exam, questions.length);
    const closed = window.phase === 'closed';

    const rows = students.map((student) => {
      const attempt = byUser.get(student.id) || null;
      const request = askedBy.get(student.id) || null;
      return {
        student: {
          id: student.id, regNo: student.regNo, name: student.name, email: student.email,
        },
        status: attempt ? attempt.status : 'not-started',
        // Only meaningful once the paper has shut.
        missed: closed && !attempt,
        makeupStatus: request ? request.status : null,
        makeupId: request ? request.id : null,
        makeupReason: request ? request.reason : '',
        attemptId: attempt ? attempt.id : null,
        score: attempt ? attempt.score : 0,
        totalMarks: attempt ? attempt.totalMarks : 0,
        percent: attempt ? attempt.percent : 0,
        correctCount: attempt ? attempt.correctCount : 0,
        wrongCount: attempt ? attempt.wrongCount : 0,
        unansweredCount: attempt ? attempt.unansweredCount : 0,
        submittedAt: attempt ? attempt.submittedAt : null,
      };
    });

    const done = rows.filter((r) => r.status === 'submitted');
    const totalMarks = Math.round(questions.reduce((s, q) => s + q.marks, 0) * 100) / 100;
    const scores = done.map((r) => r.percent).sort((a, b) => a - b);

    send(res, 200, {
      exam: { ...exam, questionCount: questions.length, marksTotal: totalMarks },
      rows: rows.sort((a, b) => b.percent - a.percent || a.student.name.localeCompare(b.student.name)),
      summary: {
        students: rows.length,
        submitted: done.length,
        inProgress: rows.filter((r) => r.status === 'in_progress').length,
        notStarted: rows.filter((r) => r.status === 'not-started').length,
        missed: rows.filter((r) => r.missed).length,
        awaitingDecision: rows.filter((r) => r.makeupStatus === 'pending').length,
        closed,
        average: done.length
          ? Math.round((done.reduce((s, r) => s + r.percent, 0) / done.length) * 10) / 10
          : 0,
        highest: scores.length ? scores[scores.length - 1] : 0,
        lowest: scores.length ? scores[0] : 0,
        passed: done.filter((r) => r.percent >= 40).length,
      },
    });
  },

  /* Every submitted attempt across every exam — the admin Reports tab. */
  'GET /api/admin/exam/scores': async (req, res) => {
    await requireAdmin(req);
    const attempts = await store.listAttempts({});
    send(res, 200, {
      attempts: attempts
        .filter((a) => a.status === 'submitted')
        .map((a) => ({
          id: a.id,
          score: a.score,
          totalMarks: a.totalMarks,
          percent: a.percent,
          correctCount: a.correctCount,
          wrongCount: a.wrongCount,
          unansweredCount: a.unansweredCount,
          questionCount: a.questionCount,
          submittedAt: a.submittedAt,
          student: a.student,
          exam: a.exam ? {
            id: a.exam.id, title: a.exam.title, examDate: a.exam.examDate,
            batchName: a.exam.batch ? a.exam.batch.name : '',
          } : null,
        })),
    });
  },

  'POST /api/admin/attendance': async (req, res) => {
    await requireAdmin(req);
    const body = await readBody(req);
    if (!['present', 'late', 'absent', 'clear'].includes(body.status)) fail('Pick a valid status.');
    const student = await store.getUser(body.userId);
    if (!student) fail('Student not found.', 404);
    const date = String(body.date || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail('Pick a valid date.');
    if (date > sched.localDate()) fail('You cannot record attendance for a future date.');

    await store.setAttendance({
      userId: student.id, date, status: body.status,
      note: body.note ? String(body.note).slice(0, 200) : null,
    });
    send(res, 200, { ok: true });
  },

  'GET /api/admin/log': async (req, res, url) => {
    await requireAdmin(req);
    send(res, 200, {
      entries: await store.listAttendanceWithUsers({
        from: url.searchParams.get('from') || undefined,
        to: url.searchParams.get('to') || undefined,
        limit: Number(url.searchParams.get('limit')) || 300,
      }),
    });
  },

  'GET /api/admin/resets': async (req, res) => {
    await requireAdmin(req);
    send(res, 200, { resets: await store.pendingResets() });
  },

  'GET /api/admin/export.csv': async (req, res, url) => {
    await requireAdmin(req);
    const from = url.searchParams.get('from') || undefined;
    const to = url.searchParams.get('to') || undefined;
    const students = await store.listUsers({ role: 'student' });
    const marks = await store.listAttendance({ from, to });
    const byUser = new Map();
    for (const m of marks) {
      if (!byUser.has(m.userId)) byUser.set(m.userId, []);
      byUser.get(m.userId).push(m);
    }

    const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [[
      'Reg. No.', 'Name', 'Email', 'Phone', 'Batch', 'Course', 'Class time',
      'Class days', 'Present', 'Late', 'Absent', 'Class days counted',
      'Attendance %', 'Punctuality %', 'Current streak', 'Last marked',
    ].map(cell).join(',')];

    for (const s of students) {
      const r = sched.buildReport(s, byUser.get(s.id) || [], { from, to });
      const b = s.batch;
      lines.push([
        s.regNo, s.name, s.email, s.phone,
        b ? b.name : '', b ? b.course : '',
        b && b.classStart ? `${b.classStart}-${b.classEnd}` : '',
        b ? (b.classDays || []).map((d) => sched.DAY_SHORT[d]).join(' ') : '',
        r.present, r.late, r.absent, r.total, r.percent, r.punctuality,
        r.streak, r.lastSeen || '',
      ].map(cell).join(','));
    }

    send(res, 200, lines.join('\n'), {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="attendance-${sched.localDate()}.csv"`,
    });
  },
};

/* --------------------------------------------------------- static server */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = path.join(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR)) return send(res, 403, { error: 'Forbidden' });
  fs.readFile(filePath, (err, buf) => {
    if (err) return send(res, 404, { error: 'Not found' });
    send(res, 200, buf, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
  });
}

/**
 * Handles one request. Kept separate from the listener below so a serverless
 * host (Vercel) can call it directly — there, `public/` is served by the CDN
 * and this only ever sees /api/* paths.
 */
async function requestListener(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const handler = routes[`${req.method} ${url.pathname}`];

  if (handler) {
    try {
      await handler(req, res, url);
    } catch (err) {
      const status = Number.isInteger(err.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
      if (status >= 500) console.error(`  ! ${req.method} ${url.pathname} —`, err.message);
      send(res, status, { error: err.message || 'Something went wrong.' });
    }
    return;
  }
  if (url.pathname.startsWith('/api/')) return send(res, 404, { error: 'Unknown endpoint' });
  if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed' });
  serveStatic(req, res, url.pathname);
}

const server = http.createServer(requestListener);

/* ------------------------------------------------------------------ boot */

/** Creates the first admin from .env so there is a way in on a fresh database. */
async function ensureAdmin() {
  if ((await store.countAdmins()) > 0) return null;

  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) {
    console.log('  ! No admin account exists yet. Set ADMIN_EMAIL and ADMIN_PASSWORD');
    console.log('    in .env and restart, and one will be created for you.');
    return null;
  }

  const existing = await store.findByEmail(email);
  if (existing) {
    await store.updateUser(existing.id, { role: 'admin' });
    return { email, promoted: true };
  }
  await store.createUser({
    email: String(email).trim(),
    passwordHash: auth.hashPassword(password),
    role: 'admin',
    name: process.env.ADMIN_NAME || 'Teacher',
  });
  return { email, promoted: false };
}

/**
 * Class times are converted explicitly in zone.js, so the server's own clock
 * does not matter — running in UTC on a host gives the same answers as running
 * in India on a laptop. All this needs to check is that the configured zone is
 * one the runtime actually knows; a typo would otherwise throw on every request.
 */
const checkTimezone = () => zone.assertValidZone();

async function boot() {
  const tzProblem = checkTimezone();
  if (tzProblem) {
    console.error('\n  x Cannot start — wrong timezone.\n');
    console.error(`    ${tzProblem}\n`);
    process.exitCode = 1;
    return;
  }

  try {
    await store.healthCheck();
  } catch (err) {
    console.error('\n  x Cannot start — Supabase is not ready.\n');
    console.error(`    ${err.message}\n`);
    process.exitCode = 1;
    return;
  }

  let admin = null;
  try {
    admin = await ensureAdmin();
  } catch (err) {
    console.error('  ! Could not create the admin account:', err.message);
  }

  server.listen(PORT, () => {
    console.log('');
    console.log("  Learner's Byte — Attendance & Exam Portal");
    console.log('  ----------------------------------------');
    console.log(`  Open        : http://localhost:${PORT}/`);
    console.log(`  Database    : ${process.env.SUPABASE_URL}  connected`);
    if (admin) {
      console.log(`  Admin login : ${admin.email}  (${admin.promoted ? 'existing account promoted' : 'created from .env'})`);
    }
    console.log(`  Class clock : ${zone.ZONE} — set with APP_TIMEZONE, independent of the host`);
    console.log('');
  });
}

/* Only listen when started directly (`node server.js`). When a serverless host
   imports this file it wants the handler, not a socket. */
if (require.main === module) boot();

/* One-time setup on a serverless instance: make sure an admin exists. The
   promise is cached, so this costs one query per cold start, not per request. */
let readyPromise = null;
const ensureReady = () => {
  if (!readyPromise) {
    readyPromise = ensureAdmin().catch((err) => {
      console.error('  ! Could not create the admin account:', err.message);
    });
  }
  return readyPromise;
};

module.exports = { requestListener, ensureReady, checkTimezone, server };
