# plexamp-web

A self-hosted web player for your Plex music library, laid out like Plexamp and built for phones first. It's one small container, and music plays straight from your Plex server in the browser.

> [!IMPORTANT]
> **Claude, an AI model made by Anthropic, wrote all of this project's code**, at the direction of the repository's owner. None of it was written by hand, and it hasn't been independently audited. Read [SECURITY.md](SECURITY.md) and review the code before you rely on it, especially before you make it reachable from the internet.

> Unofficial project. Not made, endorsed or supported by Plex.

## Install

**Docker**

```sh
docker run -d --name plexamp-web -p 8080:80 -v plexamp-web-data:/data \
  -e PLEX_SERVER_URL=http://192.168.1.10:32400 \
  --restart unless-stopped ghcr.io/kamakazedan/plexamp-web:latest
```

**Compose or Portainer**: use [docker-compose.yml](docker-compose.yml) (in Portainer, paste it in as a stack), then `docker compose up -d`.

**Proxmox VE**: in the node's shell, as root. It makes a small Debian container (LXC), without Docker.

```sh
bash -c "$(curl -fsSL https://raw.githubusercontent.com/kamakazedan/plexamp-web/stable/proxmox/plexamp-web.sh)"
```

Then open `http://<host>:8080`, choose **Sign in with Plex**, and pick your server and music library.

Updating, HTTPS and more: [docs/setup.md](docs/setup.md).

## Settings

All optional. Here's an example with the common ones, as a Compose `environment:` block:

```yaml
environment:
  PLEX_SERVER_URL: "http://192.168.1.10:32400"  # your Plex server, on your network
  OLLAMA_URL: "http://192.168.1.20:11434"       # AI playlists and the AI DJ
  OLLAMA_MODEL: "llama3.1:8b"
  MUSICBRAINZ_URL: "http://192.168.1.30:5000"   # your MusicBrainz mirror, or https://musicbrainz.org
  MUSICBRAINZ_ADVANCED: "true"                  # the MusicBrainz features
```

The names are the same everywhere: `-e NAME=value` with `docker run`, or a `NAME=value` line in the Proxmox settings file (`pct exec <ID> -- plexamp-web-settings`).

| Setting | Example | What it does |
| --- | --- | --- |
| `PLEX_SERVER_URL` | `http://192.168.1.10:32400` | Your Plex server on your network. Recommended: browsers that can't reach Plex go through the player instead. |
| `WEBSOCKETS` | `auto` (default), `on`, `off` | How live updates arrive. `auto` falls back where WebSockets are blocked. |
| `OLLAMA_URL` | `http://192.168.1.20:11434` | An Ollama server for AI playlists and the AI DJ, shared by everyone. |
| `OLLAMA_MODEL` | `llama3.1:8b` | The one model to use. Default: the first one installed. |
| `OLLAMA_AUTH` | `plex` (default), `off` | Who can use it: people signed in with Plex (only those who can use your server, with `PLEX_SERVER_URL` set), or anyone. |
| `OLLAMA_API_KEY` | | Only for an Ollama behind a proxy that asks for a key. |
| `MUSICBRAINZ_URL` | `https://musicbrainz.org` | Checks AI suggestions are real songs. A mirror of your own keeps the names on your network. |
| `MUSICBRAINZ_ADVANCED` | `true` | The MusicBrainz features: missing albums, original years, years and genres to fix. |
| `PLAY_TOGETHER` | `true` (default), `false` | Listen in sync with Plex friends. |
| `CASTING` | `true` (default), `false` | Play on Plexamp and other Plex players, for the server's owner (needs `PLEX_SERVER_URL`). |
| `PLAYLIST_SHARING` | `true` (default), `false` | Share playlists with Plex friends. |
| `SYNC_SETTINGS` | `true` (default), `false` | Your app settings follow your Plex account to every browser. |
| `SYNC_MISSING_TRACKS` | `true` (default), `false` | Missing tracks follow your account, and the server's owner sees everyone's. |
| `SPOTIFY_FILE_IMPORT` | `true` (default), `false` | Playlists from Spotify's download of your data. |
| `SPOTIFY_LINK_IMPORT` | `true`, `false` (default) | A playlist from a public Spotify link (first 100 tracks; against Spotify's terms). |
| `OFFLINE_PWD` | a long random password | Sign in with this while plex.tv is down. It signs in as your server's owner: [read this first](docs/configuration.md#offline-mode). |
| `OFFLINE_NETWORKS` | `private` (default), `192.168.1.0/24` | Where the offline password works from. |
| `DEBUG` | `true` | Extra detail in the container log, with tokens removed. |

A setting the player can't use (a typo, say) stops it from starting, and the log says why. Every setting in detail: [docs/configuration.md](docs/configuration.md).

## What it does

- **Browse and search** artists, albums, genres, moods, decades and collections, with search that narrows word by word.
- **Now Playing** with a waveform, ratings that save to Plex, Up next, gapless playback, Smart crossfades and loudness levelling.
- **Playlists and collections**: make, edit, sort and back them up, or bring yours over from Spotify.
- **Shared playlists** with Plex friends, and **Play Together** to listen in sync.
- **Your devices** share what's playing: control your computer from your phone, or move the music to the device in your hand.
- **Play on** Plexamp and other Plex players, or AirPlay and Google Cast speakers.
- **Guest DJs** and **AI playlists**, with a model on your own hardware.
- **Radio** from an artist, a playlist, your favourites or the whole library.
- **Plex Home**: switch user, each of you with your own playlists, ratings and settings.
- **Dropped connections**: what's loaded plays on, and plays and ratings reach Plex once it's back.
- **Days without the internet**: with your Plex server set to let the player in, everyone signed in carries on, and an offline password can sign in afresh.

How each part works: [docs/features.md](docs/features.md). AI playlists and the AI DJ: [docs/ai.md](docs/ai.md).

## Documentation

| | |
| --- | --- |
| [docs/setup.md](docs/setup.md) | Installing with Docker, Compose, Portainer or Proxmox VE; updating; HTTPS |
| [docs/configuration.md](docs/configuration.md) | Every setting, reaching your server, offline mode, live updates, debug mode |
| [docs/features.md](docs/features.md) | What the player does, and what's good to know |
| [docs/ai.md](docs/ai.md) | AI playlists, the AI DJ, Ollama and Missing tracks |
| [docs/troubleshooting.md](docs/troubleshooting.md) | When something doesn't work |
| [SECURITY.md](SECURITY.md) | What the player handles, where it goes, and reporting a problem |
| [docs/development.md](docs/development.md) | Running it from the source, the tests, and the code's layout |
| [CHANGELOG.md](CHANGELOG.md) | What changed in each version |

## Licence

MIT: see [LICENSE](LICENSE). The image includes [hls.js](https://github.com/video-dev/hls.js) (Apache 2.0), with its licence at `/usr/share/nginx/html/vendor/hls.js-LICENSE.txt`.
