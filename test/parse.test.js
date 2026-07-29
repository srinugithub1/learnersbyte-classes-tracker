/**
 * Tests for the question-paper parser: DOCX and PDF text extraction, and
 * turning that text into questions and answers.
 *
 *   node test/parse.test.js
 *
 * Builds real .docx and .pdf files in memory (a ZIP and a PDF written by hand),
 * so nothing external is needed.
 */

const zlib = require('zlib');
const { extractText, parseQuestions } = require('../parse');

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? ` — ${extra}` : ''}`); }
};
const section = (t) => console.log(`\n== ${t} ==`);

/* --------------------------------------------------- build a real .docx */

function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const byte of buf) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Writes a minimal but genuine ZIP with one deflated entry. */
function makeZip(name, content) {
  const nameBuf = Buffer.from(name, 'utf8');
  const raw = Buffer.from(content, 'utf8');
  const deflated = zlib.deflateRawSync(raw);
  const crc = crc32(raw);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(8, 8);              // deflate
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(deflated.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);

  const localPart = Buffer.concat([local, nameBuf, deflated]);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(deflated.length, 20);
  central.writeUInt32LE(raw.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt32LE(0, 42);           // local header offset
  const centralPart = Buffer.concat([central, nameBuf]);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralPart.length, 12);
  eocd.writeUInt32LE(localPart.length, 16);

  return Buffer.concat([localPart, centralPart, eocd]);
}

const paragraphs = (lines) =>
  '<?xml version="1.0"?><w:document xmlns:w="x"><w:body>' +
  lines.map((l) => `<w:p><w:r><w:t>${l.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</w:t></w:r></w:p>`).join('') +
  '</w:body></w:document>';

/* ----------------------------------------------------- build a real PDF */

function makePdf(lines) {
  const content = 'BT /F1 12 Tf 72 720 Td\n' +
    lines.map((l) => `(${l.replace(/[()\\]/g, (c) => `\\${c}`)}) Tj T*`).join('\n') +
    '\nET';
  const stream = zlib.deflateSync(Buffer.from(content, 'latin1'));

  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>\nendobj\n',
  ];
  const head = Buffer.from('%PDF-1.4\n' + objects.join(''), 'latin1');
  const objStart = Buffer.from(`4 0 obj\n<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n`, 'latin1');
  const objEnd = Buffer.from('\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF', 'latin1');
  return Buffer.concat([head, objStart, stream, objEnd]);
}

/* ------------------------------------------------------------- fixtures */

const PAPER = [
  'Unit Test 1 — General Knowledge',
  '',
  '1. Which planet is closest to the Sun?',
  'A) Venus',
  'B) Mercury',
  'C) Earth',
  'D) Mars',
  'Answer: B',
  '',
  '2. The capital of France is ____.',
  'Answer: Paris',
  '',
  '3. Water boils at ____ degrees Celsius at sea level.',
  'Ans: 100',
  '',
  '4. Which of these is a mammal?',
  'A) Shark',
  'B) Crocodile',
  'C) Dolphin',
  'D) Eagle',
  'Correct Answer: C',
];

/* ============================================================== DOCX === */
section('.docx extraction');
const docx = makeZip('word/document.xml', paragraphs(PAPER));
let text = extractText(docx, 'paper.docx');
ok('reads text out of a .docx', text.includes('Which planet is closest to the Sun?'));
// PAPER has 21 entries, 4 of them blank spacers.
ok('keeps each paragraph on its own line',
  text.split('\n').filter((l) => l.trim()).length === 17,
  `got ${text.split('\n').filter((l) => l.trim()).length}`);
ok('detects .docx by signature when the name is odd',
  extractText(docx, 'paper.bin').includes('Mercury'));

/* =============================================================== PDF === */
section('.pdf extraction');
const pdf = makePdf(PAPER);
const pdfText = extractText(pdf, 'paper.pdf');
ok('reads text out of a .pdf', pdfText.includes('Which planet is closest to the Sun?'));
ok('keeps the options', pdfText.includes('Mercury') && pdfText.includes('Dolphin'));
ok('detects .pdf by signature', extractText(pdf, 'paper.bin').includes('Mercury'));

let refused = '';
try { extractText(Buffer.from('just some bytes'), 'paper.doc'); } catch (e) { refused = e.message; }
ok('old .doc is refused with advice', /Save As/i.test(refused));

refused = '';
try { extractText(Buffer.from('%PDF-1.4 no streams here'), 'x.pdf'); } catch (e) { refused = e.message; }
ok('an image-only PDF says so instead of saving nothing', /No text could be read/i.test(refused));

/* ========================================================= questions === */
section('question parsing');
const { questions, warnings } = parseQuestions(text);
ok('finds all four questions', questions.length === 4, `got ${questions.length}`);
ok('no warnings on a well-formed paper', warnings.length === 0, warnings.join(' | '));

const [q1, q2, q3, q4] = questions;
ok('Q1 is multiple choice', q1.type === 'mcq');
ok('Q1 keeps its text', q1.questionText === 'Which planet is closest to the Sun?', q1.questionText);
ok('Q1 has four options', q1.options.length === 4);
ok('Q1 options are lettered', q1.options[1].key === 'B' && q1.options[1].text === 'Mercury');
ok('Q1 answer is B', q1.correctAnswer === 'B');

ok('Q2 is fill in the blank', q2.type === 'fill');
ok('Q2 keeps the blank', q2.questionText.includes('____'));
ok('Q2 answer is Paris', q2.correctAnswer === 'Paris');

ok('Q3 reads the "Ans:" form', q3.correctAnswer === '100');
ok('Q4 reads "Correct Answer:"', q4.correctAnswer === 'C');
ok('positions are sequential', questions.map((q) => q.position).join(',') === '1,2,3,4');

/* the same paper via PDF */
const fromPdf = parseQuestions(pdfText);
ok('the PDF path gives the same four questions', fromPdf.questions.length === 4);
ok('the PDF path finds the answers',
  fromPdf.questions.filter((q) => q.correctAnswer).length === 4);

/* ---------------------------------------------------------- edge cases */
section('parsing edge cases');

const inlineOpts = parseQuestions([
  '1. Pick a colour A) red B) blue C) green D) black',
  'Answer: C',
].join('\n'));
ok('options crammed on one line are split', inlineOpts.questions[0].options.length === 4);
ok('inline options keep the answer', inlineOpts.questions[0].correctAnswer === 'C');

const answerByText = parseQuestions([
  '1. Which is a fruit?',
  'A) Carrot',
  'B) Mango',
  'Answer: Mango',
].join('\n'));
ok('an answer written as text maps to its letter',
  answerByText.questions[0].correctAnswer === 'B', answerByText.questions[0].correctAnswer);

const bracketed = parseQuestions('1) Who wrote Hamlet? (Answer: Shakespeare)');
ok('a trailing bracketed answer is picked up',
  bracketed.questions[0].correctAnswer === 'Shakespeare', bracketed.questions[0].correctAnswer);
ok('the trailing answer is stripped from the question',
  !bracketed.questions[0].questionText.toLowerCase().includes('answer'));

const missing = parseQuestions('1. A question with no answer at all');
ok('a missing answer is flagged', missing.warnings.some((w) => /no answer/i.test(w)));

const badAnswer = parseQuestions([
  '1. Pick one',
  'A) yes',
  'B) no',
  'Answer: Z',
].join('\n'));
ok('an answer that is not an option is flagged',
  badAnswer.warnings.some((w) => /not one of its options/i.test(w)));

const empty = parseQuestions('This paper has no numbered questions at all.');
ok('unrecognised text is reported, not silently accepted',
  empty.questions.length === 0 && empty.warnings.some((w) => /No questions could be recognised/i.test(w)));

const modeMismatch = parseQuestions('1. Capital of Japan is ____.\nAnswer: Tokyo', { mode: 'mcq' });
ok('a fill question in an MCQ-only exam is flagged',
  modeMismatch.warnings.some((w) => /multiple choice only/i.test(w)));

const qPrefix = parseQuestions([
  'Q1. What is 2 + 2?',
  'Answer: 4',
  'Q2. What is 3 + 3?',
  'Answer: 6',
].join('\n'));
ok('the "Q1." style is understood', qPrefix.questions.length === 2);
ok('and keeps both answers',
  qPrefix.questions[0].correctAnswer === '4' && qPrefix.questions[1].correctAnswer === '6');

const stray = parseQuestions([
  '1. In 1947, India became independent.',
  'Answer: True',
].join('\n'));
ok('a year inside the text does not start a new question', stray.questions.length === 1);

/* ------------------------------------------------------- the sample paper */
/* samples/ is what teachers are told to copy. If a change to the parser ever
   stops reading it, that is a broken promise, not a detail. */

const fs = require('fs');
const path = require('path');

const sampleDir = path.join(__dirname, '..', 'samples');
for (const file of ['question-paper-sample.txt', 'question-paper-sample.docx']) {
  const full = path.join(sampleDir, file);
  const kind = file.endsWith('.docx') ? 'docx' : 'text';
  const text = extractText(fs.readFileSync(full), file);
  const sample = parseQuestions(text, { mode: 'both' });

  ok(`the ${kind} sample gives 10 questions`, sample.questions.length === 10,
    `got ${sample.questions.length}`);
  ok(`the ${kind} sample raises no warnings`, sample.warnings.length === 0,
    JSON.stringify(sample.warnings));
  ok(`the ${kind} sample mixes both styles`,
    sample.questions.filter((q) => q.type === 'mcq').length === 5 &&
    sample.questions.filter((q) => q.type === 'fill').length === 5);
  ok(`the ${kind} sample keeps its multiple-choice answers as letters`,
    sample.questions[1].correctAnswer === 'B' && sample.questions[1].options.length === 4);
  ok(`the ${kind} sample keeps the either/or answer`,
    /zero/.test(sample.questions[2].correctAnswer));
  ok(`the ${kind} sample ignores the title lines`,
    sample.questions[0].questionText.startsWith('The capital city'),
    sample.questions[0].questionText);
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exitCode = fail ? 1 : 0;
