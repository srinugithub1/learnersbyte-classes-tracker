/** Tiny .env loader — avoids a dotenv dependency. Values already present in
 *  process.env win, so `SUPABASE_URL=... node server.js` still overrides. */

const fs = require('fs');
const path = require('path');

function loadEnv(file = path.join(__dirname, '.env')) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return process.env;         // no .env file — rely on real env vars
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return process.env;
}

module.exports = { loadEnv };
