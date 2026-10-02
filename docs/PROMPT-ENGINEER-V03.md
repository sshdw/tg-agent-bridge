# PROMPT FOR THE ENGINEER AGENT — v0.3 "render + attachments" (copy in full)

You are the engineer agent on tg-agent-bridge. v0.2 is merged into `main` (`163195a`) and running in production. This is a focused fix wave: the owner reports two symptoms from his phone.

Work on a new branch `v0.3` from `origin/main`. English for code/comments, bot replies in Russian. You talk to the owner ONLY through me (the orchestrator): I give prompts, you return Summaries (branch, SHAs, diff stat, gates, verified-how, owner-needed numbered). Never touch the production folder `D:\projects\tg-agent-bridge`, never run `npm run dev`/`start` — production owns the single Telegram polling slot.

Gate per task: `npx tsc --noEmit` clean, `npm run build` pass, plus an offline harness for every behavioural change. Push per task.

---

## Symptom 1 — markdown renders as raw text in the chat

The owner sees literal `**bold**`, `` `code` ``, `- bullets` and raw fence markers instead of formatted Telegram text. I audited the pipeline; these are the concrete defects. Fix all of them, they compound.

### 1a. `notify()` sends no `parse_mode` at all — CRITICAL

`src/core/router.ts:534` — `createResponder.notify` calls `sendLong(...)`, and `sendLong` (`src/telegram/stream.ts:247`) calls `api.sendMessage(chatId, chunk)` with **no `parse_mode`**. So *every* non-stream reply is plain text: `/help`, `/find`, `/sys`, `/cost`, `/exec` output, `/status`, `/ci`, the boot ping. `/help` literally contains markdown bullets that never render.

Fix: one send path for everything. `notify` must render markdown to Telegram HTML and send with `parse_mode: 'HTML'`. Keep bot-authored strings HTML-safe (they contain `<` rarely, but `/exec` output and `/find` hits are untrusted — the existing whole-input escape in `markdownToHtml` already covers that; keep it).

### 1b. Splitting happens on RAW length, rendering happens after — CRITICAL

`splitMessage` chunks the markdown at `MAX_MSG = 4000` raw characters, then `renderHtml` converts each chunk. Conversion *expands* text: `&`→`&amp;` (1→5), `<`→`&lt;` (1→4), and every tag adds bytes. A 4000-char chunk of code containing `&&` or `<div>` blows past Telegram's 4096-char limit → `sendMessage` throws → `sendChunkHtml` catches and **silently re-sends the same chunk as plain text**. That is precisely the owner's symptom: the HTML attempt is rejected for length and the raw markdown lands in the chat.

Fix: make the length budget apply to the *rendered* output.
- Split on rendered length, not raw length. Render first, then chunk the HTML so each chunk is ≤ 4096 minus a safety margin.
- Keep the fence-safety property: never cut inside a fenced block. A code chunk may be split across two Telegram messages, but each message must be independently valid HTML with balanced tags — split at line boundaries, and hard-slice only as a last resort for pathological single lines.
- Never let the length fallback degrade to plain markdown silently. If HTML still fails, retry with a smaller chunk budget; plain text is the last resort, not the first.

### 1c. Silent plain-text fallback hides real errors — HIGH

`sendChunkHtml` (`stream.ts:149`) swallows every error and retries as plain text. Same in `flush` (`:169`), `finish` (`:206`) and `fail` (`:233`). A malformed-HTML bug, a rate limit, or the length problem above all look identical to the owner: "markdown is broken". No diagnostics ever reach the log.

Fix: keep the fallback (a reply must always land) but log the actual Telegram error once per task via `src/log.ts`, and only fall back for errors that are genuinely about markup/length. Rate limits and network errors must retry, not downgrade.

### 1d. Streaming re-sends overflow chunks on every tick — HIGH

`flush` (`stream.ts:165`) runs every 1200ms. It edits the live message with `chunks[0]` and then does `for (const c of chunks.slice(1)) await sendChunkHtml(...)` — **on every tick**. Once the buffer passes 4000 chars, chunks 2..N are re-sent as brand-new messages 5×/second. The owner gets a flood of duplicated messages mid-answer.

Fix: while streaming, live-edit only the first chunk. Buffer the remainder and send it once, after `finish`, deduplicated against what was already sent.

### 1e. Partial markdown flickers during streaming — LOW

Live edits render half-written markup, so `**bo` shows literally then flips to bold. Acceptable, but do not make it worse: when the buffer ends mid-fence or mid-emphasis, prefer to render the incomplete tail as plain escaped text rather than emitting an unbalanced tag.

---

## Symptom 2 — the agent cannot send files and photos back

v0.2 has the plumbing (`src/core/files.ts`, `/get`, `extractFileRefs` auto-attach, `attachFiles`) but it does not do what the owner expects. Fix these.

### 2a. Images are sent as documents, never as photos

`router.ts:138` (`/get`) and `router.ts:552` (`attachFiles`) always call `sendDocument`. A `.png`/`.jpg` arrives as a file attachment with no preview. Send image types via `sendPhoto` with a caption naming the file; everything else stays a document. Decide by extension, keep the 50 MB cap from `MAX_OUTBOUND_BYTES` (Telegram's photo limit is much lower — cap photos at 10 MB and say so in the error text).

### 2b. Auto-attach only fires on paths the agent happens to mention

`extractFileRefs` (`files.ts:157`) guesses from tokens in the reply text. If the agent writes "готово" and names nothing, nothing is sent — and the agent has no reliable way to know that naming a path is what triggers an upload.

Fix: give the agent an explicit, documented protocol instead of relying on guesses.
- A marker the agent can emit, e.g. a line `[[attach:relative/path.png]]` (document it in the system prompt appended by `composePrompt`, `src/gateway/spawnRunner.ts`), which the queue strips from the visible reply and turns into attachments.
- Keep the current conservative `extractFileRefs` guessing as a fallback for unmarked answers, but never let the marker text itself reach the phone.
- Both paths must resolve through `resolveOutboundFile` — reuse the existing containment guard, do not add a second, weaker one.

### 2c. No way to see what is available to send

Add `/files [subdir]` — list files in the chat workdir (size, modified time, capped count) so the owner can name one for `/get` or `[[attach:…]]`. Reuse `resolveWorkdir` + the containment rule; a subdir argument must not escape the workdir.

---

## Constraints

- `src/gateway/types.ts` stays frozen. `Responder.attachFiles` may gain an optional caption parameter, nothing else.
- No new runtime dependencies. The markdown converter stays hand-rolled (`src/telegram/markdown.ts`); fix it, do not swap it for a library.
- Windows-safe paths, `E_*` codes outward, never internals. No stubs, no TODOs.
- Every Telegram send goes through the single fixed path from 1a–1c. No ad-hoc `sendMessage` elsewhere; grep for `sendMessage` and route them all.
- Untrusted text (`/exec` output, `/find` hits, filenames, agent replies) must never become markup. The whole-input escape stays.

## Harness (offline, no network, no bot)

Extend or add `work/verify-render.mjs` covering:
- rendered-length budgeting: a 4000-char chunk full of `&&`/`<div>`/fences still produces chunks whose **rendered** length ≤ 4096;
- every chunk is independently valid Telegram HTML (balanced `<b>/<i>/<code>/<pre>/<a>`, no tag spanning chunks);
- no chunk contains an unclosed fence;
- the `[[attach:…]]` marker is stripped from the visible text and yields a resolved in-workdir path; `[[attach:../etc/passwd]]` and an absolute path are rejected with `E_PATH_DENIED`;
- photo-vs-document routing by extension and the size caps;
- streaming: a >8000-char buffer produces no duplicate message sends across ticks (count calls with a fake Api).

## Summary format

Branch, SHAs, `git diff --stat` vs `origin/main`, gates (`tsc`, `build`, harness), what was verified and how, owner-needed (numbered phone checks). No prose essays.
