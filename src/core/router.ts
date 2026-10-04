import { join, resolve } from 'node:path';
import { type Bot } from 'grammy';
import type { Config } from '../config.js';
import { AGENT_IDS } from '../config.js';
import { hasApproval, approvalReply, resolveApproval } from '../core/approvals.js';
import { displayName, errorCode, inboxFilename } from '../core/files.js';
import type { Responder } from '../core/queue.js';
import { TaskQueue } from '../core/queue.js';
import { CODE_USAGE, requestCode, tryPlanRework } from '../core/plan.js';
import { PRESET_NAMES, applyPreset, type PresetName } from '../core/presets.js';
import { dropAgentSession, getOrCreate, updateSession } from '../core/sessions.js';
import { projectDeniedMessage, resolveWorkdir } from '../core/permissions.js';
import { listProjects } from '../core/projects.js';
import { cachedModels, modelLabel, pickModels } from '../gateway/models.js';
import { availableProviders } from '../gateway/registry.js';
import type { Store } from '../storage/db.js';
import { createStream, escapeHtml, saveInboundFile, sendMarkdown } from '../telegram/stream.js';
import { sendOutboundFile } from '../telegram/outbound.js';
import { approvalKeyboard, registerCallbacks, resolveModelArg } from '../telegram/callbacks.js';
import { SCOPE } from '../telegram/keyboard.js';
import { clear } from '../telegram/nonce.js';
import { transcribeVoice } from '../voice/index.js';
import { log } from '../log.js';

export interface Deps {
  cfg: Config;
  store: Store;
  queue: TaskQueue;
  io: Responder;
  /**
   * Optional live grammy Bot. `registerRouter` captures the bot it is handed and
   * uses that; this field exists only so callers that already have a bot can pass
   * one. `src/index.ts` deliberately leaves it unset.
   */
  bot?: Bot;
}

const arg = (text: string | undefined): string => (text ?? '').split(' ').slice(1).join(' ').trim();

function ask(bot: Bot, deps: Deps, chatId: number, prompt: string, mode: 'ask' | 'code'): Promise<void> {
  if (prompt === '') {
    return deps.io.notify(chatId, mode === 'ask' ? 'Использование: /ask <вопрос>' : 'Использование: /code <задача>');
  }
  const images = takeImages(chatId);
  const state = deps.queue.submit(chatId, prompt, mode, images);
  if (state === 'queued') return deps.io.notify(chatId, '⏳ В очередь. Дождись текущей задачи.');
  return Promise.resolve();
}

// WAVE2/FILES-BEGIN — outbound + inbound file plumbing. Keep this block
// self-contained so sibling router edits merge cleanly around it.
//
// One pending-files map for every inbound kind (photo/document/audio/video), so the
// shared handlers below cannot drift. The queue's `images: string[]` field carries
// arbitrary absolute paths, so documents and images ride the same field.
const pendingFiles = new Map<number, PendingEntry>();

/** Inbound files live on disk (`<workdir>/inbox`); this map only remembers them. */
interface PendingEntry {
  /** Each file carries its own receive time, so one append cannot extend another's TTL. */
  files: { path: string; addedAt: number }[];
  /** Owning chat: `takeImages(chatId)` only ever returns its own entry. */
  chatId: number;
}

/** Inbox entries older than this are dropped on read (24 h, W2). */
export const PENDING_FILES_TTL_MS = 24 * 3600 * 1000;

/**
 * The live Bot, captured by `registerRouter`. `src/index.ts` builds Deps in two
 * steps and never sets `bot`, so the router takes it from the parameter instead of
 * widening the Deps contract the orchestrator owns.
 */
let liveBot: Bot | undefined;

function requireBot(): Bot {
  if (liveBot === undefined) throw new Error('E_AGENT_FAILED: bot not ready');
  return liveBot;
}

export function takeImages(chatId: number): string[] {
  sweepPendingFiles();
  const entry = pendingFiles.get(chatId);
  pendingFiles.delete(chatId);
  if (!entry || entry.chatId !== chatId) return [];
  return entry.files.map((f) => f.path);
}

/**
 * Remember inbound files for the next task. Exported so the W2 harness can
 * prove TTL + ownership offline; `receiveInboundFile` delegates here.
 */
export function rememberInboundFiles(chatId: number, paths: string[], nowMs = Date.now()): void {
  sweepPendingFiles(nowMs);
  const prev = pendingFiles.get(chatId);
  const kept = prev && prev.chatId === chatId ? prev.files : [];
  pendingFiles.set(chatId, {
    files: [...kept, ...paths.map((path) => ({ path, addedAt: nowMs }))],
    chatId,
  });
}

/**
 * Drop inbox files older than 24 h. Files already live on disk — only the
 * "attach to next task" memory is forgotten. Returns files dropped.
 */
export function sweepPendingFiles(nowMs = Date.now()): number {
  let dropped = 0;
  for (const [chatId, entry] of pendingFiles) {
    const live = entry.files.filter((f) => nowMs - f.addedAt <= PENDING_FILES_TTL_MS);
    dropped += entry.files.length - live.length;
    if (live.length === 0) pendingFiles.delete(chatId);
    else if (live.length !== entry.files.length) pendingFiles.set(chatId, { files: live, chatId });
  }
  return dropped;
}

/**
 * Shared inbound-file handler for photo/document/audio/video. Downloads into
 * `<workdir>/inbox`, records the path for the next task and keeps the caption as
 * context, exactly like the photo flow always did.
 */
async function receiveInboundFile(
  deps: Deps,
  chatId: number,
  fileId: string,
  suggestedName: string,
  caption: string,
  label: string,
): Promise<void> {
  const s = getOrCreate(deps.store, deps.cfg, chatId);
  const workdir = resolveWorkdir(deps.cfg, chatId, s.project);
  const abs = await saveInboundFile(
    requireBot().api,
    deps.cfg.botToken,
    fileId,
    join(workdir, 'inbox'),
    inboxFilename(suggestedName),
  );
  rememberInboundFiles(chatId, [abs]);
  deps.store.addMessage(chatId, 'user', `[file saved: ${abs}] ${caption}`.trim());
  const name = displayName(abs);
  await deps.io.notify(
    chatId,
    caption === ''
      ? `${label} Сохранено: ${name}. Теперь /ask с вопросом.`
      : `${label} Сохранено: ${name}\nКонтекст: ${caption}`,
  );
}

// W8: /get /files /find, /commit /pr /ci /watch, /clone chat commands deleted
// (cut list §9). Listing, GitHub and clone live in the Mini App / setup docs now;
// the guards (core/files.ts) and inbox plumbing above stay as the API substrate.

/**
 * W8 cut list: commands that no longer exist. Each is registered to a stub
 * that answers with the short help pointer and NEVER executes — a removed
 * command must read as E_UNKNOWN/help, never run, never fall through to
 * the plain-text ask path as an accidental prompt.
 */
const REMOVED_COMMANDS = [
  'clone',
  'exec',
  'sys',
  'get',
  'files',
  'find',
  'auto',
  'status',
  'cost',
  'update',
  'commit',
  'pr',
  'ci',
  'watch',
] as const;

const REMOVED_REPLY =
  '❌ Такой команды больше нет. Доступные: /ask /code /approve /cancel /new /start /help. Файлы, пикеры и статус — в Mini App.';

export function registerRouter(bot: Bot, deps: Deps): void {
  const { cfg, store } = deps;
  liveBot = bot; // WAVE2/FILES: file handlers need the live bot to download/upload.

  // Inline-button callbacks share the same whitelist gate as messages.
  registerCallbacks(bot, deps);

  bot.command('start', (ctx) => {
    const chatId = ctx.chat.id;
    const s = getOrCreate(store, cfg, chatId);
    return deps.io.notify(
      chatId,
      `Привет! Я мост к агентам на этом ПК.\nАгент: ${s.agent}\nПроект: ${s.project === '' ? '(песочница)' : s.project}\n\nОткрой Mini App кнопкой меню — там задачи, файлы и настройки.\n\n/ask вопрос • /code задача • /approve разрешить • /cancel отменить • /new новый диалог • /help все команды`,
    );
  });

  bot.command('help', (ctx) => {
    return deps.io.notify(
      ctx.chat.id,
      `/ask <текст> — вопрос агенту\n/code <задача> — план, запуск после одобрения\n/approve — разрешить команду агента (или кнопка)\n/cancel — отменить\n/new — очистить историю\n/start — это меню\n/help — список команд`,
    );
  });

  bot.command('ask', (ctx) => ask(bot, deps, ctx.chat.id, arg(ctx.message?.text), 'ask'));

  // WAVE2/EXEC-BEGIN (/exec, /sys, plan-mode /code, preset commands)
  // NOTE: registerPlanFlow lives in index.ts (after the queue exists) —
  // calling it here would read deps.queue before it is assigned. Keep this
  // block registration-only; everything else reads deps lazily at call time.

  const codeLike = (
    ctx: { chat: { id: number }; message?: { text?: string } },
    raw: string,
    preset: '' | PresetName,
  ): Promise<void> => {
    const chatId = ctx.chat.id;
    if (raw === '' && (preset === '' || preset === 'fix')) {
      return deps.io.notify(
        chatId,
        preset === 'fix' ? 'Использование: /fix <симптом> — что сломалось?' : CODE_USAGE,
      );
    }
    const busy = deps.queue.status(chatId).running;
    const state = requestCode(deps, chatId, preset === '' ? raw : applyPreset(preset, raw), takeImages(chatId), {
      preset,
    });
    if (state === 'planned' && busy) return deps.io.notify(chatId, '🗺 Готовлю план…');
    return Promise.resolve();
  };

  // Plan mode: /code drafts a plan first; it runs only after approve.
  bot.command('code', (ctx) => codeLike(ctx, arg(ctx.message?.text), ''));

  // Presets = /code with a fixed role prefix (defined once in presets.ts).
  for (const name of PRESET_NAMES) {
    bot.command(name, (ctx) => codeLike(ctx, arg(ctx.message?.text), name));
  }
  // W8: /exec + /sys deleted (cut list §9#6, §9#3). Shell runs through the agent;
  // bridge status lives in the Mini App (GET /api/health).

  // W8: bare pickers moved to the Mini App (More tab). Chat keeps text-only
  // aliases: with an argument they switch, bare they list. No keyboards.
  bot.command('agent', (ctx) => {
    const chatId = ctx.chat.id;
    const id = arg(ctx.message?.text);
    const s = getOrCreate(store, cfg, chatId);
    if (id === '') {
      return deps.io.notify(chatId, `Агент: ${s.agent}\nДоступны: ${availableProviders().join(', ')}\nСменить: /agent <id> (или в Mini App)`);
    }
    if (!(AGENT_IDS as readonly string[]).includes(id)) {
      return deps.io.notify(chatId, `Нет такого агента. Доступны: ${availableProviders().join(', ')}`);
    }
    try {
      const prev = store.getSession(chatId)?.agent;
      updateSession(store, chatId, { agent: id as (typeof AGENT_IDS)[number] });
      if (prev !== undefined && prev !== id) dropAgentSession(store, chatId);
      return deps.io.notify(chatId, `Агент: ${id}`);
    } catch {
      return deps.io.notify(chatId, '❌ E_AGENT_FAILED');
    }
  });

  bot.command('model', async (ctx) => {
    const chatId = ctx.chat.id;
    const m = arg(ctx.message?.text);
    const s = getOrCreate(store, cfg, chatId);
    if (m === '') {
      const listed = await cachedModels(cfg.opencodeBin);
      const picks = pickModels(listed.models, [s.model, cfg.defaultModel]);
      const head = `Модель: ${s.model === '' ? `(default) ${cfg.defaultModel || '—'}` : s.model}`;
      if (picks.length === 0) {
        return deps.io.notify(
          chatId,
          `${head}\n\n⚠️ Не удалось получить список моделей: ${listed.error ?? 'opencode models вернул пусто'}.\n` +
            'Проверь OPENCODE_BIN в .env. Текущая модель продолжает работать.',
        );
      }
      const lines = picks.map((p) => `- ${p.id === s.model ? '✅ ' : ''}${p.label}`).join('\n');
      return deps.io.notify(chatId, `${head}\n${lines}\nСменить: /model <id> (или в Mini App)`);
    }
    // Resolve against the LIVE opencode list. Accepting an unknown id silently is what
    // made the picker look broken: the error only surfaced later, inside the agent.
    const found = await resolveModelArg(cfg, m);
    if (found.error !== null) {
      return deps.io.notify(
        chatId,
        `⚠️ Не удалось получить список моделей: ${found.error}.\n` +
          'Проверь OPENCODE_BIN в .env. Текущая модель продолжает работать.',
      );
    }
    if (found.id !== null) {
      updateSession(store, chatId, { model: found.id });
      return deps.io.notify(chatId, `Модель: ${found.id}`);
    }
    if (found.candidates.length === 0) {
      return deps.io.notify(chatId, `❓ Модель «${m}» не найдена в списке opencode.`);
    }
    const labels = found.candidates.map((id) => modelLabel(id));
    return deps.io.notify(chatId, `Не нашёл «${m}». Похожее:\n${labels.map((l) => `- ${l}`).join('\n')}`);
  });

  bot.command('project', (ctx) => {
    const chatId = ctx.chat.id;
    const p = arg(ctx.message?.text);
    if (p === '') {
      const s = getOrCreate(store, cfg, chatId);
      const projects = listProjects(cfg);
      const current = s.project === '' ? '(песочница)' : s.project;
      if (projects.length === 0) {
        return deps.io.notify(
          chatId,
          `Проект: ${current}\n\nПапок в разрешённых корнях пока нет: ${cfg.allowedRoots.join(', ')}`,
        );
      }
      const lines = projects.map((e) => `- ${e.dir === s.project ? '✅ ' : ''}${e.label}`).join('\n');
      return deps.io.notify(chatId, `Проект: ${current}\n${lines}\nСменить: /project <имя|путь> (или в Mini App)`);
    }
    try {
      // The guard is the only thing that decides; the stored value is the RESOLVED
      // directory, so a later bare name can never silently rebind the chat elsewhere.
      const dir = resolveWorkdir(cfg, chatId, p);
      const prev = store.getSession(chatId)?.project;
      updateSession(store, chatId, { project: dir });
      if (prev !== undefined && prev !== dir) dropAgentSession(store, chatId);
      return deps.io.notify(chatId, `Проект: ${dir}`);
    } catch (e) {
      return deps.io.notify(chatId, projectDeniedMessage(e));
    }
  });

  // W8: /clone, /get, /files, /find, /auto, /status, /cost, /update,
  // /commit, /pr, /ci, /watch, /exec, /sys deleted (cut list §9). Removed
  // commands never execute: each answers with the short help pointer below.
  for (const name of REMOVED_COMMANDS) {
    bot.command(name, (ctx) => deps.io.notify(ctx.chat.id, REMOVED_REPLY));
  }

  bot.command('approve', (ctx) => {
    const chatId = ctx.chat.id;
    const r = resolveApproval(chatId, true);
    // A dead button must not stay up: the row is settled either way.
    if (r !== 'none') clear(chatId, SCOPE.approve);
    return deps.io.notify(chatId, approvalReply(r, true));
  });

  bot.command('new', (ctx) => {
    dropAgentSession(store, ctx.chat.id);
    store.clearMessages(ctx.chat.id);
    return deps.io.notify(ctx.chat.id, 'История очищена. Новый диалог.');
  });

  // W8: /status deleted (§9#3 — Home tab owns it via GET /api/tasks/current).

  bot.command('cancel', async (ctx) => {
    const chatId = ctx.chat.id;
    const r = await deps.queue.cancel(chatId);
    if (r.kind === 'approval') return deps.io.notify(chatId, 'Отклонено.');
    if (r.kind === 'task') return; // fail() already messaged
    return deps.io.notify(chatId, 'Нечего отменять.');
  });

  // W8: /cost deleted (§9#3 — per-task cost rides the task object);
  // /update deleted (§9#8 — self-update is incompatible with Mini App + tunnel).

  // WAVE2/FILES-BEGIN — unified inbound: any file (photo/document/audio/video) lands
  // in <workdir>/inbox and is attached to the next task. One helper, so they cannot drift.
  bot.on('message:photo', async (ctx) => {
    const photos = ctx.message.photo;
    const biggest = photos[photos.length - 1];
    if (!biggest) return;
    try {
      await receiveInboundFile(deps, ctx.chat.id, biggest.file_id, `${Date.now()}.jpg`, ctx.message.caption ?? '', '📷');
    } catch {
      await deps.io.notify(ctx.chat.id, '❌ Не удалось сохранить фото.');
    }
  });

  bot.on('message:document', async (ctx) => {
    const doc = ctx.message.document;
    try {
      await receiveInboundFile(deps, ctx.chat.id, doc.file_id, doc.file_name ?? '', ctx.message.caption ?? '', '📎');
    } catch {
      await deps.io.notify(ctx.chat.id, '❌ Не удалось сохранить файл.');
    }
  });

  bot.on('message:audio', async (ctx) => {
    const audio = ctx.message.audio;
    try {
      await receiveInboundFile(
        deps,
        ctx.chat.id,
        audio.file_id,
        audio.file_name ?? 'audio.mp3',
        ctx.message.caption ?? '',
        '🎵',
      );
    } catch {
      await deps.io.notify(ctx.chat.id, '❌ Не удалось сохранить аудио.');
    }
  });

  bot.on('message:video', async (ctx) => {
    const video = ctx.message.video;
    try {
      await receiveInboundFile(
        deps,
        ctx.chat.id,
        video.file_id,
        video.file_name ?? 'video.mp4',
        ctx.message.caption ?? '',
        '🎬',
      );
    } catch {
      await deps.io.notify(ctx.chat.id, '❌ Не удалось сохранить видео.');
    }
  });
  // WAVE2/FILES-END

  bot.on('message:voice', async (ctx) => {
    const chatId = ctx.chat.id;
    try {
      const s = getOrCreate(store, cfg, chatId);
      const workdir = resolve(params(cfg, chatId, s.project));
      await deps.io.notify(chatId, '🎤 Распознаю голосовое…');
      const text = await transcribeVoice(bot.api, cfg, ctx.message.voice.file_id, workdir);
      if (text === '') {
        await deps.io.notify(chatId, '🔇 Не расслышал. Попробуй ещё раз или напиши текстом.');
        return;
      }
      await deps.io.notify(chatId, `🎤 Распознано: ${text}`);
      await ask(bot, deps, chatId, `[voice] ${text}`, 'ask');
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      const code = m.startsWith('E_') ? (m.split(':')[0] ?? 'E_AGENT_FAILED') : 'E_AGENT_FAILED';
      const map: Record<string, string> = {
        E_VOICE_NOT_CONFIGURED: '🎤 Голос не настроен. Задай WHISPER_BIN и VOICE_MODEL_PATH в .env.',
        E_VOICE_TIMEOUT: '⏱ Распознавание не уложилось в лимит времени.',
        E_AGENT_FAILED: '❌ Не удалось распознать голосовое.',
      };
      await deps.io.notify(chatId, map[code] ?? `❌ Ошибка: ${code}`);
    }
  });

  bot.on('message:text', async (ctx) => {
    const chatId = ctx.chat.id;
    const text = ctx.message.text.trim();
    if (hasApproval(chatId)) {
      const ok = /^(да|yes|ага|ok|\+|approve)$/i.test(text);
      const r = resolveApproval(chatId, ok);
      clear(chatId, SCOPE.approve);
      return deps.io.notify(chatId, approvalReply(r, ok));
    }
    // WAVE2/EXEC (plan rework): plain text while a plan is parked = plan comment.
    if (await tryPlanRework(deps, chatId, text)) return;
    return ask(bot, deps, chatId, text, 'ask');
  });
}

function params(cfg: Config, chatId: number, project: string): string {
  return resolveWorkdir(cfg, chatId, project);
}

export function createResponder(bot: Bot): Responder {
  return {
    streamStart: (chatId) => createStream(bot.api, chatId),
    // Every non-streaming reply goes out as rendered Telegram HTML. The old path sent
    // the raw markdown with no parse_mode, which is why /help and /find arrived on the
    // owner's phone as literal `**bold**` and ``` fences.
    notify: async (chatId, text) => {
      await sendMarkdown(bot.api, chatId, text);
    },
    askApproval: async (chatId, command) => {
      const { requestApproval } = await import('../core/approvals.js');
      // Register the pending promise BEFORE sending the keyboard, so a fast tap
      // cannot race the approval into "нечего подтверждать". The command lands
      // in the durable row so the Mini App can show it after a restart (W2).
      const pending = requestApproval(chatId, command);
      await bot.api.sendMessage(
        chatId,
        `Агент хочет выполнить:\n<pre>${escapeHtml(command)}</pre>\n\nНажми кнопку или /approve — разрешить, /cancel — отклонить`,
        { parse_mode: 'HTML', reply_markup: approvalKeyboard(chatId) },
      );
      return pending;
    },
    async attachFiles(chatId, paths, caption) {
      for (const abs of paths) {
        try {
          // Images arrive inline as photos with a caption; the rest stay documents.
          await sendOutboundFile(bot.api, chatId, abs, caption ?? '');
        } catch (e) {
          // a single failed upload must not stop the rest, but it must be visible in the
          // log: a silently missing file is indistinguishable from a broken bot.
          log(`attach ${abs}: ${errorCode(e)}`);
        }
      }
    },
  };
}
