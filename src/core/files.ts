import { statSync } from 'node:fs';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/**
 * Files both ways (§1.4): outbound path resolution and inbound filename sanitation.
 *
 * Everything here is pure and synchronous on purpose — it is the security boundary
 * between untrusted Telegram text and the local filesystem, so it must be trivially
 * testable without a bot, a config or a network. Callers in the Telegram layer do
 * the actual sending; this module never touches the Telegram API.
 */

/** Telegram `sendDocument` hard cap. Above this the upload is rejected by Telegram. */
export const MAX_OUTBOUND_BYTES = 50 * 1024 * 1024;

/** Hard cap on the number of auto-attached files per reply — a spam guard, not a feature. */
export const MAX_AUTO_ATTACH = 5;

/**
 * Extensions we will auto-attach without requiring a path separator. Deliberately
 * tiny: a bare word like `README` or `todo` must never be treated as a file.
 */
const AUTO_ATTACH_EXTS = new Set([
  '.md',
  '.txt',
  '.pdf',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.csv',
  '.json',
  '.log',
  '.zip',
  '.tsv',
  '.xlsx',
  '.docx',
  '.yml',
  '.yaml',
  '.ts',
  '.js',
]);

export interface OutboundFile {
  abs: string;
  size: number;
}

/**
 * Resolve a user-supplied path *inside* `workdir` for `/get`.
 *
 * Rejects (never throws for the caller's convenience beyond the documented codes):
 * absolute paths, drive letters, UNC, `..` escapes — but only after `resolve()`,
 * comparing with `sep`, so symlink-free lexical tricks and mixed separators are
 * all caught by the same check.
 *
 * @throws Error with an `E_*` code: `E_PATH_DENIED`, `E_NOT_FOUND`, `E_NOT_FILE`,
 *         `E_FILE_TOO_BIG`, `E_BAD_PATH`.
 *
 * Note: this is the lexical guard the brief asks for. It does NOT resolve symlinks;
 * a symlink inside the workdir pointing outside would still pass (and is created by
 * the agent, which already has full shell access inside the workdir).
 */
export function resolveOutboundFile(
  workdir: string,
  requested: string,
  maxBytes: number = MAX_OUTBOUND_BYTES,
): OutboundFile {
  const raw = requested.trim();
  if (raw === '') throw new Error('E_BAD_PATH');
  // Absolute, drive-letter and UNC forms are refused outright: `/get` only ever
  // serves paths relative to the chat's workdir.
  if (isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith('\\')) {
    throw new Error('E_PATH_DENIED');
  }
  const base = resolve(workdir);
  const abs = resolve(base, raw);
  // Post-resolve containment: the only reliable check. `relative()` yields '' for
  // the workdir itself and a leading `..` segment for anything outside it.
  const rel = relative(base, abs);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) throw new Error('E_PATH_DENIED');

  let st;
  try {
    st = statSync(abs);
  } catch {
    throw new Error('E_NOT_FOUND');
  }
  if (!st.isFile()) throw new Error('E_NOT_FILE');
  if (st.size > maxBytes) throw new Error('E_FILE_TOO_BIG');
  return { abs, size: st.size };
}

/**
 * Make an untrusted Telegram filename safe to join onto a destination directory.
 *
 * Telegram supplies `document.file_name` verbatim, so it may contain traversal,
 * reserved Windows device names, path separators, control characters or nothing at
 * all. Strategy: take the basename only, keep just `[A-Za-z0-9._-]`, collapse
 * leading dots (so `..` and dotfiles cannot survive), refuse reserved device names,
 * and keep the extension. The result is always a single path segment that cannot
 * leave `destDir` once joined.
 *
 * Returns `''` when nothing safe remains — callers must fall back to a generated
 * name (e.g. `${Date.now()}.bin`) rather than writing to `destDir` itself.
 */
export function sanitizeFilename(name: string): string {
  // Take the last segment under BOTH separators; basename() is platform-specific.
  const segments = name.split(/[\\/]+/);
  const last = segments[segments.length - 1] ?? '';
  const cleaned = last.replace(/[^A-Za-z0-9._-]/g, '').replace(/^\.+/, '');
  if (cleaned === '' || cleaned === '.' || cleaned === '..') return '';
  const lower = cleaned.toLowerCase();
  // Windows reserved device names (CON, PRN, AUX, NUL, COM1-9, LPT1-9), with or
  // without an extension: `CON.txt` is still the device.
  const stem = lower.includes('.') ? (lower.split('.')[0] ?? lower) : lower;
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(stem)) return '';
  return cleaned;
}

/**
 * Timestamp-prefixed inbound name so two documents in the same second cannot collide
 * and the result is guaranteed to live directly inside the inbox directory.
 */
export function inboxFilename(original: string, now: number = Date.now()): string {
  const safe = sanitizeFilename(original);
  return `${now}-${safe === '' ? 'file.bin' : safe}`;
}

/** A file reference the agent named in its reply that we may safely attach. */
export interface FileRef {
  token: string;
  abs: string;
}

/**
 * Pull candidate file references out of an agent reply.
 *
 * Conservative by design: a false positive sends a wrong file to the owner's phone,
 * which is worse than sending nothing. A token qualifies only when it
 *   - looks like a path: has a `/` or `\`, or an extension from AUTO_ATTACH_EXTS;
 *   - is not absolute (absolute paths are reported but never resolved outside the
 *     workdir — they simply fail containment);
 *   - resolves strictly inside `workdir`, exists and is a regular file;
 *   - is under `maxBytes`.
 * Results are deduped by resolved absolute path and capped at `limit`.
 */
export function extractFileRefs(
  text: string,
  workdir: string,
  maxBytes: number = MAX_OUTBOUND_BYTES,
  limit: number = MAX_AUTO_ATTACH,
): FileRef[] {
  const tokens = text.match(/[A-Za-z0-9._/\\~-]{3,}/g) ?? [];
  const base = resolve(workdir);
  const seen = new Set<string>();
  const out: FileRef[] = [];
  for (const raw of tokens) {
    if (out.length >= limit) break;
    const token = raw.replace(/[.,;:]+$/, '');
    if (!looksLikePath(token)) continue;
    let abs: string;
    try {
      abs = resolve(base, token);
    } catch {
      continue;
    }
    // Reuse the same containment rule as /get: one guard, one behaviour.
    const rel = relative(base, abs);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) continue;
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (!st.isFile() || st.size > maxBytes) continue;
    if (seen.has(abs)) continue;
    seen.add(abs);
    out.push({ token, abs });
  }
  return out;
}

function looksLikePath(token: string): boolean {
  if (token === '' || token.startsWith('http')) return false;
  if (token.includes('/') || token.includes('\\')) return true;
  return AUTO_ATTACH_EXTS.has(extname(token).toLowerCase());
}

/** Human-facing Russian label for an outbound-file error code, in the app's tone. */
export function outboundErrorMessage(code: string): string {
  const map: Record<string, string> = {
    E_PATH_DENIED: '🔒 Путь вне разрешённых. Укажи файл внутри папки проекта.',
    E_NOT_FOUND: '❌ Файл не найден.',
    E_NOT_FILE: '❌ Это не файл.',
    E_FILE_TOO_BIG: '❌ Файл слишком большой для Telegram (лимит 50 МБ).',
    E_BAD_PATH: '❌ Пустой путь. Использование: /get <файл>',
  };
  return map[code] ?? `❌ Ошибка: ${code}`;
}

/** Extract the leading `E_*` code from a thrown error, or `E_AGENT_FAILED`. */
export function errorCode(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.startsWith('E_') ? (m.split(':')[0] ?? 'E_AGENT_FAILED') : 'E_AGENT_FAILED';
}

/** The basename of a resolved path, for display ("отправляю report.pdf"). */
export function displayName(abs: string): string {
  return basename(abs);
}

/** Join a sanitized name onto a directory; the name is guaranteed single-segment. */
export function joinInbox(dir: string, safeName: string): string {
  // Belt and braces: even though sanitizeFilename() cannot return a separator, the
  // final join is asserted to stay inside `dir` before it is handed to writeFile.
  const abs = join(dir, safeName);
  if (abs !== join(dir, basename(abs))) throw new Error('E_BAD_PATH');
  return abs;
}

export { sep as pathSep };
