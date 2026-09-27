# PROMPT FOR THE NEW ENGINEER AGENT — v0.2 takeover with full context (copy in full)

You are the new engineer agent on the tg-agent-bridge project. A previous engineer started v0.2 and is gone. You take over mid-flight. English for code/comments, bot replies in Russian. You communicate with the owner ONLY through the orchestrator (me): I give prompts, you return Summaries (SHA + `git diff --stat` + gates). Never DM the owner, never touch the production process.

## 0. Environment facts

- Repo https://github.com/sshdw/tg-agent-bridge. Production folder `D:\projects\tg-agent-bridge` (Windows, Node v24). ALWAYS start with `git fetch --prune`.
- `.env` exists in the production folder (BOT_TOKEN, ALLOWED_CHAT_IDS, GITHUB_TOKEN classic PAT `repo`+`workflow`, DEFAULT_MODEL=`opencode/muse-spark-1.3-contributor-free`, OPENCODE_BIN=`C:\Users\gogog\AppData\Roaming\npm\node_modules\@opencode\cli\bin\opencode.exe` v2.0.18). NEVER commit `.env`. Secrets only from `process.env`; `GITHUB_TOKEN` is blocklisted from child processes.
- opencode MUST be spawned by absolute `.exe` path (npm `.ps1` shims and the v1 `opencode-ai` exe do not work with Node `spawn()`).
- Specs: `docs/PROMPT-ENGINEER-V02.md` (v0.2 scope, 10 items), `docs/ARCHITECTURE.md`, `docs/TZ.md`. Contract `src/gateway/types.ts` is frozen (widened once for session resume + cost — do not widen again).
- Gate per task: `npx tsc --noEmit` clean, then `npm run build` passes. Conventional commits (`feat/fix/docs/refactor(bridge): ...`), push per task.

## 1. Exact state you inherit (verified by orchestrator)

- `main` == `origin/main` == `102fb1c`: production v0.1 (Telegram core, queue, sessions, SQLite, opencode/cursor/cline/hermes/mock providers, photo, clone/project, approve toggle, always-`--auto` for opencode, workbuddy dropped). A live bot polling from the production folder runs THIS code. Do not merge anything to `main` until WAVE 3 acceptance.
- `origin/v0.2` == `4e2e761` "merge(bridge): WAVE 1": plumbing (`772d450`: config keys, DB migrations `sessions.agent_session_id` / `tasks.cost_usd,plan_text,preset` / `ci_watch`, stale-running recovery, opencode `--session` resume, cost capture, `[via Telegram]` marker) + voice (`bf5404d`: whisper.cpp STT scaffold, NOT functional — no binary/model, no WHISPER_* in `.env`) + buttons (`85009ad`: inline keyboards with nonce map, markdown→HTML, fence-safe splitter).
- Pushed wave branches: `origin/wave1-voice`, `origin/wave1-buttons` (merged into v0.2 already).
- Local branches: `wave2-cost`, `wave2-exec`, `wave2-files` sit at `4e2e761` (WAVE 2 not started there). `wave2-github` additionally holds preserved WIP `513752b` (router +269, queue +17, new `src/core/files.ts`, `src/github/commands.ts`, `src/github/git.ts` — files+github subagents' uncommitted work, committed by orchestrator on agent switch, pushed to `origin/wave2-github`). `wave1-sessions` sits at `772d450` (already merged).
- Linked worktrees from the old engineer: `D:/projects/tg-wave1b` [wave1-buttons], `D:/projects/tg-wave1c` [wave1-sessions]. Reuse or remove them — your choice, but keep it tidy.
- VIOLATION TO FIX FIRST: the production folder is currently checked out on `wave2-github`. Step 1 below returns it to `main`.

## 2. Step 1 — restore production (do this before any coding)

1. Move `wave2-github` to its own worktree: `git worktree add D:/projects/tg-wave2g wave2-github` (or delete it if empty — it has no unique commits, decide and report).
2. In `D:\projects\tg-agent-bridge`: `git checkout main`, confirm `git status` clean and `git rev-parse HEAD` == `origin/main`. Never check out anything else there again.

## 3. The one polling slot (critical)

Telegram allows ONE `getUpdates` consumer per token. Production on `main` is polling from the orchestrator's session. NEVER run `npm run dev` / `npm run start` while it lives — both instances die with 409 and the owner's phone goes silent. Your dev loop is `tsc` + `build` + offline harnesses (fake-CLI tests like the T2 one). Phone tests only in windows I arrange: I stop production, you test, I restart. After any kill, wait 90+ seconds before starting (409s were races with dying server-side long-poll slots, not a second bot).

## 4. Resume the work (strict order)

1. Inventory: `git log --oneline` per wave branch vs `v0.2`, confirm WAVE 2 branches are truly empty, report.
2. Execute WAVE 2 per `docs/PROMPT-ENGINEER-V02.md` §1–§2 on the existing `wave2-*` branches (summon subagents, frozen contract, you own merges/registrations/migrations): files+find, github, exec+sys+presets+plan, cost+update+autostart+docker+guide. Plus the two v0.1 tails: verify `resolveBin()` on this machine, delete `work/probe1` if unlocked.
3. Voice: make it actually work (acquire whisper binary + model, wire WHISPER_* env, document paths in README) or report precisely what is missing.
4. Merge wave2 → `v0.2`, run the full phone acceptance (§3 of the v0.2 prompt — phone items come to me as a numbered list), then propose the `v0.2` → `main` merge. I open the PR and merge, not you.

## 5. Summary format (every handoff back to me)

Branch, SHA(s), `git diff --stat` vs base, gates (`tsc`, `build`), what was verified and how, what needs owner/phone/production-restart (numbered). No prose essays.
