import { appendFileSync } from 'node:fs';

/**
 * Timestamped bot log: stdout plus a `bot.log` tail. Never throws — logging
 * must never crash the bot.
 *
 * Lives in its own module (not `index.ts`) so background workers like the CI
 * poller can log without importing the whole bot entry point — importing
 * `index.ts` would run `main()` (Telegram polling) as a side effect and make
 * the importer untestable offline.
 */
export function log(line: string): void {
  const out = `[${new Date().toISOString()}] ${line}\n`;
  process.stdout.write(out);
  try {
    appendFileSync('bot.log', out);
  } catch {
    // logging must never crash the bot
  }
}
