# Review checklist — run before calling any UI done

Every item is a number, a property value, or a grep-able condition.
Fail any item → fix before merge.

## 0. Backdrop-root pre-flight (run FIRST — invisible until it ships)

- [ ] **P0.** No ancestor of any glass element creates a backdrop root. An element
  is a backdrop root if ANY of these hold: `filter` != `none`; `opacity` < 1;
  `mask`/`mask-image`/`mask-border`/`clip-path` != `none`; its own
  `backdrop-filter` != `none`; `mix-blend-mode` != `normal`; `will-change`
  names any of the above. Inside a backdrop root the blur sees only content
  between that element and the glass child — the page background stops
  blurring and glass looks silently broken.
- [ ] **P0-check.** In DevTools, for each `backdrop-filter` element walk up the
  ancestor chain and read computed `opacity`, `filter`, `mask-image`,
  `clip-path`, `mix-blend-mode`, `will-change`. All must be `1` / `none` /
  `normal`. Grep: `opacity:\s*0\.\d+|filter:\s*blur\(0\)|will-change:\s*opacity`
  on shared containers (scroll areas, card lists) must return nothing.

## Layers and blur

- [ ] **D1.** Max **2** nested glass layers (`backdrop-filter` element inside a
  `backdrop-filter` element). Check: for each element with computed
  `backdropFilter !== 'none'`, count ancestors with `backdropFilter !== 'none'`
  — must be ≤ 1.
- [ ] **D2.** Max **3** simultaneously visible `backdrop-filter` elements on the
  first screen. Check: count elements with computed `backdropFilter !== 'none'`
  and non-empty `getBoundingClientRect()` — must be ≤ 3.
- [ ] **D3.** `blur()` ≤ **28px** everywhere; capsules ≤ **12px**. Grep:
  `blur\((2[9-9]|[3-9]\d|\d{3,})px` must return nothing.
- [ ] **D4.** `backdrop-filter` contains only `blur()` and `saturate()` (max two
  functions). Grep: `backdrop-filter:[^;]*(hue-rotate|invert|sepia|grayscale|brightness|contrast|drop-shadow|url\()` must return nothing.
- [ ] **D5.** No `filter: url(...)` and no SVG displacement/turbulence filters
  (`feDisplacementMap`, `feTurbulence`) in production code. Grep:
  `feDisplacementMap|feTurbulence|filter:\s*url\(` must return nothing outside
  an isolated demo page.

## Readability

- [ ] **D6.** No `backdrop-filter` over `mono`/`diff`/`log` classes, tables, or
  text < 15px — unless covered by a scrim ≥ 30% opacity. Check: overlay each
  glass element's rect against code/log/diff rects; assert no intersection.
- [ ] **D7.** Text contrast ≥ **4.5:1** (body), ≥ **3:1** (large text ≥ 24px or
  ≥ 18.66px bold; icons/borders). `hint_color` never assumed — compute via
  `relLum`; on failure use `text_color` at 0.72 opacity.
- [ ] **D8.** Every interactive element has `:focus-visible` =
  `outline: 2px solid var(--tg-theme-link-color, var(--accent)); outline-offset: 2px`.

## Color

- [ ] **D9.** Max **1** accent color (`link`/`button_color`) + destructive for
  destructive actions. No extra brand colors.
- [ ] **D10.** No purple/neon/acid; no colored `text-shadow` glow; no `box-shadow`
  with 3+ colored layers; no animated gradients. Grep:
  `text-shadow:[^;]*#[0-9a-f]{3,6}|animation:[^;]*gradient` must return nothing.
- [ ] **D11.** No web fonts — no `<link>`/ `@import` / `@font-face` fetching
  fonts, zero font network requests. Grep: `@font-face|fonts\.google|font-display`
  must return nothing.

## Motion

- [ ] **D12.** No animation longer than **250 ms** except Mini App open (420 ms,
  `--spring-open`) and sheet present/dismiss (300 ms). Grep all
  `transition(-duration)?` / `animation(-duration)?` values and assert each ≤
  250 ms unless the selector is `.app[data-ready]` or `.sheet`.
- [ ] **D13.** No `animation-iteration-count: infinite` anywhere. Grep:
  `infinite` must return nothing in app CSS.
- [ ] **D14.** No stagger on lists; `animation-delay` total ≤ **100 ms**, ≤ **3**
  steps, only for 3–4 items after one explicit user action. Grep:
  `animation-delay` values; assert each computed total ≤ 100 ms.
- [ ] **D15.** Only `transform`, `opacity` (and `background-color` on hover/press)
  are animated. Banned: `width` (except `.nav-indicator`, 240 ms
  `--spring-nav`), `height`, `top`, `left`, `filter`, `box-shadow`,
  `backdrop-filter`. Grep `transition:[^;]*(width|height|filter|box-shadow|backdrop-filter)`
  — the only allowed hit is `.nav-indicator`.
- [ ] **D16.** No `will-change: opacity|filter|mask|clip-path|mix-blend-mode` on
  any container with glass descendants (backdrop root — see P0). `will-change:
  transform` on buttons is fine.

## Content rules

- [ ] **D17.** No breathing/pulse loops, no background parallax. Parallax only
  scroll-linked, full mode only, amplitude ≤ **8px**.
- [ ] **D18.** No animated particles / bokeh / noise. Grep:
  `particle|bokeh|noise\.png` must return nothing.
- [ ] **D19.** No living wallpapers, video backgrounds, mesh gradients. Grep:
  `<video.*background|mesh-gradient` must return nothing.
- [ ] **D20.** Skeletons do not blink: `animation: none` or a single 1200 ms
  pass, max one animated skeleton per group.

## Theme and platform wiring

- [ ] **T1.** Colors come from `--tg-theme-*` / `--tg-color-scheme`; hardcoded
  palette only as pre-`ready()` fallback. `themeChanged` subscription present.
- [ ] **T2.** Bottom nav pinned to `--tg-viewport-stable-height`, never
  `viewportHeight`; `margin-bottom: calc(var(--safe-bottom) + 8px)`, never
  `bottom: 0`.
- [ ] **T3.** Lite path verified: set `data-perf="low"` + block
  `backdrop-filter` in DevTools and confirm the UI stays fully usable as
  solid surfaces with opacity-only motion.
