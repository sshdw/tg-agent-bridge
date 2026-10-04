/**
 * W8 Cut + wiring + docs harness — offline, no Telegram, no .env.
 * - Grep-audit of the cut list (files gone, identifiers zero, SCOPE exact,
 *   /help <= 7, deps == 2, markdown frozen, ci_watch stays, voice stays).
 * - F1 preset channel: drafts/tasks POST with a preset NAME runs the task
 *   with the server role prefix applied (mock provider captures the prompt).
 * - Regression: runs verify-w1..w7 + verify-render + verify-tables as child
 *   processes and prints a PASS/FAIL table. verify-dot is NOT run here
 *   (SKIP-environmental: it reads .env, which agents must never touch).
 * Usage: node work/verify-w8-cut.mjs   (run from the repo root)
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const srcFiles = [];
{
  const walk = (dir) => {
    for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(rel);
      else if (e.name.endsWith('.ts')) srcFiles.push(rel);
    }
  };
  walk('src');
}
const srcAll = srcFiles.map((f) => ({ f, t: read(f) }));

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
const hits = (re) => srcAll.filter(({ t }) => re.test(t)).map(({ f }) => f);

/* ---------------- A: cut files gone ---------------- */
g('A deleted files');
{
  for (const f of [
    'src/providers/cursor.ts',
    'src/providers/cline.ts',
    'src/providers/hermes.ts',
    'src/gateway/fetchRunner.ts',
    'src/core/exec.ts',
    'src/core/update.ts',
    'scripts/updater.cmd',
  ]) {
    assert(!existsSync(join(ROOT, f)), `${f} deleted`);
  }
  let githubGone = false;
  try {
    githubGone = readdirSync(join(ROOT, 'src/github')).length === 0;
  } catch {
    githubGone = true;
  }
  assert(githubGone, 'src/github/ deleted');
}

/* ---------------- B: identifier sweep in src/ ---------------- */
g('B grep-zero cut identifiers in src/');
{
  assert(hits(/CursorProvider|ClineProvider|HermesProvider/).length === 0, 'no provider classes (cursor/cline/hermes)');
  assert(hits(/fetchRunner/).length === 0, 'no fetchRunner');
  assert(hits(/ciPoller|startCiPoller/).length === 0, 'no ciPoller/startCiPoller');
  assert(hits(/updateConfirmKeyboard|parseUpdatePayload|SCOPE\.update|runUpdateConfirm/).length === 0, 'no update keyboard/scope/handler');
  assert(hits(/handleCi|handleCommit|handlePr|handleWatch|GitHubClient/).length === 0, 'no github handlers/client');
  assert(hits(/from '\.\.\/github\/|from '\.\/github\//).length === 0, 'no imports of src/github/');
  assert(hits(/runExec/).length === 0, 'no runExec (/exec gone)');
  assert(hits(/agentPickerKeyboard|modelCandidatesKeyboard|projectPickerKeyboard|[^e]modelKeyboard/).length === 0, 'no picker keyboards');
  assert(hits(/showAgentPicker|showModelPicker|showProjectPicker/).length === 0, 'no picker entry points');
  const cmds = hits(/bot\.command\('(?:clone|exec|sys|get|files|find|auto|status|cost|update|commit|pr|ci|watch)'/);
  assert(cmds.length === 0, `removed chat commands never registered (${cmds.join(',') || 'none'})`);
  const router = read('src/core/router.ts');
  assert(router.includes('REMOVED_COMMANDS') && router.includes('REMOVED_REPLY'), 'removed commands answer via REMOVED_COMMANDS stub');
}

/* ---------------- C: SCOPE + /help + config ---------------- */
g('C SCOPE, /help, AGENT_IDS');
{
  const kb = read('src/telegram/keyboard.ts');
  const block = (kb.match(/SCOPE = \{[\s\S]*?\} as const/) ?? [''])[0];
  const keys = (block.match(/\n  [a-z]+: '/g) ?? []).map((s) => s.trim().replace(/[: ']/g, ''));
  assert(keys.length === 2 && keys.includes('approve') && keys.includes('plan'), `SCOPE exactly approve+plan (found ${keys.join(',')})`);
  const router = read('src/core/router.ts');
  const hm = router.match(/bot\.command\('help'[\s\S]*?`([\s\S]*?)`,/);
  const lines = hm ? hm[1].split(/\\n|\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith('/')) : [];
  assert(hm !== null && lines.length <= 7, `/help lists <= 7 commands (found ${lines.length})`);
  assert(lines.some((l) => l.startsWith('/ask')) && lines.some((l) => l.startsWith('/help')), '/help covers /ask + /help');
  for (const c of ['/ask', '/code', '/approve', '/cancel', '/new', '/start', '/help']) {
    assert(lines.some((l) => l.startsWith(c + ' ') || l.startsWith(c + '—') || l === c || l.startsWith(c)), `/help lists ${c}`);
  }
  const cfg = read('src/config.ts');
  assert(cfg.includes("['opencode', 'mock']"), "AGENT_IDS is exactly ['opencode','mock']");
  assert(/bot\.command\('agent'/.test(router) && /bot\.command\('model'/.test(router) && /bot\.command\('project'/.test(router), '/agent /model /project text aliases kept (pickers in Mini App)');
}

/* ---------------- D: frozen + kept substrate ---------------- */
g('D frozen markdown, kept substrate, deps');
{
  const md = read('src/telegram/markdown.ts');
  assert(md.includes('FROZEN') && md.includes('PLAN-V05 W8'), 'markdown.ts carries the W8 FROZEN comment');
  assert(/export function markdownToHtml/.test(md), 'markdown.ts contents intact (markdownToHtml present)');
  const db = read('src/storage/db.ts');
  assert(db.includes('ci_watch'), 'ci_watch table stays (forward-only migrations)');
  assert(routerHasVoice(), 'voice-in-chat untouched (message:voice + transcribeVoice)');
  const pkg = JSON.parse(read('package.json'));
  assert(JSON.stringify(Object.keys(pkg.dependencies).sort()) === '["better-sqlite3","grammy"]', 'dependencies are exactly better-sqlite3 + grammy');
  const index = read('src/index.ts');
  assert(!/CursorProvider|ClineProvider|HermesProvider|startCiPoller/.test(index), 'index.ts has no cut registrations');
  assert(/register\(new OpenCodeProvider/.test(index) && /register\(new MockProvider/.test(index), 'index.ts registers opencode + mock');
  function routerHasVoice() {
    const r = read('src/core/router.ts');
    return r.includes('message:voice') && r.includes('transcribeVoice');
  }
}

/* ---------------- E: F1 preset channel (live mock run) ---------------- */
g('E preset channel: name in, role prefix applied');
{
  const { Store } = await import('../dist/storage/db.js');
  const { TaskQueue } = await import('../dist/core/queue.js');
  const { register } = await import('../dist/gateway/registry.js');
  const { dispatchApi } = await import('../dist/miniapp/api.js');
  const presets = await import('../dist/core/presets.js');
  const tmp = mkdtempSync(join(tmpdir(), 'w8-'));
  const workRoot = join(tmp, 'work');
  mkdirSync(workRoot, { recursive: true });
  const CHAT = 424242;
  const cfg = {
    botToken: 'test-token',
    allowedChatIds: [CHAT],
    defaultAgent: 'mock',
    defaultModel: '',
    taskTimeoutMs: 60000,
    workRoot,
    allowedRoots: [workRoot],
    autoApprove: false,
    historyLimit: 50,
    opencodeBin: 'opencode',
    cursorBin: '',
    clineBin: '',
    hermesBaseUrl: '',
    hermesApiKey: '',
    githubToken: '',
    whisperBin: '',
    voiceModelPath: '',
    voiceLang: 'ru',
    ffmpegBin: '',
    ciPollMs: 300000,
    dbPath: join(tmp, 'bridge.db'),
    miniPort: 0,
    miniUrl: '',
  };
  const store = new Store(cfg.dbPath);
  const seenPrompts = [];
  class InstantMock {
    id = 'mock';
    async run(task, onEvent) {
      seenPrompts.push(task.prompt);
      onEvent({ type: 'text', delta: 'ok\n' });
      return { text: 'ok', exitCode: 0, sessionId: '', costUsd: null };
    }
    async cancel() {}
  }
  try {
    register(new InstantMock());
  } catch {
    /* registry already has a mock in this process */
  }
  const io = {
    async streamStart() {
      return { push() {}, async finish() {}, async fail() {} };
    },
    async askApproval() {
      return true;
    },
    async notify() {},
  };
  const queue = new TaskQueue(store, cfg, io);
  const env = { cfg, store, queue, startTimeMs: Date.now(), heartbeatPath: join(tmp, 'hb') };
  const q = new URLSearchParams();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // drafts path: name in body, prefixed task out
  const d = await dispatchApi(env, CHAT, 'POST', '/api/drafts', q, { prompt: 'target text', mode: 'ask', skills: [], preset: 'review' });
  assert(d.status === 200 && d.body.draft && d.body.draft.id > 0, 'POST /api/drafts accepts preset name');
  const draftRow = store.getDraft(d.body.draft.id);
  assert(!!draftRow && draftRow.prompt.startsWith(presets.PRESET_PREFIXES.review), 'stored draft prompt carries the server role prefix');
  const c = await dispatchApi(env, CHAT, 'POST', `/api/drafts/${d.body.draft.id}/confirm`, q, {});
  assert(c.status === 200 && c.body.task_id > 0, 'confirm runs the draft');
  await sleep(300);
  assert(seenPrompts.length >= 1 && seenPrompts[0].startsWith(presets.PRESET_PREFIXES.review), 'confirmed task prompt starts with server preset text (review)');
  assert(seenPrompts[0].includes('target text'), 'confirmed task keeps the owner text after the prefix');
  // direct tasks path
  seenPrompts.length = 0;
  const t = await dispatchApi(env, CHAT, 'POST', '/api/tasks', q, { prompt: 'broken thing', mode: 'code', skills: [], preset: 'fix' });
  assert(t.status === 200 && t.body.task_id > 0, 'POST /api/tasks accepts preset name');
  await sleep(300);
  assert(seenPrompts.length >= 1 && seenPrompts[0].startsWith(presets.PRESET_PREFIXES.fix), 'direct task prompt starts with server preset text (fix)');
  // unknown preset refused, no-preset verbatim
  const bad = await dispatchApi(env, CHAT, 'POST', '/api/drafts', q, { prompt: 'x', preset: 'nope' });
  assert(bad.status === 400, 'unknown preset name -> 400 E_BAD_ARG');
  seenPrompts.length = 0;
  const plain = await dispatchApi(env, CHAT, 'POST', '/api/tasks', q, { prompt: 'plain ask', skills: [] });
  assert(plain.status === 200, 'no preset still works');
  await sleep(300);
  assert(seenPrompts.length >= 1 && seenPrompts[0] === 'plain ask', 'no preset -> prompt verbatim, no prefix');
  // client sends names only
  const apiJs = read('web/lib/api.js');
  const draftJs = read('web/lib/draft.js');
  assert(/preset/.test(apiJs) && !/Code review\. Inspect/.test(apiJs), 'client postDraft sends the preset NAME, never body text');
  assert(draftJs.includes('preset: p') || draftJs.includes('{ preset }') || draftJs.includes('{ preset: p }') || /preset: p/.test(draftJs), 'validateDraft payload carries the preset name');
  store.close();
  rmSync(tmp, { recursive: true, force: true });
}

/* ---------------- F: README sections ---------------- */
g('F README sections');
{
  const rm = read('README.md');
  assert(rm.includes('Mini App'), 'README: what the Mini App is');
  for (const t of ['Home', 'Tasks', 'Files', 'More']) assert(rm.includes(t), `README: ${t} tab`);
  assert(rm.includes('MINIAPP_PORT') && rm.includes('MINIAPP_URL'), 'README: env table with MINIAPP_PORT + MINIAPP_URL');
  assert(/skip/i.test(rm) && rm.includes('no MINIAPP_URL'), 'README: skip rule when MINIAPP_URL is empty');
  assert(rm.includes('Funnel') && rm.includes('quick') && rm.includes('Prod'), 'README: Funnel primary / quick fallback / prod endpoint');
  assert(/код.*не знает|knows nothing|deployment concern/i.test(rm), 'README: code has zero knowledge of the tunnel');
  assert(rm.includes('schtasks'), 'README: Windows autostart via schtasks');
  assert(rm.includes('run-bridge.cmd') && rm.includes('Один процесс'), 'README: autostart notes the single process (no extra Mini App steps)');
  assert(/whisper|Голос/i.test(rm), 'README: voice-in-chat stays');
  assert(/Performance|Auto.*Full.*Lite/.test(rm), 'README: perf modes Auto|Full|Lite');
  assert(rm.includes('telegram-liquid-glass'), 'README: skill link as design source');
  assert(rm.includes('```') && rm.includes('node:http'), 'README: ASCII architecture with the HTTP layer');
}

/* ---------------- G: full regression table ---------------- */
g('G regression: w1..w7 + render + tables (dot SKIP-environmental)');
const table = [];
{
  const subs = [
    ['w1-http', 'work/verify-w1-http.mjs'],
    ['w2-durable', 'work/verify-w2-durable.mjs'],
    ['w3-diff', 'work/verify-w3-diff.mjs'],
    ['w4-api', 'work/verify-w4-api.mjs'],
    ['w5-shell', 'work/verify-w5-shell.mjs'],
    ['w6-files', 'work/verify-w6-files.mjs'],
    ['w7-more', 'work/verify-w7-more.mjs'],
    ['render', 'work/verify-render.mjs'],
    ['tables', 'work/verify-tables.mjs'],
  ];
  for (const [name, rel] of subs) {
    let cell = 'FAIL';
    let counts = '';
    try {
      const out = execFileSync('node', [join(ROOT, rel)], { encoding: 'utf8', cwd: ROOT, timeout: 240000, windowsHide: true });
      const m = out.match(/(\d+) passed, (\d+) failed/);
      counts = m ? `${m[1]} passed/${m[2]} failed` : 'exit 0';
      cell = 'PASS';
    } catch (e) {
      const out = String((e.stdout ?? '') + (e.stderr ?? ''));
      const m = out.match(/(\d+) passed, (\d+) failed/);
      counts = m ? `${m[1]} passed/${m[2]} failed` : `exit ${e.status ?? '?'}`;
      const tail = out.trim().split('\n').slice(-4).join(' | ').slice(0, 300);
      if (tail !== '') counts += ` :: ${tail}`;
    }
    table.push([name, cell, counts]);
    assert(cell === 'PASS', `regression ${name}: ${counts}`);
  }
  table.push(['dot', 'SKIP', 'reads .env (agents must never touch it)']);
  process.stdout.write('\n  harness  | result | counts\n');
  process.stdout.write('  ---------|--------|-------\n');
  for (const [n, c, k] of table) process.stdout.write(`  ${n} | ${c} | ${k}\n`);
}

process.stdout.write(`\n${String(passed)} passed, ${String(failures.length)} failed\n`);
if (failures.length > 0) {
  process.stdout.write('FAILURES:\n');
  for (const f of failures) process.stdout.write(` - ${f}\n`);
  process.exit(1);
}
