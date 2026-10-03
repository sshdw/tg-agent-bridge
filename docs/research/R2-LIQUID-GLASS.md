# R2 — Liquid Glass: исследовательская база для дизайн-скилла Mini App

Документ-исследование для `tg-agent-bridge`. Задача: превратить «выглядеть и двигаться как
современный Telegram / iOS 26 Liquid Glass» в набор значений, которые напрямую ложатся в CSS
и небольшой JS. Ничего из перечисленного не является иллюстрацией — это спецификация.

Правила оформления: проза по-русски, CSS/идентификаторы/имена спецификаций — по-английски.
Каждое утверждение о дизайне Apple или Telegram снабжено ссылкой; выводы из скриншотов и видео
помечены как **INFERENCE**, неподтверждённые детали — как **UNVERIFIED**. Полная таблица
источников — в разделе 7.

---

## 1. Что такое Liquid Glass на самом деле

### 1.1 Официальное ядро (проверяемо)

Ключевой источник — [Apple HIG: Materials](https://developer.apple.com/design/human-interface-guidelines/materials).
Цитаты и следствия из него:

- **Два типа материалов.** «Apple platforms feature two types of materials: Liquid Glass, and
  standard materials». Liquid Glass — динамический материал, «allowing you to present controls
  and navigation without obscuring underlying content». Standard materials отвечают за
  визуальную дифференциацию **внутри** контентного слоя.
- **Liquid Glass — это функциональный слой, а не контентный.** «Liquid Glass forms a distinct
  functional layer for controls and navigation elements — like tab bars and sidebars — that
  floats above the content layer». Контент может «scroll and peek through from beneath these
  elements».
- **Прямой запрет на стекло в контентном слое.** «Don't use Liquid Glass in the content layer.»
  Исключение — транзиентные интерактивные элементы (sliders, toggles), которые «take on a
  Liquid Glass appearance to emphasize their interactivity».
- **Умеренность — прямое требование.** «Use Liquid Glass effects sparingly… Limit these
  effects to the most important functional elements in your app.»
- **Два варианта: `regular` и `clear`.**
  - `regular`: «blurs and adjusts the luminosity of background content to maintain legibility»,
    плюс **scroll edge effects** — «blurring and reducing the opacity of background content».
    Используется, когда под элементом может быть нечитаемый фон или много текста (alerts,
    sidebars, popovers). Большинство системных компонентов.
  - `clear`: «highly translucent», для плавающих над медиа-фоном элементов. Если под ним
    **яркий** контент — Apple прямо предписывает «adding a dark dimming layer of **35%**
    opacity». Это конкретное число из HIG, его можно использовать буквально.
- **Standard materials по толщине:** `ultraThin`, `thin`, `regular`, `thick`. Vibrancy-уровни
  для labels: `label` (default) / `secondaryLabel` / `tertiaryLabel` / `quaternaryLabel`;
  для fills: `fill` / `secondaryFill` / `tertiaryFill`.
- **Поведение адаптивно к системным настройкам.** «The appearance of these variants can differ
  in response to certain system settings, like if people choose a preferred look for Liquid
  Glass in their device's settings, or turn on accessibility settings that reduce transparency
  or increase contrast» — то есть «Reduce Transparency» ломает материал нативно.

Цвет — [Apple HIG: Color, раздел «Liquid Glass color»](https://developer.apple.com/design/human-interface-guidelines/color):

- «By default, Liquid Glass has no inherent color, and instead takes on colors from the content
  directly behind it.»
- Мелкие элементы (toolbars, tab bars) система сама переключает между светлым и тёмным
  вариантом по контенту под ними; символы и текст следуют за этим переключением
  (монохромная схема).
- «Liquid Glass appears **more opaque in larger elements** like sidebars to preserve legibility».
  Прямое указание на обратную зависимость прозрачности от площади элемента.
- Цвет применять скупо: «reserve it for elements that truly benefit from emphasis, such as
  status indicators or primary actions. To emphasize primary actions, apply color to the
  **background** rather than to symbols or text… Refrain from adding color to the background
  of multiple controls.»

Детали реализации — [Adopting Liquid Glass](https://developer.apple.com/documentation/technologyoverviews/adopting-liquid-glass)
и [Applying Liquid Glass to custom views](https://developer.apple.com/documentation/swiftui/applying-liquid-glass-to-custom-views):

- Системные компоненты (bars, sheets, popovers, controls) подхватывают материал сами.
  Кастомные фоны в `NavigationStack` / `NavigationSplitView` / `toolbar` / `titleBar` могут
  «overlay or interfere with Liquid Glass or other effects… such as the scroll edge effect».
- API: `glassEffect(_:in:)`, `glassEffectID`, `glassEffectTransition`, `glassEffectUnion`,
  `interactive(Bool)`, `GlassEffectContainer(spacing:)`, `GlassEffectTransition`,
  `GlassButtonStyle`, `GlassProminentButtonStyle`, `DefaultGlassEffectShape`.
- **Производительность:** «Combine custom Liquid Glass effects to improve rendering
  performance… make sure to combine them using a `GlassEffectContainer`». То есть система
  сама подсказывает: несколько стеклянных элементов нужно объединять в один контейнер, иначе
  каждый рендерится независимо. Прямой аналог на вебе — не навешивать `backdrop-filter` на
  десятки элементов списка.
- Концентричность форм: `rect(corners:isUniform:)`, `ConcentricRectangle` — вложенные
  скруглённые элементы должны иметь концентрические радиусы.
- Полупрозрачные half sheets при раскрытии «transition to a more opaque appearance to help
  maintain focus on the task».

Motion — [Apple HIG: Motion](https://developer.apple.com/design/human-interface-guidelines/motion):

- «Aim for brevity and precision in feedback animations. When animated feedback is brief and
  precise, it tends to feel lightweight and unobtrusive».
- «In apps, generally **avoid adding motion to UI interactions that occur frequently**. The
  system already provides subtle animations for interactions with standard interface elements.»
  Это ровно то, чего хочет владелец: частые взаимодействия не анимировать сверх системного.
- «Let people cancel motion… don't make people wait for an animation to complete».
- Реакция материала зависит от типа ввода: «the movement of Liquid Glass responds to direct
  touch interaction with greater emphasis… but produces a more subdued effect when a person
  interacts using a trackpad». На мобильном это автоматически даёт более выраженный отклик.

Типографика — [Apple HIG: Typography](https://developer.apple.com/design/human-interface-guidelines/typography):

- iOS/iPadOS: **default size 17 pt, minimum 11 pt**.
- «avoid light font weights… prefer Regular, Medium, Semibold, or Bold, and avoid Ultralight,
  Thin, and Light».
- Системные шрифты: SF Pro / SF Pro Text; SF Pro поддерживает optical sizing (динамические
  optical sizes). Размеры в pt ≈ px при 1× и совпадают с нашими px-значениями на телефоне.

### 1.2 Telegram: что проверяемо

Официальная документация Mini Apps — [core.telegram.org/bots/webapps](https://core.telegram.org/bots/webapps).
Раздел «Design Guidelines» дословно:

> Telegram apps are known for being snappy, smooth and following a consistent cross-platform
> design. Your Mini App should ideally reflect these principles.
> - All elements should be responsive and designed with a mobile-first approach.
> - Interactive elements should mimic the style, behavior, and intent of UI components that already exist.
> - All included animations should be smooth, ideally 60fps.
> - All inputs and images should contain labels for accessibility purposes.
> - The app should deliver a seamless experience by monitoring the dynamic theme-based colors provided by the API and using them accordingly.
> - Ensure that the app's interface respects the safe area and content safe area…
> - For Android devices, consider the additional information in the User-Agent… adjust for the device's performance class, minimizing animations and visual effects on low-performance devices.

Последний пункт — это **прямое разрешение Telegram использовать performance class для
деградации эффектов**, а не только рекомендация. Механизм описан там же: в User-Agent на
Android добавляется хвост
`Telegram-Android/{app_version} ({manufacturer} {model}; Android {android_version}; SDK {sdk_version}; {performance_class})`,
где `performance_class` — `LOW`, `AVERAGE` или `HIGH`.

Официальные блог-посты Telegram:

- [11 октября 2025 — «Liquid Glass for iOS 26»](https://telegram.org/blog/comments-in-video-chats-threads-for-bots):
  «Telegram for iOS now features an updated Liquid Glass interface to match iOS 26. The bottom
  navigation bar, keyboard, sticker panel, and more all feature **transparent elements with a
  satisfying refraction effect as you scroll**. We’ll keep updating the app’s design in step with
  Apple’s evolving iOS 26 standards.»
- [3 января 2026 — «AI Summaries, New Design and More»](https://telegram.org/blog/new-design-ai-summaries):
  «Telegram’s first update of 2026 brings **even more Liquid Glass interfaces** on iOS».
- [9 февраля 2026 — «Android Redesign…»](https://telegram.org/blog/crafting-android-design-and-more):
  «The new **bottom bar** lets you easily jump between your chats, settings, profile and more in
  just one tap… Telegram developers **completely rebuilt** the interface code… **You can
  control interface effects to maximize performance and extend battery life in Settings >
  Power Saving.**»

Последняя цитата — самая важная для нас: **сам Telegram** вынес «отключение эффектов
интерфейса» в настройки энергосбережения. Значит набор переключателей «полный / lite /
выкл» — не наша выдумка, а паттерн, который владелец уже видел в самом Telegram.

Стороннее подтверждение (не официальный источник, но полезно как контекст):
[9to5Mac, 13 октября 2025](https://9to5mac.com/2025/10/13/telegram-adopts-a-liquid-glass-like-design-no-ios-26-required/)
— «Telegram adopts a Liquid Glass-**like** design, **no iOS 26 required**», то есть Telegram
реализовал эффект собственными средствами, а не только через нативные API iOS 26.

### 1.3 Что НЕ проверяемо, а выведено (INFERENCE / UNVERIFIED)

Честная граница. Всё перечисленное ниже — вывод из скриншотов, видео и текстовых описаний,
а не из спецификаций. Использовать как **дизайн-таргет**, не как цитату.

| Утверждение | Статус |
|---|---|
| Точные числовые параметры blur/alpha в нативном Liquid Glass Apple | **UNVERIFIED** — Apple их не публикует. Все числа ниже — наши проектные значения, подобранные под HIG-принципы, а не измеренные в iOS. |
| Точный радиус таббара Telegram, точная толщина его верхней highlight-полосы | **UNVERIFIED** — по скриншотам выглядит как сплошная «пилюля» с заметным верхним бликом и мягкой тенью; конкретные px снять неоткуда. |
| Поведение Telegram на старых iOS (где нет нативного Liquid Glass) | По [9to5Mac](https://9to5mac.com/2025/10/13/telegram-adopts-a-liquid-glass-like-design-no-ios-26-required/) — собственный аналог, работает везде. Точный порог версии **UNVERIFIED**. |
| Что именно «refraction effect as you scroll» означает технически в Telegram | **UNVERIFIED**. Судя по описанию, это статичная деформация/смещение контента у кромки панели, а не динамический per-frame refraction. Для веба воспроизводится приближением из §2.4. |
| Реальные spring-константы в анимациях Telegram | **UNVERIFIED** — закрытый код. Наши значения в §3 — проектные, рассчитаны аналитически. |
| Существует ли API, позволяющий веб-странице Mini App повлиять на анимацию открытия | **Проверено отрицательно**: в [core.telegram.org/bots/webapps](https://core.telegram.org/bots/webapps) такого метода нет. Открытие/закрытие анимирует клиент. См. §6.3. |
| `prefers-reduced-transparency` в Telegram WebView | **UNVERIFIED** — медиафункция существует в спецификации (см. §2.3), но её проброс в WebView Telegram не задокументирован. Поэтому стратегия деградации строится на трёх независимых сигналах. |

### 1.4 Вывод для нашего приложения

Три правила, которые следуют из источников и которые надо зафиксировать в скилле:

1. **Стекло — только функциональный слой.** App bar, bottom nav, sheets, floating-контролы.
   Карточки задач в ленте — стандартный материал, не Liquid Glass. Это прямое требование HIG
   («Don't use Liquid Glass in the content layer») и заодно решает вопрос производительности.
2. **Прозрачность обратно пропорциональна ответственности.** Чем больше площадь элемента и
   чем больше текста внутри, тем выше непрозрачность заливки и/или тем сильнее scrim.
   Это прямое следствие «Liquid Glass appears more opaque in larger elements» и рекомендации
   про 35% dimming layer.
3. **Деградация — не опция, а функция.** Telegram отдаёт `performance_class` и требует
   учитывать его; Apple требует учитывать Reduce Transparency / Reduce Motion; Telegram сам
   даёт пользователю тумблер эффектов. Значит `lite mode` — ожидаемая функция, а не
   украшение.

---

## 2. Материальная спецификация

Все токены — CSS custom properties в `:root`. Значения по умолчанию заданы для тёмной темы
(она дефолтная для большинства Telegram-пользователей), светлая тема переопределяет их ниже.

### 2.1 Базовые токены

```css
:root {
  /* ---- Telegram theme passthrough (все есть как CSS-переменные в WebView) ---- */
  /* --tg-theme-bg-color, --tg-theme-text-color, --tg-theme-hint-color,
     --tg-theme-link-color, --tg-theme-button-color, --tg-theme-button-text-color,
     --tg-theme-secondary-bg-color, --tg-theme-header-bg-color,
     --tg-theme-bottom-bar-bg-color, --tg-theme-accent-text-color,
     --tg-theme-section-bg-color, --tg-theme-section-header-text-color,
     --tg-theme-section-separator-color, --tg-theme-subtitle-text-color,
     --tg-theme-destructive-text-color, --tg-color-scheme */

  /* ---- Fallback palette: используется только если themeParams пуст (страховка) ---- */
  --bg:            #17212b;   /* близко к Telegram dark bg */
  --bg-secondary:  #0e1621;
  --text:          #f5f6f7;
  --text-hint:     #8d9aa8;
  --accent:        #6ab3f3;

  /* ---- Типографика (Apple HIG: iOS default 17pt / min 11pt) ---- */
  --font-sans: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI",
               system-ui, Roboto, "Helvetica Neue", Arial, sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas,
               "Liberation Mono", monospace;

  --fs-display: 28px;  --lh-display: 32px;  --fw-display: 700;
  --fs-title:   20px;  --lh-title:   24px;  --fw-title:   600;
  --fs-body:    17px;  --lh-body:    22px;  --fw-body:    400;
  --fs-sub:     15px;  --lh-sub:     20px;  --fw-sub:     400;
  --fs-caption: 13px;  --lh-caption: 16px;  --fw-caption: 400;

  /* ---- Spacing scale (4px base) ---- */
  --sp-1: 4px;  --sp-2: 8px;  --sp-3: 12px; --sp-4: 16px;
  --sp-5: 20px; --sp-6: 24px; --sp-8: 32px; --sp-10: 40px;

  /* ---- Radius scale ---- */
  --r-xs: 8px; --r-sm: 12px; --r-md: 16px; --r-lg: 20px; --r-xl: 28px; --r-pill: 999px;

  /* ---- Border alpha ---- */
  --hairline:      rgba(255, 255, 255, 0.14);
  --hairline-soft: rgba(255, 255, 255, 0.08);
  --hairline-dark: rgba(0, 0, 0, 0.10);

  /* ---- Elevation: два уровня, без «3D» ---- */
  --elev-1:
      0 1px 2px rgba(0, 0, 0, 0.18),
      0 4px 16px rgba(0, 0, 0, 0.14);
  --elev-2:
      0 2px 6px rgba(0, 0, 0, 0.22),
      0 12px 32px rgba(0, 0, 0, 0.20);

  /* ---- Контентный слой: НЕ стекло (Apple HIG) ---- */
  --surface-solid:   var(--tg-theme-bg-color, var(--bg));
  --surface-section: var(--tg-theme-section-bg-color, var(--bg-secondary));

  /* ---- Стеклянный слой ---- */
  --glass-tint:        rgba(255, 255, 255, 0.06);
  --glass-tint-strong: rgba(255, 255, 255, 0.10);
  --glass-scrim:       rgba(14, 22, 33, 0.35); /* = HIG «dark dimming layer 35%» */

  --blur-1: 12px;  /* capsule, мелкие контролы */
  --blur-2: 20px;  /* карточка */
  --blur-3: 28px;  /* bottom nav, sheet */

  --sat-1: 160%;
  --sat-2: 180%;

  /* ---- Safe area: tg-переменные + env как страховка ---- */
  --safe-top:    max(env(safe-area-inset-top, 0px),    var(--tg-content-safe-area-inset-top, 0px));
  --safe-bottom: max(env(safe-area-inset-bottom, 0px), var(--tg-content-safe-area-inset-bottom, 0px));
  --safe-left:   max(env(safe-area-inset-left, 0px),   var(--tg-content-safe-area-inset-left, 0px));
  --safe-right:  max(env(safe-area-inset-right, 0px),  var(--tg-content-safe-area-inset-right, 0px));
}
```

Почему `max()`: в Mini App есть **две независимые** системы отступов. `safeAreaInset` /
`--tg-safe-area-inset-*` — системный UI устройства (вырез, home indicator, системная навигация).
`contentSafeAreaInset` / `--tg-content-safe-area-inset-*` — Telegram-овский UI (его шапка,
нижние нативные кнопки). Обе пары задокументированы в
[core.telegram.org/bots/webapps#safeareainset](https://core.telegram.org/bots/webapps#safeareainset)
и `#contentsafeareainset`. Берём максимум, чтобы не получить двойной отступ там, где обе
системы совпадают, и нулевой там, где Telegram отдаёт 0, а iOS — нет.

### 2.2 Слоистые фоны: готовая палитра

Один материал = три слоя: `rgba`-заливка → `backdrop-filter` → hairline-бордер + верхний
highlight. Дальше — четыре готовых варианта.

```css
/* ---------- (0) Фон приложения: непрозрачный, НЕ стекло ---------- */
.app-bg {
  background: var(--surface-solid);
}

/* ---------- (1) Плавающая карточка (основной рабочий элемент) ---------- */
.glass-card {
  position: relative;
  border-radius: var(--r-lg);
  background: var(--glass-tint);
  backdrop-filter: blur(var(--blur-2)) saturate(var(--sat-1));
  -webkit-backdrop-filter: blur(var(--blur-2)) saturate(var(--sat-1));
  box-shadow: var(--elev-1), inset 0 0 0 1px var(--hairline-soft);
}
/* верхний highlight — тонкая светлая полоса с растушёвкой */
.glass-card::before {
  content: "";
  position: absolute;
  inset: 0 0 auto 0;
  height: 1px;
  border-radius: inherit;
  background: linear-gradient(
    90deg,
    rgba(255, 255, 255, 0.00) 0%,
    rgba(255, 255, 255, 0.22) 22%,
    rgba(255, 255, 255, 0.28) 50%,
    rgba(255, 255, 255, 0.22) 78%,
    rgba(255, 255, 255, 0.00) 100%
  );
  pointer-events: none;
}

/* ---------- (2) Elevated / prominent: sheets, модалки, активные состояния ---------- */
.glass-elevated {
  border-radius: var(--r-xl);
  background:
    var(--glass-scrim),                 /* HIG: 35% dimming под прозрачным */
    var(--glass-tint-strong);
  backdrop-filter: blur(var(--blur-3)) saturate(var(--sat-2));
  -webkit-backdrop-filter: blur(var(--blur-3)) saturate(var(--sat-2));
  box-shadow: var(--elev-2), inset 0 0 0 1px var(--hairline);
}

/* ---------- (3) Bottom navigation: самый функциональный элемент ---------- */
.glass-nav {
  border-radius: var(--r-xl);
  background: var(--glass-tint-strong);
  backdrop-filter: blur(var(--blur-3)) saturate(var(--sat-2));
  -webkit-backdrop-filter: blur(var(--blur-3)) saturate(var(--sat-2));
  box-shadow: var(--elev-2), inset 0 0 0 1px var(--hairline-soft);
}

/* ---------- (4) Capsule: переключатели, чипы, pill-кнопки ---------- */
.glass-capsule {
  border-radius: var(--r-pill);
  background: var(--glass-tint);
  backdrop-filter: blur(var(--blur-1)) saturate(var(--sat-1));
  -webkit-backdrop-filter: blur(var(--blur-1)) saturate(var(--sat-1));
  box-shadow: inset 0 0 0 1px var(--hairline-soft);
}

/* ---------- (5) Solid fallback: когда стекло отключено (lite / нет поддержки) ---------- */
.solid-card {
  border-radius: var(--r-lg);
  background: color-mix(in srgb, var(--surface-section) 88%, var(--surface-solid));
  box-shadow: inset 0 0 0 1px var(--hairline-soft);
}
```

`color-mix()` — Baseline widely available с мая 2023 ([MDN](https://developer.mozilla.org/en-US/docs/Web/CSS/color_value/color-mix)),
пространство по умолчанию `oklab`. Годится для смешивания темы с чёрнотой/белой без
жёстко зашитых hex.

Светлая тема — переопределение, а не отдельная палитра. Значения подставляются из
`themeParams`, поэтому на кастомной теме Telegram «near-white on near-white» разбирается в §2.6.

```css
@media (prefers-color-scheme: light) {
  :root {
    --glass-tint:        rgba(255, 255, 255, 0.55);
    --glass-tint-strong: rgba(255, 255, 255, 0.72);
    --glass-scrim:       rgba(0, 0, 0, 0.35);
    --hairline:          rgba(0, 0, 0, 0.10);
    --hairline-soft:     rgba(0, 0, 0, 0.06);
    --elev-1: 0 1px 2px rgba(16, 24, 34, 0.10), 0 4px 16px rgba(16, 24, 34, 0.08);
    --elev-2: 0 2px 6px rgba(16, 24, 34, 0.14), 0 12px 32px rgba(16, 24, 34, 0.12);
  }
}
/* Telegram — источник истины, а не prefers-color-scheme */
:root[data-scheme="light"] { /* те же значения, что выше */ }
```

### 2.3 Что безопасно в `backdrop-filter`, а что нет

Факты, а не вкусовщина:

- **`backdrop-filter` поддерживается везде с сентября 2024** (Baseline 2024, «newly
  available») — [MDN](https://developer.mozilla.org/en-US/docs/Web/CSS/backdrop-filter).
  В 2026 году префикс `-webkit-` избыточен для современных iOS, но оставлен в коде
  для старых WebView — это страховка, а не необходимость.
- **Backdrop root — главная ловушка.** По спецификации backdrop root создают: корень
  документа; элемент с `filter` ≠ `none`; элемент с `opacity` < 1; элемент с `mask`,
  `mask-image`, `mask-border` или `clip-path` ≠ `none`; элемент с `backdrop-filter` ≠ `none`;
  элемент с `mix-blend-mode` ≠ `normal`; `will-change` с любым из перечисленного. Внутри
  backdrop root фильтр блюрит **только содержимое между этим элементом и потомком** —
  фон страницы не блюрится, эффект выглядит сломанным. Практический вывод: **никогда**
  не вешать `opacity: 0.99` или `filter: blur(0)` на общий контейнер карточек/скролл-область,
  если внутри есть элементы со стеклом.
- **`hue-rotate` в стекле — плохая идея.** Он крутит тон всего, что видно сквозь панель,
  включая текст под ней, и визуально ломает тему Telegram. Не используется.
- **`saturate` — полезен и дешёв.** Поднимает насыщенность того, что видно сквозь стекло;
  на скриншотах Apple-систем это читается как «стекло не выцвело». Один фильтр поверх
  `blur` — безопасно.
- **`brightness`/`contrast` — по вкусу**, но осторожно: они меняют контраст текста под
  панелью. Рекомендуется не трогать.
- **WebKit прямо предупреждает о стоимости**: «the nature of this backdrop effect forces the
  engine to perform more rendering passes, which will have an impact on performance. Make sure
  you only use this feature where it is most necessary» —
  [WebKit, Introducing Backdrop Filters](https://webkit.org/blog/3632/introducing-backdrop-filters/).
- **`filter: url()` с SVG-фильтром** технически разрешён в `backdrop-filter`
  (`backdrop-filter = url("filters.svg#filter") blur(4px) saturate(150%)` — формальный синтаксис
  в [MDN](https://developer.mozilla.org/en-US/docs/Web/CSS/backdrop-filter)). См. §2.4.

**Правило для скилла:** стеклянный фильтр — ровно `blur()` + опционально `saturate()`.
Не больше двух функций. Никаких `hue-rotate`, `invert`, `sepia`, `grayscale` на элементах,
за которыми может быть контент.

### 2.4 Рефракция: что реально, а что нет

**Прямо и честно: настоящей рефракции (смещения пикселей по краю элемента, как у стекла)
на вебе сегодня нет.** Нет CSS-свойства «преломить фон». Что есть:

| Техника | Что делает | Цена | Вердикт |
|---|---|---|---|
| `backdrop-filter: blur() saturate()` | Размытие + насыщенность фона | Дёшево, аппаратно | **Базовый слой. Использовать всегда.** |
| `backdrop-filter: url(#svgFilter)` с `feDisplacementMap` + `feImage`/`feTurbulence` | Смещение пикселей по карте смещений | Дорого: не аппаратный путь, software-фильтр, полная перерисовка области каждый кадр при скролле | **Нет для продакшена.** Годится только для статичной демонстрации. `feDisplacementMap` — Baseline widely available с июля 2015 ([MDN](https://developer.mozilla.org/en-US/docs/Web/SVG/Reference/Element/feDisplacementMap)), но это не про производительность. |
| `filter: url()` на самом элементе (не фоне) | Искажает сам элемент вместе с текстом | Так же дорого + ломает текст | **Нет.** |
| `border-radius` + `mask` + тонкий `box-shadow` inset | Имитация «линзы» на кромке | Бесплатно | **Да. Это и есть наш «refraction».** |

Telegram описывает свой эффект как «refraction effect **as you scroll**» — то есть деформация
привязана к позиции скролла, а не к пиксельной карте смещений. Это подсказывает правильную
дешёвую имитацию: **refraction = статичная рамка, которая ведёт себя как линза (highlight +
hairline + тень), плюс очень слабая реакция на скролл** (см. §6.2).

**Лучшее убедительное приближение — «specular edge + hairline ring», а не искажение пикселей:**

```css
/* Верхняя кромка: тонкий светлый specular highlight (это «блик», который
   продаёт стекло в реальности), плюс hairline по всему периметру */
.glass-card::after {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: inherit;
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.18),   /* specular, верх */
    inset 0 -1px 0 rgba(255, 255, 255, 0.04),  /* слабый отражённый свет, низ */
    inset 0 0 0 1px rgba(255, 255, 255, 0.08); /* hairline ring */
  pointer-events: none;
}

/* «Линза»: лёгкое сжатие по краям через inset-shadow, имитирует загиб */
.glass-nav {
  --lens: 24px;
  box-shadow:
    var(--elev-2),
    inset 0 0 0 1px var(--hairline-soft),
    inset 0 calc(var(--lens) / 2) calc(var(--lens) / 2) -12px rgba(255, 255, 255, 0.05);
}
```

Итог: **реальный refraction — нет; convincing approximation — specular edge + hairline ring +
scroll-linked микросдвиг (§6.2).** Это честнее и на 60 FPS, чем `feDisplacementMap`.

### 2.5 Типографика

```css
body {
  font-family: var(--font-sans);
  font-size: var(--fs-body);
  line-height: var(--lh-body);
  color: var(--tg-theme-text-color, var(--text));
  /* -apple-system / SF Pro внутри Telegram на iOS: WKWebView отдаёт системный
     шрифт; на Android — Roboto через system-ui. Мы не грузим свои веб-шрифты. */
  -webkit-font-smoothing: antialiased;
  -webkit-text-size-adjust: 100%;
  text-rendering: optimizeLegibility;
}

/* Заголовки — без лёгких весов (Apple HIG) */
.h-display { font-size: var(--fs-display); line-height: var(--lh-display); font-weight: var(--fw-display); letter-spacing: -0.02em; }
.h-title   { font-size: var(--fs-title);   line-height: var(--lh-title);   font-weight: var(--fw-title);   letter-spacing: -0.01em; }
.h-sub     { font-size: var(--fs-sub);     line-height: var(--lh-sub);     font-weight: var(--fw-sub); }
.h-caption { font-size: var(--fs-caption); line-height: var(--lh-caption); font-weight: var(--fw-caption); color: var(--tg-theme-hint-color, var(--text-hint)); }
```

**Табличные цифры для cost/time — обязательны.** Стоимость, время выполнения, размер файла
должны не «прыгать» при обновлении:

```css
.metric {
  font-variant-numeric: tabular-nums;
  font-feature-settings: "tnum" 1, "lnum" 1;
  letter-spacing: -0.01em;
}
/* Моноширинный код и диффы — фиксированная ширина, никакого стекла */
.mono {
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  background: var(--surface-section);
  border-radius: var(--r-sm);
}
```

Почему моноширинный: цифры в `SF Mono`/`Roboto Mono` уже моноширинные, но `tabular-nums`
гарантирует одинаковую ширину и для системных sans. И **никогда** стекло на `.mono` — см. §5.

### 2.6 Светлое/тёмное и near-white на near-white

Три источника темы, в порядке приоритета:

1. `Telegram.WebApp.themeParams` → CSS-переменные `--tg-theme-*`. Это **единственный
   правильный** источник: он отражает и кастомные темы пользователя, и `colorScheme`
   (`--tg-color-scheme`). Telegram требует именно этого: «monitoring the dynamic theme-based
   colors provided by the API and using them accordingly».
2. `prefers-color-scheme` — только fallback, если `themeParams` пуст.
3. Хардкод-палитра (`--bg`, `--accent`) — последний fallback, чтобы UI не развалился до
   `ready()`.

Подписка на смену темы обязательна — тема может переключиться, пока Mini App открыта:

```js
const tg = window.Telegram?.WebApp;
tg?.onEvent("themeChanged", () => {
  document.documentElement.dataset.scheme = tg.colorScheme; // "light" | "dark"
  readMetricTokens(); // см. ниже
});
document.documentElement.dataset.scheme = tg?.colorScheme ?? "dark";
```

**Проблема near-white на near-white.** Telegram-тема может дать `bg_color: #FFFFFF`,
`section_bg_color: #F7F7F7`, `hint_color: #C8C8C8`. Тогда стеклянная карточка над белым
фоном неотличима от фона, а hint-текст нечитаем. Решение — **вычислять относительную
яркость темы и поднимать alpha заливки + включать scrim**, а не угадывать:

```js
// sRGB relative luminance (WCAG). Возвращает 0..1
function relLum(hex) {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

// Вызывается на старте и на themeChanged
function readMetricTokens() {
  const tp = window.Telegram?.WebApp?.themeParams ?? {};
  const bg  = tp.bg_color  || "#17212b";
  const sec = tp.section_bg_color || tp.secondary_bg_color || bg;
  const isLight = relLum(bg) > 0.45;
  const lowContrastBg = relLum(sec) > 0.90;      // near-white на white

  const root = document.documentElement;
  root.style.setProperty("--metric-bg", bg);
  root.style.setProperty("--metric-sec", sec);
  root.style.setProperty("--metric-hint", tp.hint_color || (isLight ? "#707579" : "#8d9aa8"));

  // Адаптируем плотность стекла к теме
  if (isLight) {
    root.style.setProperty("--glass-tint", lowContrastBg ? "rgba(255,255,255,0.85)" : "rgba(255,255,255,0.55)");
    root.style.setProperty("--glass-tint-strong", lowContrastBg ? "rgba(255,255,255,0.94)" : "rgba(255,255,255,0.72)");
  } else {
    root.style.setProperty("--glass-tint", lowContrastBg ? "rgba(0,0,0,0.45)" : "rgba(255,255,255,0.06)");
  }

  // Контраст hint-текста: если не хватает — подменяем на text_color с opacity
  const tl = relLum(tp.text_color || "#ffffff");
  const hl = relLum(root.style.getPropertyValue("--metric-hint") || "#8d9aa8");
  const contrast = (Math.max(tl, hl) + 0.05) / (Math.min(tl, hl) + 0.05);
  root.style.setProperty("--metric-hint-ok", contrast >= 4.5 ? "1" : "0");
}
```

Правило: **если рассчитанный контраст < 4.5:1, hint-текст не используется — берётся
`text_color` с opacity 0.72 и увеличенный вес.** Контрастные требования — в §5.

Дополнительно: стекло над контентом в светлой теме почти всегда требует scrim, ровно как
предписывает HIG для варианта `clear` над ярким контентом. Отсюда же «35% opacity».

---

## 3. Motion-спецификация

Фильтры из §2.3 (`blur` + `saturate`) и трансформы — **всегда на композиторе**
(`transform`/`opacity`), никогда не на `width`/`height`/`top`/`filter`.

### 3.1 Кривые

`linear()` — Baseline widely available с декабря 2023 ([MDN](https://developer.mozilla.org/en-US/docs/Web/CSS/easing-function/linear)),
поэтому можно использовать пружины без JS-библиотеки. Значения ниже рассчитаны аналитически
из формы `y(t) = 1 − e^(−ζωₙt)(cos ω_d t + (ζωₙ/ω_d) sin ω_d t)` при заданных
`duration` и `ζ` (коэффициент затухания); это проектные константы, а не измеренные
константы Telegram (**UNVERIFIED** относительно Telegram, но математика проверяема).

```css
:root {
  /* Нажатие: 180 мс, ζ=0.72 — заметный, но короткий «отскок» */
  --spring-press:
    linear(0, 0.081, 0.257, 0.458, 0.642, 0.791, 0.9, 0.971,
           1.013, 1.033, 1.038, 1.036, 1.029, 1.021, 1.014);

  /* Появление/уход карточки: 260 мс, ζ=0.85 — почти критическое, без раскачки */
  --spring-card:
    linear(0, 0.078, 0.242, 0.424, 0.588, 0.722, 0.823, 0.895,
           0.943, 0.973, 0.991, 1, 1.005, 1.006, 1.006);

  /* Sheet present/dismiss: 300 мс, ζ=0.90 — критическое, без отскока */
  --spring-sheet:
    linear(0, 0.061, 0.194, 0.347, 0.494, 0.622, 0.726, 0.807,
           0.868, 0.913, 0.944, 0.966, 0.98, 0.99, 0.995, 0.999, 1);

  /* Индикатор bottom nav: 240 мс, ζ=0.82 — лёгкая «пружина», читается как магнит */
  --spring-nav:
    linear(0, 0.079, 0.246, 0.431, 0.6, 0.737, 0.839, 0.911,
           0.958, 0.986, 1.002, 1.009, 1.011, 1.011, 1.009);

  /* Открытие Mini App: 420 мс, ζ=0.86 — единственная длинная анимация */
  --spring-open:
    linear(0, 0.05, 0.163, 0.302, 0.441, 0.568, 0.677, 0.766,
           0.836, 0.889, 0.928, 0.957, 0.976, 0.989, 0.997,
           1.001, 1.004, 1.005, 1.005);

  /* Простые кривые для не-пружинных случаев */
  --ease-out:   cubic-bezier(0.22, 0.61, 0.36, 1);   /* быстрый выход */
  --ease-in:    cubic-bezier(0.55, 0.06, 0.68, 0.19);  /* уход */
  --ease-std:   cubic-bezier(0.4, 0.0, 0.2, 1);        /* переключение состояний */
}
```

Значения > 1 в `linear()` — легальный overshoot пружины; если эффект кажется избыточным,
поднять ζ (0.85→0.92), а не обрезать массив.

### 3.2 Длительности

| Событие | Длительность | Кривая | Почему так |
|---|---|---|---|
| Нажатие кнопки (scale/opacity) | 90–120 мс вниз, 180 мс вверх | `--ease-std` вниз, `--spring-press` вверх | Отклик должен ощущаться мгновенным; «пружинящий возврат» оправдан на кнопке. |
| Переключение segmented / чипа | 150 мс | `--ease-std` | Без пружины: это смена состояния, а не физическое событие. |
| Появление карточки/тоста | 180–260 мс | `--spring-card` | До 250 мс — «легко», читается как быстрое. |
| Уход карточки | 150 мс | `--ease-in` | Уход всегда быстрее прихода. |
| Индикатор bottom nav | 240 мс | `--spring-nav` | Единственная «пружина» в навигации: магнитный перенос индикатора — приятный акцент. |
| Present / dismiss sheet | 300 мс | `--spring-sheet` / `--ease-in` | Дольше, потому что это смена «слоя» интерфейса. |
| Переход между экранами (таб) | 0 мс — мгновенно | — | См. §3.4. |
| Открытие Mini App | 420 мс | `--spring-open` | **Единственное исключение из правила «≤250 мс».** |
| Parallax / scroll-linked | scroll-driven, без длительности | `--ease-std` на `animation-timeline` | Длительности нет — она задаётся скроллом. |

Правило: **всё, что пользователь может вызвать повторно за одну сессию (табы, строки списка,
кнопки), анимируется минимально или не анимируется вовсе** — прямо по HIG Motion
(«avoid adding motion to UI interactions that occur frequently»).

### 3.3 Press feedback

```css
.btn {
  transition:
    transform 180ms var(--spring-press),
    opacity   180ms var(--spring-press);
  will-change: transform; /* НЕ will-change: opacity — это создаёт backdrop root (§2.3) */
}
.btn:active {
  transform: scale(0.97);   /* диапазон 0.96–0.98 */
  opacity: 0.88;            /* диапазон 0.85–0.92, применять только к тексту на стекле */
  transition-duration: 90ms;
  transition-timing-function: var(--ease-std);
}
/* Тонкая тактильность через Telegram, если доступна (документировано в webapps) */
```

**`will-change: opacity` / `opacity < 1` на контейнере с дочерними стеклянными элементами —
запрещено** (backdrop root, §2.3). На кнопке, у которой нет стеклянных потомков, — можно,
но и не нужно.

**Когда пружина, когда простая кривая:**
- Пружина — когда элемент «физически» возвращается в исходное состояние и это приятно
  видеть: кнопка, переключатель, индикатор, dragged-элемент.
- Простая кривая — когда анимируется нечто, у чего нет «массы»: opacity, цвет, фон, контент.

### 3.4 Когда НЕ анимировать

1. **`prefers-reduced-motion: reduce`** — [Baseline с января 2020](https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion),
   отображает iOS «Reduce Motion», Android «Remove animations». Правило — убрать
   трансформации и пружины, оставить мгновенные смены состояния и opacity:
   ```css
   @media (prefers-reduced-motion: reduce) {
     *, *::before, *::after {
       transition-duration: 1ms !important;
       animation-duration: 1ms !important;
       animation-iteration-count: 1 !important;
     }
     .btn:active { transform: none; }  /* уменьшение области нажатия — не vestibular-триггер */
   }
   ```
   Подробнее о том, какие именно анимации являются триггерами (масштабирование, панорамирование,
   вращение, плоскостные сдвиги, периферийное движение) и почему не нужно резать всё подряд —
   [WebKit, Responsive Design for Motion](https://webkit.org/blog/7551/responsive-design-for-motion/).
2. **Слабое устройство (`performance_class` LOW)** — глобально: без параллакса, blur ≤ 12px,
   без пружин (только `--ease-std`), без входа карточек с трансформацией. Оставить только
   opacity-переходы 150 мс.
3. **Во время скролла** — никаких `enter`-анимаций на элементах ленты. Только scroll-linked
   эффекты (§6.2), и точечно.
4. **Длинные списки** (> 20 строк) — элементы ниже первого экрана не анимируются при
   появлении. Никакого stagger на списках вообще (см. ниже).
5. **Stagger** — **запрещён**. Единственное исключение: 3–4 элемента, появляющихся
   одновременно после явного действия пользователя (открыт sheet → его 3 пункта). Тогда
   `animation-delay: calc(var(--i) * 24ms)`, максимум 3 ступени, суммарно ≤ 100 мс. На
   24 шага — 576 мс задержки, это уже не «быстро».

### 3.5 Библиотека или чистый CSS

**Рекомендация: чистый CSS, без библиотеки.** Обоснование:

- Полный набор анимаций здесь — это `transition` с 4–5 кривыми и один `@keyframes` для
  входа. Всё это пишется на CSS за ~60 строк.
- `linear()` даёт пружины без JS (Baseline с декабря 2023). Нет нужды в runtime-физике.
- Размеры библиотек (проверено через [bundlephobia API](https://bundlephobia.com), gzip, полный
  entry, актуальные версии на момент исследования):
  | Пакет | Версия | gzip | Замечание |
  |---|---|---|---|
  | `gsap` | 3.15.0 | **~27 KB** | Избыточен: timelines, plugins, scrolltrigger. |
  | `react-spring` | 10.0.4 | ~20 KB | Требует React; peer-зависимости. |
  | `animejs` | 4.5.0 | **~40 KB** | Большой, умеет много лишнего. |
  | `motion` | 14.0.0 | **~48 KB** | Тянет `framer-motion`/`motion-dom`; peer React. |
  | **CSS `linear()`** | — | **0 KB** | Достаточно для всего §3. |

  Минимальный «полезный» размер библиотеки (20–27 KB gzip) в Mini App, где первая загрузка
  идёт через WebView Telegram, — это 20–27 KB лишнего JS ради эффектов, которые
  компилируются в CSS. Не окупается.

- Если всё-таки нужна физика (например, «реальный» drag индикатора nav с преследованием
  пальца), писать 15 строк на Pointer Events + `requestAnimationFrame` с критически
  затухающей пружиной, а не тащить библиотеку.

```js
// Минимальная критически-затухающая пружина, если реально понадобится.
function spring(el, from, to, { duration = 240, zeta = 0.85 } = {}) {
  const wn = 2 * Math.PI / duration;
  const wd = wn * Math.sqrt(1 - zeta * zeta);
  const t0 = performance.now();
  (function frame(t) {
    const T = (t - t0) / 1000;
    const y = zeta < 1
      ? 1 - Math.exp(-zeta * wn * T) * (Math.cos(wd * T) + (zeta * wn / wd) * Math.sin(wd * T))
      : 1 - Math.exp(-wn * T) * (1 + wn * T);
    el.style.transform = `translate3d(${(from + (to - from) * y).toFixed(2)}px,0,0)`;
    if (t - t0 < duration * 1.2) requestAnimationFrame(frame);
  })(t0);
}
```

---

## 4. Layout и информационная архитектура

### 4.1 Safe area в Mini App — полная схема

Проблема: в Mini App **две** системы отступов сверху и снизу.

- **Сверху** Telegram рисует свою шапку (с кнопкой назад / заголовком). Насколько высоко
  уходит контент — сообщает `contentSafeAreaInset.top`. Плюс вырез устройства — это
  `safeAreaInset.top`.
- **Снизу** — home indicator iOS / системная навигация Android (`safeAreaInset.bottom`) **и**
  нативная нижняя кнопка Telegram, если она показана (`MainButton` / `SecondaryButton`,
  Bot API 7.7+) — это `contentSafeAreaInset.bottom`.
- `viewportStableHeight` — стабильная высота видимой области. Документация Telegram прямо
  предупреждает: `viewportHeight` «refresh rate of this value is not sufficient to smoothly
  follow the lower border of the window. It should not be used to pin interface elements to
  the bottom of the visible area. It’s more appropriate to use the value of
  `viewportStableHeight` for this purpose».

Схема, которая не ломается:

```css
.app {
  min-height: 100svh;
  padding-top: var(--safe-top);
  padding-left: var(--safe-left);
  padding-right: var(--safe-right);
}

/* Нижняя навигация: прибита к низу СТАБИЛЬНОЙ области, а не текущей */
.bottom-nav {
  position: fixed;
  left: var(--safe-left);
  right: var(--safe-right);
  /* --tg-viewport-stable-height — высота стабильной области;
     если Telegram её не отдал, fallback на 100svh */
  bottom: calc(100svh - min(var(--tg-viewport-stable-height, 100svh), 100svh));
  margin-bottom: calc(var(--safe-bottom) + 8px); /* + 8 — «дыхалка» над home indicator */
  z-index: 30;
}

/* Контент под nav — не перекрывается */
.app-content {
  padding-bottom: calc(72px + var(--safe-bottom) + 16px); /* 72 = высота навки */
}
```

Подписки на изменение геометрии:

```js
const tg = window.Telegram?.WebApp;
tg?.onEvent("viewportChanged", ({ isStateStable }) => {
  if (!isStateStable) return;              // во время жеста не трогаем — иначе дёргается
  document.documentElement.style.setProperty(
    "--tg-viewport-stable-height", `${tg.viewportStableHeight}px`
  );
});
tg?.onEvent("safeAreaChanged", syncInsets);
tg?.onEvent("contentSafeAreaChanged", syncInsets);
tg?.onEvent("fullscreenChanged", syncInsets);

function syncInsets() {
  const s = tg?.safeAreaInset ?? { top: 0, bottom: 0, left: 0, right: 0 };
  const c = tg?.contentSafeAreaInset ?? { top: 0, bottom: 0, left: 0, right: 0 };
  const r = document.documentElement.style;
  r.setProperty("--tg-safe-area-inset-top", `${s.top}px`);
  r.setProperty("--tg-safe-area-inset-bottom", `${s.bottom}px`);
  r.setProperty("--tg-content-safe-area-inset-top", `${c.top}px`);
  r.setProperty("--tg-content-safe-area-inset-bottom", `${c.bottom}px`);
}
```

**Как избежать столкновения 4-табового бара с шапкой Telegram и home indicator:**

1. Наш app bar **не дублирует** шапку Telegram. Он либо отсутствует (используем нативную
   шапку Telegram через `BackButton`), либо это компактный «hero»-блок **внутри** контента,
   начинающийся ниже `--safe-top`. Дублировать заголовок шапки — визуальный мусор.
2. Bottom nav всегда `margin-bottom: calc(var(--safe-bottom) + 8px)`. Никогда `bottom: 0`.
3. Если показан нативный `MainButton` Telegram, он живёт **под** нашим навом. Наш nav
   поднимается на высоту, которую сообщает `contentSafeAreaInset.bottom`, — то есть `max()`
   из §2.1 делает это автоматически.
4. В полноэкранном режиме (`requestFullscreen`) шапка Telegram прозрачна
   (документировано), но рекомендуется всё равно вызвать `setHeaderColor`, чтобы
   определить контраст статус-бара. Если используем fullscreen — пересчитать insets на
   событии `fullscreenChanged`.
5. `disableVerticalSwipes()`, если наш layout конфликтует со свайпом закрытия — документировано
   как правильный ход.

### 4.2 Spacing, ширина, адаптив

- Spacing scale: `--sp-1..--sp-10` (4/8/12/16/20/24/32/40) — из §2.1. Никаких «просто 15px».
- Горизонтальные поля: `--sp-4` (16px) на телефоне, `--sp-6` (24px) на ≥ 480px.
- Максимальная ширина контента: **560px**, центрирование — потому что 4-табовый нав на
  планшете должен остаться «плавающим», а колонка текста — читаемой.
- От 320px до 480px: одна колонка, поля 16px, индикатор nav масштабируется.
- 480–768px: поля 24px, размеры шрифта те же.
- ≥ 768px (планшет/Desktop Telegram): контент по центру `max-width: 560px`, nav остаётся
  `max-width: 560px` по центру снизу, но получает большую вертикальную «подушку» — на
  десктопе WebView широкий, иначе nav выглядит «прилипшим». Альтернатива (зафиксировано как
  рекомендация, не обязательство) — превратить nav в вертикальный sidebar при ≥ 900px
  (по аналогии с `sidebarAdaptable` из HIG; на вебе это наша собственная реализация).
- Ландшафт: не поддерживаем как основной сценарий. Mini App в Telegram обычно запускается
  портретно; `requestFullscreen` в ландшафте можно не предлагать.

### 4.3 Инвентарь компонентов

| Компонент | Назначение (одной строкой) | Стекло? |
|---|---|---|
| `app-bar` | Заголовок раздела/задачи внутри контента; нативная шапка Telegram не дублируется | **Нет** — непрозрачный или вообще отсутствует |
| `status-pill` | «Агент онлайн / очередь N / лимит» — компактная капсула с точкой состояния | **Да**, `glass-capsule` |
| `glass-card` | Плавающая карточка с ключевой сводкой (стоимость, статус) | **Да**, `glass-card` |
| `task-card` | Строка задачи в ленте: название, статус, время, стоимость | **Нет** — `solid-card` (Apple: стекло не в контентном слое) |
| `progress-bar` | Прогресс выполнения задачи/квоты | **Нет** — тонкая плашка с `--tg-theme-accent-text-color` |
| `list-row` | Строка списка (файлы, логи, агенты) с иконкой и вторичным текстом | **Нет**, `solid-card` |
| `section-header` | Заголовок секции списка (title-case, по HIG) | **Нет** — только типографика |
| `segmented-control` | Переключатель фильтра/вкладки на одном уровне | **Да**, `glass-capsule` + стеклянный «ползунок» внутри |
| `bottom-nav` | 4 таба: `Home · Tasks · Files · More` + активный индикатор | **Да**, `glass-nav` — главный элемент материала |
| `bottom-sheet` | Модальный выбор/детали, выезжает снизу, полу-скруглённый | **Да**, `glass-elevated` |
| `toast` | Краткое уведомление поверх контента | **Да**, `glass-elevated`; или **Нет** (`solid`), если поверх диффа |
| `empty-state` | «Список пуст» — иконка + текст + одно действие | **Нет** |
| `skeleton` | Заглушка на время загрузки: блоки, без мигания | **Нет** — только `--tg-theme-hint-color` на 8–12% |

**Правило читаемости.** Текст **никогда** не лежит на «шумном» размытом фоне. Стекло —
только там, где под ним: (а) ровный фон приложения, (б) крупные гладкие блоки. Стекло
запрещено над: дифф-вьюером, моноширинным кодом, логами, таблицами, любым местом, где
текст ≤ 15px. Для таких зон — непрозрачный `solid-card` или scrim 35% (HIG). Это же
правило объясняет, почему `task-card` и `list-row` не стеклянные: они и есть контентный слой.

---

## 5. Запреты (проверяемые ревьюером)

Каждое правило сформулировано так, чтобы его можно было проверить механически (grep, DevTools,
скрипт).

**Слои и blur**

1. **D1.** Максимум **2** стеклянных слоя, вложенных друг в друга (`backdrop-filter`-элемент
   внутри `backdrop-filter`-элемента). Проверка: `document.querySelectorAll('*')` — для каждого
   элемента с `backdropFilter !== 'none'` посчитать предков с `backdropFilter !== 'none'`.
2. **D2.** Одновременно видимых элементов с `backdrop-filter: blur(...)` — **не более 3**.
   Проверка: в `:active`/первом экране посчитать элементы с computed
   `backdropFilter !== 'none'` и видимым `getBoundingClientRect()`.
3. **D3.** Значение `blur` — **не более 28px** нигде; для `glass-capsule` — не более 12px.
4. **D4.** В `backdrop-filter` разрешены **только** `blur()` и `saturate()`. Запрещены
   `hue-rotate`, `invert`, `sepia`, `grayscale`, `brightness`, `contrast`, `drop-shadow`.
   Проверка: regex по CSS.
5. **D5.** `filter: url(...)` и SVG-фильтры (`feDisplacementMap`, `feTurbulence`) —
   **запрещены в продакшен-коде**. Разрешены только в изолированной демо-странице.

**Читаемость**

6. **D6.** Никакого `backdrop-filter` над: элементами с `class` containing `mono`/`diff`/`log`,
   и над любым элементом с `font-size < 15px`, если он не перекрыт scrim ≥ 30%.
7. **D7.** Контраст текста на фоне ≥ **4.5:1** (обычный текст), ≥ **3:1** (крупный текст
   ≥ 18.66px bold или ≥ 24px, и UI-границы/иконки). Проверка: расширение / ручной расчёт по
   `relLum` (§2.6). `hint_color` Telegram не гарантирует 4.5:1 — проверять и подменять.
8. **D8.** Все интерактивные элементы имеют `:focus-visible`-стиль с видимым индикатором
   (`outline: 2px solid var(--tg-theme-link-color, var(--accent)); outline-offset: 2px`).

**Цвет**

9. **D9.** Максимум **1** акцентный цвет (`--tg-theme-link-color` / `button_color`) плюс
   `destructive_text_color` для деструктивных действий. Никаких «брендовых» дополнительных
   цветов. Apple прямо: «Refrain from adding color to the background of multiple controls».
10. **D10.** Нет фиолетового/неонового/кислотного. Нет `text-shadow` с цветным свечением.
    Нет `box-shadow` с 3+ цветными слоями. Нет анимированных градиентов.
11. **D11.** Никаких веб-шрифтов — только системный стек (§2.5). Ноль сетевых запросов за
    шрифтами.

**Motion**

12. **D12.** Ни одна анимация не длиннее **250 мс**, кроме: открытия Mini App (420 мс) и
    present/dismiss sheet (300 мс). Проверка: regex по `transition`/`animation-duration`.
13. **D13.** Нет `animation-iteration-count: infinite` нигде, кроме случаев, где анимация
    скрыта `prefers-reduced-motion` и не более одного (запрещено полностью для нашего UI —
    «no constant looping animations»).
14. **D14.** Нет stagger на списках; `animation-delay` ≤ 100 мс суммарно и ≤ 3 ступени.
15. **D15.** Анимируются **только** `transform` и `opacity` (и `background-color` на hover/
    press). Запрещены анимации `width`, `height`, `top`, `left`, `filter`, `box-shadow`,
    `backdrop-filter`.
16. **D16.** `will-change` не содержит `opacity`, `filter`, `mask`, `clip-path`, `mix-blend-mode`
    на контейнерах со стеклянными потомками (backdrop root).

**Правила содержания**

17. **D17.** Никакого вечного «дыхания», пульсации, параллакса фона. Parallax — только
    scroll-linked, только в lite-off, амплитуда ≤ 8px.
18. **D18.** Никаких анимированных частиц/боке/шумов.
19. **D19.** Никаких «живых» обоев, видео-фонов, mesh-градиентов.
20. **D20.** Скелетоны не мигают: `animation: none` либо один проход 1200 мс, не более одного
    на группу.

---

## 6. Референс-реализации (pseudo-CSS)

### 6.1 Плавающий стеклянный bottom nav с анимированным индикатором

Ключевая идея: индикатор — **один** абсолютно позиционированный элемент, который
перемещается через `transform` (или `left` через CSS-переменную), а не четыре отдельных
подсвеченных таба. Это и дешевле, и выглядит как «магнит».

```css
.bottom-nav {
  position: fixed;
  left: var(--safe-left);
  right: var(--safe-right);
  bottom: calc(100svh - min(var(--tg-viewport-stable-height, 100svh), 100svh));
  margin-bottom: calc(var(--safe-bottom) + 8px);
  margin-inline: 16px;
  max-width: 560px;
  margin-inline: auto;

  height: 64px;                 /* 64 + safe-area — стандартная высота мобильного таббара */
  border-radius: var(--r-xl);   /* 28px — «пилюля» */

  display: grid;
  grid-template-columns: repeat(4, 1fr);
  align-items: center;

  /* Материал: заливка + blur + hairline + elevation */
  background: var(--glass-tint-strong);
  backdrop-filter: blur(var(--blur-3)) saturate(var(--sat-2));
  -webkit-backdrop-filter: blur(var(--blur-3)) saturate(var(--sat-2));
  box-shadow: var(--elev-2), inset 0 0 0 1px var(--hairline-soft);

  z-index: 30;
  overflow: hidden;            /* чтобы индикатор не вылезал за скруглённый край */
}

/* Specular highlight вдоль верхней кромки — «блик», который продаёт стекло */
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

/* --- Анимированный индикатор --- */
.nav-indicator {
  position: absolute;
  top: 8px;
  left: 0;
  height: 48px;
  /* ширину и X считает JS из реальных размеров табов */
  width: var(--ind-w, 25%);
  transform: translate3d(var(--ind-x, 0px), 0, 0);
  border-radius: var(--r-lg);
  background: rgba(255, 255, 255, 0.14);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.12);
  transition:
    transform 240ms var(--spring-nav),
    width     240ms var(--spring-nav);
  pointer-events: none;
}

/* Табы */
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
  transition: color 180ms var(--ease-std);   /* только цвет, никаких transform */
}
.nav-item[aria-selected="true"] {
  color: var(--tg-theme-text-color, var(--text));
}
.nav-item svg { width: 24px; height: 24px; }

/* Прижатие — лёгкое, без прыжка */
.nav-item:active { opacity: 0.7; transition-duration: 90ms; }
```

JS для позиционирования индикатора (пересчёт на resize и при смене шрифтовой метрики):

```js
function moveIndicator(index, animate = true) {
  const nav = document.querySelector(".bottom-nav");
  const items = nav.querySelectorAll(".nav-item");
  const el = items[index];
  if (!el) return;
  const navBox = nav.getBoundingClientRect();
  const box = el.getBoundingClientRect();
  const x = box.left - navBox.left;
  const w = box.width;
  const ind = nav.querySelector(".nav-indicator");
  if (!animate) ind.style.transition = "none";
  ind.style.setProperty("--ind-w", `${w}px`);
  ind.style.setProperty("--ind-x", `${x}px`);
  if (!animate) requestAnimationFrame(() => (ind.style.transition = ""));
}
addEventListener("resize", () => moveIndicator(current, false));
```

Иконки — **SVG-спрайт или инлайн-SVG**, `currentColor`, размер 24px, `stroke-width: 1.75`,
`stroke-linecap: round`. Никаких иконочных шрифтов и растровых PNG.

### 6.2 Стеклянная карточка, которая «реагирует» на скролл

Идея: blur и прозрачность слегка меняются в зависимости от позиции карточки в вьюпорте.
В Telegram это и есть «refraction as you scroll». Реализуется через
**scroll-driven animation** (CSS `animation-timeline: view()`) — без единой строки JS и без
лишнего кадра анимации.

```css
@keyframes glass-refract {
  from {
    backdrop-filter: blur(20px) saturate(160%);
    background-color: rgba(255, 255, 255, 0.06);
    transform: translate3d(0, 6px, 0);
  }
  to {
    backdrop-filter: blur(28px) saturate(185%);
    background-color: rgba(255, 255, 255, 0.11);
    transform: translate3d(0, -6px, 0);
  }
}

.glass-card--reactive {
  animation: glass-refract linear both;
  animation-timeline: view();
  animation-range: entry 0% exit 100%;   /* «карточка проходит через вьюпорт» */
  will-change: auto;                    /* НЕ will-change: filter — backdrop root! */
}

/* Fallback / выключенный режим — статичное стекло */
@supports not (animation-timeline: view()) {
  .glass-card--reactive { animation: none; }
}
@media (prefers-reduced-motion: reduce) {
  .glass-card--reactive { animation: none; }
}
/* Слабое устройство */
:root[data-perf="low"] .glass-card--reactive { animation: none; }
```

Важные оговорки:

- Анимировать `backdrop-filter` в scroll-driven — **дорого**. Допустимо **только** для 1–2
  карточек и **только** в режиме «полный». На ленте из 20 карточек — мгновенно удвоит
  стоимость кадра. Безопаснее анимировать только `transform` (±6px) и `background-color`, а
  `blur` держать постоянным. Именно поэтому в `from/to` выше разница в blur мала
  (20→28px): если заметно лагает — зафиксируйте `blur(24px)` в обоих ключевых кадрах.
- Fallback для старых WebView — `@supports not (animation-timeline: view())` плюс статичное
  значение. Поддержку `animation-timeline` в целевых WebView мы **не проверяли**
  (**UNVERIFIED**) — поэтому `@supports`-ветка обязательна, а не опциональна.
- Никогда не сочетать с `will-change: filter`, `opacity < 1` на родителе (backdrop root).

### 6.3 Анимация открытия Mini App

**Проверено:** API, позволяющего веб-странице influence на анимацию открытия, в
[core.telegram.org/bots/webapps](https://core.telegram.org/bots/webapps) нет — её рисует
клиент Telegram. Отсюда правило: **не пытаемся проиграть «открытие» сами** иначе получим
двойную анимацию (клиент + страница). Что можно и нужно:

1. Держать `body` в состоянии «ничего не видно» до готовности.
2. На `Telegram.WebApp.ready()` (документировано: «It is recommended to call this method as
   early as possible… Once this method is called, the loading placeholder is hidden and the
   Mini App is shown») проиграть **только вход содержимого**.
3. Дождаться `viewportChanged` с `isStateStable: true`, если в момент готовности размер ещё
   не устоялся.

```css
/* До ready() — контент скрыт, чтобы не «вспыхнул» */
.app { opacity: 0; }

.app[data-ready="1"] {
  opacity: 1;
  animation: miniapp-open 420ms var(--spring-open) both;
}

@keyframes miniapp-open {
  from { opacity: 0; transform: translate3d(0, 10px, 0) scale(0.985); }
  to   { opacity: 1; transform: translate3d(0, 0,   0) scale(1); }
}

@media (prefers-reduced-motion: reduce) {
  .app[data-ready="1"] { animation: none; }
}
:root[data-perf="low"] .app[data-ready="1"] {
  animation: fade-in 180ms var(--ease-std) both;  /* только прозрачность, без пружины */
}
@keyframes fade-in { from { opacity: 0 } to { opacity: 1 } }
```

```js
const tg = window.Telegram?.WebApp;

function reveal() {
  document.querySelector(".app").dataset.ready = "1";
}

// Наш skeleton виден сразу, поэтому ready() можно звать рано
tg?.ready();
requestAnimationFrame(reveal);

// Если высота ещё не устоялась — подождём стабилизации
tg?.onEvent("viewportChanged", ({ isStateStable }) => { if (isStateStable) reveal(); });
```

Сдвиг 10px и `scale(0.985)` — маленькие намеренно. Telegram уже показал пользователю, что
приложение «выехало»; наша задача — лишь снять ощущение «пустой белый экран», а не
переиграть переход. 420 мс — единственная анимация длиннее 250 мс, и это единственное
оправданное исключение из правила §3.2.

---

## 7. Источники

Все URL, которые были открыты при подготовке документа, с указанием, что именно каждый
подтвердил.

| # | URL | Что подтвердил |
|---|---|---|
| 1 | https://developer.apple.com/design/human-interface-guidelines/materials | Liquid Glass как отдельный функциональный слой; два варианта `regular`/`clear`; blur + luminosity adjustment в `regular`; scroll edge effects; «Don't use Liquid Glass in the content layer»; «Use Liquid Glass effects sparingly»; 35% dark dimming layer над ярким контентом; standard materials `ultraThin`/`thin`/`regular`/`thick`; vibrancy-уровни; адаптация к Reduce Transparency / Increase Contrast |
| 2 | https://developer.apple.com/documentation/technologyoverviews/adopting-liquid-glass | `glassEffect(_:in:)`, `GlassEffectContainer` для производительности и морфинга, `glass`/`glassProminent` button styles, `safeAreaBar`, `rect(corners:isUniform:)`/`ConcentricRectangle`, `tabBarMinimizeBehavior(.onScrollDown)`, `backgroundExtensionEffect()`, `UIDesignRequiresCompatibility`; предупреждение что кастомные фоны интерферируют со scroll edge effect; «Limit these effects to the most important functional elements» |
| 3 | https://developer.apple.com/documentation/swiftui/applying-liquid-glass-to-custom-views | Семантика `interactive(_:)`, `tint`, `GlassEffectContainer(spacing:)` (spacing влияет на слияние форм), `glassEffectUnion`; «reacts to touch and pointer interactions in real time» |
| 4 | https://developer.apple.com/design/human-interface-guidelines/color | Раздел «Liquid Glass color»: у материала нет собственного цвета, он берёт его из контента; мелкие элементы светлеют/темнеют по контенту; крупные элементы более непрозрачны; цвет применять к фону, а не к символам; «Refrain from adding color to the background of multiple controls»; обязательные light/dark варианты + increased contrast |
| 5 | https://developer.apple.com/design/human-interface-guidelines/motion | «Aim for brevity and precision»; «avoid adding motion to UI interactions that occur frequently»; «Let people cancel motion»; разная выраженность реакции материала на touch vs trackpad; избегать светлых начертаний |
| 6 | https://developer.apple.com/design/human-interface-guidelines/typography | iOS/iPadOS default 17 pt, minimum 11 pt; SF Pro / SF Pro Text; optical sizing; рекомендация избегать Ultralight/Thin/Light |
| 7 | https://core.telegram.org/bots/webapps | Раздел «Design Guidelines» (mobile-first, 60fps, mimic existing components, a11y labels, theme-based colors, safe area + content safe area, performance class); `themeParams` и все `--tg-theme-*` / `--tg-color-scheme`; `viewportStableHeight` vs `viewportHeight` (явный запрет пинить элементы по `viewportHeight`); `safeAreaInset` / `contentSafeAreaInset` + CSS-переменные; события `themeChanged`, `viewportChanged` (`isStateStable`), `safeAreaChanged`, `contentSafeAreaChanged`, `fullscreenChanged`; `ready()`, `expand()`, `requestFullscreen()`, `disableVerticalSwipes()`, `setHeaderColor()`; Android User-Agent с `performance_class` ∈ {LOW, AVERAGE, HIGH}; `HapticFeedback`; отсутствие API для анимации открытия; `MainButton`/`SecondaryButton` как нативный нижний UI |
| 8 | https://telegram.org/blog/comments-in-video-chats-threads-for-bots | Официально: «Liquid Glass for iOS 26… transparent elements with a satisfying refraction effect as you scroll» (нижний нав, клавиатура, панель стикеров) |
| 9 | https://telegram.org/blog/new-design-ai-summaries | Официально: Telegram for iOS «now fully supports Liquid Glass», «transparent elements» |
| 10 | https://telegram.org/blog/crafting-android-design-and-more | Официально: полный редизайн Android, новый bottom bar, «Settings > Power Saving» управляет эффектами интерфейса ради производительности и батареи |
| 11 | https://developer.mozilla.org/en-US/docs/Web/CSS/backdrop-filter | Baseline 2024 (since Sept 2024); полный список filter-функций; `url()` разрешён в синтаксисе; правила **backdrop root** (`opacity<1`, `filter`, `mask`, `clip-path`, `mix-blend-mode`, `will-change`) и их ловушка |
| 12 | https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-transparency | Медиафункция **существует** (Media Queries L5), но помечена Experimental / Limited availability (не Baseline). Отсюда решение не полагаться только на неё |
| 13 | https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion | Baseline widely available с января 2020; маппинг системных настроек (iOS Settings > Accessibility > Motion, Android Remove animations) |
| 14 | https://developer.mozilla.org/en-US/docs/Web/CSS/easing-function/linear | `linear()` — Baseline widely available с декабря 2023; синтаксис с двумя процентами на точку; можно аппроксимировать пружины |
| 15 | https://developer.mozilla.org/en-US/docs/Web/CSS/env | `env(safe-area-inset-top/right/bottom/left)` и `safe-area-max-inset-*`; семантика fallback-аргумента |
| 16 | https://developer.mozilla.org/en-US/docs/Web/CSS/filter | `filter` (Baseline с сентября 2016), поддержка `url()` со ссылкой на SVG-фильтр, правила интерполяции между filter-списками |
| 17 | https://developer.mozilla.org/en-US/docs/Web/SVG/Reference/Element/feDisplacementMap | `feDisplacementMap` Baseline с июля 2015; формула смещения; `color-interpolation-filters` — основание для вывода о его непригодности для 60 FPS |
| 18 | https://developer.mozilla.org/en-US/docs/Web/CSS/color_value/color-mix | `color-mix()` Baseline с мая 2023; пространство по умолчанию `oklab`; рекомендация `oklab`/`oklch` для перцептивно ровных смесей |
| 19 | https://developer.mozilla.org/en-US/docs/Web/CSS/@supports | `@supports` Baseline с сентября 2015; синтаксис `not`, `and`, `or` — база для feature-веток Lite-режима |
| 20 | https://developer.mozilla.org/en-US/docs/Web/CSS/@view-transition | `@view-transition` — Limited availability (только cross-document, same-origin). Полезно знать, но **не** использовать для навигации внутри Mini App |
| 21 | https://webkit.org/blog/3632/introducing-backdrop-filters/ | Официальное предупреждение WebKit: backdrop-filter заставляет движок делать дополнительные проходы рендеринга и влияет на производительность; использовать только там, где необходимо; аппаратный ускоритель делает базовые случаи эффективными |
| 22 | https://webkit.org/blog/7551/responsive-design-for-motion/ | `prefers-reduced-motion` (Media Queries L5); перечень vestibular-триггеров (масштабирование, вращение, многоскоростное движение, плоскостные сдвиги, периферийное движение); совет не резать больше, чем нужно («Don't Reduce Too Much») |
| 23 | https://developer.apple.com/design/human-interface-guidelines/color (fetch как text) | Подтвердило, что раздел «Liquid Glass color» присутствует; текст добыт через браузер |
| 24 | https://developer.apple.com/design/human-interface-guidelines/typography (fetch как page) | Подтвердило таблицу размеров шрифтов по платформам |
| 25 | https://webkit.org/blog/category/performance/ | Проверка наличия отдельного поста WebKit о стоимости `backdrop-filter` — **такого поста в этом разделе нет**; единственная официальная цитата о стоимости — [WebKit blog 3632](https://webkit.org/blog/3632/introducing-backdrop-filters/) |
| 26 | https://9to5mac.com/2025/10/13/telegram-adopts-a-liquid-glass-like-design-no-ios-26-required/ | Вторичный источник: «Liquid Glass-**like**», собственная реализация Telegram, работает **без iOS 26**; цитата пользователей о том, что часть UI осталась в pre-iOS-26 стиле (для нас: вывод — не пытаться «переделать всё», а сделать несколько ключевых элементов) |
| 27 | https://bundlephobia.com/api/size?package=gsap@latest | `gsap` 3.15.0 — 70.6 KB raw / **27.4 KB gzip** |
| 28 | https://bundlephobia.com/api/size?package=motion@latest | `motion` 14.0.0 — 141.3 KB raw / **47.6 KB gzip** (+ framer-motion, motion-dom) |
| 29 | https://bundlephobia.com/api/size?package=animejs@latest | `animejs` 4.5.0 — 116.8 KB raw / **40.3 KB gzip** |
| 30 | https://bundlephobia.com/api/size?package=react-spring@latest | `react-spring` 10.0.4 — 52.1 KB raw / **20.0 KB gzip** |

### 7.1 Явные пробелы в верификации

Чтобы дизайн-скилл не опирался на выдумки:

- **Не проверено вживую** на реальных устройствах: конкретные fps, реальная стоимость
  `backdrop-filter` в WebView Telegram на Android, поведение `animation-timeline: view()` в
  этих WebView, проброс `prefers-reduced-transparency` в них. Всё это требует прогона на
  устройствах — и это первоочередная задача при валидации скилла.
- **Не найдено официального числового спеца** параметров Liquid Glass (blur, alpha, радиусы).
  Все числа в §2 — проектные. Их нужно помечать как «design tokens», а не « Apple's values».
- **Не найдено официального гайдлайна Telegram именно по визуалу Mini App** — есть только
  текстовый «Design Guidelines» из п. 7 (#7). Всё, что касается «как выглядит Telegram»,
  опирается на блог-посты и вторичные обзоры.
- **Не проверено**: существует ли непубличный API Telegram для кастомизации анимаций
  открытия Mini App. Публично — нет.