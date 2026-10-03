import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

/**
 * W3 task engine: git snapshots before/after a task, per-file unified diffs.
 *
 * Every `git` call goes through `execFileSync('git', …)` with a hard per-spawn
 * timeout (15 s) and `windowsHide:true`, synchronously. A whole per-task
 * collection is additionally bounded by DIFF_BUDGET_MS (30 s, deadline
 * threading through snapshotGit/collectTaskFiles/unifiedDiff): worst-case
 * event-loop block per task ≈ budget + one in-flight spawn + SQLite writes.
 * Nothing here ever throws out: any failure (not a repo, no `git` on PATH,
 * timeout, expired budget) degrades to `null` / empty / `truncated`, and the
 * task itself is unaffected.
 */

/** Hard cap for any single `git` spawn. Longer → kill, treat as truncated. */
export const DIFF_TIMEOUT_MS = 15000;
/** Whole per-task collection bound (M6): snapshot + all per-file diffs. */
export const DIFF_BUDGET_MS = 30000;
/** Empty-tree sha (well-known constant): diff base when the repo had no HEAD at task start. */
export const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
/** Max unified-diff lines stored per file; beyond that a trailer is appended. */
export const DIFF_MAX_LINES = 200;
/**
 * Files larger than this get name-only rows (`binary: true`, `diff: null`).
 * Spec §W3 caps: oversize TEXT is stored identically to binary — W4 must
 * document `binary:true` as "binary or oversize" in the API (m5).
 */
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
  /**
   * Per-path content signatures at snapshot time (B1 dirt filter): existing
   * files → `h:<git hash-object>`; paths missing at snapshot time (deletions)
   * → `d:<git diff HEAD -- path>`. Absent key = unknown → conservative keep.
   */
  sigs: Record<string, string>;
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
 * Enforce the ≤200-line cap on an arbitrary diff text (m3 defense in depth
 * for `saveTaskFiles`, which must not trust callers to have capped).
 */
export function enforceDiffCap(text: string, cap: number = DIFF_MAX_LINES): string {
  const lines = text.split('\n');
  if (lines.length <= cap) return text;
  return lines.slice(0, cap).join('\n') + diffTrailer(lines.length - cap);
}

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
 * Snapshot a workdir: `{sha, porcelain, sigs}`, or null when git is unusable
 * here (not a repo, no `git` on PATH, timeout). An empty repo (no commits
 * yet) still returns a snapshot with `sha: null` — `status` works without
 * HEAD. `-uall` lists new files inside new directories individually (B2: no
 * collapsed `sub/` phantom rows). Signature collection stops at `deadlineMs`;
 * missing sigs degrade to conservative keep.
 */
export function snapshotGit(
  workdir: string,
  deadlineMs: number = Number.POSITIVE_INFINITY,
): GitSnapshot | null {
  let cwd: string;
  try {
    cwd = resolve(workdir);
  } catch {
    return null;
  }
  const status = git(['-c', 'core.quotePath=false', 'status', '--porcelain', '-uall'], cwd);
  if (status === null) return null;
  let sha: string | null = null;
  const rev = git(['rev-parse', 'HEAD'], cwd);
  if (rev !== null) {
    const t = rev.trim();
    if (/^[0-9a-f]{4,40}$/i.test(t)) sha = t;
  }
  const snap: GitSnapshot = { sha, porcelain: status, sigs: {} };
  for (const p of parsePorcelain(status)) {
    if (Date.now() >= deadlineMs) break;
    const sig = fileSignature(cwd, p);
    if (sig !== null) snap.sigs[p] = sig;
  }
  return snap;
}

/**
 * Content signature of one snapshot-listed path. Existing files hash by
 * content (`git hash-object` works for tracked and untracked alike); paths
 * missing at snapshot time (deletions, rename old sides) fall back to their
 * `git diff HEAD` text. Null = unknown (git failed) → the caller keeps the
 * file rather than risk losing a real change.
 */
function fileSignature(cwd: string, path: string): string | null {
  let exists = false;
  try {
    exists = !statSync(resolve(join(cwd, path))).isDirectory();
  } catch {
    exists = false;
  }
  if (exists) {
    const h = git(['hash-object', '--', path], cwd);
    if (h !== null && /^[0-9a-f]{40}$/i.test(h.trim())) return `h:${h.trim()}`;
    return null;
  }
  const d = git(['-c', 'core.quotePath=false', 'diff', 'HEAD', '--', path], cwd);
  return d === null ? null : `d:${d}`;
}

/** Repo-relative path of `abs` under `cwd`, or null on escape. */
function relPath(cwd: string, abs: string): string | null {
  const rel = relative(cwd, abs);
  if (rel === '' || rel.startsWith('..') || abs !== join(cwd, rel)) return null;
  // `relative` never returns an absolute path for two absolutes on one drive.
  if (rel.includes('\0')) return null;
  return rel.split(sep).join('/');
}

/**
 * `XY path` porcelain lines → repo-relative paths. Rename lines
 * (`R  old -> new`) push BOTH sides (M2): the old side then records its
 * deletion, symmetric with the unstaged case. C-unquoting is a fallback —
 * callers pass `-c core.quotePath=false`, so names normally arrive verbatim.
 */
function parsePorcelain(porcelain: string): string[] {
  const out: string[] = [];
  const push = (p: string): void => {
    p = p.trim();
    if (p.startsWith('"') && p.endsWith('"') && p.length >= 2) {
      try {
        p = JSON.parse(p) as string;
      } catch {
        p = p.slice(1, -1);
      }
    }
    if (p !== '') out.push(p);
  };
  for (const line of porcelain.split('\n')) {
    if (line.length < 4) continue;
    const p = line.slice(3);
    const arrow = p.indexOf(' -> ');
    if (arrow >= 0) {
      push(p.slice(0, arrow));
      push(p.slice(arrow + 4));
    } else {
      push(p);
    }
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
 * A NUL anywhere in the content means binary (M4: the 8 KB probe in
 * `unifiedDiff` cannot see past its window) → `{binary: true, diff: null}`.
 */
function synthesizeNewFile(
  abs: string,
  path: string,
  cap: number,
): { diff: string | null; added: number; binary: boolean } {
  let content: string;
  try {
    content = readFileSync(abs, 'utf8');
  } catch {
    return { diff: null, added: 0, binary: false };
  }
  if (content.includes('\0')) return { diff: null, added: 0, binary: true };
  if (content === '') return { diff: `--- /dev/null\n+++ b/${path}\n@@ -0,0 +0,0 @@`, added: 0, binary: false };
  const endsNl = content.endsWith('\n');
  const parts = content.split('\n');
  if (endsNl) parts.pop();
  const body = parts.map((ln) => `+${ln}`).join('\n');
  const full = `--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${parts.length} @@\n${body}`;
  const { text } = capDiff(full, cap);
  return { diff: text, added: parts.length, binary: false };
}

/**
 * Per-file unified diff. Returns `{diff, truncated, binary}` (plus counts).
 * Never throws for filesystem causes — those degrade to null/empty; a bad
 * `workdir`/`path` shape returns zeros. `git` failure (incl. timeout) is
 * reported as `truncated: true` with `diff: null`. `base` (a commit sha, or
 * the empty-tree sha) diffs worktree-vs-base instead of worktree-vs-HEAD
 * (M1: task changes committed mid-run). Past `deadlineMs` → truncated stub.
 */
export function unifiedDiff(
  workdir: string,
  path: string,
  cap: number = DIFF_MAX_LINES,
  deadlineMs: number = Number.POSITIVE_INFINITY,
  base: string | null = null,
): { diff: string | null; truncated: boolean; binary: boolean; added: number; removed: number } {
  const zeros = { diff: null as string | null, truncated: false, binary: false, added: 0, removed: 0 };
  if (Date.now() >= deadlineMs) return { ...zeros, truncated: true };
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

  const diffArgs =
    base === null
      ? ['-c', 'core.quotePath=false', 'diff', 'HEAD', '--', path]
      : ['-c', 'core.quotePath=false', 'diff', base, '--', path];
  const out = git(diffArgs, cwd);
  if (out === null) return { ...zeros, truncated: true };
  if (out === '') {
    // Untracked files are invisible to `git diff` (any base) — synthesize.
    if (isUntracked(cwd, path)) {
      const synth = synthesizeNewFile(abs, path, cap);
      return {
        diff: synth.diff,
        truncated: synth.diff !== null && synth.diff.includes('…ещё'),
        binary: synth.binary,
        added: synth.added,
        removed: 0,
      };
    }
    return { diff: '', truncated: false, binary: false, added: 0, removed: 0 };
  }
  // Strip the `diff --git`/`index`/mode preamble: the stored text starts at
  // the `--- a/…` header (AC2), and +N/−N counts cover content lines only.
  // No preamble line ever starts with `--- `, so the first hit is the header.
  // A git-rendered binary stub has no header → binary (never a raw leak).
  if (out.includes('Binary files ') && !out.includes('\n--- ')) {
    return { ...zeros, binary: true };
  }
  const rawLines = out.split('\n');
  let start = 0;
  while (start < rawLines.length && !rawLines[start].startsWith('--- ')) start += 1;
  if (start >= rawLines.length) return { ...zeros, truncated: true };
  const text = rawLines.slice(start).join('\n');
  // Belt and braces (M4): no NUL byte may ever reach the DB.
  if (text.includes('\0')) return { ...zeros, binary: true };
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
 * Storage guard (m4 defense in depth): repo-relative forward-slash paths
 * only. Rejects absolute paths, drive letters, `..`/`.`/empty segments and
 * anything with a NUL or `:` (no ADS streams, no alternate syntax) — even
 * though git output is safe in practice. Null = skip the row.
 */
export function sanitizeDiffPath(p: string): string | null {
  const fwd = p.replace(/\\/g, '/');
  if (fwd === '' || fwd.includes('\0') || fwd.startsWith('/') || /^[A-Za-z]:/.test(fwd)) return null;
  for (const seg of fwd.split('/')) {
    if (seg === '' || seg === '.' || seg === '..' || seg.includes(':')) return null;
  }
  return fwd;
}

/**
 * Union of paths changed between two snapshots → per-file diffs.
 * Empty when either side is null (non-git / no-git degrade to "no files").
 *
 * B1 attribution: a path is DROPPED when its AFTER signature is byte-identical
 * to the BEFORE signature (pre-existing dirt the task never touched), or when
 * it is absent from the AFTER porcelain while present in BEFORE (returned to
 * HEAD-clean — the empty diff it would render is noise). Missing BEFORE sig =
 * unknown = conservative keep.
 *
 * M1 mid-run commits: when `after.sha !== before.sha`, the committed range
 * (`git diff --name-only <base> HEAD`, base = before.sha or the empty tree)
 * joins the union, and per-file content diffs run worktree-vs-base so
 * committed task changes stay visible.
 *
 * M6 budget: past `deadlineMs`, remaining union paths become
 * `{diff: null, truncated: true}` stubs (counted, flagged, no spawns).
 * One bad file never kills the collection. Sorted by path.
 */
export function collectTaskFiles(
  before: GitSnapshot | null,
  after: GitSnapshot | null,
  workdir: string,
  deadlineMs: number = Number.POSITIVE_INFINITY,
): FileChange[] {
  if (before === null || after === null) return [];
  const beforeSigs = before.sigs ?? {};
  const afterPaths = new Set(parsePorcelain(after.porcelain));
  const union = new Set([...parsePorcelain(before.porcelain), ...afterPaths]);
  let cwd: string | null = null;
  try {
    cwd = resolve(workdir);
  } catch {
    return [];
  }
  // M1: HEAD moved during the task — list the committed range too.
  let base: string | null = null;
  const ranged = new Set<string>();
  if (before.sha !== after.sha && after.sha !== null && Date.now() < deadlineMs) {
    const rangeBase = before.sha ?? EMPTY_TREE_SHA;
    const names = git(['diff', '--name-only', rangeBase, 'HEAD', '--'], cwd);
    if (names !== null) {
      for (const ln of names.split('\n')) {
        const t = ln.trim();
        if (t !== '') {
          union.add(t);
          ranged.add(t);
        }
      }
      base = rangeBase;
    }
  }
  const out: FileChange[] = [];
  for (const p of union) {
    if (Date.now() >= deadlineMs) {
      out.push({ path: p, added: 0, removed: 0, diff: null, truncated: true, binary: false });
      continue;
    }
    try {
      // B1: returned to HEAD-clean — the empty diff it would render is noise.
      // (Range-committed paths (M1) are exempt: clean worktree is expected.)
      if (!afterPaths.has(p) && !ranged.has(p)) continue;
      const beforeSig: string | undefined = beforeSigs[p];
      if (beforeSig !== undefined) {
        const afterSig = fileSignature(cwd, p);
        // Byte-identical signature = pre-existing dirt the task never touched.
        if (afterSig !== null && afterSig === beforeSig) continue;
      }
      const d = unifiedDiff(workdir, p, DIFF_MAX_LINES, deadlineMs, base);
      out.push({ path: p, added: d.added, removed: d.removed, diff: d.diff, truncated: d.truncated, binary: d.binary });
    } catch {
      // collect everything else
    }
  }
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}
