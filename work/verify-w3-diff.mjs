/**
 * W3 Task-engine harness — offline, no bot, no network, no Telegram token.
 *
 * Temp dirs, temp git repos, temp file-based `better-sqlite3`, fake
 * `Responder` (streamStart returns a no-op handle), mock provider only —
 * never a real `provider.run`. If `git` is absent: SKIP with a reason.
 *
 * Covers W3 AC1–AC8 plus snapshot timing (< 2 s on a 500-file repo).
 * Usage: node work/verify-w3-diff.mjs
 */
import { execFileSync, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Store } from '../dist/storage/db.js';
import { TaskQueue } from '../dist/core/queue.js';
import { register } from '../dist/gateway/registry.js';
import {
  collectTaskFiles,
  snapshotGit,
  summarizeFiles,
  taskTitle,
  unifiedDiff,
} from '../dist/miniapp/diff.js';

let n = 0;
const failures = [];
function check(label, ok, detail = '') {
  n += 1;
  if (!ok) failures.push(`${label}${detail === '' ? '' : ` :: ${detail}`}`);
}

// ---------------------------------------------------------------- git setup
const gitProbe = spawnSync('git', ['--version'], { encoding: 'utf8' });
if (gitProbe.status !== 0 || gitProbe.error) {
  console.log(`SKIP: git is not on PATH (${gitProbe.error?.message ?? 'exit ' + gitProbe.status}) — W3 diff collection untestable offline here`);
  process.exit(0);
}

const sh = (args, cwd) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 60000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
const GIT_ENV = ['-c', 'user.name=w3', '-c', 'user.email=w3@t'];
const initRepo = (dir) => {
  mkdirSync(dir, { recursive: true });
  sh(['init', '-q'], dir);
  sh([...GIT_ENV, 'commit', '-q', '--allow-empty', '-m', 'init'], dir);
  return sh(['rev-parse', 'HEAD'], dir).trim();
};
const headOf = (dir) => sh(['rev-parse', 'HEAD'], dir).trim();

// ------------------------------------------------------- mock provider
let mockFn = async () => ({ text: 'noop', exitCode: 0, sessionId: '', costUsd: null });
register({
  id: 'mock',
  run: async (task, onEvent) => mockFn(task, onEvent),
  cancel: async () => undefined,
});

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs = 30000, label = '') {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting: ${label}`);
    await tick(25);
  }
}

const fakeIo = () => ({
  async streamStart() {
    return { push() {}, async finish() {}, async fail() {} };
  },
  async askApproval() {
    return false;
  },
  async notify() {},
});

// ---------------------------------------------------------------- config
const base = mkdtempSync(join(tmpdir(), 'w3-'));
const workRoot = join(base, 'work');
mkdirSync(workRoot, { recursive: true });
const cfg = {
  botToken: 'test',
  allowedChatIds: [111, 112, 113, 114, 115, 116, 117, 118],
  defaultAgent: 'mock',
  defaultModel: '',
  taskTimeoutMs: 30000,
  workRoot,
  allowedRoots: [base],
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
  dbPath: join(base, 'bridge.db'),
  miniPort: 8080,
  miniUrl: '',
};

const dbFile = join(base, 'w3.db');
const store = new Store(dbFile);
const queue = new TaskQueue(store, cfg, fakeIo());

const useProject = (chatId, projectAbs, model = 'm-verify') => {
  store.saveSession({
    chat_id: chatId,
    agent: 'mock',
    model,
    project: projectAbs,
    auto_approve: 0,
    agent_session_id: null,
  });
};
let nextIdHint = 0;
const drive = async (chatId, prompt, options = {}, timeoutMs = 60000) => {
  queue.submit(chatId, prompt, 'code', [], options);
  nextIdHint += 1;
  const t0 = Date.now();
  for (;;) {
    const t = store.getTask(nextIdHint);
    if (t && t.chat_id === chatId && ['done', 'error', 'cancelled'].includes(t.status)) return t;
    // ids may skip (plan turns); scan forward a little
    for (let id = nextIdHint; id <= nextIdHint + 4; id += 1) {
      const c = store.getTask(id);
      if (c && c.chat_id === chatId && ['done', 'error', 'cancelled'].includes(c.status)) {
        nextIdHint = id;
        return c;
      }
    }
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout driving task: ${prompt.slice(0, 40)}`);
    await tick(25);
  }
};

// ---------------------------------------------------------------- AC1: 2 files changed by the task
{
  const repo = join(base, 'r1');
  initRepo(repo);
  writeFileSync(join(repo, 'a.txt'), Array.from({ length: 10 }, (_, i) => `line-${i}`).join('\n') + '\n');
  sh(['add', '-A'], repo);
  sh([...GIT_ENV, 'commit', '-qm', 'base'], repo);
  const shaBefore = headOf(repo);
  useProject(111, repo);
  mockFn = async (task) => {
    appendFileSync(join(task.workdir, 'a.txt'), 'n1\nn2\nn3\n');
    writeFileSync(join(task.workdir, 'b.txt'), 'l1\nl2\nl3\nl4\nl5\n');
    return { text: 'changed two', exitCode: 0, sessionId: '', costUsd: null };
  };
  const done = await drive(111, 'AC1 change two files', { skills: ['gortex-debug'] });
  check('AC1: task done', done.status === 'done', done.status);
  const files = store.taskFiles(done.id);
  check('AC1: exactly 2 task_files rows', files.length === 2, JSON.stringify(files.map((f) => f.path)));
  const a = files.find((f) => f.path === 'a.txt');
  const b = files.find((f) => f.path === 'b.txt');
  check('AC1: a.txt added/removed', a?.added === 3 && a?.removed === 0, JSON.stringify(a));
  check('AC1: b.txt added/removed', b?.added === 5 && b?.removed === 0, JSON.stringify(b));
  check('AC1: git_base_sha is pre-task HEAD', done.git_base_sha === shaBefore, String(done.git_base_sha));
  const summary = store.taskFilesSummary(done.id);
  check('AC1: files_summary changed_n=2', summary.changed_n === 2, JSON.stringify(summary));
  check('AC1: skills_used pinned JSON', done.skills_used === '["gortex-debug"]', String(done.skills_used));
  check('AC1: model/project from session', done.model === 'm-verify' && done.project === repo, `${done.model}|${done.project}`);
  check('AC1: git_before clean (BEFORE precedes writes)', done.git_before === '', JSON.stringify(done.git_before));
  check('AC1: git_after shows the touched files', (done.git_after ?? '').includes('b.txt'), JSON.stringify(done.git_after));
}

// ---------------------------------------------------------------- AC2: unifiedDiff shape + 200-line cap
{
  const repo = join(base, 'r2');
  initRepo(repo);
  writeFileSync(join(repo, 'mod.txt'), 'one\ntwo\n');
  writeFileSync(
    join(repo, 'big.txt'),
    Array.from({ length: 500 }, (_, i) => `big-line-${i}`).join('\n') + '\n',
  );
  sh(['add', '-A'], repo);
  sh([...GIT_ENV, 'commit', '-qm', 'base'], repo);
  appendFileSync(join(repo, 'mod.txt'), 'three\n');
  const d = unifiedDiff(repo, 'mod.txt');
  check('AC2: starts with --- a/', d.diff?.startsWith('--- a/mod.txt') === true, String(d.diff?.slice(0, 60)));
  check('AC2: contains @@ hunk', d.diff?.includes('@@') === true);
  appendFileSync(join(repo, 'big.txt'), Array.from({ length: 400 }, (_, i) => `more-${i}`).join('\n') + '\n');
  const capped = unifiedDiff(repo, 'big.txt');
  const full = unifiedDiff(repo, 'big.txt', 100000);
  const fullLines = full.diff?.split('\n').length ?? -1;
  const m = capped.diff?.match(/…ещё (\d+) строк/);
  check('AC2: 500+ line file truncated', capped.truncated === true && m !== null, `truncated=${capped.truncated}`);
  check('AC2: trailer N is exact', m !== null && Number(m[1]) === fullLines - 200, `N=${m?.[1]} full=${fullLines}`);
  check('AC2: stored ≤ 200 content lines + trailer', (capped.diff?.split('\n').length ?? 999) <= 201);
}

// ---------------------------------------------------------------- AC3: binary file
{
  const repo = join(base, 'r3');
  initRepo(repo);
  writeFileSync(join(repo, 'keep.txt'), 'keep\n');
  sh(['add', '-A'], repo);
  sh([...GIT_ENV, 'commit', '-qm', 'base'], repo);
  useProject(113, repo);
  mockFn = async (task) => {
    writeFileSync(
      join(task.workdir, 'img.png'),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x01, 0x02]),
    );
    return { text: 'binary added', exitCode: 0, sessionId: '', costUsd: null };
  };
  const done = await drive(113, 'AC3 binary file');
  const files = store.taskFiles(done.id);
  const img = files.find((f) => f.path === 'img.png');
  check('AC3: binary flag set', img?.binary === 1, JSON.stringify(img));
  check('AC3: diff IS NULL', img?.diff === null, String(img?.diff)?.slice(0, 40));
}

// ---------------------------------------------------------------- AC4: non-git dir
{
  const plain = join(base, 'nogit');
  mkdirSync(plain, { recursive: true });
  writeFileSync(join(plain, 'note.txt'), 'hello\n');
  useProject(114, plain);
  mockFn = async (task) => {
    writeFileSync(join(task.workdir, 'new.txt'), 'x\n');
    return { text: 'noop', exitCode: 0, sessionId: '', costUsd: null };
  };
  const done = await drive(114, 'AC4 non-git dir');
  check('AC4: task done', done.status === 'done', done.status);
  check('AC4: git_base_sha IS NULL', done.git_base_sha === null, String(done.git_base_sha));
  check('AC4: task_files empty', store.taskFiles(done.id).length === 0);
}

// ---------------------------------------------------------------- AC5: failed task still snapshots
{
  const repo = join(base, 'r5');
  initRepo(repo);
  writeFileSync(join(repo, 'v.txt'), 'v1\n');
  sh(['add', '-A'], repo);
  sh([...GIT_ENV, 'commit', '-qm', 'base'], repo);
  useProject(115, repo);
  mockFn = async (task) => {
    writeFileSync(join(task.workdir, 'partial.txt'), 'p1\np2\n');
    throw new Error('E_AGENT_FAILED: boom');
  };
  const fin = await drive(115, 'AC5 failing task');
  check('AC5: status error', fin.status === 'error', fin.status);
  check('AC5: snapshots present', fin.git_before !== null && fin.git_base_sha !== null, String(fin.git_base_sha));
  const files = store.taskFiles(fin.id);
  check('AC5: task_files collected', files.length === 1 && files[0].path === 'partial.txt', JSON.stringify(files.map((f) => f.path)));
}

// ---------------------------------------------------------------- AC6: > 50 files → 50 rows, full counters
{
  const repo = join(base, 'r6');
  initRepo(repo);
  useProject(116, repo);
  mockFn = async (task) => {
    for (let i = 0; i < 60; i += 1) {
      writeFileSync(join(task.workdir, `f${String(i).padStart(2, '0')}.txt`), `a${i}\nb${i}\n`);
    }
    return { text: 'many', exitCode: 0, sessionId: '', costUsd: null };
  };
  const done = await drive(116, 'AC6 sixty files', {}, 120000);
  const files = store.taskFiles(done.id);
  const summary = store.taskFilesSummary(done.id);
  check('AC6: 50 rows in DB', files.length === 50, String(files.length));
  check('AC6: changed_n holds full count', summary.changed_n === 60, JSON.stringify(summary));
  check('AC6: totals cover all files', summary.added === 120 && summary.removed === 0, JSON.stringify(summary));
}

// ---------------------------------------------------------------- AC7: git absent from PATH
{
  const repo = join(base, 'r7');
  initRepo(repo);
  writeFileSync(join(repo, 'g.txt'), 'g\n');
  sh(['add', '-A'], repo);
  sh([...GIT_ENV, 'commit', '-qm', 'base'], repo);
  useProject(117, repo);
  mockFn = async () => ({ text: 'nopath', exitCode: 0, sessionId: '', costUsd: null });
  const savedPath = process.env.PATH ?? '';
  const emptyDir = mkdtempSync(join(tmpdir(), 'w3-empty-path-'));
  process.env.PATH = emptyDir;
  let done;
  try {
    done = await drive(117, 'AC7 no git on PATH');
  } finally {
    process.env.PATH = savedPath;
  }
  check('AC7: task done without git', done.status === 'done', done.status);
  check('AC7: no_git (sha NULL, no rows)', done.git_base_sha === null && store.taskFiles(done.id).length === 0);
  check('AC7: process alive after', snapshotGit(repo) !== null);
}

// ---------------------------------------------------------------- AC8: title (surrogate-safe) + rev bumps
{
  const repo = join(base, 'r8');
  initRepo(repo);
  useProject(118, repo, 'm8');
  mockFn = async () => ({ text: 't', exitCode: 0, sessionId: '', costUsd: null });
  const prompt = `${'T'.repeat(59)}😀 tail text that must be cut off`;
  const expectedTitle = `${'T'.repeat(59)}😀`;
  const fin = await drive(118, prompt);
  check('AC8: title is 60 code points, emoji intact', fin.title === expectedTitle, JSON.stringify(fin.title));
  check('AC8: title length 60 code points', [...(fin.title ?? '')].length === 60, String([...(fin.title ?? '')].length));
  check('AC8: no lone surrogate at cut', !/[\ud800-\udbff]$/.test(fin.title ?? ''), JSON.stringify((fin.title ?? '').slice(-3)));
  check('AC8: rev bumped ≥ 3 over lifecycle', (fin.rev ?? 0) >= 3, String(fin.rev));
  check('AC8: taskTitle unit keeps pair', taskTitle(prompt) === expectedTitle);
}

// ---------------------------------------------------------------- B1a: pre-existing dirt is NOT the task's
{
  const repo = join(base, 'r-b1a');
  initRepo(repo);
  writeFileSync(join(repo, 'base.txt'), 'base\n');
  sh(['add', '-A'], repo);
  sh([...GIT_ENV, 'commit', '-qm', 'base'], repo);
  writeFileSync(join(repo, 'dirty.txt'), ' чужое\ndirt\n'); // dirt BEFORE the task
  useProject(119, repo);
  mockFn = async (task) => {
    writeFileSync(join(task.workdir, 'other.txt'), 'o1\no2\no3\n');
    return { text: 'only other', exitCode: 0, sessionId: '', costUsd: null };
  };
  const done = await drive(119, 'B1a pre-existing dirt');
  const files = store.taskFiles(done.id);
  check('B1a: only the task-touched file stored', files.length === 1 && files[0].path === 'other.txt', JSON.stringify(files.map((f) => f.path)));
  check('B1a: dirty.txt excluded', files.every((f) => f.path !== 'dirty.txt'));
}

// ---------------------------------------------------------------- B1b: plan-turn writes survive approve
{
  const repo = join(base, 'r-b1b');
  initRepo(repo);
  writeFileSync(join(repo, 'base.txt'), 'base\n');
  sh(['add', '-A'], repo);
  sh([...GIT_ENV, 'commit', '-qm', 'base'], repo);
  useProject(120, repo);
  mockFn = async (task) => {
    if (task.prompt.startsWith('Plan first')) {
      writeFileSync(join(task.workdir, 'planmade.txt'), 'from plan turn\n');
      return { text: 'the plan', exitCode: 0, sessionId: '', costUsd: null };
    }
    writeFileSync(join(task.workdir, 'impl.txt'), 'from impl run\n');
    return { text: 'impl done', exitCode: 0, sessionId: '', costUsd: null };
  };
  queue.submit(120, 'B1b plan flow', 'code', [], { planOnly: true });
  nextIdHint += 1;
  const parked = await waitFor(() => store.awaitingPlan(120), 30000, 'plan parks (b1b)');
  check('B1b: plan parked', parked?.plan_text === 'the plan', String(parked?.plan_text));
  const tid = queue.approvePlan(120);
  check('B1b: approve returns same task', tid === parked?.id, String(tid));
  const t0 = Date.now();
  let fin;
  for (;;) {
    const c = tid != null ? store.getTask(tid) : undefined;
    if (c && ['done', 'error', 'cancelled'].includes(c.status)) {
      fin = c;
      break;
    }
    if (Date.now() - t0 > 60000) throw new Error('timeout B1b impl run');
    await tick(25);
  }
  const paths = store.taskFiles(fin.id).map((f) => f.path);
  check('B1b: plan-turn file still attributed', paths.includes('planmade.txt'), JSON.stringify(paths));
  check('B1b: impl-run file attributed', paths.includes('impl.txt'), JSON.stringify(paths));
}

// ---------------------------------------------------------------- B2: new file in a new subdir
{
  const repo = join(base, 'r-b2');
  initRepo(repo);
  writeFileSync(join(repo, 'base.txt'), 'base\n');
  sh(['add', '-A'], repo);
  sh([...GIT_ENV, 'commit', '-qm', 'base'], repo);
  useProject(121, repo);
  mockFn = async (task) => {
    mkdirSync(join(task.workdir, 'sub'), { recursive: true });
    writeFileSync(join(task.workdir, 'sub', "q'q.txt"), 'quoted content\n');
    return { text: 'subdir', exitCode: 0, sessionId: '', costUsd: null };
  };
  const done = await drive(121, 'B2 new subdir file');
  const files = store.taskFiles(done.id);
  const hit = files.find((f) => f.path === "sub/q'q.txt");
  check('B2: real relative path stored (no sub/ phantom)', hit !== undefined, JSON.stringify(files.map((f) => f.path)));
  check('B2: diff non-empty with content', (hit?.diff ?? '').includes('quoted content'), String(hit?.diff)?.slice(0, 80));
}

// ---------------------------------------------------------------- M1: mid-run commit keeps changes visible
{
  const repo = join(base, 'r-m1');
  initRepo(repo);
  writeFileSync(join(repo, 'm.txt'), 'm0\n');
  sh(['add', '-A'], repo);
  sh([...GIT_ENV, 'commit', '-qm', 'base'], repo);
  const shaBefore = headOf(repo);
  useProject(122, repo);
  mockFn = async (task) => {
    appendFileSync(join(task.workdir, 'm.txt'), 'midrun\n');
    execFileSync('git', [...GIT_ENV, 'add', '-A'], { cwd: task.workdir, timeout: 30000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    execFileSync('git', [...GIT_ENV, 'commit', '-qm', 'mid'], { cwd: task.workdir, timeout: 30000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    return { text: 'committed mid-run', exitCode: 0, sessionId: '', costUsd: null };
  };
  const done = await drive(122, 'M1 mid-run commit');
  check('M1: HEAD moved during task', done.git_base_sha === shaBefore && headOf(repo) !== shaBefore, String(done.git_base_sha));
  const files = store.taskFiles(done.id);
  const m = files.find((f) => f.path === 'm.txt');
  check('M1: committed change still recorded', m !== undefined && m.added === 1, JSON.stringify(m));
}

// ---------------------------------------------------------------- M2: staged rename keeps both sides
{
  const repo = join(base, 'r-m2');
  initRepo(repo);
  writeFileSync(join(repo, 'old.txt'), 'r1\nr2\n');
  sh(['add', '-A'], repo);
  sh([...GIT_ENV, 'commit', '-qm', 'base'], repo);
  sh(['mv', 'old.txt', 'new.txt'], repo);
  appendFileSync(join(repo, 'new.txt'), 'r3\n');
  const sha = headOf(repo);
  const after = snapshotGit(repo);
  const files = collectTaskFiles({ sha, porcelain: '', sigs: {} }, after, repo);
  const paths = files.map((f) => f.path).sort();
  const old = files.find((f) => f.path === 'old.txt');
  const nw = files.find((f) => f.path === 'new.txt');
  check('M2: both rename sides collected', JSON.stringify(paths) === '["new.txt","old.txt"]', JSON.stringify(paths));
  check('M2: old side records removal, new side addition', (old?.removed ?? 0) === 2 && (nw?.added ?? 0) >= 1, JSON.stringify(files.map((f) => [f.path, f.added, f.removed])));
}

// ---------------------------------------------------------------- M3: Cyrillic filename verbatim
{
  const repo = join(base, 'r-m3');
  initRepo(repo);
  writeFileSync(join(repo, 'base.txt'), 'base\n');
  sh(['add', '-A'], repo);
  sh([...GIT_ENV, 'commit', '-qm', 'base'], repo);
  useProject(123, repo);
  mockFn = async (task) => {
    writeFileSync(join(task.workdir, 'uni-файл.txt'), 'кириллица-контент\n');
    return { text: 'cyrillic', exitCode: 0, sessionId: '', costUsd: null };
  };
  const done = await drive(123, 'M3 cyrillic name');
  const files = store.taskFiles(done.id);
  const hit = files.find((f) => f.path === 'uni-файл.txt');
  check('M3: path stored verbatim (no octal escape)', hit !== undefined, JSON.stringify(files.map((f) => f.path)));
  check('M3: diff non-empty', (hit?.diff ?? '').includes('кириллица-контент'), String(hit?.diff)?.slice(0, 80));
}

// ---------------------------------------------------------------- M4: NUL past the 8 KB probe
{
  const repo = join(base, 'r-m4');
  initRepo(repo);
  writeFileSync(join(repo, 'base.txt'), 'base\n');
  sh(['add', '-A'], repo);
  sh([...GIT_ENV, 'commit', '-qm', 'base'], repo);
  useProject(124, repo);
  mockFn = async (task) => {
    writeFileSync(join(task.workdir, 'late-nul.bin'), `${'A'.repeat(8500)}\0tail\n`);
    return { text: 'late nul', exitCode: 0, sessionId: '', costUsd: null };
  };
  const done = await drive(124, 'M4 late NUL byte');
  const files = store.taskFiles(done.id);
  const hit = files.find((f) => f.path === 'late-nul.bin');
  check('M4: binary:true past probe window', hit?.binary === 1, JSON.stringify(hit));
  check('M4: diff IS NULL (no raw leak)', hit?.diff === null, String(hit?.diff)?.slice(0, 40));
}

// ---------------------------------------------------------------- M6: overall budget trips on a past deadline
{
  const repo = join(base, 'r-m6');
  initRepo(repo);
  writeFileSync(join(repo, 'x.txt'), 'x\n');
  sh(['add', '-A'], repo);
  sh([...GIT_ENV, 'commit', '-qm', 'base'], repo);
  appendFileSync(join(repo, 'x.txt'), 'y\n');
  writeFileSync(join(repo, 'z.txt'), 'z\n');
  const sha = headOf(repo);
  const after = snapshotGit(repo);
  const files = collectTaskFiles({ sha, porcelain: '', sigs: {} }, after, repo, Date.now() - 1);
  check('M6: expired budget marks all remaining truncated', files.length === 2 && files.every((f) => f.truncated === true && f.diff === null), JSON.stringify(files.map((f) => [f.path, f.truncated])));
}

// ---------------------------------------------------------------- R2-MAJOR: restart between park and approve
{
  const repo = join(base, 'r-r2');
  initRepo(repo);
  writeFileSync(join(repo, 'base.txt'), 'base\n');
  sh(['add', '-A'], repo);
  sh([...GIT_ENV, 'commit', '-qm', 'base'], repo);
  useProject(125, repo);
  const planImplMock = async (task) => {
    if (task.prompt.startsWith('Plan first')) {
      writeFileSync(join(task.workdir, 'planmade.txt'), 'from plan turn\n');
      return { text: 'the plan', exitCode: 0, sessionId: '', costUsd: null };
    }
    writeFileSync(join(task.workdir, 'impl.txt'), 'from impl run\n');
    return { text: 'impl done', exitCode: 0, sessionId: '', costUsd: null };
  };
  mockFn = planImplMock;
  queue.submit(125, 'R2 restart mid-approval', 'code', [], { planOnly: true });
  nextIdHint += 1;
  const parked = await waitFor(() => store.awaitingPlan(125), 30000, 'plan parks (r2)');
  check('R2: plan parked before restart', parked?.plan_text === 'the plan', String(parked?.plan_text));
  const tid = parked?.id ?? -1;
  // Full restart: close the DB, reopen on the same file, brand-new queue
  // (in-memory planSnaps lost; restorePlans rebuilds only planWaiting).
  store.close();
  const store2 = new Store(dbFile);
  const queue2 = new TaskQueue(store2, cfg, fakeIo());
  check('R2: parked plan visible after reopen', store2.awaitingPlan(125)?.id === tid, String(store2.awaitingPlan(125)?.id));
  const approved = queue2.approvePlan(125);
  check('R2: approve after reopen returns task', approved === tid, String(approved));
  const t0 = Date.now();
  let fin;
  for (;;) {
    const c = store2.getTask(tid);
    if (c && ['done', 'error', 'cancelled'].includes(c.status)) {
      fin = c;
      break;
    }
    if (Date.now() - t0 > 60000) throw new Error('timeout R2 impl run');
    await tick(25);
  }
  check('R2: impl run done', fin.status === 'done', fin.status);
  const paths = store2.taskFiles(fin.id).map((f) => f.path);
  check('R2: plan-turn file attributed after restart', paths.includes('planmade.txt'), JSON.stringify(paths));
  check('R2: impl-run file attributed after restart', paths.includes('impl.txt'), JSON.stringify(paths));
  check('R2: park-time snapshot consumed (cleared)', store2.getTask(tid)?.plan_diff_before === null, String(store2.getTask(tid)?.plan_diff_before));
  store2.close();
}

// ------------------------------------------------- snapshot timing: 500-file repo
{
  const repo = join(base, 'rbig');
  initRepo(repo);
  for (let i = 0; i < 500; i += 1) {
    writeFileSync(join(repo, `p${String(i).padStart(3, '0')}.txt`), `content ${i}\n`);
  }
  sh(['add', '-A'], repo);
  sh([...GIT_ENV, 'commit', '-qm', '500 files'], repo);
  const t0 = Date.now();
  const snap = snapshotGit(repo);
  const elapsed = Date.now() - t0;
  check('timing: snapshot non-null on 500-file repo', snap !== null);
  check('timing: snapshot < 2 s', elapsed < 2000, `${elapsed} ms`);
  const files = collectTaskFiles(snap, snap, repo);
  check('timing: clean tree collects nothing', files.length === 0);
  check('timing: summarizeFiles shape', JSON.stringify(summarizeFiles(files)) === '{"changed_n":0,"added":0,"removed":0}');
}

// ------------------------------------------------- no new runtime deps (plan rule §8.4)
{
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const deps = Object.keys(pkg.dependencies ?? {}).sort();
  check('deps: only better-sqlite3 + grammy', JSON.stringify(deps) === '["better-sqlite3","grammy"]', deps.join(','));
}

// Both stores are closed by the R2 restart block (a mid-harness failure
// exits via process.exit(1) without cleanup, like the other harnesses).

console.log(`\n${n - failures.length}/${n} passed`);
if (failures.length > 0) {
  console.log('FAILURES:');
  for (const f of failures) console.log('  -', f);
  process.exit(1);
}
console.log('ALL GREEN');
