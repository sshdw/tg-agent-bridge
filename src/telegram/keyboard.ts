import { InlineKeyboard } from 'grammy';
import { encodeCallback, put } from './nonce.js';

/**
 * Inline keyboard builders. Every button that triggers an action carries only
 * `scope:nonce` as callback data (see `nonce.ts`); the real payload is stored
 * server-side. These helpers mint the nonce and return a ready-to-send keyboard, so
 * callers never hand-assemble callback data and cannot accidentally leak a path or a
 * command into it.
 *
 * Telegram layer only: no business logic, no provider/CLI calls.
 */

/** Scope names — stable identifiers shared with the callback router. */
export const SCOPE = {
  approve: 'approve',
  plan: 'plan',
} as const;

export type ScopeName = (typeof SCOPE)[keyof typeof SCOPE];

/** ✅ Разрешить / ❌ Отклонить — shell approval and other yes/no decisions. */
export function approveDenyKeyboard(
  chatId: number,
  scope: string,
  okPayload: string,
  denyPayload = '',
): InlineKeyboard {
  const ok = put(chatId, scope, okPayload);
  const no = put(chatId, scope, denyPayload);
  return new InlineKeyboard()
    .text('✅ Разрешить', encodeCallback(scope, ok))
    .text('❌ Отклонить', encodeCallback(scope, no));
}

/** Plan mode: ✅ Запустить / ✏️ Доработать. Payload carries the parked task id. */
export function planKeyboard(chatId: number, taskId: number): InlineKeyboard {
  const run = put(chatId, SCOPE.plan, `run:${taskId}`);
  const rework = put(chatId, SCOPE.plan, `rework:${taskId}`);
  return new InlineKeyboard()
    .text('✅ Запустить', encodeCallback(SCOPE.plan, run))
    .text('✏️ Доработать', encodeCallback(SCOPE.plan, rework));
}

/** Decode a plan payload into its action and task id; null on any malformed value. */
export function parsePlanPayload(payload: string): { action: 'run' | 'rework'; taskId: number } | null {
  const i = payload.indexOf(':');
  if (i <= 0) return null;
  const action = payload.slice(0, i);
  const taskId = Number(payload.slice(i + 1));
  if (action !== 'run' && action !== 'rework') return null;
  if (!Number.isInteger(taskId) || taskId <= 0) return null;
  return { action, taskId };
}
