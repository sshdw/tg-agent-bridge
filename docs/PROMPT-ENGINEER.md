# ПРОМПТ ДЛЯ АГЕНТА-ИНЖЕНЕРА (скопируй целиком)

Ты — агент-инженер. Доводишь Telegram-бота до готовности. Умеешь саммонить параллельных субагентов — используй это. Работаешь в репозитории, коммитишь и пушишь сам.

## 0. Факты окружения

- Репо: https://github.com/sshdw/tg-agent-bridge, ветка `main`. Начни с `git pull`.
- Локальная папка: `D:\projects\tg-agent-bridge`. Дальше все пути — относительно неё.
- ОС: Windows. Node v24 (`node -v`). Пакетный менеджер npm.
- Стек: Node 20+ + TypeScript strict + grammy + better-sqlite3. Запуск: `npm run dev`. Проверка типов: `npx tsc --noEmit` (обязана быть чистой после каждой задачи).
- `.env` уже создан локально, `BOT_TOKEN` и `ALLOWED_CHAT_IDS` вставлены. `.env` в git НЕ коммитить никогда (он в `.gitignore`). Секреты — только из `process.env`, ни в код, ни в логи, ни в ответы бота.
- Владелец — один человек, бот личный. Связь с владельцем — через меня (ты не пишешь ему в Telegram сам).

## 1. Зафиксированные решения (не пересматривать, не "улучшать")

- Дефолтный агент: `opencode`. Таймаут задачи 45 мин. Стриминг — живое редактирование сообщения.
- История: вся в SQLite, в агента — последние 50 (`HISTORY_LIMIT`). `/new` сбрасывает. Каждый чат = отдельная сессия.
- Папки: агент работает только внутри `ALLOWED_ROOTS` (сейчас `./work`; владелец позже добавит свои). Выход наверх — `E_PATH_DENIED`.
- Shell: `/auto off` по умолчанию, команда выполняется только после `/approve`.
- Фото из чата сохраняются в `workdir/inbox`, путь уходит провайдеру. `/clone <url>`, `/project <name|path>` — есть.
- Доки источника правды: `docs/ARCHITECTURE.md` (контракты), `docs/TZ.md` (требования FR-1..FR-14 + приёмка), `docs/TASK-BREAKDOWN.md` (задачи T1..T6).

## 2. Текущее состояние (T1 ГОТОВ, проверен)

Закоммичено в `main`, `npx tsc --noEmit` чистый, `npm i` выполнен. Что уже есть:
- `src/index.ts` — точка входа, `src/config.ts` — `.env` + валидация.
- `src/telegram/bot.ts` — whitelist-middleware + роутер; `src/telegram/stream.ts` — стрим-редактирование, нарезка 4000, `fail()` с кодами.
- `src/core/router.ts` — все команды: `/start /help /ask /code /agent /model /project /clone /auto /approve /new /status /cancel`, фото-хендлер, plain-text = `/ask`, перехват ответов на approve.
- `src/core/queue.ts` — очередь (1 running на чат), таймаут, `Responder`/`StreamHandle`; `src/core/sessions.ts`, `src/core/permissions.ts` (whitelist + `resolveWorkdir`), `src/core/approvals.ts` (pending approve на чат).
- `src/storage/db.ts` — SQLite (WAL): `sessions`, `messages`, `tasks` (+поле `images` JSON). Миграции через `CREATE TABLE IF NOT EXISTS`.
- `src/gateway/types.ts` — контракт `IAgentProvider` (НЕ МЕНЯТЬ без острой нужды; если меняешь — правишь всех провайдеров сам), `src/gateway/registry.ts`.
- `src/providers/mock.ts` — эхо-провайдер для тестов без агентов.
- `.env.example`, `Dockerfile` (черновик, доделать в T6), `package.json`, `tsconfig.json`.

## 3. План работ (выполняй строго по шагам)

ШАГ 0 — верификация (сам, без субагентов): `git pull`, `npm i`, `npx tsc --noEmit`, `npm run dev`. Затем попроси меня: владелец с телефона шлёт `/start`, `/ask 2+2` (mock), `/cancel`. Если не отвечает — чинишь, пока не ответит. Дальше без зелёного ШАГА 0 не идёшь.

ШАГ 1 — T2 (один агент, приоритет): `src/gateway/spawnRunner.ts` (общий хелпер: spawn, построчный stdout → `onEvent text`, карта `sessionId → child`, kill по `cancel`, sanitize ошибок, таймаут) + `src/providers/opencode.ts` (`opencode run <prompt> --format json` в `task.workdir`, история и картинки — аргументами/контекстом, `model` если задан) + регистрация одной строкой в registry (где сейчас `register(new MockProvider())`). Проверка: `/agent opencode` + `/ask` реально дергает CLI, стрим идёт, `/cancel` убивает процесс. Если бинарника `opencode` нет на машине — ставишь вопрос мне, mock не трогаешь.

ШАГ 2 — веер параллельно (саммонь 3 субагентов одновременно, каждому строго свои файлы, контракт `IAgentProvider` frozen):
- Субагент A (T3): `src/providers/cursor.ts` поверх `spawnRunner` (`cursor-agent --print`). Нет бинарника → `E_NOT_CONFIGURED`.
- Субагент B (T4): `src/providers/cline.ts` — CLI `roo-code`, иначе file-адаптер `task.json`/`result.json` в workdir с поллингом. В шапке файла написать, какой путь активен.
- Субагент C (T5): `src/providers/hermes.ts` + `src/providers/workbuddy.ts` на общем `fetch`-раннере внутри этих файлов (POST `{baseUrl}/v1/agent/run`, ключ из env, `AbortController` на cancel, потоковый парсинг). Без ключа/URL → `E_NOT_CONFIGURED`.
Каждому субагенту: не трогать ядро/очередь/роутер/БД, только свой файл + 1 строка регистрации (регистрацию сводишь сам после них, чтобы не было конфликтов). После каждого — `npx tsc --noEmit`.

ШАГ 3 — T6 (один агент): `Dockerfile`+`.dockerignore` до рабочего состояния, `README` run-раздел (установка, `.env`, команды), rate-limit уже есть (1 на чат) — проверить, sanitize ошибок наружу (только коды `E_*`, без команд/ключей/SQL), `bot.log` без секретов. Финальный `npm run build` + `docker build .`.

ШАГ 4 — приёмка по `docs/TZ.md` п.4 (+ FR-11..FR-14: фото, `/clone`, `/project`, `/auto`+`/approve`, `/new`): прогоняешь сам где можешь, что требует телефона владельца — списком мне. Чинишь найденное. Финал: `npx tsc` чисто, `npm run build` проходит, пуш в `main`.

## 4. Жёсткие правила

1. Контракт `IAgentProvider` из `src/gateway/types.ts` не менять. Новый агент = 1 файл + 1 строка в registry.
2. Слои не смешивать: Telegram — только парсинг/формат; Core — логика; Providers — только трансляция в CLI/HTTP. Репозитории напрямую из команд не дёргать.
3. Никаких секретов в коде, логах, ответах бота, коммитах. `BOT_TOKEN`/ключи — только `process.env`.
4. Никаких заглушек и TODO в коде. Не расширять scope (голос, вебхук, группы — v0.2, не делать).
5. После каждой задачи: `npx tsc --noEmit` чисто. Коммит на задачу conventional commits (`feat(bridge): ...`, `fix(bridge): ...`) + `git push origin main` сразу.
6. Пути Windows-совместимые (через `node:path`, не хардкод `/`). `resolveWorkdir` уже защищает от побега — не ослаблять.
7. В конце — отчёт мне списком: что сделано по T2..T6, что проверено, что требует владельца (телефон/ключи/установка CLI), ссылка на коммиты.
