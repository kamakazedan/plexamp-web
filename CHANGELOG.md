# Changelog

What changed in each version of plexamp-web, newest first. The version
you're running is shown in **Settings › About**.

## 0.24.0 - 2026-10-28

### New

- **Missing tracks follow your Plex account.** The player can keep each
  account's list for each Plex server (in `/data`), so every browser it
  signs in on has the same one: what's added or taken off on one is on
  the others when they next look (as the app opens or is shown again,
  every few minutes while it's on screen, and when Missing tracks is
  opened). A change made offline goes once the player can be reached.
  The first time a browser that had a list of its own meets the
  account's, the two are put together. What anyone asks an AI for, and
  their Spotify playlists' names, never leave the device they asked on:
  another device shows the rest (a Spotify one's playlists are counted
  by a short hash of each name).
- **The server's owner sees everyone's who keeps theirs.** Signed in as
  the owner of the Plex server (plex.tv says who that is), your list is
  kept for your account as you use it, and Missing tracks has your
  friends' that are kept for theirs too: what their AI playlists and
  Spotify imports didn't find, whose each is (their names as your Plex
  friends) and how often in all, never what they asked for or what their
  playlists are called. Taking one off, Clear the list and Check again
  change everyone's list then, friends' too; Check on MusicBrainz checks
  your own. The spreadsheet has them all, without whose.
- **A friend's stays on their device until they choose**: **Keep them
  for your Plex account**, on Missing tracks and under Settings › AI ›
  Show missing tracks, says that whoever runs the server (and the
  player) can see them then. Nothing of their list goes to the player
  before. Turned off, theirs is taken off the player, and each of their
  devices keeps its own. Friends never see anyone's but their own.
- `SYNC_MISSING_TRACKS=false` keeps each browser's list its own, as
  before.

### Changed

- Under an AI playlist, Not in your library says where its missing
  tracks are kept, when that's for your account; so do Show missing
  tracks and an import's Put what isn't here on Missing tracks.
- Signing out says Missing tracks kept for your account stay with it.
- Tests: the missingsync section (two browsers of one account, a friend
  before and after they keep theirs for their account, the owner,
  offline, signing out and in over someone), unit tests for the lists the
  service keeps, and the container's.

## 0.23.0 - 2026-10-27

### New

- **Each album's format over its cover**, as you browse (an artist's
  albums, the album lists, Home, collections), as on its page: FLAC 24/96
  in gold for high resolution, FLAC 16/44.1, MP3, or Mixed for an album
  of several formats, so an album and its hi-res edition can be told
  apart. Albums in search have theirs before the artist, as tracks do.
  Your server is asked about each album once it's been in view for a
  moment (not what's scrolled past), a few at a time, and what it says
  is kept while the app's open (for an hour, or until a scan of the
  library ends). **Settings › Experience › Show codec badges on covers**
  turns them off.
- **A menu on every album, playlist and collection cover**: the ⋯ in the
  corner of its artwork (with the play buttons, when the pointer's over
  it), or a long press on a touch screen. Albums in search have a ⋯ too.
  An album's has Play next, Add to queue, Add to playlist…, Select, and
  Go to album or artist.
- **Choose several tracks or albums at once**, and play them, queue them
  (next, or at the end) or add them to a playlist together: **Select**
  in a track's or album's menu, or on a computer Ctrl-click (⌘-click on
  a Mac) or Shift-click (on a cover, instead of opening it in a new tab
  or window). While choosing, a tap chooses or lets go, Shift-click
  chooses everything from the one chosen last, and Ctrl+A or Select all
  everything loaded in that list. What's chosen stays chosen as you
  search again, sort the list another way or take a filter off, so songs
  from several searches can go into one playlist. Albums go in by their
  tracks: those on the page in the order they're shown, the rest in the
  order they were chosen. The server's admin can add them to a
  collection too (of one kind). Doing one of those lets go of what it
  was done with, once it's in; ✕, Esc or another page stops. Not Up
  next's own tracks, nor an unlocked playlist's.

### Changed

- **Now Playing shows the file's format as a badge**, as album pages do
  (FLAC 16/44.1, gold for high resolution; MP3 320), with the rating to
  its right. Converted as it plays, the badge is dimmed, with the
  bitrate it plays at after it.
- An album's Play next and Add to queue say how many tracks went in, as
  a playlist's do.
- Fixed: Play next or Add to queue in a Play Together session (a whole
  playlist, artist or collection) said up to 1,000 tracks went in. 500
  do, the most a session takes at once, and it says so.

## 0.22.0 - 2026-10-27

### New

- **Your Spotify playlists, from Spotify's download of your data**
  (Search › From Spotify): all your playlists, however long, and
  your Liked Songs, with a free Spotify account. Off unless it's turned
  on with `SPOTIFY_FILE_IMPORT=true` on the container, for now, while
  it's tried with real downloads from Spotify. Spotify only lets other
  apps read your playlists through its developer programme (Premium, and
  five people at most), so the app walks you through asking Spotify for
  your data instead, and choosing just its playlist files:
  `Playlist1.json` (and `Playlist2.json` and so on) and
  `YourLibrary.json`. Only files with those names are opened, in the
  browser; any other, the ZIP included, is turned away unread, as the
  rest of the download is your personal details. Of them, only playlist
  names and each track's title, artist and album are kept. You choose
  which playlists to make (the files can be dropped on the guide, too);
  those found in your library make them, and what isn't goes on Missing
  tracks, as before.
- **Each way of importing from Spotify has its own setting, and each is
  off unless it's turned on**: `SPOTIFY_FILE_IMPORT` for the download of
  your data, and `SPOTIFY_LINK_IMPORT` for one public playlist straight
  away from its link (its first 100 tracks), as `SPOTIFY_IMPORT` did,
  which still works (`SPOTIFY_LINK_IMPORT`, when set, wins). With both
  on, the link is **Use a link instead**; with the link alone, From
  Spotify goes straight to it, as before.

### Changed

- **The `/pms/` proxy's sign-in check is given only each request's
  token** (with `PLEX_SERVER_URL`): it was given the whole address, with
  what's searched for in it, which the service never used or kept, but
  needn't have had.
- **Missing tracks keeps the latest 500 that AI playlists suggested, and
  apart from those the latest 1,000 from Spotify, for each server**, so
  a big Spotify import can't push the rest out. It was 500 in all. Each
  playlist imported says how many of its are on the list once the rest
  have come in, when there wasn't room for them all: its spreadsheet has
  them all.
- A song from Spotify on Missing tracks counts once for each playlist
  it's in (up to "20+"), however often a playlist is imported: it counted
  each import. One that comes from somewhere else next (from a playlist,
  then an AI's suggestion) is counted afresh from there.
- Fixed: a song on Missing tracks from a Spotify playlist was taken off
  when an AI playlist suggested it too and MusicBrainz didn't know it,
  and one an AI suggested after could then be taken off by Check on
  MusicBrainz. Songs from Spotify are real, and stay so.
- An import's playlist with none of its tracks found (so not made) lists
  them too, to copy or save as a spreadsheet.
- A file dropped on the page by mistake isn't opened in its place, which
  left the player.

## 0.21.1 - 2026-10-26

### Changed

- **Debug mode logs every pause, and what caused it**: the play button,
  the space bar, media keys, a headset or the system's media controls,
  another of your devices (by name), Play Together, the sleep timer, the
  end of the queue, tracks that won't play, or the browser itself (the
  system pausing it, say, with Media keys and lock screen off). The
  service logs which of your devices sends the one that plays a command
  (only what kind: pause, next), and a playing device it stops hearing
  from. A track still waiting for data after 8 seconds is logged as it
  waits, and so is a device losing touch with the service, and getting it
  back. What every open player asks every few seconds (your devices
  waiting for news, the playing one's report, Play Together looking for
  invitations) is left out of the log, unless it goes wrong.
- A pause sent from another of your devices says so on the one that
  plays: "Paused from Firefox on Windows".

### Fixed

- A file played as it is that stops coming part-way, its connection
  held open with nothing more arriving (as through a proxy that's
  stopped passing it on), is loaded again from where it got to after 30
  seconds, once a track. It waited for ever. One that stops as it fades
  out into the next track gives way to it after 3 seconds: the fade
  waited with it.
- Another of your devices takes over once it's playing, not as it starts
  to: a play there that didn't start (the browser wanting a tap first,
  say) stopped the music everywhere.
- A play, pause, skip or seek from another device that took more than
  30 seconds to reach the one playing (out of touch meanwhile) is let go,
  rather than done out of nowhere.
- On big screens, the bar at the top of Settings and the other pages
  kept to a column in the middle goes right across, as on other pages,
  rather than stopping at the column's edges.

## 0.21.0 - 2026-10-23

### New

- **Keep played tracks** (Settings › Playback, 1 to start with, up to
  5): the last tracks played stay in memory, so going back to one plays
  it at once, even with a slow or dropped connection, and so does the one
  gone back from. What was loaded ahead is kept as it is (a file still
  loading when it starts playing goes on loading). A converted track is
  kept as it came in, with no second stream of it; a file that came in as
  it played is read again into memory once the tracks ahead are in, with
  Load ahead on (off, it isn't read twice). The tracks ahead come first:
  those played make room for them, the furthest back first, and one still
  being read waits, part-read, while a track ahead loads. Played again, a
  track is another playback as far as Plex is concerned.
- **Use your own Ollama server even when the player shares a model**
  (Settings › AI › My own Ollama server): for anyone the player's model
  isn't for (someone signed in to a Plex server of their own, say), or
  who'd rather use theirs. The browser talks to it directly, never
  through the player, and its address and key stay on the device.
  Someone the player's model isn't for is told so, and pointed there.
  Nothing about the player's own AI server is shown, as before, but the
  name of its model and whether it's ready.

### Fixed

- **A track no longer stops, now and then, as it starts** (the first one
  played after opening the page, and on taking over from another of your
  devices or joining Play Together), in Chrome, Edge and other browsers
  built on Chromium. The silent sound that warms up the second player
  could stop it, so it's muted now, except in Safari and on iPhones and
  iPads, where it's as before.

## 0.20.0 - 2026-10-23

### New

- **Load ahead goes up to 10 tracks**, each choice saying about how much
  memory it takes (as MP3 and FLAC, or at the bitrate tracks are converted
  to), and it loads the next track to start with. Until the track playing
  has all it needs, loading ahead is held back: small parts, each with a
  rest, so it takes half the connection at most and leaves the track
  playing at least twice its bitrate (on a connection too slow for that,
  a small part every half a minute). Once it's all in, the next tracks
  load as fast as the connection allows. A browser keeps up to 512 MB
  (Chrome and Edge over HTTPS, by how much memory the device has;
  otherwise 384 MB, or 256 MB on a phone or tablet), and none of a track
  once it's played.
- **Loudness levelling is on to start with**: louder tracks turned down to
  match quieter ones, never up, and each device loads the next track
  ahead. Both started off in 0.19.0, so where they're still off from then
  (on a device, or in the settings kept for your account) they're turned
  on, once; turn either off again in Settings › Playback.
- **Searching within a list shows what matches as you type**: "strokes"
  in Artists shows The Strokes, with no "In the name" to choose first. A
  matching genre, style or mood is still offered above it.

### Fixed

- **A track loaded ahead plays from memory, as it is, when you skip to
  it.** Pressing Next (or choosing the next track in Up next) well before
  the change of track, or at any change of track with gapless playback
  and crossfades both off, what was loaded for it was let go just as it
  was about to play, and it played converted by the server instead (a
  converted track, from the network). In 0.19.0 that was only with Load
  ahead turned on.
- **Plex hears that a track stopped when you play something else in its
  place** (an album, a playlist, a mix). 0.19.0 said nothing then, and
  earlier versions said it of the wrong track, so Plex went on showing it
  as playing for a while.
- **Search's library lists no longer jump about as their counts load**:
  each has its place from the start, and the counts are kept in the
  browser (just the numbers, until you sign out), so they show at once
  next time while your server is asked again.
- **What you'd searched for no longer stays in the tab after signing
  out.** It was kept with the browser's own history of the tab too, which
  no page can clear. It's kept only in the tab's own storage now, which
  signing out clears.

## 0.19.0 - 2026-10-22

### New

- **A favourite tick to rate tracks**, as the rating system to start with:
  a ring beside each track and in Now Playing. Ticked (green), a track is
  five stars in Plex and goes in ❤️ Tracks; unticked, it has no rating
  and comes out. Five stars and thumbs are still in Settings › Experience
  › Rating system; half stars are gone. Settings on five stars or half
  stars move to the tick: choose Five stars again there to keep stars.
- **Your settings follow your Plex account**: any browser you sign in on
  with the same player has them, the Home screen too, kept for your
  account by the container (`settings.json` in `/data`; `SYNC_SETTINGS=false`
  turns it off). Streaming quality, connection settings, the player name,
  sharing with your devices, playback speed, Load ahead and your own AI
  server stay each device's own. The first time a browser has them, what
  you'd changed on it stays (and goes to your other devices); a change
  made offline, or as a tab closed, is sent next time, unless it's been
  changed elsewhere since; after someone signs out of a browser, what it
  has never goes to the next account. Settings › Account › On all your
  devices turns it off for your account.
- **One Home screen layout** for every library and server (each library
  had its own): the one for the library you're in carries on.
- **Load ahead** (Settings › Playback, each device's own): the next 1 to 3
  tracks loaded in full, so a dropped or slow connection doesn't stop the
  music at the next track. They load only while the track playing has
  what it needs (waiting whenever it needs more), a part at a time, and
  the browser keeps them only while they're wanted (300 MB at most; not
  saved, nor in its cache).
- **Loudness levelling** (Settings › Playback, off to start with): louder
  tracks turned down to match quieter ones, from your server's loudness
  analysis, to the level Spotify and TIDAL play at. Nothing is turned up,
  so nothing distorts, and no preamp or limiter is needed. Albums played
  in order keep their own ups and downs. Not on iPhone or iPad.
- **Playlist radio**, on a playlist's page and in its menu: some of the
  playlist, mixed with tracks that sound like it (or more from its
  artists), and **Favourites radio** in Home › Stations: the artists in
  ❤️ Tracks, and artists like them.

### Fixed

- **Play Together told Plex the wrong track had stopped** when a session
  changed track (joining it, or anyone skipping): the new track, at the
  old one's position, which Plex could count as a play. The track left is
  now the one, as its own playback.

## 0.18.3 - 2026-10-22

### Fixed

- **Playback cutting out in a track's last 30 seconds** on a slow
  connection (playing from home at work, say), then skipping: that's when
  the next track starts loading, for a crossfade or a gapless change, and
  its download took what the track still playing needed. The next track
  now waits until the one playing has loaded to its end (or has plenty
  buffered), and a converted next track loads only its first seconds
  until it plays.
- **Converted tracks cutting out now and then**: a dropped connection with
  plenty still buffered is now tried again on the same stream up to four
  times, rather than once, before the stream is started again (which is
  heard as a gap). (0.18.1 said converted tracks would buffer a minute
  ahead: for music, hls.js already loads the whole track, or ten minutes
  of it, as it still does.)
- **Changing Streaming quality takes effect straight away.** Switching back
  to Original (say) left the track playing converted, and the next one too
  if it had started loading; a converted stream started again after a
  failure stayed converted. The track playing now carries on from where it
  is, the new way, and so does the next one, from one bitrate to another
  too (High to Data saver, say). A track the server converts because the
  file doesn't play as it is here stays converted, at the new bitrate.
  During a crossfade, the change waits until it's done; while paused,
  until you play again (nothing loads meanwhile).
- **A crossfade into a track that hasn't loaded yet** (on a slow
  connection) no longer fades the track playing out into silence: it plays
  on until the next one sounds (or holds, if the next one stops for data
  part-way), and the fade fits into what's left. With Smart crossfade, a
  converted next track loads far enough to start where its music does.
- A track playing as it is (FLAC, say) whose connection drops is loaded
  again from where it was, once, before the server is asked to convert it
  (then only until Streaming quality is changed).
- With `DEBUG=true`, the container's log says when playback had to wait
  for data part-way through a track: for how long, how much was buffered,
  and whether the next track was loading.

## 0.18.2 - 2026-10-22

### Fixed

Converted tracks, when their stream fails (new in 0.18.1):

- A stream started again that failed again before it played anything
  started the track over from the top. It starts where the track got to.
- A problem decoding the stream (rather than a dropped connection) could
  leave the track silent, with play and pause doing nothing. The stream
  starts again from there instead (or, in the track's last seconds, the
  next track plays). So does a stream that fails before anything has
  loaded, when the track was to start near its end.
- In Play Together, a track this device couldn't play as it is, with the
  session paused, could stop the player working until the page was
  reloaded.
- A track that came in through a gapless change or a crossfade only got
  one try at starting its stream again, not three.
- Moving back in a track whose stream had stopped a few seconds short of
  its end got stuck; it starts again from there, with its tries counted
  afresh (Previous could skip it). Moving in a track while its stream was
  being started again was undone.
- A stream that stopped close to a crossfade could start again in the
  middle of the fade. The track ends where what's buffered does, and the
  fade carries on.
- Play reports for a queue of one track on repeat, or for a converted
  track sent to AirPlay from Safari, could name the wrong playback.

## 0.18.1 - 2026-10-22

### Fixed

- **Tracks the server converts were skipped part-way** ("Can't play …
  Skipping."), on networks that drop a connection now and then (office
  proxies in particular), or when the server stopped the stream: one
  hiccup was enough. Now:
  - the stream's playlist is tried again when the connection drops, or
    the server is slow to start the conversion, rather than given up on
    at once (its parts already were);
  - a stream that stops part-way is started again from where it got to,
    after what's already buffered has played, so you hear at most a moment's
    gap; with plenty still buffered, a dropped connection carries on on
    the same stream, without a gap at all;
  - a stream that stops a few seconds short of the end ends there, and the
    next track plays;
  - a track is only skipped if its stream keeps failing at the same place
    (three times, or twice for one that never started), as before.
- Each track now plays as **its own playback** for the server: its stream
  and its play reports say which (Plex's `X-Plex-Session-Identifier`).
  Every track (and every tab) had the same one, and the next track's
  stream starts while one ends, so a server could take that as the
  playback moving on and stop the stream still playing.
- A converted track buffers a minute ahead (it was 30 seconds), to ride
  out a slow patch.
- With `DEBUG=true`, the container's log says what went wrong in a
  converted stream (which part, and what the server answered) and what
  the player did about it.

## 0.18.0 - 2026-10-21

### Added

- **Search › From Spotify** (with `SPOTIFY_IMPORT=true` on the container,
  off unless you turn it on): paste a Spotify playlist's link, see the
  playlist as Spotify has it (its name, who made it, how many tracks and
  how long), name it, and the tracks your library has make a playlist here
  in the same order. Spotify's extras on a title ("Song - Remastered
  2011", "(feat. …)") and lists of artists don't get in the way of finding
  them. What isn't found is listed, to copy or save, and goes on **Missing
  tracks**, saying which Spotify playlist it was in (unless that's turned
  off for the import). Spotify's API only gives a playlist's tracks to the
  account that owns it, so the container reads the page Spotify shows
  anyone for the playlist: public playlists only, their first 100 tracks
  at most, and only for as long as Spotify keeps that page as it is. Only
  the playlist's id goes to Spotify, from the container (see
  [SECURITY.md](SECURITY.md#spotify-imports)).
- Missing tracks' spreadsheet says where each came from (an AI playlist or
  a Spotify playlist), in a new last column.

## 0.17.1 - 2026-10-21

### Changed

- **No Show all beside a shelf's arrows**: with a mouse, the shelf's title
  opens the whole list (it's underlined as the pointer goes over it), and
  the arrows are all there is on the right.

## 0.17.0 - 2026-10-21

### Fixed

- **Plex servers could only be reached through the container** (with
  `PLEX_SERVER_URL` set), or not at all, since 0.16.0. That includes
  servers shared with you, which the container doesn't reach for you.
  0.16.0 asked each route who it was without your sign-in, and a Plex
  server only lets a web page read its answer when the request carries
  one, so every route looked as if it didn't answer ("Didn't answer this
  browser"). Opening the address in a tab worked, as a tab isn't held to
  that rule. Routes are asked with the server's sign-in again, but only
  where it stays private, as before: `https://` addresses, plain `http://`
  on your home network, and the container. A route still only counts if
  it's your server that answers (see
  [SECURITY.md](SECURITY.md#routes-to-your-server)).
- On artist pages, **Show more** under Popular tracks lines up with the
  tracks.

### Changed

- **Full screen on a computer uses the whole screen.** Pages to browse
  (Home, the library, albums, artists, playlists, search) are no longer
  held to 1500 pixels at the left, and artwork grows with the window on
  big screens, so shelves and grids fill it. Settings, Play Together, the
  AI playlist and Sonic path keep to a column in the middle, as wide as on
  half the screen. Now Playing's artwork is bigger there too, and artist
  pages ask Plex for a photo as big as the banner it fills.
- **The arrows by a shelf's heading scroll the shelf** (with a mouse):
  › moves it on a screenful, so the card that was cut off comes first, ‹
  appears once it has moved and goes back, and neither shows when it all
  fits. The title, or **Show all**, opens the whole list, as the arrow did.
  On a touch screen shelves are swiped and the heading opens the list, as
  before.
- **Proxmox VE: `update-plexamp-web --verbose`** follows the update step
  by step: the installer it downloads, apt's own output, the downloads
  (and the checksum hls.js matched), what goes where, and the services
  restarting with what they logged; a step that fails says which line it
  stopped at. `--help` says how to use it. The `update-plexamp-web` that
  0.16.1 and earlier put in place doesn't know `--verbose` yet, but passes
  `PW_VERBOSE=1` on: `pct exec <ID> -- env PW_VERBOSE=1 update-plexamp-web`.
  The one-line install takes `PW_VERBOSE=1` too (also for what it runs on
  the node), and an update says which version it came from.

## 0.16.1 - 2026-10-21

### Fixed

- **Proxmox VE: `update-plexamp-web` ended with `Syntax error: ")"
  unexpected`** after updating to 0.16.0. The update itself had finished:
  the installer the command runs puts a new copy of the command in place,
  and it did that by changing the file the running command was reading,
  so the shell carried on into the new copy from where the old one ended,
  partway through a comment. Nothing else ran. The installer now puts its
  commands in place without touching the file a running one reads, and
  the command reads all of itself before any of it runs. Updating from
  0.16.0 to this is clean.
- The installer restarts the player once rather than twice (restarting
  its settings already restarted the service).

## 0.16.0 - 2026-10-21

A security and privacy review: what it found, and what changed, is in
[SECURITY.md](SECURITY.md#0160).

### Changed

- **Routes are only tried when you test the connection.** Settings ›
  Connection shows them after **Test connection**, rather than trying each
  one whenever the page opens. Each is tried without your token now, and
  only counts if it's your server that answers. Over the internet only a
  server's `https://` addresses are used (a plain `http://` one would carry
  your sign-in unencrypted), as in Plex's own apps: a server with secure
  connections turned off is reached through Plex's relay instead.
- **Missing tracks are kept for each Plex server.** Settings › AI ›
  Missing tracks shows the list for the server in use, Check again looks in
  that server's library, and clearing it leaves other servers' lists. The
  spreadsheet, copy and share leave out what you asked the AI for.
- **Signing out clears everything that's yours on the device**: the
  queue and lists as before, and now anything for the AI (its address,
  model and your notes), the player's name and Home layouts. How the app
  looks and plays stays. The page loads afresh, other tabs signed in sign
  out too, and the browser is asked to forget the artwork it kept from the
  player (over HTTPS).
- **Searches aren't in the page's address**, so they stay out of the
  browser's history. Back and a reload still bring them back.
- **Play on with Plex players needs `PLEX_SERVER_URL`**, and is for the
  server's owner: without it, anyone signed in to Plex could have the
  container send requests around its network. AirPlay and Cast aren't
  affected, and are given the server's temporary token for the server in
  use only (nothing is sent until there is one).
- **With `PLEX_SERVER_URL` set, the container's service is for the people
  who can use that server**: Play Together, your devices and shared
  playlists too (on that server, or another of theirs), as the shared AI
  model and MusicBrainz checks already were.
- **A Plex server the container can't check** (a self-signed certificate,
  say) lets nobody through `/pms/`, where it let everybody through, and at
  an `https://` name nginx checks its certificate too.
- **The shared AI model's errors are plain**: what Ollama says (which can
  name the AI server's address and what's on it), when it turns a chat down
  or stops partway through one, goes to the container's log. The container
  also decides how much memory a chat takes (its context, and that the
  model stays loaded 15 minutes), and asks Ollama again without `think`,
  or with plain JSON, itself.
- **The documentation is in [docs/](docs/)**: a short README with setting
  it up first, then setup, configuration, features, AI, troubleshooting and
  development guides, and [SECURITY.md](SECURITY.md). `docker-compose.yml`
  has its notes in one header above the settings, and sets
  `no-new-privileges`.
- **The image is built on nginx 1.30**, its stable branch (1.27 no longer
  gets security fixes), with Alpine's security fixes since.
- **Proxmox VE**: the one-line install starts from the `stable` branch,
  falls back to `main` only while there's no `stable` (never because a
  download failed), and runs nothing unless all of it was downloaded, nor
  does the installer it fetches, then or in `update-plexamp-web`. The
  service can't gain capabilities.

### Fixed

- The service read a backslash in a path as `/`, where nginx doesn't, so
  the paths nginx keeps from browsers (its sign-in checks for `/pms/`, the
  AI model's own) could be reached directly. Only plain paths are
  answered, and those only when nginx sent them.
- Made-up tokens could each make the container ask plex.tv: new sign-ins
  are checked a few a minute from each address, each token once however
  many requests ask, and plex.tv's answers are capped, without following
  redirects. Many addresses at once no longer reset everyone's rate
  limits.
- Debug mode's redaction could be made to take a very long time, and
  missed tokens inside other addresses and in headers; browsers' lines are
  limited per minute.
- A setting with a line break in it passed the start-up checks (only its
  first line was checked), so it could add to nginx's settings or the
  app's `config.js`.
- Converted streams' session ids, which are all their files are fetched by,
  could be worked out from the device's id. They're random.
- The browser could keep answers from Plex and the service, whose addresses
  have tokens in them (artwork aside).
- A shared playlist being brought up to date when you signed out could save
  to the device, or say it changed, after signing out.
- Plex can't set cookies for the player's address, only WebSocket upgrades
  reach Plex, and nothing whose name starts with a dot is served.
- CI: each job has only the permissions it needs, actions are pinned to
  commits, and the shellcheck it downloads is checked.

## 0.15.0 - 2026-10-21

### Added

- **Routes, in Settings › Connection.** Each way this browser can reach
  your server (on your network, through this container, over the
  internet, Plex's relay), tried, with how long each took or why it didn't
  answer, and which one is in use. The connection says why it's the one in
  use. With `PLEX_SERVER_URL` set, **Route to the server** chooses: the best
  that answers (as before), always through this container, or straight to
  the server (through the container only when its own addresses don't
  answer).
- **Converted tracks are marked** in Now Playing, by their bitrate. Hover
  over the mark, or tap it, to see why your server converts the track (the
  Streaming quality chosen, or a format this browser can't play), with a
  way to the setting.
- **Tracks an import didn't find, with their albums.** The list shows each
  one's album, year, number and length, Copy the list adds the album, and
  Save as a spreadsheet (CSV) has the lot.

### Changed

- **The sleep timer's button is off to begin with.** Settings › Experience
  › Player › Sleep timer adds it to the player. A timer that's set goes
  when it's turned off.
- **The server this container is set up for is listed once** in
  Settings › Source: as that server ("also set up for this app") when
  it's one of yours on plex.tv, rather than again as "Server set up for
  this app".
- **Importing looks in every music library on the server**, the one in
  use first, and last on a track's album, by its number there (for a title
  written differently, "Song - 2011 Remaster", say).
- **A track already at the Streaming quality chosen, or lower** (a 128 kbps
  MP3 with High chosen, say), plays as it is rather than being converted.
- Going through this container, the app also looks for a better route when
  it starts (back on your network, say).
- **Test connection** waits 15 seconds, and through this container says
  which part didn't answer: the container, or the server behind it.

## 0.14.0 - 2026-10-21

### Added

- **Shared playlists.** Share a playlist with Plex friends who can use your
  server (Share with friends…, in its menu), letting each edit it or only
  view and play it. They find it on their Playlists tab, under Shared with
  you (a dot on the tab says so), and add it as a playlist of their own in
  Plex. Everyone's copy is kept the same: a change made in plexamp-web goes
  in straight away, and one made in another app (Plexamp, say) the next
  time that person opens plexamp-web. When two people change it meanwhile,
  both changes are kept; someone who can only view it has theirs undone.
  A mark at the top left of its picture shows it's shared. Stop sharing it,
  or delete it, and everyone keeps their copy, without the mark. Each
  browser changes its own person's copy with its own sign-in, so no one's
  Plex sign-in is shared or kept. The player keeps what's shared in `/data`
  (`/var/lib/plexamp-web` on Proxmox): give the container a volume there,
  as `docker-compose.yml` now does. `PLAYLIST_SHARING=false` turns it off.
- **Playlist files.** Export a playlist to a file from its menu, or back up
  all of yours in one (the Playlists tab's ⋯ menu), to import again later
  (after a Plex server is set up again, say) or for a friend with access to
  your server to import. A file has each track's title, artist, album,
  number and length, and Plex's ids for it, and nothing else about the
  server. Importing finds each track by its id on the same server, by
  Plex's id for the recording on a server set up again, or by title and
  artist elsewhere, and lists what isn't found.
- **Quiet endings.** Smart crossfade starts the next track over a quiet
  ending (a beat ticking on under a fade, a hushed outro: 20 dB under the
  rest of the track), up to 15 seconds before the music stops, rather than
  5 seconds before the end of the file. Settings › Playback › Quiet endings
  sets how quiet (15, 20 or 25 dB, or never).
- **Check on MusicBrainz** on the Missing tracks list, with MusicBrainz set
  up: those listed before they were checked are looked up, and what
  MusicBrainz doesn't know (most likely made up) and albums taken for songs
  come off the list, with Undo. Those it knows are marked On MusicBrainz.
- **A × to clear an AI playlist's description**, as in search (Escape
  too).

### Changed

- **`docker-compose.yml` has `MUSICBRAINZ_URL` for musicbrainz.org,
  commented out**, saying what turning it on sends where. The Proxmox
  settings file says so too.
- **The service's settings are root's, in a folder only root can change**
  (`/run/plexamp-web`), readable by the service; its socket has a folder
  of its own inside (`/run/plexamp-web/socket`). On Proxmox both were the
  service's before, so a service that had been taken over could have had
  root write to a file of its choosing at the next start. The start-up
  script also refuses a `SERVICE_USER` that doesn't exist (the service
  would have stayed root), and a `RUN_DIR` outside `/run`.

## 0.13.0 - 2026-10-20

### Added

- **Numbered track lists.** Playlists, collections, AI playlists, top
  tracks and the library's track lists number their tracks, and, where the
  screen is wide enough, show each one's album in a column of its own (a
  tap opens it). The numbers follow the tracks as you drag, sort or remove
  them.
- **One of each in search.** A song or album your library has more than
  once (an album and its hi-res edition, a song on its album and on a
  best-of) shows once, as the best-sounding copy: lossless over lossy, then
  the higher bitrate. A radio edit, a few seconds shorter or more, still
  shows on its own.
- **Formats in search**: each track's format before its artist (FLAC
  24/96, MP3 320), hi-res marked. Settings › Experience › Show formats in
  search turns them off.

### Changed

- **MusicBrainz is the container's choice.** `MUSICBRAINZ_URL` says which
  MusicBrainz to check AI playlists' suggestions with: musicbrainz.org, or a
  server of your own (a MusicBrainz Docker mirror, with its search
  indexes), so names needn't leave your network. Not set, nothing is
  checked and nothing goes to MusicBrainz; in 0.12.0 musicbrainz.org was
  offered unless `MUSICBRAINZ=false` (`MUSICBRAINZ=true` alone still means
  musicbrainz.org). Your own server is asked as fast as it answers, one
  request at a time; musicbrainz.org once a second at most. MusicBrainz
  needs no API key.
- **Suggestions are checked as the AI playlist is made**, not on the
  Missing tracks list: Not in your library says which were left out, as
  MusicBrainz doesn't know them (most likely made up) or they're albums, and
  only the rest go on the list. The list has no MusicBrainz controls any
  more, and what 0.12.0 kept on it hidden goes. Checking is on to begin
  with, where the container has a MusicBrainz to ask.
- **DJ Bridge plays one track** between each of yours and the next: the
  one in the middle of the path Plex finds between them. 0.12.0 played up
  to four, and in a big library nearly always four, as Plex rarely says how
  far apart two tracks are.
- **The AI DJ varies its artists**: never the artist playing or the last
  few, their best-known songs (Plex's popular tracks) where it has them,
  from artists who sound like what's playing, who Plex says are similar, or
  who share the genre of the track it started on, and it's asked to keep to
  that genre.
- **Turning a DJ off puts your queue back as it was**: its picks still to
  come are taken out (all of them: DJ Bridge's too), and what the queue DJs
  moved goes back where it was. Choosing another DJ does the same.
- **Sorting a playlist says what it's counting**: "211 of 458 moved (42
  already in place)", as only the tracks out of place move. Once done, it
  checks the order Plex has, and puts right anything that didn't land where
  it should.

### Fixed

- **Queue Bridge did nothing** in a big library, and Queue Echo went by
  little more than artists and years: Plex only gives the distance between
  a track and its nearest few hundred. Both now go by what Plex knows of the
  albums and artists in your queue when it doesn't say (genres and styles,
  moods, years, similar artists), and say what they did, or why nothing
  needed moving, the first time after they're turned on.
- Sorting a playlist read it 500 tracks at a time, and would have missed
  some from a server giving fewer at a time.

## 0.12.0 - 2026-10-20

### Added

- **Pictures for playlists and collections.** Unlocked, a playlist (or, for
  the server's owner, a collection) has a pencil over its artwork (on a
  computer, when the pointer's over it): upload a picture from the device,
  go back to one it had, or to the covers Plex puts together. Pictures are
  made smaller in the browser first, so only the picture goes to Plex, not
  where a photo was taken. Smart playlists, which can't be unlocked, have
  Change picture… in their menu.
- **Two DJs that only use your queue**, and add nothing to it. **Queue
  Echo** plays next whichever of your next 40 tracks sounds most like the
  one playing. **Queue Bridge**, when your next track sounds far from this
  one, first plays one from later in your queue that sits between them.
- **Wait for the model** (Settings › AI): how long to wait for the AI model
  to start answering, from 2 to 30 minutes (5 to begin with). The app says
  while the model is loading, and if the wait runs out, the model carries on
  loading, so trying again is quick. Before, after 4 minutes the app gave up,
  and Ollama stopped loading the model with it.
- **Check them on MusicBrainz** (Settings › AI, under Show missing tracks):
  each missing song and artist is looked up on musicbrainz.org. The ones it
  doesn't know, mostly ones the AI made up, are left out of the list (Show
  brings them back), and albums taken for songs are dropped. Off until you
  turn it on. Only the names are sent, by the container, never your token;
  `MUSICBRAINZ=false` takes the option away. See the security report.

### Changed

- **DJ Bridge** fits the journey to the gap: one track between two that
  sound alike, up to four when they're far apart, spread along the path
  Plex finds between them so each step is a small one. It always played
  two, from the middle of the path, so the first step could still be a big
  jump.
- **No more loops with DJ Steady**, or any DJ: none adds a song you've
  played since opening the player, and another version of a song (on a
  compilation, a live album, a remaster) counts as the same song. Versions
  sound alike, so they were always "the most similar", and Steady played
  the same few songs again and again. Steady also mixes in other artists
  where they sound as close.
- **Search for an artist** ("groove armada") and Tracks, now straight after
  Artists and above Albums, starts with their best-known tracks.
- **Fewer made-up songs in AI playlists.** The model is asked only for
  songs it's sure of, with their titles as released, never an album's, and
  for fewer rather than a guess. A suggestion that's one of the artist's
  albums is no longer looked for as a song (or listed as missing), and a
  playlist takes no more than an eighth of its tracks (at least two) from
  any one album where the library allows, so "best of" an artist isn't one
  album from start to finish. Compilations are the exception.
- The shared AI model is loaded by the container itself, once, however many
  people are waiting for it, and nobody giving up stops it.

### Fixed

- **On Proxmox, `pct exec <ID> -- update-plexamp-web` couldn't find the
  command** (nor `plexamp-web-settings`): `pct exec` doesn't look in
  `/usr/local/bin`. Both are now linked from `/usr/bin` too. A container
  installed with 0.10.0 or 0.11.0 needs
  `pct exec <ID> -- /usr/local/bin/update-plexamp-web` once.
- A wrong `PLEX_TV_URL` (a setting for tests) was printed in full in the
  start-up error, a password in it included. It's hidden now, as in every
  other address the container prints.

## 0.11.0 - 2026-10-20

### Added

- **Appears in lists the albums the song is on**: the track's own album
  first, then any other with the same song by the same artist (a
  compilation, a soundtrack, a best-of, a live album), oldest first, each
  saying what the song is called there if it's another version ("Radio
  Edit", "Extended Mix"). Another artist's song of the same name isn't
  counted. The page now starts with how many albums, playlists and
  collections it's on and in.
- With Show missing tracks on, an AI playlist where everything the model
  suggested is in the library now says so ("Nothing missing: the 8 artists
  and 12 songs it suggested are all in your library"), rather than showing
  nothing.

### Changed

- **A smart playlist of a whole library** (such as an "All Music" of every
  track) is no longer reported as too long to look through: its rules say
  every track is in it, so Appears in lists it without reading it. Other
  very long smart playlists are still left out, and the page now says why
  more plainly.

### Fixed

- A stray word "null" under AI playlists (with Show missing tracks off, or
  nothing missing). Every page the browser tests visit is now checked for
  words like this.
- The Proxmox install printed "curl: (22) The requested URL returned error:
  502" while the app was starting. Its checks are now quiet; only the
  outcome is told.

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
  [Your devices](docs/features.md#your-devices).

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
