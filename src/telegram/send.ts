/**
 * The single Telegram send policy: classify a failure, retry what is retryable,
 * downgrade only what is genuinely a markup/length problem — and log the real error
 * once per operation instead of swallowing it.
 *
 * Why this module exists: every symptom the owner reported ("markdown is broken")
 * was the visible face of a silent `catch {}`. A rejected HTML message, a rate limit
 * and a network blip all used to land in the owner's chat as literal `**bold**`.
 * Here they are told apart:
 *
 *   - `markup` / `too_long` -> the send path shrinks the budget and retries, and only
 *     escapes to plain text as a last resort (so a reply always lands);
 *   - `rate_limit` / `network` -> retried with backoff, never downgraded, because the
 *     markup was never the problem;
 *   - `fatal` -> logged and given up on; downgrading cannot fix it.
 *
 * Every Telegram send in the bot goes through here or through `stream.ts`, which uses
 * this module. There is no second policy to drift from this one.
 */

import type { Api } from 'grammy';
import { log } from '../log.js';
import {
  MIN_RENDER_BUDGET,
  RENDER_BUDGET,
  renderHtmlChunks,
  TELEGRAM_TEXT_LIMIT,
} from './markdown.js';

/**
 * The length budget lives with the renderer (it is a property of the rendered
 * string), and is re-exported here so the send path has one obvious import site.
 */
export { MIN_RENDER_BUDGET, RENDER_BUDGET, TELEGRAM_TEXT_LIMIT };

/** How many attempts a retryable failure gets before it is reported and given up on. */
export const SEND_ATTEMPTS = 4;

/** Upper bound on the length of a Telegram error string written to the log. */
const LOG_ERROR_MAX = 300;

export type FailureKind = 'markup' | 'too_long' | 'rate_limit' | 'network' | 'fatal';

/** True for the failures a plain-text retry can plausibly fix. */
export function isDowngradable(kind: FailureKind): boolean {
  return kind === 'markup' || kind === 'too_long';
}

/** True for the failures that must be retried, never downgraded. */
export function isRetryable(kind: FailureKind): boolean {
  return kind === 'rate_limit' || kind === 'network';
}

/** grammy wraps Bot API errors; `error_code` and `parameters.retry_after` are the facts. */
function errorCode(e: unknown): number {
  const c = (e as { error_code?: unknown } | null)?.error_code;
  return typeof c === 'number' ? c : 0;
}

/** Error text with secrets-shaped noise stripped: this goes to `bot.log`. */
function errorText(e: unknown): string {
  const raw = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  return raw
    .replace(/\b\d{6,}:[A-Za-z0-9_-]{30,}\b/g, '[token]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, LOG_ERROR_MAX);
}

/**
 * Classify a Telegram/API failure.
 *
 * Telegram's own wording is the contract, and it is stable across Bot API versions:
 * entity errors arrive as `Bad Request: can't parse entities: Unsupported start tag`,
 * length errors as `Bad Request: message is too long`, flood control as
 * `Too Many Requests: retry after N` (HTTP 429).
 */
export function classifyFailure(e: unknown): FailureKind {
  if (errorCode(e) === 429) return 'rate_limit';
  const t = errorText(e).toLowerCase();
  if (t.includes('too many requests') || t.includes('retry after')) return 'rate_limit';
  if (t.includes('parse entities') || t.includes('unsupported start tag')) return 'markup';
  if (t.includes('find end tag') || t.includes('find closing tag')) return 'markup';
  if (t.includes('too long')) return 'too_long';
  if (
    t.includes('fetch failed') ||
    t.includes('econnreset') ||
    t.includes('econnrefused') ||
    t.includes('etimedout') ||
    t.includes('eai_again') ||
    t.includes('socket hang up') ||
    t.includes('network')
  ) {
    return 'network';
  }
  return 'fatal';
}

/** Seconds Telegram asked us to wait, when it said. */
function retryAfterSeconds(e: unknown): number {
  const n = (e as { parameters?: { retry_after?: unknown } } | null)?.parameters?.retry_after;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/**
 * Report a failure to the log at most once per distinct message.
 *
 * "Once" matters: a rate-limited task can fail the same way a dozen times in a row,
 * and a log that repeats one line per tick buries the one line that matters.
 */
export class FailureLog {
  private readonly seen = new Set<string>();

  constructor(private readonly scope: string) {}

  report(step: string, e: unknown): FailureKind {
    const kind = classifyFailure(e);
    const line = `${step}: ${errorText(e)}`;
    if (!this.seen.has(line)) {
      this.seen.add(line);
      log(`telegram ${this.scope} ${line}`);
    }
    return kind;
  }
}

/**
 * Run one Telegram call, retrying the retryable failures.
 *
 * Markup/length failures are NOT retried here — they need a different payload (smaller
 * chunks, or escaped plain text), which only the caller can build — so they propagate
 * immediately and the caller re-plans the message.
 */
export async function sendWithRetry<T>(
  step: string,
  call: () => Promise<T>,
  failures: FailureLog,
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await call();
    } catch (e) {
      const kind = failures.report(step, e);
      if (!isRetryable(kind)) throw e;
      if (attempt >= SEND_ATTEMPTS) throw e;
      const asked = retryAfterSeconds(e);
      await sleep(Math.min(asked > 0 ? asked * 1000 : 2 ** attempt * 250, 8000));
    }
  }
}

/** Split raw text into Telegram-sized pieces for the plain-text last resort. */
export function splitPlain(text: string, limit = TELEGRAM_TEXT_LIMIT - 16): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += limit) out.push(text.slice(i, i + limit));
  return out;
}

/**
 * Send markdown to a chat as formatted Telegram HTML — THE send path.
 *
 * The chunk budget applies to the RENDERED length (see `renderHtmlChunks`). On a
 * markup/length rejection the body is re-chunked with a halved budget and re-sent; the
 * already-delivered prefix is not re-sent, and because chunking is deterministic from
 * the start, a smaller budget only ever splits the tail more finely, so no message is
 * duplicated and none is lost.
 *
 * Escaped plain text is the last resort, not the first: it is reached only after
 * shrinking has been exhausted, and `failures` has already recorded the real reason.
 */
export async function deliverMarkdown(
  api: Api,
  chatId: number,
  md: string,
  failures: FailureLog,
): Promise<string[]> {
  if (md === '') return [];
  let budget = RENDER_BUDGET;
  let sent = 0;
  for (;;) {
    const chunks = renderHtmlChunks(md, budget);
    try {
      for (let i = sent; i < chunks.length; i += 1) {
        const html = chunks[i] ?? '';
        await sendWithRetry('send', () => api.sendMessage(chatId, html, { parse_mode: 'HTML' }), failures);
        sent = i + 1;
      }
      return chunks;
    } catch (e) {
      const kind = classifyFailure(e);
      if (!isDowngradable(kind)) throw e;
      if (budget > MIN_RENDER_BUDGET) {
        budget = Math.max(MIN_RENDER_BUDGET, Math.floor(budget / 2));
        continue;
      }
      // Last resort, and only after shrinking failed: escaped plain text.
      await deliverPlain(api, chatId, md, failures);
      return chunks;
    }
  }
}

/** Escaped plain text, still split so no single message is over the limit. */
export async function deliverPlain(
  api: Api,
  chatId: number,
  text: string,
  failures: FailureLog,
): Promise<void> {
  if (text === '') return;
  for (const piece of splitPlain(text)) {
    await sendWithRetry('send-plain', () => api.sendMessage(chatId, piece), failures);
  }
}

/**
 * Send one ALREADY-RENDERED chunk (the tail of a streamed answer).
 *
 * The body is HTML, so it cannot be re-chunked the way markdown can: on a markup or
 * length rejection the only smaller option is the escaped text of the same chunk, sent
 * once. Retryable failures (rate limit, network) are retried by `sendWithRetry` and
 * never downgraded.
 */
export async function deliverHtml(
  api: Api,
  chatId: number,
  html: string,
  failures: FailureLog,
): Promise<void> {
  if (html === '') return;
  try {
    await sendWithRetry('send', () => api.sendMessage(chatId, html, { parse_mode: 'HTML' }), failures);
  } catch (e) {
    if (!isDowngradable(classifyFailure(e))) throw e;
    await sendWithRetry('send-plain', () => api.sendMessage(chatId, stripHtml(html)), failures);
  }
}

/**
 * Flatten a rendered chunk back to the text it displays.
 *
 * Only used on the last-resort plain path, so it must be conservative: unknown tags
 * are dropped, `<`/`>` inside them vanish, and the few entities the renderer emits are
 * decoded. A wrong-but-readable line beats a missing answer.
 */
export function stripHtml(html: string): string {
  return html
    .replace(/<\/(?:b|i|u|s|code|pre|a|blockquote)>/g, '')
    .replace(/<br\s*\/?>/g, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}