import { mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { loadConfig } from './config.js';
import type { Config } from './config.js';
import { TaskQueue } from './core/queue.js';
import type { Responder } from './core/queue.js';
import type { Deps } from './core/router.js';
import { createResponder } from './core/router.js';
import { registerPlanFlow } from './core/plan.js';
import { register } from './gateway/registry.js';
import { ClineProvider } from './providers/cline.js';
import { CursorProvider } from './providers/cursor.js';
import { HermesProvider } from './providers/hermes.js';
import { MockProvider } from './providers/mock.js';
import { OpenCodeProvider } from './providers/opencode.js';
import { Store } from './storage/db.js';
import { createBot } from './telegram/bot.js';
import { startCiPoller } from './github/ciPoller.js';
import { log } from './log.js';
import { VERSION } from './version.js';

export { log };

/** Short SHA of the working tree, or 'unknown' outside a git checkout. */
export function shortSha(): string {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }).trim();
  } catch {
    return 'unknown';
  }
}

function logResolvedBins(cfg: Config): void {
  log(`bin opencode=${cfg.opencodeBin}`);
  log(`bin whisper=${cfg.whisperBin} model=${cfg.voiceModelPath === '' ? '(unset)' : cfg.voiceModelPath}`);
  log(`github token: ${cfg.githubToken === '' ? 'absent' : 'present'}`);
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  mkdirSync(cfg.workRoot, { recursive: true });
  const store = new Store(cfg.dbPath);
  register(new OpenCodeProvider(cfg.opencodeBin));
  register(new CursorProvider(cfg.cursorBin));
  register(new ClineProvider(cfg.clineBin));
  register(new HermesProvider(cfg.hermesBaseUrl, cfg.hermesApiKey));
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
  registerPlanFlow(deps.queue, deps.io);

  log(`bot up. version=${VERSION} sha=${shortSha()} default agent=${cfg.defaultAgent}, timeout=${cfg.taskTimeoutMs}ms`);
  log(`allowed chats: ${cfg.allowedChatIds.join(',') || '(none — bot will ignore everyone)'}`);
  logResolvedBins(cfg);

  // Boot recovery: a `running` row cannot belong to a live process (single-instance
  // bot, one task per chat), so flip it back to `pending` and tell the owner.
  // Nothing is executed automatically — the owner decides whether to resume.
  const interrupted = store.recoverStaleRunning();
  const running = store.listAllCiWatch().length;
  for (const chatId of cfg.allowedChatIds) {
    const sha = shortSha();
    await deps.io
      .notify(chatId, `🟢 я жив (v${VERSION}, ${sha}), прерванных задач: ${interrupted}`)
      .catch(() => undefined);
  }
  if (interrupted > 0) log(`recovered ${interrupted} stale running task(s) -> pending`);
  if (running > 0) log(`ci watch entries: ${running}`);

  startCiPoller(cfg, store, deps.io);

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
