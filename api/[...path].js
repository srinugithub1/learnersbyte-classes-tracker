/**
 * Vercel entry point.
 *
 * Vercel is serverless: there is no long-running process, so `server.listen()`
 * is never called. This file receives every /api/* request and hands it to the
 * same handler `node server.js` uses locally, so there is one copy of the
 * routing logic and no risk of the two drifting apart.
 *
 * Everything outside /api/ (the HTML, CSS, JS and logo in public/) is served by
 * Vercel's CDN and never reaches this function.
 *
 * Nothing here is allowed to throw. A serverless function that throws while
 * loading gives the visitor an opaque "This Serverless Function has crashed"
 * page with no clue what went wrong, so every failure is caught and turned into
 * a readable JSON answer instead.
 */

let app = null;
let loadError = null;

try {
  app = require('../server.js');
} catch (err) {
  loadError = err;
}

const reply = (res, status, body) => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
};

module.exports = async function handler(req, res) {
  if (loadError) {
    return reply(res, 500, {
      error: 'The server could not start. Please tell your administrator.',
      detail: loadError.message,
      fix: 'Check Vercel -> Settings -> Environment Variables, then redeploy.',
    });
  }

  const tzProblem = app.checkTimezone();
  if (tzProblem) {
    return reply(res, 500, {
      error: 'The server timezone setting is wrong. Please tell your administrator.',
      detail: tzProblem,
    });
  }

  try {
    await app.ensureReady();
    return await app.requestListener(req, res);
  } catch (err) {
    if (res.headersSent) return undefined;
    console.error('Unhandled error:', err);
    return reply(res, err.status || 500, {
      error: err.message || 'Something went wrong.',
    });
  }
};
