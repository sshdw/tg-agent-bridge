/**
 * The live model list, straight from the opencode CLI.
 *
 * Why this exists: the picker used to offer a hardcoded array of model ids that no
 * provider recognised — invented names, offered as if they were the source of truth.
 * The real source of truth is `opencode models`, which prints one model id per line
 * (99 on the owner's machine, and it changes whenever opencode is updated).
 *
 * Conventions inherited from `spawnRunner.ts`, deliberately:
 *  - the binary is resolved by the shared `resolveBin()` in `config.ts`, so
 *    `OPENCODE_BIN` behaves the same here as for `opencode run`;
 *  - the child gets `childEnv()`, so `GITHUB_TOKEN`, `BOT_TOKEN` and the rest of the
 *    secret blocklist can never reach a spawned process;
 *  - a failure NEVER throws into a command handler. The picker shows a clear Russian
 *    message instead, because a broken model list is not a reason to lose a reply.
 *
 * The 6-hour cache exists so tapping `/model` does not spawn a CLI per tap; the live
 * list only changes when opencode itself is updated. A FAILURE is cached separately
 * and briefly, and is never cached as a success.
 */

import { spawn } from 'node:child_process';
import { childEnv, sanitize } from './spawnRunner.js';
import { log } from '../log.js';

/** How long `opencode models` may take before we give up on it. */
export const MODEL_LIST_TIMEOUT_MS = 20000;

/** A successful list is good for this long; `/model` never spawns a CLI per tap. */
export const MODEL_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/** A failure is cached briefly, so a broken CLI cannot be respawned on every tap. */
export const MODEL_FAIL_TTL_MS = 60 * 1000;

/**
 * Model ids that are real but unusable as a chat backend, so they must never reach a
 * button: embedding and reranking models, protein-structure models, image/video/audio
 * generators, speech and TTS models, vision-only encoders and safety classifiers.
 *
 * Matching is substring-based on the lowercased id, which is why the list includes
 * bare family names (`embed`, `flux`, `whisper`) and not only full model names.
 */
const NON_CHAT_PATTERNS: readonly RegExp[] = [
  // retrieval / embeddings
  /embed/,
  /bge/,
  /rerank/,
  /retriev/,
  // protein / structure models
  /esm/,
  /fold/,
  // image, video, 3D and diffusion generators
  /flux/,
  /paligemma/,
  /diffusion/,
  /image/,
  /video/,
  /bevformer/,
  /cosmos/,
  /sparsedrive/,
  /usdcode/,
  /usdvalidate/,
  /synthetic/,
  // speech, audio and multimodal-only encoders
  /whisper/,
  /tts/,
  /speech/,
  /voice/,
  /magpie/,
  /studiovoice/,
  /streampetr/,
  /audio/,
  /omni/,
  /vl\b/,
  /-vl/,
  /vision/,
  // classifiers and safety/utility heads
  /guard/,
  /safety/,
  /moderation/,
  /content-safety/,
  /active-speaker/,
  /translate/,
  /depth/,
  /segment/,
  /\bner\b/,
];

/** True when this id names a chat/coding model we could actually run a task with. */
export function isChatModel(id: string): boolean {
  const t = id.toLowerCase();
  return !NON_CHAT_PATTERNS.some((re) => re.test(t));
}

/** Parse `opencode models` stdout into ids: one per line, blanks and noise dropped. */
export function parseModelList(stdout: string): string[] {
  const out: string[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '') continue;
    // Ids are `provider/name`, optionally with a path segment: no spaces, no markup.
    if (!/^[A-Za-z0-9][A-Za-z0-9._\/-]*$/.test(line)) continue;
    if (!line.includes('/')) continue;
    if (out.includes(line)) continue;
    out.push(line);
  }
  return out;
}

/** Group id -> its provider segment (`nvidia/baai/bge-m3` -> `nvidia`). */
export function modelProvider(id: string): string {
  const i = id.indexOf('/');
  return i <= 0 ? id.slice(0, id.indexOf('/')) || id : id.slice(0, i);
}

export interface ModelListResult {
  /** Chat-capable model ids, provider-grouped. Empty when the CLI failed. */
  models: string[];
  /** Every id the CLI printed, before the chat filter. Diagnostics only. */
  all: string[];
  /** Human-readable reason the list is empty, or null on success. */
  error: string | null;
  /** When this result was produced (ms since epoch). */
  fetchedAt: number;
  /** True when this result came out of the cache rather than a fresh spawn. */
  cached: boolean;
}

interface CacheEntry {
  result: Omit<ModelListResult, 'cached'>;
  /** Failure results expire on the short TTL. */
  ttl: number;
}

let cache: CacheEntry | null = null;
let inflight: Promise<Omit<ModelListResult, 'cached'>> | null = null;

/**
 * Spawn `bin models` and return the parsed ids. Never throws and never rejects: a
 * missing binary, a non-zero exit, a timeout and unparsable output all resolve to an
 * empty list plus an `error` string.
 */
export function listModels(bin: string, timeoutMs = MODEL_LIST_TIMEOUT_MS): Promise<Omit<ModelListResult, 'cached'>> {
  return new Promise((resolve) => {
    const done = (models: string[], all: string[], error: string | null): void => {
      clearTimeout(timer);
      const result: Omit<ModelListResult, 'cached'> = { models, all, error, fetchedAt: Date.now() };
      resolve(result);
    };
    let child;
    try {
      child = spawn(bin, ['models'], {
        env: childEnv(),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      done([], [], `не удалось запустить opencode: ${sanitize(String(e))}`);
      return;
    }
    let settled = false;
    const finish = (models: string[], all: string[], error: string | null): void => {
      if (settled) return;
      settled = true;
      done(models, all, error);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // already gone
      }
      finish([], [], 'opencode models не ответил вовремя');
    }, timeoutMs);
    timer.unref?.();

    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      if (stdout.length < 200000) stdout += chunk;
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      if (stderr.length < 2000) stderr += chunk;
    });
    child.on('error', (e: Error) => {
      finish([], [], /ENOENT/.test(e.message) ? `не найден бинарник: ${bin}` : sanitize(e.message));
    });
    child.on('close', (code) => {
      const all = parseModelList(stdout);
      if (all.length === 0) {
        const why = stderr.trim() === '' ? `код выхода ${code ?? 'signal'}` : sanitize(stderr);
        finish([], [], `opencode не вернул список моделей (${why})`);
        return;
      }
      finish(all.filter(isChatModel), all, null);
    });
  });
}

/** Drop the cache. Offline harness only. */
export function resetModelCache(): void {
  cache = null;
  inflight = null;
}

/**
 * The live model list, cached. Concurrent callers share one spawn.
 *
 * A success is cached for `MODEL_CACHE_TTL_MS`; a failure for `MODEL_FAIL_TTL_MS`, so
 * `/model` cannot be used to respawn a broken CLI — but a failure is never returned as
 * a success, and it expires quickly enough that a repaired opencode is picked up.
 */
export async function cachedModels(bin: string, ttlMs = MODEL_CACHE_TTL_MS): Promise<ModelListResult> {
  const now = Date.now();
  if (cache !== null && now - cache.result.fetchedAt < cache.ttl) return { ...cache.result, cached: true };
  if (inflight === null) {
    inflight = listModels(bin).finally(() => {
      inflight = null;
    });
  }
  const result = await inflight;
  cache = { result, ttl: result.error === null ? ttlMs : MODEL_FAIL_TTL_MS };
  if (result.error !== null) log(`models: ${result.error}`);
  return { ...result, cached: false };
}

/* ------------------------------------------------------------------- picking */

/**
 * How many buttons the keyboard may show. 99 live models flattened into buttons is
 * not a picker, it is a wall; ~20 rows is what a phone can actually scroll.
 */
export const MODEL_BUTTON_CAP = 20;

/** Ids the owner must always be able to pick, whatever the cap. */
function forced(pinned: string[]): string[] {
  const out: string[] = [];
  for (const id of pinned) {
    if (id !== '' && !out.includes(id)) out.push(id);
  }
  return out;
}

/** Longest button label a phone shows without truncating the model into uselessness. */
export const MODEL_LABEL_MAX = 40;

/**
 * Button label: the model name without its provider prefix, trimmed only if it is
 * genuinely too long. The FULL id always goes into the server-side nonce, so a trimmed
 * label never costs the owner anything — the picker still sets exactly that model.
 */
export function modelLabel(id: string): string {
  const i = id.lastIndexOf('/');
  const name = i > 0 ? id.slice(i + 1) : id;
  return name.length > MODEL_LABEL_MAX ? `${name.slice(0, MODEL_LABEL_MAX - 1)}…` : name;
}

export interface ModelPick {
  /** The full id, what actually goes into `--model`. */
  id: string;
  /** Short button text. */
  label: string;
  provider: string;
  /** True for the session's current model or `cfg.defaultModel`. */
  pinned: boolean;
}

/**
 * Curate the live list into something a phone can scroll: forced picks first, then
 * provider-grouped models up to `MODEL_BUTTON_CAP`, one row per provider block.
 *
 * The current model and `DEFAULT_MODEL` are ALWAYS included — even when they are not in
 * the live list at all (a stale session value must stay selectable), and even when the
 * cap is exhausted. Everything else is capped.
 */
export function pickModels(
  models: string[],
  pinnedIds: string[],
  cap = MODEL_BUTTON_CAP,
): ModelPick[] {
  const out: ModelPick[] = [];
  const seen = new Set<string>();
  const add = (id: string, pinned: boolean): void => {
    if (id === '' || seen.has(id)) return;
    seen.add(id);
    out.push({ id, label: modelLabel(id), provider: modelProvider(id), pinned });
  };

  const pin = forced(pinnedIds);
  for (const id of pin) add(id, true);

  // Provider order: the pinned models' providers first (so the block the owner is
  // looking at is at the top), then the rest alphabetically for a stable layout.
  const providers = new Set(models.map(modelProvider));
  for (const id of pin) providers.add(modelProvider(id));
  const order = [...providers].sort((a, b) => {
    const ap = pin.some((p) => modelProvider(p) === a) ? 0 : 1;
    const bp = pin.some((p) => modelProvider(p) === b) ? 0 : 1;
    return ap - bp || a.localeCompare(b);
  });

  // Budget per provider: a provider with 60 ids must not eat the whole keyboard, so
  // each provider gets a share of the remaining rows and the rest is handed out in
  // later passes until the cap is reached or the live list runs out.
  const byProvider = new Map<string, string[]>();
  for (const p of order) byProvider.set(p, []);
  for (const id of models) {
    const p = modelProvider(id);
    const bucket = byProvider.get(p);
    if (bucket !== undefined) bucket.push(id);
  }
  const rank = new Map(order.map((p, i) => [p, i]));
  const live = order.filter((p) => (byProvider.get(p) ?? []).length > 0);
  if (live.length === 0) return disambiguate(out);
  for (let round = 0; out.length < cap; round += 1) {
    let progressed = false;
    for (const p of live) {
      const id = (byProvider.get(p) ?? [])[round];
      if (id === undefined) continue;
      progressed = true;
      add(id, false);
      if (out.length >= cap) break;
    }
    if (!progressed) break;
  }
  // Selection was round-robin (so no provider monopolises the keyboard); the RETURNED
  // order is grouped by provider, because that is how the keyboard reads on a phone.
  out.sort((a, b) => {
    const ra = rank.get(a.provider) ?? 99;
    const rb = rank.get(b.provider) ?? 99;
    return ra - rb;
  });
  return disambiguate(out);
}

/**
 * Make every label unique.
 *
 * `opencode/deepseek-v4.1-flash` and `nvidia/deepseek-ai/deepseek-v4.1-flash` shorten to
 * the same text, and two identical buttons are worse than a slightly longer one: the
 * owner would have no idea which provider they are picking. A colliding label grows its
 * provider prefix back; if that still collides, the middle path segment is included.
 */
function disambiguate(picks: ModelPick[]): ModelPick[] {
  const counts = new Map<string, number>();
  for (const p of picks) counts.set(p.label, (counts.get(p.label) ?? 0) + 1);
  for (const p of picks) {
    if ((counts.get(p.label) ?? 0) < 2) continue;
    // Grow the label by ONE trailing path segment at a time: `opencode/kimi-k3` and
    // `nvidia/moonshotai/kimi-k3` both shorten to `kimi-3`, and the second segment is
    // what tells them apart. Never truncate back down to the model name alone.
    const parts = p.id.split('/');
    for (let keep = 2; keep <= parts.length; keep += 1) {
      const candidate = parts.slice(-keep).join('/');
      if (candidate.length <= MODEL_LABEL_MAX && !labelsTaken(picks, candidate, p.id)) {
        p.label = candidate;
        break;
      }
    }
  }
  return picks;
}

/** Is `label` already used by a DIFFERENT model id in this picker? */
function labelsTaken(picks: ModelPick[], label: string, exceptId: string): boolean {
  return picks.some((p) => p.id !== exceptId && p.label === label);
}

/**
 * Case-insensitive candidates for a `/model <text>` the owner typed, best match first.
 *
 * Ranking, because "closest" has to mean something: a full-id match beats a full-id
 * prefix, which beats a short-label prefix (`gpt-5.5` for `opencode/gpt-5.5`), which
 * beats any other substring. So `/model gpt` offers `opencode/gpt-5.3-codex` before
 * `nvidia/openai/gpt-oss-20b`, which sorts earlier only because of the provider name.
 *
 * Used instead of accepting an id the agent will later reject: the closest live ids
 * come back so the owner taps the right one instead of guessing twice.
 */
export function matchModels(models: string[], query: string, limit = 8): string[] {
  const q = query.trim().toLowerCase();
  if (q === '') return [];
  const tiers: string[][] = [[], [], [], []];
  for (const id of models) {
    const t = id.toLowerCase();
    const short = modelLabel(id).toLowerCase();
    const tier = t === q || short === q ? 0 : t.startsWith(q) ? 1 : short.startsWith(q) ? 2 : 3;
    if (tier === 3 && !t.includes(q) && !short.includes(q)) continue;
    tiers[tier]?.push(id);
  }
  return [...tiers[0], ...tiers[1], ...tiers[2], ...tiers[3]].slice(0, limit);
}