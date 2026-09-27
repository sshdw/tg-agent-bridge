# PROMPT FOR THE ENGINEER AGENT — v0.2 RESUME in a fresh chat (copy in full)

You are the engineer agent continuing v0.2 of the Telegram bot in a NEW session. The previous session was stopped mid-work. Read this whole prompt first — it replaces lost context.

## 0. Environment facts

- Repo https://github.com/sshdw/tg-agent-bridge. Local folder `D:\projects\tg-agent-bridge`. Windows, Node v24.
- `.env` exists locally (BOT_TOKEN, ALLOWED_CHAT_IDS, GITHUB_TOKEN classic PAT `repo`+`workflow`, DEFAULT_MODEL=`opencode/muse-spark-1.3-contributor-free`, OPENCODE_BIN points at the real v2 exe). NEVER commit `.env`.
- opencode binary: `C:\Users\gogog\AppData\Roaming\npm\node_modules\@opencode\cli\bin\opencode.exe` (v2.0.18). The npm `opencode.ps1` shim and the `opencode-ai` v1 exe do NOT work with Node `spawn()` — never use them.
- Full v0.2 spec: `docs/PROMPT-ENGINEER-V02.md` in the repo. Contract: `src/gateway/types.ts` (already widened once for session resume + cost — do not widen further without need).

## 1. State you inherit (verified by reviewer)

- `main` == `origin/main` == `289be1d`: production v0.1 + always-`--auto` + workbuddy dropped. CLEAN and running.
- Your previous session's work is on branches (all pushed to origin, `main` untouched):
  - `772d450` plumbing (config keys, DB migrations: `sessions.agent_session_id`, `tasks.cost_usd/plan_text/preset`, `ci_watch` table, stale-running recovery, opencode `--session` resume, cost capture, Telegram marker + system line, GITHUB_TOKEN blocklisted): merged into `v0.2` branch and fanned out.
  - `bf5404d` voice (whisper.cpp STT, `src/voice/*`, router hook) on `wave1-voice`. Voice is NOT yet functional: whisper binary/model are NOT downloaded, WHISPER_* keys are NOT in `.env`.
  - Other wave branches exist: `wave1-buttons`, `wave1-sessions`, `wave2-cost`, `wave2-exec`, `wave2-files`, `wave2-github` (check each with `git log` — some may be empty stubs).
- `npx tsc --noEmit` was clean at the stop point. Re-verify on your branch before continuing.

## 2. The single most important rule: ONE polling slot

Telegram allows exactly ONE `getUpdates` consumer per token. A production bot on `main` is currently polling from the reviewer's session. If you start a second `npm run dev`, BOTH instances die with 409 and the owner's phone goes silent.
- NEVER run `npm run dev` / `npm run start` while the production instance lives. Ask me (via the owner) for a test window: I will stop production, you test, then I restart production.
- Your dev loop is: `npx tsc --noEmit` + `npm run build` + unit-level harnesses (like the T2 fake-CLI test). Phone tests only in agreed windows.
- The 409s seen earlier were kill→start races against dying server-side long-poll slots, not a real second bot. After any kill, wait 90+ seconds before starting.

## 3. Resume plan

1. `git fetch`, inventory every `wave*` branch: `git log --oneline <branch> --not main`. Report per branch: done / stub / empty.
2. Continue exactly per `docs/PROMPT-ENGINEER-V02.md` waves: finish WAVE 1 (voice needs binary+model acquisition — document the exact download paths in README; buttons; sessions), then WAVE 2 (files+find, github, exec+sys+presets+plan, cost+update+autostart+docker).
3. Finish the two tails from v0.1: win32 OPENCODE_BIN auto-detect (started in plumbing via `resolveBin()` — verify it actually resolves on this machine), delete `work/probe1` if unlocked.
4. Merge to `main` ONLY in WAVE 3 after full phone acceptance (§3 of the v0.2 prompt). Conventional commits, push per task.
5. Anything needing the owner's phone, login, or a production restart comes to me as a numbered list — never DM the owner, never touch the production process.

## 4. Standing rules

Frozen contract, separated layers, secrets in env only, no stubs/TODOs, no scope beyond the v0.2 prompt, Windows-safe paths, `E_*` codes outward. Final report: done per item, verified, owner-needed list, commit links.
