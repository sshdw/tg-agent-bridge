import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentEvent, AgentResult, AgentTask, IAgentProvider } from '../gateway/types.js';
import { cancelSpawn, composePrompt, runSpawn, sanitize } from '../gateway/spawnRunner.js';

/**
 * cline provider — CLI first, file-adapter fallback.
 *
 * ## Which path is active, and when
 *
 * 1. **Primary — CLI.** `runSpawn` launches the configured binary (default
 *    `roo-code`, from `cfg.clineBin`; never hardcoded here) as
 *    `roo-code --print <composePrompt(task)>` plus `--model <task.model>` when a
 *    model is set. This is the path that runs whenever the binary exists.
 *
 * 2. **Fallback — file adapter.** `roo-code` is NOT installed on this machine, so
 *    in practice `runSpawn` rejects with `E_NOT_CONFIGURED` and the provider
 *    transparently switches to the file adapter. ONLY that error is caught; every
 *    other failure (timeout, cancel, non-zero exit, spawn I/O) propagates
 *    unchanged. Because the binary is absent locally, the CLI path is unverified —
 *    the file adapter is the exercised path.
 *
 * ## File-adapter contract (the core never sees this; it is an implementation detail)
 *
 * - Directory: `<workdir>/.bridge/`, created if missing (`node:path` join, Windows-safe).
 * - Writes `task.json`:
 *     `{ sessionId, prompt, model, mode, images, workdir, createdAt }`
 *   where `prompt` is `composePrompt(task)` and `createdAt` is an ISO-8601 string.
 * - Polls for `result.json` every ~500 ms until `task.timeoutMs` elapses.
 * - `result.json` shape: `{ "text": string, "exitCode": number }`. Once present and
 *   valid, its `text` is emitted as a single `{ type: 'text', delta }` event and the
 *   provider resolves with `{ text, exitCode }`.
 * - Timeout rejects `E_TIMEOUT`; a non-zero `exitCode` rejects `E_AGENT_FAILED`.
 *   A partially written / malformed `result.json` is ignored and retried.
 * - Artifacts are removed on completion and on cancel, and a stale `result.json`
 *   is cleared before a new task starts, so runs cannot observe each other's output.
 *   The adapter therefore assumes one task at a time per workdir (the core enforces
 *   a single in-flight task per chat, and a workdir belongs to one chat).
 *
 * `cancel(sessionId)` covers BOTH paths: it stops the file-adapter polling loop and
 * removes its artifacts, and it calls `cancelSpawn(sessionId)` so a CLI child is killed.
 *
 * Any error text this file constructs is passed through `sanitize()`; prompts, tokens
 * and full command lines are never embedded in error messages.
 */

const BRIDGE_DIR = '.bridge';
const TASK_FILE = 'task.json';
const RESULT_FILE = 'result.json';
const POLL_MS = 500;

/** A live file-adapter run, keyed by sessionId so `cancel` can reach it. */
interface FileSession {
  cancelled: boolean;
  taskPath: string;
  resultPath: string;
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const msgOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Shape written to task.json — stable, documented above. */
interface TaskFile {
  sessionId: string;
  prompt: string;
  model: string;
  mode: AgentTask['mode'];
  images: string[];
  workdir: string;
  createdAt: string;
}

export class ClineProvider implements IAgentProvider {
  readonly id = 'cline' as const;

  /** Active file-adapter runs, so `cancel` can stop polling and clean up. */
  private readonly files = new Map<string, FileSession>();

  constructor(private readonly bin: string) {}

  async run(task: AgentTask, onEvent: (e: AgentEvent) => void): Promise<AgentResult> {
    try {
      return await this.runCli(task, onEvent);
    } catch (e) {
      // Only a missing/unlaunchable binary falls through to the file adapter.
      const msg = msgOf(e);
      if (!msg.startsWith('E_NOT_CONFIGURED')) throw e;
      return this.runFile(task, onEvent);
    }
  }

  async cancel(sessionId: string): Promise<void> {
    const session = this.files.get(sessionId);
    if (session !== undefined) {
      session.cancelled = true;
      this.files.delete(sessionId);
      await this.cleanup(session.taskPath, session.resultPath);
    }
    await cancelSpawn(sessionId);
  }

  /** Primary path: `roo-code --print <prompt> [--model <model>]` via runSpawn. */
  private runCli(task: AgentTask, onEvent: (e: AgentEvent) => void): Promise<AgentResult> {
    const args = ['--print', composePrompt(task)];
    if (task.model !== '') args.push('--model', task.model);

    return runSpawn(
      {
        bin: this.bin,
        args,
        workdir: task.workdir,
        sessionId: task.sessionId,
        timeoutMs: task.timeoutMs,
      },
      onEvent,
    );
  }

  /** Fallback path: exchange task.json / result.json inside `<workdir>/.bridge/`. */
  private async runFile(task: AgentTask, onEvent: (e: AgentEvent) => void): Promise<AgentResult> {
    const dir = join(task.workdir, BRIDGE_DIR);
    const taskPath = join(dir, TASK_FILE);
    const resultPath = join(dir, RESULT_FILE);

    const session: FileSession = { cancelled: false, taskPath, resultPath };
    this.files.set(task.sessionId, session);

    try {
      try {
        await mkdir(dir, { recursive: true });
        // Never let a previous run's output satisfy this one.
        await rm(resultPath, { force: true });
        const payload: TaskFile = {
          sessionId: task.sessionId,
          prompt: composePrompt(task),
          model: task.model,
          mode: task.mode,
          images: task.images,
          workdir: task.workdir,
          createdAt: new Date().toISOString(),
        };
        await writeFile(taskPath, JSON.stringify(payload, null, 2), 'utf8');
      } catch (e) {
        throw new Error(sanitize(`E_AGENT_FAILED: file adapter setup failed — ${msgOf(e)}`));
      }

      const deadline = Date.now() + task.timeoutMs;
      for (;;) {
        if (session.cancelled) throw new Error('E_CANCELLED');
        if (Date.now() >= deadline) throw new Error('E_TIMEOUT');

        const result = await this.readResult(resultPath);
        if (result !== null) {
          if (result.exitCode !== 0) {
            throw new Error(sanitize(`E_AGENT_FAILED: exit ${result.exitCode}`));
          }
          onEvent({ type: 'text', delta: result.text });
          return { text: result.text, exitCode: result.exitCode };
        }

        await delay(POLL_MS);
      }
    } finally {
      if (this.files.get(task.sessionId) === session) this.files.delete(task.sessionId);
      await this.cleanup(taskPath, resultPath);
    }
  }

  /**
   * Read result.json, returning null while it is absent, mid-write or malformed so
   * the caller keeps polling instead of failing on a transient read.
   */
  private async readResult(path: string): Promise<AgentResult | null> {
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch {
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    if (typeof parsed !== 'object' || parsed === null) return null;

    const o = parsed as { text?: unknown; exitCode?: unknown };
    if (typeof o.text !== 'string' || typeof o.exitCode !== 'number') return null;
    if (!Number.isInteger(o.exitCode)) return null;
    return { text: o.text, exitCode: o.exitCode };
  }

  /** Best-effort removal of adapter artifacts; never masks the real outcome. */
  private async cleanup(...paths: string[]): Promise<void> {
    for (const p of paths) {
      try {
        await rm(p, { force: true });
      } catch {
        // Ignore: cleanup must not change the run's result.
      }
    }
  }
}
