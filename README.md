# TG Agent Bridge + Mini App

Мост между тобой в Telegram и код-агентом (`opencode`), запущенным на домашнем ПК.
Пишешь боту с телефона — агент работает на ПК в нужной папке, ответ стримится в чат.

Управление — через **Telegram Mini App** (кнопка меню у бота): задачи, файлы,
настройки и подтверждение запуска. Чат остаётся вводом + ответами + двумя
кнопками (approve/plan).

---

## Mini App — что это

Встроенное веб-приложение Telegram, которое отдаёт сам бот (тот же процесс,
что и long polling — отдельных шагов запуска нет). Открывается кнопкой меню
у бота, когда задана `MINIAPP_URL` (см. ниже); без неё бот просто работает
чатом, в логе одна строка `menu-button: skipped (no MINIAPP_URL)`.

Четыре таба:

| Таб | Что там |
|---|---|
| `Home` | текущая задача (статус, elapsed, стоимость), очередь, кнопка новой задачи |
| `Tasks` | история задач, детали, файлы задачи (`+N −N`), per-file diff, retry/continue/stop |
| `Files` | проводник проекта: листинг, preview до 64 КБ, diff против `HEAD`, скачивание |
| `More` | агент/модель/проект (пикеры), bridge status, Performance, skills + pin, карточка подтверждения запуска |

Новая задача: текст → карточка подтверждения (промпт, агент, модель, проект,
skills, пресет-чипы Review/Test/Fix) → Run → задача бежит. Пресеты подставляют
role-префикс на сервере (`src/core/presets.ts`) — клиент шлёт только имя.

---

## Деплой внешнего URL (код ничего не знает)

Боту нужен публичный HTTPS-URL, Telegram требует его для Mini App. Код бриджа
о туннеле не знает: URL приходит извне через `MINIAPP_URL`, смена хостинга —
это смена переменной, не правка кода.

| Вариант | Когда |
|---|---|
| Tailscale Funnel (primary) | dev по умолчанию: стабильный URL + валидный TLS, без карты |
| `cloudflared` quick tunnel (fallback) | разовая проверка: URL меняется при каждом старте, без SSE (нам не нужен — только polling) |
| Prod endpoint (VPS / Cloudflare Tunnel с доменом) | когда понадобится аптайм, несовместимый с домашним ПК |

Без `MINIAPP_URL` кнопка меню не прошивается (молчаливый skip), всё остальное
работает как раньше.

---

## Быстрый старт

```bash
git clone https://github.com/sshdw/tg-agent-bridge.git
cd tg-agent-bridge
npm i
cp .env.example .env      # заполнить BOT_TOKEN и ALLOWED_CHAT_IDS
npm run dev
```

С телефона отправь боту `/start` — он ответит текущим агентом и подскажет Mini App.

### Токен и id (2 минуты)

1. Telegram → **@BotFather** → `/newbot` → получишь токен вида `123456:ABC...` → в `.env` как `BOT_TOKEN=...`.
2. Свой chat id узнай у **@userinfobot** → в `.env` как `ALLOWED_CHAT_IDS=...`.
3. `npm run dev` → `/start` с телефона.

> Бот личный: любой chat id, которого нет в `ALLOWED_CHAT_IDS`, молча игнорируется.

---

## Настройка `.env`

| Переменная | По умолчанию | Смысл |
|---|---|---|
| `BOT_TOKEN` | — (**обязательно**) | токен от @BotFather |
| `ALLOWED_CHAT_IDS` | — (**обязательно**) | id владельца, через запятую |
| `DEFAULT_AGENT` | `opencode` | агент для новых чатов (`opencode` \| `mock`) |
| `DEFAULT_MODEL` | *(пусто)* | модель по умолчанию (пусто = дефолт провайдера) |
| `TASK_TIMEOUT_MS` | `2700000` | таймаут задачи, 45 мин |
| `WORK_ROOT` | `./work` | песочница: `./work/<chat_id>` |
| `ALLOWED_ROOTS` | `./work` | разрешённые папки через `;` |
| `AUTO_APPROVE` | `false` | `true` = shell без подтверждения (тумблер также в More) |
| `HISTORY_LIMIT` | `50` | сколько сообщений отдавать агенту как контекст |
| `OPENCODE_BIN` | `opencode` | путь/имя бинарника |
| `MINIAPP_PORT` | `8080` | порт HTTP-сервера Mini App (только `127.0.0.1`) |
| `MINIAPP_URL` | *(пусто)* | публичный URL Mini App; пусто = skip прошивки кнопки меню (D1) |
| `GITHUB_TOKEN` | *(пусто)* | только для сигнала bridge status; поллинга CI нет |
| `WHISPER_BIN` | `whisper-cli` | путь к `whisper-cli.exe`; пусто/не найден = голос отключён |
| `VOICE_MODEL_PATH` | *(пусто)* | путь к `ggml-*.bin`; пусто = голос отключён |
| `VOICE_LANG` | `ru` | язык подсказкой (`-l`) для whisper.cpp |
| `FFMPEG_BIN` | `ffmpeg` | только для нестандартных форматов; для `.oga` не нужен |
| `DB_PATH` | `./data/bridge.db` | файл SQLite |

Правило skip: `MINIAPP_URL` пусто → старт без ошибок, кнопка меню не трогается.
Занятый `MINIAPP_PORT` → деградация с логом `E_PORT_BUSY`, polling продолжается
(чат — основной канал, Mini App — вспомогательный).

Секреты живут только в `.env` / `process.env`. Они не пишутся в БД, в логи и в сообщения об ошибках.

---

## Команды чата

| Команда | Что делает |
|---|---|
| `/start` | приветствие + Mini App + команды |
| `/ask <текст>` | вопрос активному агенту (со стримингом) |
| `/code <задача>` | план, запуск после одобрения (кнопки ✅/✏️) |
| `/review` `/test` `/fix <текст>` | пресеты `/code` с role-префиксом |
| `/agent [id]` | текст-алиас: показать/сменить агента (`opencode` \| `mock`) |
| `/model [id]` | текст-алиас: показать/сменить модель (живой список `opencode models`) |
| `/project [имя\|путь]` | текст-алиас: показать/привязать папку (только внутри `ALLOWED_ROOTS`) |
| `/approve` | разрешить ожидающее действие агента (или кнопка; «да» текстом тоже работает) |
| `/new` | очистить историю чата |
| `/cancel` | убить текущую задачу |
| `/help` | список команд |

Удалённые команды (`/exec`, `/sys`, `/get`, `/files`, `/find`, `/auto`, `/status`,
`/cost`, `/update`, `/clone`, `/commit`, `/pr`, `/ci`, `/watch`) отвечают
подсказкой и никогда не выполняются — их заменили табы Mini App. Таблица
`ci_watch` в БД остаётся пустой (миграции только вперёд).

Каждый Telegram-чат = отдельная сессия: свой агент, модель, проект и история.

---

## Голос в чате — остаётся

Голосовое без команды — скачивается в `<workdir>/inbox/voice-<ts>.oga`,
распознаётся локально через whisper.cpp и уходит в очередь как обычный `/ask`
с пометкой `[voice]`. Распознанный текст бот присылает отдельным сообщением.
Отдельной записи голоса из Mini App в v0.5 нет.

Для голосовых сообщений нужен локальный whisper.cpp — ставь по желанию, без него бот просто отвечает `E_VOICE_NOT_CONFIGURED`. ffmpeg не требуется: whisper.cpp читает Telegram-овый `.oga` (OGG/Opus) напрямую.

### Установка whisper.cpp (Windows)

1. Скачай `whisper-bin-x64.zip` из [релиза whisper.cpp](https://github.com/ggml-org/whisper.cpp/releases) и распакуй — внутри папка `Release/` с `whisper-cli.exe` и `ggml-*.dll`.
2. Скачай модель: `ggml-base.bin` (~148 МБ) с [huggingface.co/ggerganov/whisper.cpp](https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin) (`ggml-small.bin` точнее и медленнее, `ggml-tiny.bin` ~78 МБ).
3. Пропиши в `.env` абсолютные пути (см. выше).

Важно: `.dll` должны лежать рядом с `whisper-cli.exe` — не переноси `.exe` в одиночку.

---

## Проекты и папки

Бот может работать только в тех папках, которые ты явно разрешил в `ALLOWED_ROOTS` (через `;`):

```env
ALLOWED_ROOTS=./work;D:\projects\nx
```

- Без `/project` чат живёт в песочнице `./work/<chat_id>`.
- `/project D:\projects\nx` — привязать чат к существующей папке (должна быть внутри `ALLOWED_ROOTS`).
- Имя без пути ищется во всех корнях. Если оно нашлось в двух местах сразу — бот не угадывает, а просит указать полный путь.
- Выход наверх запрещён: любой путь, пришедший от владельца, проходит через одну проверку (`resolveWorkdir` в `src/core/permissions.ts`).
- Входящие файлы (фото/документы/аудио/видео) сохраняются в `<workdir>/inbox/` и прикладываются к следующей задаче.

---

## Агенты и модели

| id | Как работает | Что нужно |
|---|---|---|
| `opencode` | `opencode run <текст> --format json` (subprocess) | установленный `opencode`, авторизованный (`opencode auth list`) |
| `mock` | эхо с задержкой | ничего — для тестов без агентов |

Если провайдер не настроен (нет бинарника), бот присылает `⚙ Провайдер не настроен`, а не падает.

Список моделей — **живой**: бот запускает `opencode models` (`OPENCODE_BIN`) и показывает то,
что реально доступно сейчас. Список кэшируется на 6 часов; при поломке CLI в чат приходит
понятное сообщение, текущая модель при этом продолжает работать. В Mini App (More) —
пикеры с бейджем `cached` и ручным обновлением.

---

## Performance: Auto | Full | Lite

В `More → Performance`, по умолчанию Auto. Auto смотрит хвост Android User-Agent
(`LOW`/`AVERAGE`/`HIGH`), `deviceMemory`, `hardwareConcurrency`, замер кадров и
`prefers-reduced-motion`: HIGH → полные эффекты, AVERAGE → урезанные blur/motion,
LOW → Lite. Ручной выбор побеждает Auto и сохраняется (CloudStorage +
localStorage). Переключение — синхронно, без перезагрузки. Владельцу выбирать
ничего не нужно — из коробки работает Auto.

---

## Запуск

### Разработка

```bash
npm run dev          # tsx, без сборки
npx tsc --noEmit     # проверка типов
```

### Прод

```bash
npm run build        # tsc → dist/
npm start            # node dist/index.js
```

Один процесс: HTTP-слой Mini App живёт в том же процессе, что grammy long polling.
Перезапуск бота тянет и HTTP-сервер — отдельных шагов нет.

Логи пишутся в stdout и в `bot.log` (без секретов).

---

## Автозапуск (Windows)

Чтобы бот пережил перезагрузку и падение, есть задача планировщика «запуск при входе + рестарт при сбое»:

```cmd
scripts\install-autostart.cmd
```

Что делает: создаёт задачу `tg-agent-bridge` (текущий пользователь, триггер — вход в систему), которая запускает `scripts\run-bridge.cmd` → `npm run dev` в этой папке. Перезапуск бота поднимает и HTTP-сервер Mini App — это один процесс, отдельных шагов для Mini App нет. При падении — 3 перезапуска с интервалом в минуту. Прав администратора не нужно.

Проверка и удаление:

```cmd
schtasks /query /tn "tg-agent-bridge"
schtasks /delete /tn "tg-agent-bridge" /f
```

Учти: планировщик запускает только один экземпляр (политика `IgnoreNew`). Второй `npm run dev` вручную даст `409 Conflict` в Telegram — убей сначала задачу. Проверка без перезагрузки (симуляция сбоя): убей процесс `node` в диспетчере задач — через минуту планировщик поднимет бота, а в личку придёт `🟢 я жив (v0.5, <sha>), прерванных задач: N` (stale `running` → `pending`, автозапуска старых задач нет — решение за владельцем).

---

## Архитектура

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

Слои строго разделены, детали — в `docs/ARCHITECTURE.md`.

| Слой | Папка | Можно | Нельзя |
|---|---|---|---|
| Telegram | `src/telegram/` | парсинг команд, форматирование, стриминг | бизнес-логика, вызов CLI |
| Core | `src/core/` | router, sessions, queue, permissions, approvals | знать детали агента |
| Gateway | `src/gateway/` | `types.ts`, `registry.ts`, `spawnRunner` | хардкод флагов CLI |
| Providers | `src/providers/` | 1 файл = 1 агент: `AgentTask → CLI` | лезть в Telegram API |
| Mini App API | `src/miniapp/` | `http.ts` (guard+статика), `api.ts` (~30 эндпоинтов), `diff.ts`, `skills.ts` | SSE/WebSocket |
| Storage | `src/storage/` | SQLite, forward-only миграции | хранить токены |

### Структура

```
src/
  index.ts                 # composition root: config, store, register провайдеров, bot + Mini App HTTP
  config.ts                # env → Config
  telegram/{bot,stream}.ts # grammy, whitelist, нарезка, стрим-редактирование
  core/{router,queue,sessions,permissions,approvals}.ts
  gateway/{types,registry,spawnRunner}.ts
  providers/{opencode,mock}.ts
  miniapp/{http,api,diff,skills}.ts
  web/                     # статика Mini App, ванилла, без сборки
  storage/db.ts
```

Контракт провайдера (`src/gateway/types.ts`, frozen):

```ts
interface IAgentProvider {
  readonly id: AgentId;
  run(task: AgentTask, onEvent: (e: AgentEvent) => void): Promise<AgentResult>;
  cancel(sessionId: string): Promise<void>;
}
```

---

## Дизайн-источник

Весь UI Mini App — по замороженному скиллу
`.opencode/skills/telegram-liquid-glass/` (токены, motion, чеклист
`references/checklist.md`). Значения не выдумываются: `web/tokens.css` —
дословная копия токенов скилла + проектный appendix. Акцент — только из темы
Telegram, ровно 5 мест (таб, primary-кнопки, ссылки, прогресс, статусы).

---

## Форматирование ответов

Используется Bot API 10.1 «Rich Messages»: `sendRichMessage` и `rich_message` в `editMessageText`.
Telegram разбирает markdown на своей стороне, поэтому таблицы, заголовки и вложенные списки
выглядят нормально, а лимит сообщения — 32768 символов, а не 4096.

- Поддержка проверяется один раз при старте (`src/telegram/rich.ts`): запрос с пустым payload, по
  ответу `Bad Request` значит «метод есть», `404 Not Found: method not found` — «метода нет».
  Пустой payload не содержит `chat_id`, поэтому отправить что-либо он не может.
- Ответ выбирает транспорт **один раз**: raw markdown одним сообщением, если влезает в 32768
  символов / 500 блоков / 16 уровней вложенности; иначе — старый путь: markdown → HTML и
  разбивка на сообщения по 4096 символов (`src/telegram/markdown.ts` — заморожен, см. W8).
- Если сервер не знает `rich_message`, бот запоминает это и дальше всегда использует HTML.
- Ошибка сети или 429 не выключает rich и не превращает ответ в plain text.

---

## Безопасность

- **Whitelist** по `ALLOWED_CHAT_IDS`; чужой chat id → молчаливый игнор.
- **Mini App auth (D8)**: каждый запрос (кроме `GET /health`) несёт `X-Telegram-Init-Data`; сервер проверяет HMAC (`secret = HMAC(bot_token, "WebAppData")`, `timingSafeEqual`), свежесть `auth_date` (≤ 24 ч), `user.id ∈ ALLOWED_CHAT_IDS`. Никакой `user_id` из тела запроса для авторизации не используется.
- **Файлы**: агент работает только внутри `ALLOWED_ROOTS`; выход наверх блокируется.
- **Секреты**: только `process.env`. Дочернему процессу агента переменные `BOT_TOKEN` не передаются.
- **Ошибки**: наружу только коды (`E_AGENT_FAILED`, `E_TIMEOUT`, `E_NOT_CONFIGURED`, `E_PATH_DENIED`, `E_CANCELLED`) — без команд, ключей и SQL.
- **Логи**: промпты и токены не пишутся; в debug — максимум 120 символов.
- **Лимиты**: 45 мин на задачу, 1 задача на чат одновременно, polling вместо realtime (без SSE/WebSocket).

---

## Диагностика

| Симптом | Причина / что делать |
|---|---|
| Бот не отвечает на `/start` | процесс не запущен, либо твой chat id не в `ALLOWED_CHAT_IDS` |
| `E_NO_TOKEN` при старте | не заполнен `BOT_TOKEN` в `.env` |
| `NODE_MODULE_VERSION` при старте | `better-sqlite3` собран под другую версию Node → `npm rebuild better-sqlite3` |
| `⚙ Провайдер не настроен` | нет бинарника (проверь `opencode --version`) |
| `409 Conflict` в логах | запущено два экземпляра бота — оставь один |
| Кнопка меню не открывает Mini App | не задана `MINIAPP_URL` (кнопка не прошивается) или недоступен внешний URL |
| `E_PORT_BUSY` в логах | порт Mini App занят — чат работает, Mini App недоступна; смени `MINIAPP_PORT` |
| Задача висит до таймаута | агент ждёт подтверждения внутри своего CLI; попробуй `AUTO_APPROVE=true` или тумблер в More |
