# Mini App v0.5 — мастер-план рерайта `tg-agent-bridge`

**STATUS: READY — W1 готов к выдаче**

**Владелец:** один человек, управляет всем с телефона. Русский язык для всех текстов, обращённых к владельцу.

**Последнее обновление:** 2026-10-03. **Ветка-источник аудита:** `main` = `c554fd4`. **Дизайн-система:** `.opencode/skills/telegram-liquid-glass/` (заморожена, `95206b7`) — источник всех токенов и motion-значений.

**Назначение.** Этот документ — живой мастер-план превращения `tg-agent-bridge` из keyboard-driven чат-бота в Telegram Mini App с четырьмя табами (Home, Tasks, Files, More) и дизайном Telegram-native Liquid Glass. Он читается двумя аудиториями: русскоязычным владельцем и агентами-инженерами. Поэтому проза — по-русски, а пути файлов, идентификаторы, имена API, SQL, CSS, команды и код — по-английски.

**Как оркестратор использует этот документ.** Волны выдаются по одной, строго по порядку (§7). Каждая волна проходит цикл: implementer → reviewer → fix → CI → merge. Инженер, получивший волну, не обязан знать проект: карточка волны содержит точные файлы, точный API-контракт (§5), нумерованные проверяемые критерии приёмки и точные gate-команды. Статус волн ведётся в §11 — оркестратор заполняет его по мере приземления волн. Изменения этого документа после написания фиксируются в «Decision log» (§11).

---

## 1. Решения D1–D8 (заморожены владельцем, дословно)

### D1. Hosting

**Решение.** No mandatory Tailscale. Dev: Tailscale Funnel primary, `cloudflared` quick tunnel as disposable fallback (URL churn, no SSE). Prod: a proper HTTPS endpoint / VPS / Cloudflare Tunnel. The requirement is only that the owner is never forced into a VPN/Tailscale account, and that the bridge code has zero knowledge of the tunnel.

**Rationale.** Бот и Mini App-бэкенд живут на домашнем Windows-ПК без публичного IP и без банковской карты. Исследование хостинга — `docs/research/R1-MINIAPP-PLATFORM.md`, §B.1–B.7. Tailscale Funnel — единственный cardless-вариант со стабильным URL и валидным TLS (R1 §B.3); Quick Tunnel не поддерживает SSE и меняет URL при каждом старте (R1 §B.1). Код бриджа не должен знать о туннеле, иначе смена хостинга потребует правок кода.

**Источник.** R1 §B.7 (ранжированная рекомендация).

**Constrains waves:** W1 (единственная задача про URL, правило «нет переменной — молча пропустить»), W8 (README описывает внешний деплой, код его не касается).

### D2. Refraction is a SIMULATION

**Решение.** Do not chase a true iOS compositor. Ready criterion, verbatim intent: on first open on a phone it must read as Telegram-like Liquid Glass, not as a plain `backdrop-filter`.

**Rationale.** Настоящей рефракции (смещения пикселей фона по краю элемента) в CSS не существует. Убедительная имитация собирается из восьми ингредиентов: blur, transparency, edge highlight, subtle distortion, dynamic light, parallax, spring animation (плюс specular/tint по скиллу). Честная рамка зафиксирована в скилле.

**Источник.** `.opencode/skills/telegram-liquid-glass/SKILL.md`, §«Refraction simulation (honest framing, 8 ingredients)»; `docs/research/R2-LIQUID-GLASS.md` §2.4.

**Constrains waves:** W5, W6, W7 (вся UI-работа; ревьюер проверяет по `references/checklist.md` и `references/tokens.css`).

### D3. Performance: Auto + manual

**Решение.** `Auto | Full | Lite`, default Auto, in `More → Performance`. Auto uses Telegram's Android User-Agent performance class (`LOW`/`AVERAGE`/`HIGH` — note: this is a **User-Agent tail**, NOT `window.Telegram.WebApp.performance_class`, which does not exist) plus `deviceMemory`, `hardwareConcurrency`, a frame/FPS heuristic, and `prefers-reduced-motion`. Ladder: HIGH → full effects, AVERAGE → reduced blur/motion, LOW → Lite. Manual overrides win over Auto. The user must never have to choose anything.

**Rationale.** Telegram официально требует учитывать performance class на Android (R1 §A.7); сам Telegram вынес тумблер эффектов в Settings > Power Saving. Auto по умолчанию означает: владелец ничего не выбирает, всё работает из коробки.

**Источник.** R1 §A.7; `.opencode/skills/telegram-liquid-glass/references/performance.md` §§0–3.

**Constrains waves:** W5 (лестница + настройка), W6–W7 (наследуют режимы; Lite проверяется вручную).

### D4. Light theme from day one

**Решение.** Not dark-first architecture: `Telegram themeParams → design tokens → dark / light / custom theme`. Both themes complete. Polish order is dark first, then light brought to the same system. Custom Telegram themes must not break it. The near-white-glass-on-near-white unreadability failure must be handled mechanically (the skill already specifies this in `references/theme.md`).

**Rationale.** Источник истины — `Telegram.WebApp.themeParams`, а не `prefers-color-scheme`. Кастомная тема пользователя не должна ломать вёрстку; near-white-кейс (`relLum(section_bg) > 0.90` → `data-flat="1"`) обрабатывается бинарным переключателем, а не ручной подгонкой альфы.

**Источник.** `.opencode/skills/telegram-liquid-glass/references/theme.md` §§1–3.

**Constrains waves:** W5 (wiring темы + обе темы), W6–W7 (наследуют).

### D5. Accent from the Telegram theme

**Решение.** No fixed colour, no purple. Accent is permitted ONLY at: selected tab, primary buttons, links, progress, selected state, important highlights. Neutrals stay neutral. Must feel native to Telegram, not like a separate product.

**Rationale.** Акцент берётся только из `accent_text_color` / `button_color` / `link_color` (цепочка в `references/tokens.css`: `--accent-action`, `--accent-text`). Любой фиксированный hex как акцент — провал ревью (AC1–AC2 чеклиста).

**Источник.** `.opencode/skills/telegram-liquid-glass/SKILL.md`, non-negotiable #2; `references/checklist.md` AC1–AC2.

**Constrains waves:** W5, W6, W7.

### D6. Glass layer hierarchy

**Решение.** CONTENT = Telegram background, `section_bg`, slight transparency, subtle border, **NO heavy blur**. FLOATING CONTROLS = glass. NAVIGATION (the 4-tab bottom bar) = the strongest glass. This is the accepted resolution of the Apple "don't put Liquid Glass in the content layer" conflict.

**Rationale.** Прямое требование Apple HIG («Don't use Liquid Glass in the content layer») + производительность (не вешать `backdrop-filter` на десятки строк списков). Три тира зафиксированы в скилле: `.content-card` / `.list-row` (flat), `.glass-float` (второй тир), `.glass-nav` (максимум, только 4-таб бар).

**Источник.** `.opencode/skills/telegram-liquid-glass/SKILL.md`, non-negotiable #1; R2 §1.4.

**Constrains waves:** W5, W6 (строго: никакого стекла над кодом/диффом), W7.

### D7. No realtime in v0.5

**Решение.** HTTP API + short polling, e.g. `GET /api/tasks/:id` every ~1–2 s ONLY while a task is active, slower when idle. Do not build realtime infrastructure for a progress bar. SSE/WebSocket deferred until a stable production endpoint exists.

**Rationale.** Quick Tunnel не поддерживает SSE (R1 §B.1) — стриминг-инфраструктура умрёт на первом же fallback-туннеле. Для прогресс-бара достаточно дешёвого polling с `since_rev`/ETag (§6). SSE/WebSocket — только когда появится стабильный production endpoint (см. §10).

**Источник.** R1 §B.1; `docs/research/R3-CODEBASE-AUDIT.md` §3.4 (вывод о durable-состоянии).

**Constrains waves:** W4 (контракт polling, без SSE), W5 (клиентский poller), все волны: запрет на SSE/WS-код в v0.5.

### D8. Security — hard requirement

**Решение.** Validate Telegram `initData` **server-side** on every request (HMAC with the bot token, `auth_date` freshness, signature check). Whitelist the authorized chat/user. **Never trust a client-supplied user id.** Mini Apps receive user data and `query_id` from Telegram; the backend must verify, not believe. R1 documents the validation mechanism.

**Rationale.** Без HMAC любой, кто откроет Mini App URL, получит доступ к `opencode` на домашнем ПК. Проверки на каждый запрос: наличие `hash`, HMAC-SHA256 по `data-check-string` с `secret_key = HMAC_SHA256(bot_token, "WebAppData")`, сравнение через `crypto.timingSafeEqual`, свежесть `auth_date` (≤ 24 ч), `user.id ∈ ALLOWED_CHAT_IDS`, `initDataUnsafe` на сервере игнорируется.

**Источник.** R1 §A.3 (таблица из 6 проверок); `src/config.ts:106` (`ALLOWED_CHAT_IDS` уже есть).

**Constrains waves:** W1 (guard), W4 (каждый endpoint), W6 (download/preview — тоже за guard).

---

## 2. Non-goals (явно НЕ в v0.5)

| Non-goal | Куда попадёт позже |
|---|---|
| Multi-agent pipelines | Отдельный эпик после v0.5, когда будет realtime-транспорт |
| Workflow editor | Не планируется; пресеты (`src/core/presets.ts:14`) остаются чипами |
| Scheduled tasks | Отдельный эпик (нужен планировщик + персистентность триггеров) |
| Model benchmarking | Не планируется |
| Task priorities | Только если очередь станет >1 на чат; сейчас одна задача на чат (`src/core/queue.ts:62`) |
| Task tags | Вместе с фильтрами, не раньше |
| Custom personas | Не планируется |
| Custom preset editor | Пресеты остаются кодом (`src/core/presets.ts`) |
| Multiple concurrent sessions UI | Архитектура — одна задача на чат; смена потребует перепроектирования `pumping` (`src/core/queue.ts:62`) |
| Drag-and-drop queue | Очередь personal-scale; не нужно |
| Complex notification center | Только CI-watch DM уже есть (`src/github/ciPoller.ts:44`); в v0.5 — DELETE (см. §9) |
| Full code editor | Только preview + diff; редактирование — через агента |
| Large system monitor | Только минимальный bridge status (`GET /api/health`) |
| Complex permissions center | `autoApprove` on/off остаётся; большего нет |
| Automatic CI→fix→CI loops | GitHub-модуль удаляется в v0.5 (§9) |
| Separate analytics dashboards | Только `/cost`-эквивалент в More |
| Dozens of filters | Один `recent` + история по дням |
| Skill marketplace | Не планируется |
| Skill ratings/stars/analytics | Не планируется |
| Skill editor in Telegram | Навыки — файлы `SKILL.md`; редактирование вне Mini App |
| 50 built-in skills | Несколько собственных `SKILL.md` в новом каталоге; остальное — pin существующих |
| Separate Skills tab | Навыки живут внутри Tasks (pin) + More (list); отдельного таба нет |

---

## 3. Current state (по R3, сверено с кодом)

| Capability | Статус | Доказательство |
|---|---|---|
| Long-polling grammy-бот, одна задача на чат | Есть | `src/index.ts:115` (`bot.start`), `src/core/queue.ts:62` (`pumping: Set<number>`) |
| HTTP-сервер / Mini App-код / `initData` / `setChatMenuButton` | Нет | `src/index.ts:115` (long polling без webhook); grep по `src/` на `createServer\|setChatMenuButton\|initData` — 0 совпадений (R3 §3.1, сверено) |
| `Store` (better-sqlite3, WAL, синхронные вызовы) | Есть | `src/storage/db.ts:58`, `src/storage/db.ts:64` |
| Таблицы `sessions/messages/tasks/ci_watch`, миграции только `ADD COLUMN` | Есть | `src/storage/db.ts:80`, `src/storage/db.ts:123` |
| Статусы `pending→running→done/error/cancelled` + `awaiting_plan` | Есть | `src/core/queue.ts:297`, `src/core/queue.ts:171` |
| `runningTask/oldestPending/pendingCount`, `recoverStaleRunning` | Есть | `src/storage/db.ts:242`, `src/storage/db.ts:248`, `src/storage/db.ts:254`, `src/storage/db.ts:266` |
| Plan mode (`awaiting_plan`, `plan_text`, approve/rework, max 2 rework) | Есть (чат) | `src/core/queue.ts:115`, `src/core/queue.ts:134`, `src/core/queue.ts:343`; клавиатура `src/telegram/keyboard.ts:131` |
| Approvals (один pending на чат) | Есть, in-memory | `src/core/approvals.ts:2` (`Map<chatId, resolve>`); резолв `src/telegram/callbacks.ts:185`, `/approve` `src/core/router.ts:483`, `/cancel` `src/core/queue.ts:180` |
| `pendingFiles` (inbox-аттачи) | Есть, in-memory | `src/core/router.ts:80` |
| `planWaiting/planTurns/planOrigin/planRounds` | Есть, in-memory | `src/core/queue.ts:66`, `src/core/queue.ts:69`, `src/core/queue.ts:71`, `src/core/queue.ts:73` |
| Model picker (живой список, кэш 6 ч / fail 1 мин) | Есть (чат) | `src/gateway/models.ts:270` (`cachedModels`), `src/telegram/callbacks.ts:315` |
| Agent/project pickers, `listProjects` | Есть (чат, telegram-слой) | `src/telegram/callbacks.ts:278`, `src/telegram/callbacks.ts:290`, `src/telegram/callbacks.ts:85` (`listProjects`) |
| Cost (`cost_usd`, `formatCostReply`), sys (`formatSys/sysInfo`) | Есть (чат) | `src/core/cost.ts:39`, `src/core/sys.ts:31`, `src/core/sys.ts:56` |
| Files: guards, 1-уровневый листинг (40 строк), `[[attach:…]]` | Есть (чат) | `src/core/files.ts:115`, `src/core/files.ts:357`, `src/core/files.ts:48`, `src/core/files.ts:394`, `src/core/files.ts:449` |
| `resolveWorkdir` containment guard | Есть | `src/core/queue.ts:238` (использование); определение — `src/core/permissions.ts` (НЕ ПРОВЕРЕНО построчно, номер строки не фиксирую) |
| Changed files / diffs / `+N −N` | Нет | R3 §1.6: ни один модуль не запускает `git status/diff`; единственное упоминание — текст промпта `src/core/presets.ts:16` |
| Прогресс задачи (проценты/elapsed) | Нет | Только текстовый стрим; `created_at` есть — elapsed выводим |
| `title` задачи, токены, skills | Нет | В схеме только `cost_usd`; `composePrompt` режет историю по символам (`src/gateway/spawnRunner.ts:278` — НЕ ПРОВЕРЕНО построчно, см. ниже) |
| Skills system | Нет | Совпадений смысловых нет (R3 §4) |
| Единый health-объект | Нет | Сигналы разбросаны: `src/index.ts:79`, `src/core/sys.ts:73`, `src/index.ts:89`, `src/index.ts:95` |
| Nonce-реестр кнопок (TTL 15 мин, single-use) | Есть | `src/telegram/nonce.ts:21`, `src/telegram/nonce.ts:89` |
| Scope-кнопки `approve/agent/model/project/plan/update` | Есть | `src/telegram/keyboard.ts:15`, `src/telegram/callbacks.ts:184` |
| Voice in (whisper.cpp), GitHub (`/commit/pr/ci/watch` + poller) | Есть (под cut) | `src/voice/transcribe.ts:70` (R3 §1.9, сверено частично); `src/github/commands.ts:73`, `src/github/commands.ts:117`, `src/github/commands.ts:205`, `src/github/commands.ts:229`; poller `src/config.ts:140`, `src/github/ciPoller.ts:44` |
| Харнессы `work/verify-render.mjs`, `work/verify-tables.mjs`, `work/verify-dot.mjs` | Есть | Покрывают `core/files`, `telegram/markdown`, `permissions`, `storage` (R3 §5) |

**НЕ ПРОВЕРЕНО и не фиксирую номер строки:** `src/core/permissions.ts` (факт guard подтверждён использованием в `src/core/queue.ts:238`); `src/gateway/spawnRunner.ts:278` (`composePrompt` лимит 12000 — факт принят из R3 §1.5, строка не подтверждена мной); `src/github/client.ts` поле `configured` (принято из R3 §2 через использование `src/github/ciPoller.ts:46` — сам файл не открывал); точная строка `src/core/exec.ts:145` (approval в `/exec` — принят из R3 §1.7). Что их верифицирует: открытие файла и grep перед использованием в W4/W8.

---

## 4. Target architecture

```
Telegram Mini App (static, no bundler)
      │  HTTPS
      ▼
public endpoint  ← deployment concern, NOT part of this repo's architecture
      │
      ▼
TG Agent Bridge HTTP API  (node:http, no new runtime deps)
      ▼
SQLite (better-sqlite3)  +  agent gateway (frozen src/gateway/types.ts)
```

Один процесс: HTTP-слой живёт в том же процессе, что grammy long polling (R3 §3.3–3.4: WAL допускает короткие синхронные SELECT/UPDATE без влияния на цикл; in-memory состояние — approvals, planWaiting, streams — невидимо другому процессу).

### 4.1. Target file tree (минимум новых модулей)

```
src/
  core/                 # queue.ts (+title/skills/snapshot этапы), sessions.ts, presets.ts,
                        #   cost.ts, sys.ts, files.ts — как есть; approvals.ts — durable-таблица
  gateway/              # opencode.ts, spawnRunner.ts, models.ts, registry.ts (БЕЗ hermes/fetchRunner)
  providers/            # opencode.ts, mock.ts (остальное — DELETE, §9)
  storage/db.ts         # + новые колонки/таблицы (§4.2), миграции только вперёд
  telegram/             # bot.ts, callbacks.ts (только approve/plan), keyboard.ts (урезан),
                        #   stream.ts, send.ts, rich.ts, markdown.ts (заморожен), nonce.ts
  miniapp/              # НОВОЕ — единственный новый домен-модуль (4 файла, меньше нельзя:
    http.ts             #   слушатель node:http + initData-HMAC guard + раздача статики web/
    api.ts              #   ~20 эндпоинтов (§6) поверх Store/TaskQueue
    diff.ts             #   git status/diff сбор (снапшоты до/после, caps)
    skills.ts           #   list/pin/record (§4 R3: readdir SKILL.md + frontmatter)
  web/                  # НОВОЕ — статика Mini App, ванилла, без сборки:
    index.html          #   shell: <script telegram-web-app.js?63> в <head>, 4 таба, nav
    tokens.css          #   verbatim-копия скилла references/tokens.css + проектные классы
    app.js              #   один ES-модуль: boot, theme, perf, tabs, polling, screens
    screens/
      home.js tasks.js files.js more.js   # 4 экрана, native ES imports из app.js
  skills/               # НОВОЕ — наши собственные SKILL.md (релиз, ревью, коммит-месседж…)
work/
  verify-w1-auth.mjs … verify-w8-cut.mjs  # харнессы волн (§7 Gates), офлайн
```

**Почему 4 файла в `miniapp/` — минимум.** HTTP-границы (auth+слушатель, роутинг эндпоинтов, diff-сбор, skills) не должны лежать ни в `telegram/`, ни в `core/`: у них другой жизненный цикл и другие тесты. Складывать всё в один `server.ts` — значит смешать guard, SQL-проекции и git-вызовы в нетестируемый комок.

**Почему frontend без бандлера/фреймворка.** Zero toolchain (нечего собирать на Windows-ПК — деплой = скопировать файлы), instant iteration (правишь `web/*.js` — обновляешь WebView), CSS-native дизайн-система (весь скилл — это CSS-токены + 15 строк JS-пружин; фреймворк добавит рантайм ради эффектов, которые компилируются в CSS), personal single-user scope (нет нужды в роутере/сторе — 4 таба и один poller).

### 4.2. SQLite schema changes (DDL sketch)

Миграции — только вперёд: `CREATE TABLE IF NOT EXISTS` + `addColumn` (паттерн `src/storage/db.ts:80`, `src/storage/db.ts:123`). Существующий файл БД переживает апгрейд без потерь. `ci_watch` остаётся нетронутой (миграции не удаляют таблицы).

```sql
-- tasks: новые колонки (addColumn каждая)
ALTER TABLE tasks ADD COLUMN title TEXT;            -- короткий заголовок (первые ~60 символов prompt)
ALTER TABLE tasks ADD COLUMN model TEXT DEFAULT ''; -- модель на момент запуска (сейчас читается из сессии)
ALTER TABLE tasks ADD COLUMN project TEXT DEFAULT '';// проект/workdir на момент запуска
ALTER TABLE tasks ADD COLUMN skills_used TEXT DEFAULT '[]'; -- JSON-массив имён навыков
ALTER TABLE tasks ADD COLUMN rev INTEGER DEFAULT 0; -- cheap-polling счётчик (bump при смене статуса)
ALTER TABLE tasks ADD COLUMN plan_origin TEXT;      -- durable origin prompt (из planOrigin in-memory)
ALTER TABLE tasks ADD COLUMN plan_reworks INTEGER DEFAULT 0; -- durable rework-счётчик
ALTER TABLE tasks ADD COLUMN git_before TEXT;       -- `git status --porcelain` до задачи (nullable)
ALTER TABLE tasks ADD COLUMN git_after TEXT;        -- `git status --porcelain` после задачи (nullable)
ALTER TABLE tasks ADD COLUMN git_base_sha TEXT;     -- HEAD до задачи (nullable; нет git → NULL)

-- task_files: изменённые файлы задачи (НОВОЕ)
CREATE TABLE IF NOT EXISTS task_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  path TEXT NOT NULL,          -- относительный путь от workdir
  added INTEGER NOT NULL DEFAULT 0,    -- +N
  removed INTEGER NOT NULL DEFAULT 0,  -- -N
  diff TEXT,                   -- unified diff файла, capped (§W3), NULL при обрезке/бинарнике
  truncated INTEGER NOT NULL DEFAULT 0 -- 1 = обрезан cap'ом
);

-- approvals: durable shell-approvals (НОВОЕ; сейчас in-memory src/core/approvals.ts:2)
CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  command TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending|allowed|denied|expired
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);

-- drafts: pre-run confirmation card (НОВОЕ)
CREATE TABLE IF NOT EXISTS drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  prompt TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'ask',
  agent TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  project TEXT NOT NULL DEFAULT '',
  skills TEXT NOT NULL DEFAULT '[]',  -- JSON-массив pinned навыков
  status TEXT NOT NULL DEFAULT 'open',-- open|confirmed|discarded|expired
  created_at INTEGER NOT NULL
);

-- skill_pins: закреплённые навыки (НОВОЕ; auto — политика на клиенте + флаг в draft)
CREATE TABLE IF NOT EXISTS skill_pins (
  chat_id INTEGER NOT NULL,
  skill TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (chat_id, skill)
);

CREATE INDEX IF NOT EXISTS idx_task_files_task ON task_files (task_id);
CREATE INDEX IF NOT EXISTS idx_approvals_chat ON approvals (chat_id, status, id);
CREATE INDEX IF NOT EXISTS idx_drafts_chat ON drafts (chat_id, status, id);
```

**Порядок обязателен.** `CREATE INDEX … idx_tasks_rev ON tasks (id, rev)` выполняется ПОСЛЕ всех `addColumn('tasks','rev',…)`, а не рядом с `CREATE TABLE`. На свежей БД колонки `rev` ещё нет, и создание индекса в том же блоке падает с `no such column: rev`. Это не гипотеза — W2 это обнаружил при реализации и вынес исправление в код; здесь схема исправлена, чтобы следующий инженер не наступил на грабли повторно. Полная последовательность миграции: `CREATE TABLE IF NOT EXISTS` для новых таблиц → `addColumn` для каждой новой колонки `tasks` → затем индексы по `tasks`.

Введённые таблицы/колонки: `task_files(task_id, path, added, removed, diff, truncated)`; `approvals(chat_id, command, status, created_at, resolved_at)`; `drafts(chat_id, prompt, mode, agent, model, project, skills, status, created_at)`; `skill_pins(chat_id, skill, created_at)`; колонки `tasks.title/model/project/skills_used/rev/plan_origin/plan_reworks/git_before/git_after/git_base_sha`.

---

## 5. API contract

**Base.** Тот же origin, что отдаёт статику (same-origin, CORS не нужен — вариант 1 из R1 §B.6). Все ответы — `application/json`.

**Auth (D8).** Каждый запрос кроме `GET /health` (liveness без данных) несёт заголовок `X-Telegram-Init-Data: <raw initData query string>`. Сервер: парсит, проверяет наличие `hash`, строит `data_check_string` (сортировка по ключу, `key=<value>`, разделитель `0x0A`), `secret_key = HMAC_SHA256(bot_token, "WebAppData")`, сравнивает `hex(HMAC_SHA256(data_check_string, secret_key)) == hash` через `crypto.timingSafeEqual`, проверяет `auth_date` (текущее время − `auth_date` ≤ 86400 с), извлекает `user.id` из поля `user` (JSON) — требует `user.id ∈ ALLOWED_CHAT_IDS`. `query_id` принимается как есть (Telegram-issued), но авторизация — только по проверенному `user.id`. **Никакой `user_id`/`chat_id` из тела запроса не используется для авторизации** — chat_id выводится сервером из проверенного `user.id`. Ошибки: `401 {error:"E_AUTH"}` (нет/плохая подпись), `403 {error:"E_FORBIDDEN"}` (подпись верна, но не whitelisted), `400 {error:"E_STALE"}` (протухший `auth_date`). Механика — R1 §A.3 дословно.

**Cheap polling.** Каждый изменяемый ресурс несёт монотонный `rev` (для задач — `tasks.rev`, bump при каждой смене статуса/стоимости). Клиент шлёт `?since_rev=N`; сервер отвечает `304 Not Modified` (пустое тело) если `rev == N`, иначе полным объектом. Это делает poll 1/с дешёвым: ответ — один индексный SELECT + 0 байт в простое.

**Polling cadence.** Активная задача (статус `running`/`pending`/`awaiting_plan` или открытый approval): `GET /api/tasks/:id?since_rev=` каждые 1000–2000 мс. Idle (нет активных): `GET /api/tasks/current` каждые 10000–15000 мс. Пауза polling при `Telegram.WebApp.isActive === false` (поле верифицировано R1 §A.4). Никаких SSE/WebSocket (D7).

### 5.1. Endpoints

1. `GET /health` — liveness без auth. Response `200 {"ok":true,"version":"0.5.0","sha":"c554fd4"}`. Errors: none.
2. `GET /api/health` — auth. Агрегат: telegram (polling жив), agent (`opencode` bin резолвится), github (token present/absent — без вызова сети), whisper (bin+model `existsSync`, без запуска), db (WAL ok), uptime, `pending` count. Response:
   ```json
   {"ok":true,"version":"0.5.0","sha":"c554fd4","uptime_s":12345,
    "telegram":"polling","agent":"opencode:/path/opencode","github":"absent","whisper":"ready",
    "db":"wal","pending":1,"stale_s":12}
   ```
   `stale_s` — секунд с последнего heartbeat (W1 вводит heartbeat-файл/строку каждые 30 с; stale > 90 с — UI показывает «бот недоступен»). Errors: `401/403/400` auth.
3. `GET /api/tasks/current` — auth. Текущая running + oldest pending + parked plan + pending approval в одном ответе (один экран Home — один запрос).
   ```json
   {"running":{"id":42,"title":"Починить падение…","agent":"opencode","model":"","project":"tg","mode":"code","status":"running","elapsed_s":137,"rev":3,"cost_usd":null},
    "pending_n":1,"plan":{"task_id":41,"reworks":0},"approval":{"id":7,"command":"rm -rf …"}}
   ```
   `elapsed_s = now − created_at`. Errors: auth only.
4. `GET /api/tasks/recent?limit=20&offset=0` — auth. Последние задачи DESC (`id,title,agent,model,project,mode,status,elapsed_s,cost_usd,created_at,finished_at`) + `{"has_more":true}`. `limit` 1..100. `offset` для постраничной подгрузки истории на экране Tasks (группировка по дням и заголовки «Сегодня»/«Вчера» считает клиент из `created_at`). Errors: `400 E_BAD_ARG` (limit вне 1..100, offset < 0).
5. `GET /api/tasks/:id[?since_rev=N]` — auth. Полная задача + `rev`; `304` если без изменений. Response: задача + `skills_used[]` + `files_summary{changed_n, added, removed}`.
6. `POST /api/drafts {prompt, mode, skills[]}` — auth. Создаёт confirmation card (W7 UI), возвращает `{"draft":{"id":9,"prompt":"…","mode":"code","agent":"opencode","model":"","project":"tg","skills":["gortex-debug"],"status":"open"}}`. Errors: `400 E_BAD_ARG` (пустой prompt / prompt > 8000 символов).
7. `POST /api/drafts/:id/confirm` — auth. Draft → `submit` в очередь (тот же `TaskQueue.submit`, `src/core/queue.ts:89`), draft `confirmed`. Response `{"task_id":43,"state":"started|queued|planned"}`.
8. `POST /api/drafts/:id/discard` — auth. Draft `discarded`. Response `{"ok":true}`.
9. `POST /api/tasks {prompt, mode, skills[]}` — auth. Прямой запуск без draft (retry/continue/шаблоны-пресеты). Те же лимиты, что п.6.
10. `POST /api/tasks/:id/stop` — auth. Эквивалент `cancel` (`src/core/queue.ts:179`): approval → parked plan → running task по приоритету. Response `{"stopped":"approval|task|plan","task_id":42}` или `404 E_NO_TASK`.
11. `POST /api/tasks/:id/retry` — auth. Новый `submit` с тем же prompt/mode/skills (новый id). Response `{"task_id":44}`.
12. `POST /api/tasks/:id/continue {text}` — auth. Новый `submit` с `prompt = text` в том же project (продолжение). Response `{"task_id":45}`.
13. `GET /api/tasks/:id/files` — auth. Из `task_files`: `{"files":[{"path":"src/a.ts","added":12,"removed":3,"truncated":0}],"changed_n":4,"total_added":120,"total_removed":30,"no_git":false}`. `no_git:true` + пустой список — проект не git-репо (W3 graceful).
14. `GET /api/tasks/:id/diff?path=src/a.ts` — auth. `{"path":"…","diff":"--- a/…\n+++ b/…\n@@ …","truncated":false}`. Cap: per-file 200 строк + хвост `…ещё N строк`; бинарники — только имена (`{"binary":true}`). Errors: `404 E_NO_DIFF`.
15. `GET /api/plan/current` — auth. Паркованный план: `{"task_id":41,"plan":"…","reworks":0}` или `{"plan":null}`.
16. `POST /api/plan/:id/approve` — auth. `approvePlan` (`src/core/queue.ts:115`). Response `{"task_id":41,"state":"started|queued"}` / `404 E_NO_PLAN`.
17. `POST /api/plan/:id/rework {comment}` — auth. `reworkPlan` (`src/core/queue.ts:134`). Response `{"rounds":1}` / `410 E_ROUNDS_OUT` (раунды кончились — задача запущена как есть).
18. `GET /api/approvals/pending` — auth. `{"approval":{"id":7,"command":"…","created_at":…}|null}`.
19. `POST /api/approvals/:id/allow` и `POST /api/approvals/:id/deny` — auth. Резолвят durable approval (и in-memory мост для текущего runner). Response `{"ok":true}` / `404 E_NO_APPROVAL` / `410 E_RESOLVED`.
20. `GET /api/files?dir=<rel>` — auth. Листинг через `listDir` (`src/core/files.ts:394`): `{"abs":"D:/…/proj","entries":[{"name":"a.ts","rel":"src/a.ts","size":123,"mtime":…,"isDir":false}],"total":87,"shown":40}`. **Всегда показывать полный видимый абсолютный путь** (`abs`). Errors: `403 E_PATH_DENIED`, `404 E_NOT_FOUND` (коды уже есть в `resolveOutboundDir`, `src/core/files.ts:357`).
21. `GET /api/files/preview?path=<rel>` — auth. Текст до 64 КБ (`{"path":"…","abs":"…","text":"…","truncated":true,"size":…}`); бинарник — `{"binary":true}`. Errors: path-коды как п.20.
22. `GET /api/files/download?path=<rel>` — auth. Бинарная отдача с `Content-Disposition: attachment; filename="<name>"` для `Telegram.WebApp.downloadFile` (R1 §A.5). **Без `Access-Control-Allow-Origin`** — статика и API отдаются с одного origin, CORS-заголовок не нужен, а жёстко прописанный `https://web.telegram.org` сломал бы доступ при любом другом хостинге. Лимиты `MAX_OUTBOUND_BYTES`/`MAX_PHOTO_BYTES` (`src/core/files.ts:15`, `:22`).
23. `GET /api/files/diff?path=<rel>` — auth. `git diff HEAD -- <path>` на текущее дерево (не по задаче), capped как п.14. Для «diff» из Files-таба.
24. `GET /api/pickers/agents` — auth. `{"agents":["opencode","mock"],"current":"opencode"}` (из `availableProviders` + сессия; `src/gateway/registry.ts:15` — НЕ ПРОВЕРЕНО построчно).
25. `GET /api/pickers/models` — auth. `{"models":[{"id":"…","label":"…"}],"current":"…","cached":true}` (поверх `cachedModels`, `src/gateway/models.ts:270`).
26. `GET /api/pickers/projects` — auth. `{"projects":[{"name":"…","dir":"D:/…","label":"…"}],"current":"…"}` (поверх `listProjects`, `src/telegram/callbacks.ts:85` — вынести в shared в W4).
27. `GET /api/settings` — auth. `{"agent":"…","model":"…","project":"…","auto_approve":false,"allowed_roots":["D:/…"]}` (сессия + read-only конфиг).
28. `PUT /api/settings {agent?, model?, project?, auto_approve?}` — auth. Поверх `updateSession` (`src/core/sessions.ts:43`); смена agent/project роняет `agent_session_id` (`dropAgentSession`, `src/core/sessions.ts:69`). Response — новая сессия. Errors: `400 E_BAD_ARG` (неизвестный agent — сверка с `AGENT_IDS`, `src/config.ts:5`; проект вне `ALLOWED_ROOTS`).
29. `GET /api/skills` — auth. `{"skills":[{"name":"gortex-debug","description":"…","source":"project|global","pinned":true}],"auto":true}`. Источники: `.opencode/skills/*/SKILL.md` вверх от workdir + global + `skills/` репо (механика R3 §4a).
30. `PUT /api/skills {pins:[…], auto:bool}` — auth. Перезаписывает `skill_pins` для чата. Response `{"ok":true}`.

**Два эндпоинта, которые были в черновике и удалены сознательно.** Агент-архитектор предложил `GET /api/history?day=YYYY-MM-DD` (группировка истории по дням) и `GET /api/cost?period=day|week` (JSON-версия `formatCostReply`, `src/core/cost.ts:39`). Оба вырезаны: первый дублировал `GET /api/tasks/recent` — данные для группировки по дням те же, а сама группировка является представлением экрана Tasks, то есть ответственность клиента; второй не входит в утверждённый scope v0.5 (в `More` его нет), а стоимость конкретной задачи уже приходит в объекте задачи. `/cost` и `/history` остаются чат-командами. Итог: 30 эндпоинтов вместо 32 — это следствие решения «жёстко урезать», а не недосмотр.

---

## 6. Waves W1–W8

Гейт-легенда (одинакова для всех волн): `npx tsc --noEmit` чисто, `npm run build` проходит, harness `node work/verify-wN-<name>.mjs` зелёный с указанием assertion count в отчёте. Без всех трёх — merge запрещён (§8). Наследуемые правила — §8.
### W1. Foundation — HTTP-сервер, auth, статика, health, menu-button

**Goal.** В том же процессе рядом с grammy long polling поднимается `node:http`-сервер: `initData`-HMAC guard (D8), раздача статики-заглушки, `GET /health`, heartbeat; при старте внешняя `MINIAPP_URL` (если задана) прошивается в `setChatMenuButton`, иначе молча пропускается (D1).

**Why now.** Всё остальное (API, Mini App) стоит на этом: guard, слушателе и правиле «ноль знания о туннеле».

**Depends on.** Ничего (первая волна).

**Files to add.**
- `src/miniapp/http.ts` — `createMiniServer(deps): {listen(port), close()}`; роутинг `GET /health`, `GET /` (статика), guard-middleware; 404/405 JSON.
- `work/verify-w1-http.mjs` — harness.

**Files to modify.**
- `src/index.ts:45` — старт HTTP-сервера после инициализации (порт из env `MINIAPP_PORT`, дефолт `8080`); первым — pid-lock против двух инстансов (R3 риск #1).
- `src/index.ts:79` — boot-ping + heartbeat каждые 30 с (heartbeat-файл `data/heartbeat`; stale > 90 с — Mini App показывает «недоступен», R3 риск #2).
- `src/index.ts:105` — рядом: `setChatMenuButton` wiring (см. ниже).
- `src/config.ts:98` — `loadConfig`: `miniPort` (`MINIAPP_PORT`, дефолт 8080), `miniUrl` (`MINIAPP_URL`, дефолт `''`).

**Data/DB changes.** Нет (heartbeat — файл, не таблица).

**API changes.** `GET /health` → `200 {"ok":true,"version","sha"}` без auth (liveness). Все остальные пути — `401 E_AUTH` без заголовка `X-Telegram-Init-Data` (guard уже работает, тестовый вектор в harness).

**UI/design obligations.** Нет UI. Статика-заглушка `web/index.html` (один `<h1>`) — только чтобы проверить раздачу; настоящий shell — W5.

**Menu-button wiring (единственная задача про URL, D1).** Если `cfg.miniUrl !== ''` — один вызов `bot.api.setChatMenuButton` на каждый id из `cfg.allowedChatIds` (`menu_button: { type: 'web_app', text: 'App', web_app: { url: cfg.miniUrl } }`), ошибка только в лог. Метод верифицирован: `bot.api.setChatMenuButton` существует в grammY-типах (R1 §0). `miniUrl === ''` → skip SILENTLY, одна строка в лог. URL приходит извне (env), код не знает про Tailscale/Cloudflare.

**Acceptance criteria.**
1. Сервер на тестовом порту отвечает `GET /health` JSON с `ok:true` за < 50 мс.
2. Запрос без `X-Telegram-Init-Data` на `GET /api/health` возвращает `401 {"error":"E_AUTH"}` (guard активен до появления API).
3. Поддельный `initData` (неверный `hash`) → `401`; верный HMAC, но `user.id` не из `ALLOWED_CHAT_IDS` → `403`; `auth_date` старше 24 ч → `400 E_STALE` (три вектора в harness, токен тестовый, не боевой).
4. Сравнение хеша — `crypto.timingSafeEqual` (grep по `src/miniapp/http.ts` находит `timingSafeEqual`, НЕ находит сравнение секрета через `===`).
5. Два запущенных процесса: второй падает на pid-lock с `E_ALREADY_RUNNING` в логе, polling не дублируется.
6. `MINIAPP_URL` пусто → старт без ошибок, в логе одна строка `menu-button: skipped (no MINIAPP_URL)`; задано → один вызов `setChatMenuButton` на chat (fake Api считает вызовы).
7. Heartbeat обновляется каждые ≤ 35 с; kill процесса → heartbeat stale (harness читает файл дважды).
8. Новая runtime-зависимость отсутствует (`package.json:11` — только `better-sqlite3`, `grammy`).

**Gates.** `npx tsc --noEmit`; `npm run build`; `node work/verify-w1-http.mjs` (ожидается ≥ 14 assertions). НЕ запускать `npm run dev`/`start`, НЕ читать `.env`, НЕ вызывать Bot API.

**Harness requirements.** Офлайн, без Telegram-токена: импортирует собранный `dist/miniapp/http.js` с тестовым конфигом (порт 0/ephemeral, тестовый `BOT_TOKEN='test'`); HMAC-векторы считаются тем же `node:crypto`; temp-dir для heartbeat.

**Risks and cheapest mitigation.** Порт занят (другой софт на 8080) → env `MINIAPP_PORT` + понятная ошибка `E_PORT_BUSY`, не молчание. Windows Firewall режет слушатель → слушать `127.0.0.1` явно, не `0.0.0.0` (v0.5: same-host, туннель смотрит на localhost).

**Rollback.** Удалить вызов старта сервера + `src/miniapp/http.ts`; бот продолжает long polling без изменений (точка отката — один коммит).

**Owner phone checks.**
1. В логе после рестарта видна строка `я жив` в чате (как раньше) — бот не сломан.
2. (Если задана `MINIAPP_URL`.) Кнопка меню у бота открывает пустую страницу-заглушку.

### W2. Durability — approvals, plans, drafts, running-state в SQLite

**Goal.** Всё, что сегодня живёт в памяти (`src/core/approvals.ts:2`, `src/core/queue.ts:66–73`, `src/core/router.ts:80`), переезжает в SQLite (§4.2) и становится читаемым для API: таблицы `approvals`, `drafts`, `skill_pins`, колонки `tasks.plan_origin/plan_reworks/rev`.

**Why now.** Mini App обязана видеть pending approval и parked plan после рестарта; без этого кнопка «разрешить» отвечает «нечего подтверждать» (R3 §3.4, риск #7 — гарантированный провал без этой волны). Делается ДО API (W4), чтобы эндпоинты читали durable-источник сразу.

**Depends on.** W1 (порядок; технически независима, но durability раньше API).

**Files to add.**
- `work/verify-w2-durable.mjs`.

**Files to modify.**
- `src/storage/db.ts:80` — `CREATE TABLE IF NOT EXISTS approvals/drafts/skill_pins` + `addColumn` для `tasks`: `title`, `model`, `project`, `skills_used`, `rev`, `plan_origin`, `plan_reworks` (паттерн `src/storage/db.ts:123`; интерфейс `TaskRow` расширить, `src/storage/db.ts:17`).
- `src/core/approvals.ts:2` — durable `requestApproval/resolveApproval/hasApproval` поверх таблицы `approvals` (in-memory Map остаётся fast-path уведомлений текущего runner, источником истины становится БД).
- `src/core/queue.ts:66` — `planWaiting/planTurns/planOrigin/planRounds` дублируются в `tasks` (`awaiting_plan` + `plan_text` уже durable: `src/core/queue.ts:297`; добавить запись `plan_origin/plan_reworks` в `parkPlan`, `src/core/queue.ts:171`); boot восстанавливает `planWaiting` из строк `awaiting_plan`.
- `src/core/queue.ts:179` — `cancel` резолвит durable approval/plan/task в том же приоритете.
- `src/core/router.ts:80` — `pendingFiles`: TTL-очистка (24 ч) + пометка принадлежности (полного переноса в БД НЕ требуется — файлы уже на диске в `<workdir>/inbox`).

**Data/DB changes.** §4.2 (таблицы `approvals/drafts/skill_pins`, 7 новых колонок `tasks`). Существующая БД мигрирует без потерь; даунгрейд не поддерживается (только вперёд).

**API changes.** Нет новых HTTP-endpoint (W4). Внутренний контракт: `Store.createApproval/resolveApproval/pendingApproval(chatId)`, `Store.createDraft/confirmDraft/discardDraft`, `Store.bumpRev(taskId)`.

**UI/design obligations.** Нет.

**Acceptance criteria.**
1. `approvals` переживает рестарт: создать pending, закрыть Store, открыть заново — `pendingApproval(chatId)` возвращает его.
2. `resolveApproval(chatId, false)` после рестарта резолвит promise текущего runner (мост память↔БД работает).
3. Parked plan переживает рестарт: `awaiting_plan` + `plan_text` + `plan_origin` читаются, `approvePlan` после рестарта запускает задачу с origin-промптом.
4. Rework-счётчик durable: два rework → третий вызов возвращает `null` и запускает задачу (MAX 2, `src/core/queue.ts:343`).
5. Каждая смена статуса задачи bump'ает `tasks.rev` монотонно (+1, без пропусков назад).
6. Старая БД (без новых колонок — fixture без них) открывается и мигрирует: `PRAGMA table_info(tasks)` содержит все 7 колонок, старые строки на месте.
7. Двойной `resolveApproval` одного id → второй раз `false` (single-use, как `take` в `src/telegram/nonce.ts:89`).
8. Просроченные approvals/drafts (`created_at` старше 24 ч) не резолвятся (`E_EXPIRED`), sweep при чтении.

**Gates.** `npx tsc --noEmit`; `npm run build`; `node work/verify-w2-durable.mjs` (≥ 18 assertions, temp-БД в `os.tmpdir`).

**Harness requirements.** Без бота/сети: напрямую `Store` + `TaskQueue` с fake `Responder` (как существующие `work/verify-*.mjs`); рестарт = `store.close()` + `new Store(samePath)`; fixture старой БД собирается CREATE без новых колонок.

**Risks and cheapest mitigation.** Гонка «кнопка в чате + кнопка в Mini App одновременно» → single-use resolve в одной транзакции (`UPDATE … WHERE status='pending'` + проверка `changes===1`); проигравший получает `E_RESOLVED`.

**Rollback.** Откат коммита; новая БД на старом коде игнорирует лишние таблицы/колонки (forward-only это допускает).

**Owner phone checks.**
1. Чат-флоу не изменился: `/code` → план → «Запустить» работает как раньше.
2. Рестарт бота с висящим approval: после `я жив` кнопка/`/approve` всё ещё резолвит команду (раньше — «нечего подтверждать»).

### W3. Task engine — снапшоты git, changed files, diffs, caps

**Goal.** Задача фиксирует git-снапшот до/после выполнения; Mini App показывает «изменено BY THE TASK»: список файлов, per-file unified diff, `+N −N`; caps для огромных diffs; graceful-деградация вне git-репо.

**Why now.** Самое большое белое пятно (R3 §2: размер L, переиспользовать нечего). Должно быть готово ДО W4 (API отдают `task_files`) и не зависит от UI.

**Depends on.** W2 (`tasks.rev`, `git_*` колонки из §4.2).

**Files to add.**
- `src/miniapp/diff.ts` — `snapshotGit(workdir): {sha, porcelain} | null`, `collectTaskFiles(before, after, workdir): FileChange[]`, `unifiedDiff(workdir, path, cap): {diff, truncated, binary}`; все вызовы `execFileSync('git', …)` с timeout 15 с, `windowsHide:true`.
- `work/verify-w3-diff.mjs`.

**Files to modify.**
- `src/storage/db.ts:80` — таблица `task_files` (§4.2: `task_id, path, added, removed, diff, truncated`).
- `src/core/queue.ts:226` — `execute`: снапшот ДО (после `setTaskStatus(running)`, `src/storage/db.ts:217`), снапшот ПОСЛЕ (перед `setTaskStatus(done)` / в `catch` тоже — даже упавшая задача могла поменять файлы); запись `task_files` + `git_before/git_after/git_base_sha`; `title` = первые 60 символов prompt; `model/project` = значения сессии на старте; bump `rev`.
- `src/core/queue.ts:311` — рядом с `setTaskCost`: запись `skills_used` (JSON pinned skills из submit; извлечение реальных `tool_use` из JSONL — если дёшево в том же проходе, иначе pinned; R3 §4c).

**Data/DB changes.** Таблица `task_files` + колонки `tasks.git_before/git_after/git_base_sha/title/model/project/skills_used` (§4.2).

**API changes.** Нет HTTP (W4). Внутренний: `Store.saveTaskFiles(taskId, files)`, `Store.taskFiles(taskId)`, проекция с `files_summary`.

**Caps (жёстко).** Per-file diff ≤ 200 строк + трейлер `…ещё N строк`; файл > 1 МБ или бинарный (NUL-байт в первых 8 КБ) — только имя + `binary:true`; всего на задачу ≤ 50 файлов в БД (дальше — только счётчики); `git diff` timeout 15 с → `truncated:true`.

**UI/design obligations.** Нет UI. Задел под W6: `diff` хранится сырым unified-текстом (рендер на клиенте), `+N/−N` уже посчитаны сервером.

**Acceptance criteria.**
1. Temp git-репо + mock-провайдер, меняющий 2 файла: после `done` в `task_files` ровно 2 строки с верными `path/added/removed`.
2. `unifiedDiff` на изменённый файл начинается с `--- a/` и содержит `@@` hunk-заголовок; файл 500+ строк → `truncated:1` и трейлер `…ещё N строк` с верным N.
3. Бинарный файл (png-заголовок) → `binary:true`, `diff IS NULL`.
4. Не-git директория: задача завершается `done`, `git_base_sha IS NULL`, `task_files` пусто (флаг `no_git` выводим).
5. Упавшая задача (`error`) всё равно имеет снапшоты и `task_files` (сбор в `finally`-ветке).
6. Файлов > 50 в одной задаче: в БД 50 строк + `changed_n` полное число (счётчик отдельно).
7. `git` отсутствует в PATH (harness подменяет PATH на пустой dir): задача `done`, `no_git`, процесс жив.
8. `title` = prompt до 60 символов без разрыва суррогатной пары; `rev` bump'нут ≥ 3 раз за жизненный цикл (pending→running→done).

**Gates.** `npx tsc --noEmit`; `npm run build`; `node work/verify-w3-diff.mjs` (≥ 16 assertions, temp git-репы, mock-провайдер; если `git` нет на машине — harness сообщает `SKIP` с причиной, не фейлит молча).

**Harness requirements.** Temp-директории, `better-sqlite3` в файле, fake `Responder` (streamStart возвращает no-op handle), никакого `provider.run` кроме mock; время снапшота измеряется (< 2 с на репо из 500 файлов).

**Risks and cheapest mitigation.** `git status` медленный на огромном workdir (node_modules) → timeout 15 с + `truncated` вместо зависания; diff никогда не блокирует `pump` дольше timeout (R3 риск #6: только короткие вызовы).

**Rollback.** Откат коммита; колонки/таблица остаются (forward-only), старый код их игнорирует.

**Owner phone checks.**
1. Невидимо в чате: ответы агента приходят как раньше (diff-сбор не меняет текст).
2. (Проверяется полностью в W5 Tasks → details; здесь — только что бот жив после задач в git-репо.)

### W4. API surface — все 30 endpoints + cheap polling

**Goal.** Все read + mutating endpoints §5 поверх Store/TaskQueue; `listProjects` вынесен из telegram-слоя в shared; каждый запрос за guard W1; polling дешёвый (`since_rev`/304).

**Why now.** W1 дал guard, W2 — durable-источники, W3 — файлы/diff; W4 склеивает их в контракт, на который W5–W7 пишут UI. Последняя backend-волна перед фронтендом.

**Depends on.** W1, W2, W3.

**Files to add.**
- `src/miniapp/api.ts` — все хендлеры §5 (чистые функции `(deps, auth, req) → {status, body}`; транспорт отдельно в `http.ts`).
- `src/core/projects.ts` — переезд `listProjects` из `src/telegram/callbacks.ts:85` (единственный новый core-файл, обоснован выносом из telegram-слоя; callbacks и api оба его импортируют).
- `work/verify-w4-api.mjs`.

**Files to modify.**
- `src/miniapp/http.ts` — роутинг 30 endpoint + `304` (`since_rev`), JSON-ошибки `E_*`, лимиты тела (POST ≤ 64 КБ, иначе `413`).
- `src/telegram/callbacks.ts:85` — заменить локальный `listProjects` импортом из `core/projects.ts` (поведение то же, тесты те же).
- `src/core/queue.ts:89` — `submit` принимает `skills: string[]` (запись в draft/task, препенд тел SKILL.md в prompt — R3 §4b путь ①).
- `src/config.ts:5` — БЕЗ изменений (проверка agent против `AGENT_IDS` уже есть).

**Data/DB changes.** Нет новых таблиц (используются W2). `PUT /api/settings` пишет через `updateSession` (`src/core/sessions.ts:43`).

**API changes.** Все 30 endpoint §5.1. Правила: chat_id только из проверенного `user.id`; `POST /api/tasks` и `confirm` соблюдают «одна задача на чат» (занято → задача встаёт в существующую очередь `pump`, `src/core/queue.ts:210`, ответ `queued` — НЕ новая очередь); `stop` повторяет приоритет `cancel` (`src/core/queue.ts:179`).

**UI/design obligations.** Нет UI. Но контракт уже несёт дизайн-ограничения: `abs` всегда полный путь (W6), `elapsed_s` серверный (не клиентские часы), `title` ≤ 60 символов.

**Acceptance criteria.**
1. Матрица auth: выборка read-эндпоинтов × {без заголовка → 401; плохой hash → 401; чужой user.id → 403; протухший auth_date → 400} — harness гоняет все четыре кейса на каждом read-эндпоинте.
2. `POST /api/drafts → confirm` создаёт задачу, видимую в `GET /api/tasks/:id` со статусом `pending/running`; `discard` → повторный `confirm` даёт `404/410`.
3. `stop` running-задачи → статус `cancelled`, ответ `{"stopped":"task"}`; `stop` без активного → `404 E_NO_TASK`.
4. `retry` создаёт НОВЫЙ id с тем же prompt; `continue {text}` — новый id с новым prompt в том же project.
5. `approve/rework` поверх `awaiting_plan`: approve → `started|queued`; третий rework после 2 раундов → `410 E_ROUNDS_OUT` + задача запущена.
6. `allow/deny` несуществующего approval → `404`; повторный resolve → `410 E_RESOLVED`.
7. `?since_rev=<current>` → `304` с пустым телом; после bump `rev` → `200` с новым `rev`.
8. `PUT /api/settings {agent:"nope"}` → `400 E_BAD_ARG`; проект вне `ALLOWED_ROOTS` → `400`; смена agent роняет `agent_session_id` (`getSession().agent_session_id === null`).
9. `GET /api/files?dir=../../..` → `403 E_PATH_DENIED` (guard `resolveOutboundDir`, `src/core/files.ts:357`); `preview` бинарника → `{"binary":true}`; `download` отдаёт `Content-Disposition: attachment` + лимит `MAX_OUTBOUND_BYTES` (`src/core/files.ts:15`).
10. Нагрузка: 100 последовательных `GET /api/tasks/:id?since_rev=` выполняются < 2 с суммарно на локальной SQLite.

**Gates.** `npx tsc --noEmit`; `npm run build`; `node work/verify-w4-api.mjs` (≥ 40 assertions; in-process сервер на ephemeral-порту, тестовый BOT_TOKEN, temp-БД, mock-провайдер).

**Harness requirements.** Реальный HTTP через `node:http` (не прямые вызовы хендлеров — проверяется и транспорт); `initData`-векторы собираются `node:crypto` по формуле R1 §A.3; chat/user — тестовые id, НЕ из `.env`.

**Risks and cheapest mitigation.** Раздувание JSON (`recent?limit=999999`) → clamp `limit` 1..100 + POST-лимит 64 КБ. Блокировка event loop длинным SELECT → все запросы точечные по индексам (`idx_tasks_chat`, `src/storage/db.ts:119`); `recent` всегда с `LIMIT`.

**Rollback.** Откат коммита; эндпоинты исчезают, бот продолжает работать (API аддитивен, чат его не использует).

**Owner phone checks.**
1. Невидимо: чат работает как раньше (API никого не трогает).
2. (Техническая, с ПК.) `curl` с валидным `initData` на `GET /api/tasks/current` возвращает JSON текущей задачи.

### W5. Mini App shell + Home + Tasks — 4 таба, токены, nav, темы, perf-лестница

**Goal.** Работающий Mini App shell: 4 таба, bottom nav с сильнейшим стеклом, safe-area, theme wiring (dark+light+custom, D4), perf-лестница Auto/Full/Lite (D3), затем экраны Home (текущая задача + stop/details) и Tasks (recent + stop/retry/continue/details) на polling W4.

**Why now.** Первый видимый результат; все backend-зависимости (W1–W4) закрыты. Files/More идут после — shell и паттерны (polling, theme, perf) задаются здесь один раз.

**Depends on.** W1, W4 (W2–W3 транзитивно через W4).

**Files to add.**
- `web/index.html` — shell: `<script src="https://telegram.org/js/telegram-web-app.js?63">` в `<head>` первым (R1 §A.1 п.6), 4 таба, `.glass-nav` ровно один на экран, `max-width: 560px`.
- `web/tokens.css` — verbatim-копия `.opencode/skills/telegram-liquid-glass/references/tokens.css` + проектные классы (`.btn-primary`, `.nav-item`, `.status-hl`, `.progress-bar`, `.skeleton` — ровно 5 accent-групп, AC1).
- `web/app.js` — boot: `tg.ready()` → `tg.expand()` первым делом; `themeChanged`/`viewportChanged(isStateStable)`/`safeAreaChanged`/`contentSafeAreaChanged` wiring (SKILL.md «Minimal boot wiring»); `disableVerticalSwipes()`; tab-навигация instant 0 мс; poller (актив 1–2 с, idle 10–15 с, пауза при `isActive===false`).
- `web/lib/perf.js`, `web/lib/theme.js`, `web/lib/api.js` — ЧИСТЫЕ модули без DOM (Autoэвристика, `relLum`/contrast/flat, fetch-обёртка с `X-Telegram-Init-Data`): импортируются и в `app.js`, и в harness через node.
- `web/screens/home.js`, `web/screens/tasks.js` — Home + Tasks.
- `work/verify-w5-shell.mjs`.

**Files to modify.** Нет в `src/` (фронтенд аддитивен). `src/miniapp/http.ts` — только раздача `web/` как статики (content-type по расширению, `Cache-Control: no-cache` на `app.js`, иначе stale UI после деплоя).

**Data/DB changes.** Нет. `perf_choice` (`auto|full|lite`) — `Telegram.WebApp.CloudStorage` primary + `localStorage` fallback (ключ `perf_choice`), НЕ серверная настройка.

**API changes.** Нет новых. Используются: `GET /api/tasks/current`, `GET /api/tasks/recent`, `GET /api/tasks/:id?since_rev=`, `POST /api/tasks/:id/{stop,retry,continue}`.

**UI/design obligations (замороженный скилл, D2/D4/D5/D6).**
- Строить ТОЛЬКО из `references/tokens.css` (single source); копипаст дословный, значения не переизобретать. Ревьюер сверяет diff `web/tokens.css` vs скилла.
- Тиры: контент (task rows) — `.content-card`/`.list-row`, flat, никакого `backdrop-filter` (C1); floating `[Stop][Details]` — `.glass-float`, max один на экран (C3); nav — `.glass-nav` + `.glass-tex` + `--reactive`, ровно один (C2).
- Accent ровно в 5 местах (AC1): `.btn-primary`, `.nav-item[aria-selected="true"]`, `a`, `.status-hl`, `.progress-bar`. Шестое использование — провал.
- `readThemeTokens()` на boot + `themeChanged`: `data-scheme`, `data-flat="1"` при `relLum(section_bg) > 0.90`, hint-guard 4.5:1 (`references/theme.md` F1–F3).
- Perf: `readTelegramPerfClass()` (UA tail, optional) + эвристика (`deviceMemory/hardwareConcurrency/devicePixelRatio/frame-budget`) + reduced-motion → `data-perf="full|reduced|lite"`; `Telegram.WebApp.performance_class` НИКОГДА не читать (UNVERIFIED, `references/performance.md` §0).
- Motion: ≤ 250 мс кроме open 420/sheet 300/skeleton 1200-single-pass (D12); только `transform/opacity` (+`width` индикатора nav 240 мс); tab switch 0 мс; без stagger; `prefers-reduced-motion` → мгновенно.
- Checklist: прогнать `references/checklist.md` P0 + D1–D20 + PF1–PF3 + LT1–LT3 + T1–T3; P0 (backdrop-root pre-flight) — первым.
- Refraction — только 8-ингредиентная SIMULATION (D2); никакого `feDisplacementMap`/`filter:url()` (D5).

**Acceptance criteria.**
1. `web/tokens.css` содержит дословные блоки скилла (harness сравнивает нормализованный текст tier-классов `.glass-nav/.glass-float/.glass-capsule/.content-card/.mono` — 0 расхождений).
2. Grep-провалы отсутствуют: `hue-rotate|invert(|sepia|grayscale|drop-shadow|url\(` в `backdrop-filter`; `feDisplacementMap|feTurbulence|filter:\s*url\(`; `@font-face|fonts.google`; `infinite` в app CSS; `blur\(([2-9][9-9]|[3-9]\d)` (>28px).
3. Ровно один `.glass-nav` на экран; `backdrop-filter`-элементов на первом экране ≤ 3 (harness считает по CSS-классам в `index.html` + `screens/*.js` шаблонах); вложенность стекла ≤ 2.
4. `autoPerf()` unit-тесты в harness: UA `…; LOW)` → `lite`; `AVERAGE` → `reduced`; `prefers-reduced-motion` → `lite`; слабый heuristic (score ≥ 3) → `lite`; `performance_class` не читается (grep `performance_class` в `web/` — только комментарий со словом UNVERIFIED).
5. `readThemeTokens()` unit-тесты: `section_bg #FFFFFF` → `data-flat="1"`; hint `#C8C8C8` на белом → `hintOk=0` (fallback `text_color` 0.72); custom theme (произвольный hex) не роняет функцию.
6. Poller: при `running` интервал 1000–2000 мс с `since_rev`; при idle 10–15 с; `304` не перерисовывает DOM (harness: stub `fetch` считает запросы, stub DOM — нет перерисовки на 304).
7. Home показывает running-задачу (title, status, `elapsed_s` серверный, `.metric tabular-nums`), кнопки Stop/Details; Stop → `showConfirm` → `POST stop`; нет активной → empty-state + recent.
8. Tasks: recent-список (title/agent/mode/status/elapsed/cost), tap → details (status, cost, `skills_used`, files summary `changed_n +N −N`), кнопки stop/retry/continue работают против mock API.
9. `tg.ready()` вызывается до первого рендера; `expand()` на boot; `viewportChanged` трогает `--tg-viewport-stable-height` только при `isStateStable`; nav pinned к stable height, `margin-bottom: calc(var(--safe-bottom) + 8px)`.
10. Lite-путь: `data-perf="lite"` + заблокированный `backdrop-filter` → UI полностью usable (flat + opacity ≤ 150 мс); то же для `reduced` и `data-flat="1"` (ручная проверка на телефоне, чекбоксы в отчёте).

**Gates.** `npx tsc --noEmit` (web не в tsconfig — см. риск); `npm run build`; `node work/verify-w5-shell.mjs` (≥ 30 assertions: node-импорт `web/lib/*`, CSS-grep, HTML-инвентаризация); reviewer прогоняет checklist вручную + phone checks.

**Harness requirements.** Без браузера/Telegram: `web/lib/*.js` — чистый ESM, импортируется в node ≥ 22; CSS/HTML-проверки — чтение файлов + regex (детерминировано, без DOM). `telegram-web-app.js` НЕ загружается.

**Risks and cheapest mitigation.** `web/*.js` вне `tsc` (без бандлера нет типов) → harness + reviewer вместо компилятора; правило «не больше 5 accent-селекторов» ловится grep, а не типами. `animation-timeline` UNVERIFIED в WebView → обязательная `@supports`-ветка уже в токенах (скилл), harness проверяет её наличие.

**Rollback.** Откат коммита; `web/` исчезает, `GET /` отдаёт заглушку W1, API/бот не затронуты.

**Owner phone checks.**
1. Открыть Mini App: с первого экрана читается как Telegram Liquid Glass (сильное стекло nav, блик, пружина индикатора), а не плоская страница.
2. Home: running-задача видна, elapsed тикает, Stop останавливает (подтверждение нативным `showConfirm`).
3. Tasks: recent открывается, details показывает cost/skills/changed files summary.
4. Переключить тему Telegram (dark→light→custom): UI перестраивается без перезагрузки, всё читаемо.
5. More → Performance: Auto/Full/Lite переключаются мгновенно, выбор переживает перезапуск.
6. На слабом Android (или принудительно Lite): всё flat, но полностью usable.

### W6. Files + diff viewer — explorer, абсолютные пути, preview, unified diff

**Goal.** Таб Files: explorer по проекту (всегда видимый полный абсолютный путь, copy path), preview (cap 64 КБ), unified diff view per-file и per-task. Никакого стекла над кодом/диффом (D6, D6-чеклист).

**Why now.** После shell (W5): паттерны экранов заданы, API файлов (W4) и движок diff (W3) готовы. До More (W7) — Files независим от настроек.

**Depends on.** W4, W5.

**Files to add.**
- `web/screens/files.js` — explorer + preview + diff view.
- `work/verify-w6-files.mjs`.

**Files to modify.** `web/app.js` (роут таба), `web/tokens.css` (только если нужны классы — новые классы БЕЗ `backdrop-filter`, иначе C1-провал).

**Data/DB changes.** Нет.

**API changes.** Нет новых. Используются: `GET /api/files?dir=`, `GET /api/files/preview?path=`, `GET /api/files/download?path=`, `GET /api/files/diff?path=`, `GET /api/tasks/:id/files`, `GET /api/tasks/:id/diff?path=`.

**UI/design obligations.**
- Код/diff/logs — `.mono` solid, НИКОГДА `backdrop-filter` (D6 чеклиста; пересечение rect стекла с rect кода = провал).
- Task rows/file rows — flat `.list-row`; цифры размеров — `.metric tabular-nums`.
- Copy path — нативный clipboard + `HapticFeedback.selectionChanged`; Download — `Telegram.WebApp.downloadFile` (URL + `file_name`), fallback — `openLink`.
- Diff-раскраска: `+`/`−` строки — tint из `--accent-text`/`--danger` ТОЛЬКО как status highlights (входит в 5 accent-мест, нового места не создаёт); фон строк — solid.

**Acceptance criteria.**
1. Explorer показывает `abs` проекта всегда видимым (harness: шаблон содержит элемент с `data-testid="abs-path"`, API отдаёт `abs`).
2. Copy path копирует EXACT `abs + rel` (harness: stub clipboard, сверка строки побайтово).
3. Preview файла 200 КБ → показан head 64 КБ + бейдж `truncated` + размер `.metric`; бинарник → бейдж `binary`, без попытки рендера текста.
4. `dir=../../..` из UI невозможен (ссылки строятся только из `entries[].rel` API; ручной ввод пути в UI отсутствует).
5. Diff view: `+N −N` из API совпадают с числом `.diff-add`/`.diff-del` строк в рендере; `truncated` показывает `…ещё N строк`; binary — только имя.
6. Per-task changed files (из Tasks → details → files) и per-path diff (Files → diff) используют один компонент рендера (grep: функция `renderDiff` ровно одна).
7. Grep: в `files.js` и его CSS нет `backdrop-filter` (D6); нет `width/height/top/filter` в transition (D15).
8. Навигация Back: `BackButton` Telegram ведёт Files-вглубь → назад (harness: stub `Telegram.WebApp.BackButton`, проверка подписки `onEvent('backButtonClicked')` — НЕ ПРОВЕРЕНО как имя события? Имя выведено из R1-таблицы методов `BackButton`; если в W5 выбран другой механизм — этот критерий переформулировать под него, зафиксировать в Decision log).

**Gates.** `npx tsc --noEmit`; `npm run build`; `node work/verify-w6-files.mjs` (≥ 18 assertions: импорт `screens/files.js` невозможен без DOM — проверять через regex-инвентаризацию + `web/lib/api.js` контракт + mock-API прогон pure-функций парсинга diff).

**Harness requirements.** Офлайн: mock `fetch` отдаёт fixture `task_files`/preview/diff (включая binary/truncated/no_git); pure-функции (parse unified diff → строки) живут в `web/lib/diff.js` (новый чистый модуль — оправдан тестом) и unit-тестируются в node.

**Risks and cheapest mitigation.** Diff на 10k строк вешает WebView → cap уже серверный (W3) + клиент рендерит первые 200 строк, остальное по кнопке «показать ещё» (чанками по 200). `downloadFile` требует HTTPS-URL + CORS-заголовки (R1 §A.5) — заголовки введены в W4 п.22, harness W4 их проверил.

**Rollback.** Откат коммита; таб Files исчезает из nav (3 таба), API остаются.

**Owner phone checks.**
1. Files: виден полный путь проекта, папки открываются, preview читается, copy path вставляет точный путь.
2. Diff задачи: цвета строк спокойные (не неон), `+N −N` совпадают с деталями задачи.
3. Скачивание файла через нативный промпт работает.
4. Код нигде не «под стеклом» — текст резкий, не размыт.

### W7. More + task confirmation card + Skills — пикеры, статус, настройки, draft, skills

**Goal.** Таб More (agent/model/project, github minimal, bridge status, performance, settings, Reset session), pre-run confirmation card (prompt+agent+model+project+attachments+skills, Run/Edit) и Skills (list/pin/auto/used).

**Why now.** Последний функциональный таб; использует всё: pickers/settings/skills API (W4), perf wiring (W5). Confirmation card закрывает проблему «текст сразу запускает» (R3 §2: сейчас текст → сразу `submit`, `src/core/router.ts:64` — НЕ ПРОВЕРЕНО построчно, факт принят из R3).

**Depends on.** W4, W5.

**Files to add.**
- `web/screens/more.js` — More + settings + performance + bridge status + skills list.
- `web/screens/confirm.js` — confirmation card (draft flow).
- `work/verify-w7-more.mjs`.

**Files to modify.** `web/app.js` (роуты), `web/screens/home.js` (кнопка «Новая задача» → confirm card; пресеты `/review|/test|/fix` как чипы-шаблоны — MOVE из §9 п.7).

**Data/DB changes.** Нет (таблицы `drafts/skill_pins` из W2).

**API changes.** Нет новых. Используются: `GET /api/pickers/{agents,models,projects}`, `GET+PUT /api/settings`, `GET /api/health`, `GET /api/cost?period=`, `GET /api/skills`, `PUT /api/skills`, `POST /api/drafts`, `POST /api/drafts/:id/{confirm,discard}`, `GET /api/history?day=`.

**UI/design obligations.**
- Settings/pickers — flat content (C1); Performance — `Auto|Full effects|Lite`, default Auto, синхронный switch без reload (PF3).
- Confirmation card — `.glass-elevated` sheet (transient, 35% scrim — единственный кейс elevated вне nav/float); present 300 мс `--spring-sheet`, dismiss `--ease-in`.
- Agent/model/project чипы показывают ТЕКУЩИЕ значения сессии; смена — до Run (пишется в draft, затем в settings).
- Skills UI: список (name+description+source), pin-toggle, auto-mode toggle, в draft — выбранные skills, в task details — `skills_used`. Отдельного Skills-таба НЕТ (non-goal).
- Github minimal: только ссылки (открыть PR/CI через `openLink` в ответ на жест) — никакого poller в Mini App.

**Acceptance criteria.**
1. More показывает agent/model/project из `GET /api/settings`; смена agent → `PUT` → бейдж обновлён; `agent_session_id` сброшен (проверяется через API-эффект: следующая задача стартует fresh — harness сверяет `agentSessionId` семантику через mock).
2. Bridge status: все 5 сигналов (`telegram/agent/github/whisper/db`) + `pending` + `stale_s`; tap по строке → reason-строка (harness: fixture health с `whisper:"missing"` → виден reason).
3. Performance: три опции, default Auto; выбор пишется в `CloudStorage` (stub) + `localStorage`; switch — синхронный `dataset.perf` без reload (harness: stub document).
4. Reset session (`/new`-эквивалент через `PUT settings` или dedicated — фиксировать в коде W7): подтверждение `showConfirm`,後は бейдж сессии сброшен.
5. Confirmation card: поля prompt/agent/model/project/attachments/skills; Run → `confirm` → task_id; Edit → возврат с сохранённым текстом; пустой prompt → Run disabled (harness: pure-логика `validateDraft` в `web/lib/draft.js`).
6. Пресеты: чипы Review/Test/Fix подставляют role-префикс из `src/core/presets.ts:14` (строка сверяется с серверным текстом — harness читает `dist/core/presets.js`? presets — серверный модуль; клиент хранит только ИМЕНА пресетов, текст подставляет сервер по `mode/preset` — проверить, что клиент НЕ дублирует тексты пресетов: grep `files to touch` в `web/` пуст).
7. Skills: list рендерит name+description+source+pinned; pin-toggle → `PUT /api/skills`; auto-toggle сохраняется; task details показывает `skills_used[]` (harness на mock-API).
8. Chat-поверхность не выросла: `SCOPE` в `src/telegram/keyboard.ts:15` без новых скопов (grep `SCOPE.` — только approve/agent/model/project/plan/update до W8).
9. Cost-виджет: `GET /api/cost?period=week` рендерит total/priced/unpriced + top agents `.metric`.

**Gates.** `npx tsc --noEmit`; `npm run build`; `node work/verify-w7-more.mjs` (≥ 22 assertions).

**Harness requirements.** Офлайн: mock-API fixture покрывает pickers/settings/health/cost/skills/drafts; pure-модули `web/lib/draft.js` (+ `web/lib/diff.js` из W6) unit-тестируются в node; DOM-шаблоны — regex-инвентаризация (accent-селекторы ≤ 5 — пересчёт AC1 по всему `web/`).

**Risks and cheapest mitigation.** Рассинхрон draft (два устройства) → draft single-open на чат (`open` draft один; новый `POST /api/drafts` протухает старый в `expired`). Клиент показывает stale pickers (model cache 6 ч) → бейдж `cached` из API + pull-to-refresh.

**Rollback.** Откат коммита; More сводится к заглушке, confirm card отсутствует (прямой `POST /api/tasks` остаётся для отладки).

**Owner phone checks.**
1. More: смена agent/model/project — два тапа, без клавиатур-спама в чате.
2. Новая задача: текст → карточка подтверждения (всё видно) → Run → задача бежит; Edit не теряет текст.
3. Skills: pin `gortex-debug` → задача с ним → в details видно «used skills».
4. Performance и bridge status работают; Reset session с подтверждением.
5. Пресеты Review/Test/Fix — чипы, подставляют шаблон.

### W8. Cut + wiring + docs — удалить по cut-листу, зачистить клавиатуры, README, автозапуск

**Goal.** Репо приведено к целевому состоянию: удалены команды/провайдеры из cut-листа, убраны inline-клавиатуры, дублирующие Mini App, README + автозапуск + финальный gate всего репо.

**Why now.** Только после рабочей Mini App: удалять чат-поверхность раньше — значит оставлять владельца без управления. Финальная волна.

**Depends on.** W5, W6, W7 (вся Mini App зелёная).

**Files to add.** Нет (только правки + `work/verify-w8-cut.mjs`).

**Files to modify.**
- `src/core/router.ts:337` — `/start` текст: меню Mini App + 7 команд (`/ask /code /approve /cancel /new /start /help`).
- `src/core/router.ts:346` — `/help` урезать до kept-команд.
- `src/core/router.ts:299`, `:456` — удалить `/clone`; `:252`, `:333` — github-регистрации; `:388` — `/exec`; `:389` — `/sys` (health уехал в API); `:460`–`:472` — `/get /files /find /auto`(текстовый approve-алиас `/approve` KEEP, `:483`); `:511` — `/cost`; `:519` — `/update`; `:253`, `:265`, `:276`, `:286` — `/commit /pr /ci /watch`.
- `src/index.ts:50–52` — удалить регистрации cursor/cline/hermes; `:105` — удалить `startCiPoller`.
- `src/config.ts:5` — `AGENT_IDS` сузить до `['opencode','mock']`.
- Удалить файлы: `src/providers/cursor.ts`, `src/providers/cline.ts`, `src/providers/hermes.ts`, `src/gateway/fetchRunner.ts`, `src/core/exec.ts`, `src/core/update.ts`, `scripts/updater.cmd`, весь `src/github/` (+ `ciPoller`).
- `src/telegram/keyboard.ts:15` — `SCOPE` без `update` (+ удалить `updateConfirmKeyboard`, `:144`); agent/model/project клавиатуры удалить, оставить approve (`:27`) + plan (`:131`); `src/telegram/callbacks.ts:194,207,214,241` — соответствующие хендлеры удалить, approve (`:185`) + plan (`:131`) KEEP.
- `src/telegram/markdown.ts` — заморозить (комментарий `/** FROZEN — see PLAN-V05 W8 */`), содержимое не трогать.
- README.md — секции: что такое Mini App, 4 таба, деплой внешнего URL (Funnel primary / quick fallback / prod endpoint — БЕЗ привязки кода), `MINIAPP_PORT`/`MINIAPP_URL`, автозапуск Windows (schtasks, как раньше), голос-в-чате остаётся.
- `scripts/install-autostart.cmd` — обновить под Mini App (перезапуск бота тянет и HTTP-сервер — один процесс, отдельных шагов нет).

**Data/DB changes.** Нет (таблица `ci_watch` остаётся пустой; миграции не удаляют).

**API changes.** Нет. `GET /api/pickers/*` продолжают работать на `opencode+mock`.

**UI/design obligations.** Финальный прогон `references/checklist.md` по всему `web/` + P0 pre-flight; финальный подсчёт accent-селекторов (≤ 5); скрин-чек dark + light + custom + Lite на телефоне (владелец).

**Acceptance criteria.**
1. Grep-чистота: `cursor|cline|hermes|fetchRunner|ciPoller|updateConfirmKeyboard|/exec|/clone|/update` в `src/` — 0 совпадений (кроме README-истории и Decision log).
2. `SCOPE` содержит только `approve` + `plan` (agent/model/project/update клавиатуры удалены, pickers живут в Mini App) — reviewer сверяет точный состав.
3. `/help` выводит ≤ 7 команд; удалённые команды отвечают `E_UNKNOWN` или хелпом (не выполняют).
4. Существующие харнессы зелёные: `work/verify-render.mjs`, `work/verify-tables.mjs`, `work/verify-dot.mjs` + все `verify-w1…w7` (регрессия отсутствует).
5. `npx tsc --noEmit` чисто, `npm run build` проходит, удалённые импорты нигде не висят (tsc это доказывает).
6. README содержит: архитектуру (ASCII §4), env-таблицу (`MINIAPP_PORT`, `MINIAPP_URL` + правило skip), деплой-варианты (Funnel/quick/prod, код не знает о туннеле), автозапуск, голос-в-чате, perf-режимы, ссылку на скилл как дизайн-источник.
7. `package.json:11` dependencies — по-прежнему только `better-sqlite3`, `grammy` (0 новых runtime-зависимостей за все 8 волн).
8. Production-папка `D:\projects\tg-agent-bridge` на `main` не тронута агентами (проверяет оркестратор, не implementer).

**Gates.** `npx tsc --noEmit`; `npm run build`; `node work/verify-w8-cut.mjs` (≥ 20 assertions: grep-инвентаризация + прогон всех старых харнессов); финальный reviewer verdict по всему репо.

**Harness requirements.** Офлайн grep-аудит (`src/`, `web/`, `package.json`) + запуск всех харнессов w1–w7 + render/tables/dot; отчёт — таблица PASS/FAIL по каждому.

**Risks and cheapest mitigation.** Удалённое оказалось нужно (владелец просит `/ci` назад) → всё в git-истории, возврат — один файл; `AGENT_IDS` расширяется одной строкой. Сломанный импорт после удаления → ловит `tsc` до merge (gate #1).

**Rollback.** Откат merge-коммита W8 целиком (волна — один коммит, см. §8).

**Owner phone checks.**
1. `/help` короткий; чат чистый: вопрос → ответ, `/code` → план → запуск.
2. Mini App: все 4 таба работают после cut (регрессии нет).
3. Кнопка меню открывает Mini App (при заданной `MINIAPP_URL`).
4. README читается с телефона (инструкция перезапуска понятна).

---

## 7. Dependency graph

```
W1 ──┬──▶ W2 ──▶ W3 ──╮
     │                ▼
     └─────────────▶ W4 ──▶ W5 ──┬──▶ W6 ──╮
                                 └──▶ W7 ──▶ W8
```

Критический путь: W1 → W2 → W3 → W4 → W5 → W7 → W8 (W6 висит параллельно W7, обе после W5; W8 ждёт обе). Параллельно ничего не выдаётся (оркестратор ведёт одну волну за раз), но граф показывает, что W6 и W7 независимы друг от друга — при срыве одной вторая не блокируется. W2 технически могла бы идти параллельно W1 (разные файлы, кроме `src/storage/db.ts` vs `src/index.ts` — пересечений нет), но порядок зафиксирован: guard и heartbeat раньше, чтобы W4 тестировалась на готовом транспорте.

---

## 8. Cross-cutting rules (наследуются каждой волной)

1. Один Telegram polling slot: production-папка `D:\projects\tg-agent-bridge` всегда на `main`, untouched. Инженер работает в worktree на своей ветке, НЕ в production-папке.
2. Никогда два инстанса: pid-lock с W1; бот рестартует ТОЛЬКО оркестратор, detached, с ожиданием 90 с после любого kill.
3. `src/gateway/types.ts` frozen: контракт `AgentId/AgentTask/AgentEvent/AgentResult/IAgentProvider` (`src/gateway/types.ts:1–53`) не меняется ни в одной волне.
4. No new runtime dependency: `package.json` dependencies остаются `better-sqlite3` + `grammy`. Проверяется в harness каждой волны.
5. No `npm run dev` / `npm run start` руками инженера; `.env` никогда не читается и не пишется агентами; секреты не коммитятся.
6. Gates обязательны до merge: `npx tsc --noEmit` + `npm run build` + wave-harness; assertion count — в отчёте волны.
7. Одна волна — один коммит (merge — squash при необходимости); статус §12 заполняет оркестратор.
8. Не выдумывать Bot API/WebApp members: только верифицированное R1 §A.4 (поля `initData…contentSafeAreaInset`, методы `ready()…openInvoice()`); `performance_class`, `BackgroundFill`, `showFilePopup`, `devicePixelRatio` как члены WebApp — запрещены.
9. Каждый wave-harness: офлайн, без сети, без Telegram-токена, с fake Api/Responder и temp-директориями/БД; `SKIP` с причиной вместо молчаливого фейла (пример: нет `git` на машине).
10. Существующие `work/verify-render.mjs`, `work/verify-tables.mjs`, `work/verify-dot.mjs` — не удалять, не ломать; W8 прогоняет их как регрессию.
11. **Любая волна с UI обязана использовать скилл `telegram-liquid-glass`.** Агент-инженер сначала вызывает skill tool с `id: telegram-liquid-glass` (или читает `.opencode/skills/telegram-liquid-glass/SKILL.md` и нужные `references/`), и только потом пишет разметку или CSS. Запрещено: переизобретать значения токенов, брать цифры из памяти, копировать дизайн-значения из R2 напрямую — R2 это исследование, источник истины для реализации только скилл. Запрещено создавать вторую копию токенов вне `web/tokens.css`. Ревьюер любой UI-волны обязан проверить факт вызова скилла и отсутствие расхождений `web/tokens.css` против `references/tokens.css`.
12. **Wave-харнессы обязаны быть закоммичены.** `work/` игнорируется (.gitignore: `work/*` + `!work/verify-w*.mjs`), поэтому каждый `work/verify-wN-*.mjs` коммитится в ветку волны. Причина: до W2 харнесс жил только в worktree и погиб вместе с ним — гейт «ничего не сломалось» оказался невыполнимым, и это обнаружил следующий implementer, а не оркестратор. Остальной скретч в `work/` остаётся неотслеживаемым. Х арнесс не должен содержать секретов и абсолютных путей машины (W2-ревью проверило: чисто).

---

## 9. Cut list (основание — R3 §5, сверено)

Принцип: Mini App делает лучше всё, что сегодня — кнопки-списки; чат остаётся вводом + ответами + клавиатурами approve/plan (+ picker-fallback до W7, удаляются в W8).

| # | Что | Вердикт | Причина | Риск удаления |
|---|---|---|---|---|
| 1 | `/files`, `/get`, `[[attach:…]]` как *пользовательский интерфейс* (текст угадайки `src/core/files.ts:198` — НЕ ПРОВЕРЕНО построчно) | **MOVE-TO-MINI-APP** | Вкладка Files с preview/diff бьёт чат-листинг; угадайка — источник ложных аттачей | Guard'ы (`resolveOutboundFile/Dir`, `listDir`, `planAttachments` — `src/core/files.ts:115`, `:357`, `:394`, `:449`) KEEP как API-подложка; `verify-render.mjs`/`verify-dot.mjs` их покрывают — тесты перенести, не удалять |
| 2 | `/agent`, `/model`, `/project` как чат-команды с клавиатурами | **MOVE-TO-MINI-APP** | Пикеры — нативная работа More-таба; в чате оставить только bare `/agent x` как алиас | `listProjects` (`src/telegram/callbacks.ts:85`), `cachedModels/pickModels` (`src/gateway/models.ts:270` + picker — НЕ ПРОВЕРЕНО построчно вторая) KEEP, вынести в shared; риск — нулевой |
| 3 | `/status`, `/cost`, `/sys`, `/find` как чат-команды | **MOVE-TO-MINI-APP** | Home/History/More-виджеты; текстовый `/status` (`src/core/router.ts:497` — принято из R3) — карикатура на мониторинг | Форматтеры (`formatCostReply` `src/core/cost.ts:39`, `formatSys` `src/core/sys.ts:56`) KEEP как API-подложка; риск — нулевой |
| 4 | `/auto on\|off` как чат-команда | **MOVE-TO-MINI-APP** | Тумблер в settings More; дефолт из `.env` (`src/config.ts:127` — принято из R3) | One-line мутация сессии; риск — ноль |

5. `/commit`, `/pr`, `/ci`, `/watch` + `ciPoller` (+ весь `src/github/`) — **DELETE**. GitHub-супербот противоречит «малой IDE-панели»; `/commit` (`git add -A + push` из чата, `src/github/commands.ts:73`) — самая опасная команда; poller будит владельца ради чужого CI. Read-only `handleCi` НЕ сохраняем: `/ci` в Mini App не входит в scope v0.5 (github minimal = открытие ссылок PR/CI из task context, не polling). Таблицу `ci_watch` оставить (миграции только вперёд, `src/storage/db.ts:72`). Риск: владелец потеряет CI-уведомления — осознанная цена, чинится внешним мониторингом позже. Харнессы не покрывают (проверено: `work/` — только файлы/рендер). Удалить: регистрации (`src/core/router.ts:252`, `:333`), `startCiPoller` (`src/index.ts:105`).
6. `/exec` — **DELETE**; `/sys` — **MOVE-TO-MINI-APP** (как `GET /api/health`). `/exec` дублирует агента + дыра (произвольный бинарь). `src/core/exec.ts` удалить. Риск: потеря быстрого shell — митигация отсутствует в v0.5 (поле «run command» — M-фича вне scope). Харнессы не покрывают.
7. `/review`, `/test`, `/fix` пресеты — **MOVE-TO-MINI-APP** (чипы-шаблоны над полем ввода). `src/core/presets.ts` (33 строки) — KEEP как есть. Риск — ноль.
8. `/update` + `src/core/update.ts` + `scripts/updater.cmd` — **DELETE**. Самоперезапись с `process.exit(0)` (`src/core/update.ts:228` — НЕ ПРОВЕРЕНО построчно, факт принят из R3) неприемлема рядом с Mini App/туннелем. Удалить `updateConfirmKeyboard` (`src/telegram/keyboard.ts:144`) + `SCOPE.update` (`src/telegram/keyboard.ts:15`) + `runUpdateConfirm`. Риск: потеря one-tap update — осознанная цена.
9. `/clone` — **DELETE** (`src/core/router.ts:299`, `:456`). Клонирование — действие настройки. Риск — ноль.
10. Hand-rolled markdown→HTML (`src/telegram/markdown.ts`, 738 строк) — **KEEP как fallback** (заморожен). Rich Messages покрывают таблицы, fallback обязателен. Удаление ломает `send.ts`/`stream.ts` и `verify-render/tables.mjs`.
11. `cursor`/`cline`/`hermes` провайдеры — **DELETE** (остаются `opencode` + `mock`). `cursor-agent`/`roo-code` не установлены — флаги НЕПРОВЕРЯЕМЫ (`src/providers/cursor.ts:16`, `src/providers/cline.ts:16` — принято из R3); `hermes` — контракт без живого сервера (`src/providers/hermes.ts:7` — принято из R3). Удалить 3 файла + регистрации (`src/index.ts:50–52`) + сузить `AGENT_IDS` (`src/config.ts:5`); `fetchRunner.ts` уходит с hermes. Риск: вернуть один файл из git, контракт `IAgentProvider` стабилен (`src/gateway/types.ts:49`).
12. Ветки `origin/v0.2`, локальные `wave*`/`v0.3`/`v0.4` — **DELETE указателей** (ручная команда владельца, НЕ агент: read-only git для агентов). Код `main` не трогают.
13. `/new` — **KEEP** (кнопка Reset session в More поверх `dropAgentSession`, `src/core/sessions.ts:69`).
14. Voice in (`message:voice` + `src/voice/`) — **KEEP**. Mini App-голос — отдельная фича с деградацией (R1 §A.6), не в v0.5.

Итоговый чат: `/ask`, `/code`, `/approve`, `/cancel`, `/new`, `/start`, `/help` + голос + входящие файлы + клавиатуры approve/plan (+ picker-fallback до W7, удаляются в W8).

---

## 10. Open decisions deferred (НЕ решать сейчас)

| Вопрос | Триггер решения |
|---|---|
| Production endpoint (VPS / Cloudflare Tunnel с доменом / оставить Funnel) | Quick/Funnel упрётся в лимиты либо потребуется аптайм, несовместимый с домашним ПК |
| Realtime транспорт (SSE vs WebSocket vs оставить polling) | Стабильный production endpoint + жалоба на задержку/трафик polling |
| Нативная аудиозапись из Mini App (MediaRecorder → POST → whisper) | Проверка `getUserMedia({audio:true})` на реальном iPhone в Telegram WebView (R1 §A.6: UNVERIFIED); до проверки — голос только через чат |
| Desktop/wide-WebView layout (`max-width` > 560px, двухколоночность) | Реальное использование с desktop-клиента; до тех пор `max-width: 560px` centered |
| Точная семантика progress-percentage (что значит «42%») | Появление провайдера, отдающего токен-бюджеты; до тех пор прогресс = статус + elapsed + живой хвост текста |
| GitHub read-only возврат (`/ci` в Mini App) | Запрос владельца после W8; сейчас DELETE без возврата |
| Судьба `[[attach:…]]`-протокола после diff-системы | W3: KEEP оба пути (sender-путь + diff-сбор отдельно, R3 риск #9) |

---

## 11. Status table

| Wave | Status | Commit | Reviewer verdict | Assertions | Merged | Notes |
|---|---|---|---|---|---|---|
| W1 Foundation | MERGED | `7e61fa2` → merge `bba50a0` | 1-й раунд: APPROVE-WITH-FIXES (0 B / 2 M / 8 m) → fix → 2-й раунд: **APPROVE (0/0/0)** | 71 + render 1249 + tables 430 | да, `bba50a0` | Живая проверка на проде: `/health` 200 `sha=bba50a0`, слушает только `127.0.0.1:8080`, heartbeat пишется, гвард режет без `initData` (401), второй инстанс падает с `E_ALREADY_RUNNING` (pid 3420). `MINIAPP_URL` намеренно не задан — туннель появится вместе с UI в W5 |
| W2 Durability | MERGED | `8a4b369` (`bcb587e` + fix + харнессы) → merge `adee002` | 1-й раунд: APPROVE-WITH-FIXES (0 B / 2 M / 4 m) → fix → 2-й раунд: **APPROVE (0/0/0)** | 94 (было 69) + w1 96 + render 1249 + tables 430 | да, `adee002` | Живая миграция продовой БД прошла чисто: 7 новых колонок `tasks`, таблицы `approvals/drafts/skill_pins`, `idx_tasks_rev`, 56 задач и 1 сессия сохранены. Бэкап `data/backup-20261003-181559/` (db+wal+shm) сделан ДО рестарта. Бот pid 11392, `sha=adee002` |
| W3 Task engine | MERGED | `8a8cbb1` (`28e1050` + 2 fix-раунда) → merge `85a3b18` | 1-й раунд: REJECT (3 B / 6 M / 7 m) → fix → 2-й: APPROVE-WITH-FIXES (0 B / 1 M / 4 m) → fix2 → 3-й: **APPROVE (0/0/0)** | 63 (было 37) + w1 96 + w2 94 + render 1249 + tables 430 | да, `85a3b18` | Живая миграция чистая: `task_files` + 5 новых колонок `tasks`, 56 задач и 1 сессия на месте. Бэкап `data/backup-20261003-190134/`. Бот pid 2056, `sha=85a3b18` |
| W4 API surface | MERGED | `1c9008c` (`705dc8c` + 2 fix-раунда) → merge `16ba54e` | 1-й раунд: REJECT (1 B / 4 M / 12 m) → fix → 2-й: REJECT (0 B / 1 M / 1 m) → fix2 → 3-й: **APPROVE (0/0/0)** | 267 (было 208) + w1 96 + w2 94 + w3 63 | да, `16ba54e` | Латентный прод-баг: `src/index.ts` не передавал `api:` в `createMiniServer` — все `/api/*` отдавали 404. Починен в fix-раунде |
| W5 Shell + Home + Tasks | PENDING | — | — | — | — | — |
| W6 Files + diff viewer | PENDING | — | — | — | — | — |
| W7 More + confirm + Skills | PENDING | — | — | — | — | — |
| W8 Cut + wiring + docs | PENDING | — | — | — | — | — |

### Decision log

Формат: дата, что изменено, почему, какие волны затронуты.

| Дата | Изменение | Почему | Волны |
|---|---|---|---|
| 2026-10-03 | Удалён `GET /api/history?day=` — данные те же, что у `GET /api/tasks/recent`, а группировка по дням и заголовки «Сегодня»/«Вчера» считаются на клиенте | Решение владельца «жёстко урезать»: не дублировать ресурс только ради представления | W4, W5 |
| 2026-10-03 | Удалён `GET /api/cost?period=day\|week` — JSON-версия `formatCostReply` (`src/core/cost.ts:39`) | Не входит в утверждённый scope v0.5 (`More` его не содержит); стоимость конкретной задачи уже приходит в объекте задачи. `/cost` остаётся чат-командой | W4 |
| 2026-10-03 | `/api/tasks/recent` расширен параметрами `offset` и `has_more` | Раз история грузится постранично с одного `/recent`, пагинация нужна; альтернатива была бы отдельный `/history`, который удалён выше | W4, W5 |
| 2026-10-03 | Убран `Access-Control-Allow-Origin: https://web.telegram.org` из `/api/files/download` | Статика и API отдаются с одного origin — CORS не нужен, а жёстко прописанный origin сломал бы доступ при любом другом хостинге | W4, W6 |
| 2026-10-03 | Исправлена нумерация разделов (был пропуск: §10 отсутствовал, `## 12.` -> `## 11.`, ссылки из D7 исправлены) | Внутренняя ссылка на несуществующий раздел ломает навигацию агента-инженера | все |
| 2026-10-03 | Проверены 12 ключевых `file:line` из §3/§4/§5 против реального кода (`queue.ts:89/115/134/179`, `files.ts:357/394`, `callbacks.ts:85`, `sessions.ts:43/69`, `cost.ts:39`, `models.ts:270`, `config.ts:5`) — все совпали | Ошибка в строке отравляет каждую последующую волну; сверка дешевле, чем исправление волны постфактум | W2–W4 |
| 2026-10-03 | Добавлено cross-cutting правило §8.11: любая волна с UI обязана вызвать skill `telegram-liquid-glass` до написания разметки/CSS; ревьюер проверяет факт вызова и отсутствие расхождений `web/tokens.css` против скилла | Решение владельца: агенты обязаны пользоваться скиллом, а не изобретать дизайн-значения заново в каждой волне | W5, W6, W7 |
| 2026-10-03 | **W1 — решение оркестратора по MAJOR-1 ревью:** занятый порт Mini App НЕ убивает бота — деградирует с логом `E_PORT_BUSY` и продолжает long polling; fail-fast остаётся только для не-`E_PORT_BUSY` ошибок. Вердикт ревьюера предлагал либо так, либо задокументировать как намеренное | Чат — основной канал управления владельца, Mini App — вспомогательный. Отнять у владельца бота из-за чужого процесса на 8080 неприемлемо. Решение принято оркестратором, владельцу не выносилось: его явно следует из D1 «туннель — внешняя забота» и из §8.2 «никогда два инстанса» | W1 |
| 2026-10-03 | **Исправлен баг в самом плане (§4.2):** `CREATE INDEX idx_tasks_rev` перенесён ПОСЛЕ `addColumn('tasks','rev',…)`. На свежей БД исходный порядок падал с `no such column: rev`. Найден не ревьюером кода, а implementer'ом W2 при реализации | План — контракт для следующих волн; ошибка в нём воспроизводится буквально. Ревьюер W2 подтвердил, что код верно делает индекс после колонок, но схема в документе оставалась неверной | W2 ( retroactive), W3+ |
| 2026-10-03 | **Добавлено правило §8.12 и исправлен `.gitignore`:** wave-харнессы `work/verify-w*.mjs` теперь коммитятся (`work/*` + `!work/verify-w*.mjs`), остальной скретч игнорируется | W1-харнесс погиб вместе с worktree, и implementer W2 не смог прогнать гейт «W1 не сломалось» — то есть защита от регрессий молча отсутствовала. Обнаружил это implementer, а не оркестратор: процесс надо усилить, а не записать в список пожеланий | все волны |
| 2026-10-03 | **Перед рестартом бота после W2 сделан бэкап `data/backup-<ts>/` (bridge.db + -wal + -shm).** Первый бэкап получился 4 КБ, потому что копирование шло при живом боте и основные данные лежали в WAL (3.2 МБ) | W2 меняет схему продовой БД. Бэкап, который не содержит данных, хуже отсутствия бэкапа — он создаёт ложное чувство безопасности. Правило: бэкапить БД только после kill, и копировать весь комплект `bridge.db*` | W2+, каждая волна со схемой |
| 2026-10-03 | **W3: «изменено задачей» сначала значило «грязное до ∪ грязное после».** Ревьюер доказал фикстурой: чужая незакоммиченная грязь приписывалась задаче. Исправлено фильтром content-сигнатур (`h:` hash-object / `d:` diff-HEAD) + персистентной колонкой `tasks.plan_diff_before` (парк пережить рестарт обязан — in-memory `planSnaps` для W2-урока недостаточно) | Mini App показывает «изменено ЗАДАЧЕЙ» — ложная атрибуция здесь это враньё в UI, а не косметика. In-memory перенос через рестарт не живёт — это уже доказывала W2 с orphan-approval | W3, W4 (отдаёт), W5 (рендерит) |
| 2026-10-03 | **Ограничение для W4 от W3-ревью: API проектирует явные колонки, никакого `SELECT *`.** Иначе внутренняя колонка `plan_diff_before` (сигнатуры хэшей) утечёт наружу; ревьюер проверил — сейчас её видит только `consumeTaskPlanDiff`, так и должно остаться | Внутреннее состояние diff-механизма не является частью API-контракта. Дешевле запретить `SELECT *` сейчас, чем чистить утечку после W5 | W4 |
| 2026-10-03 | **W4 MERGED as `16ba54e` (3 раунда ревью, харнесс 267).** Каноничная форма плана — `mode:"plan"`; `{plan:true}` → 400 `E_BAD_ARG`; `cancel()` возвращает `{kind,id}` реально остановленного; confirm восстанавливает значения карточки; retry/continue идут в проект исходной задачи; 6-way гонки allow/deny покрыты | Последний backend-контракт перед фронтендом (W5–W7 пишут UI на W4). Пустая карточка (`""`) тоже контекст — `strArg` её схлопывал в дрейф сессии, найден ревьюером во 2-м раунде | W4, W5 |
| 2026-10-03 | **Латентный прод-баг найден implementer'ом W4:** `src/index.ts` никогда не передавал `api:` в `createMiniServer` — все `/api/*` в проде отдавали 404 за работающим гвардом. Починен в fix-раунде, проверен ревьюером первым пунктом | Ревью ловит то, что описано в контракте; мёртвую проводку вне диффа волны нашёл только взгляд реализатора. Проверять wiring `index.ts → createMiniServer` в каждой волне, трогающей транспорт | W4 |

Итого API-контракт: **30 эндпоинтов** (черновик архитектора содержал 32).
