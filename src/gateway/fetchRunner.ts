import { TextDecoder } from 'node:util';
import type { AgentEvent, AgentResult } from './types.js';
import { sanitize } from './spawnRunner.js';

/**
 * Shared HTTP runner for the network-based provider (hermes).
 *
 * Mirror of `spawnRunner` for agents reachable over HTTP (ARCHITECTURE.md §5):
 * POST JSON with `Authorization: Bearer <apiKey>`, an `AbortController` per task,
 * a per-task timeout, a kill-map keyed by `sessionId`, incremental response
 * streaming and secret-free error sanitizing.
 *
 * Streaming is incremental: the body is read chunk-by-chunk and forwarded to
 * `onEvent` as it arrives — the whole response is never buffered first. Two
 * content types are supported:
 *   - `text/event-stream`: `data:` frames are parsed. `data: [DONE]` ends the
 *     stream; a JSON payload contributes the first text found in `text`,
 *     `delta`, `content` or `choices[0].delta.content`; a non-JSON payload is
 *     emitted verbatim.
 *   - anything else: the decoded body is emitted chunk-by-chunk as-is.
 *
 * Rejections carry `E_NOT_CONFIGURED`, `E_AGENT_FAILED`, `E_TIMEOUT` or
 * `E_CANCELLED` — never a token, key or raw prompt.
 */

export interface FetchSpec {
  /** Absolute endpoint to POST to, e.g. `${baseUrl}/v1/agent/run`. */
  url: string;
  /** Bearer token; comes only from config/env, never logged. */
  apiKey: string;
  /** JSON-serialisable request body. */
  body: unknown;
  /** Unique per queued task; keys the kill-map. */
  sessionId: string;
  /** Hard per-task deadline in milliseconds. */
  timeoutMs: number;
}

interface Run {
  controller: AbortController;
  reason: 'cancel' | 'timeout' | null;
}

const running = new Map<string, Run>();

const msgOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** True for the AbortError undici raises when a fetch/stream signal fires. */
const isAbort = (e: unknown): boolean =>
  e instanceof Error && (e.name === 'AbortError' || /abort/i.test(e.message));

/** Pull a user-visible fragment out of a parsed SSE JSON payload, or null. */
function extractText(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value !== 'object' || value === null) return null;
  const o = value as Record<string, unknown>;
  for (const key of ['text', 'delta', 'content'] as const) {
    const v = o[key];
    if (typeof v === 'string') return v;
  }
  const choices = o['choices'];
  if (Array.isArray(choices) && choices.length > 0) {
    const first: unknown = choices[0];
    if (typeof first === 'object' && first !== null) {
      const delta = (first as Record<string, unknown>)['delta'];
      if (typeof delta === 'object' && delta !== null) {
        const content = (delta as Record<string, unknown>)['content'];
        if (typeof content === 'string') return content;
      }
    }
  }
  return null;
}

/**
 * Handle one SSE line. Returns true when the line terminates the stream
 * (`data: [DONE]`).
 */
function processSseLine(line: string, emit: (delta: string) => void): boolean {
  const t = line.trim();
  if (t === '' || t.startsWith(':')) return false; // blank line / comment keep-alive
  if (!t.startsWith('data:')) return false;
  const payload = t.slice('data:'.length).replace(/^ /, '');
  if (payload === '[DONE]') return true;
  if (payload === '') return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    emit(payload);
    return false;
  }
  const text = extractText(parsed);
  if (text !== null) emit(text);
  return false;
}

/** Bounded, sanitized snippet of an error response body (never a secret). */
async function errorSnippet(res: Response): Promise<string> {
  try {
    return sanitize(await res.text());
  } catch {
    return '';
  }
}

/**
 * POST `spec.body` as JSON and stream the response to `onEvent`.
 * Rejects with E_NOT_CONFIGURED, E_AGENT_FAILED, E_TIMEOUT or E_CANCELLED.
 */
export function runFetch(spec: FetchSpec, onEvent: (e: AgentEvent) => void): Promise<AgentResult> {
  return new Promise<AgentResult>((resolve, reject) => {
    if (spec.url === '' || spec.apiKey === '') {
      reject(new Error('E_NOT_CONFIGURED: endpoint/key missing'));
      return;
    }

    const controller = new AbortController();
    const run: Run = { controller, reason: null };
    running.set(spec.sessionId, run);

    let settled = false;
    let text = '';

    const timer = setTimeout(() => {
      run.reason = 'timeout';
      controller.abort();
    }, spec.timeoutMs);
    timer.unref?.();

    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      running.delete(spec.sessionId);
      fn();
    };

    const emit = (delta: string): void => {
      if (delta === '') return;
      text += delta;
      onEvent({ type: 'text', delta });
    };

    void (async () => {
      try {
        const res = await fetch(spec.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'text/event-stream, text/plain;q=0.9, application/json;q=0.8',
            authorization: `Bearer ${spec.apiKey}`,
          },
          body: JSON.stringify(spec.body),
          signal: controller.signal,
        });

        if (!res.ok) {
          const snippet = await errorSnippet(res);
          settle(() =>
            reject(new Error(`E_AGENT_FAILED: HTTP ${res.status}${snippet === '' ? '' : ` — ${snippet}`}`)),
          );
          return;
        }

        const body = res.body;
        if (body === null) {
          settle(() => resolve({ text, exitCode: 0, sessionId: '', costUsd: null }));
          return;
        }

        const sse = /text\/event-stream/i.test(res.headers.get('content-type') ?? '');
        const reader = body.getReader();
        const decoder = new TextDecoder();
        let lineBuf = '';
        let terminated = false;

        while (!terminated) {
          const chunk = await reader.read();
          if (chunk.done) {
            const tail = decoder.decode();
            if (sse) {
              lineBuf += tail;
              if (lineBuf.trim() !== '') processSseLine(lineBuf, emit);
            } else if (tail !== '') {
              emit(tail);
            }
            break;
          }
          const piece = decoder.decode(chunk.value, { stream: true });
          if (!sse) {
            emit(piece);
            continue;
          }
          lineBuf += piece;
          const lines = lineBuf.split(/\r?\n/);
          lineBuf = lines.pop() ?? '';
          for (const line of lines) {
            if (processSseLine(line, emit)) {
              terminated = true;
              break;
            }
          }
        }

        if (terminated) {
          try {
            await reader.cancel();
          } catch {
            // stream already closed
          }
        }

        settle(() => resolve({ text, exitCode: 0, sessionId: '', costUsd: null }));
      } catch (e) {
        settle(() => {
          if (run.reason === 'timeout') reject(new Error('E_TIMEOUT'));
          else if (run.reason === 'cancel') reject(new Error('E_CANCELLED'));
          else if (isAbort(e)) reject(new Error('E_CANCELLED'));
          else reject(new Error(`E_AGENT_FAILED: ${sanitize(msgOf(e))}`));
        });
      }
    })();
  });
}

/** Abort the in-flight request for `sessionId`, if any. */
export async function cancelFetch(sessionId: string): Promise<void> {
  const run = running.get(sessionId);
  if (!run) return;
  run.reason = 'cancel';
  run.controller.abort();
}

/** Whether a request for `sessionId` is currently in flight. */
export function isFetchRunning(sessionId: string): boolean {
  return running.has(sessionId);
}
