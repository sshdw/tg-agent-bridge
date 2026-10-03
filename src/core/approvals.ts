import type { Store } from '../storage/db.js';

/**
 * Durable shell approvals: one pending row per chat in the `approvals` table,
 * with the in-memory map kept as a fast-path notification bridge for the
 * currently running runner. The DB is authoritative — after a restart the rows
 * are still there and `resolveApproval` still wakes the live promise.
 *
 * A chat resolve can only claim success when it woke a LIVE waiter (`'live'`).
 * A pending row with no waiter is an orphan from a dead process: it is settled
 * as denied (safe default — the command must never run) and reported as
 * `'orphan'` so the owner hears the truth, never `✅ Разрешено.`
 */

export type ChatResolve = 'live' | 'orphan' | 'none';

/** Honest reply when a tap addresses an approval whose runner is already gone. */
export const ORPHAN_APPROVAL_MSG = 'Команда больше не ждёт — задача прервана рестартом бота.';

/** Owner-facing verdict for a chat-button / /approve / text resolve. */
export function approvalReply(r: ChatResolve, ok: boolean): string {
  if (r === 'live') return ok ? '✅ Разрешено.' : 'Отклонено.';
  if (r === 'orphan') return ORPHAN_APPROVAL_MSG;
  return 'Нечего подтверждать.';
}

interface Waiter {
  resolve: (ok: boolean) => void;
  /** Durable row id, or null when no store was bound at request time. */
  approvalId: number | null;
}

const pending = new Map<number, Waiter>();

let storeRef: Store | null = null;

/**
 * Bind the live Store. Called by `TaskQueue`'s constructor, so every reopen
 * (new Store + new TaskQueue) re-points the bridge at the current database.
 */
export function bindApprovalStore(s: Store): void {
  storeRef = s;
}

export function hasApproval(chatId: number): boolean {
  if (pending.has(chatId)) return true;
  if (storeRef) {
    try {
      return storeRef.pendingApproval(chatId) !== undefined;
    } catch {
      return false;
    }
  }
  return false;
}

export function requestApproval(chatId: number, command = ''): Promise<boolean> {
  let approvalId: number | null = null;
  if (storeRef) {
    try {
      approvalId = storeRef.createApproval(chatId, command);
    } catch {
      approvalId = null;
    }
  }
  return new Promise<boolean>((resolve) => {
    pending.set(chatId, { resolve, approvalId });
  });
}

/**
 * Chat-side resolve (`/approve`, approve button, "да"-reply, `cancel`).
 *
 * - `'live'` — a live waiter was woken; only this may be reported as success.
 * - `'orphan'` — an orphaned row was settled as denied, or a leaked waiter was
 *   settled with deny; nothing runs either way.
 * - `'none'` — nothing pending at all.
 */
export function resolveApproval(chatId: number, ok: boolean): ChatResolve {
  const entry = pending.get(chatId);
  if (!storeRef) {
    if (!entry) return 'none';
    pending.delete(chatId);
    entry.resolve(ok);
    return 'live';
  }
  try {
    const decision = ok ? 'allowed' : 'denied';
    // 1) The row this waiter was bound to.
    if (entry?.approvalId != null) {
      if (storeRef.resolveApproval(entry.approvalId, decision) === 'ok') {
        pending.delete(chatId);
        entry.resolve(ok);
        return 'live';
      }
      // Bound id stale (resolved behind our back, or expired): fall through
      // to the newest pending row instead of stranding the waiter.
    }
    // 2) Newest pending row (sweeps expired rows on read).
    const newest = storeRef.pendingApproval(chatId);
    if (!newest || (entry && newest.id === entry.approvalId)) {
      // Bound row terminally dead with nothing live left: settle a leaked
      // waiter with deny so no promise hangs until the task timeout.
      if (entry) {
        pending.delete(chatId);
        entry.resolve(false);
        return 'orphan';
      }
      return 'none';
    }
    if (!entry) {
      // Orphan: no live waiter, only a row from a dead process. Settle it as
      // denied (safe default) but do NOT claim success.
      storeRef.resolveApproval(newest.id, 'denied');
      return 'orphan';
    }
    // Bound id stale but a live row exists: close the loop on the newest row.
    if (storeRef.resolveApproval(newest.id, decision) === 'ok') {
      pending.delete(chatId);
      entry.resolve(ok);
      return 'live';
    }
    // Lost a race between lookup and flip: nothing left to wake.
    pending.delete(chatId);
    entry.resolve(false);
    return 'orphan';
  } catch {
    // A broken DB must not hang the runner until its timeout: deny-settle.
    if (entry) {
      pending.delete(chatId);
      try {
        entry.resolve(false);
      } catch {
        // already settled elsewhere
      }
      return 'orphan';
    }
    return 'none';
  }
}

/**
 * Mini-App path: resolve by approval id. Returns the durable verdict so the
 * API can map it (`ok` → 200, `resolved` → E_RESOLVED, `expired` → E_EXPIRED,
 * `missing` → 404). On `ok` the live runner is woken when it waits on this id.
 */
export function resolveApprovalById(id: number, ok: boolean): 'ok' | 'resolved' | 'expired' | 'missing' {
  if (!storeRef) return 'missing';
  const r = storeRef.resolveApproval(id, ok ? 'allowed' : 'denied');
  if (r === 'ok') {
    for (const [chatId, entry] of pending) {
      if (entry.approvalId === id) {
        pending.delete(chatId);
        entry.resolve(ok);
        break;
      }
    }
  }
  return r;
}
