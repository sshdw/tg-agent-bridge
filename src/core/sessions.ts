import type { Config } from '../config.js';
import type { AgentId } from '../gateway/types.js';
import type { Store } from '../storage/db.js';

export interface Session {
  agent: AgentId;
  model: string;
  project: string;
  autoApprove: boolean;
}

export function getOrCreate(store: Store, cfg: Config, chatId: number): Session {
  const row = store.getSession(chatId);
  if (row) {
    return {
      agent: row.agent as AgentId,
      model: row.model,
      project: row.project,
      autoApprove: row.auto_approve === 1,
    };
  }
  const s: Session = {
    agent: cfg.defaultAgent,
    model: cfg.defaultModel,
    project: '',
    autoApprove: cfg.autoApprove,
  };
  store.saveSession({ chat_id: chatId, ...s, auto_approve: s.autoApprove ? 1 : 0 });
  return s;
}

export function updateSession(store: Store, chatId: number, patch: Partial<Session>): Session {
  const cur = store.getSession(chatId);
  if (!cur) throw new Error('E_NO_SESSION');
  const next = {
    chat_id: chatId,
    agent: patch.agent ?? cur.agent,
    model: patch.model ?? cur.model,
    project: patch.project ?? cur.project,
    auto_approve: (patch.autoApprove ?? cur.auto_approve === 1) ? 1 : 0,
  };
  store.saveSession(next);
  return {
    agent: next.agent as AgentId,
    model: next.model,
    project: next.project,
    autoApprove: next.auto_approve === 1,
  };
}
