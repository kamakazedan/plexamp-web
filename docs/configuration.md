# Configuration

- [Container settings](#container-settings)
- [Reaching your Plex server](#reaching-your-plex-server)
- [Live updates](#live-updates)
- [Debug mode](#debug-mode)

Settings in the app itself follow each Plex account (but those that are each device's own): see [features.md](features.md#settings-in-the-app).

## Container settings

All optional. Set them as environment variables on the container; on Proxmox VE, run `pct exec <ID> -- plexamp-web-settings` (see [setup.md](setup.md#proxmox-ve)).

| Variable | Example | What it does |
| --- | --- | --- |
| `PLEX_SERVER_URL` | `http://192.168.1.10:32400` | Your Plex server's address on your network. The container proxies it at `/pms/`, giving browsers that can't reach Plex directly a route through the container (see below). `https://` works too. With it set, the container's service is for the people who can use that server: the shared AI model, MusicBrainz checks, Play Together, your devices and shared playlists (and Play on, for its owner). |
| `WEBSOCKETS` | `auto` (default), `on` or `off` | How live updates reach the app (see [Live updates](#live-updates)). `auto`: a WebSocket, and where WebSockets don't work (some proxies and firewalls block them), plexamp-web uses whatever is available instead: Plex's event stream, or checking every minute. `on`: WebSockets only, never anything else (for a network where you know they work). `off`: never a WebSocket. `DISABLE_WEBSOCKETS=true`, its name before 0.25.0, still means `off`, unless `WEBSOCKETS` is set too. |
| `OLLAMA_URL` | `http://192.168.1.20:11434` | An Ollama server whose model the people who use the player share (see [ai.md](ai.md)). |
| `OLLAMA_MODEL` | `llama3.1:8b` | The one model the app uses. The server's other models can't be used or seen. Not set: the first model installed. |
| `OLLAMA_API_KEY` | | Sent as a bearer token, for an Ollama behind a proxy that asks for one. Never reaches browsers. |
| `OLLAMA_AUTH` | `plex` (default) or `off` | Who may use the shared model: `plex`, people signed in with Plex who can use your server (see [ai.md](ai.md#who-can-use-the-shared-model)); `off`, anyone who can open the player. |
| `MUSICBRAINZ_URL` | `https://musicbrainz.org`, or your own, like `http://192.168.1.30:5000` | The MusicBrainz that AI playlists check their suggestions with, to leave out made-up ones (see [ai.md](ai.md#checking-suggestions-on-musicbrainz)). Not set: no checks, and nothing goes to MusicBrainz. |
| `PLAY_TOGETHER` | `true` (default) or `false` | Play Together and its tab. |
| `CASTING` | `true` (default) or `false` | Playing on other Plex players from the app, for the server's owner: it needs `PLEX_SERVER_URL`. AirPlay and Cast, which are the browser's own, aren't affected. |
| `PLAYLIST_SHARING` | `true` (default) or `false` | Sharing playlists with Plex friends. |
| `SYNC_SETTINGS` | `true` (default) or `false` | Each Plex account's settings kept here, so they follow it to every browser it signs in on (but those that are each device's own: see [features.md](features.md#settings-in-the-app)). For Plex accounts that can use the server the app is on, and with `PLEX_SERVER_URL` set, that server. Kept in `DATA_DIR`. |
| `SYNC_MISSING_TRACKS` | `true` (default) or `false` | When someone imports a playlist from Spotify (or an AI playlist suggests music) and some of its tracks aren't on your Plex server, they go on their **Missing tracks**, and this syncs them into the Plex server owner's Missing tracks, so the owner can see what's missing from their server and add it: everyone's, saying whose each is, how often and when (see [ai.md](ai.md#on-every-device-and-for-the-servers-owner)). Each account's list also follows it to every browser it signs in on. Never what anyone asked an AI for, or a Spotify playlist's name. For Plex accounts that can use the server the app is on, and with `PLEX_SERVER_URL` set, that server. Kept in `DATA_DIR`. `false`: each browser keeps its own, and the owner sees only theirs. |
| `SPOTIFY_FILE_IMPORT` | `true`, or `false` (default) | **Search › From Spotify**, from Spotify's download of your data: all your playlists, however long, and your Liked Songs, with a free Spotify account (see [features.md](features.md#from-spotify)). Its playlist files are read in the browser: nothing goes to this container or to Spotify. Off unless you turn it on, for now, while it's tried with real downloads from Spotify. |
| `SPOTIFY_LINK_IMPORT` | `true`, or `false` (default) | **Search › From Spotify** from a public Spotify playlist's link (**Use a link instead**, with `SPOTIFY_FILE_IMPORT` on too): paste the link, and the tracks you have make a playlist here, straight away (see [features.md](features.md#from-a-link)). Off unless you turn it on: Spotify's API only gives a playlist's tracks to the account that owns it, so the container reads them from the page Spotify shows anyone for the playlist instead. That page lists the first 100 tracks at most, Spotify's terms don't allow reading it like this, and it can stop working whenever Spotify changes it. For the people who can use your server, as the shared AI model is. (`SPOTIFY_IMPORT`, its name before 0.22.0, still works; `SPOTIFY_LINK_IMPORT`, when set, wins.) |
| `DATA_DIR` | `/data` (default) | Where shared playlists, and each account's settings and Missing tracks, are kept: a folder of their own (give the container a volume there). |
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

New music, playlist changes and ratings from other Plex apps show up without reloading. With `WEBSOCKETS=auto` (the default), the app tries, in order:

1. **A WebSocket**: instant.
2. **Plex's event stream**: also instant, over plain HTTP, so it gets through most proxies that block WebSockets. A proxy that holds the stream back is noticed within about 25 seconds.
3. **Checking for changes every minute**: works through anything.

So where WebSockets don't work, nothing needs setting: each device uses whatever its network lets through. When a WebSocket can't connect from a network, the app remembers that for six hours and goes straight to the event stream. Nothing else uses WebSockets: browsing, playback, ratings, playlists, Play Together and the AI features are ordinary HTTP requests.

- `WEBSOCKETS=on` forces WebSockets: the app never falls back, and keeps trying a WebSocket where one won't connect.
- `WEBSOCKETS=off` disables them completely: the event stream, or checking every minute.
- **Settings › Connection › Live updates** shows how this device gets them, and why. **Test connection** there tries again from the top (a WebSocket first, even one that failed lately).
- Behind a reverse proxy, turn on its WebSockets support if it has a switch for it.

## Debug mode

If something doesn't work, set `DEBUG=true` on the container, restart it, and watch its log (`docker logs -f plexamp-web`, or the container's Logs page in Portainer; on Proxmox, see [setup.md](setup.md#proxmox-ve)). You'll see:

- the settings the container started with (secrets show only as "set") and the `config.js` it wrote;
- whether the container can reach your Plex server, Ollama and plex.tv;
- every request as a path and status code (`GET /pms/library/sections 502`), without query strings, except what every open player asks every few seconds (your devices waiting for news, the playing one's report, Play Together looking for invitations) unless it goes wrong;
- nginx's own errors for the Plex proxy (timeouts, refused connections, TLS problems), with tokens removed;
- what the service does: sign-in checks, Play Together sessions, which of your devices plays, the commands your other devices send it (only what kind: pause, next), and a playing device it stops hearing from (and, from the browsers, a device losing touch with the service and getting it back);
- problems from browsers: failed requests, tracks that won't play, converted streams that fail part-way (which part, what the server answered, and what the player did about it), playback waiting for data part-way through a track (for how long, and how much was buffered, and as it waits past 8 seconds), script errors, which connection and live-update route each device uses, and every pause with what caused it: the play button, the space bar, media keys, a headset or the system's media controls, another of your devices (by name), Play Together, the sleep timer, the end of the queue, tracks that won't play, or the browser itself (a limited number of lines a minute, as anyone who can open the player could send them).

Lines from browsers start `plexamp-web browser` and the start of the browser's own id, so one device's can be told apart (`plexamp-web browser 1a2b3c4d: info player: paused “Song” at 81.2 s: media keys, a headset or the system’s media controls`). The browser's console shows them too, as `[plexamp-web]`.

Tokens and keys are replaced with `[redacted]` everywhere, but the log does show server addresses, people's names and the names of tracks: share it with care, and turn debug mode off when you're done. **Settings › Connection** in the app shows whether it's on.
