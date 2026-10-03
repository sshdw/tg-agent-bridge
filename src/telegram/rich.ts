/**
 * Bot API 10.1 "Rich Messages" — native markdown rendering, narrow adapter.
 *
 * Telegram parses the rich markdown SERVER-SIDE into a structured block tree, so a
 * pipe table, a heading or a nested list renders as an actual table/list instead of
 * the `|---|` soup the HTML parse mode degrades to. Three methods matter:
 *
 *   - `sendRichMessage`      — one message, up to RICH_TEXT_LIMIT characters;
 *   - `editMessageText` with a `rich_message` parameter — replace the content of a
 *     message we already posted (used for the live edit of a streamed answer);
 *   - `sendRichMessageDraft` — a private-chat draft that expires in ~30 s and MUST be
 *     finalised with a real `sendRichMessage`. Deliberately NOT used, see
 *     `src/telegram/stream.ts`.
 *
 * Two facts drive this module's shape:
 *
 * 1. The pinned grammY release predates Bot API 10.1, so its types have no
 *    `sendRichMessage`. `api.raw` is a Proxy that binds `callApi` for ANY method
 *    name, so the runtime can call the new method while a narrow local type keeps
 *    the rest of the codebase strongly typed. No `any`, no cast of the whole Api.
 *
 * 2. Capability is PROBED ONCE and cached, never guessed per call. The probe sends
 *    an empty payload: `chat_id` is required, so Telegram must answer `Bad Request`
 *    when the method exists and `404 Not Found: method not found` when it does not —
 *    and with no `chat_id` nothing can possibly be delivered to a chat. The verdict
 *    is latched for the process lifetime; an inconclusive probe (rate limit, network
 *    blip) latches NOTHING and is retried after a short backoff, so a transient
 *    failure can never cost the owner the feature for the rest of the session.
 */

import type { Api } from 'grammy';
import { log } from '../log.js';

/** Telegram's own limit for one rich message, in characters. */
export const RICH_TEXT_LIMIT = 32768;

/** Telegram's own limit for blocks in one rich message. */
export const RICH_BLOCK_LIMIT = 500;

/** Telegram's own limit for nesting depth in one rich message. */
export const RICH_NESTING_LIMIT = 16;

/** What we know about this bot account's support for Rich Messages. */
export type RichSupport = 'unknown' | 'supported' | 'unsupported';

/** The three raw methods this module may call. Optional: grammy binds any name. */
interface RawRichApi {
  sendRichMessage?: (payload: Record<string, unknown>) => Promise<unknown>;
  sendRichMessageDraft?: (payload: Record<string, unknown>) => Promise<unknown>;
  editMessageText?: (payload: Record<string, unknown>) => Promise<unknown>;
}

/**
 * The raw API object, or null when this client cannot reach new methods at all
 * (an old grammY build, or a test double). Detection is defensive on purpose: a
 * missing `raw` must degrade to the HTML path, never throw into a send.
 */
export function rawRichApi(api: Api): RawRichApi | null {
  const raw = (api as { raw?: unknown }).raw;
  if (raw === null || typeof raw !== 'object') return null;
  const typed = raw as RawRichApi;
  if (typeof typed.sendRichMessage !== 'function') return null;
  return typed;
}

/** Telegram's error text, whitespace-collapsed. */
function errorText(e: unknown): string {
  const raw = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  return raw.replace(/\s+/g, ' ').trim().toLowerCase();
}

function errorCode(e: unknown): number {
  const c = (e as { error_code?: unknown } | null)?.error_code;
  return typeof c === 'number' ? c : 0;
}

/**
 * True ONLY for "this Bot API method does not exist on this server".
 *
 * A bare 404 is not enough: `Bad Request: chat not found` is also a 404-shaped
 * rejection, and latching the whole process off rich because a chat was deleted
 * would be a silent, permanent downgrade. The method-not-found wording is the
 * contract that distinguishes the two.
 */
export function isMethodUnsupported(e: unknown): boolean {
  if (errorCode(e) !== 404) return false;
  const t = errorText(e);
  return t.includes('method not found') || t.includes('unknown method') || t.includes('not found: method');
}

/** True for a rejected PARAMETER, which is what an empty probe payload produces. */
function isBadRequest(e: unknown): boolean {
  if (errorCode(e) === 400) return true;
  return errorText(e).includes('bad request');
}

/** Transient shapes: rate limit, network, Telegram 5xx. Never a capability verdict. */
function isTransient(e: unknown): boolean {
  if (errorCode(e) === 429) return true;
  const t = errorText(e);
  return /too many requests|retry after|fetch failed|econnreset|econnrefused|etimedout|eai_again|socket hang up|network|internal server error|bad gateway|service unavailable/.test(t);
}

/* --------------------------------------------------------------- capability */

let support: RichSupport = 'unknown';
/** While inconclusive, do not re-probe more often than this (network/rate limit). */
let nextProbeAt = 0;
let inflight: Promise<RichSupport> | null = null;

/** How long to wait before re-probing after an inconclusive answer. */
export const PROBE_RETRY_MS = 60 * 1000;

/** The current verdict. `'unknown'` means "not probed, or probed inconclusively". */
export function richSupport(): RichSupport {
  return support;
}

/** Latch the capability. Exported for the offline harness; production never calls it. */
export function setRichSupport(next: RichSupport): void {
  support = next;
}

/** Drop all cached capability state. Offline harness only. */
export function resetRichSupport(): void {
  support = 'unknown';
  nextProbeAt = 0;
  inflight = null;
}

/**
 * Find out whether this account can send Rich Messages. Cached, coalesced and
 * incapable of throwing: an unknown verdict simply means "use the HTML path".
 *
 * The probe payload is `{}` on purpose. `chat_id` is a required field of every
 * send method, so Telegram rejects it as `Bad Request` (method exists) or answers
 * `404 Not Found: method not found` (pre-10.1 server) — and with no `chat_id` there
 * is no chat to post to, so the probe cannot spam anything.
 */
export async function probeRichSupport(api: Api): Promise<RichSupport> {
  if (support !== 'unknown') return support;
  if (inflight !== null) return inflight;
  if (Date.now() < nextProbeAt) return 'unknown';

  inflight = (async (): Promise<RichSupport> => {
    const raw = rawRichApi(api);
    if (raw === null) {
      // This client cannot call new methods at all: permanent, so it is latched.
      support = 'unsupported';
      return support;
    }
    try {
      await raw.sendRichMessage?.({});
      // Unreachable in practice (a required field is missing). If it ever happens we
      // learned nothing, so we must NOT latch "supported" on a guess.
      nextProbeAt = Date.now() + PROBE_RETRY_MS;
      return 'unknown';
    } catch (e) {
      if (isMethodUnsupported(e)) {
        support = 'unsupported';
        log('telegram rich messages: unsupported (probe: method not found)');
        return support;
      }
      if (isBadRequest(e)) {
        support = 'supported';
        log('telegram rich messages: supported (probe: bad request, as expected)');
        return support;
      }
      if (isTransient(e)) {
        // Deliberately no latch: a 429 or a network blip says nothing about the
        // server's capabilities, and the answer must not downgrade later sends.
        nextProbeAt = Date.now() + PROBE_RETRY_MS;
        log(`telegram rich messages: probe inconclusive (${errorText(e).slice(0, 120)})`);
        return 'unknown';
      }
      nextProbeAt = Date.now() + PROBE_RETRY_MS;
      return 'unknown';
    }
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

/**
 * Latch the capability off after a REAL send or edit was rejected as an unknown method.
 *
 * This is the safety net for the case where the probe was inconclusive (a network blip
 * on the very first call): the first real rejection costs one round trip, and then the
 * process stays on the HTML path forever.
 */
function noteUnsupported(e: unknown): boolean {
  if (!isMethodUnsupported(e)) return false;
  if (support !== 'unsupported') log('telegram rich messages: unsupported (send rejected)');
  support = 'unsupported';
  return true;
}

/** Latch the capability on after a real send succeeded. Cheap and truthful. */
function noteSupported(): void {
  if (support === 'unknown') support = 'supported';
}

/* ------------------------------------------------------------------- limits */

/**
 * Conservative estimate of the block tree Telegram will build from this markdown.
 *
 * Paragraph runs collapse into ONE block, while headings, list items, block-quote
 * lines, table rows and every line inside a fence count separately. Over-counting
 * is the safe direction: it can only push a borderline answer onto the proven HTML
 * path, and even a wrong estimate is not fatal because a rich send rejected for
 * blocks/length falls back to HTML (see `deliverMarkdown`).
 */
export function estimateRichBlocks(md: string): number {
  let blocks = 0;
  let inFence = false;
  let paragraphOpen = false;
  const closeParagraph = (): void => {
    paragraphOpen = false;
  };
  for (const raw of md.split('\n')) {
    const line = raw.trimEnd();
    if (line.trim() === '') {
      closeParagraph();
      continue;
    }
    if (/^\s{0,3}(?:```|~~~)/.test(line)) {
      closeParagraph();
      inFence = !inFence;
      blocks += 1; // the fence delimiter itself is a block
      continue;
    }
    if (inFence) {
      blocks += 1; // a code line renders as its own block
      continue;
    }
    // Outside a fence, a line that opens its own construct is its own block: a heading,
    // a list item, a block-quote line, or a table row (header, delimiter or body — each
    // is a row of the block table Telegram builds). Everything else is a paragraph run:
    // one block, however many lines it spans.
    const startsOwnBlock =
      /^\s{0,3}#{1,6}\s/.test(line) ||
      /^\s*(?:[-*+]\s|\d+[.)]\s|>\s?)/.test(line) ||
      line.includes('|');
    if (startsOwnBlock) {
      blocks += 1;
      paragraphOpen = false;
      continue;
    }
    if (!paragraphOpen) blocks += 1;
    paragraphOpen = true;
  }
  return blocks;
}

/** Deepest list/quote nesting, in levels. Blockquote and list markers both count. */
export function estimateRichNesting(md: string): number {
  let deepest = 0;
  let inFence = false;
  for (const raw of md.split('\n')) {
    const line = raw.replace(/\t/g, '  ');
    if (/^\s{0,3}(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || line.trim() === '') continue;
    if (!/^\s*(?:[-*+]\s|\d+[.)]\s|>\s?)/.test(line)) continue;
    const indent = line.length - line.trimStart().length;
    // Two spaces (or one tab) per nesting level; a marker itself is level 1.
    const level = Math.max(1, Math.floor(indent / 2) + 1);
    if (level > deepest) deepest = level;
  }
  return deepest;
}

/** Code points in the string, which is how Telegram counts "characters". */
function codePoints(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    // Skip the low half of a surrogate pair: one code point, two UTF-16 units.
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) i += 1;
    n += 1;
  }
  return n;
}

/**
 * True when this markdown fits the rich limits as ONE message.
 *
 * The length limit is counted in CODE POINTS, because that is what Telegram
 * documents — a Russian answer of 30 000 characters is a 30 000-character message even
 * though it is ~60 000 bytes in UTF-8. Counting bytes instead would push every Cyrillic
 * answer of ~16 000 characters back onto the ten-message HTML path and throw away the
 * entire win. `md.length` (UTF-16 units) is checked as well, so astral characters
 * (emoji) are never allowed to smuggle a message past a limit Telegram might count
 * differently. A 10 000-character answer therefore stays ONE message.
 */
export function richFits(md: string): boolean {
  if (md === '') return false;
  if (md.length > RICH_TEXT_LIMIT) return false;
  if (codePoints(md) > RICH_TEXT_LIMIT) return false;
  if (estimateRichBlocks(md) > RICH_BLOCK_LIMIT) return false;
  if (estimateRichNesting(md) > RICH_NESTING_LIMIT) return false;
  return true;
}

/**
 * The longest prefix of `md` that is safe to show live: at most `maxChars`
 * characters, cut on a line boundary, with any open code fence closed so the block
 * tree stays balanced.
 */
export function richPrefix(md: string, maxChars = RICH_TEXT_LIMIT): string {
  if (md.length <= maxChars) {
    const open = openFence(md);
    return open === null ? md : `${md}\n${open}`;
  }
  const cut = md.lastIndexOf('\n', maxChars);
  const head = md.slice(0, cut > 0 ? cut : maxChars);
  const open = openFence(head);
  return open === null ? head : `${head}\n${open}`;
}

/**
 * The fence marker still open at the end of `md`, or null when it is balanced.
 *
 * A fence's body is literal text, so a ``` line inside a ~~~ block toggles
 * nothing; only a marker of the same character and at least the same length closes
 * an open fence.
 */
function openFence(md: string): string | null {
  let open: string | null = null;
  for (const line of md.split('\n')) {
    const m = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (m === null) continue;
    const marker = m[1] ?? '';
    if (open === null) open = marker;
    else if (marker[0] === open[0] && marker.length >= open.length) open = null;
  }
  return open;
}

/** The closing fence `md` still needs, exposed for the offline harness. */
export function richFenceTail(md: string): string {
  return openFence(md) ?? '';
}

/* ----------------------------------------------------------------- raw calls */

/** One native rich message. `md` is sent byte-for-byte: no HTML, no rewriting. */
export async function sendRichMarkdown(api: Api, chatId: number, md: string): Promise<number> {
  const raw = rawRichApi(api);
  if (raw === null) throw new Error('E_NO_RICH_API');
  try {
    const res = (await raw.sendRichMessage?.({
      chat_id: chatId,
      rich_message: { markdown: md },
    })) as { message_id?: unknown } | undefined;
    noteSupported();
    return typeof res?.message_id === 'number' ? res.message_id : 0;
  } catch (e) {
    // Only a "method not found" verdict changes the latched capability; every other
    // failure (rate limit, network, markup, length) is handled by the caller's policy.
    noteUnsupported(e);
    throw e;
  }
}

/**
 * Replace the content of a message we already posted with rich markdown.
 *
 * The `rich_message` parameter on `editMessageText` is documented in Bot API 10.1. A
 * "method not found" here latches the capability off process-wide, so a server that
 * rejects the parameter costs one round trip and never another.
 */
export async function editRichMarkdown(
  api: Api,
  chatId: number,
  messageId: number,
  md: string,
): Promise<void> {
  const raw = rawRichApi(api);
  if (raw === null) throw new Error('E_NO_RICH_API');
  try {
    await raw.editMessageText?.({
      chat_id: chatId,
      message_id: messageId,
      rich_message: { markdown: md },
    });
    noteSupported();
  } catch (e) {
    noteUnsupported(e);
    throw e;
  }
}