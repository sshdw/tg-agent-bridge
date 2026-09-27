# PROMPTS — 3 промпта до готового бота

Скопируй инженеру как есть, по одному за раз.

## ПРОМПТ 1 (скаффолд + ядро, 1 агент)
```
В папке tg-agent-bridge подними Node 20 + TS strict + grammy + better-sqlite3 скелет по docs/ARCHITECTURE.md и docs/TZ.md.
Выполни задачу T1 из docs/TASK-BREAKDOWN.md: Telegram Core + Router + Sessions + Queue + SQLite + IAgentProvider + mock-провайдер.
Требования: npm run dev запускается, /start и /ask на mock отвечают, npx tsc --noEmit чисто. Только код из T1, провайдеры из T3-T5 не трогай.
```

## ПРОМПТ 2 (5 провайдеров параллельно, 5 агентов)
```
Разбери docs/TASK-BREAKDOWN.md задачи T2,T3,T4,T5,T6 на 5 параллельных агентов, каждый делает только свой файл(ы):
T2: src/gateway/spawnRunner.ts + src/providers/opencode.ts
T3: src/providers/cursor.ts
T4: src/providers/cline.ts
T5: src/providers/hermes.ts
T6: Dockerfile + нарезка + лимиты + sanitize
Контракт IAgentProvider из T1 не менять. После каждой — npx tsc --noEmit. В конце сведи registry и проверь /agent <id> для каждого.
```

## ПРОМПТ 3 (приёмка)
```
Прогони приёмку из docs/TZ.md п.4: /start, /ask на mock, /agent переключение, /code со стримом, /cancel длинной задачи, kill провайдера без падения бота.
Почини найденное, добавь недостающее в README run-раздел, убедись что BOT_TOKEN и ключи только в .env, в логах секретов нет.
Финал: npm run build + docker build проходят, npx tsc чисто.
```
