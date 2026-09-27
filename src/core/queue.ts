import type { Config } from '../config.js';
import { getProvider } from '../gateway/registry.js';
import type { AgentEvent, AgentId, AgentTask, HistoryItem, TaskMode } from '../gateway/types.js';
import type { Store } from '../storage/db.js';
import { resolveWorkdir } from './permissions.js';
import { getOrCreate } from './sessions.js';
import { resolveApproval } from './approvals.js';

export interface StreamHandle {
  push(delta: string): void;
  finish(text: string): Promise<void>;
  fail(code: string): Promise<void>;
}

export interface Responder {
  streamStart(chatId: number): Promise<StreamHandle>;
  askApproval(chatId: number, command: string): Promise<boolean>;
  notify(chatId: number, text: string): Promise<void>;
}

function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(new Error('E_TIMEOUT'));
    }, ms);
    timer.unref?.();
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}

const errCode = (e: unknown): string => {
  const m = e instanceof Error ? e.message : String(e);
  return m.startsWith('E_') ? m.split(':')[0] ?? 'E_AGENT_FAILED' : 'E_AGENT_FAILED';
};

export class TaskQueue {
  private pumping = new Set<number>();
  private streams = new Map<number, StreamHandle>();
  private sessionIds = new Map<number, string>();

  constructor(
    private store: Store,
    private cfg: Config,
    private io: Responder,
  ) {}

  submit(chatId: number, prompt: string, mode: TaskMode, images: string[]): 'started' | 'queued' {
    const s = getOrCreate(this.store, this.cfg, chatId);
    this.store.addMessage(chatId, 'user', prompt);
    this.store.createTask(chatId, s.agent, mode, prompt, images);
    if (this.pumping.has(chatId)) return 'queued';
    void this.pump(chatId);
    return 'started';
  }

  async cancel(chatId: number): Promise<'approval' | 'task' | 'nothing'> {
    if (resolveApproval(chatId, false)) return 'approval';
    const task = this.store.runningTask(chatId);
    if (!task || !this.pumping.has(chatId)) return 'nothing';
    this.store.setTaskStatus(task.id, 'cancelled');
    const sid = this.sessionIds.get(chatId);
    if (sid) {
      try {
        await getProvider(task.agent).cancel(sid);
      } catch {
        // provider cancel is best-effort
      }
    }
    await this.streams.get(chatId)?.fail('E_CANCELLED');
    return 'task';
  }

  status(chatId: number): { running: boolean; pending: number } {
    return { running: this.pumping.has(chatId), pending: this.store.pendingCount(chatId) };
  }

  private async pump(chatId: number): Promise<void> {
    if (this.pumping.has(chatId)) return;
    this.pumping.add(chatId);
    try {
      for (;;) {
        const task = this.store.oldestPending(chatId);
        if (!task) return;
        await this.execute(chatId, task.id);
      }
    } finally {
      this.pumping.delete(chatId);
      this.streams.delete(chatId);
      this.sessionIds.delete(chatId);
    }
  }

  private async execute(chatId: number, taskId: number): Promise<void> {
    const stream = await this.io.streamStart(chatId);
    this.streams.set(chatId, stream);
    this.store.setTaskStatus(taskId, 'running');
    try {
      const s = getOrCreate(this.store, this.cfg, chatId);
      const task = this.store.runningTask(chatId);
      if (!task) throw new Error('E_NO_TASK');
      const workdir = resolveWorkdir(this.cfg, chatId, s.project);
      const history: HistoryItem[] = this.store
        .recentMessages(chatId, this.cfg.historyLimit)
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => ({ role: m.role as 'user' | 'assistant', text: m.text }));
      const sessionId = `${chatId}:${task.id}`;
      this.sessionIds.set(chatId, sessionId);
      const images: string[] = JSON.parse(task.images) as string[];
      const agentTask: AgentTask = {
        sessionId,
        agent: task.agent as AgentId,
        mode: task.mode as TaskMode,
        model: s.model,
        prompt: task.prompt,
        images,
        workdir,
        autoApprove: s.autoApprove,
        timeoutMs: this.cfg.taskTimeoutMs,
        history,
        requestApproval: (cmd) => this.io.askApproval(chatId, cmd),
      };
      const provider = getProvider(agentTask.agent);
      let full = '';
      const onEvent = (e: AgentEvent): void => {
        if (e.type === 'text') {
          full += e.delta;
          stream.push(e.delta);
        }
      };
      const result = await withTimeout(provider.run(agentTask, onEvent), this.cfg.taskTimeoutMs, () => {
        void provider.cancel(sessionId);
      });
      this.store.addMessage(chatId, 'assistant', result.text === '' ? full : result.text);
      this.store.setTaskStatus(taskId, 'done');
      await stream.finish(result.text === '' ? full : result.text);
    } catch (e) {
      const code = errCode(e);
      this.store.setTaskStatus(taskId, code === 'E_CANCELLED' ? 'cancelled' : 'error');
      await stream.fail(code);
    }
  }
}
