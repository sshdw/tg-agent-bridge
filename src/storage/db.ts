import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

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
    `);

    // v0.2: real agent sessions (opencode `ses_*`), NULL means "start a fresh one".
    this.addColumn('sessions', 'agent_session_id', 'TEXT');
    // v0.2: per-task cost, NULL when the provider reports none.
    this.addColumn('tasks', 'cost_usd', 'REAL');
    // v0.2: 'plan' mode tasks park here between plan approval and execution.
    this.addColumn('tasks', 'plan_text', 'TEXT');
    // v0.2: preset that produced the task (/review, /test, /fix), for /cost breakdowns.
    this.addColumn('tasks', 'preset', 'TEXT');
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
      .prepare('UPDATE tasks SET status = ?, finished_at = ? WHERE id = ?')
      .run(status, finished, id);
  }

  /** Empty `cost` clears the value; undefined leaves it untouched. */
  setTaskCost(id: number, cost: number | null): void {
    this.db.prepare('UPDATE tasks SET cost_usd = ? WHERE id = ?').run(cost, id);
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
      .prepare("UPDATE tasks SET status = 'pending', finished_at = NULL WHERE status = 'running'")
      .run();
    return r.changes;
  }

  /** Tasks that are parked waiting for the owner to approve the plan. */
  awaitingPlan(chatId: number): TaskRow | undefined {
    return this.db
      .prepare("SELECT * FROM tasks WHERE chat_id = ? AND status = 'awaiting_plan' ORDER BY id ASC LIMIT 1")
      .get(chatId) as TaskRow | undefined;
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

  updateCiWatchState(repo: string, status: string, runId: number | null): void {
    this.db
      .prepare('UPDATE ci_watch SET last_status = ?, last_run_id = ?, updated_at = ? WHERE repo = ?')
      .run(status, runId, nowSec(), repo);
  }

  /** True when `status` is one of the terminal states the poller cares about. */
  static isFinishedStatus(status: string): boolean {
    return (FINISHED_STATUSES as readonly string[]).includes(status);
  }
}
