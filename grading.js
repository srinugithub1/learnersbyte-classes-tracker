/**
 * Exam timing windows and marking.
 *
 * Exam dates and times are wall-clock in the school's timezone (zone.js), so
 * they mean the same thing whether the server runs in India or in UTC.
 *
 * Correct answers never leave the server until an attempt is submitted, so the
 * question paper a student receives has no answer key in it.
 */

const zone = require('./zone');

/** How long after the scheduled finish a student may still begin. */
const LATE_START_GRACE_MINUTES = 30;

/** Total seconds a paper is expected to take. */
const examDurationSeconds = (exam, questionCount) =>
  Math.max(questionCount, 1) * exam.secondsPerQuestion;

/**
 * The instant the exam starts.
 *
 * The teacher enters a wall-clock time in the school's timezone, so that is
 * what this resolves — not the server's own clock, which on a host is UTC.
 */
function examStartsAt(exam) {
  return zone.instantOf(exam.examDate, exam.startTime || '00:00');
}

/**
 * When the paper shuts.
 *
 * A teacher-set finish time wins: "this exam ends at 11:00" is a promise to the
 * class and must not be undone by arithmetic on the per-question timer. With no
 * finish time set, the old rule stands — questions × seconds from the start.
 */
function examEndsAt(exam, questionCount) {
  if (exam.endTime) return zone.instantOf(exam.examDate, exam.endTime);
  return new Date(examStartsAt(exam).getTime() + examDurationSeconds(exam, questionCount) * 1000);
}

/** Seconds until the paper shuts. 0 once it has. */
function examTimeLeft(exam, questionCount, now = new Date()) {
  return Math.max(0, Math.ceil((examEndsAt(exam, questionCount).getTime() - now.getTime()) / 1000));
}

/**
 * Can this student press Start right now?
 * phase: not-published | upcoming | open | closed | completed | in-progress
 *
 * `expired` says the paper is over for a student who still has it open — the
 * caller must submit and mark it rather than let them keep typing.
 */
function examWindow(exam, questionCount, attempt = null, now = new Date()) {
  const startsAt = examStartsAt(exam);
  const endsAt = examEndsAt(exam, questionCount);
  const fixedEnd = Boolean(exam.endTime);

  // A late start is a kindness for a paper whose finish was only ever implied.
  // Once a teacher names the finish time, that time is the finish time.
  const lastStart = fixedEnd
    ? endsAt
    : new Date(endsAt.getTime() + LATE_START_GRACE_MINUTES * 60000);

  const base = {
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
    fixedEnd,
    durationSeconds: examDurationSeconds(exam, questionCount),
    secondsLeft: Math.max(0, Math.ceil((endsAt.getTime() - now.getTime()) / 1000)),
    passMarks: passMarkOf(exam),
  };

  if (attempt && attempt.status === 'submitted') {
    return { ...base, phase: 'completed', canStart: false, expired: false,
      message: 'You have already submitted this exam.' };
  }
  if (attempt && attempt.status === 'in_progress') {
    // Only a teacher-set finish time takes a paper away mid-attempt. Without
    // one the finish is merely questions x seconds — an estimate, not a
    // promise — and a student who reads slowly between questions would find
    // their paper snatched away for no stated reason.
    if (fixedEnd && now > endsAt) {
      return { ...base, phase: 'closed', canStart: false, expired: true,
        message: 'Time is up — this exam has been submitted for you.' };
    }
    return { ...base, phase: 'in-progress', canStart: true, expired: false,
      message: 'You have this exam open — continue where you left off.' };
  }
  if (exam.status !== 'published') {
    return { ...base, phase: 'not-published', canStart: false,
      message: 'This exam has not been released by your teacher yet.' };
  }
  if (!questionCount) {
    return { ...base, phase: 'not-published', canStart: false,
      message: 'This exam has no questions yet.' };
  }
  if (now < startsAt) {
    return { ...base, phase: 'upcoming', canStart: false,
      message: `This exam opens on ${zone.formatDateTime(startsAt)}.` };
  }
  if (now > lastStart) {
    return { ...base, phase: 'closed', canStart: false, expired: false,
      message: 'This exam has closed.' };
  }
  return { ...base, phase: 'open', canStart: true, expired: false,
    message: 'You can start now.' };
}

/* ------------------------------------------------------------ pass mark -- */

/** The pass mark, or null when the teacher did not set one. */
function passMarkOf(exam) {
  const raw = exam ? exam.passMarks : null;
  if (raw === null || raw === undefined || raw === '') return null;
  const mark = Number(raw);
  return Number.isFinite(mark) ? mark : null;
}

/**
 * Did this score pass?
 * `passed` is null — not false — when no pass mark was set, so "no pass mark"
 * is never mistaken for "failed".
 */
function passOutcome(exam, score) {
  const passMarks = passMarkOf(exam);
  if (passMarks === null) return { passMarks: null, passed: null };
  return { passMarks, passed: Number(score) >= passMarks };
}

/* -------------------------------------------------- per-question clock -- */

/**
 * Slack allowed on a per-question deadline, in seconds.
 *
 * The browser's countdown and the server's clock are never perfectly aligned,
 * and the answer still has to travel over the network. Without this, an honest
 * student answering on the very last tick would be told they were too late.
 * It is deliberately small — enough for latency, not enough to think with.
 */
const DEADLINE_SLACK_SECONDS = 3;

/**
 * How long is left on this question, according to the server.
 *
 * `openedAt` is stamped by the server the first time the question is served, so
 * this cannot be influenced from the browser. A question that was never opened
 * has its full time — the student has not seen it yet.
 */
function questionTimeLeft(question, openedAt, now = new Date()) {
  const total = Number(question.seconds) || 0;
  if (!openedAt) return { total, remaining: total, expired: false, openedAt: null };

  const elapsed = (now.getTime() - new Date(openedAt).getTime()) / 1000;
  const remaining = Math.max(0, Math.ceil(total - elapsed));
  return {
    total,
    remaining,
    expired: elapsed > total + DEADLINE_SLACK_SECONDS,
    openedAt: new Date(openedAt).toISOString(),
  };
}

/* ------------------------------------------------------------- marking -- */

const normalise = (value) => String(value ?? '')
  .trim()
  .toLowerCase()
  .replace(/\s+/g, ' ')
  .replace(/[.,;:!?]+$/, '');

/**
 * Is this answer right?
 * Multiple choice compares the option letter. Fill-in-the-blank compares text
 * loosely (case, spacing and trailing punctuation are ignored), and the key may
 * list several acceptable answers separated by "|".
 */
function isAnswerCorrect(question, answer) {
  const given = String(answer ?? '').trim();
  if (!given) return false;

  if (question.type === 'mcq') {
    return given.toUpperCase() === String(question.correctAnswer || '').toUpperCase();
  }
  const accepted = String(question.correctAnswer || '')
    .split('|')
    .map(normalise)
    .filter(Boolean);
  return accepted.includes(normalise(given));
}

/**
 * Mark a whole attempt.
 * Returns per-question results plus the totals to store on the attempt.
 */
function gradeAttempt(questions, answersByQuestion) {
  let score = 0;
  let correctCount = 0;
  let wrongCount = 0;
  let unansweredCount = 0;

  const results = questions.map((question) => {
    const saved = answersByQuestion.get(question.id) || null;
    const given = saved ? saved.answer : '';
    const attempted = Boolean(String(given).trim());
    const correct = attempted && isAnswerCorrect(question, given);
    const marksAwarded = correct ? question.marks : 0;

    if (!attempted) unansweredCount++;
    else if (correct) { correctCount++; score += question.marks; }
    else wrongCount++;

    return {
      answerId: saved ? saved.id : null,
      questionId: question.id,
      position: question.position,
      type: question.type,
      questionText: question.questionText,
      options: question.options,
      correctAnswer: question.correctAnswer,
      yourAnswer: given,
      attempted,
      isCorrect: correct,
      marks: question.marks,
      marksAwarded,
    };
  });

  const totalMarks = questions.reduce((sum, q) => sum + q.marks, 0);

  return {
    results,
    totals: {
      score: Math.round(score * 100) / 100,
      totalMarks: Math.round(totalMarks * 100) / 100,
      correctCount,
      wrongCount,
      unansweredCount,
      questionCount: questions.length,
      percent: totalMarks ? Math.round((score / totalMarks) * 1000) / 10 : 0,
    },
  };
}

/** Strips the answer key — this is what a student is allowed to receive. */
const forStudent = (question) => ({
  id: question.id,
  position: question.position,
  type: question.type,
  questionText: question.questionText,
  options: question.options,
  marks: question.marks,
  seconds: question.seconds,
});

module.exports = {
  examStartsAt, examEndsAt, examWindow, examDurationSeconds, examTimeLeft,
  passMarkOf, passOutcome,
  isAnswerCorrect, gradeAttempt, forStudent,
  questionTimeLeft,
  LATE_START_GRACE_MINUTES, DEADLINE_SLACK_SECONDS,
};
