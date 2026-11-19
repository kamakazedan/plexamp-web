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
import { app, on, proxyUri } from './state.js';
import { defaultDeviceName } from './plex.js';
import { connection } from './connection.js';
import { debugLog } from './debug.js';

const bridge = () => window.plexampAndroid?.downloads || null;

// Change events: 'change' once what the app says changes.
export const downloads = new EventTarget();

let state = null; // as the app last said: see Downloads.kt state()
let saved = new Set(); // the ids of tracks on the phone
const unplayable = new Set(); // downloaded tracks that wouldn't play here this time (see notPlayable)

// Whether downloads can be had here: in the Android app, signed in with
// Plex (not the offline password, whose sign-in can't reach the server).
export const downloadsHere = () => !!bridge() && !!app.auth?.token && !app.auth.offline;

export const downloadState = () => state;

// Whether this is the Android app, which keeps downloads (whatever the
// sign-in: offline, they still play).
export const keepsDownloads = () => !!bridge();

export const isDownloaded = (playlistId) => !!state?.playlists?.some((p) => p.id === String(playlistId));

// A playlist on the phone in full: every track of it, as the app last found
// it on the server.
export const complete = (p) => p.tracks > 0 && p.saved >= p.tracks;
export const downloadedInFull = (playlistId) => {
  const p = state?.playlists?.find((x) => x.id === String(playlistId));
  return !!p && complete(p);
};

export const hasDownloads = () => !!state?.playlists?.length;

function took(next) {
  if (!next || typeof next !== 'object') return;
  state = next;
  saved = new Set((next.tracks || []).map(String));
  downloads.dispatchEvent(new Event('change'));
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
  on('source', () => downloadsHere() && sendAccount());
  // Signing out, or switching to someone else: the files and the sign-in go.
  on('signing-out', () => {
    state = null;
    saved = new Set();
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
    .account({ serverId: src.serverId, token: src.token, user: app.auth?.username || '', uris, device: app.settings.playerName || defaultDeviceName() })
    .then(took)
    .catch((err) => debugLog('downloads', `the app didn’t take the server’s details (${err?.code || err?.message})`, 'warn'));
}

export const addDownload = (playlistId) => ask('add', String(playlistId));
export const removeDownload = (playlistId) => ask('remove', String(playlistId));
export const setDownloads = (patch) => ask('set', patch);
export const refreshDownloads = () => ask('state');

// Has the app check for changes now (Settings › Downloads' "Up to date",
// tapped), where it can (an app from before 0.2.3 can't).
export const canCheckDownloads = () => typeof bridge()?.check === 'function';
export const checkDownloads = () => ask('check');

// A playlist as it was downloaded: { playlist, items } (Plex's own JSON for
// it and its tracks, as the server last gave them), or null.
export async function downloadedPlaylist(id) {
  const b = bridge();
  if (!b || !isDownloaded(id)) return null;
  try {
    const res = await fetch(b.playlistUrl(String(id)), { cache: 'no-store' });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

// ---------- playing them ----------

// On mobile data: as the app says (Android knows), or as the browser does.
const onMobileData = () => (typeof state?.metered === 'boolean' ? state.metered : navigator.connection?.type === 'cellular');

// Whether the server can't be reached now, as far as the app knows.
export const offlineNow = () => connection.lost || navigator.onLine === false;

// Whether a track's downloaded, and plays from the phone where it has to
// (offline, whatever Play downloads says).
export const playableHere = (track) => !!track?.id && saved.has(String(track.id)) && !unplayable.has(String(track.id)) && !!bridge();

// Where a track plays from the phone now, or null: downloaded, and Play
// downloads says so (or the server can't be reached).
export function localUrl(track) {
  if (!playableHere(track)) return null;
  const prefer = state?.settings?.prefer || 'always';
  const now = prefer === 'always' || offlineNow() || (prefer === 'mobile' && onMobileData());
  return now ? bridge().trackUrl(String(track.id)) : null;
}

export const isLocal = (url) => typeof url === 'string' && url.includes('/__plexamp-web-android/downloads/');

// A downloaded track that didn't play from the phone (damaged, say): from
// the server instead, this time, and the app downloads it again.
export function notPlayable(track) {
  const id = String(track.id);
  unplayable.add(id);
  debugLog('downloads', `“${track.title}” didn’t play from the phone: from the server, and downloaded again`, 'warn');
  bridge()
    ?.bad(id)
    .then(took)
    .catch(() => {});
}

// Where an album's cover is on the phone (downloaded with its tracks), by
// the server's name for it, or null where nothing's downloaded. (One that
// isn't there isn't found, as a picture the server hasn't got isn't: see
// ui.js art.)
export const phoneCover = (path) => (hasDownloads() && typeof path === 'string' && path.startsWith('/') ? bridge()?.coverUrl(path) || null : null);

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
