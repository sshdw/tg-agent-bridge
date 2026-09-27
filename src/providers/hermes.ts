import type { AgentEvent, AgentResult, AgentTask, IAgentProvider } from '../gateway/types.js';
import { cancelFetch, runFetch } from '../gateway/fetchRunner.js';
import { composePrompt } from '../gateway/spawnRunner.js';

/**
 * hermes provider — HTTP adapter over the shared `fetchRunner`.
 *
 * CONTRACT ASSUMPTION: no live Hermes server was available to test against, so
 * the request shape below is the contract pinned by ARCHITECTURE.md §5 rather
 * than a verified API. Exact request:
 *
 *   POST {baseUrl}/v1/agent/run
 *   headers:
 *     Authorization: Bearer <HERMES_API_KEY>
 *     Content-Type: application/json
 *     Accept: text/event-stream, text/plain, application/json
 *   body: { "prompt": string, "model": string, "sessionId": string }
 *     - `prompt`    = composePrompt(task)  (flattened history, current prompt deduped)
 *     - `model`     = task.model           (empty string means "server default")
 *     - `sessionId` = task.sessionId
 *   response:
 *     2xx `text/event-stream` -> `data:` frames streamed to onEvent as text deltas;
 *         `data: [DONE]` ends the stream.
 *     2xx other content type  -> plain chunked body streamed to onEvent verbatim.
 *     non-2xx                 -> E_AGENT_FAILED with a sanitized body snippet.
 *
 * Missing `baseUrl` or `apiKey` -> E_NOT_CONFIGURED (secret-free, no key material).
 * `cancel(sessionId)` aborts the in-flight request via the shared kill-map.
 */
export class HermesProvider implements IAgentProvider {
  readonly id = 'hermes' as const;

  constructor(private readonly baseUrl: string, private readonly apiKey: string) {}

  run(task: AgentTask, onEvent: (e: AgentEvent) => void): Promise<AgentResult> {
    if (this.baseUrl === '' || this.apiKey === '') {
      return Promise.reject(new Error('E_NOT_CONFIGURED: hermes endpoint/key missing'));
    }
    return runFetch(
      {
        url: `${this.baseUrl}/v1/agent/run`,
        apiKey: this.apiKey,
        body: { prompt: composePrompt(task), model: task.model, sessionId: task.sessionId },
        sessionId: task.sessionId,
        timeoutMs: task.timeoutMs,
      },
      onEvent,
    );
  }

  async cancel(sessionId: string): Promise<void> {
    await cancelFetch(sessionId);
  }
}
