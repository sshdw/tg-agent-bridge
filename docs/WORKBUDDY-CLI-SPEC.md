# WorkBuddy: переезд провайдера с HTTP на CLI (спек для инженера)

## Факт
У обычного WorkBuddy НЕТ HTTP API. Файл `src/providers/workbuddy.ts` сейчас ходит в выдуманный
`POST {base}/v1/agent/run` — так не заработает никогда. Реальный путь — локальный CLI.

## Что найдено (проверено руками 27.09.2026)
- WorkBuddyAI = CodeBuddy CLI (`@genie/agent-cli`), лежит в:
  `D:\Apps\WorkBuddyAI\resources\app.asar.unpacked\cli\bin\codebuddy` (node-скрипт с shebang).
- Неинтерактивный режим: `node <script> -p --output-format stream-json '<prompt>'` — работает,
  отвечает JSONL, exit 0. Проверено: `2+2` → `**4**`.
- Формат строк: `{"type":"assistant",...,"message":{"content":[{"type":"text","text":"..."}]}}`,
  финал: `{"type":"result",...,"is_error":bool,...}`. `is_error=true` даже при exit 0!
- Флаги разрешений: `--permission-mode <acceptEdits|bypassPermissions|default|plan|dontAsk|auto>`.
  Решение владельца (вариант A, как opencode `--auto`): всегда `bypassPermissions`, иначе
  задача висит без отвечающего. Безопасность — через ALLOWED_ROOTS + whitelist + /cancel.
- Авторизация: CLI требует свой логин (`Authentication required. Please use /login`).
  Логин десктоп-приложения НЕ shared с CLI. Владелец логинит CLI сам один раз
  (TUI `/login` через браузер). Сторидж: `C:\Users\gogog\.codebuddy`.
- Открытый вопрос: передача картинок в print-режиме (аналога `--file` не найден; проверить
  `--input-format stream-json` или передавать пути текстом в промпте).

## Задача (T-WorkBuddy, один агент)
1. Переписать `src/providers/workbuddy.ts`: CLI-адаптер поверх `spawnRunner`
   (как `opencode.ts`). Запуск: `bin = process.execPath` (текущий node, без зависимости от PATH),
   `args = [<codebuddyScript>, '-p', '--output-format', 'stream-json', '--permission-mode', 'bypassPermissions', <composePrompt(task)>]`
   (+ `--model`, если `task.model` задан и CLI его принимает в print-режиме — проверить).
   `cwd = task.workdir`. Путь к скрипту — `WORKBUDDY_CLI` из env с дефолтом на путь выше.
2. Парсер строк: текст из `assistant.message.content[]` (`type:text`), дифф по `uuid`
   (части могут быть кумулятивными — проверить и дедуплицировать как в opencode-провайдере).
   `type:result` с `is_error=true` → `E_AGENT_FAILED`; текст `Authentication required` внутри →
   `E_NOT_CONFIGURED: workbuddy CLI login required (run codebuddy /login once)`.
3. Убрать `WORKBUDDY_BASE_URL`/`WORKBUDDY_API_KEY` из `.env.example` (заменить на `WORKBUDDY_CLI`),
   `fetchRunner` не использовать. id провайдера `workbuddy` не менять (сессии/команды не трогать).
4. Приёмка: `npx tsc --noEmit`, `/agent workbuddy` + `/ask 2+2` с телефона владельца
   (только после его логина!), `/cancel` посреди задачи. Коммит + push.
