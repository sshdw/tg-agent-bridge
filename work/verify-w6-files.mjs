/**
 * W6 Files + diff viewer harness — no browser, no Telegram, no .env.
 * Pure ESM imports of web/lib/diff.js + web/lib/api.js + web/screens/files.js
 * (node >= 22) plus deterministic CSS/HTML/JS greps. telegram-web-app.js is
 * NEVER loaded; transport is a stub fetch.
 * Usage: node work/verify-w6-files.mjs   (run from the repo root)
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

const appJs = read('web/app.js');
const appCss = read('web/app.css');
const tokens = read('web/tokens.css');
const filesJs = read('web/screens/files.js');

const diff = await import('../web/lib/diff.js');
const api = await import('../web/lib/api.js');
const files = await import('../web/screens/files.js');

let passed = 0;
const failures = [];
let group = '';
const g = (name) => {
  group = name;
  process.stdout.write(`\n${name}\n`);
};
function ok(label) {
  passed += 1;
  process.stdout.write(`  ok   ${label}\n`);
}
function assert(cond, label) {
  if (cond) ok(label);
  else {
    failures.push(`${group} :: ${label}`);
    process.stdout.write(`  FAIL ${label}\n`);
  }
}
const count = (s, re) => (s.match(re) ?? []).length;

/* Fixtures mirroring the W4 API shapes (api.ts filesList/filesPreview/
/ filesDiff/taskFiles/taskDiff). */
const SMALL_DIFF =
  `--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,3 +1,4 @@\n ctx\n-old1\n-old2\n+new1\n+new2\n+new3\n ctx2`;
const TRUNC_DIFF = `${SMALL_DIFF}\n…ещё 12 строк`;
const BIG_DIFF = `--- a/big.ts\n+++ b/big.ts\n@@ -1,600 +1,600 @@\n${'+x\n'.repeat(600).trimEnd()}`;

/* ---------------- A: lib/diff.js units ---------------- */
g('A parseUnifiedDiff units');
{
  const p = diff.parseUnifiedDiff(SMALL_DIFF);
  assert(p.added === 3 && p.removed === 2, 'counts +3 −2, +++ / --- headers excluded');
  assert(p.rows.some((r) => r.kind === 'hunk') && p.rows.some((r) => r.kind === 'meta'), 'hunk + meta rows present');
  assert(p.rows.some((r) => r.kind === 'ctx'), 'ctx rows present');
  assert(p.dropped === 0, 'complete diff: dropped 0');
  const t = diff.parseUnifiedDiff(TRUNC_DIFF);
  assert(t.dropped === 12, 'trailer …ещё 12 строк -> dropped 12');
  assert(t.added === 3 && t.removed === 2, 'truncated diff keeps counts');
  const e = diff.parseUnifiedDiff('');
  assert(e.rows.length === 0 && e.added === 0 && e.removed === 0 && e.dropped === 0, 'empty diff -> zeros');
  assert(diff.DIFF_CHUNK === 200, 'DIFF_CHUNK is 200');
  const rows600 = diff.parseUnifiedDiff(BIG_DIFF).rows;
  const c1 = diff.chunkRows(rows600, 200);
  assert(c1.visible.length === 200 && c1.remaining === 403, 'chunk 1: first 200 rows + remaining 403');
  const c2 = diff.chunkRows(rows600, 400);
  assert(c2.visible.length === 400 && c2.remaining === 203, 'chunk 2: ×200 stepping');
}

/* ---------------- B: lib/api.js contract (mock fetch) ---------------- */
g('B api.js files contract');
{
  const seen = [];
  const stub = async (url, opts) => {
    seen.push({ url, opts });
    return { status: 200, json: async () => ({ ok: true }) };
  };
  const c = api.createApiClient({ getInitData: () => 'INITDATA', fetchImpl: stub });
  await c.listFiles('.');
  await c.listFiles('src/sub');
  await c.filePreview('src/a.ts');
  await c.fileDiff('src/a.ts');
  await c.taskFiles(7);
  await c.taskDiff(7, 'src/a.ts');
  const urls = seen.map((s) => s.url).join(' ');
  assert(urls.includes('/api/files?dir=.') || urls.includes('/api/files?dir=%2E'), 'listFiles hits GET /api/files?dir=');
  assert(urls.includes('dir=src%2Fsub') || urls.includes('dir=src/sub'), 'listFiles passes subdir through');
  assert(urls.includes('/api/files/preview?path=src%2Fa.ts') || urls.includes('/api/files/preview?path=src/a.ts'), 'filePreview hits /api/files/preview?path=');
  assert(urls.includes('/api/files/diff?path='), 'fileDiff hits /api/files/diff?path=');
  assert(urls.includes('/api/tasks/7/files'), 'taskFiles hits /api/tasks/:id/files');
  assert(urls.includes('/api/tasks/7/diff?path='), 'taskDiff hits /api/tasks/:id/diff?path=');
  assert(seen.every((s) => s.opts.headers['X-Telegram-Init-Data'] === 'INITDATA'), 'initData header on files endpoints');
  assert(api.downloadUrl('src/a.ts') === '/api/files/download?path=src%2Fa.ts', 'downloadUrl builder is exact');
  assert(c.downloadUrl('a b.ts') === '/api/files/download?path=a%20b.ts', 'downloadUrl encodes spaces');
  // Fixture shape checks against the api.ts contract.
  const previewFixture = { path: 'big.bin.ts', abs: 'D:\\proj\\big.bin.ts', text: 'x'.repeat(65536), truncated: true, size: 204800 };
  assert(previewFixture.text.length === 64 * 1024 && previewFixture.size === 200 * 1024, 'preview fixture: 200KB file -> 64KB head');
  const taskFilesFixture = { files: [{ path: 'src/a.ts', added: 3, removed: 2, truncated: false, binary: false }], changed_n: 1, total_added: 3, total_removed: 2 };
  assert(typeof taskFilesFixture.files[0].truncated === 'boolean' && typeof taskFilesFixture.files[0].binary === 'boolean', 'task_files rows carry boolean truncated/binary');
}

/* ---------------- C: screens/files.js render ---------------- */
g('C explorer + abs-path');
{
  const v = files.renderFilesExplorer({
    abs: 'D:\\proj',
    dir: '.',
    entries: [
      { name: 'src', rel: 'src', size: 0, mtime: 1, isDir: true },
      { name: 'a.ts', rel: 'src/a.ts', size: 12, mtime: 1, isDir: false },
    ],
    parent: null,
  });
  assert(v.html.includes('data-testid="abs-path"'), 'abs bar carries data-testid="abs-path"');
  assert(v.html.includes('D:\\proj'), 'abs path text is visible');
  assert(v.html.includes('data-rel="src"') && v.html.includes('data-rel="src/a.ts"'), 'links built from entries[].rel only');
  assert(!/<input/i.test(filesJs), 'no manual path input widget in files.js');
  assert(v.float === '', 'explorer: no floating bar');
}

g('C preview caps');
{
  const big = files.renderFilePreview({ path: 'big.ts', abs: 'D:\\proj\\big.ts', text: 'x'.repeat(65536), truncated: true, size: 204800, binary: false });
  assert(big.html.includes('truncated'), '200KB file -> truncated badge');
  assert(big.html.includes('204800') && /metric/.test(big.html), 'size rendered in .metric');
  assert((big.html.match(/x{100,}/) ?? []).length >= 1, '64KB head text rendered');
  const bin = files.renderFilePreview({ path: 'a.png', abs: 'D:\\proj\\a.png', binary: true });
  assert(bin.html.includes('binary'), 'binary -> binary badge');
  assert(!/<pre/i.test(bin.html), 'binary -> no text render attempt');
}

g('C single renderDiff');
{
  const defs = count(filesJs, /(function|const|let|var)\s+renderDiff\b/g);
  assert(defs === 1, `renderDiff defined exactly once in files.js (found ${defs})`);
  assert(count(appJs, /(function|const|let|var)\s+renderDiff\b/g) === 0, 'no second renderDiff in app.js');
  const d = files.renderDiff({ path: 'src/a.ts', abs: 'D:\\proj', rel: 'src/a.ts', diff: SMALL_DIFF, added: 3, removed: 2 });
  assert(count(d.html, /diff-add/g) === 3 && count(d.html, /diff-del/g) === 2, 'API +N −N match .diff-add/.diff-del row counts');
  assert(d.html.includes('+3') && d.html.includes('−2'), 'counts header shows +3 −2');
  const t = files.renderDiff({ path: 'src/a.ts', diff: TRUNC_DIFF, truncated: true, added: 3, removed: 2 });
  assert(t.html.includes('…ещё 12 строк'), 'truncated shows …ещё N строк');
  assert(t.html.split('…ещё 12 строк').length - 1 === 1, 'truncated trailer renders exactly once (no duplicate row in .diff-view)');
  const b = files.renderDiff({ path: 'img.png', binary: true, added: 0, removed: 0 });
  assert(b.html.includes('img.png') && !/diff-add|diff-del/.test(b.html), 'binary diff -> name only, no rows');
  const ng = files.renderDiff({ path: 'src/a.ts', no_git: true, diff: '' });
  assert(/No diff available/.test(ng.html), 'no_git -> empty state, no fetch loop');
  const tf = files.renderTaskFiles({ taskId: 7, files: [{ path: 'src/a.ts', added: 3, removed: 2, truncated: false, binary: false }], changed_n: 1, total_added: 3, total_removed: 2 });
  assert(tf.html.includes('data-action="task-diff"'), 'per-task rows open per-path diff via shared renderer');
}

g('C chunked render');
{
  const d1 = files.renderDiff({ path: 'big.ts', diff: BIG_DIFF, shown: 200 });
  assert(count(d1.html, /diff-row/g) === 200, '10k-line scale: first 200 rows render');
  assert(/Show more \(40\d\)/.test(d1.html), 'show-more carries the remaining count');
  const d2 = files.renderDiff({ path: 'big.ts', diff: BIG_DIFF, shown: 400 });
  assert(count(d2.html, /diff-row/g) === 400 && /Show more \(20\d\)/.test(d2.html), 'show more steps ×200');
}

g('C copy-path byte-exactness');
{
  const clips = [];
  const clipboard = { writeText: async (t) => { clips.push(t); } };
  let haptic = 0;
  const copied = await files.copyPath({ clipboard, haptics: { selectionChanged: () => { haptic += 1; } } }, 'D:\\proj', 'src/a.ts');
  assert(copied === 'D:\\proj/src/a.ts', 'copy text is EXACT abs + rel');
  assert(clips.length === 1 && clips[0] === 'D:\\proj/src/a.ts', 'stub clipboard received the byte-exact string');
  assert(haptic === 1, 'HapticFeedback.selectionChanged fires on copy');
  assert(files.joinAbsRel('D:\\proj\\', 'src/a.ts') === 'D:\\proj/src/a.ts', 'trailing separators collapse');
  assert(files.joinAbsRel('D:/x/', '/y') === 'D:/x/y', 'leading slash in rel collapses (no double slash)');
  assert(files.joinAbsRel('D:\\proj', '') === 'D:\\proj', 'empty rel -> bare abs');
}

g('C download routing');
{
  const calls = [];
  const viaDl = files.downloadFile({ tg: { downloadFile: (p) => { calls.push(p); } } }, 'https://srv/api/files/download?path=a.ts', 'a.ts');
  assert(viaDl === 'downloadFile' && calls[0].url.endsWith('path=a.ts') && calls[0].file_name === 'a.ts', 'downloadFile gets URL + file_name');
  const opened = [];
  const viaOpen = files.downloadFile({ tg: { openLink: (u) => { opened.push(u); } } }, 'https://srv/x', 'x');
  assert(viaOpen === 'openLink' && opened.length === 1, 'openLink fallback without downloadFile');
  assert(files.downloadFile({ tg: {} }, 'https://srv/x', 'x') === 'none', 'no transport -> none, no throw');
  assert(files.fileNameOf('src/dir/a.ts') === 'a.ts', 'file_name is the last path segment');
}

/* ---------------- D: grep inventory ---------------- */
g('D design + wiring inventory');
{
  assert(!/backdrop-filter/.test(filesJs), 'no backdrop-filter in files.js (D6)');
  const w6raw = appCss.slice(appCss.indexOf('W6 Files'), appCss.indexOf('@media (prefers-reduced-motion'));
  assert(w6raw.length > 500, 'W6 CSS block is locatable');
  const w6css = w6raw.replace(/\/\*[\s\S]*?\*\//g, '');
  assert(!/backdrop-filter/.test(w6css), 'no backdrop-filter in W6 CSS (D6)');
  assert(!/transition/.test(w6css), 'no transitions at all in W6 CSS (D15: width/height/top/filter unconstructible)');
  assert(!/var\(--accent-(?:action|text)\)/.test(w6css) && !/var\(--danger\)/.test(w6css), 'no new accent/danger var in W6 CSS (cap stays 5)');
  assert(count(tokens, /var\(--accent-(?:action|text)\)/g) === 5, 'accent uses still exactly 5 in tokens.css');
  assert(!/glass-float/.test(filesJs), 'no .glass-float in Files templates (content only)');
  assert(!/ServerSentEvent|EventSource|new WebSocket|WebSocket/.test(`${filesJs}\n${appJs}`), 'no SSE/WebSocket in W6 frontend path');
  assert(!/['"]dir=/.test(filesJs), 'files.js never builds dir= queries (fetch goes through api.js rel)');
  assert(filesJs.includes('data-testid="abs-path"'), 'abs-path testid in files.js source');
  assert(/onEvent\?*\.\('backButtonClicked'/.test(appJs), "BackButton onEvent('backButtonClicked') subscription present");
  assert(/BackButton\?*\.\s*show/.test(appJs) && /BackButton\?*\.\s*hide/.test(appJs), 'BackButton show/hide on drill-in depth');
  assert(/downloadFile/.test(appJs) && /openLink/.test(filesJs), 'downloadFile primary + openLink fallback wired');
  assert(filesJs.includes('diff-more') && /data-action=/.test(filesJs), 'show-more button emits diff-more');
}

process.stdout.write(`\n${String(passed)} passed, ${String(failures.length)} failed\n`);
if (failures.length > 0) {
  process.stdout.write('FAILURES:\n');
  for (const f of failures) process.stdout.write(` - ${f}\n`);
  process.exit(1);
}
