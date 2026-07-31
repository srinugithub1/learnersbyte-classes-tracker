/**
 * The .xlsx writer — structure, not appearance.
 *
 *   node test/sheet.test.js
 *
 * A workbook Excel calls "corrupt" fails silently for the teacher, so the parts
 * that make it valid are checked here: the zip entries, the relationships, the
 * XML being well formed, and numbers staying numbers.
 */

const sheet = require('../sheet');
const parse = require('../parse');

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? ` — ${extra}` : ''}`); }
};
const section = (t) => console.log(`\n== ${t} ==`);

/* --------------------------------------------------------- column names */

section('column names');
ok('the first column is A', sheet.columnName(0) === 'A');
ok('the 26th is Z', sheet.columnName(25) === 'Z');
ok('the 27th is AA', sheet.columnName(26) === 'AA', sheet.columnName(26));
ok('the 53rd is BA', sheet.columnName(52) === 'BA', sheet.columnName(52));

/* ---------------------------------------------------------- sheet names */

section('sheet names');
ok('a name Excel forbids is cleaned', !/[\\/*?:[\]]/.test(sheet.safeSheetName('Unit/Test: 1 [A]', 'X')));
ok('a long name is cut to 31', sheet.safeSheetName('x'.repeat(60), 'X').length === 31);
ok('an empty name falls back', sheet.safeSheetName('', 'Results') === 'Results');
ok('a name of only illegal characters falls back', sheet.safeSheetName('///', 'Results') === 'Results');

/* -------------------------------------------------------- the workbook */

section('a workbook');

const book = sheet.buildXlsx([
  {
    name: 'Summary',
    columns: [{ width: 20 }, { width: 30 }],
    rows: [
      { title: 'Exam results' },
      'blank',
      ['Average', 61.5],
      ['Pass rule', '8 marks or above'],
    ],
  },
  {
    name: 'Results',
    freezeHeader: true,
    columns: [{ header: 'Rank', width: 6 }, { header: 'Student', width: 24 }, { header: 'Score', width: 8 }],
    rows: [
      { header: ['Rank', 'Student', 'Score'] },
      [1, 'Aisha "Ash" <O\'Neil> & Co', 20],
      [2, 'Ravi Kumar', 18],
      ['', 'Did not sit', ''],
    ],
  },
]);

ok('it is a Buffer', Buffer.isBuffer(book));
ok('it starts with the zip signature', book.subarray(0, 2).toString('latin1') === 'PK');

// parse.js already has a zip reader — reuse it rather than trusting the writer
// to describe its own output.
const files = parse.unzip(book);
const names = [...files.keys()].sort();

ok('every required part is present',
  ['[Content_Types].xml', '_rels/.rels', 'xl/_rels/workbook.xml.rels',
    'xl/styles.xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml',
    'xl/worksheets/sheet2.xml'].every((n) => names.includes(n)),
  names.join(', '));

const text = (name) => files.get(name).toString('utf8');

ok('the content types name both sheets',
  text('[Content_Types].xml').includes('/xl/worksheets/sheet1.xml') &&
  text('[Content_Types].xml').includes('/xl/worksheets/sheet2.xml'));

const wb = text('xl/workbook.xml');
ok('the workbook lists both tabs', wb.includes('name="Summary"') && wb.includes('name="Results"'));

const rels = text('xl/_rels/workbook.xml.rels');
ok('every sheet has a relationship',
  rels.includes('worksheets/sheet1.xml') && rels.includes('worksheets/sheet2.xml'));
ok('and the styles do too', rels.includes('styles.xml'));
ok('the relationship ids match the workbook',
  wb.includes('r:id="rId1"') && wb.includes('r:id="rId2"') &&
  rels.includes('Id="rId1"') && rels.includes('Id="rId2"'));

/* ------------------------------------------------------------- the cells */

section('cells');

const s2 = text('xl/worksheets/sheet2.xml');

ok('a number is written as a number, not text',
  s2.includes('<c r="C2"><v>20</v></c>'), s2.slice(0, 400));
ok('text is written as an inline string',
  /<c r="B3"[^>]*t="inlineStr"><is><t[^>]*>Ravi Kumar<\/t>/.test(s2));
ok('a blank cell is empty, not zero',
  /<c r="A4"\/>/.test(s2), s2);

ok('the header row is bold', /<row r="1">.*?s="1"/.test(s2));
ok('the header row is frozen', s2.includes('state="frozen"'));
ok('column widths are set', s2.includes('customWidth="1"'));

// A name with XML characters in it is the classic way to produce a file Excel
// refuses to open.
ok('quotes and angle brackets are escaped',
  s2.includes('Aisha &quot;Ash&quot; &lt;O\'Neil&gt; &amp; Co'), s2.match(/Aisha[^<]*/));
ok('no raw ampersand survives',
  !/&(?!amp;|quot;|lt;|gt;|apos;|#)/.test(s2));

const s1 = text('xl/worksheets/sheet1.xml');
ok('a blank row is written as an empty row', /<row r="2"\/>/.test(s1), s1);
ok('a title row is bold', /<row r="1"><c r="A1" s="1"/.test(s1), s1);
ok('a decimal survives', s1.includes('<v>61.5</v>'));

/* --------------------------------------------------------- well formed */

section('the XML is well formed');

/**
 * Walk the tags with a stack. Counting `<` and `</` cannot work — an attribute
 * value like a namespace URL contains slashes — so match tag by tag and check
 * that each close pairs with the open below it.
 */
function xmlProblem(xml) {
  const stack = [];
  const tag = /<(\/?)([A-Za-z_][\w.:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
  const body = xml.replace(/<\?[\s\S]*?\?>/g, '').replace(/<!--[\s\S]*?-->/g, '');
  let m;
  let consumed = 0;

  while ((m = tag.exec(body)) !== null) {
    consumed += m[0].length;
    const [, closing, name, , selfClosing] = m;
    if (selfClosing) continue;
    if (closing) {
      if (!stack.length) return `</${name}> with nothing open`;
      const open = stack.pop();
      if (open !== name) return `</${name}> closes <${open}>`;
      continue;
    }
    stack.push(name);
  }
  if (stack.length) return `never closed: <${stack.join('>, <')}>`;
  // A stray "<" that no tag matched would leave text the reader cannot parse.
  if (/</.test(body.replace(tag, ''))) return 'a stray < outside any tag';
  return consumed ? null : 'no tags at all';
}

for (const name of names) {
  if (!name.endsWith('.xml') && !name.endsWith('.rels')) continue;
  const problem = xmlProblem(text(name));
  ok(`${name} is well formed`, problem === null, problem || '');
}

// Prove the checker itself would catch a broken file, so a pass means something.
ok('the checker rejects an unclosed tag', xmlProblem('<a><b></a>') !== null);
ok('the checker rejects a dangling close', xmlProblem('</a>') !== null);
ok('the checker accepts a namespace URL full of slashes',
  xmlProblem('<a xmlns="http://x/y/z"><b/></a>') === null);

/* --------------------------------------------------------------- edges */

section('edge cases');

const empty = sheet.buildXlsx([]);
ok('an empty workbook is still a valid file', parse.unzip(empty).has('xl/workbook.xml'));

const control = sheet.buildXlsx([{ name: 'X', rows: [[`badname`]] }]);
ok('a control character is stripped rather than written',
  !parse.unzip(control).get('xl/worksheets/sheet1.xml').toString('utf8').includes(''));

const wide = sheet.buildXlsx([{
  name: 'Wide',
  rows: [Array.from({ length: 30 }, (_, i) => i)],
}]);
ok('a sheet wider than 26 columns keeps going past Z',
  parse.unzip(wide).get('xl/worksheets/sheet1.xml').toString('utf8').includes('r="AD1"'));

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exitCode = fail ? 1 : 0;
