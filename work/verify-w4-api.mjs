/**
 * W4 offline harness — real HTTP through node:http against an in-process server
 * on an ephemeral port (transport is under test, not just handlers).
 * No network, no Telegram token, no .env: BOT_TOKEN='test', temp file-based
 * better-sqlite3, a gate-controlled fake provider, a fake Responder.
 * Usage: node work/verify-w4-api.mjs   (run from the repo root)
 *
 * Proves AC1–AC10 of PLAN-V05 §W4 plus the W3-review constraint
 * (no `plan_diff_before` leak, explicit columns only).
 */
import { createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { createMiniServer } = await import('../dist/miniapp/http.js');
const { Store } = await import('../dist/storage/db.js');
const { TaskQueue } = await import('../dist/core/queue.js');
const { register } = await import('../dist/gateway/registry.js');

const TOKEN = 'test';
const CHAT = 111;
const FOREIGN = 999;

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- HMAC vectors (same construction as verify-w1-http.mjs) ---------------- */
function signEntries(entries) {
  const sorted = [...entries].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const dcs = sorted.map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(TOKEN).digest();
  return createHmac('sha256', secret).update(dcs).digest('hex');
}
function sign(params) {
  return signEntries(Object.entries(params).filter(([k]) => k !== 'hash'));
}
function initData({ userId, authDate, hashOverride } = {}) {
  const at = authDate ?? Math.floor(Date.now() / 1000);
  const p = {
    auth_date: String(at),
    query_id: 'AAH-test-query',
    user: JSON.stringify({ id: userId ?? CHAT, first_name: 'T' }),
  };
  const h = hashOverride ?? sign(p);
  return new URLSearchParams({ ...p, hash: h }).toString();
}
const V = () => initData({ userId: CHAT });
const STALE_S = 90000;

/* ---------------- offline world: temp dirs, store, gated provider ---------------- */
const tmp = mkdtempSync(join(tmpdir(), 'w4-'));
const dbPath = join(tmp, 'bridge.db');
const workRoot = join(tmp, 'work');
mkdirSync(workRoot, { recursive: true });
const heartbeatPath = join(tmp, 'heartbeat');
writeFileSync(heartbeatPath, `${Date.now()}\n`);

const cfg = {
  botToken: TOKEN,
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
  dbPath,
  miniPort: 0,
  miniUrl: '',
};

const store = new Store(dbPath);
const seenPrompts = [];
const gates = new Map();
const cancelled = new Set();
class GateProvider {
  id = 'mock';
  async run(task, onEvent) {
    await new Promise((res) => gates.set(task.sessionId, { task, res }));
    seenPrompts.push(task.prompt);
    onEvent({ type: 'text', delta: 'gate-output\n' });
    if (cancelled.has(task.sessionId)) {
      cancelled.delete(task.sessionId);
      throw new Error('E_CANCELLED');
    }
    return { text: 'gate-output', exitCode: 0, sessionId: '', costUsd: 0.5 };
  }
  async cancel(sessionId) {
    cancelled.add(sessionId);
    const gt = gates.get(sessionId);
    if (gt) {
      gates.delete(sessionId);
      gt.res();
    }
  }
}
class InstantProvider {
  id = 'opencode';
  async run(task, onEvent) {
    seenPrompts.push(task.prompt);
    onEvent({ type: 'text', delta: 'instant\n' });
    return { text: 'instant', exitCode: 0, sessionId: '', costUsd: null };
  }
  async cancel() {}
}
register(new GateProvider());
register(new InstantProvider());

const io = {
  async streamStart() {
    return { push() {}, async finish() {}, async fail() {} };
  },
  async askApproval() {
    return false;
  },
  async notify() {},
};
const queue = new TaskQueue(store, cfg, io);

const logs = [];
const server = createMiniServer({
  botToken: TOKEN,
  allowedChatIds: [CHAT],
  webDir: join(tmp, 'web'),
  log: (l) => logs.push(l),
  api: { cfg, store, queue, startTimeMs: Date.now() - 5000, heartbeatPath },
});
const { port } = await server.listen(0);
const base = `http://127.0.0.1:${port}`;

function headersFor(auth) {
  if (auth === 'none') return {};
  if (auth === 'bad') return { 'X-Telegram-Init-Data': initData({ userId: CHAT, hashOverride: '0'.repeat(64) }) };
  if (auth === 'foreign') return { 'X-Telegram-Init-Data': initData({ userId: FOREIGN }) };
  if (auth === 'stale')
    return { 'X-Telegram-Init-Data': initData({ userId: CHAT, authDate: Math.floor(Date.now() / 1000) - STALE_S }) };
  return { 'X-Telegram-Init-Data': V() };
}
async function api(method, path, { auth = 'valid', body, rawBody } = {}) {
  const headers = headersFor(auth);
  const opts = { method, headers };
  if (rawBody !== undefined) {
    headers['content-type'] = 'application/json';
    opts.body = rawBody;
  } else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(base + path, opts);
  const buf = Buffer.from(await res.arrayBuffer());
  let json = null;
  try {
    json = JSON.parse(buf.toString('utf8'));
  } catch {
    json = null;
  }
  return { status: res.status, json, buf, headers: res.headers };
}
const jget = (path, auth) => api('GET', path, { auth });
const jpost = (path, body, auth) => api('POST', path, { auth, body });

g('setup: ephemeral listener');
assert(Number.isInteger(port) && port > 0, `listen(0) returned a real port (${port})`);

/* ---------------- AC1: auth matrix on EVERY read endpoint ---------------- */
const READS = [
  '/api/health',
  '/api/tasks/current',
  '/api/tasks/recent',
  '/api/tasks/1',
  '/api/tasks/1/files',
  '/api/tasks/1/diff?path=x.ts',
  '/api/plan/current',
  '/api/approvals/pending',
  '/api/files?dir=.',
  '/api/files/preview?path=t.txt',
  '/api/files/download?path=t.txt',
  '/api/files/diff?path=t.txt',
  '/api/pickers/agents',
  '/api/pickers/models',
  '/api/pickers/projects',
  '/api/settings',
  '/api/skills',
];
g(`AC1: auth matrix on ${READS.length} read endpoints x {none,bad,foreign,stale}`);
for (const p of READS) {
  const no = await jget(p, 'none');
  assert(no.status === 401 && no.json?.error === 'E_AUTH', `${p} without header -> 401 E_AUTH`);
  const bad = await jget(p, 'bad');
  assert(bad.status === 401 && bad.json?.error === 'E_AUTH', `${p} forged hash -> 401 E_AUTH`);
  const alien = await jget(p, 'foreign');
  assert(alien.status === 403 && alien.json?.error === 'E_FORBIDDEN', `${p} foreign user.id -> 403 E_FORBIDDEN`);
  const stale = await jget(p, 'stale');
  assert(stale.status === 400 && stale.json?.error === 'E_STALE', `${p} stale auth_date -> 400 E_STALE`);
}

/* ---------------- valid-auth shapes ---------------- */
g('shapes: valid auth on key reads');
{
  const h = await jget('/api/health');
  assert(h.status === 200, 'GET /api/health -> 200');
  assert(h.json?.ok === true && typeof h.json?.version === 'string' && typeof h.json?.sha === 'string', 'health carries ok/version/sha');
  assert(h.json?.telegram === 'polling' && typeof h.json?.agent === 'string', 'health carries telegram+agent');
  assert(h.json?.github === 'absent' && h.json?.whisper === 'missing', 'health: no tokens/bins offline (absent/missing)');
  assert(h.json?.db === 'wal' && typeof h.json?.pending === 'number', 'health carries db+pending');
  assert(typeof h.json?.uptime_s === 'number' && typeof h.json?.stale_s === 'number', 'health carries uptime_s+stale_s numbers');

  const c = await jget('/api/tasks/current');
  assert(c.status === 200, 'GET /api/tasks/current -> 200');
  assert(c.json?.running === null && c.json?.pending_n === 0, 'current idle: running null, pending_n 0');
  assert(c.json?.plan === null && c.json?.approval === null, 'current idle: plan+approval null');

  const r = await jget('/api/tasks/recent?limit=5');
  assert(r.status === 200 && Array.isArray(r.json?.tasks) && r.json?.has_more === false, 'recent empty: tasks [] + has_more false');
  const badLimit = await jget('/api/tasks/recent?limit=999');
  assert(badLimit.status === 400 && badLimit.json?.error === 'E_BAD_ARG', 'recent?limit=999 -> 400 E_BAD_ARG');
  const badOff = await jget('/api/tasks/recent?offset=-1');
  assert(badOff.status === 400 && badOff.json?.error === 'E_BAD_ARG', 'recent?offset=-1 -> 400 E_BAD_ARG');

  const pa = await jget('/api/pickers/agents');
  assert(pa.status === 200 && pa.json?.current === 'mock', 'pickers/agents current=mock');
  assert(Array.isArray(pa.json?.agents) && pa.json.agents.includes('mock') && pa.json.agents.includes('opencode'), 'pickers/agents lists mock+opencode');
  const pm = await jget('/api/pickers/models');
  assert(pm.status === 200 && Array.isArray(pm.json?.models) && typeof pm.json?.cached === 'boolean', 'pickers/models shape (offline: empty list, no throw)');
  const pp = await jget('/api/pickers/projects');
  assert(pp.status === 200 && Array.isArray(pp.json?.projects) && pp.json?.current === '', 'pickers/projects shape, current sandbox');
  const st = await jget('/api/settings');
  assert(st.status === 200 && st.json?.agent === 'mock' && st.json?.auto_approve === false, 'settings shape (agent mock, auto_approve false)');
  assert(Array.isArray(st.json?.allowed_roots) && st.json.allowed_roots.length === 1, 'settings allowed_roots read-only');
  const sk = await jget('/api/skills');
  assert(sk.status === 200 && Array.isArray(sk.json?.skills) && sk.json?.auto === false, 'skills shape (empty, auto false)');
  const pl = await jget('/api/plan/current');
  assert(pl.status === 200 && pl.json?.plan === null, 'plan/current idle: {plan:null}');
  const ap = await jget('/api/approvals/pending');
  assert(ap.status === 200 && ap.json?.approval === null, 'approvals/pending idle: {approval:null}');
}

/* ---------------- AC2: drafts -> confirm; discard -> re-confirm ---------------- */
g('AC2: POST /api/drafts -> confirm -> visible task; discard -> 410');
let draftTaskId = -1;
{
  const bad1 = await jpost('/api/drafts', { prompt: '   ', mode: 'ask' });
  assert(bad1.status === 400 && bad1.json?.error === 'E_BAD_ARG', 'drafts: empty prompt -> 400 E_BAD_ARG');
  const bad2 = await jpost('/api/drafts', { prompt: 'x'.repeat(8001) });
  assert(bad2.status === 400, 'drafts: prompt > 8000 chars -> 400');
  const bad3 = await jpost('/api/drafts', { prompt: 'hi', mode: 'nope' });
  assert(bad3.status === 400, 'drafts: bad mode -> 400');
  const bad4 = await jpost('/api/drafts', { prompt: 'hi', skills: ['BAD NAME'] });
  assert(bad4.status === 400, 'drafts: malformed skill name -> 400');

  const d = await jpost('/api/drafts', { prompt: 'drafted task prompt', mode: 'code', skills: ['gortex-debug'] });
  assert(d.status === 200 && typeof d.json?.draft?.id === 'number', 'drafts: created (id numeric)');
  assert(d.json.draft.status === 'open' && d.json.draft.agent === 'mock', 'draft carries session agent + open status');
  assert(JSON.stringify(d.json.draft.skills) === '["gortex-debug"]', 'draft stores pinned skills');
  const did = d.json.draft.id;

  const c = await jpost(`/api/drafts/${did}/confirm`, {});
  assert(c.status === 200 && typeof c.json?.task_id === 'number', 'confirm: task_id numeric');
  assert(c.json?.state === 'started', `confirm on idle chat -> state started (got ${c.json?.state})`);
  draftTaskId = c.json.task_id;

  const t = await jget(`/api/tasks/${draftTaskId}`);
  assert(t.status === 200 && ['pending', 'running'].includes(t.json?.status), `confirmed task visible as pending/running (got ${t.json?.status})`);
  assert(JSON.stringify(t.json?.skills_used) === '["gortex-debug"]', 'task carries skills_used from draft');
  assert(typeof t.json?.rev === 'number' && typeof t.json?.elapsed_s === 'number', 'task carries rev + server-side elapsed_s');
  assert(t.json?.files_summary !== undefined && typeof t.json.files_summary.changed_n === 'number', 'task carries files_summary');

  const c2 = await jpost(`/api/drafts/${did}/confirm`, {});
  assert(c2.status === 410 && c2.json?.error === 'E_RESOLVED', 'confirm is single-use -> 410 E_RESOLVED');

  const d2 = await jpost('/api/drafts', { prompt: 'to discard' });
  const x = await jpost(`/api/drafts/${d2.json.draft.id}/discard`, {});
  assert(x.status === 200 && x.json?.ok === true, 'discard -> {ok:true}');
  const x2 = await jpost(`/api/drafts/${d2.json.draft.id}/confirm`, {});
  assert(x2.status === 410 && x2.json?.error === 'E_RESOLVED', 'confirm after discard -> 410 (404/410 accepted)');
  const x3 = await jpost('/api/drafts/999999/confirm', {});
  assert(x3.status === 404, 'confirm unknown draft -> 404');

  // Busy chat: the next confirm joins the EXISTING pump (queued, not a new queue).
  const d3 = await jpost('/api/drafts', { prompt: 'second wave' });
  const c3 = await jpost(`/api/drafts/${d3.json.draft.id}/confirm`, {});
  assert(c3.status === 200 && c3.json?.state === 'queued', `confirm while busy -> queued (got ${c3.json?.state})`);
}

/* ---------------- AC3: stop ---------------- */
g('AC3: stop running task; stop with nothing active');
{
  const s = await jpost(`/api/tasks/${draftTaskId}/stop`, {});
  assert(s.status === 200 && s.json?.stopped === 'task', `stop running -> {"stopped":"task"} (got ${s.json?.stopped})`);
  const t = await jget(`/api/tasks/${draftTaskId}`);
  assert(t.json?.status === 'cancelled', `stopped task reads cancelled (got ${t.json?.status})`);
  await sleep(300);
  // Drain the pump to true idle: AC2 queued 'second wave' is still running
  // inside the gate, so cancel() would find IT (200), not "nothing" (404).
  for (let i = 0; i < 10 && (gates.size > 0 || store.runningTask(CHAT)); i += 1) {
    for (const [, gt] of [...gates]) gt.res();
    await sleep(150);
  }

  const orphan = store.createTask(CHAT, 'mock', 'ask', 'never pumped', [], '');
  const s2 = await jpost(`/api/tasks/${orphan}/stop`, {});
  assert(s2.status === 404 && s2.json?.error === 'E_NO_TASK', 'stop with nothing active -> 404 E_NO_TASK');
  const s3 = await jpost('/api/tasks/999999/stop', {});
  assert(s3.status === 404 && s3.json?.error === 'E_NO_TASK', 'stop unknown task -> 404 E_NO_TASK');
}

/* ---------------- AC4: retry + continue ---------------- */
g('AC4: retry new id same prompt; continue new id new prompt same project');
{
  const r = await jpost(`/api/tasks/${draftTaskId}/retry`, {});
  assert(r.status === 200 && typeof r.json?.task_id === 'number' && r.json.task_id !== draftTaskId, 'retry -> NEW task id');
  const rt = await jget(`/api/tasks/${r.json.task_id}`);
  assert(rt.json?.prompt === 'drafted task prompt', 'retry keeps the same prompt');
  assert(rt.json?.mode === 'code', 'retry keeps the same mode');
  const c = await jpost(`/api/tasks/${draftTaskId}/continue`, { text: 'follow-up text' });
  assert(c.status === 200 && c.json?.task_id !== draftTaskId && c.json?.task_id !== r.json?.task_id, 'continue -> NEW task id');
  const ct = await jget(`/api/tasks/${c.json.task_id}`);
  assert(ct.json?.prompt === 'follow-up text', 'continue uses the new prompt');
  const bad = await jpost(`/api/tasks/${draftTaskId}/continue`, { text: '' });
  assert(bad.status === 400 && bad.json?.error === 'E_BAD_ARG', 'continue with empty text -> 400');
  const unk = await jpost('/api/tasks/999999/retry', {});
  assert(unk.status === 404, 'retry unknown task -> 404');
  // Long prompt: title clamped to 60 chars server-side.
  const long = await jpost('/api/tasks', { prompt: 'L'.repeat(100) });
  assert(long.status === 200, 'direct POST /api/tasks -> 200');
  const lt = await jget(`/api/tasks/${long.json.task_id}`);
  assert(typeof lt.json?.title === 'string' && lt.json.title.length <= 60, `title <= 60 chars (got ${lt.json?.title?.length})`);
}

/* ---------------- AC5: plan approve / rework x2 / rounds out ---------------- */
function parkPlan(prompt, plan, reworks) {
  const tid = store.createTask(CHAT, 'mock', 'code', prompt, [], '');
  store.setTaskPlan(tid, plan);
  store.setTaskPlanMeta(tid, prompt, reworks);
  store.setTaskStatus(tid, 'awaiting_plan');
  return tid;
}
g('AC5: approve -> started|queued; rework x2; third -> 410 E_ROUNDS_OUT + started');
{
  const a0 = await jpost('/api/plan/999999/approve', {});
  assert(a0.status === 404 && a0.json?.error === 'E_NO_PLAN', 'approve unknown plan -> 404 E_NO_PLAN');

  const p1 = parkPlan('origin-one', 'plan body one', 0);
  const wrong = await jpost('/api/plan/999999/approve', {});
  assert(wrong.status === 404, 'approve mismatched id while plan parked -> 404');
  const a1 = await jpost(`/api/plan/${p1}/approve`, {});
  assert(a1.status === 200 && ['started', 'queued'].includes(a1.json?.state), `approve -> started|queued (got ${a1.json?.state})`);
  assert(a1.json?.task_id === p1, 'approve returns the parked task id');

  const p2 = parkPlan('origin-two', 'plan body two', 0);
  const r1 = await jpost(`/api/plan/${p2}/rework`, { comment: 'please adjust' });
  assert(r1.status === 200 && r1.json?.rounds === 1, `first rework -> {rounds:1} (got ${r1.json?.rounds})`);

  const p3 = parkPlan('origin-three', 'plan body three', 1);
  const r2 = await jpost(`/api/plan/${p3}/rework`, { comment: 'once more' });
  assert(r2.status === 200 && r2.json?.rounds === 2, `second rework -> {rounds:2} (got ${r2.json?.rounds})`);

  const p4 = parkPlan('origin-four', 'plan body four', 2);
  const r3 = await jpost(`/api/plan/${p4}/rework`, { comment: 'third time' });
  assert(r3.status === 410 && r3.json?.error === 'E_ROUNDS_OUT', 'third rework -> 410 E_ROUNDS_OUT');
  const started = await jget(`/api/tasks/${r3.json?.task_id ?? p4}`);
  assert(['pending', 'running'].includes(started.json?.status), `rounds-out task started (got ${started.json?.status})`);

  const cur = await jget('/api/plan/current');
  assert(cur.status === 200, 'plan/current after rounds-out -> 200');
}

/* ---------------- AC6: approvals allow/deny ---------------- */
g('AC6: allow/deny unknown -> 404; repeat -> 410 E_RESOLVED');
{
  const u1 = await jpost('/api/approvals/999999/allow', {});
  assert(u1.status === 404 && u1.json?.error === 'E_NO_APPROVAL', 'allow unknown -> 404 E_NO_APPROVAL');
  const u2 = await jpost('/api/approvals/999999/deny', {});
  assert(u2.status === 404 && u2.json?.error === 'E_NO_APPROVAL', 'deny unknown -> 404 E_NO_APPROVAL');
  const aid = store.createApproval(CHAT, 'rm -rf /tmp/w4-probe');
  const pend = await jget('/api/approvals/pending');
  assert(pend.json?.approval?.id === aid && pend.json?.approval?.command === 'rm -rf /tmp/w4-probe', 'pending approval visible with command');
  const a1 = await jpost(`/api/approvals/${aid}/allow`, {});
  assert(a1.status === 200 && a1.json?.ok === true, 'allow -> {ok:true}');
  const a2 = await jpost(`/api/approvals/${aid}/allow`, {});
  assert(a2.status === 410 && a2.json?.error === 'E_RESOLVED', 'repeat allow -> 410 E_RESOLVED');
  const bid = store.createApproval(CHAT, 'ls /tmp');
  const b1 = await jpost(`/api/approvals/${bid}/deny`, {});
  assert(b1.status === 200 && b1.json?.ok === true, 'deny -> {ok:true}');
  const b2 = await jpost(`/api/approvals/${bid}/deny`, {});
  assert(b2.status === 410, 'repeat deny -> 410');
  // Foreign-chat approval is not resolvable from here.
  const fid = store.createApproval(FOREIGN, 'evil');
  const f1 = await jpost(`/api/approvals/${fid}/allow`, {});
  assert(f1.status === 404 && f1.json?.error === 'E_NO_APPROVAL', 'foreign approval -> 404 (chat-scoped)');
}

/* ---------------- AC7: since_rev ---------------- */
g('AC7: ?since_rev=<current> -> 304; after bump -> 200 with new rev');
{
  const t = await jget(`/api/tasks/${draftTaskId}`);
  const rev = t.json.rev;
  assert(typeof rev === 'number', `task rev numeric (got ${rev})`);
  const s = await api('GET', `/api/tasks/${draftTaskId}?since_rev=${rev}`);
  assert(s.status === 304 && s.buf.length === 0, 'since_rev=current -> 304 with empty body');
  store.bumpRev(draftTaskId);
  const s2 = await api('GET', `/api/tasks/${draftTaskId}?since_rev=${rev}`);
  assert(s2.status === 200 && s2.json?.rev === rev + 1, `after bump -> 200 with rev ${rev + 1}`);
  const s3 = await api('GET', `/api/tasks/${draftTaskId}?since_rev=${rev + 1}`);
  assert(s3.status === 304, 'since_rev=new current -> 304 again');
}

/* ---------------- AC8: settings ---------------- */
g('AC8: PUT /api/settings validation + agent_session_id drop');
{
  const badAgent = await api('PUT', '/api/settings', { body: { agent: 'nope' } });
  assert(badAgent.status === 400 && badAgent.json?.error === 'E_BAD_ARG', 'agent "nope" -> 400 E_BAD_ARG');
  const badProj = await api('PUT', '/api/settings', { body: { project: '/etc' } });
  assert(badProj.status === 400 && badProj.json?.error === 'E_BAD_ARG', 'project outside ALLOWED_ROOTS -> 400');
  const badType = await api('PUT', '/api/settings', { body: { auto_approve: 'yes' } });
  assert(badType.status === 400, 'auto_approve non-bool -> 400');
  const empty = await api('PUT', '/api/settings', { body: {} });
  assert(empty.status === 400, 'empty patch -> 400');

  store.setAgentSessionId(CHAT, 'ses_probe123');
  const ch = await api('PUT', '/api/settings', { body: { agent: 'opencode' } });
  assert(ch.status === 200 && ch.json?.agent === 'opencode', 'agent change accepted');
  assert(store.getSession(CHAT)?.agent_session_id === null, 'agent change nulls agent_session_id');
  const keep = await api('PUT', '/api/settings', { body: { model: 'm1' } });
  assert(keep.status === 200 && keep.json?.model === 'm1', 'model change accepted');
  const back = await api('PUT', '/api/settings', { body: { agent: 'mock' } });
  assert(back.status === 200 && back.json?.agent === 'mock', 'agent back to mock (gated provider)');
}

/* ---------------- AC9: files ---------------- */
const chatDir = join(workRoot, String(CHAT));
g('AC9: path guard, binary preview, download headers');
{
  mkdirSync(chatDir, { recursive: true });
  writeFileSync(join(chatDir, 'hello.txt'), 'hello miniapp\n');
  writeFileSync(join(chatDir, 'bin.dat'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x00, 0x01]));
  writeFileSync(join(chatDir, 'big.txt'), 'x'.repeat(200 * 1024));

  const esc = await jget('/api/files?dir=../../..');
  assert(esc.status === 403 && esc.json?.error === 'E_PATH_DENIED', 'dir=../../.. -> 403 E_PATH_DENIED');
  const esc2 = await jget('/api/files/preview?path=../../secret');
  assert(esc2.status === 403, 'preview escape -> 403');
  const esc3 = await jget('/api/files/download?path=/abs/path');
  assert(esc3.status === 403, 'download absolute -> 403');

  const list = await jget('/api/files');
  assert(list.status === 200 && list.json?.abs === chatDir, `listing abs is the full workdir path (got ${list.json?.abs})`);
  assert(list.json?.total >= 3 && list.json?.shown === list.json?.entries?.length, 'listing total/shown consistent');
  assert(list.json.entries.every((e) => typeof e.rel === 'string' && typeof e.isDir === 'boolean'), 'entries carry rel+isDir');
  const miss = await jget('/api/files?dir=no-such-dir');
  assert(miss.status === 404, 'listing missing dir -> 404');

  const pv = await jget('/api/files/preview?path=hello.txt');
  assert(pv.status === 200 && pv.json?.text === 'hello miniapp\n' && pv.json?.truncated === false, 'text preview exact + truncated false');
  assert(pv.json?.abs === join(chatDir, 'hello.txt'), 'preview abs is a full path');
  const big = await jget('/api/files/preview?path=big.txt');
  assert(big.status === 200 && big.json?.truncated === true && big.json?.text?.length === 64 * 1024, 'preview capped at 64 КБ with truncated flag');
  const bin = await jget('/api/files/preview?path=bin.dat');
  assert(bin.status === 200 && bin.json?.binary === true, 'binary preview -> {"binary":true}');
  const pmiss = await jget('/api/files/preview?path=nope.txt');
  assert(pmiss.status === 404, 'preview missing -> 404');
  const noparam = await jget('/api/files/preview');
  assert(noparam.status === 400, 'preview without path -> 400');

  const dl = await api('GET', '/api/files/download?path=hello.txt');
  assert(dl.status === 200, 'download -> 200');
  assert(dl.headers.get('content-disposition') === 'attachment; filename="hello.txt"', 'download sends Content-Disposition: attachment');
  assert(dl.buf.toString('utf8') === 'hello miniapp\n', 'download bytes exact');
  assert(![...dl.headers.keys()].some((k) => k.toLowerCase() === 'access-control-allow-origin'), 'download sends no ACAO header (same-origin decision)');
  const dlmiss = await api('GET', '/api/files/download?path=nope.txt');
  assert(dlmiss.status === 404, 'download missing -> 404');

  // Byte cap: a file over MAX_OUTBOUND_BYTES is refused before any byte is read.
  const huge = join(chatDir, 'huge.bin');
  writeFileSync(huge, Buffer.alloc(51 * 1024 * 1024, 7));
  const over = await api('GET', '/api/files/download?path=huge.bin');
  assert(over.status === 413, `oversize download -> 413 (got ${over.status})`);
  rmSync(huge, { force: true });

  // Per-path git diff on the live tree (git repo fixture; SKIP when git is absent).
  let gitOk = false;
  try {
    execFileSync('git', ['init'], { cwd: chatDir, stdio: 'ignore', windowsHide: true });
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: chatDir, stdio: 'ignore', windowsHide: true });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: chatDir, stdio: 'ignore', windowsHide: true });
    writeFileSync(join(chatDir, 'tracked.txt'), 'v1\n');
    execFileSync('git', ['add', '.'], { cwd: chatDir, stdio: 'ignore', windowsHide: true });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: chatDir, stdio: 'ignore', windowsHide: true });
    writeFileSync(join(chatDir, 'tracked.txt'), 'v1\nv2\n');
    gitOk = true;
  } catch {
    gitOk = false;
  }
  if (gitOk) {
    const gd = await jget('/api/files/diff?path=tracked.txt');
    assert(gd.status === 200 && typeof gd.json?.diff === 'string' && gd.json.diff.includes('+v2'), 'files/diff shows the live-tree change');
    const gb = await jget('/api/files/diff?path=bin.dat');
    assert(gb.status === 200 && gb.json?.binary === true, 'files/diff on binary -> {"binary":true}');
  } else {
    process.stdout.write('  SKIP files/diff live-tree checks (no git on PATH)\n');
  }
}

/* ---------------- task files/diff from stored rows + leak guard ---------------- */
g('task files/diff endpoints + plan_diff_before invisibility');
{
  const tid = store.createTask(CHAT, 'mock', 'ask', 'files probe', [], '');
  store.saveTaskFiles(tid, [
    { path: 'src/a.ts', added: 12, removed: 3, diff: '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-x\n+y\n', truncated: false, binary: false },
    { path: 'img.png', added: 0, removed: 0, diff: null, truncated: false, binary: true },
  ]);
  const fl = await jget(`/api/tasks/${tid}/files`);
  assert(fl.status === 200 && fl.json?.changed_n === 2, 'task files changed_n 2');
  assert(fl.json?.total_added === 12 && fl.json?.total_removed === 3, 'task files totals from summary/rows');
  assert(fl.json?.files?.[0]?.path === 'src/a.ts' && fl.json?.no_git === true, 'task files rows + no_git flag');
  const df = await jget(`/api/tasks/${tid}/diff?path=src/a.ts`);
  assert(df.status === 200 && df.json?.diff?.includes('@@') && df.json?.truncated === false, 'task diff serves stored unified text');
  const db = await jget(`/api/tasks/${tid}/diff?path=img.png`);
  assert(db.status === 200 && db.json?.binary === true, 'task diff on binary row -> {"binary":true}');
  const dn = await jget(`/api/tasks/${tid}/diff?path=nope.ts`);
  assert(dn.status === 404 && dn.json?.error === 'E_NO_DIFF', 'task diff unknown path -> 404 E_NO_DIFF');
  const nop = await jget(`/api/tasks/${tid}/diff`);
  assert(nop.status === 400, 'task diff without path -> 400');

  store.setTaskPlanDiff(tid, '{"sigs":{"src/a.ts":"h:SECRET-SIG-MARKER"}}');
  const tv = await jget(`/api/tasks/${tid}`);
  assert(tv.status === 200 && !JSON.stringify(tv.json).includes('SECRET-SIG-MARKER'), 'plan_diff_before never leaks into the task view');
  const rc = await jget('/api/tasks/recent?limit=100');
  assert(rc.status === 200 && !JSON.stringify(rc.json).includes('SECRET-SIG-MARKER'), 'plan_diff_before never leaks into recent');
  const cur = await jget('/api/tasks/current');
  assert(!JSON.stringify(cur.json).includes('SECRET-SIG-MARKER'), 'plan_diff_before never leaks into current');

  const alienTask = store.createTask(FOREIGN, 'mock', 'ask', 'alien', [], '');
  const al = await jget(`/api/tasks/${alienTask}`);
  assert(al.status === 404 && al.json?.error === 'E_NO_TASK', 'foreign-chat task -> 404 (chat-scoped)');
}

/* ---------------- skills list/pin + prepend path ---------------- */
g('skills: list, pins, auto, SKILL.md prepend');
{
  const skillDir = join(chatDir, '.opencode', 'skills', 'demo-skill');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: demo-skill\ndescription: Demo skill for W4.\n---\n\n# Demo\nDo the thing.\n');
  const s1 = await jget('/api/skills');
  const found = (s1.json?.skills ?? []).find((s) => s.name === 'demo-skill');
  assert(s1.status === 200 && found?.description === 'Demo skill for W4.' && found?.pinned === false, 'skill discovered with description, unpinned');
  assert(found?.source === 'project', 'skill source project');

  const put = await api('PUT', '/api/skills', { body: { pins: ['demo-skill'], auto: true } });
  assert(put.status === 200 && put.json?.ok === true, 'PUT skills -> {ok:true}');
  const s2 = await jget('/api/skills');
  assert(s2.json?.auto === true, 'auto flag persisted');
  assert(s2.json?.skills?.find((s) => s.name === 'demo-skill')?.pinned === true, 'pin persisted');
  const bad = await api('PUT', '/api/skills', { body: { pins: ['BAD NAME'] } });
  assert(bad.status === 400 && bad.json?.error === 'E_BAD_ARG', 'malformed pin -> 400');
  const bad2 = await api('PUT', '/api/skills', { body: { pins: 'x' } });
  assert(bad2.status === 400, 'non-array pins -> 400');

  // End-to-end R3 §4b path ①: the provider sees the SKILL.md body prepended.
  // The pump may be backlogged (earlier waves left queued tasks), so release
  // gates in a bounded loop until OUR task's prompt is observed — one res()
  // only advances a single queued task and proves nothing about ours.
  const t = await jpost('/api/tasks', { prompt: 'use the skill', skills: ['demo-skill'] });
  assert(t.status === 200, 'task with skill submitted');
  for (let i = 0; i < 25 && !seenPrompts.some((p) => p.includes('use the skill')); i += 1) {
    for (const [, gt] of [...gates]) gt.res();
    await sleep(150);
  }
  assert(seenPrompts.some((p) => p.includes('# Skill: demo-skill') && p.includes('use the skill')), 'provider prompt carries the prepended SKILL.md body');
}

/* ---------------- transport: methods, bodies, misc ---------------- */
g('transport: 405/400/413/404 + source invariants');
{
  const p1 = await jpost('/api/tasks', { prompt: 'x' }, 'none');
  assert(p1.status === 401, 'POST without header -> 401');
  const del = await api('DELETE', '/api/health');
  assert(del.status === 405 && del.json?.error === 'E_METHOD_NOT_ALLOWED', 'DELETE -> 405');
  const badJson = await api('POST', '/api/tasks', { rawBody: '{not json' });
  assert(badJson.status === 400 && badJson.json?.error === 'E_BAD_ARG', 'malformed JSON -> 400 E_BAD_ARG');
  const huge = await api('POST', '/api/tasks', { rawBody: `{"prompt":"${'y'.repeat(70 * 1024)}"}` });
  assert(huge.status === 413 && huge.json?.error === 'E_BODY_TOO_BIG', 'body > 64 КБ -> 413');
  const unk = await jget('/api/nope-xyz');
  assert(unk.status === 404 && unk.json?.error === 'E_NOT_FOUND', 'unknown /api path -> 404 JSON');

  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert(JSON.stringify(Object.keys(pkg.dependencies).sort()) === '["better-sqlite3","grammy"]', 'dependencies exactly better-sqlite3 + grammy');
  const src = readFileSync(join(ROOT, 'src', 'miniapp', 'api.ts'), 'utf8');
  assert(!/SELECT\s+\*/i.test(src), 'api.ts contains no SELECT * (explicit columns via Store.*Api)');
  const dbSrc = readFileSync(join(ROOT, 'src', 'storage', 'db.ts'), 'utf8');
  const apiReads = ['getTaskApi', 'recentTasksApi', 'runningTaskApi', 'oldestPendingApi', 'awaitingPlanApi'];
  assert(apiReads.every((m) => dbSrc.includes(m)), 'Store exposes the five explicit-column Api readers');
  for (const m of apiReads) {
    const at = dbSrc.indexOf(`${m}(`);
    const end = dbSrc.indexOf('\n  }', at);
    const window = dbSrc.slice(at, end);
    assert(!/SELECT\s+\*/i.test(window), `Store.${m} projects explicit columns`);
  }
  let typesDiff = null;
  try {
    typesDiff = execFileSync('git', ['diff', 'origin/main', '--', 'src/gateway/types.ts'], { encoding: 'utf8', cwd: ROOT });
  } catch {
    typesDiff = null;
  }
  if (typesDiff !== null) assert(typesDiff.trim() === '', 'src/gateway/types.ts zero diff (FROZEN)');
  else process.stdout.write('  SKIP types.ts diff check (git unavailable)\n');
  const cfgSrc = readFileSync(join(ROOT, 'src', 'config.ts'), 'utf8');
  assert(cfgSrc.includes('opencode'), 'config.ts present (agent check via AGENT_IDS unchanged)');
}

/* ---------------- AC10: load ---------------- */
g('AC10: 100 sequential since_rev polls < 2 s');
{
  const t = await jget(`/api/tasks/${draftTaskId}`);
  const rev = t.json.rev;
  const t0 = Date.now();
  let oks = 0;
  for (let i = 0; i < 100; i += 1) {
    const r = await api('GET', `/api/tasks/${draftTaskId}?since_rev=${rev}`);
    if (r.status === 304) oks += 1;
  }
  const dt = Date.now() - t0;
  assert(oks === 100, `100 polls all 304 (${oks}/100)`);
  assert(dt < 2000, `100 sequential polls in ${dt} ms (< 2000 ms)`);
}

/* ---------------- drain background pumps, close ---------------- */
for (const [, gt] of gates) gt.res();
await sleep(1200);
await server.close();
store.close();
rmSync(tmp, { recursive: true, force: true });

process.stdout.write(`\n${'-'.repeat(60)}\n`);
if (failures.length === 0) {
  process.stdout.write(`ALL GREEN — ${passed} assertions passed\n`);
} else {
  process.stdout.write(`${failures.length} FAILED of ${passed + failures.length} assertions:\n`);
  for (const f of failures) process.stdout.write(`  - ${f}\n`);
  process.exitCode = 1;
}
