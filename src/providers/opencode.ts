import type { AgentEvent, AgentResult, AgentTask, IAgentProvider } from '../gateway/types.js';
import type { SpawnMeta } from '../gateway/spawnRunner.js';
import {
  ATTACH_PROTOCOL_LINE,
  cancelSpawn,
  composePrompt,
  runSpawn,
  TELEGRAM_MARKER,
  TELEGRAM_SYSTEM_LINE,
} from '../gateway/spawnRunner.js';

/**
 * opencode provider — the reference CLI adapter.
 *
 * Active path: CLI (`opencode run`). Verified against opencode v2.0.18
 * (`opencode run --help` on this machine):
 *   opencode run [flags] [<message...>]
 *     --format <default|json>   --model, -m   --file, -f   --auto
 *     --session, -s <id>        resume an existing session
 *     --continue, -c            continue the most recent session
 *
 * stdout with `--format json` is JSONL, one event per line. Observed events:
 * `step_start`, `tool_use`, `text`, `step_finish`, `error`. Only `text` events
 * carry assistant output (`part.text`); `error` events surface as a short marker.
 * step_start / step_finish / tool_use are intentionally not shown so the stored
 * history stays clean assistant prose.
 *
 * Session persistence: this provider keeps one real opencode session per chat.
 *  - `task.resumeSessionId` set -> `--session <id>`, no history injection.
 *  - empty                      -> fresh `opencode run`; every JSONL event carries
 *    `sessionID`, which we report back so the queue can store it.
 *  - resume failed (session gone) -> retry once without `--session`, injecting
 *    history as text, so a stale id never bricks a chat.
 *
 * Cost: the `run --format json` stream on this version carries no cost field
 * (verified by dumping every event type) and `session_v2.cost` stays 0 for these
 * models. So we read cost opportunistically — any `cost`/`cost_usd`/`total_cost`
 * found on the event, its `part`, or its `usage` wins; otherwise the task's
 * `cost_usd` stays NULL and `/cost` says so openly instead of inventing numbers.
 *
 * A missing binary surfaces as E_NOT_CONFIGURED (mapped from ENOENT by spawnRunner).
 */
export class OpenCodeProvider implements IAgentProvider {
  readonly id = 'opencode' as const;

  /** Last text seen per part id, so cumulative parts are diffed into deltas. */
  private readonly seen = new Map<string, string>();

  constructor(private readonly bin: string) {}

  async run(task: AgentTask, onEvent: (e: AgentEvent) => void): Promise<AgentResult> {
    if (task.resumeSessionId !== '') {
      try {
        return await this.dispatch(task, onEvent, task.resumeSessionId, task.prompt);
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        if (
          m.startsWith('E_NOT_CONFIGURED') ||
          m.startsWith('E_CANCELLED') ||
          m.startsWith('E_TIMEOUT')
        ) {
          throw e;
        }
        // Stored id is gone (deleted session, wiped opencode DB, other machine).
        // Forget it and fall through to a fresh session rather than failing the task.
        task.onSessionId?.('');
      }
    }
    // Fresh path flattens history into the prompt; the resume path must not, since
    // the real session already holds the transcript.
    return this.dispatch(task, onEvent, '', composePrompt(task));
  }

  private dispatch(
    task: AgentTask,
    onEvent: (e: AgentEvent) => void,
    resumeId: string,
    prompt: string,
  ): Promise<AgentResult> {
    const args = ['run', this.decorate(prompt), '--format', 'json'];
    if (task.model !== '') args.push('--model', task.model);
    if (resumeId !== '') args.push('--session', resumeId);
    // Owner decision: opencode always gets --auto. Its internal permission prompts
    // can't be bridged to Telegram (nobody to answer them), so without --auto tasks
    // hang until timeout. Safety comes from ALLOWED_ROOTS + whitelist + /cancel.
    args.push('--auto');
    for (const img of task.images) args.push('--file', img);

    this.seen.clear();
    return runSpawn(
      {
        bin: this.bin,
        args,
        workdir: task.workdir,
        sessionId: task.sessionId,
        timeoutMs: task.timeoutMs,
        parseLine: (line) => this.parseLine(line),
        parseMeta: function (this: SpawnMeta, line) {
          const ev = safeJson(line);
          if (ev === null) return;
          const sid = ev['sessionID'];
          if (typeof sid === 'string' && sid !== '') this.sessionId = sid;
          const c = findCost(ev);
          if (c !== null) this.costUsd = c;
        },
      },
      onEvent,
    ).then((r) => {
      if (r.sessionId !== '') task.onSessionId?.(r.sessionId);
      return r;
    });
  }

  /**
   * Prefix the prompt so a resumed session — which skips history injection — still
   * sees the Telegram marker, the phone-friendly output instruction and the
   * `[[attach:…]]` protocol.
   */
  private decorate(prompt: string): string {
    if (prompt.includes(TELEGRAM_MARKER)) return prompt;
    return `${TELEGRAM_MARKER} ${prompt}\n\n${TELEGRAM_SYSTEM_LINE}\n${ATTACH_PROTOCOL_LINE}`;
  }

  async cancel(sessionId: string): Promise<void> {
    this.seen.clear();
    await cancelSpawn(sessionId);
  }

  /** JSONL line -> user-visible text delta, or null to drop. */
  private parseLine(line: string): string | null {
    const e = safeJson(line);
    if (e === null) return null;
    const type = e['type'];

    if (type === 'text') {
      const part = e['part'] as { id?: unknown; text?: unknown } | undefined;
      if (typeof part?.text !== 'string') return null;
      const id = typeof part.id === 'string' ? part.id : '';
      const prev = this.seen.get(id) ?? '';
      // `part.text` may arrive once per part or grow as the part streams.
      const delta = part.text.startsWith(prev) ? part.text.slice(prev.length) : part.text;
      this.seen.set(id, part.text);
      return delta === '' ? null : delta;
    }

    if (type === 'error') {
      const err = e['error'] as { name?: unknown; data?: { message?: unknown } } | undefined;
      const msg = typeof err?.data?.message === 'string' ? err.data.message : undefined;
      const name = typeof err?.name === 'string' ? err.name : 'agent error';
      return `\n⚠ ${msg ?? name}\n`;
    }

    return null;
  }
}

function safeJson(line: string): Record<string, unknown> | null {
  const t = line.trim();
  if (t === '' || !t.startsWith('{')) return null;
  try {
    const v = JSON.parse(t) as unknown;
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Opportunistic cost extraction across opencode event shapes. Returns null when the
 * stream simply carries no price — the honest answer for v2.0.18, and the reason
 * `/cost` reports unpriced tasks instead of showing a fake zero.
 */
function findCost(ev: Record<string, unknown>): number | null {
  for (const k of ['cost', 'cost_usd', 'costUsd', 'total_cost']) {
    const n = asCost(ev[k]);
    if (n !== null) return n;
  }
  const usage = ev['usage'];
  if (typeof usage === 'object' && usage !== null) {
    const u = usage as Record<string, unknown>;
    for (const k of ['cost', 'cost_usd', 'total_cost']) {
      const n = asCost(u[k]);
      if (n !== null) return n;
    }
  }
  const part = ev['part'];
  if (typeof part === 'object' && part !== null) {
    const p = part as Record<string, unknown>;
    for (const k of ['cost', 'cost_usd']) {
      const n = asCost(p[k]);
      if (n !== null) return n;
    }
  }
  return null;
}

function asCost(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}
