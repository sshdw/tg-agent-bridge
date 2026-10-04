/**
 * W5 theme mapping — PURE module, no DOM, no Telegram API.
 * Importable from node >= 22 as ESM and from web/app.js.
 * Implements references/theme.md section 3 (contrast guard + flat switch).
 */

/** Pre-ready neutral fallbacks (grays, never accent — see theme.md table). */
export const NEUTRAL_BG = '#17212b';
export const NEUTRAL_HINT_DARK = '#8d9aa8';
export const NEUTRAL_HINT_LIGHT = '#707579';

/** Near-white section background collapses all glass to solid. */
export const FLAT_LUMA_THRESHOLD = 0.9;

/** Body-text contrast floor (WCAG). */
export const HINT_CONTRAST_FLOOR = 4.5;

/** Normalize #RGB/#RRGGBB; anything else falls back (custom themes never crash). */
export function normHex(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const s = value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(s)) return s;
  const m3 = /^#([0-9a-fA-F]{3})$/.exec(s);
  if (m3) {
    const triple = m3[1];
    const r = triple[0];
    const g = triple[1];
    const b = triple[2];
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  return fallback;
}

/** sRGB relative luminance (WCAG), 0..1. Invalid input reads as black. */
export function relLum(hex) {
  const clean = normHex(hex, '#000000').slice(1);
  const n = parseInt(clean, 16);
  const channels = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

/** WCAG contrast ratio between two hex colors. */
export function contrast(a, b) {
  const x = relLum(a);
  const y = relLum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/**
 * DOM-free theme resolution. app.js applies the result to documentElement
 * (`data-scheme`, `data-flat`, `data-hint-ok`) on boot + themeChanged.
 */
export function readThemeTokensPure(input = {}) {
  const tp = input.themeParams ?? {};
  const cs = input.colorScheme;
  const scheme = cs === 'light' || cs === 'dark' ? cs : 'dark';

  const bg = normHex(tp.bg_color, NEUTRAL_BG);
  const secRaw = tp.section_bg_color ?? tp.secondary_bg_color ?? bg;
  const sec = normHex(secRaw, bg);
  const flat = relLum(sec) > FLAT_LUMA_THRESHOLD ? '1' : '';

  const hintFallback = relLum(bg) > 0.45 ? NEUTRAL_HINT_LIGHT : NEUTRAL_HINT_DARK;
  const hint = normHex(tp.hint_color, hintFallback);
  const hintOk = contrast(hint, bg) >= HINT_CONTRAST_FLOOR ? '1' : '0';

  return { scheme, flat, hintOk };
}
