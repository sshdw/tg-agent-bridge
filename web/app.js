/**
 * W5 Mini App shell — boot, tabs, theme/viewport wiring, polling.
 * Browser entry (type="module" in index.html). Top-level DOM access is
 * guarded so the module also parses cleanly under node (harness greps it).
 */

import { createApiClient, createPoller } from './lib/api.js';
import { autoPerf, PERF_CHOICE_KEY } from './lib/perf.js';
import { readThemeTokensPure } from './lib/theme.js';
import { formatElapsed, renderHome } from './screens/home.js';
import { renderTaskDetails, renderTasks } from './screens/tasks.js';

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

function stubFiles() {
  return {
    html:
      `<section class="empty-state" aria-label="Files coming soon">` +
      `<div class="h-title">Files</div>` +
      `<p class="h-caption">Project explorer lands in W6.</p>` +
      `</section>`,
    float: '',
  };
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
}

function switchTab(tab) {
  if (!TABS.includes(tab)) return;
  state.tab = tab;
  if (tab !== 'tasks') {
    state.detailId = null;
    state.detail = null;
  }
  if (doc) {
    doc.querySelectorAll('.nav-item').forEach((b) => {
      b.setAttribute('aria-selected', b.dataset.tab === tab ? 'true' : 'false');
    });
  }
  if (tab === 'home') paint(renderHome({ running: state.current?.running ?? null, recent: state.recent }));
  else if (tab === 'tasks') {
    paint(state.detailId && state.detail ? renderTaskDetails(state.detail) : renderTasks({ tasks: state.recent }));
  } else if (tab === 'files') paint(stubFiles());
  else paint(stubMore());
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

async function onAction(action, id) {
  if (action === 'details') {
    state.detailId = id;
    state.detailRev = undefined;
    state.detail = null;
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
    paint(state.detail ? renderTaskDetails(state.detail) : renderTasks({ tasks: state.recent }));
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

  resolvePerfChoice();

  if (doc) {
    doc.querySelectorAll('.nav-item').forEach((b) => {
      b.addEventListener('click', () => switchTab(b.dataset.tab));
    });
    doc.addEventListener('click', (e) => {
      const t = e.target && e.target.closest ? e.target.closest('[data-action]') : null;
      if (!t) return;
      void onAction(t.dataset.action, Number(t.dataset.id));
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
        if (state.tab === 'tasks' && !state.detailId) paint(renderTasks({ tasks: state.recent }));
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
        if (state.tab === 'tasks' && state.detailId !== null) paint(renderTaskDetails(state.detail));
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

export { boot, switchTab, onAction, readThemeTokens, syncGeometry, loadPerfChoice, savePerfChoice };
