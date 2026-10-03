import { mkdirSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { Config } from '../config.js';

/** Personal bot: only whitelisted chat ids get any response. Others are silently ignored. */
export function isAllowed(cfg: Config, chatId: number): boolean {
  return cfg.allowedChatIds.includes(chatId);
}

/**
 * The single containment guard. Every path that reaches the filesystem — a `/project`
 * binding, `/get`, `/exec` cwd, an agent workdir — passes through this function.
 *
 * Two shapes are accepted and nothing else:
 *   - `''`  -> the per-chat sandbox inside WORK_ROOT;
 *   - a path (bare name or absolute) that, after `resolve()`, lands inside one of
 *     `cfg.allowedRoots`.
 *
 * A bare name is looked up across EVERY allowed root, not just WORK_ROOT, which is
 * what makes `ALLOWED_ROOTS=./work;D:/projects` work: `/project tg-v04` resolves to the
 * copy under `D:/projects`. When the same name exists in more than one root we refuse
 * rather than guess, because binding the wrong tree silently runs the agent in the
 * wrong directory — the picker solves it by passing the absolute path instead.
 *
 * Rejected by construction: `..` escapes (normalised away, then containment-checked),
 * absolute paths outside every root, drive-letter/UNC/device tricks (`\\?\`, `\\.\`,
 * `//`), and anything else that fails the containment test.
 */
export function resolveWorkdir(cfg: Config, chatId: number, project: string): string {
  const abs = resolveProjectDir(cfg, project, chatId);
  mkdirSync(abs, { recursive: true });
  mkdirSync(join(abs, 'inbox'), { recursive: true });
  return abs;
}

/**
 * Resolve a project selector to an absolute directory WITHOUT touching the filesystem.
 *
 * Split out from `resolveWorkdir` so the picker and the harness can prove what a
 * selector maps to (and that escapes are refused) without creating anything. Throws
 * `E_PATH_DENIED` for anything outside the allowed roots, and `E_AMBIGUOUS_PROJECT`
 * for a bare name that exists in more than one root.
 */
export function resolveProjectDir(cfg: Config, project: string, chatId?: number): string {
  if (project === '') {
    return resolve(join(cfg.workRoot, chatId === undefined ? 'default' : String(chatId)));
  }
  // Windows device / UNC / NT prefixes are never a legitimate project path. Refused
  // by shape, before `resolve()` gets a chance to normalise something clever.
  if (project.includes('\0') || hasWindowsPrefix(project)) {
    throw new Error('E_PATH_DENIED');
  }
  const abs = isAbsoluteLike(project) ? resolve(project) : resolveBareName(cfg, project);
  if (!isInsideRoots(cfg, abs)) throw new Error('E_PATH_DENIED');
  return abs;
}

/**
 * `\\server\share`, `//server/share`, `\\?\C:\...`, `\\.\device` — every shape that
 * turns a "relative-looking" string into something outside the roots.
 */
function hasWindowsPrefix(p: string): boolean {
  return p.startsWith('\\\\') || p.startsWith('//');
}

/** A path that names a location on its own, as opposed to a directory name. */
function isAbsoluteLike(project: string): boolean {
  return (
    /^[A-Za-z]:[\\/]/.test(project) ||
    /^[A-Za-z]:$/.test(project) ||
    project.startsWith('/') ||
    hasWindowsPrefix(project)
  );
}

/**
 * A bare name may only be a plain directory name — no separators, no `..`, no drive
 * letter. Anything else is treated as an escape attempt rather than normalised.
 */
const BARE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._ -]*$/;

/** A directory that really exists (symlinks/loops surface as "not a directory"). */
function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Find `name` under the allowed roots.
 *
 * Only roots where the name is an EXISTING directory count as a hit — otherwise a
 * single real project would look ambiguous purely because it has not been created in
 * the other roots yet. WORK_ROOT is preferred (the sandbox root every chat shares),
 * then the remaining roots in configured order. A name that exists nowhere is created
 * under WORK_ROOT, which is the pre-existing behaviour for a new project.
 */
function resolveBareName(cfg: Config, name: string): string {
  if (!BARE_NAME_RE.test(name) || name === '.' || name === '..' || name.includes('..')) {
    throw new Error('E_PATH_DENIED');
  }
  const roots = [cfg.workRoot, ...cfg.allowedRoots.filter((r) => r !== cfg.workRoot)];
  const hits: string[] = [];
  for (const root of roots) {
    const candidate = resolve(join(root, name));
    if (!isInsideRoots(cfg, candidate)) continue;
    if (!isDir(candidate)) continue;
    // On a case-insensitive filesystem two spellings can be the same directory.
    const key = process.platform === 'win32' ? candidate.toLowerCase() : candidate;
    if (!hits.some((h) => (process.platform === 'win32' ? h.toLowerCase() : h) === key)) hits.push(candidate);
  }
  if (hits.length > 1) throw new Error('E_AMBIGUOUS_PROJECT');
  return hits[0] ?? resolve(join(cfg.workRoot, name));
}

/** The containment test itself: equal to a root, or strictly below one of them. */
export function isInsideRoots(cfg: Config, abs: string): boolean {
  return cfg.allowedRoots.some((r) => abs === r || abs.startsWith(r + sep));
}

/**
 * Russian, owner-facing reason a selector was refused. Kept next to the guard so the
 * two cannot drift apart.
 */
export function projectDeniedMessage(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  if (m.includes('E_AMBIGUOUS_PROJECT')) {
    return '⚠️ Такая папка есть в нескольких корнях. Выбери её кнопкой или укажи полный путь.';
  }
  return '🔒 Папка вне разрешённых. Смотри ALLOWED_ROOTS в .env.';
}