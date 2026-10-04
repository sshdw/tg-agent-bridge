/**
 * W5 Home screen — PURE render (HTML strings, no DOM at module scope).
 * Importable from node >= 22 as ESM and from web/app.js.
 * Data shapes follow src/miniapp/api.ts (current/recent/taskView).
 */

/** Minimal HTML escaping for server-provided titles/prompts. */
export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => {
    if (c === '&') return '&amp;';
    if (c === '<') return '&lt;';
    if (c === '>') return '&gt;';
    if (c === '"') return '&quot;';
    return '&#39;';
  });
}

/** Server elapsed_s (Unix-seconds based) as H:MM:SS / M:SS. Never client clocks. */
export function formatElapsed(elapsedS) {
  const s = Math.max(0, Math.floor(Number(elapsedS) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${h > 0 ? `${String(h)}:` : ''}${mm}:${String(sec).padStart(2, '0')}`;
}

/** Cost in USD with 4 decimals; null/NaN renders as an em dash. */
export function formatCost(costUsd) {
  const n = Number(costUsd);
  if (!Number.isFinite(n)) return '—';
  return `$${n.toFixed(4)}`;
}

/* Designed empty states: icon tile + title + sub (+ optional action).
 * `hero` centers the block in the tab's free space (top-level states only);
 * inline states (no git, no diff) stay compact. Icons are inline SVG,
 * currentColor, 1.75 stroke — no fonts, no raster, no new deps. */
const EMPTY_ICONS = {
  idle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M12 8.5V12l2.5 2.5"/></svg>',
  list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" aria-hidden="true"><path d="M5 6h14"/><path d="M5 12h14"/><path d="M5 18h14"/></svg>',
  folder:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" aria-hidden="true"><path d="M4 6h6l2 2h8v10H4z"/></svg>',
  code: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" aria-hidden="true"><path d="M9 6l-5 6 5 6"/><path d="M15 6l5 6-5 6"/></svg>',
  box: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" aria-hidden="true"><rect x="5" y="7" width="14" height="12" rx="2"/><path d="M5 10.5h14"/></svg>',
};

export function emptyState({ icon = 'list', title = '', sub = '', action = '', label = '', hero = false } = {}) {
  const art = `<span class="empty-icon" aria-hidden="true">${EMPTY_ICONS[icon] ?? EMPTY_ICONS.list}</span>`;
  return (
    `<section class="empty-state${hero ? ' empty-hero' : ''}" aria-label="${escapeHtml(label || title)}">` +
    art +
    `<div class="h-title">${escapeHtml(title)}</div>` +
    (sub === '' ? '' : `<p class="h-caption">${escapeHtml(sub)}</p>`) +
    (action === '' ? '' : action) +
    `</section>`
  );
}

function statusLine(t) {
  const agent = escapeHtml(t.agent ?? '—');
  const mode = escapeHtml(t.mode ?? '—');
  return `${agent} · ${mode}`;
}

function runningCard(running) {
  const cost = Number(running.cost_usd);
  const costLine =
    Number.isFinite(cost) && cost > 0
      ? `<div class="h-caption home-meta">cost <span class="metric">${formatCost(cost)}</span></div>`
      : '';
  return (
    `<section class="content-card home-current" aria-label="Current task">` +
    `<div class="h-sub home-title">${escapeHtml(running.title ?? '')}</div>` +
    `<div class="h-caption"><span class="status-hl">${escapeHtml(running.status ?? '')}</span> · ${statusLine(running)}</div>` +
    `<div class="metric home-elapsed" data-elapsed-base="${Number(running.elapsed_s) || 0}">${formatElapsed(running.elapsed_s)}</div>` +
    costLine +
    `</section>`
  );
}

/** Floating Stop/Details bar — the single .glass-float of the Home screen. */
function homeFloatBar(running) {
  return (
    `<div class="glass-float float-bar" role="toolbar" aria-label="Task actions">` +
    `<button class="btn btn-danger" type="button" data-action="stop" data-id="${Number(running.id)}">Stop</button>` +
    `<button class="btn" type="button" data-action="details" data-id="${Number(running.id)}">Details</button>` +
    `</div>`
  );
}

function recentList(tasks) {
  if (!tasks || tasks.length === 0) return '';
  const rows = tasks
    .slice(0, 5)
    .map(
      (t) =>
        `<button class="list-row task-row" type="button" data-action="details" data-id="${Number(t.id)}">` +
        `<span class="task-row-title">${escapeHtml(t.title ?? '')}</span>` +
        `<span class="h-caption">${escapeHtml(t.status ?? '')} · ${statusLine(t)}</span>` +
        `</button>`,
    )
    .join('');
  return `<section aria-label="Recent"><h2 class="h-caption section-header">Recent</h2>${rows}</section>`;
}

/**
 * Home states: running task (card + one floating bar) or idle
 * (empty-state + recent). Returns {html, float} so the shell can place
 * at most one .glass-float outside the content flow.
 */
export function renderHome({ running = null, recent = [] } = {}) {
  if (running) {
    return {
      html: runningCard(running) + recentList(recent),
      float: homeFloatBar(running),
    };
  }
  return {
    html:
      emptyState({
        icon: 'idle',
        title: 'No active task',
        sub: 'Send a message in chat to start one.',
        action: '<button class="btn btn-primary" type="button" data-action="new-task">New task</button>',
        label: 'No active task',
        hero: true,
      }) + recentList(recent),
    float: '',
  };
}
