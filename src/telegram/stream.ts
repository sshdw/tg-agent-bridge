/**
 * The streaming answer path and the single non-streaming send path.
 *
 * Every Telegram send in the bot goes through `sendMarkdown` (non-streaming) or
 * `createStream` (streaming answers). Both decide the transport ONCE per answer —
 * native rich markdown (Bot API 10.1) or the rendered-HTML fallback — and both
 * classify Telegram failures through `send.ts`. There is no `parse_mode`-less send
 * left in the codebase: that missing `parse_mode` is why the owner saw literal
 * `**bold**` for every bot reply.
 *
 * ## Why no `sendRichMessageDraft`
 *
 * Drafts were evaluated and rejected, not overlooked. A draft is private-chat only,
 * expires in about 30 seconds, and MUST be finalised with a real `sendRichMessage`;
 * an unfinalised draft is not something the owner is guaranteed to ever see. To use
 * one safely we would need a watchdog that finalises or drops every draft on a timer,
 * on top of a stable non-zero `draft_id` per generation stream — and any hole in that
 * watchdog means a finished task whose answer lives only in an expiring draft. The
 * live edit already gives the owner streaming feedback, and the final answer lands as
 * ONE native rich message with no expiry, so drafts buy nothing worth that failure
 * mode. The non-draft path is the whole feature.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Api } from 'grammy';
import type { StreamHandle } from '../core/queue.js';
import { escapeHtml, MIN_RENDER_BUDGET, renderHtmlChunks, RENDER_BUDGET } from './markdown.js';
import { editRichMarkdown, probeRichSupport, richFits, richPrefix } from './rich.js';
import {
  classifyFailure,
  deliverHtml,
  deliverHtmlChunked,
  deliverMarkdown,
  deliverPlain,
  FailureLog,
  isDowngradable,
  isRetryable,
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
 *
 * ## One transport per stream
 *
 * The capability is probed once, when the stream is created, and the answer is held in
 * `useRich` for the whole stream — the live edit and the tail can therefore never
 * disagree about the format. `liveText` holds exactly the body that was put in the
 * message (raw markdown on the rich path, rendered HTML on the fallback), so the
 * "unchanged render" check compares like with like.
 *
 * A rich edit that Telegram rejects as an unknown method latches the capability off
 * process-wide (`rich.ts`) and drops THIS stream to the HTML path from the next tick on.
 */
export async function createStream(
  api: Api,
  chatId: number,
  opts: { flushMs?: number } = {},
): Promise<StreamHandle> {
  const failures = new FailureLog(`stream:${chatId}`);
  // Decided once, before the placeholder exists: a stream never changes its mind.
  let useRich = (await probeRichSupport(api)) === 'supported';
  const sent = await api.sendMessage(chatId, '…');
  const msgId = sent.message_id;

  let buffer = '';
  /** Last body we put in the live message, so an unchanged render is a no-op. */
  let liveText = '';
  let closed = false;
  let timer: NodeJS.Timeout | undefined;
  let budget = RENDER_BUDGET;

  /**
   * Put the head of `md` in the live message, in the transport this stream chose.
   * Returns true when the chat shows it. A "message is not modified" rejection counts
   * as success — the owner already sees exactly that text.
   */
  const showLive = async (md: string): Promise<boolean> => {
    const head = useRich ? richPrefix(md) : (renderHtmlChunks(md, budget)[0] ?? escapeHtml(md));
    if (head === liveText) return true;
    try {
      await sendWithRetry(
        'edit',
        async () => {
          if (useRich) await editRichMarkdown(api, chatId, msgId, head);
          else await api.editMessageText(chatId, msgId, head, { parse_mode: 'HTML' });
        },
        failures,
      );
      liveText = head;
      return true;
    } catch (e) {
      if (isNotModified(e)) {
        liveText = head;
        return true;
      }
      // A rich edit Telegram refuses. `rich.ts` has already latched the capability off
      // when the reason was an unknown method. Either way this stream finishes on the
      // HTML path: the owner must not be left looking at unrendered markdown, and the
      // transport must not flip back and forth within one answer.
      if (useRich) {
        useRich = false;
        liveText = '';
        const kind = classifyFailure(e);
        // Transient faults are retried by sendWithRetry; give up on rich for this
        // stream but do NOT spam the log — the final delivery below will report.
        if (!isRetryable(kind)) failures.report('edit-rich', e);
        return showLive(md);
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

  /**
   * Finish the answer in the transport this stream chose.
   *
   * Rich + fits -> one live edit carrying the markdown byte-for-byte, no tail at all:
   * a 10 000-character answer is ONE message, not ten.
   *
   * Rich + too long for one rich message -> the whole answer goes out through the
   * proven rendered-HTML path (head into the live message, tail as new messages), so
   * the overflow is chunked by the renderer that has always been tested instead of by
   * a fresh guess.
   */
  const deliverFinal = async (md: string, fallbackText: string): Promise<void> => {
    if (useRich && !richFits(md)) {
      // Over the rich limit (length, blocks or nesting): the WHOLE answer goes out
      // through the rendered-HTML path, so nothing is half rich and half HTML and no
      // byte of it is lost. Decided before any edit, because `showLive` would
      // otherwise render a rich prefix and silently drop the overflow.
      useRich = false;
      liveText = '';
    }
    if (useRich && (await showLive(md))) {
      // The whole answer, byte-for-byte, in the live message. No tail exists.
      return;
    }
    if (await showLive(md)) {
      await sendTail(md);
      return;
    }
    try {
      await deliverHtmlChunked(api, chatId, md, failures);
    } catch (e) {
      failures.report('send-head', e);
      await deliverPlain(api, chatId, fallbackText, failures).catch((err) => {
        failures.report('send-head-plain', err);
      });
    }
  };

  /** Send the tail chunks of a finished answer, once each, in order. */
  const sendTail = async (md: string): Promise<void> => {
    if (useRich) return;
    for (const html of renderHtmlChunks(md, budget).slice(1)) {
      try {
        await deliverHtml(api, chatId, html, failures);
      } catch (e) {
        failures.report('send-tail', e);
      }
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
      await deliverFinal(body, body);
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
      await deliverFinal(body, text);
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
    // No explicit mode: this path asks for its own decision, made once by
    // `planDelivery` (rich limits + the cached capability probe) and then threaded
    // down unchanged, so the whole answer travels in one format.
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