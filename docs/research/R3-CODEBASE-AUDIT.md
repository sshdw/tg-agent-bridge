# R3 — Аудит кодовой базы `tg-agent-bridge` под Mini App-рерайт

**Дата:** 2026-10-03. **Ветка:** `main` = `c554fd4`. **Правило:** каждое утверждение о коде — с `file:line`. Непроверенное помечено `НЕ ПРОВЕРЕНО`.
**Прочитано целиком:** `src/index.ts`, `src/config.ts`, `src/core/router.ts`, `src/core/queue.ts`, `src/core/plan.ts`, `src/core/approvals.ts`, `src/core/files.ts`, `src/core/exec.ts`, `src/core/sys.ts`, `src/core/update.ts`, `src/core/presets.ts`, `src/core/sessions.ts`, `src/core/permissions.ts`, `src/core/cost.ts`, `src/telegram/bot.ts`, `src/telegram/callbacks.ts`, `src/telegram/keyboard.ts`, `src/telegram/nonce.ts`, `src/telegram/stream.ts`, `src/telegram/send.ts`, `src/telegram/rich.ts`, `src/telegram/markdown.ts`, `src/telegram/outbound.ts`, `src/gateway/types.ts`, `src/gateway/spawnRunner.ts`, `src/gateway/fetchRunner.ts`, `src/gateway/registry.ts`, `src/gateway/models.ts`, `src/providers/opencode.ts`, `src/providers/cursor.ts`, `src/providers/cline.ts`, `src/providers/hermes.ts`, `src/providers/mock.ts`, `src/storage/db.ts`, `src/voice/index.ts`, `src/voice/transcribe.ts`, `src/github/commands.ts`, `src/github/ciPoller.ts`, `src/version.ts`, `package.json`.
**Входы R1/R2:** `docs/research/R1-MINIAPP-PLATFORM.md` (платформа + хостинг: HTTP-сервера нет, `bot.start()` = long polling, Mini App — greenfield), `docs/research/R2-LIQUID-GLASS.md` (дизайн-система). Их выводы не дублирую, только опираюсь.

---

## 1. Инвентаризация: что существует сегодня

Архитектура в одной строке: `src/index.ts` собирает `Config` → `Store` → `Bot` → `Responder` → `TaskQueue`, дальше всё — long-polling grammy-бот (`src/index.ts:115`), одна задача на чат (`src/core/queue.ts:62`, `pumping: Set<number>`).

### 1.1. Все `/команды` (регистрация → описание)

Все регистрации — в `src/core/router.ts`, если не сказано иное.

| Команда | Регистрация | Описание одной строкой |
|---|---|---|
| `/start` | `src/core/router.ts:337` | Приветствие + текущие agent/model/project |
| `/help` | `src/core/router.ts:346` | Полный список команд одним сообщением |
| `/ask <текст>` | `src/core/router.ts:353` | Вопрос агенту, режим `ask` (без plan-обёртки) |
| `/code <задача>` | `src/core/router.ts:381` | Всегда через plan-turn: сначала план, запуск только после approve (`src/core/plan.ts:37`) |
| `/review`, `/test`, `/fix` | `src/core/router.ts:384` (цикл по `PRESET_NAMES` из `src/core/presets.ts:9`) | `/code` с фиксированным role-префиксом (`src/core/presets.ts:14`) |
| `/exec <команда>` | `src/core/router.ts:388` | Один процесс без shell в папке проекта, 5 мин, 64 КБ (`src/core/exec.ts:16`, `:20`, `:121`) |
| `/sys` | `src/core/router.ts:389` | CPU/RAM/диск хоста (`src/core/sys.ts:73`) |
| `/agent [id]` | `src/core/router.ts:392` | Без аргумента — picker-клавиатура (`src/telegram/callbacks.ts:278`); с аргументом — прямое переключение + сброс agent-сессии |
| `/model [name]` | `src/core/router.ts:412` | Без аргумента — живой picker (`src/telegram/callbacks.ts:315`); с аргументом — резолв против живого списка, иначе «did you mean»-кнопки (`src/core/router.ts:430`) |
| `/project [name]` | `src/core/router.ts:439` | Без аргумента — picker по всем `ALLOWED_ROOTS` (`src/telegram/callbacks.ts:290`); с аргументом — `resolveWorkdir` |
| `/clone <url>` | `src/core/router.ts:456` (`runClone`, `src/core/router.ts:299`) | `git clone --depth 1` в `WORK_ROOT`, 5 мин |
| `/get <путь>` | `src/core/router.ts:460` | Прислать один файл из workdir (`src/core/router.ts:146`) |
| `/files [папка]` | `src/core/router.ts:462` | Листинг workdir, 40 строк (`src/core/files.ts:48`, `:394`) |
| `/find <текст>` | `src/core/router.ts:464` | LIKE-поиск по истории чата, max 20 (`src/core/router.ts:101`, `:218`) |
| `/auto on\|off` | `src/core/router.ts:472` | Shell-команды с вопросом / без спроса (дефолт из `.env`, `src/config.ts:127`) |
| `/approve` | `src/core/router.ts:483` | Текстовый дубль кнопки «Разрешить» |
| `/new` | `src/core/router.ts:491` | Сброс agent-сессии + очистка истории |
| `/status` | `src/core/router.ts:497` | `running` + число `pending` — весь «мониторинг» |
| `/cancel` | `src/core/router.ts:502` | Отмена approval → parked plan → running task, по приоритету (`src/core/queue.ts:179`) |
| `/cost [day\|week]` | `src/core/router.ts:511` | Траты из `tasks.cost_usd` (`src/core/cost.ts:39`) |
| `/update` | `src/core/router.ts:519` | `git pull` + `npm i` + build + `tsc`, затем detached `scripts/updater.cmd` и `process.exit(0)` (`src/core/update.ts:211`) |
| `/commit <текст>` | `src/core/router.ts:253` | `git add -A` + commit + push (`src/github/commands.ts:73`) |
| `/pr [заголовок]` | `src/core/router.ts:265` | Push + открытие PR через REST (`src/github/commands.ts:117`) |
| `/ci <owner/repo> [ветка]` | `src/core/router.ts:276` | 5 последних запусков Actions (`src/github/commands.ts:205`, `:27`) |
| `/watch <owner/repo> [ветка]` | `src/core/router.ts:286` | Вкл/выкл фоновых уведомлений о CI (`src/github/commands.ts:229`) |

Не-командные входы (`src/core/router.ts`): `message:photo` (`:530`), `message:document` (`:541`), `message:audio` (`:550`), `message:video` (`:566`) — все в `pendingFiles` → аттач к следующей задаче (`src/core/router.ts:109`); `message:voice` (`:583`) — whisper-транскрипция → сразу `/ask`; `message:text` (`:608`) — approval yes/no → plan-rework комментарий → иначе `/ask`.

### 1.2. Все inline-кнопки / callback-данные

Скопы — `src/telegram/keyboard.ts:15`. Реально несёт только `scope:nonce`, пейлоад серверный (`src/telegram/nonce.ts:71`). Роутер — `src/telegram/callbacks.ts:184`.

| Scope | Минт | Обработчик | Действие |
|---|---|---|---|
| `approve` | `src/telegram/callbacks.ts:356` (`approvalKeyboard`) | `src/telegram/callbacks.ts:185` | ✅/❌ для shell-команды агента |
| `agent` | `src/telegram/keyboard.ts:41` | `src/telegram/callbacks.ts:194` | Смена агента + сброс agent-сессии |
| `model` | `src/telegram/keyboard.ts:62`, `:93` (candidates) | `src/telegram/callbacks.ts:207` | Смена модели / сброс к default |
| `project` | `src/telegram/keyboard.ts:110` | `src/telegram/callbacks.ts:214` | Привязка абсолютного dir + guard `resolveWorkdir` |
| `plan` | `src/telegram/keyboard.ts:131` | `src/telegram/callbacks.ts:235` → `handlePlan` (`:131`) | «✅ Запустить» / «✏️ Доработать» |
| `update` | `src/telegram/keyboard.ts:144` | `src/telegram/callbacks.ts:241` | Двойное подтверждение `/update` |

Протухшая/чужая/повторная кнопка — `⌛ Кнопка устарела` (`src/telegram/callbacks.ts:114`), single-use `take` (`src/telegram/nonce.ts:89`), TTL 15 мин (`src/telegram/nonce.ts:21`).

### 1.3. Все вызываемые методы Telegram Bot API

| Метод | Где | Зачем |
|---|---|---|
| `sendMessage` | `src/telegram/stream.ts:77` (плейсхолдер `…`), `src/telegram/send.ts:292,320,340,343`, `src/core/router.ts:641` (запрос approval) | Всё исходящее |
| `editMessageText` | `src/telegram/stream.ts:100` (HTML live-edit), `src/telegram/rich.ts:377` (`rich_message`-edit) | Стриминг |
| `sendRichMessage` | `src/telegram/rich.ts:352` через `api.raw` (`src/telegram/rich.ts:58`) | Нативные Rich Messages, лимит 32768/500/16 (`src/telegram/rich.ts:35`) |
| `answerCallbackQuery` | `src/telegram/callbacks.ts:164–272` (каждый путь) | Гашение спиннера |
| `editMessageReplyMarkup` | `src/telegram/callbacks.ts:180` | Снятие кнопок с протухшего сообщения |
| `getFile` + HTTPS-скачивание `api.telegram.org/file/bot<token>/` | `src/telegram/stream.ts:274,276` | Входящие файлы/голос |
| `sendPhoto` / `sendDocument` | `src/telegram/outbound.ts:44,47` | Исходящие файлы (фото ≤10 МБ, документ ≤50 МБ, `src/core/files.ts:15`, `:22`) |
| `ctx.reply` (тот же `sendMessage`) | `src/telegram/callbacks.ts` (все ответы на кнопки), `src/core/router.ts:434,522` | Ответы вне `sendMarkdown` |

**Не вызывается ничего из:** `sendVoice`, `deleteMessage`, `sendChatAction`, `setWebhook`, `setChatMenuButton`, `answerWebAppQuery`. Капабилити Rich Messages — проба пустым payload один раз (`src/telegram/rich.ts:140`), вердикт на процесс (`src/telegram/rich.ts:106`).

### 1.4. Модель задач и реальная схема БД (`src/storage/db.ts`)

Таблицы создаются `src/storage/db.ts:80`, миграции только `ADD COLUMN` (`:123`).

```sql
sessions(chat_id PK, agent, model DEFAULT '', project DEFAULT '',
         auto_approve DEFAULT 0, created_at, updated_at,
         agent_session_id TEXT NULL);                        -- v0.2, :124
messages(id PK AI, chat_id, role, text, created_at);          -- :90
tasks(id PK AI, chat_id, agent, mode DEFAULT 'ask', prompt,
      images DEFAULT '[]', status DEFAULT 'pending',
      created_at, finished_at NULL,                          -- :97
      cost_usd REAL NULL, plan_text TEXT NULL, preset TEXT NULL); -- :126-130
ci_watch(id PK AI, chat_id, repo, branch DEFAULT '',
         last_status DEFAULT '', last_run_id NULL,
         created_at, updated_at);                            -- :108
-- idx_messages_chat(chat_id,id); idx_tasks_chat(chat_id,status,id);
-- UNIQUE idx_ci_watch_chat_repo(chat_id,repo)               -- :118-120
```

Статусы `tasks.status`: `pending` → `running` → `done`/`error`/`cancelled`, плюс `awaiting_plan` для запаркованного плана (`src/core/queue.ts:297`, `:171`). Строка `preset` — только метка `/review|/test|/fix|plan-rework` для `/cost` (`src/core/queue.ts:18`). Незавершённого: **нет колонок** под model-per-task (модель читается из сессии на старте, `src/core/queue.ts:250`), токены, файлы-изменения, diff, elapsed, skills.

### 1.5. Spawn-путь и жизненный цикл задачи

`submit` (`src/core/queue.ts:89`) → `pump` по одному на чат (`:210`) → `execute` (`:226`): `setTaskStatus(running)` (`src/storage/db.ts:217` ставит `finished_at` только для терминальных), `resolveWorkdir` (`src/core/queue.ts:238`), история `recentMessages(limit=HISTORY_LIMIT)` (`:240`), `sessionId = chatId:taskId` (`:243`), `images` из JSON (`:245`), `provider.run` с `withTimeout(taskTimeoutMs)` (`:282`, дефолт 45 мин `src/config.ts:124`). Прогресс — **только поток текста**, процентов/elapsed нет. Финал: `setTaskCost` (`src/core/queue.ts:311`), `addMessage(assistant)` (`:312`), `setTaskStatus(done)` (`:313`), `stream.finish` (`:314`), затем `planAttachments` → `attachFiles` (`:318`). Ошибка: статус `cancelled` при `E_CANCELLED`, иначе `error` (`:336`), `stream.fail` с картой кодов (`src/telegram/stream.ts:217`). Токены/стоимость: cost — оппортунистический `findCost` по JSONL-событиям (`src/providers/opencode.ts:173`); **токен-счётчиков нет нигде** (в схеме только `cost_usd`; `composePrompt` режет историю по символам 12000, `src/gateway/spawnRunner.ts:278`).

### 1.6. Изменённые файлы и diffs: **НЕ ПОЛУЧАЮТСЯ**

Явно: ни один модуль не запускает `git status/diff`, не собирает список изменённых файлов, не считает `+N/-N`. Единственное упоминание `git diff` — текст пресет-промпта, адресованный агенту (`src/core/presets.ts:16`: «use `git diff` … and report»). Файлы попадают в чат только если агент сам написал `[[attach:…]]` (`src/core/files.ts:449`) или угаданные пути (`src/core/files.ts:198`). Для Mini App «files changed / diff view» — **чистый greenfield**, переиспользовать нечего.

### 1.7. Approvals и plan mode сегодня

Approvals — in-memory `Map<chatId, resolve>` (`src/core/approvals.ts:2`): один pending на чат, переживание рестарта — нет. Запрос: `askApproval` (`src/core/router.ts:636`) — клавиатура + текстовый фолбэк; резолв: кнопка (`src/telegram/callbacks.ts:185`), `/approve` (`src/core/router.ts:483`), `/cancel` как reject (`src/core/queue.ts:180`), plain-text да/нет (`src/core/router.ts:611`). `/exec` спрашивает так же при `autoApprove off` (`src/core/exec.ts:145`).
Plan mode: `/code` всегда `planOnly` (`src/core/plan.ts:37`); в `execute` промпт оборачивается `planPrompt` (`src/core/queue.ts:253`, текст `src/core/queue.ts:349` — «Reply with a SHORT plan, max 8 bullets, do NOT write code»); результат паркуется `awaiting_plan` + `planWaiting` (`src/core/queue.ts:297`, `:171`); клавиатура через `planNotify` (`src/core/plan.ts:21`); run восстанавливает origin-промпт (`src/core/queue.ts:115`); rework — новый plan-turn, max 2 (`src/core/queue.ts:343`, `:134`).

### 1.8. Стриминг и Rich Messages

`createStream` (`src/telegram/stream.ts:69`): плейсхолдер `…`, `push` буферизует, flush каждые 1200 мс (`src/telegram/stream.ts:42`), live-edit одного сообщения (`showLive`, `:92`), хвост — один раз из `finish` (`:175`). Транспорт на стрим — один (`useRich`, `:76`): rich — edit `rich_message` + финал одним сообщением (`deliverFinal`, `:147`); fallback — `renderHtmlChunks` + `editMessageText HTML`. Не-стриминг — `sendMarkdown` (`:241`) → `deliverMarkdown` (`src/telegram/send.ts:227`): `planDelivery` (`:206`) решает rich-vs-html один раз; downgrade-лестница: halve-budget → plain (`:278`); retry только rate_limit/network (`:150`).

### 1.9. Голос, файлы, GitHub

Голос: `message:voice` → `transcribeVoice` (`src/core/router.ts:589`, `src/voice/index.ts:20`) → whisper.cpp напрямую по `.oga` (`src/voice/transcribe.ts:70`), 120 с (`:22`), коды `E_VOICE_*`; пустой транскрипт — «не расслышал» (`src/core/router.ts:590`). Файлы: входящие — `saveInboundFile` (`src/telegram/stream.ts:267`) в `<workdir>/inbox` с `inboxFilename` (`src/core/files.ts:175`); исходящие — §1.3; guard — `resolveOutboundFile/Dir` (`src/core/files.ts:115`, `:357`), листинг без `.git/node_modules/dist/inbox/out` и dotfiles (`:387`, `:404`). GitHub: `/commit` — add/commit/push (`src/github/commands.ts:73`); `/pr` — push + `createPullRequest`, с защитой от PR из default-ветки (`:117`); `/ci` — 5 ранов (`:205`); `/watch` + поллер каждые `CI_POLL_MS` (дефолт 5 мин, `src/config.ts:140`, `src/github/ciPoller.ts:44`), DM только при смене на finished-статус (`isNoteworthy`, `:39`).

---

## 2. Что должно быть построено для Mini App

Легенда: ✅ есть · 🟡 частично · ❌ нет. Размер: S (1–2 файла, дни) / M (новый модуль + API, ~неделя) / L (подсистема, недели).

| Требование | Статус | Доказательство | Размер и почему |
|---|---|---|---|
| Home: карточка текущей задачи + stop/details + recent | 🟡 | `runningTask/oldestPending` есть (`src/storage/db.ts:242,248`), `status()` (`src/core/queue.ts:202`); но прогресса/elapsed нет (§1.5) | **M** — нужен HTTP API + elapsed из `created_at` + стрим статуса; логика чтения готова |
| Tasks: сущность id/title/agent/model/project/status/elapsed/cost + stop/continue/retry/details | 🟡 | Всё кроме `title`/`elapsed` выводимо: `tasks.*` + сессия (§1.4); `title` нет в схеме; retry = новый submit; continue = `approvePlan`-аналог | **M** — добавить `title` (1 колонка) или деривировать из `prompt`; остальное — API над существующим |
| Completion: files changed, +N −N, diff view, files list | ❌ | §1.6: не собирается ничего | **L** — новая подсистема: снапшот `git status --porcelain` до/после задачи + `git diff` + хранение; самое большое белое пятно |
| Files: explorer, абсолютные пути, copy path, preview, diff | 🟡 | `listDir/resolveOutboundDir` (`src/core/files.ts:394,357`) — только 1 уровень, без preview/diff, пути относительные (`rel`, `:379`) | **M** — рекурсивный листинг + `preview` (cap по размеру) + переиспользование guard'ов; diff — из L выше |
| Diff viewer (unified, per-file и per-task) | ❌ | Нет ничего (§1.6) | **L** (входит в L выше) — рендер на клиенте, сервер отдаёт сырой `git diff`; риск — размер (§7.10) |
| More: agent/model/project pickers | ✅ логика, ❌ API | Пикеры есть как клавиатуры (`src/telegram/callbacks.ts:278,290,315`); `availableProviders` (`src/gateway/registry.ts:15`), живой `cachedModels` (`src/gateway/models.ts:270`), `listProjects` (`src/telegram/callbacks.ts:85`) | **S** — те же функции за HTTP; `listProjects` переедет из telegram-слоя в shared |
| GitHub minimal | ✅ логика, ❌ API | `handleCi/handleWatch` + `ci_watch` (`src/github/commands.ts:205,229`) | **S** — read-only обёртка; `/commit|/pr` в Mini App не нужны (cut, §5) |
| Bridge status | 🟡 | Boot-пинг (`src/index.ts:79`), `/sys` (`src/core/sys.ts:73`), probe rich (`src/index.ts:89`), models-warm (`:95`); но нет единого health-объекта | **S** — один `/api/health` из готовых кусков |
| Settings (agent/model/project/autoApprove/...) | 🟡 | `sessions` хранит всё (`src/storage/db.ts:81`); мутации — `updateSession` (`src/core/sessions.ts:43`) | **S** — CRUD над `sessions` + `allowedRoots` read-only из конфига |
| Confirmation card (prompt+agent+model+project+attachments, Run/Edit) | 🟡 | Данных хватает (сессия + `pendingFiles`, `src/core/router.ts:80`); но подтверждения перед `/ask` нет — текст сразу `submit` (`src/core/router.ts:64`) | **M** — draft/confirm состояние (новая маленькая таблица или in-memory + TTL); решает и проблему «текст сразу запускает» |
| Plan mode UI | ✅ логика, ❌ API | `awaiting_plan` + `plan_text` + `approvePlan/reworkPlan` (`src/core/queue.ts:115,134`) | **S** — три эндпоинта поверх готового автомата; клавиатура → кнопки Mini App |
| Approval UI | ✅ логика, ❌ API | `hasApproval` (`src/core/approvals.ts:4`), но pending живёт в памяти | **S–M** — нужен durable pending (иначе Mini App не прочитает); см. §3.4 |
| Queue (list, cancel current, clear) | 🟡 | `pendingCount/oldestPending` (`src/storage/db.ts:254,242`), `cancel` (`src/core/queue.ts:179`); «clear всей очереди» нет, списка pending нет | **S** — `listPending` запрос + `cancelAll`; вся механика есть |
| History (по дням, tap → task) | 🟡 | `messages` + `tasks` с `created_at` есть; `recentMessages/findMessages` (`src/storage/db.ts:176,184`); группировки по дням нет | **S** — один SELECT с `date(created_at,'unixepoch','localtime')` |
| System status (telegram/agent/github/whisper, tap → reason) | ❌ как сущность | Сигналы разбросаны: `logResolvedBins` (`src/index.ts:39`), `probeRichSupport`, `GitHubClient.configured` (НЕ ПРОВЕРЕНО построчно — класс в `src/github/client.ts`, поле `configured` подтверждено использованием `src/github/ciPoller.ts:46`), whisper `checkBin/checkModel` (`src/voice/transcribe.ts:33,38`) | **S** — `/api/health` агрегирует 4 проверки; whisper проверять `existsSync` без запуска |
| Skills system | ❌ | Нет ни файла, ни упоминания (grep `skill` по `src/` — только `skipped`/`skills`-шум, НЕ ПРОВЕРЕНО дословно: совпадений смысловых нет) | **M** — см. §4; list/pin — S, запись использования — M |
| Чат остаётся чатом, не 20-кнопочным | ✅ | Уже так: клавиатуры только для picker/approve/plan (`src/telegram/keyboard.ts`), команды — текст | **—** — инвариант рефактора: новые Mini App-эндпоинты не должны порождать новые скопы кнопок |

---

## 3. Server reality check

### 3.1. HTTP-listener сегодня: **НЕТ. Однозначно.**

- `src/index.ts:115` — `bot.start({ onStart })` без вебхука = long polling; входящего сервера нет.
- `src/` не содержит `server/`, `hono`/`express`/`fastify`/`node:http`: grep `createServer|express|listen\(|http\.|web_app|initData|setChatMenuButton|setWebhook|webhook|WebApp|fastify|koa|hono` по `src/` — совпадения только `honour PATHEXT` (`src/core/exec.ts:83`) и `honoured http(s)` (`src/core/telegram/markdown.ts:33`) — шум. Совпадение с R1 (§0: «0 совпадений»).
- `package.json:11` — зависимости только `better-sqlite3`, `grammy`. HTTP-слоя нет даже как транзитивной необходимости.
- Единственный «серверный» сетевой код — исходящий: `fetch` к `api.telegram.org/file` (`src/telegram/stream.ts:276`) и к Hermes (`src/gateway/fetchRunner.ts:147`).

### 3.2. Что переиспользует HTTP-слой. `src/gateway/types.ts` — контракт?

`src/gateway/types.ts:1` (`AgentId`), `:10` (`AgentTask`), `:35` (`AgentEvent`), `:40` (`AgentResult`), `:49` (`IAgentProvider`) — **де-факто замороженный контракт**: его потребляют `queue.ts`, `spawnRunner.ts`, `fetchRunner.ts`, все 5 провайдеров. Формального `/** frozen */` нет, но менять его без нужды нельзя — это граница «шина ↔ провайдеры». Для Mini App напрямую он не нужен (Mini App говорит с задачами, не с провайдерами); HTTP-слою нужны: `Store` (запросы), `TaskQueue.status/submit/cancel/approvePlan/reworkPlan` (`src/core/queue.ts:89,115,134,179,202`), `getOrCreate/updateSession` (`src/core/sessions.ts:14,43`), `listProjects` (сейчас в telegram-слое — `src/telegram/callbacks.ts:85` — **вынести**), `cachedModels/pickModels` (`src/gateway/models.ts:270,333`), `formatCostReply` (`src/core/cost.ts:39`), `formatSys/sysInfo` (`src/core/sys.ts:31,56`), `handleCi/handleWatch` (`src/github/commands.ts:205,229`).

### 3.3. DB-доступ и конкуренция с grammy-циклом

`Store` (`src/storage/db.ts:58`) — `better-sqlite3`, **все вызовы синхронные**, WAL включён (`src/storage/db.ts:64`). Для HTTP-обработчика в том же процессе это означает: короткие SELECT/UPDATE — безопасны и дешёвы (микросекунды, цикл не заметит); длинных транзакций нет ни одной — не создавать. Отдельный процесс/воркер с тем же файлом — тоже ок (WAL), но тогда in-memory состояние (§3.4) ему невидимо — поэтому HTTP-слой должен жить **в том же процессе**, а не отдельным сервером. Блокирующая опасность реальна только одна: `recoverStaleRunning`-подобные UPDATE без индекса — но `idx_tasks_chat` есть (`src/storage/db.ts:119`).

### 3.4. Где живёт состояние: и там, и там — и это определяет архитектуру

| Состояние | Где | Код |
|---|---|---|
| sessions, messages, tasks, ci_watch | SQLite, durable | `src/storage/db.ts` |
| pump-флаг, streams, sessionIds (`chatId:taskId`), planWaiting/planTurns/planOrigin/planRounds | Память `TaskQueue` | `src/core/queue.ts:62–73` |
| shell-approval pending | Память | `src/core/approvals.ts:2` |
| nonce кнопок | Память, TTL 15 мин | `src/telegram/nonce.ts:33` |
| `pendingFiles` (inbox-аттачи) | Память | `src/core/router.ts:80` |
| model cache | Память, TTL 6 ч / fail 1 мин | `src/gateway/models.ts:30,137` |

Следствие: Mini App **может** читать историю/очередь/сессии прямо из SQLite, но **живое** (running-стрим, pending approval, parked plan в `planWaiting`) — только через процесс. Значит пуш-канал обязателен: минимум — polling `/api/tasks/:id` (дешёво, state в SQLite), для живого текста — SSE/long-poll поверх `streams` (см. R1 §B.1: Quick Tunnel не поддерживает SSE — аргумент за Tailscale Funnel). Approval и parked-plan перед рерайтом надо перенести в durable-хранилище (2 маленькие таблицы), иначе Mini App их не увидит после рестарта, а чат — увидит «нечего подтверждать».

---

## 4. OpenCode Skills: что реально поддерживается (проверено, не угадано)

Проверено 2026-10-03 на установленном `opencode v2.0.22` (`opencode --version`): бот не запускался, сессия не создавалась, только `--help` отдельных субкоманд + чтение официальной документации (https://v2.opencode.ai/docs/skills) + локальный `~/.config/opencode/skills/` (21 навык `gortex-*`, у каждого `SKILL.md` с `name:`/`description:` — сверен `gortex-debug/SKILL.md:1`).

- **`SKILL.md` — реален.** Формат: директория на навык + `SKILL.md` с frontmatter `name` (kebab-case `^[a-z0-9]+(-[a-z0-9]+)*$`, 1–64) + `description` (1–1024). Рядом — `scripts/`, `references/` (конвенция из доков, пути внутри навыка — относительно его директории).
- **Локации:** проект — `.opencode/skills/<name>/SKILL.md` (поиск вверх от cwd до корня git worktree); глобал — `~/.config/opencode/skills/`; совместимость — `.claude/skills/`, `.agents/skills/` (глобал + вверх по дереву). Плюс `skills: [...]` в `opencode.json` (локальные dirs + HTTP-каталоги с `index.json`). Подтверждено наличием `skills/` в выводе конфигурации (`opencode debug paths` показал `config: C:\Users\gogog\.config\opencode`, где лежит `skills/`).
- **`skill` tool + on-demand:** на каждом шаге модели рекламируются только `id+name+description` (`<available_skills>`), тело грузится вызовом `skill({name})`; пермишены `permission.skill: {pattern: allow|deny|ask}`, отключение — `tools: {skill: false}`.
- **CLI-флаги для навыков — НЕ ПРОВЕРЕНО:** в `opencode --help` / `run --help` / `session --help` субкоманды `skill` нет. Управление — только файлами + `opencode.json`, не флагами.

Что должен делать bridge:

| Задача | Вердикт | Как |
|---|---|---|
| (a) LIST | Возможно чисто у нас — **S** | `readdir` project `.opencode/skills/*/SKILL.md` (вверх от workdir) + global + парс frontmatter (name/description). Никакого agent API не нужно |
| (b) PIN к задаче | Возможно чисто у нас — **S** | Два пути, оба наши: ① препенд тела навыка в `prompt` перед `submit` (тот же механизм, что `PLAN_FIRST_INSTRUCTION`, `src/core/queue.ts:349`); ② положить `SKILL.md` в workdir проекта — `opencode run` подхватит сам (cwd = workdir, `src/providers/opencode.ts:94`). `--agent` (`opencode run --help`: `--agent string`) — НЕ ПРОВЕРЕНО, что он выбирает навык; не использовать без проверки |
| (c) Запись использования | Возможно, **M** | JSONL `opencode run --format json` содержит `tool_use` события (`src/providers/opencode.ts:22` — сегодня отбрасываются в `parseLine`, `:153`). Нужно: сохранять `tool_use{name=skill}` → новая колонка `tasks.skills_used`. Чисто наша работа, поддержки агента не требует |
| (d) Авто-выбор навыка | Только agent-side | Модель сама вызывает `skill` tool по `description`. Наше влияние — качественные `description` + (b). Форсировать вызов навыка из bridge нельзя и не нужно |

---

## 5. Cut list (главный раздел)

Принцип: Mini App делает лучше всё, что сегодня — кнопки-списки; чат остаётся вводом + ответами + 3 клавиатурами (approve/plan/picker-fallback). Оценка риска — против `work/verify-*.mjs` (офлайн-харнесс на `dist/`).

| # | Что | Вердикт | Причина | Риск удаления |
|---|---|---|---|---|
| 1 | `/files`, `/get`, `[[attach:…]]` + `extractFileRefs`-угадайка как *пользовательский интерфейс* | **MOVE-TO-MINI-APP** | Вкладка Files с preview/diff бьёт чат-листинг по всем осям; угадайка (`src/core/files.ts:198`) — источник ложных аттачей | Guard'ы (`resolveOutboundFile/Dir`, `listDir`, `planAttachments`) — KEEP как API-подложка; `verify-render.mjs`/`verify-dot.mjs` их покрывают — тесты перенести, не удалять |
| 2 | `/agent`, `/model`, `/project` как чат-команды с клавиатурами | **MOVE-TO-MINI-APP** | Пикеры — нативная работа More-таба; в чате оставить только bare `/agent x` как алиас для быстрого переключения | `listProjects/cachedModels/pickModels` — KEEP, вынести из `src/telegram/callbacks.ts` в shared; риск — нулевой, логика не меняется |
| 3 | `/status`, `/cost`, `/sys`, `/find` как чат-команды | **MOVE-TO-MINI-APP** | Это Home/History/More-виджеты; текстовый `/status` (`src/core/router.ts:497` — одна строка!) — карикатура на мониторинг | Форматтеры (`formatCostReply`, `formatSys`) — KEEP как API; риск — нулевой |
| 4 | `/commit`, `/pr`, `/ci`, `/watch` + `ciPoller` | **DELETE** (оставить `handleCi` read-only если дёшево) | GitHub-супербот противоречит «малой IDE-панели»; `/commit` делает `add -A + push` из чата — самая опасная команда в репо; поллер будит владельца ради чужого CI | `verify-*` их не покрывают (проверено: `work/` — только `verify-dot/render/tables.mjs` про файлы/рендер); удалить `src/github/` целиком + регистрации (`src/core/router.ts:252,333`) + `startCiPoller` (`src/index.ts:105`) + `ci_watch` таблицу оставить (миграции только вперёд, `src/storage/db.ts:72`) |
| 5 | `/exec`, `/sys` выполнение произвольного shell из чата | **DELETE** (`/exec`), **MOVE** (`/sys` → health) | `/exec` — дублирует агента + дыра (argv без shell, но произвольный бинарь); агент и так имеет shell в workdir | `src/core/exec.ts` удалить; `verify-*` не покрывают; риск — владелец потеряет быстрый shell: митигация — поле «run command» в Mini App Files через тот же `runSpawn`, но это уже M-фича, не carry-over |
| 6 | `/review`, `/test`, `/fix` пресеты | **MOVE-TO-MINI-APP** (как кнопки-шаблоны промпта) | Три строки префиксов (`src/core/presets.ts:14`) — идеальные чипы над полем ввода Mini App | KEEP `src/core/presets.ts` как есть (33 строки, покрыт транзитивно); риск — ноль |
| 7 | `/update` + `src/core/update.ts` + `scripts/updater.cmd` | **DELETE** | Самоперезаписывающийся бот с `process.exit(0)` (`src/core/update.ts:228`) — неприемлемо рядом с Mini App/туннелем; обновление ПК — руками или отдельным скриптом | Удалить `updateConfirmKeyboard` + `SCOPE.update` + `runUpdateConfirm`; `verify-*` не покрывают; риск — потеря one-tap update: осознанная цена |
| 8 | `/clone` | **DELETE** | Клонирование — действие настройки, не ежедневное; в Mini App — поле «add project path» вместо git-операций | `src/core/router.ts:299` + `:456`; риск — ноль |
| 9 | Hand-rolled markdown→HTML (`src/telegram/markdown.ts`, 738 строк) | **KEEP как fallback** | Нативные Rich Messages покрывают то, ради чего он писался (таблицы), но fallback обязателен: pre-10.1 сервер, `richFits=false`, reject по лимитам (`src/telegram/send.ts:227`) | Удаление ломает `send.ts`/`stream.ts` и `verify-render/tables.mjs`; согласиться: KEEP, заморозить фичи |
| 10 | `cursor`/`cline`/`hermes` провайдеры | **DELETE** (оставить `opencode` + `mock`) | `cursor-agent`/`roo-code` не установлены — флаги НЕПРОВЕРЯЕМЫ (`src/providers/cursor.ts:16`, `src/providers/cline.ts:16`); `hermes` — контракт без живого сервера (`src/providers/hermes.ts:7`); мёртвый код с invented-флагами — ровно та фабрикация, за которую уже удалили hardcoded models | Удалить 3 файла + регистрации (`src/index.ts:50–52`) + `AGENT_IDS` сузить (`src/config.ts:5`); `fetchRunner.ts` уходит вместе с hermes; риск — если владелец завтра поставит cursor: вернуть один файл из git, контракт `IAgentProvider` стабилен |
| 11 | `origin/v0.2` + `wave*`/`v0.3`/`v0.4` ветки | **DELETE** (remote `origin/v0.2` — точно) | `git diff main origin/v0.2 --stat`: −2847 строк — ветка старше всех волн; локальные `wave2-*` смержены (лог: `ad242d8`, `159ca89`, `27ef891`); висячие ветки путают `git log` и соблазняют чинить не то | Только ветки-указатели, код `main` не трогают; риск — ноль (история остаётся в reflog/origin). Read-only правило соблюдено: удаление — отдельной ручной командой владельца |
| 12 | `/new` (wipe истории) | **KEEP** (переименовать в Reset session) | Единственный способ сбросить `agent_session_id` без смены проекта (`src/core/sessions.ts:69`); нужен и Mini App | S — кнопка поверх того же `dropAgentSession` |
| 13 | Voice input (`message:voice` + `src/voice/`) | **KEEP** | Работает, локально, бесплатно (whisper.cpp, `src/voice/transcribe.ts:70`); R1 §A.6: голос из Mini App на iOS под вопросом — чат-голос остаётся основным входом | Не трогать; Mini App-голос — отдельная M-фича с деградацией |

Итого новый чат: `/ask`, `/code`, `/approve`, `/cancel`, `/new`, `/start`, `/help` + голос + входящие файлы + 3 клавиатуры. Всё остальное — Mini App.

---

## 6. Предлагаемый минимальный layout

Принцип: один процесс (см. §3.3–3.4), один источник правды — `Store` + `TaskQueue`; чат и Mini App — два тонких адаптера.

```
src/
  core/            # БЕЗ ИЗМЕНЕНИЙ кроме: queue.ts (+title/skills_used этапы),
                   #   approvals durable-таблица; presets/cost/sys/files — как есть
  gateway/         # opencode.ts, spawnRunner.ts, models.ts, registry.ts (без hermes/fetchRunner)
  providers/       # opencode.ts, mock.ts
  storage/db.ts    # + tasks.title, tasks.skills_used, approvals, task_files(diff-мета)
  telegram/        # bot.ts, callbacks.ts (только approve/plan), keyboard.ts (урезать),
                   #   stream.ts, send.ts, rich.ts, markdown.ts (заморожен), nonce.ts
  miniapp/         # НОВОЕ (единственный новый домен-модуль):
    http.ts        # слушатель (node:http, без deps) + initData-HMAC guard (R1 §A.3)
    api.ts         # ~15 эндпоинтов поверх core/store (таблица ниже)
    diff.ts        # git status/diff сбор (L из §2)
    skills.ts      # list/pin/record (§4)
  web/             # НОВОЕ: статика Mini App (index.html + app.js + style.css, ванилла,
                   #   токены R2; позже — GitHub Pages вариант из R1 §B.5)
  skills/          # НОВОЕ: наши собственные SKILL.md (релиз, ревью, коммит-месседж…)
```

API-минимум (каждый — тонкая обёртка над существующим, §3.2): `GET /api/tasks/current|recent|/api/tasks/:id`, `POST /api/tasks {prompt,mode}` + `GET /api/tasks/:id/stream` (SSE), `POST /api/tasks/:id/{stop,retry,continue}`, `GET/POST /api/plan/:id/{approve,rework}`, `POST /api/approvals/:id/{allow,deny}`, `GET /api/files?dir=…` + `GET /api/files/preview?path=…` + `GET /api/diff?task=…`, `GET /api/pickers/{agents,models,projects}`, `GET/PUT /api/settings`, `GET /api/history?day=…`, `GET /api/health`, `GET /api/skills` + `POST /api/tasks` с `skills:[…]`. Chat-адаптер (`router.ts`) и `api.ts` делят `Deps` — две проекции одного состояния, а не два источника.

Новых модулей — 4 файла в `miniapp/` + статика: меньше нельзя, потому что HTTP-границы (auth, роутинг, diff-сбор, skills) не должны лежать ни в `telegram/`, ни в `core/`.

---

## 7. Risk register (топ-10)

| # | Риск | Что ломается | Вероятность | Дешёвая митигация |
|---|---|---|---|---|
| 1 | Два инстанса / два polling-цикла | Telegram отдаёт апдейты то одному, то другому; задачи дублируются, approval резолвится не там | Средняя (рестарт при висящем процессе — классика Windows) | Pid-lock файл на старте (`src/index.ts:45` — добавить первым); `getMe` + `recoverStaleRunning` (`src/storage/db.ts:266`) уже есть как детектор |
| 2 | Бот умирает молча (ПК спит/процесс убит) | Running-задача висит, Mini App показывает «выполняется» вечно | Высокая (домашний ПК) | Heartbeat-файл/строка с timestamp каждые 30 с; Mini App считает stale >90 с; boot-пинг (`src/index.ts:79`) уже шлёт «я жив» — добавить туда же heartbeat |
| 3 | Клиентские различия рендера Mini App (iOS/Android/desktop) | Liquid Glass едет, safe-area врёт, голос не работает на iOS | Высокая | R1 §A.6–A.7 + R2 §2.6: `performance_class` LOW → lite, `themeChanged` подписка, голос с деградацией «открой чат»; тестировать на реальном iPhone, не десктопе |
| 4 | Нестабильность Mini App URL (туннель пересоздался) | Кнопка меню ведёт в никуда; `setChatMenuButton` протухает | Высокая при Quick/ngrok, низкая при Funnel | Funnel со стабильным именем (R1 §B.7 — вариант 1); `setChatMenuButton` при старте поверх `t.me/<bot>/app` (R1 §A.1 п.2) |
| 5 | Cost/latency больших diffs | `git diff` на 10k строк вешает WebView и съедает туннель | Средняя | Cap: per-file 200 строк + `…ещё N строк` (паттерн уже есть — `TABLE_ROW_CAP`, `src/telegram/markdown.ts:146`); unified→свёртка по файлам; бинарники — только имена |
| 6 | better-sqlite3 блокирует event loop | Длинный SELECT из Mini App стопает polling/стрим | Низкая (запросы мелкие) | Только короткие запросы; WAL уже включён (`src/storage/db.ts:64`); никогда — транзакции через стрим |
| 7 | In-memory state невидим Mini App (approval/plan/стрим) | Кнопка «разрешить» в Mini App отвечает «нечего подтверждать» | Гарантировано, если не перенести | Durable `approvals` + `planWaiting` в SQLite до первого эндпоинта (§3.4); стрим — SSE поверх `streams` (`src/core/queue.ts:63`) |
| 8 | Подделка `initData` | Чужой открывает Mini App и рулит агентом на ПК | Низкая при проверке, критична без неё | HMAC + `auth_date` + `allowedChatIds` на каждый запрос (R1 §A.3 — готовая таблица проверок); токен никогда на клиент (R1 §B.5) |
| 9 | Потеря `[[attach:…]]`-протокола при переходе на diff-систему | Агент пишет маркеры, а новый Files-путь их игнорирует | Средняя | KEEP `planAttachments`/`AttachCensor` (`src/core/files.ts:449`, `:326`) как sender-путь; diff-сбор — отдельно, не вместо |
| 10 | Раздувание скоупа обратно («ещё одна кнопочка в чат») | Возврат к 20-кнопочному интерфейсу, ради чего и режется | Высокая (социальная, не техническая) | Инвариант из §2: новый UI — только в Mini App; `SCOPE` (`src/telegram/keyboard.ts:15`) — freeze, новые скопы только через R-документ |

---

## Приложение: откуда что проверено (быстрый индекс)

Boot/сборка: `src/index.ts:45–118`. Конфиг: `src/config.ts:98–142`. Контракт агентов: `src/gateway/types.ts:1–53`. Spawn: `src/gateway/spawnRunner.ts:106–211` (+`composePrompt` `:278`, `telegramify` `:263`). HTTP-провайдер: `src/gateway/fetchRunner.ts:111–225`. Providers: `src/providers/opencode.ts:51–112`, `cursor.ts:33–47`, `cline.ts:81–117`, `hermes.ts:35–49`, `mock.ts:10–31`. Модели: `src/gateway/models.ts:184–282` (spawn+cache), `:333–391` (picker). Harнесс: `work/verify-render.mjs`, `work/verify-tables.mjs`, `work/verify-dot.mjs` (покрывают `core/files`, `telegram/markdown`, `permissions`, `storage`). Доки волн: `docs/PROMPT-ENGINEER-V02.md`, `V03.md`, `ARCHITECTURE.md` (контекст, не источник истины — истина сверена с кодом выше).
