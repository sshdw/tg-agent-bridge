import type { Store } from '../storage/db.js';

/**
 * Durable shell approvals: one pending row per chat in the `approvals` table,
 * with the in-memory map kept as a fast-path notification bridge for the
 * currently running runner. The DB is authoritative — after a restart the rows
 * are still there and `resolveApproval` still wakes the live promise.
 */

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

/** Returns true if there was a pending approval to resolve. */
export function resolveApproval(chatId: number, ok: boolean): boolean {
  const entry = pending.get(chatId);
  if (storeRef) {
    try {
      // Prefer the row this runner waited on; fall back to the newest pending
      // row (covers rows created straight through the Store, e.g. by the API).
      const id = entry?.approvalId ?? storeRef.pendingApproval(chatId)?.id ?? null;
      if (id === null) {
        // No durable row and no memory waiter: nothing to resolve.
        if (!entry) return false;
        pending.delete(chatId);
        entry.resolve(ok);
        return true;
      }
      // Single-use by construction: only the `ok` winner flips the row.
      // An already-resolved or expired id reports false (E_RESOLVED/E_EXPIRED).
      if (storeRef.resolveApproval(id, ok ? 'allowed' : 'denied') !== 'ok') return false;
      pending.delete(chatId);
      entry?.resolve(ok);
      return true;
    } catch {
      return false;
    }
  }
  if (!entry) return false;
  pending.delete(chatId);
  entry.resolve(ok);
  return true;
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
