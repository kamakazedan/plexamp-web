// What a track appears in (the "Appears in" page): the albums the song is
// on, your playlists, and collections; and an artist's (Appears in, on
// their page): your playlists and collections with their music in them.
//
// Plex says which collections a track, its album and its artist are in (in
// their details), but for smart ones, which follow their rules. It can't be
// asked which playlists hold a track, or an artist's, so those, and smart
// collections (and any collection of what Plex didn't give the details of,
// and for an artist, collections of albums and of tracks), are read, a page
// at a time (each entry's id and whose it is, and no more, where Plex can
// leave the rest out), and kept until the list changes (Plex says when it
// last did), so looking again is quick, for any track or artist. Smart
// lists change without saying so: they're read again after a minute (five,
// for an artist's page). A smart playlist whose rules take in a whole
// library (Plex's All Music, say) is left out: every track there is in it,
// so saying so says nothing (nor is it read: its rules say so, as they do
// of one of another library). Very long smart playlists aren't read: those
// are left out, and the page says so.
//
// Plex doesn't link the same song on different albums either, so they're
// found by the song's name and artist.
import { app, on } from './state.js';
import { norm, sameTitle } from './ai.js';
import { creditedTo } from './hubs.js';
import { norm as nameOf } from './releases.js';

export const SMART_LIMIT = 2000; // smart lists longer than this aren't read
export const LIST_LIMIT = 10000; // nor are other lists longer than this
// Entries asked for at a time: a playlist's, and a collection's (Plex
// refuses more than 120 of those, on some servers).
const PAGE = { playlist: 500, collection: 120 };
const SMART_TTL = 60000;
const ARTIST_SMART_TTL = 5 * 60000;
const CACHE_LIMIT = 100000; // ids and whose they are kept, over all lists

// `${server}|${kind}|${id}` -> { stamp, at, counts: Map(entry's id ->
// times), owners: Map(`${whose}|${credit}` -> entries) }: whose, the
// artist's id (a track's album artist, an album's artist, an artist), and
// credit, who a track's credited to, where Plex says.
let cache = new Map();
let cached = 0;
// Lists being read (key -> { stamp, ctrl, waiters, job }): one read of a
// list at a time, however many pages ask for it meanwhile (an artist's page
// and a similar artist's, say), stopped once none of them wants it.
let reading = new Map();
let generation = 0; // (what's read for a server or account since let go isn't kept)
const forget = () => {
  cache = new Map();
  cached = 0;
  for (const r of reading.values()) r.ctrl.abort();
  reading = new Map();
  generation++;
};
on('source', forget);
on('signout', forget);

const stampOf = (list) => `${list.updatedAt || 0}|${list.leafCount ?? list.childCount ?? ''}`;
// How many entries a list has, or NaN if Plex didn't say.
const sizeOf = (list) => Number(list.leafCount ?? list.childCount);

// Whose an entry is: a track's album artist's (as the artist's page has
// their tracks), an album's artist's, or an artist's own id.
const whose = (m, of) => String((of === 'artist' ? m.ratingKey : of === 'album' ? m.parentRatingKey : m.grandparentRatingKey) ?? '');

const abortedError = () => Object.assign(new Error('aborted'), { aborted: true });

// A list's contents, as kept, or read (once, for everyone asking: see
// `reading`); `signal` lets this one asker go.
async function contents(kind, list, signal, { smartTtl = SMART_TTL } = {}) {
  const s = app.server;
  const key = `${s.uri}|${kind}|${list.ratingKey}`;
  const stamp = stampOf(list);
  const hit = cache.get(key);
  if (hit && hit.stamp === stamp && (!isSmart(list) || Date.now() - hit.at < smartTtl)) {
    cache.delete(key);
    cache.set(key, hit); // most recently used last
    return hit;
  }
  if (signal?.aborted) throw abortedError();
  let r = reading.get(key);
  // (A read of the list as it was before it changed goes on, for those
  // asking for that: this is a read of its own. So is one after a read
  // everyone let go of.)
  if (!r || r.stamp !== stamp || r.ctrl.signal.aborted) {
    const ctrl = new AbortController();
    const mine = { stamp, ctrl, waiters: 0, job: null };
    mine.job = readList(s, kind, list, key, stamp, ctrl.signal).finally(() => {
      if (reading.get(key) === mine) reading.delete(key);
    });
    mine.job.catch(() => {});
    reading.set(key, mine);
    r = mine;
  }
  const read = r;
  read.waiters++;
  return new Promise((resolve, reject) => {
    let left = false;
    const done = () => {
      if (left) return false;
      left = true;
      signal?.removeEventListener('abort', gone);
      read.waiters--;
      return true;
    };
    // (The last one asking lets go: the read stops, and no one else joins
    // it.)
    const gone = () => {
      if (!done()) return;
      if (read.waiters <= 0) {
        if (reading.get(key) === read) reading.delete(key);
        read.ctrl.abort();
      }
      reject(abortedError());
    };
    signal?.addEventListener('abort', gone, { once: true });
    read.job.then(
      (got) => {
        done();
        resolve(got);
      },
      (err) => {
        done();
        reject(err);
      },
    );
  });
}

async function readList(s, kind, list, key, stamp, signal) {
  const gen = generation;
  const started = Date.now();
  const counts = new Map();
  const owners = new Map();
  const of = kind === 'playlist' ? 'track' : list.subtype || 'album';
  const size = PAGE[kind];
  let ids = true;
  let last = null;
  // (Until Plex's count of them, or a page short of what was asked for
  // where it gives none: a server that gives fewer at a time is read on.)
  for (let start = 0; start < LIST_LIMIT; ) {
    if (signal?.aborted) throw abortedError();
    const page = kind === 'playlist' ? await s.playlistItems(list.ratingKey, { start, size, ids, signal }) : await s.collectionItems(list.ratingKey, { start, size, ids, signal });
    // (A server that left even the ids out: read in full.)
    if (ids && page.items.length && !page.items.some((m) => m?.ratingKey != null)) {
      ids = false;
      continue;
    }
    // (The same page again: a server that doesn't page, so that's all.)
    const sig = page.items.map((m) => m?.ratingKey).join(',');
    if (start && sig === last) break;
    last = sig;
    for (const m of page.items) {
      const id = String(m.ratingKey);
      counts.set(id, (counts.get(id) || 0) + 1);
      const credit = of === 'track' && typeof m.originalTitle === 'string' ? m.originalTitle : '';
      const own = `${whose(m, of)}|${credit}`;
      owners.set(own, (owners.get(own) || 0) + 1);
    }
    start += page.items.length;
    // (More than was asked for: a server that gave it all at once.)
    if (!page.items.length || page.items.length > size || (page.counted != null ? start >= page.counted : page.items.length < size)) break;
  }
  const sizeIn = (v) => v.counts.size + v.owners.size;
  const got = { stamp, at: Date.now(), started, counts, owners };
  // (Kept, unless the server or account it was read for has been let go;
  // what it takes the place of, whatever that is by now, isn't counted.)
  if (gen !== generation) return got;
  const was = cache.get(key);
  // (Nor over what a read of it begun later, since it changed, has kept.)
  if (was && was.started > started) return got;
  if (was) cached -= sizeIn(was);
  cache.delete(key);
  cache.set(key, got);
  cached += sizeIn(got);
  while (cached > CACHE_LIMIT && cache.size > 1) {
    const [k, v] = cache.entries().next().value;
    cache.delete(k);
    cached -= sizeIn(v);
  }
  return got;
}

// How many of a list's entries (as contents has them) are an artist's
// (`me`, their id; `want`, their name, as releases.js norm has it): by
// them, or credited to them (hubs.js creditedTo: the whole credit, or a
// name either side of a featured one).
function theirs(owners, me, want) {
  let n = 0;
  for (const [k, times] of owners) {
    const bar = k.indexOf('|');
    const credit = k.slice(bar + 1);
    if (k.slice(0, bar) === me || (credit && creditedTo({ originalTitle: credit }, want))) n += times;
  }
  return n;
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

// The collections Plex says an item is in (its details' Collection tags):
// each one's id, which is the collection's index, and its title.
function collectionTags(item) {
  const tags = Array.isArray(item?.Collection) ? item.Collection : item?.Collection ? [item.Collection] : [];
  const ids = new Set();
  const titles = new Set();
  for (const t of tags) {
    const id = String(t?.id ?? String(t?.filter || '').split('=')[1] ?? '');
    if (/^\d+$/.test(id)) ids.add(id);
    if (typeof t?.tag === 'string' && t.tag) titles.add(t.tag);
  }
  return { ids, titles };
}
// (By its index, where the collection and the tags have them; by its title
// where they haven't.)
const tagged = (c, tags) => (/^\d+$/.test(String(c.index ?? '')) && tags.ids.size ? tags.ids.has(String(c.index)) : tags.titles.has(c.title));
const isSmart = (list) => list.smart === true || list.smart === 1 || list.smart === '1';

// What a track (as normTrack makes them) is in. Results come as they're
// found, through onFound('playlist', { list, times }) and
// onFound('collection', { list, via }), where `via` says what's in the
// collection: the track, its album or its artist. Resolves to { playlists,
// collections, skipped (lists too long to read), checked }.
export async function appearsIn(track, { signal, onFound, onProgress } = {}) {
  const s = app.server;
  // (Its details as they are now, for the collections it's in.)
  const meta = await s.metadata(track.id).catch(() => null);
  const ids = {
    track: String(track.id),
    album: String(meta?.parentRatingKey ?? track.albumId ?? ''),
    artist: String(meta?.grandparentRatingKey ?? track.artistId ?? ''),
  };
  const section = meta?.librarySectionID ?? app.source.sectionKey;
  const details = (id) => (/^\d+$/.test(id) ? s.metadata(id).catch(() => null) : null);
  const [playlists, collections, album, artist] = await Promise.all([
    s.playlists().catch(() => []),
    s.collections(section).catch(() => []),
    details(ids.album),
    details(ids.artist),
  ]);
  // (Null where its details couldn't be had: those collections are read.)
  const tags = { track: meta && collectionTags(meta), album: album && collectionTags(album), artist: artist && collectionTags(artist) };
  const found = { playlists: [], collections: [] };
  // Collections, as Plex says (but smart ones, read with the playlists).
  const ofKind = collections.filter((c) => ids[c.subtype || 'album']);
  const toRead = (c) => isSmart(c) || !tags[c.subtype || 'album'];
  for (const list of ofKind.filter((c) => !toRead(c))) {
    const via = list.subtype || 'album';
    if (!tagged(list, tags[via])) continue;
    const entry = { list, via };
    found.collections.push(entry);
    onFound?.('collection', entry);
  }
  const lists = [
    ...playlists.filter((p) => (p.playlistType || 'audio') === 'audio').map((list) => ({ kind: 'playlist', list })),
    ...ofKind.filter(toRead).map((list) => ({ kind: 'collection', list })),
  ];
  const read = await readLists(lists, section, {
    signal,
    onProgress,
    each: ({ kind, list }, { counts }) => {
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
    },
  });
  return { ...found, ...read };
}

// What of yours an artist's music is in (`artist`, their details, with the
// collections Plex says they're in): your playlists with their tracks in
// (by them, or credited to them), and the library's collections of them,
// of their albums or with their tracks. Results come as they're found,
// through onFound('playlist', { list, count }) and
// onFound('collection', { list, via, count }) (`count`: how many of
// theirs; `via`, what's in the collection: artists, albums or tracks).
// Resolves to { playlists, collections, skipped, checked }, as appearsIn
// does.
export async function artistAppearsIn(artist, { signal, onFound, onProgress } = {}) {
  const s = app.server;
  const me = String(artist?.ratingKey ?? '');
  const want = nameOf(artist?.title);
  if (!/^\d+$/.test(me)) return { playlists: [], collections: [], skipped: [], checked: 0 };
  const section = artist.librarySectionID ?? app.source.sectionKey;
  const [playlists, collections] = await Promise.all([s.playlists().catch(() => []), s.collections(section).catch(() => [])]);
  const found = { playlists: [], collections: [] };
  const hit = (kind, entry) => {
    found[kind === 'playlist' ? 'playlists' : 'collections'].push(entry);
    onFound?.(kind, entry);
  };
  // Collections of artists, as Plex says (but smart ones, read with the
  // rest: those of albums and of tracks say only what's in them).
  const viaOf = (c) => c.subtype || 'album';
  const tags = collectionTags(artist);
  for (const c of collections.filter((c) => viaOf(c) === 'artist' && !isSmart(c))) {
    if (tagged(c, tags)) hit('collection', { list: c, via: 'artist', count: 1 });
  }
  const lists = [
    ...playlists.filter((p) => (p.playlistType || 'audio') === 'audio').map((list) => ({ kind: 'playlist', list })),
    ...collections.filter((c) => viaOf(c) !== 'artist' || isSmart(c)).map((list) => ({ kind: 'collection', list })),
  ];
  const read = await readLists(lists, section, {
    signal,
    onProgress,
    smartTtl: ARTIST_SMART_TTL,
    each: ({ kind, list }, { counts, owners }) => {
      const via = kind === 'playlist' ? 'track' : viaOf(list);
      const count = via === 'artist' ? (counts.has(me) ? 1 : 0) : theirs(owners, me, via === 'track' ? want : '');
      if (count) hit(kind, kind === 'playlist' ? { list, count } : { list, via, count });
    },
  });
  return { ...found, ...read };
}

// Reads `lists` ({ kind, list }) three at a time (see contents), giving
// each one's contents to `each`. Smart playlists whose rules take in all
// of `section` (it says nothing that a track's in one) or another library
// (it can't be) are left out; those too long to read are `skipped`.
// Resolves to { skipped, checked }.
async function readLists(lists, section, { signal, onProgress, smartTtl, each }) {
  const aborted = abortedError;
  const said = await Promise.all(lists.map((x) => (x.kind === 'playlist' && isSmart(x.list) ? byRules(x.list, section) : 'unknown')));
  if (signal?.aborted) throw aborted();
  const skipped = [];
  const todo = lists.filter((x, i) => {
    if (said[i] !== 'unknown') return false; // of everything here, or of another library
    const n = sizeOf(x.list);
    if (n === 0) return false; // empty
    if (n > (isSmart(x.list) ? SMART_LIMIT : LIST_LIMIT)) {
      skipped.push(x.list);
      return false;
    }
    return true;
  });
  let done = 0;
  onProgress?.(0, todo.length);
  await eachLimited(todo, 3, async (x) => {
    if (signal?.aborted) return;
    let got = null;
    try {
      got = await contents(x.kind, x.list, signal, { smartTtl });
    } catch {
      if (signal?.aborted) return;
      // A list that went away, or couldn't be read: left out.
    }
    if (got) each(x, got);
    done++;
    if (!signal?.aborted) onProgress?.(done, todo.length);
  });
  if (signal?.aborted) throw aborted();
  return { skipped, checked: todo.length };
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
