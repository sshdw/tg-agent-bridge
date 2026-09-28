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
  agent: 'agent',
  model: 'model',
  project: 'project',
  plan: 'plan',
  update: 'update',
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

/** One row per agent, the current one marked. */
export function agentPickerKeyboard(chatId: number, agents: string[], current: string): InlineKeyboard {
  const kb = new InlineKeyboard();
  let first = true;
  for (const agent of agents) {
    const label = agent === current ? `✅ ${agent}` : agent;
    const nonce = put(chatId, SCOPE.agent, agent);
    // `row()` on an empty keyboard prepends an empty row; skip it for the first one.
    if (first) kb.add(InlineKeyboard.text(label, encodeCallback(SCOPE.agent, nonce)));
    else kb.row().text(label, encodeCallback(SCOPE.agent, nonce));
    first = false;
  }
  return kb;
}

/**
 * A compact grid of model buttons plus a reset. Accepts however many models the
 * caller passes; two per row keeps labels readable on a phone.
 */
export function modelKeyboard(chatId: number, models: string[], current: string): InlineKeyboard {
  const kb = new InlineKeyboard();
  const perRow = 2;
  let col = 0;
  let first = true;
  for (const model of models) {
    const label = model === current ? `✅ ${model}` : model;
    const nonce = put(chatId, SCOPE.model, model);
    const btn = InlineKeyboard.text(label, encodeCallback(SCOPE.model, nonce));
    if (first) kb.add(btn);
    else if (col === 0) kb.row().add(btn);
    else kb.add(btn);
    first = false;
    col += 1;
    if (col >= perRow) col = 0;
  }
  const reset = InlineKeyboard.text('↺ сбросить', encodeCallback(SCOPE.model, put(chatId, SCOPE.model, '')));
  if (first || col === 0) kb.row().add(reset);
  else kb.add(reset);
  return kb;
}

/** One project per row: names are `WORK_ROOT` subdirectory names. Current one marked. */
export function projectPickerKeyboard(chatId: number, projects: string[], current: string): InlineKeyboard {
  const kb = new InlineKeyboard();
  let first = true;
  for (const name of projects) {
    const label = name === current ? `✅ ${name}` : name;
    const nonce = put(chatId, SCOPE.project, name);
    if (first) kb.add(InlineKeyboard.text(label, encodeCallback(SCOPE.project, nonce)));
    else kb.row().text(label, encodeCallback(SCOPE.project, nonce));
    first = false;
  }
  const sandbox = put(chatId, SCOPE.project, '');
  if (first) kb.add(InlineKeyboard.text('🏖 песочница', encodeCallback(SCOPE.project, sandbox)));
  else kb.row().text('🏖 песочница', encodeCallback(SCOPE.project, sandbox));
  return kb;
}

/** Plan mode: ✅ Запустить / ✏️ Доработать. Payload carries the parked task id. */
export function planKeyboard(chatId: number, taskId: number): InlineKeyboard {
  const run = put(chatId, SCOPE.plan, `run:${taskId}`);
  const rework = put(chatId, SCOPE.plan, `rework:${taskId}`);
  return new InlineKeyboard()
    .text('✅ Запустить', encodeCallback(SCOPE.plan, run))
    .text('✏️ Доработать', encodeCallback(SCOPE.plan, rework));
}

/**
 * `/update` double-confirm. Stage 1 asks "обновить?", stage 2 asks "точно обновить?
 * процесс перезапустится". Payload encodes the stage so the router can advance
 * without trusting anything the client sends beyond the opaque nonce.
 */
export function updateConfirmKeyboard(chatId: number, stage: 1 | 2): InlineKeyboard {
  const yes = put(chatId, SCOPE.update, `yes:${stage}`);
  const no = put(chatId, SCOPE.update, `no:${stage}`);
  const kb = new InlineKeyboard();
  if (stage === 1) {
    kb.text('🔄 Обновить', encodeCallback(SCOPE.update, yes)).text('Отмена', encodeCallback(SCOPE.update, no));
  } else {
    kb.text('⚠️ Точно обновить', encodeCallback(SCOPE.update, yes)).text('Отмена', encodeCallback(SCOPE.update, no));
  }
  return kb;
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

/** Decode an update payload into its decision and stage; null on any malformed value. */
export function parseUpdatePayload(payload: string): { decision: 'yes' | 'no'; stage: 1 | 2 } | null {
  const i = payload.indexOf(':');
  if (i <= 0) return null;
  const decision = payload.slice(0, i);
  const stage = Number(payload.slice(i + 1));
  if (decision !== 'yes' && decision !== 'no') return null;
  if (stage !== 1 && stage !== 2) return null;
  return { decision, stage };
}
