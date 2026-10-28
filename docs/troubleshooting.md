# Troubleshooting

Start with [debug mode](configuration.md#debug-mode): most set-up problems show up in the container log with it on.

## Connecting

- **"Can't reach your Plex server"**: check the server is online and Remote Access is on in Plex, or set `PLEX_SERVER_URL`. **Settings › Connection › Test connection** says which route is in use, how long the server took to answer, and, through the container, whether it's the container or the server behind it that didn't answer.
- **Every route but the container's "Didn't answer this browser"**, and servers shared with you can't be reached, though their addresses open in a tab: that was 0.16.0, which tested routes without your sign-in, and Plex servers don't answer a browser then. Update to 0.17.0 or later.
- **The connection isn't local at home** (**Settings › Connection** says Remote, Plex relay or Through this container): the browser can't use the server's local address, and **Test connection** shows which routes answered. Usually the router won't look up `*.plex.direct` addresses that point into the home network (DNS rebinding protection), the browser keeps a page from the internet out of the home network (Chrome asks first: allow it, and the app can go straight there), or Plex runs in Docker and gives out an address only Docker can reach. With `PLEX_SERVER_URL` set, the app goes through the container instead (see [configuration.md](configuration.md#reaching-your-plex-server)).
- **The log says your Plex server "lets this container in without signing in"**: the container's address is in Plex's list of networks allowed without signing in (**Settings › Network** in Plex). Until you take it out, only you (the server's owner) can use the server through the player's proxy, as Plex would treat anyone else as you.
- **The log says it "couldn't check the Plex server at PLEX_SERVER_URL"**, and nothing works through the container: its certificate can't be checked (a self-signed one, or one for another name), so the container can't tell whether the server would let anyone in, and lets nobody through. Use the server's `http://` address, or its network address with Plex's own certificate (`https://192.168.1.10:32400`).
- **"Too many sign-ins checked from your network"**: the container checks sign-ins it hasn't seen in the last 15 minutes with plex.tv, 30 a minute from each address. Everyone behind one reverse proxy shares its address, so many people opening the player at once can see this: wait a minute.
- **Live updates say they're checking every minute**: a proxy is blocking both WebSockets and the event stream. Everything still works; changes just take up to a minute to appear.

## Listening

- **Some tracks won't play**: check **Settings › Connection › Browser formats**. Formats the browser can't play need your server to convert them.
- **"Can't play … Skipping." part-way through tracks the server converts** (a Streaming quality below Original, or a format the browser can't play): before 0.18.1, one dropped connection (some office proxies drop them now and then) or a stream the server stopped was enough. Update. A stream that fails is now tried again, then started again from where it got to (at most a moment's gap), and a track is only skipped if its stream keeps failing at the same place. If it still happens, turn on [debug mode](configuration.md#debug-mode): the container's log says which part of the stream failed, what the server answered (`HTTP 404`: the server stopped the stream; `no answer`: the connection dropped), and what the player did. Blocked WebSockets don't affect playback: only live updates use them.
- **The sound cuts out and play/pause flickers, often in a track's last 30 seconds**: playback is waiting for data, on a connection that can't keep up (playing from home at work, say: your home upload speed is the limit). The last 30 seconds are when the next track starts loading for a crossfade or a gapless change; since 0.18.3 it waits until the track playing has loaded to its end, and a crossfade waits until the next track has something to play. **Settings › Playback › Load ahead** (from 0.19.0) loads the next tracks in full well before they're due. A lower **Streaming quality** needs less (320 kbps is about a third of a CD-quality FLAC). With [debug mode](configuration.md#debug-mode) on, the container's log says each time playback waited, for how long and how much was buffered.
- **Playback stops when the phone locks**: add the player to your home screen, and check the browser isn't held back by battery-saving settings.
- **Smart crossfade waits for the very end of tracks**: it needs Plex's loudness analysis (see [features.md](features.md#good-to-know)).
- **The browser uses a lot of memory**: open an issue saying which browser, how big your library is and what you were doing; in Firefox, the numbers from `about:memory` (Measure) help most.

- **Settings don't follow you to another device**: they're kept for your Plex account by the player, so both need the same player address, signed in to the same Plex account. Check **Settings › Account › On all your devices** is on. The container's log says when it starts if they're off for everyone (`settings that follow each account are off: …`): `SYNC_SETTINGS=false`, or something about the `/data` folder. Streaming quality, connection settings, the player name, sharing with your devices, playback speed, Load ahead and your own AI server are each device's own on purpose.
- **Missing tracks aren't on another device, or your friends' aren't on yours**: the player keeps them for each Plex account, so both need the same player address, signed in to the same Plex account; friends' are for the server's owner (plex.tv says who that is), and appear once their browser has sent them (an import with Put what isn't here on Missing tracks, or an AI playlist made with Show missing tracks on), on 0.25.0 or later: before, a friend had to turn on Keep them for your Plex account. Opening Missing tracks reads them again. The container's log says when it starts if they're off for everyone (`missing tracks that follow each account are off: …`): `SYNC_MISSING_TRACKS=false`, or something about the `/data` folder. What was asked for an AI playlist, and Spotify playlists' names, are only ever on the device that asked, on purpose.

## With friends

- **Play Together shows no friends**: friends come from plex.tv, so they need to be your Plex friends, sharing your library. "Can't play from …" means they don't have access to this server. With `PLEX_SERVER_URL` set, Play Together, your devices and shared playlists are for people who can use that server: anyone else gets "You can't play from that Plex server".
- **A friend can't join**: they must open the same player address, sign in with Plex, and have your music library shared with them.
- **A friend doesn't see a playlist you shared**: they find it on the Playlists tab, under Shared with you, signed in with Plex on the same player address. "Can't play from …" in the share list means your server isn't shared with them in Plex.
- **No Share with friends… in a playlist's menu**: shared playlists are off. The container's log says why when it starts (`shared playlists are off: …`): `PLAYLIST_SHARING=false`, or something about the `/data` folder, such as other files in it (give shared playlists a volume of their own).
- **Shared playlists went after an update**: the container had no volume at `/data` (its log says so when it starts). Add one, as in `docker-compose.yml`. Everyone still has their copy, as an ordinary playlist: share it again.

## Play on

- **No Plex players are listed**: Play on with Plex players needs `PLEX_SERVER_URL`, and only the server's owner sees them. The player must be signed in to your Plex account, switched on, and on the same network as the container, and Plex has to know its address there (a player only Plex's relay can reach, or one inside another Docker network, doesn't show).
- **A Plex player is listed but doesn't respond**: check it's still on the same network and allows remote control, and turn on debug mode to see what it answered.

## AI

- **"Couldn't reach Ollama"** with your own server: check it's running, that this device can reach it, and that `OLLAMA_ORIGINS` includes the player's address (see [ai.md](ai.md#your-own-ollama-on-one-device)).
- **"The AI service couldn't confirm your Plex sign-in"**: sign out and in again. With `PLEX_SERVER_URL` set, only people with access to that server can use the shared model; anyone else can use an Ollama of their own (**Settings › AI › My own Ollama server**).
- **AI answers are slow**: the first request loads the model, which can take a minute on modest hardware, and several after Ollama has just started. The model then stays loaded for 15 minutes.
- **"The AI model was still loading after 5 minutes"**: it carries on loading, so try again in a minute or two. If it happens often (a big model, or a slow disk), give it longer in **Settings › AI › Wait for the model**.
- **"Not all could be checked on MusicBrainz"**: musicbrainz.org limits how often each internet address asks, and says it's busy when that's used up (by something else on your network too). The container needs to reach `musicbrainz.org`. With your own MusicBrainz, "Searching it needs its search indexes" means just that: build or download them.

## Proxmox VE

- **`update-plexamp-web` isn't found** in a container installed with 0.10.0 or 0.11.0: run `pct exec <ID> -- /usr/local/bin/update-plexamp-web` once, and the short form works from then on.
- **An update stops, or you want to see what it does**: `pct exec <ID> -- update-plexamp-web --verbose` shows every step, the tools' own output, and the line it stopped at (from 0.16.1 or earlier: `pct exec <ID> -- env PW_VERBOSE=1 update-plexamp-web`). The first install takes `PW_VERBOSE=1` before `bash -c` too.
- **Logs**: `pct exec <ID> -- journalctl -u plexamp-web -u plexamp-web-config -f`.
