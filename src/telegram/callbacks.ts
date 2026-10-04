import type { Bot, Context } from 'grammy';
import type { Config } from '../config.js';
import { approvalReply, resolveApproval } from '../core/approvals.js';
import type { Responder } from '../core/queue.js';
import { TaskQueue } from '../core/queue.js';
import { cachedModels, matchModels } from '../gateway/models.js';
import type { Store } from '../storage/db.js';
import {
  approveDenyKeyboard,
  parsePlanPayload,
  SCOPE,
  planKeyboard,
} from './keyboard.js';
import { parseCallback, take } from './nonce.js';

/**
 * Telegram layer: callback-query parsing and rendering only.
 *
 * A callback carries nothing but `scope:nonce`; the nonce is resolved server-side via
 * `take` (single-use). Everything a handler needs about the payload comes out of that
 * lookup, never out of the update itself. Business decisions (approvals, session
 * updates, plan approval) are owned by Core and reached through `Deps`; this module
 * must not call a provider or a CLI.
 *
 * Every path answers the callback query so the phone never keeps a spinner.
 */

export interface CallbackDeps {
  cfg: Config;
  store: Store;
  queue: TaskQueue;
  io: Responder;
}

/** Short Russian notice for a nonce that is expired / used / from another chat. */
const STALE = '⌛ Кнопка устарела. Отправь команду заново.';

/** Plan actions: delegate to the queue's state machine, never reimplement it. */
async function handlePlan(ctx: Context, deps: CallbackDeps, payload: string): Promise<void> {
  const decoded = parsePlanPayload(payload);
  const chatId = ctx.chat?.id;
  if (decoded === null || chatId === undefined) {
    await ctx.reply('⌛ Кнопка устарела. Отправь команду заново.');
    return;
  }
  if (!deps.queue.hasPlan(chatId)) {
    await ctx.reply('Плана уже нет — возможно, он отменён или запущен.');
    return;
  }
  if (decoded.action === 'run') {
    const id = deps.queue.approvePlan(chatId);
    await ctx.reply(id === null ? 'Нечего запускать.' : `▶ Запускаю задачу #${id}.`);
    return;
  }
  // Rework: the queue creates a follow-up task that re-plans with the comment.
  const rounds = deps.queue.reworkPlan(chatId, 'Пожалуйста, доработай план.');
  await ctx.reply(rounds === null ? 'Раунды доработки закончились — запускаю как есть.' : '✏️ Ок, план на доработку.');
}

/**
 * Register the callback_query handler. Returns nothing; grammy dispatches by
 * registration. Placed in the Telegram layer and called from `registerRouter`.
 */
export function registerCallbacks(bot: Bot, deps: CallbackDeps): void {
  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;
    const chatId = ctx.chat?.id;
    // Answer first thing in every path so no client keeps a spinner; the notice
    // strings below are deliberately terse.
    try {
      if (chatId === undefined) {
        await ctx.answerCallbackQuery();
        return;
      }
      if (!deps.cfg.allowedChatIds.includes(chatId)) {
        await ctx.answerCallbackQuery({ text: 'Нет доступа.' });
        return;
      }
      const parsed = parseCallback(data);
      if (parsed === null) {
        await ctx.answerCallbackQuery({ text: STALE });
        return;
      }
      // Single-use lookup: wrong chat / wrong scope / expired / reused -> null.
      const payload = take(chatId, parsed.scope, parsed.nonce);
      if (payload === null) {
        await ctx.answerCallbackQuery({ text: STALE });
        await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined);
        return;
      }

      switch (parsed.scope) {
        case SCOPE.approve: {
          const ok = payload !== '';
          const r = resolveApproval(chatId, ok);
          await ctx.answerCallbackQuery({ text: r === 'live' ? (ok ? 'Разрешено' : 'Отклонено') : 'Не актуально' });
          await ctx.reply(approvalReply(r, ok));
          break;
        }

        case SCOPE.plan: {
          await ctx.answerCallbackQuery();
          await handlePlan(ctx, deps, payload);
          break;
        }

        default: {
          // Unknown scope: feature not in this wave. Neutral reply, no throw.
          await ctx.answerCallbackQuery({ text: 'Недоступно' });
          await ctx.reply('🔧 Недоступно в этой сборке.');
          break;
        }
      }
    } catch {
      // A callback must never crash the bot loop; if the answer already went out the
      // client is happy, otherwise answer now.
      await ctx.answerCallbackQuery().catch(() => undefined);
    }
  });
}

/**
 * `/model <text>` — resolve typed text against the LIVE list.
 *
 * Returns the model id to store, or null when nothing matched (the caller then shows
 * `candidates`). A bare substring used to be accepted silently and blow up inside the
 * agent; here it comes back as "did you mean" buttons instead.
 */
export async function resolveModelArg(
  cfg: Config,
  text: string,
): Promise<{ id: string | null; candidates: string[]; error: string | null }> {
  const listed = await cachedModels(cfg.opencodeBin);
  if (listed.models.length === 0) return { id: null, candidates: [], error: listed.error };
  const wanted = text.trim().toLowerCase();
  const exact = listed.models.find((m) => m.toLowerCase() === wanted);
  if (exact !== undefined) return { id: exact, candidates: [], error: null };
  return { id: null, candidates: matchModels(listed.models, text), error: null };
}

/** Mint a fresh approve/deny keyboard for a pending shell command. */
export function approvalKeyboard(chatId: number): ReturnType<typeof approveDenyKeyboard> {
  return approveDenyKeyboard(chatId, SCOPE.approve, 'ok', 'no');
}

/** Mint a fresh plan keyboard; the task id is only ever carried server-side. */
export function pendingPlanKeyboard(chatId: number, taskId: number): ReturnType<typeof planKeyboard> {
  return planKeyboard(chatId, taskId);
}
