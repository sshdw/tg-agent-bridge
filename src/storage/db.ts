import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface SessionRow {
  chat_id: number;
  agent: string;
  model: string;
  project: string;
  auto_approve: number;
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
  created_at: number;
  finished_at: number | null;
}

export interface MsgRow {
  role: string;
  text: string;
}

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
      CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages (chat_id, id);
      CREATE INDEX IF NOT EXISTS idx_tasks_chat ON tasks (chat_id, status, id);
    `);
  }

  getSession(chatId: number): SessionRow | undefined {
    return this.db.prepare('SELECT * FROM sessions WHERE chat_id = ?').get(chatId) as
      | SessionRow
      | undefined;
  }

  saveSession(row: Omit<SessionRow, 'created_at' | 'updated_at'>): void {
    const t = nowSec();
    this.db
      .prepare(
        `INSERT INTO sessions (chat_id, agent, model, project, auto_approve, created_at, updated_at)
         VALUES (@chat_id, @agent, @model, @project, @auto_approve, @t, @t)
         ON CONFLICT (chat_id) DO UPDATE SET
           agent = excluded.agent, model = excluded.model, project = excluded.project,
           auto_approve = excluded.auto_approve, updated_at = excluded.updated_at`,
      )
      .run({ ...row, t });
  }

  addMessage(chatId: number, role: string, text: string): void {
    this.db
      .prepare('INSERT INTO messages (chat_id, role, text, created_at) VALUES (?, ?, ?, ?)')
      .run(chatId, role, text, nowSec());
  }

  recentMessages(chatId: number, limit: number): MsgRow[] {
    const rows = this.db
      .prepare('SELECT role, text FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT ?')
      .all(chatId, limit) as MsgRow[];
    return rows.reverse();
  }

  clearMessages(chatId: number): void {
    this.db.prepare('DELETE FROM messages WHERE chat_id = ?').run(chatId);
  }

  createTask(chatId: number, agent: string, mode: string, prompt: string, images: string[]): number {
    const r = this.db
      .prepare(
        'INSERT INTO tasks (chat_id, agent, mode, prompt, images, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(chatId, agent, mode, prompt, JSON.stringify(images), 'pending', nowSec());
    return Number(r.lastInsertRowid);
  }

  setTaskStatus(id: number, status: string): void {
    const finished = status === 'pending' || status === 'running' ? null : nowSec();
    this.db
      .prepare('UPDATE tasks SET status = ?, finished_at = ? WHERE id = ?')
      .run(status, finished, id);
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
}
