# plexamp-web

A self-hosted web player for Plex music libraries, laid out like the Plexamp app and built for phones first. It runs as one small container and plays music straight from your Plex Media Server in the browser.

> [!IMPORTANT]
> **This project was coded entirely by Claude, an AI model made by Anthropic,** at the direction of the repository's owner. No part of the code was written by hand, and it hasn't been independently audited. Read [SECURITY.md](SECURITY.md) and review the code before you rely on it, especially before you make it reachable from the internet.

> Unofficial project. Not made, endorsed or supported by Plex.

## Quick start

With Docker:

```sh
docker run -d --name plexamp-web -p 8080:80 -v plexamp-web-data:/data \
  -e PLEX_SERVER_URL=http://192.168.1.10:32400 \
  --restart unless-stopped ghcr.io/kamakazedan/plexamp-web:latest
```

Or with Compose (in Portainer, paste it as a stack): use [docker-compose.yml](docker-compose.yml) from this repository and run `docker compose up -d`.

Or on Proxmox VE, in the node's shell, as root. It makes a small Debian container (LXC) with the player in it, without Docker:

```sh
bash -c "$(curl -fsSL https://raw.githubusercontent.com/kamakazedan/plexamp-web/stable/proxmox/plexamp-web.sh)"
```

Then open `http://<host>:8080` (on Proxmox, the address it shows when it's done), choose **Sign in with Plex**, and pick your server and music library.

`PLEX_SERVER_URL` is optional, but recommended: it's your Plex server's address on your network, and it gives browsers that can't reach Plex directly a route through the container. The `/data` volume keeps shared playlists, each account's settings and Missing tracks, and what the MusicBrainz features look up, when the container is replaced (by an update, say).

More on installing, updating and running it behind HTTPS: [docs/setup.md](docs/setup.md).

## Settings

All optional, as environment variables on the container (on Proxmox: `pct exec <ID> -- plexamp-web-settings`).

| Variable | What it does |
| --- | --- |
| `PLEX_SERVER_URL` | Your Plex server's address, such as `http://192.168.1.10:32400`, for the container to reach it for browsers that can't. It also keeps the player's shared features to people who can use that server. |
| `OLLAMA_URL`, `OLLAMA_MODEL` | An [Ollama](https://ollama.com) server, and its model, for AI playlists and the AI DJ, shared with everyone who uses the player. |
| `MUSICBRAINZ_URL` | `https://musicbrainz.org` (or your own mirror), to check AI suggestions are real songs. Not set: nothing goes to MusicBrainz. |
| `MUSICBRAINZ_ADVANCED` | `true` turns on the MusicBrainz features, with `MUSICBRAINZ_URL`: the albums an artist's page is missing; albums in the order they first came out; artists found by their other names; another artist's albums of the same name kept apart; MusicBrainz's kind for albums Plex hasn't typed, for Skip live tracks and demos; and, for the server's owner, the years and genres to fix in Plex. Nothing else needs them: an artist's Singles & EPs, Compilations and the rest come from Plex. Off unless set: they ask MusicBrainz about your whole library, best with a mirror of your own. See [docs/features.md](docs/features.md#musicbrainz-features). |
| `PLAY_TOGETHER`, `CASTING`, `PLAYLIST_SHARING`, `SYNC_SETTINGS` | `false` turns off Play Together, Play on with Plex players (for the server's owner, with `PLEX_SERVER_URL`), shared playlists, or settings that follow each Plex account. |
| `SYNC_MISSING_TRACKS` | On unless set to `false`. When someone imports a playlist from Spotify (or an AI playlist suggests music) and your Plex server doesn't have some of its tracks, they're synced into the server owner's **Missing tracks**, so the owner can see what's missing from their server and add it. Each account's list also follows it to every browser. `false`: each browser keeps its own. |
| `SPOTIFY_FILE_IMPORT`, `SPOTIFY_LINK_IMPORT` | `true` turns on making playlists from Spotify's download of your data (read in the browser), or from a public Spotify playlist's link (read from Spotify's public page for it). Each is off unless set: see [docs/configuration.md](docs/configuration.md). |
| `OFFLINE_KEY`, `OFFLINE_FROM` | Offline mode, with `PLEX_SERVER_URL`: while plex.tv isn't answering (your internet's down, say), nobody can sign in with Plex, so the player takes this key instead, from your own networks (`OFFLINE_FROM`), till plex.tv is back. It plays your server as its owner, and needs your Plex server to let the player in without signing in: see [docs/configuration.md](docs/configuration.md#offline-mode). Those signed in already carry on either way. |
| `WEBSOCKETS` | `auto` (default): live updates use WebSockets, and where they don't get through (some proxies and firewalls block them), plexamp-web uses whatever does, server-sent events or polling. `on` uses WebSockets only, `off` never does. (`DISABLE_WEBSOCKETS=true`, from before, still means `off`.) |
| `DEBUG` | `true` writes extra detail to the container log, with tokens removed. |

Every setting, and how the app reaches your server: [docs/configuration.md](docs/configuration.md).

## What it does

- **Browse and search** your library: artists, albums, genres, moods, decades, collections, with live search that narrows word by word.
- **Now Playing** with a waveform from your server's loudness analysis, a favourite tick (or stars, or thumbs) that saves to Plex, Up next, gapless playback, Smart crossfades, loudness levelling and tracks loaded ahead for slow connections.
- **Playlists and collections**: make and edit them, sort them, change their pictures, export them to a file and import them again, or bring yours over from Spotify: from Spotify's download of your data, or one by its link (each if whoever runs the player turns it on).
- **Shared playlists** with your Plex friends, kept the same for everyone, and **Play Together**, to listen in sync with them.
- **Your devices** share what's playing: control your computer from your phone, or move the music to the device in your hand.
- **Play on** Plexamp and other Plex players on your network, or AirPlay and Google Cast speakers.
- **Guest DJs** that play along with your queue, and **AI playlists** from a description, with a model on your own hardware.
- **Radio** from an artist, a playlist, your favourites or the whole library.
- **Live updates** from other Plex apps, a home screen you arrange, themes from album artwork, and settings that follow your Plex account to every browser.
- **Plex Home**: switch to anyone in your Plex Home, each of you with your own playlists, ratings and settings, and nothing of one person's left for the next.
- **Days without the internet**: with your Plex server letting the player in, you, your friends and your Plex Home carry on as yourselves while plex.tv can't be reached, and an offline key of your own signs in afresh (see [docs/configuration.md](docs/configuration.md#offline-mode)).

How each part works, and the settings in the app: [docs/features.md](docs/features.md). AI playlists, the AI DJ and Ollama: [docs/ai.md](docs/ai.md).

## Documentation

| | |
| --- | --- |
| [docs/setup.md](docs/setup.md) | Installing with Docker, Compose, Portainer or Proxmox VE; updating; HTTPS |
| [docs/configuration.md](docs/configuration.md) | Every container setting, connections and routes, live updates, debug mode |
| [docs/features.md](docs/features.md) | The player's features, and what's good to know about them |
| [docs/ai.md](docs/ai.md) | AI playlists, the AI DJ, Ollama, MusicBrainz checks and missing tracks |
| [docs/troubleshooting.md](docs/troubleshooting.md) | When something doesn't work |
| [SECURITY.md](SECURITY.md) | What the player handles and where it goes, its safeguards, and reporting a problem |
| [docs/development.md](docs/development.md) | Running it from the source, the tests, and how the code is laid out |
| [CHANGELOG.md](CHANGELOG.md) | What changed in each version |

## Licence

MIT. See [LICENSE](LICENSE). The image also includes [hls.js](https://github.com/video-dev/hls.js) (Apache 2.0); its licence is in the image at `/usr/share/nginx/html/vendor/hls.js-LICENSE.txt`.
