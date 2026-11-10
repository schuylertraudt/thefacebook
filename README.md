# Friendbook

Personal Android app: a locked-down WebView around mobile Facebook that only allows the
Friends feed (plus posts, profiles, photos, comments, notifications, messages and login
flows) and reskins it in the 2008–2011 style. Never published; installed as a debug APK.

Everything Facebook-specific lives in three asset files. Kotlin holds only mechanism.

| File | What it controls |
|---|---|
| `app/src/main/assets/rules.json` | feed URL, allow/block patterns, hosts, labels to hide, selectors, header links |
| `app/src/main/assets/inject.js` | SPA URL enforcement, content hiding, header, debug reporting (logic only) |
| `app/src/main/assets/theme.css` | CSS variables, fonts, shape, header styling |

## Build

Requirements: JDK 17+ and the Android SDK (platform `android-37`, build-tools 37). Android
Studio installs both. From a terminal:

```sh
# once: tell Gradle where the SDK is (or export ANDROID_HOME)
echo "sdk.dir=$HOME/Android/Sdk" > local.properties      # macOS: $HOME/Library/Android/sdk

./gradlew testDebugUnitTest     # URL classifier tests
./gradlew assembleDebug         # -> app/build/outputs/apk/debug/app-debug.apk
```

Optional desktop tests (need Node and Playwright with Chromium):

```sh
node tools/inject-test/run.js   # inject.js + theme.css against a fake feed page (asserts)
node tools/live-test/run.js     # REAL logged-out m.facebook.com with the app's policy simulated
                                # prints the navigation log, writes live.png
```

## Install

### With adb (USB debugging on)

```sh
adb devices                                            # phone must be listed as "device"
adb install -r app/build/outputs/apk/debug/app-debug.apk
# or build + install in one step:
./gradlew installDebug
```

Enable USB debugging: Settings → About phone → tap *Build number* 7 times → Settings →
System → Developer options → *USB debugging*.

### Manually (no computer connection)

1. Copy `app-debug.apk` to the phone (USB file transfer, cloud drive, etc.).
2. Open it from the Files app.
3. When prompted, allow *Install unknown apps* for that Files app, then tap *Install*.
4. Play Protect may warn about an unknown developer: choose *Install anyway*.

### Signing note

Debug APKs are signed with the debug key of the machine that built them
(`~/.android/debug.keystore`). An update must carry the same signature, so if you switch
build machines, uninstall first (`adb uninstall com.personal.friendbook`); this also logs
you out.

## How it works

- **Launch**: loads `friendsFeedUrl` directly when logged in, `loginUrl` when not. The Home
  feed is never loaded.
- **Feed URL rewrite**: m.facebook.com loads `friendsFeedUrl` and then rewrites the address
  bar to `/` with `history.replaceState`. Inside a document that was loaded as the friends
  feed, rewrites to a `friendsFeedCanonical` pattern are kept (JS check, native history
  check, popstate/back). `/` stays blocked as a navigation of its own (Home tab, links).
- **Desktop mode** (`desktopMode: true`): loads the desktop site with `desktopUserAgent`
  (wide viewport, pinch zoom). Use it if the mobile site serves the mixed Home feed for
  `friendsFeedUrl`. Also set `friendsFeedUrl`, `loginUrl` and `sessionCookie.url` to
  `https://www.facebook.com/…`; the desktop friends feed is
  `https://www.facebook.com/?filter=friends&sk=h_chr`.
- **Logged out** (no `sessionCookie` cookie): allow/block rules are not enforced. Facebook
  serves the login form at `/`, `/login/` and `/unified/login_via/app/…` interchangeably, and
  logged-out sessions can only reach login pages. Once the cookie exists, rules apply, so
  Facebook's post-login landing on `/` is redirected to the friends feed.
- **Session**: cookies are accepted (including third-party) and flushed on pause.
- **User agent**: the default WebView UA with every string in `uaRemoveTokens` (`"; wv"`)
  removed.
- **Navigation policy** (`UrlRules.kt`), evaluated in this order for http(s) URLs:
  1. link-shim host (`l.facebook.com/l.php?u=…`) → unwrap, classify the target
  2. host not in `internalHosts` → open in the system browser
  3. host in `openHosts` → allow
  4. matches `friendsFeedUrl` (same path, all its query params present) → allow
  5. any `block` pattern → **block**
  6. any `allow` pattern → allow
  7. anything else → **block** (`default`)

  Block is checked before allow so broad allow rules (vanity profile names) can't reopen
  `/marketplace` etc. Patterns are Java regexes matched against path+query
  (`/story.php?story_fbid=1&id=2`), the same for `m.` and `www.` hosts. A blocked
  navigation always goes to the friends feed. Non-web schemes such as `fb://` and
  `intent://` are dropped (never handed to the Facebook app).
- **Where the rules are enforced**:
  - native: `shouldOverrideUrlLoading`, `onPageStarted`, `doUpdateVisitedHistory`
  - injected JS: wrapped `history.pushState`/`replaceState`, `popstate`, `hashchange`,
    and a 500 ms `location.href` poll. Blocked → `location.replace(friendsFeedUrl)`.
  - Every blocked navigation is redirected (no de-duplication). If the start page keeps
    bouncing to blocked URLs (more than 5 bounces in 15 s; reports of one bounce from several
    hooks within 400 ms count once), or the page fails to load, a native error screen is
    shown. It lists the blocked URLs and the rule that blocked each, with **Retry**,
    **Debug mode** (reload with filtering off) and **Copy log**. Navigation decisions are
    always kept in the in-memory log, so the log is useful even if debug mode was off.
- **Network**: sub-resource requests to hosts not in `resourceHosts` are answered locally
  with 403 (no analytics or third-party calls). No data is stored besides WebView cookies
  and cache; the debug log is memory-only.
- **Injection**: `Injector.kt` wraps `inject.js` as
  `(function (THEME_CSS, CFG) { … })(<theme.css>, <rules.json>)` and installs it with
  `WebViewCompat.addDocumentStartJavaScript` for `injectOrigins`. On WebViews without that
  feature it falls back to `evaluateJavascript` in `onPageStarted` and `onPageFinished`.
- **Hiding** (MutationObserver, 150 ms debounce): matched elements get
  `data-fbk-hidden="<reason>"`, and a stylesheet rule sets `display:none` on that attribute.
  - feed units (`feedUnitSelectors`) containing a `hideLabels.sponsored` label: matched on
    normalized text, on `aria-label`, on `innerText` (which drops letters hidden with
    `display:none`), and fuzzily: the label's letters in order inside a string at most
    `sponsoredFuzzyRatio`× its length (decoy letters mixed in)
  - blocks headed by `hideLabels.sections` (all pages) or `hideLabels.feedOnly` (feed only).
    From the label the script climbs to the largest wrapper that has no feed units, no form
    fields it didn't already contain, less than `sectionClimbMaxText` characters and less
    than 60% of the viewport height.
  - Safety: nothing containing `role=main` / `role=feed` / `<main>` or more than 60% of the
    page's text is ever hidden; refusals are logged as `[hide-refused]` in debug mode.
  - everything in `hideSelectors` (stories tray, Facebook's own bars)
- **Theme**: `theme.css` is injected as a `<style>` and kept last in `<head>` after every
  SPA navigation. Light mode is forced via `color-scheme`, the `forceLightMode` class swap,
  a light app theme and disabled algorithmic darkening.
- **Header**: our own markup (`#friendbook-header`), 42 px, title plus the `headerLinks`.
  `"@friendsFeedUrl"` as a link URL means the `friendsFeedUrl` value.
- **Pull-to-refresh** reloads the friends feed. It only triggers when the page reports it is
  scrolled to the top.
- **Back** goes back in the WebView; on the friends feed it exits.
- **Uploads**: `<input type=file>` opens the system picker (photo picker for images),
  multi-select supported.

## Debug / discovery mode

**Long-press the "Friendbook" title** in the header (or the title on the error screen).
The title reads "Friendbook · debug" and a log panel opens at the bottom.

While it is on:
- URL filtering is **off**. External links still open in the browser, and `fb://` style
  links are still dropped.
- Every URL change is logged with a timestamp and the verdict it *would* get:
  - `native:override`, `native:start`, `native:history`: full navigations / history updates
  - `spa:pushState`, `spa:replaceState`, `spa:popstate`, `spa:poll`, `js:docstart`: SPA changes
  - format: `HH:mm:ss.SSS [source] ALLOW|BLOCK|EXTERNAL [reason] url`; `reason` is
    `friends-feed`, `default`, or the exact pattern that matched
- `[hidden]` shows the hidden-element count for the page, grouped by reason.
- `[css-vars]` lists every CSS custom property the page defines, with Facebook's original
  values. `*` = already overridden by theme.css, `c` = looks like a color.
- `[net:blocked-host]` shows each third-party host whose requests were refused.
- Hidden elements stay visible but faded, with a dashed red outline and a
  `hidden: <reason>` tag, so you can check for false positives.
- **Copy log** copies the whole log to the clipboard. Paste it into a note or message to
  yourself.

Debug builds also enable WebView remote debugging: connect the phone over USB, open
`chrome://inspect` in desktop Chrome, and inspect the Friendbook WebView (DOM, console,
network).

### Checklist: filling in `friendsFeedUrl` and the patterns

1. Install, open, log in. (Login, checkpoint and 2FA paths are already allowed. If a login
   step bounces you to the feed, turn on debug mode first and finish logging in.)
2. Long-press the title to enable debug mode.
3. In Facebook's own UI, open the **Friends** feed (look for a *Feeds* tab or menu entry with a
   *Friends* filter). Wait for it to load.
4. In the log, find the URL that loaded it (`native:start` or `spa:pushState`). Note the path
   and the query parameters that select the friends feed (e.g. `filter=friends`, `sk=…`).
   Leave out tracking parameters (`ref`, `_rdr`, `mibextid`, …).
5. Set `friendsFeedUrl` in `rules.json` to that URL, using only the identifying parameters.
   The feed matches when the path is equal and **all** of its query parameters are present.
6. Pull to refresh or tap **Feed** and check the log line for that URL says
   `ALLOW [friends-feed]`.
7. Use the app normally for a while with debug on: open a post, its comments, a photo, a
   friend's profile, notifications, a message, and post a comment with a photo. Then try
   the things you want blocked: Home, Reels, Watch, Marketplace, Groups, Stories, Search.
8. **Copy log**. For every line, decide:
   - should be allowed but says `BLOCK [default]` → add a regex to `allow`
   - should be blocked but says `ALLOW [allow:…]` → add a regex to `block` (block wins)
   - `BLOCK [block:…]` but you want it → narrow or remove that block pattern
9. Look at `[hidden]` lines and the red-outlined elements. A friend's post outlined →
   remove or narrow the label / selector that matched (the tag shows which). An ad or
   suggestion block not outlined → inspect it via `chrome://inspect` and add its label to
   `hideLabels` or a selector to `hideSelectors`.
10. Look at `[css-vars]`: add every `c` variable without `*` to the variable block at the
    top of `theme.css`.
11. Look at `[net:blocked-host]`: if something broke (e.g. a login captcha) and a host
    there is needed, add it to `resourceHosts`.
12. Rebuild and reinstall (`./gradlew installDebug`), turn debug off, repeat steps 7–8 to
    confirm.

## Updating when Facebook changes

Facebook changes markup and URLs often. Usually only an asset file needs editing:

| Symptom | Fix |
|---|---|
| App lands on an error screen, "keeps redirecting" | Feed URL changed: run the checklist above, update `friendsFeedUrl` |
| A normal page bounces back to the feed | debug on, find its `BLOCK [default]` line, add an `allow` pattern |
| A section you want gone is reachable | add a `block` pattern |
| Ads / suggestions visible again | add the label to `hideLabels`, or a selector to `hideSelectors` / `feedUnitSelectors` |
| Friend posts disappearing | debug on, read the red `hidden:` tag, narrow that label/selector |
| Colors drifting back | debug on, read `[css-vars]`, add the new variables to `theme.css` |
| Names/timestamps unstyled | adjust `nameSelectors` / `timestampPattern` |

Then `./gradlew testDebugUnitTest installDebug`. Unit tests run against the real
`rules.json`, so they catch a broken edit (bad regex, home root no longer blocked, etc.).
Update `UrlRulesTest.kt` when you change policy on purpose.

Notes:
- JSON strings need doubled backslashes: regex `\.` is written `"\\."`.
- `hideLabels` are compared after lowercasing and removing all whitespace.
- Sponsored labels drawn as SVG glyphs, or with decoy letters in a separate DOM subtree,
  are not detected by text. Find a stable attribute with `chrome://inspect` and add it to
  `hideSelectors`.

## Project layout

```
app/src/main/kotlin/com/personal/friendbook/
  MainActivity.kt   WebView setup, clients, JS bridge, back, pull-to-refresh, file chooser, debug panel
  UrlRules.kt       loads rules.json, classifies URLs
  Injector.kt       builds the injected script from assets, document-start injection + fallback
  DebugLog.kt       in-memory log for the debug panel
app/src/main/assets/
  rules.json  inject.js  theme.css
app/src/test/kotlin/com/personal/friendbook/UrlRulesTest.kt
tools/inject-test/  desktop Playwright test for inject.js + theme.css
```
