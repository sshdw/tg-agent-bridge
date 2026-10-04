/**
 * W7 More screen — PURE render (HTML strings, no DOM at module scope).
 * Importable from node >= 22 as ESM and from web/app.js.
 * Data shapes follow src/miniapp/api.ts: getSettings/putSettings,
 * pickersAgents/pickersModels/pickersProjects, getHealth, getSkills/putSkills.
 *
 * Design: settings/pickers are FLAT content (C1) — .content-card sections,
 * .set-row rows, .chip toggles. No glass here, no new accent place:
 * values reuse .metric, status text reuses .status-hl, the destructive
 * action reuses .btn-danger, links are plain buttons opening via openLink.
 * GitHub is minimal by owner decision: status + browser links, NO poller —
 * this module never fetches on its own; the shell loads once per visit.
 */

import { escapeHtml } from './home.js';
import { HEALTH_SIGNALS, healthReason } from '../lib/draft.js';

export { escapeHtml };

const PERF_OPTIONS = [
  { value: 'auto', label: 'Auto' },
  { value: 'full', label: 'Full effects' },
  { value: 'lite', label: 'Lite' },
];

function section(title, inner, testid) {
  return (
    `<section class="content-card more-sec" aria-label="${escapeHtml(title)}" data-testid="${testid}">` +
    `<div class="h-sub more-title">${escapeHtml(title)}</div>${inner}</section>`
  );
}

function pickerRow(label, current, kind, open) {
  return (
    `<div class="set-row"><span class="h-caption">${escapeHtml(label)}</span>` +
    `<span class="metric set-val">${escapeHtml(current === '' || current == null ? '—' : current)}</span>` +
    `<button class="btn btn-mini" type="button" data-action="picker-open" data-picker="${kind}" aria-expanded="${open ? 'true' : 'false'}">Change</button></div>`
  );
}

function optionList(kind, options, current) {
  const rows = options
    .map((o) => {
      const value = String(o.value ?? '');
      const label = String(o.label ?? o.value ?? '');
      const sel = value === String(current ?? '');
      return (
        `<button class="list-row opt-row" type="button" data-action="setting-pick" data-kind="${kind}" data-value="${escapeHtml(value)}" aria-pressed="${sel ? 'true' : 'false'}">` +
        `<span>${escapeHtml(label)}</span>${sel ? '<span class="status-hl">✓</span>' : ''}</button>`
      );
    })
    .join('');
  return `<div class="opt-list" role="listbox" aria-label="${escapeHtml(kind)} options">${rows}</div>`;
}

function sessionSection(settings, pickers, openPicker) {
  if (!settings) {
    return section('Session', '<p class="h-caption">Loading…</p>', 'more-session');
  }
  const kinds = ['agent', 'model', 'project'];
  const labels = { agent: 'Agent', model: 'Model', project: 'Project' };
  let inner = '';
  for (const k of kinds) {
    inner += pickerRow(labels[k], settings[k], k, openPicker === k);
    if (openPicker === k && pickers && Array.isArray(pickers[k])) {
      inner += optionList(k, pickers[k], settings[k]);
    }
    if (k === 'model' && pickers && pickers.modelsCached === true) {
      inner += '<p class="h-caption">Model list is cached — pull to refresh in chat.</p>';
    }
  }
  return section('Session', inner, 'more-session');
}

function signalRow(signal, value, open) {
  return (
    `<button class="list-row sig-row" type="button" data-action="health-reason" data-signal="${signal}" aria-expanded="${open ? 'true' : 'false'}">` +
    `<span>${escapeHtml(signal)}</span>` +
    `<span class="status-hl">${escapeHtml(value === '' || value == null ? '—' : value)}</span></button>` +
    (open ? `<p class="h-caption reason">${escapeHtml(healthReason(signal, value, open.staleS ?? null))}</p>` : '')
  );
}

function statusSection(health, healthOpen) {
  if (!health) {
    return section('Bridge status', '<p class="h-caption">Loading…</p>', 'more-status');
  }
  let inner = '';
  for (const s of HEALTH_SIGNALS) {
    const isOpen = healthOpen === s;
    inner += signalRow(s, health[s], isOpen ? { staleS: health.stale_s } : null);
  }
  inner +=
    `<div class="set-row"><span class="h-caption">Pending</span>` +
    `<span class="metric set-val">${Number(health.pending) || 0}</span></div>` +
    `<div class="set-row"><span class="h-caption">Heartbeat stale</span>` +
    `<span class="metric set-val">${health.stale_s == null ? '—' : `${Number(health.stale_s)} s`}</span></div>` +
    `<button class="btn btn-mini" type="button" data-action="health-refresh">Refresh</button>`;
  return section('Bridge status', inner, 'more-status');
}

function githubSection(health) {
  const status = health ? health.github : null;
  const inner =
    `<div class="set-row"><span class="h-caption">Token</span>` +
    `<span class="status-hl">${escapeHtml(status == null ? '…' : status)}</span></div>` +
    `<p class="h-caption">Read-only links — they open in the browser, nothing polls here.</p>` +
    `<button class="btn btn-mini" type="button" data-action="gh-open" data-url="https://github.com">Open GitHub</button>`;
  return section('GitHub', inner, 'more-github');
}

function perfSection(perf) {
  const cur = perf === 'full' || perf === 'lite' ? perf : 'auto';
  const rows = PERF_OPTIONS.map(
    (o) =>
      `<button class="chip" type="button" data-action="perf" data-value="${o.value}" aria-pressed="${cur === o.value ? 'true' : 'false'}">` +
      `${o.label}</button>`,
  ).join('');
  return section(
    'Performance',
    `<div class="chip-row" aria-label="Performance mode">${rows}</div>` +
      '<p class="h-caption">Auto follows the device; Full/Lite override it. Switches instantly, no reload.</p>',
    'more-perf',
  );
}

function settingsSection(settings) {
  if (!settings) {
    return section('Settings', '<p class="h-caption">Loading…</p>', 'more-settings');
  }
  const auto = settings.auto_approve === true;
  const roots = Array.isArray(settings.allowed_roots) ? settings.allowed_roots : [];
  const inner =
    `<div class="set-row"><span class="h-caption">Auto-approve shell</span>` +
    `<button class="chip" type="button" data-action="auto-approve" aria-pressed="${auto ? 'true' : 'false'}">${auto ? 'On' : 'Off'}</button></div>` +
    `<div class="h-caption">Allowed roots</div>` +
    (roots.length === 0
      ? '<p class="h-caption">—</p>'
      : roots.map((r) => `<div class="mono root-line">${escapeHtml(r)}</div>`).join('')) +
    `<button class="btn btn-danger" type="button" data-action="reset-session">Reset session</button>` +
    '<p class="h-caption">Reset drops the agent session so the next task starts fresh (chat /new equivalent).</p>';
  return section('Settings', inner, 'more-settings');
}

function skillsSection(skills, skillsAuto) {
  const list = Array.isArray(skills) ? skills : [];
  const rows =
    list.length === 0
      ? '<p class="h-caption">No skills found.</p>'
      : list
          .map(
            (s) =>
              `<div class="set-row skill-row"><span class="skill-name">${escapeHtml(s.name)}</span>` +
              `<button class="chip" type="button" data-action="skills-pin" data-skill="${escapeHtml(s.name)}" aria-pressed="${s.pinned === true ? 'true' : 'false'}">` +
              `${s.pinned === true ? 'Pinned' : 'Pin'}</button></div>` +
              `<p class="h-caption">${escapeHtml(s.description ?? '')} · ${escapeHtml(s.source ?? '')}</p>`,
          )
          .join('');
  const inner =
    `<div class="set-row"><span class="h-caption">Auto-pick skills</span>` +
    `<button class="chip" type="button" data-action="skills-auto" aria-pressed="${skillsAuto === true ? 'true' : 'false'}">` +
    `${skillsAuto === true ? 'On' : 'Off'}</button></div>` + rows;
  return section('Skills', inner, 'more-skills');
}

/**
 * Full More tab. Null data renders loading placeholders (the shell fills
 * them in after one fetch round — no polling from this tab).
 */
export function renderMore({
  settings = null,
  pickers = null,
  health = null,
  skills = [],
  skillsAuto = false,
  perf = 'auto',
  openPicker = null,
  healthOpen = null,
} = {}) {
  const html =
    sessionSection(settings, pickers, openPicker) +
    statusSection(health, healthOpen) +
    githubSection(health) +
    perfSection(perf) +
    settingsSection(settings) +
    skillsSection(skills, skillsAuto);
  return { html, float: '' };
}
