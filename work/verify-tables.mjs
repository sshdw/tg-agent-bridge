import { markdownToHtml } from '../dist/telegram/markdown.js';

const ALLOWED = new Set(['b', 'i', 'u', 's', 'code', 'pre', 'a', 'blockquote']);
const failures = [];
let n = 0;

function check(label, ok, detail = '') {
  n += 1;
  if (!ok) failures.push(`${label}${detail === '' ? '' : ` :: ${detail}`}`);
}

function validate(label, html) {
  const stack = [];
  for (const m of html.matchAll(/<\/?([a-z]+)([^>]*)>/g)) {
    const tag = m[1];
    const closing = m[0].startsWith('</');
    check(`${label}: tag allowed`, ALLOWED.has(tag), tag);
    if (closing) {
      check(`${label}: balanced`, stack.pop() === tag, `close ${tag}, stack=${stack}`);
    } else {
      stack.push(tag);
    }
  }
  check(`${label}: all closed`, stack.length === 0, `left open: ${stack}`);
  const bare = html.replace(/<[^>]+>/g, '').match(/[<>]/g) ?? [];
  check(`${label}: no raw angle in text`, bare.length === 0, `found ${bare.length}`);
  const badAmp = html.replace(/&(amp|lt|gt|quot|#\d+);/g, '').includes('&');
  check(`${label}: only known entities`, !badAmp);
}

// 1. The exact table from the owner's screenshot: BORDERLESS, no |---| row.
const modelTable = [
  'модель | цена in/out $/1M | оценка | для чего',
  'Opus 5.5 | 4/20 | 10 | лучший код, агент',
  'Sonnet 5.5 | 2/10 | 9.6 | код быстро+качественно',
  'GPT-6.1 Sol | 2/10 | 9.5 | агент, сложная логика',
  'GPT-6 Astra | 10/50 | 9.4 | max reasoning',
  'Muse Spark 1.3 | 1.25/4.25 | 8.2 | быстрая, ты на free-версии',
].join('\n');
const t1 = markdownToHtml(modelTable);
console.log('--- 4-column borderless table ---');
console.log(t1);
validate('table4', t1);
check('table4: no pipes left', !t1.includes('|'), t1);
check('table4: legend present', t1.includes('<b>модель · цена in/out $/1M · оценка · для чего</b>'), t1);
// 5 rows, each a 4-cell line joined by 3 em-dashes => 15 separators, 6 lines total.
const t1Lines = t1.split('\n').filter((l) => l !== '');
check('table4: row count', t1Lines.length === 6, String(t1Lines.length));
check('table4: separator count', (t1.match(/—/g) ?? []).length === 15, String((t1.match(/—/g) ?? []).length));
check('table4: last row intact', t1Lines[5] === '<b>Muse Spark 1.3</b> — 1.25/4.25 — 8.2 — быстрая, ты на free-версии', t1Lines[5]);

// 1b. Same table WITH a proper alignment row must render identically.
const modelTableDelim = [
  'модель | цена | оценка | для чего',
  '---|---|---|---|',
  'Opus 5.5 | 4/20 | 10 | лучший код',
  'Sonnet 5.5 | 2/10 | 9.6 | быстро',
  'GPT-6 Astra | 10/50 | 9.4 | reasoning',
].join('\n');
const t1b = markdownToHtml(modelTableDelim);
console.log('\n--- 4-column delimited table ---');
console.log(t1b);
validate('table4b', t1b);
check('table4b: no pipes', !t1b.includes('|'), t1b);
check('table4b: no delimiter row leaked', !/---/.test(t1b), t1b);

// 2. Two-column table, borderless (what the owner would hit most often).
const t2 = markdownToHtml('файл | что\nsrc/core/files.ts | разбор путей\nsrc/core/queue.ts | очередь');
console.log('\n--- 2-column borderless table ---');
console.log(t2);
validate('table2', t2);
check('table2: key:value shape', t2.includes('<b>src/core/files.ts</b>: разбор путей'), t2);
check('table2: no pipes', !t2.includes('|'), t2);

// 2b. Two-column table with an alignment row.
const t2b = markdownToHtml('файл | что\n---|---\nREADME.md | описание');
console.log('\n--- 2-column delimited table ---');
console.log(t2b);
validate('table2b', t2b);
check('table2b: key:value shape', t2b.includes('<b>README.md</b>: описание'), t2b);

// 3. Leading/trailing pipes, escaped pipe inside a cell, alignment colons.
const t3 = markdownToHtml('| a | b |\n|:--|--:|\n| x \\| y | z |');
console.log('\n--- padded + escaped pipe ---');
console.log(t3);
validate('table3', t3);
check('table3: literal pipe preserved', t3.includes('x | y'), t3);

// 4. A 200-row table is capped, and says so. (delimited form)
const many = ['h1 | h2', '--- | ---', ...Array.from({ length: 200 }, (_, i) => `r${i} | v${i}`)].join('\n');
const t4 = markdownToHtml(many);
validate('table200', t4);
check('table200: capped', !t4.includes('r199'), 'row 199 leaked');
check('table200: says how many left', /ещё 160 строк/.test(t4), t4.slice(-80));

// 4b. Same cap on a borderless table.
const manyB = ['h1 | h2', ...Array.from({ length: 200 }, (_, i) => `r${i} | v${i}`)].join('\n');
const t4b = markdownToHtml(manyB);
validate('table200b', t4b);
check('table200b: capped', !t4b.includes('r199'), 'row 199 leaked');
check('table200b: says how many left', /ещё 160 строк/.test(t4b), t4b.slice(-80));

// 5. NOT a table: prose, a bullet, a heading rule, inconsistent widths, stray pipes.
for (const [label, src, expectPipe] of [
  ['prose-dash', 'стоит 4-20 $/1M — дёшево', false],
  ['single-pipe-line', 'a | b', true],
  ['bullet-with-pipe', '- пункт | с палочкой', true],
  ['setext-rule', 'заголовок\n---', false],
  ['empty-delim', 'a | b\n| |', true],
  // Two consecutive pipe lines of DIFFERENT width must stay literal text.
  ['unstable-width', 'a | b | c\nx | y', true],
  // A pipe line directly under a heading is a heading, not a table header.
  ['heading-then-pipes', '# Заголовок\n\nодин | два', true],
]) {
  const h = markdownToHtml(src);
  validate(label, h);
  if (expectPipe) check(`${label}: pipes preserved as text`, h.includes('|'), h);
  check(`${label}: no table artefacts`, !h.includes('<i>… ещё'), h);
  check(`${label}: no bold legend invented`, !/^<b>.* · .*<\/b>$/m.test(h), h);
}

// 5b. A table followed by prose must not swallow the prose.
const after = markdownToHtml('a | b\n1 | 2\n3 | 4\n\nИтог: всё.');
validate('table-then-prose', after);
check('table-then-prose: prose kept', after.includes('Итог: всё.'), after);
check('table-then-prose: table rendered', !after.includes('|'), after);

// 6. Table inside surrounding prose and lists keeps everything else intact.
const mixed = markdownToHtml([
  'Сравнение:',
  '',
  'модель | цена | для чего',
  '---|---|---',
  'A | 1 | раз',
  'B | 2 | два',
  '',
  'Итог: **A** дешевле.',
  '',
  '```js',
  'const t = a | b;',
  '```',
].join('\n'));
console.log('\n--- mixed prose + table + fence ---');
console.log(mixed);
validate('mixed', mixed);
check('mixed: fence intact', mixed.includes('<pre><code class="language-js">const t = a | b;</code></pre>'), mixed);
check('mixed: bold after table', mixed.includes('<b>A</b> дешевле'), mixed);

// 7. A table cell carrying markup and a link.
const t7 = markdownToHtml('файл | ссылка\n`a.ts` | [дока](https://example.com/x)');
validate('table7', t7);
check('table7: code cell', t7.includes('<code>a.ts</code>'), t7);
check('table7: link href', t7.includes('<a href="https://example.com/x">'), t7);

console.log(`\n${n - failures.length}/${n} passed`);
if (failures.length > 0) {
  console.log('FAILURES:');
  for (const f of failures) console.log('  -', f);
  process.exit(1);
}
console.log('ALL GREEN');
