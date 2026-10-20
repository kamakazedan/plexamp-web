# Changelog

What changed in each version of plexamp-web, newest first. The version
you're running is shown in **Settings › About**.

## 0.10.0 - 2026-10-20

### Added

- **Appears in.** Every track's menu (in a list, Up next or Now Playing) has
  Appears in…, which shows the playlists the track is in (and how many times,
  if more than once) and the collections it's in, its album's or its
  artist's included. Each opens with a tap. Plex can't be asked this, so
  your playlists and collections are read, then kept until they change, so
  looking again is quick. Very long smart playlists (a whole library) are
  skipped, and the page says so.
- **Sorting playlists and collections.** Unlocked for editing, a playlist has
  Sort: by artist (each artist's albums by year, in track order), track
  name, album or year, or reversed. A collection sorts the same way, as fits
  what it holds (albums by artist, album name or year; artists by name). The
  new order is saved to Plex with as few moves as possible, with progress, a
  Stop button and Undo.
- **Missing tracks from AI playlists.** With Settings › AI › Show missing
  tracks on, an AI playlist lists the songs and artists it suggested that
  your library doesn't have, and Settings › AI › Missing tracks collects
  them (how often, and for what), to download as a spreadsheet (CSV), copy
  or share. Check again takes off what's in the library now. Kept on the
  device.
- **Proxmox VE install with one command**, in the manner of the community
  helper scripts: it makes an unprivileged Debian container and installs the
  player in it (no Docker). Default settings with one key, or each one
  chosen; `plexamp-web-settings` and `update-plexamp-web` in the container.
  It installs from the `stable` branch, which CI moves to each commit that
  passed every test.
- Images are also tagged with their version (`ghcr.io/kamakazedan/plexamp-web:0.10.0`).

### Changed

- Moving tracks in a playlist or collection doesn't download Plex's answer,
  which can be the whole list.

## 0.9.1 - 2026-10-17

### Added

- **Search tags.** Press Enter (or +) and the word you typed becomes a tag
  above the search; what you type next only finds things that match every
  tag, in their name, artist, album or year. "prodigy", then "fire", finds
  The Prodigy's tracks with "fire" in them. Tap a tag to take it off;
  Backspace in an empty search takes off the last one; × clears it all.
- An AI playlist made while you're elsewhere in the app says when it's
  ready, with a button to open it.

### Changed

- **AI features show only where they can be used.** With AI turned off in
  Settings › AI (or no AI model, or a Plex account the shared model isn't
  for), the AI playlist row in Search, the AI DJ and the AI playlist page
  are gone, rather than saying they aren't available.
- **Recent searches are gone** from Search, and what they kept on each
  device is deleted.
- Settings › Experience › Player: **Show codec** and **Show rating** are
  separate settings.
- **Search all music libraries** and **Playlists from all music libraries**
  (renamed) say which libraries they mean, and only show when the server has
  more than one music library. Film and TV playlists were never shown.
- Play Together says that friends need access to the music library, shared
  with them in Plex, as well as signing in.

### Fixed

- **An AI playlist that looked stuck.** Made while you were on another tab,
  it was ready, but going back to its page showed it still being made. It
  now shows the playlist (or what went wrong), and any AI playlist page
  shows one being made.
- Genre, style, mood and decade lists finish counting, and library lists
  finish naming their filters, while you're on another page.

## 0.9.0 - 2026-10-17

### Added

- **Search within library lists.** Every list in the library (a genre, a
  decade, all albums, all artists) has a search box: in the 1990s, type
  "rock" to narrow it to rock albums from the 1990s, then "calm" for a
  mood, or words from the title. Only choices that leave something are
  offered, each with how many. The filters show as chips above the list;
  tap one to take it off.
- **A clear button for search**, as soon as there's something typed.
  Escape clears it too.
- **AI playlists: Add to queue**, and **Save to Plex** asks where: a new
  playlist (named after it), one of yours, or, for the server's owner, a
  collection.
- **Play next and Add to queue** in the menus of playlists, collections
  and artists (where mixes lead).
- Genres, styles, moods and decades say how many albums (or artists) each
  has.

### Changed

- **The shared AI model is the one you set.** With `OLLAMA_URL` set, the
  app uses only the model in `OLLAMA_MODEL` (or, if it isn't set, the first
  one installed), whatever a request asks for. Settings › AI shows its
  name, whether it's ready and a test, and turns AI on or off for the
  device; there's no list of the AI server's models, and no other servers.
  Requests now go through the container's service, which passes on chats
  only: the AI server's version and models are no longer reachable at
  `/ollama/`.
- **AI playlists keep to what you ask for.** Every request asks the model
  to stay with the artists, era, genre or mood you name, and to be creative
  within that, and the app checks. "Best of The Prodigy" is built only from
  The Prodigy's tracks, best known first, and is shorter rather than padded
  with other artists when they don't have enough. "Music like The Prodigy"
  is mostly them. An era you name holds for artists' tracks too.
- **Play Together:** Copy link, Leave and End for everyone are next to
  Invite friends, rather than at the bottom of the page.

### Fixed

- **Genres with nothing in them.** Many genres opened to "0 albums,
  Nothing here". The app followed the address Plex gives each genre, which
  can lead to artists rather than albums; it now asks for albums itself.
  Genres nothing in the library uses any more are left out.
- **When someone can't use the shared AI model, they're told why**: the
  AI playlist page says so before they try (for example, that the model is
  for people who can use the player's Plex server), and the container log
  notes the refusal. Before, it said to sign in again.

## 0.8.0 - 2026-10-16

### Added

- **Your devices share what's playing.** Signed in to the same Plex account
  and playing from the same server, your devices act like one session. Open
  the player on your phone while your computer plays, and the phone shows
  what's playing, where it's got to and Up next, with its own sound off: a
  muted speaker, and "Playing on …" where the artist was. Play, pause,
  skip, seek, volume, shuffle, repeat, changes to Up next and playing new
  music all happen on the device that's playing. **Listen here** (the muted
  speaker, or the button under the artwork) moves the music to that device
  from the same spot, and the one that was playing goes quiet and follows.
  Close the player where it was playing, or leave it paused for 10 minutes,
  and another device carries on from there. On by default: Settings ›
  Playback › Share playback with your devices turns it off for a device,
  which then plays on its own, so two devices can play at once. See
  [Your devices](README.md#your-devices) in the README.

### Fixed

- **Playlist pictures.** A picture set for a playlist in Plex didn't show
  (since 0.1.0): the app always used the mosaic Plex makes from the
  playlist's tracks. It now shows your picture wherever the playlist
  appears, and the mosaic for playlists without one.

### Changed

- In track lists, a track's rating is now to the left of its length.

## 0.7.0 - 2026-10-16

### Added

- **A Playlists tab**, in place of Library: all your music playlists, with
  ❤️ Tracks first.
- **Browsing the library from Search**: artists, albums, tracks,
  compilations, soundtracks, collections, genres, styles, moods and decades,
  as tiles with their counts, above Most played and Explore.
- **Ratings in track lists**: with a rating system on (Settings ›
  Experience), every track in an album, playlist, collection, artist page,
  search result or list can be rated right there: tap a star (tap it again
  to clear it), or thumbs up or down. They match the player's rating. On
  narrow phones a track's time makes way for them. Settings › Experience ›
  Ratings in track lists turns them off.
- **❤️ Tracks**: tracks you give five stars or a thumbs up go in your
  ❤️ Tracks playlist, and come out if they lose that rating, as in
  Plexamp. If there isn't one, it's made. If yours is Plexamp's own (a
  smart playlist), Plex keeps it up to date from your ratings itself.
  Settings › Experience › Keep ❤️ Tracks up to date.
- **A reminder about the lock**: a playlist (and, for the server's owner, a
  collection) points out its lock until you've used it, and a track's menu
  there has **Edit playlist**, which unlocks it.

### Fixed

- **Local connections.** With an `https://` `PLEX_SERVER_URL` (for a
  server that requires secure connections), the container couldn't check
  the server: Plex's certificate is for its `plex.direct` name, not its
  address (`ERR_TLS_CERT_ALTNAME_INVALID` in the log). It now accepts a
  valid Plex certificate there, so sign-in checks for the shared AI model
  and Play on work. A self-signed certificate is still refused, and the
  log says why.
- When the browser can't use the server's local address (often because the
  router won't look up `plex.direct` addresses that point into the home
  network, or Plex runs in Docker), the app went out through the internet
  or Plex's relay, even with `PLEX_SERVER_URL` set. It now goes through the
  container's proxy, which reaches the server on your network, before a
  remote address, and moves to it by itself if it was using a remote
  address or the relay.
- Debug mode's start-up checks no longer say an `https://` Plex server
  can't be reached, or that plex.tv answered "HTTP 400".

### Changed

- Smart crossfade says, in Settings › Playback and the README, that it
  needs Plex's loudness analysis (Settings › Library › Analyze audio tracks
  for loudness, in Plex). Sonic analysis isn't needed for it.

## 0.6.0 - 2026-10-16

### Added

- **Edit playlists**, with a lock so nothing changes by accident. Playlists
  open locked, as before. Tap the padlock at the top to unlock one: drag
  tracks by their handles to reorder them, or take them out with the −
  button, and Undo puts a track back. Unlocked, a track's menu also has
  **Move to top** and **Move to bottom**, and the playlist's menu has
  **Rename** and **Delete**. Every change is saved to Plex straight away.
  Taking a track out of a playlist leaves it in your library. **Done**, or
  leaving the page, locks the playlist again. Smart playlists follow their
  rules in Plex, so they can't be edited.
- **Add to playlist…** on tracks, albums, artists, playlists and
  collections, and **Save as a playlist…** in the ⋯ menu next to Up next.
  **New playlist…** at the top of the list makes one. Tracks already in the
  playlist aren't added again.
- **Edit collections, for the server's admin**: the same lock and editing as
  playlists, and **Add to collection…** on tracks, albums, artists,
  playlists and Up next. Collections belong to the library, which everyone
  you share it with sees, so only the server's owner gets these options.
  For everyone else collections stay play-only. A collection holds one kind
  of item (artists, albums or tracks), so you're offered collections of the
  matching kind, and adding a playlist or the queue adds its tracks.
- **Move to top** in the menu of a track in Up next, so it plays next.
- **Play on**: the cast button next to Repeat (and in the desktop player
  bar) plays on another Plex player on your network, such as Plexamp on a
  Raspberry Pi, with this app as its remote. Play, pause, skip, seek,
  volume and changes to Up next go to that player, and the app follows what
  it plays, even after a reload. **This device** brings the music back,
  from where it got to. It's for players signed in to your own Plex
  account; with `PLEX_SERVER_URL` set, it's for the server's owner. Set
  `CASTING=false` to turn it off.
- **AirPlay or Cast…** in the same list, where the browser has its own
  speaker picker (AirPlay in Safari, Google Cast in Chrome on Android).
- **Volume**: a percentage shows while you drag the slider, with marks at
  25, 50 and 75% that it settles on, and the speaker icon loses a wave
  below 75, 50 and 25%, as in Plexamp.
- A menu on artist pages: play, shuffle, artist radio, add to a playlist.

Alexa speakers can't be added to Play on: Amazon only lets its approved
music services play on them, so no app can, Plexamp included. Pairing the
speaker with your phone or computer over Bluetooth works, and the Play on
list says so.

### Changed

- **Security**: if your Plex server lets this container in without signing
  in (Plex's "List of IP addresses and networks that are allowed without
  auth"), only the server's owner now gets through the `/pms/` proxy. Plex
  accepts any token from such a network and can treat its requests as the
  owner's, so friends using the proxy could have seen the owner's view of
  the server and made changes (a new playlist, say) as the owner. The
  container's log says how to fix the Plex setting, after which friends get
  through again.

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
