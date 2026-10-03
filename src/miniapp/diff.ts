import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

/**
 * W3 task engine: git snapshots before/after a task, per-file unified diffs.
 *
 * Every `git` call goes through `execFileSync('git', …)` with a hard timeout
 * and `windowsHide:true`, synchronously (the queue pump must never block
 * longer than the timeout — plan R3 risk #6). Nothing here ever throws out:
 * any failure (not a repo, no `git` on PATH, timeout) degrades to `null` /
 * empty, and the task itself is unaffected.
 */

/** Hard cap for any single `git` spawn. Longer → kill, treat as truncated. */
export const DIFF_TIMEOUT_MS = 15000;
/** Max unified-diff lines stored per file; beyond that a trailer is appended. */
export const DIFF_MAX_LINES = 200;
/** Files larger than this get name-only rows (`binary: true`, `diff: null`). */
export const DIFF_MAX_FILE_BYTES = 1024 * 1024;
/** Binary probe: a NUL byte in the first bytes means "not text". */
export const DIFF_BINARY_PROBE_BYTES = 8192;
/** Max `task_files` rows stored per task; beyond that counters only. */
export const TASK_FILES_MAX = 50;
/** `tasks.title` length, in code points (never splits a surrogate pair). */
export const TASK_TITLE_LEN = 60;

/** `git status --porcelain` + HEAD before or after a task. */
export interface GitSnapshot {
  /** HEAD sha at snapshot time, or null (empty repo — still a repo). */
  sha: string | null;
  /** Raw `git status --porcelain` output (`''` when clean). */
  porcelain: string;
}

/** One changed file, as stored in `task_files` (plus `task_id`). */
export interface FileChange {
  /** Repo-relative path (forward slashes). */
  path: string;
  added: number;
  removed: number;
  /** Unified diff text (capped), or null for binary/oversize/unreadable. */
  diff: string | null;
  /** True when the diff was cut at `DIFF_MAX_LINES` (trailer appended). */
  truncated: boolean;
  /** True for binary or >1 MB files (name + counters only). */
  binary: boolean;
}

/** `{changed_n, added, removed}` cached on `tasks.files_summary` (JSON). */
export interface FilesSummary {
  changed_n: number;
  added: number;
  removed: number;
}

/** Trailer appended to a capped diff; N = dropped line count. */
export const diffTrailer = (dropped: number): string => `\n…ещё ${dropped} строк`;

/**
 * `tasks.title`: first 60 chars of the prompt. Spread iterates code points,
 * so an astral character (emoji) at the boundary is kept whole or dropped
 * whole — never a lone surrogate.
 */
export function taskTitle(prompt: string, max: number = TASK_TITLE_LEN): string {
  const pts = [...prompt];
  return pts.length <= max ? prompt : pts.slice(0, max).join('');
}

/** Sum a file list into a `files_summary`-shaped object. */
export function summarizeFiles(files: FileChange[]): FilesSummary {
  let added = 0;
  let removed = 0;
  for (const f of files) {
    added += f.added;
    removed += f.removed;
  }
  return { changed_n: files.length, added, removed };
}

/** One `git` spawn. Returns stdout, or null on ANY failure (incl. timeout). */
function git(args: string[], cwd: string): string | null {
  try {
    const out = execFileSync('git', args, {
      cwd,
      timeout: DIFF_TIMEOUT_MS,
      windowsHide: true,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      // A failing git (not a repo, no git, timeout) is routine degradation,
      // not a log event: keep its stderr out of the bot log.
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return typeof out === 'string' ? out : null;
  } catch {
    return null;
  }
}

/**
 * Snapshot a workdir: `{sha, porcelain}`, or null when git is unusable here
 * (not a repo, no `git` on PATH, timeout). An empty repo (no commits yet)
 * still returns a snapshot with `sha: null` — `status` works without HEAD.
 */
export function snapshotGit(workdir: string): GitSnapshot | null {
  let cwd: string;
  try {
    cwd = resolve(workdir);
  } catch {
    return null;
  }
  const status = git(['status', '--porcelain'], cwd);
  if (status === null) return null;
  let sha: string | null = null;
  const rev = git(['rev-parse', 'HEAD'], cwd);
  if (rev !== null) {
    const t = rev.trim();
    if (/^[0-9a-f]{4,40}$/i.test(t)) sha = t;
  }
  return { sha, porcelain: status };
}

/** Repo-relative path of `abs` under `cwd`, or null on escape. */
function relPath(cwd: string, abs: string): string | null {
  const rel = relative(cwd, abs);
  if (rel === '' || rel.startsWith('..') || abs !== join(cwd, rel)) return null;
  // `relative` never returns an absolute path for two absolutes on one drive.
  if (rel.includes('\0')) return null;
  return rel.split(sep).join('/');
}

/** `XY path` porcelain lines → repo-relative paths (rename takes the new side). */
function parsePorcelain(porcelain: string): string[] {
  const out: string[] = [];
  for (const line of porcelain.split('\n')) {
    if (line.length < 4) continue;
    let p = line.slice(3);
    const arrow = p.indexOf(' -> ');
    if (arrow >= 0) p = p.slice(arrow + 4);
    p = p.trim();
    if (p.startsWith('"') && p.endsWith('"') && p.length >= 2) {
      try {
        p = JSON.parse(p) as string;
      } catch {
        p = p.slice(1, -1);
      }
    }
    if (p !== '') out.push(p);
  }
  return out;
}

/** Count `+N`/`-N` over unified-diff text (header `+++`/`---` excluded). */
function countDiffLines(text: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const ln of text.split('\n')) {
    if (ln.startsWith('+') && !ln.startsWith('+++')) added += 1;
    else if (ln.startsWith('-') && !ln.startsWith('---')) removed += 1;
  }
  return { added, removed };
}

/** Cap diff text at `cap` lines; returns `{text, dropped}`. */
function capDiff(text: string, cap: number): { text: string; dropped: number } {
  const lines = text.split('\n');
  if (lines.length <= cap) return { text, dropped: 0 };
  const dropped = lines.length - cap;
  return { text: lines.slice(0, cap).join('\n') + diffTrailer(dropped), dropped };
}

/** True when `git status --porcelain -- <path>` reports untracked (`??`). */
function isUntracked(cwd: string, path: string): boolean {
  const out = git(['status', '--porcelain', '--', path], cwd);
  if (out === null) return false;
  return out.split('\n').some((ln) => ln.startsWith('??'));
}

/**
 * Whole-file diff for an untracked path (`git diff HEAD` is silent on those):
 * `--- /dev/null` + `+++ b/<path>` + one hunk, then the same line cap.
 */
function synthesizeNewFile(abs: string, path: string, cap: number): { diff: string; added: number } | null {
  let content: string;
  try {
    content = readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
  if (content === '') return { diff: `--- /dev/null\n+++ b/${path}\n@@ -0,0 +0,0 @@`, added: 0 };
  const endsNl = content.endsWith('\n');
  const parts = content.split('\n');
  if (endsNl) parts.pop();
  const body = parts.map((ln) => `+${ln}`).join('\n');
  const full = `--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${parts.length} @@\n${body}`;
  const { text } = capDiff(full, cap);
  return { diff: text, added: parts.length };
}

/**
 * Per-file unified diff. Returns `{diff, truncated, binary}` (plus counts).
 * Never throws for filesystem causes — those degrade to null/empty; a bad
 * `workdir`/`path` shape returns zeros. `git` failure (incl. timeout) is
 * reported as `truncated: true` with `diff: null`.
 */
export function unifiedDiff(
  workdir: string,
  path: string,
  cap: number = DIFF_MAX_LINES,
): { diff: string | null; truncated: boolean; binary: boolean; added: number; removed: number } {
  const zeros = { diff: null as string | null, truncated: false, binary: false, added: 0, removed: 0 };
  let cwd: string;
  try {
    cwd = resolve(workdir);
  } catch {
    return zeros;
  }
  if (path === '' || path.includes('\0') || path.startsWith('/') || /^[A-Za-z]:/.test(path)) return zeros;
  const abs = resolve(join(cwd, path));
  if (relPath(cwd, abs) === null) return zeros;

  try {
    const st = statSync(abs);
    if (st.isDirectory()) return zeros;
    if (st.size > DIFF_MAX_FILE_BYTES) return { ...zeros, binary: true };
    if (st.size > 0) {
      const probe = readFileSync(abs).subarray(0, DIFF_BINARY_PROBE_BYTES);
      if (probe.includes(0)) return { ...zeros, binary: true };
    }
  } catch {
    // Missing (deleted) or unreadable: fall through to `git diff HEAD`,
    // which renders deletions; a truly unreadable path yields empty below.
  }

  const out = git(['diff', 'HEAD', '--', path], cwd);
  if (out === null) return { ...zeros, truncated: true };
  if (out === '') {
    // Untracked files are invisible to `git diff HEAD` — synthesize.
    if (isUntracked(cwd, path)) {
      const synth = synthesizeNewFile(abs, path, cap);
      if (synth === null) return zeros;
      return {
        diff: synth.diff,
        truncated: synth.diff.includes('…ещё'),
        binary: false,
        added: synth.added,
        removed: 0,
      };
    }
    return { diff: '', truncated: false, binary: false, added: 0, removed: 0 };
  }
  // Strip the `diff --git`/`index`/mode preamble: the stored text starts at
  // the `--- a/…` header (AC2), and +N/−N counts cover content lines only.
  // No preamble line ever starts with `--- `, so the first hit is the header.
  const rawLines = out.split('\n');
  let start = 0;
  while (start < rawLines.length && !rawLines[start].startsWith('--- ')) start += 1;
  if (start >= rawLines.length) return { ...zeros, truncated: true };
  const text = rawLines.slice(start).join('\n');
  const { added, removed } = countDiffLines(text);
  const capped = capDiff(text, cap);
  return {
    diff: capped.text,
    truncated: capped.dropped > 0,
    binary: false,
    added,
    removed,
  };
}

/**
 * Union of paths changed between two snapshots → per-file diffs.
 * Empty when either side is null (non-git / no-git degrade to "no files").
 * One bad file never kills the collection. Sorted by path.
 */
export function collectTaskFiles(
  before: GitSnapshot | null,
  after: GitSnapshot | null,
  workdir: string,
): FileChange[] {
  if (before === null || after === null) return [];
  const union = new Set([...parsePorcelain(before.porcelain), ...parsePorcelain(after.porcelain)]);
  const out: FileChange[] = [];
  for (const p of union) {
    try {
      const d = unifiedDiff(workdir, p);
      out.push({ path: p, added: d.added, removed: d.removed, diff: d.diff, truncated: d.truncated, binary: d.binary });
    } catch {
      // collect everything else
    }
  }
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}
