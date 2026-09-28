import type { Config } from '../config.js';
import type { AgentId } from '../gateway/types.js';
import type { Store } from '../storage/db.js';

export interface Session {
  agent: AgentId;
  model: string;
  project: string;
  autoApprove: boolean;
  /** Provider-side session id (opencode `ses_*`); '' means "no real session yet". */
  agentSessionId: string;
}

export function getOrCreate(store: Store, cfg: Config, chatId: number): Session {
  const row = store.getSession(chatId);
  if (row) {
    return {
      agent: row.agent as AgentId,
      model: row.model,
      project: row.project,
      autoApprove: row.auto_approve === 1,
      agentSessionId: row.agent_session_id ?? '',
    };
  }
  const s: Session = {
    agent: cfg.defaultAgent,
    model: cfg.defaultModel,
    project: '',
    autoApprove: cfg.autoApprove,
    agentSessionId: '',
  };
  store.saveSession({
    chat_id: chatId,
    agent: s.agent,
    model: s.model,
    project: s.project,
    auto_approve: s.autoApprove ? 1 : 0,
    agent_session_id: null,
  });
  return s;
}

export function updateSession(store: Store, chatId: number, patch: Partial<Session>): Session {
  const cur = store.getSession(chatId);
  if (!cur) throw new Error('E_NO_SESSION');
  const agentSessionId = patch.agentSessionId ?? cur.agent_session_id ?? '';
  const next = {
    chat_id: chatId,
    agent: patch.agent ?? cur.agent,
    model: patch.model ?? cur.model,
    project: patch.project ?? cur.project,
    auto_approve: (patch.autoApprove ?? cur.auto_approve === 1) ? 1 : 0,
    agent_session_id: agentSessionId === '' ? null : agentSessionId,
  };
  store.saveSession(next);
  return {
    agent: next.agent as AgentId,
    model: next.model,
    project: next.project,
    autoApprove: next.auto_approve === 1,
    agentSessionId,
  };
}

/**
 * `/new`, `/agent` switches and workdir changes invalidate the agent's own
 * context: drop the provider-side session id so the next task starts fresh.
 */
export function dropAgentSession(store: Store, chatId: number): void {
  store.setAgentSessionId(chatId, null);
}
