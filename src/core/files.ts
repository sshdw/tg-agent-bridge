import { readdirSync, statSync } from 'node:fs';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/**
 * Files both ways (§1.4): outbound path resolution, the `[[attach:…]]` protocol,
 * inbound filename sanitation, and the `/files` listing.
 *
 * Everything here is pure and synchronous on purpose — it is the security boundary
 * between untrusted Telegram text and the local filesystem, so it must be trivially
 * testable without a bot, a config or a network. Callers in the Telegram layer do
 * the actual sending; this module never touches the Telegram API.
 */

/** Telegram `sendDocument` hard cap. Above this the upload is rejected by Telegram. */
export const MAX_OUTBOUND_BYTES = 50 * 1024 * 1024;

/**
 * Telegram's photo cap, far below the document one. A bigger image still goes out as a
 * document (see `sendOutboundFile`), but a photo we promised is refused early with a
 * message that names the real limit.
 */
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

/**
 * Extensions Telegram shows inline as a photo. Decided by extension, not by content:
 * sniffing a file's bytes to guess an image type would let a `.txt` masquerade as one.
 */
export const PHOTO_EXTENSIONS: ReadonlySet<string> = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
]);

/** True when `name` (a path or a filename) names something Telegram will render inline. */
export function isPhotoName(name: string): boolean {
  return PHOTO_EXTENSIONS.has(extname(name).toLowerCase());
}

/** Size cap for `name`: the photo cap for images, the document cap for everything else. */
export function outboundCapFor(name: string): number {
  return isPhotoName(name) ? MAX_PHOTO_BYTES : MAX_OUTBOUND_BYTES;
}

/** How many bytes `/files` lists before it stops and says how many there were. */
export const FILES_LIST_LIMIT = 40;

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
 * True when `rel` (a `relative(base, abs)` result) climbs out of `base`.
 * Segment-aware: a literal dirname like `..foo` starts with two dots but stays
 * inside, so only an exact `..` segment counts.
 *
 * `rel === ''` means the target IS `base` — that is containment, not escape. It
 * happens whenever the requested path is `.` or `./`, which is how an owner
 * naturally asks for "the project root" from `/get .` or `/files .`. Callers
 * then apply their own kind check (`isFile()` / `isDirectory()`), so allowing it
 * here cannot widen access; rejecting it only produced a bogus "папка вне
 * разрешённых".
 */
function escapesBase(rel: string): boolean {
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
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
  if (raw === '' || raw.includes('\0')) throw new Error('E_BAD_PATH');
  // Absolute, drive-letter and UNC forms are refused outright: `/get` only ever
  // serves paths relative to the chat's workdir.
  if (isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith('\\')) {
    throw new Error('E_PATH_DENIED');
  }
  const base = resolve(workdir);
  const abs = resolve(base, raw);
  // Post-resolve containment: the only reliable check. `relative()` yields '' for
  // the workdir itself and a leading `..` segment for anything outside it.
  if (escapesBase(relative(base, abs))) throw new Error('E_PATH_DENIED');

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
  const seen = new Set<string>();
  const out: FileRef[] = [];
  for (const raw of tokens) {
    if (out.length >= limit) break;
    const token = raw.replace(/[.,;:]+$/, '');
    if (!looksLikePath(token)) continue;
    // One guard for every outbound path: /get, `[[attach:…]]` and this guesser all go
    // through resolveOutboundFile, so none of them can be weaker than the others.
    let abs: string;
    try {
      abs = resolveOutboundFile(workdir, token, maxBytes).abs;
    } catch {
      continue;
    }
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
export function outboundErrorMessage(code: string, maxBytes = MAX_OUTBOUND_BYTES): string {
  const mb = Math.round(maxBytes / (1024 * 1024));
  const map: Record<string, string> = {
    E_PATH_DENIED: '🔒 Путь вне разрешённых. Укажи файл внутри папки проекта.',
    E_NOT_FOUND: '❌ Файл не найден.',
    E_NOT_FILE: '❌ Это не файл.',
    E_NOT_DIR: '❌ Это не папка.',
    E_FILE_TOO_BIG: `❌ Файл слишком большой для Telegram (лимит ${mb} МБ).`,
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

/**
 * The explicit attachment protocol.
 *
 * The agent writes `[[attach:relative/path.png]]` on its own line. Guessing from
 * whatever paths a reply happens to mention works only when the agent guesses the
 * magic word; a marker makes it a documented instruction (see the prompt line in
 * `gateway/spawnRunner.ts`) instead of folklore. The marker is stripped from the
 * visible reply and never reaches the phone — not even mid-stream, hence
 * `AttachCensor` below.
 */
const ATTACH_INLINE_RE = /( ?)\[\[\s*attach\s*:\s*([^\]\r\n]{0,300}?)\s*\]\]( ?)/gi;
const ATTACH_LINE_RE = /^[ \t]*\[\[\s*attach\s*:[^\]\r\n]{0,300}\]\][ \t]*$/;

/** The visible text of a reply plus every path it asked to attach. */
export interface AttachScan {
  text: string;
  paths: string[];
}

/**
 * Strip `[[attach:…]]` markers and collect the requested paths.
 *
 * A marker alone on its line disappears with the line; an inline marker leaves one
 * space. Both keep the surrounding prose readable on a phone, and neither touches
 * anything else in the reply. An empty marker (`[[attach:]]`) is stripped like any
 * other and yields an empty path, which `resolveOutboundFile` then refuses as
 * `E_BAD_PATH` — the protocol text never reaches the phone either way.
 */
export function extractAttachMarkers(md: string): AttachScan {
  const paths: string[] = [];
  const lines: string[] = [];
  for (const line of md.split('\n')) {
    const ownLine = ATTACH_LINE_RE.test(line);
    const replaced = line.replace(ATTACH_INLINE_RE, (_m, before: string, path: string, after: string) => {
      paths.push(path.trim());
      if (ownLine) return '';
      // Swallow one neighbouring space when both sides have one, so `a [[attach:x]] b`
      // becomes `a b` rather than `a  b`. Nothing else is collapsed.
      return before !== '' && after !== '' ? '' : ' ';
    });
    if (ownLine) continue;
    lines.push(replaced);
  }
  const text = lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text, paths };
}

/**
 * Streaming filter that keeps attach markers out of the live message.
 *
 * `push` must be able to emit text immediately, but a marker arrives one token at a
 * time, so the tail after the last unclosed `[[` is held back until the closing `]]`
 * arrives. A marker that is still incomplete when `finish` lands is dropped outright:
 * showing half of it would be worse than showing none of it.
 */
export class AttachCensor {
  private held = '';

  /** Append `delta` and return the text that is safe to display now. */
  push(delta: string): string {
    const buf = this.held + delta;
    const stripped = buf.replace(ATTACH_INLINE_RE, ' ');
    const open = stripped.lastIndexOf('[[');
    const close = stripped.lastIndexOf(']]');
    if (open > close) {
      this.held = stripped.slice(open);
      return stripped.slice(0, open);
    }
    this.held = '';
    return stripped;
  }

  /** Final text: any marker still half-written is dropped, not shown. */
  finish(text: string): string {
    return extractAttachMarkers(text).text;
  }
}

/**
 * Resolve a directory inside the chat workdir for `/files <subdir>`.
 *
 * Same containment rule as `resolveOutboundFile` (absolute forms refused, post-resolve
 * `relative()` check), so a subdir argument can never walk out of the workdir.
 *
 * @throws Error with `E_BAD_PATH`, `E_PATH_DENIED`, `E_NOT_FOUND` or `E_NOT_DIR`.
 */
export function resolveOutboundDir(workdir: string, requested: string): { abs: string; rel: string } {
  const raw = requested.trim();
  if (raw === '' || raw.includes('\0')) throw new Error('E_BAD_PATH');
  if (isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith('\\')) {
    throw new Error('E_PATH_DENIED');
  }
  const base = resolve(workdir);
  const abs = resolve(base, raw);
  if (escapesBase(relative(base, abs))) throw new Error('E_PATH_DENIED');
  let st;
  try {
    st = statSync(abs);
  } catch {
    throw new Error('E_NOT_FOUND');
  }
  if (!st.isDirectory()) throw new Error('E_NOT_DIR');
  return { abs, rel: raw === '' ? '' : raw };
}

/** One row of `/files`. */
export interface FileEntry {
  name: string;
  /** Path relative to the chat workdir, ready for `/get <path>` or `[[attach:<path>]]`. */
  rel: string;
  size: number;
  mtimeMs: number;
  isDir: boolean;
}

/** Directories a project listing must not walk into: huge, machine-generated, never sent. */
const SKIP_DIRS: ReadonlySet<string> = new Set(['node_modules', '.git', 'dist', 'inbox', 'out']);

/**
 * List a workdir (or a subdir of it) for `/files`: directories first, then files by
 * modified time, newest first, capped at `limit`. Returns the rows plus the total count
 * so the caller can say "показано 40 из 812".
 */
export function listDir(dir: string, workdir: string, limit = FILES_LIST_LIMIT): { entries: FileEntry[]; total: number } {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    throw new Error('E_NOT_FOUND');
  }
  const entries: FileEntry[] = [];
  let total = 0;
  for (const name of names.sort()) {
    if (name.startsWith('.')) continue;
    let st;
    try {
      st = statSync(join(dir, name));
    } catch {
      continue;
    }
    const isDir = st.isDirectory();
    if (isDir && SKIP_DIRS.has(name.toLowerCase())) continue;
    total += 1;
    if (entries.length >= limit) continue;
    const rel = relative(resolve(workdir), join(dir, name));
    entries.push({ name, rel, size: st.size, mtimeMs: st.mtimeMs, isDir });
  }
  entries.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return b.mtimeMs - a.mtimeMs;
  });
  return { entries, total };
}

/** One `[[attach:…]]` request the guard refused, kept for the owner's error message. */
export interface AttachProblem {
  requested: string;
  code: string;
}

/** What to show, what to upload, and what the guard rejected. */
export interface AttachmentPlan {
  /** The reply with every marker removed — this is what the phone sees. */
  text: string;
  /** Absolute paths to upload, in the order the agent asked for them. */
  files: string[];
  problems: AttachProblem[];
}

/**
 * Turn an agent reply into a visible text plus the files to send.
 *
 * Explicit markers win; the conservative path guesser is only a fallback for an answer
 * that used no marker at all. Every accepted path goes through `resolveOutboundFile`,
 * so a marker can neither escape the workdir nor exceed the cap for its kind (10 MB for
 * a photo, 50 MB for a document). A rejected marker is reported instead of silently
 * dropped — the owner asked for a file and deserves to learn why it did not arrive.
 */
export function planAttachments(md: string, workdir: string, limit = MAX_AUTO_ATTACH): AttachmentPlan {
  const scan = extractAttachMarkers(md);
  const files: string[] = [];
  const problems: AttachProblem[] = [];
  const seen = new Set<string>();
  for (const requested of scan.paths) {
    if (files.length >= limit) break;
    if (seen.has(requested)) continue;
    seen.add(requested);
    if (requested === '') {
      problems.push({ requested: '(пусто)', code: 'E_BAD_PATH' });
      continue;
    }
    try {
      const { abs } = resolveOutboundFile(workdir, requested, outboundCapFor(requested));
      if (files.includes(abs)) continue;
      files.push(abs);
    } catch (e) {
      problems.push({ requested, code: errorCode(e) });
    }
  }
  if (files.length === 0) {
    for (const ref of extractFileRefs(scan.text, workdir, MAX_OUTBOUND_BYTES, limit)) files.push(ref.abs);
  }
  return { text: scan.text, files, problems };
}
