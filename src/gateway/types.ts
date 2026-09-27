export type AgentId = 'opencode' | 'cursor' | 'cline' | 'hermes' | 'mock';

export type TaskMode = 'ask' | 'code';

export interface HistoryItem {
  role: 'user' | 'assistant';
  text: string;
}

export interface AgentTask {
  /** `${chatId}:${taskId}` — unique per queued task. Internal correlation id. */
  sessionId: string;
  agent: AgentId;
  mode: TaskMode;
  model: string;
  prompt: string;
  /** Absolute paths of files attached to this task (images and documents). */
  images: string[];
  /** Absolute workdir, already validated against ALLOWED_ROOTS. */
  workdir: string;
  autoApprove: boolean;
  timeoutMs: number;
  history: HistoryItem[];
  /**
   * Provider-side session id to resume (`ses_*` for opencode). Empty string means
   * "start a new session and report its id back through AgentResult".
   */
  resumeSessionId: string;
  /** Resolves true when the user approves the shell command. */
  requestApproval: (command: string) => Promise<boolean>;
  /** Streaming hook for providers that emit their session id mid-turn. */
  onSessionId?: (id: string) => void;
}

export type AgentEvent =
  | { type: 'text'; delta: string }
  | { type: 'done'; exitCode: number }
  | { type: 'error'; message: string };

export interface AgentResult {
  text: string;
  exitCode: number;
  /** Session id the provider used or created; empty when it has no such concept. */
  sessionId: string;
  /** USD cost when the provider reports one, otherwise null. */
  costUsd: number | null;
}

export interface IAgentProvider {
  readonly id: AgentId;
  run(task: AgentTask, onEvent: (e: AgentEvent) => void): Promise<AgentResult>;
  cancel(sessionId: string): Promise<void>;
}
