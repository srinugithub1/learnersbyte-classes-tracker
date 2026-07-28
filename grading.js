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

function examEndsAt(exam, questionCount) {
  return new Date(examStartsAt(exam).getTime() + examDurationSeconds(exam, questionCount) * 1000);
}

/**
 * Can this student press Start right now?
 * phase: not-published | upcoming | open | closed | completed | in-progress
 */
function examWindow(exam, questionCount, attempt = null, now = new Date()) {
  const startsAt = examStartsAt(exam);
  const endsAt = examEndsAt(exam, questionCount);
  const lastStart = new Date(endsAt.getTime() + LATE_START_GRACE_MINUTES * 60000);

  const base = {
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
    durationSeconds: examDurationSeconds(exam, questionCount),
  };

  if (attempt && attempt.status === 'submitted') {
    return { ...base, phase: 'completed', canStart: false,
      message: 'You have already submitted this exam.' };
  }
  if (attempt && attempt.status === 'in_progress') {
    return { ...base, phase: 'in-progress', canStart: true,
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
    return { ...base, phase: 'closed', canStart: false,
      message: 'This exam has closed.' };
  }
  return { ...base, phase: 'open', canStart: true, message: 'You can start now.' };
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
  examStartsAt, examEndsAt, examWindow, examDurationSeconds,
  isAnswerCorrect, gradeAttempt, forStudent,
  questionTimeLeft,
  LATE_START_GRACE_MINUTES, DEADLINE_SLACK_SECONDS,
};
