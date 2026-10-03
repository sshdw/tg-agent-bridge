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
  first screen: the nav, at most one floating bar, at most one transient
  overlay. Check: count elements with computed `backdropFilter !== 'none'`
  and non-empty `getBoundingClientRect()` — must be ≤ 3.
- [ ] **D3.** `blur()` ≤ **28px** everywhere; capsules ≤ **12px**; float tier ≤
  **20px**. Grep: `blur\((2[9-9]|[3-9]\d|\d{3,})px` must return nothing.
- [ ] **D4.** `backdrop-filter` contains only `blur()` and `saturate()` (max two
  functions). Grep: `backdrop-filter:[^;]*(hue-rotate|invert|sepia|grayscale|brightness|contrast|drop-shadow|url\()` must return nothing.
- [ ] **D5.** No `filter: url(...)` and no SVG displacement/turbulence filters
  (`feDisplacementMap`, `feTurbulence`) in production code. The texture-fake
  is a positioned gradient (`.glass-tex`), never a displacement map. Grep:
  `feDisplacementMap|feTurbulence|filter:\s*url\(` must return nothing outside
  an isolated demo page.

## Readability

- [ ] **D6.** No `backdrop-filter` over `mono`/`diff`/`log` classes, tables, or
  text < 15px — unless covered by a scrim ≥ 30% opacity. Check: overlay each
  glass element's rect against code/log/diff rects; assert no intersection.
- [ ] **D7.** Text contrast ≥ **4.5:1** (body), ≥ **3:1** (large text ≥ 24px or
  ≥ 18.66px bold; icons/borders). `hint_color` never assumed — compute via
  `relLum` (theme.md); on failure use `text_color` at 0.72 opacity
  (`data-hint-ok="0"` path present and styled).
- [ ] **D8.** Every interactive element has `:focus-visible` =
  `outline: 2px solid var(--tg-theme-link-color, var(--tg-theme-accent-text-color, currentColor));
  outline-offset: 2px`. Grep must show NO hex fallback in the outline rule.

## Accent — hard cap, exactly 5 places (D5)

- [ ] **AC1.** Accent tokens are USED in exactly five selector groups, nowhere
  else. Grep `var\(--accent-(action|text)\)` (uses, not the two `--accent-*:`
  definitions in tokens.css `:root`, which are the token source) and assert
  every hit is inside one of:
  1. `.btn-primary` — primary action (fill + `--on-accent` text);
  2. `.nav-item[aria-selected="true"]` — selected tab;
  3. `a` — links;
  4. `.status-hl` / state dot — status highlights;
  5. `.progress-bar` — progress.
  Count of distinct accented selector groups ≤ 5. Any sixth use fails.
- [ ] **AC2.** No fixed accent hex anywhere. Grep `#[0-9a-fA-F]{3,8}` in app CSS:
  every hit must be a documented neutral (bg/text/hint/disabled grays) or the
  destructive fallback — never presented as accent, never purple/neon/acid.
- [ ] **D9.** No purple/neon/acid; no colored `text-shadow` glow; no `box-shadow`
  with 3+ colored layers; no animated gradients. The `--sim-bleed` inset is
  neutral white only. Grep:
  `text-shadow:[^;]*#[0-9a-f]{3,6}|animation:[^;]*gradient` must return nothing.
- [ ] **D11.** No web fonts — no `<link>`/ `@import` / `@font-face` fetching
  fonts, zero font network requests. Grep: `@font-face|fonts\.google|font-display`
  must return nothing.

## Material hierarchy — content is flat (D6)

- [ ] **C1.** Content-layer components are NEVER glass: `task-card`,
  `list-row`, `app-bar`, `section-header`, `empty-state`, `skeleton`,
  `content-card`, `solid-card`, `mono`, `metric` must have NO
  `backdrop-filter` declaration. Grep each class name joined with
  `backdrop-filter` — must return nothing.
- [ ] **C2.** Maximum glass sits on the 4-tab nav ONLY (`.glass-nav` /
  `.bottom-nav`). Exactly one `.glass-nav` exists per screen. Grep:
  `glass-nav` defined once in tokens.css; used once per screen.
- [ ] **C3.** Second glass tier (`.glass-float`) is used ONLY for floating
  action controls (e.g. [Stop] [Details] bar), max one per screen, never
  inside content rows or feeds.
- [ ] **C4.** Scroll-driven material change exists ONLY on nav + floating
  controls (`nav-material` / `float-material` keyframes). No
  scroll-reactive card, no scroll-linked effect on any content component.
  Grep `animation-timeline` — allowed hits are nav/float selectors only.

## Motion

- [ ] **D12.** No animation longer than **250 ms** except exactly three: Mini App open (420 ms,
  `--spring-open`), sheet present/dismiss (300 ms), and a single 1200 ms
  skeleton pass (R2 D20; see D20). Grep all
  `transition(-duration)?` / `animation(-duration)?` values and assert each ≤
  250 ms unless the selector is `.app[data-ready]`, `.sheet`, or a
  single-pass `.skeleton`.
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
- [ ] **D17.** No breathing/pulse loops, no background parallax. Parallax only
  scroll-linked on nav/float, full mode only, amplitude ≤ **8px** total.
- [ ] **D18.** No animated particles / bokeh / noise. Grep:
  `particle|bokeh|noise\.png` must return nothing.
- [ ] **D19.** No living wallpapers, video backgrounds, mesh gradients. Grep:
  `<video.*background|mesh-gradient` must return nothing.
- [ ] **D20.** Skeletons do not blink (R2 D20): `animation: none` or a single 1200 ms
  pass, max one animated skeleton per group.

## Performance modes (D3) — all three verified

- [ ] **PF1.** All three resolved modes exist in CSS: `data-perf="full"` (default,
  no overrides), `data-perf="reduced"` (blur caps 16/12px, no sim, no springs),
  `data-perf="lite"` (solid, opacity-only ≤150ms). Grep `data-perf=` — all
  three branches present in tokens.css.
- [ ] **PF2.** Auto resolves HIGH→full, AVERAGE→reduced, LOW→lite; JS-heuristic
  (deviceMemory, hardwareConcurrency, devicePixelRatio, measured frame budget)
  feeds the same ladder; `prefers-reduced-motion` forces at least lite motion.
  `window.Telegram.WebApp.performance_class` is never read (UNVERIFIED as API).
- [ ] **PF3.** More → Performance offers Auto | Full effects | Lite, default
  Auto; manual Full/Lite overrides Auto; choice persists (CloudStorage +
  localStorage fallback); mode switch applies synchronously with no reload.

## Light theme (D4) — complete, not "same as dark"

- [ ] **LT1.** `:root[data-scheme="light"]` block exists with its OWN glass
  alphas, hairlines, shadows, specular values (not inherited from dark).
- [ ] **LT2.** Near-white guard wired: `readThemeTokens()` computes
  `relLum(section_bg)`; `> 0.90` sets `data-flat="1"` which collapses all
  glass tiers to solid. Check: `[data-flat]` block present in tokens.css,
  detection runs on boot + `themeChanged`.
- [ ] **LT3.** Custom Telegram themes cannot break layout: every token has a
  fallback (theme.md table), no branch on theme names, contrast guard F2
  enforced for hint text.

## Theme and platform wiring

- [ ] **T1.** Colors come from `--tg-theme-*` / `--tg-color-scheme`; neutral
  palette only as pre-`ready()` fallback. `themeChanged` subscription present
  and re-runs mapping + flat switch + hint guard.
- [ ] **T2.** Bottom nav pinned to `--tg-viewport-stable-height`, never
  `viewportHeight`; `margin-bottom: calc(var(--safe-bottom) + 8px)`, never
  `bottom: 0`.
- [ ] **T3.** Lite path verified by hand: set `data-perf="lite"` + block
  `backdrop-filter` in DevTools and confirm the UI stays fully usable as
  flat surfaces with opacity-only motion. Repeat for `reduced`.
