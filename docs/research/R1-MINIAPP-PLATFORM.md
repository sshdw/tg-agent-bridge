# R1 — Telegram Mini App: платформенные ограничения и cardless-хостинг

**Дата исследования:** 2026-10-03. **Bot API на дату:** 10.3 (2026-08-24), Mini Apps docs от 2026-09.
**Область:** только исследование. Ни один файл проекта, кроме этого документа, не менялся; бот не запускался; Bot API не вызывался.

---

## 0. Верификация состояния репозитория

| Проверка | Результат |
|---|---|
| `grep` по `src/` на `createServer\|express\|listen(\|WebApp\|setChatMenuButton\|web_app\|initData` | **0 совпадений** |
| `package.json` → `dependencies` | только `better-sqlite3`, `grammy`. Ни одного HTTP-фреймворка |
| `src/index.ts:115` → `await bot.start({ onStart })` | grammY `bot.start()` без `webhook` = **long polling**, входящий HTTP-сервер не поднимается |
| `grep` по `src/` на `setWebhook` | **0 совпадений** |

**Вывод (подтверждён чтением кода):** HTTP-сервера у проекта нет, Mini App-кода нет, `telegram-web-app.js` не подключается. Всё, что описано ниже в разделах B и частично A — greenfield.

Уже есть и будет использовано:

- grammY уже умеет нужные методы: `bot.api.setChatMenuButton({ menu_button: { type: 'web_app', text, web_app: { url } } })` (проверено в `node_modules/@grammyjs/types/methods.d.ts:1632` и `settings.d.ts:30`).
- `ALLOWED_CHAT_IDS` уже есть в конфиге → авторизация по `initData.user.id` ложится на существующий список.
- Лимиты файлов уже зашиты в `src/core/files.ts`: `MAX_OUTBOUND_BYTES = 50 MB`, `MAX_PHOTO_BYTES = 10 MB` — совпадают с официальными ([Handling Media](#с-источники)).

---

## A. Жёсткие ограничения платформы

### A.1. Способы запуска Mini App и откуда берётся URL

Официальная страница: [Telegram Mini Apps → Implementing Mini Apps](https://core.telegram.org/bots/webapps#implementing-mini-apps). Telegram перечисляет **семь** способов.

| Способ | Механизм URL | `initData` | `answerWebAppQuery` | Доступно личный боту на production |
|---|---|---|---|---|
| **Main Mini App** (`Launching the main Mini App`) | URL задаётся в BotFather один раз | да | да | да |
| **Menu button** (`setChatMenuButton`) | `MenuButtonWebApp.web_app` — **URL либо t.me-ссылка** | да | да | **да — рекомендуется** |
| **Keyboard button** (`web_app`) | URL в кнопке | только базовые | **нет** | да, но `sendData` ≤4096 байт и Mini App закрывается |
| **Inline button** (`web_app`) | URL в кнопке | да | да | да |
| **Direct link** `t.me/<bot>/<short_name>` | URL зашит в BotFather | да | нет | да |
| **Inline mode** (`InlineQueryResultsButton.web_app`) | URL в кнопке | да | нет | да |
| **Attachment menu** (`startattach`) | URL в BotFather | да | да | **НЕТ** |

Ключевые цитаты и следствия:

1. **Menu button — лучший выбор для персонального бота.** Документация прямо говорит: *«Apart from this, Mini Apps opened via the menu button work in the exact same way as when using inline buttons»* ([#launching-mini-apps-from-the-menu-button](https://core.telegram.org/bots/webapps#launching-mini-apps-from-the-menu-button)). Причины конкретно для этого проекта:
   - Кнопка всегда на месте — не нужно приклеивать `web_app`-кнопку к каждому сообщению, которое шлёт `src/telegram/outbound.ts` / `stream.ts` (их десятки мест).
   - Даёт полный `initData` (с `user`, `auth_date`) и `query_id` → работает `answerWebAppQuery`.
   - `setChatMenuButton` можно вызвать программно при старте, когда туннель уже поднят и URL известен — URL обновляется автоматически, без похода в BotFather.

2. **`MenuButtonWebApp.web_app` допускает `t.me`-ссылку вместо URL.** Из локальных grammY-типов (`node_modules/@grammyjs/types/settings.d.ts:30-37`, дословный текст Bot API):
   > *«Alternatively, a t.me link to a Web App can be specified in the object instead of the Web App's URL, in which case the Web App will be opened as if the user pressed the link.»*

   Это важнейшая деталь: **можно зашить `t.me/<bot>/app` и перестать обновлять кнопку при каждом рестарте** — URL хранится в BotFather, а он меняется только при смене туннеля/хоста. См. B.5.

3. **Attachment menu недоступен.** Документация: *«Attachment menu integration is currently only available for major advertisers on the Telegram Ad Platform. However, **all bots** can use it in the test environment»* ([#launching-mini-apps-from-the-attachment-menu](https://core.telegram.org/bots/webapps#launching-mini-apps-from-the-attachment-menu)). Для личного бота на production — **нет**. Поэтому `startattach` из этой ветки использовать нельзя; упомянутые в ней `readTextFromClipboard`, `answerWebAppQuery` по текущему чату и `writeAccessRequested` теряют практическую ценность.

4. **`sendData` — только для Keyboard button.** Документация: *«This method is only available for Mini Apps launched via a Keyboard button»* ([#initializing-mini-apps](https://core.telegram.org/bots/webapps#initializing-mini-apps)). Плюс лимит 4096 байт и **Mini App закрывается**. Для проекта с AI-агентом (нужны поток, файлы, голос) — **непригодно**, отбрасываем.

5. **Прямая ссылка / Main Mini App** открывается на **полную высоту** начиная с Bot API 7.6, `mode=compact` в ссылке возвращает уменьшенную высоту ([#direct-link-mini-apps](https://core.telegram.org/bots/webapps#direct-link-mini-apps)). Полезно для «More»-таба, но для основного входа menu button проще.

6. **Загрузка скрипта — строго в `<head>` до всего остального:**
   ```html
   <script src="https://telegram.org/js/telegram-web-app.js?63"></script>
   ```
   (версия `?63` указана в официальной документации на момент исследования).

---

### A.2. Обязателен ли HTTPS для `WebAppInfo.url`

| Вопрос | Ответ | Источник |
|---|---|---|
| Тип поля | `WebAppInfo.url` — **«An HTTPS URL of a Web App»**. Не «URL», а именно HTTPS | [Bot API → WebAppInfo](https://core.telegram.org/bots/api#webappinfo); дословно в grammY-типах `node_modules/@grammyjs/types/methods.d.ts:1253`: *«An HTTPS URL of a Web App to be opened…»* |
| Можно ли `http://localhost` | **Нет на production.** Единственное документированное исключение: *«**Note:** When working with the test environment, you may use HTTP links without TLS to test your Mini App»* — то есть только для тестового DC (`api.telegram.org/bot<token>/test/…`, отдельный аккаунт и отдельный бот) | [Mini Apps → Using bots in the test environment](https://core.telegram.org/bots/webapps#using-bots-in-the-test-environment) |
| Что будет, если клиент не может валидировать сертификат | В официальной документации **нет** описания режима «allow invalid certificates» для Mini App. Для webhooks самоподписанный сертификат решается загрузкой `certificate` в `setWebhook`, но это **другая механика** (Telegram проверяет сертификат сам, сервер Telegram стучится к вам) — к `WebAppInfo.url` она неприменима | [Bot API → setWebhook](https://core.telegram.org/bots/api#setwebhook), [FAQ → self-signed](https://core.telegram.org/bots/faq#i-39m-having-trouble-with-my-self-signed-certificate) |
| IP-адрес в URL | Прямого запрета в `WebAppInfo` нет, но для Mini App **клиент** (WebView телефона) загружает URL, а не сервер Telegram. IP без доменного имени означает отсутствие publicly-trusted сертификата → WebView покажет предупреждение. Практически нерабочий путь | вывод из архитектуры загрузки ([#initializing-mini-apps](https://core.telegram.org/bots/webapps#initializing-mini-apps)) — **прямого документального запрета на IP не нашёл: UNVERIFIED** |
| Порты | Для Mini App **не ограничены** (ограничение 443/80/88/8443 в документации относится к `setWebhook`, а не к `WebAppInfo.url`) | см. [Bot API → setWebhook, Notes](https://core.telegram.org/bots/api#setwebhook) |
| Ограничение домена | Для **Mini Apps** нет реестра разрешённых доменов — BotFather просто принимает HTTPS-URL. Реестр «Allowed URLs» существует только у **Telegram Login** (OIDC), см. [Telegram Login → Registering Your Allowed URLs](https://core.telegram.org/bots/webapps#registering-your-allowed-urls) — **это другой продукт, не путать** |

**Важное ограничение, введённое недавно.** Bot API **10.2 (2026-07-14)**:
> *«Hardened the security of Mini Apps by disallowing the usage of Mini App methods from origins different from the original Mini App domain. The protection will be automatically enabled for all Mini Apps on July 20, 2026.»*
> ([Bot API changelog, July 14, 2026](https://core.telegram.org/bots/api))

То есть на сегодня (октябрь 2026) защита **уже включена у всех**. Следствие: любые `Telegram.WebApp.*` вызовы работают только с origin'ом самого Mini App. Кросс-origin `fetch()` к нашему API это не ломает (обычный CORS), но ломает любую попытку отдать WebApp-методы с другого хоста. Opt-out только через BotFather.

**Итог по HTTPS:** единственный практичный путь — публичный HTTPS-хост с валидным сертификатом от публичного CA. Это и есть блокирующий вопрос → раздел B.

---

### A.3. Безопасность `initData`

Документация: [Validating data received via the Mini App](https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app) и [Validating data for Third-Party Use](https://core.telegram.org/bots/webapps#validating-data-for-third-party-use).

**Механика (дословно из документации):**

```
data_check_string = ...   # все поля, отсортированные по алфавиту, "key=<value>", разделитель 0x0A
secret_key = HMAC_SHA256(<bot_token>, "WebAppData")
if (hex(HMAC_SHA256(data_check_string, secret_key)) == hash) { /* ok */ }
```

**Что обязан проверять бэкенд на КАЖДЫЙ запрос:**

| # | Проверка | Обязательность | Обоснование |
|---|---|---|---|
| 1 | Наличие `hash` | **обязательна** | без него нет якоря доверия |
| 2 | HMAC-SHA256 по `data-check-string` с `secret_key = HMAC_SHA256(bot_token, "WebAppData")` | **обязательна** | единственный способ доказать, что данные выпустил Telegram |
| 3 | Сравнение хеша в **constant-time** | **обязательна** | `crypto.timingSafeEqual`; наивное `===` уязвимо к timing-атаке |
| 4 | `auth_date` свежесть (например, ≤ 24 ч) | **настоятельно** | документация: *«To prevent the use of outdated data, you can additionally check the auth_date field»*. Без этого перехваченный `initData` вечен |
| 5 | `user.id` ∈ `cfg.allowedChatIds` | **обязательна для этого проекта** | в проекте уже есть `ALLOWED_CHAT_IDS`; иначе любой, кто открыл Mini App, получит доступ к `opencode` |
| 6 | Игнорировать `initDataUnsafe` на сервере | **обязательна** | документация дважды: *«Data from this field should not be trusted»* |

**Про `initDataUnsafe`.** Это объект-зеркало `initData`, разобранный из query-строки. Он не подписан отдельно и не зашифрован. Допустимое использование — **только на клиенте** для UX (имя пользователя, `start_param`, определение темы). На сервер — только `initData` и только после HMAC. Документация формулирует это как «You should only use data from initData on the bot's server and only after it has been validated».

**Про `start_param`.** Заполняется из `startapp`/`startattach` и дублируется в GET-параметр `tgWebAppStartParam`, чтобы UI мог отрисовать нужный экран сразу. Присутствует в `WebAppInitData` ([#webappinitdata](https://core.telegram.org/bots/webapps#webappinitdata)). **Серверная валидация `start_param` обязательна** — иначе UI можно заставить открыть чужой проект/задачу подделанным deep link.

**Third-party validation (Ed25519).** С Bot API 8.0 сторонние обработчики (Mini App builders, SDK) могут валидировать `initData` **без знания токена**: проверяется base64url-подпись `signature` поля, data-check-string начинается с `<bot_id>:WebAppData\n`, ключи — опубликованные Telegram:

- Test: `40055058a4ee38156a06562e52eece92a771bcd8346a8c4615cb7376eddf72ec`
- Production: `e7bf03a2fa4602af4580703d88dda5bb59f32ed8b02a56c187fe7d34caed242d`

**Для нашего случая это бесполезно.** Мы сами владеем токеном, поэтому HMAC-путь проще и не требует third-party. Фиксировать как «полезно, если UI-логика уедет в чужой SDK» — сейчас не нужно.

---

### A.4. Полная поверхность `window.Telegram.WebApp` (актуально на Bot API 10.3)

Источник для всей таблицы: таблица полей и методов в [Mini Apps → Initializing Mini Apps](https://core.telegram.org/bots/webapps#initializing-mini-apps). Всё, чего нет в этой таблице, помечено.

### Поля

| Поле | Что делает | Годится ли здесь |
|---|---|---|
| `initData` | Подписанная query-строка для серверной валидации | **ДА — единственный источник авторизации** |
| `initDataUnsafe` | То же, но недоверенное; только UX на клиенте | ДА, только для отображения |
| `version` | Версия Bot API в клиенте пользователя | ДА, для feature-detection |
| `platform` | `ios` / `android` / `macos` / `tdesktop` / `weba` / … | ДА — разные лаунчеры туннеля |
| `colorScheme` | `light` / `dark`; также `var(--tg-color-scheme)` | ДА — для тёмной темы |
| `themeParams` | 12 цветов темы, все как `var(--tg-theme-*)` | **ДА — обязателен**, это основа темизации |
| `viewportHeight` | Высота видимой области; обновляется в реалтайме | Да, но для «прибития к низу» использовать нельзя — документация прямо это запрещает |
| `viewportStableHeight` | Высота в последнем стабильном состоянии; есть как CSS-переменная | **ДА — для sticky-футера/таб-бара** |
| `isExpanded` | Развёрнут ли Mini App на максимум | ДА |
| `isActive` (8.0+) | Активен ли (не свёрнут) | Да — для паузы polling при сворачивании |
| `isFullscreen` (8.0+) | Полноэкранный режим | Нет — не медиа-приложение |
| `isOrientationLocked` (8.0+) | Заблокирована ли ориентация | Нет |
| `isClosingConfirmationEnabled` | Включено ли подтверждение закрытия | Да — включать на Tasks, если идёт долгая задача |
| `isVerticalSwipesEnabled` | Разрешены ли вертикальные свайпы закрытия | **ДА — см. ниже** |
| `headerColor`, `backgroundColor`, `bottomBarColor` | Текущие цвета `#RRGGBB` | ДА |
| `safeAreaInset` (8.0+) | `{top,bottom,left,right}` под вырез/системные панели | **ДА — обязателен на iPhone** |
| `contentSafeAreaInset` (8.0+) | Safe area с учётом UI Telegram (в т.ч. таб-бара) | **ДА — обязателен, иначе таб-бар перекроет контент** |
| `BackButton` | Кнопка «назад» в шапке Telegram | **ДА — обязателен для 4-табовой навигации** |
| `MainButton` / `SecondaryButton` | Нижние кнопки Telegram (класс называется `BottomButton` с 7.10) | ДА — `showProgress()` для долгих задач |
| `SettingsButton` | Пункт контекстного меню «Settings» | Да — для «More» |
| `HapticFeedback` | `impactOccurred` / `notificationOccurred` / `selectionChanged` | ДА — дешёвый тактильный отклик на действия |
| `CloudStorage` | До 1024 items на юзера, ключи `[A-Za-z0-9_-]{1,128}`, значения ≤4096 символов | ДА — кэш последней вкладки/состояния UI |
| `BiometricManager` | `init()`, `requestAccess`, `authenticate`, `updateBiometricToken`, `openSettings` | Нет — личный бот, телефон хозяина |
| `Accelerometer` / `DeviceOrientation` / `Gyroscope` (8.0+) | сенсоры | Нет |
| `LocationManager` (8.0+) | геолокация | Нет |
| `DeviceStorage` (9.0+) | локальное хранилище устройства | Может пригодиться вместо `CloudStorage`, но `CloudStorage` проще |
| `SecureStorage` (9.0+) | защищённое локальное хранилище | Нет |

### Методы

| Метод | Что делает | Годится ли здесь |
|---|---|---|
| `ready()` | Прячет placeholder-заглушку и показывает Mini App | **ДА, вызвать как можно раньше** — иначе заглушка висит до полной загрузки |
| `expand()` | Развернуть на максимум | **ДА** — сразу на входе, чтобы не было «шторки на половину экрана» |
| `close()` | Закрыть Mini App | ДА |
| `setHeaderColor(color)` | цвет шапки `#RRGGBB` либо `bg_color`/`secondary_bg_color` | ДА |
| `setBackgroundColor(color)` | цвет фона | ДА |
| `setBottomBarColor(color)` (7.10+) | цвет нижней панели + navigation bar на Android | **ДА — под цвета таб-бара** |
| `isVersionAtLeast(v)` | feature detection | **ДА** |
| `onEvent(type, h)` / `offEvent(type, h)` | подписка на события | **ДА** |
| `onEvent('themeChanged')` | смена темы; новая тема в `this.themeParams` | **ДА — обязателен, тема может смениться в любой момент** |
| `disableVerticalSwipes()` | Запретить свайп для закрытия/сворачивания | **ДА для этого проекта — см. ниже** |
| `enableVerticalSwipes()` | Разрешить обратно | Только если own-gestures не конфликтуют |
| `enableClosingConfirmation()` / `disableClosingConfirmation()` | Диалог подтверждения при закрытии | **ДА** — на `Tasks` при running-задаче |
| `requestFullscreen()` / `exitFullscreen()` (8.0+) | полный экран | Нет |
| `lockOrientation()` / `unlockOrientation()` (8.0+) | фиксация ориентации | Нет |
| `showPopup(params, cb)` | нативный попап, 1–3 кнопки, `message` 1–256 символов | ДА — подтверждения опасных действий |
| `showAlert(msg, cb)` | нативный алерт с кнопкой Close | ДА — «нет доступа», «туннель упал» |
| `showConfirm(msg, cb)` | OK/Cancel, callback получает boolean | **ДА** — «отменить задачу?» |
| `openTelegramLink(url)` | открыть t.me-ссылку **внутри** Telegram; Mini App **не** закрывается (с 7.0) | **ДА** — «открыть чат с ботом», `?startapp=`-навигация |
| `openLink(url[, options])` | открыть во внешнем браузере; вызывать **только в ответ на действие пользователя** | ДА — ссылки на PR/CI |
| `shareToStory(media_url[, params])` (7.8+) | редактор Telegram-сторис; `media_url` — **HTTPS-URL** | Нет |
| `shareMessage(msg_id, cb)` (8.0+) | диалог «поделиться сообщением бота»; нужен `PreparedInlineMessage` от `savePreparedInlineMessage` | Нет — нет смысла шарить ответ агента |
| `downloadFile(params[, cb])` (8.0+) | **нативный промпт на скачивание файла**; `params = {url (HTTPS), file_name}` | **ДА — для вкладки Files** |
| `sendData(data)` | ≤4096 байт сервис-сообщение боту; **Mini App закрывается**; только для Keyboard button | **НЕТ** |
| `switchInlineQuery` (6.7+) | вставка inline-запроса в поле ввода | Нет |
| `showScanQrPopup` / `closeScanQrPopup` (6.4+) | сканер QR | Нет |
| `readTextFromClipboard` (6.4+) | **только для Mini App из attachment menu** → недоступно | НЕТ |
| `requestWriteAccess` (6.9+) | разрешение боту писать пользователю | Нет — `ALLOWED_CHAT_IDS` уже решает |
| `requestContact` (6.9+) | запрос телефона | Нет |
| `requestChat(req_id, cb)` (9.6+) | выбор чата | Нет |
| `addToHomeScreen()` / `checkHomeScreenStatus()` (8.0+) | иконка на рабочий стол | Нет |
| `requestEmojiStatusAccess` / `setEmojiStatus` (8.0+) | эмодзи-статус | Нет |
| `hideKeyboard()` (9.1+) | скрыть экранную клавиатуру | **ДА** — при скролле в чате |
| `openInvoice(url[, cb])` | платёж | Нет |

### Чего НЕТ — важно не выдумывать

| Заявлено в задании | Вердикт |
|---|---|
| `BackgroundFill` | **НЕ ЯВЛЯЕТСЯ полем `Telegram.WebApp`.** В Bot API есть класс `BackgroundFill` (`BackgroundFillSolid` / `BackgroundFillGradient` / `BackgroundFillFreeformGradient`, [Bot API → BackgroundFill](https://core.telegram.org/bots/api#backgroundfill)), но он используется в `InputProfilePhoto` и `background_custom_emoji_id`-связанных типах, а **в таблице `WebApp` отсутствует**. Для фона Mini App есть только `setBackgroundColor` (строка `#RRGGBB`). **Не использовать.** |
| `devicePixelRatio` | В таблице `WebApp` **отсутствует**. Фактически это обычный `window.devicePixelRatio`, но как метод/поле Telegram API я его подтвердить **не могу — UNVERIFIED**. Использовать как `window.devicePixelRatio` с вердиктом «не из Telegram API». |
| `addEventListener` | В текущей документации методов только `onEvent` / `offEvent`. Старые версии `telegram-web-app.js` имели `addEventListener` как legacy-алиас. **Наличие в v?63 не подтверждено — UNVERIFIED. Использовать `onEvent`.** |
| `showFilePopup` | **В документации не существует.** Ближайшее — `downloadFile` (8.0+), но это промпт на **скачивание**, а не файловый выбор. Для выбора файла — обычный `<input type="file">`. |
| `viewportChanged` как метод | Это **событие**, не метод: `onEvent('viewportChanged', ({isStateStable}) => …)`. В обработчике `this === Telegram.WebApp`. |
| `viewportStableHeight` как событие | Поле + документированное событие `viewportChanged` с `isStateStable=true` как сигнал «стабильное состояние обновилось». |

### Практический вывод по `disableVerticalSwipes`

Документация прямо советует: *«For user convenience, it is recommended to always enable swipes unless they conflict with the Mini App's own gestures»* и *«This method is useful if your Mini App uses swipe gestures that may conflict with the gestures for minimizing and closing the app»*. Для UI с нижним таб-баром Home/Tasks/Files/More и горизонтальным скроллом в списках — **конфликт реален**, вызывать `disableVerticalSwipes()` на старте.

---

### A.5. Файлы и вложения из Mini App

| Возможность | Статус | Детали |
|---|---|---|
| `<input type="file">` + `FormData` | **РАБОТАЕТ**, это обычный браузерный API внутри WebView | Файл загружается **POST-ом на наш бэкенд**, не в Telegram |
| `navigator.mediaDevices.getUserMedia` (камера) | **ПРОБЛЕМАТИЧНО на iOS** | Открытый баг: [tma.js #748](https://github.com/Telegram-Mini-Apps/tma.js/issues/748) — `getUserMedia({video:true})` в Mini App на iOS отдаёт чёрный поток (в Safari тот же код работает; на Android и macOS — работает). Статус `open`, помечен `Telegram bug` |
| `MediaRecorder` | Зависит от `getUserMedia` → на iOS та же проблема | См. A.6 |
| Telegram-нативный выбор файла | **НЕ СУЩЕСТВУЕТ** в Mini App API | Нет аналога `startattach`-выбора файла |
| `downloadFile(params)` (8.0+) | **ДА** — нативный промпт «скачать файл» | `params.url` — **HTTPS URL**. Документация отдельно требует заголовки ответа: `Content-Disposition: attachment; filename="<file_name>"` и **`Access-Control-Allow-Origin: https://web.telegram.org`**, иначе скачивание может не сработать, особенно на web-платформе ([DownloadFileParams](https://core.telegram.org/bots/webapps#downloadfileparams)) |
| Лимит размера | Наш бэкенд режет до 50 MB, потом шлёт в Telegram | Совпадает с официальным: *«Bots can currently send files of any type of up to 50 MB in size»* ([FAQ → Handling Media](https://core.telegram.org/bots/faq#how-do-i-upload-a-large-file)). Локально уже: `src/core/files.ts` `MAX_OUTBOUND_BYTES = 50 * 1024 * 1024`, `MAX_PHOTO_BYTES = 10 * 1024 * 1024` |
| Лимит скачивания через `getFile` | 20 MB | *«Please note that this will only work with files of up to 20 MB in size»*. Для файлов >20 MB нужен локальный Bot API сервер — **не наш случай** ([FAQ](https://core.telegram.org/bots/faq#how-do-i-download-files)) |

**Связь с `startattach` / `download_file`.** Это **разные механизмы, не связанные с Mini App**:

- `startattach` — добавление бота в **attachment menu**, доступно только крупным рекламодателям (production) / всем ботам на тестовом DC. Файл выбирает **пользователь в Telegram**, Mini App тут ни при чём.
- `downloadFile` (Mini App) — Mini App **просит** у пользователя разрешение скачать файл **по HTTPS-ссылке**. То есть файл всё равно должен где-то лежать по HTTPS — то есть **на нашем бэкенде за туннелем**.

Итог для вкладки Files: `<input type="file">` → `multipart/form-data` POST на `/api/upload` → бэкенд кладёт в `WORK_ROOT` → шлёт в Telegram через `sendDocument`/`sendPhoto` (лимиты уже есть в `core/files.ts`). Для скачивания — `downloadFile({url: <tunnel>/api/files/<name>, file_name})` + обязательные заголовки.

---

### A.6. Голосовые сообщения из Mini App

**Что НЕвозможно:** отправить Telegram-голосовое сообщение (waveform, длительность, «🎤»-стик) напрямую из Mini App. В `Telegram.WebApp` **нет ни одного метода отправки медиа в чат**. Полный перечень «отправляющих» методов: `sendData` (≤4096 байт сервис-сообщение), `shareMessage` (только `PreparedInlineMessage`), `switchInlineQuery`. Ни один не принимает аудио.

**Что возможно — единственный рабочий путь:**

```
Mini App: MediaRecorder → Blob (webm/opus или mp4/aac)
   └─► POST /api/voice  (multipart)  ──►  бэкенд на ПК
                                             └─► ffmpeg → OGG/Opus
                                                   └─► bot.api.sendVoice(chatId, ogg)
```

Транскрипция уже есть: `src/voice/index.ts` `transcribeVoice()` умеет читать OGG/Opus через whisper.cpp, `src/voice/transcribe.ts` — сама транскрипция, `FFMPEG_BIN`/`WHISPER_BIN` уже в конфиге.

**Риск на iOS (важно).** Цепочка начинается с `getUserMedia({audio:true})`. Прямого багрепорта про **аудио** в Mini App на iOS я найти не смог — **[UNVERIFIED]**. Но:
- видео в Mini App на iOS отдаёт чёрный поток (tma.js #748, открыт, помечен `Telegram bug`);
- исторически `getUserMedia` в WKWebView был сломан (WebKit 208667, 221031 — обе `RESOLVED`, но это 2020–2021);
- документация Telegram **ничего не обещает** по микрофону.

**Вывод, который надо зафиксировать до того, как строить фичу:** голос из Mini App надо проектировать с деградацией — Android-рабочий путь + кнопка «открыть чат с ботом» (`openTelegramLink`) для iOS, где пользователь просто диктует в чат как сегодня. Проверять на реальном iPhone в тестовом DC, а не доверять десктопу.

---

### A.7. Производительность

**Официальные указания** ([Design Guidelines](https://core.telegram.org/bots/webapps#design-guidelines) и [Bot API 8.0 → Hardware-specific Optimizations](https://core.telegram.org/bots/webapps#june-11-2026)):
- *«All included animations should be smooth, ideally 60fps.»*
- *«For Android devices, consider the additional information in the User-Agent and adjust for the device's performance class, **minimizing animations and visual effects on low-performance devices**.»*

**Формат User-Agent на Android** ([Additional Data in User-Agent](https://core.telegram.org/bots/webapps#additional-data-in-user-agent)):

```
Telegram-Android/{app_version} ({manufacturer} {model}; Android {android_version}; SDK {sdk_version}; {performance_class})
```

`performance_class` ∈ `LOW` | `AVERAGE` | `HIGH`. Документация рекомендует использовать это для оптимизации.

Пример из документации:
```
Mozilla/5.0 (Linux; Android 14; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/113.0.5672.136 Mobile Safari/537.36 Telegram-Android/11.3.3 (Google sdk_gphone64_arm64; Android 14; SDK 34; LOW)
```

**Как детектить слабое устройство в браузере** (практическая реализация, документация даёт только User-Agent):

```ts
const ua = navigator.userAgent;
const m = ua.match(/Telegram-Android\/[\d.]+\s+\([^)]*;\s*([^;)]+)\)/);
const perfClass = m ? m[1].trim() : null;   // 'LOW' | 'AVERAGE' | 'HIGH' | null (iOS/desktop)
const reduced =
  perfClass === 'LOW' ||
  matchMedia('(prefers-reduced-motion: reduce)').matches ||
  (navigator.hardwareConcurrency ?? 8) <= 4;
```

Резервные сигналы (вне Telegram API, стандартные браузерные): `prefers-reduced-motion`, `navigator.hardwareConcurrency`, `navigator.deviceMemory`, `matchMedia('(update: slow)')`.

При `reduced === true`: отключить blur/backdrop-filter, теней, параллакс, длинные transition; оставить только opacity ≤150 мс. **Осторожно:** 60 FPS — рекомендация документации, а не жёсткое требование; на `LOW` документация прямо велит упрощать эффекты.

---

## B. Хостинг / достижимость — блокирующий вопрос

Исходные условия: бот и Mini App-бэкенд на домашнем Windows-ПК, **нет публичного IP, нет проброса портов, нет банковской карты**.

### B.1. Cloudflare Quick Tunnel

Источник: [Cloudflare → Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/) (last updated Sep 30, 2026).

| Параметр | Значение (документировано) |
|---|---|
| Аккаунт Cloudflare | **Не нужен.** *«You do not need a Cloudflare account or domain.»* |
| Карта | Не требуется (нет биллинга вообще) |
| Команда | `cloudflared tunnel --url http://localhost:8080` |
| Домен | `*.trycloudflare.com`, **случайный при каждом старте**: *«The hostname changes each time you create a Quick Tunnel.»* |
| Uptime | *«Quick Tunnels have no uptime guarantee.»* |
| In-flight запросы | **до 200**, дальше `429` |
| **SSE** | **«Quick Tunnels do not support Server-Sent Events (SSE).»** ← **убийственно для стриминга AI-ответа** |
| Ограничение по назначению | *«Quick Tunnels are for testing and development. For production, create a Cloudflare Tunnel.»* |
| Доп. фичи | `--allowed-mail` — OTP по email; работает только в интерактивном браузере |

Дополнительно: баг [cloudflared #1449](https://github.com/cloudflare/cloudflared/issues/1449) «SSE over GET is not streamed in real-time on Quick Tunnel» — историческое подтверждение той же проблемы.

**Совместимость с long-polling ботом.** Не конфликтует технически: бот ходит к `api.telegram.org` сам, туннель — отдельный исходящий процесс. НО: `cloudflared` на Windows ставятся как сервис, а Quick Tunnel по своей природе dev-инструмент; 200 in-flight + отсутствие SSE делают его непригодным для постоянно работающего Mini App.

**Вердикт: только для отладки, не для продакшена.**

### B.2. Cloudflare Named Tunnel

Источник: [Create a locally-managed tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/create-local-tunnel/) (Aug 25, 2026).

**Пререквизиты, дословно:**
> *«Add a website to Cloudflare.»*
> *«Change your domain nameservers to Cloudflare.»*

То есть **нужен собственный домен, купленный и переведённый NS на Cloudflare**. Домен — платная покупка (~$10–15/год за дешёвый TLD, требуется карта для покупки, чего у владельца нет).

Плюсы: стабильный URL, поддержка SSE, `cloudflared` как Windows-сервис, бесплатный tier Zero Trust.

**Вердикт: технически лучший вариант, но блокируется отсутствием карты на покупку домена. Отложить.**

### B.3. Tailscale Funnel

Источники: [Tailscale Funnel](https://tailscale.com/kb/1223/funnel), [tailscale funnel CLI](https://tailscale.com/docs/reference/tailscale-cli/funnel), [Tailscale Pricing](https://tailscale.com/pricing).

| Параметр | Значение |
|---|---|
| План | **Personal $0 «Free forever»**; таблица сравнения показывает `Funnel` ✓ в колонке Personal |
| Карта | Не требуется: Personal — $0 навсегда, без биллинга |
| Аккаунт | Нужен бесплатный (email / Google / GitHub). Funnel **доступен на всех планах** — *«Tailscale Funnel is available for all plans»* |
| Статус | Beta, но в beta с 2024 и работает |
| **Стабильный URL** | **ДА** — *«Funnels have a predictable, stable DNS name, like amelie-workstation.pango-lin.ts.net. This lets you set or share your DNS name one time. Then, it's accessible anytime you turn your Funnel on.»* |
| Свой домен | **НЕ нужен** — домен `tailnet-name.ts.net` выдаётся Tailscale |
| TLS | Автоматический валидный сертификат (Let's Encrypt), браузеру доверенный |
| Порты | Только `443`, `8443`, `10000` |
| Proxy | **TCP-прокси, TLS терминируется на ноде**, Funnel-релей **не расшифровывает** трафик |
| Пропускная способность | *«Traffic sent over a Funnel is subject to non-configurable bandwidth limits.»* Точные цифры **не опубликованы** |
| SSE / long-lived | **Явно НЕ запрещено.** Funnel — это прозрачный TCP-прокси, значит SSE должен работать. **Официального подтверждения «Funnel supports SSE» я не нашёл — UNVERIFIED**, но и запрета в docs нет, в отличие от Quick Tunnel, где запрет выписан явно |
| Windows | Поддерживается; официальные примеры содержат `c:\Users\Amelie> tailscale funnel c:\tmp\public` ([Funnel examples](https://tailscale.com/kb/1247/funnel-examples)) |
| Автоперезапуск | С флагом `--bg` Funnel **переживает ребут и `tailscale down`/`up`** |

**Риски:** (1) Funnel — публичный endpoint, нужна собственная аутентификация (у нас она будет: `initData`-валидация); (2) Let's Encrypt rate limits — при частое пересоздании можно получить **блокировку на 34 часа** (документировано в Funnel docs); (3) bandwidth limits не настраиваются и не задокументированы.

**Вердикт: лучший cardless-вариант со стабильным URL.**

### B.4. Остальные туннели

| Сервис | Цена | Карта | Стабильный URL | Auth | Домены/лимиты | Windows | Вердикт |
|---|---|---|---|---|---|---|---|
| **ngrok Free** | **$0** + **$5 одноразового кредита** | **Не требуется для HTTP/S.** Карта требуется только для TCP endpoints ([ngrok blog, Jun 13 2024](https://ngrok.com/blog/tcp-endpoints-require-verification)) | **ДА** — 1 dev domain на аккаунт, например `xxx.ngrok-free.app`, привязан к аккаунту | Нет (для API) | 1 GB/мес трафика, 20k HTTP-запросов/мес, 4000 req/min, 3 endpoint, 1 пользователь, 24 ч retention логов | Да | **Проблема: interstitial page.** Подробнее ниже |
| **Tailscale Serve** | $0 | нет | Да | Только внутри tailnet | — | Да | **Не подходит** — не публичный |
| **localhost.run** | Free forever | нет | **НЕТ** — *«Domain names change regularly»*, плюс *«speed limit»* | Нет | Регистрация продлевает жизнь домена | Да (через SSH) | Отстойчивый, непредсказуемый |
| **pinggy.io Free** | **$0 «Free for life»**, unlimited data transfer | нет (регистрация по email) | **НЕТ** — *«60 minutes tunnel timeout»* + *«Random subdomains»* | HTTP Basic / bearer / IP whitelist | 60 мин таймаут | Да | Отстойчивый: URL меняется каждый час |
| **bore / bore.pub** | Free | нет | НЕТ (порт назначается случайно) | Опционально `--secret` | — | Да (prebuilt binaries) | **НЕПРИГОДЕН: только сырой TCP, без TLS.** `bore.pub:PORT` — не HTTPS, `WebAppInfo.url` его не примет |
| **croc** | Free | нет | НЕТ | Да (code phrase) | — | Да | **НЕПРИГОДЕН по той же причине** — TCP/relay без публичного TLS для HTTP |
| **zrok** | Free tier есть | — | — | — | — | — | **UNVERIFIED — не проверял, не включаю в рейтинг** |

#### Деталь про ngrok free: interstitial page

Из [ngrok → Free Plan Limits](https://ngrok.com/docs/pricing-limits/free-plan-limits):
> *«ngrok shows an interstitial page in front of **all HTML browser traffic** on the free tier… This does not impact users serving APIs or accessing ngrok endpoints programmatically.»*

Обход: заголовок `ngrok-skip-browser-warning` **или** нестандартный `User-Agent`.

**Ключевой вывод, который меняет архитектуру:** interstitial показывается **только при браузерной навигации**. Первичную загрузку Mini App делает именно браузер (WebView) → **interstitial увидит пользователь, и заголовок выставить нельзя**. Но `fetch()` внутри страницы — программный доступ → interstitial не будет.

Отсюда: **ngrok Free годится только если UI лежит на GitHub Pages, а через туннель идёт исключительно API.** Как транспорт для всего подряд — не годится.

---

### B.5. Ветка «без туннеля»: статический UI на чужом хостинге

**Есть ли в Telegram хостинг статики?** **Нет.** Ни в Bot API, ни в Mini Apps API нет метода «загрузить статику» или «отдать файл по Bot API URL». Проверено по полному списку методов Bot API. Telegram — не CDN.

**Разрешён ли `WebAppInfo.url` на сторонний хост типа GitHub Pages?** **Да.** `WebAppInfo.url` — просто «An HTTPS URL», никаких требований к домену или регистрации. Реестр «Allowed URLs» есть только у Telegram Login (OIDC) — другой продукт. Это подтверждается и тем, что Mini App URL на `t.me` демонстрационно открывается с любого HTTPS-хоста (в т.ч. `jsfiddle.net` в багрепорте tma.js #748).

**Проблема: браузер не может хранить bot token.** Но и не должен:
- `initData` подписан HMAC'ом от токена → **проверяется на бэкенде**;
- на клиенте живёт только `initData` (query-строка) и `initDataUnsafe` (для UX);
- токен живёт **только** в `.env` на ПК и используется **только** для `setChatMenuButton`/`sendVoice`.

То есть статический UI на GitHub Pages **безопасен**, пока бэкенд валидирует HMAC. Нужно лишь:
1. CORS: бэкенд отвечает `Access-Control-Allow-Origin: https://<user>.github.io`.
2. Все состояние/команды идут через `/api/*`.
3. Origin hardening из Bot API 10.2 **не мешает**: страница сама является origin'ом Mini App, её `Telegram.WebApp.*` работают; кросс-origin `fetch` — обычный CORS.

**Плюсы GitHub Pages:** бесплатно, без карты (GitHub Free), HTTPS из коробки, деплой по `git push`, CDN по миру, 100% аптайм.
**Минусы:** два деплоя (бэкенд локально, фронт на Pages), CORS вместо same-origin, латентность каждого API-запроса всё равно зависит от туннеля.

---

### B.6. Статика отдельно vs всё за одним туннелем

| Критерий | Вариант 1: **всё за туннелем** (Funnel проксирует и UI, и API) | Вариант 2: **UI на GitHub Pages + API за туннелем** |
|---|---|---|
| Origins | **один** | два (`github.io` + `*.ts.net`) |
| CORS | не нужен | нужен, плюс preflight на POST с кастомными заголовками |
| Обновление UI | требует рестарта/релоада туннеля | `git push`, мгновенно, независимо от ПК |
| Латентность UI | каждый байт через туннель → заметно на мобильном интернете | UI с CDN, мгновенно |
| Латентность API | одинаковая в обоих | одинаковая |
| TLS | один сертификат (Tailscale) | два (Let's Encrypt + GitHub) |
| Движущихся частей | **2** (бот+туннель) | **3** (бот+туннель+CI Pages) |
| Что увидит юзер, когда туннель упал | **ничего — страница не загрузится вообще**, WebView покажет свою сетевую ошибку | UI загрузится, покажет понятный «бот недоступен» |
| Origin hardening (10.2) | нет риска | риск, если не уследить |
| Рекомендация | **для старта** | оптимизация, когда упрётесь в латентность |

---

### B.7. Ранжированная рекомендация

| # | Вариант | Вердикт в одну строку |
|---|---|---|
| **1** | **Tailscale Funnel** (`https://<device>.<tailnet>.ts.net`) | **БЕЗ КАРТЫ, стабильный URL, валидный TLS, TCP-прокси ⇒ SSE не запрещён — единственное, что проходит все фильтры.** |
| 2 | UI на GitHub Pages + Tailscale Funnel для API | Тот же туннель, но быстрый UI и внятная деградация при падении туннеля; дороже в настройке (CORS). |
| 3 | UI на GitHub Pages + ngrok Free для API | Работает, но 1 GB/мес и 20k запросов/мес — потолок, исчерпается за часы активного использования. |
| 4 | Cloudflare Named Tunnel | Лучший по возможностям (SSE, сервис, стабильность), но **требует купленного домена** → нужна карта. Отложить. |
| 5 | Cloudflare Quick Tunnel | **SSE запрещён документацией** + случайный URL + нет гарантии аптайма → только для локальной отладки. |
| 6 | Cloudflare Pages + отдельный API | Статика бесплатна и без карты, но **не решает главную задачу** — где живёт API. |
| 7 | localhost.run | Бесплатно и без аккаунта, но домены меняются регулярно + ограничение скорости. |
| 8 | pinggy Free | Бесплатно навсегда, но **таймаут туннеля 60 минут** ⇒ URL умирает каждый час. |
| 9 | Tailscale Serve | Не публичный — не подходит по определению. |
| 10 | bore / bore.pub / croc | **Дисквалифицированы: нет публичного HTTPS.** `WebAppInfo.url` их не примет. |
| — | zrok | **UNVERIFIED** — не исследовался. |

---

### B.8. Рекомендованная архитектура (cardless, personal)

**Вариант 1 — «всё за одним туннелем», стартовый.**

```
┌──────────────────────────────────────────────────────────────────────────┐
│  Телефон владельца                                                        │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │ Telegram → кнопка меню бота (MenuButtonWebApp)                    │  │
│  │   или t.me/<bot>/app                                               │  │
│  │            │  WebView открывает URL                                │  │
│  │            ▼                                                       │  │
│  │   https://desktop-abc123.tailnet-xyz.ts.net/                       │  │
│  │   ├─ <script src="telegram.org/js/telegram-web-app.js?63">         │  │
│  │   └─ Mini App: Home / Tasks / Files / More                         │  │
│  │      initData ─────────────────────────────────────┐               │  │
│  └─────────────────────────────────────────────────────┼───────────────┘  │
└────────────────────────────────────────────────────────┼──────────────────┘
                                                         │ HTTPS
                    ┌────────────────────────────────────┴──────────────┐
                    │  Публичный интернет                                │
                    │  ┌──────────────────────────────────────────────┐  │
                    │  │ Tailscale Funnel ingress (гео-реплики)        │  │
                    │  │  TLS терминируется на НОДЕ, реле не видит    │  │
                    │  │  содержимого (чистый TCP-прокси)             │  │
                    │  └───────────────────┬──────────────────────────┘  │
                    └──────────────────────┼─────────────────────────────┘
                                           │ WireGuard (P2P или DERP)
   ┌───────────────────────────────────────┴──────────────────────────────┐
   │  Домашний Windows PC                                                     │
   │                                                                          │
   │  ┌────────────────────────────────────────────────────────────────────┐ │
   │  │  tsnet.exe / tailscaled  (Windows-сервис, автостарт)               │ │
   │  └───────────────────────────┬────────────────────────────────────────┘ │
   │                              │ http://127.0.0.1:8787                  │
   │  ┌───────────────────────────▼────────────────────────────────────────┐ │
   │  │  tg-agent-bridge (Node 22, единственный процесс)                   │ │
   │  │  ├─ HTTP-сервер :8787   ← СРАЗУ ДОБАВИТЬ, сегодня его нет         │ │
   │  │  │   ├─ GET  /            → index.html + miniapp.js                │ │
   │  │  │   ├─ GET  /api/state                                   │ │
   │  │  │   ├─ GET  /api/tasks                                   │ │
   │  │  │   ├─ GET  /api/files                → Content-Disposition    │ │
   │  │  │   ├─ POST /api/upload  (multipart, ≤50 MB)                    │ │
   │  │  │   ├─ POST /api/voice   (multipart → ffmpeg → sendVoice)        │ │
   │  │  │   └─ GET  /api/stream  (SSE, поток ответа агента)              │ │
   │  │  ├─ ГЕРОЙ: validateInitData()  HMAC-SHA256 + timingSafeEqual      │ │
   │  │  │           + auth_date ≤ TTL + user.id ∈ ALLOWED_CHAT_IDS       │ │
   │  │  ├─ grammY Bot  ── long polling ──► api.telegram.org               │ │
   │  │  ├─ SQLite  data/bridge.db   (уже существует)                     │ │
   │  │  └─ opencode / cursor / cline процессы (уже существуют)            │ │
   │  └────────────────────────────────────────────────────────────────────┘ │
   │  .env:  BOT_TOKEN=…   (единственное место, где живёт токен)           │
   └──────────────────────────────────────────────────────────────────────────┘

  Автоприменение URL в Telegram:
    node -e "…" → bot.api.setChatMenuButton({ menu_button:{
                    type:'web_app', text:'Открыть',
                    web_app:{ url:'https://desktop-abc123.tailnet-xyz.ts.net/' }}})
```

**Почему именно этот вариант для старта:** один origin (нет CORS), ноль зависимостей от GitHub, URL не нужно парсить и подставлять в конфиг — он **константный**, поэтому `setChatMenuButton` можно вызвать один раз и забыть.

**Вариант 2 — оптимизация позже.** Фронт переезжает на GitHub Pages, туннель остаётся, но проксирует только `/api/*`. Тогда появляется CORS, зато UI грузится с CDN и может показать внятную ошибку соединения при падении туннеля. Переход дешёвый: бэкенд просто начинает отдавать `Access-Control-Allow-Origin`.

---

### B.9. Точные команды для Windows

#### Шаг 1 (один раз): регистрация и включение Funnel

Funnel требует: Tailscale v1.38.3+, включённые **MagicDNS** и **HTTPS-сертификаты**, и node attribute `funnel` в policy-файле. `tailscale funnel` сам поднимает браузер, прописывает атрибут и заказывает сертификат.

```powershell
# Установка
winget install tailscale.tailscale

# Вход в аккаунт (откроется браузер; карта не нужна — план Personal $0)
tailscale up

# Включить HTTPS-сертификаты для tailnet (иначе Funnel не поднимется)
tailscale cert
```

#### Шаг 2: запуск туннеля + автоприменение URL

```powershell
# Один раз: поднять Funnel в фоне на 443, проксируя локальный бэкенд.
# --bg  => переживает ребут и `tailscale down`/`up`
# --yes => без интерактивных промптов
tailscale funnel --bg --yes --https=443 http://127.0.0.1:8787
```

Вывод команды (`tailscale funnel status`) содержит hostname:

```
Available on the internet:

https://desktop-abc123.tailnet-xyz.ts.net

|-- / proxy http://127.0.0.1:8787
```

#### Шаг 3: получить URL программно и засунуть его в бота

Официальная формат вывода подтверждена документацией (см. выше), поэтому парсинг по regex безопасен:

```powershell
# one-liner: достать базовый URL Funnel
$u = ([regex]::Match((tailscale funnel status), 'https://[A-Za-z0-9.-]+\.ts\.net')).Value
$u   # → https://desktop-abc123.tailnet-xyz.ts.net

# сохранить для бота (НЕ в .env — это не секрет, но и не обязано быть секретом)
Set-Content -Path .\data\miniapp-url.txt -Value "$u/" -NoNewline
```

Внутри `tg-agent-bridge` (TypeScript, читать файл на старте, до `bot.start()`):

```ts
import { readFileSync } from 'node:fs';

function miniAppUrl(): string | null {
  try {
    const raw = readFileSync('data/miniapp-url.txt', 'utf8').trim();
    return /^https:\/\/[A-Za-z0-9.-]+\.ts\.net\/?$/.test(raw) ? raw : null;
  } catch { return null; }
}

// …в main(), рядом с probeRichSupport:
// 1) та же логика работает и для Quick Tunnel, если переименовать хост в regex
await bot.api.setChatMenuButton(miniAppUrl() ? {
  menu_button: {
    type: 'web_app',
    text: 'Панель',
    web_app: { url: miniAppUrl()! },
  },
} : { menu_button: { type: 'default' } });
```

**Альтернатива с меньшей связанностью:** бот сам спавнит `tailscale funnel status` / `cloudflared` через `child_process` и парсит URL из вывода. Плюс — не нужен внешний скрипт и файл. Минус — надо смириться с тем, что `cloudflared` пишет логи в **stderr** (точную строку формата я по документации **не проверял — UNVERIFIED**), и с platform-specific парсингом.

#### Вариант B: если Tailscale не хочется — Cloudflare Quick Tunnel

```powershell
winget install Cloudflare.cloudflared

cloudflared tunnel --url http://127.0.0.1:8787 --no-autoupdate 2>&1 |
  Tee-Object -FilePath .\data\cloudflared.log
```

URL надо **вытащить из лога** регуляркой вида `https://[a-z0-9-]+\.trycloudflare\.com` и сразу записать в `data/miniapp-url.txt` + вызвать `setChatMenuButton`. Формат строки лога в документации не приведён — **регулярку надо проверить на первой же попытке, не полагаться на память**.

Напоминание: **SSE через Quick Tunnel не работает** → стриминг ответа агента придётся делать на polling (опрос `/api/tasks/:id` раз в 1–2 с).

---

### B.10. Режимы отказа и что показывать в UI

| Симптом | Кто замечает | Что делать |
|---|---|---|
| Туннель упал, UI за Variant 1 | Юзер в WebView Telegram видит стандартную сетевую ошибку браузера | **Красивую ошибку показать нельзя — страница не приехала.** Компенсация: бот ловит падение туннеля и пишет сообщение в чат |
| Туннель упал, UI за Variant 2 | Юзер видит загруженный UI | **Показать полноэкранный баннер:** «Бот недоступен — туннель не поднят. Запусти на ПК `tailscale funnel --bg --yes --https=443 http://127.0.0.1:8787`». Детект — любой `fetch` вернул non-2xx или network error |
| Бэкенд жив, туннель жив, но бот офф | Юзер видит пустой UI | Отдавать с бэкенда флаг `botOnline: false` в `/api/state` и рендерить баннер «Бот остановлен» |
| `initData` не проходит HMAC | Юзер видит 401 | `Telegram.WebApp.showAlert('Сессия истекла — закрой и открой приложение заново')` + кнопка «Обновить» (`location.reload()`). **Ошибку валидации логировать, но текст пользователю не выдавать** |
| `user.id` ∉ `ALLOWED_CHAT_IDS` | Юзер — не хозяин | `showAlert('Доступ запрещён')` и **не отвечать ни на что**. Данные не отдавать |
| `auth_date` старше TTL | Долго открытый Mini App | Тихо обновить сессию (закрыть/открыть) либо переоткрыть `initData`; если нельзя — баннер «Сессия истекла» |
| Задача идёт > N минут | Юзер | `MainButton.showProgress(true)` + `enableClosingConfirmation()` |
| SSE отвалился | Юзер | Автоматический фолбэк на polling `/api/tasks/:id` каждые 2 с. Обязателен в любом случае — туннели обрывают long-lived соединения |

**Минимальный health-эндпоинт**, без которого половина таблицы не работает:

```
GET /healthz  →  200 { "ok": true, "bot": "@my_bot", "uptimeSec": 1234 }
```

---

### B.11. Нужна ли стабильность URL — да, и вот почему

1. **`setChatMenuButton` / `MenuButtonWebApp.web_app` — это сохранённая строка.** Telegram **не перезапрашивает** DNS и не знает, что туннель перезапустился. Сменился URL ⇒ кнопка открывает мёртвую страницу, пока бот не вызовет `setChatMenuButton` заново.
2. **Deep link `t.me/<bot>/<short_name>` ломается так же.** Он, физически, содержит hostname; Telegram открывает **его**, а не наш. Сменился туннель ⇒ битая ссылка. `?startapp=payload` не помогает — payload дойдёт, страница не загрузится.
3. **Закладки и ярлыки.** Если юзер добавил Mini App (`addToHomeScreen`, 8.0+), онконка сохраняет URL. Меняется URL — иконка битая.
4. **Кеш WebView.** Меняющийся hostname каждый раз — холодный кеш.

**Как с этим жить:**

| Механизм URL | Меняется? | Что делать |
|---|---|---|
| Funnel `*.ts.net` | **Нет** | Ничего. `setChatMenuButton` один раз при первом запуске |
| Cloudflare Named Tunnel | Нет | То же |
| ngrok Free dev domain | Нет (привязан к аккаунту) | То же |
| Cloudflare Quick Tunnel `trycloudflare.com` | **Да, каждый старт** | Бот обязан парсить лог и вызывать `setChatMenuButton` на каждом старте |
| localhost.run | Да, регулярно | То же + домен может протухнуть |
| pinggy Free | Да, каждый час | Не годится |

**Прямой ответ на вопрос про `startapp`:** deep link с payload'ом **работает только при стабильном URL**. Поэтому `start_param`-навигация (открыть конкретную задачу/проект из сообщения бота) проектируется **только** поверх решения со стабильным hostname. При переменном URL `startapp` становится непроверяемым мусором, и на сервере всё равно придётся валидировать `start_param` против whitelist, а не доверять ему.

**Дополнительно:** `MenuButtonWebApp.web_app` допускает `t.me`-ссылку вместо URL (см. A.1 п.2). Это элегантный ход — можно зашить `t.me/<bot>/app` в кнопку, и тогда её URL обновляется **только** в BotFather (разово при смене хоста), а не в рантайме. Цена: URL всё равно надо обновить в BotFather вручную при переезде на другой туннель.

---

## C. Сводный список источников

Все URL открыты **2026-10-03**. Колонка «Что подтвердил» — только то, что реально есть на странице.

| # | URL | Дата | Что подтвердил |
|---|---|---|---|
| 1 | https://core.telegram.org/bots/webapps | 2026-10-03 | Полная таблица полей/методов `WebApp`; 7 способов запуска; `sendData` только для Keyboard button; `initData`/`initDataUnsafe` предупреждения; HMAC-валидация (`WebAppData`); Ed25519 third-party ключи (test/prod); список событий; `themeParams` (12 цветов); `BackButton`/`BottomButton`/`HapticFeedback`/`CloudStorage`/`BiometricManager`/сенсоры; `safeAreaInset`/`contentSafeAreaInset`; рекомендация «60fps» и «minimizing animations… on low-performance devices»; формат Android-UA с `performance_class` `LOW/AVERAGE/HIGH`; attachment menu только для крупных рекламодадателей; `DownloadFileParams` требует `Content-Disposition` + `Access-Control-Allow-Origin: https://web.telegram.org`; **«test environment: you may use HTTP links without TLS»**; скрипт `telegram-web-app.js?63`; `mode=compact`; `startapp` в `start_param` + `tgWebAppStartParam`; рекомендация про vertical swipes; Telegram Login Allowed URLs (другой продукт) |
| 2 | https://core.telegram.org/bots/api | 2026-10-03 | `WebAppInfo.url` = **«An HTTPS URL of a Web App»**; changelog Bot API **10.2 (2026-07-14)**: hardening «disallowing the usage of Mini App methods from origins different from the original Mini App domain», auto-enabled **2026-07-20**; класс `BackgroundFill` существует, но **вне таблицы `WebApp`**; changelog 8.0/8.1 (`downloadFile`, `shareMessage`, `shareToStory`, `safeAreaInset`, `requestFullscreen`); `setWebhook` — порты 443/80/88/8443 и self-signed через `certificate` (**не применимо к Mini App**) |
| 3 | https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/ | 2026-10-03 | Quick Tunnels: **аккаунт и домен не нужны**; **«do not support Server-Sent Events (SSE)»**; **200 in-flight** запросов, дальше 429; **hostname меняется каждый раз**; **нет гарантии аптайма**; «for testing and development»; `--allowed-mail` только интерактивно |
| 4 | https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/create-local-tunnel/ | 2026-10-03 | Пререквизиты Named Tunnel: **«Add a website to Cloudflare»** + **«Change your domain nameservers to Cloudflare»** ⇒ домен обязателен; `cloudflared` ставится как сервис на Linux и Windows; порядок `login` → `create` → `route dns` → `run` |
| 5 | https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/ | 2026-10-03 | Модель outbound-only; `cloudflared` сам инициирует соединения ⇒ **не конфликтует с long polling** бота; Authenticated Origin Pulls неприменим |
| 6 | https://developers.cloudflare.com/pages/ | 2026-10-03 | Cloudflare Pages — бесплатно, «Available on all plans», лимит 500 деплоев/мес на Free; **но не решает задачу хостинга API** |
| 7 | https://tailscale.com/kb/1223/funnel | 2026-10-03 | Funnel: **«available for all plans»**, beta; требует Tailscale v1.38.3+, **MagicDNS**, **HTTPS-сертификаты**, node attribute `funnel`; порты **только 443/8443/10000**; только TLS; **«non-configurable bandwidth limits»**; **TCP-прокси, реле не расшифровывает**; DNS может распространяться до 10 минут; предупреждение про **Let's Encrypt rate limits → 34 часа** |
| 8 | https://tailscale.com/docs/reference/tailscale-cli/funnel | 2026-10-03 | Флаги `--bg`, `--https=<port>`, `--yes`, `--set-path`; `tailscale funnel status [--json]`; пример вывода с `https://<host>.<tailnet>.ts.net` и строкой `\|-- / proxy http://127.0.0.1:3000`; **`--bg` ⇒ авто-возобновление после ребута и `tailscale down`/`up`**; прокси-таргет **`http://127.0.0.1`** |
| 9 | https://tailscale.com/kb/1247/funnel-examples | 2026-10-03 | **Windows-пример** (`c:\Users\Amelie> tailscale funnel …`); **«Funnels have a predictable, stable DNS name… set or share your DNS name one time»** |
| 10 | https://tailscale.com/pricing | 2026-10-03 | Personal **$0 «Free forever»**, до 6 юзеров, **Funnel ✓ в Personal** |
| 11 | https://ngrok.com/pricing | 2026-10-03 | Free: **$0 + $5 одноразового кредита**, 3 endpoint, **1 GB трафика**, **20k HTTP-запросов**, **interstitial page on HTTP/S**, assigned dev domain, 1 пользователь; Hobbyist $10/мес — без interstitial |
| 12 | https://ngrok.com/docs/pricing-limits/free-plan-limits | 2026-10-03 | Interstitial показывается **только для HTML-браузерного трафика**, API не затрагивается; обход — заголовок `ngrok-skip-browser-warning` **или** нестандартный `User-Agent`; бесплатные endpoint'ы **не имеют таймаута**; лимиты: 4000 req/min, 5k TCP/мес, TLS endpoints недоступны |
| 13 | https://ngrok.com/blog/tcp-endpoints-require-verification | 2026-10-03 (поиск) | Карта требуется **только для TCP endpoints**, включая free tier. Для HTTP/S — **требования карты в документации не найдено** |
| 14 | https://localhost.run/docs/ | 2026-10-03 | Client-less через SSH, **без аккаунта и без установки**; `ssh -R 80:localhost:8080 localhost.run` |
| 15 | https://localhost.run/docs/forever-free | 2026-10-03 | Free tier: **«Domain names change regularly»** + **«There is a speed limit»**; аккаунт + SSH-ключ продлевают жизнь домена |
| 16 | https://pinggy.io/ | 2026-10-03 | Free **$0 «Free for life»**, unlimited data transfer, но **«60 minutes tunnel timeout»** и **random subdomains** ⇒ URL меняется каждый час; persistent URL и свой домон — только Pro; регион `free.pinggy.io` рядом с пользователем; на Windows иногда нужен `127.0.0.1` вместо `localhost` |
| 17 | https://github.com/ekzhang/bore | 2026-10-03 | `bore.pub` — **чистый TCP-туннель, без TLS и без HTTP**; порт назначается случайно ⇒ **непригоден для `WebAppInfo.url`**; prebuilt binaries под Windows есть |
| 18 | https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages | 2026-10-03 | GitHub Pages: статический хостинг прямо из репозитория, HTTPS, бесплатно; **логирует IP посетителей** |
| 19 | https://github.com/Telegram-Mini-Apps/tma.js/issues/748 | 2026-10-03 | `getUserMedia({video:true})` в Telegram Mini App на **iOS даёт чёрный поток** (в Safari работает; Android/macOS работают). Статус `open`, метки `bug` / `Telegram bug` |
| 20 | https://github.com/cloudflare/cloudflared/issues/1449 | 2026-10-03 | Историческое подтверждение: SSE over GET на Quick Tunnel не стримится в реалтайме |
| 21 | Локально: `node_modules/@grammyjs/types/settings.d.ts`, `methods.d.ts` | 2026-10-03 | `MenuButtonWebApp { type:'web_app'; text; web_app: WebAppInfo }`; **`web_app` допускает t.me-ссылку вместо URL**; `setChatMenuButton({chat_id?, menu_button?})`; `WebAppInfo.url` = «An HTTPS URL» |
| 22 | Локально: `src/index.ts`, `package.json`, grep по `src/` | 2026-10-03 | **HTTP-сервера нет**; зависимости только `better-sqlite3` + `grammy`; `bot.start()` = long polling; ни одного упоминания `WebApp`/`initData`/`setChatMenuButton` |

### Явно помечено UNVERIFIED (не удалось подтвердить источником)

| Утверждение | Статус |
|---|---|
| `Telegram.WebApp.addEventListener` существует в `telegram-web-app.js?63` | **UNVERIFIED** — в текущей документации только `onEvent`/`offEvent`. Использовать `onEvent` |
| `Telegram.WebApp.devicePixelRatio` | **UNVERIFIED** как поле Telegram API — в таблице `WebApp` его нет. Использовать `window.devicePixelRatio` |
| Прямой запрет Telegram на IP-адрес (без домена) в `WebAppInfo.url` | **UNVERIFIED** — запрета в тексте нет, но публичного CA для IP не бывает |
| Tailscale Funnel официально поддерживает SSE / long-lived соединения | **UNVERIFIED** — Funnel документирован как TCP-прокси, запрета нет (в отличие от Quick Tunnel, где запрет выписан явно), но явного «Funnel supports SSE» в docs я не нашёл |
| Точные bandwidth limits Tailscale Funnel | **UNVERIFIED** — задокументировано лишь «non-configurable bandwidth limits», цифр нет |
| Формат строки лога `cloudflared`, из которой парсится `trycloudflare.com` URL | **UNVERIFIED** — в документации не приведён, регулярку надо проверить на первой попытке |
| Структура JSON у `tailscale funnel status --json` | **UNVERIFIED** — использован regex по текстовому выводу, формат которого документирован |
| Требует ли ngrok Free банковскую карту для регистрации аккаунта | **UNVERIFIED** — документация про карту упоминает только TCP endpoints; сам процесс регистрации я не проверял (и не должен, без разрешения владельца) |
| Аудио (`getUserMedia({audio:true})`) в Mini App на iOS | **UNVERIFIED** — баг найден только для видео (tma.js #748). Аудио надо проверять на реальном устройстве в тестовом DC |
| `zrok` как cardless-вариант | **UNVERIFIED** — не исследовался, в рейтинг не включён |

---

## Резюме в трёх пунктах

1. **HTTPS обязателен, localhost не подходит, self-signed не подходит.** Значит вопрос не «как поднять», а «где взять публичный HTTPS-хост». Telegram не хостит статику и не реестрит домены Mini App — значит, хостинг полностью на нас.

2. **Единственный вариант без карты, который проходит все фильтры (стабильный URL + валидный TLS + SSE не запрещён + Windows) — Tailscale Funnel** с бесплатным планом Personal за $0. Cloudflare Quick Tunnel отпадает из-за прямого запрета SSE; Cloudflare Named Tunnel отпадает из-за необходимости купить домен; ngrok Free отпадает как основной вариант из-за interstitial-страницы на HTML-трафике и жёстких квот.

3. **Правильная точка расширения в коде:** добавить в тот же процесс Node HTTP-сервер на `127.0.0.1`, целиком за reverse-proxy от Funnel. Тогда Mini App и API — один origin, CORS не нужен, `setChatMenuButton` получает константный URL, а HMAC-валидация `initData` + проверка `user.id` против уже существующего `ALLOWED_CHAT_IDS` закрывают доступ для посторонних.