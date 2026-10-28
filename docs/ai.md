# AI playlists and the AI DJ

- [What they do](#what-they-do)
- [Setting up a shared model](#setting-up-a-shared-model)
- [Your own Ollama, on one device](#your-own-ollama-on-one-device)
- [Missing tracks](#missing-tracks)
- [Checking suggestions on MusicBrainz](#checking-suggestions-on-musicbrainz)

Both use a model on your own hardware through [Ollama](https://ollama.com); nothing is sent to a cloud service.

## What they do

**AI playlists**: describe what you want to hear, and the model builds a playlist from your library, keeping to what you asked for ("best of The Prodigy" is just The Prodigy; "music like The Prodigy" is mostly them, with similar artists). Play it, add it to the queue, or save it to Plex as a playlist (or, for the server's owner, a collection). A playlist carries on being made while you use the rest of the app.

Playlists are built in two passes, so they only contain music you have: the model picks genres, styles, moods, artists and songs from the tags your library uses, the app finds matching tracks on your Plex server, and the model chooses and orders tracks from those. Models sometimes make songs up, or give an album's title as if it were a song: a suggestion that turns out to be an album isn't used, and no more than an eighth of a playlist comes from any one album where the library allows (compilations aside).

**The AI DJ** (one of the [Guest DJs](features.md#guest-dj)) picks each next track from your library and says why: never by the artist playing or the last few, their best-known songs where Plex has them, from artists who sound like what's playing, who Plex says are similar, or who are in the genre you started with.

**Notes for the AI**, in **Settings › AI**, are added to every request ("I love 90s trip-hop; skip live recordings").

**Waiting for the model.** After Ollama starts, a model can take minutes to load into memory. The app waits up to 5 minutes for it to start answering (**Settings › AI › Wait for the model** goes from 2 to 30 minutes), and says while it's loading. The model carries on loading if the wait runs out, so trying again a little later is quick.

An instruction-tuned model of about 7 to 9 billion parameters, such as `llama3.1:8b` or `qwen2.5:7b`, is a good place to start.

## Setting up a shared model

1. Install Ollama by its own guide: [ollama.com/download](https://ollama.com/download), or [its Docker image](https://docs.ollama.com/docker).
2. Download a model on it: `ollama pull llama3.1:8b` (in Docker: `docker exec -it ollama ollama pull llama3.1:8b`).
3. Make sure the player's container can reach it. Ollama only listens on its own machine to begin with: set `OLLAMA_HOST=0.0.0.0` where it runs (see [Ollama's FAQ](https://docs.ollama.com/faq)). On the same machine as Docker, the player can use `http://host.docker.internal:11434` (the bundled `docker-compose.yml` maps that name on Linux); in the same Compose file, the service's name (`http://ollama:11434`).
4. Set `OLLAMA_URL` (and `OLLAMA_MODEL`) on the player's container, and restart it.

**Settings › AI** in the app then shows **This player's model**: the model's name, whether it's ready (and in memory, or loading), and a test button. Nothing else about the AI server is shown, to anyone.

### Who can use the shared model

Browsers only ever talk to the player's own address, so this works from anywhere the player does, and Ollama needs no other setup. Requests go through the container's service, which checks each one:

- **One model: yours.** The player uses the model in `OLLAMA_MODEL` (or, if it isn't set, the first one installed), whatever a request asks for. Nobody can choose another in the app, or see anything else about the AI server: not its address, its other models or its settings. Each device can still turn AI features off, or use an Ollama of its own instead (see below).
- **People with access to your Plex server** (`OLLAMA_AUTH=plex`, the default). Every request is checked with plex.tv. With `PLEX_SERVER_URL` set, Plex accounts that can use that server get through: you, and the friends you share it with. Without it, any signed-in Plex account is accepted, so set it if the player can be reached from the internet. Anyone refused is told why in the app, and that they can use an Ollama of their own instead.
- **Only chats** are passed on, with just the fields the app uses, each checked. The AI server's other models, its version and its settings can't be reached through the player, and nothing can be downloaded, changed or deleted.
- **Rate-limited** per person and per address, and the browser's Plex token, cookies and origin aren't passed to Ollama. The container decides how much memory the model takes (how much context, and that it stays loaded for 15 minutes), not the request, and what Ollama says when something goes wrong goes to the container's log rather than the app, as it can say where the AI server is and what's on it. Closing the page or pressing **Stop** stops the model too.

## Your own Ollama, on one device

Any device can use an Ollama of its own: in **Settings › AI**, choose **My own Ollama server**, enter its address, such as `http://localhost:11434` for Ollama on the same computer (and an API key, if it's behind a proxy that asks for one), then choose one of its models. That's for anyone the player's shared model isn't for (someone signed in to a Plex server of their own, say), for whoever would rather use theirs, and for every device on a player without a shared model.

The browser connects to it directly, never through the player, so it adds nothing to the player's own AI server, and its address and key stay on that device (signing out clears them). Ollama has to allow the player's address: set `OLLAMA_ORIGINS` to it where Ollama runs (the settings page shows the exact value; see [Ollama's FAQ](https://docs.ollama.com/faq)), and restart Ollama. **This player's model**, in the same place, goes back to the shared one.

If the player is served over HTTPS, browsers block plain `http://` addresses other than `localhost`: use an HTTPS address, or the shared setup.

## Missing tracks

Turn on **Settings › AI › Show missing tracks** (it's off to begin with), and under each AI playlist is a list of the songs and artists the model suggested that your library doesn't have, or a line saying they're all there. They're collected in **Settings › AI › Missing tracks**, with how often each was suggested and for what. Download them as a spreadsheet (CSV), copy or share them, so whoever looks after the server can go and find them: that has each one's artist and title, its library, and how often and when it was suggested, but not what anyone asked for, or whose it is. Playlists brought over from Spotify put the tracks they had that the library doesn't on the same list, saying which Spotify playlist each was in (see [features.md](features.md#from-spotify)); MusicBrainz isn't asked about those, as they're real songs. Each server keeps the latest 500 that AI playlists suggested, and apart from those, the latest 1,000 from Spotify, so one can't push the other out.

- Each Plex server has a list of its own: the page shows the one for the server in use.
- **Check again**, after adding music, takes off what's in the library now.
- **Check on MusicBrainz**, with MusicBrainz set up (see below), looks up those of yours listed before they were checked, and takes off what MusicBrainz doesn't know (most likely made up) and albums taken for songs, with Undo. Those it knows are marked **On MusicBrainz**. (A friend's are checked on their devices, as they choose.)

### On every device, and for the server's owner

The player keeps each Plex account's list (in `/data`; `SYNC_MISSING_TRACKS`, on unless it's turned off), so every browser it signs in on has the same one, and the Plex server's owner sees everyone's. What's added or taken off on one device is on the others when they next look (as the app opens, when it's shown again, every few minutes while it's on screen, and when Missing tracks is opened). A change made offline goes once the player can be reached. The first time a browser that had a list of its own (before 0.24.0, say) meets its account's, the two are put together. What anyone asks an AI for, and their Spotify playlists' names, never leave the device they asked on: another device shows the rest ("suggested 3 times, last yesterday"). A Spotify one's playlists are counted by a short hash of each one's name, never the name itself, so a playlist imported twice counts once (the hash is too short to tell what a name was: now and then, two playlists count as one).

**The owner of the Plex server** (plex.tv says who that is) sees everyone's on the same list, so they can see what's missing from their server and add it: what their friends' Spotify imports and AI playlists didn't find on it, saying whose it is (by their names as the owner's Plex friends) and how often in all, but never what they asked for or what their playlists are called. Taking one off, **Clear the list** and **Check again** then change everyone's list, friends' too. **Check on MusicBrainz** checks the owner's own: a friend's are checked on their devices, as they choose.

**A friend's list is kept for their account too**, from 0.25.0 without them having to turn anything on: a Spotify import's missing tracks are a big part of what the server's owner needs to know. Their Missing tracks page, Show missing tracks and an import's **Put what isn't here on Missing tracks** say that whoever runs the server sees them. The list a friend's browser had before (on that device only, before 0.25.0) goes to their account the first time it meets it. Other friends never see anyone's but their own.

A friend who can no longer use the server can't take theirs off from their device (the player no longer answers them for it): the server's owner's **Clear the list** does, or whoever runs the player can delete `/data/missing.json`.

Without the container's service, or with `SYNC_MISSING_TRACKS=false`, each list is kept in the browser on that device only (as before 0.24.0), and the server's owner sees only their own. Either way, signing out clears it from that device; the account's stays with the player. If the player has no room for more (it keeps up to 100,000 in all, and an account's lists for up to 10 servers), a list it can't keep stays on the device, and the page says so.

## Checking suggestions on MusicBrainz

[MusicBrainz](https://musicbrainz.org), the open music encyclopedia, knows which songs and artists are real. Set `MUSICBRAINZ_URL` on the container, and an AI playlist (with Show missing tracks on) looks up what it suggested that your library doesn't have there before listing it: what MusicBrainz doesn't know, and albums taken for songs, are left out, and **Not in your library**, under the playlist, says which and why. Each device can turn this off: **Settings › AI › Check suggestions on MusicBrainz**.

- **musicbrainz.org** (`MUSICBRAINZ_URL=https://musicbrainz.org`; `docker-compose.yml` has it, commented out): no account or API key is needed. The container asks about one name a second at most, MusicBrainz's rule, so checking a playlist's suggestions takes a few seconds, sometimes half a minute. Answers are kept for a week.
- **Your own MusicBrainz**, so nothing leaves your network: a mirror made with [MusicBrainz Docker](https://github.com/metabrainz/musicbrainz-docker), at its address (port 5000 by default), such as `MUSICBRAINZ_URL=http://192.168.1.30:5000`. It needs its search indexes, which by MusicBrainz Docker's own guide take about 16 GB of memory and 350 GB of disk.

Only the names go (artists, and songs' titles with their artist), from the container rather than your browser: no token, nothing about you or the rest of your library (see [SECURITY.md](../SECURITY.md#musicbrainz-checks)).
