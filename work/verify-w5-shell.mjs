/**
 * W5 Mini App shell harness — no browser, no Telegram, no .env.
 * Pure ESM imports of web/lib/* + web/screens/* (node >= 22) plus
 * deterministic CSS/HTML greps. telegram-web-app.js is NEVER loaded.
 * Usage: node work/verify-w5-shell.mjs   (run from the repo root)
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

const tokens = read('web/tokens.css');
const appCss = read('web/app.css');
const appJs = read('web/app.js');
const indexHtml = read('web/index.html');
const skillTokens = read('.opencode/skills/telegram-liquid-glass/references/tokens.css');
const httpTs = read('src/miniapp/http.ts');

const perf = await import('../web/lib/perf.js');
const theme = await import('../web/lib/theme.js');
const api = await import('../web/lib/api.js');
const home = await import('../web/screens/home.js');
const tasks = await import('../web/screens/tasks.js');

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
const norm = (s) => s.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').replace(/\s+/g, ' ').trim();

/* ---------------- AC1: tokens.css tier blocks byte-identical ---------------- */
g('AC1 tokens verbatim + accent cap');
const MARK = 'PROJECT APPENDIX';
const stripTrailingOpener = (s) => s.replace(/\/\*\s*[=*][\s=*]*$/, '').trimEnd();
const webPrefix = stripTrailingOpener(tokens.slice(0, tokens.indexOf(MARK)));
const skillPrefix = skillTokens.trimEnd();
assert(tokens.includes(MARK), 'web/tokens.css carries the PROJECT APPENDIX marker');
assert(skillPrefix.length > 5000, 'skill tokens.css prefix is substantive');
assert(norm(webPrefix) === norm(skillPrefix), 'tier blocks 0-diff vs skill (normalized compare)');
for (const cls of ['.glass-nav', '.glass-float', '.glass-capsule', '.content-card', '.mono', '.metric']) {
  assert(webPrefix.includes(cls), `tier block present: ${cls}`);
}
// Accent uses (not the two --accent-*: definitions in :root).
const accentUses = [...tokens.matchAll(/var\(--accent-(?:action|text)\)/g)];
assert(accentUses.length === 5, `exactly 5 accent uses (found ${accentUses.length})`);
for (const sel of ['.btn-primary', '.nav-item[aria-selected="true"]', '\na {', '.status-hl', '.progress-bar']) {
  assert(tokens.includes(sel), `accent selector group present: ${sel.trim()}`);
}
assert(!/--accent-action:\s*#[0-9a-fA-F]/.test(tokens), 'no fixed accent hex in token definitions');

/* ---------------- AC2: forbidden greps absent ---------------- */
g('AC2 forbidden greps');
const appAll = `${tokens}\n${appCss}`;
assert(!/hue-rotate/i.test(appAll), 'no hue-rotate');
assert(!/backdrop-filter:[^;}]*invert\(/i.test(appAll), 'no invert( in backdrop-filter');
assert(!/backdrop-filter:[^;}]*sepia/i.test(appAll), 'no sepia in backdrop-filter');
assert(!/backdrop-filter:[^;}]*grayscale/i.test(appAll), 'no grayscale in backdrop-filter');
assert(!/backdrop-filter:[^;}]*drop-shadow/i.test(appAll), 'no drop-shadow in backdrop-filter');
assert(!/backdrop-filter:[^;}]*url\(/i.test(appAll), 'no url( in backdrop-filter');
assert(!/feDisplacementMap|feTurbulence/i.test(`${appAll}\n${appJs}`), 'no feDisplacementMap/feTurbulence');
assert(!/filter:\s*url\(/i.test(appAll), 'no filter:url(');
assert(!/@font-face|fonts\.google/i.test(`${indexHtml}\n${appAll}`), 'no @font-face/fonts.google');
assert(!/\binfinite\b/i.test(appCss), 'no infinite in app CSS');
assert(!/blur\((2[9-9]|[3-9]\d|\d{3,})px/i.test(appAll), 'no blur(>28px)');
assert(!/animation-delay/i.test(appCss), 'no animation-delay (no stagger) in app CSS');
assert(!/ServerSentEvent|EventSource|new WebSocket|WebSocket/i.test(`${appJs}\n${httpTs.slice(0, 4000)}`), 'no SSE/WebSocket in frontend path');

/* ---------------- AC3: glass inventory ---------------- */
g('AC3 glass inventory');
const navInIndex = (indexHtml.match(/glass-nav/g) ?? []).length;
assert(navInIndex === 1, `exactly one .glass-nav in index.html (found ${navInIndex})`);
const floatInScreens = (
  read('web/screens/home.js').replace(/\/\*[\s\S]*?\*\//g, '') +
  read('web/screens/tasks.js').replace(/\/\*[\s\S]*?\*\//g, '')
).match(/class="glass-float/g) ?? [];
assert(floatInScreens.length === 2, `one .glass-float markup per screen template (found ${floatInScreens.length} across home+tasks)`);
assert(!/glass-nav/.test(read('web/screens/home.js') + read('web/screens/tasks.js')), 'no .glass-nav inside screen templates');
assert(!/backdrop-filter/.test(appCss.replace(/\/\*[\s\S]*?\*\//g, '')), 'app.css holds layout only: no backdrop-filter');
assert(!/backdrop-filter/.test(read('web/screens/home.js') + read('web/screens/tasks.js')), 'no backdrop-filter in screen templates');
assert(!/\.content-card[^{]*{[^}]*backdrop-filter|\.list-row[^{]*{[^}]*backdrop-filter/s.test(tokens), 'content rows flat: no backdrop-filter on .content-card/.list-row');
// Nesting: no glass-float inside a glass-nav subtree in static shell.
assert(!/glass-nav[\s\S]{0,2000}glass-float/.test(indexHtml), 'no glass nested inside nav in index.html');

/* ---------------- AC3b: glass polish invariants ---------------- */
g('AC3b glass polish invariants');
// (1)+(2) elevated-sheet specular glint (блик) appended below the frozen block.
assert(tokens.includes('.glass-elevated::after'), 'tokens.css defines .glass-elevated::after glint');
{
  const i = tokens.indexOf('.glass-elevated::after');
  const block = i === -1 ? '' : tokens.slice(i, tokens.indexOf('}', i) + 1);
  assert(/var\(--sim-edge/.test(block), '.glass-elevated::after glint references var(--sim-edge…)');
}
assert(tokens.includes('.glass-elevated { position: relative; }'), '.glass-elevated gets position: relative for its ::after');
// (3) the sheet wrapper carries no scrim: the 35% dim lives on .glass-elevated.
{
  const i = appCss.indexOf('.sheet-scrim {');
  const block = i === -1 ? '' : appCss.slice(i, appCss.indexOf('}', i) + 1);
  assert(i !== -1 && !/background:/.test(block), '.sheet-scrim declares no background (single scrim on .glass-elevated)');
}
// (4) P0: the open reveal must not sit on .app — an opacity there makes .app a
// backdrop root and breaks the nav/float glass for the first 420 ms.
{
  const i = appCss.indexOf('.app {');
  const block = i === -1 ? '' : appCss.slice(i, appCss.indexOf('}', i) + 1);
  assert(i !== -1 && !/opacity:/.test(block), '.app declares no opacity (never a backdrop root at open)');
}
// (5) the 420 ms reveal still hangs off the allowlisted .app[data-ready="1"] prefix.
assert(/\.app\[data-ready="1"\]\s+\.app-head/.test(appCss), 'reveal animates .app-head via the .app[data-ready="1"] prefix');
assert(/miniapp-open 420ms/.test(appCss), '420 ms miniapp-open reveal preserved');
// (6) FIX A regression guard: fill-mode must be `backwards` (releases the
// transform when done, so .sheet-scrim stays viewport-fixed) — never `both`.
assert(
  /miniapp-open 420ms var\(--spring-open\) backwards/.test(appCss) &&
    !/miniapp-open 420ms var\(--spring-open\) both/.test(appCss),
  'reveal uses fill-mode backwards, not both (sheet scrim stays viewport-fixed)',
);
// (7) FIX B: the sheet glint is suppressed on the SOLID fallback branches.
assert(
  /\[data-flat="1"\] \.glass-elevated::after/.test(tokens) &&
    /\[data-perf="lite"\] \.glass-elevated::after/.test(tokens),
  'sheet glint hidden on [data-flat="1"] and [data-perf="lite"] solid fallbacks',
);

/* ---------------- AC4: autoPerf units ---------------- */
g('AC4 autoPerf ladder');
assert((await perf.autoPerf({ uaClass: 'LOW', measure: false })) === 'lite', 'UA LOW -> lite');
assert((await perf.autoPerf({ uaClass: 'AVERAGE', measure: false })) === 'reduced', 'UA AVERAGE -> reduced');
assert((await perf.autoPerf({ reducedMotion: true, measure: false })) === 'lite', 'prefers-reduced-motion -> lite');
assert(
  (await perf.autoPerf({ uaClass: 'HIGH', deviceMemory: 2, hardwareConcurrency: 2, devicePixelRatio: 3, frameAvgMs: 40, measure: false })) === 'lite',
  'weak heuristic (score>=3) -> lite',
);
assert((await perf.autoPerf({ measure: false })) === 'full', 'strong defaults -> full');
assert(perf.PERF_CHOICE_KEY === 'perf_choice', 'perf choice key is perf_choice');
const pcHits = [...read('web/lib/perf.js').matchAll(/performance_class/g)];
assert(pcHits.length >= 1 && pcHits.every((m) => {
  const i = m.index ?? 0;
  const ctx = read('web/lib/perf.js').slice(Math.max(0, i - 200), i + 200);
  return /UNVERIFIED/.test(ctx);
}), 'performance_class appears only beside UNVERIFIED (never read)');
assert(!/Telegram(\?\.|\.)WebApp(\?\.|\.)performance_class/.test(appJs.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')), 'app.js never reads performance_class (only the UNVERIFIED note in lib)');

/* ---------------- AC5: theme units ---------------- */
g('AC5 readThemeTokens');
const whiteFlat = theme.readThemeTokensPure({ colorScheme: 'light', themeParams: { bg_color: '#ffffff', section_bg_color: '#FFFFFF', hint_color: '#000000' } });
assert(whiteFlat.flat === '1', 'white section_bg -> data-flat=1');
const hintFail = theme.readThemeTokensPure({ colorScheme: 'light', themeParams: { bg_color: '#ffffff', hint_color: '#C8C8C8' } });
assert(hintFail.hintOk === '0', '#C8C8C8 hint on white -> hintOk=0 (fallback path)');
assert(theme.contrast('#C8C8C8', '#ffffff') < 4.5, 'contrast(#C8C8C8, white) < 4.5:1 (guard trips)');
let customOk = false;
try {
  const r = theme.readThemeTokensPure({ colorScheme: 'dark', themeParams: { bg_color: '#1a2b3c', section_bg_color: 'bogus', hint_color: '#zzzzzz' } });
  customOk = typeof r.scheme === 'string' && typeof r.flat === 'string' && typeof r.hintOk === 'string';
} catch { customOk = false; }
assert(customOk, 'custom/invalid hex never crashes');
assert(theme.relLum('#ffffff') > 0.9, 'relLum(white) > 0.90');
assert(appJs.includes("onEvent?.('themeChanged'") || appJs.includes('onEvent("themeChanged"'), 'themeChanged wiring present');
assert(appCss.includes('[data-hint-ok="0"]'), 'hint fallback CSS [data-hint-ok="0"] present');

/* ---------------- AC6: poller cadence + 304 ---------------- */
g('AC6 poller cadence + 304-no-rerender');
assert(api.POLL_ACTIVE_MS >= 1000 && api.POLL_ACTIVE_MS <= 2000, `active cadence in 1-2s (${api.POLL_ACTIVE_MS}ms)`);
assert(api.POLL_IDLE_MS >= 10000 && api.POLL_IDLE_MS <= 15000, `idle cadence in 10-15s (${api.POLL_IDLE_MS}ms)`);
assert(api.nextPollDelay({ running: true }) === api.POLL_ACTIVE_MS, 'running -> active delay');
assert(api.nextPollDelay({ running: false }) === api.POLL_IDLE_MS, 'idle -> idle delay');
assert(api.nextPollDelay({ running: true, visible: false }) === api.POLL_IDLE_MS, 'hidden -> idle delay');
assert(api.isNotModified(304) === true && api.isNotModified(200) === false, 'isNotModified(304) only');
// 304 never reaches onData.
{
  let calls = 0;
  const scheduled = [];
  const p = api.createPoller({
    tick: async () => ({ status: 304, body: null }),
    running: () => true,
    isActive: () => true,
    onData: () => { calls += 1; },
    schedule: (fn, ms) => { scheduled.push(ms); return 1; },
    cancel: () => undefined,
  });
  p.start();
  await new Promise((r) => setTimeout(r, 30));
  p.stop();
  assert(calls === 0, '304 never reaches onData (no re-render)');
  assert(scheduled.length >= 1 && scheduled[0] === api.POLL_ACTIVE_MS, 'post-tick delay follows running cadence');
}
// Paused while isActive()===false: no fetch.
{
  let fetches = 0;
  const p = api.createPoller({
    tick: async () => { fetches += 1; return { status: 200, body: {} }; },
    running: () => true,
    isActive: () => false,
    schedule: () => 1,
    cancel: () => undefined,
  });
  p.start();
  await new Promise((r) => setTimeout(r, 30));
  p.stop();
  assert(fetches === 0, 'paused while isActive()===false (no fetch)');
}
// api client: header + allowed endpoints only.
{
  const seen = [];
  const stub = async (url, opts) => {
    seen.push({ url, opts });
    return { status: 200, json: async () => ({ ok: true }) };
  };
  const c = api.createApiClient({ getInitData: () => 'INITDATA', fetchImpl: stub });
  await c.current();
  await c.recent(20, 0);
  await c.task(7, 3);
  await c.stop(7);
  await c.retry(7);
  await c.continueTask(7, 'go on');
  assert(seen.every((s) => s.opts.headers['X-Telegram-Init-Data'] === 'INITDATA'), 'initData travels in X-Telegram-Init-Data');
  const urls = seen.map((s) => s.url).join(' ');
  assert(urls.includes('/api/tasks/current') && urls.includes('/api/tasks/recent') && urls.includes('/api/tasks/7'), 'uses current/recent/one endpoints');
  assert(urls.includes('since_rev=3'), 'details poll carries since_rev');
  assert(urls.includes('/stop') && urls.includes('/retry') && urls.includes('/continue'), 'stop/retry/continue endpoints');
}

/* ---------------- AC7: Home ---------------- */
g('AC7 Home screen');
const running = { id: 3, title: 'Fix login', status: 'running', agent: 'code', mode: 'code', elapsed_s: 125 };
const hRun = home.renderHome({ running, recent: [] });
assert(hRun.html.includes('Fix login') && hRun.html.includes('running'), 'running card: title + status');
assert(hRun.html.includes('125') || hRun.html.includes('2:05'), 'running card: server elapsed_s');
assert(hRun.html.includes('metric') && hRun.html.includes('tabular-nums') || tokens.includes('tabular-nums'), '.metric tabular-nums for elapsed');
assert(hRun.float.includes('data-action="stop"') && hRun.float.includes('data-action="details"'), 'Stop + Details buttons');
assert((hRun.float.match(/glass-float/g) ?? []).length === 1, 'home: exactly one .glass-float');
const hIdle = home.renderHome({ running: null, recent: [{ id: 1, title: 'Old', status: 'done', agent: 'ask', mode: 'ask' }] });
assert(/empty-state|No active task/.test(hIdle.html), 'idle -> empty-state');
assert(hIdle.html.includes('Old'), 'idle -> recent list');
assert(hIdle.float === '', 'idle -> no floating bar');
assert(home.formatElapsed(3661) === '1:01:01', 'formatElapsed H:MM:SS (server seconds)');
assert(appJs.includes('showConfirm'), 'Stop goes through showConfirm');
assert(/POST stop|client\.stop|\.stop\(/.test(appJs), 'Stop triggers POST stop');

/* ---------------- AC8: Tasks ---------------- */
g('AC8 Tasks screen');
const list = tasks.renderTasks({ tasks: [{ id: 5, title: 'T', agent: 'code', mode: 'code', status: 'done', elapsed_s: 61, cost_usd: 0.0123 }] });
assert(list.html.includes('T') && list.html.includes('code') && list.html.includes('done'), 'row: title/agent/mode/status');
assert(list.html.includes('1:01') && list.html.includes('$0.0123'), 'row: elapsed + cost');
const det = tasks.renderTaskDetails({ id: 5, title: 'T', status: 'done', cost_usd: 0.5, elapsed_s: 9, skills_used: ['diff'], files_summary: { changed_n: 2, added: 3, removed: 1 } });
assert(det.html.includes('$0.5000'), 'details: cost');
assert(det.html.includes('diff'), 'details: skills_used');
assert(det.html.includes('changed 2') && det.html.includes('+3'), 'details: files changed_n +N');
assert(det.html.includes('−1') || det.html.includes('-1'), 'details: files −N');
assert(det.float.includes('data-action="retry"') && det.float.includes('data-action="continue"'), 'details float: retry + continue');
assert((det.float.match(/glass-float/g) ?? []).length === 1, 'details: exactly one .glass-float');
assert(/client\.retry|retry\(/.test(appJs) && /client\.continueTask|continueTask\(/.test(appJs), 'retry/continue wired in app.js');

/* ---------------- AC9: boot wiring ---------------- */
g('AC9 boot wiring');
const readyIdx = appJs.indexOf('tg?.ready()');
const expandIdx = appJs.indexOf('tg?.expand()');
assert(readyIdx !== -1 && expandIdx !== -1 && readyIdx < expandIdx, 'tg.ready() before tg.expand()');
assert(/isStateStable/.test(appJs), 'viewportChanged gated on isStateStable');
assert(!/viewportHeight\b/.test(appJs) || /viewportStableHeight/.test(appJs), 'stable height, not live viewportHeight');
assert(appCss.includes('margin-bottom: calc(var(--safe-bottom) + 8px)'), 'nav pinned: margin-bottom calc(var(--safe-bottom) + 8px)');
assert(appCss.includes('--tg-viewport-stable-height'), 'nav pinned to --tg-viewport-stable-height');
assert(appJs.includes('disableVerticalSwipes'), 'disableVerticalSwipes() called');
assert(indexHtml.indexOf('telegram-web-app.js') !== -1, 'telegram-web-app.js script present');
assert(indexHtml.indexOf('telegram-web-app.js') < indexHtml.indexOf('<meta'), 'tg script FIRST in <head>');
for (const t of ['home', 'tasks', 'files', 'more']) assert(indexHtml.includes(`data-tab="${t}"`), `tab present: ${t}`);
assert(appCss.includes('max-width: 560px') || indexHtml.includes('560'), 'max-width 560px');
assert(/CloudStorage/.test(appJs) && /localStorage/.test(appJs) && /PERF_CHOICE_KEY/.test(appJs), 'perf_choice: CloudStorage primary + localStorage fallback');
assert(read('web/lib/perf.js').includes("PERF_CHOICE_KEY = 'perf_choice'"), "key literal 'perf_choice' defined once in lib");
assert(httpTs.includes('no-cache') && httpTs.includes('app.js'), 'http.ts: Cache-Control no-cache on app.js');
assert(/content-type.*text\/javascript|'\.js'/.test(httpTs), 'http.ts: content-type by extension');

/* ---------------- shell misc ---------------- */
g('shell misc');
assert((indexHtml.match(/<button[^>]*data-tab/g) ?? []).length === 4, '4 tab buttons');
assert(/Files.*W6|Project explorer lands in W6/.test(appJs), 'Files stub placeholder (W6)');
assert(/renderMore\(|moreViewModel\(\)/.test(appJs), 'More tab real (W7 landed, stub superseded)');
assert(/\.skeleton/.test(tokens), '.skeleton placeholder class present');
assert(/prefers-reduced-motion/.test(appCss), 'prefers-reduced-motion -> instant in app CSS');
assert(/data-perf="lite"/.test(tokens) && /data-perf="reduced"/.test(tokens), 'perf ladder full|reduced|lite in tokens');
assert(/data-flat="1"/.test(tokens), '[data-flat="1"] collapse in tokens');
assert(/@supports not \(animation-timeline/.test(tokens), '@supports animation-timeline fallback present');

process.stdout.write(`\n${String(passed)} passed, ${String(failures.length)} failed\n`);
if (failures.length > 0) {
  process.stdout.write('FAILURES:\n');
  for (const f of failures) process.stdout.write(` - ${f}\n`);
  process.exit(1);
}
