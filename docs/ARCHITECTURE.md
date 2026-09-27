# ARCHITECTURE — TG Agent Bridge

## 1. Цель

Один Telegram-бот, который умеет говорить с любым кодовым агентом через единый интерфейс.
Смена агента = смена адаптера, ядро не меняется.

## 2. Диаграмма

```
Telegram User
    │  (grammy, long-polling)
    ▼
┌─────────────┐     ┌──────────────┐     ┌───────────────────┐
│ Telegram    │────▶│ Core         │────▶│ Agent Gateway     │
│ Layer       │◀────│ Router+Queue │◀────│ IAgentProvider    │
└─────────────┘     └──────┬───────┘     └─┬───┬───┬───┬───┬─┘
                           │               │   │   │   │   │
                        SQLite          open cursor cline hermes work-
                        sessions        code -agent  roo  http  buddy
                        tasks                                    http
```

## 3. Слои (строго)

| Слой | Папка | Можно | Нельзя |
|---|---|---|---|
| Telegram | `src/telegram/` | парсинг команд, форматирование, стрим-редактирование | бизнес-логика, прямой вызов CLI |
| Core | `src/core/` | router, sessions, queue, permissions, лимиты | знать детали конкретного агента |
| Gateway | `src/gateway/` | `types.ts` + `ProviderRegistry`, общий `spawnRunner` | хардкодить флаги CLI в ядре |
| Providers | `src/providers/` | по 1 файлу на агента, трансляция `AgentTask → CLI/HTTP` | лезть в Telegram API |
| Storage | `src/storage/` | SQLite, миграции forward-only | хранить токены ТГ/провайдеров в БД |

## 4. Контракты

```ts
// src/gateway/types.ts
export type AgentId = 'opencode' | 'cursor' | 'cline' | 'hermes' | 'mock';

export interface AgentTask {
  sessionId: string;      // chat_id:string
  agent: AgentId;
  model?: string;
  prompt: string;
  workdir: string;        // ./work/<chat_id>, вне — запрещено
  timeoutMs: number;
}

export type AgentEvent =
  | { type: 'text'; delta: string }
  | { type: 'done'; exitCode: number }
  | { type: 'error'; message: string }; // без секретов

export interface AgentResult { text: string; exitCode: number; }

export interface IAgentProvider {
  readonly id: AgentId;
  run(task: AgentTask, onEvent: (e: AgentEvent) => void): Promise<AgentResult>;
  cancel(sessionId: string): Promise<void>;
}
```

Правила casing: Telegram/API — camelCase снаружи, внутри всё snake→camel на границе провайдера. Токены — только `process.env`, никогда в `AgentTask` и в логи.

## 5. Провайдеры (как реализованы)

- **opencode (референс):** `spawn('opencode', ['run', prompt, '--format', 'json'], { cwd: workdir })`. stdout построчно → `onEvent({type:'text'})`. `cancel` = `child.kill('SIGTERM')` по `sessionId`.
- **cursor:** `spawn('cursor-agent', ['--print', prompt], ...)`. Тот же `spawnRunner`.
- **cline:** `spawn('roo-code', [...])`. Если CLI нет — file-adapter: пишет `task.json` в workdir, поллит `result.json` (таймаут). Ядро этого не видит.
- **hermes:** `fetch POST {baseUrl}/v1/agent/run {prompt, model, sessionId}`, токен из `HERMES_API_KEY`. SSE/chunked → `onEvent`. Без URL/ключа провайдер кидает `not configured` (secret-free).
- **mock:** эхо с задержкой, для тестов без агентов.

Общий хелпер `src/gateway/spawnRunner.ts` — один на все CLI-провайдеры (spawn, таймаут, kill-map, sanitize ошибок).

## 6. Команды Telegram

```
/start — привет + какой агент активен
/ask <текст> — быстрый вопрос активному агенту
/code <задача> — кодовая задача (папка проекта чата)
/agent <id> — переключить провайдера
/model <name> — переключить модель
/project <name|path> — привязать чат к папке проекта (внутри ALLOWED_ROOTS)
/clone <url> — склонировать репо в WORK_ROOT
/auto on|off — shell без подтверждения / с подтверждением
/approve — подтвердить ожидающее действие агента
/new — очистить историю чата
/status — очередь + текущая задача
/cancel — убить текущую задачу
Фото без команды — приложить картинку к следующему /ask (сохраняется в workdir).
```

## 7. Безопасность и лимиты

- `ALLOWED_CHAT_IDS` — только id владельца. Чужой chat_id → молча игнор.
- Файлы: агент работает только внутри `ALLOWED_ROOTS` (список папок через `;`, дефолт `./work`).
  Каждый чат привязан к одной папке (`/project`), выход наверх запрещён (`path.resolve` проверка).
  Про папки простыми словами: боту можно разрешить только те папки, которые ты укажешь.
  Например `D:\projects\nx` — тогда из телефона сможешь кодить Nexora; `./work` — песочница по умолчанию.
- Shell-команды агента: при `/auto off` бот присылает команду и ждёт `/approve`.
- Таймаут 45 мин, max ответ 4000 символов/сообщение (нарезка), rate-limit 1 задача на чат.
- История: вся в SQLite, в агента — последние 50 сообщений. `/new` сбрасывает.
- Ошибки наружу: `E_AGENT_FAILED`, `E_TIMEOUT`, `E_NOT_CONFIGURED` — без команд, ключей, SQL.

## 8. Конфиг (env)

```
BOT_TOKEN= (обязательно)
ALLOWED_CHAT_IDS= (обязательно, id владельца)
DEFAULT_AGENT=opencode
DEFAULT_MODEL=
TASK_TIMEOUT_MS=900000
WORK_ROOT=./work
OPENCODE_BIN=opencode
CURSOR_BIN=cursor-agent
CLINE_BIN=roo-code
HERMES_BASE_URL= / HERMES_API_KEY=
ALLOWED_ROOTS=./work (папки через ; — например D:\projects\nx)
AUTO_APPROVE=false
HISTORY_LIMIT=50
```

## 9. Почему переживёт смену агентов

Новый агент = 1 новый файл в `src/providers/` + 1 строка в `ProviderRegistry` + 1 задача в `TASK-BREAKDOWN.md`. Ядро, ТГ-слой, БД не трогаем.
