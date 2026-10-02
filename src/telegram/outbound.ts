/**
 * Sending files TO Telegram.
 *
 * Decided by extension (`core/files.ts` owns the set): an image goes out as a photo
 * with a caption naming it, so the owner sees it inline in the chat instead of as an
 * anonymous attachment; everything else stays a document.
 *
 * Caps: 10 MB for a photo, Telegram's own 50 MB for a document. An image over the
 * photo cap degrades to a document rather than failing — the owner still gets the file —
 * while anything over the document cap is refused with an `E_*` code the caller
 * already knows how to phrase.
 */

import { statSync } from 'node:fs';
import { basename } from 'node:path';
import { InputFile, type Api } from 'grammy';
import { isPhotoName, MAX_OUTBOUND_BYTES, MAX_PHOTO_BYTES } from '../core/files.js';

/** Telegram's caption limit. */
const CAPTION_MAX = 1024;

/**
 * Photo or document, decided by extension and capped by size.
 *
 * @throws Error with `E_NOT_FOUND`, `E_NOT_FILE` or `E_FILE_TOO_BIG`.
 */
export async function sendOutboundFile(
  api: Api,
  chatId: number,
  abs: string,
  captionPrefix = '',
): Promise<'photo' | 'document'> {
  let st;
  try {
    st = statSync(abs);
  } catch {
    throw new Error('E_NOT_FOUND');
  }
  if (!st.isFile()) throw new Error('E_NOT_FILE');
  if (st.size > MAX_OUTBOUND_BYTES) throw new Error('E_FILE_TOO_BIG');

  const caption = buildCaption(captionPrefix, basename(abs));
  if (isPhotoName(abs) && st.size <= MAX_PHOTO_BYTES) {
    await api.sendPhoto(chatId, new InputFile(abs), caption === '' ? {} : { caption });
    return 'photo';
  }
  await api.sendDocument(chatId, new InputFile(abs), {});
  return 'document';
}

/**
 * Caption text for a photo: the caller's label plus the file's own name.
 *
 * Sent WITHOUT `parse_mode`, so a filename can never become markup — the same reason
 * agent replies are escaped before they are rendered.
 */
function buildCaption(prefix: string, name: string): string {
  const label = `${prefix.trim()}: ${name}`.trim();
  const head = label.slice(0, Math.max(0, CAPTION_MAX - 1));
  return head.length < label.length ? `${head}…` : head;
}