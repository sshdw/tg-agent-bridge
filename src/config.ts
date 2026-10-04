import { existsSync, readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import type { AgentId } from './gateway/types.js';

export const AGENT_IDS: readonly AgentId[] = ['opencode', 'mock'];

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
  /** Classic PAT with `repo` + `workflow`. Empty disables every /commit /pr /ci /watch path. */
  githubToken: string;
  /** Absolute path to whisper-cli(.exe). Empty = voice disabled. */
  whisperBin: string;
  /** Absolute path to the ggml .bin model. Empty = voice disabled. */
  voiceModelPath: string;
  /** Spoken language hint passed to whisper.cpp (`-l`). */
  voiceLang: string;
  /** Absolute path to ffmpeg; empty = rely on PATH. */
  ffmpegBin: string;
  /** How often the CI poller ticks. */
  ciPollMs: number;
  dbPath: string;
  /** Port for the Mini App HTTP server (same process as polling). */
  miniPort: number;
  /** Public URL of the Mini App. Empty = skip menu-button wiring (D1). */
  miniUrl: string;
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

/**
 * Resolve a bare binary name to its Windows launcher when only the extensionless
 * shim is on PATH. npm installs `opencode`, `opencode.cmd` and `opencode.ps1`
 * side by side; `spawn('opencode')` finds none of them without a shell, so we
 * prefer the `.cmd` we can prove exists. Explicit env overrides always win.
 *
 * Exported because `gateway/models.ts` must spawn the SAME binary the agent runs:
 * `opencode models` is useless if it shells out to a different opencode install.
 */
export function resolveBin(override: string, fallback: string): string {
  if (override !== '') return override;
  if (process.platform !== 'win32') return fallback;
  const dirs = (process.env.PATH ?? '').split(';').filter((d) => d.trim() !== '');
  if (dirs.length === 0) {
    const appData = process.env.APPDATA ?? '';
    if (appData !== '') dirs.push(`${appData}\\npm`);
  }
  for (const dir of dirs) {
    for (const ext of ['.cmd', '.exe', '']) {
      const p = `${dir.replace(/[\\/]+$/, '')}\\${fallback}${ext}`;
      try {
        if (existsSync(p)) return p;
      } catch {
        // unreadable PATH entry: skip
      }
    }
  }
  return fallback;
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
    opencodeBin: resolveBin(str('OPENCODE_BIN').trim(), 'opencode'),
    cursorBin: resolveBin(str('CURSOR_BIN').trim(), 'cursor-agent'),
    clineBin: resolveBin(str('CLINE_BIN').trim(), 'roo-code'),
    hermesBaseUrl: str('HERMES_BASE_URL').trim(),
    hermesApiKey: str('HERMES_API_KEY').trim(),
    githubToken: str('GITHUB_TOKEN').trim(),
    whisperBin: resolveBin(str('WHISPER_BIN').trim(), 'whisper-cli'),
    voiceModelPath: str('VOICE_MODEL_PATH').trim(),
    voiceLang: str('VOICE_LANG', 'ru').trim() || 'ru',
    ffmpegBin: resolveBin(str('FFMPEG_BIN').trim(), 'ffmpeg'),
    ciPollMs: num('CI_POLL_MS', 300000),
    dbPath: resolve(process.cwd(), str('DB_PATH', './data/bridge.db')),
    miniPort: num('MINIAPP_PORT', 8080),
    miniUrl: str('MINIAPP_URL').trim(),
  };
}
