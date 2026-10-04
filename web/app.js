/**
 * W5 Mini App shell — boot, tabs, theme/viewport wiring, polling.
 * Browser entry (type="module" in index.html). Top-level DOM access is
 * guarded so the module also parses cleanly under node (harness greps it).
 */

import { createApiClient, createPoller, downloadUrl } from './lib/api.js';
import { toggleInList, togglePreset, validateDraft } from './lib/draft.js';
import { autoPerf, PERF_CHOICE_KEY } from './lib/perf.js';
import { readThemeTokensPure } from './lib/theme.js';
import { renderConfirm } from './screens/confirm.js';
import { formatElapsed, renderHome } from './screens/home.js';
import { renderMore } from './screens/more.js';
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
  /* W7 More + confirm state. Draft text lives here (never in localStorage —
   * a draft is single-open server-side; a new POST expires the old one). */
  settings: null,
  agents: null,
  models: null,
  modelsCached: false,
  projects: null,
  health: null,
  skills: [],
  skillsAuto: false,
  perfChoice: 'auto',
  moreUI: { openPicker: null, healthOpen: null },
  composerText: '',
  confirm: null,
};

/* Known Telegram themeParams keys (theme.md §1 table). Values are mirrored
 * to --tg-theme-*; anything else is ignored. */
const THEME_VAR_KEYS = {
  bg_color: 1,
  secondary_bg_color: 1,
  section_bg_color: 1,
  header_bg_color: 1,
  bottom_bar_bg_color: 1,
  text_color: 1,
  hint_color: 1,
  link_color: 1,
  button_color: 1,
  button_text_color: 1,
  accent_text_color: 1,
  destructive_text_color: 1,
  section_header_text_color: 1,
  subtitle_text_color: 1,
  section_separator_color: 1,
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
  /* T1: Telegram themeParams are the source of truth. Mirror every known
   * key to its --tg-theme-* variable (dash-joined); invalid/absent keys
   * are removed so the neutral fallbacks in tokens.css take over. Custom
   * themes can never crash this loop. */
  const tp = tg?.themeParams ?? {};
  for (const k of Object.keys(THEME_VAR_KEYS)) {
    const v = tp[k];
    if (typeof v === 'string' && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v.trim())) {
      doc.documentElement.style.setProperty(`--tg-theme-${k.replace(/_/g, '-')}`, v.trim());
    } else {
      doc.documentElement.style.removeProperty(`--tg-theme-${k.replace(/_/g, '-')}`);
    }
  }
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

/**
 * W7 Performance switch: synchronous dataset.perf flip, no reload.
 * 'auto' re-resolves in the background; explicit full/lite apply at once.
 * Persists to CloudStorage primary + localStorage fallback (savePerfChoice).
 */
function applyPerfChoice(value) {
  const v = value === 'full' || value === 'lite' ? value : 'auto';
  state.perfChoice = v;
  savePerfChoice(v);
  if (v === 'full' || v === 'lite') applyPerf(v);
  else void autoPerf().then(applyPerf);
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
  if (state.confirm) {
    state.composerText = readConfirmText();
    closeConfirm();
    return;
  }
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
  if (state.confirm) return true;
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

/* ---------------- W7 More tab + confirmation card ---------------- */

function moreViewModel() {
  const pickers =
    state.agents || state.models || state.projects
      ? {
          agent: (state.agents ?? []).map((a) => ({ value: a, label: a })),
          model: (state.models ?? []).map((m) => ({ value: m.id, label: m.label })),
          project: (state.projects ?? []).map((p) => ({ value: p.dir, label: p.label })),
          modelsCached: state.modelsCached,
        }
      : null;
  return {
    settings: state.settings,
    pickers,
    health: state.health,
    skills: state.skills,
    skillsAuto: state.skillsAuto,
    perf: state.perfChoice,
    openPicker: state.moreUI.openPicker,
    healthOpen: state.moreUI.healthOpen,
  };
}

function paintMore() {
  paint(renderMore(moreViewModel()));
}

function paintConfirm() {
  if (!state.confirm) return;
  const c = state.confirm;
  paint(
    renderConfirm({
      text: c.text,
      mode: c.mode,
      preset: c.preset,
      agent: state.settings?.agent ?? '',
      model: state.settings?.model ?? '',
      project: state.settings?.project ?? '',
      skills: c.skills,
      pinned: state.skills.filter((s) => s.pinned).map((s) => s.name),
      attachN: 0,
      busy: c.busy,
      leaving: c.leaving,
    }),
  );
}

function pinnedNames() {
  return state.skills.filter((s) => s.pinned).map((s) => s.name);
}

async function loadSettings() {
  try {
    const r = await client.settings();
    if (r.status === 200 && r.body) state.settings = r.body;
  } catch {
    /* keep the stale view */
  }
}

async function loadSkills() {
  try {
    const r = await client.skills();
    if (r.status === 200 && r.body) {
      state.skills = Array.isArray(r.body.skills) ? r.body.skills : [];
      state.skillsAuto = r.body.auto === true;
    }
  } catch {
    /* keep the stale view */
  }
}

/** More tab data: one fetch round per visit, no poller (github minimal rule). */
async function loadMore() {
  await loadSettings();
  try {
    const r = await client.pickersAgents();
    if (r.status === 200 && r.body && Array.isArray(r.body.agents)) state.agents = r.body.agents;
  } catch {
    /* keep stale */
  }
  try {
    const r = await client.pickersModels();
    if (r.status === 200 && r.body && Array.isArray(r.body.models)) {
      state.models = r.body.models;
      state.modelsCached = r.body.cached === true;
    }
  } catch {
    /* keep stale */
  }
  try {
    const r = await client.pickersProjects();
    if (r.status === 200 && r.body && Array.isArray(r.body.projects)) {
      state.projects = r.body.projects;
    }
  } catch {
    /* keep stale */
  }
  try {
    const r = await client.health();
    if (r.status === 200 && r.body) state.health = r.body;
  } catch {
    /* keep stale */
  }
  await loadSkills();
  if (state.tab === 'more' && !state.confirm) paintMore();
}

/** Home → confirmation card. Text restores the preserved composer buffer. */
function openConfirm() {
  state.confirm = {
    text: state.composerText,
    mode: 'ask',
    preset: '',
    skills: pinnedNames(),
    busy: false,
    leaving: false,
  };
  paintConfirm();
  void (async () => {
    await loadSettings();
    await loadSkills();
    if (state.confirm) {
      state.confirm.skills = state.confirm.skills.length === 0 ? pinnedNames() : state.confirm.skills;
      paintConfirm();
    }
  })();
}

function readConfirmText() {
  try {
    const input = doc ? doc.querySelector('[data-confirm-input]') : null;
    if (input && typeof input.value === 'string') return input.value;
  } catch {
    /* no DOM */
  }
  return state.confirm ? state.confirm.text : '';
}

/** Edit/dismiss: play the 300 ms --ease-in exit, then reveal the tab. */
function closeConfirm(after) {
  if (!state.confirm) {
    if (state.tab === 'more') paintMore();
    else if (state.tab === 'tasks') paintTasks();
    else if (state.tab === 'files') paintFiles();
    else paint(renderHome({ running: state.current?.running ?? null, recent: state.recent }));
    return;
  }
  state.confirm.leaving = true;
  paintConfirm();
  setTimeout(() => {
    state.confirm = null;
    if (after === 'home') switchTab('home');
    else if (state.tab === 'more') paintMore();
    else if (state.tab === 'tasks') paintTasks();
    else if (state.tab === 'files') paintFiles();
    else paint(renderHome({ running: state.current?.running ?? null, recent: state.recent }));
  }, 300);
}

function openLink(url) {
  const u = String(url ?? '');
  if (!/^https:\/\//.test(u)) return 'none';
  try {
    if (tg?.openLink) {
      tg.openLink(u);
      return 'openLink';
    }
  } catch {
    /* fall through */
  }
  try {
    if (typeof window !== 'undefined' && typeof window.open === 'function') {
      window.open(u, '_blank', 'noopener');
      return 'window';
    }
  } catch {
    /* no transport */
  }
  return 'none';
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

function syncHead() {
  /* Top-bar status pill mirrors the poller state the shell already owns:
   * running task -> Active, otherwise Idle. No invented data. */
  if (!doc) return;
  const live = !!state.current?.running;
  const text = doc.getElementById('app-status-text');
  if (text) text.textContent = live ? 'Active' : 'Idle';
  const pill = doc.getElementById('app-status');
  if (pill) pill.setAttribute('data-live', live ? '1' : '0');
}

function paint(view) {
  const screen = el('screen');
  const slot = el('float-slot');
  if (screen) {
    screen.innerHTML = view.html;
    if (view.float) screen.setAttribute('data-float', '1');
    else screen.removeAttribute('data-float');
  }
  if (slot) slot.innerHTML = view.float;
  stampElapsed();
  syncHead();
  syncBack();
}

function switchTab(tab) {
  if (!TABS.includes(tab)) return;
  if (state.confirm) {
    state.composerText = readConfirmText();
    state.confirm = null;
  }
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
  } else {
    paintMore();
    void loadMore();
  }
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

function showConfirmDialog(text) {
  return new Promise((resolve) => {
    try {
      if (tg?.showConfirm) {
        tg.showConfirm(text, (ok) => resolve(ok === true));
        return;
      }
    } catch {
      /* fall through to window.confirm */
    }
    try {
      resolve(window.confirm(text) === true);
    } catch {
      resolve(false);
    }
  });
}

function confirmStop() {
  return showConfirmDialog('Stop this task?');
}

function hapticSelect() {
  try {
    tg?.HapticFeedback?.selectionChanged();
  } catch {
    /* haptics optional */
  }
}

function hapticError() {
  try {
    tg?.HapticFeedback?.notificationOccurred('error');
  } catch {
    /* optional */
  }
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
      /* Home shows the recent list under the running card too, so a fresh
       * list always repaints the tab (running or idle). */
      if (state.tab === 'home') {
        paint(renderHome({ running: state.current?.running ?? null, recent: state.recent }));
      } else if (state.tab === 'tasks' && !state.detailId) {
        paint(renderTasks({ tasks: state.recent }));
      }
    }
  } catch {
    /* transport errors surface on the next tick */
  }
}

/* ---------------- W7 actions: confirm card, More, skills ---------------- */

/**
 * Reset session — the Mini App equivalent of chat /new
 * (src/core/router.ts:531: dropAgentSession + clearMessages).
 * PUT /api/settings has no "reset" field, but switching agent or project
 * drops the provider-side session server-side (src/miniapp/api.ts:786-788),
 * so reset = an agent round-trip: PUT {agent: other} then PUT {agent:
 * current}. Both flips drop agent_session_id; the visible session is
 * unchanged afterwards and the next task starts fresh. The agent pair comes
 * from the loaded pickers (never hardcoded). Chat-history clearing
 * (store.clearMessages) has no API equivalent — provider session only.
 */
async function resetSession() {
  if (!(await showConfirmDialog('Reset session? The next task starts fresh.'))) return;
  try {
    if (!state.agents) {
      const r = await client.pickersAgents();
      if (r.status === 200 && r.body && Array.isArray(r.body.agents)) state.agents = r.body.agents;
    }
    const cur = state.settings?.agent ?? (state.agents ?? [])[0] ?? '';
    const other = (state.agents ?? []).find((a) => a !== cur) ?? (cur === 'mock' ? 'opencode' : 'mock');
    await client.updateSettings({ agent: other });
    await client.updateSettings({ agent: cur });
    await loadSettings();
  } catch {
    /* refresh shows the truth */
  }
  if (state.tab === 'more' && !state.confirm) paintMore();
}

async function runConfirmCard() {
  const c = state.confirm;
  if (!c || c.busy) return;
  const text = readConfirmText();
  const v = validateDraft({ text, mode: c.mode, preset: c.preset, skills: c.skills });
  if (!v.ok || !v.payload) {
    hapticError();
    return;
  }
  c.busy = true;
  c.text = text;
  paintConfirm();
  try {
    // Single-open semantics are server-side: this POST expires any older
    // open draft for the chat (api.ts createDraft), the client keeps none.
    // The preset NAME rides along (never body text); the server bakes the
    // role prefix into the stored draft before confirm runs it.
    const d = await client.postDraft(v.payload.prompt, v.payload.mode, v.payload.skills, v.payload.preset);
    const id = d.body && d.body.draft ? Number(d.body.draft.id) : NaN;
    if (d.status !== 200 || !Number.isInteger(id)) {
      c.busy = false;
      paintConfirm();
      return;
    }
    const r = await client.confirmDraft(id);
    const taskId = r.body ? Number(r.body.task_id) : NaN;
    if (r.status !== 200 || !Number.isInteger(taskId)) {
      c.busy = false;
      paintConfirm();
      return;
    }
    state.composerText = '';
    state.confirm = null;
    await refreshAll();
    switchTab('home');
  } catch {
    c.busy = false;
    if (state.confirm) paintConfirm();
  }
}

/** W7 actions. Returns true when the action was handled here. */
async function onW7Action(action, ds = {}) {
  if (action === 'noop') return true;
  if (action === 'new-task') {
    openConfirm();
    return true;
  }
  /* Confirm-card actions need an open card; More actions work any time. */
  const CONFIRM_ACTIONS = ['preset', 'draft-mode', 'draft-skill', 'draft-run', 'draft-edit'];
  const MORE_ACTIONS = ['picker-open', 'setting-pick', 'auto-approve', 'perf', 'health-reason', 'health-refresh', 'gh-open', 'skills-pin', 'skills-auto', 'reset-session'];
  if (CONFIRM_ACTIONS.includes(action) && !state.confirm) return false;
  if (!CONFIRM_ACTIONS.includes(action) && !MORE_ACTIONS.includes(action)) return false;
  if (action === 'preset') {
    if (state.confirm) {
      state.confirm.text = readConfirmText();
      state.confirm.preset = togglePreset(state.confirm.preset, ds.preset);
      if (state.confirm.preset !== '') state.confirm.mode = 'code';
      hapticSelect();
      paintConfirm();
    }
    return true;
  }
  if (action === 'draft-mode') {
    if (state.confirm) {
      state.confirm.text = readConfirmText();
      const m = String(ds.mode ?? '');
      if (m === 'ask' || m === 'code' || m === 'plan') state.confirm.mode = m;
      state.confirm.preset = '';
      hapticSelect();
      paintConfirm();
    }
    return true;
  }
  if (action === 'draft-skill') {
    if (state.confirm) {
      state.confirm.text = readConfirmText();
      state.confirm.skills = toggleInList(state.confirm.skills, ds.skill);
      hapticSelect();
      paintConfirm();
    }
    return true;
  }
  if (action === 'draft-run') {
    await runConfirmCard();
    return true;
  }
  if (action === 'draft-edit') {
    if (state.confirm && !state.confirm.busy) {
      state.composerText = readConfirmText();
      closeConfirm();
    }
    return true;
  }
  if (action === 'picker-open') {
    state.moreUI.openPicker = state.moreUI.openPicker === ds.picker ? null : ds.picker;
    hapticSelect();
    paintMore();
    return true;
  }
  if (action === 'setting-pick') {
    const kind = String(ds.kind ?? '');
    const value = ds.value ?? '';
    if (kind === 'agent' || kind === 'model' || kind === 'project') {
      try {
        // Agent/project switches drop agent_session_id server-side
        // (chat parity with the telegram pickers); the badge below
        // re-renders from the PUT response via loadSettings.
        await client.updateSettings({ [kind]: value });
        await loadSettings();
      } catch {
        /* refresh shows the truth */
      }
      state.moreUI.openPicker = null;
      hapticSelect();
      if (state.tab === 'more' && !state.confirm) paintMore();
    }
    return true;
  }
  if (action === 'auto-approve') {
    try {
      await client.updateSettings({ auto_approve: !(state.settings?.auto_approve === true) });
      await loadSettings();
    } catch {
      /* refresh shows the truth */
    }
    hapticSelect();
    if (state.tab === 'more' && !state.confirm) paintMore();
    return true;
  }
  if (action === 'perf') {
    applyPerfChoice(String(ds.value ?? 'auto'));
    hapticSelect();
    if (state.tab === 'more' && !state.confirm) paintMore();
    return true;
  }
  if (action === 'health-reason') {
    const s = String(ds.signal ?? '');
    state.moreUI.healthOpen = state.moreUI.healthOpen === s ? null : s;
    hapticSelect();
    paintMore();
    return true;
  }
  if (action === 'health-refresh') {
    await loadMore();
    return true;
  }
  if (action === 'gh-open') {
    openLink(ds.url);
    return true;
  }
  if (action === 'skills-pin') {
    const name = String(ds.skill ?? '');
    if (name !== '') {
      const pins = toggleInList(pinnedNames(), name);
      try {
        await client.updateSkills(pins, state.skillsAuto);
        await loadSkills();
      } catch {
        /* refresh shows the truth */
      }
      hapticSelect();
      if (state.tab === 'more' && !state.confirm) paintMore();
    }
    return true;
  }
  if (action === 'skills-auto') {
    try {
      await client.updateSkills(pinnedNames(), !state.skillsAuto);
      await loadSkills();
    } catch {
      /* refresh shows the truth */
    }
    hapticSelect();
    if (state.tab === 'more' && !state.confirm) paintMore();
    return true;
  }
  if (action === 'reset-session') {
    await resetSession();
    return true;
  }
  return false;
}

async function onAction(action, id, ds = {}) {
  if (await onW7Action(action, ds)) return;
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
  state.perfChoice = loadPerfChoice();

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
        else if (state.tab === 'home') {
          paint(renderHome({ running: state.current?.running ?? null, recent: state.recent }));
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

export { boot, switchTab, onAction, goBack, needBack, readThemeTokens, syncGeometry, loadPerfChoice, savePerfChoice, applyPerfChoice };
