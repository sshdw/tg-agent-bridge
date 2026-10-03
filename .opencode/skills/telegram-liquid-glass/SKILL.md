---
name: telegram-liquid-glass
description: "Use when building or reviewing the Telegram Mini App UI: Liquid Glass surfaces, glassmorphism, blurred cards, bottom nav bar, sheets and modals, press and enter animations, motion and springs, Telegram theme colors and dark mode, surfaces and elevation, safe-area layout, or lite-mode fallbacks."
---

# Telegram Liquid Glass — Mini App design system

Single source of truth for the Mini App look and motion (4 tabs: Home / Tasks / Files / More).
Mobile-first, Telegram/iOS-26-style "Liquid Glass", functionally restrained.

> All numeric blur/alpha/spring values below are **project design tokens**, not measured
> Apple or Telegram values (Apple publishes no numbers; Telegram's code is closed).
> Spring constants are analytically derived project constants, **UNVERIFIED** against Telegram.

## Non-negotiables (reviewer checks these first)

1. **Readability over glass.** Text never sits on a noisy blurred background. Contrast on
   body text >= 4.5:1, on large text/icons >= 3:1. If Telegram `hint_color` fails, use
   `text_color` at 0.72 opacity instead.
2. **No glass over code.** Never put `backdrop-filter` over `mono` / `diff` / `log` blocks,
   tables, or any text < 15px unless covered by a >= 30% scrim.
3. **Glass is the functional layer only.** `bottom-nav`, sheets, floating controls, capsules
   may be glass. Content (`task-card`, `list-row`, `app-bar`, `section-header`, `empty-state`,
   `skeleton`) is always solid. (Apple HIG: "Don't use Liquid Glass in the content layer.")
4. **Telegram theme wins.** `themeParams` (`--tg-theme-*`, `--tg-color-scheme`) is the only
   correct color source. `prefers-color-scheme` and hardcoded palette are fallbacks only.
   Subscribe to `themeChanged` and recompute.
5. **No animation over 250 ms**, except exactly two: Mini App open (420 ms) and
   sheet present/dismiss (300 ms). Tab switches are instant (0 ms).
6. **Animate only `transform` and `opacity`** (plus `background-color` on hover/press).
   The single exception: `width` on the bottom-nav indicator (240 ms, same curve).
7. **Glass filter = `blur()` + optional `saturate()` only.** Never `hue-rotate`, `invert`,
   `sepia`, `grayscale`, `brightness`, `contrast`, `drop-shadow`, or SVG/`url()` filters
   in production code.
8. **Max 3 visible `backdrop-filter` elements, max 2 nested.** `blur` <= 28px everywhere,
   <= 12px on capsules. No glass inside scrolling lists (> 20 rows never animate on enter).
9. **No backdrop roots above glass.** No ancestor of a glass element may have `opacity` < 1,
   `filter`, `mask`/`clip-path`, `mix-blend-mode`, or `will-change: opacity/filter/...`.
   Run the pre-flight check in `references/checklist.md` before calling UI done.
10. **Lite mode is a feature, not decoration.** Three independent fallback signals, always
    all three: Telegram `performance_class` LOW (via User-Agent), `prefers-reduced-motion`,
    and low hardware (`hardwareConcurrency` <= 4). `prefers-reduced-transparency` is
    Experimental / limited availability — never rely on it alone.
11. **No stagger on lists.** `animation-delay` <= 100 ms total, <= 3 steps, only for 3-4 items
    appearing after one explicit user action. No infinite loops, no particles, no living
    wallpapers, no animated gradients. Skeletons never blink.
12. **System fonts only.** `-apple-system / system-ui / Roboto`, mono via `ui-monospace`.
    Zero network requests for fonts. No light weights (Regular/Medium/Semibold/Bold only),
    body 17px, minimum 11px.

## Surface -> material lookup

| Surface | Use | Glass? |
|---|---|---|
| App background | `.app-bg` (solid `--surface-solid`) | No |
| Floating summary card (cost, status) | `.glass-card` + specular `::before` | Yes |
| Bottom nav (Home/Tasks/Files/More + indicator) | `.glass-nav` + `.nav-indicator` | Yes — the hero element |
| Sheet / modal / toast over media | `.glass-elevated` (35% scrim + strong tint) | Yes |
| Segmented control, chips, status pill, pill buttons | `.glass-capsule` | Yes |
| Task rows, file/log rows, list rows | `.solid-card` | **No** |
| App bar, section header, empty state, skeleton | type/spacing only, solid or transparent | **No** |
| Code, diffs, logs, tables, cost/time metrics | `.mono` / `.metric` (`tabular-nums`), solid bg | **No, never** |
| Lite mode / no `backdrop-filter` support | `.solid-card` everywhere | **No** |

Opacity follows responsibility: larger element or more text inside -> more opaque fill
and/or stronger scrim. Accent color: at most one (`link`/`button_color`) + destructive.
No purple/neon, no colored glow, no colored multi-layer shadows.

## Layout in one paragraph

`min-height: 100svh`; top padding from `--safe-top`; bottom nav `position: fixed`,
pinned to `--tg-viewport-stable-height` (never `viewportHeight`), with
`margin-bottom: calc(var(--safe-bottom) + 8px)`; content `padding-bottom` clears the
72px nav; content `max-width: 560px` centered; never duplicate Telegram's native header
with our own app bar. Safe-area tokens merge device + Telegram insets with `max()` —
see `references/tokens.css`.

## Motion in one paragraph

Springs via CSS `linear()` (0 KB, no library). Press: scale 0.96-0.98 + opacity
0.85-0.92, 90 ms down (`--ease-std`), 180 ms release (`--spring-press`). Springs only
for things with "mass" (button return, nav indicator, dragged element); plain curves
for opacity/color. Never animate during scroll; `enter` animations only above the fold.
Full tables, curves, and the do-not-animate list: `references/motion.md`.

## References (progressive loading — open only what you need)

- Exact token values, material classes, light-theme and lite overrides:
  `references/tokens.css` — copy-paste ready, single source of truth.
- Spring `linear()` curves, durations, press spec, do-not-animate list:
  `references/motion.md`.
- Component inventory (glass vs not) + 3 worked implementations (bottom nav with
  animated indicator; scroll-reactive card; Mini App open transition):
  `references/components.md`.
- Pre-merge review: `references/checklist.md` — every item is a number, a property
  value, or a grep-able condition. Includes the `backdrop-root` pre-flight check.

## When NOT to use glass

- Inside the content layer: task rows, file rows, logs, diffs, tables, code (D6).
- Over text smaller than 15px without a >= 30% scrim (D6).
- More than 3 visible blurred elements or 2 nested levels (D1/D2).
- On LOW performance class, under `prefers-reduced-motion`, or when the user disabled
  effects: use `.solid-card` + opacity-only transitions <= 150 ms.
- As decoration: breathing/pulse animations, parallax backgrounds, particles, bokeh,
  mesh gradients, animated gradients (D17-D19).
- To re-play the Mini App open transition: the Telegram client owns it; we only reveal
  content once on `ready()` (see `references/components.md`).
- Where `color-mix()` or `animation-timeline` is required but unsupported: serve the
  `@supports` fallback branch, never a broken half-effect.

## Wiring checklist (JS, from platform research)

- `tg.ready()` then `tg.expand()` as early as possible.
- `onEvent("themeChanged")` -> set `data-scheme`, recompute luminance tokens.
- `onEvent("viewportChanged")` -> update `--tg-viewport-stable-height` only when
  `isStateStable` is true.
- `disableVerticalSwipes()` when our gestures conflict with the close swipe.
- Perf class from Android User-Agent (`LOW`/`AVERAGE`/`HIGH`) + `prefers-reduced-motion`
  + `hardwareConcurrency` -> set `data-perf="low"` on `:root`.

## Minimal boot wiring (copy-paste, then adapt)

```js
const tg = window.Telegram?.WebApp;
const root = document.documentElement;

// Theme: Telegram is the source of truth.
root.dataset.scheme = tg?.colorScheme ?? "dark";
tg?.onEvent("themeChanged", () => {
  root.dataset.scheme = tg.colorScheme;
});

// Stable viewport + insets: touch only when stable, or the UI jitters.
function syncGeometry() {
  root.style.setProperty("--tg-viewport-stable-height", `${tg.viewportStableHeight}px`);
  const s = tg.safeAreaInset ?? { top: 0, bottom: 0, left: 0, right: 0 };
  const c = tg.contentSafeAreaInset ?? { top: 0, bottom: 0, left: 0, right: 0 };
  root.style.setProperty("--tg-safe-area-inset-top", `${s.top}px`);
  root.style.setProperty("--tg-safe-area-inset-bottom", `${s.bottom}px`);
  root.style.setProperty("--tg-content-safe-area-inset-top", `${c.top}px`);
  root.style.setProperty("--tg-content-safe-area-inset-bottom", `${c.bottom}px`);
}
tg?.onEvent("viewportChanged", ({ isStateStable }) => { if (isStateStable) syncGeometry(); });
tg?.onEvent("safeAreaChanged", syncGeometry);
tg?.onEvent("contentSafeAreaChanged", syncGeometry);

// Lite mode: three independent signals, any one triggers it.
const m = navigator.userAgent.match(/Telegram-Android\/[\d.]+\s+\([^)]*;\s*([^;)]+)\)/);
const perfClass = m ? m[1].trim() : null;
if (perfClass === "LOW"
    || matchMedia("(prefers-reduced-motion: reduce)").matches
    || (navigator.hardwareConcurrency ?? 8) <= 4) {
  root.dataset.perf = "low";
}

tg?.ready();
tg?.expand();
```

## Fallback ladder (all three ship, always)

1. `data-perf="low"` from JS (LOW class / reduced motion / weak hardware) — full
   lite mode: solid surfaces, blur <= 12px, springs replaced by `--ease-std`.
2. `prefers-reduced-transparency` media query — best-effort OS signal only.
3. `@supports not (backdrop-filter)` — static solid UI for old WebViews.

## Maintenance

- Tokens live in `references/tokens.css` only. A value that appears in two
  places is a bug — move it into tokens.
- R2 caveats travel with the values: anything marked UNVERIFIED / INFERENCE in
  `docs/research/R2-LIQUID-GLASS.md` stays marked here. Never promote a guess
  to a rule.
- Real-device validation still owed (R2 §7.1): actual fps cost of
  `backdrop-filter` in Telegram WebViews, `animation-timeline` support there,
  and `prefers-reduced-transparency` delivery. Re-measure before tightening
  any number in this skill.
