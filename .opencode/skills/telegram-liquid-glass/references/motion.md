# Motion — springs, durations, press feedback, do-not-animate

Distilled from R2 §3. Animate **only `transform` and `opacity`**
(plus `background-color` on hover/press). Never `width`/`height`/`top`/`left`/
`filter`/`box-shadow`/`backdrop-filter` — except the single documented
nav-indicator `width` exception below.

> Spring constants are **project constants, UNVERIFIED against Telegram**
> (closed code) — but the math is checkable: each `linear()` approximates
> `y(t) = 1 − e^(−ζωₙt)(cos ω_d t + (ζωₙ/ω_d) sin ω_d t)` for the stated
> duration and damping ratio ζ. Values > 1 are legal spring overshoot;
> if overshoot feels strong, raise ζ (0.85 → 0.92), never truncate the array.
> `linear()` is Baseline since December 2023, so springs need no JS library
> (gsap ~27 KB, animejs ~40 KB, motion ~48 KB gzip — unjustified here).

## Spring curves (copy-paste)

```css
:root {
  /* Press release: 180 ms, ζ=0.72 — visible but short "bounce" */
  --spring-press:
    linear(0, 0.081, 0.257, 0.458, 0.642, 0.791, 0.9, 0.971,
           1.013, 1.033, 1.038, 1.036, 1.029, 1.021, 1.014);

  /* Card/toast enter: 250 ms, ζ=0.85 — near-critical, no rocking */
  --spring-card:
    linear(0, 0.078, 0.242, 0.424, 0.588, 0.722, 0.823, 0.895,
           0.943, 0.973, 0.991, 1, 1.005, 1.006, 1.006);

  /* Sheet present: 300 ms, ζ=0.90 — critical, no bounce.
   * Dismiss uses --ease-in instead (exits are always plain curves). */
  --spring-sheet:
    linear(0, 0.061, 0.194, 0.347, 0.494, 0.622, 0.726, 0.807,
           0.868, 0.913, 0.944, 0.966, 0.98, 0.99, 0.995, 0.999, 1);

  /* Bottom-nav indicator: 240 ms, ζ=0.82 — light "magnet" spring */
  --spring-nav:
    linear(0, 0.079, 0.246, 0.431, 0.6, 0.737, 0.839, 0.911,
           0.958, 0.986, 1.002, 1.009, 1.011, 1.011, 1.009);

  /* Mini App open: 420 ms, ζ=0.86 — the ONLY long animation */
  --spring-open:
    linear(0, 0.05, 0.163, 0.302, 0.441, 0.568, 0.677, 0.766,
           0.836, 0.889, 0.928, 0.957, 0.976, 0.989, 0.997,
           1.001, 1.004, 1.005, 1.005);

  /* Plain curves for non-spring cases */
  --ease-out:   cubic-bezier(0.22, 0.61, 0.36, 1);   /* fast exit  */
  --ease-in:    cubic-bezier(0.55, 0.06, 0.68, 0.19);  /* dismissal */
  --ease-std:   cubic-bezier(0.4, 0.0, 0.2, 1);        /* state switch */
}
```

## Durations

| Event | Duration | Curve | Why |
|---|---|---|---|
| Button press down (scale/opacity) | 90–120 ms | `--ease-std` | Response must feel instant |
| Button release | 180 ms | `--spring-press` | Springy return is earned on a button |
| Segmented / chip switch | 150 ms | `--ease-std` | State change, no mass — no spring |
| Card / toast enter | 180–250 ms | `--spring-card` | ≤ 250 ms reads as "light and fast" |
| Card exit | 150 ms | `--ease-in` | Exits are always faster than enters |
| Bottom-nav indicator | 240 ms | `--spring-nav` | The one "magnetic" spring in navigation |
| Sheet present | 300 ms | `--spring-sheet` | Layer change earns extra time |
| Sheet dismiss | 300 ms | `--ease-in` | Plain curve on the way out |
| Tab screen switch | 0 ms — instant | — | Frequent interaction, no motion (HIG) |
| Mini App open reveal | 420 ms | `--spring-open` | **Only exception to the ≤ 250 ms rule** |
| Parallax / scroll-linked | scroll-driven, no duration | `animation-timeline` | Duration comes from the scroll |

Rule (Apple HIG Motion): anything the user can trigger repeatedly in one
session (tabs, list rows, buttons) animates minimally or not at all.

## Press feedback

```css
.btn {
  transition:
    transform 180ms var(--spring-press),
    opacity   180ms var(--spring-press);
  will-change: transform; /* NEVER will-change: opacity here if the button
                             contains glass children — backdrop root (D16) */
}
.btn:active {
  transform: scale(0.97);   /* allowed range 0.96–0.98 */
  opacity: 0.88;            /* allowed range 0.85–0.92; opacity shift only
                               for text sitting on glass */
  transition-duration: 90ms;
  transition-timing-function: var(--ease-std);
}
```

Optional: Telegram `HapticFeedback` (`impactOccurred` / `selectionChanged`)
for tactile response where available.

**Spring vs plain curve:** spring when the element physically returns to rest
(button, toggle, indicator, dragged element). Plain curve when the animated
thing has no "mass" (opacity, color, background, content).

## Do-not-animate list

1. **`prefers-reduced-motion: reduce`** — strip transforms and springs, keep
   instant state changes and opacity:
   ```css
   @media (prefers-reduced-motion: reduce) {
     *, *::before, *::after {
       transition-duration: 1ms !important;
       animation-duration: 1ms !important;
       animation-iteration-count: 1 !important;
     }
     .btn:active { transform: none; }
   }
   ```
2. **Weak device (`performance_class` LOW)** — no parallax, blur ≤ 12px
   (see `tokens.css` lite block), no springs (only `--ease-std`), no card
   enter with transform. Opacity-only transitions, 150 ms.
3. **During scroll** — no `enter` animations on feed items; scroll-linked
   effects only, and sparingly.
4. **Long lists (> 20 rows)** — below-the-fold items never animate on appear.
5. **Stagger is banned.** One exception: 3–4 items appearing together after an
   explicit user action (sheet opens → its 3 items). Then
   `animation-delay: calc(var(--i) * 24ms)`, max 3 steps, total ≤ 100 ms.
6. **No infinite loops** — `animation-iteration-count: infinite` is banned
   everywhere in our UI, no exceptions (skeletons: `animation: none` or a
   single 1200 ms pass, max one per group).
7. **Scroll-driven `backdrop-filter` animation is banned by default** (it
   violates the transform/opacity-only rule and doubles frame cost on feeds).
   The scroll-reactive card animates `transform` ±6px and `background-color`
   only; any `blur()` keyframes are a full-mode-only experiment for 1–2
   hero cards — see `components.md`.
