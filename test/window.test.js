/**
 * Exam finish times and pass marks — pure logic, no server and no database.
 *
 *   node test/window.test.js
 *
 * These are the rules that decide when a paper shuts and who passed, so they
 * are worth pinning down on their own rather than only through the UI.
 */

process.env.APP_TIMEZONE = process.env.APP_TIMEZONE || 'Asia/Calcutta';

const grading = require('../grading');
const zone = require('../zone');

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? ` — ${extra}` : ''}`); }
};
const section = (t) => console.log(`\n== ${t} ==`);

/** A wall-clock moment on exam day, in the school's timezone. */
const at = (hhmm) => zone.instantOf('2026-08-10', hhmm);

const baseExam = {
  examDate: '2026-08-10',
  startTime: '10:00',
  endTime: '',
  secondsPerQuestion: 60,
  status: 'published',
  passMarks: null,
};

/* ------------------------------------------------------------ finish time */

section('when the paper shuts');

const openEnded = { ...baseExam };
ok('with no end time, the finish is questions x seconds',
  grading.examEndsAt(openEnded, 10).getTime() === at('10:10').getTime(),
  grading.examEndsAt(openEnded, 10).toISOString());

const fixed = { ...baseExam, endTime: '11:00' };
ok('an end time wins over the question timers',
  grading.examEndsAt(fixed, 10).getTime() === at('11:00').getTime(),
  grading.examEndsAt(fixed, 10).toISOString());

ok('and it wins even when the timers would run longer',
  grading.examEndsAt({ ...fixed, secondsPerQuestion: 3600 }, 10).getTime() === at('11:00').getTime());

ok('time left counts down to the end time',
  grading.examTimeLeft(fixed, 10, at('10:59')) === 60);
ok('and never goes below zero',
  grading.examTimeLeft(fixed, 10, at('12:00')) === 0);

/* ----------------------------------------------------------------- phases */

section('what a student is allowed to do');

const win = (exam, now, attempt = null) => grading.examWindow(exam, 10, attempt, now);

ok('before the start it is upcoming', win(fixed, at('09:59')).phase === 'upcoming');
ok('and cannot be started', win(fixed, at('09:59')).canStart === false);
ok('during the window it is open', win(fixed, at('10:30')).phase === 'open');
ok('one minute before the end it is still open', win(fixed, at('10:59')).phase === 'open');
ok('after the end time it is closed', win(fixed, at('11:01')).phase === 'closed');
ok('and cannot be started', win(fixed, at('11:01')).canStart === false);

// The 30-minute late-start grace exists for papers with no stated finish. Once
// a teacher names the finish time, that promise has to hold.
ok('an open-ended paper still allows a late start',
  win(openEnded, at('10:20')).canStart === true);
ok('a paper with an end time does not',
  win(fixed, at('11:20')).canStart === false);

ok('the window reports the finish is fixed', win(fixed, at('10:30')).fixedEnd === true);
ok('and open-ended when it is not', win(openEnded, at('10:05')).fixedEnd === false);
ok('it carries the seconds left', win(fixed, at('10:30')).secondsLeft === 1800);

/* ---------------------------------------------------- a paper left open */

section('a student still writing when time runs out');

const busy = { status: 'in_progress' };
const during = win(fixed, at('10:30'), busy);
ok('mid-exam they may carry on', during.phase === 'in-progress' && during.canStart === true);
ok('and nothing needs closing', during.expired === false);

const after = win(fixed, at('11:05'), busy);
ok('past the end they may not', after.canStart === false);
ok('and the paper is flagged for closing', after.expired === true);
ok('with an honest message', /submitted for you/i.test(after.message), after.message);

const done = win(fixed, at('11:05'), { status: 'submitted' });
ok('an already-submitted paper is never re-closed', done.expired === false);
ok('and reads as completed', done.phase === 'completed');

/* ------------------------------------------------------------ pass marks */

section('pass or fail');

ok('no pass mark means no verdict', grading.passOutcome(baseExam, 18).passed === null);
ok('and the mark is reported as null', grading.passOutcome(baseExam, 18).passMarks === null);

const graded = { ...baseExam, passMarks: 8 };
ok('above the mark passes', grading.passOutcome(graded, 12).passed === true);
ok('exactly the mark passes', grading.passOutcome(graded, 8).passed === true);
ok('below the mark fails', grading.passOutcome(graded, 7.5).passed === false);
ok('zero fails', grading.passOutcome(graded, 0).passed === false);
ok('the mark comes back with the verdict', grading.passOutcome(graded, 12).passMarks === 8);

// Zero is a real pass mark — everybody passes — and must not be read as "unset".
const freebie = { ...baseExam, passMarks: 0 };
ok('a pass mark of zero is kept, not treated as missing',
  grading.passMarkOf(freebie) === 0);
ok('and everyone passes it', grading.passOutcome(freebie, 0).passed === true);

ok('a blank pass mark is treated as unset', grading.passMarkOf({ passMarks: '' }) === null);
ok('so is nonsense', grading.passMarkOf({ passMarks: 'abc' }) === null);

/* --------------------------------------------------------------- rollover */

section('an exam that runs past midnight is not supported quietly');

// end_time is a time of day on the same date, so 23:00–00:30 would read as
// backwards. The server refuses it at creation; this records why.
const backwards = { ...baseExam, startTime: '23:00', endTime: '00:30' };
ok('a finish before the start would end before it begins',
  grading.examEndsAt(backwards, 10).getTime() < grading.examStartsAt(backwards).getTime());

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exitCode = fail ? 1 : 0;
