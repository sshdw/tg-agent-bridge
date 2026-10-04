/**
 * W7 More + confirmation card + Skills harness — no browser, no Telegram, no .env.
 * Pure ESM imports of web/lib/draft.js + web/lib/api.js + web/screens/*.js
 * (node >= 22) plus deterministic CSS/HTML/JS greps. telegram-web-app.js is
 * NEVER loaded; transport is a stub fetch.
 * Usage: node work/verify-w7-more.mjs   (run from the repo root)
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

const appJs = read('web/app.js');
const appCss = read('web/app.css');
const tokens = read('web/tokens.css');
const homeSrc = read('web/screens/home.js');
const tasksSrc = read('web/screens/tasks.js');
const moreSrc = read('web/screens/more.js');
const confirmSrc = read('web/screens/confirm.js');
const draftSrc = read('web/lib/draft.js');
const apiSrc = read('web/lib/api.js');
const keyboardSrc = read('src/telegram/keyboard.ts');
const miniApiSrc = read('src/miniapp/api.ts');

const draft = await import('../web/lib/draft.js');
const api = await import('../web/lib/api.js');
const home = await import('../web/screens/home.js');
const tasks = await import('../web/screens/tasks.js');
const more = await import('../web/screens/more.js');
const confirm = await import('../web/screens/confirm.js');
const app = await import('../web/app.js');

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

/* ---------------- A: lib/draft.js pure units ---------------- */
g('A validateDraft + toggles + reasons');
{
  const e = draft.validateDraft({ text: '   ', mode: 'ask' });
  assert(e.ok === false && e.disabled === true && e.reason === 'empty' && e.payload === null, 'empty prompt -> Run disabled (reason empty)');
  const t = draft.validateDraft({ text: 'x'.repeat(8001) });
  assert(t.ok === false && t.disabled === true && t.reason === 'too-long' && t.payload === null, 'over 8000 chars -> disabled (reason too-long)');
  assert(draft.PROMPT_MAX === 8000, 'PROMPT_MAX mirrors api.ts (8000)');
  const v = draft.validateDraft({ text: 'do the thing', mode: 'ask', skills: ['gortex-debug'] });
  assert(v.ok === true && v.disabled === false && v.payload.prompt === 'do the thing' && v.payload.mode === 'ask' && v.payload.skills.join() === 'gortex-debug', 'valid draft -> payload {prompt, mode, skills}');
  const p = draft.validateDraft({ text: 'target', mode: 'ask', preset: 'review' });
  assert(p.preset === 'review' && p.mode === 'code' && p.payload.mode === 'code', 'preset review forces mode code (all presets are /code)');
  assert(draft.validateDraft({ text: 't', preset: 'nope' }).preset === '', 'unknown preset ignored');
  assert(draft.togglePreset('', 'fix') === 'fix' && draft.togglePreset('fix', 'fix') === '' && draft.togglePreset('fix', 'test') === 'test', 'preset chips single-select toggle');
  assert(draft.toggleInList(['a'], 'b').join() === 'a,b' && draft.toggleInList(['a', 'b'], 'a').join() === 'b', 'skill list toggle adds/removes');
  assert(draft.effectiveMode('plan', 'test') === 'code' && draft.effectiveMode('plan', '') === 'plan' && draft.effectiveMode('bogus', '') === 'ask', 'effectiveMode: preset wins, else normalized');
  assert(draft.HEALTH_SIGNALS.join() === 'telegram,agent,github,whisper,db', '5 health signals in order');
  const r = draft.healthReason('whisper', 'missing');
  assert(typeof r === 'string' && r.length > 10 && /whisper/i.test(r), 'whisper missing -> visible reason string');
  assert(/fresh|alive/i.test(draft.healthReason('telegram', 'polling')), 'telegram polling -> alive reason');
  assert(/90|down/i.test(draft.healthReason('telegram', 'stale', 137)), 'telegram stale carries the stale seconds');
  assert(draft.healthReason('nope', 'x') === '', 'unknown signal -> empty reason');
}

/* ---------------- B: lib/api.js W7 contract (mock fetch) ---------------- */
g('B api.js pickers/settings/health/skills/drafts contract');
{
  const seen = [];
  const stub = async (url, opts) => {
    seen.push({ url, method: opts.method, headers: opts.headers, body: opts.body });
    if (String(url).includes('/api/drafts') && opts.method === 'POST' && !/\/\d+\//.test(String(url))) {
      return { status: 200, json: async () => ({ draft: { id: 9 } }) };
    }
    if (/\/api\/drafts\/\d+\/confirm/.test(String(url))) {
      return { status: 200, json: async () => ({ task_id: 43, state: 'started' }) };
    }
    return { status: 200, json: async () => ({ ok: true }) };
  };
  const c = api.createApiClient({ getInitData: () => 'INITDATA', fetchImpl: stub });
  await c.pickersAgents();
  await c.pickersModels();
  await c.pickersProjects();
  await c.settings();
  await c.updateSettings({ agent: 'mock' });
  await c.health();
  await c.skills();
  await c.updateSkills(['gortex-debug'], true);
  const d = await c.postDraft('prompt text', 'code', ['gortex-debug']);
  const cf = await c.confirmDraft(9);
  await c.discardDraft(9);
  const by = (frag) => seen.find((s) => s.url.includes(frag));
  assert(by('/api/pickers/agents').method === 'GET', 'agents hits GET /api/pickers/agents');
  assert(by('/api/pickers/models').method === 'GET', 'models hits GET /api/pickers/models');
  assert(by('/api/pickers/projects').method === 'GET', 'projects hits GET /api/pickers/projects');
  assert(by('/api/settings').method === 'GET', 'settings GET present');
  const put = seen.find((s) => s.url.includes('/api/settings') && s.method === 'PUT');
  assert(put && JSON.parse(put.body).agent === 'mock' && put.headers['content-type'] === 'application/json', 'PUT /api/settings carries the patch as JSON');
  assert(by('/api/health').method === 'GET', 'health hits GET /api/health');
  assert(by('/api/skills').method === 'GET', 'skills GET present');
  const sput = seen.find((s) => s.url.includes('/api/skills') && s.method === 'PUT');
  const sp = sput && JSON.parse(sput.body);
  assert(sp && sp.pins.join() === 'gortex-debug' && sp.auto === true, 'PUT /api/skills carries {pins, auto}');
  const post = by('/api/drafts');
  const pp = post && JSON.parse(post.body);
  assert(post.method === 'POST' && pp.prompt === 'prompt text' && pp.mode === 'code' && pp.skills.join() === 'gortex-debug', 'POST /api/drafts carries {prompt, mode, skills}');
  assert(d.body.draft.id === 9, 'draft round-trip returns draft id');
  assert(cf.body.task_id === 43 && cf.body.state === 'started', 'Run = confirm -> task_id + state');
  assert(seen.every((s) => s.headers['X-Telegram-Init-Data'] === 'INITDATA'), 'initData header on all W7 endpoints');
}

/* ---------------- C: confirm card render ---------------- */
g('C renderConfirm');
{
  const v = confirm.renderConfirm({ text: 'hello', agent: 'opencode', model: 'm', project: 'p', pinned: ['gortex-debug'], skills: ['gortex-debug'] });
  assert(v.html.includes('glass-elevated') && v.html.includes('role="dialog"'), 'sheet uses .glass-elevated dialog');
  assert(v.html.includes('hello') && v.html.includes('opencode') && v.html.includes('gortex-debug'), 'card shows prompt + agent + skills');
  assert(v.html.includes('data-action="draft-run"') && v.html.includes('data-action="draft-edit"'), 'Run + Edit actions present');
  assert(v.html.includes('data-confirm-input'), 'textarea carries data-confirm-input');
  assert(v.float === '', 'confirm: no floating bar');
  const empty = confirm.renderConfirm({ text: '  ' });
  assert(/data-action="draft-run"[^>]*disabled/.test(empty.html), 'empty prompt -> Run disabled');
  const evil = confirm.renderConfirm({ text: '<script>alert(1)</script>' });
  assert(!evil.html.includes('<script>') && evil.html.includes('&lt;script&gt;'), 'prompt text is escaped (Edit preserves it safely)');
  const busy = confirm.renderConfirm({ text: 'x', busy: true });
  assert(/draft-run"[^>]*disabled/.test(busy.html) && busy.html.includes('Running'), 'busy -> Run disabled + Running label');
  const pr = confirm.renderConfirm({ text: 't', preset: 'review' });
  assert(pr.html.includes('data-preset="review"') && pr.html.includes('data-preset="test"') && pr.html.includes('data-preset="fix"'), 'Review/Test/Fix chips = names only');
}

/* ---------------- D: More render ---------------- */
g('D renderMore');
{
  const loading = more.renderMore({});
  assert(loading.html.includes('more-session') && loading.html.includes('Loading'), 'null data -> loading placeholders, no crash');
  const full = more.renderMore({
    settings: { agent: 'opencode', model: '', project: 'tg', auto_approve: false, allowed_roots: ['D:/w'] },
    pickers: {
      agent: [{ value: 'opencode', label: 'opencode' }, { value: 'mock', label: 'mock' }],
      model: [{ value: 'm1', label: 'M1' }],
      project: [{ value: 'D:/w/tg', label: 'tg' }],
      modelsCached: true,
    },
    health: { telegram: 'polling', agent: 'opencode:/bin/opencode', github: 'absent', whisper: 'missing', db: 'wal', pending: 1, stale_s: 12 },
    skills: [{ name: 'gortex-debug', description: 'debug helper', source: 'project', pinned: true }],
    skillsAuto: true,
    perf: 'auto',
    openPicker: 'agent',
    healthOpen: 'whisper',
  });
  assert(full.html.includes('opencode') && full.html.includes('data-action="setting-pick"'), 'session picker options render from API data');
  assert(full.html.includes('cached'), 'stale model pickers show the cached badge');
  for (const s of ['telegram', 'agent', 'github', 'whisper', 'db']) {
    assert(full.html.includes(`data-signal="${s}"`), `bridge status shows signal ${s}`);
  }
  assert(/Whisper binary or voice model is missing/i.test(full.html), 'whisper missing -> reason visible on tap');
  assert(full.html.includes('Pending') && full.html.includes('Heartbeat stale'), 'pending + stale_s rows present');
  assert((full.html.match(/data-action="perf"/g) ?? []).length === 3, 'Performance: exactly Auto|Full|Lite');
  assert(full.html.includes('data-action="reset-session"') && full.html.includes('btn-danger'), 'Reset session present, reuses .btn-danger');
  assert(full.html.includes('gortex-debug') && full.html.includes('debug helper') && full.html.includes('project'), 'skills list: name + description + source');
  assert(full.html.includes('data-action="skills-pin"') && full.html.includes('data-action="skills-auto"'), 'pin-toggle + auto-toggle present');
  assert(full.html.includes('data-action="gh-open"') && full.html.includes('https://github.com'), 'github minimal: browser link via openLink');
  assert(full.float === '', 'more: no floating bar');
  assert(!/fetch\(|setInterval|setTimeout/.test(moreSrc), 'more.js never fetches or polls on its own');
}

/* ---------------- E: home entry + task details skills ---------------- */
g('E home wiring + details skills_used');
{
  const idle = home.renderHome({ running: null, recent: [] });
  assert(idle.html.includes('data-action="new-task"') && idle.html.includes('btn-primary'), 'idle Home has a New task entry (primary)');
  const det = tasks.renderTaskDetails({ id: 7, title: 't', status: 'done', cost_usd: 0.01, elapsed_s: 5, skills_used: ['gortex-debug'], files_summary: { changed_n: 1, added: 2, removed: 0 } });
  assert(det.html.includes('data-testid="skills-used"') && det.html.includes('gortex-debug'), 'task details shows skills_used[]');
  assert(homeSrc.includes('new-task') && !/review|preset/i.test(homeSrc), 'home.js change is the entry point only (no preset logic there)');
}

/* ---------------- F: repo-wide grep inventory ---------------- */
g('F design + contract inventory');
{
  const cssAll = [appCss, tokens, homeSrc, tasksSrc, moreSrc, confirmSrc, draftSrc, appJs].join('\n');
  assert(count(cssAll, /var\(--accent-(?:action|text)\)/g) === 5, `accent uses exactly 5 across web/ (found ${count(cssAll, /var\(--accent-(?:action|text)\)/g)})`);
  assert(!/var\(--accent-(?:action|text)\)/.test(appCss), 'no new accent place in app.css');
  assert(!/var\(--accent-(?:action|text)\)|var\(--danger\)/.test(`${moreSrc}\n${confirmSrc}`), 'no accent/danger vars in new screens');
  const bodies = ['ordered by severity', 'Do NOT modify files', 'keep the diff minimal', 'Diagnose the root cause', 'the whole project in the working directory', 'run the existing test suite', 'smallest reasonable diff', 'files to touch'];
  assert(bodies.every((b) => !cssAll.includes(b)), 'zero preset body text in web/ (names only)');
  const scopeBlock = (keyboardSrc.match(/SCOPE = \{[\s\S]*?\} as const/) ?? [''])[0];
  const keys = (scopeBlock.match(/\n  [a-z]+: '/g) ?? []).length;
  assert(keys === 6 && ['approve', 'agent', 'model', 'project', 'plan', 'update'].every((k) => scopeBlock.includes(`${k}: '`)), 'keyboard.ts SCOPE unchanged (6 scopes, no new)');
  assert(!/\/api\/cost|\/api\/history/.test(miniApiSrc), 'no /api/cost or /api/history in miniapp/api.ts (owner-removed, not re-added)');
  assert(!/\/api\/cost|\/api\/history/.test(`${apiSrc}\n${appJs}\n${moreSrc}`), 'no cost/history widget against removed endpoints');
  assert(!/ServerSentEvent|EventSource|new WebSocket|WebSocket/.test(`${moreSrc}\n${confirmSrc}\n${draftSrc}`), 'no SSE/WebSocket in W7 frontend path');
  assert(!/backdrop-filter/.test(`${moreSrc}\n${confirmSrc}`), 'no backdrop-filter in new screens (sheet class comes from tokens.css)');
  const w7css = appCss.slice(appCss.indexOf('W7 More'));
  assert(w7css.length > 500 && !/backdrop-filter/.test(w7css.replace(/\/\*[\s\S]*?\*\//g, '')), 'no backdrop-filter in W7 CSS');
  assert(!/transition[^;]*(width|height|\btop\b|filter)/.test(w7css.replace(/\/\*[\s\S]*?\*\//g, '')), 'no width/height/top/filter in W7 transitions');
  assert(!/localStorage|CloudStorage/.test(`${moreSrc}\n${confirmSrc}\n${draftSrc}`), 'draft text never touches storage (single-open is server-side)');
  assert(count(tokens, /--spring-sheet/g) >= 2 && /--ease-in:/.test(tokens), 'motion tokens define --spring-sheet + --ease-in');
  assert(/sheet-in 300ms var\(--spring-sheet\)/.test(w7css) && /sheet-out 300ms var\(--ease-in\)/.test(w7css), 'sheet present 300ms spring-sheet, dismiss ease-in');
  assert(/location\.reload/.test(appJs) === false, 'perf switch never reloads');
  assert(/\.dataset\.perf = /.test(appJs), 'perf switch flips dataset.perf synchronously');
}

/* ---------------- G: perf choice node behaviour ---------------- */
g('G perf persistence (node-safe subset)');
{
  assert(typeof app.loadPerfChoice === 'function' && typeof app.savePerfChoice === 'function' && typeof app.applyPerfChoice === 'function', 'perf helpers exported from app.js');
  assert(app.loadPerfChoice() === 'auto', 'no stored choice -> default Auto');
  let threw = false;
  try {
    app.savePerfChoice('full');
    app.applyPerfChoice('full');
    app.applyPerfChoice('auto');
  } catch {
    threw = true;
  }
  assert(!threw, 'save/apply perf choice are node-safe (guarded storage/DOM)');
  const { autoPerf } = await import('../web/lib/perf.js');
  assert((await autoPerf({ reducedMotion: true })) === 'lite', 'reduced-motion forces lite');
  assert((await autoPerf({ measure: false, deviceMemory: 8, hardwareConcurrency: 8, devicePixelRatio: 1 })) === 'full', 'strong device -> full');
}

/* ---------------- H: app.js route inventory ---------------- */
g('H app routes + reset mechanism');
{
  assert(/renderMore\(/.test(appJs) && /void loadMore\(\)/.test(appJs), 'More route paints then loads once per visit');
  assert(/openConfirm\(\)/.test(appJs) && /new-task/.test(appJs), 'New task entry opens the confirm card');
  assert(/readConfirmText\(\)/.test(appJs) && /composerText/.test(appJs), 'Edit/Back preserves text via the composer buffer');
  assert(/postDraft\(/.test(appJs) && /confirmDraft\(/.test(appJs), 'Run = POST draft then confirm -> task_id');
  assert(/validateDraft\(/.test(appJs), 'Run passes through the pure validateDraft gate');
  assert(/showConfirmDialog\('Reset session/.test(appJs), 'Reset asks showConfirm first');
  assert(/updateSettings\(\{ agent: other \}\)/.test(appJs) && /updateSettings\(\{ agent: cur \}\)/.test(appJs), 'Reset = agent round-trip (both flips drop the provider session)');
  assert(/api\.ts:786/.test(appJs) || /drop agent_session_id server-side/.test(appJs), 'reset documents the server-side drop mechanism');
  assert(/onEvent\?*\.\('backButtonClicked'/.test(appJs) && /needBack\(\)/.test(appJs), 'sheet participates in BackButton depth');
  assert(/openLink\(/.test(appJs) && /tg\?\.openLink/.test(appJs), 'github links go through openLink');
  assert(/expires any older/.test(appJs), 'draft single-open semantics noted at the POST site');
}

process.stdout.write(`\n${String(passed)} passed, ${String(failures.length)} failed\n`);
if (failures.length > 0) {
  process.stdout.write('FAILURES:\n');
  for (const f of failures) process.stdout.write(` - ${f}\n`);
  process.exit(1);
}
