import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DIFF_MAX_LINES, TASK_FILES_MAX, enforceDiffCap, sanitizeDiffPath } from '../miniapp/diff.js';

export interface SessionRow {
  chat_id: number;
  agent: string;
  model: string;
  project: string;
  auto_approve: number;
  /** Real agent-side session id (opencode `ses_*`). NULL until the first task. */
  agent_session_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface TaskRow {
  id: number;
  chat_id: number;
  agent: string;
  mode: string;
  prompt: string;
  images: string;
  status: string;
  /** USD cost reported by the agent, or NULL when the provider does not report one. */
  cost_usd: number | null;
  /** Plan text captured in plan mode, for the approve/rework flow. */
  plan_text: string | null;
  /** Preset that produced the task (/review, /test, /fix), '' when none. */
  preset: string | null;
  /** Short title (first ~60 chars of prompt, set by W3). NULL until set. */
  title: string | null;
  /** Model at launch time. '' when unset. */
  model: string;
  /** Project/workdir at launch time. '' when unset. */
  project: string;
  /** JSON array of skill names attached at launch. '[]' when none. */
  skills_used: string;
  /** Cheap-polling counter, bumped +1 on every status change. */
  rev: number;
  /** Durable origin (implementation) prompt of a parked plan. NULL when none. */
  plan_origin: string | null;
  /** Durable rework rounds already spent on a parked plan. */
  plan_reworks: number;
  /** `git status --porcelain` before the task (W3). NULL when never collected. */
  git_before: string | null;
  /** `git status --porcelain` after the task (W3). NULL when never collected. */
  git_after: string | null;
  /** HEAD sha before the task (W3). NULL outside git repos / no git. */
  git_base_sha: string | null;
  /** JSON `{changed_n, added, removed}` over ALL changed files (W3). NULL until collected. */
  files_summary: string | null;
  created_at: number;
  finished_at: number | null;
}

export interface MsgRow {
  id: number;
  role: string;
  text: string;
  created_at: number;
}

export interface CiWatchRow {
  id: number;
  chat_id: number;
  repo: string;
  branch: string;
  last_status: string;
  last_run_id: number | null;
  created_at: number;
  updated_at: number;
}

/** One durable shell-approval row. `status`: pending|allowed|denied|expired. */
export interface ApprovalRow {
  id: number;
  chat_id: number;
  command: string;
  status: string;
  created_at: number;
  resolved_at: number | null;
}

/** One pre-run confirmation-card row. `status`: open|confirmed|discarded|expired. */
export interface DraftRow {
  id: number;
  chat_id: number;
  prompt: string;
  mode: string;
  agent: string;
  model: string;
  project: string;
  /** JSON array of pinned skill names. */
  skills: string;
  status: string;
  created_at: number;
}

/** One changed-file row (W3). `truncated`/`binary` are 0/1. */
export interface TaskFileRow {
  id: number;
  task_id: number;
  path: string;
  added: number;
  removed: number;
  /** Unified diff text (capped), NULL for binary/oversize/unreadable. */
  diff: string | null;
  truncated: number;
  binary: number;
}

/** Shape of `tasks.files_summary` (JSON) and `Store.taskFilesSummary`. */
export interface FilesSummaryShape {
  changed_n: number;
  added: number;
  removed: number;
}

/** How long an approval or draft stays resolvable (24 h, seconds). */
export const PENDING_TTL_SEC = 86400;

/** Statuses that mean "this task is no longer owned by a live process". */
const FINISHED_STATUSES = ['done', 'error', 'cancelled'] as const;

const nowSec = (): number => Math.floor(Date.now() / 1000);

export class Store {
  private db: Database.Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  /**
   * Forward-only migrations.
   *
   * `CREATE TABLE IF NOT EXISTS` covers fresh databases; `addColumn` covers
   * databases created by an earlier version. Never drop or rewrite a column —
   * the owner's chat history and session ids must survive every upgrade.
   */
  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        chat_id INTEGER PRIMARY KEY,
        agent TEXT NOT NULL,
        model TEXT NOT NULL DEFAULT '',
        project TEXT NOT NULL DEFAULT '',
        auto_approve INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id INTEGER NOT NULL,
        role TEXT NOT NULL,
        text TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id INTEGER NOT NULL,
        agent TEXT NOT NULL,
        mode TEXT NOT NULL DEFAULT 'ask',
        prompt TEXT NOT NULL,
        images TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL,
        finished_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS ci_watch (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id INTEGER NOT NULL,
        repo TEXT NOT NULL,
        branch TEXT NOT NULL DEFAULT '',
        last_status TEXT NOT NULL DEFAULT '',
        last_run_id INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages (chat_id, id);
      CREATE INDEX IF NOT EXISTS idx_tasks_chat ON tasks (chat_id, status, id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_ci_watch_chat_repo ON ci_watch (chat_id, repo);
      CREATE TABLE IF NOT EXISTS approvals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id INTEGER NOT NULL,
        command TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL,
        resolved_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS drafts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id INTEGER NOT NULL,
        prompt TEXT NOT NULL,
        mode TEXT NOT NULL DEFAULT 'ask',
        agent TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL DEFAULT '',
        project TEXT NOT NULL DEFAULT '',
        skills TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'open',
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS skill_pins (
        chat_id INTEGER NOT NULL,
        skill TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (chat_id, skill)
      );
      CREATE TABLE IF NOT EXISTS task_files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL,
        path TEXT NOT NULL,
        added INTEGER NOT NULL DEFAULT 0,
        removed INTEGER NOT NULL DEFAULT 0,
        diff TEXT,
        truncated INTEGER NOT NULL DEFAULT 0,
        binary INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_approvals_chat ON approvals (chat_id, status, id);
      CREATE INDEX IF NOT EXISTS idx_drafts_chat ON drafts (chat_id, status, id);
      CREATE INDEX IF NOT EXISTS idx_task_files_task ON task_files (task_id);
    `);

    // v0.2: real agent sessions (opencode `ses_*`), NULL means "start a fresh one".
    this.addColumn('sessions', 'agent_session_id', 'TEXT');
    // v0.2: per-task cost, NULL when the provider reports none.
    this.addColumn('tasks', 'cost_usd', 'REAL');
    // v0.2: 'plan' mode tasks park here between plan approval and execution.
    this.addColumn('tasks', 'plan_text', 'TEXT');
    // v0.2: preset that produced the task (/review, /test, /fix), for /cost breakdowns.
    this.addColumn('tasks', 'preset', 'TEXT');
    // v0.5 W2: durability for the Mini App (approvals, drafts, plans, cheap polling).
    this.addColumn('tasks', 'title', 'TEXT');
    this.addColumn('tasks', 'model', "TEXT DEFAULT ''");
    this.addColumn('tasks', 'project', "TEXT DEFAULT ''");
    this.addColumn('tasks', 'skills_used', "TEXT DEFAULT '[]'");
    this.addColumn('tasks', 'rev', 'INTEGER DEFAULT 0');
    this.addColumn('tasks', 'plan_origin', 'TEXT');
    this.addColumn('tasks', 'plan_reworks', 'INTEGER DEFAULT 0');
    // v0.5 W3: what the task changed (git snapshots + file diffs for the Mini App).
    this.addColumn('tasks', 'git_before', 'TEXT');
    this.addColumn('tasks', 'git_after', 'TEXT');
    this.addColumn('tasks', 'git_base_sha', 'TEXT');
    this.addColumn('tasks', 'files_summary', 'TEXT');
    // Forward-compat: a hypothetical pre-W3 `task_files` without `binary`
    // (no real-world instance exists — production never had the table).
    this.addColumn('task_files', 'binary', 'INTEGER NOT NULL DEFAULT 0');
    // After every column exists (fresh and legacy DBs alike).
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_rev ON tasks (id, rev)');
  }

  private addColumn(table: string, column: string, type: string): void {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (cols.some((c) => c.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }

  // ---------------------------------------------------------------- sessions

  getSession(chatId: number): SessionRow | undefined {
    return this.db.prepare('SELECT * FROM sessions WHERE chat_id = ?').get(chatId) as
      | SessionRow
      | undefined;
  }

  saveSession(row: Omit<SessionRow, 'created_at' | 'updated_at'>): void {
    const t = nowSec();
    this.db
      .prepare(
        `INSERT INTO sessions (chat_id, agent, model, project, auto_approve, agent_session_id, created_at, updated_at)
         VALUES (@chat_id, @agent, @model, @project, @auto_approve, @agent_session_id, @t, @t)
         ON CONFLICT (chat_id) DO UPDATE SET
           agent = excluded.agent, model = excluded.model, project = excluded.project,
           auto_approve = excluded.auto_approve, agent_session_id = excluded.agent_session_id,
           updated_at = excluded.updated_at`,
      )
      .run({ ...row, t });
  }

  /** Persist the provider-side session id so the next task can resume it. */
  setAgentSessionId(chatId: number, sessionId: string | null): void {
    this.db
      .prepare('UPDATE sessions SET agent_session_id = ?, updated_at = ? WHERE chat_id = ?')
      .run(sessionId, nowSec(), chatId);
  }

  // ---------------------------------------------------------------- messages

  addMessage(chatId: number, role: string, text: string): void {
    this.db
      .prepare('INSERT INTO messages (chat_id, role, text, created_at) VALUES (?, ?, ?, ?)')
      .run(chatId, role, text, nowSec());
  }

  recentMessages(chatId: number, limit: number): MsgRow[] {
    const rows = this.db
      .prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT ?')
      .all(chatId, limit) as MsgRow[];
    return rows.reverse();
  }

  /** `/find <text>` — LIKE over the full history. Personal scale, no FTS needed. */
  findMessages(chatId: number, needle: string, limit: number): MsgRow[] {
    const like = `%${needle.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
    const rows = this.db
      .prepare(
        "SELECT * FROM messages WHERE chat_id = ? AND text LIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT ?",
      )
      .all(chatId, like, limit) as MsgRow[];
    return rows.reverse();
  }

  clearMessages(chatId: number): void {
    this.db.prepare('DELETE FROM messages WHERE chat_id = ?').run(chatId);
  }

  // ------------------------------------------------------------------- tasks

  createTask(
    chatId: number,
    agent: string,
    mode: string,
    prompt: string,
    images: string[],
    preset = '',
  ): number {
    const r = this.db
      .prepare(
        `INSERT INTO tasks (chat_id, agent, mode, prompt, images, status, preset, created_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(chatId, agent, mode, prompt, JSON.stringify(images), preset, nowSec());
    return Number(r.lastInsertRowid);
  }

  setTaskStatus(id: number, status: string): void {
    const finished = status === 'pending' || status === 'running' ? null : nowSec();
    this.db
      .prepare('UPDATE tasks SET status = ?, finished_at = ?, rev = rev + 1 WHERE id = ?')
      .run(status, finished, id);
  }

  /** Cheap-polling counter bump without a status change (W4 `?since_rev=`). */
  bumpRev(id: number): void {
    this.db.prepare('UPDATE tasks SET rev = rev + 1 WHERE id = ?').run(id);
  }

  /** Durable plan metadata: origin prompt + spent rework rounds of a parked plan. */
  setTaskPlanMeta(id: number, origin: string, reworks: number): void {
    this.db.prepare('UPDATE tasks SET plan_origin = ?, plan_reworks = ? WHERE id = ?').run(origin, reworks, id);
  }

  /**
   * W3 launch metadata, written once at submit (the only point where the
   * pinned skills are known): short title, session model/project, skills JSON.
   * No `rev` bump — the lifecycle bumps (running/cost/done/git) own that.
   */
  setTaskLaunchMeta(id: number, title: string, model: string, project: string, skillsJson: string): void {
    this.db
      .prepare('UPDATE tasks SET title = ?, model = ?, project = ?, skills_used = ? WHERE id = ?')
      .run(title, model, project, skillsJson, id);
  }

  /**
   * W3 diff finalize: git snapshots + `files_summary` JSON + `rev` bump (so
   * cheap polling sees the diff arrival, including on the error path).
   * NULLs mean "never collected" (non-git workdir, no git on PATH, timeout).
   */
  setTaskGit(
    id: number,
    before: string | null,
    after: string | null,
    baseSha: string | null,
    summaryJson: string | null,
  ): void {
    this.db
      .prepare(
        'UPDATE tasks SET git_before = ?, git_after = ?, git_base_sha = ?, files_summary = ?, rev = rev + 1 WHERE id = ?',
      )
      .run(before, after, baseSha, summaryJson, id);
  }

  /**
   * Replace the `task_files` rows of a task. Stores at most the first
   * TASK_FILES_MAX files (by the caller's order); beyond that only the
   * `files_summary` counters on the task row carry the full count.
   * Defense in depth (m3/m4): the ≤200-line cap is re-enforced and every
   * path re-sanitized here, not just in `unifiedDiff` — hostile rows never
   * reach the DB, and no NUL byte ever reaches it either.
   */
  saveTaskFiles(
    taskId: number,
    files: { path: string; added: number; removed: number; diff: string | null; truncated: boolean; binary: boolean }[],
  ): void {
    const tx = this.db.transaction(
      (list: { path: string; added: number; removed: number; diff: string | null; truncated: boolean; binary: boolean }[]) => {
        this.db.prepare('DELETE FROM task_files WHERE task_id = ?').run(taskId);
        const ins = this.db.prepare(
          'INSERT INTO task_files (task_id, path, added, removed, diff, truncated, binary) VALUES (?, ?, ?, ?, ?, ?, ?)',
        );
        for (const f of list.slice(0, TASK_FILES_MAX)) {
          const safePath = sanitizeDiffPath(f.path);
          if (safePath === null) continue;
          const capped = f.diff === null ? null : enforceDiffCap(f.diff, DIFF_MAX_LINES);
          const cut = capped !== null && f.diff !== null && capped !== f.diff;
          const dirty = f.diff !== null && f.diff.includes('\0');
          ins.run(
            taskId,
            safePath,
            f.added,
            f.removed,
            dirty ? null : capped,
            f.truncated || cut || dirty ? 1 : 0,
            f.binary || dirty ? 1 : 0,
          );
        }
      },
    );
    tx(files);
  }

  /** Changed-file rows of a task, in insertion order. */
  taskFiles(taskId: number): TaskFileRow[] {
    return this.db
      .prepare('SELECT * FROM task_files WHERE task_id = ? ORDER BY id ASC')
      .all(taskId) as TaskFileRow[];
  }

  /**
   * `{changed_n, added, removed}` for a task. Prefers the cached
   * `files_summary` (which holds the FULL count past the 50-row cap);
   * falls back to the stored rows when no summary was collected.
   */
  taskFilesSummary(taskId: number): FilesSummaryShape {
    const row = this.db.prepare('SELECT files_summary FROM tasks WHERE id = ?').get(taskId) as {
      files_summary: string | null;
    } | undefined;
    if (row?.files_summary) {
      try {
        const s = JSON.parse(row.files_summary) as Partial<FilesSummaryShape>;
        if (
          typeof s.changed_n === 'number' &&
          typeof s.added === 'number' &&
          typeof s.removed === 'number'
        ) {
          return { changed_n: s.changed_n, added: s.added, removed: s.removed };
        }
      } catch {
        // corrupt summary: fall through to the rows
      }
    }
    const files = this.taskFiles(taskId);
    let added = 0;
    let removed = 0;
    for (const f of files) {
      added += f.added;
      removed += f.removed;
    }
    return { changed_n: files.length, added, removed };
  }

  /** Empty `cost` clears the value; undefined leaves it untouched. Bumps `rev` (§5). */
  setTaskCost(id: number, cost: number | null): void {
    this.db.prepare('UPDATE tasks SET cost_usd = ?, rev = rev + 1 WHERE id = ?').run(cost, id);
  }

  setTaskPlan(id: number, plan: string): void {
    this.db.prepare('UPDATE tasks SET plan_text = ? WHERE id = ?').run(plan, id);
  }

  /** Plan approve: restore the implementation prompt on a parked plan-turn row. */
  setTaskPrompt(id: number, prompt: string): void {
    this.db.prepare('UPDATE tasks SET prompt = ? WHERE id = ?').run(prompt, id);
  }

  getTask(id: number): TaskRow | undefined {
    return this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
  }

  oldestPending(chatId: number): TaskRow | undefined {
    return this.db
      .prepare("SELECT * FROM tasks WHERE chat_id = ? AND status = 'pending' ORDER BY id ASC LIMIT 1")
      .get(chatId) as TaskRow | undefined;
  }

  runningTask(chatId: number): TaskRow | undefined {
    return this.db
      .prepare("SELECT * FROM tasks WHERE chat_id = ? AND status = 'running' ORDER BY id ASC LIMIT 1")
      .get(chatId) as TaskRow | undefined;
  }

  pendingCount(chatId: number): number {
    const r = this.db
      .prepare("SELECT COUNT(*) AS n FROM tasks WHERE chat_id = ? AND status = 'pending'")
      .get(chatId) as { n: number };
    return r.n;
  }

  /**
   * Boot recovery: a `running` row can only be stale, because the process that
   * owned it is gone (single-instance bot, one task per chat). Flip them back to
   * `pending` and report how many. Nothing is auto-executed — the owner decides.
   */
  recoverStaleRunning(): number {
    const r = this.db
      .prepare(
        "UPDATE tasks SET status = 'pending', finished_at = NULL, rev = rev + 1 WHERE status = 'running'",
      )
      .run();
    return r.changes;
  }

  /** Tasks that are parked waiting for the owner to approve the plan. */
  awaitingPlan(chatId: number): TaskRow | undefined {
    return this.db
      .prepare("SELECT * FROM tasks WHERE chat_id = ? AND status = 'awaiting_plan' ORDER BY id ASC LIMIT 1")
      .get(chatId) as TaskRow | undefined;
  }

  /** Every parked plan (all chats) — boot restore of the in-memory plan map. */
  awaitingPlans(): TaskRow[] {
    return this.db
      .prepare("SELECT * FROM tasks WHERE status = 'awaiting_plan' ORDER BY id ASC")
      .all() as TaskRow[];
  }

  costsSince(chatId: number, sinceSec: number): { total: number; priced: number; unpriced: number } {
    const r = this.db
      .prepare(
        `SELECT
           COALESCE(SUM(cost_usd), 0) AS total,
           COALESCE(SUM(CASE WHEN cost_usd IS NOT NULL THEN 1 ELSE 0 END), 0) AS priced,
           COALESCE(SUM(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END), 0) AS unpriced
         FROM tasks WHERE chat_id = ? AND created_at >= ?`,
      )
      .get(chatId, sinceSec) as { total: number; priced: number; unpriced: number };
    return r;
  }

  costByAgentSince(chatId: number, sinceSec: number): { agent: string; total: number; n: number }[] {
    return this.db
      .prepare(
        `SELECT agent, COALESCE(SUM(cost_usd), 0) AS total, COUNT(*) AS n
         FROM tasks WHERE chat_id = ? AND created_at >= ?
         GROUP BY agent ORDER BY total DESC`,
      )
      .all(chatId, sinceSec) as { agent: string; total: number; n: number }[];
  }

  // -------------------------------------------------------------- approvals

  /** Insert a pending approval, return its id. The chat-button and the Mini App race on it. */
  createApproval(chatId: number, command: string): number {
    const r = this.db
      .prepare("INSERT INTO approvals (chat_id, command, status, created_at) VALUES (?, ?, 'pending', ?)")
      .run(chatId, command, nowSec());
    return Number(r.lastInsertRowid);
  }

  getApproval(id: number): ApprovalRow | undefined {
    return this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as
      | ApprovalRow
      | undefined;
  }

  /**
   * Newest pending approval for a chat. Expired rows (older than 24 h) are
   * swept to `expired` on read and never returned.
   */
  pendingApproval(chatId: number): ApprovalRow | undefined {
    this.sweepExpiredApprovals();
    return this.db
      .prepare(
        "SELECT * FROM approvals WHERE chat_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1",
      )
      .get(chatId) as ApprovalRow | undefined;
  }

  /**
   * Single-use resolve. ONE statement decides the winner of a chat-button vs
   * Mini-App race: `UPDATE … WHERE status='pending'` flips exactly one row, so
   * exactly one caller sees `changes === 1`. The loser gets `resolved`.
   * Expired rows are swept to `expired` instead and report `expired`.
   */
  resolveApproval(id: number, decision: 'allowed' | 'denied'): 'ok' | 'resolved' | 'expired' | 'missing' {
    const row = this.getApproval(id);
    if (!row) return 'missing';
    if (row.status !== 'pending') return 'resolved';
    if (row.created_at + PENDING_TTL_SEC < nowSec()) {
      this.db
        .prepare("UPDATE approvals SET status = 'expired', resolved_at = ? WHERE id = ? AND status = 'pending'")
        .run(nowSec(), id);
      return 'expired';
    }
    const r = this.db
      .prepare('UPDATE approvals SET status = ?, resolved_at = ? WHERE id = ? AND status = ?')
      .run(decision, nowSec(), id, 'pending');
    return r.changes === 1 ? 'ok' : 'resolved';
  }

  /** Mark pending approvals older than 24 h as expired. Returns rows swept. */
  // NOTE (W4): this full-table sweep runs on every read (each chat message via
  // hasApproval too); trivial at personal scale, revisit only if `?since_rev=`
  // polling ever shows it hot.
  sweepExpiredApprovals(now = nowSec()): number {
    const r = this.db
      .prepare("UPDATE approvals SET status = 'expired', resolved_at = ? WHERE status = 'pending' AND created_at + ? < ?")
      .run(now, PENDING_TTL_SEC, now);
    return r.changes;
  }

  // ----------------------------------------------------------------- drafts

  /** Insert an open pre-run confirmation card, return its id. */
  createDraft(
    chatId: number,
    prompt: string,
    mode = 'ask',
    agent = '',
    model = '',
    project = '',
    skills: string[] = [],
  ): number {
    const r = this.db
      .prepare(
        `INSERT INTO drafts (chat_id, prompt, mode, agent, model, project, skills, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
      )
      .run(chatId, prompt, mode, agent, model, project, JSON.stringify(skills), nowSec());
    return Number(r.lastInsertRowid);
  }

  getDraft(id: number): DraftRow | undefined {
    return this.db.prepare('SELECT * FROM drafts WHERE id = ?').get(id) as DraftRow | undefined;
  }

  /** Newest open draft for a chat. Expired rows (older than 24 h) are swept on read. */
  openDraft(chatId: number): DraftRow | undefined {
    this.sweepExpiredDrafts();
    return this.db
      .prepare("SELECT * FROM drafts WHERE chat_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1")
      .get(chatId) as DraftRow | undefined;
  }

  /**
   * Single-use confirm/discard, same race contract as approvals: one
   * `UPDATE … WHERE status='open'` statement, winner sees `changes === 1`.
   */
  confirmDraft(id: number): 'ok' | 'resolved' | 'expired' | 'missing' {
    return this.finishDraft(id, 'confirmed');
  }

  discardDraft(id: number): 'ok' | 'resolved' | 'expired' | 'missing' {
    return this.finishDraft(id, 'discarded');
  }

  private finishDraft(
    id: number,
    to: 'confirmed' | 'discarded',
  ): 'ok' | 'resolved' | 'expired' | 'missing' {
    const row = this.getDraft(id);
    if (!row) return 'missing';
    if (row.status !== 'open') return 'resolved';
    if (row.created_at + PENDING_TTL_SEC < nowSec()) {
      this.db
        .prepare("UPDATE drafts SET status = 'expired' WHERE id = ? AND status = 'open'")
        .run(id);
      return 'expired';
    }
    const r = this.db
      .prepare('UPDATE drafts SET status = ? WHERE id = ? AND status = ?')
      .run(to, id, 'open');
    return r.changes === 1 ? 'ok' : 'resolved';
  }

  /** Mark open drafts older than 24 h as expired. Returns rows swept. */
  sweepExpiredDrafts(now = nowSec()): number {
    const r = this.db
      .prepare("UPDATE drafts SET status = 'expired' WHERE status = 'open' AND created_at + ? < ?")
      .run(PENDING_TTL_SEC, now);
    return r.changes;
  }

  // ------------------------------------------------------------- skill_pins

  /** Replace the pinned-skill set of a chat (one transaction). */
  setSkillPins(chatId: number, skills: string[]): void {
    const t = nowSec();
    const tx = this.db.transaction((list: string[]) => {
      this.db.prepare('DELETE FROM skill_pins WHERE chat_id = ?').run(chatId);
      const ins = this.db.prepare('INSERT INTO skill_pins (chat_id, skill, created_at) VALUES (?, ?, ?)');
      for (const skill of list) ins.run(chatId, skill, t);
    });
    tx(skills);
  }

  /** Pinned skill names of a chat, oldest first. */
  skillPins(chatId: number): string[] {
    const rows = this.db
      .prepare('SELECT skill FROM skill_pins WHERE chat_id = ? ORDER BY rowid ASC')
      .all(chatId) as { skill: string }[];
    return rows.map((r) => r.skill);
  }

  // --------------------------------------------------------------- ci_watch

  listCiWatch(chatId: number): CiWatchRow[] {
    return this.db
      .prepare('SELECT * FROM ci_watch WHERE chat_id = ? ORDER BY id ASC')
      .all(chatId) as CiWatchRow[];
  }

  listAllCiWatch(): CiWatchRow[] {
    return this.db.prepare('SELECT * FROM ci_watch ORDER BY id ASC').all() as CiWatchRow[];
  }

  getCiWatch(chatId: number, repo: string): CiWatchRow | undefined {
    return this.db
      .prepare('SELECT * FROM ci_watch WHERE chat_id = ? AND repo = ?')
      .get(chatId, repo) as CiWatchRow | undefined;
  }

  addCiWatch(chatId: number, repo: string, branch: string): void {
    const t = nowSec();
    this.db
      .prepare(
        `INSERT INTO ci_watch (chat_id, repo, branch, last_status, last_run_id, created_at, updated_at)
         VALUES (?, ?, ?, '', NULL, @t, @t)
         ON CONFLICT (chat_id, repo) DO UPDATE SET branch = excluded.branch, updated_at = excluded.updated_at`,
      )
      .run(chatId, repo, branch, { t });
  }

  removeCiWatch(chatId: number, repo: string): boolean {
    const r = this.db
      .prepare('DELETE FROM ci_watch WHERE chat_id = ? AND repo = ?')
      .run(chatId, repo);
    return r.changes > 0;
  }

  /**
   * Record the newest observed run. Scoped to (chat_id, repo): two chats may
   * watch the same repo (or one chat two branches of it) and must not share a
   * baseline, or DMs get lost / duplicated across chats.
   */
  updateCiWatchState(chatId: number, repo: string, status: string, runId: number | null): void {
    this.db
      .prepare(
        'UPDATE ci_watch SET last_status = ?, last_run_id = ?, updated_at = ? WHERE chat_id = ? AND repo = ?',
      )
      .run(status, runId, nowSec(), chatId, repo);
  }

  /** True when `status` is one of the terminal states the poller cares about. */
  static isFinishedStatus(status: string): boolean {
    return (FINISHED_STATUSES as readonly string[]).includes(status);
  }
}
