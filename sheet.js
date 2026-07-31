/**
 * A very small .xlsx writer — no dependencies.
 *
 * CSV opens in Excel, but it loses the difference between "0123" and 123, has
 * no column widths, and cannot carry two tables in one file. A real workbook
 * costs about two hundred lines, so it is worth writing.
 *
 * What it supports, and no more: several sheets, a bold frozen header row,
 * column widths, and cells that are text, number or blank. That is everything a
 * results export needs.
 */

const zlib = require('zlib');

/* ------------------------------------------------------------------- zip */

/**
 * A ZIP with stored (uncompressed) entries.
 *
 * Deflate would make the file smaller, but stored entries need no compression
 * bookkeeping and a results sheet is a few tens of kilobytes either way.
 */
function zip(entries) {
  const parts = [];
  const central = [];
  let offset = 0;

  for (const [name, text] of entries) {
    const data = Buffer.from(text, 'utf8');
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = zlib.crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);   // local file header
    local.writeUInt16LE(20, 4);           // version needed
    local.writeUInt16LE(0, 6);            // flags
    local.writeUInt16LE(0, 8);            // stored, not deflated
    local.writeUInt16LE(0, 10);           // modified time
    local.writeUInt16LE(0x2821, 12);      // modified date (2000-01-01)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, nameBuf, data);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);     // central directory header
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0, 8);
    dir.writeUInt16LE(0, 10);
    dir.writeUInt16LE(0, 12);
    dir.writeUInt16LE(0x2821, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(data.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([dir, nameBuf]));

    offset += local.length + nameBuf.length + data.length;
  }

  const dirBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);       // end of central directory
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dirBuf.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...parts, dirBuf, end]);
}

/* ------------------------------------------------------------------- xml */

const esc = (value) => String(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  // Control characters are illegal in XML and would make Excel call the file
  // corrupt. Student names arriving from a paste can carry them.
  .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');

/** 0 -> A, 25 -> Z, 26 -> AA */
function columnName(index) {
  let name = '';
  let n = index;
  do {
    name = String.fromCharCode(65 + (n % 26)) + name;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return name;
}

const isNumber = (v) => typeof v === 'number' && Number.isFinite(v);

function cell(ref, value, styleIndex) {
  const style = styleIndex ? ` s="${styleIndex}"` : '';
  if (value === null || value === undefined || value === '') return `<c r="${ref}"${style}/>`;
  if (isNumber(value)) return `<c r="${ref}"${style}><v>${value}</v></c>`;
  return `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${esc(value)}</t></is></c>`;
}

/**
 * One sheet: { name, columns: [{ header, width }], rows: [[cell, …]] }
 * A row may also be the string 'blank' to leave a gap, or
 * { title: 'text' } for a bold full-width line between tables.
 */
function sheetXml(sheet) {
  const columns = sheet.columns || [];
  const cols = columns.length
    ? `<cols>${columns.map((c, i) =>
      `<col min="${i + 1}" max="${i + 1}" width="${c.width || 16}" customWidth="1"/>`).join('')}</cols>`
    : '';

  const lines = [];
  let r = 0;

  const push = (values, style) => {
    r++;
    const cells = values.map((v, i) => cell(`${columnName(i)}${r}`, v, style)).join('');
    lines.push(`<row r="${r}">${cells}</row>`);
  };

  for (const row of sheet.rows || []) {
    if (row === 'blank') { r++; lines.push(`<row r="${r}"/>`); continue; }
    if (row && row.title !== undefined) { push([row.title], 1); continue; }
    if (row && row.header) { push(row.header, 1); continue; }
    push(row, 0);
  }

  // The header row is the first row only when the sheet opens with one.
  const freeze = sheet.freezeHeader
    ? '<sheetViews><sheetView workbookViewId="0">'
      + '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>'
      + '</sheetView></sheetViews>'
    : '';

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${freeze}${cols}<sheetData>${lines.join('')}</sheetData></worksheet>`;
}

const CONTENT_TYPES = (count) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${Array.from({ length: count }, (_, i) =>
    `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('\n')}
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

/* Two cell formats: 0 plain, 1 bold. */
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="2">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
</cellXfs>
</styleSheet>`;

/** Excel refuses these characters in a tab name, and caps it at 31. */
const safeSheetName = (name, fallback) => (String(name || fallback)
  .replace(/[\\/*?:[\]]/g, ' ')
  .trim()
  .slice(0, 31) || fallback);

/** Build a workbook. Returns a Buffer ready to send as a download. */
function buildXlsx(sheets) {
  const list = (sheets || []).length ? sheets : [{ name: 'Sheet1', rows: [] }];

  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${list.map((s, i) =>
    `<sheet name="${esc(safeSheetName(s.name, `Sheet${i + 1}`))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>
</workbook>`;

  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${list.map((s, i) =>
    `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('\n')}
<Relationship Id="rId${list.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

  return zip([
    ['[Content_Types].xml', CONTENT_TYPES(list.length)],
    ['_rels/.rels', ROOT_RELS],
    ['xl/workbook.xml', workbook],
    ['xl/_rels/workbook.xml.rels', workbookRels],
    ['xl/styles.xml', STYLES],
    ...list.map((s, i) => [`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s)]),
  ]);
}

module.exports = { buildXlsx, zip, columnName, safeSheetName };
