import { mkdirSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { Config } from '../config.js';

/** Personal bot: only whitelisted chat ids get any response. Others are silently ignored. */
export function isAllowed(cfg: Config, chatId: number): boolean {
  return cfg.allowedChatIds.includes(chatId);
}

/**
 * Resolve the workdir for a chat. `project` is either '' (default per-chat sandbox),
 * a name (resolved inside WORK_ROOT) or an absolute path (must be inside ALLOWED_ROOTS).
 * Throws E_PATH_DENIED on any escape attempt.
 */
export function resolveWorkdir(cfg: Config, chatId: number, project: string): string {
  let dir: string;
  if (project === '') {
    dir = join(cfg.workRoot, String(chatId));
  } else if (/^[A-Za-z]:[\\/]/.test(project) || project.startsWith('/') || project.startsWith('\\\\')) {
    dir = resolve(project);
  } else {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(project)) throw new Error('E_BAD_PROJECT');
    dir = join(cfg.workRoot, project);
  }
  const abs = resolve(dir);
  const inside = cfg.allowedRoots.some((r) => abs === r || abs.startsWith(r + sep));
  if (!inside) throw new Error('E_PATH_DENIED');
  mkdirSync(abs, { recursive: true });
  mkdirSync(join(abs, 'inbox'), { recursive: true });
  return abs;
}
