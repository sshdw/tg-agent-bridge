import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../config.js';

/**
 * W4 shared project discovery: moved verbatim out of
 * `src/telegram/callbacks.ts` so the chat picker and `GET /api/pickers/projects`
 * read the same enumeration. Behaviour identical, no logic changes.
 */

/**
 * One bindable project directory, as offered by the picker.
 *
 * `name` alone is NOT an identity: with `ALLOWED_ROOTS=./work;D:/projects` two roots can
 * each contain a folder called `api`, and binding the wrong one silently runs the agent
 * in the wrong tree. So every entry carries the absolute directory it resolves to, and
 * the callback data holds that path server-side (`nonce.ts`), never the owner's input.
 */
export interface ProjectEntry {
  /** Directory name, for display. */
  name: string;
  /** Absolute directory. This is what `resolveWorkdir` receives. */
  dir: string;
  /** Which configured root it came from. */
  root: string;
  /** Button text: `name` when unique across roots, `name · root-label` otherwise. */
  label: string;
}

/** Short, unambiguous tag for a root: its last path segment (`work`, `projects`). */
export function rootLabel(root: string): string {
  const parts = root.split(/[\\/]+/).filter((p) => p !== '' && p !== '.');
  return parts[parts.length - 1] ?? root;
}

/** Internal folders that are not projects. */
const NON_PROJECT_DIRS = new Set(['inbox', 'node_modules']);

/**
 * Every candidate project directory across ALL configured allowed roots.
 *
 * This is the fix for "почему из разрешенных только эти 3 папки": the old version read
 * `WORK_ROOT` only, so with `ALLOWED_ROOTS=./work;D:/projects` the owner could bind
 * `/project tg-v04` but never saw it offered. Enumeration is a DISCOVERY step — every
 * path still goes through `resolveWorkdir`'s containment guard before it can be used,
 * and names that collide across roots are labelled apart.
 */
export function listProjects(cfg: Config): ProjectEntry[] {
  const found: ProjectEntry[] = [];
  const counts = new Map<string, number>();
  for (const root of cfg.allowedRoots) {
    let names: string[];
    try {
      names = readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .filter((n) => !NON_PROJECT_DIRS.has(n) && !n.startsWith('.'))
        .sort();
    } catch {
      continue;
    }
    for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
    for (const name of names) found.push({ name, dir: join(root, name), root, label: name });
  }
  // Disambiguate only where it is actually needed, so the common case stays one tap.
  const rootLabels = new Map<string, string>();
  for (const root of cfg.allowedRoots) {
    rootLabels.set(root, rootLabel(root));
  }
  for (const e of found) {
    if ((counts.get(e.name) ?? 0) > 1) e.label = `${e.name} · ${rootLabels.get(e.root) ?? e.root}`;
  }
  return found;
}
