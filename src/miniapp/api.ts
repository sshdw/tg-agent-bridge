import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, relative, resolve } from 'node:path';
import { AGENT_IDS } from '../config.js';
import type { Config } from '../config.js';
import { resolveApprovalById } from '../core/approvals.js';
import { listDir, MAX_OUTBOUND_BYTES, resolveOutboundDir, resolveOutboundFile } from '../core/files.js';
import { resolveWorkdir } from '../core/permissions.js';
import { listProjects } from '../core/projects.js';
import { dropAgentSession, getOrCreate, updateSession } from '../core/sessions.js';
import { listSkills, parseSkillNames, SKILL_NAME_MAX, SKILL_NAME_RE } from '../core/queue.js';
import type { TaskQueue } from '../core/queue.js';
import { cachedModels, modelLabel } from '../gateway/models.js';
import { availableProviders } from '../gateway/registry.js';
import type { TaskMode } from '../gateway/types.js';
import type { AgentId } from '../gateway/types.js';
import { taskTitle, unifiedDiff } from './diff.js';
import type { Store, TaskRow } from '../storage/db.js';
import { VERSION } from '../version.js';

/**
 * W4 API surface: ALL §5.1 handlers as pure functions
 * `(env, chatId, method, pathname, query, body) → ApiResult`.
 *
 * Transport (guard, JSON framing, 304/413, binary download) stays in `http.ts`.
 * `chatId` is the VERIFIED identity from W1's guard (`user.id`) — never a
 * client-supplied chat id. Every resource id is chat-scoped before use, so one
 * chat can neither read nor mutate another chat's tasks/drafts/approvals.
 *
 * Design-contract obligations (no UI in this wave, but the contract carries them):
 * - `abs` is always a full absolute path (W6 needs it);
 * - `elapsed_s` is computed server-side (never client clocks);
 * - `title` is ≤ 60 chars (computed at submit; fallback here never exceeds it).
 */

export interface ApiEnv {
  cfg: Config;
  store: Store;
  queue: TaskQueue;
  startTimeMs: number;
  heartbeatPath: string;
}

export interface ApiResult {
  status: number;
  /** JSON body (serialised by http.ts). Absent for 304 / raw responses. */
  body?: unknown;
  /** Binary payload (download). When present, `body` is ignored. */
  raw?: Buffer;
  headers?: Record<string, string>;
}

/** Prompt/comment limits shared by drafts, tasks and rework (§5.1). */
export const PROMPT_MAX = 8000;
export const COMMENT_MAX = 2000;
/** Preview serves the head of a text file; the rest is flagged, not sent. */
export const PREVIEW_MAX = 64 * 1024;
/** Binary probe window (NUL byte in the head means "not text"). */
const BINARY_PROBE = 8192;
/** §5.1 line 298: heartbeat older than this ⇒ the UI shows "бот недоступен". */
export const HEARTBEAT_STALE_S = 90;
/** Persistence for the skills `auto` flag inside `skill_pins` (no schema change). */
export const SKILLS_AUTO_SENTINEL = '__auto__';

/**
 * Path separator contract (m11): `abs` is the OS-native absolute path exactly as
 * the resolver produced it (`D:\…` on Windows) — it is what the owner copies
 * and what the guard proved, so it is never rewritten. `entries[].rel` and every
 * task-relative `path` are ALWAYS forward-slash (`src/a.ts`); W6 builds links
 * from `rel` and displays `abs` verbatim.
 */

/** JSON booleans everywhere, never 0/1 (m2): `truncated`/`binary` in
 * `/api/tasks/:id/files`, `truncated` in `/api/tasks/:id/diff` and
 * `/api/files/{preview,diff}`. §5.1 line 314 writes `0` for one and line 315
 * writes `false` for another — the document contradicts itself; BOOLEAN is the
 * choice, and the per-row `binary` flag is contracted here (a binary row has no
 * diff at all, so the list must say so instead of making W6 fetch a 404). */

const nowSec = (): number => Math.floor(Date.now() / 1000);
const elapsedOf = (createdAt: number): number => Math.max(0, nowSec() - createdAt);

/** Short SHA of the working tree, resolved once (same approach as http.ts). */
let cachedSha: string | null = null;
function apiSha(): string {
  if (cachedSha === null) {
    try {
      cachedSha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      }).trim();
    } catch {
      cachedSha = 'unknown';
    }
  }
  return cachedSha;
}
const skillsOf = (json: string | null | undefined): string[] => parseSkillNames(json ?? '[]');
const titleOf = (row: { title: string | null; prompt: string }): string => row.title ?? taskTitle(row.prompt);

function err(status: number, error: string, extra?: Record<string, unknown>): ApiResult {
  return { status, body: { error, ...(extra ?? {}) } };
}

/**
 * Body keys a write endpoint accepts. Unknown keys are REFUSED (m7), never
 * ignored: a client that misspells `skills` or sends an option this build does
 * not implement must learn about it from a 400, not from a silently different
 * run. `plan` is deliberately absent — the canonical trigger is `mode:"plan"`
 * (BLOCKER 1), so `{plan:true}` is an unknown field with a pointed hint.
 */
function unknownKey(body: Record<string, unknown>, allowed: readonly string[]): string | null {
  for (const k of Object.keys(body)) {
    if (!allowed.includes(k)) return k;
  }
  return null;
}

function bodyShapeError(body: unknown, allowed: readonly string[]): ApiResult | null {
  if (body === undefined || body === null) return null;
  if (typeof body !== 'object' || Array.isArray(body)) return err(400, 'E_BAD_ARG', { detail: 'body must be an object' });
  const bad = unknownKey(body as Record<string, unknown>, allowed);
  if (bad === null) return null;
  return err(400, 'E_BAD_ARG', {
    detail:
      bad === 'plan'
        ? 'use mode:"plan" — the boolean "plan" field is not part of the contract'
        : `unknown field: ${bad}`,
  });
}

/** Agent id from a stored string, undefined when it is not a known agent. */
function agentArg(v: string | null | undefined): AgentId | undefined {
  return typeof v === 'string' && (AGENT_IDS as readonly string[]).includes(v) ? (v as AgentId) : undefined;
}

/** `''`/`undefined` mean "not set" — let the session decide. */
function strArg(v: string | null | undefined): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

function skillsSummary(store: Store, taskId: number): { changed_n: number; added: number; removed: number } {
  try {
    return store.taskFilesSummary(taskId);
  } catch {
    return { changed_n: 0, added: 0, removed: 0 };
  }
}

/** Full task view for `GET /api/tasks/:id` (explicit columns only — see Store.*Api). */
function taskView(store: Store, row: TaskRow): Record<string, unknown> {
  return {
    id: row.id,
    title: titleOf(row),
    agent: row.agent,
    model: row.model,
    project: row.project,
    mode: row.mode,
    status: row.status,
    prompt: row.prompt,
    plan_text: row.plan_text,
    cost_usd: row.cost_usd,
    skills_used: skillsOf(row.skills_used),
    files_summary: skillsSummary(store, row.id),
    rev: row.rev,
    elapsed_s: elapsedOf(row.created_at),
    created_at: row.created_at,
    finished_at: row.finished_at,
  };
}

/** Chat-scoped task lookup: foreign or missing ids are 404 (never 403 — no oracle). */
function scopedTask(store: Store, id: number, chatId: number): TaskRow | undefined {
  const row = store.getTaskApi(id);
  if (!row || row.chat_id !== chatId) return undefined;
  return row;
}

/**
 * The canonical run mode as it travels on the wire: `ask` | `code` | `plan`.
 *
 * `plan` is the ONE canonical plan trigger (fix-round decision for BLOCKER 1):
 * it rides the existing contract field `mode` instead of adding a second,
 * silently-ignorable flag. It maps to `TaskMode 'code'` + `planOnly: true`,
 * because `TaskMode` is frozen at `'ask' | 'code'` (`src/gateway/types.ts:3`)
 * and the plan TURN, not the mode string, is what parks the task.
 */
type WireMode = 'ask' | 'code' | 'plan';

function parseMode(v: unknown): WireMode | null {
  if (v === 'ask' || v === 'code' || v === 'plan') return v;
  return null;
}

const TASK_MODE: Record<WireMode, TaskMode> = { ask: 'ask', code: 'code', plan: 'code' };

/** Shared `mode` + `skills` validation for `POST /api/drafts` and `/api/tasks`. */
function parseRunBody(body: unknown): { prompt: string; mode: WireMode; skills: string[] } | ApiResult {
  const shape = bodyShapeError(body, ['prompt', 'mode', 'skills']);
  if (shape !== null) return shape;
  const b = (body ?? {}) as { prompt?: unknown; mode?: unknown; skills?: unknown };
  if (!validPrompt(b.prompt)) return err(400, 'E_BAD_ARG');
  const mode = b.mode === undefined ? 'ask' : parseMode(b.mode);
  if (mode === null) return err(400, 'E_BAD_ARG');
  const skills = parseSkills(b.skills);
  if (skills === null) return err(400, 'E_BAD_ARG');
  return { prompt: b.prompt, mode, skills };
}

function parseSkills(v: unknown): string[] | null {
  if (v === undefined) return [];
  if (!Array.isArray(v)) return null;
  for (const s of v) {
    if (typeof s !== 'string' || !SKILL_NAME_RE.test(s) || s.length > SKILL_NAME_MAX) return null;
  }
  return [...v] as string[];
}

function validPrompt(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= PROMPT_MAX;
}

/** Session workdir, with guard errors mapped to API errors (null = ok). */
function workdirOf(env: ApiEnv, chatId: number): { dir: string } | ApiResult {
  try {
    const s = getOrCreate(env.store, env.cfg, chatId);
    return { dir: resolveWorkdir(env.cfg, chatId, s.project) };
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    if (m.includes('E_PATH_DENIED')) return err(403, 'E_PATH_DENIED');
    return err(400, 'E_BAD_ARG');
  }
}

function outboundError(e: unknown): ApiResult {
  const m = e instanceof Error ? e.message : String(e);
  const code = m.startsWith('E_') ? (m.split(':')[0] ?? 'E_AGENT_FAILED') : 'E_AGENT_FAILED';
  switch (code) {
    case 'E_PATH_DENIED':
      return err(403, 'E_PATH_DENIED');
    case 'E_NOT_FOUND':
      return err(404, 'E_NOT_FOUND');
    case 'E_FILE_TOO_BIG':
      return err(413, 'E_FILE_TOO_BIG');
    default:
      return err(400, 'E_BAD_ARG');
  }
}

/* ------------------------------------------------------------ endpoint impls */

async function getHealth(env: ApiEnv, chatId: number): Promise<ApiResult> {
  const { cfg, store } = env;
  // m9: real probes, not literals. `db` is the live journal mode, and the two
  // liveness numbers are the same signals W1's guard-side code uses.
  let db = 'error';
  let pending = 0;
  try {
    db = store.journalMode();
    pending = store.pendingCount(chatId);
  } catch {
    db = 'error';
  }
  let stale: number | null = null;
  try {
    const mtime = statSync(env.heartbeatPath).mtimeMs;
    stale = Math.max(0, Math.floor((Date.now() - mtime) / 1000));
  } catch {
    stale = null;
  }
  // The API has no handle on the grammy loop (W1 owns it, `src/index.ts` is not
  // part of this module), so "polling alive" is derived from the SAME heartbeat
  // the Mini App already treats as the liveness signal: fresh ⇒ this process is
  // up and ticking ⇒ polling; missing or >90 s stale ⇒ `stale`/`unknown`, which
  // is what §5.1 line 298 tells the UI to render as "бот недоступен".
  const telegram = stale === null ? 'unknown' : stale > HEARTBEAT_STALE_S ? 'stale' : 'polling';
  const whisperReady =
    cfg.whisperBin !== '' && cfg.voiceModelPath !== '' && existsSync(cfg.whisperBin) && existsSync(cfg.voiceModelPath);
  return {
    status: 200,
    body: {
      ok: true,
      version: VERSION,
      sha: apiSha(),
      uptime_s: Math.max(0, Math.floor((Date.now() - env.startTimeMs) / 1000)),
      telegram,
      agent: cfg.opencodeBin !== '' ? `opencode:${cfg.opencodeBin}` : 'missing',
      github: cfg.githubToken !== '' ? 'present' : 'absent',
      whisper: whisperReady ? 'ready' : 'missing',
      db,
      pending,
      stale_s: stale,
    },
  };
}

function getCurrent(env: ApiEnv, chatId: number): ApiResult {
  const running = env.store.runningTaskApi(chatId);
  const plan = env.store.awaitingPlanApi(chatId);
  const approval = env.store.pendingApproval(chatId);
  return {
    status: 200,
    body: {
      running: running
        ? {
            id: running.id,
            title: titleOf(running),
            agent: running.agent,
            model: running.model,
            project: running.project,
            mode: running.mode,
            status: running.status,
            elapsed_s: elapsedOf(running.created_at),
            rev: running.rev,
            cost_usd: running.cost_usd,
          }
        : null,
      pending_n: env.store.pendingCount(chatId),
      plan: plan ? { task_id: plan.id, reworks: plan.plan_reworks ?? 0 } : null,
      approval: approval ? { id: approval.id, command: approval.command } : null,
    },
  };
}

function getRecent(env: ApiEnv, chatId: number, query: URLSearchParams): ApiResult {
  const limitRaw = query.get('limit') ?? '20';
  const offsetRaw = query.get('offset') ?? '0';
  const limit = Number(limitRaw);
  const offset = Number(offsetRaw);
  if (!Number.isInteger(limit) || !Number.isInteger(offset) || limit < 1 || limit > 100 || offset < 0) {
    return err(400, 'E_BAD_ARG');
  }
  const rows = env.store.recentTasksApi(chatId, limit + 1, offset);
  const page = rows.slice(0, limit);
  return {
    status: 200,
    body: {
      tasks: page.map((t) => ({
        id: t.id,
        // m1: same 60-char, surrogate-safe title as the detail view. The SQL
        // fallback (`COALESCE(NULLIF(title,''), substr(prompt,1,60))`) covers
        // pre-W3 rows; `taskTitle` keeps the clamp identical to `taskView`.
        title: taskTitle(t.title ?? ''),
        agent: t.agent,
        model: t.model,
        project: t.project,
        mode: t.mode,
        status: t.status,
        elapsed_s: elapsedOf(t.created_at),
        cost_usd: t.cost_usd,
        created_at: t.created_at,
        finished_at: t.finished_at,
      })),
      has_more: rows.length > limit,
    },
  };
}

function getTask(env: ApiEnv, chatId: number, id: number, query: URLSearchParams): ApiResult {
  const row = scopedTask(env.store, id, chatId);
  if (!row) return err(404, 'E_NO_TASK');
  const sinceRaw = query.get('since_rev');
  if (sinceRaw !== null) {
    const since = Number(sinceRaw);
    if (Number.isInteger(since) && since === row.rev) return { status: 304 };
  }
  return { status: 200, body: taskView(env.store, row) };
}

function postDrafts(env: ApiEnv, chatId: number, body: unknown): ApiResult {
  const parsed = parseRunBody(body);
  if ('status' in parsed) return parsed;
  const s = getOrCreate(env.store, env.cfg, chatId);
  // The card snapshots the run context AND the plan intent: `confirm` must run
  // what the owner saw, even if `PUT /api/settings` moved the session on (M2).
  const id = env.store.createDraft(
    chatId,
    parsed.prompt,
    parsed.mode,
    s.agent,
    s.model,
    s.project,
    parsed.skills,
    parsed.mode === 'plan',
  );
  const draft = env.store.getDraft(id);
  if (!draft) return err(400, 'E_BAD_ARG');
  return {
    status: 200,
    body: {
      draft: {
        id: draft.id,
        prompt: draft.prompt,
        mode: draft.mode,
        agent: draft.agent,
        model: draft.model,
        project: draft.project,
        skills: skillsOf(draft.skills),
        status: draft.status,
      },
    },
  };
}

function confirmDraft(env: ApiEnv, chatId: number, id: number): ApiResult {
  const draft = env.store.getDraft(id);
  if (!draft || draft.chat_id !== chatId) return err(404, 'E_NO_DRAFT');
  const r = env.store.confirmDraft(id);
  if (r === 'missing') return err(404, 'E_NO_DRAFT');
  if (r === 'expired') return err(410, 'E_EXPIRED');
  if (r === 'resolved') return err(410, 'E_RESOLVED');
  // "One task per chat": submit joins the EXISTING pump when busy (queued),
  // it never starts a second queue.
  const fresh = env.store.getDraft(id);
  if (!fresh) return err(404, 'E_NO_DRAFT');
  // B1.4 + M2: the STORED card decides — its plan flag and its agent/model/
  // project snapshot. Re-reading the session here is exactly the drift the
  // reviewer measured (draft said model:"" → task ran "drifted-model").
  const mode = parseMode(fresh.mode) ?? 'ask';
  const state = env.queue.submit(chatId, fresh.prompt, TASK_MODE[mode], [], {
    skills: skillsOf(fresh.skills),
    planOnly: fresh.plan === 1 || mode === 'plan',
    agent: agentArg(fresh.agent),
    model: strArg(fresh.model),
    project: strArg(fresh.project),
  });
  return { status: 200, body: { task_id: lastTaskOf(env, chatId), state } };
}

/** Newest task id for this chat — the row `submit` just created (same tick). */
function lastTaskOf(env: ApiEnv, chatId: number): number {
  const rows = env.store.recentTasksApi(chatId, 1, 0);
  return rows[0]?.id ?? -1;
}

function discardDraft(env: ApiEnv, chatId: number, id: number): ApiResult {
  const draft = env.store.getDraft(id);
  if (!draft || draft.chat_id !== chatId) return err(404, 'E_NO_DRAFT');
  const r = env.store.discardDraft(id);
  if (r === 'missing') return err(404, 'E_NO_DRAFT');
  if (r === 'expired') return err(410, 'E_EXPIRED');
  if (r === 'resolved') return err(410, 'E_RESOLVED');
  return { status: 200, body: { ok: true } };
}

function postTasks(env: ApiEnv, chatId: number, body: unknown): ApiResult {
  const parsed = parseRunBody(body);
  if ('status' in parsed) return parsed;
  // Direct launch (retry/continue templates use the endpoints below): the live
  // session IS the run context here — there is no card to restore.
  const state = env.queue.submit(chatId, parsed.prompt, TASK_MODE[parsed.mode], [], {
    skills: parsed.skills,
    planOnly: parsed.mode === 'plan',
  });
  return { status: 200, body: { task_id: lastTaskOf(env, chatId), state } };
}

async function stopTask(env: ApiEnv, chatId: number, id: number): Promise<ApiResult> {
  if (!scopedTask(env.store, id, chatId)) return err(404, 'E_NO_TASK');
  // Same priority as chat `cancel`: approval → parked plan → running task.
  // M1: echo the id of what ACTUALLY stopped, not the URL id — a `stop` may
  // address any task while the parked plan is a different one.
  const { kind, id: stoppedId } = await env.queue.cancel(chatId);
  if (kind === 'nothing') return err(404, 'E_NO_TASK');
  return { status: 200, body: { stopped: kind, task_id: stoppedId } };
}

/** Run context of the source row for retry/continue (M3): agent/model/project
 *  "at launch", never the current session (§5.1 item 12: "в том же project"). */
function sourceContext(row: TaskRow): { agent: AgentId | undefined; model: string | undefined; project: string | undefined } {
  return {
    agent: agentArg(row.agent),
    model: strArg(row.model),
    project: strArg(row.project),
  };
}

function retryTask(env: ApiEnv, chatId: number, id: number): ApiResult {
  const row = scopedTask(env.store, id, chatId);
  if (!row) return err(404, 'E_NO_TASK');
  const mode = parseMode(row.mode) ?? 'ask';
  env.queue.submit(chatId, row.prompt, TASK_MODE[mode], [], {
    skills: skillsOf(row.skills_used),
    ...sourceContext(row),
  });
  return { status: 200, body: { task_id: lastTaskOf(env, chatId) } };
}

function continueTask(env: ApiEnv, chatId: number, id: number, body: unknown): ApiResult {
  const row = scopedTask(env.store, id, chatId);
  if (!row) return err(404, 'E_NO_TASK');
  const text = (body ?? {}) as { text?: unknown };
  if (!validPrompt(text.text)) return err(400, 'E_BAD_ARG');
  const mode = parseMode(row.mode) ?? 'ask';
  env.queue.submit(chatId, text.text as string, TASK_MODE[mode], [], {
    skills: skillsOf(row.skills_used),
    ...sourceContext(row),
  });
  return { status: 200, body: { task_id: lastTaskOf(env, chatId) } };
}

function taskFiles(env: ApiEnv, chatId: number, id: number): ApiResult {
  const row = scopedTask(env.store, id, chatId);
  if (!row) return err(404, 'E_NO_TASK');
  const files = env.store.taskFiles(id);
  const summary = skillsSummary(env.store, id);
  return {
    status: 200,
    body: {
      files: files.map((f) => ({
        path: f.path,
        added: f.added,
        removed: f.removed,
        truncated: f.truncated === 1,
        binary: f.binary === 1,
      })),
      changed_n: summary.changed_n,
      total_added: summary.added,
      total_removed: summary.removed,
      no_git: row.git_base_sha === null || row.git_base_sha === undefined,
    },
  };
}

function taskDiff(env: ApiEnv, chatId: number, id: number, query: URLSearchParams): ApiResult {
  if (!scopedTask(env.store, id, chatId)) return err(404, 'E_NO_TASK');
  const path = query.get('path');
  if (path === null || path === '') return err(400, 'E_BAD_ARG');
  const hit = env.store.taskFiles(id).find((f) => f.path === path);
  if (!hit) return err(404, 'E_NO_DIFF');
  if (hit.binary === 1 || hit.diff === null) return { status: 200, body: { path, binary: true } };
  return { status: 200, body: { path, diff: hit.diff, truncated: hit.truncated === 1 } };
}

function planCurrent(env: ApiEnv, chatId: number): ApiResult {
  const row = env.store.awaitingPlanApi(chatId);
  if (!row) return { status: 200, body: { plan: null } };
  return { status: 200, body: { task_id: row.id, plan: row.plan_text ?? '', reworks: row.plan_reworks ?? 0 } };
}

function planApprove(env: ApiEnv, chatId: number, id: number): ApiResult {
  const parked = env.store.awaitingPlanApi(chatId);
  if (!parked || parked.id !== id) return err(404, 'E_NO_PLAN');
  const busy = env.queue.status(chatId).running;
  const taskId = env.queue.approvePlan(chatId);
  if (taskId === null) return err(404, 'E_NO_PLAN');
  return { status: 200, body: { task_id: taskId, state: busy ? 'queued' : 'started' } };
}

function planRework(env: ApiEnv, chatId: number, id: number, body: unknown): ApiResult {
  const comment = (body ?? {}) as { comment?: unknown };
  if (typeof comment.comment !== 'string' || comment.comment.trim() === '' || comment.comment.length > COMMENT_MAX) {
    return err(400, 'E_BAD_ARG');
  }
  const parked = env.store.awaitingPlanApi(chatId);
  if (!parked || parked.id !== id) return err(404, 'E_NO_PLAN');
  const r = env.queue.reworkPlan(chatId, comment.comment);
  if (r === null) {
    // Out of rounds (MAX 2): the queue already started the task as-is.
    const started = env.store.oldestPendingApi(chatId) ?? env.store.runningTaskApi(chatId);
    return err(410, 'E_ROUNDS_OUT', started ? { task_id: started.id } : {});
  }
  return { status: 200, body: { rounds: r.rounds } };
}

function approvalsPending(env: ApiEnv, chatId: number): ApiResult {
  const row = env.store.pendingApproval(chatId);
  return {
    status: 200,
    body: { approval: row ? { id: row.id, command: row.command, created_at: row.created_at } : null },
  };
}

function approvalResolve(env: ApiEnv, chatId: number, id: number, ok: boolean): ApiResult {
  const row = env.store.getApproval(id);
  if (!row || row.chat_id !== chatId) return err(404, 'E_NO_APPROVAL');
  const r = resolveApprovalById(id, ok);
  if (r === 'missing') return err(404, 'E_NO_APPROVAL');
  if (r === 'resolved') return err(410, 'E_RESOLVED');
  if (r === 'expired') return err(410, 'E_EXPIRED');
  return { status: 200, body: { ok: true } };
}

function filesList(env: ApiEnv, chatId: number, query: URLSearchParams): ApiResult {
  const w = workdirOf(env, chatId);
  if (!('dir' in w)) return w;
  const dir = query.get('dir') ?? '.';
  let gate: { abs: string };
  try {
    gate = resolveOutboundDir(w.dir, dir);
  } catch (e) {
    return outboundError(e);
  }
  let listed: ReturnType<typeof listDir>;
  try {
    listed = listDir(gate.abs, w.dir);
  } catch (e) {
    return outboundError(e);
  }
  return {
    status: 200,
    body: {
      abs: gate.abs,
      entries: listed.entries.map((e) => ({
        name: e.name,
        rel: e.rel.split('\\').join('/'),
        size: e.size,
        mtime: e.mtimeMs,
        isDir: e.isDir,
      })),
      total: listed.total,
      shown: listed.entries.length,
    },
  };
}

function filesPreview(env: ApiEnv, chatId: number, query: URLSearchParams): ApiResult {
  const w = workdirOf(env, chatId);
  if (!('dir' in w)) return w;
  const path = query.get('path');
  if (path === null || path === '') return err(400, 'E_BAD_ARG');
  let file: { abs: string; size: number };
  try {
    file = resolveOutboundFile(w.dir, path, MAX_OUTBOUND_BYTES);
  } catch (e) {
    return outboundError(e);
  }
  let full: Buffer;
  try {
    const st = statSync(file.abs);
    if (!st.isFile()) return err(400, 'E_BAD_ARG');
    full = readFileSync(file.abs);
  } catch {
    return err(404, 'E_NOT_FOUND');
  }
  const head = full.subarray(0, Math.min(full.length, PREVIEW_MAX + 1));
  if (head.subarray(0, BINARY_PROBE).includes(0)) {
    return { status: 200, body: { path, abs: file.abs, binary: true } };
  }
  const truncated = file.size > PREVIEW_MAX;
  const text = head.subarray(0, PREVIEW_MAX).toString('utf8');
  return { status: 200, body: { path, abs: file.abs, text, truncated, size: file.size } };
}

function filesDownload(env: ApiEnv, chatId: number, query: URLSearchParams): ApiResult {
  const w = workdirOf(env, chatId);
  if (!('dir' in w)) return w;
  const path = query.get('path');
  if (path === null || path === '') return err(400, 'E_BAD_ARG');
  let file: { abs: string; size: number };
  try {
    file = resolveOutboundFile(w.dir, path, MAX_OUTBOUND_BYTES);
  } catch (e) {
    return outboundError(e);
  }
  let data: Buffer;
  try {
    data = readFileSync(file.abs);
  } catch {
    return err(404, 'E_NOT_FOUND');
  }
  const safe = basename(file.abs).replace(/["\r\n]/g, '_');
  return {
    status: 200,
    raw: data,
    headers: {
      'content-type': 'application/octet-stream',
      'content-disposition': `attachment; filename="${safe}"`,
      'content-length': String(data.length),
    },
  };
}

function filesDiff(env: ApiEnv, chatId: number, query: URLSearchParams): ApiResult {
  const w = workdirOf(env, chatId);
  if (!('dir' in w)) return w;
  const path = query.get('path');
  if (path === null || path === '') return err(400, 'E_BAD_ARG');
  let file: { abs: string };
  try {
    file = resolveOutboundFile(w.dir, path, MAX_OUTBOUND_BYTES);
  } catch (e) {
    return outboundError(e);
  }
  const rel = relative(resolve(w.dir), resolve(file.abs)).split('\\').join('/');
  if (rel === '' || rel.startsWith('..')) return err(403, 'E_PATH_DENIED');
  const d = unifiedDiff(w.dir, rel);
  if (d.binary) return { status: 200, body: { path, binary: true } };
  // m6: `unifiedDiff` reports a FAILED git (no binary/no git binary/timeout/
  // not-a-repo) as `diff: null, truncated: true` — indistinguishable from a
  // real cap, so W6 would badge "truncated" on every file outside a repo.
  // Say it explicitly instead: `no_git` mirrors `GET /api/tasks/:id/files`.
  if (d.diff === null) {
    return { status: 200, body: { path, no_git: true, diff: '', truncated: false } };
  }
  return { status: 200, body: { path, diff: d.diff, truncated: d.truncated, no_git: false } };
}

function pickersAgents(env: ApiEnv, chatId: number): ApiResult {
  const s = getOrCreate(env.store, env.cfg, chatId);
  return { status: 200, body: { agents: availableProviders(), current: s.agent } };
}

async function pickersModels(env: ApiEnv, chatId: number): Promise<ApiResult> {
  const s = getOrCreate(env.store, env.cfg, chatId);
  const listed = await cachedModels(env.cfg.opencodeBin);
  return {
    status: 200,
    body: {
      models: listed.models.map((id) => ({ id, label: modelLabel(id) })),
      current: s.model,
      cached: listed.cached,
    },
  };
}

function pickersProjects(env: ApiEnv, chatId: number): ApiResult {
  const s = getOrCreate(env.store, env.cfg, chatId);
  return {
    status: 200,
    body: {
      projects: listProjects(env.cfg).map((p) => ({ name: p.name, dir: p.dir, label: p.label })),
      current: s.project,
    },
  };
}

function getSettings(env: ApiEnv, chatId: number): ApiResult {
  const s = getOrCreate(env.store, env.cfg, chatId);
  return {
    status: 200,
    body: {
      agent: s.agent,
      model: s.model,
      project: s.project,
      auto_approve: s.autoApprove,
      allowed_roots: env.cfg.allowedRoots,
    },
  };
}

function putSettings(env: ApiEnv, chatId: number, body: unknown): ApiResult {
  const shape = bodyShapeError(body, ['agent', 'model', 'project', 'auto_approve']);
  if (shape !== null) return shape;
  const b = (body ?? {}) as { agent?: unknown; model?: unknown; project?: unknown; auto_approve?: unknown };
  const patch: { agent?: AgentId; model?: string; project?: string; autoApprove?: boolean } = {};
  let touched = false;
  if (b.agent !== undefined) {
    if (typeof b.agent !== 'string' || !(AGENT_IDS as readonly string[]).includes(b.agent)) {
      return err(400, 'E_BAD_ARG');
    }
    patch.agent = b.agent as AgentId;
    touched = true;
  }
  if (b.model !== undefined) {
    if (typeof b.model !== 'string') return err(400, 'E_BAD_ARG');
    patch.model = b.model;
    touched = true;
  }
  if (b.project !== undefined) {
    if (typeof b.project !== 'string') return err(400, 'E_BAD_ARG');
    try {
      patch.project = resolveWorkdir(env.cfg, chatId, b.project);
    } catch {
      return err(400, 'E_BAD_ARG');
    }
    touched = true;
  }
  if (b.auto_approve !== undefined) {
    if (typeof b.auto_approve !== 'boolean') return err(400, 'E_BAD_ARG');
    patch.autoApprove = b.auto_approve;
    touched = true;
  }
  if (!touched) return err(400, 'E_BAD_ARG');
  const before = getOrCreate(env.store, env.cfg, chatId);
  const next = updateSession(env.store, chatId, patch);
  // Agent/project switches invalidate the provider-side session (chat parity:
  // same rule as the telegram agent/project pickers in callbacks.ts).
  if ((patch.agent !== undefined && patch.agent !== before.agent) || (patch.project !== undefined && patch.project !== before.project)) {
    dropAgentSession(env.store, chatId);
  }
  return {
    status: 200,
    body: { agent: next.agent, model: next.model, project: next.project, auto_approve: next.autoApprove },
  };
}

function getSkills(env: ApiEnv, chatId: number): ApiResult {
  const w = workdirOf(env, chatId);
  if (!('dir' in w)) return w;
  const pins = env.store.skillPins(chatId);
  const auto = pins.includes(SKILLS_AUTO_SENTINEL);
  const pinned = new Set(pins.filter((p) => p !== SKILLS_AUTO_SENTINEL));
  return {
    status: 200,
    body: {
      skills: listSkills(w.dir).map((s) => ({
        name: s.name,
        description: s.description,
        source: s.source,
        pinned: pinned.has(s.name),
      })),
      auto,
    },
  };
}

function putSkills(env: ApiEnv, chatId: number, body: unknown): ApiResult {
  const shape = bodyShapeError(body, ['pins', 'auto']);
  if (shape !== null) return shape;
  const b = (body ?? {}) as { pins?: unknown; auto?: unknown };
  if (b.pins !== undefined && !Array.isArray(b.pins)) return err(400, 'E_BAD_ARG');
  if (b.auto !== undefined && typeof b.auto !== 'boolean') return err(400, 'E_BAD_ARG');
  const pins = parseSkills(b.pins ?? []);
  if (pins === null) return err(400, 'E_BAD_ARG');
  let auto: boolean;
  if (typeof b.auto === 'boolean') {
    auto = b.auto;
  } else {
    try {
      auto = env.store.skillPins(chatId).includes(SKILLS_AUTO_SENTINEL);
    } catch {
      auto = false;
    }
  }
  env.store.setSkillPins(chatId, auto ? [...pins, SKILLS_AUTO_SENTINEL] : pins);
  return { status: 200, body: { ok: true } };
}

/* ------------------------------------------------------------------ routing */

const ID = '(\\d+)';

/**
 * Route a verified request to its handler. Pure apart from Store/queue/fs
 * effects inside the handlers themselves — no transport, no auth here.
 */
export async function dispatchApi(
  env: ApiEnv,
  chatId: number,
  method: string,
  pathname: string,
  query: URLSearchParams,
  body: unknown,
): Promise<ApiResult> {
  // Item 2–5 (§5.1).
  if (method === 'GET' && pathname === '/api/health') return getHealth(env, chatId);
  if (method === 'GET' && pathname === '/api/tasks/current') return getCurrent(env, chatId);
  if (method === 'GET' && pathname === '/api/tasks/recent') return getRecent(env, chatId, query);
  // Items 13–14 before the bare `:id` route (path prefix overlap).
  let m = new RegExp(`^/api/tasks/${ID}/files$`).exec(pathname);
  if (method === 'GET' && m) return taskFiles(env, chatId, Number(m[1]));
  m = new RegExp(`^/api/tasks/${ID}/diff$`).exec(pathname);
  if (method === 'GET' && m) return taskDiff(env, chatId, Number(m[1]), query);
  // Items 10–12.
  m = new RegExp(`^/api/tasks/${ID}/stop$`).exec(pathname);
  if (method === 'POST' && m) return stopTask(env, chatId, Number(m[1]));
  m = new RegExp(`^/api/tasks/${ID}/retry$`).exec(pathname);
  if (method === 'POST' && m) return retryTask(env, chatId, Number(m[1]));
  m = new RegExp(`^/api/tasks/${ID}/continue$`).exec(pathname);
  if (method === 'POST' && m) return continueTask(env, chatId, Number(m[1]), body);
  // Item 5.
  m = new RegExp(`^/api/tasks/${ID}$`).exec(pathname);
  if (method === 'GET' && m) return getTask(env, chatId, Number(m[1]), query);
  // Items 6–8.
  if (method === 'POST' && pathname === '/api/drafts') return postDrafts(env, chatId, body);
  m = new RegExp(`^/api/drafts/${ID}/confirm$`).exec(pathname);
  if (method === 'POST' && m) return confirmDraft(env, chatId, Number(m[1]));
  m = new RegExp(`^/api/drafts/${ID}/discard$`).exec(pathname);
  if (method === 'POST' && m) return discardDraft(env, chatId, Number(m[1]));
  // Item 9.
  if (method === 'POST' && pathname === '/api/tasks') return postTasks(env, chatId, body);
  // Items 15–17.
  if (method === 'GET' && pathname === '/api/plan/current') return planCurrent(env, chatId);
  m = new RegExp(`^/api/plan/${ID}/approve$`).exec(pathname);
  if (method === 'POST' && m) return planApprove(env, chatId, Number(m[1]));
  m = new RegExp(`^/api/plan/${ID}/rework$`).exec(pathname);
  if (method === 'POST' && m) return planRework(env, chatId, Number(m[1]), body);
  // Items 18–19.
  if (method === 'GET' && pathname === '/api/approvals/pending') return approvalsPending(env, chatId);
  m = new RegExp(`^/api/approvals/${ID}/allow$`).exec(pathname);
  if (method === 'POST' && m) return approvalResolve(env, chatId, Number(m[1]), true);
  m = new RegExp(`^/api/approvals/${ID}/deny$`).exec(pathname);
  if (method === 'POST' && m) return approvalResolve(env, chatId, Number(m[1]), false);
  // Items 20–23.
  if (method === 'GET' && pathname === '/api/files') return filesList(env, chatId, query);
  if (method === 'GET' && pathname === '/api/files/preview') return filesPreview(env, chatId, query);
  if (method === 'GET' && pathname === '/api/files/download') return filesDownload(env, chatId, query);
  if (method === 'GET' && pathname === '/api/files/diff') return filesDiff(env, chatId, query);
  // Items 24–26.
  if (method === 'GET' && pathname === '/api/pickers/agents') return pickersAgents(env, chatId);
  if (method === 'GET' && pathname === '/api/pickers/models') return pickersModels(env, chatId);
  if (method === 'GET' && pathname === '/api/pickers/projects') return pickersProjects(env, chatId);
  // Items 27–28.
  if (method === 'GET' && pathname === '/api/settings') return getSettings(env, chatId);
  if (method === 'PUT' && pathname === '/api/settings') return putSettings(env, chatId, body);
  // Items 29–30.
  if (method === 'GET' && pathname === '/api/skills') return getSkills(env, chatId);
  if (method === 'PUT' && pathname === '/api/skills') return putSkills(env, chatId, body);
  return err(404, 'E_NOT_FOUND');
}
