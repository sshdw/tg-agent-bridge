# Performance — Auto / Full / Lite ladder

Source: R1 §A.7 (official guidance + User-Agent format), R2 §§1.4/3.4/6.2,
Telegram February 2026 blog (Settings > Power Saving pattern).

## 0. `performance_class`: unverified as WebApp API, verified as User-Agent data

Status, exactly as R1 establishes it:

- **NOT a verified `window.Telegram.WebApp` field.** R1 §A.4 tabulates the
  full verified WebApp surface (fields `initData` … `contentSafeAreaInset`,
  methods `ready()` … `openInvoice()`); `performance_class` appears in
  NEITHER the fields table NOR the methods table, and R1 §"Чего НЕТ" warns
  against inventing WebApp members. **Never read
  `Telegram.WebApp.performance_class` — that property is UNVERIFIED and
  must be treated as absent.**
- **VERIFIED as Android User-Agent data.** R1 §A.7 quotes the official
  docs ([Design Guidelines + Additional Data in User-Agent]): Android
  clients append
  `Telegram-Android/{ver} ({manufacturer} {model}; Android {ver}; SDK {n};
  {LOW|AVERAGE|HIGH})`, and Telegram "recommends using this to optimize".
  Parsing it from `navigator.userAgent` is therefore legitimate — but it
  is an **optional enhancement**: present only on Android, absent on
  iOS/desktop, spoofable. Feature-detect before use (never assume the
  match succeeds), and it is only ONE input to Auto (§2), never the whole
  decision.

## 1. The ladder (explicit, testable)

Resolved mode lives in `:root[data-perf]` = `full` | `reduced` | `lite`.

| Auto input | Resolves to | Effect (tokens.css) |
|---|---|---|
| UA class `HIGH`, strong heuristic, no reduced-motion | `full` | full glass: nav 28px, float 20px, sim stack on |
| UA class `AVERAGE`, OR mid heuristic | `reduced` | reduced blur (nav ≤16px, float ≤12px), saturate off, no scroll-linked sim, springs → `--ease-std` |
| UA class `LOW`, OR weak heuristic, OR `prefers-reduced-motion` | `lite` | solid surfaces, no `backdrop-filter`, opacity-only motion ≤150ms |
| Manual `Full effects` | `full` | overrides whatever Auto decided |
| Manual `Lite` | `lite` | overrides whatever Auto decided |

`prefers-reduced-motion: reduce` participates in Auto: it forces at
least `lite` for motion (transforms/springs stripped) even when blur
could stay. Manual `Full` never re-enables motion under
reduced-motion — the manual override covers effects density, not the OS
accessibility signal.

## 2. Auto heuristic (JS-side, no Telegram API needed)

```js
function readTelegramPerfClass() {
  // OPTIONAL enhancement: Android UA tail only. Null on iOS/desktop.
  // UNVERIFIED as a WebApp API — never read it off window.Telegram.WebApp.
  const m = navigator.userAgent.match(/Telegram-Android\/[\d.]+\s+\([^)]*;\s*([^;)]+)\)/);
  const v = m ? m[1].trim().toUpperCase() : null;
  return v === "LOW" || v === "AVERAGE" || v === "HIGH" ? v : null;
}

async function autoPerf() {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return "lite";
  const uaClass = readTelegramPerfClass();
  if (uaClass === "LOW") return "lite";
  if (uaClass === "AVERAGE") return "reduced";

  // JS-side heuristic: memory, cores, pixel cost, measured frame budget.
  let score = 0;
  if ((navigator.deviceMemory ?? 8) <= 4) score += 2;       // GB RAM bucket (project threshold)
  if ((navigator.hardwareConcurrency ?? 8) <= 4) score += 2; // weak CPU (project threshold)
  if ((window.devicePixelRatio ?? 1) >= 3) score += 1;        // blur cost ∝ pixels (project threshold)
  // Measured frame budget: median rAF delta over 30 frames, UNVERIFIED
  // threshold until real-device validation (R2 §7.1) — 24ms is a project
  // constant, not a Telegram value.
  const avgMs = await measureFrameBudget();
  if (avgMs > 24) score += 2;
  if (score >= 3) return "lite";
  if (score >= 1 || uaClass === "AVERAGE") return "reduced";
  return "full";
}

function measureFrameBudget() {
  return new Promise(resolve => {
    const deltas = [];
    let last = performance.now(), n = 0;
    (function tick(t) {
      deltas.push(t - last); last = t;
      if (++n < 30) requestAnimationFrame(tick);
      else { deltas.sort((a, b) => a - b); resolve(deltas[15]); }
    })(last);
  });
}
```

Notes:

- `navigator.deviceMemory` may be absent (iOS, desktop) — `?? 8` treats
  unknown as strong, never as weak. Unknown signals must NEVER push
  toward lite on their own; only measured jank or explicit UA LOW does.
- The frame-budget probe runs once at boot, off the critical path
  (after `ready()`), and re-runs only when the user opens
  More → Performance on Auto. It never runs during scroll.
- Thresholds are project constants, UNVERIFIED on real Telegram
  WebViews until device validation (R2 §7.1) — re-measure, then tighten.

## 3. Manual override: More → Performance

Setting with three options, default **Auto**:

- `Auto` → resolved mode from §2, re-evaluated on each app start.
- `Full effects` → `data-perf="full"`, overrides Auto (except the
  reduced-motion motion cut, see §1).
- `Lite` → `data-perf="lite"`, overrides Auto.

Persist in `Telegram.WebApp.CloudStorage` (primary, roams with the
user) with `localStorage` fallback. Key: `perf_choice` = `auto|full|lite`.

## 4. Applying a mode change without reload flicker

Modes are pure CSS attribute state — no reload, no re-fetch, no flash:

1. Write `document.documentElement.dataset.perf` synchronously in the
   same task as the user gesture (before next paint).
2. All glass/solid variants resolve from the SAME theme tokens
   (`--surface-section` etc.), so the swap changes only blur/alpha —
   layout, colors, and text never shift. No FOUC by construction.
3. Persist the choice (§3) AFTER the paint (async `CloudStorage.setItem`
   or `localStorage`), so storage latency never blocks the switch.
4. On boot, inline the stored choice in `<head>` (before first paint):
   `document.documentElement.dataset.perf = stored || "full"` then let
   Auto correct it once the heuristic resolves — correction only ever
   moves full→reduced→lite (downward), never flashes lite→full content
   in, because solids are the same tokens either way.
