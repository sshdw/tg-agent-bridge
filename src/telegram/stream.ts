import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Api } from 'grammy';
import type { StreamHandle } from '../core/queue.js';
import { escapeHtml, markdownToHtml } from './markdown.js';

const MAX_MSG = 4000;
const FLUSH_MS = 1200;

/**
 * Fence marker on a line: 3+ backticks or tildes, optionally with a language hint.
 * Kept local to the splitter so it agrees with the markdown converter about what
 * counts as a fence.
 */
const FENCE_OPEN_RE = /^([ \t]{0,3})(`{3,}|~{3,})[ \t]*([^\s`~]*)/;

interface Fence {
  char: string;
  len: number;
  lang: string;
}

/** True when `line` closes the currently open fence. */
function isFenceClose(line: string, fence: Fence): boolean {
  const re = new RegExp(`^[ \\t]{0,3}\\${fence.char}{${fence.len},}[ \\t]*$`);
  return re.test(line);
}

/** Reopen a fence with the same marker/length and language hint. */
function fenceOpenText(fence: Fence): string {
  return `${fence.char.repeat(fence.len)}${fence.lang}`;
}

/** Close a fence with the same marker and length. */
function fenceCloseText(fence: Fence): string {
  return fence.char.repeat(fence.len);
}

/**
 * Split text into <= MAX_MSG chunks for Telegram, never cutting inside a fenced code
 * block: if a cut would land mid-fence, the fence is closed at the end of the chunk
 * and reopened (same language hint) at the start of the next. Long single lines are
 * hard-sliced, and a hard slice inside a fence still closes and reopens.
 *
 * Contract: always returns at least one element; `''` yields `['(empty response)']`.
 */
export function splitMessage(text: string): string[] {
  if (text === '') return ['(empty response)'];
  const parts: string[] = [];
  let cur = '';
  let fence: Fence | null = null;

  /**
   * Characters a chunk must keep in reserve so the synthetic fence close still fits
   * inside MAX_MSG. Accounts for both the separator newline `pushCur` may insert and
   * the close marker + trailing newline. Zero when no fence is open.
   */
  const reserve = (): number => (fence === null ? 0 : fenceCloseText(fence).length + 2);

  /**
   * Push `cur` as a chunk, appending a synthetic fence close when one is open. A
   * newline is inserted first when the chunk does not already end with one, so the
   * close marker always sits on its own line and stays a valid fence.
   */
  const pushCur = (): void => {
    if (cur === '') return;
    if (fence === null) {
      parts.push(cur);
    } else {
      const sep = cur.endsWith('\n') ? '' : '\n';
      parts.push(`${cur}${sep}${fenceCloseText(fence)}\n`);
    }
    cur = '';
  };

  /** Continue `cur` into a fresh chunk, reopening the fence when needed. */
  const breakChunk = (): void => {
    pushCur();
    if (fence !== null) cur = `${fenceOpenText(fence)}\n`;
  };

  const lines = text.split('\n');
  for (let li = 0; li < lines.length; li += 1) {
    const line = lines[li] ?? '';
    const isLast = li === lines.length - 1;
    const suffix = isLast ? '' : '\n';

    // A line longer than the budget must be sliced, fence-aware. Every bound below
    // accounts for `reserve()`, so a slice plus its synthetic fence close still fits
    // inside MAX_MSG.
    if (line.length + suffix.length + reserve() > MAX_MSG) {
      let i = 0;
      while (i < line.length) {
        if (cur.length + reserve() >= MAX_MSG) {
          // Break first, then place the SAME char into the fresh chunk — a plain
          // `for (…; i += 1)` would skip it and lose characters.
          breakChunk();
          continue;
        }
        cur += line[i] ?? '';
        i += 1;
      }
      if (!isLast && cur.length + suffix.length + reserve() <= MAX_MSG) cur += suffix;
      continue;
    }

    // Would appending this whole line overflow the current chunk?
    if (cur !== '' && cur.length + line.length + suffix.length + reserve() > MAX_MSG) {
      breakChunk();
    }
    cur += line + suffix;

    // Track fence state after the line is committed.
    if (fence === null) {
      const m = FENCE_OPEN_RE.exec(line);
      if (m !== null) {
        const marker = m[2] ?? '```';
        fence = { char: marker[0] ?? '`', len: marker.length, lang: m[3] ?? '' };
      }
    } else if (isFenceClose(line, fence)) {
      fence = null;
    }
  }

  pushCur();
  return parts.length === 0 ? ['(empty response)'] : parts;
}

/** Re-exported so callers keep importing escaping from the stream module. */
export { escapeHtml } from './markdown.js';

/**
 * Render markdown to Telegram HTML, falling back to escaped plain text when the
 * converter throws. A render failure must never take down a reply.
 */
function renderHtml(md: string): string {
  try {
    return markdownToHtml(md);
  } catch {
    return escapeHtml(md);
  }
}

/**
 * Send a chunk as HTML, retrying with escaped plain text when Telegram rejects the
 * markup. Returns when either attempt succeeded. The caller decides what to do when
 * both fail (the live-edit path swallows it, `finish` falls back to a plain send).
 */
async function sendChunkHtml(api: Api, chatId: number, text: string): Promise<void> {
  try {
    await api.sendMessage(chatId, renderHtml(text), { parse_mode: 'HTML' });
  } catch {
    await api.sendMessage(chatId, text);
  }
}

export async function createStream(api: Api, chatId: number): Promise<StreamHandle> {
  const sent = await api.sendMessage(chatId, '…');
  const msgId = sent.message_id;
  let buffer = '';
  let lastPushed = '';
  let closed = false;
  let timer: NodeJS.Timeout | undefined;

  const flush = async (): Promise<void> => {
    if (closed || buffer === lastPushed) return;
    lastPushed = buffer;
    const chunks = splitMessage(buffer);
    try {
      await api.editMessageText(chatId, msgId, renderHtml(chunks[0] ?? '…'), { parse_mode: 'HTML' });
    } catch {
      // A rejected/failed render must not kill the task: retry this flush as plain
      // text, and if even that fails, the next flush (or finish) retries.
      try {
        await api.editMessageText(chatId, msgId, chunks[0] ?? '…');
      } catch {
        // best-effort: edit conflicts / rate limits resolve on the next tick
      }
      return;
    }
    for (const c of chunks.slice(1)) await sendChunkHtml(api, chatId, c);
  };

  timer = setInterval(() => {
    void flush();
  }, FLUSH_MS);
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
      const chunks = splitMessage(body);
      const head = chunks[0] ?? '(empty response)';
      try {
        await api.editMessageText(chatId, msgId, renderHtml(head), { parse_mode: 'HTML' });
      } catch {
        try {
          await api.editMessageText(chatId, msgId, head);
        } catch {
          await api.sendMessage(chatId, renderHtml(head), { parse_mode: 'HTML' }).catch(async () => {
            await api.sendMessage(chatId, head);
          });
        }
      }
      for (const c of chunks.slice(1)) await sendChunkHtml(api, chatId, c);
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
      try {
        await api.editMessageText(chatId, msgId, renderHtml(body), { parse_mode: 'HTML' });
      } catch {
        try {
          await api.editMessageText(chatId, msgId, body);
        } catch {
          await api.sendMessage(chatId, text);
        }
      }
    },
  };
}

/** Send plain text, splitting anything over the Telegram limit into several messages. */
export async function sendLong(api: Api, chatId: number, text: string): Promise<void> {
  if (text === '') return;
  for (const chunk of splitMessage(text)) await api.sendMessage(chatId, chunk);
}

/**
 * Send markdown as Telegram HTML, splitting first and sending each chunk as HTML.
 * Falls back to plain text per chunk if Telegram rejects the markup.
 */
export async function sendMarkdown(api: Api, chatId: number, text: string): Promise<void> {
  if (text === '') return;
  for (const chunk of splitMessage(text)) await sendChunkHtml(api, chatId, chunk);
}

export async function savePhoto(
  api: Api,
  botToken: string,
  chatId: number,
  fileId: string,
  workdirInbox: string,
): Promise<string> {
  const file = await api.getFile(fileId);
  if (!file.file_path) throw new Error('E_AGENT_FAILED: no file_path');
  const res = await fetch(`https://api.telegram.org/file/bot${botToken}/${file.file_path}`);
  if (!res.ok) throw new Error('E_AGENT_FAILED: photo download failed');
  const buf = Buffer.from(await res.arrayBuffer());
  mkdirSync(workdirInbox, { recursive: true });
  const name = `${Date.now()}.jpg`;
  const abs = join(workdirInbox, name);
  writeFileSync(abs, buf);
  return abs;
}
