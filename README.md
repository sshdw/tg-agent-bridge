# TG Agent Bridge — бот, совместимый с любым ИИ-агентом

Транспорт Telegram → единый `IAgentProvider` → любой агент
(Cursor / Cline / Hermes / WorkBuddy / OpenCode).

## Папка

```
tg-agent-bridge/
  docs/
    ARCHITECTURE.md      # архитектура (утвердить)
    TZ.md                # ТЗ (утвердить)
    TASK-BREAKDOWN.md    # 6 параллельных задач для саммона агентов
    PROMPTS.md           # 3 готовых промпта для агента-инженера
  .env.example
  package.json           # минимальный скелет
  tsconfig.json
  Dockerfile
```

## Архитектура (коротко)

1. **Telegram Layer** — `grammy`, long-polling. Только парсинг команд и стриминг ответов. Никакой бизнес-логики.
2. **Core** — Router (команды), SessionStore (chat_id → agent, model, workdir), TaskQueue (SQLite, 1 задача = 1 запуск агента).
3. **Agent Gateway** — единый интерфейс:
   ```ts
   interface IAgentProvider {
     id: 'opencode' | 'cursor' | 'cline' | 'hermes' | 'workbuddy' | 'mock';
     run(task: AgentTask, onEvent: (e: AgentEvent) => void): Promise<AgentResult>;
     cancel(sessionId: string): Promise<void>;
   }
   ```
   Каждый провайдер = тонкий адаптер поверх CLI/HTTP. Ядро не знает деталей агента.
4. **Providers (приоритет):**
   - `opencode` (основной) — `opencode run --format json` как subprocess, парсинг stdout → стрим в ТГ.
   - `cursor` — `cursor-agent --print` subprocess.
   - `cline` — `roo-code --task` / file-based очередь (у Cline нет стабильного headless API → адаптер через CLI).
   - `hermes` / `workbuddy` — HTTP POST `/v1/agent/run` (токен из env, не из ТГ).
5. **Безопасность:** allowlist команд, workdir на чат (`./work/<chat_id>`), секреты только в env/keyring, в логи и в ТГ ошибки без секретов/SQL.
6. **Хранение:** SQLite (`better-sqlite3`): `sessions`, `tasks`. Миграции forward-only.

## Что утвердить (ответь номерами)

Смотри `docs/TZ.md` и `docs/ARCHITECTURE.md`. От тебя нужно:
1. Стек: Node 20 + TS strict + grammy + SQLite — ок? Или Python/aiogram?
2. Режим: личный бот (1 whitelist chat_id) или многопользовательский?
3. Дефолтный агент: `opencode`? Дефолтная модель?
4. Доступ к файлам: бот работает в фиксированной папке `./work` или имеет доступ к `D:\projects\nx`?
5. Деплой: локально / Docker / VPS?

## Вопросы — что ты хотел бы добавить (списком, ответь коротко)

1. Команды: `/ask /code /agent /model /status /cancel` — хватает? Нужны `/voice`, `/photo`, `/repo`?
2. Стриминг: редактировать сообщение по ходу (как ChatGPT) или слать кусками?
3. Контекст: помнить переписку в пределах чата (сколько сообщений: 20/50/безлимит)?
4. Репозитории: клонировать по URL из ТГ (`/clone <url>`) или только локальная папка?
5. Права: выполнять shell-команды агента без подтверждения или с `/approve`?
6. Уведомления: слать результат только запросившему или в группу?
7. Модели: переключать из ТГ (`/model gpt-5`) или фиксированная?
8. Лимиты: max длина ответа, таймаут задачи (5/15/60 мин)?
9. Логи: писать `bot.log` локально — ок?
10. Токен бота уже есть (@BotFather)? Куда деплоим?

## Следующий шаг (2–3 промпта до готовности)

В `docs/PROMPTS.md` уже лежат 3 готовых промпта для твоего агента-инженера:
- Промпт 1: скаффолд + Telegram Core + Queue (запуск `/start /ask` на mock-провайдере).
- Промпт 2 (параллельно ×5): 5 провайдеров по `TASK-BREAKDOWN.md`.
- Промпт 3: hardening + Docker + `npm run dev` smoke.

Как ответишь на 5 пунктов «утвердить» + 10 вопросов — даю команду инженеру начинать с Промпта 1.
