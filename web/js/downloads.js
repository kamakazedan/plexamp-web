// Downloads: playlists kept on the phone, in the Android app (plexamp-web for
// Android, whose page bridge gives this page plexampAndroid.downloads: see
// docs/android-app.md). The app downloads them, keeps them up to date with
// the server (on Wi-Fi, or mobile data too, as Settings › Downloads says),
// and answers for their files at this page's own address. This page shows
// them (views/downloads.js), adds and removes them, and plays from them as
// Play downloads says: always, on mobile data, or only offline (and always,
// whatever it says, when the server can't be reached).
//
// In a browser there's none of it: downloadsHere() is false, and nothing
// here does anything.
//
// The app's told the server, and the sign-in to it, each time the page
// opens (and as they change), so it can keep downloads up to date with the
// page closed; signing out (or switching to someone else in your Plex Home)
// tells it to forget them, files and sign-in.
//
// Each server's are kept apart (an app from 0.3.0 on): this server's, kept
// up to date, and each other server's, as they were when you were last on
// it. Those play from the phone here too, as tracks of their own (see
// phoneTracks), which this server never hears of.
import { app, on, proxyUri } from './state.js';
import { defaultDeviceName, normTrack } from './plex.js';
import { connection } from './connection.js';
import { debugLog } from './debug.js';

const bridge = () => window.plexampAndroid?.downloads || null;

// Change events: 'change' once what the app says changes.
export const downloads = new EventTarget();

let told = null; // as the app last said: see Downloads.kt state()
let state = null; // the same, as this server's: its playlists and tracks, and the app's settings and space
let saved = new Set(); // the ids of this server's tracks on the phone
let others = []; // each other server's: { server, name, playlists, saved, syncedAt }
const unplayable = new Set(); // downloaded tracks that wouldn't play here this time (see notPlayable)

// Whether downloads can be had here: in the Android app, signed in with
// Plex (not the offline password, whose sign-in can't reach the server).
export const downloadsHere = () => !!bridge() && !!app.auth?.token && !app.auth.offline;

export const downloadState = () => state;

// Whether this is the Android app, which keeps downloads (whatever the
// sign-in: offline, they still play).
export const keepsDownloads = () => !!bridge();

// Whether a playlist of this server's is on the phone.
export const isDownloaded = (playlistId) => !!state?.playlists?.some((p) => p.id === String(playlistId));

// A playlist on the phone in full: every track of it, as the app last found
// it on the server.
export const complete = (p) => p.tracks > 0 && p.saved >= p.tracks;
export const downloadedInFull = (playlistId, server = null) => {
  const list = server ? otherServer(server)?.playlists : state?.playlists;
  const p = list?.find((x) => x.id === String(playlistId));
  return !!p && complete(p);
};

// Whether anything's on the phone: this server's, or another's.
export const hasDownloads = () => !!state?.playlists?.length || others.length > 0;

// Each other server's downloads: [{ server, name, playlists, syncedAt }], by
// name (null where the app hasn't been told it yet).
export const otherDownloads = () => others;
export const otherServer = (server) => others.find((o) => o.server === String(server)) || null;

function took(next) {
  if (!next || typeof next !== 'object') return;
  told = next;
  sort();
  downloads.dispatchEvent(new Event('change'));
}

// What the app said, as this server's and the others'. It says the server
// it keeps up to date at the top, and the rest apart; one from before 0.3.0
// says one server's, at the top. The top's this server's but where it's
// another's: the app not told of this one yet, as the player's just
// switched (then this one's are among the rest, if any are there).
function sort() {
  const next = told;
  if (!next) {
    state = null;
    saved = new Set();
    others = [];
    return;
  }
  const mine = app.source?.serverId || null;
  const top = { server: typeof next.server === 'string' ? next.server : null, name: next.name, playlists: next.playlists, tracks: next.tracks, syncedAt: next.syncedAt };
  const rest = (Array.isArray(next.others) ? next.others : []).filter((o) => o && typeof o.server === 'string');
  const topIsMine = !top.server || top.server === mine;
  const here = topIsMine ? top : rest.find((o) => o.server === mine) || {};
  state = {
    ...next,
    playlists: here.playlists || [],
    tracks: here.tracks || [],
    syncedAt: here.syncedAt || 0,
    // (What it's doing is for the server it keeps up to date.)
    status: topIsMine ? next.status : { state: 'idle' },
  };
  saved = new Set(state.tracks.map(String));
  others = [top, ...rest]
    .filter((o) => o !== here && o.server && o.server !== mine && o.playlists?.length)
    .map((o) => ({
      server: o.server,
      name: typeof o.name === 'string' && o.name.trim() ? o.name.trim() : null,
      playlists: o.playlists,
      saved: new Set((o.tracks || []).map(String)),
      syncedAt: o.syncedAt || 0,
    }));
}

// Asks the app: what it answers is its state, taken in as it comes.
async function ask(op, ...args) {
  const b = bridge();
  if (!b) throw Object.assign(new Error('Downloads are only in the Android app.'), { code: 'gone' });
  took(await b[op](...args));
  return state;
}

// Once, at start (app.js), signed in: what's downloaded, the account for
// the app, and kept so as it changes.
let started = false;
export function startDownloads() {
  const b = bridge();
  if (!b || started) return;
  started = true;
  b.watch(took);
  if (downloadsHere()) sendAccount();
  on('source', () => {
    // (Another server's at once: what's this one's, and what's another's.)
    sort();
    downloads.dispatchEvent(new Event('change'));
    if (downloadsHere()) sendAccount();
  });
  // Signing out, or switching to someone else: the files and the sign-in go.
  on('signing-out', () => {
    told = null;
    sort();
    b.forget().catch(() => {});
  });
}

// The server, the sign-in to it, and every address it has (the one in use
// first, then the rest as plex.tv listed them, this player's own /pms/ and
// the relay last): the app tries each, as it was where it is.
function sendAccount() {
  const src = app.source;
  if (!src?.serverId || !src.token) return;
  const conns = src.connections || [];
  const uris = [src.uri, ...conns.filter((c) => !c.relay).map((c) => c.uri), proxyUri(), ...conns.filter((c) => c.relay).map((c) => c.uri)].filter(Boolean);
  bridge()
    .account({
      serverId: src.serverId,
      serverName: src.serverName || null,
      token: src.token,
      user: app.auth?.username || '',
      uris,
      device: app.settings.playerName || defaultDeviceName(),
    })
    .then(took)
    .catch((err) => debugLog('downloads', `the app didn’t take the server’s details (${err?.code || err?.message})`, 'warn'));
}

// (With the server they're from: the app takes none from another server
// than it's keeping up to date.)
export const addDownload = (playlistId) => ask('add', String(playlistId), app.source?.serverId);
export const removeDownload = (playlistId, server = app.source?.serverId) => ask('remove', String(playlistId), server);
export const setDownloads = (patch) => ask('set', patch);
export const refreshDownloads = () => ask('state');

// Has the app check for changes now (Settings › Downloads' "Up to date",
// tapped), where it can (an app from before 0.2.3 can't).
export const canCheckDownloads = () => typeof bridge()?.check === 'function';
export const checkDownloads = () => ask('check');

// A playlist as it was downloaded: { playlist, items } (Plex's own JSON for
// it and its tracks, as the server last gave them), or null. `server`:
// another server's.
export async function downloadedPlaylist(id, server = null) {
  const b = bridge();
  if (!b || !(server ? otherServer(server)?.playlists.some((p) => p.id === String(id)) : isDownloaded(id))) return null;
  try {
    const res = await fetch(b.playlistUrl(String(id), server || app.source?.serverId), { cache: 'no-store' });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

// ---------- another server's ----------

// Another server's tracks, from a playlist as it was downloaded, as the
// player plays them: from the phone, whatever Play downloads says. Each id
// is its server's and its own (`${server}:${ratingKey}`), so it's never
// taken for this server's track of the same number, and nothing that would
// ask this server about it (its artist and album, its file, its cover) is
// there: it carries its server (`server`) and its own id there (`rk`).
export function phoneTracks(kept, server) {
  return (kept?.items || [])
    .filter((m) => m?.type === 'track' && m.ratingKey != null)
    .map(normTrack)
    .map((t) => ({ ...t, id: `${server}:${t.id}`, rk: t.id, server, artistId: null, albumId: null, partKey: null, thumb: phoneThumb(server, t.thumb) }));
}

// Whether a track is another server's, played from the phone (see
// phoneTracks): nothing goes to this server about it.
export const phoneOnly = (track) => !!track?.server;

// Whether what's playing is from another server's playlist on the phone
// (its page, #/downloads/<server>/<id>, being where it's from).
export const phoneContext = (context) => typeof context?.href === 'string' && context.href.startsWith('/downloads/');

// Its cover, as such a track carries it: shown from the phone (see ui.js
// art), never asked of this server.
const PHONE_THUMB = 'phone:';
const phoneThumb = (server, path) => (typeof path === 'string' && path.startsWith('/') ? `${PHONE_THUMB}${server}:${path}` : null);

// Another server's cover (a playlist's, say), by that server's name for it:
// as such a track carries it, for art() (see ui.js).
export const phonePicture = (path, server) => phoneThumb(server, path);

// Where a cover such a track carries is on the phone: its address, '' where
// it can't be had, or null for any other picture.
export function phoneThumbUrl(thumb) {
  if (typeof thumb !== 'string' || !thumb.startsWith(PHONE_THUMB)) return null;
  const rest = thumb.slice(PHONE_THUMB.length);
  const at = rest.indexOf(':');
  return (at > 0 && bridge()?.coverUrl(rest.slice(at + 1), rest.slice(0, at))) || '';
}

// ---------- playing them ----------

// On mobile data: as the app says (Android knows), or as the browser does.
const onMobileData = () => (typeof state?.metered === 'boolean' ? state.metered : navigator.connection?.type === 'cellular');

// Whether the server can't be reached now, as far as the app knows.
export const offlineNow = () => connection.lost || navigator.onLine === false;

// Whether a track's downloaded, and plays from the phone where it has to
// (offline, whatever Play downloads says): another server's too.
export function playableHere(track) {
  if (!track?.id || unplayable.has(String(track.id)) || !bridge()) return false;
  if (!phoneOnly(track)) return saved.has(String(track.id));
  const from = track.server === app.source?.serverId ? saved : otherServer(track.server)?.saved;
  return !!from?.has(String(track.rk));
}

// Where another server's track is on the phone, even where it isn't there
// any more (or this isn't the phone): asked for, it's not found, and the
// player skips it. Never this server.
export function phoneUrl(track) {
  const there = localUrl(track);
  if (there) return there;
  const u = new URL(`__plexamp-web-android/downloads/track/${encodeURIComponent(String(track.rk))}`, document.baseURI);
  u.searchParams.set('server', String(track.server));
  return u.href;
}

// Where a track plays from the phone now, or null: downloaded, and Play
// downloads says so (or the server can't be reached). Another server's,
// always (it can't be had otherwise).
export function localUrl(track) {
  if (!playableHere(track)) return null;
  if (phoneOnly(track)) return bridge().trackUrl(String(track.rk), track.server);
  const prefer = state?.settings?.prefer || 'always';
  const now = prefer === 'always' || offlineNow() || (prefer === 'mobile' && onMobileData());
  return now ? bridge().trackUrl(String(track.id), app.source?.serverId) : null;
}

export const isLocal = (url) => typeof url === 'string' && url.includes('/__plexamp-web-android/downloads/');

// A downloaded track that didn't play from the phone (damaged, say): from
// the server instead, this time, and the app downloads it again.
export function notPlayable(track) {
  const id = String(track.id);
  unplayable.add(id);
  // (Another server's can't be downloaded again from here: it's skipped.)
  if (phoneOnly(track)) {
    debugLog('downloads', `“${track.title}” (another server’s) didn’t play from the phone: skipped`, 'warn');
    return;
  }
  debugLog('downloads', `“${track.title}” didn’t play from the phone: from the server, and downloaded again`, 'warn');
  bridge()
    ?.bad(id, app.source?.serverId)
    .then(took)
    .catch(() => {});
}

// Where an album's cover is on the phone (downloaded with its tracks), by
// the server's name for it, or null where nothing's downloaded. (One that
// isn't there isn't found, as a picture the server hasn't got isn't: see
// ui.js art.) `server`: another server's.
export function phoneCover(path, server = null) {
  if (typeof path !== 'string' || !path.startsWith('/')) return null;
  if (server ? !otherServer(server) : !state?.playlists?.length) return null;
  return bridge()?.coverUrl(path, server || app.source?.serverId) || null;
}

// ---------- sizes ----------

// "1.2 GB", "340 MB": in the units phones' own storage settings use.
export function bytesText(n) {
  const v = Math.max(0, Number(n) || 0);
  const units = [
    [1e12, 'TB'],
    [1e9, 'GB'],
    [1e6, 'MB'],
    [1e3, 'KB'],
  ];
  for (const [size, unit] of units) {
    if (v >= size) {
      const x = v / size;
      return `${x < 10 ? Math.round(x * 10) / 10 : Math.round(x)} ${unit}`;
    }
  }
  return `${Math.round(v)} bytes`;
}
