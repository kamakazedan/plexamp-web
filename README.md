# plexamp-web

A self-hosted web player for Plex music libraries, laid out like the Plexamp mobile app and built for phones first. It runs as a small container (nginx serving static files) and plays music straight from your Plex Media Server in the browser.

> Unofficial project. Not made, endorsed or supported by Plex.

## Features

- **Home**: recent playlists, recent plays and recently added albums, with a quick library switcher.
- **Library**: artists, albums, compilations, soundtracks, tracks, playlists, collections, genres, styles, moods and decades, with counts from your server.
- **Search**: live results, recent searches, top artists/albums/tracks, Sonic path (a journey between two tracks) and Shuffle library.
- **Artist pages**: popular tracks, albums grouped by type, sonically similar artists and artist radio.
- **Album and playlist pages**: play, shuffle, and a menu on every track (play next, add to queue, similar tracks, go to album or artist).
- **Now Playing**: big artwork, a waveform seek bar drawn from your server's loudness analysis, star ratings that save to Plex, the file format and quality (e.g. FLAC, 44.1 / 16), an "Up next" queue, similar-tracks radio, shuffle, repeat and a sleep timer.
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

The image is built and published by GitHub Actions on every push to `main`. If pulling fails because the package is private, either make it public in the package settings on GitHub or run `docker login ghcr.io` first. To build locally instead, uncomment `build: .` in `docker-compose.yml`.

### Optional: proxy your server through the container

| Variable | Example | What it does |
| --- | --- | --- |
| `PLEX_SERVER_URL` | `http://192.168.1.10:32400` | Proxies that server at `/pms/` and adds "Server set up for this app" to the server list. |

Use it when the browser can't reach Plex directly, for example when the player is served over HTTPS but Plex is plain HTTP, or when your router's DNS rebinding protection blocks `*.plex.direct` addresses. You still sign in; the proxy only carries the traffic.

## Good to know

- **Formats.** Files play as-is when the browser supports them (FLAC, MP3, AAC, Opus and WAV in current browsers; ALAC mostly in Safari). Anything else is converted by your server over HLS. Browsers without built-in HLS load [hls.js](https://github.com/video-dev/hls.js) from cdn.jsdelivr.net for those tracks. The conversion path is new and the part most likely to need adjusting against real servers.
- **Sonic features** (similar tracks, Sonic path, sonically similar artists, artist radio) need sonic analysis turned on for the library in Plex.
- **Not built yet**: casting to other Plex players, lyrics, ratings, editing playlists, loudness levelling and crossfades.

## Develop

There is no build step and no dependencies; the app is plain ES modules in `web/`.

```sh
python3 dev/mock-plex.py          # fake Plex server on :32400 (needs Pillow)
python3 -m http.server 8080 -d web
```

Open http://127.0.0.1:8080, choose **Use a server address and token instead**, and connect to `http://127.0.0.1:32400` with any token. The mock serves an invented library with generated artwork and short test tones, so you can work on the UI without a real server. To use your own server, enter its address and your [X-Plex-Token](https://support.plex.tv/articles/204059436-finding-an-authentication-token-x-plex-token/), or sign in with Plex.

```
web/
  index.html, manifest.webmanifest, config.js, icons/
  css/app.css            all styles (mobile first, desktop from 960px)
  js/app.js              entry point and routes
  js/plex.js             plex.tv sign-in, server discovery, Plex Media Server API
  js/player.js           queue, gapless playback, conversion fallback, play reporting
  js/nowplaying.js       mini player, desktop transport bar, Now Playing screen
  js/backdrop.js         album-colour backgrounds
  js/router.js           hash routing, back-button handling, view cache
  js/ui.js, components.js, actions.js
  js/views/              home, library, detail pages, search, settings, sign-in
docker/                  nginx config and start-up script
dev/mock-plex.py         fake server for development
```

## Troubleshooting

- **"Can't reach your Plex server"**: check the server is online and Remote Access is on in Plex, or set `PLEX_SERVER_URL`. **Settings → Connection** shows which address is in use and can test it.
- **Some tracks won't play**: check **Settings → Connection → Browser formats**. Unsupported formats need your server to convert them.
- **Playback stops when the phone locks**: add the player to your home screen and check the browser isn't restricted by battery-saving settings.

## Licence

MIT. See [LICENSE](LICENSE).
