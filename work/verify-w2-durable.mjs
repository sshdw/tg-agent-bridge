/**
 * W2 Durability harness — offline, no bot, no network, no Telegram token.
 *
 * Drives Store + TaskQueue directly with a fake Responder (like the existing
 * work/verify-*.mjs). Temp DBs in os.tmpdir(). A "restart" is
 * store.close() + new Store(samePath) (+ a new TaskQueue, like src/index.ts).
 *
 * Covers W2 AC1–AC8 plus the plan's named race risk (single-use resolve) and
 * a rev monotonicity sweep. Usage: node work/verify-w2-durable.mjs
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { Store, PENDING_TTL_SEC } from '../dist/storage/db.js';
import {
  approvalReply,
  bindApprovalStore,
  hasApproval,
  ORPHAN_APPROVAL_MSG,
  requestApproval,
  resolveApproval,
  resolveApprovalById,
} from '../dist/core/approvals.js';
import { TaskQueue, MAX_PLAN_REWORKS } from '../dist/core/queue.js';
import { register } from '../dist/gateway/registry.js';
import {
  rememberInboundFiles,
  sweepPendingFiles,
  takeImages,
  PENDING_FILES_TTL_MS,
} from '../dist/core/router.js';

let n = 0;
const failures = [];
function check(label, ok, detail = '') {
  n += 1;
  if (!ok) failures.push(`${label}${detail === '' ? '' : ` :: ${detail}`}`);
}

// Instant offline provider under the 'mock' id (registry is a Map: last wins).
register({
  id: 'mock',
  run: async (task) => ({
    text: `mock-plan for: ${task.prompt.slice(0, 120)}`,
    exitCode: 0,
    sessionId: '',
    costUsd: null,
  }),
  cancel: async () => undefined,
});

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs = 8000, label = '') {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting: ${label}`);
    await tick(25);
  }
}

const fakeIo = () => ({
  notifies: [],
  async streamStart() {
    return { push() {}, async finish() {}, async fail() {} };
  },
  async askApproval() {
    return false;
  },
  async notify(chatId, text) {
    this.notifies.push([chatId, text]);
  },
});

const workRoot = mkdtempSync(join(tmpdir(), 'w2-work-'));
const cfg = {
  botToken: 'test',
  allowedChatIds: [111, 222, 333, 444, 555, 666],
  defaultAgent: 'mock',
  defaultModel: '',
  taskTimeoutMs: 30000,
  workRoot,
  allowedRoots: [workRoot],
  autoApprove: false,
  historyLimit: 50,
  opencodeBin: 'opencode',
  cursorBin: 'cursor-agent',
  clineBin: 'roo-code',
  hermesBaseUrl: '',
  hermesApiKey: '',
  githubToken: '',
  whisperBin: '',
  voiceModelPath: '',
  voiceLang: 'ru',
  ffmpegBin: '',
  ciPollMs: 300000,
  dbPath: join(workRoot, 'bridge.db'),
  miniPort: 8080,
  miniUrl: '',
};

const dbDir = mkdtempSync(join(tmpdir(), 'w2-db-'));
const dbPath = (name) => join(dbDir, `${name}.db`);

// ---------------------------------------------------------------- AC1: approval survives restart
{
  const s1 = new Store(dbPath('a1'));
  const id = s1.createApproval(111, 'rm -rf /tmp/x');
  check('AC1: createApproval returns id', id > 0, String(id));
  check('AC1: pending before restart', s1.pendingApproval(111)?.command === 'rm -rf /tmp/x');
  s1.close();
  const s2 = new Store(dbPath('a1'));
  const back = s2.pendingApproval(111);
  check('AC1: pending after reopen', back?.id === id && back?.command === 'rm -rf /tmp/x', JSON.stringify(back));
  s2.close();
}

// ------------------------------------------------- AC2: resolve after reopen wakes the runner
{
  const s1 = new Store(dbPath('a2'));
  bindApprovalStore(s1);
  let settled = 'unsettled';
  const p = requestApproval(111, 'ls /tmp').then((v) => {
    settled = v;
  });
  await tick();
  check('AC2: hasApproval while waiting', hasApproval(111) === true);
  s1.close();
  const s2 = new Store(dbPath('a2'));
  bindApprovalStore(s2);
  check('AC2: pending row survived reopen', s2.pendingApproval(111)?.command === 'ls /tmp');
  const ok = resolveApproval(111, false);
  check('AC2: resolveApproval after reopen returns live', ok === 'live', String(ok));
  await p;
  check('AC2: runner promise resolved false', settled === false, String(settled));
  check('AC2: nothing left pending', s2.pendingApproval(111) === undefined);
  s2.close();
}

// ------------------------------------------- AC7 + race: single-use resolve
{
  const s = new Store(dbPath('a7'));
  bindApprovalStore(s);
  const id = s.createApproval(222, 'echo hi');
  check('AC7: first resolve ok', s.resolveApproval(id, 'allowed') === 'ok');
  check('AC7: second resolve loses', s.resolveApproval(id, 'denied') === 'resolved');
  // chat-button vs Mini-App race, mini-app first
  let v1 = 'unsettled';
  const p1 = requestApproval(222, 'cmd-race-1').then((v) => {
    v1 = v;
  });
  await tick();
  const rid = s.pendingApproval(222)?.id ?? -1;
  const miniWins = resolveApprovalById(rid, false);
  const chatLoses = resolveApproval(222, true);
  check('race: mini-app wins first', miniWins === 'ok', String(miniWins));
  check('race: chat loses after (nothing left)', chatLoses === 'none', String(chatLoses));
  await p1;
  check('race: runner got winner value', v1 === false, String(v1));
  // same race, chat first
  let v2 = 'unsettled';
  const p2 = requestApproval(222, 'cmd-race-2').then((v) => {
    v2 = v;
  });
  await tick();
  const rid2 = s.pendingApproval(222)?.id ?? -1;
  const chatWins = resolveApproval(222, true);
  const miniLoses = resolveApprovalById(rid2, true);
  check('race: chat wins first', chatWins === 'live', String(chatWins));
  check('race: mini-app gets resolved', miniLoses === 'resolved', String(miniLoses));
  await p2;
  check('race: runner got winner value (2)', v2 === true, String(v2));
  s.close();
}

// ------------------------------------------------- M1: orphan row must not claim success
{
  const s = new Store(dbPath('m1'));
  bindApprovalStore(s);
  // Row with NO waiter: the runner died with the previous process.
  const oid = s.createApproval(777, 'orphan-cmd');
  check('M1: hasApproval sees the row', hasApproval(777) === true);
  const r = resolveApproval(777, true);
  check('M1: chat path does not claim success', r === 'orphan', String(r));
  check('M1: owner message is the honest one', approvalReply(r, true) === ORPHAN_APPROVAL_MSG);
  check(
    'M1: honest string never implies execution',
    ORPHAN_APPROVAL_MSG === 'Команда больше не ждёт — задача прервана рестартом бота.',
  );
  check('M1: orphan settled denied', s.getApproval(oid)?.status === 'denied');
  check('M1: second tap finds nothing', resolveApproval(777, true) === 'none');
  check(
    'M1: live mapping intact',
    approvalReply('live', true) === '✅ Разрешено.' && approvalReply('live', false) === 'Отклонено.',
  );
  // cancel must skip the orphan and fall through (no plan/task here).
  const q = new TaskQueue(s, cfg, fakeIo());
  check('M1: cancel skips orphan approval', (await q.cancel(777)) === 'nothing');
  s.close();
}

// ------------------------------------------------- M2a: stale bound id falls back to live row
{
  const s = new Store(dbPath('m2a'));
  bindApprovalStore(s);
  let v = 'unsettled';
  const p = requestApproval(778, 'cmd-one').then((x) => {
    v = x;
  });
  await tick();
  const id1 = s.pendingApproval(778)?.id ?? -1;
  check('M2a: setup back-resolve', s.resolveApproval(id1, 'denied') === 'ok');
  const id2 = s.createApproval(778, 'cmd-two');
  const r = resolveApproval(778, true);
  check('M2a: falls back to live row', r === 'live', String(r));
  await p;
  check('M2a: waiter woken with tap value', v === true, String(v));
  check('M2a: live row flipped', s.getApproval(id2)?.status === 'allowed');
  s.close();
}

// ------------------------------------------------- M2b: terminally dead waiter settles deny, no hang
{
  const path = dbPath('m2b');
  const s = new Store(path);
  bindApprovalStore(s);
  let v = 'unsettled';
  const p = requestApproval(779, 'cmd-old').then((x) => {
    v = x;
  });
  await tick();
  const id = s.pendingApproval(779)?.id ?? -1;
  s.close();
  const raw = new Database(path);
  raw
    .prepare('UPDATE approvals SET created_at = ? WHERE id = ?')
    .run(Math.floor(Date.now() / 1000) - PENDING_TTL_SEC - 10, id);
  raw.close();
  const s2 = new Store(path);
  bindApprovalStore(s2);
  const r = resolveApproval(779, true);
  check('M2b: dead waiter reports orphan', r === 'orphan', String(r));
  await p;
  check('M2b: waiter settled deny', v === false, String(v));
  check('M2b: nothing left afterwards', resolveApproval(779, true) === 'none');
  s2.close();
}

// ------------------------------------------------- m1: cost update bumps rev (§5)
{
  const s = new Store(dbPath('m1cost'));
  const id = s.createTask(111, 'mock', 'ask', 'cost rev', [], '');
  const r0 = s.getTask(id)?.rev ?? -1;
  s.setTaskCost(id, 0.05);
  check('m1: cost update bumps rev', (s.getTask(id)?.rev ?? -1) === r0 + 1);
  check('m1: cost stored', s.getTask(id)?.cost_usd === 0.05);
  s.close();
}
{
  const path = dbPath('a8');
  const s = new Store(path);
  const aid = s.createApproval(333, 'stale-cmd');
  const did = s.createDraft(333, 'stale draft');
  s.close();
  const raw = new Database(path);
  const old = Math.floor(Date.now() / 1000) - PENDING_TTL_SEC - 10;
  raw.prepare('UPDATE approvals SET created_at = ? WHERE id = ?').run(old, aid);
  raw.prepare('UPDATE drafts SET created_at = ? WHERE id = ?').run(old, did);
  raw.close();
  const s2 = new Store(path);
  // Direct resolve first (no prior read): the row is still `pending` but stale.
  check('AC8: expired approval reports expired', s2.resolveApproval(aid, 'allowed') === 'expired');
  check('AC8: expired draft confirm reports expired', s2.confirmDraft(did) === 'expired');
  check('AC8: expired approval not pending', s2.pendingApproval(333) === undefined);
  check('AC8: expired draft not open', s2.openDraft(333) === undefined);
  // fresh rows still work after the sweep
  const aid2 = s2.createApproval(333, 'fresh-cmd');
  check('AC8: fresh approval resolves', s2.resolveApproval(aid2, 'denied') === 'ok');
  const did2 = s2.createDraft(333, 'fresh draft');
  check('AC8: fresh draft confirms', s2.confirmDraft(did2) === 'ok');
  check('AC8: double confirm loses', s2.confirmDraft(did2) === 'resolved');
  const did3 = s2.createDraft(333, 'to discard');
  check('AC8: discard works', s2.discardDraft(did3) === 'ok');
  s2.close();
}

// ------------------------------------------------- drafts + pins durability
{
  const path = dbPath('dp');
  const s1 = new Store(path);
  const did = s1.createDraft(444, 'plan the thing', 'code', 'mock', 'm', 'p', ['gortex-debug']);
  s1.setSkillPins(444, ['gortex-debug', 'gortex-explore']);
  check('drafts: open before restart', s1.openDraft(444)?.id === did);
  check('pins: set before restart', JSON.stringify(s1.skillPins(444)) === '["gortex-debug","gortex-explore"]');
  s1.close();
  const s2 = new Store(path);
  const d = s2.openDraft(444);
  check('drafts: open after reopen', d?.prompt === 'plan the thing' && d?.mode === 'code', JSON.stringify(d));
  check('pins: survive reopen', JSON.stringify(s2.skillPins(444)) === '["gortex-debug","gortex-explore"]');
  s2.setSkillPins(444, ['one']);
  check('pins: replace works', JSON.stringify(s2.skillPins(444)) === '["one"]');
  s2.close();
}

// ------------------------------------------------- AC3: parked plan survives restart
{
  const path = dbPath('a3');
  const ORIGIN = 'ORIGIN-PROMPT-AC3-implement feature X';
  const CHAT = 555;
  const s1 = new Store(path);
  const q1 = new TaskQueue(s1, cfg, fakeIo());
  q1.submit(CHAT, ORIGIN, 'code', [], { planOnly: true });
  await waitFor(() => s1.awaitingPlan(CHAT), 8000, 'plan parks');
  const parked = s1.awaitingPlan(CHAT);
  check('AC3: plan parked', parked?.plan_text?.startsWith('mock-plan') === true);
  check('AC3: origin durable on row', parked?.plan_origin === ORIGIN, String(parked?.plan_origin));
  check('AC3: reworks start at 0', parked?.plan_reworks === 0);
  s1.close();
  const s2 = new Store(path);
  const q2 = new TaskQueue(s2, cfg, fakeIo());
  check('AC3: plan restored at boot', q2.hasPlan(CHAT) === true);
  const tid = q2.approvePlan(CHAT);
  check('AC3: approvePlan after reopen returns id', tid === parked?.id, String(tid));
  await waitFor(() => (tid != null ? s2.getTask(tid)?.status === 'done' : false), 15000, 'task runs');
  const done = tid != null ? s2.getTask(tid) : undefined;
  check('AC3: task done with origin prompt', done?.status === 'done' && (done?.prompt?.startsWith(ORIGIN) ?? false));
  s2.close();
}

// ------------------------------------------------- AC4: rework counter durable, MAX 2
{
  check('AC4: MAX_PLAN_REWORKS is 2', MAX_PLAN_REWORKS === 2, String(MAX_PLAN_REWORKS));
  const path = dbPath('a4');
  const ORIGIN = 'ORIGIN-PROMPT-AC4-second feature';
  const CHAT = 666;
  const s = new Store(path);
  const q = new TaskQueue(s, cfg, fakeIo());
  q.submit(CHAT, ORIGIN, 'code', [], { planOnly: true });
  await waitFor(() => s.awaitingPlan(CHAT), 8000, 'plan parks (ac4)');
  const t1 = s.awaitingPlan(CHAT)?.id;
  const r1 = q.reworkPlan(CHAT, 'comment one');
  check('AC4: first rework rounds=1', r1?.rounds === 1, JSON.stringify(r1));
  await waitFor(() => {
    const cur = s.awaitingPlan(CHAT);
    return cur && cur.id !== t1 ? true : false;
  }, 8000, 'rework turn parks again');
  const t2 = s.awaitingPlan(CHAT)?.id;
  check('AC4: rework count durable on row', s.awaitingPlan(CHAT)?.plan_reworks === 1);
  const r2 = q.reworkPlan(CHAT, 'comment two');
  check('AC4: second rework rounds=2', r2?.rounds === 2, JSON.stringify(r2));
  await waitFor(() => {
    const cur = s.awaitingPlan(CHAT);
    return cur && cur.id !== t2 ? true : false;
  }, 8000, 'second rework parks again');
  check('AC4: reworks=2 durable', s.awaitingPlan(CHAT)?.plan_reworks === 2);
  const t3 = s.awaitingPlan(CHAT)?.id;
  const r3 = q.reworkPlan(CHAT, 'comment three');
  check('AC4: third rework returns null (runs anyway)', r3 === null);
  await waitFor(() => (t3 != null ? s.getTask(t3)?.status === 'done' : false), 15000, 'task runs anyway');
  const fin = t3 != null ? s.getTask(t3) : undefined;
  check('AC4: final task done with origin', fin?.status === 'done' && (fin?.prompt?.startsWith(ORIGIN) ?? false));
  s.close();
}

// ------------------------------------------------- AC5: rev +1 per status change, monotonic
{
  const s = new Store(dbPath('a5'));
  const id = s.createTask(111, 'mock', 'ask', 'rev test', [], '');
  check('AC5: rev starts at 0', s.getTask(id)?.rev === 0, String(s.getTask(id)?.rev));
  const seen = [s.getTask(id)?.rev ?? -1];
  for (const st of ['running', 'awaiting_plan', 'pending', 'running', 'done']) {
    const before = s.getTask(id)?.rev ?? -1;
    s.setTaskStatus(id, st);
    const after = s.getTask(id)?.rev ?? -1;
    check(`AC5: rev +1 on ->${st}`, after === before + 1, `${before}->${after}`);
    seen.push(after);
  }
  check('AC5: rev never decreases', seen.every((v, i) => i === 0 || v >= seen[i - 1]), seen.join(','));
  // bumpRev without a status change (W4 cheap polling)
  const b0 = s.getTask(id)?.rev ?? -1;
  s.bumpRev(id);
  check('AC5: bumpRev +1', (s.getTask(id)?.rev ?? -1) === b0 + 1);
  // stale-running recovery bumps too
  const id2 = s.createTask(111, 'mock', 'ask', 'stale', [], '');
  s.setTaskStatus(id2, 'running');
  const r0 = s.getTask(id2)?.rev ?? -1;
  check('AC5: one stale recovered', s.recoverStaleRunning() === 1);
  const rec = s.getTask(id2);
  check('AC5: stale back to pending with rev+1', rec?.status === 'pending' && (rec?.rev ?? -1) === r0 + 1);
  s.close();
}

// ------------------------------------------------- AC6: legacy DB migrates
{
  const path = dbPath('a6');
  const raw = new Database(path);
  raw.exec(`
    CREATE TABLE tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER NOT NULL,
      agent TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'ask',
      prompt TEXT NOT NULL,
      images TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      finished_at INTEGER
    );
  `);
  raw.prepare("INSERT INTO tasks (chat_id, agent, mode, prompt, status, created_at) VALUES (111, 'mock', 'ask', 'legacy one', 'done', 1700000000)").run();
  raw.prepare("INSERT INTO tasks (chat_id, agent, mode, prompt, status, created_at) VALUES (111, 'mock', 'code', 'legacy two', 'pending', 1700000001)").run();
  raw.close();
  const s = new Store(path);
  const info = new Database(path, { readonly: true }).prepare('PRAGMA table_info(tasks)').all();
  const names = new Set(info.map((c) => c.name));
  for (const c of ['title', 'model', 'project', 'skills_used', 'rev', 'plan_origin', 'plan_reworks']) {
    check(`AC6: migrated column ${c}`, names.has(c), [...names].join(','));
  }
  const t1 = s.getTask(1);
  const t2 = s.getTask(2);
  check('AC6: legacy rows survive', t1?.prompt === 'legacy one' && t2?.prompt === 'legacy two');
  check('AC6: legacy statuses intact', t1?.status === 'done' && t2?.status === 'pending');
  check('AC6: approvals table created', s.pendingApproval(111) === undefined);
  s.close();
}

// ------------------------------------------------- migration idempotency: NEW-schema DB reopened twice
{
  const path = dbPath('idem');
  const snapCols = () => {
    const d = new Database(path, { readonly: true });
    const rows = d.prepare('PRAGMA table_info(tasks)').all();
    d.close();
    return rows.map((c) => `${c.name}:${c.type}`).join('|');
  };
  const s1 = new Store(path);
  const tid = s1.createTask(111, 'mock', 'ask', 'idem row', [], '');
  s1.createApproval(111, 'idem-cmd');
  s1.setSkillPins(111, ['a']);
  const cols1 = snapCols();
  s1.close();
  const s2 = new Store(path);
  check('idem: 2nd open keeps schema', snapCols() === cols1);
  check('idem: task row survives reopen', s2.getTask(tid)?.prompt === 'idem row');
  check('idem: approval survives reopen', s2.pendingApproval(111)?.command === 'idem-cmd');
  check('idem: pins survive reopen', JSON.stringify(s2.skillPins(111)) === '["a"]');
  s2.close();
  const s3 = new Store(path);
  check('idem: 3rd open keeps schema', snapCols() === cols1);
  check('idem: task row survives 2nd reopen', s3.getTask(tid)?.prompt === 'idem row');
  s3.close();
}
{
  check('pendingFiles: TTL is 24h', PENDING_FILES_TTL_MS === 86400 * 1000, String(PENDING_FILES_TTL_MS));
  rememberInboundFiles(111, ['/a/one.txt']);
  rememberInboundFiles(222, ['/b/two.txt']);
  check('pendingFiles: ownership isolated', JSON.stringify(takeImages(111)) === '["/a/one.txt"]');
  check('pendingFiles: consume-once', JSON.stringify(takeImages(111)) === '[]');
  check('pendingFiles: other chat intact', JSON.stringify(takeImages(222)) === '["/b/two.txt"]');
  rememberInboundFiles(333, ['/c/three.txt']);
  const dropped = sweepPendingFiles(Date.now() + 25 * 3600 * 1000);
  check('pendingFiles: 24h sweep drops stale', dropped >= 1, String(dropped));
  check('pendingFiles: swept entry gone', JSON.stringify(takeImages(333)) === '[]');
  // m4: per-file TTL — appending must not extend older files of the same chat.
  const NOW = Date.now();
  rememberInboundFiles(881, ['/old/a.txt'], NOW - 23.5 * 3600 * 1000);
  rememberInboundFiles(881, ['/new/b.txt']);
  const dropped2 = sweepPendingFiles(NOW + 3600 * 1000);
  check('m4: only the stale file dropped', dropped2 === 1, String(dropped2));
  check('m4: fresh file survives', JSON.stringify(takeImages(881)) === '["/new/b.txt"]');
}

// ------------------------------------------------- no new runtime deps (plan rule §8.4)
{
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const deps = Object.keys(pkg.dependencies ?? {}).sort();
  check('deps: only better-sqlite3 + grammy', JSON.stringify(deps) === '["better-sqlite3","grammy"]', deps.join(','));
}

console.log(`\n${n - failures.length}/${n} passed`);
if (failures.length > 0) {
  console.log('FAILURES:');
  for (const f of failures) console.log('  -', f);
  process.exit(1);
}
console.log('ALL GREEN');
