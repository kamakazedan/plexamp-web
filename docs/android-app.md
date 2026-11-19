# The Android app

[plexamp-web for Android](https://github.com/kamakazedan/plexamp-web-android) runs this player in a WebView, from a copy of its files saved on the phone, and signs it in with Plex itself. For that it relies on a few things here that nothing else does. They're listed below, and [tests/android-app.test.mjs](../tests/android-app.test.mjs), which CI runs, fails when one of them changes.

Changing one is fine, with the app changed to match (the **In the app** column). Better still, keep the old way working beside the new for a while: phones update the app later than the player, which they save again from your server as soon as it changes.

## What it relies on

| What | Here | In the app | If it changed |
| --- | --- | --- | --- |
| The page loads `config.js` and `js/app.js` | `web/index.html` | `GuiRefs.looksLikePlexampWeb` | The app takes the player for something else (a Wi-Fi sign-in page) and won't set it up or save it |
| The version, as `APP_INFO = { …, version: '1.2.3' }` | `web/js/plex.js` | `GuiRefs.appVersion` | The app's Settings don't say which version is saved |
| What's kept: JSON in `localStorage`, under `pw.` and the key's name | `store` in `web/js/plex.js` | `Handoff.kt` | Signing in with the app doesn't sign the player in |
| The sign-in, `pw.auth`: `{ token, username, thumb, manual: false }`, as the player's own Sign in with Plex keeps it | `setAuth` in `web/js/state.js`, `web/js/views/login.js` | `Handoff.kt` | The same |
| The device's id with Plex, `pw.clientId`, and a sign-in under way, `pw.pendingPin` (the app removes it) | `clientId` in `web/js/plex.js`, `web/js/views/login.js` | `Handoff.kt` | The player signs in as another device, or picks up a sign-in it had started |
| The pages `#/setup` (choosing a server, just signed in), `#/` and `#/login` (signed out), and `#/login?offline=…` (offline mode's session ended) | `web/js/app.js`, `web/js/offline.js` | `Handoff.kt`, `MainActivity.onRoute` | The app opens the wrong page after signing in, or misses a sign-out |
| Sign in with Plex goes to `https://app.plex.tv/auth…` | `authUrl` in `web/js/plex.js` | `PlayerClient.kt` | The player's own button opens plex.tv inside the app, rather than the app's sign-in |
| The paths the container answers, never files: `api/`, `pms/`, `ollama/` and `signed-out` | `docker/nginx.conf`, `docker/40-plexamp-web.sh` | `GuiRefs.isServicePath` | The app saves them, and answers them from the phone |
| Files to save: a Blob's link (`URL.createObjectURL`), clicked as an `<a download>` | `download` in `web/js/ui.js` | `page-bridge.js` | Saving a playlist file does nothing in the app |
| Sharing text and links, not files (`navigator.share`) | `web/js/views/missingtracks.js` | `page-bridge.js` | Share does nothing in the app |
| Files a script loads by name are named in plain strings (`'vendor/hls.min.js'`) | `web/js/player.js` | `GuiRefs.find` | The file isn't saved, so it doesn't load without a connection |
| The page `#/settings/downloads` (Settings › Downloads) | `pages` in `web/js/views/settings.js` | `MainActivity` (`DOWNLOADS_ROUTE`) | Tapping the downloads notification opens the wrong page |
| Downloads: the page gives the app the server, the sign-in to it and its addresses (`account`) as it opens and as they change, and has it forget them (`forget`) as someone signs out or switches | `web/js/downloads.js` | `DownloadBridge.kt` | Downloads aren't kept up to date, or stay on the phone after signing out |

The app finds the player's files as a browser does: from the page, each module's imports (`./`, `../` or `/`), the styles, the manifest, and paths in scripts' own strings. A file named any other way (a template string, a path put together as it runs) isn't saved. The app's own CI saves this repository's `web/` folder, from `main`, and checks every file in it was found.

Downloads are the one thing the player asks the app for by name: `window.plexampAndroid.downloads`, which only the app's `page-bridge.js` gives a page. The player plays downloads from the addresses it hands out, under `__plexamp-web-android/downloads/` at the player's own address (`isLocal` in `web/js/downloads.js` knows them by that). What each call takes and answers is in the app's `DownloadBridge.kt`. A call that came later is looked for before it's offered (`check`, which **Up to date** makes, is in the app from 0.2.3): an older app has no button for it.
