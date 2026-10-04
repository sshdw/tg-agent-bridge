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

function statusLine(t) {
  const agent = escapeHtml(t.agent ?? '—');
  const mode = escapeHtml(t.mode ?? '—');
  return `${agent} · ${mode}`;
}

function runningCard(running) {
  return (
    `<section class="content-card home-current" aria-label="Current task">` +
    `<div class="h-sub home-title">${escapeHtml(running.title ?? '')}</div>` +
    `<div class="h-caption">${escapeHtml(running.status ?? '')} · ${statusLine(running)}</div>` +
    `<div class="metric home-elapsed" data-elapsed-base="${Number(running.elapsed_s) || 0}">${formatElapsed(running.elapsed_s)}</div>` +
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
      html: runningCard(running),
      float: homeFloatBar(running),
    };
  }
  return {
    html:
      `<section class="empty-state" aria-label="No active task">` +
      `<div class="h-title">No active task</div>` +
      `<p class="h-caption">Send a message in chat to start one.</p>` +
      `</section>` +
      recentList(recent),
    float: '',
  };
}
