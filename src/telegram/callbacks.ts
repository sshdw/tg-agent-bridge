import { readdirSync } from 'node:fs';
import type { Bot, Context } from 'grammy';
import type { Config } from '../config.js';
import { AGENT_IDS } from '../config.js';
import { resolveApproval } from '../core/approvals.js';
import type { Responder } from '../core/queue.js';
import { TaskQueue } from '../core/queue.js';
import { getOrCreate, updateSession } from '../core/sessions.js';
import { resolveWorkdir } from '../core/permissions.js';
import { availableProviders } from '../gateway/registry.js';
import type { Store } from '../storage/db.js';
import {
  approveDenyKeyboard,
  agentPickerKeyboard,
  modelKeyboard,
  parsePlanPayload,
  parseUpdatePayload,
  projectPickerKeyboard,
  SCOPE,
  planKeyboard,
  updateConfirmKeyboard,
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

/** Reachable set of models offered by the model picker, curated for phone readability. */
export const MODEL_CHOICES: readonly string[] = [
  'claude-sonnet-4-5',
  'claude-opus-4-1',
  'gpt-5',
  'gpt-5-mini',
  'o4-mini',
  'gemini-2.5-pro',
];

/** Model buttons to actually show: the curated set, the current model, and the default. */
export function modelChoices(cfg: Config, current: string): string[] {
  const set = new Set<string>(MODEL_CHOICES);
  if (current !== '') set.add(current);
  if (cfg.defaultModel !== '') set.add(cfg.defaultModel);
  return [...set];
}

/** Subdirectory names inside WORK_ROOT — the projects a chat may bind to. */
export function listProjects(cfg: Config): string[] {
  try {
    return readdirSync(cfg.workRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .filter((n) => n !== 'inbox' && !n.startsWith('.'))
      .sort();
  } catch {
    return [];
  }
}

/** Short Russian notice for a nonce that is expired / used / from another chat. */
const STALE = '⌛ Кнопка устарела. Отправь команду заново.';

/**
 * The `/update` flow lives in `src/core/update.ts`; this is the Telegram seam
 * that runs it after the double-confirm buttons. The button router above
 * already handled stage 1 ("обновить?") → stage 2 ("точно обновить?"), so by
 * the time we get here the owner confirmed twice.
 */
export async function runUpdateConfirm(ctx: Context, cfg: Config, _io: Responder, stage: 1 | 2): Promise<void> {
  void cfg;
  void _io;
  void stage;
  const { confirmUpdate } = await import('../core/update.js');
  await confirmUpdate({ reply: (text: string) => ctx.reply(text) });
}

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
          const resolved = resolveApproval(chatId, ok);
          await ctx.answerCallbackQuery({ text: ok ? 'Разрешено' : 'Отклонено' });
          if (resolved) await ctx.reply(ok ? '✅ Разрешено.' : 'Отклонено.');
          else await ctx.reply('Нечего подтверждать.');
          break;
        }

        case SCOPE.agent: {
          if (!(AGENT_IDS as readonly string[]).includes(payload)) {
            await ctx.answerCallbackQuery({ text: 'Нет такого агента' });
            break;
          }
          updateSession(deps.store, chatId, { agent: payload as (typeof AGENT_IDS)[number] });
          await ctx.answerCallbackQuery({ text: `Агент: ${payload}` });
          await ctx.reply(`Агент: ${payload}`);
          break;
        }

        case SCOPE.model: {
          updateSession(deps.store, chatId, { model: payload });
          await ctx.answerCallbackQuery({ text: payload === '' ? 'Модель сброшена' : `Модель: ${payload}` });
          await ctx.reply(payload === '' ? 'Модель сброшена (default).' : `Модель: ${payload}`);
          break;
        }

        case SCOPE.project: {
          if (payload !== '') {
            try {
              resolveWorkdir(deps.cfg, chatId, payload);
            } catch {
              await ctx.answerCallbackQuery({ text: 'Папка недоступна' });
              await ctx.reply('🔒 Папка вне разрешённых. Смотри ALLOWED_ROOTS в .env.');
              break;
            }
          }
          updateSession(deps.store, chatId, { project: payload });
          await ctx.answerCallbackQuery({ text: payload === '' ? 'Песочница' : `Проект: ${payload}` });
          await ctx.reply(payload === '' ? 'Проект: (песочница)' : `Проект: ${payload}`);
          break;
        }

        case SCOPE.plan: {
          await ctx.answerCallbackQuery();
          await handlePlan(ctx, deps, payload);
          break;
        }

        case SCOPE.update: {
          const decoded = parseUpdatePayload(payload);
          await ctx.answerCallbackQuery();
          if (decoded === null) {
            await ctx.reply(STALE);
            break;
          }
          if (decoded.decision === 'no') {
            await ctx.reply('Отменено.');
            break;
          }
          if (decoded.stage === 1) {
            await ctx.reply('Точно обновить? Процесс перезапустится.', {
              reply_markup: updateConfirmKeyboard(chatId, 2),
            });
            break;
          }
          await runUpdateConfirm(ctx, deps.cfg, deps.io, 2);
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

/** Register the `/agent` picker entry point (no-argument path). */
export async function showAgentPicker(ctx: Context, deps: CallbackDeps): Promise<void> {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return;
  const s = getOrCreate(deps.store, deps.cfg, chatId);
  const agents = availableProviders();
  await ctx.reply(
    `Агент: ${s.agent}\nДоступны: ${agents.join(', ')}`,
    { reply_markup: agentPickerKeyboard(chatId, agents, s.agent) },
  );
}

/** Register the `/project` picker entry point (no-argument path). */
export async function showProjectPicker(ctx: Context, deps: CallbackDeps): Promise<void> {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return;
  const s = getOrCreate(deps.store, deps.cfg, chatId);
  const projects = listProjects(deps.cfg);
  if (projects.length === 0) {
    await ctx.reply(`Проект: ${s.project === '' ? '(песочница)' : s.project}\n\nПапок в WORK_ROOT пока нет.`);
    return;
  }
  await ctx.reply(`Проект: ${s.project === '' ? '(песочница)' : s.project}`, {
    reply_markup: projectPickerKeyboard(chatId, projects, s.project),
  });
}

/** Register the `/model` picker entry point (no-argument path). */
export async function showModelPicker(ctx: Context, deps: CallbackDeps): Promise<void> {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return;
  const s = getOrCreate(deps.store, deps.cfg, chatId);
  const models = modelChoices(deps.cfg, s.model);
  await ctx.reply(`Модель: ${s.model === '' ? '(default)' : s.model}`, {
    reply_markup: modelKeyboard(chatId, models, s.model),
  });
}

/** Mint a fresh approve/deny keyboard for a pending shell command. */
export function approvalKeyboard(chatId: number): ReturnType<typeof approveDenyKeyboard> {
  return approveDenyKeyboard(chatId, SCOPE.approve, 'ok', 'no');
}

/** Mint a fresh plan keyboard; the task id is only ever carried server-side. */
export function pendingPlanKeyboard(chatId: number, taskId: number): ReturnType<typeof planKeyboard> {
  return planKeyboard(chatId, taskId);
}
