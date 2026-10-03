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
 * A compact grid of model buttons plus a reset.
 *
 * `models` is a curated, capped list of picks, each already carrying its own button
 * label; the FULL id goes into the server-side nonce, so a short label costs the owner
 * nothing and callback data never carries more than an opaque token.
 */
export function modelKeyboard(
  chatId: number,
  models: { id: string; label: string; pinned?: boolean }[],
  current: string,
): InlineKeyboard {
  const kb = new InlineKeyboard();
  const perRow = 2;
  let col = 0;
  let first = true;
  for (const model of models) {
    const mark = model.id === current ? '✅ ' : model.pinned === true ? '⭐ ' : '';
    const label = `${mark}${model.label}`;
    const nonce = put(chatId, SCOPE.model, model.id);
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

/**
 * Model buttons for "did you mean" candidates after `/model <text>` matched nothing.
 * Same discipline: the full id is server-side, the label is what fits on a phone.
 */
export function modelCandidatesKeyboard(chatId: number, ids: string[], labels: string[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  ids.forEach((id, i) => {
    const btn = InlineKeyboard.text(labels[i] ?? id, encodeCallback(SCOPE.model, put(chatId, SCOPE.model, id)));
    if (i === 0) kb.add(btn);
    else kb.row().add(btn);
  });
  return kb;
}

/**
 * One project per row, labelled unambiguously across roots.
 *
 * The payload is the resolved ABSOLUTE directory, so a folder named `api` in two roots
 * is two distinct, correct choices and neither depends on which root happens to be
 * listed first. `resolveWorkdir` still guards every one of them.
 */
export function projectPickerKeyboard(
  chatId: number,
  projects: { name: string; dir: string; label: string }[],
  current: string,
): InlineKeyboard {
  const kb = new InlineKeyboard();
  let first = true;
  for (const p of projects) {
    const label = p.dir === current ? `✅ ${p.label}` : p.label;
    const nonce = put(chatId, SCOPE.project, p.dir);
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
