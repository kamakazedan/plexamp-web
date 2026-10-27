// Search › From Spotify, two ways, each turned on on the container (and
// off unless it is). Spotify's own download of your data, with
// SPOTIFY_FILE_IMPORT (see readSpotifyFiles): its playlist files, read here
// in the browser, with all your playlists, however long. And, with
// SPOTIFY_LINK_IMPORT (SPOTIFY_IMPORT before 0.22.0), a public playlist's
// link, which goes to this player's service, which reads the playlist from
// the page Spotify shows anyone for it (server/spotify.js), at most its
// first 100 tracks. Either way, the tracks are then looked for in the
// library like a playlist file's (playlistio.js matchEntries), and what
// isn't found goes on Missing tracks. Nothing goes from the browser to
// Spotify.
import { app } from './state.js';
import { FILE_LIMITS } from './playlistio.js';

// The link (config.js: spotify), and the download's files (spotifyFiles).
export const spotifyOffered = () => !!app.config?.spotify;
export const spotifyFilesOffered = () => !!app.config?.spotifyFiles;

// What a pasted link is, before it's sent: 'playlist' (its link or URI),
// 'short' (a spotify.link short link, which the service follows), 'other'
// (an album, song, artist or podcast on Spotify), or null. The service
// checks it properly.
export function spotifyLinkKind(text) {
  const s = String(text || '').trim();
  if (/^spotify:(?:user:[^:\s]+:)?playlist:[A-Za-z0-9]{22}$/.test(s) || /^[A-Za-z0-9]{22}$/.test(s)) return 'playlist';
  if (/^spotify:(album|track|artist|show|episode):/.test(s)) return 'other';
  let url;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (host === 'spotify.link') return 'short';
  if (host !== 'open.spotify.com' && host !== 'play.spotify.com') return null;
  if (/\/playlist\/[A-Za-z0-9]{22}\/?$/.test(url.pathname)) return 'playlist';
  if (/\/(album|track|artist|show|episode)\//.test(url.pathname)) return 'other';
  return null;
}

// The playlist, as the service read it: { id, name, owner, tracks: [{
// title, artist, artists?, album?, duration? }], capped }. Throws with the
// service's own words for what went wrong.
export async function readSpotifyPlaylist(link, { signal } = {}) {
  // Who's asking, checked by the player as for its shared AI model.
  const headers = { 'Content-Type': 'application/json', 'X-Plex-Token': app.auth?.token || '' };
  if (app.source?.token && app.source.token !== app.auth?.token) headers['X-Plex-Server-Token'] = app.source.token;
  let res;
  try {
    res = await fetch('api/spotify/playlist', { method: 'POST', headers, body: JSON.stringify({ link: String(link).trim() }), credentials: 'omit', signal });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new Error('This player didn’t answer. Check it’s still running, and try again.');
  }
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* no explanation */
  }
  if (!res.ok) throw Object.assign(new Error(data.error || `The player couldn’t read it (HTTP ${res.status}).`), { status: res.status });
  const pl = data.playlist;
  if (!pl || !Array.isArray(pl.tracks)) throw new Error('The player’s answer wasn’t a playlist.');
  return pl;
}

// Versions Spotify adds to a title after " - " that the library's copy
// doesn't say ("Song - Remastered 2011", "Song - 2011 Remaster", "Song -
// Radio Edit", "Song - Mono"). Mixes and live versions stay: they're other
// recordings.
const VERSION = /\s+-\s+(?:(?:\d{4}\s+)?(?:digital(?:ly)?\s+)?remaster(?:ed)?(?:\s+\d{4})?(?:\s+version)?|\d{4}\s+version|(?:single|album|original|stereo|mono)\s+(?:version|mix|edit)|radio\s+edit|mono|stereo|bonus\s+track|explicit|clean)\s*$/i;
export const plainTitle = (title) => String(title || '').replace(VERSION, '').trim() || String(title || '');

// A playlist from Spotify as playlistio.js imports one: each track's title
// (without the version Spotify adds), its first artist (others in
// albumArtist, so either can match), its album when the page says, and its
// length.
export function spotifyEntries(pl) {
  return pl.tracks.map((t) => {
    const first = t.artists?.[0] || String(t.artist || '').split(', ')[0];
    const e = { title: plainTitle(t.title), artist: first || '', albumArtist: t.artist && t.artist !== first ? t.artist : '', album: t.album || '' };
    if (Number.isFinite(t.duration)) e.duration = t.duration;
    return e;
  });
}

// ---------- Spotify's download of your data ----------

// Spotify only lets other apps read your playlists through its developer
// programme (a Premium account, for five people at most), so its own
// download of your data is used instead: spotify.com › Account › Privacy
// settings › Download your data › Account data, which anyone can ask for. It
// comes as a ZIP of files, one for each kind of data, and only two kinds are
// wanted: Playlist1.json (with Playlist2.json and so on, for a lot of
// playlists), your playlists, and YourLibrary.json, with the
// songs you've liked. The others hold your personal details (email, date of
// birth, address, phone number, payment card, what you've searched for and
// listened to), so a file is only opened if it has one of those two names:
// any other, the ZIP included, is turned away by its name, unread. Those
// read are read here, nothing of them goes anywhere, and only each
// playlist's name and each track's title, artist and album are kept.
export const SPOTIFY_PRIVACY_URL = 'https://www.spotify.com/account/privacy/';
export const LIKED_SONGS = 'Liked Songs';
const PLAYLIST_FILE = /^Playlist(\d*)\.json$/i;
const LIBRARY_FILE = /^YourLibrary\.json$/i;

// Which of the files chosen are Spotify's playlist files, by their names
// alone: { wanted, refused: [names], zip: whether the ZIP was among them }.
export function sortSpotifyFiles(files) {
  const wanted = [];
  const refused = [];
  let zip = false;
  for (const f of files || []) {
    const name = String(f?.name || '');
    if (PLAYLIST_FILE.test(name) || LIBRARY_FILE.test(name)) wanted.push(f);
    else {
      refused.push(name);
      if (/\.zip$/i.test(name)) zip = true;
    }
  }
  return { wanted, refused, zip };
}

const fileError = (message) => Object.assign(new Error(message), { file: true });
const words = (v, n = 300) => (typeof v === 'string' ? v.slice(0, n).trim() : '');

// A track as playlistio.js looks for one: its title (without the version
// Spotify adds), artist and album. Null for one without a title.
function entryOf(title, artist, album) {
  const t = words(title);
  return t ? { title: plainTitle(t), artist: words(artist), albumArtist: '', album: words(album) } : null;
}

// A file of your own you'd added to Spotify, in a playlist: its address has
// its artist, album and title (spotify:local:Artist:Album:Title:Seconds).
function localEntry(lt) {
  const uri = typeof lt?.uri === 'string' ? lt.uri.slice(0, 1000) : '';
  const m = /^spotify:local:([^:]*):([^:]*):([^:]*):\d*$/.exec(uri);
  if (!m) return null;
  const part = (s) => {
    try {
      return decodeURIComponent(s.replace(/\+/g, ' '));
    } catch {
      return '';
    }
  };
  return entryOf(part(m[3]), part(m[1]), part(m[2]));
}

// The playlists in Spotify's playlist files (see sortSpotifyFiles): {
// playlists: [{ title, tracks: [{ title, artist, albumArtist, album }], of,
// liked, file, alone }], tooBig: [names], more, moreIn: [names], moreAlone,
// files: [names read] }. Your Liked Songs (from YourLibrary.json) come
// first, then the playlists in Spotify's order. Files come from anyone, so
// what's read is bounded (FILE_LIMITS): a file too big is passed over
// (tooBig), playlists past the most that can be read at once are only
// counted (more, in the files moreIn), and a playlist past the most tracks
// has its first ones (`of` is how many it has). Which would come over in
// full with their file chosen on its own: `alone`, for a playlist cut short
// by the most in all, and moreAlone, for those passed over (none of their
// files has more playlists than can be read at once). What isn't a track (a
// podcast episode, an audiobook) is left out. Throws (with `file`) for a
// file that isn't what its name says, or when none could be read.
export async function readSpotifyFiles(files) {
  const order = (f) => (LIBRARY_FILE.test(f.name) ? -1 : Number(PLAYLIST_FILE.exec(f.name)?.[1] || 0));
  const out = { playlists: [], tooBig: [], more: 0, moreIn: [], moreAlone: true, files: [] };
  let total = 0;
  // Each file's tracks, as they'd be read with it on its own; the playlists
  // in each; the files with playlists passed over.
  const alone = new Map();
  const lists = new Map();
  const passed = new Set();
  const take = (title, items, read, file, liked = false) => {
    if (out.playlists.length >= FILE_LIMITS.playlists) {
      out.more += 1;
      passed.add(file);
      return;
    }
    const tracks = [];
    let of = 0;
    for (const it of items) {
      const e = read(it);
      if (!e) continue;
      of += 1;
      if (tracks.length < FILE_LIMITS.tracks && total < FILE_LIMITS.total) {
        tracks.push(e);
        total += 1;
      }
    }
    const own = (alone.get(file) || 0) + Math.min(of, FILE_LIMITS.tracks);
    alone.set(file, own);
    out.playlists.push({ title, tracks, of, liked, file, alone: own <= FILE_LIMITS.total });
  };
  for (const file of [...files].sort((a, b) => order(a) - order(b))) {
    if (file.size > FILE_LIMITS.bytes) {
      out.tooBig.push(file.name);
      continue;
    }
    let data = null;
    try {
      data = JSON.parse(await file.text());
    } catch {
      data = null;
    }
    out.files.push(file.name);
    if (LIBRARY_FILE.test(file.name)) {
      if (!data || typeof data !== 'object' || !Array.isArray(data.tracks)) throw fileError(`${file.name} isn’t Spotify’s list of your library.`);
      lists.set(file.name, 1);
      take(LIKED_SONGS, data.tracks, (t) => (t && typeof t === 'object' ? entryOf(t.track, t.artist, t.album) : null), file.name, true);
      continue;
    }
    if (!data || typeof data !== 'object' || !Array.isArray(data.playlists)) throw fileError(`${file.name} isn’t one of Spotify’s playlist files.`);
    const valid = data.playlists.filter((p) => p && typeof p === 'object' && Array.isArray(p.items));
    lists.set(file.name, valid.length);
    for (const p of valid) {
      take(
        words(p.name, 200) || 'A playlist from Spotify',
        p.items,
        (it) => {
          if (!it || typeof it !== 'object') return null;
          if (it.track && typeof it.track === 'object') return entryOf(it.track.trackName, it.track.artistName, it.track.albumName);
          return it.localTrack ? localEntry(it.localTrack) : null;
        },
        file.name,
      );
    }
  }
  if (!out.playlists.length && out.tooBig.length) {
    throw fileError(`${out.tooBig.join(', ')} ${out.tooBig.length === 1 ? 'is' : 'are'} too big to be Spotify’s playlist files (over ${FILE_LIMITS.bytes / 1024 / 1024} MB).`);
  }
  out.moreIn = [...passed];
  out.moreAlone = out.moreIn.every((f) => (lists.get(f) || 0) <= FILE_LIMITS.playlists);
  return out;
}
