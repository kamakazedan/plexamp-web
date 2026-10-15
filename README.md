# plexamp-web

A self-hosted web player for Plex music libraries, laid out like the Plexamp mobile app and built for phones first. It runs as a small container (nginx serving static files) and plays music straight from your Plex Media Server in the browser.

> Unofficial project. Not made, endorsed or supported by Plex.

## Features

- **Home**: recent playlists, recent plays and recently added albums, with a quick library switcher.
- **Library**: artists, albums, compilations, soundtracks, tracks, playlists, collections, genres, styles, moods and decades, with counts from your server.
- **Search**: live results, recent searches, top artists/albums/tracks, AI playlist, Sonic path (a journey between two tracks) and Shuffle library.
- **Artist pages**: popular tracks, albums grouped by type, sonically similar artists and artist radio.
- **Album and playlist pages**: play, shuffle, and a menu on every track (play next, add to queue, similar tracks, go to album or artist).
- **Now Playing**: big artwork, a waveform seek bar drawn from your server's loudness analysis, star ratings that save to Plex, the file format and quality (e.g. FLAC, 44.1 / 16), an "Up next" queue, Guest DJ, shuffle, repeat and a sleep timer.
- **AI playlist**: describe what you want to hear and a model running on your own hardware (through [Ollama](https://ollama.com)) builds a playlist from your library, which you can play or save to Plex.
- **Guest DJ**: DJs that add tracks as you listen. Six follow fixed rules (similar sound, same artist, same era, sonic journeys); the AI DJ uses your Ollama model to pick each next track and introduce it.
- **Live updates**: new music, playlist changes and ratings from other Plex apps appear without reloading. Works with or without WebSockets (see [Behind a work proxy](#behind-a-work-proxy)).
- **Playback**: gapless hand-off between tracks, lock-screen and media-key controls, and play reporting to Plex (play counts, recent plays, dashboard).
- **Album-colour backgrounds** from Plex's own artwork colours.
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

The image is built, tested and published by GitHub Actions on every push to `main`. If pulling fails because the package is private, either make it public in the package settings on GitHub or run `docker login ghcr.io` first. To build locally instead, uncomment `build: .` in `docker-compose.yml`.

## Settings

All optional. Set them as environment variables on the container.

| Variable | Example | What it does |
| --- | --- | --- |
| `PLEX_SERVER_URL` | `http://192.168.1.10:32400` | Proxies that Plex server at `/pms/` and adds "Server set up for this app" to the server list. |
| `DISABLE_WEBSOCKETS` | `true` | The app never opens a WebSocket. Live updates use Plex's event stream, or check every minute. |
| `OLLAMA_URL` | `http://192.168.1.20:11434` | Shares that Ollama server with everyone who uses the app, through `/ollama/`. |
| `OLLAMA_MODEL` | `llama3.1:8b` | The shared model people get unless they choose another installed one. |
| `OLLAMA_API_KEY` | | Sent as a bearer token, for an Ollama behind a proxy that asks for one. Never reaches browsers. |
| `OLLAMA_AUTH` | `plex` (default) or `off` | Who may use the shared model: `plex` means signed-in Plex users (see below), `off` means anyone who can open the app. |

The container stops with a clear message in its log if a value doesn't make sense, for example an address without `http://`.

**`PLEX_SERVER_URL`** helps when the browser can't reach Plex directly: when the player is served over HTTPS but Plex is plain HTTP, when your router's DNS rebinding protection blocks `*.plex.direct` addresses, or when a work network only allows ordinary web traffic to one address. You still sign in; the proxy only carries the traffic.

## Behind a work proxy

Live updates come from your Plex server. The app tries, in order:

1. **A WebSocket**: instant.
2. **Plex's event stream**: also instant, over plain HTTP, so it gets through most proxies that block WebSockets. Plex pings it every 10 seconds, so a proxy that holds the stream back is noticed within about 25 seconds.
3. **Checking for changes every minute**: works through anything.

When a WebSocket can't connect from a network, the app remembers that for six hours and goes straight to the event stream. Nothing else uses WebSockets: browsing, playback, ratings, playlists and the AI features are ordinary HTTP requests.

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

- **Signed-in users only** (`OLLAMA_AUTH=plex`). With `PLEX_SERVER_URL` set, a request is let through only if its Plex token works on that server. That means you and the people you share the server with. Without it, any signed-in Plex account is accepted.
- **Only what the app needs** is passed on: listing models, the version and chat. Downloading, deleting or changing models through the player isn't possible.
- **Rate-limited** per user, and the browser's Plex token and origin aren't forwarded to Ollama.

Ollama on the same machine as Docker works too: use `OLLAMA_URL: http://host.docker.internal:11434` (the bundled `docker-compose.yml` already maps that name on Linux), and start Ollama with `OLLAMA_HOST=0.0.0.0` so containers can reach it.

### On one device: your own Ollama

In **Settings → AI**, choose **My own Ollama server** and enter its address, such as `http://localhost:11434` for Ollama on the same computer. The browser connects directly, so Ollama has to trust the player's address. Set this on the computer running Ollama and restart it (the settings page shows the exact value):

```sh
OLLAMA_ORIGINS=https://music.example.com
```

If the player is served over HTTPS, browsers block plain `http://` addresses other than `localhost`. In that case use an HTTPS address or the shared setup.

**Notes for the AI**, in the same settings page, are added to every request ("I love 90s trip-hop; skip live recordings").

## Good to know

- **Formats.** Files play as-is when the browser supports them (FLAC, MP3, AAC, Opus and WAV in current browsers; ALAC mostly in Safari). Anything else is converted by your server over HLS. Browsers without built-in HLS load [hls.js](https://github.com/video-dev/hls.js) from cdn.jsdelivr.net for those tracks. The conversion path is the part most likely to need adjusting against real servers.
- **Sonic features** (similar tracks, Sonic path, sonically similar artists, artist radio and the sound-based Guest DJs) need sonic analysis turned on for the library in Plex. Without it, DJs fall back to matching on genre.
- **The waveform** appears once Plex has analysed a track's loudness; until then the seek bar is a plain line.
- **Not built yet**: casting to other Plex players, lyrics, editing playlists, loudness levelling and crossfades.

## Develop

There is no build step and no dependencies; the app is plain ES modules in `web/`.

```sh
python3 dev/mock-plex.py           # fake Plex server on :32400 (artwork needs Pillow)
python3 dev/mock-ollama.py         # fake Ollama on :11434
python3 -m http.server 8080 -d web
```

Open http://127.0.0.1:8080, choose **Use a server address and token instead**, and connect to `http://127.0.0.1:32400` with any token. The mock serves an invented library with generated artwork and short test tones, live notifications over a WebSocket and an event stream, and test switches (such as refusing WebSockets the way a proxy would) described at the top of the file. For AI features, choose **Settings → AI → My own Ollama server** and enter `http://127.0.0.1:11434`.

To use your own Plex server, enter its address and your [X-Plex-Token](https://support.plex.tv/articles/204059436-finding-an-authentication-token-x-plex-token/), or sign in with Plex.

Tests, which CI runs against the built image:

```sh
docker build -t plexamp-web:test .
sh docker/test-container.sh plexamp-web:test     # proxies, sign-in check, settings
sh tests/run-browser-tests.sh plexamp-web:test   # headless Chromium (needs Playwright)
```

```
web/
  index.html, manifest.webmanifest, config.js, icons/
  css/app.css            all styles (mobile first, desktop from 960px)
  js/app.js              entry point and routes
  js/plex.js             plex.tv sign-in, server discovery, Plex Media Server API
  js/player.js           queue, gapless playback, conversion fallback, play reporting
  js/nowplaying.js       mini player, desktop transport bar, Now Playing screen
  js/live.js             live updates: WebSocket, event stream or polling
  js/ai.js               Ollama client, AI playlists and the AI DJ's picks
  js/dj.js               Guest DJ modes
  js/backdrop.js         album-colour backgrounds
  js/router.js           hash routing, back-button handling, view cache
  js/ui.js, components.js, actions.js
  js/views/              home, library, detail pages, search, AI playlist, settings, sign-in
docker/                  nginx config, start-up script and container tests
dev/                     fake Plex and Ollama servers for development
tests/                   browser tests
```

## Troubleshooting

- **"Can't reach your Plex server"**: check the server is online and Remote Access is on in Plex, or set `PLEX_SERVER_URL`. **Settings → Connection** shows which address is in use and can test it.
- **Live updates say they're checking every minute**: a proxy is blocking both WebSockets and the event stream. Everything still works; changes just take up to a minute to appear.
- **"Couldn't reach Ollama"** with your own server: check it's running, that this device can reach it, and that `OLLAMA_ORIGINS` includes the player's address.
- **"The AI service couldn't confirm your Plex sign-in"**: sign out and in again. With `PLEX_SERVER_URL` set, only people with access to that server can use the shared model.
- **AI answers are slow**: the first request loads the model, which can take a minute on modest hardware. The model then stays loaded for 15 minutes.
- **Some tracks won't play**: check **Settings → Connection → Browser formats**. Unsupported formats need your server to convert them.
- **Playback stops when the phone locks**: add the player to your home screen and check the browser isn't restricted by battery-saving settings.

## Licence

MIT. See [LICENSE](LICENSE).
