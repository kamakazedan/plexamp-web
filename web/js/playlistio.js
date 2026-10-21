// Playlists to a file and back: one playlist, or all of yours (a backup), as
// a JSON file that plexamp-web reads again, for you or someone else, on this
// Plex server or another (after a server is set up again, say). A file holds
// what's needed to find each track again: its title, artist, album, number
// and length, and Plex's ids for it (its ratingKey on this server, and its
// guid, Plex's id for the recording). Nothing else about the server goes in
// it: no addresses, no file paths, no tokens.
//
// Also used for shared playlists (sharing.js): making a playlist hold a list
// of tracks, with the fewest changes.
import { app } from './state.js';
import { norm, sameTitle, mapLimit, findArtist } from './ai.js';
import { saveOrder } from './sorting.js';

export const FORMAT = 'plexamp-web-playlists';
const VERSION = 1;
// Files come from anyone: what's read from one is bounded.
export const FILE_LIMITS = { bytes: 25 * 1024 * 1024, playlists: 1000, tracks: 20000, total: 100000 };

const GUID = /^[a-z][a-z0-9+.-]{0,30}:\/\/[^\s"'<>\\]{1,200}$/i;
const text = (v, n = 300) => (typeof v === 'string' ? v.slice(0, n) : '');
const whole = (v, max) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max ? v : undefined);
const guidOf = (v) => (typeof v === 'string' && GUID.test(v) && !/^file:/i.test(v) ? v : undefined);
const idOf = (v) => (/^\d{1,12}$/.test(String(v ?? '')) ? String(v) : undefined);

// A track (a Plex item) as a file has it. Fields Plex didn't give are left
// out.
export function entryOf(m) {
  return {
    title: text(m.title),
    artist: text(m.originalTitle || m.grandparentTitle || ''),
    albumArtist: text(m.grandparentTitle || ''),
    album: text(m.parentTitle || ''),
    year: whole(m.parentYear || m.year, 3000),
    disc: whole(m.parentIndex, 1000),
    index: whole(m.index, 100000),
    duration: whole(m.duration, 48 * 3600 * 1000),
    guid: guidOf(m.guid),
    id: idOf(m.ratingKey),
  };
}

// An entry from a file, kept only as plain text and numbers, or null.
function cleanEntry(t) {
  if (!t || typeof t !== 'object') return null;
  const e = {
    title: text(t.title).trim(),
    artist: text(t.artist).trim(),
    albumArtist: text(t.albumArtist).trim(),
    album: text(t.album).trim(),
    year: whole(t.year, 3000),
    disc: whole(t.disc, 1000),
    index: whole(t.index, 100000),
    duration: whole(t.duration, 48 * 3600 * 1000),
    guid: guidOf(t.guid),
    id: typeof t.id === 'string' ? idOf(t.id) : undefined,
  };
  return e.title ? e : null;
}

// ---------- reading a playlist from Plex ----------

// Every entry of a playlist, page by page (at most `limit`): { items, more }.
// `server`: the Plex server it's on (the one in use, unless given).
export async function playlistEntries(id, { limit = FILE_LIMITS.tracks, signal, server = app.server } = {}) {
  const out = [];
  let more = false;
  for (let start = 0; ; start += 500) {
    if (signal?.aborted) throw abortError();
    const { items, total } = await server.playlistItems(id, { start, size: 500 });
    out.push(...items.filter((m) => m.type === 'track' || m.type === undefined));
    if (out.length >= limit) {
      more = total > limit;
      break;
    }
    if (!items.length || start + items.length >= total) break;
  }
  return { items: out.slice(0, limit), more };
}

const abortError = () => Object.assign(new Error('Stopped.'), { aborted: true });

// ---------- export ----------

// Playlists as a file holds them: { format, version, exported, playlists:
// [{ title, summary, smart, tracks, more }] } (`more`: it had more tracks
// than a file holds). onProgress(i, of, playlist) before each.
export async function exportPlaylists(pls, { signal, onProgress } = {}) {
  const playlists = [];
  for (const [i, pl] of pls.entries()) {
    onProgress?.(i, pls.length, pl);
    const { items, more } = await playlistEntries(pl.ratingKey, { signal });
    playlists.push({
      title: text(pl.title, 200),
      summary: text(pl.summary, 2000) || undefined,
      smart: pl.smart ? true : undefined,
      tracks: items.map(entryOf),
      more: more || undefined,
    });
  }
  return { format: FORMAT, version: VERSION, exported: new Date().toISOString(), playlists };
}

// The file's text: one track to a line, so it's readable (and not much
// bigger than without the line breaks).
export function playlistJson(data) {
  const one = (p) => {
    const head = { title: p.title, summary: p.summary, smart: p.smart, more: p.more };
    const fields = Object.entries(head)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `    ${JSON.stringify(k)}: ${JSON.stringify(v)},`);
    const tracks = p.tracks.map((t) => `      ${JSON.stringify(t)}`).join(',\n');
    return `  {\n${fields.join('\n')}\n    "tracks": [${tracks ? `\n${tracks}\n    ` : ''}]\n  }`;
  };
  return `{\n  "format": ${JSON.stringify(data.format)},\n  "version": ${data.version},\n  "exported": ${JSON.stringify(data.exported)},\n  "playlists": [\n${data.playlists.map(one).join(',\n')}\n  ]\n}\n`;
}

// A name for the file: the playlist's, without what file names can't have.
export function playlistFileName(title) {
  const base =
    String(title || '')
      .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^\.+/, '')
      .slice(0, 80)
      .trim() || 'Playlist';
  return `${base}.playlist.json`;
}

// ---------- reading a file ----------

const fileError = (message) => Object.assign(new Error(message), { file: true });

// A playlist file, read and checked: { exported, playlists: [{ title,
// summary, smart, tracks: [entry] }] }. Throws (err.file) saying what's
// wrong with it.
export async function readPlaylistFile(file) {
  if (!file) throw fileError('No file was chosen.');
  if (file.size > FILE_LIMITS.bytes) throw fileError('That file is too big to be a playlist file.');
  let data = null;
  try {
    data = JSON.parse(await file.text());
  } catch {
    data = null;
  }
  if (!data || data.format !== FORMAT || !Array.isArray(data.playlists)) throw fileError('That isn’t a playlist file from plexamp-web.');
  if (!(Number(data.version) >= 1)) throw fileError('That isn’t a playlist file from plexamp-web.');
  if (Number(data.version) > VERSION) throw fileError('That file is from a newer plexamp-web. Update this one to import it.');
  let total = 0;
  const playlists = [];
  for (const p of data.playlists.slice(0, FILE_LIMITS.playlists)) {
    if (!p || typeof p !== 'object' || !Array.isArray(p.tracks)) continue;
    const tracks = [];
    for (const t of p.tracks.slice(0, FILE_LIMITS.tracks)) {
      if (total >= FILE_LIMITS.total) break;
      const e = cleanEntry(t);
      if (e) {
        tracks.push(e);
        total += 1;
      }
    }
    playlists.push({ title: text(p.title, 200).trim() || 'Imported playlist', summary: text(p.summary, 2000).trim(), smart: p.smart === true, tracks });
  }
  if (!playlists.length) throw fileError('There are no playlists in that file.');
  const exported = typeof data.exported === 'string' && !Number.isNaN(Date.parse(data.exported)) ? data.exported : null;
  return { exported, playlists };
}

// ---------- finding the tracks ----------

// Names close enough to be the same artist ("The Prodigy" and "Prodigy").
const sameName = (want, have) => {
  const w = norm(want);
  const n = norm(have);
  return !!w && !!n && (w === n || n.includes(w) || w.includes(n));
};
const byArtist = (e, m) => (!e.artist && !e.albumArtist) || [m.originalTitle, m.grandparentTitle].some((a) => sameName(e.artist, a) || sameName(e.albumArtist, a));
// The same song: the same title (near enough) by the same artist.
const sameSong = (e, m) => (m?.type === 'track' || m?.type === undefined) && sameTitle(norm(m.title), norm(e.title)) && byArtist(e, m);

// How alike a track in the library is to an entry, beyond being the same
// song: Plex's id for the recording, the exact title, the album, the length,
// its number and year. The most alike is the one (an album can be in the
// library twice, a song on several albums).
function likeness(e, m) {
  let n = 0;
  if (e.guid && m.guid === e.guid) n += 8;
  if (norm(m.title) === norm(e.title)) n += 4;
  if (e.album && norm(m.parentTitle) === norm(e.album)) n += 3;
  if (e.duration && m.duration && Math.abs(m.duration - e.duration) <= 3000) n += 2;
  if (e.index !== undefined && m.index === e.index) n += 1;
  if (e.year && (m.parentYear || m.year) === e.year) n += 1;
  return n;
}
const best = (e, list) =>
  list
    .filter((m) => sameSong(e, m))
    .map((m) => ({ m, n: likeness(e, m) }))
    .sort((a, b) => b.n - a.n)[0]?.m || null;

// Each entry's track in this library, or null. First by its id on this
// server (checked to be the same song: on another server an id means
// something else), then by Plex's id for the recording, then by its title
// and artist, the album, length and number choosing between copies.
// onProgress(done, of).
export async function matchEntries(entries, { signal, onProgress } = {}) {
  const s = app.server;
  const sec = app.source.sectionKey;
  const out = entries.map(() => null);
  let done = 0;
  const tick = () => onProgress?.(done, entries.length);
  // By id, a batch at a time.
  const ids = [...new Set(entries.map((e) => e.id).filter(Boolean))];
  const byId = new Map();
  for (let i = 0; i < ids.length; i += 40) {
    if (signal?.aborted) throw abortError();
    const got = await s.metadataMany(ids.slice(i, i + 40)).catch(() => []);
    got.forEach((m) => byId.set(String(m.ratingKey), m));
  }
  entries.forEach((e, i) => {
    const m = e.id ? byId.get(e.id) : null;
    if (m && sameSong(e, m)) {
      out[i] = m;
      done += 1;
    }
  });
  tick();
  // The rest, a few at a time.
  let guids = true; // until the server shows it doesn't look tracks up by them
  const lookUp = async (e) => {
    if (guids && e.guid?.startsWith('plex://')) {
      const { items, total } = await s.list(sec, 10, { filters: { guid: e.guid }, size: 5, signal });
      if (total > 5) guids = false; // it didn't filter by it
      const hit = items.find((m) => m.guid === e.guid && byArtist(e, m)) || null;
      if (hit) return hit;
    }
    const res = await s.search(e.title, sec, { signal, limit: 20 });
    const hit = best(e, res.track || []);
    if (hit) return hit;
    // A common title: among the artist's own tracks.
    const artist = await findArtist(e.artist || e.albumArtist, signal);
    if (!artist) return null;
    const want = norm(e.title);
    const needle = want.split(' ').find((w) => w.length >= 3) || want;
    const { items } = await s.list(sec, 10, { size: 50, filters: { 'artist.id': artist.ratingKey, title: needle }, signal });
    return best(e, items);
  };
  const rest = entries.map((e, i) => [e, i]).filter(([, i]) => !out[i]);
  await mapLimit(rest, 4, async ([e, i]) => {
    if (signal?.aborted) return;
    try {
      out[i] = await lookUp(e);
    } catch {
      /* not found this time */
    }
    done += 1;
    tick();
  });
  if (signal?.aborted) throw abortError();
  return out;
}

// ---------- import ----------

// A playlist from a file, made in this library, called `title`: { playlist
// (Plex's, or null if none of its tracks are here), found (how many),
// missing: [entries] }.
export async function importPlaylist(p, { title = p.title, signal, onProgress } = {}) {
  const found = await matchEntries(p.tracks, { signal, onProgress });
  const ids = found.filter(Boolean).map((m) => String(m.ratingKey));
  const missing = p.tracks.filter((_, i) => !found[i]);
  if (!ids.length) return { playlist: null, found: 0, missing };
  if (signal?.aborted) throw abortError();
  const playlist = await app.server.createPlaylist(title, ids);
  if (playlist && p.summary) await app.server.editPlaylist(playlist.ratingKey, { summary: p.summary }).catch(() => {});
  return { playlist, found: ids.length, missing };
}

// A missing entry, as a line: "Artist — Title".
export const entryLine = (e) => `${e.artist ? `${e.artist} — ` : ''}${e.title}`;

// ---------- changing a playlist from one list of tracks to another ----------

const counted = (list) => list.reduce((m, k) => m.set(String(k), (m.get(String(k)) || 0) + 1), new Map());

// What turns `from` into `to` (track ids, a track maybe there more than
// once): { remove: Map(id -> how many), add: [ids] }.
export function changesBetween(from, to) {
  const a = counted(from);
  const b = counted(to);
  const remove = new Map();
  for (const [k, n] of a) if (n > (b.get(k) || 0)) remove.set(k, n - (b.get(k) || 0));
  const add = [];
  for (const [k, n] of b) for (let i = a.get(k) || 0; i < n; i++) add.push(k);
  return { remove, add };
}

// Of the tracks `add` asked for, those Plex didn't add (counts), from the
// tracks of the entries it did add (`added`).
export function leftOut(add, added) {
  const got = counted(added);
  const out = new Map();
  for (const [k, n] of counted(add)) {
    const short = n - Math.min(n, got.get(k) || 0);
    if (short) out.set(k, short);
  }
  return out;
}

// `list` less `counts` (track -> how many) of its entries, the last ones.
export function without(list, counts) {
  const left = new Map(counts);
  const kept = [];
  for (let i = list.length - 1; i >= 0; i--) {
    const k = String(list[i]);
    const n = left.get(k) || 0;
    if (n) left.set(k, n - 1);
    else kept.push(k);
  }
  return kept.reverse();
}

// Changes playlist `id`, on `server`, from holding `from` (track ids, as it
// was read) to holding `to`, making only that difference: whatever else
// changed in it meanwhile (here, in another tab, in another app) stays, and
// the tracks in `to` are put in its order, the rest after. Resolves to {
// changed, base }: `base` is `to`, less what Plex left out (tracks this
// account can't have), so the next look can tell what's changed since.
export async function changePlaylist(id, from, to, { server = app.server, signal } = {}) {
  const s = server;
  const read = async () => (await playlistEntries(id, { limit: 100000, signal, server: s })).items;
  const { remove, add } = changesBetween(from, to);
  const entries = await read();
  const gone = new Set();
  // The entries to go: from the end, a track's last ones first.
  for (const e of entries.slice().reverse()) {
    const k = String(e.ratingKey);
    const n = remove.get(k) || 0;
    if (!n) continue;
    if (signal?.aborted) throw abortError();
    remove.set(k, n - 1);
    await s.removeFromPlaylist(id, e.playlistItemID);
    gone.add(String(e.playlistItemID));
  }
  // What Plex adds, it adds as new entries: those it doesn't (tracks this
  // account can't have) are told apart from any change made meanwhile.
  let short = new Map();
  if (add.length) {
    const before = new Set(entries.map((e) => String(e.playlistItemID)).filter((x) => !gone.has(x)));
    await s.addToPlaylist(id, add);
    short = leftOut(add, (await read()).filter((e) => !before.has(String(e.playlistItemID))).map((e) => String(e.ratingKey)));
  }
  // The order wanted, as the entries' own ids: each track's entries in turn,
  // then those `to` doesn't have, as they are.
  const target = (list) => {
    const byTrack = new Map();
    for (const e of list) {
      const k = String(e.ratingKey);
      if (!byTrack.has(k)) byTrack.set(k, []);
      byTrack.get(k).push(String(e.playlistItemID));
    }
    const order = to.map((k) => byTrack.get(String(k))?.shift()).filter(Boolean);
    const used = new Set(order);
    return [...order, ...list.map((e) => String(e.playlistItemID)).filter((x) => !used.has(x))];
  };
  const { moved } = await saveOrder({
    read,
    idOf: (e) => String(e.playlistItemID),
    target,
    move: (itemId, after) => s.movePlaylistItem(id, itemId, after),
    signal,
  });
  const added = add.length - [...short.values()].reduce((a, n) => a + n, 0);
  return { changed: gone.size > 0 || added > 0 || moved > 0, base: without(to, short) };
}
