# Components — tiered inventory + three worked implementations

Tier rule (D6): CONTENT is flat; FLOATING CONTROLS are light glass;
NAVIGATION (the 4-tab bar) is the single maximum-glass element;
SYSTEM/TRANSIENT overlays use theme colours + scrim. Detail: SKILL.md.

## Inventory (one-line purpose each)

| Component | Purpose | Tier / material |
|---|---|---|
| `app-bar` | Section/task heading inside content; never duplicates Telegram's native header | CONTENT — solid or absent |
| `task-card` | Task row in feed: title, status, time, cost | CONTENT — `content-card`, never glass |
| `list-row` | List row (files, logs, agents) with icon + secondary text | CONTENT — transparent + divider |
| `section-header` | List section heading | CONTENT — typography only |
| `progress-bar` | Task/quota progress | CONTENT — thin bar, accent place 5/5 |
| `status-pill` | "Agent online / queue N / limit" compact capsule with state dot | FUNCTIONAL — `glass-capsule`, never inside content rows |
| `segmented-control` | Same-level filter/tab switcher, sticky/floating only | FUNCTIONAL — `glass-capsule` + thumb |
| `glass-float` | Floating action bar, e.g. [Stop] [Details] | FLOATING — light glass, second tier |
| `bottom-nav` | 4 tabs Home · Tasks · Files · More + active indicator | NAVIGATION — `glass-nav`, maximum glass |
| `bottom-sheet` | Modal choice/details sliding from bottom | SYSTEM — `glass-elevated` + 35% scrim |
| `toast` | Brief notification over content | SYSTEM — `glass-elevated`; solid if over a diff |
| `empty-state` | "List is empty" — icon + text + one action | CONTENT — no glass |
| `skeleton` | Loading placeholder blocks, never blinking | CONTENT — `--ink-hint` at 8–12% |

**Readability rule:** glass only where underneath is (a) flat app background or
(b) large smooth blocks. Glass is banned over diff viewer, monospace code, logs,
tables, and anywhere text is ≤ 15px — there use flat `content-card` or a 35% scrim.

**Accent appears in exactly 5 places** (hard cap, see checklist.md AC1):
primary action · selected tab · links · status highlights · progress.
`accent-text-color`/`button_color`/`link_color` only; no fixed hex.

Icons: SVG sprite or inline SVG, `currentColor`, 24px, `stroke-width: 1.75`,
`stroke-linecap: round`. No icon fonts, no raster PNG.

## 1. Floating bottom nav with animated indicator (maximum glass)

One absolutely-positioned indicator moved via `transform` (JS measures real tab
geometry) — cheaper than four highlighted tabs and reads as a "magnet".
`width` on `.nav-indicator` is the **single allowed `width` transition** in the
system (240 ms, same `--spring-nav` curve); everything else is transform/opacity.
Full simulation stack lives here and ONLY here: blur + edge highlight +
texture sheen (`.glass-tex`) + specular ring + inner bleed + spring
indicator + scroll-driven material ramp (tokens.css `@keyframes nav-material`).

```css
.bottom-nav {
  position: fixed;
  left: var(--safe-left);
  right: var(--safe-right);
  /* Pin to the STABLE height, never the live viewport height. */
  bottom: calc(100svh - min(var(--tg-viewport-stable-height, 100svh), 100svh));
  margin-bottom: calc(var(--safe-bottom) + 8px); /* breathing room, never bottom: 0 */
  margin-inline: auto;
  max-width: 560px;
  padding-inline: 16px;

  height: 64px;
  border-radius: var(--r-xl); /* 28px "pill" */

  display: grid;
  grid-template-columns: repeat(4, 1fr);
  align-items: center;

  background: var(--nav-tint);
  backdrop-filter: blur(var(--nav-blur)) saturate(var(--nav-sat));
  -webkit-backdrop-filter: blur(var(--nav-blur)) saturate(var(--nav-sat));
  box-shadow:
    var(--elev-2),
    inset 0 0 0 1px var(--hairline-soft),
    inset 0 12px 14px -12px var(--sim-bleed),
    inset 0 -8px 12px -12px var(--sim-bleed);

  z-index: 30;
  overflow: hidden; /* indicator / sheen never escape the rounded edge */
}

/* Specular highlight along the top edge — the glint that sells glass.
 * Scroll-linked variant (.glass-nav--reactive) breathes via tokens.css. */
.bottom-nav::before {
  content: "";
  position: absolute;
  inset: 0 0 auto 0;
  height: 1px;
  background: linear-gradient(
    90deg,
    rgba(255,255,255,0) 0%,
    var(--sim-edge-dim) 25%,
    var(--sim-edge) 50%,
    var(--sim-edge-dim) 75%,
    rgba(255,255,255,0) 100%
  );
  pointer-events: none;
}

.nav-indicator {
  position: absolute;
  top: 8px;
  left: 0;
  height: 48px;
  width: var(--ind-w, 25%); /* set by JS from measured tab width */
  transform: translate3d(var(--ind-x, 0px), 0, 0); /* set by JS from measured offset */
  border-radius: var(--r-lg);
  background: rgba(255, 255, 255, 0.14);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.12);
  transition:
    transform 240ms var(--spring-nav),
    width     240ms var(--spring-nav); /* the one allowed width transition */
  pointer-events: none;
}

.nav-item {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  height: 48px;
  border: 0;
  background: none;
  cursor: pointer;
  color: var(--ink-hint);
  font: var(--fs-caption) / var(--lh-caption) var(--font-sans);
  transition: color 180ms var(--ease-std); /* color only, no transform */
}
.nav-item[aria-selected="true"] {
  color: var(--accent-text); /* accent place 2/5: selected tab */
}
.nav-item svg { width: 24px; height: 24px; }
.nav-item:active { opacity: 0.7; transition-duration: 90ms; }
```

```js
// Positions the indicator from measured geometry; recalc on resize.
function moveIndicator(index, animate = true) {
  const nav = document.querySelector(".bottom-nav");
  const items = nav.querySelectorAll(".nav-item");
  const el = items[index];
  if (!el) return;
  const navBox = nav.getBoundingClientRect();
  const box = el.getBoundingClientRect();
  const ind = nav.querySelector(".nav-indicator");
  if (!animate) ind.style.transition = "none";
  ind.style.setProperty("--ind-w", `${box.width}px`);
  ind.style.setProperty("--ind-x", `${box.left - navBox.left}px`);
  if (!animate) requestAnimationFrame(() => (ind.style.transition = ""));
}
addEventListener("resize", () => moveIndicator(current, false));
```

Primary action, links, status, progress (accent places 1, 3, 4, 5/5):

```css
.btn-primary { background: var(--accent-action); color: var(--on-accent); } /* 1/5 */
a { color: var(--accent-text); }                                             /* 3/5 */
.status-hl { color: var(--accent-text); }                                    /* 4/5 */
.progress-bar { background: var(--accent-action); }                          /* 5/5 */
```

## 2. Floating [Stop] [Details] bar (light glass, scroll-reactive)

Second glass tier. Light tint, pinned blur, scroll-linked material ramp
(`float-material` in tokens.css: tint alpha + ±4px parallax, transform and
background-color only). Max one per screen, full mode only, never inside
long feeds. Reduced/lite modes render it as a flat pill (tokens.css).

```css
.float-bar {
  position: fixed;
  left: 50%;
  transform: translateX(-50%);
  bottom: calc(72px + var(--safe-bottom) + 12px); /* clears the 64px nav */
  display: flex;
  gap: var(--sp-2);
  padding: var(--sp-2) var(--sp-3);
  z-index: 20;
}
.float-bar--reactive {
  animation: float-material linear both;
  animation-timeline: scroll();
  animation-range: 0px 200px;
}
/* Mandatory fallbacks: animation-timeline in WebViews is UNVERIFIED. */
@supports not (animation-timeline: scroll()) {
  .float-bar--reactive { animation: none; }
}
@media (prefers-reduced-motion: reduce) {
  .float-bar--reactive { animation: none; }
}
:root[data-perf="reduced"] .float-bar--reactive,
:root[data-perf="lite"] .float-bar--reactive { animation: none; }
```

Rules: amplitude ≤ 8px total (here ±4px); blur never animates; the bar
collapses to `.content-card` flat under `data-flat="1"` (theme.md) and
under `data-perf="lite"` (performance.md).

## 3. Mini App open transition

**Verified: no API lets the page influence the open animation** — the Telegram
client draws it. Never replay "opening" or you get a double animation
(client + page). Keep `body` hidden until ready, then reveal content once.

```css
/* Before ready(): content hidden so it never flashes white */
.app { opacity: 0; }

.app[data-ready="1"] {
  opacity: 1;
  animation: miniapp-open 420ms var(--spring-open) both; /* the only >250 ms enter */
}

@keyframes miniapp-open {
  from { opacity: 0; transform: translate3d(0, 10px, 0) scale(0.985); }
  to   { opacity: 1; transform: translate3d(0, 0,   0) scale(1); }
}

@media (prefers-reduced-motion: reduce) {
  .app[data-ready="1"] { animation: none; }
}
:root[data-perf="lite"] .app[data-ready="1"] {
  animation: fade-in 180ms var(--ease-std) both; /* opacity only, no spring */
}
@keyframes fade-in { from { opacity: 0 } to { opacity: 1 } }
```

```js
const tg = window.Telegram?.WebApp;

function reveal() {
  document.querySelector(".app").dataset.ready = "1";
}

// Skeleton is visible immediately, so ready() can fire early.
tg?.ready();
requestAnimationFrame(reveal);

// If the height has not settled yet, wait for stabilization.
tg?.onEvent("viewportChanged", ({ isStateStable }) => { if (isStateStable) reveal(); });
```

Shift (10px) and scale (0.985) are deliberately small: Telegram already showed
the app "sliding in"; our job is only to avoid the empty-white-screen feeling,
not to replay the transition.
