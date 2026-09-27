/**
 * Markdown -> Telegram HTML converter.
 *
 * Hand-rolled on purpose (no dependency): the surface is small and the safety
 * property matters more than fidelity — user-supplied text must NEVER become markup.
 *
 * Strategy: escape `&`, `<`, `>` on the WHOLE input first (same semantics as
 * `escapeHtml`), then apply markup on the escaped text. Because the escape step runs
 * before any tag is emitted, the only `<` characters in the output are the ones this
 * converter writes; nothing from the input can open a tag.
 *
 * Supported: fenced code (``` and ~~~), inline code, bold (`**`, `__`), italic (`*`,
 * `_`), strikethrough (`~~`), links `[text](http(s)://…)`, bullet lists, numbered
 * lists, and `#`-headings degraded to bold (Telegram has no headings).
 *
 * Telegram HTML allows `<b> <i> <u> <s> <code> <pre> <a href=""> <blockquote>`.
 * Inside `<pre>`/`<code>` nothing may be nested, so code content is emitted verbatim
 * (already escaped) and never re-parsed for markup. The output always has balanced
 * tags: this function never leaves a tag open across the end of the string.
 *
 * `*` and `_` inside a code span are literal, per every markdown dialect worth using.
 */

/** Characters escaped for Telegram HTML. `escapeHtml` semantics, shared with stream.ts. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeText(s: string): string {
  return escapeHtml(s);
}

/** A link target is only honoured when it is a plain http(s) URL. */
function safeHref(url: string): string | null {
  // The url is already HTML-escaped; quotes cannot survive escaping as raw quotes,
  // but reject anything that is not clearly http(s) anyway.
  const t = url.trim();
  if (!/^https?:\/\//i.test(t)) return null;
  if (/[\s<>"']/.test(t)) return null;
  return t;
}

interface Block {
  html: string;
}

/** Fence opener: 3+ backticks or tildes, optional info string (language hint). */
const FENCE_RE = /^([ \t]{0,3})(`{3,}|~{3,})[ \t]*([^\s`~]*)/;

/** Split into fenced-code and non-code blocks so inline markup never touches code. */
function splitFences(escaped: string): Block[] {
  const lines = escaped.split('\n');
  const blocks: Block[] = [];
  let buf: string[] = [];
  let fence: { char: string; len: number; lang: string } | null = null;

  const flushText = (): void => {
    if (buf.length === 0) return;
    blocks.push({ html: inlineBlocks(buf.join('\n')) });
    buf = [];
  };

  for (const line of lines) {
    const m: RegExpExecArray | null = fence === null ? FENCE_RE.exec(line) : null;
    if (fence === null && m !== null) {
      flushText();
      const marker: string = m[2] ?? '```';
      fence = { char: marker[0] ?? '`', len: marker.length, lang: m[3] ?? '' };
      continue;
    }
    if (fence === null) {
      buf.push(line);
      continue;
    }
    // Inside a fence: a closing marker is the same char, at least the same length,
    // and nothing but whitespace after it.
    const closeRe = new RegExp(`^[ \\t]{0,3}\\${fence.char}{${fence.len},}[ \\t]*$`);
    if (closeRe.test(line)) {
      const langAttr = fence.lang === '' ? '' : ` class="language-${fence.lang}"`;
      blocks.push({ html: `<pre><code${langAttr}>${buf.join('\n')}</code></pre>` });
      buf = [];
      fence = null;
      continue;
    }
    buf.push(line);
  }

  if (fence !== null) {
    // Unclosed fence at EOF: still emit it as code so the text is not lost.
    const langAttr = fence.lang === '' ? '' : ` class="language-${fence.lang}"`;
    blocks.push({ html: `<pre><code${langAttr}>${buf.join('\n')}</code></pre>` });
    buf = [];
  }
  flushText();
  return blocks;
}

/** Bullet / numbered list and heading handling, one line at a time. */
function inlineBlocks(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  for (const line of lines) {
    // Heading: 1-6 `#` followed by a space -> bold (Telegram has no <hN>).
    const h = /^[ \t]{0,3}(#{1,6})[ \t]+(.+)$/.exec(line);
    if (h !== null) {
      out.push(`<b>${inline(h[2] ?? '')}</b>`);
      continue;
    }
    // Bullet: `- `, `* `, `+ ` at the start of the line.
    const b = /^([ \t]*)[-*+][ \t]+(.+)$/.exec(line);
    if (b !== null) {
      out.push(`${b[1] ?? ''}• ${inline(b[2] ?? '')}`);
      continue;
    }
    // Numbered list: keep the number, keep it readable.
    const n = /^([ \t]*)(\d+)[.)][ \t]+(.+)$/.exec(line);
    if (n !== null) {
      out.push(`${n[1] ?? ''}${n[2] ?? ''}. ${inline(n[3] ?? '')}`);
      continue;
    }
    out.push(inline(line));
  }
  return out.join('\n');
}

/** Inline markup within a single non-code line / accumulated text. */
function inline(text: string): string {
  // Code spans are handled first and take precedence over every other rule.
  const parts = splitCodeSpans(text);
  return parts.map((p) => (p.code === undefined ? inlineEmphasis(p.text ?? '') : `<code>${p.code}</code>`)).join('');
}

interface Span {
  code?: string;
  text?: string;
}

function splitCodeSpans(text: string): Span[] {
  const spans: Span[] = [];
  let i = 0;
  let plain = '';
  while (i < text.length) {
    const ch = text[i];
    if (ch !== '`') {
      plain += ch;
      i += 1;
      continue;
    }
    let runLen = 0;
    while (text[i + runLen] === '`') runLen += 1;
    const marker = '`'.repeat(runLen);
    const close = text.indexOf(marker, i + runLen);
    if (close === -1) {
      plain += marker;
      i += runLen;
      continue;
    }
    if (plain !== '') {
      spans.push({ text: plain });
      plain = '';
    }
    spans.push({ code: text.slice(i + runLen, close).trim() });
    i = close + runLen;
  }
  if (plain !== '') spans.push({ text: plain });
  return spans;
}

const LINK_RE = /\[([^\]]*)\]\(([^()\s]+)\)/g;

/** Emphasis for plain (non-code) text. Order: links, then code-free token pairs. */
function inlineEmphasis(text: string): string {
  let out = '';
  let last = 0;
  LINK_RE.lastIndex = 0;
  for (let m = LINK_RE.exec(text); m !== null; m = LINK_RE.exec(text)) {
    out += emphasisWithoutLinks(text.slice(last, m.index));
    const label = m[1] ?? '';
    const href = safeHref(m[2] ?? '');
    out += href === null ? emphasisWithoutLinks(m[0]) : `<a href="${href}">${emphasisWithoutLinks(label)}</a>`;
    last = m.index + m[0].length;
  }
  out += emphasisWithoutLinks(text.slice(last));
  return out;
}

/**
 * Bold, italic and strikethrough on plain text that contains no code or links.
 * Input is already HTML-escaped by the top-level converter, so no re-escaping here —
 * escaping twice would turn `&lt;` into `&amp;lt;`.
 */
function emphasisWithoutLinks(text: string): string {
  let out = text;
  // Strikethrough before single-char italics so `~~` is not eaten by `~`.
  out = pair(out, '~~', 's');
  out = pair(out, '**', 'b');
  out = pair(out, '__', 'b');
  out = single(out, '*', 'i');
  out = single(out, '_', 'i');
  return out;
}

/**
 * Replace paired `marker … marker` runs with `<tag>…</tag>`. Unpaired markers stay
 * literal, which is what keeps the output balanced.
 */
function pair(text: string, marker: string, tag: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const start = text.indexOf(marker, i);
    if (start === -1) {
      out += text.slice(i);
      break;
    }
    const end = text.indexOf(marker, start + marker.length);
    if (end === -1) {
      out += text.slice(i);
      break;
    }
    const inner = text.slice(start + marker.length, end);
    if (inner === '' || inner.includes(marker)) {
      // Empty or nested markers: leave the first marker literal and keep scanning.
      out += text.slice(i, start + marker.length);
      i = start + marker.length;
      continue;
    }
    out += text.slice(i, start) + `<${tag}>${inner}</${tag}>`;
    i = end + marker.length;
  }
  return out;
}

/** Replace single-char `*`/`_` emphasis, ignoring word-internal underscores. */
function single(text: string, marker: string, tag: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const start = text.indexOf(marker, i);
    if (start === -1) {
      out += text.slice(i);
      break;
    }
    // An underscore inside a word (snake_case) is not emphasis.
    if (marker === '_' && start > 0 && /[A-Za-z0-9]/.test(text[start - 1] ?? '')) {
      out += text.slice(i, start + 1);
      i = start + 1;
      continue;
    }
    const end = text.indexOf(marker, start + marker.length);
    if (end === -1) {
      out += text.slice(i);
      break;
    }
    const inner = text.slice(start + marker.length, end);
    if (inner === '' || inner.includes('\n') || inner.includes(marker)) {
      out += text.slice(i, start + 1);
      i = start + 1;
      continue;
    }
    out += text.slice(i, start) + `<${tag}>${inner}</${tag}>`;
    i = end + marker.length;
  }
  return out;
}

/** Convert markdown to valid, balanced Telegram HTML. */
export function markdownToHtml(md: string): string {
  if (md === '') return '';
  const escaped = escapeText(md);
  return splitFences(escaped)
    .map((b) => b.html)
    .join('\n');
}

/**
 * Count fence markers in a rendered/split text: used by the fence-safety checks and
 * by `splitMessage`. Returns true when every ``` / ~~~ fence is closed.
 */
export function fencesBalanced(text: string): boolean {
  let open = false;
  let last = '';
  for (const line of text.split('\n')) {
    const m = FENCE_RE.exec(line);
    if (m === null) continue;
    const marker = m[2] ?? '';
    if (!open) {
      open = true;
      last = marker[0] ?? '`';
      continue;
    }
    const closeRe = new RegExp(`^[ \\t]{0,3}\\${last}{${marker.length},}[ \\t]*$`);
    if (last === marker[0] && closeRe.test(line)) open = false;
  }
  return !open;
}
