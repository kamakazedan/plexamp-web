# Development

The app is plain ES modules in `web/`, with no build step and no dependencies. The service in `server/` is plain Node.js (version 22 or newer), also without dependencies.

## Running it from the source

```sh
python3 dev/mock-plex.py           # a fake Plex server (and plex.tv) on :32400; artwork needs Pillow
python3 dev/mock-ollama.py         # a fake Ollama on :11434 (switches for tests at the top of the file)
python3 -m http.server 8080 -d web
```

Open http://127.0.0.1:8080, choose **Use a server address and token instead**, and connect to `http://127.0.0.1:32400` with the token `t`. The mock serves an invented library with generated artwork and short test tones, live notifications over a WebSocket and an event stream, three made-up Plex accounts (`t`, `t2` and `t3`) for Play Together and shared playlists, a Plex player called Living Room on port 32500 for Play on, a small MusicBrainz, converted streams as a real server's (HLS of silent MP3, which `/__mock/hls` can stop part-way or cut short), and test switches (such as refusing WebSockets the way a proxy would) described at the top of the file. `python3 dev/mock-plex.py 32401 --big 3000` adds 3,000 albums, for trying long lists. `--open` makes it a server that lets the player in without signing in (taking everyone for its owner, or with `--honour`, only sign-ins it doesn't know), and `--tv-down` has its plex.tv stop answering, for offline mode (both can be switched at `/__mock/config` too). For AI features, choose **Settings › AI › My own Ollama server** and enter `http://127.0.0.1:11434`.

Served like this, without the container, there's no `/api/`, so Play Together, Play on with Plex players, shared playlists and the shared AI model are off. The full set runs in the container; for testing, `PLEX_TV_URL` points its service at the mock instead of plex.tv, `MUSICBRAINZ_URL` at the mock's MusicBrainz, and `SPOTIFY_URL` (with `SPOTIFY_LINK_IMPORT=true`) at the mock's Spotify playlist pages instead of open.spotify.com. To play converted tracks outside the container in browsers without built-in HLS, run `sh dev/fetch-hls.sh` once (it needs npm).

To use your own Plex server, enter its address and your [X-Plex-Token](https://support.plex.tv/articles/204059436-finding-an-authentication-token-x-plex-token/), or sign in with Plex.

## Tests

CI runs them all against the built image, and publishes the image only when they pass:

```sh
node --test server/test.js                       # the service: sessions, sync, merging, cleaning, redaction
bash tests/proxmox-test.sh                       # the Proxmox script, with stand-ins for pct and the rest
bash tests/proxmox-install-test.sh               # its installer, in Debian 12 and 13 containers
docker build -t plexamp-web:test .
sh docker/test-container.sh plexamp-web:test     # proxies, sign-in checks, logging, settings
sh tests/run-browser-tests.sh plexamp-web:test   # headless Chromium (needs Playwright)
```

Most browser tests turn loudness levelling and Load ahead off as they sign in, as the app had them before 0.20.0. `APP_DEFAULTS=1 sh tests/run-browser-tests.sh plexamp-web:test` runs them all with the app's own settings instead: worth a run before a release.

The version in `web/js/plex.js` (`APP_INFO`) must match the newest entry in [CHANGELOG.md](../CHANGELOG.md).

## How the code is laid out

```
web/
  index.html, manifest.webmanifest, config.js, icons/
  css/app.css            all styles (mobile first, desktop from 960px)
  js/app.js              entry point and routes
  js/state.js            the app's state and settings, signing out, and the events between modules
  js/plex.js             plex.tv sign-in, server discovery and routes, the Plex Media Server API
  js/player.js           queue, gapless playback and crossfades, conversion, play reporting, Play Together sync
  js/transitions.js      where a track's music starts and ends (loudness analysis), album order, fade support
  js/nowplaying.js       mini player, desktop transport bar, Now Playing screen
  js/together.js         Play Together: sessions, long-polling, the shared clock
  js/cast.js             Play on: Plex players through the service, AirPlay and Cast
  js/devices.js          your devices: sharing what's playing between them
  js/editing.js          adding to playlists and collections, and who may edit collections
  js/playlistio.js       playlists to a file and back, finding their tracks, changing a playlist's tracks
  js/sharing.js          shared playlists: keeping your copies the same as everyone's
  js/sorting.js          sorting playlists and collections with the fewest moves
  js/membership.js       Appears in: the albums a song is on, and the playlists and collections it's in (or an artist's music is)
  js/hubs.js             Plex's rows for an artist's page: their releases by kind, and what they appear on
  js/releases.js         what kind of release an album is: the same file as server/releases.js
  js/mb.js               the MusicBrainz features (MUSICBRAINZ_ADVANCED)
  js/missing.js          missing tracks from AI playlists and imports, checking them on MusicBrainz, exporting them
  js/missinglist.js      how a Missing tracks list changes: the same file as server/missinglist.js
  js/missingsync.js      Missing tracks that follow your account, and everyone's for the server's owner
  js/ratings.js          ratings in the player and in track lists, and keeping ❤️ Tracks
  js/live.js             live updates: WebSocket, event stream or polling
  js/ai.js               Ollama client, AI playlists and the AI DJ's picks
  js/dj.js               Guest DJs, the queue DJs included
  js/home-sections.js    Home screen sections and their layout per library
  js/debug.js            debug mode: browser problems sent to the container log
  js/backdrop.js         album-colour backgrounds
  js/router.js           hash routing, back-button handling, view cache
  js/ui.js, components.js, actions.js, preview.js
  js/views/              home, library, detail pages, search, Play Together, AI playlist, settings, sign-in
server/                  the service behind /api/: Play Together, Play on, your devices, the shared AI model,
                         MusicBrainz checks, shared playlists, settings and Missing tracks that follow each
                         account, sign-in checks, debug log
docker/                  nginx config, start-up script and container tests
proxmox/                 the Proxmox VE script, and the installer it runs in the container
dev/                     fake Plex and Ollama servers for development
tests/                   browser tests, and the Proxmox scripts' tests
docs/                    the documentation
```
