/**
 * Local-git plumbing for the /commit and /pr commands (ARCHITECTURE.md §1.6).
 *
 * Rules this file exists to enforce:
 *  - every git invocation is an argv array, never a shell string: the commit
 *    message is untrusted chat input and must stay exactly one argument;
 *  - every invocation has a timeout, so a credential prompt can never wedge the
 *    chat loop waiting for stdin that will never come;
 *  - stderr is sanitized before it reaches the user, and secrets are never
 *    placed in the child environment (spawnRunner's blocklist owns that).
 *
 * No `gh` CLI, no new dependency: `node:child_process` only.
 */

import { spawn } from 'node:child_process';

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
  /** True when the child was killed by our own deadline rather than exiting. */
  timedOut: boolean;
}

/** Two minutes is generous for a local commit and stops a hanging credential prompt. */
export const GIT_TIMEOUT_MS = 120_000;

/**
 * Env for a git child. `GIT_TERMINAL_PROMPT=0` turns "asking for a password" into a
 * fast, readable failure instead of a hang on a machine with no TTY.
 * `GIT_ASKPASS` would be inherited from the parent otherwise, so it is dropped.
 */
function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat' };
  delete env.GIT_ASKPASS;
  return env;
}

/**
 * Run `git <args...>` in `workdir`. Resolves (never rejects) with the exit code,
 * captured stdout/stderr and a timeout flag — callers branch on `code`, so a
 * non-zero git exit is data, not an exception.
 */
export function runGit(workdir: string, args: string[], timeoutMs = GIT_TIMEOUT_MS): Promise<GitResult> {
  return new Promise((resolveDone) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const child = spawn('git', args, {
      cwd: workdir,
      env: gitEnv(),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(kill);
      resolveDone({ code, stdout, stderr, timedOut });
    };

    const kill = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('error', () => {
      // git missing from PATH, or the workdir vanished between stat and spawn.
      finish(-1);
    });
    child.on('close', (code) => finish(code ?? -1));
  });
}

/** Last non-empty line, trimmed — git likes to end output with a newline. */
const lastLine = (s: string): string =>
  s
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .pop() ?? '';

/**
 * Build the argv for a commit. Split out (and exported) purely so the harness can
 * assert that a hostile message lands in exactly one slot — the whole point of
 * never using a shell string.
 */
export function buildCommitArgs(message: string): string[] {
  return ['commit', '-m', message];
}

/**
 * `owner/repo` from a git remote URL, or null when the remote is not GitHub.
 * Handles the three shapes git actually produces:
 *   git@github.com:x/y.git   https://github.com/x/y.git   ssh://git@github.com/x/y
 * A non-GitHub host (self-hosted, GitLab, a local path) deliberately returns null
 * so `/pr` fails with a sentence instead of posting to the wrong API.
 */
export function parseRemoteUrl(url: string): string | null {
  const raw = url.trim();
  if (raw === '') return null;

  let path = '';
  const scp = /^[A-Za-z0-9._-]+@([^:/]+):(.+)$/.exec(raw);
  if (scp) {
    const host = scp[1] ?? '';
    if (host.toLowerCase() !== 'github.com') return null;
    path = scp[2] ?? '';
  } else {
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      return null;
    }
    const host = parsed.hostname.replace(/^www\./i, '');
    if (host.toLowerCase() !== 'github.com') return null;
    path = parsed.pathname.replace(/^\/+/, '');
  }

  path = path.replace(/\.git$/i, '').replace(/\/+$/, '');
  const parts = path.split('/');
  if (parts.length < 2) return null;
  return `${parts[0]}/${parts[1]}`;
}

/** Current branch name, or null on a detached HEAD / empty repo. */
export async function currentBranch(workdir: string): Promise<string | null> {
  const r = await runGit(workdir, ['rev-parse', '--abbrev-ref', 'HEAD'], 15_000);
  if (r.code !== 0) return null;
  const name = r.stdout.trim();
  return name === '' || name === 'HEAD' ? null : name;
}

export async function isGitRepo(workdir: string): Promise<boolean> {
  const r = await runGit(workdir, ['rev-parse', '--is-inside-work-tree'], 15_000);
  return r.code === 0 && r.stdout.trim() === 'true';
}

/** `owner/repo` for the repo at `workdir`, or null when origin is absent/not GitHub. */
export async function remoteSlug(workdir: string): Promise<string | null> {
  const r = await runGit(workdir, ['remote', 'get-url', 'origin'], 15_000);
  if (r.code !== 0) return null;
  return parseRemoteUrl(r.stdout);
}

/** True when the current branch has an upstream configured. */
export async function hasUpstream(workdir: string): Promise<boolean> {
  const r = await runGit(
    workdir,
    ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
    15_000,
  );
  return r.code === 0;
}
