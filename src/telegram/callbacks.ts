import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Bot, Context } from 'grammy';
import type { Config } from '../config.js';
import { AGENT_IDS } from '../config.js';
import { resolveApproval } from '../core/approvals.js';
import type { Responder } from '../core/queue.js';
import { TaskQueue } from '../core/queue.js';
import { dropAgentSession, getOrCreate, updateSession } from '../core/sessions.js';
import { projectDeniedMessage, resolveWorkdir } from '../core/permissions.js';
import { cachedModels, matchModels, pickModels } from '../gateway/models.js';
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

/* ----------------------------------------------------------------- projects */

/**
 * One bindable project directory, as offered by the picker.
 *
 * `name` alone is NOT an identity: with `ALLOWED_ROOTS=./work;D:/projects` two roots can
 * each contain a folder called `api`, and binding the wrong one silently runs the agent
 * in the wrong tree. So every entry carries the absolute directory it resolves to, and
 * the callback data holds that path server-side (`nonce.ts`), never the owner's input.
 */
export interface ProjectEntry {
  /** Directory name, for display. */
  name: string;
  /** Absolute directory. This is what `resolveWorkdir` receives. */
  dir: string;
  /** Which configured root it came from. */
  root: string;
  /** Button text: `name` when unique across roots, `name · root-label` otherwise. */
  label: string;
}

/** Short, unambiguous tag for a root: its last path segment (`work`, `projects`). */
export function rootLabel(root: string): string {
  const parts = root.split(/[\\/]+/).filter((p) => p !== '' && p !== '.');
  return parts[parts.length - 1] ?? root;
}

/** Internal folders that are not projects. */
const NON_PROJECT_DIRS = new Set(['inbox', 'node_modules']);

/**
 * Every candidate project directory across ALL configured allowed roots.
 *
 * This is the fix for "почему из разрешенных только эти 3 папки": the old version read
 * `WORK_ROOT` only, so with `ALLOWED_ROOTS=./work;D:/projects` the owner could bind
 * `/project tg-v04` but never saw it offered. Enumeration is a DISCOVERY step — every
 * path still goes through `resolveWorkdir`'s containment guard before it can be used,
 * and names that collide across roots are labelled apart.
 */
export function listProjects(cfg: Config): ProjectEntry[] {
  const found: ProjectEntry[] = [];
  const counts = new Map<string, number>();
  for (const root of cfg.allowedRoots) {
    let names: string[];
    try {
      names = readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .filter((n) => !NON_PROJECT_DIRS.has(n) && !n.startsWith('.'))
        .sort();
    } catch {
      continue;
    }
    for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
    for (const name of names) found.push({ name, dir: join(root, name), root, label: name });
  }
  // Disambiguate only where it is actually needed, so the common case stays one tap.
  const rootLabels = new Map<string, string>();
  for (const root of cfg.allowedRoots) {
    rootLabels.set(root, rootLabel(root));
  }
  for (const e of found) {
    if ((counts.get(e.name) ?? 0) > 1) e.label = `${e.name} · ${rootLabels.get(e.root) ?? e.root}`;
  }
  return found;
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
          const prevAgent = deps.store.getSession(chatId)?.agent;
          updateSession(deps.store, chatId, { agent: payload as (typeof AGENT_IDS)[number] });
          if (prevAgent !== undefined && prevAgent !== payload) dropAgentSession(deps.store, chatId);
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
          // The payload is the ABSOLUTE directory the picker enumerated, minted into a
          // server-side nonce; the guard still has the last word on it.
          let dir = payload;
          if (payload !== '') {
            try {
              dir = resolveWorkdir(deps.cfg, chatId, payload);
            } catch (e) {
              await ctx.answerCallbackQuery({ text: 'Папка недоступна' });
              await ctx.reply(projectDeniedMessage(e));
              break;
            }
          }
          const prevProject = deps.store.getSession(chatId)?.project;
          updateSession(deps.store, chatId, { project: dir });
          if (prevProject !== undefined && prevProject !== dir) dropAgentSession(deps.store, chatId);
          await ctx.answerCallbackQuery({ text: payload === '' ? 'Песочница' : `Проект: ${payload}` });
          await ctx.reply(payload === '' ? 'Проект: (песочница)' : `Проект: ${dir}`);
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
  const current = s.project === '' ? '(песочница)' : s.project;
  if (projects.length === 0) {
    await ctx.reply(
      `Проект: ${current}\n\nПапок в разрешённых корнях пока нет: ${deps.cfg.allowedRoots.join(', ')}`,
    );
    return;
  }
  await ctx.reply(`Проект: ${current}\nКорни: ${deps.cfg.allowedRoots.join(', ')}`, {
    reply_markup: projectPickerKeyboard(chatId, projects, s.project),
  });
}

/**
 * Register the `/model` picker entry point (no-argument path).
 *
 * The list comes from the live `opencode models` output (cached 6 h), not from a
 * hardcoded array — the old hardcoded ids were invented and none of them existed. When
 * the CLI cannot be run the owner gets a clear Russian notice instead of a picker full
 * of dead buttons, and the current/default models still work.
 */
export async function showModelPicker(ctx: Context, deps: CallbackDeps): Promise<void> {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return;
  const s = getOrCreate(deps.store, deps.cfg, chatId);
  const listed = await cachedModels(deps.cfg.opencodeBin);
  const pins = [s.model, deps.cfg.defaultModel];
  const picks = pickModels(listed.models, pins);
  const head = `Модель: ${s.model === '' ? `(default) ${deps.cfg.defaultModel || '—'}` : s.model}`;
  if (picks.length === 0) {
    await ctx.reply(
      `${head}\n\n⚠️ Не удалось получить список моделей: ${listed.error ?? 'opencode models вернул пусто'}.\n` +
        'Проверь OPENCODE_BIN в .env. Текущая модель продолжает работать.',
    );
    return;
  }
  await ctx.reply(
    `${head}\nНайдено моделей: ${listed.models.length}${listed.cached ? ' (из кэша)' : ''}. Показано: ${picks.length}.`,
    { reply_markup: modelKeyboard(chatId, picks, s.model) },
  );
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
