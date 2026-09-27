import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { Bot } from 'grammy';
import type { Config } from '../config.js';
import { AGENT_IDS } from '../config.js';
import { hasApproval, resolveApproval } from '../core/approvals.js';
import type { Responder } from '../core/queue.js';
import { TaskQueue } from '../core/queue.js';
import { getOrCreate, updateSession } from '../core/sessions.js';
import { resolveWorkdir } from '../core/permissions.js';
import { availableProviders } from '../gateway/registry.js';
import type { Store } from '../storage/db.js';
import { createStream, escapeHtml, savePhoto, sendLong } from '../telegram/stream.js';
import {
  approvalKeyboard,
  registerCallbacks,
  showAgentPicker,
  showModelPicker,
  showProjectPicker,
} from '../telegram/callbacks.js';
import { SCOPE } from '../telegram/keyboard.js';
import { clear } from '../telegram/nonce.js';
import { transcribeVoice } from '../voice/index.js';

export interface Deps {
  cfg: Config;
  store: Store;
  queue: TaskQueue;
  io: Responder;
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

const pendingImages = new Map<number, string[]>();

function takeImages(chatId: number): string[] {
  const imgs = pendingImages.get(chatId) ?? [];
  pendingImages.delete(chatId);
  return imgs;
}

function runClone(deps: Deps, chatId: number, url: string): Promise<void> {
  if (!/^https:\/\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=-]+$/.test(url)) {
    return deps.io.notify(chatId, 'Использование: /clone <https-url>');
  }
  let name = basename(url).replace(/\.git$/, '').replace(/[^A-Za-z0-9._-]/g, '');
  if (name === '') name = `repo-${Date.now()}`;
  const dest = join(deps.cfg.workRoot, name);
  if (existsSync(dest)) return deps.io.notify(chatId, `Папка ${name} уже существует. Привязать: /project ${name}`);
  return new Promise((resolveDone) => {
    const child = spawn('git', ['clone', '--depth', '1', url, dest], { stdio: 'ignore' });
    const kill = setTimeout(() => child.kill(), 5 * 60 * 1000);
    child.on('close', (code) => {
      clearTimeout(kill);
      void deps.io.notify(
        chatId,
        code === 0 ? `✅ Склонировано в ${name}. Привязать: /project ${name}` : '❌ Клонирование не удалось.',
      );
      resolveDone();
    });
    child.on('error', () => {
      clearTimeout(kill);
      void deps.io.notify(chatId, '❌ Git не найден или не запустился.');
      resolveDone();
    });
  });
}

export function registerRouter(bot: Bot, deps: Deps): void {
  const { cfg, store } = deps;

  // Inline-button callbacks share the same whitelist gate as messages.
  registerCallbacks(bot, deps);

  bot.command('start', (ctx) => {
    const chatId = ctx.chat.id;
    const s = getOrCreate(store, cfg, chatId);
    return deps.io.notify(
      chatId,
      `Привет! Я мост к агентам на этом ПК.\nАгент: ${s.agent}\nМодель: ${s.model === '' ? '(default)' : s.model}\nПроект: ${s.project === '' ? '(песочница)' : s.project}\n\n/ask вопрос • /code задача • /help все команды`,
    );
  });

  bot.command('help', (ctx) => {
    return deps.io.notify(
      ctx.chat.id,
      `/ask <текст> — вопрос агенту\n/code <задача> — кодовая задача\n/agent [id] — сменить агента, без аргумента — кнопки (${availableProviders().join(', ')})\n/model [name] — сменить модель, без аргумента — кнопки\n/project [name] — папка проекта, без аргумента — кнопки\n/clone <url> — склонировать репо\n/auto on|off — shell без спроса/с вопросом\n/approve — разрешить команду агента (или кнопка)\n/new — очистить историю\n/status — очередь\n/cancel — отменить`,
    );
  });

  bot.command('ask', (ctx) => ask(bot, deps, ctx.chat.id, arg(ctx.message?.text), 'ask'));
  bot.command('code', (ctx) => ask(bot, deps, ctx.chat.id, arg(ctx.message?.text), 'code'));

  bot.command('agent', (ctx) => {
    const chatId = ctx.chat.id;
    const id = arg(ctx.message?.text);
    if (id === '') {
      // No argument: show the picker keyboard; the text list stays as the message body.
      return showAgentPicker(ctx, deps);
    }
    if (!(AGENT_IDS as readonly string[]).includes(id)) {
      return deps.io.notify(chatId, `Нет такого агента. Доступны: ${availableProviders().join(', ')}`);
    }
    try {
      updateSession(store, chatId, { agent: id as (typeof AGENT_IDS)[number] });
      return deps.io.notify(chatId, `Агент: ${id}`);
    } catch {
      return deps.io.notify(chatId, '❌ E_AGENT_FAILED');
    }
  });

  bot.command('model', (ctx) => {
    const chatId = ctx.chat.id;
    const m = arg(ctx.message?.text);
    if (m === '') return showModelPicker(ctx, deps);
    updateSession(store, chatId, { model: m });
    return deps.io.notify(chatId, `Модель: ${m}`);
  });

  bot.command('project', (ctx) => {
    const chatId = ctx.chat.id;
    const p = arg(ctx.message?.text);
    if (p === '') return showProjectPicker(ctx, deps);
    try {
      resolveWorkdir(cfg, chatId, p);
      updateSession(store, chatId, { project: p });
      return deps.io.notify(chatId, `Проект: ${p}`);
    } catch {
      return deps.io.notify(chatId, '🔒 Папка вне разрешённых. Смотри ALLOWED_ROOTS в .env.');
    }
  });

  bot.command('clone', (ctx) => runClone(deps, ctx.chat.id, arg(ctx.message?.text)));

  bot.command('auto', (ctx) => {
    const chatId = ctx.chat.id;
    const v = arg(ctx.message?.text).toLowerCase();
    if (v !== 'on' && v !== 'off') {
      const s = getOrCreate(store, cfg, chatId);
      return deps.io.notify(chatId, `Сейчас: /auto ${s.autoApprove ? 'on' : 'off'}`);
    }
    updateSession(store, chatId, { autoApprove: v === 'on' });
    return deps.io.notify(chatId, v === 'on' ? 'Shell-команды — без спроса.' : 'Shell-команды — только после /approve.');
  });

  bot.command('approve', (ctx) => {
    const chatId = ctx.chat.id;
    if (!resolveApproval(chatId, true)) return deps.io.notify(chatId, 'Нечего подтверждать.');
    // The decision is made: drop the button's nonces so it cannot be tapped again.
    clear(chatId, SCOPE.approve);
    return deps.io.notify(chatId, '✅ Разрешено.');
  });

  bot.command('new', (ctx) => {
    store.clearMessages(ctx.chat.id);
    return deps.io.notify(ctx.chat.id, 'История очищена. Новый диалог.');
  });

  bot.command('status', (ctx) => {
    const st = deps.queue.status(ctx.chat.id);
    return deps.io.notify(ctx.chat.id, st.running ? `▶ Выполняется, в очереди: ${st.pending}` : '💤 Задач нет.');
  });

  bot.command('cancel', async (ctx) => {
    const chatId = ctx.chat.id;
    const r = await deps.queue.cancel(chatId);
    if (r === 'approval') return deps.io.notify(chatId, 'Отклонено.');
    if (r === 'task') return; // fail() already messaged
    return deps.io.notify(chatId, 'Нечего отменять.');
  });

  bot.on('message:photo', async (ctx) => {
    const chatId = ctx.chat.id;
    const photos = ctx.message.photo;
    const biggest = photos[photos.length - 1];
    if (!biggest) return;
    try {
      const s = getOrCreate(store, cfg, chatId);
      const workdir = resolve(params(cfg, chatId, s.project));
      const abs = await savePhoto(bot.api, cfg.botToken, chatId, biggest.file_id, join(workdir, 'inbox'));
      const list = pendingImages.get(chatId) ?? [];
      list.push(abs);
      pendingImages.set(chatId, list);
      store.addMessage(chatId, 'user', `[photo saved: ${abs}] ${ctx.message.caption ?? ''}`.trim());
      await deps.io.notify(chatId, '📷 Фото сохранено. Теперь /ask с вопросом.');
    } catch {
      await deps.io.notify(chatId, '❌ Не удалось сохранить фото.');
    }
  });

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

  bot.on('message:text', (ctx) => {
    const chatId = ctx.chat.id;
    const text = ctx.message.text.trim();
    if (hasApproval(chatId)) {
      const ok = /^(да|yes|ага|ok|\+|approve)$/i.test(text);
      resolveApproval(chatId, ok);
      clear(chatId, SCOPE.approve);
      return deps.io.notify(chatId, ok ? '✅ Разрешено.' : 'Отклонено.');
    }
    return ask(bot, deps, chatId, text, 'ask');
  });
}

function params(cfg: Config, chatId: number, project: string): string {
  return resolveWorkdir(cfg, chatId, project);
}

export function createResponder(bot: Bot): Responder {
  return {
    streamStart: (chatId) => createStream(bot.api, chatId),
    notify: async (chatId, text) => {
      await sendLong(bot.api, chatId, text);
    },
    askApproval: async (chatId, command) => {
      const { requestApproval } = await import('../core/approvals.js');
      // Register the pending promise BEFORE sending the keyboard, so a fast tap
      // cannot race the approval into "нечего подтверждать".
      const pending = requestApproval(chatId);
      await bot.api.sendMessage(
        chatId,
        `Агент хочет выполнить:\n<code>${escapeHtml(command)}</code>\n\nНажми кнопку или /approve — разрешить, /cancel — отклонить`,
        { parse_mode: 'HTML', reply_markup: approvalKeyboard(chatId) },
      );
      return pending;
    },
  };
}
