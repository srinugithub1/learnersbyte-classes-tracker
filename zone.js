/**
 * The one place that turns instants into wall-clock time.
 *
 * Every class time, grace period and exam window is a WALL-CLOCK time in the
 * school's timezone — "the 10:00 class" means 10:00 in Kolkata, wherever the
 * server happens to be running.
 *
 * This used to rely on the process timezone, which works locally but not on a
 * host. Vercel reserves the TZ variable and runs in UTC, so a 10:00 class would
 * have been treated as 15:30 and half the class marked absent — silently, and
 * plausibly enough that nobody would notice for days.
 *
 * So the conversion is done here explicitly, with Intl, and the process
 * timezone is never consulted. Set APP_TIMEZONE to change the school's clock.
 */

const ZONE = process.env.APP_TIMEZONE || 'Asia/Calcutta';

/** Throws if the configured zone is not one the runtime knows. */
function assertValidZone(zone = ZONE) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone }).format(new Date());
    return null;
  } catch {
    return `"${zone}" is not a timezone this server recognises.\n` +
      '    Use an IANA name such as Asia/Calcutta, and set it in APP_TIMEZONE.';
  }
}

const FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: ZONE,
  hour12: false,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});

/** The wall-clock fields in the school's timezone for a given instant. */
function partsOf(instant = new Date()) {
  const out = {};
  for (const part of FORMATTER.formatToParts(instant)) {
    if (part.type !== 'literal') out[part.type] = Number(part.value);
  }
  // Some locales render midnight as hour 24.
  out.hour %= 24;
  return out;
}

const pad = (n) => String(n).padStart(2, '0');

/** "YYYY-MM-DD" for that instant, in the school's timezone. */
function dateKey(instant = new Date()) {
  const p = partsOf(instant);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** Minutes since midnight, in the school's timezone. */
function minutesOfDay(instant = new Date()) {
  const p = partsOf(instant);
  return p.hour * 60 + p.minute;
}

/**
 * Day of the week for a "YYYY-MM-DD" string, 0 = Sunday.
 * A calendar date's weekday does not depend on any timezone, so this is done
 * with UTC arithmetic and never touches the local clock.
 */
function weekdayOf(key) {
  const [y, m, d] = String(key).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** "YYYY-MM-DD" shifted by whole days, with no timezone involved. */
function addDays(key, days) {
  const [y, m, d] = String(key).split('-').map(Number);
  const shifted = new Date(Date.UTC(y, m - 1, d + days));
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

/** How far the school's timezone is from UTC at that instant, in ms. */
function offsetAt(instant) {
  const p = partsOf(instant);
  const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUTC - instant.getTime();
}

/**
 * The instant at which the school's clock reads `date` `hhmm`.
 *
 * Runs the offset twice because the offset itself depends on the instant: on a
 * daylight-saving boundary the first guess can land on the wrong side of the
 * change. India has no DST, but the school's timezone is configurable.
 */
function instantOf(date, hhmm = '00:00') {
  const [y, m, d] = String(date).split('-').map(Number);
  const [hh, mm] = String(hhmm || '00:00').split(':').map(Number);
  const naive = Date.UTC(y, m - 1, d, hh || 0, mm || 0, 0);

  let ts = naive - offsetAt(new Date(naive));
  ts = naive - offsetAt(new Date(ts));
  return new Date(ts);
}

/** A human date+time in the school's timezone, for messages shown to students. */
function formatDateTime(instant) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: ZONE,
    day: 'numeric', month: 'short', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(instant instanceof Date ? instant : new Date(instant));
}

module.exports = {
  ZONE, assertValidZone,
  partsOf, dateKey, minutesOfDay, weekdayOf, addDays, instantOf, formatDateTime,
};
