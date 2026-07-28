/**
 * Class-timing rules and report aggregation.
 *
 * A student's timetable comes from their BATCH, which only a teacher can
 * create or edit. Students just pick a batch.
 *
 * Status is decided by WHEN the student clicks, against their batch's times:
 *
 *   opens 30 min before start ─┬─ within start + 15 min ───► PRESENT
 *                              ├─ after that, before end ──► LATE
 *                              └─ after class end ─────────► too late; the day
 *                                                            counts as ABSENT
 *
 * A day with no record is ABSENT — but only on that batch's class days, and
 * only from the day the student joined. Non-class days and dates before
 * sign-up are never counted against anyone.
 *
 * All times are wall-clock times in the school's timezone (APP_TIMEZONE, see
 * zone.js). The server's own timezone is never used, so this behaves the same
 * on a laptop in India and on a host running in UTC.
 */

const zone = require('./zone');

/** Fixed for every batch. Change this one number to change it everywhere. */
const GRACE_MINUTES = 15;

const EARLY_WINDOW_MINUTES = 30;   // how long before class the button unlocks
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "YYYY-MM-DD" on the school's clock. */
const localDate = (d = new Date()) => zone.dateKey(d);

/** Minutes since midnight for "HH:MM". */
function toMinutes(hhmm) {
  if (!hhmm) return null;
  const [h, m] = String(hhmm).split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}

function minutesToHHMM(mins) {
  const wrapped = ((mins % 1440) + 1440) % 1440;
  return `${String(Math.floor(wrapped / 60)).padStart(2, '0')}:${String(wrapped % 60).padStart(2, '0')}`;
}

function formatTime(hhmm) {
  const mins = toMinutes(hhmm);
  if (mins === null) return '';
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const suffix = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${suffix}`;
}

/** The timetable a student is on, or null if they have not picked a batch. */
const scheduleOf = (user) => (user && user.batch ? user.batch : null);

const isClassDay = (batch, date) =>
  Boolean(batch) && (batch.classDays || []).includes(zone.weekdayOf(date));

/**
 * Where the student stands right now for today's class.
 * phase: no-batch | inactive-batch | not-class-day | too-early | present | late | closed
 */
function currentWindow(user, now = new Date()) {
  const date = localDate(now);
  const batch = scheduleOf(user);

  if (!batch) {
    return { date, phase: 'no-batch', canMark: false,
      message: 'Choose your batch to start marking attendance.' };
  }
  if (batch.isActive === false) {
    return { date, phase: 'inactive-batch', canMark: false,
      message: `Batch "${batch.name}" is not running at the moment. Ask your teacher.` };
  }

  const start = toMinutes(batch.classStart);
  const end = toMinutes(batch.classEnd);
  if (start === null || end === null) {
    return { date, phase: 'no-batch', canMark: false,
      message: 'Your batch has no class time set. Ask your teacher.' };
  }

  if (!isClassDay(batch, date)) {
    const days = (batch.classDays || []).map((d) => DAY_SHORT[d]).join(', ');
    return { date, phase: 'not-class-day', canMark: false,
      message: `No class today. ${batch.name} runs on ${days || 'no days yet'}.` };
  }

  const nowMins = zone.minutesOfDay(now);
  const opensAt = start - EARLY_WINDOW_MINUTES;

  if (nowMins < opensAt) {
    return { date, phase: 'too-early', canMark: false,
      message: `Attendance opens at ${formatTime(minutesToHHMM(opensAt))}, 30 minutes before your class.` };
  }
  if (nowMins <= start + GRACE_MINUTES) {
    return { date, phase: 'present', canMark: true, wouldBe: 'present',
      message: `Mark now and you are PRESENT. Late after ${formatTime(minutesToHHMM(start + GRACE_MINUTES))}.` };
  }
  if (nowMins <= end) {
    return { date, phase: 'late', canMark: true, wouldBe: 'late',
      message: `Class started at ${formatTime(batch.classStart)}. Marking now records you as LATE.` };
  }
  return { date, phase: 'closed', canMark: false,
    message: `Your class ended at ${formatTime(batch.classEnd)}. Today is recorded as absent.` };
}

/** Every date the student was expected in class, oldest first. */
function expectedDates(user, from, to) {
  const batch = scheduleOf(user);
  if (!batch) return [];

  const joined = localDate(new Date(user.createdAt));
  const start = from && from > joined ? from : joined;
  const end = to || localDate();
  const out = [];

  // Walk the calendar as date strings — no Date-in-local-timezone anywhere.
  let cursor = start;
  let guard = 0;
  while (cursor <= end && guard++ < 4000) {
    if (isClassDay(batch, cursor)) out.push(cursor);
    cursor = zone.addDays(cursor, 1);
  }
  return out;
}

/**
 * Full report for one student: totals, a day-by-day series (absences filled
 * in), and a per-month roll-up for the charts.
 */
function buildReport(user, marks, { from, to } = {}) {
  const byDate = new Map(marks.map((m) => [m.date, m]));
  const today = localDate();
  const dates = expectedDates(user, from, to).filter((d) => d <= today);

  const daily = dates.map((date) => {
    const mark = byDate.get(date);
    return {
      date,
      status: mark ? mark.status : 'absent',
      markedAt: mark ? mark.markedAt : null,
      source: mark ? mark.source : null,
      recorded: Boolean(mark),
    };
  });

  const present = daily.filter((d) => d.status === 'present').length;
  const late = daily.filter((d) => d.status === 'late').length;
  const absent = daily.filter((d) => d.status === 'absent').length;
  const total = daily.length;
  const attended = present + late;

  // Current streak of consecutive attended class days, counting backwards.
  let streak = 0;
  for (let i = daily.length - 1; i >= 0; i--) {
    if (daily[i].status === 'absent') break;
    streak++;
  }

  let bestStreak = 0;
  let run = 0;
  for (const d of daily) {
    run = d.status === 'absent' ? 0 : run + 1;
    if (run > bestStreak) bestStreak = run;
  }

  const monthMap = new Map();
  for (const d of daily) {
    const key = d.date.slice(0, 7);
    if (!monthMap.has(key)) monthMap.set(key, { month: key, present: 0, late: 0, absent: 0, total: 0 });
    const bucket = monthMap.get(key);
    bucket[d.status]++;
    bucket.total++;
  }
  const monthly = [...monthMap.values()].map((m) => ({
    ...m,
    percent: m.total ? Math.round(((m.present + m.late) / m.total) * 1000) / 10 : 0,
  }));

  return {
    present, late, absent, total, attended,
    percent: total ? Math.round((attended / total) * 1000) / 10 : 0,
    punctuality: attended ? Math.round((present / attended) * 1000) / 10 : 0,
    streak, bestStreak,
    daily, monthly,
    lastSeen: marks.length ? marks.map((m) => m.markedAt).sort().slice(-1)[0] : null,
  };
}

module.exports = {
  localDate, toMinutes, minutesToHHMM, formatTime, isClassDay, scheduleOf,
  currentWindow, expectedDates, buildReport,
  DAY_NAMES, DAY_SHORT, GRACE_MINUTES, EARLY_WINDOW_MINUTES,
};
