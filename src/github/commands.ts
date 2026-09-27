/**
 * Handlers for the four GitHub-facing chat commands — /commit, /pr, /ci, /watch
 * (ARCHITECTURE.md §1.6).
 *
 * They live here rather than in `src/core/router.ts` so that Core stays a thin
 * command table and no Telegram or grammy type leaks into the GitHub layer: every
 * handler takes plain arguments (workdir strings, chat ids) and returns a finished
 * reply string. Only the router knows what a `ctx` is.
 *
 * Every failure is mapped to one short human sentence. `/commit` mid-flight in a
 * half-broken repo must never surface a git stack trace to the owner's phone.
 */

import { GitHubClient, isBranchName, isRepoSlug, runStatus, type WorkflowRun } from './client.js';
import {
  buildCommitArgs,
  currentBranch,
  hasUpstream,
  isGitRepo,
  remoteSlug,
  runGit,
} from './git.js';
import { sanitize } from '../gateway/spawnRunner.js';
import type { Store } from '../storage/db.js';

/** Telegram answers must stay well under 4096 chars; a CI list is 5 lines. */
const CI_RUNS = 5;

export interface HandlerDeps {
  cfg: { githubToken: string };
  store: Store;
}

/** One place that turns a GitHub throw into a sentence, never a stack. */
function ghError(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  if (m === 'E_NO_GITHUB_TOKEN') {
    return '❌ Нет GITHUB_TOKEN. Добавь его в .env на ПК и перезапусти бота.';
  }
  if (m === 'E_GH_NOT_FOUND') return '❌ Репозиторий или PR не найден / нет доступа.';
  if (m === 'E_GH_FORBIDDEN') return '⛔ GitHub отклонил запрос — лимит или истёкший токен.';
  const http = /^E_GH_HTTP_(\d+)$/.exec(m);
  if (http) return `❌ GitHub вернул HTTP ${http[1]}.`;
  return '❌ Не удалось обратиться к GitHub.';
}

/** Distinct short replies for the interesting git failure modes of a push. */
function pushFailureMessage(stderr: string): string {
  const s = stderr.toLowerCase();
  if (s.includes('no upstream') || s.includes('has no upstream branch')) {
    return '❌ E_GIT_NO_UPSTREAM: у ветки нет upstream. Задай его на ПК (git push -u origin <ветка>).';
  }
  if (s.includes('non-fast-forward') || s.includes('rejected') || s.includes('fetch first')) {
    return '❌ E_GIT_PUSH_REJECTED: пуш отклонён (ветка разошлась). Сделай pull/rebase на ПК.';
  }
  if (
    s.includes('could not read username') ||
    s.includes('authentication failed') ||
    s.includes('permission denied') ||
    s.includes('access denied') ||
    s.includes('invalid username or password')
  ) {
    return '❌ E_GIT_AUTH: у git на ПК нет валидных credentials. Проверь gh auth login.';
  }
  if (s.includes('could not resolve host') || s.includes('network is unreachable')) {
    return '❌ E_GIT_NETWORK: нет связи с GitHub.';
  }
  return `❌ E_GIT_PUSH: пуш не удался. ${sanitize(stderr, 160)}`;
}

// ------------------------------------------------------------- /commit

export async function handleCommit(
  deps: HandlerDeps,
  workdir: string,
  message: string,
): Promise<string> {
  const msg = message.trim();
  if (msg === '') return 'Использование: /commit <сообщение>';

  if (!(await isGitRepo(workdir))) {
    return '❌ E_GIT_NOT_REPO: это не git-репозиторий. Сначала /clone или /project.';
  }

  const added = await runGit(workdir, ['add', '-A']);
  if (added.timedOut) return '⏱ git add не ответил за 2 минуты.';
  if (added.code !== 0) return `❌ E_GIT_ADD: ${sanitize(added.stderr, 160)}`;

  // The message is a single argv element all the way down — see buildCommitArgs.
  const commit = await runGit(workdir, buildCommitArgs(msg));
  if (commit.timedOut) return '⏱ git commit не ответил за 2 минуты.';
  if (commit.code !== 0) {
    const s = commit.stderr.toLowerCase();
    if (s.includes('nothing to commit') || commit.stdout.toLowerCase().includes('nothing to commit')) {
      return '📭 Коммитить нечего — рабочее дерево чистое.';
    }
    if (s.includes('please tell me who you are')) {
      return '❌ E_GIT_IDENTITY: git не знает user.name/user.email. Настрой их на ПК.';
    }
    return `❌ E_GIT_COMMIT: ${sanitize(commit.stderr, 160)}`;
  }

  const push = await runGit(workdir, ['push']);
  if (push.timedOut) return '⏱ git push не ответил за 2 минуты.';
  if (push.code !== 0) return pushFailureMessage(push.stderr);

  const sha = await runGit(workdir, ['rev-parse', '--short', 'HEAD'], 15_000);
  const short = sha.code === 0 ? sha.stdout.trim() : '?';
  const branch = (await currentBranch(workdir)) ?? '?';
  // Echo only the first line, bounded: the message is unbounded chat input.
  const firstLine = (msg.split('\n')[0] ?? '').slice(0, 200);
  return `✅ ${short} → ${branch}\n${firstLine}`;
}

// ----------------------------------------------------------------- /pr

export async function handlePr(
  deps: HandlerDeps,
  workdir: string,
  titleArg: string,
): Promise<string> {
  if (!(await isGitRepo(workdir))) {
    return '❌ E_GIT_NOT_REPO: это не git-репозиторий. Сначала /clone или /project.';
  }

  const repo = await remoteSlug(workdir);
  if (repo === null || !isRepoSlug(repo)) {
    return '❌ E_GH_REMOTE: origin не похож на репозиторий GitHub (owner/repo).';
  }

  const head = await currentBranch(workdir);
  if (head === null) return '❌ E_GIT_DETACHED: не на ветке (detached HEAD).';

  const client = new GitHubClient(deps.cfg.githubToken);

  let base: string;
  try {
    base = await client.defaultBranch(repo);
  } catch (e) {
    return ghError(e);
  }

  // A PR from the default branch onto itself is never what the owner meant.
  if (head === base) {
    return `🚫 Текущая ветка (${base}) — дефолтная. Сначала переключись на рабочую ветку.`;
  }

  const remoteCheck = await runGit(workdir, ['remote', 'get-url', 'origin'], 15_000);
  const hasRemote = remoteCheck.code === 0;

  let pushed = false;
  if (hasRemote) {
    const upstream = await hasUpstream(workdir);
    const pushArgs = upstream ? ['push'] : ['push', '-u', 'origin', head];
    const push = await runGit(workdir, pushArgs);
    if (push.timedOut) return '⏱ git push не ответил за 2 минуты.';
    if (push.code !== 0) return pushFailureMessage(push.stderr);
    pushed = true;
  }

  let title = titleArg.trim();
  if (title === '') {
    const log = await runGit(workdir, ['log', '-1', '--pretty=%s'], 15_000);
    title = log.code === 0 ? log.stdout.trim() : '';
  }
  if (title === '') title = head;

  try {
    // A duplicate PR is a bad UX: report the open one instead of failing.
    const existing = await client.findOpenPr(repo, head);
    if (existing) return `ℹ️ PR уже открыт:\n${existing.html_url}`;

    const pr = await client.createPullRequest({ repo, title, head, base, body: '' });
    const note = pushed ? '' : '\n(push не выполнялся: нет remote)';
    return `✅ PR #${pr.number} ${head} → ${base}\n${pr.html_url}${note}`;
  } catch (e) {
    return ghError(e);
  }
}

// ---------------------------------------------------------------- /ci

function emoji(status: string): string {
  if (status === 'success') return '🟢';
  if (status === 'failure' || status === 'timed_out' || status === 'startup_failure') return '🔴';
  if (status === 'cancelled' || status === 'skipped' || status === 'neutral' || status === 'stale') {
    return '⚪';
  }
  return '🟡';
}

function renderRuns(repo: string, runs: WorkflowRun[], branch = ''): string {
  const head = branch === '' ? `CI ${repo}` : `CI ${repo} (${branch})`;
  if (runs.length === 0) return `${head}: запусков нет.`;
  const lines = runs.map((r) => {
    const status = runStatus(r);
    const br = r.head_branch === '' ? '' : ` ${r.head_branch}`;
    const sha = r.head_sha.slice(0, 7);
    const name = r.name === '' ? '(workflow)' : r.name;
    return `${emoji(status)} ${status}${br} ${sha} — ${name}\n${r.html_url}`;
  });
  return `${head}\n${lines.join('\n')}`;
}

export async function handleCi(deps: HandlerDeps, repoArg: string): Promise<string> {
  const parts = repoArg.trim().split(/\s+/).filter((w) => w !== '');
  const repo = parts[0] ?? '';
  if (repo === '') return 'Использование: /ci <owner/repo> [ветка]';
  if (!isRepoSlug(repo)) return '❌ E_GH_SLUG: нужен формат owner/repo.';

  // Extra words beyond the branch are ignored — the router already passes the
  // whole tail, and a pasted URL with trailing junk must not become API input.
  const branch = parts[1] ?? '';
  if (branch !== '' && !isBranchName(branch)) {
    return '❌ E_GH_BRANCH: странное имя ветки (буквы, цифры, . _ - /).';
  }

  const client = new GitHubClient(deps.cfg.githubToken);
  try {
    const runs = await client.latestRuns(repo, branch, CI_RUNS);
    return renderRuns(repo, runs, branch);
  } catch (e) {
    return ghError(e);
  }
}

// ------------------------------------------------------------- /watch

export async function handleWatch(
  deps: HandlerDeps,
  chatId: number,
  repoArg: string,
  branchArg = '',
): Promise<string> {
  const repo = repoArg.trim();
  if (repo === '') return 'Использование: /watch <owner/repo> [ветка]';
  if (!isRepoSlug(repo)) return '❌ E_GH_SLUG: нужен формат owner/repo.';

  const branch = branchArg.trim();
  if (branch !== '' && !isBranchName(branch)) {
    return '❌ E_GH_BRANCH: странное имя ветки (буквы, цифры, . _ - /).';
  }
  const { store } = deps;

  if (store.getCiWatch(chatId, repo)) {
    store.removeCiWatch(chatId, repo);
    return `🔕 Выключил наблюдение за ${repo}.`;
  }

  store.addCiWatch(chatId, repo, branch);

  // Seed the current status so the first poll does not DM a verdict the owner
  // already sees. Only state is written — the schema is untouched, and a failed
  // seed is not fatal (the first poll then reports normally).
  let seeded = '';
  try {
    const runs = await new GitHubClient(deps.cfg.githubToken).latestRuns(repo, branch, 1);
    const run = runs[0];
    if (run) {
      seeded = ` Сейчас: ${emoji(runStatus(run))} ${runStatus(run)}`;
      store.updateCiWatchState(chatId, repo, runStatus(run), run.id);
    }
  } catch {
    // no token / rate limit / bad repo: /watch still works, polling just starts cold.
  }

  return `🔔 Включил наблюдение за ${repo}${branch === '' ? '' : ` (${branch})`}.${seeded}\nПроверяю каждые 5 мин, сообщу при смене статуса.`;
}
