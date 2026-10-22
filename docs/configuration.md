# Configuration

- [Container settings](#container-settings)
- [Reaching your Plex server](#reaching-your-plex-server)
- [Live updates](#live-updates)
- [Debug mode](#debug-mode)

Settings in the app itself are kept per device: see [features.md](features.md#settings-in-the-app).

## Container settings

All optional. Set them as environment variables on the container; on Proxmox VE, run `pct exec <ID> -- plexamp-web-settings` (see [setup.md](setup.md#proxmox-ve)).

| Variable | Example | What it does |
| --- | --- | --- |
| `PLEX_SERVER_URL` | `http://192.168.1.10:32400` | Your Plex server's address on your network. The container proxies it at `/pms/`, giving browsers that can't reach Plex directly a route through the container (see below). `https://` works too. With it set, the container's service is for the people who can use that server: the shared AI model, MusicBrainz checks, Play Together, your devices and shared playlists (and Play on, for its owner). |
| `DISABLE_WEBSOCKETS` | `true` | The app never opens a WebSocket. Live updates use Plex's event stream, or check every minute. |
| `OLLAMA_URL` | `http://192.168.1.20:11434` | An Ollama server whose model the people who use the player share (see [ai.md](ai.md)). |
| `OLLAMA_MODEL` | `llama3.1:8b` | The one model the app uses. The server's other models can't be used or seen. Not set: the first model installed. |
| `OLLAMA_API_KEY` | | Sent as a bearer token, for an Ollama behind a proxy that asks for one. Never reaches browsers. |
| `OLLAMA_AUTH` | `plex` (default) or `off` | Who may use the shared model: `plex`, people signed in with Plex who can use your server (see [ai.md](ai.md#who-can-use-the-shared-model)); `off`, anyone who can open the player. |
| `MUSICBRAINZ_URL` | `https://musicbrainz.org`, or your own, like `http://192.168.1.30:5000` | The MusicBrainz that AI playlists check their suggestions with, to leave out made-up ones (see [ai.md](ai.md#checking-suggestions-on-musicbrainz)). Not set: no checks, and nothing goes to MusicBrainz. |
| `PLAY_TOGETHER` | `true` (default) or `false` | Play Together and its tab. |
| `CASTING` | `true` (default) or `false` | Playing on other Plex players from the app, for the server's owner: it needs `PLEX_SERVER_URL`. AirPlay and Cast, which are the browser's own, aren't affected. |
| `PLAYLIST_SHARING` | `true` (default) or `false` | Sharing playlists with Plex friends. |
| `SPOTIFY_IMPORT` | `true`, or `false` (default) | **Search › From Spotify**: paste a Spotify playlist's link, and the tracks you have make a playlist here (see [features.md](features.md#from-spotify)). Off unless you turn it on: Spotify's API only gives a playlist's tracks to the account that owns it, so the container reads them from the page Spotify shows anyone for the playlist instead. That page lists the first 100 tracks at most, Spotify's terms don't allow reading it like this, and it can stop working whenever Spotify changes it. For the people who can use your server, as the shared AI model is. |
| `DATA_DIR` | `/data` (default) | Where shared playlists are kept: a folder of their own (give the container a volume there). |
| `DEBUG` | `true` | Writes extra detail to the container log, with tokens removed (see [Debug mode](#debug-mode)). |

The container stops with a clear message in its log if a value doesn't make sense, for example an address without `http://`.

## Reaching your Plex server

When you pick your server, the app tries each way to reach it at once and uses the best that answers:

1. **On your network**: straight to the server's local address.
2. **Through this container**, with `PLEX_SERVER_URL` set: the browser talks only to the player's address, and the container passes requests on to Plex.
3. **Over the internet**: the server's remote address (with Remote Access on in Plex). Only an `https://` one: a plain `http://` address over the internet would carry your sign-in unencrypted, so a server with secure connections turned off in Plex is reached through the relay instead, as in Plex's own apps.
4. **Plex's relay**: the last resort, and slow.

`PLEX_SERVER_URL` helps when the browser can't use the server's local address. That happens when the player is served over HTTPS but Plex's local address is plain HTTP, when the router won't look up `*.plex.direct` addresses that point into the home network (DNS rebinding protection), when the browser keeps a page from the internet out of the home network (Chrome asks first), or on a work network that only allows ordinary web traffic to one address. You still sign in; the container only carries the traffic.

**Settings › Connection** in the app says which route is in use and why. **Test connection** times the server's answer, and tries each route (how long each took, or why it didn't answer). With `PLEX_SERVER_URL` set, **Route to the server** chooses:

- **Best that answers** (the default): in the order above.
- **Through this container**: always, while it answers.
- **Straight to the server**: its own addresses first, on your network or over the internet; through the container only when they don't answer.

The server `PLEX_SERVER_URL` points at is listed once in **Settings › Source**, as that server ("also set up for this app"), when it's one of yours on plex.tv; otherwise it's listed as **Server set up for this app**.

An `https://` address works too, such as `https://192.168.1.10:32400` for a server set to require secure connections. A Plex server's certificate is for its own `plex.direct` name, which an address like that can't match, so the container accepts the server's Plex certificate there and nothing else. At a name (`https://plex.example.com`), the certificate must be for that name, as in a browser. A certificate that can't be checked (a self-signed one, say) means the container can't tell whether the server would let anyone in, so nothing goes through `/pms/`, and the log says why. `http://` is simpler on a home network.

## Live updates

New music, playlist changes and ratings from other Plex apps show up without reloading. The app tries, in order:

1. **A WebSocket**: instant.
2. **Plex's event stream**: also instant, over plain HTTP, so it gets through most proxies that block WebSockets. A proxy that holds the stream back is noticed within about 25 seconds.
3. **Checking for changes every minute**: works through anything.

When a WebSocket can't connect from a network, the app remembers that for six hours and goes straight to the event stream. Nothing else uses WebSockets: browsing, playback, ratings, playlists, Play Together and the AI features are ordinary HTTP requests.

- To turn WebSockets off for everyone, set `DISABLE_WEBSOCKETS=true`.
- To turn them off on one device, such as a work laptop: **Settings › Connection › Live updates › Without WebSockets**.
- Behind a reverse proxy, turn on its WebSockets support if it has a switch for it.

## Debug mode

If something doesn't work, set `DEBUG=true` on the container, restart it, and watch its log (`docker logs -f plexamp-web`, or the container's Logs page in Portainer; on Proxmox, see [setup.md](setup.md#proxmox-ve)). You'll see:

- the settings the container started with (secrets show only as "set") and the `config.js` it wrote;
- whether the container can reach your Plex server, Ollama and plex.tv;
- every request as a path and status code (`GET /pms/library/sections 502`), without query strings;
- nginx's own errors for the Plex proxy (timeouts, refused connections, TLS problems), with tokens removed;
- what the service does (sign-in checks, Play Together sessions);
- problems from browsers: failed requests, tracks that won't play, converted streams that fail part-way (which part, what the server answered, and what the player did about it), script errors, and which connection and live-update route each device uses (a limited number of lines a minute, as anyone who can open the player could send them).

Tokens and keys are replaced with `[redacted]` everywhere, but the log does show server addresses, people's names and the names of tracks: share it with care, and turn debug mode off when you're done. **Settings › Connection** in the app shows whether it's on.
