/**
 * Offline verification harness for v0.3 — no network, no bot, no Telegram token.
 *
 * Runs against the COMPILED output (dist/), so it verifies what actually ships.
 * Each group maps to a defect from docs/PROMPT-ENGINEER-V03.md:
 *
 *   A rendered-length budgeting   (1b: raw-length split -> 4096-char rejection)
 *   B per-chunk HTML validity     (1b/1e: balanced tags, no fence cut in half)
 *   C [[attach:…]] protocol       (2b: marker + containment guard)
 *   D photo-vs-document routing   (2a/2c: caps, /files listing)
 *   E send/stream behaviour       (1a/1c/1d: parse_mode, no silent downgrade, no floods)
 *
 * Usage: node work/verify-render.mjs
 */

import { mkdtempSync, mkdirSync, writeFileSync, openSync, ftruncateSync, closeSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  fencesBalanced,
  markdownToHtml,
  renderHtml,
  renderHtmlChunks,
  RENDER_BUDGET,
  TELEGRAM_TEXT_LIMIT,
} from '../dist/telegram/markdown.js';
import {
  AttachCensor,
  extractAttachMarkers,
  listDir,
  planAttachments,
  resolveOutboundDir,
  resolveOutboundFile,
  MAX_OUTBOUND_BYTES,
  MAX_PHOTO_BYTES,
} from '../dist/core/files.js';
import { sendOutboundFile } from '../dist/telegram/outbound.js';
import { createStream, sendMarkdown } from '../dist/telegram/stream.js';
import { FailureLog } from '../dist/telegram/send.js';

let passed = 0;
const failures = [];
let group = '';

const g = (name) => {
  group = name;
  process.stdout.write(`\n${name}\n`);
};

function ok(label) {
  passed += 1;
  process.stdout.write(`  ok   ${label}\n`);
}

function assert(cond, label) {
  if (cond) ok(label);
  else {
    failures.push(`${group} :: ${label}`);
    process.stdout.write(`  FAIL ${label}\n`);
  }
}

function eq(actual, expected, label) {
  assert(actual === expected, `${label} (got ${JSON.stringify(actual)})`);
}

/* ------------------------------------------------------------------ helpers */

/** Telegram HTML subset this converter is allowed to emit. */
const ALLOWED_TAGS = new Set(['b', 'i', 'u', 's', 'code', 'pre', 'a', 'blockquote']);

/**
 * Validate one chunk as standalone Telegram HTML: only known tags, correctly nested,
 * no tag left open, and no raw `<`/`>` in text (everything user-supplied must be
 * escaped). Balance per chunk IS the "no tag spans chunks" property.
 */
function validateChunk(html, label) {
  const stack = [];
  let tags = 0;
  let badTag = '';
  let rawAngle = false;
  let badHref = '';
  let badNest = '';
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s[^<>]*?)?)(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (m[5] !== undefined) {
      if (m[5].includes('>')) rawAngle = true;
      continue;
    }
    tags += 1;
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    const selfClose = m[4] === '/';
    if (!ALLOWED_TAGS.has(tag)) badTag = badTag === '' ? tag : badTag;
    if (!closing && !selfClose) {
      stack.push(tag);
    } else if (closing) {
      const top = stack.pop();
      if (top !== tag && badNest === '') badNest = `${tag} closed by <${top ?? 'nothing'}>`;
    }
    if (!closing && tag === 'a') {
      const href = /href="([^"]*)"/.exec(m[3] ?? '')?.[1] ?? '';
      if (!/^https?:\/\//i.test(href)) badHref = href;
    }
  }
  assert(badTag === '', `${label}: only Telegram-safe tags used${badTag === '' ? '' : ` (saw <${badTag}>)`}`);
  assert(!rawAngle, `${label}: text is escaped — no raw ">" in text`);
  assert(badNest === '', `${label}: tags nest correctly${badNest === '' ? '' : ` (${badNest})`}`);
  assert(stack.length === 0, `${label}: every tag closed${stack.length === 0 ? '' : ` (open: ${stack.join(',')})`}`);
  assert(badHref === '', `${label}: every link href is http(s)${badHref === '' ? '' : ` (saw ${badHref})`}`);
  const rawAngles = (html.match(/</g) ?? []).length;
  assert(rawAngles === tags, `${label}: no unescaped "<" in input (${rawAngles} "<", ${tags} tags)`);
  // Every `&` in the output must start a known entity: input ampersands were escaped.
  const rawAmp = html.replace(/&(?:lt|gt|amp|quot|#39);/g, '').includes('&');
  assert(!rawAmp, `${label}: every "&" is an escaped entity`);
}

/** Every chunk of `md` must satisfy the length, validity and fence contracts. */
function checkChunks(md, label, budget = RENDER_BUDGET) {
  const chunks = renderHtmlChunks(md, budget);
  assert(chunks.length > 0, `${label}: split into at least one chunk`);
  for (const [i, c] of chunks.entries()) {
    assert(c.length <= budget, `${label}[${i}]: rendered length within budget (${c.length} <= ${budget})`);
    assert(c.length <= TELEGRAM_TEXT_LIMIT, `${label}[${i}]: within the Telegram limit (${c.length})`);
    validateChunk(c, `${label}[${i}]`);
    assert(fencesBalanced(c), `${label}[${i}]: fence closed inside the chunk`);
  }
  return chunks;
}

/**
 * Fake grammy Api. Records every call and lets a test decide what each call does, so a
 * rejection path can be exercised without a network or a token.
 */
function fakeApi(behaviour = {}) {
  const calls = [];
  const api = {
    calls,
    sendMessage: async (chatId, text, other) => {
      const call = { kind: 'sendMessage', chatId, text, other };
      calls.push(call);
      const verdict = behaviour.onSend?.(call, calls.length);
      if (verdict instanceof Error) throw verdict;
      return { message_id: 1 };
    },
    editMessageText: async (chatId, messageId, text, other) => {
      const call = { kind: 'editMessageText', chatId, messageId, text, other };
      calls.push(call);
      const verdict = behaviour.onEdit?.(call, calls.length);
      if (verdict instanceof Error) throw verdict;
      return { message_id: messageId };
    },
    sendPhoto: async (chatId, file, other) => {
      calls.push({ kind: 'sendPhoto', chatId, other });
      const verdict = behaviour.onSendPhoto?.(calls.at(-1), calls.length);
      if (verdict instanceof Error) throw verdict;
      return { message_id: 1 };
    },
    sendDocument: async (chatId, file, other) => {
      calls.push({ kind: 'sendDocument', chatId, other });
      const verdict = behaviour.onSendDocument?.(calls.at(-1), calls.length);
      if (verdict instanceof Error) throw verdict;
      return { message_id: 1 };
    },
    getFile: async () => ({ file_path: undefined }),
  };
  api.sends = () => calls.filter((c) => c.kind === 'sendMessage');
  api.edits = () => calls.filter((c) => c.kind === 'editMessageText');
  return api;
}

/** Sparse file of `bytes` bytes: instant, and exactly the size the caps care about. */
function sparseFile(path, bytes) {
  const fd = openSync(path, 'w');
  ftruncateSync(fd, bytes);
  closeSync(fd);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------- A: rendered-length budgeting */

g('A. rendered-length budgeting (defect 1b)');
{
  // The owner's exact failure mode: a 4000-char source chunk whose escaping alone
  // blows past Telegram's 4096-char limit. `&&` -> 10 chars, `<div>` -> 12.
  const nastyLine = Array.from({ length: 400 }, () => 'if (a && b <div>{x}</div>) {').join('\n');
  const fenceBody = Array.from({ length: 120 }, (_, i) => `line ${i}: a && b <div data-x="${i}"> && c;`).join('\n');
  const doc = [
    '# Report',
    'Intro with **bold**, `code` and a [link](https://example.com/a?b=1&c=2).',
    '',
    '```bash',
    fenceBody,
    '```',
    '',
    nastyLine,
    '',
    '~~~html',
    fenceBody,
    '~~~',
  ].join('\n');

  const chunks = checkChunks(doc, 'adversarial');
  assert(chunks.length > 1, `adversarial: expected the doc to need several messages, got ${chunks.length}`);

  const source = doc.length;
  const rendered = chunks.join('').length;
  assert(rendered > source, `fixture must actually expand: source ${source} -> rendered ${rendered}`);
  assert(rendered > TELEGRAM_TEXT_LIMIT, `fixture must exceed the limit unchunked (${rendered} > ${TELEGRAM_TEXT_LIMIT})`);
  assert(
    chunks.every((c) => c.length <= RENDER_BUDGET),
    `every chunk within the rendered budget ${RENDER_BUDGET}`,
  );

  // A wall of `&&` and `<div>` with no newline at all (the pathological single line).
  const oneLine = 'x&&y<div>'.repeat(5000);
  const lineChunks = checkChunks(oneLine, 'one-line');
  assert(lineChunks.length > 1, 'one-line: needed several messages');

  // The literal case from the brief: a 4000-char source chunk whose escaping expands it
  // past Telegram's limit. Rendered length must still fit.
  const fourK = ('if (a && b) { <div class="x">c && d</div> }\n```sh\nls && echo <ok>\n```\n').repeat(
    Math.ceil(4000 / 70),
  ).slice(0, 4000);
  eq(fourK.length, 4000, 'fixture is exactly 4000 source characters');
  const fourKChunks = checkChunks(fourK, 'four-k');
  assert(
    fourKChunks.every((c) => c.length <= TELEGRAM_TEXT_LIMIT),
    'a 4000-char source chunk still yields chunks within 4096 rendered',
  );
  assert(
    renderHtml(fourK).length > TELEGRAM_TEXT_LIMIT,
    `the 4000-char fixture does exceed the limit unchunked (${renderHtml(fourK).length})`,
  );

  // Realistic long answer: headings, lists, tables of text, many fences.
  const prose = [];
  for (let i = 0; i < 60; i += 1) {
    prose.push(`## Step ${i}`);
    prose.push(`- point **${i}** with \`code${i}\` and <angle> & ampersand`);
    prose.push('1. first');
    prose.push('```ts');
    prose.push(`const a${i} = ${i} && other <T>${i}</T>;`);
    prose.push('```');
  }
  checkChunks(prose.join('\n'), 'long-answer');

  // Non-ASCII must be counted the same way Telegram counts it.
  checkChunks('Привет, мир! '.repeat(2000), 'cyrillic');

  // Tiny budgets still honour the contract (the halving fallback reaches these).
  const tiny = checkChunks(doc, 'tiny-budget', 900);
  assert(tiny.every((c) => c.length <= 900), 'tiny-budget: every chunk within 900');
}

/* -------------------------------------------------- B: per-chunk HTML validity */

g('B. per-chunk Telegram HTML validity (defects 1b, 1e)');
{
  const corpora = {
    'unclosed-fence': '```js\nconst a = 1;\nconst b = 2;',
    'nested-emphasis': '**bold *italic* bold** and __under__ and ~~strike~~',
    'unpaired-markers': '**never closed and *also not',
    'raw-angle': 'if (a < b && c > d) { <script>alert(1)</script> }',
    'entities': 'a & b &amp; c &#39;d&#39; &lt;tag&gt;',
    'inline-code-with-tags': 'use `<div>` and `<b>` literally',
    'bad-links': '[x](javascript:alert(1)) and [y](/relative) and [z](https://ok.example/p)',
    'headings-lists': '# H1\n## H2\n- a\n* b\n+ c\n1. one\n2) two',
    'tilde-fence': '~~~python\nprint("hi")\n~~~',
    'long-fence-unclosed': `\`\`\`js\n${'const x = 1 && 2 < 3;\n'.repeat(400)}`,
    'markers-only': '*** ** * ~~ ~ ` [ ] ( ) < > &',
    'empty-ish': '\n\n\n',
  };
  for (const [name, md] of Object.entries(corpora)) {
    const chunks = renderHtmlChunks(md);
    for (const [i, c] of chunks.entries()) validateChunk(c, `${name}[${i}]`);
    assert(chunks.every(fencesBalanced), `${name}: no chunk has an unclosed fence`);
  }

  // Fence content survives the cut, and each piece re-opens a complete fence.
  const big = `\`\`\`js\n${Array.from({ length: 400 }, (_, i) => `const v${i} = ${i} && next;`).join('\n')}\n\`\`\``;
  const chunks = renderHtmlChunks(big);
  assert(chunks.length > 1, 'big-fence: needed several messages');
  for (const [i, c] of chunks.entries()) {
    assert(c.startsWith('<pre><code class="language-js">'), `big-fence[${i}]: opens its own fenced block`);
    assert(c.endsWith('</code></pre>'), `big-fence[${i}]: closes its own fenced block`);
  }
  const rejoined = chunks
    .map((c) => c.replace(/^<pre><code[^>]*>/, '').replace(/<\/code><\/pre>$/, ''))
    .join('\n');
  assert(rejoined.includes('const v399 = 399 &amp;&amp; next;'), 'big-fence: last code line survived the split');
  assert(!rejoined.includes('```'), 'big-fence: no raw fence markers leaked into the rendered text');

  // A live, half-written answer must never emit an unbalanced tag.
  const partial = ['**bo', '```js', 'const a = 1;', '<div', '`co'].join('\n');
  for (const c of renderHtmlChunks(partial)) validateChunk(c, 'partial-stream');
}

/* ------------------------------------------------------ C: [[attach:…]] marker */

g('C. [[attach:…]] protocol and containment (defect 2b)');
{
  const root = mkdtempSync(join(tmpdir(), 'v03-attach-'));
  const work = join(root, 'work');
  mkdirSync(join(work, 'out'), { recursive: true });
  writeFileSync(join(work, 'report.md'), '# report\n');
  writeFileSync(join(work, 'out', 'shot.png'), 'png-bytes');
  writeFileSync(join(root, 'secret.txt'), 'outside');

  const inline = extractAttachMarkers('Готово [[attach:out/shot.png]] — смотри.');
  assert(!inline.text.includes('[[attach'), 'inline marker stripped from visible text');
  assert(inline.text.includes('Готово') && inline.text.includes('смотри'), 'inline marker keeps prose');
  assert(!/\s{2,}/.test(inline.text), 'inline marker does not leave a double space');
  eq(inline.paths.join(','), 'out/shot.png', 'inline marker path collected');

  const ownLine = extractAttachMarkers('Сделано.\n[[attach:report.md]]\nВсё.');
  eq(ownLine.text, 'Сделано.\nВсё.', 'marker-only line removed with its line');
  eq(ownLine.paths.join(','), 'report.md', 'marker-only line path collected');

  // In-workdir marker resolves to a real file.
  const good = planAttachments('Готово [[attach:out/shot.png]]', work);
  eq(good.files.length, 1, 'in-workdir marker resolves');
  eq(good.files[0], resolve(work, 'out', 'shot.png'), 'resolved absolute path');
  eq(good.problems.length, 0, 'no problems for an in-workdir marker');
  assert(!good.text.includes('[[attach'), 'plan text carries no marker');

  // Escapes are refused with E_PATH_DENIED, by the same guard /get uses.
  for (const bad of ['../secret.txt', '../../secret.txt', join(root, 'secret.txt'), 'C:/Windows/win.ini', '/etc/passwd']) {
    const plan = planAttachments(`[[attach:${bad}]]`, work);
    eq(plan.files.length, 0, `refused: ${bad}`);
    eq(plan.problems[0]?.code, 'E_PATH_DENIED', `E_PATH_DENIED for ${bad}`);
  }

  // Missing file / directory / too big are reported, not silently dropped.
  eq(planAttachments('[[attach:nope.png]]', work).problems[0]?.code, 'E_NOT_FOUND', 'missing file -> E_NOT_FOUND');
  eq(planAttachments('[[attach:out]]', work).problems[0]?.code, 'E_NOT_FILE', 'directory marker -> E_NOT_FILE');
  eq(planAttachments('[[attach:]]', work).problems[0]?.code, 'E_BAD_PATH', 'empty marker -> E_BAD_PATH');
  eq(planAttachments('[[attach:out/shot.png]]', work, 5).files.length, 1, 'marker still resolves when text is empty');

  // Conservative guessing stays the fallback for an unmarked answer.
  const guess = planAttachments('Я сохранил отчёт в report.md, глянь.', work);
  eq(guess.files.join(','), resolve(work, 'report.md'), 'unmarked reply still auto-attaches a named file');
  const guessOutside = planAttachments('Смотри ../secret.txt и C:/Windows/win.ini', work);
  eq(guessOutside.files.length, 0, 'guessing cannot escape the workdir');

  // The streaming censor keeps a half-written marker off the phone.
  const censor = new AttachCensor();
  const streamed = ['вот файл [[att', 'ach:out/shot.p', 'ng]] готово'].map((d) => censor.push(d)).join('');
  assert(!streamed.includes('[['), `censor hides a partial marker (got ${JSON.stringify(streamed)})`);
  assert(streamed.includes('готово'), 'censor keeps text after the marker');
  const censor2 = new AttachCensor();
  eq(censor2.finish('файл [[attach:out/shot.png]]'), 'файл', 'finish() drops an unterminated marker');

  // Size cap per kind, resolved through the one guard.
  eq(MAX_PHOTO_BYTES, 10 * 1024 * 1024, 'photo cap is 10 MB');
  eq(MAX_OUTBOUND_BYTES, 50 * 1024 * 1024, 'document cap is 50 MB');
  sparseFile(join(work, 'big.png'), MAX_PHOTO_BYTES + 1);
  eq(planAttachments('[[attach:big.png]]', work).problems[0]?.code, 'E_FILE_TOO_BIG', '12 MB image refused as a photo');
  sparseFile(join(work, 'big.zip'), MAX_OUTBOUND_BYTES + 1);
  eq(planAttachments('[[attach:big.zip]]', work).problems[0]?.code, 'E_FILE_TOO_BIG', '51 MB document refused');

  rmSync(root, { recursive: true, force: true });
}

/* --------------------------------------------------- D: photo routing and caps */

g('D. photo-vs-document routing and /files listing (defects 2a, 2c)');
{
  const root = mkdtempSync(join(tmpdir(), 'v03-send-'));
  writeFileSync(join(root, 'shot.png'), 'png');
  writeFileSync(join(root, 'photo.JPEG'), 'jpg');
  writeFileSync(join(root, 'anim.gif'), 'gif');
  writeFileSync(join(root, 'bundle.zip'), 'zip');
  writeFileSync(join(root, 'main.ts'), 'ts');
  sparseFile(join(root, 'huge.png'), MAX_PHOTO_BYTES + 1);
  sparseFile(join(root, 'huge.bin'), MAX_OUTBOUND_BYTES + 1);

  const cases = [
    ['shot.png', 'photo'],
    ['photo.JPEG', 'photo'],
    ['anim.gif', 'photo'],
    ['bundle.zip', 'document'],
    ['main.ts', 'document'],
    ['huge.png', 'document'],
  ];
  for (const [name, want] of cases) {
    const api = fakeApi();
    const got = await sendOutboundFile(api, 42, join(root, name), '📎 Из ответа агента');
    eq(got, want, `${name} routed as ${want}`);
    assert(
      api.calls.length === 1 && api.calls[0].kind === (want === 'photo' ? 'sendPhoto' : 'sendDocument'),
      `${name} used exactly one ${want === 'photo' ? 'sendPhoto' : 'sendDocument'} call`,
    );
    if (want === 'photo') {
      const caption = api.calls[0].other?.caption ?? '';
      assert(caption.includes(name), `${name} photo caption names the file (${caption})`);
      assert(api.calls[0].other?.parse_mode === undefined, `${name} caption is plain text, never markup`);
    }
  }

  await (async () => {
    let code = '';
    try {
      await sendOutboundFile(fakeApi(), 42, join(root, 'huge.bin'));
    } catch (e) {
      code = e.message.split(':')[0];
    }
    eq(code, 'E_FILE_TOO_BIG', '51 MB file refused with E_FILE_TOO_BIG');
  })();
  let missing = '';
  try {
    await sendOutboundFile(fakeApi(), 42, join(root, 'nope.png'));
  } catch (e) {
    missing = e.message.split(':')[0];
  }
  eq(missing, 'E_NOT_FOUND', 'missing file refused with E_NOT_FOUND');

  // The resolver refuses what the sender would refuse, with the right cap per kind.
  eq(
    (() => {
      try {
        resolveOutboundFile(root, 'huge.png', MAX_PHOTO_BYTES);
        return 'sent';
      } catch (e) {
        return e.message.split(':')[0];
      }
    })(),
    'E_FILE_TOO_BIG',
    'resolveOutboundFile enforces the photo cap',
  );

  // /files listing.
  const work = join(root, 'proj');
  mkdirSync(join(work, 'src'), { recursive: true });
  mkdirSync(join(work, 'node_modules'), { recursive: true });
  writeFileSync(join(work, '.env'), 'secret');
  writeFileSync(join(work, 'a.txt'), 'a');
  writeFileSync(join(work, 'src', 'b.ts'), 'b');
  writeFileSync(join(work, 'node_modules', 'junk.js'), 'junk');
  const listing = listDir(work, work);
  const names = listing.entries.map((e) => e.rel);
  assert(!names.includes('.env'), 'listing skips dotfiles');
  assert(!names.some((n) => n.includes('node_modules')), 'listing skips node_modules');
  assert(names.includes('src') && names.includes('a.txt'), 'listing shows dirs and files');
  eq(listing.entries[0].isDir, true, 'directories sort first');
  eq(listing.total, 2, 'total counts what was listed (dotfiles and node_modules excluded)');
  eq(listDir(work, work, 2).entries.length, 2, 'limit respected');
  eq(listDir(join(work, 'src'), work).entries[0].rel, join('src', 'b.ts'), 'rel path is workdir-relative');

  let escaped = '';
  try {
    resolveOutboundDir(work, '../../..');
  } catch (e) {
    escaped = e.message.split(':')[0];
  }
  eq(escaped, 'E_PATH_DENIED', '/files subdir cannot escape the workdir');
  let notDir = '';
  try {
    resolveOutboundDir(work, 'a.txt');
  } catch (e) {
    notDir = e.message.split(':')[0];
  }
  eq(notDir, 'E_NOT_DIR', '/files subdir must be a directory');

  rmSync(root, { recursive: true, force: true });
}

/* ------------------------------------------------------- E: send path behaviour */

g('E. send path: parse_mode, no silent downgrade, no duplicate sends (1a, 1c, 1d)');
{
  // E1: every non-streaming send carries parse_mode: 'HTML'.
  const api = fakeApi();
  await sendMarkdown(api, 7, '# /help\n- **жирный** пункт\n```bash\nls -la && echo <ok>\n```');
  assert(api.sends().length > 0, 'notify sent something');
  assert(api.sends().every((c) => c.other?.parse_mode === 'HTML'), 'every notify send uses parse_mode HTML');
  assert(api.sends().some((c) => c.text.includes('<b>') || c.text.includes('<pre>')), 'notify text is rendered HTML');

  const big = Array.from({ length: 900 }, (_, i) => `строка ${i}: a && b <div>`).join('\n');
  const apiLong = fakeApi();
  await sendMarkdown(apiLong, 7, big);
  assert(apiLong.sends().length > 1, `long notify split into ${apiLong.sends().length} messages`);
  assert(
    apiLong.sends().every((c) => c.other?.parse_mode === 'HTML' && c.text.length <= TELEGRAM_TEXT_LIMIT),
    'every long-notify message is HTML within the limit',
  );
  assert(apiLong.sends().every((c) => !c.text.includes('**')), 'no raw markdown survives in any message');

  // E2: a rate limit is retried, never downgraded to plain text.
  let attempts = 0;
  const limited = fakeApi({
    onSend: () => {
      attempts += 1;
      if (attempts === 1) return Object.assign(new Error('Too Many Requests: retry after 1'), { error_code: 429 });
      return undefined;
    },
  });
  await sendMarkdown(limited, 7, 'проверка ретрая');
  eq(attempts, 2, 'rate limit retried once');
  assert(limited.sends().every((c) => c.other?.parse_mode === 'HTML'), 'rate limit did not downgrade to plain text');

  // E3: a markup rejection shrinks the budget and retries instead of sending raw text.
  let markupAttempts = 0;
  const markup = fakeApi({
    onSend: () => {
      markupAttempts += 1;
      if (markupAttempts === 1) return new Error("Bad Request: can't parse entities: Unsupported start tag");
      return undefined;
    },
  });
  await sendMarkdown(markup, 7, big);
  assert(markupAttempts >= 2, `markup rejection retried with a smaller budget (${markupAttempts} attempts)`);
  assert(markup.sends().every((c) => c.other?.parse_mode === 'HTML'), 'markup rejection did not downgrade to plain text');

  // E4: plain text is the last resort, reached only after shrinking is exhausted.
  let alwaysMarkup = 0;
  const stubborn = fakeApi({
    onSend: () => {
      alwaysMarkup += 1;
      return new Error("Bad Request: can't parse entities: Unsupported start tag");
    },
  });
  await sendMarkdown(stubborn, 7, '**жирный** текст');
  assert(alwaysMarkup > 1, `shrinking retried before downgrading (${alwaysMarkup} HTML attempts)`);
  const plains = stubborn.calls.filter((c) => c.other?.parse_mode === undefined);
  assert(plains.length >= 1, 'last-resort plain send happened');
  assert(plains.every((c) => !c.text.includes('<b>')), 'plain fallback carries no markup');

  // E5: streaming an 8000+ char answer produces no duplicate sends across ticks.
  const streamApi = fakeApi();
  const stream = await createStream(streamApi, 7, { flushMs: 5 });
  const deltas = [];
  for (let i = 0; i < 900; i += 1) deltas.push(`строка ${i}: a && b <div>\n`);
  for (let i = 0; i < deltas.length; i += 12) {
    stream.push(deltas.slice(i, i + 12).join(''));
    await sleep(8); // several flush ticks across the write
  }
  await sleep(40);
  const sendsBeforeFinish = streamApi.sends().length;
  eq(sendsBeforeFinish, 1, 'only the placeholder message exists while streaming (no tail spam)');
  assert(streamApi.edits().length > 1, `live message was edited ${streamApi.edits().length} times`);
  assert(
    streamApi.edits().every((c) => c.other?.parse_mode === 'HTML'),
    'every live edit uses parse_mode HTML',
  );
  assert(
    streamApi.edits().every((c) => c.text.length <= TELEGRAM_TEXT_LIMIT),
    'every live edit is within the Telegram limit',
  );
  const editedTexts = new Set(streamApi.edits().map((c) => c.text));
  eq(editedTexts.size, streamApi.edits().length, 'live edits never repeat the same text');

  const finalText = deltas.join('');
  const expected = renderHtmlChunks(finalText);
  await stream.finish(finalText);
  const sent = streamApi.sends().slice(1).map((c) => c.text);
  eq(sent.length, expected.length - 1, `tail sent exactly once per chunk (${sent.length} of ${expected.length - 1})`);
  assert(
    sent.every((t, i) => t === expected[i + 1]),
    'tail chunks are the expected rendered chunks, in order',
  );
  eq(new Set(sent).size, sent.length, 'no duplicate tail message was sent');
  assert(
    streamApi.sends().slice(1).every((c) => c.other?.parse_mode === 'HTML'),
    'streaming never downgraded to plain text',
  );
  eq(streamApi.sends()[0].text, '…', 'the only plain-text send is the live placeholder');

  // E6: finish() is idempotent and a second stream does not re-send the tail.
  await stream.finish(finalText);
  eq(streamApi.sends().length, 1 + expected.length - 1, 'a second finish() sends nothing');

  // E7: fail() keeps the live message and still reports.
  const failApi = fakeApi();
  const failStream = await createStream(failApi, 7, { flushMs: 5 });
  failStream.push('частичный ответ');
  await sleep(20);
  await failStream.fail('E_TIMEOUT');
  const lastEdit = failApi.edits().at(-1);
  assert(lastEdit.text.includes('⏱'), 'fail() shows the Russian reason on the live message');
  assert(lastEdit.other?.parse_mode === 'HTML', 'fail() edit is HTML');

  // E8: an edit that Telegram rejects as "not modified" is success, not a retry storm.
  let editCalls = 0;
  const notModified = fakeApi({
    onEdit: () => {
      editCalls += 1;
      return new Error('Bad Request: message is not modified: specified new message content and reply markup are exactly the same');
    },
  });
  const nmStream = await createStream(notModified, 7, { flushMs: 5 });
  nmStream.push('один и тот же текст');
  await sleep(30);
  await nmStream.finish('один и тот же текст');
  eq(editCalls, 1, '"message is not modified" was not retried');

  // E9: markdown escaping is total — untrusted text can never open a tag.
  const hostile = '<script>alert(1)</script> & "quotes" **bold** <b>x</b>';
  const hostileHtml = markdownToHtml(hostile);
  validateChunk(hostileHtml, 'hostile');
  assert(hostileHtml.includes('&lt;script&gt;'), 'hostile input is escaped');
  assert(!hostileHtml.includes('<script'), 'no script tag survives');
}

/* ---------------------------------------------------------------------- report */

process.stdout.write(`\n${'-'.repeat(60)}\n`);
if (failures.length === 0) {
  process.stdout.write(`ALL GREEN — ${passed} assertions passed\n`);
} else {
  process.stdout.write(`${failures.length} FAILED of ${passed + failures.length} assertions:\n`);
  for (const f of failures) process.stdout.write(`  - ${f}\n`);
  process.exitCode = 1;
}