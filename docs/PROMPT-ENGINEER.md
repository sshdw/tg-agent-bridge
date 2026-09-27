# PROMPT FOR THE ENGINEER AGENT (copy in full)

You are an engineer agent. Bring the Telegram bot to a finished state. You can summon parallel subagents — use that ability. You work in the repository, commit and push yourself.

## 0. Environment facts

- Repo: https://github.com/sshdw/tg-agent-bridge, branch `main`. Start with `git pull`.
- Local folder: `D:\projects\tg-agent-bridge`. All paths below are relative to it.
- OS: Windows. Node v24 (`node -v`). Package manager: npm.
- Stack: Node 20+ + TypeScript strict + grammy + better-sqlite3. Run: `npm run dev`. Typecheck: `npx tsc --noEmit` (must be clean after every task).
- `.env` already exists locally with `BOT_TOKEN` and `ALLOWED_CHAT_IDS` filled in. NEVER commit `.env` to git (it is in `.gitignore`). Secrets come only from `process.env` — never into code, logs, or bot replies.
- The owner is one person; the bot is personal. You communicate with the owner only through me (never DM them via Telegram yourself).

## 1. Locked decisions (do not revisit, do not "improve")

- Default agent: `opencode`. Task timeout 45 min. Streaming via live message editing.
- History: full history in SQLite, last 50 messages go to the agent (`HISTORY_LIMIT`). `/new` resets. Each chat = a separate session.
- Files: the agent works only inside `ALLOWED_ROOTS` (currently `./work`; the owner will add more later). Any escape → `E_PATH_DENIED`.
- Shell: `/auto off` by default, commands run only after `/approve`.
- Chat photos are saved to `workdir/inbox`, the path goes to the provider. `/clone <url>`, `/project <name|path>` exist.
- Source-of-truth docs: `docs/ARCHITECTURE.md` (contracts), `docs/TZ.md` (requirements FR-1..FR-14 + acceptance), `docs/TASK-BREAKDOWN.md` (tasks T1..T6).

## 2. Current state (T1 DONE, verified)

Committed to `main`, `npx tsc --noEmit` clean, `npm i` done. What exists:
- `src/index.ts` — entry point, `src/config.ts` — `.env` loading + validation.
- `src/telegram/bot.ts` — whitelist middleware + router; `src/telegram/stream.ts` — stream editing, 4000-char chunking, `fail()` with codes.
- `src/core/router.ts` — all commands: `/start /help /ask /code /agent /model /project /clone /auto /approve /new /status /cancel`, photo handler, plain text = `/ask`, approval-reply interception.
- `src/core/queue.ts` — queue (1 running task per chat), timeout, `Responder`/`StreamHandle`; `src/core/sessions.ts`, `src/core/permissions.ts` (whitelist + `resolveWorkdir`), `src/core/approvals.ts` (one pending approve per chat).
- `src/storage/db.ts` — SQLite (WAL): `sessions`, `messages`, `tasks` (with `images` JSON column). Migrations via `CREATE TABLE IF NOT EXISTS`.
- `src/gateway/types.ts` — the `IAgentProvider` contract (DO NOT CHANGE unless critical; if you change it, fix all providers yourself), `src/gateway/registry.ts`.
- `src/providers/mock.ts` — echo provider for testing without any real agent.
- `.env.example`, `Dockerfile` (draft, finish in T6), `package.json`, `tsconfig.json`.

## 3. Work plan (follow the steps strictly)

STEP 0 — verification (yourself, no subagents): `git pull`, `npm i`, `npx tsc --noEmit`, `npm run dev`. Then ask me: the owner sends `/start`, `/ask 2+2` (mock), `/cancel` from their phone. If the bot doesn't answer — fix it until it does. Do not proceed past STEP 0 until it is green.

STEP 1 — T2 (one agent, priority): `src/gateway/spawnRunner.ts` (shared helper: spawn, line-by-line stdout → `onEvent text`, `sessionId → child` map, kill on `cancel`, error sanitizing, timeout) + `src/providers/opencode.ts` (`opencode run <prompt> --format json` in `task.workdir`, history and images passed as context/args, `model` when set) + one-line registration in the registry (where `register(new MockProvider())` is now). Verify: `/agent opencode` + `/ask` really hits the CLI, streaming works, `/cancel` kills the process. If the `opencode` binary is missing on the machine — ask me, do not touch mock.

STEP 2 — fan-out in parallel (summon 3 subagents at once, each strictly its own files, `IAgentProvider` contract frozen):
- Subagent A (T3): `src/providers/cursor.ts` on top of `spawnRunner` (`cursor-agent --print`). No binary → `E_NOT_CONFIGURED`.
- Subagent B (T4): `src/providers/cline.ts` — `roo-code` CLI, otherwise file adapter `task.json`/`result.json` in workdir with polling. Document which path is active in the file header.
- Subagent C (T5): `src/providers/hermes.ts` + `src/providers/workbuddy.ts` on a shared `fetch` runner inside those files (POST `{baseUrl}/v1/agent/run`, key from env, `AbortController` on cancel, streaming parse). No key/URL → `E_NOT_CONFIGURED`.
For each subagent: do not touch core/queue/router/DB — only its own file(s) + 1 registration line (you merge the registrations yourself afterwards to avoid conflicts). `npx tsc --noEmit` after each.

STEP 3 — T6 (one agent): bring `Dockerfile`+`.dockerignore` to working state, README run section (install, `.env`, commands), rate limit already exists (1 per chat) — verify it, sanitize outward errors (only `E_*` codes, no commands/keys/SQL), `bot.log` free of secrets. Final `npm run build` + `docker build .`.

STEP 4 — acceptance per `docs/TZ.md` section 4 (+ FR-11..FR-14: photo, `/clone`, `/project`, `/auto`+`/approve`, `/new`): run everything you can yourself; anything needing the owner's phone — list it to me. Fix what you find. Finish: `npx tsc` clean, `npm run build` passes, push to `main`.

## 4. Hard rules

1. Do not change the `IAgentProvider` contract in `src/gateway/types.ts`. New agent = 1 file + 1 registry line.
2. Do not mix layers: Telegram — parsing/formatting only; Core — logic; Providers — CLI/HTTP translation only. No direct repo access from commands.
3. No secrets in code, logs, bot replies, or commits. `BOT_TOKEN`/keys — `process.env` only.
4. No stubs or TODOs in code. No scope creep (voice, webhooks, groups are v0.2 — do not build).
5. After every task: `npx tsc --noEmit` clean. One commit per task with conventional commits (`feat(bridge): ...`, `fix(bridge): ...`) + `git push origin main` immediately.
6. Windows-compatible paths (via `node:path`, never hardcoded `/`). `resolveWorkdir` already guards against escape — do not weaken it.
7. At the end — report to me as a list: what was done for T2..T6, what was verified, what needs the owner (phone/keys/CLI installs), links to commits.
