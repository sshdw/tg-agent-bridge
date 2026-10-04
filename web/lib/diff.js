/**
 * W6 diff parser — PURE module, no DOM, no Telegram API.
 * Importable from node >= 22 as ESM and from web/screens/files.js.
 * Turns a unified-diff text (server caps at 200 lines, W3 DIFF_MAX_LINES)
 * into row structs the single renderDiff() consumes.
 */

/** Client render window: first N rows, then "show more" in chunks of N. */
export const DIFF_CHUNK = 200;

/** `…ещё N строк` trailer the server appends to capped diffs. */
const TRAILER_RE = /…ещё\s+(\d+)\s+строк/;

/**
 * Parse unified diff text into rows.
 * Row kinds: 'meta' (headers, hunk ranges are 'hunk'), 'ctx', 'add', 'del'.
 * Returns { rows, added, removed, dropped } where dropped is the trailer
 * count (0 when the diff is complete).
 */
export function parseUnifiedDiff(text) {
  const rows = [];
  let added = 0;
  let removed = 0;
  let dropped = 0;
  if (typeof text !== 'string' || text === '') return { rows, added, removed, dropped };
  for (const line of text.split('\n')) {
    const m = TRAILER_RE.exec(line);
    if (m) {
      dropped = Number(m[1]) || 0;
      continue;
    }
    if (line.startsWith('@@')) {
      rows.push({ kind: 'hunk', text: line });
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      added += 1;
      rows.push({ kind: 'add', text: line });
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      removed += 1;
      rows.push({ kind: 'del', text: line });
    } else if (line.startsWith('--- ') || line.startsWith('+++ ') || line.startsWith('diff ') || line.startsWith('index ')) {
      rows.push({ kind: 'meta', text: line });
    } else {
      rows.push({ kind: 'ctx', text: line });
    }
  }
  return { rows, added, removed, dropped };
}

/**
 * Slice rows into the current client window.
 * Returns { visible, remaining }: remaining > 0 means the view must offer
 * a "show more" button for the next DIFF_CHUNK rows.
 */
export function chunkRows(rows, shown = DIFF_CHUNK) {
  const list = Array.isArray(rows) ? rows : [];
  const n = Number(shown) || 0;
  const visible = list.slice(0, Math.max(0, n));
  return { visible, remaining: Math.max(0, list.length - visible.length) };
}
