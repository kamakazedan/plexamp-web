// The app's MusicBrainz features, where the player has them
// (MUSICBRAINZ_ADVANCED on the container, with MUSICBRAINZ_URL): what
// MusicBrainz says of the library's artists and albums, through the
// player's service (server/musicbrainz.js), which asks MusicBrainz by
// artist, once a second at most where that's musicbrainz.org, and keeps
// what it says for a month. Only names go there: an artist's, and an
// album's title is matched on the player.
//
//   Skip live tracks and demos (mbSkipLive): left out of what the app
//     picks for you (radio and stations, shuffling an artist or the
//     library, Guest DJs), by their album's kind (Plex's, or MusicBrainz's
//     where Plex hasn't one) or their title. Never an album or playlist you
//     play yourself.
//   Missing albums (mbMissingAlbums, mbMissingKinds): on an artist's page,
//     their release groups the library doesn't have, of the kinds chosen.
//   Original release years (mbOriginalYears): an artist's albums in the
//     order they first came out, and on an album's page the year it did.
//   Other names: an artist not found by their name is looked for by the
//     other names MusicBrainz has for them (imports, and Missing tracks'
//     Check again).
//   For the server's owner, a look through the library (mbreview.js): the
//     years and genres MusicBrainz has that Plex hasn't, to fix in Plex.
import { app } from './state.js';
import { norm } from './missinglist.js';
import { RELEASE_KINDS, kindOf, plexKind } from './releases.js';

// The player has them.
export const mbFeatures = () => !!app.config.musicbrainzAdvanced;
// ...and this one's on (each is on to begin with).
export const mbOn = (setting) => mbFeatures() && app.settings[setting] !== false;

export { RELEASE_KINDS, kindOf, plexKind, firstYear, albumKey, matchGroup } from './releases.js';
export const KIND_NAMES = Object.fromEntries(RELEASE_KINDS);
// Shown to begin with among an artist's missing albums.
export const MISSING_KINDS = ['albums', 'singles', 'compilations', 'soundtracks', 'remixes'];

// ---------- with the player ----------

async function call(path, body, { signal } = {}) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Plex-Token': app.auth?.token || '' };
  if (app.source?.token && app.source.token !== app.auth?.token) headers['X-Plex-Server-Token'] = app.source.token;
  let res;
  try {
    res = await fetch(`api/musicbrainz/${path}`, { method: 'POST', headers, body: JSON.stringify(body), credentials: 'omit', signal: signal || AbortSignal.timeout(40000) });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw Object.assign(new Error('The player’s MusicBrainz features didn’t answer.'), { status: 0 });
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* empty or not JSON */
  }
  if (!res.ok) throw Object.assign(new Error(data?.error || `MusicBrainz couldn’t be asked (HTTP ${res.status}).`), { status: res.status });
  return data || {};
}

// An artist on MusicBrainz, by name (or by their MusicBrainz id, `id`,
// where Plex has it): { artist: { id, name, aliases, genres } | null,
// groups: [{ id, title, primary, secondary, date }] } (`groups`: false,
// without those), kept while the app's open (a failure isn't, to be asked
// again).
const artists = new Map();
const MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function artistOnMB(name, { groups = true, id = null } = {}) {
  const byId = MBID.test(String(id)) ? id : null;
  const key = `${groups ? 1 : 0}|${byId || norm(name)}`;
  if (!mbFeatures() || (!norm(name) && !byId)) return Promise.resolve({ artist: null, groups: [] });
  if (!artists.has(key)) {
    const job = call('artist', { name: String(name || '').slice(0, 200), groups, ...(byId ? { id: byId } : {}) }).then(
      (r) => ({ artist: r.artist || null, groups: Array.isArray(r.groups) ? r.groups : [] }),
      (err) => {
        artists.delete(key);
        throw err;
      },
    );
    artists.set(key, job);
    while (artists.size > 200) artists.delete(artists.keys().next().value);
  }
  return artists.get(key);
}

// Albums' release groups ([{ artist, title, year }]: `year`, the year Plex
// has for it, tells albums of one title apart), as far as the player knows
// them: each { id, title, primary, secondary, date, genres? }, null (not on
// MusicBrainz, or which it is can't be told) or 'pending' (being looked
// up: ask again later). `wait`: how long the player may wait for those it
// doesn't know yet (ms).
export async function albumsOnMB(items, { genres = false, wait = 0, signal } = {}) {
  if (!mbFeatures() || !items.length) return items.map(() => null);
  const out = [];
  for (let i = 0; i < items.length; i += 200) {
    const part = items.slice(i, i + 200).map((it) => ({ artist: String(it.artist || '').slice(0, 200), title: String(it.title || '').slice(0, 200), year: Number(it.year) || null }));
    const r = await call('albums', { items: part, genres, wait }, { signal });
    const results = Array.isArray(r.results) ? r.results : [];
    out.push(...part.map((_, j) => results[j] ?? null));
  }
  return out;
}

// The other names MusicBrainz has for an artist (spellings, scripts, what
// they were called before): none where it doesn't know them, or can't be
// asked. (After the player couldn't ask MusicBrainz, none for a few
// minutes: an import of many artists the library hasn't doesn't wait on it
// for each.)
const ALIASES_REST = 3 * 60000;
let aliasesRest = 0;
export async function aliasesOf(name) {
  if (!mbFeatures() || Date.now() < aliasesRest) return [];
  try {
    const { artist } = await artistOnMB(name, { groups: false });
    const want = norm(name);
    return [...new Set((artist?.aliases || []).filter((a) => norm(a) && norm(a) !== want))].slice(0, 8);
  } catch (err) {
    if (!(err?.status >= 400 && err?.status < 500) || err?.status === 429) aliasesRest = Date.now() + ALIASES_REST;
    return [];
  }
}

// ---------- live tracks and demos ----------

// A track's title that says it's live or a demo: "(Live)", "[Live at the
// Fillmore]", "- Live", "Live at…" and "Live from…" to begin with (not
// "Live in the Moment"), "(Demo)", "- Demo Version", "Early Demo", "(Rough
// Mix)".
const LIVE_TITLE = /[([]\s*live\b|\s[-–—]\s*live\b|^live (at|from)\b/i;
const DEMO_TITLE = /[([]\s*(early |rough |home )?demo\b|\s[-–—]\s*(early |rough |home )?demo\b|\b(demo|rough) (version|mix|take|recording)\b/i;
export const liveOrDemoTitle = (title) => LIVE_TITLE.test(String(title || '')) || DEMO_TITLE.test(String(title || ''));

const MB_WAIT = 1500; // how long picking waits on the player for albums it doesn't know yet

// Of tracks picked for you, those that aren't live or demos (with Skip live
// tracks and demos on): by their title, and their album's kind, Plex's
// (plex.js albumTypes) or else MusicBrainz's (those it doesn't know yet go
// by their title this time, and are looked up for next time). If that
// would leave fewer than `keep` (an artist with nothing but live albums),
// they're all kept. (Tracks as the app has them, or as Plex lists them.)
const albumOf = (t) => String(t?.albumId ?? t?.parentRatingKey ?? '');
export async function withoutLiveOrDemos(tracks, { server = app.server, keep = 1 } = {}) {
  if (!mbOn('mbSkipLive') || !tracks.length || !server) return tracks;
  const albums = new Map(); // album id -> { artist, title, year }, of a track of it
  for (const t of tracks) {
    const id = albumOf(t);
    if (id && !albums.has(id)) albums.set(id, { artist: t.albumArtist ?? t.grandparentTitle ?? '', title: t.album ?? t.parentTitle ?? '', year: t.year ?? t.parentYear ?? null });
  }
  const ids = [...albums.keys()];
  const types = await server.albumTypes(ids).catch(() => ids.map(() => null));
  const kinds = new Map();
  const ask = [];
  ids.forEach((id, i) => {
    const k = types[i] ? plexKind(types[i]) : null;
    const { artist, title, year } = albums.get(id);
    // (Not Various Artists': theirs is everyone's, and MusicBrainz has too
    // many to look through.)
    if (k) kinds.set(id, k);
    else if (types[i] && artist && title && norm(artist) !== 'various artists') ask.push({ id, artist, title, year });
  });
  if (ask.length) {
    const groups = await albumsOnMB(ask, { wait: MB_WAIT }).catch(() => []);
    ask.forEach((a, i) => {
      const g = groups[i];
      if (g && typeof g === 'object') kinds.set(a.id, kindOf(g.primary, g.secondary));
    });
  }
  const out = tracks.filter((t) => {
    const k = kinds.get(albumOf(t));
    return k !== 'live' && k !== 'demos' && !liveOrDemoTitle(t?.title);
  });
  return out.length >= Math.min(keep, tracks.length) ? out : tracks;
}
