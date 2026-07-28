/**
 * Reading question papers out of uploaded files — no npm dependencies.
 *
 *   .docx  a ZIP; word/document.xml is inflated and stripped to text. Reliable.
 *   .pdf   content streams are inflated and the text-showing operators read
 *          back. Works on ordinary text PDFs; a scanned/image PDF has no text
 *          to find, and some producers use font encodings this cannot map. The
 *          caller always shows the result for review before saving, so a bad
 *          extraction is visible rather than silently stored.
 *   .txt   used as-is.
 *
 * Then `parseQuestions` turns that text into questions, options and answers.
 */

const zlib = require('zlib');

/* ============================================================ DOCX ====== */

/** Minimal ZIP reader: returns Map<filename, Buffer>. */
function unzip(buffer) {
  const files = new Map();

  // End of central directory: scan backwards for its signature.
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0 && i > buffer.length - 66000; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd === -1) throw new Error('That file is not a valid .docx (no ZIP directory found).');

  const entries = buffer.readUInt16LE(eocd + 10);
  let pointer = buffer.readUInt32LE(eocd + 16);

  for (let n = 0; n < entries; n++) {
    if (pointer + 46 > buffer.length || buffer.readUInt32LE(pointer) !== 0x02014b50) break;

    const method = buffer.readUInt16LE(pointer + 10);
    const compressedSize = buffer.readUInt32LE(pointer + 20);
    const nameLen = buffer.readUInt16LE(pointer + 28);
    const extraLen = buffer.readUInt16LE(pointer + 30);
    const commentLen = buffer.readUInt16LE(pointer + 32);
    const localOffset = buffer.readUInt32LE(pointer + 42);
    const name = buffer.toString('utf8', pointer + 46, pointer + 46 + nameLen);

    // Jump to the local header to find where the data actually starts.
    if (buffer.readUInt32LE(localOffset) === 0x04034b50) {
      const localNameLen = buffer.readUInt16LE(localOffset + 26);
      const localExtraLen = buffer.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + localNameLen + localExtraLen;
      const raw = buffer.subarray(start, start + compressedSize);
      try {
        files.set(name, method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw));
      } catch {
        /* skip an entry we cannot inflate */
      }
    }
    pointer += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

const XML_ENTITIES = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ',
};

const decodeEntities = (s) => s
  .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (m) => XML_ENTITIES[m])
  .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));

function docxToText(buffer) {
  const files = unzip(buffer);
  const doc = files.get('word/document.xml');
  if (!doc) throw new Error('That .docx has no readable document body.');

  let xml = doc.toString('utf8');

  // Paragraph and line breaks become real newlines before tags are stripped.
  xml = xml
    .replace(/<w:tab[^>]*\/>/g, '\t')
    .replace(/<w:br[^>]*\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '');

  return decodeEntities(xml);
}

/* ============================================================= PDF ====== */

/** Undo PDF string escapes inside ( … ). */
function pdfString(raw) {
  return raw.replace(/\\(n|r|t|b|f|\(|\)|\\|\d{1,3})/g, (_, code) => {
    switch (code) {
      case 'n': return '\n';
      case 'r': return '\r';
      case 't': return '\t';
      case 'b': return '\b';
      case 'f': return '\f';
      case '(': return '(';
      case ')': return ')';
      case '\\': return '\\';
      default: return String.fromCharCode(parseInt(code, 8));
    }
  });
}

/** Pull the text-showing operators out of one decoded content stream. */
function textFromContentStream(content) {
  const lines = [];
  let current = '';

  // Tj / ' / " show one string; TJ shows an array of strings and kerns.
  const re = /(?:\[((?:[^\[\]\\]|\\.)*)\]\s*TJ)|(?:\(((?:[^()\\]|\\.)*)\)\s*(Tj|'|"))|(T\*|Td|TD|ET)/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    if (m[1] !== undefined) {
      // TJ array — concatenate its string parts, a big kern means a space.
      let out = '';
      const inner = /\(((?:[^()\\]|\\.)*)\)|(-?\d+(?:\.\d+)?)/g;
      let part;
      while ((part = inner.exec(m[1])) !== null) {
        if (part[1] !== undefined) out += pdfString(part[1]);
        else if (Math.abs(Number(part[2])) > 180) out += ' ';
      }
      current += out;
    } else if (m[2] !== undefined) {
      current += pdfString(m[2]);
    } else {
      // A positioning or end-text operator ends the visual line.
      if (current.trim()) { lines.push(current.trim()); current = ''; }
    }
  }
  if (current.trim()) lines.push(current.trim());
  return lines.join('\n');
}

function pdfToText(buffer) {
  const parts = [];
  const marker = Buffer.from('stream');
  const endMarker = Buffer.from('endstream');

  let from = 0;
  while (from < buffer.length) {
    const start = buffer.indexOf(marker, from);
    if (start === -1) break;
    const end = buffer.indexOf(endMarker, start);
    if (end === -1) break;

    // Skip the EOL that follows the "stream" keyword.
    let dataStart = start + marker.length;
    if (buffer[dataStart] === 0x0d) dataStart++;
    if (buffer[dataStart] === 0x0a) dataStart++;

    const raw = buffer.subarray(dataStart, end);
    let decoded = null;
    for (const attempt of [zlib.inflateSync, zlib.inflateRawSync]) {
      try { decoded = attempt(raw); break; } catch { /* try the next one */ }
    }
    if (!decoded) decoded = raw;          // uncompressed stream

    const text = textFromContentStream(decoded.toString('latin1'));
    if (text.trim()) parts.push(text);

    from = end + endMarker.length;
  }

  const joined = parts.join('\n');
  if (!joined.trim()) {
    throw new Error(
      'No text could be read from that PDF. If it is a scan or an image, ' +
      'upload a Word (.docx) file or type the questions in manually.'
    );
  }
  return joined;
}

/* ================================================= file -> plain text === */

function extractText(buffer, filename = '') {
  const name = String(filename).toLowerCase();

  if (name.endsWith('.docx')) return docxToText(buffer);
  if (name.endsWith('.pdf')) return pdfToText(buffer);
  if (name.endsWith('.txt') || name.endsWith('.text')) return buffer.toString('utf8');
  if (name.endsWith('.doc')) {
    throw new Error(
      'Old .doc files are not supported. Open it in Word and use ' +
      '"Save As -> Word Document (.docx)", or save it as PDF.'
    );
  }

  // Fall back on the file's own signature when the name is unhelpful.
  if (buffer.subarray(0, 4).toString('latin1') === '%PDF') return pdfToText(buffer);
  if (buffer[0] === 0x50 && buffer[1] === 0x4b) return docxToText(buffer);

  throw new Error('Unsupported file type. Please upload a PDF, a Word .docx, or a .txt file.');
}

/* ============================================ text -> questions ========= */

const QUESTION_START = /^\s*(?:q(?:uestion)?\s*\.?\s*)?(\d{1,3})\s*[.)\]:-]\s*(.*)$/i;
const OPTION_LINE = /^\s*\(?\s*([a-hA-H])\s*[.)\]:-]\s+(.+?)\s*$/;
const ANSWER_LINE = /^\s*(?:correct\s*(?:answer|option)|answer|ans|key)\s*[:.\-–]\s*(.+?)\s*$/i;
/** Options crammed onto one line: "A) red B) blue C) green" */
const INLINE_OPTIONS = /\(?\b([a-hA-H])\)\s*([^()]+?)(?=\s*\(?\b[a-hA-H]\)|$)/g;

const cleanLine = (s) => s
  .replace(/ /g, ' ')
  .replace(/[ \t]+/g, ' ')
  .trim();

/** Normalise an answer to the option letter when we can recognise one. */
function normaliseAnswer(raw, options) {
  const answer = String(raw || '').trim();
  if (!answer) return '';
  if (!options.length) return answer;

  const letter = answer.match(/^\(?\s*([a-hA-H])\s*[).:\-]?\s*$/);
  if (letter) return letter[1].toUpperCase();

  // "B) blue" or "Option B"
  const prefixed = answer.match(/^(?:option\s*)?\(?\s*([a-hA-H])\s*[).:\-]\s*(.+)$/i);
  if (prefixed && options.some((o) => o.key === prefixed[1].toUpperCase())) {
    return prefixed[1].toUpperCase();
  }

  // Match the answer against the option text itself.
  const hit = options.find((o) => o.text.toLowerCase() === answer.toLowerCase());
  return hit ? hit.key : answer;
}

/**
 * Turn extracted text into questions.
 * Returns { questions, warnings } — warnings are shown to the teacher so they
 * can fix anything the parser was unsure about before saving.
 */
function parseQuestions(text, { mode = 'both' } = {}) {
  const lines = String(text || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(cleanLine)
    .filter((l) => l.length);

  const blocks = [];
  let current = null;

  for (const line of lines) {
    const start = line.match(QUESTION_START);
    // A line like "2000. " inside prose should not start a question, so require
    // either the very first question or a sensible next number.
    const looksLikeNext = start &&
      (!current ? Number(start[1]) <= 2 : Number(start[1]) === current.number + 1);

    if (start && (looksLikeNext || !current)) {
      if (current) blocks.push(current);
      current = { number: Number(start[1]), lines: [], head: start[2] || '' };
      continue;
    }
    if (current) current.lines.push(line);
  }
  if (current) blocks.push(current);

  const warnings = [];
  const questions = [];

  blocks.forEach((block, index) => {
    const options = [];
    const bodyParts = block.head ? [block.head] : [];
    let answerRaw = '';

    for (const line of block.lines) {
      const answer = line.match(ANSWER_LINE);
      if (answer) { answerRaw = answer[1]; continue; }

      const option = line.match(OPTION_LINE);
      if (option) {
        options.push({ key: option[1].toUpperCase(), text: option[2].trim() });
        continue;
      }
      // Options may share one line.
      if (!options.length && /\(?\b[a-hA-H]\)\s+\S/.test(line) && (line.match(/\b[a-hA-H]\)/g) || []).length >= 2) {
        let m;
        INLINE_OPTIONS.lastIndex = 0;
        while ((m = INLINE_OPTIONS.exec(line)) !== null) {
          options.push({ key: m[1].toUpperCase(), text: m[2].trim() });
        }
        continue;
      }
      bodyParts.push(line);
    }

    // The answer may be tacked onto the end of the question line.
    let questionText = bodyParts.join(' ').trim();

    // Options are often typed on the same line as the question itself:
    //   "1. Pick a colour A) red B) blue C) green"
    if (!options.length) {
      const markers = questionText.match(/\(?\b[a-hA-H]\)\s+\S/g) || [];
      if (markers.length >= 2) {
        const first = questionText.search(/\(?\b[a-hA-H]\)\s+\S/);
        const head = questionText.slice(0, first).trim();
        const tail = questionText.slice(first);
        let m;
        INLINE_OPTIONS.lastIndex = 0;
        while ((m = INLINE_OPTIONS.exec(tail)) !== null) {
          options.push({ key: m[1].toUpperCase(), text: m[2].trim() });
        }
        if (options.length >= 2 && head) questionText = head;
        else if (options.length < 2) options.length = 0;
      }
    }
    if (!answerRaw) {
      const trailing = questionText.match(/\s*[\(\[]?\s*(?:ans(?:wer)?|key)\s*[:\-]\s*([^)\]]+)[\)\]]?\s*$/i);
      if (trailing) {
        answerRaw = trailing[1];
        questionText = questionText.slice(0, trailing.index).trim();
      }
    }

    const type = options.length >= 2 ? 'mcq' : 'fill';
    const correctAnswer = normaliseAnswer(answerRaw, options);
    const position = index + 1;

    if (!questionText) warnings.push(`Question ${position} has no text — please type it in.`);
    if (!correctAnswer) warnings.push(`Question ${position} has no answer — please add it.`);
    if (type === 'mcq' && correctAnswer && !options.some((o) => o.key === correctAnswer)) {
      warnings.push(`Question ${position}: the answer "${correctAnswer}" is not one of its options.`);
    }
    if (options.length === 1) {
      warnings.push(`Question ${position} has only one option — it was read as fill-in-the-blank.`);
    }

    questions.push({
      position,
      type,
      questionText,
      options: type === 'mcq' ? options : [],
      correctAnswer,
      marks: 1,
    });
  });

  if (!questions.length) {
    warnings.push(
      'No questions could be recognised. Number each question (1. 2. 3.), put ' +
      'options on their own lines as A) B) C), and write the answer as ' +
      '"Answer: B" underneath.'
    );
  }

  // Respect the exam's chosen question style.
  if (mode === 'mcq') {
    const wrong = questions.filter((q) => q.type !== 'mcq').length;
    if (wrong) warnings.push(`${wrong} question(s) have no options, but this exam is multiple choice only.`);
  }
  if (mode === 'fill') {
    const wrong = questions.filter((q) => q.type !== 'fill').length;
    if (wrong) warnings.push(`${wrong} question(s) have options, but this exam is fill-in-the-blank only.`);
  }

  return { questions, warnings };
}

module.exports = { extractText, parseQuestions, unzip, docxToText, pdfToText };
