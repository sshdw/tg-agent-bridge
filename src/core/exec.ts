import { existsSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import type { Config } from '../config.js';
import { childEnv, runSpawn } from '../gateway/spawnRunner.js';
import type { Store } from '../storage/db.js';
import { resolveWorkdir } from './permissions.js';
import type { Responder } from './queue.js';
import { getOrCreate } from './sessions.js';

export interface ExecDeps {
  cfg: Config;
  store: Store;
  io: Responder;
}

/** `/exec` wall-clock budget (spec §1.7: 5 min), enforced by the runner. */
export const EXEC_TIMEOUT_MS = 5 * 60 * 1000;

/** Upper bound on chat-bound output; the rest is cut with a visible mark. */
export const EXEC_MAX_OUTPUT = 64 * 1024;

export const EXEC_USAGE =
  'Использование: /exec <команда> — выполнить в папке проекта. Одна команда без каналов (|, >, &&).';

/**
 * Split one command line into argv, honouring single/double quotes and a
 * backslash escape. No shell is ever involved downstream, so pipes, redirects
 * and `&&` chains are NOT supported — each `/exec` is exactly one process.
 * Throws E_EXEC_FAILED on an unbalanced quote.
 */
export function splitArgv(cmd: string): string[] {
  const argv: string[] = [];
  let cur = '';
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let hasToken = false;
  for (const ch of cmd) {
    if (escaped) {
      cur += ch;
      escaped = false;
      hasToken = true;
      continue;
    }
    if (ch === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote !== null) {
      if (ch === quote) quote = null;
      else {
        cur += ch;
        hasToken = true;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      hasToken = true;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      if (hasToken) {
        argv.push(cur);
        cur = '';
        hasToken = false;
      }
      continue;
    }
    cur += ch;
    hasToken = true;
  }
  if (escaped) {
    cur += '\\';
    hasToken = true;
  }
  if (quote !== null) throw new Error('E_EXEC_FAILED: незакрытая кавычка.');
  if (hasToken) argv.push(cur);
  return argv;
}

/**
 * Resolve the binary without a shell. `spawn` with `shell:false` does not
 * honour PATHEXT on Windows, so bare names like `npm` (a `.cmd` shim) would
 * die with ENOENT. Search PATH for the name plus the executable extensions;
 * paths containing a separator resolve against the workdir instead.
 * Returns null when nothing executable is found (caller reports E_EXEC_FAILED).
 */
export function resolveBin(bin: string, workdir: string): string | null {
  if (bin.includes('/') || bin.includes('\\')) {
    const abs = isAbsolute(bin) ? bin : resolve(workdir, bin);
    return existsSync(abs) ? abs : null;
  }
  const dirs = (process.env.PATH ?? '').split(delimiter).filter((d) => d !== '');
  const cands =
    process.platform === 'win32'
      ? [bin, `${bin}.exe`, `${bin}.cmd`, `${bin}.bat`]
      : [bin];
  for (const dir of dirs) {
    for (const c of cands) {
      const abs = join(dir, c);
      if (existsSync(abs)) return abs;
    }
  }
  return null;
}

const errCode = (e: unknown): string => {
  const m = e instanceof Error ? e.message : String(e);
  return m.startsWith('E_') ? m.split(':')[0] ?? 'E_EXEC_FAILED' : 'E_EXEC_FAILED';
};

/**
 * `/exec <shell cmd>`: run one process in the chat's workdir, stream chunked
 * output to the chat, kill after EXEC_TIMEOUT_MS.
 *
 * Safety: argv array + `shell:false` always (chat input never touches a shell),
 * cwd jailed by `resolveWorkdir`, env scrubbed by `childEnv` (no BOT_TOKEN et al
 * in the child). Approval: same flow as agent shell — `autoApprove off` asks via
 * the askApproval button (`/approve` / `/cancel` keep their meaning).
 */
export async function runExec(deps: ExecDeps, chatId: number, cmd: string): Promise<void> {
  const text = cmd.trim();
  if (text === '') {
    await deps.io.notify(chatId, EXEC_USAGE);
    return;
  }
  let argv: string[];
  try {
    argv = splitArgv(text);
  } catch {
    await deps.io.notify(chatId, '❌ E_EXEC_FAILED: незакрытая кавычка.');
    return;
  }
  const bin = argv[0] ?? '';
  const args = argv.slice(1);
  if (bin === '') {
    await deps.io.notify(chatId, EXEC_USAGE);
    return;
  }

  let workdir: string;
  try {
    const s = getOrCreate(deps.store, deps.cfg, chatId);
    workdir = resolveWorkdir(deps.cfg, chatId, s.project);
    if (!s.autoApprove) {
      const ok = await deps.io.askApproval(chatId, `$ ${text}`);
      if (!ok) {
        await deps.io.notify(chatId, '❌ Отклонено (E_EXEC_DENIED).');
        return;
      }
    }
  } catch {
    await deps.io.notify(chatId, '🔒 Папка вне разрешённых. Смотри ALLOWED_ROOTS в .env.');
    return;
  }

  const resolved = resolveBin(bin, workdir);
  if (resolved === null) {
    await deps.io.notify(chatId, `❌ E_EXEC_FAILED: команда не найдена: ${bin}`);
    return;
  }

  const stream = await deps.io.streamStart(chatId, { mode: 'ask', label: 'exec' });
  let out = '';
  let truncated = false;
  try {
    await runSpawn(
      {
        bin: resolved,
        args,
        workdir,
        sessionId: `exec:${chatId}:${Date.now()}`,
        timeoutMs: EXEC_TIMEOUT_MS,
        env: childEnv(),
      },
      (e) => {
        if (e.type !== 'text') return;
        stream.push(e.delta);
        if (out.length < EXEC_MAX_OUTPUT) {
          out += e.delta;
          if (out.length >= EXEC_MAX_OUTPUT) truncated = true;
        } else {
          truncated = true;
        }
      },
    );
    const body = out === '' ? '(пустой вывод)' : `$ ${text}\n${out}`;
    await stream.finish(truncated ? `${body}\n…(вывод обрезан, показаны первые 64 КБ)` : body);
  } catch (e) {
    const code = errCode(e);
    // Runner codes are translated to the exec namespace; the message itself may
    // carry a sanitized stderr tail, safe to show (secrets are scrubbed there).
    const detail = e instanceof Error ? e.message : String(e);
    if (code === 'E_TIMEOUT') {
      await stream.fail('E_EXEC_TIMEOUT');
    } else if (code === 'E_CANCELLED') {
      await stream.fail('E_CANCELLED');
    } else {
      await stream.fail(`E_EXEC_FAILED${detail.startsWith('E_') ? `: ${detail.slice(detail.indexOf(':') + 1).trim()}` : ''}`);
    }
  }
}
