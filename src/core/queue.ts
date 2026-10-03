import type { Config } from '../config.js';
import { getProvider } from '../gateway/registry.js';
import type { AgentEvent, AgentId, AgentTask, HistoryItem, TaskMode } from '../gateway/types.js';
import { composePrompt } from '../gateway/spawnRunner.js';
import type { Store } from '../storage/db.js';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { collectTaskFiles, snapshotGit, summarizeFiles, taskTitle } from '../miniapp/diff.js';
import { DIFF_BUDGET_MS } from '../miniapp/diff.js';
import type { GitSnapshot } from '../miniapp/diff.js';
import { AttachCensor, outboundErrorMessage, planAttachments } from './files.js';
import { resolveWorkdir } from './permissions.js';
import { getOrCreate } from './sessions.js';
import { bindApprovalStore, resolveApproval } from './approvals.js';
import { log } from '../log.js';

export interface StreamHandle {
  push(delta: string): void;
  finish(text: string): Promise<void>;
  fail(code: string): Promise<void>;
}

export interface SubmitOptions {
  /** `/review`, `/test`, `/fix` — recorded on the task for `/cost` breakdowns. */
  preset?: string;
  /** Extra system-ish instruction prepended to the prompt (presets, plan comments). */
  rolePrefix?: string;
  /** Plan mode: park the task as `awaiting_plan` instead of executing it. */
  planOnly?: boolean;
  /** Pinned skill names attached at launch (W3: stored as `skills_used`). */
  skills?: string[];
  /**
   * W4 (M2/M3): run context override. The Mini App confirmation card snapshots
   * agent/model/project, and `retry`/`continue` reproduce the SOURCE task's
   * context — both must survive a later `PUT /api/settings`, so they are passed
   * explicitly instead of being re-read from the live session at execute time.
   * Omitted → today's behaviour exactly (the session decides).
   */
  agent?: AgentId;
  model?: string;
  project?: string;
}

/** Caption for files the agent asked to send, shown under an inline photo. */
export const ATTACH_CAPTION = '📎 Из ответа агента';

/**
 * What `cancel` stopped. `id` is the row that ACTUALLY changed — never the
 * caller's guess: §5.1 item 10 requires `task_id` to identify the stopped
 * resource, and a Mini App `stop` may address any task id while the real target
 * is a parked plan or a pending approval with a different one (W4 M1).
 */
export interface CancelResult {
  kind: 'approval' | 'task' | 'plan' | 'nothing';
  /** Row id of the stopped resource; `null` for `nothing` (and for an approval
   *  with no durable row, impossible while a Store is bound). */
  id: number | null;
}

/**
 * W4 skills (R3 §4a/§4b path ①): pinned skill names are stored on the draft/task
 * (`skills_used` = PINNED INTENT, not observed tool_use — see the NOTE in
 * `submit`), and the SKILL.md bodies are prepended to the prompt at execute
 * time. Execute-time (not submit-time) composition keeps retry/continue from
 * stacking the same bodies twice: the stored prompt stays raw.
 */

/** `SKILL.md` frontmatter `name:` shape (R3 §4): kebab-case, 1–64 chars. */
export const SKILL_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const SKILL_NAME_MAX = 64;
/** Per-skill body cap for the prompt prepend (a SKILL.md is docs, not a dump). */
export const SKILL_BODY_MAX = 16 * 1024;
/** Max skills composed into one prompt. */
export const SKILL_PREPEND_MAX = 10;

/** One discovered skill: name + description + where it came from. */
export interface SkillEntry {
  name: string;
  description: string;
  source: 'project' | 'global';
  /** Absolute directory holding the `SKILL.md` (nearest wins on duplicates). */
  dir: string;
}

/** Skill search roots for a workdir, nearest first. */
function skillSearchDirs(workdir: string): { dir: string; source: 'project' | 'global' }[] {
  const out: { dir: string; source: 'project' | 'global' }[] = [];
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
  let homeAbs = '';
  try {
    homeAbs = home === '' ? '' : resolve(home);
  } catch {
    homeAbs = '';
  }
  try {
    let cur = resolve(workdir);
    for (let depth = 0; depth < 32; depth += 1) {
      // m12: the user's HOME directory is not a project. When the upward walk
      // reaches it (every workdir under `~/…` does, and so does every temp
      // workdir), `~/.opencode/skills` must be reported as `global`, not
      // `project` — §5.1 item 29 contracts exactly two sources. A project that
      // merely LIVES under home (`~/dev/app/.opencode/skills`) still walks up
      // from itself and stays `project`.
      const atHome = homeAbs !== '' && cur === homeAbs;
      for (const scope of ['.opencode/skills', '.claude/skills', '.agents/skills']) {
        out.push({ dir: join(cur, scope), source: atHome ? 'global' : 'project' });
      }
      const parent = dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  } catch {
    // unresolvable workdir: fall through to global + repo roots only
  }
  // Explicit global roots, for a workdir OUTSIDE home (`D:/projects/…`), where
  // the upward walk never gets near them. Duplicates of the walk are harmless
  // (nearest-wins + `seen` in `listSkills`).
  if (homeAbs !== '') {
    for (const scope of ['.config/opencode/skills', '.opencode/skills', '.claude/skills', '.agents/skills']) {
      out.push({ dir: join(homeAbs, scope), source: 'global' });
    }
  }
  // Bundled repo skills (`skills/` next to the checkout): project-scoped.
  try {
    out.push({ dir: join(resolve(process.cwd()), 'skills'), source: 'project' });
  } catch {
    // process.cwd() cannot fail in practice; guard keeps this total
  }
  return out;
}

/** Parse `name:`/`description:` out of a SKILL.md frontmatter block. */
function parseSkillFrontmatter(text: string): { name: string; description: string } | null {
  const lines = text.split('\n');
  if ((lines[0] ?? '').trim() !== '---') return null;
  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if ((lines[i] ?? '').trim() === '---') {
      end = i;
      break;
    }
    if (i > 40) break;
  }
  if (end < 0) return null;
  let name = '';
  let description = '';
  for (const ln of lines.slice(1, end)) {
    const m = /^([A-Za-z_]+)\s*:\s*(.*)$/.exec(ln.trim());
    if (!m) continue;
    const unquote = (v: string): string => {
      const t = v.trim();
      if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1);
      if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1);
      return t;
    };
    if (m[1] === 'name' && name === '') name = unquote(m[2] ?? '');
    else if (m[1] === 'description' && description === '') description = unquote(m[2] ?? '');
  }
  if (!SKILL_NAME_RE.test(name) || name.length > SKILL_NAME_MAX) return null;
  if (description === '' || description.length > 1024) return null;
  return { name, description };
}

/**
 * List every discoverable skill for a workdir (R3 §4a): project skill dirs
 * (`.opencode/skills`, plus `.claude` and `.agents` compat) scanned upward
 * from the workdir, plus global `~/.config/opencode/skills` and repo `skills/`.
 * Nearest wins on duplicate names. Never throws — an unreadable tree lists nothing.
 */
export function listSkills(workdir: string): SkillEntry[] {
  const out: SkillEntry[] = [];
  const seen = new Set<string>();
  for (const root of skillSearchDirs(workdir)) {
    let names: string[];
    try {
      names = readdirSync(root.dir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort();
    } catch {
      continue;
    }
    for (const name of names) {
      if (!SKILL_NAME_RE.test(name) || name.length > SKILL_NAME_MAX || seen.has(name)) continue;
      const file = join(root.dir, name, 'SKILL.md');
      let text: string;
      try {
        if (!statSync(file).isFile()) continue;
        text = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      const fm = parseSkillFrontmatter(text);
      if (!fm || fm.name !== name) continue;
      seen.add(name);
      out.push({ name, description: fm.description, source: root.source, dir: join(root.dir, name) });
    }
  }
  return out;
}

/**
 * Raw body of one named skill (the full SKILL.md text, capped), or null when
 * the skill is not discoverable from this workdir. Name-gated: only
 * well-formed kebab-case names ever hit the filesystem.
 */
export function readSkillBody(workdir: string, name: string): string | null {
  if (!SKILL_NAME_RE.test(name) || name.length > SKILL_NAME_MAX) return null;
  for (const root of skillSearchDirs(workdir)) {
    const file = join(root.dir, name, 'SKILL.md');
    try {
      if (!statSync(file).isFile()) continue;
      const text = readFileSync(file, 'utf8');
      const fm = parseSkillFrontmatter(text);
      if (!fm || fm.name !== name) continue;
      return text.length > SKILL_BODY_MAX ? text.slice(0, SKILL_BODY_MAX) : text;
    } catch {
      continue;
    }
  }
  return null;
}

/** Parse a stored `skills_used`/draft `skills` JSON array defensively. */
export function parseSkillNames(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const v: unknown = JSON.parse(json);
    if (!Array.isArray(v)) return [];
    return v.filter((s): s is string => typeof s === 'string' && SKILL_NAME_RE.test(s)).slice(0, SKILL_PREPEND_MAX);
  } catch {
    return [];
  }
}

/**
 * Compose the skill prefix for a prompt (R3 §4b path ①): one `# Skill: <name>`
 * section per resolvable pinned skill. Unknown names are skipped silently —
 * pinning is intent, the file may appear later. Pure composition, no I/O beyond
 * the skill files themselves.
 */
export function prependSkillBodies(workdir: string, prompt: string, skills: string[]): string {
  const names = skills.filter((s) => SKILL_NAME_RE.test(s)).slice(0, SKILL_PREPEND_MAX);
  if (names.length === 0) return prompt;
  const sections: string[] = [];
  for (const name of names) {
    const body = readSkillBody(workdir, name);
    if (body !== null) sections.push(`# Skill: ${name}\n${body}`);
  }
  if (sections.length === 0) return prompt;
  return `${sections.join('\n\n')}\n\n${prompt}`;
}

export interface Responder {
  streamStart(chatId: number, options?: { mode?: TaskMode; label?: string }): Promise<StreamHandle>;
  askApproval(chatId: number, command: string): Promise<boolean>;
  notify(chatId: number, text: string, keyboard?: unknown): Promise<void>;
  /**
   * Optional (WAVE2/FILES): send the files an agent reply asked for — the explicit
   * `[[attach:path]]` markers first, the conservative path guesser as a fallback.
   * `caption` labels the upload (used as the photo caption); each file's own name is
   * always appended. Kept optional so a Responder without file support still satisfies
   * the contract; the queue only calls it when present.
   */
  attachFiles?(chatId: number, paths: string[], caption?: string): Promise<void>;
}

function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(new Error('E_TIMEOUT'));
    }, ms);
    timer.unref?.();
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}

const errCode = (e: unknown): string => {
  const m = e instanceof Error ? e.message : String(e);
  return m.startsWith('E_') ? m.split(':')[0] ?? 'E_AGENT_FAILED' : 'E_AGENT_FAILED';
};

export class TaskQueue {
  private pumping = new Set<number>();
  private streams = new Map<number, StreamHandle>();
  private sessionIds = new Map<number, string>();
  /** Tasks parked on plan approval: chatId -> taskId awaiting a decision. */
  private planWaiting = new Map<number, { taskId: number; plan: string; reworks: number; origin: string }>();
  // WAVE2/EXEC-BEGIN (plan turns: agent drafts a plan first, chat approves, then it runs)
  /** Task ids currently running as plan turns (stored prompt is the real one). */
  private planTurns = new Set<number>();
  /** Plan turn id -> original implementation prompt (restored on approve). */
  private planOrigin = new Map<number, string>();
  /** Plan turn id -> rework rounds already spent. */
  private planRounds = new Map<number, number>();
  /**
   * Plan-turn BEFORE snapshots (B1): taskId -> workdir + snapshot taken when
   * the plan turn ran. A parked plan's re-run must attribute against the
   * PRE-plan-turn tree, not the post-plan-turn one — otherwise the B1 dirt
   * filter would eat the plan turn's own file writes. Two layers, single-use
   * each: the in-memory map (fast path) and the durable `plan_diff_before`
   * column written at park time (R2-MAJOR: survives a restart mid-approval;
   * consumed + cleared by the next `execute` of the same taskId, workdir
   * must still match in both layers).
   */
  private planSnaps = new Map<number, { workdir: string; snap: GitSnapshot }>();
  /** Set by plan.ts: deliver the approve/rework keyboard after a plan turn. */
  private planNotify: ((chatId: number, taskId: number, plan: string) => Promise<void>) | null = null;

  /** plan.ts delivers the approve/rework keyboard through this hook (queue stays telegram-free). */
  onPlanReady(fn: (chatId: number, taskId: number, plan: string) => Promise<void>): void {
    this.planNotify = fn;
  }
  // WAVE2/EXEC-END

  constructor(
    private store: Store,
    private cfg: Config,
    private io: Responder,
  ) {
    // The approvals bridge must point at the live database; a reopen builds a
    // new Store + a new queue, which rebinds here. Plan fast-path state is
    // rebuilt from the durable `awaiting_plan` rows right after.
    bindApprovalStore(this.store);
    this.restorePlans();
  }

  /**
   * Boot restore: rebuild the fast-path plan map from durable `awaiting_plan`
   * rows, so a parked plan survives a restart (W2 AC3). Memory stays a cache —
   * the rows are the source of truth.
   */
  private restorePlans(): void {
    try {
      for (const row of this.store.awaitingPlans()) {
        if (this.planWaiting.has(row.chat_id)) continue;
        this.planWaiting.set(row.chat_id, {
          taskId: row.id,
          plan: row.plan_text ?? '',
          reworks: row.plan_reworks ?? 0,
          origin: row.plan_origin ?? row.prompt ?? '',
        });
      }
    } catch {
      // A store that cannot list plans must not break boot; chat flows fall
      // back to per-chat lookups in `waitingFor`.
    }
  }

  /**
   * The parked plan for a chat: memory fast path first, durable row on a miss
   * (cold boot). The miss populates the map, so later calls stay cheap.
   */
  private waitingFor(chatId: number): { taskId: number; plan: string; reworks: number; origin: string } | undefined {
    const hit = this.planWaiting.get(chatId);
    if (hit) return hit;
    try {
      const row = this.store.awaitingPlan(chatId);
      if (!row) return undefined;
      const waiting = {
        taskId: row.id,
        plan: row.plan_text ?? '',
        reworks: row.plan_reworks ?? 0,
        origin: row.plan_origin ?? row.prompt ?? '',
      };
      this.planWaiting.set(chatId, waiting);
      return waiting;
    } catch {
      return undefined;
    }
  }

  submit(
    chatId: number,
    prompt: string,
    mode: TaskMode,
    images: string[],
    options: SubmitOptions = {},
  ): 'started' | 'queued' | 'planned' {
    const s = getOrCreate(this.store, this.cfg, chatId);
    // W4 (M2/M3): an explicit run context wins over the live session — the card
    // the owner confirmed, or the source task being retried/continued.
    const agent = options.agent ?? s.agent;
    const model = options.model ?? s.model;
    const project = options.project ?? s.project;
    this.store.addMessage(chatId, 'user', prompt);
    const taskId = this.store.createTask(chatId, agent, mode, prompt, images, options.preset ?? '');
    // W3 launch metadata: the ONLY point where the pinned skills are known
    // (the pump later re-reads the row, the options do not survive to it).
    // NOTE (m1): `skills_used` is PINNED INTENT at submit, not observed
    // tool_use — W5/W7 must label it "pinned", never "used".
    try {
      this.store.setTaskLaunchMeta(
        taskId,
        taskTitle(prompt),
        model,
        project,
        JSON.stringify(options.skills ?? []),
      );
    } catch {
      // metadata must never break submit; execute() still snapshots the diff
    }
    if (options.planOnly === true) {
      // WAVE2/EXEC (plan turn): the stored prompt stays the real one; the pump
      // runs the agent for a plan, execute() wraps the prompt and parks the result.
      this.planTurns.add(taskId);
      this.planOrigin.set(taskId, prompt);
      this.planRounds.set(taskId, 0);
      // Durable from birth: a restart mid-plan-turn must keep origin + rounds.
      try {
        this.store.setTaskPlanMeta(taskId, prompt, 0);
      } catch {
        // memory above already carries this tick; the meta lands on park
      }
      if (this.pumping.has(chatId)) return 'planned';
      void this.pump(chatId);
      return 'planned';
    }
    if (this.pumping.has(chatId)) return 'queued';
    void this.pump(chatId);
    return 'started';
  }

  /** Plan flow: the owner approved a parked task — restore the real prompt and run it. */
  approvePlan(chatId: number): number | null {
    const waiting = this.waitingFor(chatId);
    if (!waiting) return null;
    this.planWaiting.delete(chatId);
    // The parked row holds a plan-turn (or rework) prompt: put the original
    // implementation prompt back, with the approved plan attached as context.
    const task = this.store.getTask(waiting.taskId);
    const origin = waiting.origin !== '' ? waiting.origin : (task?.prompt ?? '');
    this.store.setTaskPrompt(waiting.taskId, `${origin}\n\nApproved plan to follow:\n${waiting.plan}`);
    this.store.setTaskStatus(waiting.taskId, 'pending');
    if (!this.pumping.has(chatId)) void this.pump(chatId);
    return waiting.taskId;
  }

  /**
   * Plan flow: plain-text reply treated as a plan comment. Follow-up runs are
   * plan turns too (buttons each round). Returns false when out of rounds —
   * the caller then runs the task anyway.
   */
  reworkPlan(chatId: number, comment: string): { rounds: number } | null {
    const waiting = this.waitingFor(chatId);
    if (!waiting) return null;
    // The DB is authoritative for spent rounds: after a restart the memory map
    // is rebuilt from `plan_reworks`, but take the max so a hot tick never lags.
    const spent = this.store.getTask(waiting.taskId)?.plan_reworks ?? waiting.reworks;
    const reworks = Math.max(waiting.reworks, spent);
    if (reworks >= MAX_PLAN_REWORKS) {
      // Out of rework rounds: run the task anyway, as specified.
      this.planWaiting.delete(chatId);
      const task = this.store.getTask(waiting.taskId);
      const origin = waiting.origin !== '' ? waiting.origin : (task?.prompt ?? '');
      this.store.setTaskPrompt(waiting.taskId, `${origin}\n\nApproved plan to follow:\n${waiting.plan}`);
      this.store.setTaskStatus(waiting.taskId, 'pending');
      if (!this.pumping.has(chatId)) void this.pump(chatId);
      return null;
    }
    const rounds = reworks + 1;
    const task = this.store.getTask(waiting.taskId);
    const origin = waiting.origin !== '' ? waiting.origin : (task?.prompt ?? '');
    this.store.setTaskPlan(waiting.taskId, waiting.plan);
    this.store.addMessage(chatId, 'user', comment);
    this.store.setTaskStatus(waiting.taskId, 'cancelled');
    this.planWaiting.delete(chatId);
    // N3: the old (cancelled) taskId leaves no snapshot behind — its plan
    // turn never runs again, so neither the memory stash nor the durable
    // park-time snapshot may survive to confuse a future taskId reuse.
    this.planSnaps.delete(waiting.taskId);
    try {
      this.store.setTaskPlanDiff(waiting.taskId, null);
    } catch {
      // row cleanup is best-effort; a stale NULL-equivalent never executes
    }
    const s = getOrCreate(this.store, this.cfg, chatId);
    const nextId = this.store.createTask(
      chatId,
      task?.agent ?? s.agent,
      task?.mode ?? 'code',
      `${PLAN_REWORK_PREFIX}${comment}`,
      [],
      'plan-rework',
    );
    this.planTurns.add(nextId);
    this.planOrigin.set(nextId, origin);
    this.planRounds.set(nextId, rounds);
    // Durable from birth, like the first plan turn in submit().
    try {
      this.store.setTaskPlanMeta(nextId, origin, rounds);
    } catch {
      // memory above already carries this tick; the meta lands on park
    }
    if (!this.pumping.has(chatId)) void this.pump(chatId);
    return { rounds };
  }

  /** Register a plan for button-driven approval, keyed by chat. */
  parkPlan(chatId: number, taskId: number, plan: string, reworks = 0, origin = ''): void {
    this.planWaiting.set(chatId, { taskId, plan, reworks, origin });
    // The parked plan must survive a restart: origin + rework count live on
    // the row (`awaiting_plan` + `plan_text` were already durable).
    try {
      this.store.setTaskPlanMeta(taskId, origin, reworks);
    } catch {
      // memory above already carries this tick
    }
  }

  hasPlan(chatId: number): boolean {
    return this.waitingFor(chatId) !== undefined;
  }

  async cancel(chatId: number): Promise<CancelResult> {
    // Only a LIVE waiter counts as an approval cancel; an orphaned row is
    // settled as denied inside resolveApproval and cancel falls through.
    // The pending row is read BEFORE the flip so the response can name it.
    const pendingId = this.store.pendingApproval(chatId)?.id ?? null;
    if (resolveApproval(chatId, false) === 'live') return { kind: 'approval', id: pendingId };
    const waiting = this.waitingFor(chatId);
    if (waiting) {
      this.planWaiting.delete(chatId);
      this.store.setTaskStatus(waiting.taskId, 'cancelled');
      return { kind: 'plan', id: waiting.taskId };
    }
    const task = this.store.runningTask(chatId);
    if (!task || !this.pumping.has(chatId)) return { kind: 'nothing', id: null };
    this.store.setTaskStatus(task.id, 'cancelled');
    const sid = this.sessionIds.get(chatId);
    if (sid) {
      try {
        await getProvider(task.agent).cancel(sid);
      } catch {
        // provider cancel is best-effort
      }
    }
    await this.streams.get(chatId)?.fail('E_CANCELLED');
    return { kind: 'task', id: task.id };
  }

  status(chatId: number): { running: boolean; pending: number; plan: boolean } {
    return {
      running: this.pumping.has(chatId),
      pending: this.store.pendingCount(chatId),
      plan: this.waitingFor(chatId) !== undefined,
    };
  }

  private async pump(chatId: number): Promise<void> {
    if (this.pumping.has(chatId)) return;
    this.pumping.add(chatId);
    try {
      for (;;) {
        const task = this.store.oldestPending(chatId);
        if (!task) return;
        await this.execute(chatId, task.id);
      }
    } finally {
      this.pumping.delete(chatId);
      this.streams.delete(chatId);
      this.sessionIds.delete(chatId);
    }
  }

  private async execute(chatId: number, taskId: number): Promise<void> {
    const task0 = this.store.getTask(taskId);
    const stream = await this.io.streamStart(chatId, {
      mode: (task0?.mode as TaskMode) ?? 'ask',
      label: task0?.preset ?? '',
    });
    this.streams.set(chatId, stream);
    this.store.setTaskStatus(taskId, 'running');
    // W4 (M2/M3): the run context is the TASK ROW, not the live session — §4.2
    // stores `model`/`project` "на момент запуска", and that is exactly what a
    // confirmed confirmation card (M2) and a retry/continue (M3) must honour
    // after `PUT /api/settings` moved the session on. The row ALWAYS wins,
    // including `''` — `''` is a real value ("the sandbox", or "no model"), and
    // collapsing it to "ask the session" is precisely the drift M2 reported
    // (card said model:"" → the task ran "drifted-model"). Only `NULL` (a row
    // whose column was never written) falls back to the session.
    // Known one-way trade-off: `ALTER TABLE … DEFAULT ''` gave every PRE-W2 row
    // `project=''`, so a task that was still pending at the W2 migration runs in
    // the per-chat sandbox instead of the session project. Deliberate: the W2
    // migration is merged and its one-time window has passed, and correctness of
    // the confirmed-card contract is worth more than that row's old intent.
    const s0 = getOrCreate(this.store, this.cfg, chatId);
    const runProject = task0?.project ?? s0.project;
    // W3 BEFORE snapshot (right after `running`, before the agent touches
    // anything). `resolveWorkdir` mkdirs first so the sandbox/inbox creation
    // itself never shows up as a task change. Never throws: any failure
    // degrades to `null` (non-git / no git / timeout → empty diff later).
    let snapBefore: GitSnapshot | null = null;
    let snapWorkdir = '';
    try {
      snapWorkdir = resolveWorkdir(this.cfg, chatId, runProject);
      // N1: the sig loop over a pathological dirty tree is bounded too —
      // missing sigs degrade to conservative keep.
      snapBefore = snapshotGit(snapWorkdir, Date.now() + DIFF_BUDGET_MS);
    } catch {
      snapBefore = null;
      snapWorkdir = '';
    }
    // B1: an approved parked plan re-runs under the SAME taskId — attribute
    // against the plan turn's BEFORE snapshot, not a fresh (post-plan-turn)
    // one. Consumed single-use; workdir mismatch (project switched while
    // parked) falls back to the fresh snapshot.
    const carried = this.planSnaps.get(taskId);
    this.planSnaps.delete(taskId);
    if (carried !== undefined && carried.workdir === snapWorkdir) {
      snapBefore = carried.snap;
    } else if (snapWorkdir !== '') {
      // R2-MAJOR: restart lost the in-memory stash — rehydrate the park-time
      // snapshot persisted on the row (`plan_diff_before`). Same workdir gate:
      // a snapshot from another workdir is never applied. Single-use: the
      // row is cleared whether or not the payload validates.
      try {
        const saved = this.store.consumeTaskPlanDiff(taskId);
        if (saved !== null) {
          const parsed = JSON.parse(saved) as { workdir?: unknown; snap?: unknown };
          const ps = parsed.snap as { sha?: unknown; porcelain?: unknown; sigs?: unknown } | undefined;
          if (
            parsed.workdir === snapWorkdir &&
            ps !== undefined &&
            (ps.sha === null || typeof ps.sha === 'string') &&
            typeof ps.porcelain === 'string' &&
            (ps.sigs === undefined || (typeof ps.sigs === 'object' && ps.sigs !== null))
          ) {
            snapBefore = {
              sha: (ps.sha as string | null) ?? null,
              porcelain: ps.porcelain as string,
              sigs: (ps.sigs ?? {}) as Record<string, string>,
            };
          }
        }
      } catch {
        // Corrupt row or DB hiccup: the fresh snapshot stands.
      }
    }
    try {
      const s = getOrCreate(this.store, this.cfg, chatId);
      const task = this.store.getTask(taskId);
      if (!task) throw new Error('E_NO_TASK');
      const workdir = resolveWorkdir(this.cfg, chatId, task.project ?? s.project);
      const model = task.model ?? s.model;
      const history: HistoryItem[] = this.store
        .recentMessages(chatId, this.cfg.historyLimit)
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => ({ role: m.role as 'user' | 'assistant', text: m.text }));
      const sessionId = `${chatId}:${task.id}`;
      this.sessionIds.set(chatId, sessionId);
      const images: string[] = JSON.parse(task.images) as string[];
      // W4 skills (R3 §4b path ①): pinned SKILL.md bodies are composed onto the
      // prompt HERE, at execute time — the stored prompt stays raw so retry /
      // continue never stack the same bodies twice. Plan-turn wrapping applies
      // first (the plan instruction describes the implementation prompt).
      const basePrompt = this.planTurns.has(taskId) ? planPrompt(task.prompt) : task.prompt;
      const agentTask: AgentTask = {
        sessionId,
        agent: task.agent as AgentId,
        mode: task.mode as TaskMode,
        model,
        // WAVE2/EXEC (plan turn): the stored prompt is the real one; the plan
        // instruction wraps it here so approve can run the original as-is.
        prompt: prependSkillBodies(workdir, basePrompt, parseSkillNames(task.skills_used)),
        images,
        workdir,
        autoApprove: s.autoApprove,
        timeoutMs: this.cfg.taskTimeoutMs,
        history,
        // Only opencode holds a real session today; other providers ignore it and
        // get history injection from `composePrompt`.
        resumeSessionId: task.agent === 'opencode' ? s.agentSessionId : '',
        requestApproval: (cmd) => this.io.askApproval(chatId, cmd),
        onSessionId: (id) => {
          try {
            this.store.setAgentSessionId(chatId, id === '' ? null : id);
          } catch {
            // a failed session-id write must not fail the task itself
          }
        },
      };
      const provider = getProvider(agentTask.agent);
      let full = '';
      // Attach markers are stripped from the LIVE message too, not just from the final
      // text: `[[attach:…]]` is protocol, and the owner must never see it arrive.
      const censor = new AttachCensor();
      const onEvent = (e: AgentEvent): void => {
        if (e.type === 'text') {
          full += e.delta;
          stream.push(censor.push(e.delta));
        }
      };
      const result = await withTimeout(provider.run(agentTask, onEvent), this.cfg.taskTimeoutMs, () => {
        void provider.cancel(sessionId);
      });
      // The plan for an attachment: visible text with the markers gone, plus the files
      // every marker and the fallback guesser resolved to inside the workdir.
      const plan = planAttachments(result.text === '' ? full : result.text, workdir);
      const reply = plan.text === '' ? '(пустой ответ)' : plan.text;
      // WAVE2/EXEC-BEGIN (plan turn completion: park the plan, ask to run)
      if (this.planTurns.delete(taskId)) {
        // Origin + rounds prefer memory, but the row carries them too — a
        // restart between submit and completion must not reset the counter.
        const origin = this.planOrigin.get(taskId) ?? task.plan_origin ?? task.prompt;
        const rounds = this.planRounds.get(taskId) ?? task.plan_reworks ?? 0;
        this.planOrigin.delete(taskId);
        this.planRounds.delete(taskId);
        this.store.setTaskPlan(taskId, reply);
        this.store.addMessage(chatId, 'assistant', reply);
        this.store.setTaskStatus(taskId, 'awaiting_plan');
        this.parkPlan(chatId, taskId, reply, rounds, origin);
        // B1 (+R2-MAJOR durable layer): stash this turn's BEFORE snapshot
        // for the approved re-run — in memory for the fast path, on the row
        // (`plan_diff_before`) for a restart mid-approval. A dedicated
        // column, not `setTaskGit` reuse: `files_summary` must never carry a
        // foreign (sigs-shaped) JSON between park and finalize.
        if (snapBefore !== null && snapWorkdir !== '') {
          this.planSnaps.set(taskId, { workdir: snapWorkdir, snap: snapBefore });
          try {
            this.store.setTaskPlanDiff(taskId, JSON.stringify({ workdir: snapWorkdir, snap: snapBefore }));
          } catch {
            // The memory stash still carries the non-restart case.
          }
        }
        await stream.finish(reply);
        const notify = this.planNotify;
        if (notify) {
          try {
            await notify(chatId, taskId, reply);
          } catch {
            // the plan itself is already delivered; a dead keyboard is minor
          }
        }
        return;
      }
      // WAVE2/EXEC-END
      this.store.setTaskCost(taskId, result.costUsd);
      this.store.addMessage(chatId, 'assistant', reply);
      // W3 AFTER snapshot (before `done`): what the task changed lands in
      // `task_files` + `git_*` columns. Best-effort — never fails the task.
      this.finishTaskDiff(taskId, snapWorkdir, snapBefore);
      this.store.setTaskStatus(taskId, 'done');
      await stream.finish(reply);
      // WAVE2/FILES: send what the answer asked for. Best-effort — a failed upload
      // must never fail the task — but every refused marker is told to the owner,
      // because a silently missing file is indistinguishable from a broken bot.
      for (const p of plan.problems) {
        await this.io
          .notify(chatId, `${outboundErrorMessage(p.code)}\nФайл: ${p.requested}`)
          .catch((e) => log(`attach-notify: ${errCode(e)}`));
      }
      if (this.io.attachFiles && plan.files.length > 0) {
        try {
          await this.io.attachFiles(chatId, plan.files, ATTACH_CAPTION);
        } catch (e) {
          log(`attach-files: ${errCode(e)}`);
        }
      }
    } catch (e) {
      const code = errCode(e);
      // WAVE2/EXEC (plan turn): a failed plan leaves nothing parked — clean up.
      this.planTurns.delete(taskId);
      this.planOrigin.delete(taskId);
      this.planRounds.delete(taskId);
      this.planSnaps.delete(taskId);
      this.store.setTaskStatus(taskId, code === 'E_CANCELLED' ? 'cancelled' : 'error');
      // W3: a failed task may still have changed files — same finalize branch
      // (covers cancel-mid-run too: `cancel()` only flips the status, the
      // collection always happens here when `execute` settles).
      this.finishTaskDiff(taskId, snapWorkdir, snapBefore);
      await stream.fail(code);
    }
  }

  /**
   * W3 AFTER snapshot + `task_files` rows + `git_*`/`files_summary` columns +
   * `rev` bump. Best-effort, never throws — but never silent either (m7):
   * collection failures are logged. `workdir === ''` means even the BEFORE
   * snapshot never resolved — nothing to collect. Whole collection runs under
   * DIFF_BUDGET_MS (M6). Plan-turn parks skip this (not terminal; the
   * approved re-run finalizes against the stashed BEFORE snapshot).
   */
  private finishTaskDiff(taskId: number, workdir: string, before: GitSnapshot | null): void {
    try {
      if (workdir === '') return;
      const deadline = Date.now() + DIFF_BUDGET_MS;
      const after = snapshotGit(workdir, deadline);
      const files = collectTaskFiles(before, after, workdir, deadline);
      this.store.saveTaskFiles(taskId, files);
      this.store.setTaskGit(
        taskId,
        before?.porcelain ?? null,
        after?.porcelain ?? null,
        before?.sha ?? null,
        JSON.stringify(summarizeFiles(files)),
      );
    } catch (e) {
      // Best-effort: the task status set beside this still lands.
      log(`task-diff: collect failed for task ${taskId} (${e instanceof Error ? e.message : String(e)})`);
    }
  }
}

/** Plan mode: at most two rework rounds, then the task runs regardless. */
export const MAX_PLAN_REWORKS = 2;

export const PLAN_REWORK_PREFIX =
  'The user reviewed your plan and asked for changes. Produce an UPDATED short plan only, do not implement yet. Comment: ';

/** Instruction prepended to a /code turn when plan mode is on. */
export const PLAN_FIRST_INSTRUCTION =
  'Plan first. Reply with a SHORT plan (max 8 bullet points): files to touch, steps, risks. Do NOT write code or modify files in this turn.';

/** Turn a parked plan request into the composed prompt actually sent to the agent. */
export function planPrompt(prompt: string): string {
  return `${PLAN_FIRST_INSTRUCTION}\n\n${prompt}`;
}

/** Exported so the queue can hand `composePrompt` a plan-shaped task when needed. */
export { composePrompt };
