import { appendFileSync, mkdirSync } from 'node:fs';
import { loadConfig } from './config.js';
import { TaskQueue } from './core/queue.js';
import type { Responder } from './core/queue.js';
import type { Deps } from './core/router.js';
import { createResponder } from './core/router.js';
import { register } from './gateway/registry.js';
import { MockProvider } from './providers/mock.js';
import { OpenCodeProvider } from './providers/opencode.js';
import { Store } from './storage/db.js';
import { createBot } from './telegram/bot.js';

function log(line: string): void {
  const out = `[${new Date().toISOString()}] ${line}\n`;
  process.stdout.write(out);
  try {
    appendFileSync('bot.log', out);
  } catch {
    // logging must never crash the bot
  }
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  mkdirSync(cfg.workRoot, { recursive: true });
  const store = new Store(cfg.dbPath);
  register(new OpenCodeProvider(cfg.opencodeBin));
  register(new MockProvider());

  // Deps is filled in two steps: handlers read deps.queue/deps.io lazily at call time.
  const deps = {
    cfg,
    store,
    queue: undefined as unknown as TaskQueue,
    io: undefined as unknown as Responder,
  } satisfies Deps;
  const bot = createBot(cfg, deps);
  deps.io = createResponder(bot);
  deps.queue = new TaskQueue(store, cfg, deps.io);

  log(`bot up. default agent=${cfg.defaultAgent}, timeout=${cfg.taskTimeoutMs}ms`);
  log(`allowed chats: ${cfg.allowedChatIds.join(',') || '(none — bot will ignore everyone)'}`);

  const stop = (): void => {
    log('stopping...');
    void bot.stop();
    store.close();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  await bot.start({
    onStart: (info) => log(`polling as @${info.username}`),
  });
}

main().catch((e: unknown) => {
  const m = e instanceof Error ? e.message : String(e);
  console.error(m.slice(0, 300));
  process.exit(1);
});
