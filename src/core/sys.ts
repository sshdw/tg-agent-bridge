import { statfsSync } from 'node:fs';
import { cpus, freemem, totalmem } from 'node:os';
import type { Config } from '../config.js';
import type { Store } from '../storage/db.js';
import type { Responder } from './queue.js';
import { getOrCreate } from './sessions.js';
import { resolveWorkdir } from './permissions.js';

export interface SysDeps {
  cfg: Config;
  store: Store;
  io: Responder;
}

export interface SysInfo {
  cpuModel: string;
  cpuCount: number;
  memTotal: number;
  memFree: number;
  /** Null when the OS refuses the call (statfs is best-effort). */
  diskTotal: number | null;
  diskFree: number | null;
}

const gb = (n: number): string => `${(n / 1024 ** 3).toFixed(1)}`;

/**
 * CPU/RAM/disk snapshot. No new dependencies: `node:os` + `fs.statfsSync`
 * (works on win32; guarded regardless so a weird FS never throws outward).
 */
export function sysInfo(workdir: string): SysInfo {
  const list = cpus();
  let diskTotal: number | null = null;
  let diskFree: number | null = null;
  try {
    const st = statfsSync(workdir);
    // bsize can be 0 on exotic mounts — guard the multiply, not just the call.
    if (st.bsize > 0 && st.blocks > 0) {
      diskTotal = st.blocks * st.bsize;
      diskFree = st.bavail * st.bsize;
    }
  } catch {
    // leave nulls; the formatter prints н/д
  }
  return {
    cpuModel: list[0]?.model.trim() ?? 'CPU',
    cpuCount: list.length,
    memTotal: totalmem(),
    memFree: freemem(),
    diskTotal,
    diskFree,
  };
}

/** Short Russian report, small formatted numbers. Pure: easy to unit-check. */
export function formatSys(i: SysInfo): string {
  const memUsed = i.memTotal - i.memFree;
  const memPct = i.memTotal > 0 ? Math.round((memUsed / i.memTotal) * 100) : 0;
  const lines = [
    `🖥 ${i.cpuModel} × ${i.cpuCount}`,
    `🧠 RAM: ${gb(memUsed)}/${gb(i.memTotal)} ГБ (${memPct}%)`,
  ];
  if (i.diskTotal !== null && i.diskFree !== null && i.diskTotal > 0) {
    const diskPct = Math.round((i.diskFree / i.diskTotal) * 100);
    lines.push(`💾 Диск: свободно ${gb(i.diskFree)} из ${gb(i.diskTotal)} ГБ (${diskPct}%)`);
  } else {
    lines.push('💾 Диск: н/д');
  }
  return lines.join('\n');
}

/** `/sys` handler: snapshot the host, reply in Russian. Never throws outward. */
export async function runSys(deps: SysDeps, chatId: number): Promise<void> {
  try {
    const s = getOrCreate(deps.store, deps.cfg, chatId);
    const workdir = resolveWorkdir(deps.cfg, chatId, s.project);
    await deps.io.notify(chatId, formatSys(sysInfo(workdir)));
  } catch {
    await deps.io.notify(chatId, '🔒 Папка вне разрешённых. Смотри ALLOWED_ROOTS в .env.');
  }
}
