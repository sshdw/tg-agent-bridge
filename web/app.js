/**
 * W5 Mini App shell — boot, tabs, theme/viewport wiring, polling.
 * Browser entry (type="module" in index.html). Top-level DOM access is
 * guarded so the module also parses cleanly under node (harness greps it).
 */

import { createApiClient, createPoller, downloadUrl } from './lib/api.js';
import { autoPerf, PERF_CHOICE_KEY } from './lib/perf.js';
import { readThemeTokensPure } from './lib/theme.js';
import { formatElapsed, renderHome } from './screens/home.js';
import { renderTaskDetails, renderTasks } from './screens/tasks.js';
import {
  copyPath,
  DIFF_CHUNK,
  downloadFile,
  fileNameOf,
  renderDiff,
  renderFilePreview,
  renderFilesExplorer,
  renderTaskFiles,
} from './screens/files.js';

const tg = typeof window !== 'undefined' ? window.Telegram?.WebApp : undefined;
const doc = typeof document !== 'undefined' ? document : undefined;

const TABS = ['home', 'tasks', 'files', 'more'];

const state = {
  tab: 'home',
  current: null,
  recent: [],
  detailId: null,
  detailRev: undefined,
  detail: null,
  detailFiles: null,
  tsub: null,
  files: { dir: '.', abs: '', entries: [], total: 0 },
  fview: { kind: 'explorer' },
};

function el(id) {
  return doc ? doc.getElementById(id) : null;
}

function getInitData() {
  return (tg && tg.initData) || '';
}

const client = createApiClient({ getInitData });

/* ---------------- theme + geometry (SKILL.md minimal boot wiring) ---------------- */

function readThemeTokens() {
  if (!doc) return;
  const r = readThemeTokensPure({
    colorScheme: tg?.colorScheme,
    themeParams: tg?.themeParams,
  });
  doc.documentElement.dataset.scheme = r.scheme;
  doc.documentElement.dataset.flat = r.flat;
  doc.documentElement.dataset.hintOk = r.hintOk;
}

function syncGeometry() {
  if (!doc || !tg) return;
  const stable = tg.viewportStableHeight;
  if (typeof stable === 'number' && Number.isFinite(stable)) {
    doc.documentElement.style.setProperty('--tg-viewport-stable-height', `${stable}px`);
  }
  const c = tg.contentSafeAreaInset ?? { top: 0, bottom: 0, left: 0, right: 0 };
  doc.documentElement.style.setProperty('--tg-content-safe-area-inset-top', `${c.top ?? 0}px`);
  doc.documentElement.style.setProperty(
    '--tg-content-safe-area-inset-bottom',
    `${c.bottom ?? 0}px`,
  );
}

/* ---------------- perf choice: CloudStorage primary, localStorage fallback ---------------- */

function loadPerfChoice() {
  try {
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem(PERF_CHOICE_KEY) : null;
    if (v === 'lite' || v === 'full' || v === 'auto') return v;
  } catch {
    /* storage unavailable */
  }
  return 'auto';
}

function savePerfChoice(value) {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(PERF_CHOICE_KEY, value);
  } catch {
    /* storage unavailable */
  }
  try {
    tg?.CloudStorage?.setItem(PERF_CHOICE_KEY, value, () => undefined);
  } catch {
    /* older clients without CloudStorage */
  }
}

function applyPerf(mode) {
  if (!doc) return;
  if (mode === 'full' || mode === 'reduced' || mode === 'lite') {
    doc.documentElement.dataset.perf = mode;
  }
}

function resolvePerfChoice() {
  const stored = loadPerfChoice();
  if (stored === 'full' || stored === 'lite') {
    applyPerf(stored);
    return;
  }
  try {
    tg?.CloudStorage?.getItem(PERF_CHOICE_KEY, (_err, v) => {
      if (v === 'full' || v === 'lite') {
        applyPerf(v);
        return;
      }
      void autoPerf().then(applyPerf);
    });
  } catch {
    void autoPerf().then(applyPerf);
  }
  if (!tg?.CloudStorage) void autoPerf().then(applyPerf);
}

/* ---------------- tabs: instant 0 ms switch, no transition ---------------- */

/* Files tab: W5 stub replaced in W6 by the explorer below (pure render
 * lives in screens/files.js; data comes from the W4 files endpoints). */

function parentDir(dir) {
  const d = String(dir ?? '.');
  if (d === '.' || d === '' || !d.includes('/')) return d === '.' || d === '' ? null : '.';
  return d.slice(0, d.lastIndexOf('/')) || '.';
}

function paintFiles() {
  const v = state.fview;
  if (v.kind === 'preview') paint(renderFilePreview(v.data));
  else if (v.kind === 'diff') paint(renderDiff(v.data));
  else {
    paint(
      renderFilesExplorer({
        abs: state.files.abs,
        dir: state.files.dir,
        entries: state.files.entries,
        parent: state.files.dir === '.' ? null : parentDir(state.files.dir),
      }),
    );
  }
}

/** Tasks tab: list, details+changed-files, or per-task diff (single funnel). */
function paintTasks() {
  if (state.detailId === null || !state.detail) {
    paint(renderTasks({ tasks: state.recent }));
    return;
  }
  if (state.tsub && state.tsub.kind === 'diff') {
    paint(renderDiff(state.tsub.data));
    return;
  }
  const det = renderTaskDetails(state.detail);
  const files = state.detailFiles
    ? renderTaskFiles({ taskId: state.detailId, ...state.detailFiles }).html
    : '';
  paint({ html: det.html + files, float: det.float });
}

async function loadFiles(dir) {
  try {
    const r = await client.listFiles(dir);
    if (r.status === 200 && r.body) {
      state.files = {
        dir: String(dir ?? '.'),
        abs: String(r.body.abs ?? ''),
        entries: Array.isArray(r.body.entries) ? r.body.entries : [],
        total: Number(r.body.total) || 0,
      };
      state.fview = { kind: 'explorer' };
      if (state.tab === 'files') paintFiles();
    }
  } catch {
    /* keep the stale view; transport errors surface on the next tick */
  }
}

async function openPreview(rel) {
  try {
    const r = await client.filePreview(rel);
    if (r.status === 200 && r.body) {
      state.fview = {
        kind: 'preview',
        data: {
          path: String(rel ?? ''),
          abs: String(r.body.abs ?? ''),
          text: typeof r.body.text === 'string' ? r.body.text : '',
          truncated: r.body.truncated === true,
          size: Number(r.body.size) || 0,
          binary: r.body.binary === true,
        },
      };
      if (state.tab === 'files') paintFiles();
    }
  } catch {
    /* keep the stale view */
  }
}

async function openFileDiff(rel) {
  try {
    const r = await client.fileDiff(rel);
    if (r.status === 200 && r.body) {
      state.fview = {
        kind: 'diff',
        data: {
          path: String(rel ?? ''),
          abs: state.files.abs,
          rel: String(rel ?? ''),
          diff: typeof r.body.diff === 'string' ? r.body.diff : '',
          truncated: r.body.truncated === true,
          binary: r.body.binary === true,
          no_git: r.body.no_git === true,
          added: undefined,
          removed: undefined,
          shown: DIFF_CHUNK,
        },
      };
      if (state.tab === 'files') paintFiles();
    }
  } catch {
    /* keep the stale view */
  }
}

/** Per-task diff counters live on the taskFiles rows, not on the diff body. */
function taskRowCounts(taskFiles, path) {
  const hit = Array.isArray(taskFiles?.files)
    ? taskFiles.files.find((f) => String(f.path ?? '') === String(path ?? ''))
    : undefined;
  if (!hit) return { added: undefined, removed: undefined };
  return { added: Number(hit.added) || 0, removed: Number(hit.removed) || 0 };
}

async function openTaskDiff(id, rel) {
  try {
    const r = await client.taskDiff(id, rel);
    if (r.status === 200 && r.body) {
      const c = taskRowCounts(state.detailFiles, rel);
      state.tsub = {
        kind: 'diff',
        data: {
          path: String(rel ?? ''),
          abs: '',
          rel: String(rel ?? ''),
          diff: typeof r.body.diff === 'string' ? r.body.diff : '',
          truncated: r.body.truncated === true,
          binary: r.body.binary === true,
          no_git: false,
          added: c.added,
          removed: c.removed,
          shown: DIFF_CHUNK,
        },
      };
      if (state.tab === 'tasks') paintTasks();
    }
  } catch {
    /* keep the stale view */
  }
}

async function doCopy(abs, rel) {
  try {
    const clip =
      typeof navigator !== 'undefined' && navigator.clipboard ? navigator.clipboard : null;
    if (!clip) return;
    await copyPath({ clipboard: clip, haptics: tg?.HapticFeedback }, abs ?? '', rel ?? '');
  } catch {
    /* clipboard unavailable */
  }
}

function doDownload(rel) {
  try {
    const base =
      typeof location !== 'undefined' && location.origin ? location.origin : '';
    downloadFile({ tg }, base + downloadUrl(rel), fileNameOf(rel));
  } catch {
    /* no transport available */
  }
}

/* ---------------- drill-in → back (Telegram BackButton) ---------------- */

function goBack() {
  if (state.tab === 'files') {
    if (state.fview.kind === 'preview' || state.fview.kind === 'diff') {
      state.fview = { kind: 'explorer' };
      paintFiles();
      return;
    }
    if (state.files.dir !== '.') {
      const p = parentDir(state.files.dir);
      void loadFiles(p === null ? '.' : p);
    }
    return;
  }
  if (state.tab === 'tasks' && state.detailId !== null) {
    if (state.tsub) {
      state.tsub = null;
      paintTasks();
      return;
    }
    state.detailId = null;
    state.detail = null;
    state.detailFiles = null;
    paintTasks();
  }
}

function needBack() {
  if (state.tab === 'files') return state.fview.kind !== 'explorer' || state.files.dir !== '.';
  if (state.tab === 'tasks') return state.detailId !== null;
  return false;
}

function syncBack() {
  try {
    if (!tg?.BackButton) return;
    if (needBack()) tg.BackButton.show?.();
    else tg.BackButton.hide?.();
  } catch {
    /* older clients without BackButton */
  }
}

function stubMore() {
  return {
    html:
      `<section class="empty-state" aria-label="More coming soon">` +
      `<div class="h-title">More</div>` +
      `<p class="h-caption">Settings, skills and performance land in W7.</p>` +
      `</section>`,
    float: '',
  };
}

function moveIndicator() {
  if (!doc) return;
  const nav = doc.querySelector('.bottom-nav');
  const items = nav ? Array.from(nav.querySelectorAll('.nav-item')) : [];
  const ind = el('nav-ind');
  const idx = TABS.indexOf(state.tab);
  const target = items[idx];
  if (!nav || !ind || !target) return;
  const navBox = nav.getBoundingClientRect();
  const box = target.getBoundingClientRect();
  ind.style.setProperty('--ind-w', `${box.width}px`);
  ind.style.setProperty('--ind-x', `${box.left - navBox.left}px`);
}

function paint(view) {
  const screen = el('screen');
  const slot = el('float-slot');
  if (screen) screen.innerHTML = view.html;
  if (slot) slot.innerHTML = view.float;
  stampElapsed();
  syncBack();
}

function switchTab(tab) {
  if (!TABS.includes(tab)) return;
  state.tab = tab;
  if (tab !== 'tasks') {
    state.detailId = null;
    state.detail = null;
    state.detailFiles = null;
    state.tsub = null;
  }
  if (doc) {
    doc.querySelectorAll('.nav-item').forEach((b) => {
      b.setAttribute('aria-selected', b.dataset.tab === tab ? 'true' : 'false');
    });
  }
  if (tab === 'home') paint(renderHome({ running: state.current?.running ?? null, recent: state.recent }));
  else if (tab === 'tasks') paintTasks();
  else if (tab === 'files') {
    paintFiles();
    if (state.files.abs === '') void loadFiles(state.files.dir);
  } else paint(stubMore());
  try {
    tg?.HapticFeedback?.selectionChanged();
  } catch {
    /* haptics optional */
  }
  if (doc && typeof requestAnimationFrame !== 'undefined') requestAnimationFrame(moveIndicator);
  else moveIndicator();
}

/* ---------------- elapsed ticker (display only; server elapsed_s is truth) ---------------- */

function stampElapsed() {
  if (!doc) return;
  const now = Date.now();
  doc.querySelectorAll('[data-elapsed-base]').forEach((n) => {
    n.setAttribute('data-elapsed-at', String(now));
  });
}

function tickElapsed() {
  if (!doc) return;
  const now = Date.now();
  doc.querySelectorAll('[data-elapsed-base]').forEach((n) => {
    const base = Number(n.getAttribute('data-elapsed-base')) || 0;
    const at = Number(n.getAttribute('data-elapsed-at')) || now;
    n.textContent = formatElapsed(base + Math.max(0, Math.floor((now - at) / 1000)));
  });
}

/* ---------------- actions: stop (confirm) / retry / continue / details ---------------- */

function confirmStop() {
  return new Promise((resolve) => {
    try {
      if (tg?.showConfirm) {
        tg.showConfirm('Stop this task?', (ok) => resolve(ok === true));
        return;
      }
    } catch {
      /* fall through to window.confirm */
    }
    try {
      resolve(window.confirm('Stop this task?') === true);
    } catch {
      resolve(false);
    }
  });
}

async function refreshAll() {
  try {
    const r = await client.current();
    if (r.status !== 304 && r.body) {
      state.current = r.body;
      if (state.tab === 'home') paint(renderHome({ running: r.body.running ?? null, recent: state.recent }));
    }
  } catch {
    /* transport errors surface on the next tick */
  }
  try {
    const r = await client.recent(20, 0);
    if (r.status !== 304 && r.body && Array.isArray(r.body.tasks)) {
      state.recent = r.body.tasks;
      if (state.tab === 'home' && !state.current?.running) {
        paint(renderHome({ running: null, recent: state.recent }));
      } else if (state.tab === 'tasks' && !state.detailId) {
        paint(renderTasks({ tasks: state.recent }));
      }
    }
  } catch {
    /* transport errors surface on the next tick */
  }
}

async function onAction(action, id, ds = {}) {
  if (action === 'details') {
    state.detailId = id;
    state.detailRev = undefined;
    state.detail = null;
    state.detailFiles = null;
    state.tsub = null;
    state.tab = 'tasks';
    if (doc) {
      doc.querySelectorAll('.nav-item').forEach((b) => {
        b.setAttribute('aria-selected', b.dataset.tab === 'tasks' ? 'true' : 'false');
      });
    }
    try {
      const r = await client.task(id);
      if (r.status !== 304 && r.body && typeof r.body.rev === 'number') {
        state.detail = r.body;
        state.detailRev = r.body.rev;
      }
    } catch {
      state.detail = null;
    }
    try {
      const f = await client.taskFiles(id);
      if (f.status === 200 && f.body) state.detailFiles = f.body;
    } catch {
      state.detailFiles = null;
    }
    paintTasks();
    return;
  }
  if (action === 'files-open') {
    if (ds.isdir === '1') void loadFiles(ds.rel ?? '.');
    else void openPreview(ds.rel ?? '');
    return;
  }
  if (action === 'files-up') {
    const p = parentDir(state.files.dir);
    void loadFiles(p === null ? '.' : p);
    return;
  }
  if (action === 'files-preview') {
    void openPreview(ds.rel ?? '');
    return;
  }
  if (action === 'files-diff') {
    void openFileDiff(ds.rel ?? '');
    return;
  }
  if (action === 'files-download') {
    doDownload(ds.rel ?? '');
    return;
  }
  if (action === 'copy-path') {
    void doCopy(ds.abs ?? '', ds.rel ?? '');
    return;
  }
  if (action === 'diff-more') {
    if (state.tab === 'files' && state.fview.data) {
      state.fview.data.shown = (Number(state.fview.data.shown) || DIFF_CHUNK) + DIFF_CHUNK;
      paintFiles();
    } else if (state.tab === 'tasks' && state.tsub?.data) {
      state.tsub.data.shown = (Number(state.tsub.data.shown) || DIFF_CHUNK) + DIFF_CHUNK;
      paintTasks();
    }
    return;
  }
  if (action === 'task-diff') {
    void openTaskDiff(id, ds.rel ?? '');
    return;
  }
  if (action === 'files-back') {
    goBack();
    return;
  }
  if (action === 'stop') {
    if (!(await confirmStop())) return;
    try {
      await client.stop(id);
    } catch {
      /* refresh shows the truth */
    }
    state.detailId = null;
    state.detail = null;
    await refreshAll();
    return;
  }
  if (action === 'retry') {
    try {
      await client.retry(id);
    } catch {
      /* refresh shows the truth */
    }
    await refreshAll();
    return;
  }
  if (action === 'continue') {
    const input = doc ? doc.querySelector(`[data-continue-input="${id}"]`) : null;
    const text = input ? String(input.value ?? '').trim() : '';
    if (text === '') {
      try {
        tg?.HapticFeedback?.notificationOccurred('error');
      } catch {
        /* optional */
      }
      return;
    }
    try {
      await client.continueTask(id, text);
    } catch {
      /* refresh shows the truth */
    }
    await refreshAll();
  }
}

/* ---------------- boot ---------------- */

function boot() {
  tg?.ready();
  tg?.expand();
  try {
    tg?.disableVerticalSwipes?.();
  } catch {
    /* older clients without the method */
  }

  readThemeTokens();
  syncGeometry();
  tg?.onEvent?.('themeChanged', readThemeTokens);
  tg?.onEvent?.('viewportChanged', (e) => {
    if (e && e.isStateStable) syncGeometry();
  });
  tg?.onEvent?.('safeAreaChanged', syncGeometry);
  tg?.onEvent?.('contentSafeAreaChanged', syncGeometry);
  // Drill-in → BackButton. Event name per the official WebApp interface
  // (R1 §A.1 links it: docs/research/R1-MINIAPP-PLATFORM.md:650; BackButton
  // itself is required for tab navigation per R1:151; onEvent is the only
  // subscription mechanism per R1:173,206). The exact 'backButtonClicked'
  // string is INFERENCE from that interface (W5 had no back mechanism, so
  // there was nothing to reuse); guarded so unknown clients ignore it.
  // Haptic + clipboard + downloadFile follow the same defensive pattern.
  tg?.onEvent?.('backButtonClicked', goBack);

  resolvePerfChoice();

  if (doc) {
    doc.querySelectorAll('.nav-item').forEach((b) => {
      b.addEventListener('click', () => switchTab(b.dataset.tab));
    });
    doc.addEventListener('click', (e) => {
      const t = e.target && e.target.closest ? e.target.closest('[data-action]') : null;
      if (!t) return;
      void onAction(t.dataset.action, Number(t.dataset.id), t.dataset);
    });
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('resize', () => moveIndicator());
    }
  }

  switchTab('home');

  const currentPoller = createPoller({
    tick: () => client.current(),
    running: () => !!state.current?.running,
    isActive: () => (typeof document === 'undefined' ? true : document.hidden === false),
    onData: (r) => {
      if (r.body) {
        state.current = r.body;
        if (state.tab === 'home') {
          paint(renderHome({ running: r.body.running ?? null, recent: state.recent }));
        }
      }
    },
  });

  const recentPoller = createPoller({
    tick: () => client.recent(20, 0),
    running: () => false,
    isActive: () => (typeof document === 'undefined' ? true : document.hidden === false),
    onData: (r) => {
      if (r.body && Array.isArray(r.body.tasks)) {
        state.recent = r.body.tasks;
        if (state.tab === 'tasks' && !state.detailId) paintTasks();
        else if (state.tab === 'home' && !state.current?.running) {
          paint(renderHome({ running: null, recent: state.recent }));
        }
      }
    },
  });

  const detailPoller = createPoller({
    tick: () => (state.detailId === null ? { status: 304, body: null } : client.task(state.detailId, state.detailRev)),
    running: () => state.detailId !== null,
    isActive: () =>
      state.detailId !== null && (typeof document === 'undefined' ? true : document.hidden === false),
    onData: (r) => {
      if (r.body && typeof r.body.rev === 'number' && state.detailId !== null) {
        state.detail = r.body;
        state.detailRev = r.body.rev;
        if (state.tab === 'tasks' && state.detailId !== null && !state.tsub) paintTasks();
      }
    },
  });

  currentPoller.start();
  recentPoller.start();
  detailPoller.start();

  if (typeof setInterval !== 'undefined') setInterval(tickElapsed, 1000);

  const app = el('app');
  if (app) app.dataset.ready = '1';
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') boot();

export { boot, switchTab, onAction, goBack, needBack, readThemeTokens, syncGeometry, loadPerfChoice, savePerfChoice };
