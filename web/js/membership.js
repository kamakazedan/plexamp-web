// Which of your playlists, and which collections, a track is in (the
// "Appears in" page). Plex can't be asked that directly, so each list's
// contents are read, a page at a time, and kept until the list changes
// (Plex says when it last did), so looking again is quick. Smart lists
// follow their rules and change without saying so: they're read again after
// a minute, and very long ones (a smart playlist of the whole library, say)
// aren't read at all.
import { app, on } from './state.js';

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

// What a track (as normTrack makes them) is in. Results come as they're
// found, through onFound('playlist', { list, times }) and
// onFound('collection', { list, via }), where `via` says what's in the
// collection: the track, its album or its artist. Resolves to { playlists,
// collections, skipped (lists too long to read), checked }.
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
  const skipped = [];
  const todo = lists.filter(({ list }) => {
    const n = sizeOf(list);
    if (n === 0) return false; // empty
    if (n > (list.smart ? SMART_LIMIT : LIST_LIMIT)) {
      skipped.push(list);
      return false;
    }
    return true;
  });
  const found = { playlists: [], collections: [] };
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
