import { Bot } from 'grammy';
import type { Config } from '../config.js';
import { isAllowed } from '../core/permissions.js';
import type { Deps } from '../core/router.js';
import { registerRouter } from '../core/router.js';
import { getOrCreate } from '../core/sessions.js';

/** Telegram layer: auth + routing only. No business logic, no direct CLI calls. */
export function createBot(cfg: Config, deps: Deps): Bot {
  const bot = new Bot(cfg.botToken);

  bot.use(async (ctx, next) => {
    const id = ctx.chat?.id;
    if (id === undefined || !isAllowed(cfg, id)) return;
    // Ensure the session row exists before any handler runs, so commands that
    // only patch a session (/model, /auto, /project, /agent) also work as the
    // very first message, without a preceding /start.
    getOrCreate(deps.store, cfg, id);
    await next();
  });

  registerRouter(bot, deps);

  bot.catch((err) => {
    const m = err instanceof Error ? err.message : String(err);
    console.error(`[bot] ${m.slice(0, 200)}`);
  });

  return bot;
}
