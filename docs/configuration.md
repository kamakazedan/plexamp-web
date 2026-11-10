# Configuration

- [Settings](#settings)
- [Examples](#examples)
- [Reaching your Plex server](#reaching-your-plex-server)
- [Offline mode](#offline-mode)
- [Live updates](#live-updates)
- [Debug mode](#debug-mode)

## Settings

All optional. Set them as environment variables on the container. On Proxmox VE, run `pct exec <ID> -- plexamp-web-settings`.

Settings in the app itself (themes, playback and so on) follow each Plex account: see [features.md](features.md#settings-in-the-app).

### Plex

| Setting | Example | What it does |
| --- | --- | --- |
| `PLEX_SERVER_URL` | `http://192.168.1.10:32400` | Your Plex server's own address on your network. Browsers that can't reach Plex directly go through the player (at `/pms/`). It also keeps the player's shared features to people who can use this server. |

- Use the server itself, not another proxy in front of it, at one fixed address. A name with several addresses only lets you, the owner, through.
- `https://192.168.1.10:32400` works too (for a server set to require secure connections). See [Reaching your Plex server](#reaching-your-plex-server).
- Plex sees every request through the player as coming from the player's own address.

### Live updates

| Setting | Example | What it does |
| --- | --- | --- |
| `WEBSOCKETS` | `auto` (default), `on`, `off` | `auto`: WebSockets, or where they're blocked, an event stream, or checking every minute. `on`: WebSockets only. `off`: never WebSockets. |

`DISABLE_WEBSOCKETS=true`, the old name, still means `off`. See [Live updates](#live-updates).

### AI

| Setting | Example | What it does |
| --- | --- | --- |
| `OLLAMA_URL` | `http://192.168.1.20:11434` | An Ollama server whose model everyone using the player shares, for AI playlists and the AI DJ. See [ai.md](ai.md). |
| `OLLAMA_MODEL` | `llama3.1:8b` | The one model the app uses, exactly as `ollama list` shows it. Default: the first one installed. Nobody can see or choose the others. |
| `OLLAMA_AUTH` | `plex` (default), `off` | `plex`: people signed in with Plex (with `PLEX_SERVER_URL` set, only those who can use your server). `off`: anyone who can open the player. |
| `OLLAMA_API_KEY` | | Sent to Ollama as a bearer token, for an Ollama behind a proxy that asks for one. Never reaches browsers. |

`OLLAMA_MODEL`, `OLLAMA_API_KEY` and `OLLAMA_AUTH=off` need `OLLAMA_URL`: set without it, the container doesn't start, and says why.

### MusicBrainz

| Setting | Example | What it does |
| --- | --- | --- |
| `MUSICBRAINZ_URL` | `https://musicbrainz.org`, or your mirror: `http://192.168.1.30:5000` | Checks that AI playlists' suggestions are real songs. Not set: nothing goes to MusicBrainz. See [ai.md](ai.md#checking-suggestions-on-musicbrainz). |
| `MUSICBRAINZ_ADVANCED` | `true` | Turns on the [MusicBrainz features](features.md#musicbrainz-features): missing albums on artist pages, original release years, artists' other names, and for the server's owner, years and genres to fix. Needs `MUSICBRAINZ_URL`. |

- The features look up your whole library: musicbrainz.org allows one request a second, so a mirror of your own is much quicker, and keeps the names on your network.
- What MusicBrainz says is kept in `/data` for a month. Each person can turn each feature off in **Settings › MusicBrainz**.
- `MUSICBRAINZ=false`, the old setting, still turns the checks off.

### Sharing and sync

| Setting | Example | What it does |
| --- | --- | --- |
| `PLAY_TOGETHER` | `true` (default), `false` | Play Together: listening in sync with Plex friends. |
| `CASTING` | `true` (default), `false` | Play on Plexamp and other Plex players, for the server's owner. Needs `PLEX_SERVER_URL`. AirPlay and Cast, the browser's own, aren't affected. |
| `PLAYLIST_SHARING` | `true` (default), `false` | Sharing playlists with Plex friends. |
| `SYNC_SETTINGS` | `true` (default), `false` | Each Plex account's app settings, kept by the player so they follow it to every browser. |
| `SYNC_MISSING_TRACKS` | `true` (default), `false` | Each account's Missing tracks, kept by the player, and everyone's shown to the server's owner. `false`: each browser keeps its own. |

Shared playlists, settings and Missing tracks are kept in `/data`, for Plex accounts that can use your server.

### Spotify

| Setting | Example | What it does |
| --- | --- | --- |
| `SPOTIFY_FILE_IMPORT` | `true` (default), `false` | **Search › From Spotify** from Spotify's download of your data: all your playlists and Liked Songs. The files are read in the browser, and never go to the player or to Spotify. |
| `SPOTIFY_LINK_IMPORT` | `true`, `false` (default) | **Search › From Spotify** from a public playlist's link. The player reads Spotify's public page for it: the first 100 tracks only, against Spotify's terms, and it can stop working whenever Spotify changes the page. |

`SPOTIFY_IMPORT`, the old name for `SPOTIFY_LINK_IMPORT`, still works. See [features.md](features.md#from-spotify).

### Offline mode

| Setting | Example | What it does |
| --- | --- | --- |
| `OFFLINE_PWD` | a long random password | While plex.tv is down, the player can be signed in to with this, as your Plex server's owner. Needs `PLEX_SERVER_URL`. [Read about it first](#offline-mode). |
| `OFFLINE_NETWORKS` | `private` (default), `any`, `192.168.1.0/24,10.8.0.0/16` | Where the offline password works from. `private`: your own networks (10.x, 172.16–31.x, 192.168.x, 100.64–127.x for Tailscale, 127.x, 169.254.x and local IPv6). |

- The password: 12 to 200 letters, digits and `. _ ~ + / = : , @ -`. Make one with `openssl rand -base64 24`.
- With Compose, keep it out of `docker-compose.yml` (often shared or committed): put it in an `env_file` of its own.

### Advanced

| Setting | Example | What it does |
| --- | --- | --- |
| `DEBUG` | `true` | Extra detail in the container log, with tokens removed. See [Debug mode](#debug-mode). |
| `DATA_DIR` | `/data` (default; `/var/lib/plexamp-web` on Proxmox VE) | Where shared playlists, account settings, Missing tracks and MusicBrainz answers are kept. Give the container a volume there. |
| `NGINX_ACCESS_LOG` | `/dev/stdout` (default) | In debug mode, where nginx's log of requests goes. |
| `NGINX_LOG_PORT` | `5140` (default) | In debug mode, the local UDP port nginx sends its errors to, to have tokens removed. |

### When the container won't start

It stops, saying why in its log, when:

- a value doesn't make sense (an address without `http://`, say);
- a setting needs another that isn't set (`MUSICBRAINZ_ADVANCED` without `MUSICBRAINZ_URL`, say);
- a name looks like one of its own but isn't (`SYNC_SETING`: it asks whether you meant `SYNC_SETTINGS`).

So nothing you set is ignored without you knowing. Other names starting `PLEX_` or `OLLAMA_` are only mentioned in the log, as Plex's and Ollama's own containers have settings like that.

## Examples

A typical Compose setup:

```yaml
services:
  plexamp-web:
    image: ghcr.io/kamakazedan/plexamp-web:latest
    ports:
      - "8080:80"
    environment:
      PLEX_SERVER_URL: "http://192.168.1.10:32400"
      OLLAMA_URL: "http://192.168.1.20:11434"
      OLLAMA_MODEL: "llama3.1:8b"
      MUSICBRAINZ_URL: "http://192.168.1.30:5000"
      MUSICBRAINZ_ADVANCED: "true"
    # env_file: plexamp-web.env   # secrets, such as OFFLINE_PWD, in a file of their own (chmod 600)
    volumes:
      - plexamp-web-data:/data
    restart: unless-stopped
volumes:
  plexamp-web-data:
```

The same settings as a settings file (the Proxmox VE one, or an `env_file`), one per line:

```sh
PLEX_SERVER_URL=http://192.168.1.10:32400
OLLAMA_URL=http://192.168.1.20:11434
OLLAMA_MODEL=llama3.1:8b
MUSICBRAINZ_URL=http://192.168.1.30:5000
MUSICBRAINZ_ADVANCED=true
```

Settings left empty (`OLLAMA_API_KEY=`) are the same as not set. [docker-compose.yml](../docker-compose.yml) has every setting.

## Reaching your Plex server

When you pick your server, the app tries every way to reach it at once and uses the best that answers:

1. **On your network**: straight to the server's local address.
2. **Through the player**, with `PLEX_SERVER_URL` set: the browser only talks to the player.
3. **Over the internet**: the server's remote address (with Remote Access on in Plex), `https://` only.
4. **Plex's relay**: the last resort, and slow.

`PLEX_SERVER_URL` helps when the browser can't use the server's local address:

- the player is served over HTTPS, but Plex's local address is plain HTTP;
- the router blocks `*.plex.direct` addresses that point into your network (DNS rebinding protection);
- the browser keeps a page from the internet out of your network (Chrome asks first);
- a work network only allows ordinary web traffic, to one address.

You still sign in with Plex: the player only carries the traffic.

In the app, **Settings › Connection** shows the route in use, and **Test connection** times each one. With `PLEX_SERVER_URL` set, **Route to the server** can be:

- **Best that answers** (default): in the order above.
- **Through this container**: always, while it answers.
- **Straight to the server**: through the player only when nothing else answers.

**HTTPS addresses.** A Plex server's certificate is for its `plex.direct` name, so at `https://192.168.1.10:32400` the player checks it's a Plex certificate instead. At a name (`https://plex.example.com`), the certificate must match the name, as in a browser. One that can't be checked (a self-signed one, say) lets nothing through, and the log says why. On a home network, `http://` is simpler.

## Offline mode

Plex servers keep working without the internet, but signing in needs plex.tv. Offline mode keeps the player usable when plex.tv can't be reached.

**Setting it up:**

1. In Plex, add the player's address to **Settings › Network › Show Advanced › List of IP addresses and networks that are allowed without auth**. Add only that one address, never your whole network: Plex treats anything from an address on the list as you, its owner.
   - On Proxmox VE, that's the container's own address.
   - In Docker with Plex on another machine, it's usually the Docker machine's address, which lets in everything else on that machine too. A network that gives the container its own address (macvlan, say) avoids that.
2. Set `OFFLINE_PWD` on the player (and `OFFLINE_NETWORKS`, to use it from anywhere but your own networks).

**With the player on that list**, it checks each request to your server before it goes:

- **You** use it as before. While plex.tv is down, your devices carry on: the player knows your sign-ins by a fingerprint of each, which can't be turned back into the sign-in.
- **Friends and your Plex Home** get through as themselves, and only if your server knows them as themselves (the player asks it first). Some Plex servers take everything from a listed address as their owner's: then only you get through, and the log says so.
- **Anyone else** is refused.

**While plex.tv is down** (no answer for 20 seconds):

- The sign-in page takes the offline password. It signs in **as you**, with your playlists, ratings and history, so only give it to people you'd trust with your Plex account.
- Play Together, your devices, shared playlists and synced settings wait for a Plex sign-in.
- Two minutes after plex.tv is back, everyone signed in with the password is signed out.

**Limits on the password:** it only works from `OFFLINE_NETWORKS`, five tries a minute from an address, and none from an address for the rest of the hour after 30 wrong ones from it. More in [SECURITY.md](../SECURITY.md#offline-mode).

Without the player on that list there's no offline mode, and the sign-in page says why while plex.tv is down.

## Live updates

New music, playlist changes and ratings from other Plex apps show up without reloading. With `WEBSOCKETS=auto` (the default), the app tries:

1. **A WebSocket**: instant.
2. **Plex's event stream**: also instant, and it gets through most proxies that block WebSockets.
3. **Checking every minute**: works through anything.

Nothing needs setting where WebSockets are blocked: each device uses whatever gets through, and remembers it for six hours. Only live updates use WebSockets: playback, Play Together and everything else work without them.

- `WEBSOCKETS=on`: WebSockets only, never anything else.
- `WEBSOCKETS=off`: never WebSockets.
- **Settings › Connection › Live updates** shows what this device uses, and why.
- Behind a reverse proxy, turn on its WebSockets support if it has a switch for it.

## Debug mode

If something doesn't work, set `DEBUG=true`, restart the container, and watch its log:

- Docker: `docker logs -f plexamp-web`, or the container's **Logs** in Portainer.
- Proxmox VE: `pct exec <ID> -- journalctl -u plexamp-web -u plexamp-web-config -f`.

It shows:

- the settings it started with (secrets only as "set");
- whether it can reach your Plex server, Ollama and plex.tv;
- each request as a path and status (`GET /pms/library/sections 502`), without query strings;
- nginx's own errors (timeouts, refused connections, TLS problems);
- what the service does: sign-in checks, Play Together, your devices, and how MusicBrainz is answering (once a minute while it's busy);
- problems from browsers: tracks that won't play, waits for data part-way through a track, what caused each pause, script errors, and the route each device uses.

Lines from browsers start with `plexamp-web browser` and the start of the browser's id, so one device can be told from another:

```
plexamp-web browser 1a2b3c4d: info player: paused “Song” at 81.2 s: media keys, a headset or the system’s media controls
```

Tokens, keys and PINs show as `[redacted]`, but the log has server addresses, people's names and track names: share it with care, and turn debug mode off when you're done. **Settings › Connection** in the app shows whether it's on.
