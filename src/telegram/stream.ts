/**
 * The streaming answer path and the single non-streaming send path.
 *
 * Every Telegram send in the bot goes through `sendMarkdown` (non-streaming) or
 * `createStream` (streaming answers). Both render markdown to Telegram HTML through
 * `markdown.ts`, budget the RENDERED length, and classify Telegram failures through
 * `send.ts`. There is no `parse_mode`-less send left in the codebase: that missing
 * `parse_mode` is why the owner saw literal `**bold**` for every bot reply.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Api } from 'grammy';
import type { StreamHandle } from '../core/queue.js';
import { escapeHtml, MIN_RENDER_BUDGET, renderHtmlChunks, RENDER_BUDGET } from './markdown.js';
import {
  classifyFailure,
  deliverHtml,
  deliverMarkdown,
  deliverPlain,
  FailureLog,
  isDowngradable,
  sendWithRetry,
} from './send.js';

const FLUSH_MS = 1200;

/** Re-exported so callers keep importing escaping from the stream module. */
export { escapeHtml } from './markdown.js';

/**
 * Live-edit a streamed answer.
 *
 * `push` only buffers; every 1200 ms `flush` re-renders and edits the ONE live
 * message. Overflow chunks are deliberately NOT sent while streaming: they used to be
 * re-sent on every tick, so as soon as an answer passed 4000 characters the owner got
 * the same tail several times a second. The tail is sent once, from `finish`.
 *
 * Half-written markup is never emitted as a broken tag: the renderer keeps unbalanced
 * emphasis markers literal, and the live message simply gains them on the next tick.
 */
export async function createStream(
  api: Api,
  chatId: number,
  opts: { flushMs?: number } = {},
): Promise<StreamHandle> {
  const failures = new FailureLog(`stream:${chatId}`);
  const sent = await api.sendMessage(chatId, '…');
  const msgId = sent.message_id;

  let buffer = '';
  /** Last text we put in the live message, so an unchanged render is a no-op. */
  let liveText = '';
  let closed = false;
  let timer: NodeJS.Timeout | undefined;
  let budget = RENDER_BUDGET;

  /**
   * Put the head of `md` in the live message. Returns true when the chat shows it.
   * A "message is not modified" rejection counts as success — the owner already sees
   * exactly that text.
   */
  const showLive = async (md: string): Promise<boolean> => {
    const head = renderHtmlChunks(md, budget)[0] ?? escapeHtml(md);
    if (head === liveText) return true;
    try {
      await sendWithRetry(
        'edit',
        () => api.editMessageText(chatId, msgId, head, { parse_mode: 'HTML' }),
        failures,
      );
      liveText = head;
      return true;
    } catch (e) {
      if (isNotModified(e)) {
        liveText = head;
        return true;
      }
      const kind = classifyFailure(e);
      if (isDowngradable(kind) && budget > MIN_RENDER_BUDGET) {
        // Shrink the budget and try again — a length rejection here means the same
        // thing it meant on the send path.
        budget = Math.max(MIN_RENDER_BUDGET, Math.floor(budget / 2));
        return showLive(md);
      }
      failures.report('edit', e);
      return false;
    }
  };

  /** Send the tail chunks of a finished answer, once each, in order. */
  const sendTail = async (md: string): Promise<void> => {
    for (const html of renderHtmlChunks(md, budget).slice(1)) {
      try {
        await deliverHtml(api, chatId, html, failures);
      } catch (e) {
        failures.report('send-tail', e);
      }
    }
  };

  /**
   * Put the whole answer on the phone: head into the live message, tail as new
   * messages. If the live message cannot take the head at all, the answer is re-sent as
   * fresh messages instead — a duplicate beats a reply that never lands.
   */
  const deliver = async (md: string, fallbackText: string): Promise<void> => {
    if (await showLive(md)) {
      await sendTail(md);
      return;
    }
    try {
      await deliverMarkdown(api, chatId, md, failures);
    } catch (e) {
      failures.report('send-head', e);
      await deliverPlain(api, chatId, fallbackText, failures).catch((err) => {
        failures.report('send-head-plain', err);
      });
    }
  };

  const flush = async (): Promise<void> => {
    if (closed || buffer === '') return;
    await showLive(buffer);
  };

  timer = setInterval(() => {
    void flush();
  }, opts.flushMs ?? FLUSH_MS);
  timer.unref?.();

  const stop = (): void => {
    if (timer) clearInterval(timer);
    timer = undefined;
  };

  return {
    push(delta: string): void {
      if (closed) return;
      buffer += delta;
    },
    async finish(text: string): Promise<void> {
      if (closed) return;
      closed = true;
      stop();
      const body = text === '' ? buffer : text;
      await deliver(body, body);
    },
    async fail(code: string): Promise<void> {
      if (closed) return;
      closed = true;
      stop();
      const map: Record<string, string> = {
        E_TIMEOUT: '⏱ Задача не уложилась в лимит времени.',
        E_CANCELLED: '⛔ Задача отменена.',
        E_NOT_CONFIGURED: '⚙ Провайдер не настроен (нет бинарника/ключа).',
        E_UNKNOWN_AGENT: '❓ Неизвестный агент.',
        E_PATH_DENIED: '🔒 Папка вне разрешённых.',
        E_AGENT_FAILED: '❌ Агент упал с ошибкой.',
      };
      const text = map[code] ?? `❌ Ошибка: ${code}`;
      const body = buffer === '' ? text : `${buffer}\n\n${text}`;
      // The partial answer is kept, not dropped: only the reason is appended.
      await deliver(body, text);
    },
  };
}

/**
 * Send markdown as formatted Telegram HTML. THE path for every non-streaming reply:
 * `/help`, `/find`, `/sys`, `/cost`, `/status`, `/exec` output, the boot ping.
 *
 * Never throws: a reply that cannot be delivered at all is already reported by the
 * `FailureLog`, and an exception here would bubble into grammy and take the whole
 * update handler with it.
 */
export async function sendMarkdown(api: Api, chatId: number, text: string): Promise<void> {
  if (text === '') return;
  const failures = new FailureLog(`notify:${chatId}`);
  try {
    await deliverMarkdown(api, chatId, text, failures);
  } catch (e) {
    failures.report('notify', e);
  }
}

/** Telegram's "message is not modified" rejection: the live text already matches. */
function isNotModified(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e);
  return /not modified/i.test(m);
}

/**
 * Download any Telegram file by `file_id` into `destDir` and return its absolute path.
 *
 * The Bot API file endpoint is reached directly (the grammy Api object exposes no
 * download helper we want to depend on). `name` is a caller-chosen filename; callers
 * are responsible for making it unique and for not letting untrusted data into it.
 */
export async function saveInboundFile(
  api: Api,
  botToken: string,
  fileId: string,
  destDir: string,
  name: string,
): Promise<string> {
  const file = await api.getFile(fileId);
  if (!file.file_path) throw new Error('E_AGENT_FAILED: no file_path');
  const res = await fetch(`https://api.telegram.org/file/bot${botToken}/${file.file_path}`);
  if (!res.ok) throw new Error('E_AGENT_FAILED: download failed');
  const buf = Buffer.from(await res.arrayBuffer());
  mkdirSync(destDir, { recursive: true });
  const abs = join(destDir, name);
  writeFileSync(abs, buf);
  return abs;
}

export async function savePhoto(
  api: Api,
  botToken: string,
  chatId: number,
  fileId: string,
  workdirInbox: string,
): Promise<string> {
  void chatId;
  return saveInboundFile(api, botToken, fileId, workdirInbox, `${Date.now()}.jpg`);
}