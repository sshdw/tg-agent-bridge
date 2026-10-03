# Theme — Telegram themeParams drive every token

Source: R1 §A.4 (`themeParams`, `colorScheme`, `themeChanged`), R2 §2.6.
Telegram theme is the ONLY color source. `prefers-color-scheme` and the
neutral fallbacks in `tokens.css` cover pre-`ready()` only.

## 1. themeParams → token mapping (complete)

| Telegram param | Token(s) | Absent → fallback |
|---|---|---|
| `bg_color` | `--surface-solid`, `--app` base | `--bg` (#17212b dark / light block) |
| `secondary_bg_color` | second choice for `--surface-section` | `--bg-secondary` |
| `section_bg_color` | `--surface-section`, `--content-bg` | `secondary_bg_color` → `--bg-secondary` |
| `header_bg_color` | `--surface-header` | `--surface-solid` |
| `bottom_bar_bg_color` | `--surface-bar` | `--surface-section` |
| `text_color` | `--ink` | `--text` |
| `hint_color` | `--ink-hint` (checked, see §3) | `--text-hint` |
| `subtitle_text_color` | `--ink-sub` | `--ink-hint` |
| `section_header_text_color` | `--ink-section` | `--ink-hint` |
| `section_separator_color` | `--line`, `--content-divider` | `--hairline-soft` |
| `link_color` | links; accent fallback chain | `accent_text_color` → `currentColor` |
| `button_color` | primary action fill; accent chain | `accent_text_color` → `link_color` |
| `button_text_color` | `--on-accent` (text on accent) | `--ink` |
| `accent_text_color` | `--accent-action`, `--accent-text` (first choice) | `button_color` → `link_color` |
| `destructive_text_color` | `--danger` (destructive ONLY) | documented neutral-red (tokens.css) |
| `colorScheme` | `:root[data-scheme]` = `light` \| `dark` | `prefers-color-scheme` → `dark` |

Rule: no token may resolve to a hardcoded hex except the documented
pre-ready neutrals (`--bg`, `--bg-secondary`, `--text`, `--text-hint`)
and the destructive fallback. No fixed accent hex exists, anywhere.

## 2. Dark / light / custom

- **Dark** (`data-scheme="dark"`): default block in `tokens.css`. Glass
  tints are white-at-low-alpha over a dark theme background.
- **Light** (`data-scheme="light"`): first-class overrides in `tokens.css`
  (opaque-leaning white tints 0.55/0.72, dark hairlines, dark scrim,
  stronger specular values). Light is NOT "dark with inverted text" —
  every glass alpha, hairline, shadow, and specular has its own value.
- **Custom Telegram themes**: any user theme flows through the same
  mapping, so nothing breaks by construction — as long as every token has
  a fallback (table above) and the contrast guard (§3) runs on every
  `themeChanged`. Never branch on a theme name; branch only on measured
  luminance.

## 3. Contrast-failure detection + fallback (mechanical)

Known failure: near-white glass over near-white content becomes
unreadable; faint `hint_color` on white fails contrast.

Run `readThemeTokens()` on boot (before first paint) and on every
`themeChanged`:

```js
// sRGB relative luminance (WCAG). Returns 0..1.
function relLum(hex) {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}
function contrast(a, b) {
  const x = relLum(a), y = relLum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

function readThemeTokens() {
  const tg = window.Telegram?.WebApp;
  const tp = tg?.themeParams ?? {};
  const root = document.documentElement;
  root.dataset.scheme = tg?.colorScheme ?? "dark";

  // Hex literals below are pre-ready NEUTRALS (bg/hint/text grays), not accent.
  const bg  = tp.bg_color || "#17212b";
  const sec = tp.section_bg_color || tp.secondary_bg_color || bg;
  const lowContrastBg = relLum(sec) > 0.90;          // near-white on white
  root.dataset.flat = lowContrastBg ? "1" : "";      // collapses glass to solid

  const hint = tp.hint_color || (relLum(bg) > 0.45 ? "#707579" : "#8d9aa8");
  // Hint must reach 4.5:1 vs bg; else use text at 0.72 opacity.
  root.dataset.hintOk = contrast(hint, bg) >= 4.5 ? "1" : "0";
}
```

CSS consequence (in app CSS, next to tokens):

```css
:root[data-hint-ok="0"] .h-caption {
  color: var(--ink);
  opacity: 0.72;
}
```

Rules, all mechanically checkable:

- **F1.** `data-flat="1"` ⟺ `relLum(section_bg) > 0.90`. When set, every
  glass tier is solid (tokens.css `[data-flat]` block). Glass alpha must
  never be hand-tuned per theme — only this binary switch.
- **F2.** `hint_color` is used for text ONLY when `contrast(hint, bg) >=
  4.5`. Otherwise `text_color` at 0.72 opacity + non-light weight.
- **F3.** Light-theme glass always pairs with the 35% scrim path
  (`--glass-scrim`) on elevated/transient surfaces (HIG `clear` rule).

## 4. Live theme-change reaction

```js
tg?.onEvent("themeChanged", readThemeTokens);
```

`readThemeTokens` re-runs the mapping (CSS vars arrive automatically via
`--tg-theme-*`), the scheme flag, the flat switch, and the hint guard —
synchronously, no reload, no flash (same-frame attribute write, see
performance.md §4 for the flicker-free pattern).
