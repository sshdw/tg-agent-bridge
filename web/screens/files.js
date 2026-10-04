/**
 * W6 Files screen — PURE render (HTML strings, no DOM at module scope).
 * Importable from node >= 22 as ESM and from web/app.js.
 * Data shapes follow src/miniapp/api.ts filesList/filesPreview/
 * filesDiff/taskFiles/taskDiff. Links are built ONLY from entries[].rel
 * the API returned — there is no manual path input anywhere in this UI,
 * so dir=../../.. is unconstructible (AC4).
 *
 * Design: flat .list-row rows, sizes in .metric, code/diff/preview in
 * .mono with SOLID row backgrounds. Never any glass here (skill D6).
 * Diff +/- tint reuses the already-counted status-highlight selectors
 * (.status-hl, .btn-danger) — no new accent place is created.
 */

import { escapeHtml } from './home.js';
import { chunkRows, DIFF_CHUNK, parseUnifiedDiff } from '../lib/diff.js';

export { escapeHtml };

/** Client render window, mirrored from lib/diff.js for the views. */
export { DIFF_CHUNK };

/**
 * Byte-exact join of the API `abs` (OS-native absolute dir path) and a
 * workdir-relative `rel` (forward slashes). The abs-path bar displays
 * exactly this string and copy-path copies exactly this string (AC1+AC2).
 */
export function joinAbsRel(abs, rel) {
  const a = String(abs ?? '');
  const r = String(rel ?? '');
  if (r === '') return a;
  return `${a.replace(/[/\\]+$/, '')}/${r.replace(/^\/+/, '')}`;
}

/**
 * Copy path with injectable deps (no globals — harness stubs clipboard).
 * Returns the exact copied string so callers/tests can compare byte-exact.
 */
export async function copyPath(deps, abs, rel) {
  const text = joinAbsRel(abs, rel);
  const { clipboard, haptics } = deps ?? {};
  if (!clipboard || typeof clipboard.writeText !== 'function') throw new Error('E_NO_CLIPBOARD');
  await clipboard.writeText(text);
  try {
    haptics?.selectionChanged?.();
  } catch {
    /* haptics optional */
  }
  return text;
}

/**
 * Download with injectable Telegram handle (no globals).
 * downloadFile needs an HTTPS URL (server headers landed in W4);
 * openLink is the fallback. Returns which path was taken.
 */
export function downloadFile(deps, url, fileName) {
  const { tg } = deps ?? {};
  try {
    if (tg?.downloadFile) {
      tg.downloadFile({ url, file_name: fileName }, undefined);
      return 'downloadFile';
    }
  } catch {
    /* fall through to openLink */
  }
  try {
    if (tg?.openLink) {
      tg.openLink(url);
      return 'openLink';
    }
  } catch {
    /* no transport available */
  }
  return 'none';
}

/** File name for the download prompt: last segment of a workdir-rel path. */
export function fileNameOf(rel) {
  const r = String(rel ?? '').split('/').pop() ?? '';
  return r === '' ? 'download' : r;
}

/** Always-visible absolute path bar + copy button (AC1, AC2). */
function absBar(abs, rel) {
  const full = joinAbsRel(abs, rel);
  return (
    `<div class="abs-bar content-card">` +
    `<code class="mono abs-path" data-testid="abs-path">${escapeHtml(full)}</code>` +
    `<button class="btn btn-copy" type="button" data-action="copy-path" ` +
    `data-abs="${escapeHtml(String(abs ?? ''))}" data-rel="${escapeHtml(String(rel ?? ''))}">Copy</button>` +
    `</div>`
  );
}

function badge(kind, label) {
  return `<span class="h-caption file-badge" data-badge="${kind}">${escapeHtml(label)}</span>`;
}

function entryRow(e) {
  const rel = String(e.rel ?? '');
  const name = String(e.name ?? rel.split('/').pop() ?? rel);
  const isDir = e.isDir === true;
  const size = isDir ? '' : ` <span class="metric file-size">${Number(e.size) || 0}</span>`;
  const open = isDir
    ? `<button class="list-row file-row" type="button" data-action="files-open" data-rel="${escapeHtml(rel)}" data-isdir="1">` +
      `<span class="file-name">${escapeHtml(name)}/</span>${size}</button>`
    : `<div class="list-row file-row file-row-split">` +
      `<button class="file-name-btn" type="button" data-action="files-preview" data-rel="${escapeHtml(rel)}">` +
      `<span class="file-name">${escapeHtml(name)}</span>${size}</button>` +
      `<span class="file-ops">` +
      `<button class="btn btn-mini" type="button" data-action="files-diff" data-rel="${escapeHtml(rel)}">Diff</button>` +
      `<button class="btn btn-mini" type="button" data-action="files-download" data-rel="${escapeHtml(rel)}">Get</button>` +
      `</span></div>`;
  return open;
}

/**
 * Project explorer: abs bar always on top, entries below.
 * `dir` is the queried dir ('.' at root); `parent` is null at root.
 */
export function renderFilesExplorer({ abs = '', dir = '.', entries = [], parent = null } = {}) {
  const up =
    parent === null
      ? ''
      : `<button class="list-row file-row" type="button" data-action="files-up" data-rel="${escapeHtml(parent)}">` +
        `<span class="file-name">…</span></button>`;
  const list =
    !entries || entries.length === 0
      ? `<section class="empty-state" aria-label="Empty directory"><p class="h-caption">Empty directory.</p></section>`
      : entries.map(entryRow).join('');
  const html =
    `<section aria-label="Files">` +
    absBar(abs, '') +
    `<h2 class="h-caption section-header">Project explorer</h2>` +
    up +
    list +
    `</section>`;
  return { html, float: '' };
}

/** Single-file preview: 64 KB head + truncated badge, binary badge only. */
export function renderFilePreview({ path = '', abs = '', text = '', truncated = false, size = 0, binary = false } = {}) {
  let body;
  if (binary === true) {
    body = `<div class="preview-binary">${badge('binary', 'binary')}</div>`;
  } else {
    const head =
      `<pre class="mono preview-body">${escapeHtml(String(text ?? ''))}</pre>` +
      (truncated === true ? `<div class="preview-flags">${badge('truncated', 'truncated')}</div>` : '');
    body =
      `<div class="h-caption">size <span class="metric">${Number(size) || 0}</span></div>` + head;
  }
  const html =
    `<section aria-label="File preview">` +
    absBar(abs === '' ? String(path ?? '') : abs, abs === '' ? '' : '') +
    `<h2 class="h-caption section-header">${escapeHtml(String(path ?? ''))}</h2>` +
    body +
    `</section>`;
  return { html, float: '' };
}

/** Per-task changed files (Tasks → details → files). Rows open per-path diff. */
export function renderTaskFiles(
  { taskId = 0, files = [], changed_n = 0, total_added = 0, total_removed = 0, no_git = false } = {},
) {
  const id = Number(taskId) || 0;
  const summary =
    `<div class="h-caption">changed <span class="metric">${Number(changed_n) || 0}</span> ` +
    `<span class="status-hl">+${Number(total_added) || 0}</span> −${Number(total_removed) || 0}</div>`;
  let list;
  if (no_git === true) {
    list = `<section class="empty-state" aria-label="No git data"><p class="h-caption">No git data for this task.</p></section>`;
  } else if (!files || files.length === 0) {
    list = `<section class="empty-state" aria-label="No changed files"><p class="h-caption">No changed files.</p></section>`;
  } else {
    list = files
      .map((f) => {
        const p = String(f.path ?? '');
        const flags =
          (f.binary === true ? badge('binary', 'binary') : '') +
          (f.truncated === true ? badge('truncated', 'truncated') : '');
        return (
          `<button class="list-row file-row" type="button" data-action="task-diff" ` +
          `data-id="${id}" data-rel="${escapeHtml(p)}">` +
          `<span class="file-name">${escapeHtml(p)}</span>` +
          `<span class="h-caption"><span class="status-hl">+${Number(f.added) || 0}</span> ` +
          `−${Number(f.removed) || 0} ${flags}</span></button>`
        );
      })
      .join('');
  }
  const html =
    `<section aria-label="Task files">` +
    `<h2 class="h-caption section-header">Changed files</h2>` +
    summary +
    list +
    `</section>`;
  return { html, float: '' };
}

function diffRowClass(kind) {
  if (kind === 'add') return 'diff-row diff-add';
  if (kind === 'del') return 'diff-row diff-del';
  if (kind === 'hunk') return 'diff-row diff-hunk';
  return 'diff-row diff-ctx';
}

/**
 * THE single diff renderer (AC6: exactly one definition — per-task and
 * per-path diffs both come here). `added`/`removed` are the API counters;
 * rendered .diff-add/.diff-del row counts match them on a complete diff.
 * Client window: first `shown` rows + "show more" in DIFF_CHUNK steps.
 */
export function renderDiff(
  {
    path = '',
    abs = '',
    rel = '',
    diff = '',
    truncated = false,
    binary = false,
    no_git = false,
    added,
    removed,
    dropped = 0,
    shown = DIFF_CHUNK,
    action = 'diff-more',
  } = {},
) {
  const counts =
    `<div class="h-caption diff-counts"><span class="status-hl">+${Number(added) || 0}</span> ` +
    `−${Number(removed) || 0}</div>`;
  let body;
  if (binary === true) {
    body = `<div class="preview-binary">${badge('binary', 'binary')}</div>`;
  } else if (no_git === true || diff === '') {
    body = `<section class="empty-state" aria-label="No diff"><p class="h-caption">No diff available.</p></section>`;
  } else {
    const parsed = parseUnifiedDiff(String(diff ?? ''));
    const dropN = Number(dropped) || parsed.dropped || 0;
    const { visible, remaining } = chunkRows(parsed.rows, shown);
    const showAdded = added === undefined ? parsed.added : Number(added) || 0;
    const showRemoved = removed === undefined ? parsed.removed : Number(removed) || 0;
    const head =
      `<div class="h-caption diff-counts"><span class="status-hl">+${showAdded}</span> ` +
      `−${showRemoved}</div>`;
    const rows = visible
      .map((r) => {
        const mark =
          r.kind === 'add'
            ? `<span class="status-hl diff-sign">+</span>`
            : r.kind === 'del'
              ? `<span class="btn-danger diff-sign">−</span>`
              : `<span class="diff-sign"> </span>`;
        return `<div class="${diffRowClass(r.kind)}">${mark}<span>${escapeHtml(r.text)}</span></div>`;
      })
      .join('');
    const more =
      remaining > 0
        ? `<button class="btn" type="button" data-action="${escapeHtml(String(action))}">Show more (${remaining})</button>`
        : '';
    const trail =
      (truncated === true || dropN > 0) && remaining === 0
        ? `<div class="h-caption">…ещё ${dropN} строк</div>`
        : '';
    body =
      head +
      `<div class="mono diff-view" role="log" aria-label="Unified diff">${rows}</div>${more}${trail}`;
  }
  const html =
    `<section aria-label="Diff">` +
    absBar(abs === '' ? String(path ?? '') : abs, abs === '' ? '' : String(rel ?? '')) +
    `<h2 class="h-caption section-header">${escapeHtml(String(path ?? ''))}</h2>` +
    counts +
    body +
    `</section>`;
  return { html, float: '' };
}
