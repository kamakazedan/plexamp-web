# Changelog

What changed in each version of plexamp-web, newest first. The version
you're running is shown in **Settings › About**.

## 0.5.0 - 2026-10-15

### Added

- **Crossfade** in Settings › Playback, like Plexamp's sweet fades. **Smart**
  (the default) fades into the next track where the music actually ends,
  found from your server's loudness analysis, so silence at the end of a
  track, or before the next one's music starts, no longer leaves a gap.
  Tracks that follow each other on an album play gaplessly instead.
  **Always** fades between every track, at the very end of each one. The
  length can be set from 2 to 12 seconds (5 by default). As in Plexamp, the
  next track takes over once the fade is done, so its time starts a few
  seconds in. Pausing during a fade pauses both tracks; Next goes straight
  to the next one. Safari on iPhone and iPad doesn't let pages fade audio,
  so there tracks change where the music ends, without a fade.
- **Shuffle** button next to Play on album, playlist, collection and mix
  cards, so there's no need to open them to shuffle.
- This changelog, linked from Settings › About.

### Changed

- **Back stays within the tab you're in.** Each tab keeps its own history:
  Back (the page's arrow, the browser's or Android's) goes to the previous
  page in that tab, and switching tabs returns to where you left each one.
  Back from a tab's first page goes to Home. Tapping the tab you're in goes
  back to its first page.
- The Play button on cards sits in the middle of the artwork, with Shuffle
  beside it.
- Gapless playback starts the next track a moment before the current one
  ends, timed precisely instead of waiting for the browser to report the
  end, which closes the short gap that was still there between tracks.
- Artwork can be kept by the browser for a day, so pages you go back to
  show their pictures without fetching them again.

### Fixed

- **High memory use** after browsing for a while (one report: 6 GB in
  Firefox). Found and fixed:
  - Leaving a long list (all tracks, a big playlist) while its next part was
    loading made it load the rest of the library in the background, into a
    page nobody was looking at. It now stops.
  - Long lists keep artwork only for what's near the screen and load it
    again as you scroll back, so scrolling through thousands of albums
    doesn't keep thousands of pictures in memory.
  - Recent pages are kept so Back is instant. They now let go of their
    pictures while you're elsewhere, pages you can no longer go back to are
    let go, and beyond the last few, kept pages are limited in size.
  - The play queue (up to 1,500 tracks) was saved every five seconds while
    playing; now only the position is, and the queue when it changes.
  - Details the app looks up from your server (a Guest DJ looks up a lot)
    are kept up to a limit.
  - Converted streams keep 30 seconds of what's already played, not all of it.
  - The "playing" bars in track lists animate without laying the page out
    again on every frame, and are only added to the row that's playing.

## 0.4.0 - 2026-10-15

### Added

- **Play Together**: invite Plex friends and listen in sync (play, pause,
  seek, skip and track changes), with one shared queue anyone in the session
  can add to or remove from. A small service in the container keeps each
  session; players long-poll over plain HTTP, so it works without
  WebSockets.
- **Settings › Experience**, modelled on Plexamp: Appearance, Player and
  Home screen pages, grid and font size, rating system, codec and
  popular-track badges, preview buttons, library scope for search and
  playlists, 1-tap playback, desktop integration and the player's name.
- **Home screen editor** for each library: drag sections into order, show or
  hide them, and choose time periods. New sections include **Collections**
  and **Stations**.
- **Debug mode** (`DEBUG=true`): start-up settings and connection checks, a
  redacted access log, proxy errors and problems from browsers, all in the
  container log.
- A disclaimer and a security report in the README.

### Fixed

- Security review: no tokens in the container log, the `/pms/` proxy
  refuses requests without a token and protects servers that let the
  container's network in without signing in, hls.js is bundled and pinned,
  links can only open library listings, server colours and artwork
  addresses are checked, secrets are cleared on sign-out and hidden in
  start-up messages. Details in the README's security report.

## 0.3.0 - 2026-10-15

### Added

- **Live updates**: new music, playlist changes and ratings from other Plex
  apps appear without reloading. A WebSocket is tried first, then Plex's
  event stream, then a check every minute; networks that block WebSockets
  are remembered.
- `DISABLE_WEBSOCKETS=true` for the container, or **Without WebSockets** for
  one device in Settings › Connection, which also shows the route in use.
- **AI playlists** with [Ollama](https://ollama.com): describe a playlist and
  a model builds it from your library, to play, shuffle or save to Plex.
- **Guest DJ** in Now Playing: six rule-based DJs, and an AI DJ that picks
  each next track and introduces it.
- A shared model for everyone (`OLLAMA_URL`, `OLLAMA_MODEL`,
  `OLLAMA_API_KEY`, `OLLAMA_AUTH`) through the container, or each device's
  own Ollama in Settings › AI.

### Fixed

- A late-starting Ollama no longer stops nginx from starting, and the
  container starts on hosts with IPv6 turned off.

## 0.2.0 - 2026-10-15

### Changed

- **Now Playing** follows the Plexamp layout: a grab handle to close, large
  rounded artwork, a waveform seek bar drawn from Plex's loudness analysis,
  format, rating and sample rate in one row, and a toolbar with Up next,
  similar tracks, shuffle, repeat and a new sleep timer. Up next slides over
  the player on phones and sits beside it on desktop.
- Ratings save to Plex.

## 0.1.0 - 2026-10-15

### Added

- The first version: a Plexamp-style web player for Plex music libraries.
- Sign in with Plex, or with a server address and token; servers are found
  and the best connection (local, remote or relay) is picked, with automatic
  reconnects.
- Home, Library, Search and Settings, with album, artist, playlist,
  collection, genre and top-list pages.
- A player with a queue, shuffle and repeat, gapless playback, conversion by
  the server for formats the browser can't play, lock-screen and media-key
  controls, and play reporting to Plex.
- Album-colour backgrounds from Plex's artwork colours.
- A small container (nginx) with an optional proxy to your Plex server
  (`PLEX_SERVER_URL`), a Compose file, and images built for amd64 and arm64.
