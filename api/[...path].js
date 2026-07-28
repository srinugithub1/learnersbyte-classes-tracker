/**
 * Serverless entry point for hosts that route /api/* to a function directory
 * (Vercel's "Other" preset, and Netlify-style layouts).
 *
 * Vercel's "Node" preset does not use this file — it takes server.js as the
 * root entrypoint instead. Either way the same handler runs, so the two paths
 * cannot drift apart.
 *
 * Nothing here may throw. A serverless function that fails while loading shows
 * the visitor an opaque "This Serverless Function has crashed" page with no
 * clue what went wrong, so a failed import is caught and reported as JSON.
 */

let handler = null;
let loadError = null;

try {
  handler = require('../server.js');
} catch (err) {
  loadError = err;
}

module.exports = async function (req, res) {
  if (loadError) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.end(JSON.stringify({
      error: 'The server could not start. Please tell your administrator.',
      detail: loadError.message,
      fix: 'Check Vercel -> Settings -> Environment Variables, then redeploy.',
    }));
  }
  return handler(req, res);
};
