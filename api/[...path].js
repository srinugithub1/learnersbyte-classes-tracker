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
 */

const { requestListener, ensureReady, checkTimezone } = require('../server.js');

module.exports = async function handler(req, res) {
  // Class times are worked out on the server's clock. Vercel runs in UTC unless
  // TZ is set, which would shift every class and exam by hours — fail loudly.
  const tzProblem = checkTimezone();
  if (tzProblem) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({
      error: 'The server is set to the wrong timezone. Please tell your administrator.',
      detail: tzProblem,
    }));
    return;
  }

  await ensureReady();
  return requestListener(req, res);
};
