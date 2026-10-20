// What a track appears in (the "Appears in" page): the albums the song is
// on, your playlists, and collections.
//
// Plex can't be asked which lists hold a track, so each list's contents are
// read, a page at a time, and kept until the list changes (Plex says when it
// last did), so looking again is quick. Smart lists follow their rules and
// change without saying so: they're read again after a minute. Very long
// smart playlists aren't read: one whose rules take in a whole library (a
// playlist of everything) holds every track there, which its rules say
// without reading it; any other is left out, and the page says so.
//
// Plex doesn't link the same song on different albums either, so they're
// found by the song's name and artist.
import { app, on } from './state.js';
import { norm, sameTitle } from './ai.js';

export const SMART_LIMIT = 2000; // smart lists longer than this aren't read
export const LIST_LIMIT = 10000; // nor are other lists longer than this
const PAGE = 500;
const SMART_TTL = 60000;
const CACHE_LIMIT = 100000; // track ids kept, over all lists

let cache = new Map(); // `${server}|${kind}|${id}` -> { stamp, at, counts: Map(track id -> times) }
let cached = 0;
const forget = () => {
  cache = new Map();
  cached = 0;
};
on('source', forget);
on('signout', forget);

const stampOf = (list) => `${list.updatedAt || 0}|${list.leafCount ?? list.childCount ?? ''}`;
// How many entries a list has, or NaN if Plex didn't say.
const sizeOf = (list) => Number(list.leafCount ?? list.childCount);

async function contents(kind, list, signal) {
  const s = app.server;
  const key = `${s.uri}|${kind}|${list.ratingKey}`;
  const stamp = stampOf(list);
  const hit = cache.get(key);
  if (hit && hit.stamp === stamp && (!list.smart || Date.now() - hit.at < SMART_TTL)) {
    cache.delete(key);
    cache.set(key, hit); // most recently used last
    return hit.counts;
  }
  const counts = new Map();
  for (let start = 0; start < LIST_LIMIT; start += PAGE) {
    if (signal?.aborted) throw Object.assign(new Error('aborted'), { aborted: true });
    const page = kind === 'playlist' ? await s.playlistItems(list.ratingKey, { start, size: PAGE }) : await s.collectionItems(list.ratingKey, { start, size: PAGE });
    for (const m of page.items) {
      const id = String(m.ratingKey);
      counts.set(id, (counts.get(id) || 0) + 1);
    }
    if (page.items.length < PAGE || (page.total && start + page.items.length >= page.total)) break;
  }
  if (hit) cached -= hit.counts.size;
  cache.delete(key);
  cache.set(key, { stamp, at: Date.now(), counts });
  cached += counts.size;
  while (cached > CACHE_LIMIT && cache.size > 1) {
    const [k, v] = cache.entries().next().value;
    cache.delete(k);
    cached -= v.counts.size;
  }
  return counts;
}

async function eachLimited(items, limit, fn) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

// ---------- smart playlists ----------

// Query keys that shape a smart playlist without narrowing what's in it.
const SHAPING = new Set(['type', 'sort', 'push', 'pop', 'and', 'or']);

// A smart playlist's rules, from the address Plex keeps them in (its
// `content`: "library://…/directory//library/sections/1/all?type=10&…", the
// path escaped): which library section, the type of item, and whether
// anything narrows it (a filter or a limit). Null if they can't be read.
export function smartRules(content) {
  let text = String(content || '');
  if (!text) return null;
  try {
    text = decodeURIComponent(text);
  } catch {
    return null;
  }
  const m = text.match(/\/library\/sections\/(\d+)\/all(?:\?([^#]*))?$/);
  if (!m) return null;
  let type = '';
  let narrowed = false;
  for (const [k, v] of new URLSearchParams(m[2] || '')) {
    if (k === 'type') type = v;
    else if (!SHAPING.has(k) && !/^include/i.test(k) && !/^X-Plex-/i.test(k)) narrowed = true;
  }
  return { section: m[1], type, narrowed };
}

// What a smart playlist's rules say about a track in a library section,
// without reading the playlist (its rules are read from Plex if the listing
// didn't have them): 'all' (every track there is in it), 'none' (it's of
// another library) or 'unknown'.
async function byRules(list, section) {
  const content = list.content || (await app.server.playlist(list.ratingKey).catch(() => null))?.content;
  const rules = smartRules(content);
  if (!rules || rules.type !== '10') return 'unknown';
  if (rules.section !== String(section)) return 'none';
  return rules.narrowed ? 'unknown' : 'all';
}

// ---------- playlists and collections ----------

// What a track (as normTrack makes them) is in. Results come as they're
// found, through onFound('playlist', { list, times, every }) and
// onFound('collection', { list, via }), where `every` marks a smart
// playlist of a whole library and `via` says what's in the collection: the
// track, its album or its artist. Resolves to { playlists, collections,
// skipped (lists too long to read), checked }.
export async function appearsIn(track, { signal, onFound, onProgress } = {}) {
  const s = app.server;
  const meta = await s.trackDetail(track.id).catch(() => null);
  const ids = {
    track: String(track.id),
    album: String(meta?.parentRatingKey ?? track.albumId ?? ''),
    artist: String(meta?.grandparentRatingKey ?? track.artistId ?? ''),
  };
  const section = meta?.librarySectionID ?? app.source.sectionKey;
  const [playlists, collections] = await Promise.all([s.playlists().catch(() => []), s.collections(section).catch(() => [])]);
  const lists = [
    ...playlists.filter((p) => (p.playlistType || 'audio') === 'audio').map((list) => ({ kind: 'playlist', list })),
    ...collections.filter((c) => ids[c.subtype || 'album']).map((list) => ({ kind: 'collection', list })),
  ];
  const found = { playlists: [], collections: [] };
  const skipped = [];
  const long = [];
  const todo = lists.filter(({ list }) => {
    const n = sizeOf(list);
    if (n === 0) return false; // empty
    if (n > (list.smart ? SMART_LIMIT : LIST_LIMIT)) {
      long.push(list);
      return false;
    }
    return true;
  });
  // Too long to read: a smart playlist of everything still counts, and one
  // of another library doesn't.
  await Promise.all(
    long.map(async (list) => {
      const said = list.smart ? await byRules(list, section) : 'unknown';
      if (said === 'all') {
        const entry = { list, times: 1, every: true };
        found.playlists.push(entry);
        onFound?.('playlist', entry);
      } else if (said === 'unknown') {
        skipped.push(list);
      }
    }),
  );
  if (signal?.aborted) throw Object.assign(new Error('aborted'), { aborted: true });
  let done = 0;
  onProgress?.(0, todo.length);
  await eachLimited(todo, 3, async ({ kind, list }) => {
    if (signal?.aborted) return;
    try {
      const counts = await contents(kind, list, signal);
      if (kind === 'playlist') {
        const times = counts.get(ids.track) || 0;
        if (times) {
          const entry = { list, times };
          found.playlists.push(entry);
          onFound?.('playlist', entry);
        }
      } else {
        const via = list.subtype || 'album';
        if (counts.has(ids[via])) {
          const entry = { list, via };
          found.collections.push(entry);
          onFound?.('collection', entry);
        }
      }
    } catch (err) {
      if (signal?.aborted) return;
      // A list that went away, or couldn't be read: left out.
    }
    done++;
    if (!signal?.aborted) onProgress?.(done, todo.length);
  });
  if (signal?.aborted) throw Object.assign(new Error('aborted'), { aborted: true });
  return { ...found, skipped, checked: todo.length };
}

// ---------- the albums a song is on ----------

// A song's name without what marks a version of it: "(Remastered 2011)",
// "[Live]", "- Radio Edit".
export const coreTitle = (title) =>
  String(title || '')
    .replace(/\s*[([][^)\]]*[)\]]/g, ' ')
    .replace(/\s+[-–—]\s+.*$/, '')
    .replace(/\s+/g, ' ')
    .trim();

// What to ask Plex for: the longest run of plain words in the name, so
// "Don’t Stop Me Now" finds "Don't Stop Me Now" too.
export function searchTerm(title) {
  const core = coreTitle(title) || String(title || '').trim();
  const runs = core
    .split(/[^\p{L}\p{N} ]+/u)
    // ("t Stop Me Now", after the apostrophe: "Stop Me Now".)
    .map((r) => r.trim().replace(/^\p{L}\s+(?=\S{3})/u, ''))
    .filter(Boolean);
  return runs.sort((a, b) => b.length - a.length)[0] || core;
}

const NOT_ARTISTS = new Set(['various artists', 'various', 'va', 'unknown artist', 'soundtrack', 'original soundtrack']);
const add = (set, name) => {
  const n = norm(name);
  if (n && !NOT_ARTISTS.has(n)) set.add(n);
};

// Who a song is by, as names to look for: the track's artist and the
// album's, each also without anyone featured ("Netsky feat. Rae Morris" is
// Netsky's).
function ownNames(m) {
  const out = new Set();
  for (const credit of [m.originalTitle, m.grandparentTitle]) {
    add(out, credit);
    add(out, String(credit || '').split(/\s+(?:feat\.?|ft\.?|featuring|with)\s+/i)[0]);
  }
  return out;
}

// The names in another track's credits, each artist on its own
// ("Underworld & Gabriel Yared": underworld, gabriel yared).
function creditNames(m) {
  const out = new Set();
  for (const credit of [m.originalTitle, m.grandparentTitle]) {
    add(out, credit);
    for (const part of String(credit || '').split(/\s*(?:,|;|\/|&|\+|\s(?:feat\.?|ft\.?|featuring|with|vs\.?|x|and)\s)\s*/i)) add(out, part);
  }
  return out;
}

// The albums with this song on them (a track's metadata, as Plex gives
// it): its own, and others with the same song by the same artist, such as a
// compilation, a soundtrack or a live album. Each is { id, title, artist,
// year, thumb, current, versions: [{ id, title, duration, current }] },
// its own first, then oldest first.
export async function albumsWith(meta, { signal } = {}) {
  const s = app.server;
  const section = meta.librarySectionID ?? app.source.sectionKey;
  const want = norm(coreTitle(meta.title)) || norm(meta.title);
  const mine = ownNames(meta);
  const term = searchTerm(meta.title);
  const ask = (filters) => s.list(section, 10, { size: 300, filters, signal }).catch((err) => {
    if (signal?.aborted) throw err;
    return { items: [] };
  });
  // Any album (compilations are by "Various Artists"), and the artist's own
  // albums, in case a common name fills the first.
  const pages = await Promise.all([ask({ title: term }), meta.grandparentRatingKey ? ask({ title: term, 'artist.id': meta.grandparentRatingKey }) : { items: [] }]);
  const albums = new Map();
  const seen = new Set();
  for (const m of [meta, ...pages.flatMap((p) => p.items)]) {
    const id = String(m.ratingKey);
    if (m.type !== 'track' || seen.has(id) || !m.parentRatingKey) continue;
    const current = id === String(meta.ratingKey);
    if (!current) {
      if (!sameTitle(norm(coreTitle(m.title)) || norm(m.title), want)) continue;
      const theirs = creditNames(m);
      if (![...mine].some((n) => theirs.has(n))) continue;
    }
    seen.add(id);
    const key = String(m.parentRatingKey);
    if (!albums.has(key)) {
      albums.set(key, {
        id: key,
        title: m.parentTitle || '',
        artist: m.grandparentTitle || '',
        year: Number(m.parentYear || m.year) || 0,
        thumb: m.parentThumb || m.thumb || '',
        current: false,
        versions: [],
      });
    }
    const album = albums.get(key);
    album.current ||= current;
    album.versions.push({ id, title: m.title || '', duration: Number(m.duration) || 0, current });
  }
  const by = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
  return [...albums.values()].sort((a, b) => b.current - a.current || (a.year || 9999) - (b.year || 9999) || by.compare(a.title, b.title));
}
