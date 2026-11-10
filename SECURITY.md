# Security

Claude, an AI model made by Anthropic, wrote plexamp-web, and did the reviews below too. Treat them as careful self-reviews, not an independent audit, and review the code before you make the player reachable from the internet.

- [Reporting a problem](#reporting-a-problem)
- [At a glance](#at-a-glance)
- [Safeguards](#safeguards), feature by feature
- [What debug mode logs](#what-debug-mode-logs)
- [Remaining risks](#remaining-risks)
- [Reviews](#reviews): what each one found and fixed

## Reporting a problem

Use **Report a vulnerability** in the repository's **Security** tab if it's there: only the owner sees it. Otherwise open an issue, without tokens or logs that contain them. Only the newest version is looked after: update first, and say which version you're on (**Settings › About**).

## At a glance

- **Your Plex sign-in** is kept in the browser. It goes only to plex.tv, your Plex server (directly or through the player's `/pms/`), and the player's own service, which checks who you are.
- **Your library**: requests go from your browser to your Plex server.
- **Plays and ratings made while the connection's down** wait in the browser (two weeks at most), then go only to that very server, with the sign-in that made them. Signing out clears them.
- **What the container keeps**, in `/data`, readable by its service only: shared playlists, each account's settings and Missing tracks, MusicBrainz's answers, and fingerprints of the server owner's sign-ins. No database, and never a token.
- **In memory only**: Play Together sessions, what your devices are playing, and offline-password sessions.
- **No tracking**: no analytics or third-party scripts. hls.js is bundled into the image.
- **Who the browser talks to**: plex.tv, your Plex server, and an Ollama of your own if you set one up.
- **Who the container talks to**: plex.tv, your Plex server, and, only if you set them up, the shared Ollama, MusicBrainz, and Spotify (for link imports).
- **Signing out** clears everything kept for you on that device.

What each feature sends:

| Feature | What goes | Where |
| --- | --- | --- |
| Missing tracks | Each missing track's title and artist. Never what was asked for, or Spotify playlists' names. | The player (`SYNC_MISSING_TRACKS`) |
| MusicBrainz checks | Suggested artists, and songs' titles with their artist | MusicBrainz, from the player |
| MusicBrainz features | Artists' names, or Plex's MusicBrainz ids for them (a mirror of your own: albums' MusicBrainz ids too). Never titles. | MusicBrainz, from the player |
| Spotify, from your data | Nothing: the files are read in the browser | |
| Spotify, from a link | The playlist's id | Spotify, from the player |
| Playlist files | Nothing: the file stays on your device | |
| Pictures you upload | The picture, redrawn smaller first (so a photo's location and camera don't go with it) | Your Plex server |

## Safeguards

### The Plex proxy (`/pms/`)

- **A token is required**, except for the files of a stream Plex is converting, which are fetched by the stream's random session id, at paths with Plex's own shape.
- **If your Plex server lets the player in without signing in** (Plex's list of networks allowed without auth, as [offline mode](docs/configuration.md#offline-mode) needs), it would take any request from the player as its owner's. So the service checks each request first, asking the server whether it lets the player in right now. If it does, only these get through:
  - **the owner's own sign-in**, as plex.tv says (while plex.tv is down, by its [fingerprint](#your-own-sign-ins-by-their-fingerprints)). The owner's are never held back by others' limits;
  - **anyone else's**, only if the server, asked with that sign-in just before, refuses it what only the owner may see (its settings, and who's playing what). Then the server knows them as themselves. Asked again for every request;
  - **with one sign-in only**: no second token anywhere in the request, and "token" nowhere else in it, in any case or %-escaped;
  - **no streams** (the server's notifications), for anyone but the owner;
  - **offline-password sessions**: their requests go without a sign-in, as the owner's. That's what the password is for.
- **What can't be checked is refused**: while the server or plex.tv isn't answering as needed, only the owner gets through; until the server's certificate is checked, nobody.
- **One route to the server**: the service asks through nginx itself, so its question and the request reach the server the same way, from the same address. A `PLEX_SERVER_URL` name with several addresses, or one that's just changed, lets only the owner through.
- **Made-up sign-ins** can only have the server asked about them a few times a minute from an address.
- **Nothing of where a request came from** reaches Plex (no `X-Forwarded-For` or the like): Plex sees everything as the player's own address, as some Plex versions judge by that header.
- **No cookies** either way, no `Authorization` or `Content-Type` header to Plex, only WebSocket upgrades passed on, and nothing from Plex kept by the browser but artwork.
- **HTTPS**: at a name, nginx checks Plex's certificate as a browser would. At an address it can't, so the service checks it's a valid Plex certificate, from that very server.
- **Without Node.js** (the service), there's no `/pms/` at all.

### Your own sign-ins, by their fingerprints

So your devices carry on while plex.tv is down, the service keeps the SHA-256 hash of each sign-in plex.tv said was the server owner's, which can't be turned back into the sign-in.

- At most 50, each for 30 days after its last use, in `owners.json`, readable by the service only.
- One goes as soon as plex.tv says it's no good, or not the owner's.
- Used only while plex.tv isn't answering, and only for `/pms/`.

### Offline mode

Off unless `OFFLINE_PWD` is set. The password signs in **as the server's owner**, so it's theirs to give, only to whoever they'd let use their Plex account.

- **Only while plex.tv is down** (20 seconds without an answer), and only where the server lets the player in. Otherwise it isn't even looked at.
- **Only from your own networks**, unless `OFFLINE_NETWORKS` says otherwise. Behind another proxy, that proxy's address is what's seen.
- **Few tries**: five a minute from an address; none from it for the rest of the hour after 30 wrong ones from it. After 30 wrong ones from anywhere, none from any address a wrong one came from, and after 200, from anywhere, but where the password signed in from in the last 14 days, only that address's own count.
- **Never shown**: compared in constant time, never logged, not in `config.js`. Only characters settings files keep as they are.
- **Sessions** are random, in memory only, 14 days at most, and all end two minutes after plex.tv is back. A session's sign-in never leaves the container, and is refused wherever a Plex account is needed (Play Together, your devices, shared playlists, synced settings).

### Routes to your server

- **Only that very server**: each route is asked who it is, and only counts if it's your server, by its id.
- **Your token stays private**: it goes to `https://` addresses (certificates checked), to plain `http://` addresses only on your home network for a server of your own (and only with the player itself on plain HTTP), and to the player. Never plain `http://` over the internet.
- **Your account's token** never goes to someone else's server: the server's own access token does.
- **An address you type** (Settings › Source) is first asked who it is with nothing of yours, and used only where plex.tv has it as one of your servers.

### Play Together

- Only your own Plex friends can be invited, and plex.tv confirms each can play from the session's library.
- Everyone plays with their own token. Tokens are never shared, and the service doesn't keep them.
- Tracks added are cut down to what's needed to play them, with Plex-shaped paths, checked again by each player.
- People in a session see each other's Plex names and pictures, never email addresses or tokens.
- Sessions are in memory, end after 30 minutes with nobody listening (or 24 hours), 100 at most.

### Play on

The service passes commands to Plex players on your network, so it's tightly limited:

- **Only the server's owner, with `PLEX_SERVER_URL` set.**
- **Only their own players**: devices on their account (from plex.tv), at home-network addresses only (10.x, 172.16–31.x, 192.168.x, 100.64–127.x, unique-local IPv6), on Plex players' ports only (32500–32510, 3005, 32433). Players' addresses never reach the browser.
- **Only commands it builds**, from a fixed list, with every value checked. No redirects, 5 seconds at most, 64 KB of answer at most.
- **A temporary token** from your server for playback, which only works on that server.
- **AirPlay and Google Cast** get a temporary token for that server and account; until there is one, nothing is sent.

### Your devices

- In memory only: for each account and server, the devices open (their names and random ids), which one plays, its queue (600 tracks at most), and commands waiting.
- Each request is checked with plex.tv. One account's devices are never shown to another.
- No tokens between devices. Tracks, paths and commands are checked; requests are limited per account; bodies to 512 KB.

### The shared AI model

- Every request's Plex sign-in is checked: with `PLEX_SERVER_URL` set, only people who can use your server get through.
- Only chats go to Ollama, with the fields the app uses, each checked, always on `OLLAMA_MODEL`. The service sets how much memory the model takes.
- The AI server's address, other models, version, settings and own error messages are never shown: errors go to the container's log. The model's name is told only to those it's for.
- `OLLAMA_API_KEY` goes to Ollama only.
- An Ollama of your own is reached from the browser directly, never through the container. Its address and key stay on that device.
- Limited per person and per address, a few chats at a time.

### MusicBrainz

- **Off unless set up** (`MUSICBRAINZ_URL`). The features need `MUSICBRAINZ_ADVANCED=true` too. Each person can turn each off.
- **Only names and MusicBrainz ids go** (see [At a glance](#at-a-glance)), from the container, with a User-Agent naming the app and its version, as MusicBrainz asks. No tokens, nothing about your account or server.
- **For people who can use your Plex server**, as the shared AI model is.
- **Searches it builds itself**, each name quoted. Answers read up to 8 MB; redirects never followed.
- **Limited**: 10 names a check and 30 checks a minute each; the features 120 requests a minute each, 1,000 albums a request and 30,000 a minute. musicbrainz.org is asked once a second at most, for everyone. A mirror of your own: up to 8 at once while it keeps up, 20 a second at most. One that says it's busy is left alone as long as it asks.
- **Kept**: checks' answers in memory for a week; the features' in `/data/musicbrainz.json` for a month (MusicBrainz's public data, and each album's answer, by artist, title and year: nothing about who asked).
- **Never Various Artists**, or MusicBrainz's other special-purpose artists ([unknown], [anonymous] and the rest).
- **Changes to Plex are the owner's**: years and genres are fixed from the owner's browser, with their own sign-in. Artists to merge only lists. Plex never writes to your files.

### Spotify imports

From Spotify's download of your data:

- **Only the playlist files are opened**: `Playlist1.json` (`Playlist2.json`…) and `YourLibrary.json`. Any other file, the ZIP included, is turned away by its name, unread: the others hold personal details (email, address, payment card, listening history).
- **Read in the browser**, at most 25 MB a file, 1,000 playlists, 20,000 tracks a playlist and 100,000 in all. Only playlist names and tracks' titles, artists and albums are kept.
- **Nothing goes to Spotify.** The titles go to your Plex server, as any search does. Tracks not found go to Missing tracks, without the playlist's name.

From a link (off unless `SPOTIFY_LINK_IMPORT=true`):

- **Only the playlist's id goes to Spotify**, from the container. The link must be a Spotify playlist link; the page is always fetched from Spotify's own address. Your browser never contacts Spotify.
- **Bounded**: 15 seconds, 5 MB of page, redirects only within Spotify, and only names, titles and lengths come out of it, as plain text.
- **For people who can use your Plex server.** 10 playlists a minute each, 60 for everyone.
- Spotify's terms don't allow reading its pages like this: that's why it's off to begin with.

### Missing tracks

- **Kept** in `/data/missing.json`, readable by the service only: for each server and account (by Plex id), the missing tracks' artists and titles, their library, how often and when, and whether MusicBrainz knows them.
- **Spotify playlists are counted by a short hash** of each name (12 bits: one name in 4,096 shares it), never the name. Someone with the file could only check a single guess against it.
- **Never kept**: what anyone asked an AI for, a sign-in, anyone's name.
- **Only changes are sent**, never the whole list, checked as they come in, within limits (500 accounts, 10 servers each, 100,000 tracks in all).
- **Friends see only their own.** The server's owner sees everyone's, with whose each is, and friends are told so.
- `SYNC_MISSING_TRACKS=false` keeps nothing.

### Shared playlists

- **Kept** in `/data/shares.json`, readable by the service only: titles, tracks (by id), and the Plex names and ids of who shares with whom. No tokens or email addresses.
- **Everyone's own sign-in**: each person's browser changes their own copy.
- **Only your own Plex friends, on the same server**, checked with plex.tv. Someone it isn't shared with can't tell it exists.
- **Checked**: numeric track ids, one-line titles, and limits (5,000 tracks, 30 people, 50 playlists each, 2,000 in all).

### Switching user, in a Plex Home

- **The Home's admin and the server's owner** are only offered if they have a PIN. Where who owns the server can't be told, only managed users and those with a PIN are. plex.tv is asked again just before switching.
- **It clears what signing out clears.** Your settings are kept aside on the device, by your account's id, for when you switch back. Your own AI server's key isn't: you enter it again.
- **The PIN** goes from the browser to plex.tv only: never to the container, never kept, and taken out of debug logs.
- From the moment someone else is signed in, an open tab of the last person's keeps nothing more on the device.

### Editing playlists and collections

Changes go to your Plex server with your own token, so Plex decides what you may change. Taking a track out of a playlist never deletes it from Plex. Pictures are redrawn as a JPEG of 1200 pixels at most before they go.

### The service

- **Reachable only through nginx**, on a Unix socket, answering plain paths only.
- **With `PLEX_SERVER_URL` set**, it's for people who can use that server: Play Together, your devices, shared playlists, the AI model and MusicBrainz.
- **Sign-ins are checked with plex.tv** a few a minute from each address, each token once however many requests ask. plex.tv's answers are capped, and redirects refused.
- **It gives up root** once its socket's made.
- **Only JSON** request bodies, said so in the request, so another site's page can't make a visitor's browser send it anything.
- **Its files are written whole** before they replace the old ones. One it can't read is kept aside, never written over.

### The container and its image

- Built on nginx's stable branch with Alpine's security fixes, rebuilt each release. nginx's access log is off (tokens travel in addresses); in debug mode it shows paths only.
- A strict content security policy: scripts and styles from the player only. nginx's version isn't shown. No file starting with a dot is served.
- Every setting is checked at start-up as a whole value, before it goes into nginx's configuration or `config.js`. A bad one stops the container, without printing passwords.
- `docker-compose.yml` sets `no-new-privileges`.

### The Proxmox install

- Everything typed or set must match a strict pattern before it goes into a command or file. The settings file is readable by root only.
- An unprivileged container; the service runs as `www-data`, which can't gain privileges.
- nginx and Node.js from Debian, the app from this repository, hls.js checked against its checksum.
- Installs from the `stable` branch (commits that passed every test), and runs nothing unless all of it was downloaded.

### Building and publishing

CI's jobs get only the permissions they need, actions are pinned to commits, the image published is the very one tested, and the shellcheck it downloads is checked against its checksum.

## What debug mode logs

`DEBUG=true` adds settings (secrets only as "set"), connection checks, request paths and status codes, the service's activity, and problems from browsers (a limited number of lines a minute).

- Tokens, keys and PINs are `[redacted]` everywhere: in addresses, in headers and in JSON.
- The log does show server addresses, people's names and track names. Share it with care, and turn debug mode off when you're done.

## Remaining risks

These come with how the player works:

- **Tokens live in the browser**, as in Plex's own web app. Anyone with the browser profile, or a script injected into the page, could read one. The page uses no third-party scripts and a strict content security policy.
- **Tokens are in media addresses**: Plex needs them in artwork and audio addresses. They show in the browser's developer tools and cache (artwork, for a day). Signing out asks the browser to forget them, which only works over HTTPS.
- **The container serves plain HTTP.** From outside your home, put it behind HTTPS (see [setup.md](docs/setup.md#from-outside-your-home-https)), or tokens cross the network unencrypted.
- **At an `https://` address**, the proxy can't check the certificate's name (a Plex certificate is for its `plex.direct` name): that hop relies on your home network, as `http://` does.
- **Without `PLEX_SERVER_URL`, the service is for anyone signed in to Plex**, and Plex accounts are free. If the player can be reached from the internet, set it.
- **A Plex server that lets the player in** takes its requests as the owner's. The player checks each one just before it goes, but a change on the server in that moment (a share taken away) only counts from the next request. Anything else sending from the player's address is let in as the owner too: add only the player's own address to Plex's list.
- **`PLEX_SERVER_URL` must be the server itself.** Something in front of it that answers 401 itself would be taken for the server's own refusal.
- **Behind a reverse proxy**, everyone is one address, so they share the limits on sign-in checks.
- **While plex.tv is down**, a sign-in of the owner's that was signed out meanwhile still works, by its fingerprint, until plex.tv answers again.
- **The offline password is the owner's account** while plex.tv is down: use a long random one, and keep `OFFLINE_NETWORKS` to your own networks.
- **The browser's history** keeps the addresses of pages opened (an album's id, say; not what was searched). Back to someone else's page shows Home instead.
- **Tracks loaded ahead or kept** are held in the browser's memory (512 MB at most), not saved, and let go when no longer wanted. A browser short of memory can set large ones aside in its own temporary storage.
- **The browser's own AirPlay and Cast controls** (not Play on) can hand a speaker a track's address with your token, before the app switches it to a temporary one. Use Play on.
- **Plain JSON in `/data`**: whoever can read the volume sees shared playlists, account settings and Missing tracks. Each has a setting that keeps nothing.
- **nginx and the service run as the same user**, so a flaw in one could reach the other's files.
- **Debug mode accepts log lines from anyone** who can open the player (limited per minute), so it can fill the log while it's on.
- **Wide connection rules**: the content security policy allows connections, images and audio from any address, as Plex servers and Ollama can be anywhere.
- **Spotify link imports read a page, not an API**: against Spotify's terms, and may read names wrongly when Spotify changes it (only ever as plain text).
- **Whoever runs the container is trusted**: they control the code your browser runs, and the service sees your token when it checks who you are. That's true of any web app.

## Reviews

### 0.37.0

A review of all of the code (the browser app, the service, the container and its start-up script, the Proxmox scripts, CI and the tests), for anything written carelessly, found these that bear on security and privacy, all fixed in 0.37.0:

| Area | What was wrong | What changed |
| --- | --- | --- |
| Switch user | The Plex Home's admin was offered to everyone in the Home: where the admin had no PIN, a managed user got into the server owner's account with one tap. | The Home's admin, and the owner of the server the app is on (by plex.tv's id for them), are offered only with a PIN; where who owns it can't be told, only managed users and those with a PIN are; and switching asks plex.tv again just before. |
| Enter a server address | Your Plex sign-in went to whatever address was typed (a typo, or one pasted from someone), often over plain http, before it was known which server answered. | Asked who it is with nothing of yours, and used only where plex.tv has it for one of your servers (a `plex.direct` name only as that very name, never another server's for the same address), and only if that very server answers. |
| Server sign-ins | The access token for whichever server you were on went to the service with the shared AI model's, MusicBrainz's and Spotify's requests, and from there to the server it's set up for; and Settings › Source asked that server who it is through `/pms/` with your Plex account's own sign-in, whoever you were. | A server's token goes to the service only where it's the server the service is set up for; the service says which that is, so nothing goes through `/pms/` to find out. |
| Signing in | Signing in as another account without signing out first kept the last person's server, library (with their sign-in for it), queue, lists and settings on the device. | It clears what signing out clears. |
| Routes | A connection check counted any answer at the server's address, from another server or something that isn't Plex too; plain http addresses on a home network were tried for servers shared with you, with their token; a late check could switch back to a server chosen meanwhile. | Only that very server counts, by its id; plain http home-network routes only for your own server; and nothing switches once another is chosen. |
| Plays and ratings kept offline | Sent as soon as the browser was online, to whatever answered at the server's address. | Sent only once that very server answers. |
| Shared playlists | A page that isn't Plex's answer (a Wi-Fi sign-in page, say) was taken for an empty one, so a copy looked deleted, which stopped the share for everyone, or empty. | Every answer must be Plex's, or it's an error; a copy is gone only when Plex says 404. |
| Play Together | Play now, Play next and Add to queue sent whole tracks to the session, with your play counts, ratings and when you last played them. | Only what's needed to play a track goes. |
| Sign-in fields | The sign-in page's token field and the Ollama key field could be kept by password managers. | They're marked as codes not to keep, as the PIN's is. |
| Service | Request bodies were taken whatever they said they were, so another site's page could have a visitor's browser send the service a request without asking first (a chat with the shared model, with `OLLAMA_AUTH=off`, say). | Only JSON, said so in the request, which a browser asks first for (and isn't let). |
| Service | One signed-in person could have the container ask plex.tv about a made-up server id each time, filling its queue for everyone; and past 2,000 people signed in lately, nearly every request asked plex.tv again. | The servers an account can use are asked about once a sign-in; 20,000 sign-ins are kept, by last use. |
| Service | plex.tv not answering was taken as "no access" where the service checks an account can use a server. | It says it can't tell (503), and nothing is taken away. |
| Service | MusicBrainz's answers were read whatever their size, and its redirects followed. | Read up to 8 MB; a redirect is never followed. |
| Service | A data file that couldn't be read was written over at the next change, losing what was in it. | It's kept aside, as `<name>.unreadable-<when>`, and the log says so. |
| Service | A sign-in checked again after its 15 minutes counted as a new one from its address, so behind a reverse proxy (everyone one address) people were turned away past about 450 at once. | One plex.tv took in the last day isn't counted again; made-up ones still are. |
| Container log | nginx's own errors, outside debug mode, could quote the requests they were about (a device's name in one, say). | They're logged only in debug mode, through the service, which takes tokens out; and not even then if something else listens where they'd be sent. |
| Container | The service was given the container's whole environment, its secrets among them (`OLLAMA_API_KEY`, `OFFLINE_PWD`), though it reads its settings from a file of its own. | It's started with nothing of it but what Node.js needs. |
| Container | `PLEX_TV_URL` and `SPOTIFY_URL` (for tests) could send sign-ins or links to any address, over plain http, without a word. | https only (but to a test's own machine), and the log says when either is set. |
| CI | The image published wasn't the one tested (it was built again to publish), the arm64 one never ran, `stable` and `latest` could go back to an older build, and hls.js was checked only against the registry's checksum. | One build is tested by its digest and published as it is (arm64 started under emulation); nothing moves backwards; hls.js's checksum is kept in the repository. |
| Proxmox install | The installer and the app it installed could be different commits; an update that didn't start was left that way; Debian's other packages never got their security fixes. | One commit, its own installer; an update that doesn't start is put back; Debian's packages are upgraded with each install and update. |

### 0.30.0

A review of 0.30.0's checks at `/pms/` and offline mode, before it was released, found ways the first version of them could be got round, all fixed before release:

| Area | What was wrong | What changed |
| --- | --- | --- |
| Plex proxy | The service asked the Plex server whether it lets the container in by its own way there, not nginx's: for a server at a name, over IPv6 where nginx goes over IPv4, say, and without the `X-Forwarded-For` nginx sent (with the browser's address, which some Plex versions judge by). Where those were answered differently, anyone's sign-in, a made-up one too, could have reached a server that took it for its owner's. | The service asks through nginx itself, and nginx sends Plex nothing of where a request came from: the server judges every request by the container's own address, as it does the service's questions. |
| Plex proxy | Whether the server shows its owner what only they may see was found once every ten minutes, so a server that stopped showing that would have had everyone's sign-in taken as refused, and let through, meanwhile. | It's asked along with each sign-in's question, there and then. |
| Plex proxy | The limits on how many sign-ins an address can have checked could keep the owner out, behind a reverse proxy or on a server that takes everyone for its owner: a friend's own requests counted each time. | The owner's sign-ins plex.tv said were theirs, and those asked about lately, aren't counted, and a sign-in's requests at once ask plex.tv once. |
| Offline mode | A session's requests went to the Plex server with the session's sign-in, which it doesn't know: whether it takes that for its owner's, as it does a request without one, depends on the server, and one that could reach plex.tv might have asked it about the sign-in. Its notification stream, and Plex's own sign-ins, would outlast the session. | They go without the session's sign-in, as the service's questions do, and not the stream or `/security/token`. |
| Offline mode | 30 wrong keys from anywhere locked the right one out everywhere for an hour. | Only from wherever a wrong one came (after 30 from one address, from there whoever's there), and after 200, from everywhere but where the key signed in from in the last 14 days. |
| Artists of the same name | A MusicBrainz id Plex has, that MusicBrainz no longer knows, was still taken as plain evidence of who the page's artist is; a self-titled album could be moved; and an artist with more release groups than are asked for looked as if they hadn't those past the cap. | Plex's id counts only when MusicBrainz found the artist by it; self-titled albums, and artists with more than are listed, stay as Plex has them. |

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
