# plexamp-web

> [!IMPORTANT]
> **This project was coded entirely by Claude, an AI model made by Anthropic,** at the direction of the repository's owner. No part of the code was written by hand, and it hasn't been independently audited. Read the security report below and review the code before you rely on it, especially before you make it reachable from the internet.

A self-hosted web player for Plex music libraries, laid out like the Plexamp app and built for phones first. It runs as one small container and plays music straight from your Plex Media Server in the browser.

What changed in each version is in [CHANGELOG.md](CHANGELOG.md).

> Unofficial project. Not made, endorsed or supported by Plex.

## Security report

A review of the code with one main question: **can any of it leak your data?** That means tokens, your library, or what you listen to, ending up somewhere it shouldn't (logs, other websites, other people). The review covered the browser app, the nginx configuration, the start-up script and the service that runs alongside them. It was done by Claude, which also wrote the code, so treat it as a careful self-review rather than an independent audit.

### What the app handles, and where it goes

- **Your Plex sign-in.** After you sign in, the browser keeps your Plex token (and, for servers shared with you, that server's access token) in its local storage. The token is sent only to plex.tv, to your Plex server (directly or through the container's `/pms/` proxy), and to the container's own service (to check who you are for Play Together, Play on, sharing playback between your devices and the shared AI model). When you use Play on with a Plex player, the service also sends it with each command to that player, one of your own devices, as Plex's own apps do.
- **Your library and listening.** Requests go from your browser to your Plex server. Plays are reported back to Plex if **Sync recent plays** is on.
- **Missing tracks.** With **Show missing tracks** on (Settings › AI), the songs and artists AI playlists suggest that your library doesn't have are kept in the browser's storage on that device, with the request each came from, until you clear them or sign out. They go nowhere else, unless you download, copy or share the list.
- **The container** has no database and writes nothing to disk except its start-up configuration. Play Together sessions, and what your devices are playing, are held in memory only. The service never stores tokens; it keeps short-lived SHA-256 hashes of them as cache keys, so it doesn't have to ask plex.tv on every request.
- **No outside code or tracking.** No analytics and no third-party scripts. hls.js is bundled into the image, so nothing is loaded from a CDN. The browser contacts only plex.tv (sign-in, your server list, profile pictures), your Plex server, and an Ollama server if you set one up.

### Fixed in this review

| Area | What was wrong | What changed |
| --- | --- | --- |
| Container log | nginx's default access log wrote every request address to the container log. Plex tokens travel in those addresses (artwork and audio), so anyone who could read the log, in Portainer for example, could read tokens. | The access log is off. In debug mode it shows paths only, never query strings. |
| Container log | nginx's error messages for the Plex proxy quote the whole request, token included. | These are no longer logged. In debug mode they pass through a filter that removes tokens first. |
| Plex proxy | `/pms/` forwarded requests without a token. And if your Plex server lets the container's network in without signing in (Plex's "List of IP addresses and networks that are allowed without auth"), anyone who could open the player could use your Plex server through it, with owner rights. | Requests without a token are refused, except the playlist and segment files inside a stream Plex is converting (players fetch those by the stream's session, without a token). The service checks whether Plex accepts made-up tokens from the container; if it does, every `/pms/` request must carry the server owner's own token (checked with plex.tv), because Plex can treat requests from there as the owner's, and the log explains how to fix the Plex setting. (Until 0.6.0, friends with access got through too.) Browsers can no longer set the `X-Forwarded-For` address Plex sees, and cookies aren't passed on. |
| Shared AI sign-in check | Tokens were checked against your Plex server, which accepts anything from an allowed network (see above). | Tokens are checked with plex.tv first. Asking the Plex server is a fallback, used only when it refuses made-up tokens. |
| Third-party code | hls.js was loaded from cdn.jsdelivr.net at run time, at whatever the newest 1.x version was. | It's pinned to one version and bundled into the image at build time, and the content security policy only allows scripts from the player itself. |
| Crafted links | A link like `#/items?path=…` or `#/tags/…` could make the app send your token to any Plex endpoint, including ones that change things on a plain GET. | Links can only open library listings, tag lists are limited to known fields, and ids in links must be numbers. |
| Server data in styles | Album colours from the server went into CSS unchecked, so a malicious server could make the browser load an outside image (and see your IP address). | Colours must be plain hex values, and image addresses are escaped. |
| Outside images | Artwork hosted elsewhere (some metadata providers) was loaded straight from that host. | All artwork goes through your Plex server's image converter, so the browser only talks to your server. |
| Sign-out | An Ollama API key entered on a device stayed in its storage after signing out. | It's cleared on sign-out, along with everything else except device settings. |
| Response headers | nginx's version was shown in headers. | Hidden. A `Permissions-Policy` and `object-src 'none'` were added. |
| Start-up messages | When an address such as `PLEX_SERVER_URL` had a user name and password in it (which the container refuses), the error printed it in full, password included. | Passwords are hidden in every message the container prints. |
| Link parameters | A value in a link (a filter in `#/browse/…`) could replace the app's own Plex parameters, the token among them. | The app's own Plex parameters always win. |
| Service account | The container's service starts as root to make its socket, then becomes nginx's user. It kept root's other groups when it did (in a container, several, `disk` and `adm` among them). | It keeps only its own group, and the container test checks it isn't root and has no other groups. |

### Safeguards in Play Together

Added in 0.4.0, and built with the same aim:

- Only your own Plex friends can be invited, and joining checks with plex.tv, using the joiner's own token, that they can play from the session's library. A session's link is useless to anyone who wasn't invited.
- Everyone plays from the Plex server with their own token. Tokens are never shared between people, and the service doesn't keep them.
- Tracks someone adds are reduced to the fields the app needs, and their file and artwork paths must have Plex's own shape. So nobody can point other people's players at another website, or at another part of the server. Each player checks this again before playing.
- People in a session see each other's Plex display names and profile pictures, never email addresses or tokens.
- Sessions are held in memory and end on their own: after 30 minutes with nobody listening, or after 24 hours. A player holds at most 100 at a time, one per person.
- Requests are limited per person, and long-polling uses plain HTTP, so it works through proxies that block WebSockets.

### Safeguards in Play on

Added in 0.6.0. Browsers can't send commands to a Plex player on your network, so the container's service passes them on. That means the service makes requests into your home network for people using the player, so it's tightly limited:

- **Only the owner.** With `PLEX_SERVER_URL` set, only the server's owner can use it. The players it can reach are on the server's network, and they're the owner's; friends' players are on their own networks.
- **Only your own players, and only on your network.** The service connects only to devices on the signed-in account (from plex.tv) that say they're players, only at home-network addresses (10.x, 172.16 to 172.31, 192.168.x, 100.64 to 100.127 for Tailscale, and IPv6 unique-local addresses), and only on the ports Plex players use (32500 to 32510, 3005 and 32433). Never at internet addresses, loopback addresses (the container itself), or link-local addresses such as cloud servers' metadata service. Players' addresses stay in the container; the browser only gets their names.
- **Only commands it builds itself**, from a fixed list (play, pause, stop, skip, seek, volume, shuffle, repeat, start a queue, reload the queue, and asking what it's playing), with every value from the browser checked first. It follows no redirects, waits at most 5 seconds, reads at most 64 KB of an answer, and passes back only the player's state: playing or paused, the position, the track, the volume.
- **A temporary token for playback.** The player plays from your Plex server with a temporary token the server makes for it (Plex's own way of handing playback to another device), which only works on that server. Your account's token is only in the headers of commands to your own players.
- **AirPlay and Google Cast** are the browser's own features. Before the browser hands the track to a speaker, the app switches its address to a temporary token from your Plex server, so the speaker doesn't get your account's token. If the server can't give one, the address has your own token, as all Plex media addresses do.

### Safeguards in Your devices

Added in 0.8.0. Your devices share what's playing through the container's service (see [Your devices](#your-devices)), so it holds a little of your listening for a while:

- **What it holds**: for each Plex account and server, the devices open (a name such as "Chrome on Android", or the player name you chose, and a random id), which one plays, its queue around the current track (up to 600 tracks: titles, artists, albums, and Plex's ids and file paths), where it is in the track, and commands waiting for it. In memory only. A device that's gone quiet is forgotten after a minute, and the rest a day after your devices were last used.
- **Only your own devices.** Each request carries the device's own Plex token, checked with plex.tv, and the server must be one that account can play from, as for Play Together. What one account's devices share is never shown to another account, even on the same server.
- **No tokens between devices.** A device that takes over plays from the server with its own sign-in, and only Plex's ids and paths are passed along.
- **Checked on the way in.** Tracks are reduced to the fields the app needs, ids must be numbers, and file and artwork paths must have Plex's own shape, so one device can't point another at a website or another part of the server. Commands come from a fixed list (play, pause, skip, seek, volume, shuffle, repeat, and changes to the queue), with every value checked. Requests are limited per account, and bodies to 512 KB.

### Safeguards in the shared AI model

Changed in 0.9.0. Browsers reach the model only through the container's service (see [Shared: one Ollama for everyone](#shared-one-ollama-for-everyone)), which:

- checks every request's Plex sign-in: with `PLEX_SERVER_URL` set, only people who can use your Plex server get through;
- passes on chats only, with the fields the app uses, each checked, and always on the model in `OLLAMA_MODEL`;
- never shows the AI server's other models, its version or its settings;
- keeps the API key (`OLLAMA_API_KEY`) to itself: it goes to Ollama only, never to browsers or the log.

### Safeguards in editing playlists and collections

Added in 0.6.0. Changes go to your Plex server with your own token, so Plex decides what you may change: your own playlists, and collections only if you own the server. The app only offers collection editing to the server's owner.

Building this showed a gap in the `/pms/` proxy. If your Plex server lets the container in without signing in, it accepts any token from there and can treat requests as its owner's. Friends with access were let through, so they could have seen your view of the server and made changes (a new playlist, say) as you. In that situation the proxy now lets only the owner through.

### Safeguards in the Proxmox install

Added in 0.10.0. The script runs as root on your Proxmox node, so it's careful with what it's given:

- Everything you type, or set beforehand, must match a strict pattern (one line, no quotes or shell characters) before it goes into a command or a settings file. Addresses with a user name and password in them are refused. The settings file is written on the node and copied into the container, so nothing you typed passes through a shell in there, and only root can read it.
- The container is unprivileged, and the app's service never runs as root: systemd starts it as `www-data`, which owns only its own settings and socket.
- Only what the Docker image has is installed: nginx and Node.js from Debian, the app from this repository, and hls.js from npm, checked against the npm registry's checksum.
- The app comes from the repository's `stable` branch, which CI moves only to commits that passed every test (the ones the Docker image is published from), so an untested change never reaches a container. `update-plexamp-web` fetches the installer from there each time, so updates trust GitHub just as the first install did.

### What debug mode logs

`DEBUG=true` writes much more to the container log: settings (secrets shown only as "set"), connection checks, request paths and status codes, the service's activity, and problems from browsers. Tokens and keys are always replaced with `[redacted]`, but the log does show server addresses, people's names and the names of tracks. Share it with care, and turn debug mode off when you're done.

### Remaining risks

These come with how the app works:

- **Tokens live in the browser.** Like Plex's own web app, the player keeps your token in the browser's local storage. Anyone with access to the browser profile, or a script injected into the page, could read it. The page uses no third-party scripts, builds everything without HTML strings, and has a strict content security policy, which makes injection hard.
- **Tokens appear in media addresses.** Plex needs the token in artwork and audio addresses. They go only to your Plex server and are never sent as a referrer to anyone else, but they can show up in the browser's developer tools, and in the browser's own cache on the device, which keeps artwork for a day. Artwork is marked private, so proxies and other shared caches don't keep it.
- **The container serves plain HTTP.** On your home network that's the same as Plex's own `http://` addresses. If you use the player from outside, put it behind an HTTPS reverse proxy. Without HTTPS, tokens cross the network unencrypted.
- **The proxy doesn't check an `https://` server's certificate.** With an `https://` `PLEX_SERVER_URL`, the connection from the container to Plex is encrypted, but the proxy (nginx) can't check the certificate: it's for the server's `plex.direct` name, never its address. So, as with `http://`, that hop relies on your home network. The container's own service, which checks sign-ins with the server, does check it, and only accepts a valid Plex certificate there.
- **The shared AI model without `PLEX_SERVER_URL`** is open to anyone signed in to Plex, and Plex accounts are free. If the player can be reached from the internet, set `PLEX_SERVER_URL` so that only people with access to your server can use the model.
- **Play on without `PLEX_SERVER_URL`** works for anyone signed in to Plex, with the players on their own account. Someone who can open the player could add a made-up "player" to their account, at an address on your network, and learn whether something there answers on the Plex player ports. The service never sends them anything back from it beyond a player's state. If the player can be reached from the internet, set `PLEX_SERVER_URL`, or `CASTING=false`.
- **Wide connection rules.** The content security policy has to allow connections, images and audio from any address, because Plex servers and Ollama can be anywhere.
- **Whoever runs the container is trusted.** They control the code your browser runs, the service sees your token when it checks who you are, and, while your devices share playback, what you're playing. That's also true of any web app you open.

To report a security problem, open an issue on GitHub without posting tokens or logs that contain them.

## Features

- **Home**: sections you choose and order for each library (see below), including **Collections**, shown just like Recent playlists. There's a quick library switcher too.
- **Search**: live results, narrowed word by word: press Enter (or +) to keep a word as a tag, and what you type next only finds things that match every tag ("prodigy", then "fire"). One tap on × clears it all. Browsing the library: artists, albums, tracks, compilations, soundtracks, collections, genres, styles, moods and decades, with counts from your server. Any list can be searched within: in the 1990s, type "rock" to narrow it to rock albums from the 1990s, then "calm" for a mood, and take each filter off again with a tap. Also top artists, albums and tracks, AI playlists, Sonic path (a journey between two tracks) and Shuffle library.
- **Playlists tab**: all your music playlists, with ❤️ Tracks first.
- **Artist pages**: popular tracks, albums grouped by type, sonically similar artists, and artist radio.
- **Album and playlist pages**: play, shuffle, a rating on every track (stars or thumbs, as you choose), and a menu on every track (play next, add to queue, similar tracks, add to a playlist, appears in, go to album or artist). Albums show their format (e.g. FLAC 24/96) and mark their best-known tracks.
- **Appears in**: from any track's menu (in a list, Up next or Now Playing), the albums the song is on (its own, and others with the same song by the same artist, such as a compilation, a soundtrack or a live album, each with what that version is called), the playlists it's in, and the collections it's in, including collections of its album or its artist. Each opens with a tap. A smart playlist of a whole library (one with no rules but the library) counts as having every track without being read; other very long smart playlists are left out, and the page says which.
- **❤️ Tracks**: tracks you give five stars or a thumbs up go in your ❤️ Tracks playlist, and come out when they lose that rating, as in Plexamp. If yours is Plexamp's own (a smart playlist), Plex keeps it up to date itself.
- **Now Playing**: big artwork, a seek bar drawn from your server's loudness analysis, ratings that save to Plex, the file format and quality, an Up next queue (with **Move to top**), Guest DJ, shuffle, repeat and a sleep timer. A volume slider with a percentage and marks at 25, 50 and 75%. Optional playback speed and skip buttons.
- **Playlists**: make them, add to them from any track, album, artist or the queue, and edit them: reorder, sort (by artist, track name, album or year, or reversed, with Undo), remove, rename, delete. A playlist's, collection's or artist's menu can also play it next or add it to the queue. A lock keeps them safe from accidental swipes and taps until you unlock one (the app points it out until you've used it).
- **Collections**, for the server's owner: the same editing and sorting, and adding tracks, albums or artists, including a playlist's tracks or the queue.
- **Play on**: play on another Plex player on your network (Plexamp on a Raspberry Pi, say) with this app as the remote, or on AirPlay and Google Cast speakers where the browser supports them. See [Play on](#play-on).
- **Your devices**: open the player on your phone while your computer plays, and the phone shows what's playing and controls it. **Listen here** moves the music to the device in your hand, from the same spot. See [Your devices](#your-devices).
- **Play Together**: listen in sync with Plex friends. Everyone hears the same track at the same moment, and anyone in the session can play, pause, skip, seek, and change the queue.
- **AI playlists**: describe what you want to hear, and a model running on your own hardware (through [Ollama](https://ollama.com)) builds a playlist from your library, keeping to what you asked for ("best of The Prodigy" is just The Prodigy). Play it, add it to the queue, or save it to a playlist or collection in Plex. Optionally, it keeps a list of the songs and artists it suggested that your library doesn't have, to export and go looking for.
- **Guest DJ**: DJs that add tracks as you listen. Six follow fixed rules (similar sound, same artist, same era, sonic journeys). The AI DJ uses your Ollama model to pick each next track and introduce it.
- **Live updates**: new music, playlist changes and ratings from other Plex apps appear without reloading. Works with or without WebSockets (see [Behind a work proxy](#behind-a-work-proxy)).
- **Playback**: gapless playback, and crossfades like Plexamp's: **Smart** crossfade uses your server's loudness analysis to fade into the next track where the music really ends, so silence at the end of a track doesn't leave a gap, and plays tracks that follow each other on an album gaplessly (see [Good to know](#good-to-know) for the Plex setting it needs). Also lock-screen and media-key controls, and play reporting to Plex (play counts, recent plays, dashboard).
- **Album-colour backgrounds** from Plex's own artwork colours, or a blurred copy of the cover.
- **Responsive**: bottom tabs and a mini player on phones; a sidebar and full transport bar on desktop. Each tab keeps its own history, like a phone app's, so Back stays within the tab you're in. It can be added to a phone's home screen.
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

The image is built, tested and published by GitHub Actions on every push to `main`, for amd64 and arm64 (a Raspberry Pi 4 or CM4 works well). `latest` is the newest; each version is also tagged with its number (such as `0.10.0`), to stay on one. If pulling fails because the package is private, either make it public in the package settings on GitHub or run `docker login ghcr.io` first. To build locally instead, uncomment `build: .` in `docker-compose.yml`.

## Run it on Proxmox VE

On your Proxmox VE node's shell, as root:

```sh
bash -c "$(curl -fsSL https://raw.githubusercontent.com/kamakazedan/plexamp-web/main/proxmox/plexamp-web.sh)"
```

Like the [Proxmox VE community scripts](https://github.com/community-scripts/ProxmoxVE), it makes a small unprivileged Debian container (LXC) on the node and installs the player in it, without Docker: nginx and Node.js from Debian, the app from this repository, and hls.js from npm, checked against the registry's checksum. Press Enter to use its default settings (the next free ID, 1 core, 512 MB, 4 GB, DHCP on `vmbr0`), or `n` to choose each one, including your Plex and Ollama addresses. It shows what it's about to make, and when it's done, the address to open. It needs Proxmox VE 8 or later, and internet access for the container while it installs. As with any script from the internet that runs as root, [read it](proxmox/plexamp-web.sh) first.

The app comes from the `stable` branch: the newest commit that passed every test, as the Docker image is. Settings can be given beforehand instead, and with `YES=1` it asks nothing:

```sh
CTID=120 PLEX_SERVER_URL=http://192.168.1.10:32400 YES=1 bash -c "$(curl -fsSL https://raw.githubusercontent.com/kamakazedan/plexamp-web/main/proxmox/plexamp-web.sh)"
```

| Variable | Default | What it is |
| --- | --- | --- |
| `CTID` | the next free ID | The container's ID. |
| `CT_HOSTNAME` | `plexamp-web` | Its name. |
| `STORAGE` | `local-lvm`, or `local-zfs` | Where its disk goes. |
| `CORES`, `RAM_MB`, `DISK_GB` | `1`, `512`, `4` | Its size. |
| `BRIDGE` | `vmbr0` | Its network bridge. |
| `IP` and `GATEWAY` | `dhcp` | Or a fixed address, such as `IP=192.168.1.50/24 GATEWAY=192.168.1.1`. |
| `PLEX_SERVER_URL`, `OLLAMA_URL`, `OLLAMA_MODEL` | not set | As in [Container settings](#container-settings). |
| `TEMPLATE_STORAGE` | `local` | Where the Debian template is kept. |

Then, on the node (or inside the container, without `pct exec <ID> --`):

- **Settings**: `pct exec <ID> -- plexamp-web-settings` opens them in an editor, with the same names as [Container settings](#container-settings), and restarts the player with them. They're kept in `/etc/plexamp-web/plexamp-web.env`.
- **Updates**: `pct exec <ID> -- update-plexamp-web` installs the newest tested version. Your settings are kept.
- **Logs**: `pct exec <ID> -- journalctl -u plexamp-web -u plexamp-web-config -f`. With `DEBUG=true`, nginx's requests are in `journalctl -t nginx -f`.

## Container settings

All optional. Set them as environment variables on the container.

| Variable | Example | What it does |
| --- | --- | --- |
| `PLEX_SERVER_URL` | `http://192.168.1.10:32400` | Proxies that Plex server at `/pms/`, adds "Server set up for this app" to the server list, and gives the app a route to the server when its local address doesn't work in the browser. `https://` works too. |
| `DISABLE_WEBSOCKETS` | `true` | The app never opens a WebSocket. Live updates use Plex's event stream, or check every minute. |
| `OLLAMA_URL` | `http://192.168.1.20:11434` | Shares a model on that Ollama server with the people who use the app (see [Shared: one Ollama for everyone](#shared-one-ollama-for-everyone)). |
| `OLLAMA_MODEL` | `llama3.1:8b` | The one model the app uses. Its other models can't be used or seen. If it isn't set, the first model installed is used. |
| `OLLAMA_API_KEY` | | Sent as a bearer token, for an Ollama behind a proxy that asks for one. Never reaches browsers. |
| `OLLAMA_AUTH` | `plex` (default) or `off` | Who may use the shared model: `plex` means signed-in Plex users (see below), `off` means anyone who can open the app. |
| `PLAY_TOGETHER` | `true` (default) or `false` | Play Together and its tab. |
| `CASTING` | `true` (default) or `false` | Playing on other Plex players from the app (see [Play on](#play-on)). AirPlay and Cast, which are the browser's own, aren't affected. |
| `DEBUG` | `true` | Writes extra detail to the container log for troubleshooting, with tokens removed (see [Debug mode](#debug-mode)). |

The container stops with a clear message in its log if a value doesn't make sense, for example an address without `http://`.

**`PLEX_SERVER_URL`** helps when the browser can't reach Plex directly: when the player is served over HTTPS but Plex is plain HTTP, when your router's DNS rebinding protection blocks `*.plex.direct` addresses, or when a work network only allows ordinary web traffic to one address. You still sign in; the proxy only carries the traffic. When you pick your server by name, the app tries its local address first and then this proxy, before going out through the internet or Plex's relay.

An `https://` address works too, such as `https://192.168.1.10:32400` for a server set to require secure connections. A Plex server's certificate is for its own `plex.direct` name, which an address like that can't match, so the container accepts the server's Plex certificate there (and nothing else: a self-signed certificate is refused, and the log says so). `http://` is simpler on a home network.

## Your devices

Signed in to the same Plex account and playing from the same server, your devices share what's playing, as if they'd joined one session. Start a playlist on your computer, open the player on your phone, and the phone shows the track, where it's got to and Up next, with its own sound off.

- **One device plays.** The others show where the music is ("Playing on Firefox on Windows") and a muted speaker.
- **Control it from any of them.** Play, pause, skip, seek, volume, shuffle, repeat, changes to Up next, and playing an album or playlist all happen on the device that's playing. The rest of the app works as usual.
- **Listen here.** Tap the muted speaker (or **Listen here** under the artwork) and the music moves to that device, from the same spot. The device that was playing goes quiet and follows along, and its own muted speaker moves the music back.
- **Carry on later.** Close the player where it was playing, or leave it paused for 10 minutes, and the next device you open has the same queue ready at the same place.
- **Name your devices** in Settings › Experience › Player name, so you know which is which. Until you do, they're named by browser and system, like "Chrome on Android".
- **Play on more than one at once**: turn off Settings › Playback › Share playback with your devices on a device, and it plays on its own. On by default.

Each browser tab counts as a device. While you're in a Play Together session, sharing between your devices pauses. A device that plays on a Plex player (see [Play on](#play-on)) is the one playing: the others show the player's name and control it too. Browsers only start sound after a tap on the device itself, which is why the music moves when you tap **Listen here** on the device you want it on. If the device that's playing closes without saying so (its battery runs out, say), the others wait up to a minute for it. If it doesn't answer a command, the app says so and offers **Listen here**.

## Play Together

Listen with Plex friends, each on their own device. Open the **Together** tab, choose **Start a session**, and pick friends to invite (people you share your Plex library with). They open the same player, sign in with their own Plex account, and find the invitation in their Together tab. A dot on the tab shows when an invitation arrives.

- **In sync**: play, pause, skip and seek happen for everyone, and each track starts at the same moment for everyone. Every player follows the session's clock and corrects small drift as it plays.
- **One shared queue**: anyone in the session can add music from anywhere in the app (**Play next**, **Add to queue**, or play an album), remove upcoming tracks, shuffle or clear what's next. Up next shows who added each track.
- **Hosting**: the host can invite more friends and remove people. If the host leaves, the person who's been there longest takes over. **End for everyone** stops the session.
- **Your own server access**: friends play from your Plex server with their own access, so they need your music library shared with them. Plays count for each person.
- **Works without WebSockets**: sessions use plain HTTP requests (long-polling), so they work through work proxies too.

Things to know: everyone must use the same player address, because sessions live in that container. Guest DJ and repeat are off during a session, and a sleep timer takes you out of the session instead of pausing everyone. If a browser holds back sound after a reload, the app asks for a tap to start listening again.

## Play on

The cast button next to Repeat (and in the desktop player bar) chooses where the music plays.

- **Plex players**: Plexamp (on a Raspberry Pi or a computer, say) and other Plex apps that can be controlled remotely, signed in to your Plex account and on the same network as the container. The app becomes the remote: play, pause, skip, seek, volume and changes to Up next go to the player, and Now Playing follows what it plays, even after a reload. **This device** brings the music back, from where it got to. With `PLEX_SERVER_URL` set, this is for the server's owner.
- **AirPlay or Cast…** opens the browser's own list of speakers and TVs, where it has one: AirPlay in Safari, Google Cast in Chrome on Android. Crossfades are off while a speaker is connected, because the browser sends it one track at a time. In Chrome on a computer, Chrome's own **Cast** menu can play the whole tab on a Google speaker.
- **Alexa (Echo) speakers can't be played on.** Amazon only lets its approved music services play on them, so no app can, Plexamp included. Pair the speaker with your phone or computer over Bluetooth instead.

Plex doesn't fully document how its players are controlled, and Play on has been tested against a simulated player rather than every real one. If a player doesn't respond, please open an issue, with the [debug log](#debug-mode) (it leaves out tokens).

## Customise it

**Settings → Experience** follows the layout of Plexamp's own settings:

- **Appearance**: colour from artwork, and the background (album colours, blurred artwork, or plain).
- **Player**: show the codec, show the rating, the volume control, the seekbar style (smooth, bars or simple), Up next side by side on wide screens, the album year, opening the full player when something starts, playback speed, long-form controls (for tracks over 20 minutes: skip buttons, and carrying on where you stopped), and quick skip buttons with times you choose.
- **Home screen**: the sections on Home for the current library. Drag to reorder, tap one to show or hide it, or to pick its time period. Sections: Mixes for you, Recent plays, Recent playlists, Collections, More in (a genre), Best of the 70s to the 20s, Recently added, Top albums from (a period), Stations (library radio, deep cuts, time travel and a random album), Most played in (a period), More from (a record label), History, and Haven't played in (a period).
- **Grid size, font size and rating system** (five stars, half stars, thumbs or off).
- **Album codec badges, popular-track badges and preview buttons** (a 15-second listen without changing the queue).
- **Top plays list size**, and **1-tap playback** (when off, tapping a track while something plays asks whether to play it now, next or later).
- **Search all music libraries** and **playlists from all music libraries**, only shown when your server has more than one music library: whether Search and the Playlists tab cover the others too. Film and TV playlists never show.
- **Sync recent plays**, **desktop integration** (media keys, the tab title, keyboard shortcuts) and the **player name** Plex shows on its dashboard (and your other devices show, see [Your devices](#your-devices)).

Settings are kept per device.

## Debug mode

If something doesn't work, set `DEBUG=true` on the container, restart it, and watch its log (`docker logs -f plexamp-web`, or the container's Logs page in Portainer; on Proxmox, see [Run it on Proxmox VE](#run-it-on-proxmox-ve)). You'll see:

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

Every request asks the model to keep to what you asked for, and to be creative within it. The app checks too, because small models drift: a playlist about particular artists ("best of The Prodigy", "Daft Punk deep cuts") is built only from those artists' tracks, best known first, and is shorter rather than padded with other artists if they don't have enough. "Music like The Prodigy" is mostly them, with similar artists. An era you name ("90s") holds for the artists' tracks too.

A playlist carries on being made while you use the rest of the app, which says when it's ready. A finished playlist can be played, shuffled, added to the queue, or saved to Plex: as a new playlist, into one of yours, or (for the server's owner) into a collection.

**Missing tracks.** Turn on **Settings → AI → Show missing tracks** (it's off to begin with, and only playlists made while it's on are checked), and under each AI playlist is a list of the songs and artists the model suggested that your library doesn't have, or a line saying they're all there (a song is looked for by its title and among its artist's tracks, so a slightly different title still counts as there). They're collected in **Settings → AI → Missing tracks**, with how often each was suggested and for what, to download as a spreadsheet (CSV), copy or share, so whoever looks after the server can go and find them. **Check again**, after adding music, takes off what's in the library now. The list is kept on that device. Models sometimes suggest songs that don't exist, so check before you go looking.

There are two ways to connect.

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

Browsers only ever talk to the player's own address, so this works from anywhere the player does (a work network included), and Ollama needs no extra setup. Requests go through the container's own service, which checks each one:

- **One model: yours.** The player uses the model in `OLLAMA_MODEL` (or, if it isn't set, the first one installed), whatever a request asks for. Nobody can choose another in the app: **Settings → AI** shows the model's name, whether it's ready, and a test button, and nothing else about the AI server. Each device can still turn AI features off, and then nothing about AI shows on it (nor for anyone the container doesn't let use the model).
- **People with access to your Plex server** (`OLLAMA_AUTH=plex`). Every request is checked with plex.tv. With `PLEX_SERVER_URL` set, Plex accounts that can use that server get through: you, and the friends you share it with. Without it, any signed-in Plex account is accepted. Anyone refused is told why in the app (the AI playlist page says so before they try), and the container log notes it, without names unless debug mode is on.
- **Only chats** are passed on, with just the fields the app uses, each checked (the model's options within sensible limits). The AI server's other models, its version and its settings can't be reached through the player, and nothing can be downloaded, changed or deleted.
- **Rate-limited** per user, at most two requests at a time each (six in all), and the browser's Plex token, cookies and origin aren't forwarded to Ollama. Closing the page or pressing **Stop** stops the model too.

Ollama on the same machine as Docker works too: use `OLLAMA_URL: http://host.docker.internal:11434` (the bundled `docker-compose.yml` already maps that name on Linux), and start Ollama with `OLLAMA_HOST=0.0.0.0` so containers can reach it.

### On one device: your own Ollama

Without a shared model, each device can use its own. In **Settings → AI**, choose **My own Ollama server** and enter its address, such as `http://localhost:11434` for Ollama on the same computer. The browser connects directly, so Ollama has to trust the player's address. Set this on the computer running Ollama and restart it (the settings page shows the exact value):

```sh
OLLAMA_ORIGINS=https://music.example.com
```

If the player is served over HTTPS, browsers block plain `http://` addresses other than `localhost`. In that case use an HTTPS address or the shared setup.

**Notes for the AI**, in the same settings page, are added to every request ("I love 90s trip-hop; skip live recordings").

## Good to know

- **Formats.** Files play as-is when the browser supports them (FLAC, MP3, AAC, Opus and WAV in current browsers; ALAC mostly in Safari). Anything else is converted by your server over HLS, played with the built-in support where the browser has it and with [hls.js](https://github.com/video-dev/hls.js) (bundled into the image) where it doesn't. The conversion path is the part most likely to need adjusting against real servers.
- **Sonic features** (similar tracks, Sonic path, sonically similar artists, artist radio and the sound-based Guest DJs) need sonic analysis turned on for the library in Plex. Without it, DJs fall back to matching on genre.
- **Smart crossfade needs Plex's loudness analysis.** That's what tells it where a track's music really ends. It's a server setting in Plex: **Settings › Library › Analyze audio tracks for loudness**, and it runs during the server's maintenance period. Sonic analysis (a separate setting, which needs Plex Pass) isn't needed for this. Without loudness analysis, Smart fades at the very end of each track, like **Always**, so silence at the end of a track still leaves a gap. Gapless playback between tracks of an album doesn't need any analysis.
- **The waveform** appears once Plex has analysed a track's loudness too; until then the seek bar is a plain line.
- **Crossfades on iPhone and iPad.** Safari there doesn't let pages change the volume of audio, so it can't fade. With Crossfade on, tracks change where the music ends instead.
- **Memory.** Long lists keep artwork only near the screen, and pages you've moved on from are let go after a while, so the player stays light however long it's open or however big the library.
- **Not built yet**: lyrics and loudness levelling.

## Develop

The app is plain ES modules in `web/`, with no build step and no dependencies. The service in `server/` is plain Node.js (version 22 or newer), also without dependencies.

```sh
python3 dev/mock-plex.py           # fake Plex server (and plex.tv) on :32400; artwork needs Pillow
python3 dev/mock-plex.py 32401 --big 3000   # the same with 3,000 more albums, for trying long lists
python3 dev/mock-ollama.py         # fake Ollama on :11434
python3 -m http.server 8080 -d web
```

Open http://127.0.0.1:8080, choose **Use a server address and token instead**, and connect to `http://127.0.0.1:32400` with the token `t`. The mock serves an invented library with generated artwork and short test tones, live notifications over a WebSocket and an event stream, three made-up Plex accounts for Play Together (`t`, `t2` and `t3`), a Plex player called Living Room on port 32500 for Play on, and test switches (such as refusing WebSockets the way a proxy would) described at the top of the file. For AI features, choose **Settings → AI → My own Ollama server** and enter `http://127.0.0.1:11434`.

Served like this, without the container, there's no `/api/`, so Play Together, Play on with Plex players and the shared AI model are off. The full set runs in the container; for testing, `PLEX_TV_URL` points its service at the mock instead of plex.tv. To play converted tracks outside the container in browsers without built-in HLS, run `sh dev/fetch-hls.sh` once (it needs npm).

To use your own Plex server, enter its address and your [X-Plex-Token](https://support.plex.tv/articles/204059436-finding-an-authentication-token-x-plex-token/), or sign in with Plex.

Tests, which CI runs against the built image:

```sh
node --test server/test.js                       # the service: sessions, sync, cleaning, redaction
bash tests/proxmox-test.sh                       # the Proxmox script, with stand-ins for pct and the rest
bash tests/proxmox-install-test.sh               # its installer, in Debian 12 and 13 containers
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
  js/player.js           queue, gapless playback and crossfades, conversion fallback, play reporting, Play Together sync
  js/transitions.js      where a track's music starts and ends (loudness analysis), album order, fade support
  js/nowplaying.js       mini player, desktop transport bar, Now Playing screen
  js/together.js         Play Together: sessions, long-polling, the shared clock
  js/cast.js             Play on: Plex players through the service, AirPlay and Cast
  js/editing.js          adding to playlists and collections, and who may edit collections
  js/sorting.js          sorting playlists and collections with the fewest moves
  js/membership.js       Appears in: the albums a song is on, and the playlists and collections it's in
  js/missing.js          missing tracks from AI playlists, and exporting them
  js/ratings.js          ratings in the player and in track lists, and keeping ❤️ Tracks
  js/live.js             live updates: WebSocket, event stream or polling
  js/ai.js               Ollama client, AI playlists and the AI DJ's picks
  js/dj.js               Guest DJ modes
  js/home-sections.js    Home screen sections and their layout per library
  js/debug.js            debug mode: browser problems sent to the container log
  js/backdrop.js         album-colour backgrounds
  js/router.js           hash routing, back-button handling, view cache
  js/ui.js, components.js, actions.js, preview.js
  js/views/              home, library, detail pages, search, Play Together, AI playlist, settings, sign-in
server/                  the service behind /api/: Play Together, Play on, sign-in checks, debug log
docker/                  nginx config, start-up script and container tests
proxmox/                 the Proxmox VE script and the installer it runs in the container
dev/                     fake Plex and Ollama servers for development
tests/                   browser tests
```

## Troubleshooting

Start with [Debug mode](#debug-mode): most set-up problems show up in the container log with it on.

- **"Can't reach your Plex server"**: check the server is online and Remote Access is on in Plex, or set `PLEX_SERVER_URL`. **Settings → Connection** shows which address is in use and can test it.
- **The connection isn't local** (**Settings → Connection** says Remote or Plex relay at home): the browser can't use the server's local address. Usually the router won't look up `*.plex.direct` addresses that point into the home network (DNS rebinding protection), or Plex runs in Docker and gives out an address only Docker can reach. Set `PLEX_SERVER_URL` to the server's address on your network, and the app goes through the container instead.
- **The log says your Plex server "lets this container in without signing in"**: the container's address is in Plex's list of networks allowed without signing in (**Settings → Network** in Plex). Until you remove it, only you (the server's owner) can use the server through the player's proxy: Plex would treat anyone else as you, so friends are refused there. Remove the container's address from that list to fix it.
- **Live updates say they're checking every minute**: a proxy is blocking both WebSockets and the event stream. Everything still works; changes just take up to a minute to appear.
- **Play Together shows no friends**: friends come from plex.tv, so they need to be your Plex friends, sharing your library. "Can't play from …" means they don't have access to this server.
- **A friend can't join**: they must open the same player address and sign in with Plex (not with a server token), and have your music library shared with them.
- **Play on shows no Plex players**: the player must be signed in to your Plex account, switched on, and on the same network as the container. Plex has to know its address on that network: a player that only Plex's relay can reach, or one that gives an address the container can't reach (inside another Docker network, say), doesn't show. With `PLEX_SERVER_URL` set, only the server's owner sees players.
- **A Plex player is listed but doesn't respond**: check that it's still on the same network and allows remote control, and turn on [Debug mode](#debug-mode) to see what the player answered.
- **"Couldn't reach Ollama"** with your own server: check it's running, that this device can reach it, and that `OLLAMA_ORIGINS` includes the player's address.
- **"The AI service couldn't confirm your Plex sign-in"**: sign out and in again. With `PLEX_SERVER_URL` set, only people with access to that server can use the shared model.
- **AI answers are slow**: the first request loads the model, which can take a minute on modest hardware. The model then stays loaded for 15 minutes.
- **Some tracks won't play**: check **Settings → Connection → Browser formats**. Unsupported formats need your server to convert them.
- **Playback stops when the phone locks**: add the player to your home screen and check the browser isn't restricted by battery-saving settings.
- **The browser uses a lot of memory**: update to 0.5.0 or later, which fixed several causes (see [CHANGELOG.md](CHANGELOG.md)). If it still climbs, open an issue saying which browser, how big your library is, and what you were doing; in Firefox, the numbers from `about:memory` (Measure) help most.

## Licence

MIT. See [LICENSE](LICENSE). The image also includes [hls.js](https://github.com/video-dev/hls.js) (Apache 2.0); its licence is in the image at `/usr/share/nginx/html/vendor/hls.js-LICENSE.txt`.
