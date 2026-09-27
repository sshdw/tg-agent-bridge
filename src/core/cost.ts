import type { Store } from '../storage/db.js';

/**
 * `/cost [day|week]` — spending report from `tasks.cost_usd`.
 *
 * Storage (nullable `cost_usd`, opportunistic extraction in the opencode
 * provider, persistence in the queue) already exists in v0.2; this module owns
 * only the argument parsing and the Russian reply text. Sums ignore NULLs and
 * the reply says so openly instead of showing a fake zero.
 */

/** Periods accepted by `/cost`. */
export type CostPeriod = 'day' | 'week';

export const COST_PERIOD_SECS: Record<CostPeriod, number> = {
  day: 24 * 60 * 60,
  week: 7 * 24 * 60 * 60,
};

const PERIOD_RU: Record<CostPeriod, string> = { day: 'сутки', week: 'неделю' };

export const COST_USAGE = 'Использование: /cost [day|week]';

/**
 * Parse the raw `/cost` argument. Empty means the default (`day`).
 * Returns null on garbage so the router can answer with usage.
 */
export function parseCostArg(raw: string): CostPeriod | null {
  const v = raw.trim().toLowerCase();
  if (v === '') return 'day';
  if (v === 'day' || v === 'день' || v === 'сутки') return 'day';
  if (v === 'week' || v === 'неделя' || v === 'неделю') return 'week';
  return null;
}

const fmtUsd = (n: number): string => `$${n.toFixed(4)}`;

/** Build the `/cost` reply for a chat. Pure formatting over Store queries. */
export function formatCostReply(
  store: Store,
  chatId: number,
  period: CostPeriod,
  nowSec = Math.floor(Date.now() / 1000),
): string {
  const since = nowSec - COST_PERIOD_SECS[period];
  const { total, priced, unpriced } = store.costsSince(chatId, since);
  if (priced === 0 && unpriced === 0) return `За ${PERIOD_RU[period]} задач не было.`;
  const lines = [
    `Расходы за ${PERIOD_RU[period]}: ${fmtUsd(total)}`,
    `Задач с ценой: ${priced}, без цены: ${unpriced}.`,
  ];
  if (unpriced > 0) {
    lines.push('Задачи без цены провайдер не оценил — в сумму они не входят.');
  }
  const byAgent = store.costByAgentSince(chatId, since).filter((r) => r.total > 0);
  for (const r of byAgent.slice(0, 10)) {
    lines.push(`• ${r.agent}: ${fmtUsd(r.total)} (${r.n})`);
  }
  return lines.join('\n');
}
