/**
 * Tests for the logic that does not touch the database: password hashing,
 * session signing, class-time rules and report maths.
 *
 *   node test/logic.test.js
 */

process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key-for-session-derivation';

const auth = require('../auth');
const sched = require('../schedule');
const grading = require('../grading');

let pass = 0;
let fail = 0;
const ok = (name, cond) => {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}`); }
};
const section = (title) => console.log(`\n== ${title} ==`);

/* --------------------------------------------------------------- passwords */
section('passwords');
const hash = auth.hashPassword('Secret123');
ok('hash does not contain the plaintext', !hash.includes('Secret123'));
ok('correct password verifies', auth.verifyPassword('Secret123', hash));
ok('wrong password is rejected', !auth.verifyPassword('Secret124', hash));
ok('same password hashes differently (salted)', auth.hashPassword('Secret123') !== hash);
ok('malformed hash fails safely', auth.verifyPassword('x', 'not-a-hash') === false);
ok('empty stored hash fails safely', auth.verifyPassword('x', '') === false);
ok('short password rejected', Boolean(auth.passwordProblem('Ab1')));
ok('letters-only rejected', Boolean(auth.passwordProblem('abcdefgh')));
ok('digits-only rejected', Boolean(auth.passwordProblem('12345678')));
ok('valid password accepted', auth.passwordProblem('Secret123') === null);

/* ---------------------------------------------------------------- sessions */
section('sessions');
const token = auth.signSession({ userId: 'u1', role: 'student' });
ok('valid token round-trips', auth.readSession(token).uid === 'u1');
ok('role is preserved', auth.readSession(token).role === 'student');

const [payload, signature] = token.split('.');
const forgedPayload = Buffer.from(JSON.stringify({
  uid: 'u1', role: 'admin', exp: Date.now() + 9e6,
})).toString('base64url');
ok('privilege escalation is blocked', auth.readSession(`${forgedPayload}.${signature}`) === null);
ok('tampered signature is blocked', auth.readSession(`${payload}.AAAA`) === null);
ok('garbage token is blocked', auth.readSession('nonsense') === null);
ok('empty token is blocked', auth.readSession('') === null);
ok('null token is blocked', auth.readSession(null) === null);

const expired = (() => {
  const body = Buffer.from(JSON.stringify({ uid: 'u1', role: 'student', exp: Date.now() - 1000 })).toString('base64url');
  const crypto = require('crypto');
  const secret = crypto.createHash('sha256')
    .update('udayan-session:' + process.env.SUPABASE_SERVICE_KEY).digest('hex');
  return `${body}.${crypto.createHmac('sha256', secret).update(body).digest('base64url')}`;
})();
ok('expired token is rejected', auth.readSession(expired) === null);

ok('reset tokens are unique', auth.newResetToken().token !== auth.newResetToken().token);
const reset = auth.newResetToken();
ok('reset token hash matches', auth.hashResetToken(reset.token) === reset.tokenHash);
ok('reset hash is not the token', reset.tokenHash !== reset.token);

/* ------------------------------------------------------------ class timing */
section('class timing (batch 10:00-11:00, fixed 15 min grace, Mon-Fri)');
const batch = {
  id: 'b1', name: 'Morning', course: 'Maths',
  classStart: '10:00', classEnd: '11:00',
  classDays: [1, 2, 3, 4, 5], isActive: true,
};
const student = { batchId: 'b1', batch, createdAt: '2026-07-01T00:00:00Z' };
const at = (h, m) => new Date(2026, 6, 27, h, m, 0);   // Monday 27 July 2026

ok('09:00 is too early', sched.currentWindow(student, at(9, 0)).phase === 'too-early');
ok('09:31 opens the window', sched.currentWindow(student, at(9, 31)).phase === 'present');
ok('10:00 marks present', sched.currentWindow(student, at(10, 0)).wouldBe === 'present');
ok('10:15 still present (grace edge)', sched.currentWindow(student, at(10, 15)).wouldBe === 'present');
ok('10:16 becomes late', sched.currentWindow(student, at(10, 16)).wouldBe === 'late');
ok('grace is fixed at 15 minutes', sched.GRACE_MINUTES === 15);
ok('10:59 still late', sched.currentWindow(student, at(10, 59)).wouldBe === 'late');
ok('11:00 still markable (end edge)', sched.currentWindow(student, at(11, 0)).canMark === true);
ok('11:01 is closed', sched.currentWindow(student, at(11, 1)).phase === 'closed');
ok('closed cannot be marked', sched.currentWindow(student, at(11, 1)).canMark === false);
ok('Sunday is not a class day',
  sched.currentWindow(student, new Date(2026, 6, 26, 10, 0)).phase === 'not-class-day');
ok('no batch blocks marking',
  sched.currentWindow({ ...student, batch: null, batchId: null }, at(10, 0)).canMark === false);
ok('no batch reports the right phase',
  sched.currentWindow({ ...student, batch: null }, at(10, 0)).phase === 'no-batch');
ok('a paused batch blocks marking',
  sched.currentWindow({ ...student, batch: { ...batch, isActive: false } }, at(10, 0)).canMark === false);
ok('students cannot carry their own class time',
  sched.currentWindow({ ...student, batch: null, classStart: '10:00', classEnd: '11:00',
    classDays: [1, 2, 3, 4, 5] }, at(10, 0)).canMark === false);

/* ------------------------------------------------------------ report maths */
section('report maths');
// 1 July 2026 is a Wednesday, so Jul 1-3 are three weekday class days.
const marks = [
  { date: '2026-07-01', status: 'present', markedAt: '2026-07-01T10:00:00Z' },
  { date: '2026-07-02', status: 'late', markedAt: '2026-07-02T10:30:00Z' },
  { date: '2026-07-03', status: 'present', markedAt: '2026-07-03T10:00:00Z' },
];
const full = sched.buildReport(student, marks, { from: '2026-07-01', to: '2026-07-03' });
ok('3 class days counted', full.total === 3);
ok('2 present', full.present === 2);
ok('1 late', full.late === 1);
ok('0 absent', full.absent === 0);
ok('attendance is 100%', full.percent === 100);
ok('punctuality is 66.7%', full.punctuality === 66.7);
ok('streak counts late as attended', full.streak === 3);

const partial = sched.buildReport(student, [marks[0]], { from: '2026-07-01', to: '2026-07-03' });
ok('unmarked class days become absent', partial.absent === 2);
ok('attendance is 33.3%', partial.percent === 33.3);
ok('streak breaks on absence', partial.streak === 0);
ok('best streak remembered', partial.bestStreak === 1);

ok('weekends are not counted',
  sched.buildReport(student, [], { from: '2026-07-04', to: '2026-07-05' }).total === 0);
ok('days before joining are not counted',
  sched.buildReport(student, [], { from: '2026-06-01', to: '2026-06-30' }).total === 0);
ok('empty report does not divide by zero',
  sched.buildReport(student, [], { from: '2026-07-04', to: '2026-07-05' }).percent === 0);
ok('a student with no batch has no class days',
  sched.buildReport({ ...student, batch: null }, [], { from: '2026-07-01', to: '2026-07-31' }).total === 0);

const monthly = sched.buildReport(student, marks, { from: '2026-07-01', to: '2026-07-03' }).monthly;
ok('one month bucket', monthly.length === 1);
ok('month bucket totals match', monthly[0].total === 3 && monthly[0].percent === 100);

/* -------------------------------------------------------- school clock -- */
section('school clock (independent of the host timezone)');

const zone = require('../zone');

// A fixed instant: 2026-07-28 10:05 in Kolkata is 04:35 UTC. Every assertion
// below is written against that instant, so it holds whether this process runs
// in Asia/Calcutta or, as on Vercel, in UTC.
const tenOhFive = new Date('2026-07-28T04:35:00Z');

ok('the class clock is configurable', typeof zone.ZONE === 'string' && zone.ZONE.includes('/'));
ok('a known zone is accepted', zone.assertValidZone('Asia/Calcutta') === null);
ok('a nonsense zone is caught', typeof zone.assertValidZone('Mars/Olympus') === 'string');

ok('the date is the school date', zone.dateKey(tenOhFive) === '2026-07-28');
ok('minutes are the school wall clock', zone.minutesOfDay(tenOhFive) === 605);
ok('weekday comes from the date, not the clock', zone.weekdayOf('2026-07-28') === 2);
ok('a date late in the UTC day is still the right school date',
  zone.dateKey(new Date('2026-07-28T18:45:00Z')) === '2026-07-29');
ok('and one just before UTC midnight does not roll back',
  zone.dateKey(new Date('2026-07-27T23:00:00Z')) === '2026-07-28');

ok('10:00 school time resolves to the right instant',
  zone.instantOf('2026-07-28', '10:00').toISOString() === '2026-07-28T04:30:00.000Z');
ok('midnight school time resolves correctly',
  zone.instantOf('2026-07-28', '00:00').toISOString() === '2026-07-27T18:30:00.000Z');
ok('round trip: instantOf then dateKey agree',
  zone.dateKey(zone.instantOf('2026-07-28', '00:30')) === '2026-07-28');

ok('adding a day crosses a month end', zone.addDays('2026-07-31', 1) === '2026-08-01');
ok('and works backwards', zone.addDays('2026-03-01', -1) === '2026-02-28');
ok('leap years are handled', zone.addDays('2028-02-28', 1) === '2028-02-29');

ok('an exam at 10:00 starts at 04:30 UTC',
  grading.examStartsAt({ examDate: '2026-07-28', startTime: '10:00' }).toISOString()
    === '2026-07-28T04:30:00.000Z');

// The same window checks as above, but driven from a UTC instant rather than a
// locally-constructed Date — this is what a cloud host actually passes in.
ok('10:05 school time is present, computed from a UTC instant',
  sched.currentWindow(student, tenOhFive).wouldBe === 'present');
ok('10:21 school time is late, computed from a UTC instant',
  sched.currentWindow(student, new Date('2026-07-28T04:51:00Z')).wouldBe === 'late');

/* ------------------------------------------------- per-question deadlines */
section('per-question clock');

const q30 = { seconds: 30 };
const secondsAgo = (isoSecondsAgo) => new Date(Date.now() - isoSecondsAgo * 1000).toISOString();

let clk = grading.questionTimeLeft(q30, null);
ok('an unseen question has its full time', clk.remaining === 30 && clk.expired === false);

clk = grading.questionTimeLeft(q30, secondsAgo(10));
ok('ten seconds in leaves twenty', clk.remaining === 20);

clk = grading.questionTimeLeft(q30, secondsAgo(29));
ok('one second before the end is still open', clk.expired === false && clk.remaining === 1);

clk = grading.questionTimeLeft(q30, secondsAgo(31));
ok('a second past the end shows nothing left', clk.remaining === 0);
ok('but latency slack keeps it acceptable', clk.expired === false);

clk = grading.questionTimeLeft(q30, secondsAgo(30 + grading.DEADLINE_SLACK_SECONDS + 1));
ok('past the slack it is expired', clk.expired === true && clk.remaining === 0);

clk = grading.questionTimeLeft(q30, secondsAgo(6000));
ok('long past the end stays expired, never negative',
  clk.expired === true && clk.remaining === 0);

ok('the slack is small enough to be useless for thinking',
  grading.DEADLINE_SLACK_SECONDS <= 5);


/* ------------------------------------------------ back-filled attendance */
section('filling in days from before sign-up');

// This student signed up on 20 July, but the course began on 1 June.
const lateSignup = { batchId: 'b1', batch, createdAt: '2026-07-20T00:00:00Z' };

ok('by default they are counted from sign-up',
  sched.accountableFrom(lateSignup, []) === '2026-07-20');

// 1 June 2026 is a Monday, so Jun 1-5 are five weekday class days.
const juneMarks = [
  { date: '2026-06-01', status: 'present', markedAt: '2026-06-01T10:00:00Z' },
  { date: '2026-06-02', status: 'late',    markedAt: '2026-06-02T10:30:00Z' },
  { date: '2026-06-03', status: 'present', markedAt: '2026-06-03T10:00:00Z' },
];

ok('A BACK-FILLED DAY MOVES THE START BACK',
  sched.accountableFrom(lateSignup, juneMarks) === '2026-06-01');

const backfilled = sched.buildReport(lateSignup, juneMarks, { from: '2026-06-01', to: '2026-06-05' });
ok('the June days now appear in the report', backfilled.total === 5, `got ${backfilled.total}`);
ok('two present', backfilled.present === 2);
ok('one late', backfilled.late === 1);
ok('and the two unfilled class days count as absent', backfilled.absent === 2);
ok('so the percentage covers June too', backfilled.percent === 60, `got ${backfilled.percent}`);

const monthsBack = backfilled.monthly;
ok('June has its own month bucket', monthsBack.some((m) => m.month === '2026-06'));

// An explicit start date does the same without needing any marks first.
const declared = { ...lateSignup, attendanceFrom: '2026-06-01' };
ok('an explicit start date is honoured',
  sched.accountableFrom(declared, []) === '2026-06-01');
ok('and unmarked class days before sign-up count as absent',
  sched.buildReport(declared, [], { from: '2026-06-01', to: '2026-06-05' }).absent === 5);

// A genuinely new student must NOT be punished for the term before they joined.
ok('a mid-course joiner is still counted from their own start',
  sched.buildReport(lateSignup, [], { from: '2026-06-01', to: '2026-06-05' }).total === 0);

/* ------------------------------------------------------------------ output */
console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exitCode = fail ? 1 : 0;
