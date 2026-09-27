import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { InputFile, type Bot } from 'grammy';
import type { Config } from '../config.js';
import { AGENT_IDS } from '../config.js';
import { hasApproval, resolveApproval } from '../core/approvals.js';
import {
  displayName,
  errorCode,
  inboxFilename,
  outboundErrorMessage,
  resolveOutboundFile,
} from '../core/files.js';
import type { Responder } from '../core/queue.js';
import { TaskQueue } from '../core/queue.js';
import { runExec } from '../core/exec.js';
import { CODE_USAGE, registerPlanFlow, requestCode, tryPlanRework } from '../core/plan.js';
import { PRESET_NAMES, applyPreset, type PresetName } from '../core/presets.js';
import { getOrCreate, updateSession } from '../core/sessions.js';
import { resolveWorkdir } from '../core/permissions.js';
// [WAVE2-GITHUB] §1.6 — handlers live in the github layer so Core stays a command table.
import { handleCi, handleCommit, handlePr, handleWatch } from '../github/commands.js';
import { availableProviders } from '../gateway/registry.js';
import type { MsgRow, Store } from '../storage/db.js';
import { createStream, escapeHtml, saveInboundFile, sendLong } from '../telegram/stream.js';
import {
  approvalKeyboard,
  registerCallbacks,
  showAgentPicker,
  showModelPicker,
  showProjectPicker,
} from '../telegram/callbacks.js';
import { SCOPE } from '../telegram/keyboard.js';
import { runSys } from './sys.js';
import { clear } from '../telegram/nonce.js';
import { transcribeVoice } from '../voice/index.js';

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
const pendingFiles = new Map<number, string[]>();

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

function takeImages(chatId: number): string[] {
  const files = pendingFiles.get(chatId) ?? [];
  pendingFiles.delete(chatId);
  return files;
}

/** `/find` — how many history hits to render at most, and how long a needle may be. */
const FIND_LIMIT = 20;
const FIND_NEEDLE_MAX = 200;

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
  const list = pendingFiles.get(chatId) ?? [];
  list.push(abs);
  pendingFiles.set(chatId, list);
  deps.store.addMessage(chatId, 'user', `[file saved: ${abs}] ${caption}`.trim());
  const name = displayName(abs);
  await deps.io.notify(
    chatId,
    caption === ''
      ? `${label} Сохранено: ${name}. Теперь /ask с вопросом.`
      : `${label} Сохранено: ${name}\nКонтекст: ${caption}`,
  );
}

/** Resolve the requested path inside the chat workdir and send it as a document. */
async function sendRequestedFile(deps: Deps, chatId: number, requested: string): Promise<void> {
  const s = getOrCreate(deps.store, deps.cfg, chatId);
  const workdir = resolveWorkdir(deps.cfg, chatId, s.project);
  try {
    const { abs } = resolveOutboundFile(workdir, requested);
    await requireBot().api.sendDocument(chatId, new InputFile(abs), {});
  } catch (e) {
    await deps.io.notify(chatId, outboundErrorMessage(errorCode(e)));
  }
}

/** `/find <text>` over this chat's full history, newest first, plain-text safe. */
function renderFind(store: Store, chatId: number, needle: string): string {
  const head = `🔎 «${needle}» — найдено`;
  const rows: MsgRow[] = store.findMessages(chatId, needle, FIND_LIMIT);
  if (rows.length === 0) return `🔎 «${needle}»: ничего не нашёл.`;
  const lines = rows.map((m) => {
    const who = m.role === 'assistant' ? '🤖' : '👤';
    const when = new Date(m.created_at * 1000).toISOString().replace('T', ' ').slice(0, 16);
    const body = m.text.replace(/\s+/g, ' ').trim().slice(0, 200);
    return `${who} ${when}\n${body}`;
  });
  return [`${head} (${rows.length})`, ...lines].join('\n\n');
}

// WAVE2/FILES-END

// WAVE2/GITHUB-BEGIN — §1.6 handlers (subagent E). Every registration below is a
// thin adapter: resolve the chat workdir, call the github layer, send the sentence.
/**
 * Resolve the chat's workdir, or return the one short reply to show when the
 * project sits outside ALLOWED_ROOTS. Shared by /commit and /pr.
 */
function githubWorkdir(deps: Deps, chatId: number): string | null {
  try {
    return resolveWorkdir(deps.cfg, chatId, getOrCreate(deps.store, deps.cfg, chatId).project);
  } catch {
    return null;
  }
}

/** Split "/pr  my title  here" into the whole argument string, spaces preserved. */
const restArgs = (text: string | undefined): string => (text ?? '').split(' ').slice(1).join(' ');

const DENIED = '🔒 Папка проекта вне разрешённых. Смотри ALLOWED_ROOTS в .env.';

function registerGithubCommands(bot: Bot, deps: Deps): void {
  bot.command('commit', async (ctx) => {
    const chatId = ctx.chat.id;
    const workdir = githubWorkdir(deps, chatId);
    if (workdir === null) return deps.io.notify(chatId, DENIED);
    const message = restArgs(ctx.message?.text);
    try {
      return await deps.io.notify(chatId, await handleCommit(deps, workdir, message));
    } catch {
      return deps.io.notify(chatId, '❌ E_GIT_COMMIT: неожиданная ошибка git.');
    }
  });

  bot.command('pr', async (ctx) => {
    const chatId = ctx.chat.id;
    const workdir = githubWorkdir(deps, chatId);
    if (workdir === null) return deps.io.notify(chatId, DENIED);
    try {
      return await deps.io.notify(chatId, await handlePr(deps, workdir, restArgs(ctx.message?.text)));
    } catch {
      return deps.io.notify(chatId, '❌ E_GH_HTTP: не удалось открыть PR.');
    }
  });

  bot.command('ci', async (ctx) => {
    const chatId = ctx.chat.id;
    const repo = arg(ctx.message?.text);
    try {
      return await deps.io.notify(chatId, await handleCi(deps, repo));
    } catch {
      return deps.io.notify(chatId, '❌ Не удалось получить статус CI.');
    }
  });

  bot.command('watch', async (ctx) => {
    const chatId = ctx.chat.id;
    // First word is the slug, the rest is the optional branch.
    const parts = arg(ctx.message?.text).split(' ').filter((w) => w !== '');
    try {
      return await deps.io.notify(chatId, await handleWatch(deps, chatId, parts[0] ?? '', parts[1] ?? ''));
    } catch {
      return deps.io.notify(chatId, '❌ Не удалось изменить наблюдение. Проверь формат owner/repo.');
    }
  });
}
// WAVE2/GITHUB-END

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
  liveBot = bot; // WAVE2/FILES: file handlers need the live bot to download/upload.

  // Inline-button callbacks share the same whitelist gate as messages.
  registerCallbacks(bot, deps);

  // WAVE2/GITHUB-BEGIN — §1.6 /commit /pr /ci /watch (subagent E)
  registerGithubCommands(bot, deps);
  // WAVE2/GITHUB-END

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
      `/ask <текст> — вопрос агенту\n/code <задача> — план, запуск после одобрения\n/review • /test • /fix <симптом> — пресеты /code\n/exec <команда> — shell в папке проекта\n/sys — CPU/RAM/диск\n/get <файл> — прислать файл из папки проекта\n/find <текст> — поиск по истории\n/agent [id] — сменить агента, без аргумента — кнопки (${availableProviders().join(', ')})\n/model [name] — сменить модель, без аргумента — кнопки\n/project [name] — папка проекта, без аргумента — кнопки\n/clone <url> — склонировать репо\n/commit <текст> — git add -A + commit + push\n/pr [заголовок] — запушить ветку и открыть PR\n/ci <owner/repo> [ветка] — последние запуски Actions\n/watch <owner/repo> [ветка] — вкл/выкл уведомления о CI\n/auto on|off — shell без спроса/с вопросом\n/approve — разрешить команду агента (или кнопка)\n/new — очистить историю\n/status — очередь\n/cancel — отменить`,
    );
  });

  bot.command('ask', (ctx) => ask(bot, deps, ctx.chat.id, arg(ctx.message?.text), 'ask'));

  // WAVE2/EXEC-BEGIN (/exec, /sys, plan-mode /code, preset commands)
  registerPlanFlow(deps.queue, deps.io);

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

  bot.command('exec', (ctx) => runExec(deps, ctx.chat.id, arg(ctx.message?.text)));
  bot.command('sys', (ctx) => runSys(deps, ctx.chat.id));
  // WAVE2/EXEC-END

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

  // WAVE2/FILES-BEGIN — /get and /find registrations. Delimited so
  // sibling router additions merge without touching these lines.
  bot.command('get', (ctx) => sendRequestedFile(deps, ctx.chat.id, arg(ctx.message?.text)));

  bot.command('find', (ctx) => {
    const chatId = ctx.chat.id;
    const needle = arg(ctx.message?.text).trim().slice(0, FIND_NEEDLE_MAX);
    if (needle === '') return deps.io.notify(chatId, 'Использование: /find <текст>');
    return deps.io.notify(chatId, renderFind(store, chatId, needle));
  });
  // WAVE2/FILES-END

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
      resolveApproval(chatId, ok);
      clear(chatId, SCOPE.approve);
      return deps.io.notify(chatId, ok ? '✅ Разрешено.' : 'Отклонено.');
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
    async attachFiles(chatId, paths) {
      for (const abs of paths) {
        try {
          await bot.api.sendDocument(chatId, new InputFile(abs), {});
        } catch {
          // a single failed upload must not stop the rest
        }
      }
    },
  };
}
