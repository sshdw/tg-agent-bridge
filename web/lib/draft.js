/**
 * W7 draft/confirm pure logic + bridge-status reasons — no DOM, no Telegram
 * API, no fetch. Importable from node >= 22 as ESM and from web/app.js and
 * web/screens/*.js.
 *
 * Preset rule (src/core/presets.ts: client keeps NAMES only, the server
 * substitutes body text): this module knows exactly the three preset NAMES
 * ('review' | 'test' | 'fix') and never any preset body string. Selecting a
 * preset forces mode 'code' (every preset is a /code variant —
 * src/core/router.ts:421-426). Server-side substitution of the role prefix
 * through POST /api/drafts is NOT possible (the endpoint accepts only
 * prompt/mode/skills — src/miniapp/api.ts parseRunBody), so the name travels
 * in client state only and the prompt the owner typed is sent verbatim.
 *
 * PROMPT_MAX mirrors src/miniapp/api.ts PROMPT_MAX (8000): the client
 * disables Run under exactly the conditions the server would 400 on.
 */

/** Server prompt limit (src/miniapp/api.ts:54). Run stays disabled past it. */
export const PROMPT_MAX = 8000;

/** Preset NAMES only — never body text (see module header). */
export const PRESET_NAMES = ['review', 'test', 'fix'];

/** Bridge-status signals in GET /api/health render order. */
export const HEALTH_SIGNALS = ['telegram', 'agent', 'github', 'whisper', 'db'];

/** Wire modes for POST /api/drafts and POST /api/tasks. */
export function normalizeMode(mode) {
  return mode === 'ask' || mode === 'code' || mode === 'plan' ? mode : 'ask';
}

/** Unknown preset names are ignored (single-select, '' = none). */
export function normalizePreset(preset) {
  return PRESET_NAMES.includes(preset) ? preset : '';
}

/**
 * A selected preset forces 'code' (all presets are /code variants).
 * Otherwise the chosen mode passes through.
 */
export function effectiveMode(mode, preset) {
  return normalizePreset(preset) !== '' ? 'code' : normalizeMode(mode);
}

/** Chip toggle: same name clears, another name replaces, unknown clears. */
export function togglePreset(current, name) {
  const next = normalizePreset(name);
  if (next === '') return '';
  return normalizePreset(current) === next ? '' : next;
}

/** Generic single-toggle for a string list (confirm-card skill picks). */
export function toggleInList(list, name) {
  const cur = Array.isArray(list) ? list.map(String) : [];
  const v = String(name ?? '');
  if (v === '') return cur;
  return cur.includes(v) ? cur.filter((s) => s !== v) : [...cur, v];
}

function skillsPayload(skills) {
  if (!Array.isArray(skills)) return [];
  return skills.filter((s) => typeof s === 'string' && s !== '');
}

/**
 * Pure Run-gate. Returns {ok, disabled, reason, mode, preset, prompt,
 * payload}. `payload` ({prompt, mode, skills}) is exactly the POST
 * /api/drafts body the client sends — empty prompt disables Run, over-limit
 * disables Run (the server would 400 E_BAD_ARG on both).
 */
export function validateDraft({ text = '', mode = 'ask', preset = '', skills = [] } = {}) {
  const raw = String(text ?? '');
  const p = normalizePreset(preset);
  const m = effectiveMode(mode, p);
  const base = { mode: m, preset: p, prompt: raw };
  if (raw.trim().length === 0) {
    return { ...base, ok: false, disabled: true, reason: 'empty', payload: null };
  }
  if (raw.length > PROMPT_MAX) {
    return { ...base, ok: false, disabled: true, reason: 'too-long', payload: null };
  }
  return {
    ...base,
    ok: true,
    disabled: false,
    reason: '',
    payload: { prompt: raw, mode: m, skills: skillsPayload(skills) },
  };
}

/**
 * Tap-a-signal → reason line for the More bridge-status section.
 * Pure derivation from the GET /api/health values (api.ts getHealth):
 * fixed status strings in, owner-readable reason out. `staleS` feeds only
 * the telegram row; everything else reads the signal value alone.
 */
export function healthReason(signal, value, staleS = null) {
  const v = String(value ?? '');
  switch (signal) {
    case 'telegram': {
      if (v === 'polling') return 'Long polling is alive — heartbeat is fresh (≤ 90 s).';
      if (v === 'stale') {
        const s = Number(staleS);
        return Number.isFinite(s)
          ? `No heartbeat for ${s} s — the bot process may be down.`
          : 'Heartbeat is stale — the bot process may be down.';
      }
      return 'No heartbeat seen yet — check that the bot process runs.';
    }
    case 'agent':
      if (v === 'missing') return 'Agent binary is not configured or not found — check the server config.';
      return `Agent runner binary: ${v}.`;
    case 'github':
      if (v === 'present') return 'Token is configured. The app never polls GitHub — links open in the browser.';
      return 'No token configured. CI/PR links still open in the browser.';
    case 'whisper':
      if (v === 'ready') return 'Whisper binary and voice model found — voice input stays in chat.';
      return 'Whisper binary or voice model is missing — voice input stays in chat.';
    case 'db':
      if (v === 'wal' || v === 'wal2' || v === 'delete' || v === 'persist' || v === 'truncate') {
        return `SQLite journal mode: ${v}.`;
      }
      return `Database status: ${v === '' ? 'unknown' : v}.`;
    default:
      return '';
  }
}
