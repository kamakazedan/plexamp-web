# Troubleshooting

Start with [debug mode](configuration.md#debug-mode): most problems show up in the container log with it on.

## Connecting

| What you see | What to do |
| --- | --- |
| **"Can't reach your Plex server"** | Check the server's on and Remote Access is on in Plex, or set `PLEX_SERVER_URL`. **Settings › Connection › Test connection** shows which route answered, and how fast. |
| **Not local at home** (Settings › Connection says Remote, Plex relay or Through this container) | The browser can't use the server's local address. Usually: the router blocks `*.plex.direct` addresses (DNS rebinding protection), Chrome is asking to allow local access (allow it), or Plex in Docker gives out an address only Docker can reach. `PLEX_SERVER_URL` gives a route through the player. |
| **A phone at home can't reach the player while your internet's down** | Android sends everything over mobile data when Wi-Fi has no internet. Turn mobile data off for a while, or choose to stay on the Wi-Fi when the phone asks. |
| **"plex.tv isn't answering this player"** on the sign-in page | Nobody can sign in with Plex just now. Those signed in carry on (see [Offline mode](configuration.md#offline-mode)), and with `OFFLINE_PWD` set, the offline password works. |
| **"Too many sign-ins checked from your network"** | Many people opened the player at once from one address (everyone behind one reverse proxy shares one). Wait a minute. |
| **Live updates say they check every minute** | A proxy blocks both WebSockets and the event stream. Everything works; changes just take up to a minute to show. |

### Through the player (`PLEX_SERVER_URL`)

| What the log says | What to do |
| --- | --- |
| **"couldn't check the Plex server at PLEX_SERVER_URL"** | Its certificate can't be checked (self-signed, or for another name), so nothing goes through. Use `http://`, or its address with Plex's own certificate (`https://192.168.1.10:32400`). |
| **"lets this container in without signing in"** | The player's address is on Plex's list of networks allowed without signing in, as offline mode needs. Each request from anyone but you is then checked with your server first. Not meant? Take it off the list. |
| **"took someone else's Plex sign-in, from this container, for yours"** | Your server takes everything from the player's address as yours, so only you get through while it's on that list. Take it off (no offline mode then), or let friends reach the server another way. |
| **"PLEX_SERVER_URL's name … has more than one address"** | Only you get through. Use the server's one fixed address (`http://192.168.1.10:32400`). After a change of address, it passes in a minute. |
| **"answered 403 to a request without a sign-in"** | `PLEX_SERVER_URL` points at something in front of your server, not the server. Use the server's own address. |
| **nginx won't start: `"resolver" directive is duplicate`** (Proxmox VE, with other sites in its nginx) | Another site sets nginx's resolver for all of nginx. Move it into its own `server` block, or use an address in `PLEX_SERVER_URL`. |

## Listening

| What you see | What to do |
| --- | --- |
| **Some tracks won't play** | Check **Settings › Connection › Browser formats**. Formats the browser can't play need your server to convert them. |
| **The sound cuts out, often near a track's end** | The connection can't keep up (playing from home at work, say: your home upload is the limit). Turn on **Settings › Playback › Load ahead**, or choose a lower **Streaming quality** (320 kbps is about a third of a CD-quality FLAC). |
| **A stutter now and then** | Turn on debug mode and note when it happens. A line like `waited 0.15 s for “Song”` means playback ran out of data: `as it comes from the server` points at the connection, `from memory` at the computer. No line means the player didn't wait: it's after the player (Bluetooth headphones, say). |
| **"Can't play … Skipping." in converted tracks** | A stream that fails is tried again, and started again where it got to. If it keeps happening, the debug log says which part failed and what the server answered. |
| **Playback stops when the phone locks** | Add the player to your home screen, and check the browser isn't held back by battery saving. |
| **Smart crossfade waits for the very end** | It needs Plex's loudness analysis (see [features.md](features.md#good-to-know)). |
| **The browser uses a lot of memory** | Open an issue with the browser, your library's size and what you were doing (in Firefox, `about:memory` helps). |

## Settings and lists

| What you see | What to do |
| --- | --- |
| **Settings don't follow you** | Both devices need the same player address and Plex account, with **Settings › Account › On all your devices** on. The log says at start-up if they're off for everyone (`SYNC_SETTINGS=false`, or a problem with `/data`). Some settings are each device's own on purpose: see [features.md](features.md#settings-in-the-app). |
| **Missing tracks aren't on another device** | Same player address and Plex account on both. Friends' show for the server's owner once their browser has sent them. The log says at start-up if they're off for everyone. |
| **The log says it "couldn't read" a file in `/data`** | The file was damaged (a disk problem, say). The player starts without it, and keeps the damaged one beside it, as `<name>.unreadable-…`. |

## With friends

| What you see | What to do |
| --- | --- |
| **Play Together shows no friends** | They need to be your Plex friends, with your library shared with them. "Can't play from …" means they don't have access to this server. |
| **A friend can't join, or doesn't see a shared playlist** | They need the same player address, signed in with Plex, with your music library shared with them. Shared playlists are on their Playlists tab, under Shared with you. |
| **No Share with friends… in a playlist's menu** | Shared playlists are off. The log says why at start-up (`PLAYLIST_SHARING=false`, or a problem with `/data`, such as other files in it). |
| **Shared playlists went after an update** | The container had no volume at `/data`. Add one, as in `docker-compose.yml`. Everyone still has their copy: share it again. |

## Play on

| What you see | What to do |
| --- | --- |
| **No Plex players listed** | It needs `PLEX_SERVER_URL`, and only the server's owner sees them. The player must be on, signed in to your Plex account, and on the same network as the container. |
| **A Plex player doesn't respond** | Check it's still on that network and allows remote control. The debug log says what it answered. |

## AI and MusicBrainz

| What you see | What to do |
| --- | --- |
| **"Ollama is running, but doesn't allow …"** (your own Ollama) | Its `OLLAMA_ORIGINS` doesn't list the player's address. **How to allow this site**, in Settings › AI, has the commands. Restart Ollama after. |
| **"No answer from Ollama"** | Check it's running, and that this device can reach it. |
| **"The AI service couldn't confirm your Plex sign-in"** | Sign out and in again. With `PLEX_SERVER_URL` set, only people who can use that server can use the shared model; anyone can use their own Ollama. |
| **AI answers are slow, or "still loading after 5 minutes"** | The first request loads the model (minutes, on modest hardware). It then stays loaded for 15 minutes. For a big model, raise **Settings › AI › Wait for the model**. |
| **Years and genres to fix takes hours** | musicbrainz.org allows one request a second (a few hours for 25,000 albums). A mirror of your own is much quicker. In debug mode, the log says how quickly MusicBrainz is answering, once a minute. The check stops when the app's closed, and catches up quickly next time. |
| **"N albums couldn't be checked: your MusicBrainz server didn't answer for them"** | Each was asked 3 times without an answer within a minute. The debug log names them, and what wasn't answered. Give the mirror's database more memory (see musicbrainz-docker's README), then **Look again**. |
| **"Your MusicBrainz server isn't answering just now"** | Nothing came back for a minute. The check waits, then carries on by itself. |
| **"Searching your MusicBrainz server finds no one"** | Your mirror's search indexes aren't built. Albums Plex has MusicBrainz ids for are still found; build the indexes for the rest (see musicbrainz-docker's README). |
| **"Not all could be checked on MusicBrainz"** | musicbrainz.org limits each internet address, and said it's busy. Or, with your own mirror, "Searching it needs its search indexes": build them. |

## Proxmox VE

| What you see | What to do |
| --- | --- |
| **`update-plexamp-web` isn't found** (installed with 0.10.0 or 0.11.0) | Run `pct exec <ID> -- /usr/local/bin/update-plexamp-web` once. |
| **An update stops** | `pct exec <ID> -- update-plexamp-web --verbose` shows every step, and where it stopped. |
| **Where's the log?** | `pct exec <ID> -- journalctl -u plexamp-web -u plexamp-web-config -f`. |
