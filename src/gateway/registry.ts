import type { AgentId, IAgentProvider } from './types.js';

const providers = new Map<AgentId, IAgentProvider>();

export function register(p: IAgentProvider): void {
  providers.set(p.id, p);
}

export function getProvider(id: string): IAgentProvider {
  const p = providers.get(id as AgentId);
  if (!p) throw new Error(`E_UNKNOWN_AGENT: ${id}`);
  return p;
}

export function availableProviders(): AgentId[] {
  return [...providers.keys()];
}
