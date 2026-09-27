import type { AgentResult, AgentTask, IAgentProvider } from '../gateway/types.js';

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** DEV-ONLY echo provider. Lets the whole bot run without any real agent installed. */
export class MockProvider implements IAgentProvider {
  readonly id = 'mock' as const;
  private cancelled = new Set<string>();

  async run(task: AgentTask, onEvent: (e: { type: 'text'; delta: string }) => void): Promise<AgentResult> {
    const lines = [
      `mock: mode=${task.mode} model=${task.model === '' ? '(default)' : task.model}\n`,
      `workdir: ${task.workdir}\n`,
      `prompt: ${task.prompt.slice(0, 300)}\n`,
      task.images.length > 0 ? `images: ${task.images.join(', ')}\n` : '',
      task.history.length > 0 ? `history: ${task.history.length} msgs\n` : 'history: empty\n',
      'done (mock)\n',
    ];
    let text = '';
    for (const line of lines) {
      if (line === '') continue;
      if (this.cancelled.has(task.sessionId)) {
        this.cancelled.delete(task.sessionId);
        throw new Error('E_CANCELLED');
      }
      await delay(400);
      text += line;
      onEvent({ type: 'text', delta: line });
    }
    return { text, exitCode: 0, sessionId: '', costUsd: null };
  }

  async cancel(sessionId: string): Promise<void> {
    this.cancelled.add(sessionId);
  }
}
