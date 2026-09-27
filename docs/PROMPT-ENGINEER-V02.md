# PROMPT FOR THE ENGINEER AGENT — v0.2 "phone-first" (copy in full)

You are the engineer agent. Ship v0.2 of the Telegram bot. You summon parallel subagents — use that. Commit and push yourself. English for code/comments, bot replies in Russian.

## 0. Environment facts (same as v0.1)

- Repo https://github.com/sshdw/tg-agent-bridge, branch `main`. Start with `git pull`.
- Local folder `D:\projects\tg-agent-bridge`. Windows. Node v24. `npm run dev`, `npx tsc --noEmit` clean after every task.
- `.env` exists locally (BOT_TOKEN, ALLOWED_CHAT_IDS filled; owner will add GITHUB_TOKEN). NEVER commit `.env`. Secrets only from `process.env`.
- Current HEAD ≈ v0.1 + `fix --auto` + `drop workbuddy`. Providers: opencode (default, `--auto` always), cursor, cline, hermes, mock. `IAgentProvider` contract in `src/gateway/types.ts` stays frozen.
- Owner is one person, controls everything from their phone. Talk to the owner only through me.

## 1. Locked v0.2 scope (do not add more, do not cut)

1. **Voice IN only.** Telegram voice message → transcribed to text → fed as `/ask`. Engine: local, free, Windows x64 (e.g. whisper.cpp + ggml base model, or `nodejs-whisper` equivalent — you pick; no paid APIs). New env: `WHISPER_BIN`, `VOICE_MODEL_PATH` (+`VOICE_LANG=ru`). Flow: download `.oga` → convert to 16kHz wav (ffmpeg if present, else document the requirement in README) → transcribe → `queue.submit` with text + note `[voice]`. Transcription failure → `E_AGENT_FAILED`-style message, bot stays alive. Acceptance: owner sends a voice message from the phone.
2. **Inline buttons.** grammy `inline_keyboard` + `callback_query` handler. Buttons for: approve/deny shell (replaces `/approve` typing, `/approve` command stays), agent picker, model reset, project picker (lists `WORK_ROOT` subdirs), plan approve/reject (§7), update double-confirm (§9). Callback data: `scope:nonce` with a server-side nonce map (per chat, 15-min TTL) — never trust raw callback payloads, never put paths/secrets in callback data.
3. **Real opencode sessions.** Today every `/ask` is a fresh `opencode run` with history injected as text. Change to: one persistent opencode session per chat. Store `opencode_session_id` per chat (new nullable column in `sessions`, forward-only migration). Verify the resume flag via `opencode run --help` on this machine (binary: `C:\Users\gogog\AppData\Roaming\npm\node_modules\@opencode\cli\bin\opencode.exe`); use it when present, keep history-injection as fallback for other providers and when resume is unsupported. `/new` = drop the session id (fresh run next time) + clear history as today.
4. **Files both ways.** Outbound: agent-produced files the user asks about come back as Telegram documents (detect: relative paths in the answer + `/get <name>` command resolving inside workdir, `E_PATH_DENIED` outside). Inbound: any document/photo goes to `<workdir>/inbox` and its path is attached to the next task (extend the existing photo flow, unify photo+document handling).
5. **Reliability.** (a) On boot: flip stale `running` tasks to `pending`, DM the owner `я жив (v0.2, <shortSHA>), прерванных задач: N` — no silent auto-execution of old tasks. (b) Windows autostart: provide `scripts/install-autostart.cmd` (schtasks, run at logon, restart-on-failure) + README section. (c) Tails: auto-detect `OPENCODE_BIN` on win32 (resolve `.exe`/`.cmd` variants, log the resolved path at boot; keep explicit env override); delete `work/probe1` if unlocked, else leave it.
6. **GitHub (needs `GITHUB_TOKEN`, classic PAT with `repo`+`workflow`, owner creates it).** Via api.github.com with fetch (no `gh` dependency): `/commit <msg>` (add -A + commit + push in the chat's project dir, output short SHA), `/pr [<title>]` (push current branch + open PR, reply with URL), `/ci <owner/repo>` (latest runs + statuses), `/watch <owner/repo>` toggle (new `ci_watch` table; background poller every 5 min; DM on status change green/red). Poller failures are silent-ish (log only), never spam the chat.
7. **`/exec`, `/sys`, plan mode, presets.** `/exec <shell cmd>` runs in the chat workdir (timeout 5 min, chunked output, gated by the same approval flow as shell: `/auto off` → button). `/sys` replies CPU/RAM/disk (no new deps, `node:os` + minimal win32-safe math). Plan mode: `/code` first returns a short plan with approve/rework buttons; only after approve does the task run (rework = plain-text reply treated as plan comment, max 2 rounds, then run anyway). Preset commands `/review`, `/test`, `/fix <symptom>` = `/code` with a fixed role prefix (defined once in `src/core/presets.ts`).
8. **`/find`, `/cost`, Telegram marker + pretty output.** `/find <text>` searches all chat history (SQLite LIKE is fine at personal scale; FTS5 only if trivial). `/cost [day|week]`: new nullable `cost_usd` column on `tasks`; opencode provider extracts cost from the `result` JSONL event when present, others store NULL; sums ignore NULLs and say so. Marker: every prompt sent from Telegram is prefixed `[via Telegram]`; system line appended: `Reply concise and Telegram-friendly: short paragraphs, key points first, code in fenced blocks, no giant headers.` Response rendering: convert agent markdown to Telegram HTML (pick a small lib or 100-line converter), escape everything else, and upgrade `splitMessage` to never split inside fenced code blocks.
9. **`/update` (risky, double-confirm via button).** Flow: `git pull` + `npm i` + `npm run build` + `tsc`, then spawn a detached `scripts/updater.cmd` that waits for exit, pulls/builds again if needed, restarts `npm run dev`, and `process.exit(0)`. Reply progress into the chat before exiting. Owner-only (whitelist already guarantees it). Acceptance: version hash (`git rev-parse --short HEAD`) reported before and after from the phone.
10. **Docker + free-VPS guide (no migration yet).** Finalize `Dockerfile` (must survive native module install; keep it simple, verify `docker build .` if Docker exists — it doesn't on this machine, so at minimum keep the file coherent and document it), `.dockerignore`, and a README section "Oracle Always Free in 15 minutes" (card required for identity check, `VM.Standard.A1.Flex`, Ubuntu, Docker, `git clone`, `.env`, `docker run --restart unless-stopped`). Migration itself is a later task, not this prompt.

## 2. Execution waves (strict order)

- WAVE 0 (yourself): `git pull`, `npm i`, `tsc`, boot, owner smoke from phone (`/start`, `/ask`) — must be green before fanning out.
- WAVE 1 (3 subagents in parallel, frozen contract, core/router/DB-schema changes ONLY by you to avoid migration conflicts — subagents propose diffs, you apply):
  - A: voice (§1.1) — files: `src/voice/*`, router hook for `message:voice`, env additions.
  - B: buttons + pretty + marker (§1.2, §1.8-render): `src/telegram/keyboard.ts`, callback router, markdown→HTML, code-safe splitter.
  - C: sessions + queue resume + boot ping (§1.3, §1.5a): `sessions` migration, opencode resume flag, boot recovery.
- WAVE 2 (4 subagents in parallel): D: files in/out (§1.4) + `/find`; E: GitHub (§1.6); F: `/exec` + `/sys` + presets + plan mode (§1.7); G: `/cost` + `/update` + autostart script + Docker/guide (§1.8-cost, §1.9, §1.10, §1.5b/c).
- WAVE 3 (yourself): merge, `tsc`, `npm run build`, full phone acceptance (§3), push.

Each subagent: own files only, no contract changes, `tsc` after, conventional commits + push per task. You merge registrations and DB migrations yourself.

## 3. Phone acceptance (owner does, you list what you can't)

`/start`, `/ask`, voice message → text answer, buttons (approve + pickers), `/new` then continuity check (agent remembers), inbound doc + `/get`, `/commit`+`/pr` on a test branch, `/ci`, `/watch` toggle, `/exec`, `/sys`, `/review`, plan approve on `/code`, `/find`, `/cost`, `/update` (hash before/after), kill bot process → autostart/schtasks recovery, reboot-simulation: stale running → pending + `я жив` DM. Anything needing the phone comes to me as a numbered list.

## 4. Hard rules (as before)

Contract frozen. Layers separated. Secrets in env only (add `GITHUB_TOKEN` to the child-env blocklist in `spawnRunner.ts`). No stubs/TODOs. No scope beyond §1. Windows-safe paths. `E_*` codes outward, never internals. Final report: done per item, verified, owner-needed list, commit links.
