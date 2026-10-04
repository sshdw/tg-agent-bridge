/**
 * W5 perf ladder — PURE module, no DOM, no Telegram API.
 * Importable from node >= 22 as ESM and from web/app.js.
 *
 * NOTE: Telegram.WebApp.performance_class is UNVERIFIED as an API and is
 * never read here; the Android User-Agent tail below is the only legitimate
 * device-class signal (references/performance.md section 0).
 */

/** Resolved modes on `:root[data-perf]`. */
export const PERF_MODES = ['full', 'reduced', 'lite'];

/** Storage key for the manual choice (CloudStorage primary, localStorage fallback). */
export const PERF_CHOICE_KEY = 'perf_choice';

/**
 * OPTIONAL enhancement: Android User-Agent tail only
 * (`Telegram-Android/x.y (manufacturer model; Android ver; SDK n; CLASS)`).
 * Null on iOS/desktop/spoofed. Only ONE input to autoPerf, never the decision.
 */
export function readTelegramPerfClass(userAgent) {
  const s =
    typeof userAgent === 'string'
      ? userAgent
      : typeof navigator !== 'undefined'
        ? (navigator.userAgent ?? '')
        : '';
  const m = s.match(/Telegram-Android\/[\d.]+\s+\([^)]*;\s*([^;)]+)\)/);
  const v = m ? m[1].trim().toUpperCase() : null;
  return v === 'LOW' || v === 'AVERAGE' || v === 'HIGH' ? v : null;
}

/**
 * JS-side weak-device heuristic. Project thresholds (performance.md section 2).
 * Unknown signals default strong (8 GB / 8 cores / dpr 1 / no frame data) and
 * must NEVER push toward lite on their own — only measured jank does.
 */
export function scoreHeuristic(env = {}) {
  const mem = env.deviceMemory ?? 8;
  const cores = env.hardwareConcurrency ?? 8;
  const dpr = env.devicePixelRatio ?? 1;
  const frameAvgMs = env.frameAvgMs;
  let score = 0;
  if (mem <= 4) score += 2;
  if (cores <= 4) score += 2;
  if (dpr >= 3) score += 1;
  if (typeof frameAvgMs === 'number' && frameAvgMs > 24) score += 2;
  return score;
}

/** Median rAF delta over 30 frames. Resolves undefined where rAF is absent (node/tests). */
export function measureFrameBudget() {
  return new Promise((resolve) => {
    try {
      const raf = typeof requestAnimationFrame !== 'undefined' ? requestAnimationFrame : null;
      if (!raf) {
        resolve(undefined);
        return;
      }
      const deltas = [];
      let last = 0;
      let n = 0;
      const tick = (t) => {
        if (n > 0) deltas.push(t - last);
        last = t;
        n += 1;
        if (n < 30) {
          raf(tick);
        } else {
          deltas.sort((a, b) => a - b);
          resolve(deltas[Math.floor(deltas.length / 2)]);
        }
      };
      raf(tick);
    } catch {
      resolve(undefined);
    }
  });
}

/**
 * Auto ladder: reduced-motion -> lite; UA LOW -> lite; UA AVERAGE -> reduced;
 * heuristic score >= 3 -> lite; score >= 1 -> reduced; else full.
 * All inputs injectable for unit tests; browser defaults apply otherwise.
 */
export async function autoPerf(env = {}) {
  const reducedMotion =
    env.reducedMotion ??
    (typeof matchMedia !== 'undefined' ? matchMedia('(prefers-reduced-motion: reduce)').matches : false);
  if (reducedMotion) return 'lite';
  const uaClass = env.uaClass !== undefined ? env.uaClass : readTelegramPerfClass(env.ua);
  if (uaClass === 'LOW') return 'lite';
  if (uaClass === 'AVERAGE') return 'reduced';
  let frameAvgMs = env.frameAvgMs;
  if (frameAvgMs === undefined && env.measure !== false) {
    frameAvgMs = await measureFrameBudget();
  }
  const score = scoreHeuristic({ ...env, frameAvgMs });
  if (score >= 3) return 'lite';
  if (score >= 1) return 'reduced';
  return 'full';
}
