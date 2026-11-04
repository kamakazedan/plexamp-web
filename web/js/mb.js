// The app's MusicBrainz features, where the player has them
// (MUSICBRAINZ_ADVANCED on the container, with MUSICBRAINZ_URL): what
// MusicBrainz says of the library's artists and albums, through the
// player's service (server/musicbrainz.js), which asks MusicBrainz by
// artist, once a second at most where that's musicbrainz.org, and keeps
// what it says for a month. Only names go there: an artist's (or Plex's
// MusicBrainz id for them), and an album's title, and Plex's id for it,
// are matched on the player. None of them changes what Plex
// says of the library (which kind an album is, on an artist's page, is
// Plex's alone): they only add to it.
//
//   Skip live tracks and demos (skipLive, Settings › Playback, for
//     everyone; on to begin with where the player has these, mbSkipLive):
//     left out of what the app picks for you (radio and stations,
//     shuffling an artist or the library, Guest DJs), by their album's
//     kind (Plex's, or, with these, MusicBrainz's where Plex hasn't one)
//     or their title. Never an album or playlist you play yourself.
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
import { RELEASE_KINDS, kindOf, plexKind, shortRelease, versionedTracks, placeholderArtist } from './releases.js';
import { serviceFetch } from './service.js';

// The player has them.
export const mbFeatures = () => !!app.config.musicbrainzAdvanced;
// ...with a MusicBrainz of its own (a mirror), which albums are looked up on
// too, by their tracks (see albumsOnMB, `check`): musicbrainz.org is asked
// about artists alone.
export const mbOwnServer = () => mbFeatures() && app.config.musicbrainz === 'own';
// ...and this one's on (each is on to begin with).
export const mbOn = (setting) => mbFeatures() && app.settings[setting] !== false;
// Skip live tracks and demos (Settings › Playback): on where it's been
// turned on, or, where the player has the MusicBrainz features, unless
// it's been turned off (as it was on to begin with, with those).
export const skipLiveOn = () => app.settings.skipLive === true || mbOn('mbSkipLive');

export { RELEASE_KINDS, kindOf, plexKind, firstYear, albumKey, matchGroup, sameTitle, apartFromNamesakes, exactAlbum, shortRelease, kindsAgree, placeholderArtist } from './releases.js';
export const KIND_NAMES = Object.fromEntries(RELEASE_KINDS);
// Shown to begin with among an artist's missing albums.
export const MISSING_KINDS = ['albums', 'singles', 'compilations', 'soundtracks', 'remixes'];

// ---------- with the player ----------

// The player's MusicBrainz features are asked PER_MINUTE times a minute at
// most from this tab (the player takes 120 a minute from each account), and,
// once the player's said it's had too many (429), not again till it says
// (its Retry-After), then asked again, twice at most. A page looking through
// the library (`background`: Years and genres, Artists to merge) asks while
// fewer than BACKGROUND_PER_MINUTE have gone in the last minute, so what
// someone's waiting on always has room; and what can do without (`now`: a
// shuffle's or a radio's live tracks and demos, an import's other names)
// never waits for a turn: without one, it's turned away at once, and goes
// without.
const PER_MINUTE = 90;
const BACKGROUND_PER_MINUTE = 60;
const asked = []; // when the last ones were asked (performance.now()), oldest first
let notBefore = 0;
// (Its watch on `signal` goes with it: a long look through the library
// waits many times on one signal.)
const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    let timer = 0;
    const stop = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', stop);
      resolve();
    }, ms);
    signal?.addEventListener('abort', stop, { once: true });
  });
const busy = (wait) => Object.assign(new Error('MusicBrainz is busy just now.'), { status: 429, mb: true, retryAfter: Math.max(1, Math.ceil(wait / 1000)) });
async function myTurn(signal, { background = false, now = false } = {}) {
  const most = background ? BACKGROUND_PER_MINUTE : PER_MINUTE;
  for (;;) {
    const t = performance.now();
    while (asked.length && t - asked[0] >= 60000) asked.shift();
    // (Till fewer than `most` were asked in the last minute.)
    const wait = Math.max(notBefore - t, asked.length >= most ? asked[asked.length - most] + 60000 - t : 0);
    if (wait <= 0) {
      asked.push(t);
      return;
    }
    if (now) throw busy(wait);
    await sleep(Math.min(wait, 5000), signal);
  }
}

// (Asked with who's asking, as the player checks them for its shared AI
// model: see service.js. Not waited on for longer than MB_TIMEOUT.)
const MB_TIMEOUT = 40000;
async function call(path, body, { signal, background = false, now = false } = {}) {
  for (let tries = 0; ; tries += 1) {
    await myTurn(signal, { background, now });
    let res;
    try {
      res = await serviceFetch(`api/musicbrainz/${path}`, { method: 'POST', body, signal, timeout: MB_TIMEOUT, server: true });
    } catch (err) {
      if (signal?.aborted) throw err;
      throw Object.assign(new Error('The player’s MusicBrainz features didn’t answer.'), { status: 0 });
    }
    if (res.status === 429) {
      const secs = Number(res.headers.get('retry-after')) || 30;
      notBefore = Math.max(notBefore, performance.now() + Math.min(300, Math.max(1, secs)) * 1000);
      if (tries < 2 && !now) continue;
    }
    const { data } = res;
    if (!res.ok) {
      throw Object.assign(new Error(data?.error || `MusicBrainz couldn’t be asked (HTTP ${res.status}).`), {
        status: res.status,
        mb: true,
        retryAfter: Number(res.headers.get('retry-after')) || null,
        searchBroken: data?.searchBroken === true,
      });
    }
    return data || {};
  }
}

// An artist on MusicBrainz, by name (or by their MusicBrainz id, `id`,
// where Plex has it): { artist: { id, name, aliases, genres, note? } | null,
// groups: [{ id, title, primary, secondary, date }], capped, namesakes,
// moreNamesakes } (`groups`: false, without those; `namesakes`: true, with
// the other artists of the name too, [{ id, name, note, groups }]: see
// apartFromNamesakes, and `moreNamesakes` where MusicBrainz has more of the
// name than those; `note`: with MusicBrainz's word for telling the artist
// apart from others of the name), kept while the app's open (a failure
// isn't, to be asked again).
const artists = new Map();
const MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// An artist's or an album's MusicBrainz id, where Plex has it (its Guid,
// asked for with includeGuids).
export const mbidOf = (item) =>
  (Array.isArray(item?.Guid) ? item.Guid : [])
    .map((g) => String(g?.id || ''))
    .find((g) => /^mbid:\/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(g))
    ?.slice(7) || null;
export function artistOnMB(name, { groups = true, id = null, namesakes = false, background = false, now = false, note = false } = {}) {
  const byId = MBID.test(String(id)) ? id : null;
  const key = `${groups ? 1 : 0}|${namesakes ? 1 : 0}|${note ? 1 : 0}|${byId || norm(name)}`;
  if (!mbFeatures() || (!norm(name) && !byId)) return Promise.resolve({ artist: null, groups: [], capped: false, namesakes: [], moreNamesakes: false });
  // (One a page looking through the library is still waiting on isn't
  // shared with someone waiting themselves: they ask for it on their own.)
  const had = artists.get(key);
  if (!had || (had.background && !background && !had.done)) {
    const job = call('artist', { name: String(name || '').slice(0, 200), groups, ...(byId ? { id: byId } : {}), ...(namesakes ? { namesakes: true } : {}), ...(note ? { note: true } : {}) }, { background, now }).then(
      (r) => ({
        artist: r.artist || null,
        groups: Array.isArray(r.groups) ? r.groups : [],
        capped: r.capped === true,
        namesakes: Array.isArray(r.namesakes) ? r.namesakes : [],
        moreNamesakes: r.moreNamesakes === true,
      }),
      (err) => {
        if (artists.get(key) === job) artists.delete(key);
        throw err;
      },
    );
    job.background = background;
    job.then(
      () => (job.done = true),
      () => {},
    );
    artists.set(key, job);
    while (artists.size > 200) artists.delete(artists.keys().next().value);
  }
  return artists.get(key);
}

const ALBUMS_ASKED = 200; // albums to a request, at most (as the player takes them)...
const ALBUMS_BYTES = 160 * 1024; // ...and its size, at most (the player takes 256 KB)

// Albums' release groups ([{ artist, title, year, artistId, albumId,
// tracks }]: `year`, the year Plex has for it, tells albums of one title
// apart; `artistId` and `albumId`, the artist's and the album's MusicBrainz
// ids where Plex has them, find them without a search; `tracks`, how many
// Plex has of it, for `strict`), as far as the player
// knows them: each { id, title, primary, secondary, date, genres? }, null
// (not on MusicBrainz, or which it is can't be told), 'pending' (being
// looked up: ask again later) or 'unchecked' (only a search could find it,
// and searching the player's MusicBrainz finds no one: the list's
// `searchBroken`). `wait`: how long the player may wait for those it
// doesn't know yet (ms). `strict`: the very album or nothing, for its year
// or genres to be shown or fixed (Plex's id for it, where its title agrees,
// or else, for a studio album, its exact title: see releases.js
// exactAlbum). `check`, on a MusicBrainz of the player's own (mbOwnServer):
// by its very tracks too (`trackList`: [{ title, ms }]), the first of its
// releases with them (see server/musicbrainz.js checkedAlbum); without its
// tracks, what's to be checked (`toCheck`).
export async function albumsOnMB(items, { genres = false, wait = 0, signal, background = false, now = false, strict = false, check = false } = {}) {
  if (!mbFeatures() || !items.length) return items.map(() => null);
  const out = [];
  const asked = items.map((it) => ({
    artist: String(it.artist || '').slice(0, 200),
    title: String(it.title || '').slice(0, 200),
    year: Number(it.year) || null,
    ...(MBID.test(String(it.artistId)) ? { artistId: it.artistId } : {}),
    ...(MBID.test(String(it.albumId)) ? { albumId: it.albumId } : {}),
    ...(Number(it.tracks) > 0 ? { tracks: Math.floor(Number(it.tracks)) } : {}),
    ...(check && Array.isArray(it.trackList) ? { trackList: it.trackList.slice(0, 200).map((t) => ({ title: String(t?.title || '').slice(0, 200), ms: Math.max(0, Math.round(Number(t?.ms) || 0)) })) } : {}),
  }));
  const how = { genres, wait, ...(strict ? { strict: true } : {}), ...(check ? { check: true } : {}) };
  // A request at a time of ALBUMS_ASKED at most, and of no more than
  // ALBUMS_BYTES (albums with their tracks: fewer to a request). One the
  // player says is too large anyway is asked about in halves; an album too
  // large alone isn't on MusicBrainz, as far as this goes.
  const ask = async (part) => {
    try {
      const r = await call('albums', { items: part, ...how }, { signal, background, now });
      const results = Array.isArray(r.results) ? r.results : [];
      return { results: part.map((_, j) => results[j] ?? null), searchBroken: r.searchBroken === true };
    } catch (err) {
      if (err?.status !== 413) throw err;
      if (part.length === 1) return { results: [null], searchBroken: false };
      const half = Math.ceil(part.length / 2);
      const a = await ask(part.slice(0, half));
      const b = await ask(part.slice(half));
      return { results: [...a.results, ...b.results], searchBroken: a.searchBroken || b.searchBroken };
    }
  };
  const size = new TextEncoder();
  for (let i = 0; i < asked.length; ) {
    const part = [];
    let bytes = 0;
    while (i < asked.length && part.length < ALBUMS_ASKED) {
      const n = size.encode(JSON.stringify(asked[i])).length + 1;
      if (part.length && bytes + n > ALBUMS_BYTES) break;
      part.push(asked[i]);
      bytes += n;
      i += 1;
    }
    const r = await ask(part);
    out.push(...r.results);
    if (r.searchBroken) out.searchBroken = true;
  }
  return out;
}

const TRACK_READS = 4; // at once
let trackReads = 0;
const trackReadsWaiting = [];
function readTracks(server, id) {
  return new Promise((resolve, reject) => {
    const go = () => {
      trackReads += 1;
      server
        .children(id)
        .then(resolve, reject)
        .finally(() => {
          trackReads -= 1;
          trackReadsWaiting.shift()?.();
        });
    };
    if (trackReads < TRACK_READS) go();
    else trackReadsWaiting.push(go);
  });
}

// An album's tracks as Plex has them, for MusicBrainz's to be compared with:
// [{ title, ms }], read from Plex a few at a time, kept while the app's
// open (where they can't be read: rejected, and read again next time).
const tracksRead = new Map(); // server|album id -> Promise<[{ title, ms }]>
export function albumTracks(album, { server = app.server } = {}) {
  const key = `${app.source?.serverId || ''}|${album?.ratingKey}`;
  if (!tracksRead.has(key)) {
    const job = readTracks(server, album.ratingKey).then(
      (list) => (Array.isArray(list) ? list : []).filter((t) => t?.type === 'track' || t?.title).map((t) => ({ title: String(t.title || ''), ms: Number(t.duration) || 0 })),
      (err) => {
        if (tracksRead.get(key) === job) tracksRead.delete(key);
        throw err;
      },
    );
    tracksRead.set(key, job);
    while (tracksRead.size > 5000) tracksRead.delete(tracksRead.keys().next().value);
  }
  return tracksRead.get(key);
}

// Whether a short album's tracks say it's another recording than the
// release group of its title (releases.js versionedTracks: its one track
// "Yeah Yeah (Chocolate Puma Remix)", of "Yeah Yeah"), whose first year is
// then the original's, not its own: looked at only for a short one
// (releases.js shortRelease), its tracks (`tracks`, where they're to hand)
// read from Plex otherwise (see albumTracks).
// Where they can't be read, it's taken as another (and read again next
// time): nothing's said of it.
export function notThatRecording(album, g, { server = app.server, tracks = null } = {}) {
  if (!album || !g || !shortRelease(tracks ? tracks.length : album.leafCount, g)) return Promise.resolve(false);
  if (tracks) return Promise.resolve(versionedTracks(album.title, tracks.map((t) => t?.title)));
  return albumTracks(album, { server }).then(
    (list) => versionedTracks(album.title, list.map((t) => t.title)),
    () => true,
  );
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
    const { artist } = await artistOnMB(name, { groups: false, now: true });
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
// (plex.js albumTypes) or else, with the MusicBrainz features,
// MusicBrainz's (those it doesn't know yet go by their title this time,
// and are looked up for next time). If that would leave fewer than `keep`
// (an artist with nothing but live albums), they're all kept. (Tracks as
// the app has them, or as Plex lists them.)
const albumOf = (t) => String(t?.albumId ?? t?.parentRatingKey ?? '');
export async function withoutLiveOrDemos(tracks, { server = app.server, keep = 1 } = {}) {
  if (!skipLiveOn() || !tracks.length || !server) return tracks;
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
    else if (mbFeatures() && types[i] && artist && title && !placeholderArtist(artist)) ask.push({ id, artist, title, year });
  });
  if (ask.length) {
    const groups = await albumsOnMB(ask, { wait: MB_WAIT, now: true }).catch(() => []);
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
