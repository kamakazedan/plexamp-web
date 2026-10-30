# Configuration

- [Container settings](#container-settings)
- [Reaching your Plex server](#reaching-your-plex-server)
- [Offline mode](#offline-mode)
- [Live updates](#live-updates)
- [Debug mode](#debug-mode)

Settings in the app itself follow each Plex account (but those that are each device's own): see [features.md](features.md#settings-in-the-app).

## Container settings

All optional. Set them as environment variables on the container; on Proxmox VE, run `pct exec <ID> -- plexamp-web-settings` (see [setup.md](setup.md#proxmox-ve)).

| Variable | Example | What it does |
| --- | --- | --- |
| `PLEX_SERVER_URL` | `http://192.168.1.10:32400` | Your Plex server's address on your network: the server itself, not another proxy in front of it, at an address or a name with one address (with more, nginx takes turns between them, and only you get through `/pms/`: the log says so). The container proxies it at `/pms/`, giving browsers that can't reach Plex directly a route through the container (see below). `https://` works too. Plex sees every request through the container as from the container's own address (nothing of where it came from is passed on), so it takes them all as from your network. With it set, the container's service is for the people who can use that server: the shared AI model, MusicBrainz checks and features, Play Together, your devices, shared playlists, settings and Missing tracks that follow each account, and Spotify link import (and Play on, for its owner). |
| `WEBSOCKETS` | `auto` (default), `on` or `off` | How live updates reach the app (see [Live updates](#live-updates)). `auto`: a WebSocket, and where WebSockets don't work (some proxies and firewalls block them), plexamp-web uses whatever is available instead: Plex's event stream, or checking every minute. `on`: WebSockets only, never anything else (for a network where you know they work). `off`: never a WebSocket. `DISABLE_WEBSOCKETS=true`, its name before 0.25.0, still means `off`, unless `WEBSOCKETS` is set too. Empty is `auto`; `false` is `off`; `true` isn't taken (it could be meant as either `auto` or `on`), and the container says so as it starts. |
| `OLLAMA_URL` | `http://192.168.1.20:11434` | An Ollama server whose model the people who use the player share (see [ai.md](ai.md)). |
| `OLLAMA_MODEL` | `llama3.1:8b` | The one model the app uses. The server's other models can't be used or seen. Not set: the first model installed. |
| `OLLAMA_API_KEY` | | Sent as a bearer token, for an Ollama behind a proxy that asks for one. Never reaches browsers. |
| `OLLAMA_AUTH` | `plex` (default) or `off` | Who may use the shared model: `plex`, people signed in with Plex who can use your server (see [ai.md](ai.md#who-can-use-the-shared-model)); `off`, anyone who can open the player. |
| `MUSICBRAINZ_URL` | `https://musicbrainz.org`, or your own, like `http://192.168.1.30:5000` | The MusicBrainz that AI playlists check their suggestions with, to leave out made-up ones (see [ai.md](ai.md#checking-suggestions-on-musicbrainz)). Not set: no checks, and nothing goes to MusicBrainz. (`MUSICBRAINZ`, its name in 0.12.0: `false` still turns the checks off, even with `MUSICBRAINZ_URL` set; `true` alone means musicbrainz.org.) |
| `MUSICBRAINZ_ADVANCED` | `true`, or `false` (default) | The MusicBrainz features, with `MUSICBRAINZ_URL` (see [features.md](features.md#musicbrainz-features)): the albums missing from an artist's page, albums in the order they first came out, artists found by their other names, MusicBrainz's kind for albums Plex hasn't typed (for **Skip live tracks and demos**, in Settings › Playback, which is on to begin with here), and for the server's owner, the years and genres to fix in Plex. Nothing else needs them: what the app shows of your library (an artist's Singles & EPs, Compilations and the rest) is Plex's, with or without them. They look your library's artists up on that MusicBrainz (once a second at most on musicbrainz.org, so a big library takes a while there: a mirror of your own is best, and keeps the names on your network), and keep what it says in `DATA_DIR` for a month. Each person can turn each one off (Settings › MusicBrainz). |
| `PLAY_TOGETHER` | `true` (default) or `false` | Play Together and its tab. |
| `CASTING` | `true` (default) or `false` | Playing on other Plex players from the app, for the server's owner: it needs `PLEX_SERVER_URL`. AirPlay and Cast, which are the browser's own, aren't affected. |
| `PLAYLIST_SHARING` | `true` (default) or `false` | Sharing playlists with Plex friends. |
| `SYNC_SETTINGS` | `true` (default) or `false` | Each Plex account's settings kept here, so they follow it to every browser it signs in on (but those that are each device's own: see [features.md](features.md#settings-in-the-app)). For Plex accounts that can use the server the app is on, and with `PLEX_SERVER_URL` set, that server. Kept in `DATA_DIR`. |
| `SYNC_MISSING_TRACKS` | `true` (default) or `false` | When someone imports a playlist from Spotify (or an AI playlist suggests music) and some of its tracks aren't on your Plex server, they go on their **Missing tracks**, and this syncs them into the Plex server owner's Missing tracks, so the owner can see what's missing from their server and add it: everyone's, saying whose each is, how often and when (see [ai.md](ai.md#on-every-device-and-for-the-servers-owner)). Each account's list also follows it to every browser it signs in on. Never what anyone asked an AI for, or a Spotify playlist's name. For Plex accounts that can use the server the app is on, and with `PLEX_SERVER_URL` set, that server. Kept in `DATA_DIR`. `false`: each browser keeps its own, and the owner sees only theirs. |
| `SPOTIFY_FILE_IMPORT` | `true`, or `false` (default) | **Search › From Spotify**, from Spotify's download of your data: all your playlists, however long, and your Liked Songs, with a free Spotify account (see [features.md](features.md#from-spotify)). Its playlist files are read in the browser: nothing goes to this container or to Spotify. Off unless you turn it on, for now, while it's tried with real downloads from Spotify. |
| `SPOTIFY_LINK_IMPORT` | `true`, or `false` (default) | **Search › From Spotify** from a public Spotify playlist's link (**Use a link instead**, with `SPOTIFY_FILE_IMPORT` on too): paste the link, and the tracks you have make a playlist here, straight away (see [features.md](features.md#from-a-link)). Off unless you turn it on: Spotify's API only gives a playlist's tracks to the account that owns it, so the container reads them from the page Spotify shows anyone for the playlist instead. That page lists the first 100 tracks at most, Spotify's terms don't allow reading it like this, and it can stop working whenever Spotify changes it. For people signed in with Plex who can use your server (whatever `OLLAMA_AUTH` says). (`SPOTIFY_IMPORT`, its name before 0.22.0, still works; `SPOTIFY_LINK_IMPORT`, when set, wins.) |
| `OFFLINE_KEY` | a long random key of your own | Offline mode, with `PLEX_SERVER_URL`: while plex.tv isn't answering (your internet's down, say), nobody can sign in with Plex, so the player can be signed in to with this key instead, till plex.tv is back. It plays your Plex server as the server lets this container in without signing in, which is as you, its owner: see [Offline mode](#offline-mode) for what that needs, and what it means. 12 to 200 characters, of letters, digits and `. _ ~ + / = : , @ -` only (settings files can change others, such as `#`, `$` or quotes, so the key would be another): a long random one is best (`openssl rand -base64 24` makes one). Not set: no offline mode. |
| `OFFLINE_FROM` | `private` (default), `any`, or `192.168.1.0/24,10.8.0.0/16` | Where the offline key can be used from: `private`, your own networks (10.x, 172.16 to 172.31, 192.168.x, 100.64 to 100.127 for Tailscale, 127.x and 169.254.x, and IPv6's local addresses); `any`, anywhere; or the addresses and networks you list, separated by commas. Behind another proxy (a reverse proxy), the container sees that proxy's address, so limit where it's used from there too. In Docker, browsers that reach the container over IPv6 can come from its network's gateway (172.17.0.1, say), which is a private address. |
| `DATA_DIR` | `/data` (default; `/var/lib/plexamp-web` on Proxmox VE) | Where shared playlists, each account's settings and Missing tracks, what the MusicBrainz features looked up, and (with `PLEX_SERVER_URL`) the fingerprints of your own sign-ins, as the server's owner (see [Offline mode](#offline-mode)), are kept: a folder of their own (give the container a volume there). Where it can't be used, those (shared playlists, the settings and Missing tracks that follow each account) are off, and what MusicBrainz said and your sign-ins' fingerprints are kept in memory only, and the log says why; nothing else depends on it. |
| `DEBUG` | `true` | Writes extra detail to the container log, with tokens removed (see [Debug mode](#debug-mode)). |
| `NGINX_ACCESS_LOG` | `/dev/stdout` (default; syslog on Proxmox VE) | Where nginx's log of requests goes, in debug mode (it keeps none otherwise). |

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

## Offline mode

A Plex server carries on without the internet, but signing in to Plex needs plex.tv. For days without the internet, the player can be ready for that:

1. **Let the player in without signing in**, in Plex: **Settings › Network › Show Advanced › List of IP addresses and networks that are allowed without auth**. Add only the address the player's requests reach your server from, never your whole network: Plex takes whatever comes from an address on that list for you, its owner, whoever sends it. On Proxmox VE, that's the container's own address. In Docker, with Plex on another machine, it's usually the address of the machine Docker runs on, which lets in everything else on that machine too: a network that gives the container an address of its own (macvlan, say) keeps it to the player. `PLEX_SERVER_URL` has to be the server itself, not another proxy in front of it: the player asks the server, through its own nginx, whether it lets the player in, and a proxy that answered for it could be taken for its answer.
2. **Set `OFFLINE_KEY`** on the container (and `OFFLINE_FROM`, if the key's to be used from anywhere but your own networks).

With the player on that list, it checks each request to your server before it goes (see [SECURITY.md](../SECURITY.md#the-plex-proxy)):

- **You**, the server's owner, use it as before. While plex.tv isn't answering, the devices you're signed in on carry on: the container knows your sign-ins by a fingerprint of each, kept in `DATA_DIR`, which can't be turned back into the sign-in.
- **Friends and those in your Plex Home** get through as themselves, with their own playlists, ratings and plays, and only if your server knows them as themselves: before each of their requests, the container asks the server, with their own sign-in, for what only you may see (its settings, and who's playing what). If the server shows them that, it's taking them for you, and they're refused. Some Plex servers take everything from an address on the list for their owner's, whoever's signed in: then only you get through, and the log says so. While plex.tv isn't answering, they carry on for as long as your server still knows them.
- **Anyone else**, with a sign-in neither plex.tv nor your server knows, is refused.
- **Signing in afresh** can't be done with Plex while plex.tv isn't answering. Once it hasn't answered the player for 20 seconds, the sign-in page says so, and takes the offline key. Signed in with it, the player plays your library as your server lets it in: as you, its owner, with your playlists, ratings and history. So give the key only to those you'd let use your Plex account. Play Together, your devices, shared playlists, and the settings and Missing tracks that follow an account need a Plex sign-in, so they wait for one. Once plex.tv has been answering again for two minutes, everyone signed in with the key is signed out, and signs in with Plex. The key works only while plex.tv isn't answering, only from where `OFFLINE_FROM` says, five tries a minute from an address, and after 30 wrong keys in an hour from anywhere, none at all till the hour's up from wherever a wrong one came. The key's session never leaves the player: its requests go to your server without it, as the player's own do.

Without the player on that list there's no offline mode (while plex.tv isn't answering, the sign-in page says why), and everyone signs in with Plex as usual.

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

Tokens and keys are replaced with `[redacted]` everywhere, but the log does show server addresses, people's names and the names of tracks: share it with care, and turn debug mode off when you're done. **Settings › Connection** in the app shows whether it's on (where the container runs its service: without Node.js, it can't say).
