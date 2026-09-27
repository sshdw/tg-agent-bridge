import type { Config } from '../config.js';
import type { Store } from '../storage/db.js';
import { planKeyboard } from '../telegram/keyboard.js';
import type { Responder, TaskQueue } from './queue.js';

export interface PlanDeps {
  cfg: Config;
  store: Store;
  queue: TaskQueue;
  io: Responder;
}

export const CODE_USAGE = 'Использование: /code <задача> — сначала план, запуск после одобрения.';

/**
 * Wire the queue's plan-turn callback to the chat: when a plan turn finishes,
 * the plan text is already streamed; this message only carries the decision
 * keyboard (task id travels server-side in the nonce, never in callback data).
 * Call once from router registration.
 */
export function registerPlanFlow(queue: TaskQueue, io: Responder): void {
  queue.onPlanReady(async (chatId: number, taskId: number) => {
    await io.notify(
      chatId,
      '🗺 План выше. ✅ — запустить, ✏️ — доработать (или просто ответь текстом, что поправить, до 2 раундов).',
      planKeyboard(chatId, taskId),
    );
  });
}

/**
 * `/code` (and the presets, which are `/code` with a role prefix): submit a
 * plan turn. The agent replies with a SHORT plan first; the queue parks it and
 * `registerPlanFlow` attaches approve/rework buttons. Only after approve does
 * the real task run. Returns the queue state for the router to acknowledge.
 */
export function requestCode(
  deps: PlanDeps,
  chatId: number,
  prompt: string,
  images: string[],
  options: { preset?: string } = {},
): 'started' | 'queued' | 'planned' {
  return deps.queue.submit(chatId, prompt, 'code', images, {
    preset: options.preset ?? '',
    planOnly: true,
  });
}

/**
 * Plain-text reply while a plan is parked: treat it as a plan comment
 * (rework round). Returns true when the message was consumed as a comment.
 * Command-like texts (`/...`) are left for the router. Max 2 rounds — the
 * queue runs the task anyway once they are exhausted.
 */
export async function tryPlanRework(
  deps: PlanDeps,
  chatId: number,
  text: string,
): Promise<boolean> {
  if (!deps.queue.hasPlan(chatId)) return false;
  if (text.startsWith('/')) return false;
  const rounds = deps.queue.reworkPlan(chatId, text);
  if (rounds === null) {
    await deps.io.notify(chatId, '▶ Раунды доработки закончились — запускаю как есть.');
  } else {
    await deps.io.notify(chatId, '✏️ Принято, дорабатываю план…');
  }
  return true;
}
