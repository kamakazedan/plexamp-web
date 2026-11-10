// Of an artist's songs that the library has more than one copy of (on the
// album, a single, a compilation, a live album, an album of new recordings
// of their hits...), the original: the copy Popular tracks lists and plays
// (plex.js popularTracks). Nothing here names anyone's music: it goes by
// what Plex says each album is, the years, and the tracks' own titles and
// lengths.
import { albumKey, asides, norm, SAME_LENGTH_MS } from './releases.js';

// Kinds of album (releases.js RELEASE_KINDS) whose copies are other takes
// of a song than the original.
const OTHER_TAKES = new Set(['live', 'remixes', 'djmixes', 'mixtapes', 'demos']);

// An aside that says a recording session ("(BBC Session)", "(The Abbey
// Road Sessions)"): another take, as a live or acoustic one is.
const SESSION = /\bsessions?\b/;

// A song, whatever its title says of the version, who's featured or what
// it's from: "Signal Fires (Extended Mix)", "Signal Fires - Radio Edit",
// "Signal Fires (feat. Ana)" and "Signal Fires" are Signal Fires. Its other
// asides stay: "Tides (Part 1)" and "Tides (Part 2)" are two songs.
const NOT_ANOTHER_SONG = /^(feat|featuring|ft|with)\b|\bfrom\b/;
export function songOf(title) {
  const head = norm(String(title || '').split(/\s+[-–—:]\s+/)[0]);
  if (!head) return '';
  const own = asides(title).filter((a) => !a.versioned && !SESSION.test(a.text) && !NOT_ANOTHER_SONG.test(a.text));
  return [head, ...own.map((a) => a.text).sort()].join(' | ');
}

// A copy whose title says it's another take: live, a remix, an edit, an
// acoustic one, a session's... (releases.js asides).
const saysOtherTake = (title) => asides(title).some((a) => a.versioned || SESSION.test(a.text));

// Albums of new recordings of the artist's songs (an orchestral or acoustic
// album of their hits, say), which Plex has as an album like any other:
// most of what's here of the album (its copies, but its other takes), two
// at least, are songs the library has elsewhere too (not on another edition
// of it, nor as another take), each another length than every other copy
// of it, by more than SAME_LENGTH_MS. An original album's songs are the
// length of their copies on a compilation, and one or two in another edit
// elsewhere (a single's) don't make it new recordings.
function newRecordings(copies) {
  const bySong = new Map();
  for (const c of copies) {
    if (!bySong.has(c.song)) bySong.set(c.song, []);
    bySong.get(c.song).push(c);
  }
  const counted = new Map(); // album id -> [its copies, those of another length than every copy elsewhere]
  for (const list of bySong.values()) {
    for (const c of list) {
      if (c.otherTake) continue;
      const n = counted.get(c.album) || [0, 0];
      n[0] += 1;
      const others = c.ms ? list.filter((o) => o.edition !== c.edition && !o.otherTake && o.ms) : [];
      if (others.length && others.every((o) => Math.abs(o.ms - c.ms) > SAME_LENGTH_MS)) n[1] += 1;
      counted.set(c.album, n);
    }
  }
  const out = new Set();
  for (const [album, [all, other]] of counted) if (other >= 2 && other * 2 > all) out.add(album);
  return out;
}

// Each song once, the most popular first (Plex's popularity, ratingCount),
// `limit` of them at most, each as its original copy: the studio album's
// where the library has it, or else a single's or an EP's, or else a
// compilation's (or a soundtrack's), or else one from an album of new
// recordings (see newRecordings), and only where there's nothing else a
// live, remixed or demo take (by its album's kind, or its own title); of
// several, the earliest album's (its plain edition's, of editions of a
// year). `rows`: the artist's tracks as Plex lists them, the most popular
// first, every copy; `kinds`: album id -> its kind (as releases.js plexKind
// has it: none, or null, where Plex hasn't said). [{ row, alike }]: each
// song's row chosen, as it is, and its copies on other editions of that
// album, the same recording (`alike`: the best-sounding of them is played,
// as plex.js popularTracks chooses).
export function originalCopies(rows, kinds = new Map(), limit = Infinity) {
  const copies = (Array.isArray(rows) ? rows : [])
    .filter((m) => m && typeof m === 'object' && m.ratingKey != null)
    .map((m, i) => {
      const album = String(m.parentRatingKey ?? '');
      const kind = kinds.get(album) || 'albums';
      return {
        m,
        i,
        song: songOf(m.title),
        album,
        // (Another edition of an album isn't another album: "Fever" and
        // "Fever (Deluxe Edition)" have the same recordings.)
        edition: albumKey(m.parentTitle) || `#${album}`,
        kind,
        otherTake: saysOtherTake(m.title) || OTHER_TAKES.has(kind),
        year: Number(m.parentYear) || 9999,
        // (An album's edition that says nothing of which it is: "Fever", not
        // "Fever (Deluxe Edition)" or "Fever - 2021 Remaster".)
        plain: !/[([]|\s[-–—:]\s/.test(String(m.parentTitle || '')),
        ms: Number(m.duration) || 0,
        count: Number(m.ratingCount) || 0,
      };
    })
    .filter((c) => c.song);
  const remade = newRecordings(copies);
  const tier = (c) => {
    if (c.otherTake) return 4;
    if (remade.has(c.album) && (c.kind === 'albums' || c.kind === 'singles')) return 3;
    return c.kind === 'albums' ? 0 : c.kind === 'singles' ? 1 : 2;
  };
  const songs = new Map(); // song -> { first: its most popular copy's place, best: the copy chosen }
  for (const c of copies) {
    const s = songs.get(c.song);
    if (!s) {
      songs.set(c.song, { first: c.i, count: c.count, best: c });
      continue;
    }
    s.count = Math.max(s.count, c.count);
    const b = s.best;
    const better = tier(c) - tier(b) || c.year - b.year || Number(b.plain) - Number(c.plain) || b.count - c.count || c.i - b.i;
    if (better < 0) s.best = c;
  }
  const sameRecording = (a, b) => a !== b && a.edition === b.edition && !a.otherTake && tier(a) === tier(b) && (!a.ms || !b.ms || Math.abs(a.ms - b.ms) <= SAME_LENGTH_MS);
  return [...songs.entries()]
    .sort(([, a], [, b]) => b.count - a.count || a.first - b.first)
    .slice(0, Math.max(0, limit))
    .map(([song, s]) => ({ row: s.best.m, alike: copies.filter((c) => c.song === song && sameRecording(c, s.best)).map((c) => c.m) }));
}
