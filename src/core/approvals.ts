/** One pending shell approval per chat (queue allows 1 running task per chat). */
const pending = new Map<number, (ok: boolean) => void>();

export function hasApproval(chatId: number): boolean {
  return pending.has(chatId);
}

export function requestApproval(chatId: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    pending.set(chatId, resolve);
  });
}

/** Returns true if there was a pending approval to resolve. */
export function resolveApproval(chatId: number, ok: boolean): boolean {
  const r = pending.get(chatId);
  if (!r) return false;
  pending.delete(chatId);
  r(ok);
  return true;
}
