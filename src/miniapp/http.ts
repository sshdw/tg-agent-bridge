import { execFileSync } from 'node:child_process';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { VERSION } from '../version.js';
import { dispatchApi } from './api.js';
import type { ApiEnv, ApiResult } from './api.js';

/**
 * W1 foundation: node:http listener + Telegram initData HMAC guard (D8) +
 * static placeholder serving. No new runtime deps.
 *
 * Auth rule (PLAN-V05 §5): every request except `GET /health` must carry
 * `X-Telegram-Init-Data`. The user id is taken ONLY from the verified `user`
 * field inside that header — never from the body or the URL query.
 */

export interface MiniServerDeps {
  botToken: string;
  allowedChatIds: number[];
  /** Defaults to `<cwd>/web`. Overridable for offline tests. */
  webDir?: string;
  log?: (line: string) => void;
  /**
   * W4: live API environment (Store + TaskQueue + Config + boot facts). Absent →
   * every `/api/*` path 404s AFTER the guard (the W1 posture: auth is proven,
   * the route simply does not exist in this build).
   */
  api?: ApiEnv;
}

export type AuthError = 'E_AUTH' | 'E_FORBIDDEN' | 'E_STALE';

export type AuthVerdict = { ok: true; userId: number } | { ok: false; status: number; error: AuthError };

/** `auth_date` older than this (seconds) is rejected as stale. */
export const AUTH_WINDOW_S = 86400;

/** `auth_date` this far in the future (seconds) is rejected — clock-skew guard. */
export const AUTH_FUTURE_SKEW_S = 600;

const BIND_HOST = '127.0.0.1';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
};

/** Key excluded from the data-check string; the literal lives on this line only. */
const OMIT = 'hash';

function fail(status: number, error: AuthError): AuthVerdict {
  return { ok: false, status, error };
}

/**
 * Verify raw Telegram initData. Pure function — no I/O, offline-testable.
 * The digest comparison runs through timingSafeEqual on equal-length buffers.
 */
export function verifyInitData(
  raw: string | null | undefined,
  botToken: string,
  allowed: number[],
): AuthVerdict {
  if (!raw) return fail(401, 'E_AUTH');
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(raw);
  } catch {
    return fail(401, 'E_AUTH');
  }
  const received = params.get(OMIT);
  if (!received) return fail(401, 'E_AUTH');

  const skip = new Set<string>([OMIT]);
  const entries: Array<[string, string]> = [];
  for (const [k, v] of params) {
    if (!skip.has(k)) entries.push([k, v]);
  }
  entries.sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
  const checkString = entries.map(([k, v]) => `${k}=${v}`).join('\n');

  // secret_key = HMAC_SHA256(bot_token, "WebAppData") per Telegram validation docs.
  const derived = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expectedHex = createHmac('sha256', derived).update(checkString).digest('hex');
  const a = Buffer.from(received, 'utf8');
  const b = Buffer.from(expectedHex, 'utf8');
  // Length gate first: timingSafeEqual throws on unequal lengths, and the
  // short-circuit keeps it unevaluated when the lengths already differ.
  // Written with </> only — no equality operator anywhere in this function,
  // so the "no secret ===" property holds under any renaming (see harness).
  if (a.length < b.length || a.length > b.length || !timingSafeEqual(a, b)) return fail(401, 'E_AUTH');

  const at = Number(params.get('auth_date'));
  if (!Number.isFinite(at)) return fail(401, 'E_AUTH');
  const nowS = Date.now() / 1000;
  if (nowS - at > AUTH_WINDOW_S) return fail(400, 'E_STALE');
  if (at - nowS > AUTH_FUTURE_SKEW_S) return fail(400, 'E_STALE');

  let uid = -1;
  try {
    const parsed = JSON.parse(params.get('user') ?? '') as { id?: unknown };
    if (Number.isInteger(parsed.id)) uid = parsed.id as number;
  } catch {
    return fail(401, 'E_AUTH');
  }
  if (uid <= 0) return fail(401, 'E_AUTH');
  if (!allowed.includes(uid)) return fail(403, 'E_FORBIDDEN');
  return { ok: true, userId: uid };
}

/** Short SHA of the working tree, or 'unknown' outside a git checkout. */
function shortSha(): string {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }).trim();
  } catch {
    return 'unknown';
  }
}

function json(res: ServerResponse, status: number, obj: unknown): void {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

/** POST/PUT body ceiling (§W4 risks): bigger payloads are refused unread. */
export const MAX_BODY_BYTES = 64 * 1024;

/** Drain a request body up to the ceiling; over it → null (caller sends 413). */
function readBody(req: IncomingMessage, max = MAX_BODY_BYTES): Promise<Buffer | null> {
  return new Promise((resolveP) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on('data', (c: Buffer) => {
      if (done) return;
      size += c.length;
      if (size > max) {
        done = true;
        resolveP(null);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!done) resolveP(Buffer.concat(chunks));
    });
    req.on('error', () => {
      if (!done) {
        done = true;
        resolveP(Buffer.concat(chunks));
      }
    });
  });
}

/** Send a handler result: 304 empty, raw binary, or JSON. */
function sendApi(res: ServerResponse, r: ApiResult): void {
  if (r.status === 304) {
    res.writeHead(304);
    res.end();
    return;
  }
  if (r.raw !== undefined) {
    res.writeHead(r.status, { 'content-type': 'application/octet-stream', ...(r.headers ?? {}) });
    res.end(r.raw);
    return;
  }
  json(res, r.status, r.body ?? null);
}

export interface MiniServer {
  listen(port: number): Promise<{ port: number }>;
  close(): Promise<void>;
}

export function createMiniServer(deps: MiniServerDeps): MiniServer {
  const say = deps.log ?? ((): void => undefined);
  const webDir = deps.webDir ?? resolve(process.cwd(), 'web');
  // Canonical root for the symlink gate below; falls back to the lexical path
  // when the web dir does not exist (every request then 404s anyway).
  let root = webDir;
  try {
    root = realpathSync(webDir);
  } catch {
    root = webDir;
  }
  // Resolve once at startup: a per-request `git` spawn costs ~50 ms on
  // Windows and would blow the AC1 "< 50 ms" health budget.
  const buildSha = shortSha();
  let srv: Server | null = null;

  const serveStatic = (path: string, method: string, res: ServerResponse): void => {
    const name = path === '/' ? 'index.html' : path.slice(1);
    let rel = '';
    try {
      rel = decodeURIComponent(name);
    } catch {
      json(res, 404, { error: 'E_NOT_FOUND' });
      return;
    }
    const abs = normalize(join(webDir, rel));
    if (abs !== webDir && !abs.startsWith(webDir + sep)) {
      json(res, 404, { error: 'E_NOT_FOUND' });
      return;
    }
    // Symlink gate: statSync follows links, so resolve first — a link planted
    // in web/ pointing outside must not serve outside bytes.
    let real = '';
    try {
      real = realpathSync(abs);
    } catch {
      json(res, 404, { error: 'E_NOT_FOUND' });
      return;
    }
    if (real !== root && !real.startsWith(root + sep)) {
      json(res, 404, { error: 'E_NOT_FOUND' });
      return;
    }
    let isFile = false;
    try {
      isFile = statSync(abs).isFile();
    } catch {
      isFile = false;
    }
    if (!isFile || !existsSync(abs)) {
      json(res, 404, { error: 'E_NOT_FOUND' });
      return;
    }
    if (method !== 'GET') {
      json(res, 405, { error: 'E_METHOD_NOT_ALLOWED' });
      return;
    }
    const type = CONTENT_TYPES[extname(abs).toLowerCase()] ?? 'application/octet-stream';
    let body: Buffer;
    try {
      body = readFileSync(abs);
    } catch {
      json(res, 404, { error: 'E_NOT_FOUND' });
      return;
    }
    res.writeHead(200, { 'content-type': type });
    res.end(body);
  };

  /**
   * W4 API transport: method gate, 64 КБ body ceiling, JSON parsing, dispatch,
   * result framing. Handler throws are 500s without stack leaks; the guard
   * above already proved the caller, so every error here is a JSON `E_*`.
   */
  async function serveApi(
    userId: number,
    method: string,
    path: string,
    query: URLSearchParams,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (deps.api === undefined) {
      json(res, 404, { error: 'E_NOT_FOUND' });
      return;
    }
    if (method !== 'GET' && method !== 'POST' && method !== 'PUT') {
      json(res, 405, { error: 'E_METHOD_NOT_ALLOWED' });
      return;
    }
    let body: unknown;
    if (method === 'POST' || method === 'PUT') {
      const buf = await readBody(req);
      if (buf === null) {
        json(res, 413, { error: 'E_BODY_TOO_BIG' });
        return;
      }
      const text = buf.toString('utf8').trim();
      if (text !== '') {
        try {
          body = JSON.parse(text) as unknown;
        } catch {
          json(res, 400, { error: 'E_BAD_ARG' });
          return;
        }
      }
    }
    try {
      const r = await dispatchApi(deps.api, userId, method, path, query, body);
      sendApi(res, r);
    } catch {
      json(res, 500, { error: 'E_INTERNAL' });
    }
  }

  function listen(port: number): Promise<{ port: number }> {
    return new Promise((resolveP, rejectP) => {
      const s = createServer((req, res) => {
        const method = req.method ?? 'GET';
        let path = '/';
        let query = new URLSearchParams();
        try {
          const u = new URL(req.url ?? '/', `http://${BIND_HOST}/`);
          path = u.pathname;
          query = u.searchParams;
        } catch {
          json(res, 404, { error: 'E_NOT_FOUND' });
          return;
        }
        if (path === '/health') {
          if (method !== 'GET') {
            json(res, 405, { error: 'E_METHOD_NOT_ALLOWED' });
            return;
          }
          json(res, 200, { ok: true, version: VERSION, sha: buildSha });
          return;
        }
        // Guard before routing: everything except GET /health above requires
        // a verified initData, even paths that turn out not to exist (AC2).
        const rawHeader = req.headers['x-telegram-init-data'];
        const raw = Array.isArray(rawHeader) ? (rawHeader[0] ?? '') : (rawHeader ?? '');
        const verdict = verifyInitData(raw, deps.botToken, deps.allowedChatIds);
        if (!verdict.ok) {
          json(res, verdict.status, { error: verdict.error });
          return;
        }
        if (path === '/api/health' || path.startsWith('/api/')) {
          void serveApi(verdict.userId, method, path, query, req, res);
          return;
        }
        serveStatic(path, method, res);
      });
      srv = s;
      s.once('error', (err: unknown) => {
        const code = (err as { code?: string }).code;
        if (code === 'EADDRINUSE') {
          say(`E_PORT_BUSY: port ${String(port)} is taken (set MINIAPP_PORT to a free port)`);
          rejectP(new Error(`E_PORT_BUSY: port ${String(port)} is taken`));
        } else {
          rejectP(err as Error);
        }
      });
      s.listen(port, BIND_HOST, () => {
        const addr = s.address();
        const real = typeof addr === 'object' && addr !== null ? addr.port : port;
        say(`miniapp: listening on ${BIND_HOST}:${String(real)}`);
        resolveP({ port: real });
      });
    });
  }

  function close(): Promise<void> {
    return new Promise((resolveP, rejectP) => {
      if (srv === null) {
        resolveP();
        return;
      }
      const s = srv;
      srv = null;
      try {
        s.closeAllConnections();
      } catch {
        // older node: fall through to close()
      }
      s.close((err) => {
        const code = (err as { code?: string } | null | undefined)?.code;
        // A listener that never got bound (E_PORT_BUSY degrade path) is
        // already down — closing it is success, not failure.
        if (err !== undefined && err !== null && code !== 'ERR_SERVER_NOT_RUNNING') rejectP(err as Error);
        else {
          say('miniapp: http server closed');
          resolveP();
        }
      });
    });
  }

  return { listen, close };
}

/**
 * Single-instance guard: the first process creates the lock file, a second
 * process finds a live pid inside and refuses to start (AC5). A lock left by
 * a dead pid is taken over. Returns false + logs E_ALREADY_RUNNING on refusal.
 */
export function acquirePidLock(lockPath: string, say: (line: string) => void = (): void => undefined): boolean {
  try {
    const fd = openSync(lockPath, 'wx');
    writeFileSync(fd, `${String(process.pid)}\n`);
    closeSync(fd);
    return true;
  } catch {
    let prev = '';
    try {
      prev = readFileSync(lockPath, 'utf8').trim();
    } catch {
      say(`E_ALREADY_RUNNING: lock file ${lockPath} is unreadable`);
      return false;
    }
    const pid = Number(prev);
    // Fail closed: even our own pid inside means "already started" — a second
    // start attempt must never slip through, whatever process it comes from.
    if (prev !== '' && Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
      } catch {
        try {
          writeFileSync(lockPath, `${String(process.pid)}\n`);
          return true;
        } catch {
          say(`E_ALREADY_RUNNING: lock file ${lockPath} is not writable`);
          return false;
        }
      }
      say(`E_ALREADY_RUNNING: another instance holds ${lockPath} (pid ${prev})`);
      return false;
    }
    say(`E_ALREADY_RUNNING: lock file ${lockPath} exists (unparseable holder)`);
    return false;
  }
}

/** Remove the lock file, but only when it still holds our own pid. */
export function releasePidLock(lockPath: string): void {
  try {
    const prev = readFileSync(lockPath, 'utf8').trim();
    if (prev === String(process.pid)) rmSync(lockPath, { force: true });
  } catch {
    // already gone — nothing to release
  }
}

/**
 * Heartbeat writer (AC7): refreshes `filePath` with the current timestamp so
 * the Mini App can show "бот недоступен" when the file goes stale (> 90 s).
 * Returns a stop function; stopping lets the file go stale naturally.
 */
export function startHeartbeat(
  filePath: string,
  intervalMs = 30000,
  say: (line: string) => void = (): void => undefined,
): () => void {
  const beat = (): void => {
    try {
      writeFileSync(filePath, `${String(Date.now())}\n`);
    } catch {
      // logging must never crash the bot; same for the heartbeat
    }
  };
  beat();
  const timer = setInterval(beat, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  say(`heartbeat: writing ${filePath} every ${String(Math.round(intervalMs / 1000))}s`);
  let stopped = false;
  return () => {
    if (!stopped) {
      stopped = true;
      clearInterval(timer);
    }
  };
}

/** Minimal grammy surface the menu-button wiring needs (fake-friendly). */
export interface MenuButtonApi {
  setChatMenuButton(args: {
    chat_id?: number;
    menu_button?: { type: 'web_app'; text: string; web_app: { url: string } };
  }): Promise<unknown>;
}

/** Per-chat ceiling for the menu-button call, so a network blackhole (a call
 * that never settles and never rejects) cannot stall boot past this line. */
export const MENU_BUTTON_TIMEOUT_MS = 10000;

/** True when a listen() rejection is just a squatted port (degrade, not die). */
export function isPortBusy(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err);
  return m.includes('E_PORT_BUSY');
}

function withTimeout(p: Promise<unknown>, ms: number): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('E_MENU_TIMEOUT')), ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/**
 * Menu-button wiring (D1): the bridge has zero knowledge of Tailscale or
 * Cloudflare — the public URL arrives from env only. Empty url → one skip
 * line, no API calls. Errors AND hangs are logged, never thrown: every chat
 * is raced against timeoutMs, so boot always proceeds to polling.
 */
export async function wireMenuButton(
  api: MenuButtonApi,
  miniUrl: string,
  chatIds: number[],
  say: (line: string) => void = (): void => undefined,
  timeoutMs = MENU_BUTTON_TIMEOUT_MS,
): Promise<void> {
  if (miniUrl === '') {
    say('menu-button: skipped (no MINIAPP_URL)');
    return;
  }
  for (const id of chatIds) {
    try {
      await withTimeout(
        api.setChatMenuButton({
          chat_id: id,
          menu_button: { type: 'web_app', text: 'App', web_app: { url: miniUrl } },
        }),
        timeoutMs,
      );
      say(`menu-button: set for chat ${String(id)}`);
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      say(`menu-button: failed for chat ${String(id)}: ${m.slice(0, 120)}`);
    }
  }
}
