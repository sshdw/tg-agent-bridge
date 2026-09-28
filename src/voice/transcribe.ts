import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../config.js';
import { childEnv, sanitize } from '../gateway/spawnRunner.js';

/**
 * Local, free speech-to-text via whisper.cpp (spec §1.1 VOICE IN).
 *
 * Telegram voice notes arrive as OGG/Opus (`.oga`). whisper.cpp is built on
 * miniaudio and reads ogg directly, so a Windows install needs no ffmpeg for the
 * normal voice path. `cfg.ffmpegBin` exists for exotic formats should they ever
 * appear; this module deliberately does not shell out to it.
 *
 * Outward errors are `E_*` codes only — the same vocabulary the queue and the
 * Telegram stream layer already speak.
 */

/** Hard ceiling for one transcription. A voice note is short; anything near this is a hang. */
const TIMEOUT_MS = 120_000;

/** whisper.cpp JSON: `result.language` plus one entry per segment. */
interface WhisperJson {
  result?: { language?: string };
  transcription?: { text?: string }[];
}

const msgOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** whisper-cli.exe is a real file. `cfg.whisperBin` is only ever a name when unset. */
function checkBin(path: string): void {
  if (path === '') throw new Error('E_VOICE_NOT_CONFIGURED: WHISPER_BIN is empty');
  if (!existsSync(path)) throw new Error('E_VOICE_NOT_CONFIGURED: WHISPER_BIN not found');
}

function checkModel(path: string): void {
  if (path === '') throw new Error('E_VOICE_NOT_CONFIGURED: VOICE_MODEL_PATH is empty');
  if (!existsSync(path)) throw new Error('E_VOICE_NOT_CONFIGURED: VOICE_MODEL_PATH not found');
}

/**
 * Kill the whisper process tree. On Windows `child.kill` leaves grandchildren
 * (nothing here spawns any, but the pattern matches spawnRunner) so we use taskkill.
 */
function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid !== undefined && process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } catch {
      // fall through to child.kill
    }
  }
  try {
    child.kill('SIGTERM');
  } catch {
    // already gone
  }
}

/**
 * Run whisper.cpp on a local audio file and return the joined transcript.
 *
 * `audioPath` must be absolute. Resolves to the trimmed transcript (which may
 * legitimately be empty for silence). Rejects with `E_VOICE_NOT_CONFIGURED`,
 * `E_VOICE_TIMEOUT` or `E_AGENT_FAILED`.
 */
export async function transcribe(cfg: Config, audioPath: string): Promise<string> {
  checkBin(cfg.whisperBin);
  checkModel(cfg.voiceModelPath);
  if (!existsSync(audioPath)) throw new Error('E_AGENT_FAILED: audio file missing');

  // Whisper writes `<basename>.json` next to its output stem; keep that in the OS
  // temp dir so a transcription never litters the project inbox.
  const stem = join(tmpdir(), `tg-voice-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const jsonPath = `${stem}.json`;

  const args = [
    '-m',
    cfg.voiceModelPath,
    '-f',
    audioPath,
    '-l',
    cfg.voiceLang,
    '-oj',
    '-of',
    stem,
    '-np',
  ];

  try {
    await runWhisper(cfg.whisperBin, args, TIMEOUT_MS);
    if (!existsSync(jsonPath)) throw new Error('E_AGENT_FAILED: no transcript produced');
    const raw = readFileSync(jsonPath, 'utf8');
    let parsed: WhisperJson;
    try {
      parsed = JSON.parse(raw) as WhisperJson;
    } catch {
      throw new Error('E_AGENT_FAILED: malformed transcript json');
    }
    const parts = parsed.transcription ?? [];
    const text = parts.map((seg) => seg.text ?? '').join(' ');
    return text.replace(/\s+/g, ' ').trim();
  } finally {
    try {
      rmSync(jsonPath, { force: true });
    } catch {
      // best-effort cleanup
    }
  }
}

/**
 * Spawn whisper-cli and await a clean exit.
 *
 * Async `spawn` deliberately: `spawnSync` on this Windows setup fails with EBUSY,
 * while the async form with piped stdio exits 0.
 */
function runWhisper(bin: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(bin, args, {
        env: childEnv(),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      reject(new Error(`E_VOICE_NOT_CONFIGURED: ${sanitize(msgOf(e))}`));
      return;
    }

    let settled = false;
    let stderrBuf = '';
    // Whisper is chatty on stderr even when asked to be quiet; keep the tail only.
    const KEEP = 2000;

    const timer = setTimeout(() => {
      finish(() => {
        killTree(child);
        reject(new Error('E_VOICE_TIMEOUT'));
      });
    }, timeoutMs);
    timer.unref?.();

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderrBuf = (stderrBuf + chunk).slice(-KEEP);
    });
    // Drain stdout so a full pipe can never stall the child.
    child.stdout?.resume();

    child.on('error', (err) => {
      finish(() => {
        const m = msgOf(err);
        reject(new Error(/ENOENT/.test(m) ? `E_VOICE_NOT_CONFIGURED: ${sanitize(m)}` : `E_AGENT_FAILED: ${sanitize(m)}`));
      });
    });

    child.on('close', (code) => {
      finish(() => {
        if (code === 0) resolve();
        else reject(new Error(`E_AGENT_FAILED: exit ${code ?? 'signal'}${stderrBuf === '' ? '' : ` — ${sanitize(stderrBuf)}`}`));
      });
    });
  });
}
