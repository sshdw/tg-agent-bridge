import type { AgentEvent, AgentResult, AgentTask, IAgentProvider } from '../gateway/types.js';
import { cancelSpawn, composePrompt, runSpawn } from '../gateway/spawnRunner.js';

/**
 * opencode provider — the reference CLI adapter.
 *
 * Active path: CLI (`opencode run`). Verified against opencode v2.0.18
 * (`opencode run --help` on this machine):
 *   opencode run [flags] [<message...>]
 *     --format <default|json>   --model, -m   --file, -f   --auto
 *
 * stdout with `--format json` is JSONL, one event per line, `type` in
 * {step_start, tool_use, text, step_finish, error}. Only `text` events carry
 * assistant output (`part.text`); `error` events surface as a short marker.
 * step_start / step_finish / tool_use are intentionally not shown so the stored
 * history stays clean assistant prose.
 *
 * A missing binary surfaces as E_NOT_CONFIGURED (mapped from ENOENT by spawnRunner).
 */
export class OpenCodeProvider implements IAgentProvider {
  readonly id = 'opencode' as const;

  /** Last text seen per part id, so cumulative parts are diffed into deltas. */
  private readonly seen = new Map<string, string>();

  constructor(private readonly bin: string) {}

  run(task: AgentTask, onEvent: (e: AgentEvent) => void): Promise<AgentResult> {
    const args = ['run', composePrompt(task), '--format', 'json'];
    if (task.model !== '') args.push('--model', task.model);
    if (task.autoApprove) args.push('--auto');
    for (const img of task.images) args.push('--file', img);

    return runSpawn(
      {
        bin: this.bin,
        args,
        workdir: task.workdir,
        sessionId: task.sessionId,
        timeoutMs: task.timeoutMs,
        parseLine: (line) => this.parseLine(line),
      },
      onEvent,
    );
  }

  async cancel(sessionId: string): Promise<void> {
    this.seen.clear();
    await cancelSpawn(sessionId);
  }

  /** JSONL line -> user-visible text delta, or null to drop. */
  private parseLine(line: string): string | null {
    const t = line.trim();
    if (t === '' || !t.startsWith('{')) return null;
    let ev: unknown;
    try {
      ev = JSON.parse(t);
    } catch {
      return null;
    }
    if (typeof ev !== 'object' || ev === null) return null;
    const e = ev as { type?: unknown; part?: unknown; error?: unknown };

    if (e.type === 'text') {
      const part = e.part as { id?: unknown; text?: unknown } | undefined;
      if (typeof part?.text !== 'string') return null;
      const id = typeof part.id === 'string' ? part.id : '';
      const prev = this.seen.get(id) ?? '';
      // `part.text` may arrive once per part or grow as the part streams.
      const delta = part.text.startsWith(prev) ? part.text.slice(prev.length) : part.text;
      this.seen.set(id, part.text);
      return delta === '' ? null : delta;
    }

    if (e.type === 'error') {
      const err = e.error as { name?: unknown; data?: { message?: unknown } } | undefined;
      const msg = typeof err?.data?.message === 'string' ? err.data.message : undefined;
      const name = typeof err?.name === 'string' ? err.name : 'agent error';
      return `\n⚠ ${msg ?? name}\n`;
    }

    return null;
  }
}
