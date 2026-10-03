---
name: telegram-liquid-glass
description: "Use when building or reviewing the Telegram Mini App UI: Liquid Glass surfaces, three-tier material hierarchy, bottom nav bar, floating controls, sheets and modals, press and enter animations, motion and springs, Telegram theme colors and dark/light mode, performance Auto/Full/Lite modes, safe-area layout, or flat-mode fallbacks."
---

# Telegram Liquid Glass — Mini App design system

Single source of truth for the Mini App look and motion (4 tabs: Home / Tasks / Files / More).
Mobile-first, Telegram/iOS-26-style "Liquid Glass", functionally restrained.
Design starts in dark (glass reads best there); light ships complete from day one.

> All numeric blur/alpha/spring values below are **project design tokens**, not measured
> Apple or Telegram values (Apple publishes no numbers; Telegram's code is closed).
> Spring constants are analytically derived project constants, **UNVERIFIED** against Telegram.
> "Refraction" here is always a labelled SIMULATION — real pixel-displacement
> refraction does not exist in CSS. This skill contains no hosting/tunnel/VPN
> decisions; those live elsewhere.

## Non-negotiables (reviewer checks these first)

1. **Three-tier hierarchy — glass belongs to function, not content.**
   CONTENT → flat/translucent, minimal blur (none), thin dividers, whitespace.
   FLOATING CONTROLS → light glass (one [Stop] [Details] bar max).
   NAVIGATION → strong Liquid Glass (the 4-tab bar ONLY: blur, translucency,
   refraction simulation, dynamic highlights, fluid morphing, spring).
   SYSTEM/TRANSIENT → Telegram theme colours + 35% scrim. "Glass on every
   card" is a checklist violation (C1–C4).
2. **Accent cap: exactly 5 places, theme-mapped, no fixed hex.** Accent comes
   only from `accent_text_color` / `button_color` / `link_color`, restricted to:
   (1) primary action, (2) selected tab, (3) links, (4) status highlights,
   (5) progress. Any sixth use fails review (AC1–AC2).
3. **Performance ladder: Auto | Full effects | Lite** (More → Performance,
   default Auto). HIGH → full; AVERAGE → reduced blur/motion; LOW → Lite;
   manual Full/Lite overrides Auto; `prefers-reduced-motion` forces at least
   Lite motion. `Telegram.WebApp.performance_class` is UNVERIFIED as an API —
   never read it; the Android User-Agent tail is an optional enhancement only
   (performance.md §0).
4. **Readability over glass.** Text never sits on a noisy blurred background. Contrast on
   body text >= 4.5:1, on large text/icons >= 3:1. If Telegram `hint_color` fails, use
   `text_color` at 0.72 opacity instead. Near-white theme (`relLum > 0.90`) collapses
   all glass to solid via `data-flat="1"` (theme.md §3).
5. **No glass over code.** Never put `backdrop-filter` over `mono` / `diff` / `log` blocks,
   tables, or any text < 15px unless covered by a >= 30% scrim.
6. **Telegram theme wins.** Full `themeParams` → token mapping with fallbacks (theme.md §1).
   Dark, light, and arbitrary custom themes must all work. `prefers-color-scheme` and the
   neutral fallbacks are pre-`ready()` only. Subscribe to `themeChanged` and recompute
   mapping + flat switch + hint guard.
7. **No animation over 250 ms**, except exactly two: Mini App open (420 ms) and
   sheet present/dismiss (300 ms). Tab switches are instant (0 ms).
8. **Animate only `transform` and `opacity`** (plus `background-color` on hover/press).
   The single exception: `width` on the bottom-nav indicator (240 ms, same curve).
9. **Glass filter = `blur()` + optional `saturate()` only.** Never `hue-rotate`, `invert`,
   `sepia`, `grayscale`, `brightness`, `contrast`, `drop-shadow`, or SVG/`url()` filters
   in production code. Blur <= 28px (nav), <= 20px (float), <= 12px (capsules).
10. **Max 3 visible `backdrop-filter` elements, max 2 nested.** No glass inside scrolling
    content (> 20 rows never animate on enter). No backdrop roots above glass.
    Run the pre-flight check in `references/checklist.md` before calling UI done.
11. **Lite/reduced are features, not decoration.** Resolved modes `full | reduced | lite`
    on `:root[data-perf]`; Auto fuses UA class (optional), JS heuristic (memory, cores,
    pixel ratio, measured frame budget), and reduced-motion. `prefers-reduced-transparency`
    is Experimental / limited availability — never rely on it alone; its delivery into
    the Telegram WebView is UNVERIFIED.
12. **No stagger on lists.** `animation-delay` <= 100 ms total, <= 3 steps, only for 3-4 items
    appearing after one explicit user action. No infinite loops, no particles, no living
    wallpapers, no animated gradients. Skeletons never blink.
13. **System fonts only.** `-apple-system / system-ui / Roboto`, mono via `ui-monospace`.
    Zero network requests for fonts. No light weights (Regular/Medium/Semibold/Bold only),
    body 17px, minimum 11px.

## Refraction simulation (honest framing, 8 ingredients)

Real refraction: no. Convincing simulation: yes — blur; dynamic edge highlight
shifting with scroll; fake background-texture shift (positioned gradient, never a
displacement map); travelling specular; soft inner bleed (neutral white, never colored
glow); spring/morph; subtle parallax (<= 8px); scroll-driven material change on
nav + floating controls ONLY, blur always pinned. Full stack: `references/tokens.css`.

## Surface -> material lookup

| Surface | Class | Glass? |
|---|---|---|
| App background, task rows, file/log rows, headers, sections, empty states, skeletons | `.app-bg` / `.content-card` / `.list-row` / type only | **No — flat** |
| Floating action bar ([Stop] [Details]) | `.glass-float` (+ `--reactive` scroll ramp) | Light — second tier |
| Bottom nav (Home/Tasks/Files/More + indicator) | `.glass-nav` (+ `.glass-tex` + `--reactive`) | **Yes — max, hero element** |
| Sheet / modal / toast over media | `.glass-elevated` (35% scrim + tint) | Transient only |
| Sticky segmented control, status pill, floating pill buttons | `.glass-capsule` | Functional layer only |
| Code, diffs, logs, tables, cost/time metrics | `.mono` / `.metric` (`tabular-nums`), solid bg | **No, never** |
| Near-white theme / Lite / no `backdrop-filter` | flat `content-card` look | **No** |

Opacity follows responsibility: larger element or more text inside -> more opaque fill
and/or stronger scrim. No purple/neon, no colored glow, no colored multi-layer shadows.

## Layout in one paragraph

`min-height: 100svh`; top padding from `--safe-top`; bottom nav `position: fixed`,
pinned to `--tg-viewport-stable-height` (never `viewportHeight`), with
`margin-bottom: calc(var(--safe-bottom) + 8px)`; floating bar clears the 64px nav;
content `padding-bottom` clears nav + bar; content `max-width: 560px` centered; never
duplicate Telegram's native header with our own app bar. Safe-area tokens merge device +
Telegram insets with `max()` — see `references/tokens.css`.

## Motion in one paragraph

Springs via CSS `linear()` (0 KB, no library). Press: scale 0.96-0.98 + opacity
0.85-0.92, 90 ms down (`--ease-std`), 180 ms release (`--spring-press`). Springs only
for things with "mass" (button return, nav indicator, dragged element); plain curves
for opacity/color. Never animate during scroll except the nav/float scroll ramp;
`enter` animations only above the fold. Full tables, curves, and the do-not-animate
list: `references/motion.md`.

## References (progressive loading — open only what you need)

- Exact token values, tier classes, simulation stack, light/flat/perf blocks:
  `references/tokens.css` — copy-paste ready, single source of truth.
- Telegram theme mapping, dark/light/custom, contrast-failure guard, live reaction:
  `references/theme.md`.
- Auto/Full/Lite ladder, JS heuristic, UA feature-detection rule, flicker-free switch:
  `references/performance.md`.
- Spring `linear()` curves, durations, press spec, do-not-animate list:
  `references/motion.md`.
- Tiered inventory + 3 worked implementations (bottom nav; floating bar; open transition):
  `references/components.md`.
- Pre-merge review: `references/checklist.md` — every item is a number, a property
  value, or a grep-able condition. Includes the `backdrop-root` pre-flight check.

## When NOT to use glass

- Inside the content layer: task rows, file rows, logs, diffs, tables, code.
- Over text smaller than 15px without a >= 30% scrim.
- More than 3 visible blurred elements or 2 nested levels.
- On `reduced`/`lite` resolved mode, near-white theme (`data-flat="1"`), under
  `prefers-reduced-motion`, or manual Lite: flat surfaces + opacity-only motion <= 150 ms.
- As decoration: breathing/pulse animations, background parallax, particles, bokeh,
  mesh gradients, animated gradients.
- To re-play the Mini App open transition: the Telegram client owns it; we only reveal
  content once on `ready()` (see `references/components.md`).
- Where `color-mix()` or `animation-timeline` is required but unsupported: serve the
  `@supports` fallback branch, never a broken half-effect.

## Wiring checklist (JS, from platform research)

- `tg.ready()` then `tg.expand()` as early as possible.
- `onEvent("themeChanged")` -> `readThemeTokens()` (scheme + flat switch + hint guard).
- `onEvent("viewportChanged")` -> update `--tg-viewport-stable-height` only when
  `isStateStable` is true.
- `disableVerticalSwipes()` when our gestures conflict with the close swipe.
- Perf: `readTelegramPerfClass()` (UA, optional) + JS heuristic + reduced-motion
  -> async resolve -> set `data-perf="full|reduced|lite"`; manual choice wins.

## Minimal boot wiring (copy-paste, then adapt)

```js
const tg = window.Telegram?.WebApp;
const root = document.documentElement;

// Theme: Telegram is the source of truth (full version: theme.md).
root.dataset.scheme = tg?.colorScheme ?? "dark";
root.dataset.perf = localStorage.getItem("perf_choice") === "lite" ? "lite"
  : localStorage.getItem("perf_choice") === "full" ? "full" : "full";
tg?.onEvent("themeChanged", readThemeTokens); // theme.md §3–§4

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

// Perf: NEVER read Telegram.WebApp.performance_class (UNVERIFIED as API).
// UA tail is optional; heuristic + reduced-motion decide (performance.md §2).
autoPerf().then(mode => {
  if (localStorage.getItem("perf_choice") === "auto") root.dataset.perf = mode;
});

tg?.ready();
tg?.expand();
```

## Fallback ladder (all ship, always)

1. `data-perf="reduced|lite"` from Auto (UA class / heuristic / reduced-motion)
   or manual More → Performance — blur caps, sim off, then full flat.
2. `data-flat="1"` from near-white detection — glass collapses to solid.
3. `prefers-reduced-transparency` media query — best-effort OS signal only.
4. `@supports not (backdrop-filter)` — static flat UI for old WebViews.

## Maintenance

- Tokens live in `references/tokens.css` only. A value that appears in two
  places is a bug — move it into tokens.
- R1/R2 caveats travel with the values: anything marked UNVERIFIED / INFERENCE in
  `docs/research/` stays marked here. Never promote a guess to a rule.
- Real-device validation still owed (R2 §7.1): actual fps cost of
  `backdrop-filter` in Telegram WebViews, `animation-timeline` support there,
  frame-budget thresholds, and `prefers-reduced-transparency` delivery.
  Re-measure before tightening any number in this skill.
```

