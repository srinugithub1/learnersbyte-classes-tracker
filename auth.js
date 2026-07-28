/**
 * Passwords and sessions — no npm dependencies.
 *
 *  - Passwords: scrypt with a per-password random salt. Stored as
 *    `scrypt$N$r$p$<salt-b64>$<hash-b64>`, so the parameters travel with the
 *    hash and can be raised later without invalidating old passwords.
 *  - Sessions: an HMAC-signed cookie. Nothing to store server side, and the
 *    cookie cannot be forged or edited without the secret.
 *  - Reset tokens: only the SHA-256 hash goes to the database.
 */

const crypto = require('crypto');

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const SESSION_TTL_HOURS = 12;
const RESET_TTL_MINUTES = 60;

/** Stable secret: an explicit SESSION_SECRET, else derived from the service key
 *  (already secret, already required) so sessions survive a restart. */
function sessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const base = process.env.SUPABASE_SERVICE_KEY || '';
  if (!base) throw new Error('No SESSION_SECRET and no SUPABASE_SERVICE_KEY to derive one from.');
  return crypto.createHash('sha256').update('udayan-session:' + base).digest('hex');
}

/* ------------------------------------------------------------- passwords */

function hashPassword(plain) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(plain, salt, SCRYPT.keylen, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p,
  });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(plain, stored) {
  try {
    const [scheme, N, r, p, saltB64, hashB64] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const actual = crypto.scryptSync(plain, salt, expected.length, {
      N: Number(N), r: Number(r), p: Number(p),
    });
    // Constant-time compare so a wrong password cannot be found by timing.
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** Rules kept deliberately mild — students type these on phones. */
function passwordProblem(plain) {
  const value = String(plain || '');
  if (value.length < 8) return 'Password must be at least 8 characters.';
  if (value.length > 200) return 'Password is too long.';
  if (!/[a-zA-Z]/.test(value)) return 'Password must contain at least one letter.';
  if (!/[0-9]/.test(value)) return 'Password must contain at least one number.';
  return null;
}

/* -------------------------------------------------------------- sessions */

const b64url = (buf) => Buffer.from(buf).toString('base64url');

function signSession({ userId, role }) {
  const payload = b64url(JSON.stringify({
    uid: userId,
    role,
    exp: Date.now() + SESSION_TTL_HOURS * 3600 * 1000,
  }));
  const sig = crypto.createHmac('sha256', sessionSecret()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function readSession(token) {
  if (!token || typeof token !== 'string') return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;

  const expected = crypto.createHmac('sha256', sessionSecret()).update(payload).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (!data.exp || data.exp < Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

const COOKIE_NAME = 'udayan_session';

function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

function sessionCookie(token) {
  const maxAge = SESSION_TTL_HOURS * 3600;
  // HttpOnly: unreachable from JavaScript, so an XSS bug cannot steal the session.
  // SameSite=Lax: not sent on cross-site POSTs, which blocks CSRF on our routes.
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}

const clearCookie = () => `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;

/* ---------------------------------------------------------- reset tokens */

function newResetToken() {
  const token = crypto.randomBytes(32).toString('base64url');
  return {
    token,
    tokenHash: crypto.createHash('sha256').update(token).digest('hex'),
    expiresAt: new Date(Date.now() + RESET_TTL_MINUTES * 60 * 1000).toISOString(),
  };
}

const hashResetToken = (token) =>
  crypto.createHash('sha256').update(String(token)).digest('hex');

module.exports = {
  hashPassword, verifyPassword, passwordProblem,
  signSession, readSession, parseCookies, sessionCookie, clearCookie, COOKIE_NAME,
  newResetToken, hashResetToken,
  RESET_TTL_MINUTES, SESSION_TTL_HOURS,
};
