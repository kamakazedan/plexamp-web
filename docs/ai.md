# AI playlists and the AI DJ

- [What they do](#what-they-do)
- [Setting up a shared model](#setting-up-a-shared-model)
- [Your own Ollama, on one device](#your-own-ollama-on-one-device)
- [Missing tracks](#missing-tracks)
- [Checking suggestions on MusicBrainz](#checking-suggestions-on-musicbrainz)

Both use a model on your own hardware, through [Ollama](https://ollama.com). Nothing goes to a cloud service.

## What they do

- **AI playlists**: describe what you want to hear ("best of The Prodigy", "rainy Sunday jazz"), and the model builds a playlist from your library. Play it, queue it, or save it to Plex (for the server's owner, as a collection too).
- **Only music you have**: the model picks genres, artists and songs from your library's own tags, the app finds the tracks on your server, and the model chooses and orders them. Made-up songs and album titles taken for songs are left out.
- **The AI DJ** (one of the [Guest DJs](features.md#guest-dj)) picks each next track and says why: never the artist playing, from artists who sound like it or are in the same genre.
- **Notes for the AI**, in **Settings › AI**, go with every request ("I love 90s trip-hop; skip live recordings").
- **Waiting for the model**: a model can take minutes to load after Ollama starts. The app waits up to 5 minutes (**Settings › AI › Wait for the model**: 2 to 30), and says while it's loading.

A good model to start with: an instruction-tuned one of about 7 to 9 billion parameters, such as `llama3.1:8b` or `qwen2.5:7b`.

## Setting up a shared model

1. Install Ollama: [ollama.com/download](https://ollama.com/download), or [its Docker image](https://docs.ollama.com/docker).
2. Download a model: `ollama pull llama3.1:8b` (in Docker: `docker exec -it ollama ollama pull llama3.1:8b`).
3. Let the player reach it. Ollama only listens on its own machine to begin with: set `OLLAMA_HOST=0.0.0.0` where it runs ([Ollama's FAQ](https://docs.ollama.com/faq)).
4. Set `OLLAMA_URL` (and `OLLAMA_MODEL`) on the player, and restart it.

Which address to use:

| Where Ollama runs | `OLLAMA_URL` |
| --- | --- |
| Another machine | `http://192.168.1.20:11434` |
| The same machine as Docker | `http://host.docker.internal:11434` (`docker-compose.yml` makes this name work) |
| The same Compose file, as a service called `ollama` | `http://ollama:11434` |

**Settings › AI** then shows **This player's model**: its name, whether it's ready, and a test button.

### Who can use the shared model

Browsers only talk to the player, which checks each request:

- **One model**: the one in `OLLAMA_MODEL`, whatever's asked for. Nobody can see the AI server's address, its other models or its settings.
- **Who**: with `OLLAMA_AUTH=plex` (the default), people signed in with Plex. With `PLEX_SERVER_URL` set, only those who can use your server: set it if the player can be reached from the internet.
- **Only chats** go to Ollama, with just the fields the app uses. Nothing can be downloaded, changed or deleted on it.
- **Limited** per person and per address. The player decides how much memory the model takes, and keeps it loaded for 15 minutes.
- Closing the page, or **Stop**, stops the model too.

## Your own Ollama, on one device

Any device can use an Ollama of its own, for anyone the shared model isn't for, or who'd rather use theirs:

1. In **Settings › AI**, choose **My own Ollama server**.
2. Enter its address, such as `http://localhost:11434` for Ollama on the same computer (and an API key, if it's behind a proxy that asks for one).
3. Choose one of its models.

- The browser talks to it directly, never through the player. Its address and key stay on that device.
- **Ollama must allow the player's address**: set `OLLAMA_ORIGINS` to it where Ollama runs, and restart Ollama. **How to allow this site**, under the address, has the exact commands for Windows, Mac and Linux.
- A player served over HTTPS can't reach plain `http://` addresses other than `localhost`: use an HTTPS address for Ollama, or the shared model.

## Missing tracks

Turn on **Settings › AI › Show missing tracks** (off to begin with), and each AI playlist lists the songs it suggested that your library doesn't have.

- **Settings › AI › Missing tracks** collects them all, with how often each was suggested. Download them as a spreadsheet (CSV), copy or share them.
- **Spotify imports** put what they didn't find there too, with the Spotify playlist each was in.
- **Check again**, after adding music, takes off what's in the library now.
- **Check on MusicBrainz** (with MusicBrainz set up) takes off what MusicBrainz doesn't know (likely made up), with Undo.
- **Kept**: the latest 500 from AI playlists and, apart from those, 1,000 from Spotify, for each Plex server.

### On every device, and for the server's owner

- **Your list follows your Plex account** to every browser (`SYNC_MISSING_TRACKS`, on to begin with).
- **The server's owner sees everyone's**, so they know what's missing from their server: each track, whose it is and how often, but never what anyone asked for or their Spotify playlists' names. Friends' pages say so.
- **What's asked for** an AI playlist, and Spotify playlists' names, never leave the device they were on.
- **Off** (`SYNC_MISSING_TRACKS=false`, or without the player's service): each browser keeps its own list, and the owner sees only theirs.
- A friend who can no longer use the server can't clear theirs: the owner's **Clear the list** can, or delete `/data/missing.json`.

## Checking suggestions on MusicBrainz

[MusicBrainz](https://musicbrainz.org) knows which songs and artists are real. Set `MUSICBRAINZ_URL`, and an AI playlist (with Show missing tracks on) checks what it suggested that you don't have: what MusicBrainz doesn't know, and album titles taken for songs, are left out. Each device can turn this off in **Settings › AI › Check suggestions on MusicBrainz**.

| `MUSICBRAINZ_URL` | |
| --- | --- |
| `https://musicbrainz.org` | No account needed. One name a second at most (its rule), so a check takes a few seconds. Answers are kept a week. |
| `http://192.168.1.30:5000` | Your own mirror ([MusicBrainz Docker](https://github.com/metabrainz/musicbrainz-docker), port 5000), so nothing leaves your network. It needs its search indexes: about 16 GB of memory and 350 GB of disk, by its own guide. |

Only names go (artists, and songs' titles with their artist), from the player, never from your browser: no sign-in, and nothing else about you or your library.
