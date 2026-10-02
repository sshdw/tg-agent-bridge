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

/**
 * Force the tag stream to be properly nested and balanced.
 *
 * The emphasis passes above are deliberately simple, and on pathological input
 * (`*** ** *`) they can emit crossed tags — `<b><i>x</b></i>`. Telegram rejects that
 * with "can't parse entities", which the send path used to answer by silently
 * re-sending the raw markdown: the owner's literal `**bold**`. Repairing the nesting
 * here keeps the guarantee the module documents: the output is always valid.
 *
 * Only tags this module writes can appear (input `<` is escaped to `&lt;` first), so
 * the walk cannot be fooled into treating user text as markup.
 */
function balanceTags(html: string): string {
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s[^<>]*?)?)>/g;
  const stack: string[] = [];
  const out: string[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html)) !== null) {
    out.push(html.slice(last, m.index));
    last = m.index + m[0].length;
    const tag = (m[2] ?? '').toLowerCase();
    if (m[1] === '/') {
      const depth = stack.lastIndexOf(tag);
      if (depth === -1) continue; // stray closer: drop it, the stack stays valid
      // Close everything opened inside `tag` first, then `tag` itself.
      for (let i = stack.length - 1; i >= depth; i -= 1) out.push(`</${stack[i] ?? ''}>`);
      stack.length = depth;
      continue;
    }
    stack.push(tag);
    out.push(m[0]);
  }
  out.push(html.slice(last));
  for (let i = stack.length - 1; i >= 0; i -= 1) out.push(`</${stack[i] ?? ''}>`);
  return out.join('');
}

/** Convert markdown to valid, balanced Telegram HTML. */
export function markdownToHtml(md: string): string {
  if (md === '') return '';
  const escaped = escapeText(md);
  const html = splitFences(escaped)
    .map((b) => b.html)
    .join('\n');
  return balanceTags(html);
}

/**
 * Render markdown, tolerating a converter failure.
 *
 * The converter is total (it never throws on input), but a defensive escape keeps
 * a future change from taking down a reply: an escaped string is always valid
 * Telegram HTML and always renders as the literal text it came from.
 */
export function renderHtml(md: string): string {
  try {
    return markdownToHtml(md);
  } catch {
    return escapeHtml(md);
  }
}

/** Telegram's hard limit on `message_text`, in characters. */
export const TELEGRAM_TEXT_LIMIT = 4096;

/**
 * Rendered-HTML budget per message: the Telegram limit minus a margin.
 *
 * The budget applies to the RENDERED string, never to the markdown source: escaping
 * expands text (`&` -> `&amp;`, 1 char -> 5) and every tag adds bytes, so a source
 * budget of 4000 routinely renders past 4096 and Telegram rejects the message. The
 * margin also absorbs CRLF/Unicode surprises in Telegram's own length check.
 */
export const RENDER_BUDGET = TELEGRAM_TEXT_LIMIT - 296;

/** Smallest budget the halving fallback in the send path will ever use. */
export const MIN_RENDER_BUDGET = 700;

/** One indivisible piece of markdown plus the length of its rendered HTML. */
interface Unit {
  /** Markdown source. */
  md: string;
  /** `renderHtml(md).length` — the real cost of this unit on the wire. */
  rendered: number;
}

function unit(md: string): Unit {
  return { md, rendered: renderHtml(md).length };
}

interface FenceState {
  char: string;
  len: number;
  lang: string;
}

function isFenceCloseLine(line: string, fence: FenceState): boolean {
  return new RegExp(`^[ \\t]{0,3}\\${fence.char}{${fence.len},}[ \\t]*$`).test(line);
}

/**
 * Cost of one slice on the wire. Text is measured after rendering (markup may add
 * bytes); fence content is measured after escaping only (it is emitted verbatim
 * inside `<pre><code>`), which is why the fence path passes its own function.
 */
type CostFn = (slice: string) => number;

const renderedCost: CostFn = (slice) => renderHtml(slice).length;
const escapedCost: CostFn = (slice) => escapeHtml(slice).length;

/**
 * Cut one markdown source into pieces that each cost at most `budget`.
 *
 * Binary search on the slice length, so a pathological single line (a 200 KB minified
 * bundle, a base64 blob) splits in O(log n) cost evaluations per piece instead of one
 * per character.
 */
function sliceToBudget(md: string, budget: number, cost: CostFn = renderedCost): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < md.length) {
    let lo = i + 1;
    let hi = md.length;
    let best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cost(md.slice(i, mid)) <= budget) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    // A budget below the cost of one character cannot be honoured (only reachable with
    // a hand-made tiny budget): emit the character so progress is still guaranteed.
    const end = best === -1 ? Math.min(i + 1, md.length) : best;
    out.push(md.slice(i, end));
    i = end;
  }
  return out;
}

/**
 * One fenced block, split into as many independently valid fenced blocks as the
 * budget needs. Every piece opens and closes the fence itself, so no piece ends
 * mid-block and no tag ever spans two pieces.
 *
 * Cost model is exact: a piece renders as `<pre><code …>` + escaped content joined by
 * newlines + `</code></pre>`, and the content is emitted verbatim.
 */
function fenceUnits(openLine: string, body: string[], fence: FenceState, budget: number): Unit[] {
  const closeLine = fence.char.repeat(fence.len);
  const asPiece = (content: string[]): Unit => unit([openLine, ...content, closeLine].join('\n'));
  const whole = asPiece(body);
  if (whole.rendered <= budget) return [whole];

  // Rendered cost of an empty block with this fence marker and language hint.
  const overhead = unit([openLine, '', closeLine].join('\n')).rendered;
  const out: Unit[] = [];
  let group: string[] = [];
  let cost = overhead;

  const flushGroup = (): void => {
    if (group.length === 0) return;
    out.push(asPiece(group));
    group = [];
    cost = overhead;
  };

  for (const line of body) {
    const lineCost = escapedCost(line) + 1;
    if (overhead + lineCost > budget) {
      // This single line cannot fit inside a fence of its own: slice the raw line and
      // give every slice its own complete fence.
      flushGroup();
      for (const piece of sliceToBudget(line, budget - overhead - 1, escapedCost)) {
        out.push(asPiece([piece]));
      }
      continue;
    }
    if (cost + lineCost > budget) flushGroup();
    group.push(line);
    cost += lineCost;
  }
  flushGroup();
  return out;
}

/**
 * Split markdown into fence-aware units: one unit per text line, one unit per
 * (possibly re-opened) fenced block.
 *
 * Text units never contain a fence marker — the fence state machine below consumes
 * them — so a text unit renders independently of its neighbours and emphasis can
 * never pair across a chunk boundary.
 */
function toUnits(md: string, budget: number): Unit[] {
  const lines = md.split('\n');
  const units: Unit[] = [];
  let fence: FenceState | null = null;
  let openLine = '';
  let body: string[] = [];

  const flushFence = (): void => {
    if (fence === null) return;
    units.push(...fenceUnits(openLine, body, fence, budget));
    fence = null;
    body = [];
    openLine = '';
  };

  for (const line of lines) {
    if (fence === null) {
      const m: RegExpExecArray | null = FENCE_RE.exec(line);
      if (m !== null) {
        const marker: string = m[2] ?? '```';
        fence = { char: marker[0] ?? '`', len: marker.length, lang: m[3] ?? '' };
        openLine = line;
        body = [];
        continue;
      }
      const u = unit(line);
      if (u.rendered <= budget) units.push(u);
      else for (const piece of sliceToBudget(line, budget)) units.push(unit(piece));
      continue;
    }
    if (isFenceCloseLine(line, fence)) {
      flushFence();
      continue;
    }
    body.push(line);
  }
  // An unclosed fence at EOF still becomes a complete fenced unit: the owner sees the
  // code, and the closing marker the converter omits is added back here.
  flushFence();
  return units;
}

/**
 * Render markdown to a list of Telegram messages.
 *
 * The length budget applies to the RENDERED HTML, which is what Telegram counts.
 * Guarantees, for every returned element:
 *   - `renderHtml(el) === el` and `el.length <= budget`;
 *   - the element is independently valid Telegram HTML with balanced tags — no tag
 *     ever spans two elements, because every element is rendered on its own;
 *   - every fenced block inside it is closed, because fences are cut as whole blocks
 *     and a cut block is re-opened with the same marker and language hint.
 *
 * The join is the exact inverse of rendering one element at a time, which is why the
 * per-element output can be measured before anything is sent.
 */
export function renderHtmlChunks(md: string, budget: number = RENDER_BUDGET): string[] {
  if (md === '') return [];
  const units = toUnits(md, budget);
  const out: string[] = [];
  let pending: Unit[] = [];
  let est = 0;

  const flush = (): void => {
    if (pending.length === 0) return;
    const md = pending.map((u) => u.md).join('\n');
    let html = renderHtml(md);
    // The estimate sums per-unit renders, which can undercount when markup would have
    // paired across lines. Re-render exactly and drop trailing units until it fits.
    while (html.length > budget && pending.length > 1) {
      pending.pop();
      html = renderHtml(pending.map((u) => u.md).join('\n'));
    }
    if (html.length > budget) {
      // Single unit still over budget (only possible with a hand-made tiny budget):
      // slice it so the length contract holds unconditionally.
      for (const piece of sliceToBudget(md, budget)) out.push(renderHtml(piece));
    } else {
      out.push(html);
    }
    pending = [];
    est = 0;
  };

  for (const u of units) {
    if (pending.length > 0 && est + u.rendered + 1 > budget) flush();
    pending.push(u);
    est += u.rendered + 1;
  }
  flush();
  return out;
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
