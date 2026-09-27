import { join } from 'node:path';
import type { Api } from 'grammy';
import type { Config } from '../config.js';
import { saveInboundFile } from '../telegram/stream.js';
import { transcribe } from './transcribe.js';

/**
 * Voice-in entry point (spec §1.1).
 *
 * Telegram voice notes are OGG/Opus. whisper.cpp reads ogg via miniaudio, so the
 * downloaded `.oga` is fed straight to the model — no ffmpeg in the hot path.
 */

/**
 * Download a Telegram voice note into `<workdir>/inbox` and return its transcript.
 *
 * Resolves to the recognised text (possibly empty for silence). Rejects with the
 * same `E_*` codes as `transcribe`, plus `E_AGENT_FAILED` if the download fails.
 */
export async function transcribeVoice(
  api: Api,
  cfg: Config,
  fileId: string,
  workdir: string,
): Promise<string> {
  const inbox = join(workdir, 'inbox');
  const name = `voice-${Date.now()}.oga`;
  const audioPath = await saveInboundFile(api, cfg.botToken, fileId, inbox, name);
  return transcribe(cfg, audioPath);
}

export { transcribe } from './transcribe.js';
