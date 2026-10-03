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
 * ## One decision per answer: rich OR html, never both
 *
 * Bot API 10.1 parses rich markdown server-side, so a table or a heading renders
 * natively and the 4096-character HTML budget stops applying. That is decided ONCE
 * per answer by `planDelivery` (capability probe + rich limits) and then THREADED
 * explicitly through `deliverMarkdown(mode)`. The return value describes what was
 * really sent — one rich message, or N rendered HTML chunks — so a caller can never
 * assume a format the transport did not use.
 *
 * The rendered-HTML path is unchanged and remains the fallback for a pre-10.1
 * Telegram server, for markdown that busts the rich limits, and for a rich send
 * rejected on its own content.
 *
 * Every Telegram send in the bot goes through here or through `stream.ts`, which uses
 * this module. There is no second policy to drift from this one.
 */

import type { Api } from 'grammy';
import { log } from '../log.js';
import { probeRichSupport, richFits, sendRichMarkdown } from './rich.js';
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
 * How one answer leaves the bot, decided ONCE by `planDelivery` and threaded through
 * every function that touches the transport. There is no per-message re-decision:
 * a stream that starts in rich mode finishes in rich mode, and a stream that starts
 * in HTML mode never sends one lone native block.
 */
export type DeliveryMode = 'rich' | 'html';

/**
 * What actually reached the chat. `bodies` is the truth: one raw markdown string on
 * the rich path, N rendered HTML chunks on the fallback path. Callers that need to
 * report or count what the owner saw read this, never the mode they asked for.
 */
export interface DeliveryResult {
  mode: DeliveryMode | 'plain';
  /** How many messages were sent. 1 for rich, N for the HTML fallback, N for plain. */
  messages: number;
  rich: boolean;
  bodies: string[];
}

const EMPTY: DeliveryResult = { mode: 'html', messages: 0, rich: false, bodies: [] };

/**
 * Decide the transport for one answer: native rich markdown, or rendered HTML.
 *
 * `richFits` is checked first because a 10 000-character answer must stay ONE message
 * — that is the entire win of the rich path over a 4096-character HTML budget, and it
 * is decided before any chunking happens. The capability probe is cached in `rich.ts`,
 * so this costs one map lookup per answer after the first, not a round trip per task.
 */
export async function planDelivery(api: Api, md: string): Promise<DeliveryMode> {
  if (!richFits(md)) return 'html';
  return (await probeRichSupport(api)) === 'supported' ? 'rich' : 'html';
}

/**
 * Send markdown to a chat — THE send path.
 *
 * In rich mode the markdown goes out byte-for-byte as one native rich message: no
 * HTML conversion, no table rewriting, no splitting. Telegram renders the table.
 *
 * If the rich send is refused — the method does not exist (latched off by `rich.ts`)
 * or our markdown busts a rich limit — the SAME markdown is re-planned as HTML and
 * delivered by the chunked renderer below, which is the path that already carries the
 * whole reply policy: rendered-length budgeting, shrink-and-retry on markup/length
 * rejection, escaped plain text only as the last resort.
 *
 * A rate limit or a network failure is NOT a reason to change format: `sendWithRetry`
 * has already retried it and this function re-throws, so a transient fault can never
 * turn a formatted answer into plain text or latch the capability off.
 */
export async function deliverMarkdown(
  api: Api,
  chatId: number,
  md: string,
  failures: FailureLog,
  mode?: DeliveryMode,
): Promise<DeliveryResult> {
  if (md === '') return EMPTY;
  const planned = mode ?? (await planDelivery(api, md));
  if (planned === 'rich') {
    const one = await deliverRich(api, chatId, md, failures);
    if (one !== null) return one;
    log('telegram send: rich rejected, falling back to html chunks');
  }
  return deliverHtmlChunked(api, chatId, md, failures);
}

/** One native rich message, or null when the HTML fallback should take over. */
async function deliverRich(
  api: Api,
  chatId: number,
  md: string,
  failures: FailureLog,
): Promise<DeliveryResult | null> {
  try {
    await sendWithRetry('send-rich', () => sendRichMarkdown(api, chatId, md), failures);
    return { mode: 'rich', messages: 1, rich: true, bodies: [md] };
  } catch (e) {
    const kind = classifyFailure(e);
    // Transient: retried already, format unchanged, capability unchanged.
    if (isRetryable(kind)) throw e;
    // `rich.ts` has already latched the capability off when the method is missing.
    if (kind === 'fatal') return null;
    failures.report('send-rich', e);
    return null;
  }
}

/**
 * The rendered-HTML fallback: markdown -> Telegram HTML, chunked on the RENDERED
 * length.
 *
 * The budget applies to the RENDERED length (see `renderHtmlChunks`). On a
 * markup/length rejection the body is re-chunked with a halved budget and re-sent; the
 * already-delivered prefix is not re-sent, and because chunking is deterministic from
 * the start, a smaller budget only ever splits the tail more finely, so no message is
 * duplicated and none is lost.
 *
 * Escaped plain text is the last resort, not the first: it is reached only after
 * shrinking has been exhausted, and `failures` has already recorded the real reason.
 */
export async function deliverHtmlChunked(
  api: Api,
  chatId: number,
  md: string,
  failures: FailureLog,
): Promise<DeliveryResult> {
  if (md === '') return EMPTY;
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
      return { mode: 'html', messages: chunks.length, rich: false, bodies: chunks };
    } catch (e) {
      const kind = classifyFailure(e);
      if (!isDowngradable(kind)) throw e;
      if (budget > MIN_RENDER_BUDGET) {
        budget = Math.max(MIN_RENDER_BUDGET, Math.floor(budget / 2));
        continue;
      }
      // Last resort, and only after shrinking failed: escaped plain text.
      const pieces = splitPlain(md);
      await deliverPlain(api, chatId, md, failures);
      return { mode: 'plain', messages: pieces.length, rich: false, bodies: pieces };
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