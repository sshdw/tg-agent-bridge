import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type { AgentEvent, AgentResult, AgentTask } from './types.js';

/**
 * Shared CLI runner for every process-based provider (opencode, cursor, cline).
 *
 * Responsibilities (ARCHITECTURE.md §5): spawn, per-task timeout, kill-map keyed by
 * sessionId, line-buffered stdout streaming and secret-free error sanitizing.
 * Providers only translate `AgentTask` into argv; they never touch child_process.
 */

/** Env vars that must never be inherited by a spawned agent process. */
const SECRET_ENV_KEYS = [
  'BOT_TOKEN',
  'HERMES_API_KEY',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'GITHUB_PAT',
  /** Git asks for these when /commit or /pr runs inside a child; they are ours. */
  'GIT_ASKPASS',
] as const;

const SECRET_PATTERNS: readonly RegExp[] = [
  /\b\d{6,}:[A-Za-z0-9_-]{30,}\b/g, // telegram bot token
  /\bsk-[A-Za-z0-9_-]{16,}\b/g, // openai-style key
  /\bgh[opsur]_[A-Za-z0-9]{20,}\b/g, // github token (classic, fine-grained, server, user, refresh)
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, // github fine-grained PAT
  /Bearer\s+[A-Za-z0-9._-]{16,}/gi, // bearer header
  /\b[A-Za-z0-9_-]{32,}\b/g, // long opaque secret
];

/**
 * Strip anything that looks like a credential and collapse whitespace.
 * ONLY for diagnostics — never applied to agent output, which must reach the user intact.
 */
export function sanitize(input: string, max = 300): string {
  let out = input;
  for (const re of SECRET_PATTERNS) out = out.replace(re, '[redacted]');
  return out.replace(/\s+/g, ' ').trim().slice(0, max);
}

const msgOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** process.env minus our own secrets, so an agent can never read the bot token. */
export function childEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of SECRET_ENV_KEYS) delete env[k];
  return extra === undefined ? env : { ...env, ...extra };
}

interface Run {
  child: ChildProcess;
  reason: 'cancel' | 'timeout' | null;
}

const running = new Map<string, Run>();

/** Windows has no process groups via child.kill; taskkill /T is needed to kill the tree. */
function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } catch {
      // fall through to child.kill
    }
  }
  try {
    child.kill('SIGTERM');
  } catch {
    // already gone
  }
}

export interface SpawnSpec {
  bin: string;
  args: string[];
  workdir: string;
  sessionId: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  /** Maps one stdout line to a text delta. Return null to drop the line. Default: line + "\n". */
  parseLine?: (line: string) => string | null;
  /**
   * Side-channel for structured data hiding in the same stdout stream (session id,
   * cost). Called for every line, before `parseLine`; never contributes to the reply.
   */
  parseMeta?: (line: string) => void;
}

/** Structured, non-prose facts a provider dug out of its own JSONL stream. */
export interface SpawnMeta {
  sessionId: string;
  costUsd: number | null;
}

const defaultParse = (line: string): string => `${line}\n`;

/**
 * Run a CLI agent to completion.
 * Rejects with E_NOT_CONFIGURED (missing binary), E_TIMEOUT, E_CANCELLED or E_AGENT_FAILED.
 * Resolves with the accumulated text plus any session id / cost the provider reported.
 */
export function runSpawn(spec: SpawnSpec, onEvent: (e: AgentEvent) => void): Promise<AgentResult> {
  return new Promise<AgentResult>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(spec.bin, spec.args, {
        cwd: spec.workdir,
        env: childEnv(spec.env),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      reject(new Error(`E_NOT_CONFIGURED: ${sanitize(msgOf(e))}`));
      return;
    }

    const run: Run = { child, reason: null };
    running.set(spec.sessionId, run);

    let settled = false;
    let stdoutBuf = '';
    let stderrBuf = '';
    let text = '';
    let sessionId = '';
    let costUsd: number | null = null;

    const timer = setTimeout(() => {
      run.reason = 'timeout';
      killTree(child);
    }, spec.timeoutMs);
    timer.unref?.();

    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      running.delete(spec.sessionId);
      fn();
    };

    const parse = spec.parseLine ?? defaultParse;

    /** Providers hand back facts through a mutable carrier so they need no state. */
    const meta: SpawnMeta = {
      get sessionId() {
        return sessionId;
      },
      set sessionId(v: string) {
        if (v !== '') sessionId = v;
      },
      get costUsd() {
        return costUsd;
      },
      set costUsd(v: number | null) {
        if (typeof v === 'number' && Number.isFinite(v)) costUsd = v;
      },
    };

    const emit = (line: string): void => {
      if (spec.parseMeta) {
        try {
          spec.parseMeta.call(meta, line);
        } catch {
          // a malformed metadata line must never break the reply stream
        }
      }
      const delta = parse(line);
      if (delta === null || delta === '') return;
      text += delta;
      onEvent({ type: 'text', delta });
    };

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdoutBuf += chunk;
      const lines = stdoutBuf.split(/\r?\n/);
      stdoutBuf = lines.pop() ?? '';
      for (const line of lines) emit(line);
    });

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      if (stderrBuf.length < 4000) stderrBuf += chunk;
    });

    child.on('error', (err) => {
      settle(() => {
        const m = msgOf(err);
        reject(new Error(/ENOENT/.test(m) ? `E_NOT_CONFIGURED: ${sanitize(m)}` : `E_AGENT_FAILED: ${sanitize(m)}`));
      });
    });

    child.on('close', (code) => {
      if (stdoutBuf !== '') {
        const rest = stdoutBuf;
        stdoutBuf = '';
        emit(rest);
      }
      settle(() => {
        if (run.reason === 'timeout') reject(new Error('E_TIMEOUT'));
        else if (run.reason === 'cancel') reject(new Error('E_CANCELLED'));
        else if (code === 0) resolve({ text, exitCode: 0, sessionId, costUsd });
        else reject(new Error(`E_AGENT_FAILED: exit ${code ?? 'signal'}${stderrBuf === '' ? '' : ` — ${sanitize(stderrBuf)}`}`));
      });
    });
  });
}

export async function cancelSpawn(sessionId: string): Promise<void> {
  const run = running.get(sessionId);
  if (!run) return;
  run.reason = 'cancel';
  killTree(run.child);
}

export function isRunning(sessionId: string): boolean {
  return running.has(sessionId);
}

/**
 * Every prompt that comes from Telegram is prefixed with this marker so agents and
 * future log analysis can tell phone-originated turns apart from local ones.
 */
export const TELEGRAM_MARKER = '[via Telegram]';

/**
 * Appended to every Telegram-originated prompt. Keeps replies readable on a phone:
 * short paragraphs, key points first, fenced code, no giant headings.
 */
export const TELEGRAM_SYSTEM_LINE =
  'Reply concise and Telegram-friendly: short paragraphs, key points first, code in fenced blocks, no giant headers.';

/** Prefix a user prompt with the Telegram marker and the output-style system line. */
export function telegramify(prompt: string): string {
  return `${TELEGRAM_MARKER} ${prompt}\n\n${TELEGRAM_SYSTEM_LINE}`;
}

/**
 * Flatten the recent transcript into one prompt for CLI agents.
 * The queue records the user message before dispatching, so the current prompt is
 * normally the last history entry — it is removed here to avoid sending it twice.
 * Used as the fallback path when the provider cannot resume a real session.
 */
export function composePrompt(task: AgentTask, maxChars = 12000): string {
  const hist = [...task.history];
  for (let i = hist.length - 1; i >= 0; i--) {
    const m = hist[i];
    if (m !== undefined && m.role === 'user' && m.text === task.prompt) {
      hist.splice(i, 1);
      break;
    }
  }
  const lines: string[] = [];
  if (task.mode === 'code') lines.push('Mode: code. Work inside the project directory.');
  if (task.images.length > 0) lines.push(`Attached files: ${task.images.join(', ')}`);
  if (hist.length > 0) {
    lines.push('Conversation so far:');
    for (const m of hist) lines.push(`${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text}`);
    lines.push('');
  }
  lines.push(task.prompt);
  lines.push('');
  lines.push(TELEGRAM_SYSTEM_LINE);
  const out = lines.join('\n');
  return out.length > maxChars ? out.slice(out.length - maxChars) : out;
}
