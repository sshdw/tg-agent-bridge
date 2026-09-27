import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Api } from 'grammy';
import type { StreamHandle } from '../core/queue.js';

const MAX_MSG = 4000;
const FLUSH_MS = 1200;

export function splitMessage(text: string): string[] {
  if (text === '') return ['(empty response)'];
  const parts: string[] = [];
  let cur = '';
  for (const line of text.split('\n')) {
    if ((cur + line + '\n').length > MAX_MSG && cur !== '') {
      parts.push(cur);
      cur = '';
    }
    if (line.length > MAX_MSG) {
      if (cur !== '') {
        parts.push(cur);
        cur = '';
      }
      for (let i = 0; i < line.length; i += MAX_MSG) parts.push(line.slice(i, i + MAX_MSG));
    } else {
      cur += line + '\n';
    }
  }
  if (cur !== '') parts.push(cur);
  return parts;
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
      await api.editMessageText(chatId, msgId, chunks[0] ?? '…');
      for (const c of chunks.slice(1)) await api.sendMessage(chatId, c);
    } catch {
      // edit conflicts / rate limits: next flush retries
    }
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
      const chunks = splitMessage(text === '' ? buffer : text);
      try {
        await api.editMessageText(chatId, msgId, chunks[0] ?? '(empty response)');
      } catch {
        await api.sendMessage(chatId, chunks[0] ?? '(empty response)');
      }
      for (const c of chunks.slice(1)) await api.sendMessage(chatId, c);
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
      try {
        await api.editMessageText(chatId, msgId, buffer === '' ? text : `${buffer}\n\n${text}`);
      } catch {
        await api.sendMessage(chatId, text);
      }
    },
  };
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Send plain text, splitting anything over the Telegram limit into several messages. */
export async function sendLong(api: Api, chatId: number, text: string): Promise<void> {
  if (text === '') return;
  for (const chunk of splitMessage(text)) await api.sendMessage(chatId, chunk);
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
