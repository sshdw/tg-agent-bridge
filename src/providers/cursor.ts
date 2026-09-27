import type { AgentEvent, AgentResult, AgentTask, IAgentProvider } from '../gateway/types.js';
import { cancelSpawn, composePrompt, runSpawn } from '../gateway/spawnRunner.js';

/**
 * cursor provider — CLI adapter for the Cursor headless agent.
 *
 * Active path: CLI. The binary name comes from config (`cfg.cursorBin`, default
 * `cursor-agent`) and is injected through the constructor — never hardcoded here.
 *
 * Command shape (ARCHITECTURE.md §5):
 *   cursor-agent --print <prompt> [--model <model>]
 *
 * stdout is plain text, so the shared runner's default line parser is used as-is
 * (one text delta per line). No JSON/streaming format flag is assumed.
 *
 * UNVERIFIED ASSUMPTIONS — `cursor-agent` is not installed on this machine, so
 * the following could not be checked against `--help` and are best-effort only:
 *   1. Model selection uses `--model <name>`, appended only when `task.model`
 *      is non-empty. If the flag differs, adjust here (and nowhere else).
 *   2. There is no documented flag for auto-approve or for attaching images, so
 *      neither `task.autoApprove` nor `task.images` is translated into argv.
 *      Attached image paths already appear in the prompt via `composePrompt`.
 *      Do not invent flags without verifying against the real CLI.
 *
 * A missing binary surfaces as E_NOT_CONFIGURED (ENOENT is mapped by the shared
 * runner); this provider deliberately does not swallow or rewrap that error.
 */
export class CursorProvider implements IAgentProvider {
  readonly id = 'cursor' as const;

  constructor(private readonly bin: string) {}

  run(task: AgentTask, onEvent: (e: AgentEvent) => void): Promise<AgentResult> {
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

  async cancel(sessionId: string): Promise<void> {
    await cancelSpawn(sessionId);
  }
}
