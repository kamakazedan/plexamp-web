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

- **Home**: sections you choose and order (one layout for every library and server: see [Settings in the app](#settings-in-the-app)), including Collections and Stations (library radio, your favourites, deep cuts, time travel and a random album), and a quick library switcher.
- **Search**: live results, narrowed word by word: press Enter (or +) to keep a word as a tag, and what you type next only finds things that match every tag ("prodigy", then "fire"). One tap on × clears it all. Search for an artist ("groove armada") and Tracks starts with their best-known ones. Each song and album shows once, however many copies your library has (an album and its hi-res edition, a song and its best-of), as the best-sounding copy, with its format (FLAC 24/96, MP3 320).
- **Browsing**: artists, albums, tracks, compilations, soundtracks, collections, genres, styles, moods and decades, with counts from your server. The counts are kept in the browser (just the numbers, until you sign out), so the lists show at once, in their places, and are brought up to date as your server answers: nothing moves while you're looking (a list your library has stopped or started having goes or comes the next time). Any list can be searched within: what you type narrows it as you type ("strokes" in Artists shows The Strokes), and a matching genre, style or mood is offered too (in the 1990s, type "rock" for rock albums from the 1990s, then "calm" for a mood; take each filter off again with a tap). Also top artists, albums and tracks, Sonic path (a journey between two tracks) and Shuffle library.
- **Artist pages**: popular tracks, albums grouped by type, sonically similar artists, and artist radio.
- **Album and playlist pages**: play, shuffle, a rating on every track (a favourite tick, stars or thumbs, as you choose), and a menu on every track (play next, add to queue, similar tracks, add to a playlist, appears in, go to album or artist). Albums show their format (FLAC 24/96, say) and mark their best-known tracks. Playlists have **Radio** too: some of the playlist, mixed with tracks that sound like it (or more from its artists, without sonic analysis).
- **Favourites radio** (Home › Stations): the artists in ❤️ Tracks, those you love most first, some of their best-known tracks, and artists like them.
- **Appears in**, from any track's menu: the albums the song is on (its own, and others with the same song by the same artist, such as a compilation, a soundtrack or a live album), the playlists it's in, and the collections it's in, including collections of its album or its artist.
- **Responsive**: bottom tabs and a mini player on phones; a sidebar and full transport bar on computers. On a big screen, pages to browse use the whole width, with bigger artwork as the window grows, and settings, Play Together and the AI playlist keep to a column in the middle. Each tab keeps its own history, like a phone app's, so Back stays within the tab you're in. It can be added to a phone's home screen.
- **Shelves** (the rows on Home and album and artist pages) are swiped on a touch screen, where the heading opens the whole list. With a mouse, ‹ › by the heading scroll the shelf a screenful at a time (‹ once it's moved, › until the end), and the title opens the whole list.

## Now Playing and playback

- **Now Playing**: big artwork, a seek bar drawn from your server's loudness analysis, ratings that save to Plex, the file's format and quality, Up next (with **Move to top**), Guest DJ, shuffle, repeat and volume. Playback speed, a sleep timer and quick skip buttons can be added in **Settings › Experience › Player**.
- **Converted tracks** (a lower **Streaming quality** in Settings › Playback, or a format the browser can't play) are marked by their bitrate: hover over the mark, or tap it, to see why. A track already at the quality you chose, or lower, plays as it is.
- **Loudness levelling** (**Settings › Playback**, on to start with): louder tracks are turned down to match quieter ones, from your server's loudness analysis, to the level Spotify and TIDAL play at. Nothing is ever turned up, so nothing distorts, and no preamp or limiter is needed. Albums played in order keep their own ups and downs. Not on iPhone or iPad, which don't let a web page set the volume.
- **Load ahead** (**Settings › Playback**, each device's own, the next track to start with): the next 1 to 10 tracks loaded in full, so a dropped or slow connection doesn't stop the music at the next track. Each choice says about how much memory it takes (four-minute tracks: about 10 MB each as MP3, 30 MB as CD-quality FLAC, or at the bitrate they're converted to). The track playing comes first: tracks load ahead only while it has what it needs, and wait whenever it needs more. Until it's all loaded, loading ahead is held back too, in small parts with a rest after each, so it takes half the connection at most and leaves the track playing at least twice its bitrate (on a connection too slow for that, a small part every half a minute); once it's all in, the next tracks load as fast as the connection allows. The browser keeps them only while they're wanted (with the tracks played it keeps, as much as the device's memory allows where the browser says how much it has, as Chrome and Edge do over HTTPS: 128 MB to 512 MB; otherwise 384 MB, or 256 MB on a phone or tablet): the app doesn't save them and they don't go in the browser's cache, though a browser short of memory can set large files aside in its own temporary storage until they're let go. Converted tracks load ahead in browsers that play them through the app's stream player (not Safari, which streams them as they play). Off, the next track starts loading shortly before it's due (for a gapless change or a crossfade), once the one playing has loaded.
- **Keep played tracks** (**Settings › Playback**, each device's own, 1 to start with): the last 1 to 5 tracks played stay in memory, so going back to one (Previous, or a track in the queue) plays it at once, even with a slow or dropped connection; the one gone back from is kept too. What was loaded ahead for a track is kept as it is (a file still loading when it starts playing goes on loading); a converted track that came in as it played is kept as it came in (no second stream of it); a file that came in as it played is read again into memory once the tracks ahead are in, with Load ahead on (off, it isn't read twice, so going back to it plays it from your server again). Each choice says about how much memory it takes, and the tracks ahead come first: those played make room for them, the furthest back first, and one still being read waits, part-read, while a track ahead loads. A track played again from memory is another playback, as far as Plex is concerned. Off, a track played again comes from your server again.
- **Gapless playback and crossfades** like Plexamp's. **Smart** crossfade uses your server's loudness analysis to fade into the next track where the music really ends, so silence at the end of a track doesn't leave a gap, and a quiet ending (a beat ticking on under a fade, a hushed outro) doesn't hold the next track up (**Settings › Playback › Quiet endings** sets how quiet). Tracks that follow each other on an album play gaplessly.
- **Ratings**: a favourite tick to start with (a ring beside each track and in Now Playing; ticked, it turns green), which is five stars in Plex. Five stars and thumbs are in **Settings › Experience**.
- **❤️ Tracks**: tracks you tick, give five stars or a thumbs up go in your ❤️ Tracks playlist, and come out when they lose that rating, as in Plexamp.
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

**Search › From Spotify** makes playlists here from your Spotify ones, using Spotify's own download of your data: all your playlists, however long, and your Liked Songs. It needs nothing set on the container, and works with a free Spotify account.

- **Why a download**: Spotify only lets other apps read your playlists through its developer programme, which needs a Premium account and allows five people (only a business with 250,000 users can have more). But anyone can download their own data from Spotify.
- **Asking for it**: on spotify.com, open your account's **Privacy settings**, tick **Account data** under **Download your data**, and request it. Spotify emails you to confirm, then again when it's ready, usually within a few days (it allows itself up to 30). The guide in the app links to the page.
- **Which files**: it comes as a ZIP, with a file for each kind of data. Only these are needed: `Playlist1.json` (with `Playlist2.json` and so on, if you have a lot of playlists), with your playlists, and `YourLibrary.json`, with your Liked Songs. Open the ZIP and choose just those (or drop them on the guide): the other files hold your personal details (your email, date of birth, address and phone number, your payment card, and what you've searched for and listened to).
- **What's read**: only files with those names are opened, in your browser. Any other file you choose, the ZIP itself included, is turned away by its name without being opened, and the app says which. From the files it opens, only each playlist's name and each track's title, artist and album are kept. Descriptions, follower counts, dates and Spotify's ids are left behind, and so are podcast episodes and audiobooks. Files of your own you'd added to Spotify come over by their artist, album and title.
- **Choosing**: your playlists are listed, Liked Songs first, with how many tracks each has. Those with the name of a playlist you have already aren't chosen to begin with; chosen, one comes over as "Name (from Spotify)" (or "(from Spotify 2)", and so on), and so does the second of two by the same name, as the list shows before you start. At most 1,000 playlists and 100,000 tracks in all are read at once, and 20,000 tracks of any one playlist: the list says what was cut short, and when choosing a file on its own would bring over the rest. A file over 25 MB is passed over, saying so.
- **Finding them**: each track is looked for in every music library on the server, the one you're in first, by its title and artist, its album choosing between copies. Spotify's extras on a title ("Song - Remastered 2011", "(feat. …)") don't get in the way. Those found make a playlist in the same order.
- **What isn't found** is listed when it's done, to copy or save as a spreadsheet, and goes on **Missing tracks** (Settings › AI › Missing tracks), saying which Spotify playlist it was in (and how many of yours it's in, each once, however often it's imported), unless you turn that off for the import. Missing tracks keeps the latest 1,000 from Spotify for each server, apart from the 500 AI playlists suggested, so a whole account's can't push those out: past that, the import's spreadsheet has them all, and it says so. It's kept on the device that did the import: when a friend imports their playlists, the list is on their device, for them to share with you.
- **What goes where**: nothing goes to Spotify, nor to the container's service: on the container's `/pms/` route to your server, its sign-in check is given only your token, not what's asked for. The titles, artists and albums go no further than your Plex server, to find the tracks there (as any search does), and the playlists you choose are made there.

### From a link

With `SPOTIFY_IMPORT=true` on the container (it's off unless you turn it on: see [configuration.md](configuration.md#container-settings)), **Use a link instead** in the same place brings over one public playlist straight away, from its link, but only its first 100 tracks.

- **The link**: in Spotify, open the playlist and choose **Share › Copy link to playlist** (an `open.spotify.com/playlist/…` link, a `spotify:playlist:…` URI, or a `spotify.link` short link). The playlist has to be public.
- **What's read**: its name, who made it, and each track's title, artists and length, from the page Spotify shows anyone for the playlist. That page lists the first 100 tracks at most, so a longer playlist comes over as its first 100. Podcast episodes in it are left out.
- **Finding them**: as above, with its length choosing between copies too, and a list of artists ("Artist, Guest") not getting in the way. The playlist is named as on Spotify (or with "(from Spotify)" when you have one of that name), which you can change first. What isn't found goes on Missing tracks, as above.
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

**They follow your Plex account**: any browser you sign in on with the same player has them, the Home screen too. The container keeps them for your account (in `/data`; `SYNC_SETTINGS=false` turns it off: see [configuration.md](configuration.md#container-settings)), and the change made last to each one wins (one made offline, or as a tab closed, is sent the next time the app opens there, unless that setting has been changed since elsewhere). The first time a browser has them, the settings you'd changed on it stay (and go to your other devices), and it takes your account's for the rest; once someone has signed out of a browser, what it still has never goes to the next account signed in on it. Some are always each device's own: Streaming quality (a work laptop on a slow connection, say), the route to your server and live updates, the player name, sharing playback with your devices, playback speed, Load ahead, and your own AI server (its key never leaves the browser). **Settings › Account › On all your devices** turns it off for your account: then nothing is kept for it, and each device has its own settings.

Each device keeps its copy when you sign out, but for the ones that are yours rather than the device's: anything for the AI, the player name and the Home layout go there, with your queue and lists (what's kept for your account stays, for when you sign in again). **Settings › Experience** follows the layout of Plexamp's own settings:

- **Appearance**: colour from artwork, and the background (album colours, blurred artwork, or plain).
- **Player**: the codec, the rating, the volume control, the seekbar style, Up next side by side on wide screens, the album year, opening the full player when something starts, playback speed, the sleep timer, long-form controls (for tracks over 20 minutes), and quick skip buttons with times you choose.
- **Home screen**: the sections on Home, one layout for every library and server. Drag to reorder, tap one to show or hide it, or to pick its time period.
- **Grid size, font size and rating system** (a favourite tick, five stars, thumbs or off), album codec badges, formats in search, popular-track badges and preview buttons, the top plays list size, and **1-tap playback**.
- **Search all music libraries** and **playlists from all music libraries**, when your server has more than one music library.
- **Sync recent plays**, **desktop integration** (media keys, the tab title, keyboard shortcuts) and the **player name** Plex shows on its dashboard.

**Settings › Playback** has the streaming quality, gapless playback, crossfades, Load ahead, Keep played tracks, loudness levelling and sharing playback with your devices; **Settings › Connection** has the route to your server and live updates (see [configuration.md](configuration.md#reaching-your-plex-server)).

## Good to know

- **Formats.** Files play as they are when the browser supports them (FLAC, MP3, AAC, Opus and WAV in current browsers; ALAC mostly in Safari). Anything else is converted by your server, and played with the browser's built-in HLS support or [hls.js](https://github.com/video-dev/hls.js), which is bundled into the image. A converted stream that fails part-way (a dropped connection, or the server stopping it) is tried again and then started again from where it got to; a track is only skipped if its stream keeps failing at the same place.
- **Sonic features** (similar tracks, Sonic path, sonically similar artists, artist radio and the sound-based Guest DJs) need sonic analysis turned on for the library in Plex.
- **Smart crossfade needs Plex's loudness analysis** (Plex's **Settings › Library › Analyze audio tracks for loudness**, which runs during the server's maintenance period). It tells the player where a track's music really ends, and where it ends quietly. Without it, Smart fades at the very end of each track. The waveform in the seek bar comes from the same analysis.
- **Crossfades on iPhone and iPad.** Safari there doesn't let pages change the volume of audio, so it can't fade: tracks change where the music ends instead.
- **Memory.** Long lists keep artwork only near the screen, and pages you've moved on from are let go after a while, so the player stays light however long it's open or however big the library.
- **Not built yet**: lyrics and loudness levelling.
