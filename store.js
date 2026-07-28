/**
 * Supabase data layer — PostgREST over fetch, no npm dependency.
 *
 * This is the only file that knows Supabase exists. It uses the service_role
 * key, which bypasses Row Level Security, so nothing here may ever be exposed
 * to the browser; server.js decides who is allowed to call what.
 */

const URL_BASE = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const KEY = process.env.SUPABASE_SERVICE_KEY || '';
const REST = `${URL_BASE}/rest/v1`;

/**
 * Whether the database credentials are present. This deliberately does NOT
 * throw while the module is loading: on a serverless host that turns a missing
 * environment variable into an opaque "function crashed" page with nothing to
 * go on. Reporting it per-request gives an answer instead.
 */
const missingConfig = () => {
  const missing = [];
  if (!URL_BASE) missing.push('SUPABASE_URL');
  if (!KEY) missing.push('SUPABASE_SERVICE_KEY');
  return missing.length ? missing : null;
};

function assertConfigured() {
  const missing = missingConfig();
  if (!missing) return;
  const err = new Error(
    `Supabase is not configured — ${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} not set.\n` +
    '    Locally: copy .env.example to .env and fill them in.\n' +
    '    On Vercel: Project -> Settings -> Environment Variables, then redeploy.'
  );
  err.status = 500;
  err.setupRequired = true;
  throw err;
}

if (missingConfig() && require.main) {
  console.error('\n  x Supabase is not configured.');
  console.error(`    Missing: ${missingConfig().join(', ')}`);
  console.error('    Copy .env.example to .env and fill it in.\n');
}

/* ------------------------------------------------------- PostgREST client */

async function rest(pathname, { method = 'GET', body, prefer, headers = {} } = {}) {
  assertConfigured();
  const res = await fetch(`${REST}${pathname}`, {
    method,
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
      ...(prefer ? { Prefer: prefer } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = text; } }

  if (!res.ok) {
    const err = new Error(data && data.message ? data.message : `Supabase request failed (${res.status})`);
    err.status = res.status;
    err.code = data && data.code;
    err.details = data && data.details;
    throw err;
  }
  return data;
}

const select = (table, query = '') => rest(`/${table}?${query}`);
const insert = (table, row) => rest(`/${table}`, { method: 'POST', body: row, prefer: 'return=representation' });
const patch = (table, query, row) => rest(`/${table}?${query}`, { method: 'PATCH', body: row, prefer: 'return=representation' });
const remove = (table, query) => rest(`/${table}?${query}`, { method: 'DELETE', prefer: 'return=representation' });

const enc = encodeURIComponent;
const isDuplicate = (err) => err.status === 409 || err.code === '23505';

/** Confirms the schema exists. Called once at startup. */
async function healthCheck() {
  for (const t of ['batches', 'users', 'attendance', 'password_resets',
    'exams', 'exam_questions', 'exam_attempts', 'exam_answers',
    'exam_participants', 'exam_makeups']) {
    try {
      await select(t, 'select=count&limit=1');
    } catch (err) {
      if (err.code === 'PGRST205' || /schema cache/i.test(err.message || '')) {
        const e = new Error(
          `Table "public.${t}" does not exist yet.\n` +
          '    Open Supabase -> SQL Editor -> New query and run:\n' +
          '      supabase/migration-batches.sql  (batches upgrade)\n' +
          '      supabase/migration-exams.sql    (exams)\n' +
          '      supabase/migration-attempts.sql (students sitting exams)\n' +
          '      supabase/migration-deadlines.sql (server-side question timers)\n' +
          '      supabase/migration-makeups.sql   (missed-exam makeups)\n' +
          '      supabase/schema.sql             (fresh install — replaces all)\n' +
          '    Then restart this server.'
        );
        e.setupRequired = true;
        throw e;
      }
      throw err;
    }
  }
  // The batches upgrade also removes users.batch — catch a half-applied state.
  try {
    await select('users', 'select=batch_id&limit=1');
  } catch (err) {
    const e = new Error(
      'Your "users" table has no batch_id column yet.\n' +
      '    Run supabase/migration-batches.sql in the Supabase SQL Editor,\n' +
      '    then restart this server.'
    );
    e.setupRequired = true;
    throw e;
  }
  // Per-question deadlines are kept on the server, in exam_answers.opened_at.
  try {
    await select('exam_answers', 'select=opened_at&limit=1');
  } catch (err) {
    const e = new Error(
      'Your "exam_answers" table has no opened_at column yet.\n' +
      '    Run supabase/migration-deadlines.sql in the Supabase SQL Editor,\n' +
      '    then restart this server.'
    );
    e.setupRequired = true;
    throw e;
  }
}

/* ------------------------------------------------------- shape converters */

const toBatch = (r) => (!r ? null : {
  id: r.id,
  name: r.name,
  course: r.course || '',
  classStart: r.class_start ? String(r.class_start).slice(0, 5) : '',
  classEnd: r.class_end ? String(r.class_end).slice(0, 5) : '',
  classDays: Array.isArray(r.class_days) ? r.class_days : [],
  isActive: r.is_active !== false,
  notes: r.notes || '',
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** Never leaks password_hash — that column is stripped here, once, for good. */
function toUser(r) {
  if (!r) return null;
  const batch = r.batches ? toBatch(r.batches) : null;
  return {
    id: r.id,
    regNo: r.reg_no,
    email: r.email,
    role: r.role,
    name: r.name || '',
    phone: r.phone || '',
    batchId: r.batch_id || null,
    batch,                               // the whole timetable, or null
    batchName: batch ? batch.name : '',
    course: batch ? batch.course : '',
    profileCompleted: Boolean(r.batch_id),
    extra: r.extra || {},
    isActive: r.is_active !== false,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastLoginAt: r.last_login_at,
  };
}

const toMark = (r) => (!r ? null : {
  id: r.id,
  userId: r.user_id,
  date: r.attend_date,
  status: r.status,
  markedAt: r.marked_at,
  source: r.source,
  ip: r.ip,
  note: r.note,
});

const USER_COLS = 'id,reg_no,email,role,name,phone,batch_id,extra,is_active,' +
  'created_at,updated_at,last_login_at,batches(*)';

/* ---------------------------------------------------------------- batches */

async function listBatches({ activeOnly = false } = {}) {
  const parts = ['select=*', 'order=name.asc'];
  if (activeOnly) parts.push('is_active=eq.true');
  return (await select('batches', parts.join('&'))).map(toBatch);
}

async function getBatch(id) {
  if (!id) return null;
  const rows = await select('batches', `select=*&id=eq.${enc(id)}&limit=1`);
  return rows.length ? toBatch(rows[0]) : null;
}

function batchRow(data) {
  const row = {};
  const map = {
    name: 'name', course: 'course', classStart: 'class_start',
    classEnd: 'class_end', classDays: 'class_days', isActive: 'is_active', notes: 'notes',
  };
  for (const [key, column] of Object.entries(map)) {
    if (data[key] !== undefined) row[column] = data[key];
  }
  return row;
}

async function createBatch(data) {
  try {
    const [row] = await insert('batches', batchRow(data));
    return toBatch(row);
  } catch (err) {
    if (isDuplicate(err)) {
      const e = new Error('A batch with that name already exists.');
      e.status = 409;
      throw e;
    }
    throw err;
  }
}

async function updateBatch(id, data) {
  const row = batchRow(data);
  if (!Object.keys(row).length) return getBatch(id);
  row.updated_at = new Date().toISOString();
  try {
    const [updated] = await patch('batches', `id=eq.${enc(id)}`, row);
    return toBatch(updated);
  } catch (err) {
    if (isDuplicate(err)) {
      const e = new Error('Another batch already uses that name.');
      e.status = 409;
      throw e;
    }
    throw err;
  }
}

/** Students keep their records; batch_id is set to null by the FK rule. */
async function deleteBatch(id) {
  const rows = await remove('batches', `id=eq.${enc(id)}`);
  return rows.length > 0;
}

async function countBatchMembers(batchId) {
  const rows = await select('users', `select=id&batch_id=eq.${enc(batchId)}`);
  return rows.length;
}

/* ------------------------------------------------------------------ users */

async function listUsers({ role, batchId, search } = {}) {
  const parts = [`select=${USER_COLS}`, 'order=created_at.asc'];
  if (role) parts.push(`role=eq.${enc(role)}`);
  if (batchId) parts.push(`batch_id=eq.${enc(batchId)}`);
  if (search) {
    const q = `*${String(search).replace(/[*,()]/g, '')}*`;
    parts.push(`or=(name.ilike.${enc(q)},email.ilike.${enc(q)},reg_no.ilike.${enc(q)},phone.ilike.${enc(q)})`);
  }
  return (await select('users', parts.join('&'))).map(toUser);
}

async function getUser(id) {
  if (!id) return null;
  const rows = await select('users', `select=${USER_COLS}&id=eq.${enc(id)}&limit=1`);
  return rows.length ? toUser(rows[0]) : null;
}

async function findByEmail(email) {
  const needle = String(email || '').trim().toLowerCase();
  if (!needle) return null;
  const rows = await select('users', `select=${USER_COLS}&email=ilike.${enc(needle)}&limit=1`);
  return rows.length ? toUser(rows[0]) : null;
}

/** Returns the row WITH its password hash — only for the login check. */
async function findCredentials(email) {
  const needle = String(email || '').trim().toLowerCase();
  if (!needle) return null;
  const rows = await select('users', `select=id,email,role,password_hash,is_active&email=ilike.${enc(needle)}&limit=1`);
  return rows.length ? rows[0] : null;
}

async function createUser({ email, passwordHash, role = 'student', name = '', phone = '' }) {
  try {
    const [row] = await insert('users', {
      email: String(email).trim(),
      password_hash: passwordHash,
      role,
      name,
      phone,
    });
    return toUser(row);
  } catch (err) {
    if (isDuplicate(err)) {
      const e = new Error('An account with that email address already exists.');
      e.status = 409;
      throw e;
    }
    throw err;
  }
}

async function updateUser(id, changes) {
  const row = {};
  const map = {
    name: 'name', phone: 'phone', batchId: 'batch_id',
    email: 'email', role: 'role', isActive: 'is_active', extra: 'extra',
  };
  for (const [key, column] of Object.entries(map)) {
    if (changes[key] !== undefined) row[column] = changes[key];
  }
  if (changes.passwordHash !== undefined) row.password_hash = changes.passwordHash;
  if (!Object.keys(row).length) return getUser(id);

  row.updated_at = new Date().toISOString();
  try {
    await patch('users', `id=eq.${enc(id)}`, row);
    return await getUser(id);
  } catch (err) {
    if (isDuplicate(err)) {
      const e = new Error('Another account already uses that email address.');
      e.status = 409;
      throw e;
    }
    throw err;
  }
}

async function touchLogin(id) {
  await patch('users', `id=eq.${enc(id)}`, { last_login_at: new Date().toISOString() });
}

async function deleteUser(id) {
  const rows = await remove('users', `id=eq.${enc(id)}`);   // attendance cascades
  return rows.length > 0;
}

async function countAdmins() {
  const rows = await select('users', 'select=id&role=eq.admin');
  return rows.length;
}

/* ------------------------------------------------------------- attendance */

async function listAttendance({ userId, from, to } = {}) {
  const parts = ['select=*', 'order=attend_date.desc'];
  if (userId) parts.push(`user_id=eq.${enc(userId)}`);
  if (from) parts.push(`attend_date=gte.${enc(from)}`);
  if (to) parts.push(`attend_date=lte.${enc(to)}`);
  return (await select('attendance', parts.join('&'))).map(toMark);
}

/** Attendance joined with student details — for the admin day log. */
async function listAttendanceWithUsers({ from, to, limit = 500 } = {}) {
  const parts = [
    'select=*,users(id,reg_no,name,email,batches(name,course))',
    'order=attend_date.desc,marked_at.desc',
    `limit=${Number(limit) || 500}`,
  ];
  if (from) parts.push(`attend_date=gte.${enc(from)}`);
  if (to) parts.push(`attend_date=lte.${enc(to)}`);
  const rows = await select('attendance', parts.join('&'));
  return rows.map((r) => ({
    ...toMark(r),
    student: r.users ? {
      id: r.users.id, regNo: r.users.reg_no, name: r.users.name, email: r.users.email,
      batchName: r.users.batches ? r.users.batches.name : '',
      course: r.users.batches ? r.users.batches.course : '',
    } : null,
  }));
}

async function findMark(userId, date) {
  const rows = await select('attendance',
    `select=*&user_id=eq.${enc(userId)}&attend_date=eq.${enc(date)}&limit=1`);
  return rows.length ? toMark(rows[0]) : null;
}

/**
 * Record attendance for a day. The (user_id, attend_date) unique constraint
 * makes a second row impossible, so a duplicate click is resolved by reading
 * back the row that already exists.
 */
async function markAttendance({ userId, date, status, ip, source = 'self', note }) {
  try {
    const [row] = await insert('attendance', {
      user_id: userId, attend_date: date, status, ip, source, note,
    });
    return { record: toMark(row), already: false };
  } catch (err) {
    if (isDuplicate(err)) {
      const existing = await findMark(userId, date);
      if (existing) return { record: existing, already: true };
    }
    throw err;
  }
}

/** Admin override: force a status for a day, or clear the record entirely. */
async function setAttendance({ userId, date, status, note }) {
  await remove('attendance', `user_id=eq.${enc(userId)}&attend_date=eq.${enc(date)}`);
  if (status === 'clear') return null;
  const [row] = await insert('attendance', {
    user_id: userId, attend_date: date, status,
    source: 'admin', ip: 'admin-override', note,
  });
  return toMark(row);
}

/* --------------------------------------------------------- password resets */

async function createReset({ userId, tokenHash, expiresAt }) {
  const [row] = await insert('password_resets', {
    user_id: userId, token_hash: tokenHash, expires_at: expiresAt,
  });
  return row;
}

async function findReset(tokenHash) {
  const rows = await select('password_resets',
    `select=*&token_hash=eq.${enc(tokenHash)}&limit=1`);
  return rows.length ? rows[0] : null;
}

async function consumeReset(id) {
  await patch('password_resets', `id=eq.${enc(id)}`, { used_at: new Date().toISOString() });
}

/** Invalidate any outstanding tokens once a password actually changes. */
async function invalidateResets(userId) {
  await patch('password_resets', `user_id=eq.${enc(userId)}&used_at=is.null`,
    { used_at: new Date().toISOString() });
}

/* ------------------------------------------------------------------ exams */

const toExam = (r) => (!r ? null : {
  id: r.id,
  batchId: r.batch_id,
  batch: r.batches ? toBatch(r.batches) : null,
  title: r.title || '',
  examDate: r.exam_date,
  startTime: r.start_time ? String(r.start_time).slice(0, 5) : '',
  totalQuestions: r.total_questions,
  totalMarks: Number(r.total_marks),
  secondsPerQuestion: r.seconds_per_question,
  questionMode: r.question_mode,
  source: r.source,
  sourceFilename: r.source_filename || '',
  instructions: r.instructions || '',
  audience: r.audience || 'batch',
  status: r.status,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  questionCount: Array.isArray(r.exam_questions) ? r.exam_questions.length : undefined,
});

const toQuestion = (r) => (!r ? null : {
  id: r.id,
  examId: r.exam_id,
  position: r.position,
  type: r.type,
  questionText: r.question_text,
  options: Array.isArray(r.options) ? r.options : [],
  correctAnswer: r.correct_answer || '',
  marks: Number(r.marks),
  seconds: r.seconds,
});

const EXAM_COLS = '*,batches(*),exam_questions(id)';

async function listExams({ batchId } = {}) {
  const parts = [`select=${EXAM_COLS}`, 'order=exam_date.desc,start_time.desc'];
  if (batchId) parts.push(`batch_id=eq.${enc(batchId)}`);
  return (await select('exams', parts.join('&'))).map(toExam);
}

async function getExam(id) {
  if (!id) return null;
  const rows = await select('exams', `select=${EXAM_COLS}&id=eq.${enc(id)}&limit=1`);
  return rows.length ? toExam(rows[0]) : null;
}

async function createExam(data) {
  const [row] = await insert('exams', {
    batch_id: data.batchId,
    title: data.title || '',
    exam_date: data.examDate,
    start_time: data.startTime,
    total_questions: data.totalQuestions,
    total_marks: data.totalMarks,
    seconds_per_question: data.secondsPerQuestion,
    question_mode: data.questionMode,
    instructions: data.instructions || '',
    audience: data.audience === 'selected' ? 'selected' : 'batch',
    source: data.source || 'manual',
    source_filename: data.sourceFilename || null,
    created_by: data.createdBy || null,
  });
  return getExam(row.id);
}

async function updateExam(id, data) {
  const row = {};
  const map = {
    title: 'title', examDate: 'exam_date', startTime: 'start_time',
    totalQuestions: 'total_questions', totalMarks: 'total_marks',
    secondsPerQuestion: 'seconds_per_question', questionMode: 'question_mode',
    source: 'source', sourceFilename: 'source_filename', status: 'status',
    instructions: 'instructions',
    audience: 'audience',
    batchId: 'batch_id',
  };
  for (const [key, column] of Object.entries(map)) {
    if (data[key] !== undefined) row[column] = data[key];
  }
  if (!Object.keys(row).length) return getExam(id);
  row.updated_at = new Date().toISOString();
  await patch('exams', `id=eq.${enc(id)}`, row);
  return getExam(id);
}

async function deleteExam(id) {
  const rows = await remove('exams', `id=eq.${enc(id)}`);   // questions cascade
  return rows.length > 0;
}

async function listQuestions(examId) {
  const rows = await select('exam_questions',
    `select=*&exam_id=eq.${enc(examId)}&order=position.asc`);
  return rows.map(toQuestion);
}

/** Replaces the whole question set for an exam, so saving is idempotent. */
async function replaceQuestions(examId, questions) {
  await remove('exam_questions', `exam_id=eq.${enc(examId)}`);
  if (!questions.length) return [];
  const rows = await insert('exam_questions', questions.map((q, i) => ({
    exam_id: examId,
    position: i + 1,
    type: q.type,
    question_text: q.questionText,
    options: q.options || [],
    correct_answer: q.correctAnswer || '',
    marks: q.marks,
    seconds: q.seconds ?? null,
  })));
  return rows.map(toQuestion);
}

/* --------------------------------------------------------- exam attempts */

const toAttempt = (r) => (!r ? null : {
  id: r.id,
  examId: r.exam_id,
  userId: r.user_id,
  status: r.status,
  startedAt: r.started_at,
  submittedAt: r.submitted_at,
  score: Number(r.score),
  totalMarks: Number(r.total_marks),
  correctCount: r.correct_count,
  wrongCount: r.wrong_count,
  unansweredCount: r.unanswered_count,
  questionCount: r.question_count,
  percent: Number(r.total_marks) ? Math.round((Number(r.score) / Number(r.total_marks)) * 1000) / 10 : 0,
  exam: r.exams ? toExam(r.exams) : null,
  student: r.users ? {
    id: r.users.id, regNo: r.users.reg_no, name: r.users.name, email: r.users.email,
  } : null,
});

const toAnswer = (r) => (!r ? null : {
  id: r.id,
  attemptId: r.attempt_id,
  questionId: r.question_id,
  answer: r.answer || '',
  locked: !!r.locked,
  isCorrect: r.is_correct,
  marksAwarded: Number(r.marks_awarded),
  answeredAt: r.answered_at,
  openedAt: r.opened_at || null,
});

async function findAttempt({ examId, userId, id }) {
  const parts = ['select=*,exams(*,batches(*)),users(id,reg_no,name,email)', 'limit=1'];
  if (id) parts.push(`id=eq.${enc(id)}`);
  if (examId) parts.push(`exam_id=eq.${enc(examId)}`);
  if (userId) parts.push(`user_id=eq.${enc(userId)}`);
  const rows = await select('exam_attempts', parts.join('&'));
  return rows.length ? toAttempt(rows[0]) : null;
}

async function startAttempt({ examId, userId, questionCount, totalMarks }) {
  try {
    const [row] = await insert('exam_attempts', {
      exam_id: examId, user_id: userId,
      question_count: questionCount, total_marks: totalMarks,
      unanswered_count: questionCount,
    });
    return toAttempt(row);
  } catch (err) {
    // Already started — a refresh or a second tab. Return the original.
    if (isDuplicate(err)) return findAttempt({ examId, userId });
    throw err;
  }
}

async function listAttempts({ examId, userId } = {}) {
  const parts = ['select=*,exams(*,batches(*)),users(id,reg_no,name,email)', 'order=started_at.desc'];
  if (examId) parts.push(`exam_id=eq.${enc(examId)}`);
  if (userId) parts.push(`user_id=eq.${enc(userId)}`);
  return (await select('exam_attempts', parts.join('&'))).map(toAttempt);
}

async function listAnswers(attemptId) {
  const rows = await select('exam_answers', `select=*&attempt_id=eq.${enc(attemptId)}`);
  return rows.map(toAnswer);
}

async function findAnswer(attemptId, questionId) {
  const rows = await select('exam_answers',
    `select=*&attempt_id=eq.${enc(attemptId)}&question_id=eq.${enc(questionId)}&limit=1`);
  return rows.length ? toAnswer(rows[0]) : null;
}

/**
 * Stamp the moment a question was served, once and once only.
 *
 * The first call writes `opened_at`; every later call returns the row it
 * already has. That is what makes the deadline unforgeable — re-opening a
 * question cannot restart its clock.
 */
async function openQuestion(attemptId, questionId) {
  const existing = await findAnswer(attemptId, questionId);
  if (existing) {
    if (existing.openedAt) return existing;
    const [row] = await patch('exam_answers',
      `attempt_id=eq.${enc(attemptId)}&question_id=eq.${enc(questionId)}`,
      { opened_at: new Date().toISOString() });
    return toAnswer(row);
  }
  try {
    const [row] = await insert('exam_answers', {
      attempt_id: attemptId, question_id: questionId, answer: '',
      opened_at: new Date().toISOString(),
    });
    return toAnswer(row);
  } catch (err) {
    if (isDuplicate(err)) return findAnswer(attemptId, questionId);
    throw err;
  }
}

/** Save (or update) one answer. A locked row is never overwritten. */
async function saveAnswer({ attemptId, questionId, answer, locked }) {
  const existing = await findAnswer(attemptId, questionId);
  if (existing) {
    if (existing.locked) return existing;      // the timer already closed it
    const [row] = await patch('exam_answers',
      `attempt_id=eq.${enc(attemptId)}&question_id=eq.${enc(questionId)}`,
      { answer, locked: !!locked, answered_at: new Date().toISOString() });
    return toAnswer(row);
  }
  try {
    const [row] = await insert('exam_answers', {
      attempt_id: attemptId, question_id: questionId, answer, locked: !!locked,
      opened_at: new Date().toISOString(),
    });
    return toAnswer(row);
  } catch (err) {
    if (isDuplicate(err)) return findAnswer(attemptId, questionId);
    throw err;
  }
}

async function gradeAnswer(id, { isCorrect, marksAwarded }) {
  await patch('exam_answers', `id=eq.${enc(id)}`, {
    is_correct: isCorrect, marks_awarded: marksAwarded, locked: true,
  });
}

async function finishAttempt(id, totals) {
  const [row] = await patch('exam_attempts', `id=eq.${enc(id)}`, {
    status: 'submitted',
    submitted_at: new Date().toISOString(),
    score: totals.score,
    total_marks: totals.totalMarks,
    correct_count: totals.correctCount,
    wrong_count: totals.wrongCount,
    unanswered_count: totals.unansweredCount,
    question_count: totals.questionCount,
  });
  return toAttempt(row);
}

/* ------------------------------------------- restricted papers & makeups */

const toParticipant = (r) => (!r ? null : {
  id: r.id,
  examId: r.exam_id,
  userId: r.user_id,
  student: r.users
    ? { id: r.users.id, regNo: r.users.reg_no, name: r.users.name, email: r.users.email }
    : null,
  createdAt: r.created_at,
});

const toMakeup = (r) => (!r ? null : {
  id: r.id,
  examId: r.exam_id,
  userId: r.user_id,
  makeupExamId: r.makeup_exam_id,
  reason: r.reason || '',
  status: r.status,
  source: r.source,
  decisionNote: r.decision_note || '',
  decidedAt: r.decided_at,
  createdAt: r.created_at,
  exam: r.exams ? toExam(r.exams) : null,
  student: r.users
    ? { id: r.users.id, regNo: r.users.reg_no, name: r.users.name, email: r.users.email }
    : null,
});

async function listParticipants(examId) {
  const rows = await select('exam_participants',
    `select=*,users!user_id(id,reg_no,name,email)&exam_id=eq.${enc(examId)}`);
  return rows.map(toParticipant);
}

/** Every exam id this student has been named on. */
async function examIdsFor(userId) {
  const rows = await select('exam_participants', `select=exam_id&user_id=eq.${enc(userId)}`);
  return new Set(rows.map((r) => r.exam_id));
}

/** Replaces the named students for an exam in one go. */
async function setParticipants(examId, userIds, addedBy = null) {
  await remove('exam_participants', `exam_id=eq.${enc(examId)}`);
  const wanted = [...new Set((userIds || []).filter(Boolean))];
  if (!wanted.length) return [];
  await insert('exam_participants', wanted.map((userId) => ({
    exam_id: examId, user_id: userId, added_by: addedBy,
  })));
  return listParticipants(examId);
}

// exam_makeups points at exams twice (exam_id, makeup_exam_id) and at users
// twice (user_id, decided_by), so each embed must name its column.
const MAKEUP_COLS = '*,exams!exam_id(*,batches(*)),users!user_id(id,reg_no,name,email)';

async function listMakeups({ examId, userId, status } = {}) {
  const parts = [`select=${MAKEUP_COLS}`, 'order=created_at.desc'];
  if (examId) parts.push(`exam_id=eq.${enc(examId)}`);
  if (userId) parts.push(`user_id=eq.${enc(userId)}`);
  if (status) parts.push(`status=eq.${enc(status)}`);
  return (await select('exam_makeups', parts.join('&'))).map(toMakeup);
}

async function findMakeup({ id, examId, userId }) {
  const parts = [`select=${MAKEUP_COLS}`, 'limit=1'];
  if (id) parts.push(`id=eq.${enc(id)}`);
  if (examId) parts.push(`exam_id=eq.${enc(examId)}`);
  if (userId) parts.push(`user_id=eq.${enc(userId)}`);
  const rows = await select('exam_makeups', parts.join('&'));
  return rows.length ? toMakeup(rows[0]) : null;
}

/** One request per student per missed exam — a second ask returns the first. */
async function createMakeup({ examId, userId, reason, source }) {
  try {
    const [row] = await insert('exam_makeups', {
      exam_id: examId,
      user_id: userId,
      reason: String(reason || '').slice(0, 500),
      source: source === 'teacher' ? 'teacher' : 'student',
    });
    return findMakeup({ id: row.id });
  } catch (err) {
    if (isDuplicate(err)) return findMakeup({ examId, userId });
    throw err;
  }
}

async function decideMakeup(id, { status, makeupExamId, decisionNote, decidedBy }) {
  const [row] = await patch('exam_makeups', `id=eq.${enc(id)}`, {
    status,
    makeup_exam_id: makeupExamId || null,
    decision_note: String(decisionNote || '').slice(0, 500),
    decided_by: decidedBy || null,
    decided_at: new Date().toISOString(),
  });
  return row ? findMakeup({ id: row.id }) : null;
}

async function pendingResets() {
  const rows = await select('password_resets',
    'select=*,users(id,reg_no,name,email)&used_at=is.null&order=created_at.desc&limit=50');
  return rows
    .filter((r) => new Date(r.expires_at) > new Date())
    .map((r) => ({
      id: r.id,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      student: r.users ? { id: r.users.id, regNo: r.users.reg_no, name: r.users.name, email: r.users.email } : null,
    }));
}

module.exports = {
  missingConfig, assertConfigured,
  healthCheck,
  listBatches, getBatch, createBatch, updateBatch, deleteBatch, countBatchMembers,
  listUsers, getUser, findByEmail, findCredentials, createUser, updateUser,
  touchLogin, deleteUser, countAdmins,
  listAttendance, listAttendanceWithUsers, findMark, markAttendance, setAttendance,
  createReset, findReset, consumeReset, invalidateResets, pendingResets,
  listExams, getExam, createExam, updateExam, deleteExam,
  listQuestions, replaceQuestions,
  findAttempt, startAttempt, listAttempts, listAnswers, findAnswer,
  openQuestion, saveAnswer, gradeAnswer, finishAttempt,
  listParticipants, setParticipants, examIdsFor,
  listMakeups, findMakeup, createMakeup, decideMakeup,
};
