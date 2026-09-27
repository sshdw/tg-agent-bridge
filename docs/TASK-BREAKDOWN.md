# TASK-BREAKDOWN — 6 задач для параллельного саммона

Инженер саммонит до 6 агентов одновременно, каждый — 1 файл-задача. Порядок: T1+T2 сначала, затем T3–T6 параллельно.

## T1 — Scaffold + Telegram Core (база, без неё остальные не встанут)
Файлы: `package.json`, `tsconfig.json`, `.env.example`, `src/index.ts`, `src/telegram/bot.ts`, `src/core/{router,sessions,queue,permissions}.ts`, `src/storage/db.ts`, `src/gateway/{types,registry}.ts`, `src/providers/mock.ts`.
Команды T1: `/start /ask /code /agent /model /project /clone /auto /approve /new /status /cancel` + приём фото. Сессия на чат: агент, модель, проект, вся история (в контекст — последние 50). Whitelist по `ALLOWED_CHAT_IDS`, `ALLOWED_ROOTS`.
Готово когда: `npm run dev` + `/start`, `/ask` на mock отвечают. `npx tsc --noEmit` чисто.

## T2 — spawnRunner + opencode (референсный провайдер)
Файлы: `src/gateway/spawnRunner.ts`, `src/providers/opencode.ts`.
Готово когда: `/agent opencode` + `/ask` реально дергает `opencode run`, стрим идёт в ТГ, `/cancel` убивает процесс.

## T3 — cursor provider
Файл: `src/providers/cursor.ts` поверх `spawnRunner` (`cursor-agent --print`). Не трогать ядро. Фолбэк `E_NOT_CONFIGURED` если бинарника нет.

## T4 — cline provider
Файл: `src/providers/cline.ts`. CLI `roo-code`, иначе file-adapter `task.json/result.json` в workdir. Документировать в шапке файла какой путь активен.

## T5 — hermes + workbuddy (HTTP)
Файлы: `src/providers/{hermes,workbuddy}.ts` на общем `fetchRunner` (POST + AbortController + потоковый парсинг). Ключи только из env. Без ключа — `E_NOT_CONFIGURED`.

## T6 — Hardening + Docker
Файлы: `Dockerfile`, `.dockerignore`, `README` run-раздел, нарезка >4000 символов, rate-limit, sanitize ошибок, `bot.log`. Финальный прогон приёмки из TZ.md п.4.

## Правила для всех
- Не менять `IAgentProvider` без согласования с T1.
- 1 провайдер = 1 файл, регистрация 1 строкой в registry.
- Никаких секретов в коде/логах/ответах. Только `process.env`.
- После каждой задачи: `npx tsc --noEmit`.
