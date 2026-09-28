import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { childEnv, sanitize } from '../gateway/spawnRunner.js';

/**
 * `/update` (risky, owner-only, double-confirmed via inline buttons).
 *
 * Flow: report `git rev-parse --short HEAD`, run `git pull` + `npm i` +
 * `npm run build` + `tsc` in the repo dir with per-step timeouts, then spawn
 * the DETACHED `scripts/updater.cmd` (it waits for our exit, pulls/builds
 * again if needed, restarts `npm run dev`) and `process.exit(0)`.
 *
 * Child-process rules: `git` is a real exe and runs via argv; `npm` on
 * Windows is a `.cmd` shim (bare spawn throws EINVAL), so the npm steps go
 * through `cmd.exe /c` with FIXED strings — chat input never enters a shell
 * string. Child env comes from `childEnv()` (no BOT_TOKEN/GITHUB_TOKEN).
 * Step output tails are sanitized before they reach the chat.
 */

/** Minimal chat sink so Core stays free of grammy types. */
export interface UpdateUi {
  reply(text: string): Promise<unknown>;
}

export interface StepResult {
  label: string;
  ok: boolean;
  /** Exit code; null when the step failed to start or timed out. */
  code: number | null;
  /** Sanitized tail of the combined output, for the chat on failure. */
  tail: string;
}

export interface StepDef {
  label: string;
  timeoutMs: number;
  run: () => Promise<{ code: number | null; out: string }>;
}

const TAIL_CHARS = 500;

function tailOf(out: string): string {
  const t = out.trim().replace(/\s+/g, ' ');
  return sanitize(t.length > TAIL_CHARS ? t.slice(t.length - TAIL_CHARS) : t, TAIL_CHARS);
}

function collect(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<{ code: number | null; out: string }> {
  return new Promise((resolvePromise) => {
    let out = '';
    let done = false;
    const finish = (code: number | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolvePromise({ code, out });
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {
        // already gone
      }
      finish(null);
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => {
      if (out.length < 8000) out += d;
    });
    child.stderr?.on('data', (d: string) => {
      if (out.length < 8000) out += d;
    });
    child.on('error', () => finish(null));
    child.on('close', (code) => finish(code));
  });
}

/** argv spawn; used for real exes (`git`). Exported for the offline harness. */
export function runArgv(
  bin: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ code: number | null; out: string }> {
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(bin, args, { cwd, env: childEnv(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    return Promise.resolve({ code: null, out: '' });
  }
  return collect(child, timeoutMs);
}

/**
 * Fixed-command run via `cmd.exe /c`. Only for fully fixed strings (`npm …`) —
 * NEVER pass chat input here. Exported for the offline harness.
 */
export function runCmdFixed(cmd: string, cwd: string, timeoutMs: number): Promise<{ code: number | null; out: string }> {
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn('cmd.exe', ['/d', '/s', '/c', cmd], {
      cwd,
      env: childEnv(),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return Promise.resolve({ code: null, out: '' });
  }
  return collect(child, timeoutMs);
}

/** The repo checkout the bot runs from. */
export function repoDir(): string {
  return resolve(process.cwd());
}

/** Absolute path of the detached updater script. */
export function updaterScript(repo: string): string {
  return join(repo, 'scripts', 'updater.cmd');
}

/** Short HEAD hash, or 'unknown' outside a git checkout. Never throws. */
export async function versionHash(repo: string): Promise<string> {
  try {
    const r = await runArgv('git', ['rev-parse', '--short', 'HEAD'], repo, 15_000);
    const h = r.out.trim();
    return /^[0-9a-f]{4,40}$/i.test(h) ? h : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** The in-process pre-update sequence from the spec. */
export function preUpdateStepDefs(repo: string): StepDef[] {
  return [
    { label: 'git pull', timeoutMs: 120_000, run: () => runArgv('git', ['pull', '--ff-only'], repo, 120_000) },
    { label: 'npm i', timeoutMs: 600_000, run: () => runCmdFixed('npm i --no-audit --no-fund', repo, 600_000) },
    { label: 'npm run build', timeoutMs: 300_000, run: () => runCmdFixed('npm run build', repo, 300_000) },
    { label: 'tsc', timeoutMs: 180_000, run: () => runCmdFixed('npx tsc --noEmit', repo, 180_000) },
  ];
}

/**
 * Run steps in order, fail-fast, reporting each label through `onStep`.
 * Exported so the offline harness can verify the orchestration with harmless steps.
 */
export async function runSteps(
  steps: StepDef[],
  onStep: (label: string) => Promise<unknown> | unknown,
): Promise<StepResult[]> {
  const done: StepResult[] = [];
  for (const s of steps) {
    await onStep(s.label);
    let code: number | null = null;
    let out = '';
    try {
      ({ code, out } = await s.run());
    } catch {
      code = null;
    }
    const ok = code === 0;
    done.push({ label: s.label, ok, code, tail: tailOf(out) });
    if (!ok) return done;
  }
  return done;
}

/** In-process part of `/update`: the spec's pull/install/build/typecheck chain. */
export function preUpdateSteps(
  repo: string,
  onStep: (label: string) => Promise<unknown> | unknown,
): Promise<StepResult[]> {
  return runSteps(preUpdateStepDefs(repo), onStep);
}

/**
 * Spawn `scripts/updater.cmd` detached (it survives our exit) and unref it.
 * False when the script is missing, we are not on Windows, or spawn fails —
 * the caller must report E_UPDATE_FAILED instead of exiting.
 */
export function launchUpdaterDetached(repo: string): boolean {
  if (process.platform !== 'win32') return false;
  const script = updaterScript(repo);
  if (!existsSync(script)) return false;
  try {
    // Single quoted command: cmd runs it verbatim, spaces in the path are safe.
    const child = spawn('cmd.exe', ['/d', '/s', '/c', `"${script}"`], {
      cwd: repo,
      env: childEnv(),
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Stage-2 confirm flow (called from the update button handler): hash before,
 * pre-update with progress replies, hand off to the detached updater, exit.
 * Replies are Russian; failures carry E_ codes, never commands or secrets.
 */
export async function confirmUpdate(ui: UpdateUi, repo = repoDir()): Promise<void> {
  const before = await versionHash(repo);
  await ui.reply(`Обновляю… (версия до: ${before})`);
  const steps = await preUpdateSteps(repo, (label) => ui.reply(`…${label}`).catch(() => undefined));
  const failed = steps.find((s) => !s.ok);
  if (failed) {
    const extra = failed.tail === '' ? '' : ` — ${failed.tail}`;
    await ui.reply(`Не обновлено: E_UPDATE_FAILED (${failed.label}${extra})`);
    return;
  }
  if (!launchUpdaterDetached(repo)) {
    await ui.reply('Не обновлено: E_UPDATE_FAILED (нет scripts/updater.cmd)');
    return;
  }
  await ui.reply(`Готово (было: ${before}). Перезапускаюсь — после рестарта придёт «я жив» с новым хешем.`);
  // Let the Telegram reply flush before we die; the updater takes it from here.
  await sleep(1500);
  process.exit(0);
}
