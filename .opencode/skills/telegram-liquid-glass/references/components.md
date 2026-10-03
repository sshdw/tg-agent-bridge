# Components — inventory + three worked implementations

## Inventory (one-line purpose each)

| Component | Purpose | Glass? |
|---|---|---|
| `app-bar` | Section/task heading inside content; never duplicates Telegram's native header | **No** — solid or absent |
| `status-pill` | "Agent online / queue N / limit" compact capsule with state dot | **Yes**, `glass-capsule` |
| `glass-card` | Floating card with key summary (cost, status) | **Yes**, `glass-card` |
| `task-card` | Task row in feed: title, status, time, cost | **No** — `solid-card` (content layer) |
| `progress-bar` | Task/quota progress | **No** — thin bar in `--tg-theme-accent-text-color` |
| `list-row` | List row (files, logs, agents) with icon + secondary text | **No** — `solid-card` |
| `section-header` | List section heading | **No** — typography only |
| `segmented-control` | Same-level filter/tab switcher | **Yes**, `glass-capsule` + glass "thumb" |
| `bottom-nav` | 4 tabs Home · Tasks · Files · More + active indicator | **Yes**, `glass-nav` — the hero element |
| `bottom-sheet` | Modal choice/details sliding from bottom | **Yes**, `glass-elevated` |
| `toast` | Brief notification over content | **Yes**, `glass-elevated`; solid if over a diff |
| `empty-state` | "List is empty" — icon + text + one action | **No** |
| `skeleton` | Loading placeholder blocks, never blinking | **No** — `--tg-theme-hint-color` at 8–12% |

**Readability rule:** glass only where underneath is (a) flat app background or
(b) large smooth blocks. Glass is banned over diff viewer, monospace code, logs,
tables, and anywhere text is ≤ 15px — there use opaque `solid-card` or a 35% scrim.

Icons: SVG sprite or inline SVG, `currentColor`, 24px, `stroke-width: 1.75`,
`stroke-linecap: round`. No icon fonts, no raster PNG.

## 1. Floating bottom nav with animated indicator

One absolutely-positioned indicator moved via `transform` (JS measures real tab
geometry) — cheaper than four highlighted tabs and reads as a "magnet".
`width` on `.nav-indicator` is the **single allowed `width` transition** in the
system (240 ms, same `--spring-nav` curve); everything else is transform/opacity.

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

  background: var(--glass-tint-strong);
  backdrop-filter: blur(var(--blur-3)) saturate(var(--sat-2));
  -webkit-backdrop-filter: blur(var(--blur-3)) saturate(var(--sat-2));
  box-shadow: var(--elev-2), inset 0 0 0 1px var(--hairline-soft);

  z-index: 30;
  overflow: hidden; /* indicator never escapes the rounded edge */
}

/* Specular highlight along the top edge — the glint that sells glass */
.bottom-nav::before {
  content: "";
  position: absolute;
  inset: 0 0 auto 0;
  height: 1px;
  background: linear-gradient(
    90deg,
    rgba(255,255,255,0) 0%,
    rgba(255,255,255,0.20) 25%,
    rgba(255,255,255,0.30) 50%,
    rgba(255,255,255,0.20) 75%,
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
  color: var(--tg-theme-hint-color, var(--text-hint));
  font: var(--fs-caption) / var(--lh-caption) var(--font-sans);
  transition: color 180ms var(--ease-std); /* color only, no transform */
}
.nav-item[aria-selected="true"] {
  color: var(--tg-theme-text-color, var(--text));
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

## 2. Scroll-reactive glass card

Telegram's "refraction as you scroll" reproduced as a static lens frame
(specular edge + hairline ring from `tokens.css`) plus a scroll-linked
micro-shift — no JS, no per-frame cost. Animates **`transform` and
`background-color` only**; `blur` stays pinned (animating `backdrop-filter`
in scroll-driven keyframes is banned by default — see `motion.md`).

```css
@keyframes glass-refract {
  from {
    background-color: rgba(255, 255, 255, 0.06);
    transform: translate3d(0, 6px, 0);
  }
  to {
    background-color: rgba(255, 255, 255, 0.11);
    transform: translate3d(0, -6px, 0);
  }
}

.glass-card--reactive {
  animation: glass-refract linear both;
  animation-timeline: view();
  animation-range: entry 0% exit 100%;
  will-change: auto; /* NEVER will-change: filter/opacity here — backdrop root */
}

/* Mandatory fallbacks: animation-timeline support in target WebViews is
 * UNVERIFIED, so the @supports branch is required, not optional. */
@supports not (animation-timeline: view()) {
  .glass-card--reactive { animation: none; }
}
@media (prefers-reduced-motion: reduce) {
  .glass-card--reactive { animation: none; }
}
:root[data-perf="low"] .glass-card--reactive { animation: none; }
```

Rules: max 1–2 reactive cards per screen, full mode only, never inside long
feeds (20+ rows double the frame cost). Amplitude ≤ 8px (here ±6px).

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
:root[data-perf="low"] .app[data-ready="1"] {
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
