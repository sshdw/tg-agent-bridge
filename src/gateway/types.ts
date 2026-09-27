export type AgentId = 'opencode' | 'cursor' | 'cline' | 'hermes' | 'mock';

export type TaskMode = 'ask' | 'code';

export interface HistoryItem {
  role: 'user' | 'assistant';
  text: string;
}

export interface AgentTask {
  /** `${chatId}:${taskId}` — unique per queued task. */
  sessionId: string;
  agent: AgentId;
  mode: TaskMode;
  model: string;
  prompt: string;
  /** Absolute paths of images attached to this task. */
  images: string[];
  /** Absolute workdir, already validated against ALLOWED_ROOTS. */
  workdir: string;
  autoApprove: boolean;
  timeoutMs: number;
  history: HistoryItem[];
  /** Resolves true when the user approves the shell command. */
  requestApproval: (command: string) => Promise<boolean>;
}

export type AgentEvent =
  | { type: 'text'; delta: string }
  | { type: 'done'; exitCode: number }
  | { type: 'error'; message: string };

export interface AgentResult {
  text: string;
  exitCode: number;
}

export interface IAgentProvider {
  readonly id: AgentId;
  run(task: AgentTask, onEvent: (e: AgentEvent) => void): Promise<AgentResult>;
  cancel(sessionId: string): Promise<void>;
}
