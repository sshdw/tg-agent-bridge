import { existsSync, readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import type { AgentId } from './gateway/types.js';

export const AGENT_IDS: readonly AgentId[] = [
  'opencode',
  'cursor',
  'cline',
  'hermes',
  'mock',
];

export interface Config {
  botToken: string;
  allowedChatIds: number[];
  defaultAgent: AgentId;
  defaultModel: string;
  taskTimeoutMs: number;
  workRoot: string;
  allowedRoots: string[];
  autoApprove: boolean;
  historyLimit: number;
  opencodeBin: string;
  cursorBin: string;
  clineBin: string;
  hermesBaseUrl: string;
  hermesApiKey: string;
  dbPath: string;
}

function loadDotEnv(): void {
  const p = resolve(process.cwd(), '.env');
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const t = line.trim();
    if (t === '' || t.startsWith('#') || !t.includes('=')) continue;
    const i = t.indexOf('=');
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    else if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) v = v.slice(1, -1);
    if (!(k in process.env)) process.env[k] = v;
  }
}

function str(key: string, fallback = ''): string {
  const v = process.env[key];
  return v === undefined || v === '' ? fallback : v;
}

function num(key: string, fallback: number): number {
  const v = Number(process.env[key]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export function loadConfig(): Config {
  loadDotEnv();
  const botToken = str('BOT_TOKEN').trim();
  if (botToken === '') throw new Error('E_NO_TOKEN: put BOT_TOKEN into .env (see README)');
  const rawAgent = str('DEFAULT_AGENT', 'opencode').trim();
  const defaultAgent: AgentId = (AGENT_IDS as readonly string[]).includes(rawAgent)
    ? (rawAgent as AgentId)
    : 'opencode';
  const allowedChatIds = str('ALLOWED_CHAT_IDS')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  const workRoot = resolve(process.cwd(), str('WORK_ROOT', './work'));
  const allowedRoots = str('ALLOWED_ROOTS', './work')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .map((s) => resolve(process.cwd(), s));
  if (!allowedRoots.some((r) => r === workRoot || workRoot.startsWith(r + sep))) {
    allowedRoots.push(workRoot);
  }
  return {
    botToken,
    allowedChatIds,
    defaultAgent,
    defaultModel: str('DEFAULT_MODEL').trim(),
    taskTimeoutMs: num('TASK_TIMEOUT_MS', 2700000),
    workRoot,
    allowedRoots,
    autoApprove: str('AUTO_APPROVE', 'false').trim().toLowerCase() === 'true',
    historyLimit: num('HISTORY_LIMIT', 50),
    opencodeBin: str('OPENCODE_BIN', 'opencode'),
    cursorBin: str('CURSOR_BIN', 'cursor-agent'),
    clineBin: str('CLINE_BIN', 'roo-code'),
    hermesBaseUrl: str('HERMES_BASE_URL').trim(),
    hermesApiKey: str('HERMES_API_KEY').trim(),
    dbPath: resolve(process.cwd(), str('DB_PATH', './data/bridge.db')),
  };
}
