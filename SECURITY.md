# Security

plexamp-web was written by Claude, an AI model made by Anthropic, and the reviews below were done by Claude too. Treat them as careful self-reviews, not an independent audit, and review the code before you make the player reachable from the internet.

- [Reporting a problem](#reporting-a-problem)
- [What the player handles, and where it goes](#what-the-player-handles-and-where-it-goes)
- [Safeguards](#safeguards), feature by feature
- [What debug mode logs](#what-debug-mode-logs)
- [Remaining risks](#remaining-risks)
- [Reviews](#reviews): what each one found and fixed

## Reporting a problem

If the repository's **Security** tab offers **Report a vulnerability**, use that: only the owner sees it. Otherwise open an issue, without tokens, or logs that contain them. Only the newest version is looked after: update first (see [docs/setup.md](docs/setup.md#updating)), and say which version you're on (**Settings › About**).

## What the player handles, and where it goes

- **Your Plex sign-in.** After you sign in, the browser keeps your Plex token (and, for servers shared with you, that server's access token) in its local storage. The token goes only to plex.tv, to your Plex server (directly or through the container's `/pms/` proxy), and to the container's own service, which checks who you are for Play Together, Play on, your devices, shared playlists and the shared AI model. With Play on, the service also sends it with each command to the Plex player, one of your own devices, as Plex's own apps do.
- **Your library and listening.** Requests go from your browser to your Plex server. Plays are reported to Plex if **Sync recent plays** is on. Search keeps how many artists, albums, tracks and so on each library has (just the numbers) in the browser, to show them at once, until you sign out.
- **Missing tracks.** With **Show missing tracks** on (Settings › AI), the songs and artists AI playlists suggest that your library doesn't have are kept in the browser on that device, for each Plex server, with what each was suggested for, until you clear them or sign out. Nothing else gets them, unless you download, copy or share the list, and that leaves out what you asked the AI for.
- **MusicBrainz checks**, only if the container is given a MusicBrainz to ask (`MUSICBRAINZ_URL`). Then the names an AI playlist suggests that your library doesn't have go to the container, which looks them up there. See [MusicBrainz checks](#musicbrainz-checks).
- **Spotify imports**, each off unless the container turns it on. From Spotify's download of your data (`SPOTIFY_FILE_IMPORT`), only the files named `Playlist1.json` (`Playlist2.json`…) and `YourLibrary.json` are opened, in the browser: any other file chosen, the ZIP included, is turned away by its name without being read, as the other files hold your personal details. Only playlist names and each track's title, artist and album are kept from them, nothing goes to the container's service or to Spotify, and the tracks are looked for on your Plex server as any search is. From a link (`SPOTIFY_LINK_IMPORT`): the link goes to the container, which reads that playlist from Spotify's public page for it; only the playlist's id goes to Spotify. Either way, the tracks not found go on the device's Missing tracks. See [Spotify imports](#spotify-imports).
- **Playlist files.** A playlist you export, or a backup of all of yours, is a file on your device with each track's title, artist, album, number and length, and Plex's ids for it. Nothing about the server: no addresses, file paths or tokens. Importing one reads it in the browser only, and every field is checked and kept to plain text and numbers.
- **Shared playlists** are kept by the container's service: titles, tracks (by their ids on the server), and the Plex names and ids of who shares them with whom. No tokens. See [Shared playlists](#shared-playlists).
- **Pictures you upload** for a playlist or collection are redrawn smaller in the browser first, so what a photo carries besides the picture (where it was taken, the camera) doesn't go with it, and go to your Plex server only.
- **The container** has no database. It writes only its start-up configuration, and shared playlists, in one file in `/data` that only its service can read. Play Together sessions, and what your devices are playing, are in memory only. The service never stores tokens: it keeps short-lived SHA-256 hashes of them as cache keys, so it doesn't ask plex.tv on every request.
- **No outside code or tracking.** No analytics, no third-party scripts, and hls.js is bundled into the image. The browser contacts only plex.tv (sign-in, your server list, profile pictures), your Plex server, and Ollama if you set up your own. The container contacts only plex.tv, your Plex server, the shared Ollama and the MusicBrainz you set, if you set them, and Spotify (`open.spotify.com`, and `spotify.link` for short links) if you turn on `SPOTIFY_LINK_IMPORT`.
- **Signing out** clears everything kept for you on that device: your sign-in, the queue, lists such as missing tracks, the settings that are yours rather than the device's (anything for the AI, the player's name, Home layouts), and the tab's own record of the pages you'd opened, with what you'd typed in their search boxes (since 0.20.0 that's kept there only, not with the browser's history of the tab too, which no page can clear). The page then loads afresh, so nothing of yours is left in it, other tabs signed in sign out too, and the browser is asked to forget the artwork it kept from the player (over HTTPS; see [Remaining risks](#remaining-risks)).

## Safeguards

### The Plex proxy

- Requests without a token are refused, except the playlist and segment files inside a stream Plex is converting (players fetch those by the stream's session id, which the app makes random so it can't be guessed), and only at paths with Plex's own shape.
- If your Plex server lets the container's network in without signing in (Plex's "List of IP addresses and networks that are allowed without auth"), Plex would treat every request from the container as its owner's. The service checks for that with a made-up token, and then lets only the owner's own sign-in through (checked with plex.tv), and the log says how to fix the setting. Since 0.16.0, while that can't be told (the server isn't answering, or its certificate can't be checked), nobody gets through (the owner only, if the server's id is known from before), never everybody.
- Browsers can't set the `X-Forwarded-For` address Plex sees, cookies aren't passed on either way, only WebSocket upgrades are, and nothing from Plex is kept by the browser except artwork (its address names the picture, and it's marked private).
- At an `https://` name, nginx checks Plex's certificate as a browser would. At an `https://` network address it can't (see [Remaining risks](#remaining-risks)); the service checks there that it's a valid Plex certificate.

### Routes to your server

- The browser reaches your server at the addresses plex.tv gives for it, or through the container's `/pms/` proxy. Each route is asked who it is, and only counts if it's that very server (by its id), so whatever else answers at an address isn't used.
- The question carries the server's token, as everything the app then sends that way does: a Plex server only lets a page on another address read its answer when the request has one. So it goes only where the token stays private: to `https://` addresses, whose certificate the browser checks (Plex makes each server's `plex.direct` certificate for that server alone); to plain `http://` addresses only on your home network, and only when the player itself is opened over plain HTTP (a page over HTTPS can't use them), where it's unencrypted as in Plex's own apps; and to the player's own address. Over the internet, plain `http://` addresses are never used.

### Play Together

- Only your own Plex friends can be invited, and joining checks with plex.tv, with the joiner's own token, that they can play from the session's library. A session's link is useless to anyone who wasn't invited.
- Everyone plays from the Plex server with their own token. Tokens are never shared between people, and the service doesn't keep them.
- Tracks someone adds are reduced to the fields the app needs, and their file and artwork paths must have Plex's own shape, so nobody can point other people's players at another website, or another part of the server. Each player checks this again before playing.
- People in a session see each other's Plex display names and profile pictures, never email addresses or tokens.
- Sessions are in memory and end on their own: after 30 minutes with nobody listening, or after 24 hours. A player holds at most 100, one per person. Requests are limited per person.

### Play on

Browsers can't send commands to a Plex player on your network, so the service passes them on. That means it makes requests into your home network, so it's tightly limited:

- **Only your server's owner, and only with `PLEX_SERVER_URL` set** (since 0.16.0; before, without it, anyone signed in to Plex could use it, with players on their own account). The players it can reach are on the server's network, and they're the owner's.
- **Only your own players, on your network.** The service connects only to devices on the signed-in account (from plex.tv) that say they're players, only at home-network addresses (10.x, 172.16 to 172.31, 192.168.x, 100.64 to 100.127 for Tailscale, and IPv6 unique-local addresses), and only on the ports Plex players use (32500 to 32510, 3005 and 32433). Never at internet, loopback or link-local addresses. Players' addresses stay in the container; the browser only gets their names.
- **Only commands it builds itself**, from a fixed list, with every value checked. It follows no redirects, waits at most 5 seconds, reads at most 64 KB of an answer, and passes back only the player's state.
- **A temporary token for playback.** The player plays from your Plex server with a temporary token the server makes for it, which only works on that server.
- **AirPlay and Google Cast** are the browser's own. Before the browser hands a track to a speaker, the app switches its address to a temporary token from your Plex server, for that server and account only; until it has one, nothing is sent (since 0.16.0: before, the account's own token could go).

### Your devices

- **What it holds**, in memory only: for each Plex account and server, the devices open (a name such as "Chrome on Android", or the player name you chose, and a random id), which one plays, its queue around the current track (up to 600 tracks), where it is, and commands waiting for it. A device that's gone quiet is forgotten after a minute, the rest a day after your devices were last used.
- **Only your own devices.** Each request carries the device's own Plex token, checked with plex.tv, on a server that account can play from. What one account's devices share is never shown to another account.
- **No tokens between devices**, and what one device sends another is checked: tracks reduced to the fields the app needs, Plex-shaped paths, commands from a fixed list, requests limited per account, bodies to 512 KB.

### The shared AI model

- Every request's Plex sign-in is checked: with `PLEX_SERVER_URL` set, only people who can use your Plex server get through.
- Only chats are passed on, with the fields the app uses, each checked, and always on the model in `OLLAMA_MODEL`. Since 0.16.0 the service also decides what sets how much memory the model takes on the AI server (how much context, and how long it stays loaded), and keeps answer formats small.
- The AI server's other models, its version, its settings and its address are never shown. Since 0.16.0 that includes Ollama's own error messages (whether it turns a chat down or stops partway through one), which can say where it is and what's on it: they go to the container's log, and the app gets a plain message.
- `OLLAMA_API_KEY` goes to Ollama only, never to browsers or the log.
- **An Ollama of your own** (**Settings › AI › My own Ollama server**, for anyone the shared model isn't for, or who'd rather use theirs) is reached from the browser directly, never through the container, so the container's AI server isn't involved. Its address and key stay in that browser (a device's own settings, never kept for your account), and signing out clears them. The shared model's settings can't be chosen or seen there either way.
- Requests are rate-limited per person and per address, and a few chats run at a time.

### MusicBrainz checks

- **Off unless you set it up** (`MUSICBRAINZ_URL`: musicbrainz.org, or your own mirror, so names needn't leave your network at all). Then each device can turn it off, and it only happens with Show missing tracks on.
- **Only names**: artists, and songs' titles with their artist, that an AI playlist suggested and your library doesn't have. No tokens, nothing about your Plex account, server or the rest of your library. Browsers send them to the container, never to MusicBrainz, so MusicBrainz sees the container's address, and a User-Agent naming this app and its version, as it asks apps to send.
- **For people who can use your Plex server**, as the shared AI model is.
- **Searches it builds itself**, with each name quoted, and answers reduced to "known", "an album" or "not known".
- **Limited**: 10 names a request, 30 requests a minute each, a few at a time. musicbrainz.org is asked at most once a second for everyone (its rule). Answers are kept in memory for a week.

### Spotify imports

From Spotify's download of your data (Search › From Spotify):

- **Only the playlist files are opened.** Spotify's download is a ZIP with a file for each kind of data, most of them personal (your email, date of birth, address, phone number, payment card, and what you've searched for and listened to). The app asks for only the files named `Playlist1.json` (`Playlist2.json` and so on) and `YourLibrary.json`, and checks each file's name before opening it: any other, the ZIP itself included, is turned away unread, and the app says which.
- **Read in the browser, and kept small**: each file is read on the device (at most 25 MB a file, 1,000 playlists, 20,000 tracks a playlist and 100,000 in all), and only each playlist's name and each track's title, artist and album are kept, as plain text. Descriptions, follower counts, dates and Spotify's ids aren't. Nothing from the files goes to the container's service or to Spotify: the titles, artists and albums go to your Plex server (through the container's `/pms/` proxy when that's the route), to find the tracks, as any search does. (Since 0.22.0 the proxy's sign-in check is given only the request's token, not the rest of its address, so the service doesn't see what's searched for, from here or anywhere else in the app.)

From a link:

- **Off unless you turn it on** (`SPOTIFY_LINK_IMPORT=true`, or `SPOTIFY_IMPORT=true` as before 0.22.0). Spotify's API only gives a playlist's tracks to the account that owns it, so the container reads the page Spotify shows anyone for the playlist (its embed player) instead. Spotify's terms don't allow reading it like that, which is why it's off to begin with.
- **Only the playlist's id goes to Spotify**, from the container: the link is checked to be an `open.spotify.com` playlist link, a `spotify:playlist:` URI or a `spotify.link` short link, and the page is always fetched from Spotify's own address with that id in it, so a link can't make the container fetch anything else. A short link is followed to Spotify's address only. No tokens, cookies or anything about you or your library go to Spotify, and your browser never contacts it.
- **For people who can use your Plex server**, as the shared AI model is (anyone signed in to Plex without `PLEX_SERVER_URL`).
- **What's read is bounded**: a 15-second limit, at most 5 MB of page, redirects followed only within Spotify's address, and only the playlist's name, its maker's name and each track's title, artists, album and length come out of it, as plain text and numbers. Pages are kept in memory for 10 minutes.
- **Limited**: 10 playlists a minute each, 60 a minute for everyone, 4 at once.

### Shared playlists

- **What it keeps**, in `/data/shares.json` (on Proxmox, `/var/lib/plexamp-web`), readable by the service alone: each shared playlist's title and tracks, the Plex account id and display name of whoever shared it and of each friend it's shared with, whether each can edit it, and which playlist is each one's copy. No tokens or email addresses.
- **No one's sign-in is used for anyone else.** Each person's browser changes their own copy in Plex, with their own token.
- **Only your own Plex friends, on the same server**, checked with plex.tv. Someone it isn't shared with can't tell it exists, and the people it's shared with see whose it is, nothing about one another. Only its owner can change who it's shared with, and someone who can only view it can't change it for anyone.
- **Checked on the way in**: track ids must be numbers, titles are one line, and there are limits on tracks (5,000), people (30), playlists each person shares (50) and in all (2,000). A file that's been tampered with is checked as it's read.
- **Its folder is the service's own**, and only one that holds nothing but shared playlists. Nothing there is followed or changed through a link.
- **Tracks you can't see aren't taken out for everyone**, and only the difference is made to your copy, by one of your devices at a time.

### Editing playlists and collections

Changes go to your Plex server with your own token, so Plex decides what you may change: your own playlists, and collections only if you own the server (the app only offers collections to the server's owner). Taking a track out of a playlist only takes it out of the playlist, never out of Plex. Pictures are redrawn in the browser as a JPEG of at most 1200 pixels before they go.

### The service

- It listens on a Unix socket only nginx can reach, and answers only plain paths (since 0.16.0: a path with a backslash, `.`/`..` or encoded slashes in it isn't answered, so a path nginx kept from it can't become one it answers). Its sign-in checks for `/pms/` and the AI model's requests are only answered when they come the way nginx sends them.
- With `PLEX_SERVER_URL` set it's for the people who can use that server: Play Together, your devices and shared playlists too, since 0.16.0 (on that server, or another of theirs), as the shared AI model and MusicBrainz checks were already.
- New sign-ins are checked with plex.tv a few a minute from each address (an IPv6 address by its network; sign-ins seen lately don't count), at most 16 questions at once with a limited number waiting, and each token only once however many requests ask. plex.tv's answers are read up to a limit, and redirects aren't followed, so a token goes to plex.tv and nowhere else.
- It starts as root to make its socket, then gives up root and root's groups, and won't carry on as root if the user it should become isn't there.

### The container and its image

- Built on nginx's stable branch, with Alpine's own security fixes since, rebuilt each release. The nginx access log is off (Plex tokens travel in addresses); in debug mode it shows paths only. nginx's version isn't shown, and the content security policy allows scripts and styles from the player only.
- Every setting is checked at start-up, as a whole value (one line, the characters it can have), before it goes into nginx's configuration or the app's `config.js`; a value that doesn't fit stops the container with a message, without printing passwords.
- `docker-compose.yml` sets `no-new-privileges`. Nothing whose name starts with a dot is served.

### The Proxmox install

- Everything you type, or set beforehand, must match a strict pattern (the whole value: one line, no quotes or shell characters) before it goes into a command or settings file. The settings file is written on the node and copied into the container, readable by root only.
- The container is unprivileged, and the service runs as `www-data`, which can't gain privileges or capabilities.
- Only what the Docker image has is installed: nginx and Node.js from Debian, the app from this repository, and hls.js from npm, checked against the npm registry's checksum.
- The app comes from the `stable` branch, which CI moves only to commits that passed every test. The one-line install starts from there too, and falls back to `main` only while there's no `stable` branch, never because a download failed. The script runs nothing unless all of it was downloaded.

### Building and publishing

CI's jobs get only the permissions they need (only the one that moves `stable` can change the repository), actions are pinned to commits, and the shellcheck it downloads is checked against its checksum.

## What debug mode logs

`DEBUG=true` writes much more to the container log: settings (secrets only as "set"), connection checks, request paths and status codes, the service's activity, and problems from browsers (a limited number of lines a minute). Tokens and keys are replaced with `[redacted]` everywhere (in addresses, inside other addresses, in headers and in JSON), but the log shows server addresses, people's names and tracks' names. Share it with care, and turn debug mode off when you're done.

## Remaining risks

These come with how the player works:

- **Tokens live in the browser.** Like Plex's own web app, the player keeps your token in the browser's local storage. Anyone with the browser profile, or a script injected into the page, could read it. The page uses no third-party scripts, builds everything without HTML strings, and has a strict content security policy, which makes injection hard.
- **The browser's history of a tab keeps the addresses of the pages opened in it** (an album's or a playlist's number on the server, say: what's searched for isn't in them), and no page can take them out. After signing out, Back still reaches them, and they open as whoever is signed in then, with what they can see.
- **Tracks loaded ahead, and those played that are kept** (**Settings › Playback › Load ahead** and **Keep played tracks**) are kept by the browser while they're wanted, up to 512 MB: not saved by the app, nor in the browser's cache, and let go when they're further back than that, the queue moves on, or you sign out. A browser short of memory can set large files aside in its own temporary storage until then.
- **Tokens are in media addresses.** Plex needs the token in artwork and audio addresses. They go only to your Plex server and are never sent as a referrer, but they show in the browser's developer tools, and in its cache, which keeps artwork for a day. Signing out asks the browser to forget what it kept from the player, but browsers only do that over HTTPS, and artwork loaded from your Plex server directly is kept as that server says.
- **The container serves plain HTTP.** On your home network that's the same as Plex's own `http://` addresses. If you use the player from outside, put it behind an HTTPS reverse proxy (see [docs/setup.md](docs/setup.md#from-outside-your-home-https)): without it, tokens cross the network unencrypted.
- **At an `https://` network address, the proxy can't check the Plex server's certificate name.** A Plex server's certificate is for its `plex.direct` name, never its address, so nginx encrypts the connection but can't check who it's talking to: as with `http://`, that hop relies on your home network. The service does check the certificate is a valid Plex one there.
- **Without `PLEX_SERVER_URL`, the service is for anyone signed in to Plex**, and Plex accounts are free: the shared AI model, MusicBrainz checks, Play Together, your devices, shared playlists and account settings (those two kept on the container's disk, within limits). If the player can be reached from the internet, set `PLEX_SERVER_URL`.
- **AirPlay and Cast from the browser's own controls** (not the player's Play on) can hand a speaker the track's address, with your token, before the app switches it to the temporary one, which it does as soon as the browser says it's connected. Use Play on.
- **Shared playlists are kept as plain JSON**: whoever can read the container's `/data` volume can see which playlists are shared, with what, and between whom. `PLAYLIST_SHARING=false` keeps nothing.
- **Each account's settings are kept as plain JSON** there too (`settings.json`): how the app looks and plays for each Plex account, by its Plex id, and its Home screen layout. Only the settings that follow an account are kept, each as the kind of value it is (a yes or no, a number, one of a few words, the Home layout), within limits: never a sign-in, a device's name or connection, or anything for an AI server, even if a browser sends them. Only for Plex accounts that can use the server the app is on, and with `PLEX_SERVER_URL` set, that server. `SYNC_SETTINGS=false` keeps nothing, and anyone can turn it off for their own account in **Settings › Account**.
- **On Proxmox, nginx and the service run as the same user** (`www-data`, Debian's), so a flaw in one could reach the other's files: the service's socket, shared playlists and account settings. In the Docker image they're separate users.
- **hls.js** is checked against the npm registry's checksum, as it's downloaded. npm doesn't let a version be published twice.
- **Debug mode accepts log lines from anyone who can open the player** (a limited number a minute), so it can fill the log with noise while it's on.
- **Wide connection rules.** The content security policy has to allow connections, images and audio from any address, because Plex servers and Ollama can be anywhere.
- **Spotify imports from a link read a page, not an API** (when `SPOTIFY_LINK_IMPORT` is on). Spotify's terms don't allow it, so it's for whoever runs the player to decide, and when Spotify changes the page the import stops working (or, at worst, reads names wrongly: they're only ever plain text). Spotify sees the container's address asking for the playlists people import.
- **Whoever runs the container is trusted.** They control the code your browser runs, and the service sees your token when it checks who you are, and what you play while your devices share playback. That's true of any web app you open.

## Reviews

### 0.16.0

A second full review, of the browser app, the service, the nginx configuration and start-up script, the image, the Proxmox scripts and CI, looking for vulnerabilities, data leaks and privacy problems.

| Area | What was wrong | What changed |
| --- | --- | --- |
| Plex proxy | When the service couldn't check the Plex server (a self-signed certificate, say), the proxy let every signed-in Plex account through. If that server also let the container in without signing in, anyone could use it as its owner. | Fails closed: nobody gets through until the server can be checked, and the log says why. At an `https://` name, nginx now checks the certificate too. |
| Service paths | The service read a backslash in a path as `/`, where nginx doesn't, so its own AI path and sign-in check could be reached past the rules that keep them from browsers. | Only plain paths are answered, and those two only when nginx sent the request their way. |
| Play on | Without `PLEX_SERVER_URL`, anyone signed in to Plex could have the container send requests around its own network, to addresses they gave made-up players on plex.tv, and tell from its answers what was there. | Play on with Plex players needs `PLEX_SERVER_URL`, and is for the server's owner only. |
| Service | Anyone could send made-up tokens, each another question for plex.tv. | New sign-ins are checked a few a minute from each address, a limited number at once, each token once, with plex.tv's answers capped and redirects refused. Many addresses at once no longer reset everyone's rate limits. |
| Service | With `PLEX_SERVER_URL` set, Play Together, your devices and shared playlists could still be used by any Plex account, on a server of its own (and shared playlists are kept on the container's disk). | They're for the people who can use that server. |
| Shared AI model | Ollama's own error messages reached the app (they can name the AI server's address and what's on it), and requests could choose how much memory the model takes and how long it stays loaded. | Errors go to the log only, including those partway through an answer; the service sets the context size and how long the model stays loaded, and keeps answer formats small. |
| Debug mode | Redaction could be made to take a very long time (an attack on the service while debug mode was on), missed tokens inside other addresses and in headers, and browsers could write a lot to the log. | Redaction takes the same time whatever it's given, and finds them; lines from browsers are limited per minute. |
| Routes | Testing the connection took any server that answered at an address for yours, and a server's plain `http://` address over the internet would carry your token unencrypted. | Each route only counts if it's your server (by its id). Over the internet only `https://` addresses are used, as in Plex's own apps by default. 0.16.0 also asked each route without the token, but Plex servers don't answer a browser that way, so only the container's route worked: 0.17.0 asks with it again, only where it stays private (see [Routes to your server](#routes-to-your-server)). |
| Sign-out | Other tabs stayed signed in; personal settings stayed (AI notes, the player's name, Home layouts) while the dialog said settings were cleared; data from the account stayed in the page; and a shared playlist being brought up to date could save to the device after signing out. | All of that is cleared or stopped, nothing more is kept as the page goes, the page reloads, other tabs follow (keeping nothing either), and the browser is asked to forget artwork it kept. |
| AirPlay and Cast | The temporary token for speakers wasn't tied to a server or account, and without one the account's own token could go. | It's for one server and account, and nothing is sent without one. |
| Privacy | Missing tracks' export included what you asked the AI for, and searches were in the page's address (and so the browser's history). | The export leaves prompts out; searches are kept with the page instead. |
| Converted streams | Their session id, which is all a stream's files are fetched by, could be worked out from the device's id. | It's random. |
| Caching | Answers from Plex and the service could be kept by the browser (their addresses have tokens in them). | Not kept, apart from artwork. |
| Start-up settings | A value with a line break in it passed the checks (only its first line was checked), so it could add to nginx's configuration or the app's `config.js`. | Whole values are checked, and every number is a number. |
| Image | It was built on nginx 1.27, which no longer gets security fixes. | nginx 1.30 (the stable branch), with Alpine's fixes since; `no-new-privileges` in Compose; no dotfiles served; only WebSocket upgrades passed to Plex; Plex can't set cookies. |
| Proxmox install | A download that failed for any reason fell back to the untested `main` branch; the one-line install started from `main`; a script cut short partway could run part of itself. | `main` only while there's no `stable`; the one-liner starts from `stable`; neither the script nor the installer (nor an update's) runs unless all of it arrived; the service unit can't gain capabilities. |
| CI | Every job could publish packages, actions weren't pinned, and shellcheck wasn't checked. | Least privilege per job, actions pinned to commits, shellcheck checked against its checksum. |

### 0.5.0 to 0.14.0

| Area | What was wrong | What changed |
| --- | --- | --- |
| Container log | nginx's default access log wrote every request address, tokens included, to the container log. | The access log is off; in debug mode it shows paths only. |
| Container log | nginx's error messages for the Plex proxy quote the request, token included. | Not logged; in debug mode they pass through a filter that removes tokens. |
| Plex proxy | `/pms/` passed on requests without a token, and with a Plex server that lets the container in without signing in, anyone who could open the player could use it as its owner. | Requests without a token are refused (but stream segments), and with such a server only the owner's own sign-in gets through. Browsers can't set `X-Forwarded-For`, and cookies aren't passed on. |
| Shared AI sign-in | Tokens were checked against your Plex server, which accepts anything from an allowed network. | Checked with plex.tv first; the server only as a fallback, when it refuses made-up tokens. |
| Third-party code | hls.js was loaded from a CDN, at whatever its newest 1.x was. | Pinned and bundled into the image; scripts only from the player. |
| Crafted links | A link could make the app send your token to any Plex endpoint. | Links only open library listings, with known fields and numeric ids. |
| Server data in styles | Album colours went into CSS unchecked, so a server could make the browser load an outside image. | Only plain hex colours; image addresses escaped. |
| Outside images | Artwork hosted elsewhere was loaded from that host. | All artwork goes through your Plex server. |
| Sign-out | An Ollama API key stayed on the device. | Cleared. |
| Headers | nginx's version was shown. | Hidden; `Permissions-Policy` and `object-src 'none'` added. |
| Start-up messages | A password in an address was printed in full. | Hidden in every message. |
| Link parameters | A value in a link could replace the app's own Plex parameters, the token among them. | The app's own always win. |
| Service account | The service kept root's other groups when it gave up root. | It keeps only its own. |
| Editing | With a Plex server that lets the container in without signing in, friends could change things as the owner through `/pms/`. | Only the owner gets through there. |
