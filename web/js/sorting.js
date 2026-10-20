// Sorting a playlist or a collection in Plex. Plex keeps their order one
// entry at a time ("put this one after that one"), so sorting works out the
// order wanted, then the fewest moves that make it: the longest run of
// entries already in order relative to each other stays where it is, and
// only the rest move.

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true, ignorePunctuation: true });
// "The Prodigy" sorts under P, as in Plex.
const ARTICLES = /^(the|a|an)\s+/i;
export const sortName = (v) =>
  String(v || '')
    .trim()
    .replace(ARTICLES, '');

// The sort keys of a Plex item: a track, an album or an artist.
function keysOf(m) {
  if (m.type === 'album') {
    const title = sortName(m.titleSort || m.title);
    return { artist: sortName(m.parentTitle), title, album: title, year: Number(m.year) || 0, disc: 0, index: 0 };
  }
  if (m.type === 'artist') {
    const name = sortName(m.titleSort || m.title);
    return { artist: name, title: name, album: '', year: 0, disc: 0, index: 0 };
  }
  return {
    artist: sortName(m.originalTitle || m.grandparentTitle),
    title: sortName(m.titleSort || m.title),
    album: sortName(m.parentTitle),
    year: Number(m.parentYear || m.year) || 0,
    disc: Number(m.parentIndex) || 0,
    index: Number(m.index) || 0,
  };
}

// Ways to sort, and the keys each compares in turn.
const ORDERS = {
  artist: ['artist', 'year', 'album', 'disc', 'index', 'title'],
  title: ['title', 'artist', 'album'],
  album: ['album', 'artist', 'disc', 'index', 'title'],
  year: ['year', 'artist', 'album', 'disc', 'index'],
};

// The choices for a list holding tracks, albums or artists: [value, label].
export function sortChoices(kind = 'track') {
  if (kind === 'artist') return [['artist', 'Name'], ['reverse', 'Reverse the order']];
  if (kind === 'album') return [['artist', 'Artist'], ['title', 'Album name'], ['year', 'Year'], ['reverse', 'Reverse the order']];
  return [['artist', 'Artist'], ['title', 'Track name'], ['album', 'Album'], ['year', 'Year'], ['reverse', 'Reverse the order']];
}

function compare(a, b, field) {
  const x = a[field];
  const y = b[field];
  if (typeof x === 'number') {
    // An unknown year goes last.
    if (field === 'year') return (x || 9999) - (y || 9999);
    return x - y;
  }
  if (!x !== !y) return x ? -1 : 1; // no name: last
  return collator.compare(x, y);
}

// The items in the order `by` asks for (A to Z; years oldest first). Items
// that compare the same keep their order.
export function sortedOrder(items, by) {
  if (by === 'reverse') return items.slice().reverse();
  const fields = ORDERS[by];
  if (!fields) throw new Error(`Unknown sort: ${by}`);
  return items
    .map((m, i) => ({ m, i, k: keysOf(m) }))
    .sort((a, b) => {
      for (const f of fields) {
        const d = compare(a.k, b.k, f);
        if (d) return d;
      }
      return a.i - b.i;
    })
    .map((x) => x.m);
}

// The longest run of positions that already go up, as indices into `seq`.
function longestIncreasing(seq) {
  const tails = [];
  const prev = new Array(seq.length);
  for (let i = 0; i < seq.length; i++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (seq[tails[mid]] < seq[i]) lo = mid + 1;
      else hi = mid;
    }
    prev[i] = lo ? tails[lo - 1] : -1;
    tails[lo] = i;
  }
  const keep = new Set();
  for (let i = tails.length ? tails[tails.length - 1] : -1; i >= 0; i = prev[i]) keep.add(i);
  return keep;
}

// The moves that turn `current` (entry ids, in their order now) into
// `target` (the same ids, in the order wanted), as [{ id, after }], where
// `after` is the id to put it after, or null for the top. Made in turn, each
// move's `after` is already in place.
export function planMoves(current, target) {
  const pos = new Map(current.map((id, i) => [String(id), i]));
  if (pos.size !== target.length || target.some((id) => !pos.has(String(id)))) throw new Error('The lists don’t match.');
  const keep = longestIncreasing(target.map((id) => pos.get(String(id))));
  const moves = [];
  target.forEach((id, i) => {
    if (!keep.has(i)) moves.push({ id: String(id), after: i ? String(target[i - 1]) : null });
  });
  return moves;
}

// The order `previous` asked for, as far as it can still be had: entries
// that have gone are left out, and new ones go at the end (for undoing a
// sort after other changes).
export function restoreOrder(now, previous) {
  const have = new Set(now.map(String));
  const was = new Set(previous.map(String));
  return [...previous.map(String).filter((id) => have.has(id)), ...now.map(String).filter((id) => !was.has(id))];
}

// Makes the moves one at a time, saying how far it's got. Stops early if
// the signal says so; resolves to how many were made.
export async function applyMoves(moves, move, { signal, onProgress } = {}) {
  let done = 0;
  for (const m of moves) {
    if (signal?.aborted) break;
    await move(m.id, m.after);
    done++;
    onProgress?.(done, moves.length);
  }
  return done;
}

// Puts a list in Plex in the order wanted: the fewest moves, then a look at
// the order Plex has, and another go at anything that didn't end up where
// it should (twice at most), so the result is right whatever the server
// does with a move. read() gives the entries as Plex has them now, idOf()
// an entry's id, target(entries) the ids in the order wanted. onProgress(n,
// of, { total, checking }): n of the `of` that need moving are moved, of
// `total` entries; `checking` for a second go. Resolves to { total, moved,
// stopped, before } (`moved` from the first go; `before`: the ids as they
// were, for Undo).
export async function saveOrder({ read, idOf, target, move, signal, onProgress }) {
  let entries = await read();
  const before = entries.map(idOf);
  const total = entries.length;
  let moved = 0;
  for (let pass = 0; pass < 3; pass++) {
    const moves = planMoves(entries.map(idOf), target(entries));
    if (pass === 0) moved = moves.length;
    if (!moves.length) break;
    await applyMoves(moves, move, { signal, onProgress: (n, of) => onProgress?.(n, of, { total, checking: pass > 0 }) });
    if (signal?.aborted) return { total, moved, stopped: true, before };
    entries = await read();
  }
  return { total, moved, stopped: false, before };
}
