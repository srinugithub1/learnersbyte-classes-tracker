/**
 * Exam report downloads — ranking, and who is allowed to have them.
 *
 *   node server.js
 *   node test/report.test.js
 *
 * Sits three students on one paper with different scores, then checks the
 * ranking, the spreadsheet and the printable report. Everything it makes is
 * prefixed "E2E"/"e2e-" and deleted at the end.
 */

const parse = require('../parse');

const BASE = process.env.BASE || 'http://localhost:3000';

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? ` — ${extra}` : ''}`); }
};
const section = (t) => console.log(`\n== ${t} ==`);

/** Cookie-aware fetch that can also hand back raw bytes, for the download. */
function browser() {
  let cookie = '';
  const call = async (pathname, { method = 'GET', body, raw = false } = {}) => {
    const res = await fetch(BASE + pathname, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'manual',
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];

    if (raw) {
      return {
        status: res.status,
        headers: res.headers,
        buffer: Buffer.from(await res.arrayBuffer()),
      };
    }
    const text = await res.text();
    let data = null;
    if (text) { try { data = JSON.parse(text); } catch { data = text; } }
    return { status: res.status, headers: res.headers, data };
  };
  return call;
}

const stamp = Date.now();
const pad = (n) => String(n).padStart(2, '0');
const clock = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const today = () => {
  const n = new Date();
  return `${n.getFullYear()}-${pad(n.getMonth() + 1)}-${pad(n.getDate())}`;
};
const shift = (mins) => { const d = new Date(); d.setMinutes(d.getMinutes() + mins); return d; };

(async function run() {
  const admin = browser();
  let batchId = null;
  let examId = null;
  const students = [];         // { id, email, browser, answers }

  try {
    section('setup');
    let res = await admin('/api/auth/login', {
      method: 'POST',
      body: {
        email: process.env.ADMIN_EMAIL || 'teacher@udayan.local',
        password: process.env.ADMIN_PASSWORD || 'Teach1234',
      },
    });
    if (res.status !== 200) {
      console.error(`\n  Cannot log in as admin at ${BASE}. Start the server first.\n`);
      process.exitCode = 1;
      return;
    }
    ok('admin logged in', true);

    res = await admin('/api/admin/batches', {
      method: 'POST',
      body: {
        name: `E2E Report ${stamp}`, course: 'E2E',
        classStart: '10:00', classEnd: '11:00', classDays: [0, 1, 2, 3, 4, 5, 6],
      },
    });
    ok('batch created', res.status === 201, JSON.stringify(res.data));
    batchId = res.data.batch.id;

    // Three students: two will tie, one will score lower, one will not sit it.
    const plan = [
      { tag: 'top', answers: ['liquid', 'east'] },      // 2 right  -> 10 marks
      { tag: 'tie', answers: ['liquid', 'east'] },      // 2 right  -> 10 marks
      { tag: 'low', answers: ['liquid', 'west'] },      // 1 right  ->  5 marks
      { tag: 'nil', answers: null },                    // never sits it
    ];

    for (const p of plan) {
      const email = `e2e-rep-${p.tag}-${stamp}@example.test`;
      res = await admin('/api/admin/students', {
        method: 'POST',
        body: { email, name: `E2E Rep ${p.tag.toUpperCase()}`, password: 'Sturdy1234', phone: '9999999999' },
      });
      ok(`student ${p.tag} created`, res.status === 201, JSON.stringify(res.data));
      const id = res.data.student.id;
      await admin('/api/admin/student/update', { method: 'POST', body: { id, batchId } });

      const bro = browser();
      await bro('/api/auth/login', { method: 'POST', body: { email, password: 'Sturdy1234' } });
      students.push({ id, email, browser: bro, answers: p.answers, tag: p.tag });
    }

    res = await admin('/api/admin/exams', {
      method: 'POST',
      body: {
        batchId,
        title: `E2E Report Paper ${stamp}`,
        examDate: today(),
        startTime: clock(shift(-5)),
        endTime: clock(shift(120)),
        totalQuestions: 2,
        totalMarks: 10,
        passMarks: 10,             // only a full score passes, so ties matter
        secondsPerQuestion: 600,
        questionMode: 'fill',
      },
    });
    ok('exam created', res.status === 201, JSON.stringify(res.data));
    examId = res.data.exam.id;

    await admin('/api/admin/exams/questions', {
      method: 'POST',
      body: {
        examId,
        questions: [
          { type: 'fill', questionText: 'Water is ____ at room temperature.', correctAnswer: 'liquid', marks: 5, seconds: 600 },
          { type: 'fill', questionText: 'The sun rises in the ____.', correctAnswer: 'east', marks: 5, seconds: 600 },
        ],
      },
    });
    await admin('/api/admin/exams/update', { method: 'POST', body: { id: examId, status: 'published' } });
    ok('exam published', true);

    for (const s of students) {
      if (!s.answers) continue;
      const started = await s.browser('/api/student/exam/start', { method: 'POST', body: { examId } });
      const attemptId = started.data.attempt.id;
      const qs = started.data.questions;
      for (let i = 0; i < qs.length; i++) {
        await s.browser('/api/student/exam/answer', {
          method: 'POST',
          body: { attemptId, questionId: qs[i].id, answer: s.answers[i] },
        });
      }
      const done = await s.browser('/api/student/exam/submit', { method: 'POST', body: { attemptId } });
      ok(`student ${s.tag} submitted`, done.status === 201 || done.status === 200,
        JSON.stringify(done.data && done.data.totals));
    }

    /* --------------------------------------------------------------- rank */
    section('ranking');

    res = await admin(`/api/admin/exam/results?examId=${encodeURIComponent(examId)}`);
    ok('the results load', res.status === 200, JSON.stringify(res.data));
    const rows = res.data.rows;
    const byTag = (tag) => rows.find((r) => r.student.email.includes(`-${tag}-`));

    ok('everyone on the paper is listed', rows.length === 4, `got ${rows.length}`);
    ok('the two top scores share rank 1',
      byTag('top').rank === 1 && byTag('tie').rank === 1,
      `${byTag('top').rank} and ${byTag('tie').rank}`);
    ok('the next rank skips 2, as a shared first means no second',
      byTag('low').rank === 3, `got ${byTag('low').rank}`);
    ok('a student who never sat it has no rank', byTag('nil').rank === null);
    ok('ranked students come before unranked ones',
      rows.findIndex((r) => r.rank === null) === 3);
    ok('every ranked row knows the size of the field',
      byTag('low').outOf === 3, String(byTag('low').outOf));

    ok('a full score passes', byTag('top').passed === true);
    ok('a half score does not', byTag('low').passed === false);
    ok('the summary counts both passes', res.data.summary.passed === 2,
      String(res.data.summary.passed));
    ok('and reports the pass rule', /10 marks or above/.test(res.data.summary.passRule),
      res.data.summary.passRule);
    ok('the average is of the submitted papers only',
      res.data.summary.average === 83.3, String(res.data.summary.average));
    ok('the median is reported', res.data.summary.median === 100, String(res.data.summary.median));
    ok('minutes taken is recorded', typeof byTag('top').minutesTaken === 'number');

    /* -------------------------------------------------------------- excel */
    section('the spreadsheet');

    const book = await admin(`/api/admin/exam/report.xlsx?examId=${encodeURIComponent(examId)}`, { raw: true });
    ok('it downloads', book.status === 200, String(book.status));
    ok('with the spreadsheet content type',
      /spreadsheetml\.sheet/.test(book.headers.get('content-type') || ''),
      book.headers.get('content-type'));
    ok('as an attachment with a findable name',
      /attachment; filename=".*results-\d{4}-\d{2}-\d{2}\.xlsx"/.test(book.headers.get('content-disposition') || ''),
      book.headers.get('content-disposition'));
    ok('and it is a real zip', book.buffer.subarray(0, 2).toString('latin1') === 'PK');

    const files = parse.unzip(book.buffer);
    ok('it holds three sheets',
      files.has('xl/worksheets/sheet1.xml') &&
      files.has('xl/worksheets/sheet2.xml') &&
      files.has('xl/worksheets/sheet3.xml'));

    const workbook = files.get('xl/workbook.xml').toString('utf8');
    ok('the tabs are named for a human',
      workbook.includes('name="Summary"') &&
      workbook.includes('name="Results"') &&
      workbook.includes('name="Rank list"'), workbook);

    const results = files.get('xl/worksheets/sheet2.xml').toString('utf8');
    ok('the results sheet carries every student', (results.match(/E2E Rep (TOP|TIE|LOW|NIL)/g) || []).length === 4,
      String((results.match(/E2E Rep (TOP|TIE|LOW|NIL)/g) || []).length));
    ok('scores are written as numbers, not text', /<c r="F2"><v>10<\/v><\/c>/.test(results), results.slice(0, 900));
    ok('the unranked student has an empty rank cell, not a zero',
      /<c r="A5"\/>/.test(results), results.slice(-700));

    const merit = files.get('xl/worksheets/sheet3.xml').toString('utf8');
    ok('the rank list holds only the students who sat it',
      (merit.match(/E2E Rep (TOP|TIE|LOW|NIL)/g) || []).length === 3);

    const summary = files.get('xl/worksheets/sheet1.xml').toString('utf8');
    ok('the summary names the exam', summary.includes(`E2E Report Paper ${stamp}`));
    ok('and states the pass mark', summary.includes('Pass marks'));

    /* --------------------------------------------------------------- pdf */
    section('the printable report');

    const page = await admin(`/api/admin/exam/report.html?examId=${encodeURIComponent(examId)}`);
    ok('it loads', page.status === 200, String(page.status));
    ok('as HTML', /text\/html/.test(page.headers.get('content-type') || ''));
    const html = String(page.data);
    ok('it names the exam', html.includes(`E2E Report Paper ${stamp}`));
    ok('it lists every student', (html.match(/E2E Rep (TOP|TIE|LOW|NIL)/g) || []).length === 4);
    ok('it shows the shared rank twice',
      (html.match(/class="num rank">1</g) || []).length === 2,
      String((html.match(/class="num rank">1</g) || []).length));
    ok('it has a print button', html.includes('window.print()'));
    ok('it is set up for A4', html.includes('@page'));
    ok('it explains how ties are ranked', /share a rank/i.test(html));
    ok('it is not cached', /no-store/.test(page.headers.get('cache-control') || ''));

    /* ------------------------------------------------------- teacher only */
    section('teachers only');

    const pupil = students[0].browser;
    let denied = await pupil(`/api/admin/exam/report.xlsx?examId=${encodeURIComponent(examId)}`);
    ok('a student cannot download the spreadsheet', denied.status === 403, String(denied.status));
    denied = await pupil(`/api/admin/exam/report.html?examId=${encodeURIComponent(examId)}`);
    ok('nor the printable report', denied.status === 403, String(denied.status));
    denied = await pupil(`/api/admin/exam/results?examId=${encodeURIComponent(examId)}`);
    ok('nor the results behind them', denied.status === 403, String(denied.status));

    const anon = browser();
    denied = await anon(`/api/admin/exam/report.xlsx?examId=${encodeURIComponent(examId)}`);
    ok('a logged-out visitor gets nothing', denied.status === 401 || denied.status === 403,
      String(denied.status));

    const missing = await admin('/api/admin/exam/report.xlsx?examId=00000000-0000-0000-0000-000000000000');
    ok('an unknown exam is a clean 404, not a crash', missing.status === 404, String(missing.status));
  } finally {
    section('cleanup');
    if (examId) {
      const res = await admin('/api/admin/exams/delete', { method: 'POST', body: { id: examId } });
      ok('exam removed', res.status === 200);
    }
    for (const s of students) {
      const res = await admin('/api/admin/student/delete', { method: 'POST', body: { id: s.id } });
      ok('student removed', res.status === 200);
    }
    if (batchId) {
      const res = await admin('/api/admin/batches/delete', { method: 'POST', body: { id: batchId } });
      ok('batch removed', res.status === 200);
    }
    console.log(`\n  ${pass} passed, ${fail} failed\n`);
    process.exitCode = fail ? 1 : 0;
  }
})();
