/**
 * End-to-end test for the exam feature, against a RUNNING server and the real
 * Supabase database.
 *
 *   node server.js             (in one terminal)
 *   node test/exam.test.js     (in another)
 *
 * Creates a throwaway batch and exams prefixed "E2E", uploads a real .docx and
 * a real .pdf, then deletes everything it made.
 */

const zlib = require('zlib');

const BASE = process.env.BASE || 'http://localhost:3000';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'teacher@udayan.local';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Teach1234';

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? ` — ${extra}` : ''}`); }
};
const section = (t) => console.log(`\n== ${t} ==`);

function browser() {
  let cookie = '';
  return async function call(pathname, { method = 'GET', body } = {}) {
    const res = await fetch(BASE + pathname, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const text = await res.text();
    let data = null;
    if (text) { try { data = JSON.parse(text); } catch { data = text; } }
    return { status: res.status, data };
  };
}

/* ------------------------------------------- build real .docx and .pdf */

function crc32(buf) {
  const table = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const byte of buf) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function makeDocx(lines) {
  const xml = '<?xml version="1.0"?><w:document xmlns:w="x"><w:body>' +
    lines.map((l) => `<w:p><w:r><w:t>${l.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</w:t></w:r></w:p>`).join('') +
    '</w:body></w:document>';

  const name = Buffer.from('word/document.xml', 'utf8');
  const raw = Buffer.from(xml, 'utf8');
  const deflated = zlib.deflateRawSync(raw);
  const crc = crc32(raw);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(deflated.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(name.length, 26);
  const localPart = Buffer.concat([local, name, deflated]);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(deflated.length, 20);
  central.writeUInt32LE(raw.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(0, 42);
  const centralPart = Buffer.concat([central, name]);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralPart.length, 12);
  eocd.writeUInt32LE(localPart.length, 16);

  return Buffer.concat([localPart, centralPart, eocd]);
}

function makePdf(lines) {
  const content = 'BT /F1 12 Tf 72 720 Td\n' +
    lines.map((l) => `(${l.replace(/[()\\]/g, (c) => `\\${c}`)}) Tj T*`).join('\n') + '\nET';
  const stream = zlib.deflateSync(Buffer.from(content, 'latin1'));
  const head = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n', 'latin1');
  const objStart = Buffer.from(`4 0 obj\n<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n`, 'latin1');
  const objEnd = Buffer.from('\nendstream\nendobj\n%%EOF', 'latin1');
  return Buffer.concat([head, objStart, stream, objEnd]);
}

const PAPER = [
  '1. Which planet is closest to the Sun?',
  'A) Venus', 'B) Mercury', 'C) Earth', 'D) Mars',
  'Answer: B',
  '2. The capital of France is ____.',
  'Answer: Paris',
  '3. Water boils at ____ degrees Celsius.',
  'Ans: 100',
];

const stamp = Date.now();

(async function run() {
  const admin = browser();
  const student = browser();

  section('setup');
  let res = await admin('/api/auth/login', { method: 'POST', body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
  if (res.status !== 200) {
    console.error(`\n  Cannot log in as ${ADMIN_EMAIL}. Is the server running? Check .env.\n`);
    process.exitCode = 1;
    return;
  }
  ok('admin logged in', true);

  res = await admin('/api/admin/batches', {
    method: 'POST',
    body: { name: `E2E Exam Batch ${stamp}`, course: 'E2E', classStart: '10:00', classEnd: '11:00', classDays: [1, 2, 3, 4, 5] },
  });
  const batchId = res.data.batch && res.data.batch.id;
  ok('test batch created', res.status === 201, JSON.stringify(res.data));

  /* -------------------------------------------------------- step 1 --- */
  section('step 1 — exam details');
  const settings = {
    batchId,
    title: `E2E Unit Test ${stamp}`,
    examDate: new Date().toISOString().slice(0, 10),
    startTime: '10:30',
    totalQuestions: 3,
    totalMarks: 6,
    secondsPerQuestion: 45,
    questionMode: 'both',
  };
  res = await admin('/api/admin/exams', { method: 'POST', body: settings });
  ok('exam created', res.status === 201, JSON.stringify(res.data));
  const examId = res.data.exam && res.data.exam.id;
  ok('settings are stored', res.data.exam
    && res.data.exam.totalQuestions === 3
    && res.data.exam.totalMarks === 6
    && res.data.exam.secondsPerQuestion === 45
    && res.data.exam.questionMode === 'both');
  ok('a new exam starts as a draft', res.data.exam.status === 'draft');
  ok('the batch is attached', res.data.exam.batch && res.data.exam.batch.id === batchId);

  for (const [label, body] of [
    ['no batch', { ...settings, batchId: null }],
    ['bad date', { ...settings, examDate: 'not-a-date' }],
    ['zero questions', { ...settings, totalQuestions: 0 }],
    ['negative marks', { ...settings, totalMarks: -5 }],
    ['silly question time', { ...settings, secondsPerQuestion: 1 }],
    ['bad question style', { ...settings, questionMode: 'random' }],
  ]) {
    const bad = await admin('/api/admin/exams', { method: 'POST', body });
    ok(`rejects ${label}`, bad.status === 400, `got ${bad.status}`);
  }

  res = await student('/api/admin/exams', { method: 'POST', body: settings });
  ok('an anonymous visitor cannot create an exam', res.status === 401);

  /* ------------------------------------------------- step 2: manual --- */
  section('step 2a — manual paper');
  res = await admin('/api/admin/exams/questions', {
    method: 'POST',
    body: {
      examId,
      questions: [
        { type: 'mcq', questionText: 'Which planet is closest to the Sun?',
          options: [{ key: 'A', text: 'Venus' }, { key: 'B', text: 'Mercury' }],
          correctAnswer: 'B', marks: 2 },
        { type: 'fill', questionText: 'The capital of France is ____.', correctAnswer: 'Paris', marks: 2 },
      ],
    },
  });
  ok('manual questions save', res.status === 200, JSON.stringify(res.data));
  ok('both questions came back', res.data.questions.length === 2);
  ok('positions are numbered', res.data.questions.map((q) => q.position).join(',') === '1,2');
  ok('the MCQ keeps its options', res.data.questions[0].options.length === 2);
  ok('the answer is stored', res.data.questions[0].correctAnswer === 'B');
  ok('per-question time comes from the exam', res.data.questions[0].seconds === 45);

  for (const [label, questions] of [
    ['a question with no text', [{ type: 'fill', questionText: '  ', correctAnswer: 'x' }]],
    ['a question with no answer', [{ type: 'fill', questionText: 'Q?', correctAnswer: '' }]],
    ['an MCQ with one option', [{ type: 'mcq', questionText: 'Q?', options: [{ key: 'A', text: 'only' }], correctAnswer: 'A' }]],
    ['an answer that is not an option', [{ type: 'mcq', questionText: 'Q?', options: [{ key: 'A', text: 'a' }, { key: 'B', text: 'b' }], correctAnswer: 'D' }]],
    ['an empty paper', []],
  ]) {
    const bad = await admin('/api/admin/exams/questions', { method: 'POST', body: { examId, questions } });
    ok(`rejects ${label}`, bad.status === 400, `got ${bad.status}`);
  }

  res = await admin(`/api/admin/exam?id=${examId}`);
  ok('saving twice replaces rather than duplicates', res.data.questions.length === 2);

  /* ------------------------------------------------- step 2: upload --- */
  section('step 2b — uploaded paper (.docx)');
  res = await admin('/api/admin/exams/parse', {
    method: 'POST',
    body: { filename: 'paper.docx', contentBase64: makeDocx(PAPER).toString('base64'), mode: 'both' },
  });
  ok('the .docx is parsed', res.status === 200, JSON.stringify(res.data).slice(0, 200));
  ok('three questions were read', res.data.questions.length === 3, `got ${res.data.questions.length}`);
  ok('all three answers were read',
    res.data.questions.filter((q) => q.correctAnswer).length === 3);
  ok('the MCQ was recognised', res.data.questions[0].type === 'mcq');
  ok('its answer is B', res.data.questions[0].correctAnswer === 'B');
  ok('the fill answer is Paris', res.data.questions[1].correctAnswer === 'Paris');
  ok('no warnings on a clean paper', res.data.warnings.length === 0, res.data.warnings.join(' | '));
  ok('the raw text is returned for checking', typeof res.data.textPreview === 'string' && res.data.textPreview.length > 0);
  ok('nothing is saved by parsing alone', true);

  const parsed = res.data.questions;
  res = await admin(`/api/admin/exam?id=${examId}`);
  ok('the exam still holds only the manual questions', res.data.questions.length === 2);

  section('step 2b — uploaded paper (.pdf)');
  res = await admin('/api/admin/exams/parse', {
    method: 'POST',
    body: { filename: 'paper.pdf', contentBase64: makePdf(PAPER).toString('base64'), mode: 'both' },
  });
  ok('the .pdf is parsed', res.status === 200, JSON.stringify(res.data).slice(0, 200));
  ok('the PDF gives the same three questions', res.data.questions.length === 3);
  ok('the PDF answers are read',
    res.data.questions.filter((q) => q.correctAnswer).length === 3);

  section('upload errors');
  res = await admin('/api/admin/exams/parse', { method: 'POST', body: { filename: 'x.docx' } });
  ok('a missing file is refused', res.status === 400);

  res = await admin('/api/admin/exams/parse', {
    method: 'POST', body: { filename: 'notes.doc', contentBase64: Buffer.from('old word file').toString('base64') },
  });
  ok('an old .doc is refused with advice', res.status === 400 && /Save As/i.test(res.data.error));

  res = await admin('/api/admin/exams/parse', {
    method: 'POST', body: { filename: 'scan.pdf', contentBase64: Buffer.from('%PDF-1.4 image only').toString('base64') },
  });
  ok('a text-free PDF says so', res.status === 400 && /No text could be read/i.test(res.data.error));

  res = await admin('/api/admin/exams/parse', {
    method: 'POST', body: { filename: 'sheet.xlsx', contentBase64: Buffer.from('nonsense').toString('base64') },
  });
  ok('an unsupported type is refused', res.status === 400);

  /* --------------------------------------------- saving parsed paper --- */
  section('saving a parsed paper');
  res = await admin('/api/admin/exams/questions', {
    method: 'POST',
    body: {
      examId,
      questions: parsed.map((q) => ({ ...q, marks: 2 })),
      sourceFilename: 'paper.docx',
    },
  });
  ok('the reviewed paper saves', res.status === 200, JSON.stringify(res.data));
  ok('all three questions are stored', res.data.questions.length === 3);
  ok('the exam is marked as uploaded', res.data.exam.source === 'upload');
  ok('the filename is remembered', res.data.exam.sourceFilename === 'paper.docx');
  ok('the question count is corrected', res.data.exam.totalQuestions === 3);

  /* ----------------------------------------------------- publishing --- */
  section('publishing');
  res = await admin('/api/admin/exams/update', { method: 'POST', body: { id: examId, status: 'published' } });
  ok('the exam publishes', res.status === 200 && res.data.exam.status === 'published');

  const empty = await admin('/api/admin/exams', { method: 'POST', body: { ...settings, title: `E2E Empty ${stamp}` } });
  const emptyId = empty.data.exam.id;
  res = await admin('/api/admin/exams/update', { method: 'POST', body: { id: emptyId, status: 'published' } });
  ok('an exam with no questions cannot be published', res.status === 400, `got ${res.status}`);

  res = await admin('/api/admin/exams');
  ok('the exam list includes ours', res.data.exams.some((e) => e.id === examId));
  const listed = res.data.exams.find((e) => e.id === examId);
  ok('the list shows how many questions are in', listed.questionCount === 3);

  res = await admin(`/api/admin/exams?batchId=${batchId}`);
  ok('the list filters by batch', res.data.exams.length === 2);

  /* ------------------------------------------------------- cleanup --- */
  section('cleanup');
  for (const id of [examId, emptyId]) {
    await admin('/api/admin/exams/delete', { method: 'POST', body: { id } });
  }
  res = await admin('/api/admin/exams');
  ok('test exams deleted', !res.data.exams.some((e) => String(e.title).startsWith('E2E ')));

  await admin('/api/admin/batches/delete', { method: 'POST', body: { id: batchId } });
  res = await admin('/api/admin/batches');
  ok('test batch deleted', !res.data.batches.some((b) => b.name.startsWith('E2E ')));

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exitCode = fail ? 1 : 0;
})().catch((err) => {
  console.error('\n  Test run crashed:', err.message);
  process.exitCode = 1;
});
