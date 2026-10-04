/**
 * W5 API client + poller — PURE module, no DOM, no Telegram API.
 * Importable from node >= 22 as ESM and from web/app.js.
 * Uses only the W4 contract: GET current/recent/one(+since_rev),
 * POST stop/retry/continue, GET files/preview/download/diff,
 * GET tasks/:id/files + tasks/:id/diff. Timestamps stay Unix seconds, server-side.
 */

/** Active poll cadence while a task runs (AC6: 1000..2000 ms). */
export const POLL_ACTIVE_MS = 1500;

/** Idle cadence when nothing runs or the view is hidden (AC6: 10..15 s). */
export const POLL_IDLE_MS = 12000;

/** Pure cadence rule: running + visible polls fast, anything else idles. */
export function nextPollDelay({ running, visible = true } = {}) {
  if (visible === false) return POLL_IDLE_MS;
  return running ? POLL_ACTIVE_MS : POLL_IDLE_MS;
}

/** 304 means "unchanged" — the caller must never re-render on it. */
export function isNotModified(status) {
  return status === 304;
}

/**
 * Minimal fetch wrapper. initData travels ONLY in the
 * `X-Telegram-Init-Data` header (W1 auth posture); fetchImpl is injectable
 * so the harness can stub transport without a browser.
 */
export function createApiClient({ base = '', getInitData = () => '', fetchImpl = null } = {}) {
  const runFetch =
    fetchImpl ??
    ((url, opts) => {
      if (typeof fetch === 'undefined') throw new Error('E_NO_FETCH');
      return fetch(url, opts);
    });

  async function req(path, { method = 'GET', body, query } = {}) {
    let url = base + path;
    if (query) {
      const qs = new URLSearchParams(query).toString();
      if (qs !== '') url += `?${qs}`;
    }
    const headers = { 'X-Telegram-Init-Data': getInitData() };
    let payload;
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await runFetch(url, { method, headers, body: payload });
    if (isNotModified(res.status)) return { status: 304, body: null };
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    return { status: res.status, body: data };
  }

  return {
    current: () => req('/api/tasks/current'),
    recent: (limit = 20, offset = 0) =>
      req('/api/tasks/recent', { query: { limit: String(limit), offset: String(offset) } }),
    task: (id, sinceRev) =>
      req(`/api/tasks/${String(id)}`, sinceRev === undefined ? {} : { query: { since_rev: String(sinceRev) } }),
    stop: (id) => req(`/api/tasks/${String(id)}/stop`, { method: 'POST', body: {} }),
    retry: (id) => req(`/api/tasks/${String(id)}/retry`, { method: 'POST', body: {} }),
    continueTask: (id, text) =>
      req(`/api/tasks/${String(id)}/continue`, { method: 'POST', body: { text } }),
    listFiles: (dir = '.') => req('/api/files', { query: { dir: String(dir ?? '.') } }),
    filePreview: (path) => req('/api/files/preview', { query: { path: String(path ?? '') } }),
    fileDiff: (path) => req('/api/files/diff', { query: { path: String(path ?? '') } }),
    taskFiles: (id) => req(`/api/tasks/${String(id)}/files`),
    taskDiff: (id, path) =>
      req(`/api/tasks/${String(id)}/diff`, { query: { path: String(path ?? '') } }),
    downloadUrl: (path) => downloadUrl(path),
  };
}

/**
 * Download URL builder (pure string — the bytes travel outside JSON, via
 * Telegram.WebApp.downloadFile with an openLink fallback). Exported
 * standalone so screens can build links without a client instance.
 */
export function downloadUrl(path) {
  return `/api/files/download?path=${encodeURIComponent(String(path ?? ''))}`;
}
/**
 * Transport poller with injectable scheduler. Semantics under test (AC6):
 * - paused while isActive() is false (no fetch, idle reschedule);
 * - 304 never reaches onData (no DOM re-render);
 * - delay follows nextPollDelay({running, visible}).
 */
export function createPoller({
  tick,
  running = () => false,
  isActive = () => true,
  onData = null,
  schedule = (fn, ms) => setTimeout(fn, ms),
  cancel = (t) => clearTimeout(t),
} = {}) {
  if (typeof tick !== 'function') throw new Error('E_BAD_ARG');
  let timer = null;
  let dead = true;

  async function step() {
    if (dead) return;
    if (!isActive()) {
      timer = schedule(step, POLL_IDLE_MS);
      return;
    }
    let rendered = false;
    try {
      const r = await tick();
      if (!isNotModified(r.status)) {
        rendered = true;
        if (onData) onData(r);
      }
    } catch {
      rendered = false;
    }
    if (dead) return;
    timer = schedule(step, nextPollDelay({ running: running(), visible: true }));
    return rendered;
  }

  return {
    start() {
      if (!dead) return;
      dead = false;
      void step();
    },
    stop() {
      dead = true;
      if (timer !== null) {
        cancel(timer);
        timer = null;
      }
    },
  };
}
