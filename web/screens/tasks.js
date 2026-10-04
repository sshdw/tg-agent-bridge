/**
 * W5 Tasks screen — PURE render (HTML strings, no DOM at module scope).
 * Importable from node >= 22 as ESM and from web/app.js.
 * Data shapes follow src/miniapp/api.ts taskView/recent.
 */

import { escapeHtml, formatCost, formatElapsed } from './home.js';

export { escapeHtml, formatCost, formatElapsed };

function row(t) {
  return (
    `<button class="list-row task-row" type="button" data-action="details" data-id="${Number(t.id)}">` +
    `<span class="task-row-title">${escapeHtml(t.title ?? '')}</span>` +
    `<span class="h-caption">${escapeHtml(t.status ?? '')} · ${escapeHtml(t.agent ?? '—')} · ` +
    `${escapeHtml(t.mode ?? '—')} · <span class="metric">${formatElapsed(t.elapsed_s)}</span> · ` +
    `<span class="metric">${formatCost(t.cost_usd)}</span></span>` +
    `</button>`
  );
}

/** Recent list: title/agent/mode/status/elapsed/cost per row. */
export function renderTasks({ tasks = [] } = {}) {
  if (!tasks || tasks.length === 0) {
    return {
      html:
        `<section class="empty-state" aria-label="No tasks yet">` +
        `<div class="h-title">No tasks yet</div>` +
        `<p class="h-caption">Finished and running tasks appear here.</p>` +
        `</section>`,
      float: '',
    };
  }
  return {
    html:
      `<section aria-label="Tasks">` +
      `<h2 class="h-caption section-header">Tasks</h2>` +
      tasks.map(row).join('') +
      `</section>`,
    float: '',
  };
}

function skillsLine(skills) {
  if (!skills || skills.length === 0) return '<span class="h-caption">no skills</span>';
  return skills.map((s) => `<code class="mono skill-chip">${escapeHtml(s)}</code>`).join(' ');
}

function filesLine(summary) {
  const changed = Number(summary?.changed_n) || 0;
  const added = Number(summary?.added) || 0;
  const removed = Number(summary?.removed) || 0;
  return `<span class="metric">changed ${changed} +${added} −${removed}</span>`;
}

/**
 * Details: status, cost, skills_used, files summary `changed_n +N −N`,
 * plus the single .glass-float of the details view (stop/retry/continue).
 */
export function renderTaskDetails(t = {}) {
  const id = Number(t.id);
  const html =
    `<section class="content-card task-details" aria-label="Task details">` +
    `<div class="h-sub">${escapeHtml(t.title ?? '')}</div>` +
    `<div class="h-caption">status <span class="status-hl">${escapeHtml(t.status ?? '')}</span></div>` +
    `<div class="h-caption">cost <span class="metric">${formatCost(t.cost_usd)}</span></div>` +
    `<div class="h-caption">elapsed <span class="metric" data-elapsed-base="${Number(t.elapsed_s) || 0}">${formatElapsed(t.elapsed_s)}</span></div>` +
    `<div class="detail-block" data-testid="skills-used"><span class="h-caption">skills</span><div>${skillsLine(t.skills_used)}</div></div>` +
    `<div class="detail-block"><span class="h-caption">files</span><div>${filesLine(t.files_summary)}</div></div>` +
    `<div class="detail-block"><label class="h-caption" for="continue-text">Continue with instructions</label>` +
    `<input class="text-input" id="continue-text" data-continue-input="${id}" type="text" maxlength="4000" placeholder="What should change?">` +
    `</div>` +
    `</section>`;
  const float =
    `<div class="glass-float float-bar" role="toolbar" aria-label="Task actions">` +
    `<button class="btn btn-danger" type="button" data-action="stop" data-id="${id}">Stop</button>` +
    `<button class="btn" type="button" data-action="retry" data-id="${id}">Retry</button>` +
    `<button class="btn btn-primary" type="button" data-action="continue" data-id="${id}">Continue</button>` +
    `</div>`;
  return { html, float };
}
