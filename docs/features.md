# Features

- [Browsing and search](#browsing-and-search)
- [Now Playing and playback](#now-playing-and-playback)
- [Playlists and collections](#playlists-and-collections)
- [Shared playlists](#shared-playlists)
- [Playlist files](#playlist-files)
- [From Spotify](#from-spotify)
- [Your devices](#your-devices)
- [Play Together](#play-together)
- [Play on](#play-on)
- [Guest DJ](#guest-dj)
- [Settings in the app](#settings-in-the-app)
- [Good to know](#good-to-know)

AI playlists and the AI DJ have a page of their own: [ai.md](ai.md).

## Browsing and search

- **Home**: sections you choose and order for each library (see [Settings in the app](#settings-in-the-app)), including Collections, and a quick library switcher.
- **Search**: live results, narrowed word by word: press Enter (or +) to keep a word as a tag, and what you type next only finds things that match every tag ("prodigy", then "fire"). One tap on × clears it all. Search for an artist ("groove armada") and Tracks starts with their best-known ones. Each song and album shows once, however many copies your library has (an album and its hi-res edition, a song and its best-of), as the best-sounding copy, with its format (FLAC 24/96, MP3 320).
- **Browsing**: artists, albums, tracks, compilations, soundtracks, collections, genres, styles, moods and decades, with counts from your server. Any list can be searched within: in the 1990s, type "rock" to narrow it to rock albums from the 1990s, then "calm" for a mood, and take each filter off again with a tap. Also top artists, albums and tracks, Sonic path (a journey between two tracks) and Shuffle library.
- **Artist pages**: popular tracks, albums grouped by type, sonically similar artists, and artist radio.
- **Album and playlist pages**: play, shuffle, a rating on every track (stars or thumbs, as you choose), and a menu on every track (play next, add to queue, similar tracks, add to a playlist, appears in, go to album or artist). Albums show their format (FLAC 24/96, say) and mark their best-known tracks.
- **Appears in**, from any track's menu: the albums the song is on (its own, and others with the same song by the same artist, such as a compilation, a soundtrack or a live album), the playlists it's in, and the collections it's in, including collections of its album or its artist.
- **Responsive**: bottom tabs and a mini player on phones; a sidebar and full transport bar on computers. On a big screen, pages to browse use the whole width, with bigger artwork as the window grows, and settings, Play Together and the AI playlist keep to a column in the middle. Each tab keeps its own history, like a phone app's, so Back stays within the tab you're in. It can be added to a phone's home screen.
- **Shelves** (the rows on Home and album and artist pages) are swiped on a touch screen, where the heading opens the whole list. With a mouse, ‹ › by the heading scroll the shelf a screenful at a time (‹ once it's moved, › until the end), and the title opens the whole list.

## Now Playing and playback

- **Now Playing**: big artwork, a seek bar drawn from your server's loudness analysis, ratings that save to Plex, the file's format and quality, Up next (with **Move to top**), Guest DJ, shuffle, repeat and volume. Playback speed, a sleep timer and quick skip buttons can be added in **Settings › Experience › Player**.
- **Converted tracks** (a lower **Streaming quality** in Settings › Playback, or a format the browser can't play) are marked by their bitrate: hover over the mark, or tap it, to see why. A track already at the quality you chose, or lower, plays as it is.
- **Gapless playback and crossfades** like Plexamp's. **Smart** crossfade uses your server's loudness analysis to fade into the next track where the music really ends, so silence at the end of a track doesn't leave a gap, and a quiet ending (a beat ticking on under a fade, a hushed outro) doesn't hold the next track up (**Settings › Playback › Quiet endings** sets how quiet). Tracks that follow each other on an album play gaplessly.
- **❤️ Tracks**: tracks you give five stars or a thumbs up go in your ❤️ Tracks playlist, and come out when they lose that rating, as in Plexamp.
- **Lock-screen and media-key controls**, and play reporting to Plex (play counts, recent plays, its dashboard).
- **Live updates**: new music, playlist changes and ratings from other Plex apps appear without reloading (see [configuration.md](configuration.md#live-updates)).
- **Album-colour backgrounds** from Plex's artwork colours, or a blurred copy of the cover.

## Playlists and collections

- **Playlists**: numbered tracks, with each one's album in a column of its own where the screen is wide enough. Make them, add to them from any track, album, artist or the queue, and edit them: reorder, sort (by artist, track name, album or year, or reversed, with Undo), remove, rename, delete, and change the picture (unlocked, a pencil over the artwork uploads one from the device, goes back to one it had, or to the covers Plex puts together). A lock keeps them safe from accidental swipes and taps until you unlock one.
- **Collections**, for the server's owner: the same editing, sorting and pictures, and adding tracks, albums or artists.

## Shared playlists

Plex has no shared music playlists, so the player does it: share a playlist with Plex friends who can use your server, and everyone's copy of it stays the same.

- **Share** from the playlist's menu: **Share with friends…** lists your Plex friends, and for each you choose **Can edit** (their changes go to everyone) or **Can view** (they can play it, not change it). Friends who can't play from your server are shown, but can't be chosen. A mark at the top left of the playlist's picture shows it's shared, and the line under its title says with whom; tap it to change who, or to **Stop sharing**.
- **Your friends** find it on their Playlists tab, under **Shared with you** (a dot on the tab says something's there), with **Add** or **No thanks**. Added, it's a playlist of their own in Plex, so it plays in Plexamp and every other Plex app too.
- **Kept the same.** A change made in plexamp-web goes into the shared playlist straight away, and into each person's copy when their plexamp-web brings it up to date: when they open it, when they open the playlist, and every minute while it's open. Changes made in another app, such as Plexamp, go in the next time that person opens plexamp-web. Renaming it is up to whoever shared it.
- **When two people change it** before either opens plexamp-web again, both changes are kept: tracks added on either side are in, tracks taken out on either side are out. Someone who can only view it can't change it: their changes are undone, and they're told.
- **Stopping.** When whoever shared it stops sharing it, or deletes it, everyone keeps their copy as an ordinary playlist, without the mark. A friend can stop getting it too (**Stop sharing it with me…** in its menu).

Everyone uses the same player address, signed in with Plex, and the friend needs your music library shared with them in Plex. Each person's own browser changes their own copy, so nobody's sign-in is shared. The player keeps what's shared in `/data`: give the container a volume there. Smart playlists can't be shared, a shared playlist holds up to 5,000 tracks, and its picture isn't shared. A track a friend can't play (from a library you haven't shared with them) is left out of their copy, and stays in everyone else's.

## Playlist files

- **Export a playlist** from its menu: **Export to a file** saves a `.playlist.json` file with each track's title, artist, album, number, length and Plex's ids for it, and nothing else about your server.
- **Back up all of yours** from the Playlists tab's ⋯ menu: **Back up your playlists** saves every playlist of yours on the server in one file (not smart ones: their rules belong to the server).
- **Import** from the same menu: **Import playlists…** opens a file. One playlist asks for its name; a backup asks which to bring back, leaving out those you have already. Each track is looked for in every music library on the server, the one you're in first: by its id on the same server, by Plex's id for the recording on a server that's been set up again, by title and artist anywhere else, and last on its album by its number there. What isn't found is listed with its album, year, number and length, to copy or save as a spreadsheet (CSV).

Friends with access to your server can import a file you send them, and get the same tracks. To keep a playlist the same for both of you, share it instead.

## From Spotify

With `SPOTIFY_IMPORT=true` on the container (it's off unless you turn it on: see [configuration.md](configuration.md#container-settings)), **Search › From Spotify** makes a playlist here from a Spotify playlist's link.

- **The link**: in Spotify, open the playlist and choose **Share › Copy link to playlist** (an `open.spotify.com/playlist/…` link, a `spotify:playlist:…` URI, or a `spotify.link` short link). The playlist has to be public.
- **What's read**: its name, who made it, and each track's title, artists and length, from the page Spotify shows anyone for the playlist. That page lists the first 100 tracks at most, so a longer playlist comes over as its first 100. Podcast episodes in it are left out.
- **Finding them**: each track is looked for in every music library on the server, the one you're in first, by its title and artist, its length choosing between copies. Spotify's extras on a title ("Song - Remastered 2011", "(feat. …)") and a list of artists ("Artist, Guest") don't get in the way. Those found make a playlist in the same order, named as on Spotify (or with "(from Spotify)" when you have one of that name), which you can change first.
- **What isn't found** is listed when it's done, to copy or save as a spreadsheet, and goes on **Missing tracks** (Settings › AI › Missing tracks), saying which Spotify playlist it was in, unless you turn that off for the import. It's kept on the device that did the import: when a friend imports one, the list is on their device, for them to share with you.
- **What goes where**: the link goes to the container, which reads the page from Spotify. Nothing goes from your browser to Spotify, and nothing about you or your library goes to Spotify.

Spotify's page isn't an API: when Spotify changes it, this stops working until plexamp-web is updated, and the app says so.

## Your devices

Signed in to the same Plex account and playing from the same server, your devices share what's playing. Start a playlist on your computer, open the player on your phone, and the phone shows the track, where it's got to and Up next, with its own sound off.

- **One device plays.** The others show where the music is ("Playing on Firefox on Windows") and control it: play, pause, skip, seek, volume, shuffle, repeat and changes to Up next all happen there.
- **Listen here.** Tap the muted speaker (or **Listen here** under the artwork) and the music moves to the device in your hand, from the same spot. Browsers only start sound after a tap on the device itself.
- **Carry on later.** Close the player where it was playing, or leave it paused for 10 minutes, and the next device you open has the same queue ready at the same place.
- **Name your devices** in **Settings › Experience › Player name**. Until you do, they're named by browser and system, like "Chrome on Android".
- **Play on more than one at once**: turn off **Settings › Playback › Share playback with your devices** on a device, and it plays on its own.

Each browser tab counts as a device. While you're in a Play Together session, sharing between your devices pauses.

## Play Together

Listen with Plex friends, each on their own device. Open the **Together** tab, choose **Start a session**, and pick friends to invite (people you share your Plex library with). They open the same player, sign in with their own Plex account, and find the invitation in their Together tab.

- **In sync**: play, pause, skip and seek happen for everyone, and each track starts at the same moment for everyone.
- **One shared queue**: anyone in the session can add music from anywhere in the app, remove upcoming tracks, shuffle or clear what's next. Up next shows who added each track.
- **Hosting**: the host can invite more friends and remove people. If the host leaves, whoever's been there longest takes over. **End for everyone** stops the session.
- **Your own server access**: friends play from your Plex server with their own access, so they need your music library shared with them. Plays count for each person.

Everyone must use the same player address, because sessions live in that container. Guest DJ and repeat are off during a session, and a sleep timer takes you out of the session instead of pausing everyone. Sessions use plain HTTP requests, so they work through work proxies too.

## Play on

The cast button next to Repeat (and in the desktop player bar) chooses where the music plays.

- **Plex players**: Plexamp (on a Raspberry Pi or a computer, say) and other Plex apps that can be controlled remotely, signed in to your Plex account and on the same network as the container. The app becomes the remote, and Now Playing follows what the player plays. **This device** brings the music back, from where it got to. This is for the server's owner, and needs `PLEX_SERVER_URL` set (see [SECURITY.md](../SECURITY.md#play-on)).
- **AirPlay or Cast…** opens the browser's own list of speakers and TVs, where it has one: AirPlay in Safari, Google Cast in Chrome on Android. The speaker gets a temporary token from your Plex server, never your account's own. Crossfades are off while a speaker is connected.
- **Alexa (Echo) speakers can't be played on**: Amazon only lets its approved music services play on them. Pair the speaker with your phone or computer over Bluetooth instead.

Plex doesn't fully document how its players are controlled, and Play on has been tested against a simulated player rather than every real one. If a player doesn't respond, please open an issue, with the [debug log](configuration.md#debug-mode).

## Guest DJ

Choose a DJ with the DJ button in Now Playing. It plays along with your queue until you turn it off, and then what's to come is as it was.

| DJ | What it does |
| --- | --- |
| DJ Bridge | Between each of your tracks and the next, plays one that sits between them in sound. |
| DJ Echo | Follows each of your tracks with the one that sounds most like it. |
| DJ Steady | Keeps the mood going with tracks that sound like the one playing. Your queue waits until you turn it off. |
| DJ Double | Follows each of your tracks with another by the same artist. |
| DJ Era | Keeps the mood going with tracks from the same era. |
| DJ Superfan | Keeps queueing tracks by the same artist. |
| AI DJ | Your AI model picks each next track from your library and says why (see [ai.md](ai.md)). |
| Queue Echo | Adds nothing. As each track starts, whichever of your next 40 sounds most like it moves up to play next. |
| Queue Bridge | Adds nothing. When your next track sounds far from the one playing, one from later in your queue that sits between them plays first. |

No DJ adds a song you've played since opening the player (the last 300), or one that's queued, and another version of a song (on a compilation, a live album or a remaster) counts as the same song. Up next and Now Playing say which tracks a DJ added or moved, and why. The sound-based DJs need Plex's sonic analysis (see [Good to know](#good-to-know)); without it, the ones that add tracks match on genre.

## Settings in the app

Kept per device, and they stay when you sign out, but for the ones that are yours rather than the device's: anything for the AI, the player name and Home layouts go, with your queue and lists. **Settings › Experience** follows the layout of Plexamp's own settings:

- **Appearance**: colour from artwork, and the background (album colours, blurred artwork, or plain).
- **Player**: the codec, the rating, the volume control, the seekbar style, Up next side by side on wide screens, the album year, opening the full player when something starts, playback speed, the sleep timer, long-form controls (for tracks over 20 minutes), and quick skip buttons with times you choose.
- **Home screen**: the sections on Home for the current library. Drag to reorder, tap one to show or hide it, or to pick its time period.
- **Grid size, font size and rating system** (five stars, half stars, thumbs or off), album codec badges, formats in search, popular-track badges and preview buttons, the top plays list size, and **1-tap playback**.
- **Search all music libraries** and **playlists from all music libraries**, when your server has more than one music library.
- **Sync recent plays**, **desktop integration** (media keys, the tab title, keyboard shortcuts) and the **player name** Plex shows on its dashboard.

**Settings › Playback** has the streaming quality, gapless playback, crossfades and sharing playback with your devices; **Settings › Connection** has the route to your server and live updates (see [configuration.md](configuration.md#reaching-your-plex-server)).

## Good to know

- **Formats.** Files play as they are when the browser supports them (FLAC, MP3, AAC, Opus and WAV in current browsers; ALAC mostly in Safari). Anything else is converted by your server, and played with the browser's built-in HLS support or [hls.js](https://github.com/video-dev/hls.js), which is bundled into the image. A converted stream that fails part-way (a dropped connection, or the server stopping it) is tried again and then started again from where it got to; a track is only skipped if its stream keeps failing at the same place.
- **Sonic features** (similar tracks, Sonic path, sonically similar artists, artist radio and the sound-based Guest DJs) need sonic analysis turned on for the library in Plex.
- **Smart crossfade needs Plex's loudness analysis** (Plex's **Settings › Library › Analyze audio tracks for loudness**, which runs during the server's maintenance period). It tells the player where a track's music really ends, and where it ends quietly. Without it, Smart fades at the very end of each track. The waveform in the seek bar comes from the same analysis.
- **Crossfades on iPhone and iPad.** Safari there doesn't let pages change the volume of audio, so it can't fade: tracks change where the music ends instead.
- **Memory.** Long lists keep artwork only near the screen, and pages you've moved on from are let go after a while, so the player stays light however long it's open or however big the library.
- **Not built yet**: lyrics and loudness levelling.
