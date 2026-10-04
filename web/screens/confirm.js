/**
 * W7 confirmation card — PURE render (HTML strings, no DOM at module scope).
 * Importable from node >= 22 as ESM and from web/app.js.
 * Data shapes follow src/miniapp/api.ts postDrafts/confirmDraft (+ the
 * GET /api/settings snapshot the card was opened with).
 *
 * Design: the ONLY elevated-outside-nav/float case — a transient
 * `.glass-elevated` sheet (35% scrim lives in that class, tokens.css).
 * Present 300 ms --spring-sheet, dismiss --ease-in (see app.css W7 block).
 * Everything else on the card is flat content (C1): .content-card rows,
 * .chip toggles, .btn controls. No new accent place — Run reuses
 * .btn-primary, status text reuses .status-hl, numbers reuse .metric.
 */

import { escapeHtml } from './home.js';
import { PRESET_NAMES, validateDraft } from '../lib/draft.js';

export { escapeHtml };

const PRESET_LABEL = { review: 'Review', test: 'Test', fix: 'Fix' };
const MODES = ['ask', 'code', 'plan'];
const MODE_LABEL = { ask: 'Ask', code: 'Code', plan: 'Plan' };

function presetChips(preset) {
  return PRESET_NAMES.map(
    (n) =>
      `<button class="chip" type="button" data-action="preset" data-preset="${n}" aria-pressed="${preset === n ? 'true' : 'false'}">` +
      `${PRESET_LABEL[n]}</button>`,
  ).join('');
}

function modeSeg(mode) {
  return MODES.map(
    (m) =>
      `<button class="chip" type="button" data-action="draft-mode" data-mode="${m}" aria-pressed="${mode === m ? 'true' : 'false'}">` +
      `${MODE_LABEL[m]}</button>`,
  ).join('');
}

function contextRow(label, value) {
  return (
    `<div class="ctx-row"><span class="h-caption">${escapeHtml(label)}</span>` +
    `<span class="ctx-val">${escapeHtml(value === '' || value == null ? '—' : value)}</span></div>`
  );
}

function skillChips(pinned, selected) {
  if (!pinned || pinned.length === 0) {
    return '<span class="h-caption">no pinned skills — pin some in More</span>';
  }
  const sel = new Set((selected ?? []).map(String));
  return pinned
    .map(
      (s) =>
        `<button class="chip" type="button" data-action="draft-skill" data-skill="${escapeHtml(s)}" aria-pressed="${sel.has(String(s)) ? 'true' : 'false'}">` +
        `${escapeHtml(s)}</button>`,
    )
    .join('');
}

/**
 * Confirmation card. `text` is the owner-typed prompt (Edit closes the sheet
 * and the shell restores this exact string into the composer — nothing here
 * mutates it). Empty prompt → Run renders disabled (validateDraft).
 */
export function renderConfirm({
  text = '',
  mode = 'ask',
  preset = '',
  agent = '',
  model = '',
  project = '',
  skills = [],
  pinned = [],
  attachN = 0,
  busy = false,
  leaving = false,
} = {}) {
  const v = validateDraft({ text, mode, preset, skills });
  const runDisabled = v.disabled || busy ? ' disabled' : '';
  const presetNote =
    v.preset !== ''
      ? `<p class="h-caption">Preset ${escapeHtml(v.preset)} — runs as Code; the role prefix is applied server-side.</p>`
      : '';
  const html =
    `<div class="sheet-scrim" data-action="draft-edit">` +
    `<section class="glass-elevated sheet-card${leaving ? ' leaving' : ''}" role="dialog" aria-modal="true" aria-label="Confirm task" data-action="noop">` +
    `<div class="h-sub">New task</div>` +
    `<label class="h-caption" for="confirm-text">Prompt</label>` +
    `<textarea class="text-area mono" id="confirm-text" data-confirm-input rows="4" maxlength="8000" placeholder="What should the agent do?">${escapeHtml(text)}</textarea>` +
    `<div class="chip-row" aria-label="Presets">${presetChips(v.preset)}</div>` +
    presetNote +
    `<div class="chip-row" aria-label="Mode">${modeSeg(v.mode)}</div>` +
    `<div class="ctx-block" aria-label="Run context">` +
    contextRow('Agent', agent) +
    contextRow('Model', model) +
    contextRow('Project', project) +
    `</div>` +
    `<div class="ctx-block" aria-label="Skills"><span class="h-caption">Skills</span>` +
    `<div class="chip-row">${skillChips(pinned, skills)}</div></div>` +
    `<div class="h-caption">Attachments: <span class="metric">${Number(attachN) || 0}</span> (inbox attaches land from chat)</div>` +
    `<div class="sheet-actions">` +
    `<button class="btn" type="button" data-action="draft-edit"${busy ? ' disabled' : ''}>Edit</button>` +
    `<button class="btn btn-primary" type="button" data-action="draft-run"${runDisabled}>${busy ? 'Running…' : 'Run'}</button>` +
    `</div>` +
    `</section></div>`;
  return { html, float: '' };
}
