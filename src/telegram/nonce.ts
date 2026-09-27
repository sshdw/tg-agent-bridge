import { randomBytes } from 'node:crypto';

/**
 * Server-side nonce registry for inline-keyboard callbacks.
 *
 * Callback data is untrusted input: the user (or a forged update) controls it end
 * to end, and Telegram echoes it back verbatim. So callback data carries NOTHING but
 * `scope:nonce` — a short scope name plus an opaque token. Everything that matters
 * (which chat, which path, which command) lives here, on the server, keyed by the
 * nonce. A path, a command, a branch name or a secret must never appear in callback
 * data; see docs/PROMPT-ENGINEER-V02.md §1.2.
 *
 * Guarantees:
 *  - per-chat isolation: a nonce minted for chat A is invisible to chat B;
 *  - 15-minute TTL (overridable), enforced on lookup and swept opportunistically;
 *  - single-use: `take` deletes the entry, so an approve/deny or an update-confirm
 *    cannot be replayed by tapping the button twice;
 *  - unguessable tokens from `randomBytes`, never `Math.random`.
 */

export const DEFAULT_TTL_MS = 15 * 60 * 1000;

/** A short, safe scope name: letters only, so `scope:nonce` stays parseable. */
const SCOPE_RE = /^[a-z][a-z0-9_]*$/;

interface Entry {
  scope: string;
  payload: string;
  expiresAt: number;
  chatId: number;
}

/** chatId -> (nonce -> entry). Keyed per chat so lookups cannot cross chats. */
const registry = new Map<number, Map<string, Entry>>();

/** How often the opportunistic sweep runs, at most, on access. */
const SWEEP_MS = 60 * 1000;
let lastSweep = 0;

/** Mint a 16-byte, URL-safe, unguessable nonce. */
function mint(): string {
  return randomBytes(16).toString('base64url');
}

export function encodeCallback(scope: string, nonce: string): string {
  return `${scope}:${nonce}`;
}

/** Split `scope:nonce`; returns null when the shape is not exactly two parts. */
export function parseCallback(data: string): { scope: string; nonce: string } | null {
  const i = data.indexOf(':');
  if (i <= 0 || i === data.length - 1) return null;
  const scope = data.slice(0, i);
  const nonce = data.slice(i + 1);
  if (!SCOPE_RE.test(scope)) return null;
  return { scope, nonce };
}

/** Drop expired entries. Cheap enough to run on any access at most once a minute. */
function sweep(now: number): void {
  if (now - lastSweep < SWEEP_MS) return;
  lastSweep = now;
  for (const [chatId, entries] of registry) {
    for (const [nonce, e] of entries) {
      if (e.expiresAt <= now) entries.delete(nonce);
    }
    if (entries.size === 0) registry.delete(chatId);
  }
}

/** Store a payload for a scope and return the opaque nonce to embed in a button. */
export function put(chatId: number, scope: string, payload: string, ttlMs = DEFAULT_TTL_MS): string {
  const now = Date.now();
  sweep(now);
  const nonce = mint();
  let entries = registry.get(chatId);
  if (!entries) {
    entries = new Map<string, Entry>();
    registry.set(chatId, entries);
  }
  entries.set(nonce, { scope, payload, expiresAt: now + ttlMs, chatId });
  return nonce;
}

/**
 * Look up a nonce for a scope and CONSUME it. Returns null for a wrong chat, a wrong
 * scope, an expired nonce, an already-used nonce, or garbage — all treated alike.
 */
export function take(chatId: number, scope: string, nonce: string): string | null {
  const now = Date.now();
  sweep(now);
  const entries = registry.get(chatId);
  if (!entries) return null;
  const e = entries.get(nonce);
  // A wrong scope is not this button's consumer: leave the entry intact and return
  // null. Only a matching, unexpired entry is consumed (single-use).
  if (!e || e.scope !== scope) return null;
  entries.delete(nonce);
  if (entries.size === 0) registry.delete(chatId);
  if (e.expiresAt <= now) return null;
  return e.payload;
}

/** Look up without consuming. Same null semantics as `take`. */
export function peek(chatId: number, scope: string, nonce: string): string | null {
  const now = Date.now();
  sweep(now);
  const e = registry.get(chatId)?.get(nonce);
  if (!e || e.scope !== scope || e.expiresAt <= now) return null;
  return e.payload;
}

/**
 * Consume every nonce for a chat (optionally narrowed to one scope). Used when the
 * message that owned a keyboard is gone, so its buttons stop working.
 */
export function clear(chatId: number, scope?: string): void {
  if (scope === undefined) {
    registry.delete(chatId);
    return;
  }
  const entries = registry.get(chatId);
  if (!entries) return;
  for (const [nonce, e] of entries) {
    if (e.scope === scope) entries.delete(nonce);
  }
  if (entries.size === 0) registry.delete(chatId);
}

/**
 * Keep a nonce alive while a long-running decision is still pending: extends its
 * expiry without creating a new token, so the button the user already sees works.
 */
export function refresh(chatId: number, scope: string, nonce: string, ttlMs = DEFAULT_TTL_MS): boolean {
  const now = Date.now();
  sweep(now);
  const e = registry.get(chatId)?.get(nonce);
  if (!e || e.scope !== scope || e.expiresAt <= now) return false;
  e.expiresAt = now + ttlMs;
  return true;
}
