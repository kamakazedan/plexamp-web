# plexamp-web

> [!IMPORTANT]
> **This project was coded entirely by Claude, an AI model made by Anthropic,** at the direction of the repository's owner. No part of the code was written by hand, and it hasn't been independently audited. Read the security report below and review the code before you rely on it, especially before you make it reachable from the internet.

A self-hosted web player for Plex music libraries, laid out like the Plexamp app and built for phones first. It runs as one small container and plays music straight from your Plex Media Server in the browser.

> Unofficial project. Not made, endorsed or supported by Plex.

## Security report

A review of the code with one main question: **can any of it leak your data?** That means tokens, your library, or what you listen to, ending up somewhere it shouldn't (logs, other websites, other people). The review covered the browser app, the nginx configuration, the start-up script and the service that runs alongside them. It was done by Claude, which also wrote the code, so treat it as a careful self-review rather than an independent audit.

### What the app handles, and where it goes

- **Your Plex sign-in.** After you sign in, the browser keeps your Plex token (and, for servers shared with you, that server's access token) in its local storage. The token is sent only to plex.tv, to your Plex server (directly or through the container's `/pms/` proxy), and to the container's own service (to check who you are for Play Together and the shared AI model).
- **Your library and listening.** Requests go from your browser to your Plex server. Plays are reported back to Plex if **Sync recent plays** is on.
- **The container** has no database and writes nothing to disk except its start-up configuration. Play Together sessions are held in memory only. The service never stores tokens; it keeps short-lived SHA-256 hashes of them as cache keys, so it doesn't have to ask plex.tv on every request.
- **No outside code or tracking.** No analytics and no third-party scripts. hls.js is bundled into the image, so nothing is loaded from a CDN. The browser contacts only plex.tv (sign-in, your server list, profile pictures), your Plex server, and an Ollama server if you set one up.

### Fixed in this review

| Area | What was wrong | What changed |
| --- | --- | --- |
| Container log | nginx's default access log wrote every request address to the container log. Plex tokens travel in those addresses (artwork and audio), so anyone who could read the log, in Portainer for example, could read tokens. | The access log is off. In debug mode it shows paths only, never query strings. |
| Container log | nginx's error messages for the Plex proxy quote the whole request, token included. | These are no longer logged. In debug mode they pass through a filter that removes tokens first. |
| Plex proxy | `/pms/` forwarded requests without a token. And if your Plex server lets the container's network in without signing in (Plex's "List of IP addresses and networks that are allowed without auth"), anyone who could open the player could use your Plex server through it, with owner rights. | Requests without a token are refused, except the playlist and segment files inside a stream Plex is converting (players fetch those by the stream's session, without a token). The service checks whether Plex accepts made-up tokens from the container; if it does, every `/pms/` request must carry the token of a Plex account with access to the server (checked with plex.tv), and the log explains how to fix the Plex setting. Browsers can no longer set the `X-Forwarded-For` address Plex sees, and cookies aren't passed on. |
| Shared AI sign-in check | Tokens were checked against your Plex server, which accepts anything from an allowed network (see above). | Tokens are checked with plex.tv first. Asking the Plex server is a fallback, used only when it refuses made-up tokens. |
| Third-party code | hls.js was loaded from cdn.jsdelivr.net at run time, at whatever the newest 1.x version was. | It's pinned to one version and bundled into the image at build time, and the content security policy only allows scripts from the player itself. |
| Crafted links | A link like `#/items?path=…` or `#/tags/…` could make the app send your token to any Plex endpoint, including ones that change things on a plain GET. | Links can only open library listings, tag lists are limited to known fields, and ids in links must be numbers. |
| Server data in styles | Album colours from the server went into CSS unchecked, so a malicious server could make the browser load an outside image (and see your IP address). | Colours must be plain hex values, and image addresses are escaped. |
| Outside images | Artwork hosted elsewhere (some metadata providers) was loaded straight from that host. | All artwork goes through your Plex server's image converter, so the browser only talks to your server. |
| Sign-out | An Ollama API key entered on a device stayed in its storage after signing out. | It's cleared on sign-out, along with everything else except device settings. |
| Response headers | nginx's version was shown in headers. | Hidden. A `Permissions-Policy` and `object-src 'none'` were added. |
| Start-up messages | When an address such as `PLEX_SERVER_URL` had a user name and password in it (which the container refuses), the error printed it in full, password included. | Passwords are hidden in every message the container prints. |
| Link parameters | A value in a link (a filter in `#/browse/…`) could replace the app's own Plex parameters, the token among them. | The app's own Plex parameters always win. |

### Play Together

New in this version, and built with the same aim:

- Only your own Plex friends can be invited, and joining checks with plex.tv, using the joiner's own token, that they can play from the session's library. A session's link is useless to anyone who wasn't invited.
- Everyone plays from the Plex server with their own token. Tokens are never shared between people, and the service doesn't keep them.
- Tracks someone adds are reduced to the fields the app needs, and their file and artwork paths must have Plex's own shape. So nobody can point other people's players at another website, or at another part of the server. Each player checks this again before playing.
- People in a session see each other's Plex display names and profile pictures, never email addresses or tokens.
- Sessions are held in memory and end on their own: after 30 minutes with nobody listening, or after 24 hours. A player holds at most 100 at a time, one per person.
- Requests are limited per person, and long-polling uses plain HTTP, so it works through proxies that block WebSockets.

### Debug mode

`DEBUG=true` writes much more to the container log: settings (secrets shown only as "set"), connection checks, request paths and status codes, the service's activity, and problems from browsers. Tokens and keys are always replaced with `[redacted]`, but the log does show server addresses, people's names and the names of tracks. Share it with care, and turn debug mode off when you're done.

### Remaining risks

These come with how the app works:

- **Tokens live in the browser.** Like Plex's own web app, the player keeps your token in the browser's local storage. Anyone with access to the browser profile, or a script injected into the page, could read it. The page uses no third-party scripts, builds everything without HTML strings, and has a strict content security policy, which makes injection hard.
- **Tokens appear in media addresses.** Plex needs the token in artwork and audio addresses. They go only to your Plex server and are never sent as a referrer to anyone else, but they can show up in the browser's developer tools.
- **The container serves plain HTTP.** On your home network that's the same as Plex's own `http://` addresses. If you use the player from outside, put it behind an HTTPS reverse proxy. Without HTTPS, tokens cross the network unencrypted.
- **The shared AI model without `PLEX_SERVER_URL`** is open to anyone signed in to Plex, and Plex accounts are free. If the player can be reached from the internet, set `PLEX_SERVER_URL` so that only people with access to your server can use the model.
- **Wide connection rules.** The content security policy has to allow connections, images and audio from any address, because Plex servers and Ollama can be anywhere.
- **Whoever runs the container is trusted.** They control the code your browser runs, and the service sees your token when it checks who you are. That's also true of any web app you open.

To report a security problem, open an issue on GitHub without posting tokens or logs that contain them.

## Features

- **Home**: sections you choose and order for each library (see below), including **Collections**, shown just like Recent playlists. There's a quick library switcher too.
- **Library**: artists, albums, compilations, soundtracks, tracks, playlists, collections, genres, styles, moods and decades, with counts from your server.
- **Search**: live results, recent searches, top artists, albums and tracks, AI playlists, Sonic path (a journey between two tracks) and Shuffle library.
- **Artist pages**: popular tracks, albums grouped by type, sonically similar artists, and artist radio.
- **Album and playlist pages**: play, shuffle, and a menu on every track (play next, add to queue, similar tracks, go to album or artist). Albums show their format (e.g. FLAC 24/96) and mark their best-known tracks.
- **Now Playing**: big artwork, a seek bar drawn from your server's loudness analysis, ratings that save to Plex, the file format and quality, an Up next queue, Guest DJ, shuffle, repeat and a sleep timer. Optional playback speed and skip buttons.
- **Play Together**: listen in sync with Plex friends. Everyone hears the same track at the same moment, and anyone in the session can play, pause, skip, seek, and change the queue.
- **AI playlists**: describe what you want to hear, and a model running on your own hardware (through [Ollama](https://ollama.com)) builds a playlist from your library, which you can play or save to Plex.
- **Guest DJ**: DJs that add tracks as you listen. Six follow fixed rules (similar sound, same artist, same era, sonic journeys). The AI DJ uses your Ollama model to pick each next track and introduce it.
- **Live updates**: new music, playlist changes and ratings from other Plex apps appear without reloading. Works with or without WebSockets (see [Behind a work proxy](#behind-a-work-proxy)).
- **Playback**: gapless hand-off between tracks, lock-screen and media-key controls, and play reporting to Plex (play counts, recent plays, dashboard).
- **Album-colour backgrounds** from Plex's own artwork colours, or a blurred copy of the cover.
- **Responsive**: bottom tabs and a mini player on phones; a sidebar and full transport bar on desktop. It can be added to a phone's home screen.
- **Reconnects** on its own, preferring a local connection, then remote, then Plex's relay.

## Run it

```sh
docker run -d --name plexamp-web -p 8080:80 --restart unless-stopped ghcr.io/kamakazedan/plexamp-web:latest
```

Or with Compose, using `docker-compose.yml` from this repo:

```sh
docker compose up -d
```

Open `http://<your-docker-host>:8080`, choose **Sign in with Plex**, then pick your server and music library.

The image is built, tested and published by GitHub Actions on every push to `main`, for amd64 and arm64 (a Raspberry Pi 4 or CM4 works well). If pulling fails because the package is private, either make it public in the package settings on GitHub or run `docker login ghcr.io` first. To build locally instead, uncomment `build: .` in `docker-compose.yml`.

## Container settings

All optional. Set them as environment variables on the container.

| Variable | Example | What it does |
| --- | --- | --- |
| `PLEX_SERVER_URL` | `http://192.168.1.10:32400` | Proxies that Plex server at `/pms/` and adds "Server set up for this app" to the server list. |
| `DISABLE_WEBSOCKETS` | `true` | The app never opens a WebSocket. Live updates use Plex's event stream, or check every minute. |
| `OLLAMA_URL` | `http://192.168.1.20:11434` | Shares that Ollama server with everyone who uses the app, through `/ollama/`. |
| `OLLAMA_MODEL` | `llama3.1:8b` | The shared model people get unless they choose another installed one. |
| `OLLAMA_API_KEY` | | Sent as a bearer token, for an Ollama behind a proxy that asks for one. Never reaches browsers. |
| `OLLAMA_AUTH` | `plex` (default) or `off` | Who may use the shared model: `plex` means signed-in Plex users (see below), `off` means anyone who can open the app. |
| `PLAY_TOGETHER` | `true` (default) or `false` | Play Together and its tab. |
| `DEBUG` | `true` | Writes extra detail to the container log for troubleshooting, with tokens removed (see [Debug mode](#debug-mode)). |

The container stops with a clear message in its log if a value doesn't make sense, for example an address without `http://`.

**`PLEX_SERVER_URL`** helps when the browser can't reach Plex directly: when the player is served over HTTPS but Plex is plain HTTP, when your router's DNS rebinding protection blocks `*.plex.direct` addresses, or when a work network only allows ordinary web traffic to one address. You still sign in; the proxy only carries the traffic.

## Play Together

Listen with Plex friends, each on their own device. Open the **Together** tab, choose **Start a session**, and pick friends to invite (people you share your Plex library with). They open the same player, sign in with their own Plex account, and find the invitation in their Together tab. A dot on the tab shows when an invitation arrives.

- **In sync**: play, pause, skip and seek happen for everyone, and each track starts at the same moment for everyone. Every player follows the session's clock and corrects small drift as it plays.
- **One shared queue**: anyone in the session can add music from anywhere in the app (**Play next**, **Add to queue**, or play an album), remove upcoming tracks, shuffle or clear what's next. Up next shows who added each track.
- **Hosting**: the host can invite more friends and remove people. If the host leaves, the person who's been there longest takes over. **End for everyone** stops the session.
- **Your own server access**: friends play from your Plex server with their own access, so they need your music library shared with them. Plays count for each person.
- **Works without WebSockets**: sessions use plain HTTP requests (long-polling), so they work through work proxies too.

Things to know: everyone must use the same player address, because sessions live in that container. Guest DJ and repeat are off during a session, and a sleep timer takes you out of the session instead of pausing everyone. If a browser holds back sound after a reload, the app asks for a tap to start listening again.

## Customise it

**Settings → Experience** follows the layout of Plexamp's own settings:

- **Appearance**: colour from artwork, and the background (album colours, blurred artwork, or plain).
- **Player**: show codec and rating, the volume control, the seekbar style (smooth, bars or simple), Up next side by side on wide screens, the album year, opening the full player when something starts, playback speed, long-form controls (for tracks over 20 minutes: skip buttons, and carrying on where you stopped), and quick skip buttons with times you choose.
- **Home screen**: the sections on Home for the current library. Drag to reorder, tap one to show or hide it, or to pick its time period. Sections: Mixes for you, Recent plays, Recent playlists, Collections, More in (a genre), Best of the 70s to the 20s, Recently added, Top albums from (a period), Stations (library radio, deep cuts, time travel and a random album), Most played in (a period), More from (a record label), History, and Haven't played in (a period).
- **Grid size, font size and rating system** (five stars, half stars, thumbs or off).
- **Album codec badges, popular-track badges and preview buttons** (a 15-second listen without changing the queue).
- **Search all libraries** and **playlists from all libraries**, **top plays list size**, and **1-tap playback** (when off, tapping a track while something plays asks whether to play it now, next or later).
- **Sync recent plays**, **desktop integration** (media keys, the tab title, keyboard shortcuts) and the **player name** Plex shows on its dashboard.

Settings are kept per device.

## Debug mode

If something doesn't work, set `DEBUG=true` on the container, restart it, and watch its log (`docker logs -f plexamp-web`, or the container's Logs page in Portainer). You'll see:

- the settings the container started with (secrets show only as "set") and the `config.js` it wrote;
- whether the container can reach your Plex server, Ollama and plex.tv;
- every request as a path and status code (`GET /pms/library/sections 502`), without query strings;
- nginx's own errors for the Plex proxy (timeouts, refused connections, TLS problems), with tokens removed;
- what the service does (sign-in checks, Play Together sessions);
- problems from browsers: failed requests, tracks that won't play, script errors, which connection and live-update route each device uses.

Tokens and keys are replaced with `[redacted]` everywhere. Turn debug mode off again afterwards (see [Debug mode](#debug-mode) in the security report). **Settings → Connection** in the app shows whether debug mode is on.

## Behind a work proxy

Live updates come from your Plex server. The app tries, in order:

1. **A WebSocket**: instant.
2. **Plex's event stream**: also instant, over plain HTTP, so it gets through most proxies that block WebSockets. Plex pings it every 10 seconds, so a proxy that holds the stream back is noticed within about 25 seconds.
3. **Checking for changes every minute**: works through anything.

When a WebSocket can't connect from a network, the app remembers that for six hours and goes straight to the event stream. Nothing else uses WebSockets: browsing, playback, ratings, playlists, Play Together and the AI features are ordinary HTTP requests.

- To turn WebSockets off for everyone, set `DISABLE_WEBSOCKETS=true`.
- To turn them off on one device, such as a work laptop, use **Settings → Connection → Live updates → Without WebSockets**.

**Settings → Connection** shows which route is in use and why. Through a corporate proxy, `PLEX_SERVER_URL` usually helps too, because every request then goes to the player's own address.

## AI playlists and the AI DJ

Both use a model on your own hardware through [Ollama](https://ollama.com); nothing is sent to a cloud service. An instruction-tuned model of about 7 to 9 billion parameters, such as `llama3.1:8b` or `qwen2.5:7b`, is a good starting point. The app asks for structured (JSON) answers, and picks its own context size so long prompts aren't cut short.

Playlists are built in two passes so they only contain music you have. First the model picks genres, styles, moods, artists and songs that fit your description, chosen from tags your library actually uses. The app then finds matching tracks on your Plex server, and finally the model chooses and orders tracks from that list.

There are two ways to connect. Each device chooses in **Settings → AI**.

### Shared: one Ollama for everyone

Set `OLLAMA_URL` (and usually `OLLAMA_MODEL`) on the container:

```yaml
services:
  plexamp-web:
    image: ghcr.io/kamakazedan/plexamp-web:latest
    ports:
      - "8080:80"
    environment:
      PLEX_SERVER_URL: http://192.168.1.10:32400
      OLLAMA_URL: http://ollama:11434
      OLLAMA_MODEL: llama3.1:8b
    restart: unless-stopped

  ollama:
    image: ollama/ollama
    volumes:
      - ollama:/root/.ollama
    restart: unless-stopped
    # For an NVIDIA GPU, see the Ollama image's documentation.

volumes:
  ollama:
```

Then install the model once: `docker compose exec ollama ollama pull llama3.1:8b`.

Browsers only ever talk to the player's own address, so this works from anywhere the player does (a work network included), and Ollama needs no extra setup. The proxy is locked down:

- **Signed-in users only** (`OLLAMA_AUTH=plex`). Every request is checked with plex.tv. With `PLEX_SERVER_URL` set, only Plex accounts that can use that server get through: you, and the people you share it with. Without it, any signed-in Plex account is accepted.
- **Only what the app needs** is passed on: listing models, the version and chat. Downloading, deleting or changing models through the player isn't possible.
- **Rate-limited** per user, and the browser's Plex token, cookies and origin aren't forwarded to Ollama.

Ollama on the same machine as Docker works too: use `OLLAMA_URL: http://host.docker.internal:11434` (the bundled `docker-compose.yml` already maps that name on Linux), and start Ollama with `OLLAMA_HOST=0.0.0.0` so containers can reach it.

### On one device: your own Ollama

In **Settings → AI**, choose **My own Ollama server** and enter its address, such as `http://localhost:11434` for Ollama on the same computer. The browser connects directly, so Ollama has to trust the player's address. Set this on the computer running Ollama and restart it (the settings page shows the exact value):

```sh
OLLAMA_ORIGINS=https://music.example.com
```

If the player is served over HTTPS, browsers block plain `http://` addresses other than `localhost`. In that case use an HTTPS address or the shared setup.

**Notes for the AI**, in the same settings page, are added to every request ("I love 90s trip-hop; skip live recordings").

## Good to know

- **Formats.** Files play as-is when the browser supports them (FLAC, MP3, AAC, Opus and WAV in current browsers; ALAC mostly in Safari). Anything else is converted by your server over HLS, played with the built-in support where the browser has it and with [hls.js](https://github.com/video-dev/hls.js) (bundled into the image) where it doesn't. The conversion path is the part most likely to need adjusting against real servers.
- **Sonic features** (similar tracks, Sonic path, sonically similar artists, artist radio and the sound-based Guest DJs) need sonic analysis turned on for the library in Plex. Without it, DJs fall back to matching on genre.
- **The waveform** appears once Plex has analysed a track's loudness; until then the seek bar is a plain line.
- **Not built yet**: casting to other Plex players, lyrics, editing playlists, loudness levelling and crossfades.

## Develop

The app is plain ES modules in `web/`, with no build step and no dependencies. The service in `server/` is plain Node.js (version 22 or newer), also without dependencies.

```sh
python3 dev/mock-plex.py           # fake Plex server (and plex.tv) on :32400; artwork needs Pillow
python3 dev/mock-ollama.py         # fake Ollama on :11434
python3 -m http.server 8080 -d web
```

Open http://127.0.0.1:8080, choose **Use a server address and token instead**, and connect to `http://127.0.0.1:32400` with the token `t`. The mock serves an invented library with generated artwork and short test tones, live notifications over a WebSocket and an event stream, three made-up Plex accounts for Play Together (`t`, `t2` and `t3`), and test switches (such as refusing WebSockets the way a proxy would) described at the top of the file. For AI features, choose **Settings → AI → My own Ollama server** and enter `http://127.0.0.1:11434`.

Served like this, without the container, there's no `/api/`, so Play Together and the shared AI model are off. The full set runs in the container; for testing, `PLEX_TV_URL` points its service at the mock instead of plex.tv. To play converted tracks outside the container in browsers without built-in HLS, run `sh dev/fetch-hls.sh` once (it needs npm).

To use your own Plex server, enter its address and your [X-Plex-Token](https://support.plex.tv/articles/204059436-finding-an-authentication-token-x-plex-token/), or sign in with Plex.

Tests, which CI runs against the built image:

```sh
node --test server/test.js                       # the service: sessions, sync, cleaning, redaction
docker build -t plexamp-web:test .
sh docker/test-container.sh plexamp-web:test     # proxies, sign-in checks, logging, settings
sh tests/run-browser-tests.sh plexamp-web:test   # headless Chromium (needs Playwright)
```

```
web/
  index.html, manifest.webmanifest, config.js, icons/
  css/app.css            all styles (mobile first, desktop from 960px)
  js/app.js              entry point and routes
  js/plex.js             plex.tv sign-in, server discovery, Plex Media Server API
  js/player.js           queue, gapless playback, conversion fallback, play reporting, Play Together sync
  js/nowplaying.js       mini player, desktop transport bar, Now Playing screen
  js/together.js         Play Together: sessions, long-polling, the shared clock
  js/live.js             live updates: WebSocket, event stream or polling
  js/ai.js               Ollama client, AI playlists and the AI DJ's picks
  js/dj.js               Guest DJ modes
  js/home-sections.js    Home screen sections and their layout per library
  js/debug.js            debug mode: browser problems sent to the container log
  js/backdrop.js         album-colour backgrounds
  js/router.js           hash routing, back-button handling, view cache
  js/ui.js, components.js, actions.js, preview.js
  js/views/              home, library, detail pages, search, Play Together, AI playlist, settings, sign-in
server/                  the service behind /api/: Play Together, sign-in checks, debug log
docker/                  nginx config, start-up script and container tests
dev/                     fake Plex and Ollama servers for development
tests/                   browser tests
```

## Troubleshooting

Start with [Debug mode](#debug-mode): most set-up problems show up in the container log with it on.

- **"Can't reach your Plex server"**: check the server is online and Remote Access is on in Plex, or set `PLEX_SERVER_URL`. **Settings → Connection** shows which address is in use and can test it.
- **The log says your Plex server "lets this container in without signing in"**: the container's address is in Plex's list of networks allowed without signing in (**Settings → Network** in Plex). The proxy keeps working for Plex accounts with access to the server; remove the container's address from that list to fix it properly.
- **Live updates say they're checking every minute**: a proxy is blocking both WebSockets and the event stream. Everything still works; changes just take up to a minute to appear.
- **Play Together shows no friends**: friends come from plex.tv, so they need to be your Plex friends, sharing your library. "Can't play from …" means they don't have access to this server.
- **A friend can't join**: they must open the same player address and sign in with Plex (not with a server token), and have your music library shared with them.
- **"Couldn't reach Ollama"** with your own server: check it's running, that this device can reach it, and that `OLLAMA_ORIGINS` includes the player's address.
- **"The AI service couldn't confirm your Plex sign-in"**: sign out and in again. With `PLEX_SERVER_URL` set, only people with access to that server can use the shared model.
- **AI answers are slow**: the first request loads the model, which can take a minute on modest hardware. The model then stays loaded for 15 minutes.
- **Some tracks won't play**: check **Settings → Connection → Browser formats**. Unsupported formats need your server to convert them.
- **Playback stops when the phone locks**: add the player to your home screen and check the browser isn't restricted by battery-saving settings.

## Licence

MIT. See [LICENSE](LICENSE). The image also includes [hls.js](https://github.com/video-dev/hls.js) (Apache 2.0); its licence is in the image at `/usr/share/nginx/html/vendor/hls.js-LICENSE.txt`.
