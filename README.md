# TG Agent Bridge

Мост между тобой в Telegram и любым код-агентом (OpenCode / Cursor / Cline / Hermes), запущенным на домашнем ПК.
Пишешь боту с телефона — агент работает на ПК в нужной папке, ответ стримится в чат.

Смена агента = смена адаптера: ядро, Telegram-слой и БД не меняются.

---

## Быстрый старт

```bash
git clone https://github.com/sshdw/tg-agent-bridge.git
cd tg-agent-bridge
npm i
cp .env.example .env      # заполнить BOT_TOKEN и ALLOWED_CHAT_IDS
npm run dev
```

С телефона отправь боту `/start` — он ответит текущим агентом.

### Токен и id (2 минуты)

1. Telegram → **@BotFather** → `/newbot` → получишь токен вида `123456:ABC...` → в `.env` как `BOT_TOKEN=...`.
2. Свой chat id узнай у **@userinfobot** → в `.env` как `ALLOWED_CHAT_IDS=...`.
3. `npm run dev` → `/start` с телефона.

> Бот личный: любой chat id, которого нет в `ALLOWED_CHAT_IDS`, молча игнорируется.

---

## Требования

| Что | Версия |
|---|---|
| Node.js | 24.x (проверено на 24.16.0) |
| npm | 10+ |
| git | нужен для `/clone` |
| Docker | опционально, для VPS |

`better-sqlite3` — нативный модуль. Если переключаешься на другую мажорную версию Node, пересобери его: `npm rebuild better-sqlite3`.

Для голосовых сообщений (VOICE IN) нужен локальный whisper.cpp — ставь по желанию, без него бот просто отвечает `E_VOICE_NOT_CONFIGURED`. ffmpeg не требуется: whisper.cpp читает Telegram-овый `.oga` (OGG/Opus) напрямую.

### Установка whisper.cpp (Windows)

1. Скачай `whisper-bin-x64.zip` из [релиза whisper.cpp](https://github.com/ggml-org/whisper.cpp/releases) и распакуй — внутри папка `Release/` с `whisper-cli.exe` и `ggml-*.dll`.
2. Скачай модель: `ggml-base.bin` (~148 МБ) с [huggingface.co/ggerganov/whisper.cpp](https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin) (`ggml-small.bin` точнее и медленнее, `ggml-tiny.bin` ~78 МБ).
3. Пропиши в `.env` абсолютные пути (см. ниже).

Важно: `.dll` должны лежать рядом с `whisper-cli.exe` — не переноси `.exe` в одиночку.

Проверенная связка (сентябрь 2026): `whisper-bin-x64.zip` b5130 + `ggml-base.bin` (~148 МБ, мультиязычная, русский есть) в `D:\tools\whisper` — 11 с аудио распознаётся за ~2 с, WER 0% на эталоне `jfk.wav`.

---

## Настройка `.env`

| Переменная | По умолчанию | Смысл |
|---|---|---|
| `BOT_TOKEN` | — (**обязательно**) | токен от @BotFather |
| `ALLOWED_CHAT_IDS` | — (**обязательно**) | id владельца, через запятую |
| `DEFAULT_AGENT` | `opencode` | агент для новых чатов |
| `DEFAULT_MODEL` | *(пусто)* | модель по умолчанию (пусто = дефолт провайдера) |
| `TASK_TIMEOUT_MS` | `2700000` | таймаут задачи, 45 мин |
| `WORK_ROOT` | `./work` | песочница: `./work/<chat_id>` |
| `ALLOWED_ROOTS` | `./work` | разрешённые папки через `;` |
| `AUTO_APPROVE` | `false` | `true` = shell без подтверждения |
| `HISTORY_LIMIT` | `50` | сколько сообщений отдавать агенту как контекст |
| `OPENCODE_BIN` | `opencode` | путь/имя бинарника |
| `CURSOR_BIN` | `cursor-agent` | — |
| `CLINE_BIN` | `roo-code` | — |
| `HERMES_BASE_URL` / `HERMES_API_KEY` | *(пусто)* | HTTP-агент Hermes |
| `WHISPER_BIN` | `whisper-cli` | путь к `whisper-cli.exe`; пусто/не найден = голос отключён |
| `VOICE_MODEL_PATH` | *(пусто)* | путь к `ggml-*.bin`; пусто = голос отключён |
| `VOICE_LANG` | `ru` | язык подсказкой (`-l`) для whisper.cpp |
| `FFMPEG_BIN` | `ffmpeg` | только для нестандартных форматов; для `.oga` не нужен |
| `DB_PATH` | `./data/bridge.db` | файл SQLite |

Секреты живут только в `.env` / `process.env`. Они не пишутся в БД, в логи и в сообщения об ошибках.

---

## Команды

| Команда | Что делает |
|---|---|
| `/start` | приветствие + активный агент, модель, проект |
| `/ask <текст>` | вопрос активному агенту (со стримингом) |
| `/code <задача>` | то же, но с пометкой `mode: code` |
| `/agent <id>` | сменить агента; без аргумента — список |
| `/model <name>` | сменить модель; без аргумента — сброс |
| `/project <имя\|путь>` | привязать чат к папке (только внутри `ALLOWED_ROOTS`) |
| `/clone <https-url>` | склонировать репо в `WORK_ROOT/<name>` |
| `/auto on\|off` | shell без спроса / только после `/approve` |
| `/approve` | разрешить ожидающее действие агента |
| `/new` | очистить историю чата |
| `/status` | текущая задача + очередь |
| `/cancel` | убить текущую задачу |
| `/cost [day\|week]` | расходы за сутки/неделю из `tasks.cost_usd`; задачи без цены в сумму не входят, так и пишет |
| `/update` | `git pull` + `npm i` + `npm run build` + `tsc`, затем перезапуск (двойное подтверждение кнопкой, только хост) |
| `/help` | список команд |

Фото без команды — сохраняется в `<workdir>/inbox/` и прикладывается к следующему `/ask`.

Голосовое без команды — скачивается в `<workdir>/inbox/voice-<ts>.oga`, распознаётся локально через whisper.cpp и уходит в очередь как обычный `/ask` с пометкой `[voice]`. Распознанный текст бот присылает отдельным сообщением.

Каждый Telegram-чат = отдельная сессия: свой агент, модель, проект и история.

---

## Проекты и папки

Бот может работать только в тех папках, которые ты явно разрешил в `ALLOWED_ROOTS` (через `;`):

```env
ALLOWED_ROOTS=./work;D:\projects\nx
```

- Без `/project` чат живёт в песочнице `./work/<chat_id>`.
- `/clone https://github.com/user/repo` → клонирует в `./work/repo`, затем `/project repo`.
- `/project D:\projects\nx` — привязать чат к существующей папке (должна быть внутри `ALLOWED_ROOTS`).
- Выход наверх запрещён: путь проверяется через `path.resolve`.

---

## Агенты

| id | Как работает | Что нужно |
|---|---|---|
| `opencode` | `opencode run <текст> --format json` (subprocess) | установленный `opencode`, авторизованный (`opencode auth list`) |
| `cursor` | `cursor-agent --print <текст>` (subprocess) | бинарник `cursor-agent` |
| `cline` | CLI `roo-code`; если бинарника нет — файловый адаптер `task.json`/`result.json` в `<workdir>/.bridge/` | либо бинарник, либо внешний обработчик очереди |
| `hermes` | `POST {HERMES_BASE_URL}/v1/agent/run` (SSE/чанки) | `HERMES_BASE_URL` + `HERMES_API_KEY` |
| `mock` | эхо с задержкой | ничего — для тестов без агентов |

Если провайдер не настроен (нет бинарника/ключа), бот присылает `⚙ Провайдер не настроен`, а не падает.

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

Логи пишутся в stdout и в `bot.log` (без секретов).

### Docker

```bash
docker build -t tg-agent-bridge .
docker run -d --name bridge --restart unless-stopped \
  --env-file .env \
  -v "$PWD/data:/app/data" \
  -v "$PWD/work:/app/work" \
  tg-agent-bridge
```

Секреты передаются через `--env-file`, в образ не попадают (`.env` в `.dockerignore`).
Тома нужны, чтобы история чата и файлы проектов пережили пересборку.

> Внутри контейнера доступны только агенты, установленные в образе. Для CLI-агентов (`opencode`, `cursor`, `cline`) проще запускать на хосте, чем тащить их в образ; для HTTP-агента (`hermes`) Docker подходит идеально.

> `/update` в контейнере не работает (обновлятор — Windows `.cmd` для хоста). На VPS обновляйся через `git pull` + `docker build` + `docker run` заново.

---

## Автозапуск (Windows)

Чтобы бот пережил перезагрузку и падение, есть задача планировщика «запуск при входе + рестарт при сбое»:

```cmd
scripts\install-autostart.cmd
```

Что делает: создаёт задачу `tg-agent-bridge` (текущий пользователь, триггер — вход в систему), которая запускает `scripts\run-bridge.cmd` → `npm run dev` в этой папке. При падении — 3 перезапуска с интервалом в минуту. Прав администратора не нужно.

Проверка и удаление:

```cmd
schtasks /query /tn "tg-agent-bridge"
schtasks /delete /tn "tg-agent-bridge" /f
```

Учти: планировщик запускает только один экземпляр (политика `IgnoreNew`). Второй `npm run dev` вручную даст `409 Conflict` в Telegram — убей сначала задачу (`schtasks /run` не нужен, просто не запускай второй).

Проверка без перезагрузки (симуляция сбоя): убей процесс `node` в диспетчере задач — через минуту планировщик поднимет бота, а в личку придёт `🟢 я жив (v0.2, <sha>), прерванных задач: N` (stale `running` → `pending`, автозапуска старых задач нет — решение за владельцем).

---

## Oracle Always Free за 15 минут

Переезд на бесплатный VPS, когда понадобится 24/7 без домашнего ПК. Миграции как таковой пока нет (история чата остаётся в локальной SQLite) — это инструкция «подними второго бота в облаке».

1. Регистрация: нужен аккаунт Oracle Cloud (для проверки личности требуется карта, списаний на Always Free нет). Создай VM: образ **Ubuntu**, shape **VM.Standard.A1.Flex** (Ampere ARM, Always Free: до 4 OCPU / 24 ГБ RAM суммарно на аккаунт — бери 2 OCPU / 12 ГБ, хватит с запасом).
2. В еписке сети (subnet) открой **исходящий** трафик (Telegram polling — только outbound HTTPS, входящие порты не нужны).
3. На VM поставь Docker:
   ```bash
   curl -fsSL https://get.docker.com | sh
   sudo usermod -aG docker ubuntu && newgrp docker
   ```
4. Склонируй репо и заполни `.env`:
   ```bash
   git clone https://github.com/sshdw/tg-agent-bridge.git
   cd tg-agent-bridge
   cp .env.example .env && nano .env   # BOT_TOKEN и ALLOWED_CHAT_IDS обязательны
   mkdir -p data work
   ```
5. Запусти с авторестартом:
   ```bash
   docker build -t tg-agent-bridge .
   docker run -d --name bridge --restart unless-stopped \
     --env-file .env \
     -v "$PWD/data:/app/data" \
     -v "$PWD/work:/app/work" \
     tg-agent-bridge
   docker logs -f bridge
   ```
6. Проверка с телефона: `/start` отвечает — готово. Обновление там: `git pull && docker build -t tg-agent-bridge . && docker rm -f bridge` и снова `docker run …` из п. 5.

Ограничения облака: в образе нет CLI-агентов — используй `hermes` (HTTP-агент) либо ставь нужные CLI в `Dockerfile` сам; голос (whisper.cpp) в облаке не заведётся без настройки — бот просто ответит `E_VOICE_NOT_CONFIGURED`. Два бота на одном токене (домашний + облачный) дадут `409 Conflict` — оставь один.

---

## Архитектура

Слои строго разделены, детали — в `docs/ARCHITECTURE.md`.

| Слой | Папка | Можно | Нельзя |
|---|---|---|---|
| Telegram | `src/telegram/` | парсинг команд, форматирование, стриминг | бизнес-логика, вызов CLI |
| Core | `src/core/` | router, sessions, queue, permissions, approvals | знать детали агента |
| Gateway | `src/gateway/` | `types.ts`, `registry.ts`, `spawnRunner`, `fetchRunner` | хардкод флагов CLI |
| Providers | `src/providers/` | 1 файл = 1 агент: `AgentTask → CLI/HTTP` | лезть в Telegram API |
| Storage | `src/storage/` | SQLite, forward-only миграции | хранить токены |

Контракт провайдера (`src/gateway/types.ts`):

```ts
interface IAgentProvider {
  readonly id: AgentId;
  run(task: AgentTask, onEvent: (e: AgentEvent) => void): Promise<AgentResult>;
  cancel(sessionId: string): Promise<void>;
}
```

Общие раннеры: `spawnRunner` (CLI: spawn, таймаут, kill-map по `sessionId`, построчный стрим, санитайз ошибок) и `fetchRunner` (HTTP: POST + Bearer, `AbortController`, потоковый разбор SSE).

### Структура

```
src/
  index.ts                 # composition root: config, store, register провайдеров, bot
  config.ts                # env → Config
  telegram/{bot,stream}.ts # grammy, whitelist, нарезка >4000, стрим-редактирование
  core/{router,queue,sessions,permissions,approvals}.ts
  gateway/{types,registry,spawnRunner,fetchRunner}.ts
  providers/{opencode,cursor,cline,hermes,mock}.ts
  storage/db.ts
docs/                      # ARCHITECTURE.md, TZ.md, TASK-BREAKDOWN.md
```

---

## Безопасность

- **Whitelist** по `ALLOWED_CHAT_IDS`; чужой chat id → молчаливый игнор.
- **Файлы**: агент работает только внутри `ALLOWED_ROOTS`; выход наверх блокируется.
- **Секреты**: только `process.env`. Дочернему процессу агента переменные `BOT_TOKEN`, `HERMES_API_KEY` не передаются.
- **Ошибки**: наружу только коды (`E_AGENT_FAILED`, `E_TIMEOUT`, `E_NOT_CONFIGURED`, `E_PATH_DENIED`, `E_CANCELLED`) — без команд, ключей и SQL.
- **Логи**: промпты и токены не пишутся; в debug — максимум 120 символов.
- **Лимиты**: 45 мин на задачу, 4000 символов на сообщение (нарезка), 1 задача на чат одновременно.

---

## Диагностика

| Симптом | Причина / что делать |
|---|---|
| Бот не отвечает на `/start` | процесс не запущен, либо твой chat id не в `ALLOWED_CHAT_IDS` |
| `E_NO_TOKEN` при старте | не заполнен `BOT_TOKEN` в `.env` |
| `NODE_MODULE_VERSION` при старте | `better-sqlite3` собран под другую версию Node → `npm rebuild better-sqlite3` |
| `⚙ Провайдер не настроен` | нет бинарника (проверь `opencode --version`) или ключа для HTTP-агента |
| `409 Conflict` в логах | запущено два экземпляра бота — оставь один |
| Задача висит до таймаута | агент ждёт подтверждения внутри своего CLI; попробуй `/auto on` |

---

## Ограничения v0.1

- Только текст и фото. Голос, inline-кнопки и вебхуки — v0.2.
- Стриминг — живым редактированием одного сообщения (лимит Telegram на частоту правок).
- `/approve` работает на уровне моста. CLI-агенты (`opencode`, `cursor`, `cline`) не отдают событие «разрешить команду» до её выполнения, поэтому для них `/auto off` означает «действует политика самого CLI», а не пошаговое подтверждение. Для HTTP-агентов подтверждение управляется на стороне сервера.
- `cline` без установленного `roo-code` использует файловый адаптер: задание кладётся в `<workdir>/.bridge/task.json`, ответ ждётся в `result.json`.
