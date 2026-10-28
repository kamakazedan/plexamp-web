// Missing tracks' lists, and how each change to one goes: the same rules in
// the browser (missing.js) and in the player's service (server/missing.js,
// for the lists it keeps for each Plex account). server/missinglist.js is
// this file again, kept the same by a test: nothing here comes from the page
// or from Node.
//
// An entry: { kind ('track' or 'artist'), artist, title ('' for an artist),
// via ('spotify': in a Spotify playlist; none: an AI playlist suggested it),
// times (how often it was suggested; a Spotify one's, how many playlists it
// was in), lists (a Spotify one's playlists, each by listId, up to
// MISSING_LISTS), first and last (when it was first and last noted, in
// seconds), mb ('real': MusicBrainz knows it), server (the Plex server's id),
// section (the music library's key there) and library (its name, and the
// server's) }. In the browser that noted it last, prompt too: what the AI
// playlist was asked for, or the Spotify playlist's name, which never leaves
// that device.

// Each server keeps the most recent of each: what AI playlists suggested, and
// what playlists from Spotify had (a whole account's can be thousands: an
// import's spreadsheet has all of its own). One doesn't push the other out,
// nor one server another's.
export const MISSING_LIMITS = { ai: 500, spotify: 1000 };
// A Spotify one is counted once for each playlist it's in, up to this many
// ("20+"): past that, imported again, it isn't counted again.
export const MISSING_LISTS = 20;

// A name as it's compared: case, accents, "&" and "and", what's in brackets,
// a leading "The" and punctuation don't count. A name in another script
// (宇多田ヒカル, Кино), which that would leave nothing of, keeps its letters
// and numbers (as since 0.25.0: before, they all came out the same, as
// nothing).
const plain = (v, other) =>
  String(v || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .replace(/^the\s+/, '')
    .replace(other, ' ')
    .trim();
export const norm = (v) => plain(v, /[^a-z0-9]+/g) || plain(v, /[^\p{L}\p{N}]+/gu);

export const sourceOf = (m) => (m.via === 'spotify' ? 'spotify' : 'ai');
// What it is, wherever it's missing from.
export const keyOf = (m) => `${m.kind}|${norm(m.artist)}|${norm(m.title)}`;
// ...and which of a server's music libraries it's missing from: one entry on
// that server's list.
export const idOf = (m) => `${keyOf(m)}|${m.section}`;

// A Spotify playlist, by its name, in a few characters: a track's `lists`
// count the playlists it was in without keeping their names. Twelve bits of
// a hash of the name (since 0.25.0), so what's kept can't be used to check a
// name guessed: one in 4,096 names has the same (and now and then, two of
// someone's playlists count as one).
export function listId(name) {
  let x = 0x811c9dc5;
  for (const ch of String(name || '').trim().toLowerCase()) x = Math.imul(x ^ ch.codePointAt(0), 0x01000193) >>> 0;
  return (x >>> 20).toString(36);
}

// A listId as it is now: one kept before 0.25.0 (the whole hash, four
// characters or more) is cut down as listId cuts it.
export const shortList = (id) => (typeof id === 'string' && /^[a-z0-9]{4,8}$/.test(id) ? (parseInt(id, 36) >>> 20).toString(36) : id);
// ...and a list of them, each once.
export const shortLists = (lists) => [...new Set((Array.isArray(lists) ? lists : []).map(shortList))];

// The most recent of each server's, of each kind (see MISSING_LIMITS): by
// when each was last noted, and of those noted the same second, the last
// noted (the list is in the order they were), kept in that order.
export function trimMissing(list) {
  const groups = new Map();
  for (const m of list) {
    const k = `${m.server}\n${sourceOf(m)}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(m);
  }
  const out = [];
  for (const g of groups.values()) {
    const cap = MISSING_LIMITS[sourceOf(g[0])];
    if (g.length <= cap) {
      out.push(...g);
      continue;
    }
    const kept = new Set(
      g
        .map((m, i) => [m, i])
        .sort(([a, i], [b, j]) => (b.last || 0) - (a.last || 0) || j - i)
        .slice(0, cap)
        .map(([m]) => m),
    );
    out.push(...g.filter((m) => kept.has(m)));
  }
  return out;
}

const onServer = (server) => (m) => m.server === server;

// What an AI playlist found missing, or an import of a Spotify playlist, on
// `server`'s list (op: { items: [{ kind, artist, title, mb }], found, unreal,
// via, list, section, library, at }): new ones are added, ones seen before
// counted again (once a call: a song twice in a playlist is one), and those
// it found in that library (`found`: their keys) let go, as are those
// MusicBrainz says aren't real (`unreal`), unless they're from Spotify
// (Spotify has them, so they're real). Those MusicBrainz knows come with
// mb: 'real'. From Spotify (via: 'spotify', with the playlist as `list`, its
// listId), real songs counted once for each playlist they're in. One from
// somewhere else now is counted afresh. `at`: when, in seconds. `prompt`:
// what it was for, on the device that asked (none: it's left out). Returns
// the list, and the keys of those noted.
export function applyNote(list, op, { server, prompt } = {}) {
  const via = op.via === 'spotify' ? 'spotify' : '';
  op = via ? { ...op, list: shortList(op.list) } : op;
  const here = (m) => m.server === server && String(m.section) === String(op.section);
  const found = new Set(op.found || []);
  const unreal = new Set(op.unreal || []);
  const gone = (m) => here(m) && (found.has(keyOf(m)) || (unreal.has(keyOf(m)) && m.via !== 'spotify'));
  const kept = list.filter((m) => !gone(m));
  const index = new Map();
  for (const m of kept) if (here(m)) index.set(keyOf(m), m);
  const noted = new Set();
  // Those noted now, in the order they are: last in the list (see trimMissing).
  const noting = [];
  const now = op.at;
  for (const item of op.items || []) {
    const entry = { kind: item.kind, artist: String(item.artist || '').slice(0, 120), title: item.kind === 'track' ? String(item.title || '').slice(0, 160) : '' };
    if (!entry.artist && !entry.title) continue;
    if (item.mb === 'real') entry.mb = 'real';
    const k = keyOf(entry);
    if (noted.has(k) || found.has(k)) continue;
    noted.add(k);
    const have = index.get(k);
    if (have) {
      noting.push(have);
      if ((have.via || '') !== via) {
        have.times = 1;
        delete have.lists;
        // (One from Spotify that an AI suggests now is still a real song.)
        if (via === 'spotify') have.lists = [op.list];
        else have.mb = 'real';
      } else if (via === 'spotify') {
        // (Kept before 0.22.0: the playlist it was last in.) At most
        // MISSING_LISTS: past that, it's in "20+" playlists, and counted no
        // further (so imported again, it isn't counted again).
        const lists = Array.isArray(have.lists) ? shortLists(have.lists) : [listId(have.prompt)];
        if (!lists.includes(op.list) && lists.length < MISSING_LISTS) {
          lists.push(op.list);
          have.times = (have.times || 1) + 1;
        }
        have.lists = lists;
      } else {
        have.times = (have.times || 1) + 1;
      }
      have.last = now;
      if (prompt != null) have.prompt = String(prompt).slice(0, 200);
      else delete have.prompt;
      if (entry.mb) have.mb = entry.mb;
      if (via) have.via = via;
      else delete have.via;
    } else {
      noting.push({
        ...entry,
        ...(via ? { via } : {}),
        ...(via === 'spotify' ? { lists: [op.list] } : {}),
        times: 1,
        first: now,
        last: now,
        ...(prompt != null ? { prompt: String(prompt).slice(0, 200) } : {}),
        server,
        section: String(op.section),
        library: op.library,
      });
    }
  }
  const moved = new Set(noting);
  return { list: trimMissing([...kept.filter((m) => !moved.has(m)), ...noting]), keys: [...noted] };
}

// Another list of `server`'s (a browser's own, the first time it meets the
// account's), put together with this one: one on both is counted as often
// as the more of them says (a Spotify one's playlists each once), unless it
// came from somewhere else on each (an AI playlist, Spotify): then it's as it
// was noted last. (So putting the same one together again changes nothing:
// a browser's list kept on the device for a while, its account's before
// that, isn't counted twice.)
export function applyMerge(list, entries = [], { server } = {}) {
  const out = list.slice();
  const index = new Map();
  out.forEach((m, i) => m.server === server && index.set(idOf(m), i));
  for (const e of entries) {
    const m = { ...e, server };
    const i = index.get(idOf(m));
    if (i === undefined) {
      index.set(idOf(m), out.length);
      out.push(m);
      continue;
    }
    const have = out[i];
    if (sourceOf(have) !== sourceOf(m)) {
      if ((m.last || 0) > (have.last || 0)) out[i] = m;
      continue;
    }
    const merged = { ...have };
    if (sourceOf(m) === 'spotify') {
      const lists = shortLists([...(Array.isArray(have.lists) ? have.lists : []), ...(Array.isArray(m.lists) ? m.lists : [])]).slice(0, MISSING_LISTS);
      merged.lists = lists;
      merged.times = Math.max(have.times || 1, m.times || 1, lists.length);
    } else {
      merged.times = Math.max(have.times || 1, m.times || 1);
    }
    merged.first = Math.min(have.first || m.first || 0, m.first || have.first || 0);
    if ((m.last || 0) > (have.last || 0)) {
      merged.last = m.last;
      merged.library = m.library || have.library;
      if (m.prompt != null) merged.prompt = m.prompt;
      else delete merged.prompt;
    }
    if (m.mb === 'real') merged.mb = 'real';
    out[i] = merged;
  }
  return trimMissing(out);
}

// Those of `server`'s with these ids taken off (taken off the list, or found
// in the library).
export function applyForget(list, ids = [], { server } = {}) {
  const gone = new Set(ids);
  return list.filter((m) => !(m.server === server && gone.has(idOf(m))));
}

// All of `server`'s taken off (other servers' stay).
export function applyClear(list, { server } = {}) {
  return list.filter((m) => !onServer(server)(m));
}

// What MusicBrainz said of those of `server`'s it was asked about (by id):
// `real` ones are marked so, `dropped` ones (that it doesn't know, or albums
// taken for songs) let go, unless they've become real meanwhile (from
// Spotify, say). Returns the list, and those let go.
export function applyVerdicts(list, { real = [], dropped = [] } = {}, { server } = {}) {
  const isReal = new Set(real);
  const isDropped = new Set(dropped);
  const out = [];
  const gone = [];
  for (const m of list) {
    if (m.server !== server) {
      out.push(m);
      continue;
    }
    const id = idOf(m);
    if (isDropped.has(id) && m.via !== 'spotify' && m.mb !== 'real') {
      gone.push(m);
      continue;
    }
    if (isReal.has(id)) m.mb = 'real';
    out.push(m);
  }
  return { list: out, dropped: gone };
}

// Entries let go put back on `server`'s list (an undo), unchecked again: not
// those on it again meanwhile.
export function applyRestore(list, entries = [], { server } = {}) {
  const out = list.slice();
  const have = new Set(out.filter(onServer(server)).map(idOf));
  for (const e of entries) {
    const m = { ...e, server };
    delete m.mb;
    if (have.has(idOf(m))) continue;
    out.push(m);
    have.add(idOf(m));
  }
  return trimMissing(out);
}

// One change, as sent to the player (op.type: note, merge, forget, clear,
// mb or restore), to `server`'s list.
export function applyOp(list, op, { server, prompt } = {}) {
  if (op.type === 'note') return applyNote(list, op, { server, prompt }).list;
  if (op.type === 'merge') return applyMerge(list, op.entries, { server });
  if (op.type === 'forget') return applyForget(list, op.ids, { server });
  if (op.type === 'clear') return applyClear(list, { server });
  if (op.type === 'mb') return applyVerdicts(list, op, { server }).list;
  if (op.type === 'restore') return applyRestore(list, op.entries, { server });
  return list;
}
