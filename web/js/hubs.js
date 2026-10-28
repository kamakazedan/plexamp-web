// Plex's hubs for an artist's page (/hubs/metadata/{id}): the rows Plex's
// own apps show there, as Plexamp does (Albums, Singles & EPs, Live albums,
// Compilations, Appears On...). Plex keeps an artist's albums proper (its
// "true albums", their /children) apart from their other releases, which
// are in these rows (and in the library's albums by them), and its
// listings don't say which kind of release each is: here, which kind each
// of the artist's albums is, by the hub it's in, the albums of theirs the
// hubs have, and the albums of others' that the artist appears on.

import { plexKind, norm } from './releases.js';

// What a hub's identifier ("artist.albums.single"), context or title
// ("Singles & EPs") says it holds, word by word: the first of these.
const KIND_WORDS = [
  ['appears', /\b(appears?|appearances?|featured|guest)\b/],
  ['singles', /\b(singles?|eps?)\b/],
  ['live', /\blive\b/],
  ['compilations', /\bcompilations?\b/],
  ['soundtracks', /\b(soundtracks?|scores?)\b/],
  ['remixes', /\bremix(es)?\b/],
  ['djmixes', /\bdj ?mix(es)?\b/],
  ['mixtapes', /\bmixtapes?\b/],
  ['demos', /\bdemos?\b/],
];

// "artist.albums.djMix" -> " artist albums dj mix "
const wordsOf = (v) =>
  ` ${String(typeof v === 'string' ? v : '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()} `;

// The kind of release a hub holds: one of RELEASE_KINDS' ('singles',
// 'live'...), 'appears' (others' albums the artist is on), 'albums' if all
// it says is albums, or null if it says nothing known. Its identifier first
// (the same in any language), then its context, then its title.
export function hubKind(hub) {
  const said = [hub?.hubIdentifier, hub?.context, hub?.title].map(wordsOf);
  for (const words of said) for (const [kind, re] of KIND_WORDS) if (re.test(words)) return kind;
  return said.some((words) => /\balbums?\b/.test(words)) ? 'albums' : null;
}

const itemsOf = (hub) => [hub?.Metadata, hub?.Directory].flatMap((v) => (Array.isArray(v) ? v : v && typeof v === 'object' ? [v] : []));
const isId = (v) => /^\d+$/.test(String(v ?? ''));

// A track's album, as an album card needs it (its id, title, picture, year
// and album artist), or null if the track doesn't say which it's on.
export function albumOfTrack(t) {
  if (!t || !isId(t.parentRatingKey)) return null;
  const id = String(t.parentRatingKey);
  return {
    ratingKey: id,
    key: `/library/metadata/${id}/children`,
    type: 'album',
    title: t.parentTitle || '',
    thumb: t.parentThumb || '',
    parentRatingKey: isId(t.grandparentRatingKey) ? String(t.grandparentRatingKey) : '',
    parentTitle: t.grandparentTitle || '',
    year: Number(t.parentYear) || null,
  };
}

// What an artist's hubs say (`hubs` as Plex gives them, `artistId` the
// artist's): `kinds`, the kind of each of their albums that's in one (album
// id -> kind; an album's own Format and Subformat first, where the hub has
// them), `own`, those albums that the hub says are theirs (album id -> the
// album as the hub has it), and
// `appears`, the albums of others' in a hub of what they appear on, each
// once, in Plex's order (tracks there stand for their albums). Hubs of
// anything else are left out, as are others' albums elsewhere.
export function releasesFromHubs(hubs, artistId) {
  const me = String(artistId);
  const kinds = new Map();
  const own = new Map();
  const appears = [];
  const seen = new Set();
  const theirs = (m) => {
    const id = String(m.ratingKey);
    if (!seen.has(id)) {
      seen.add(id);
      appears.push(m);
    }
  };
  for (const hub of Array.isArray(hubs) ? hubs : []) {
    const said = hubKind(hub);
    // (An item that doesn't say what it is is what the hub holds.)
    const items = itemsOf(hub)
      .filter((m) => m && typeof m === 'object' && isId(m.ratingKey))
      .map((m) => (m.type ? m : { ...m, type: hub.type }));
    if (said === 'appears') {
      for (const t of items.filter((m) => m.type === 'track')) {
        const album = albumOfTrack(t);
        if (album && album.parentRatingKey !== me) theirs(album);
      }
    }
    for (const m of items.filter((x) => x.type === 'album')) {
      // Whose it is: the album artist Plex gives it, or, where it doesn't
      // say, the row's. Others' are what they appear on only in a row that
      // says so (not in one of a label's albums, say).
      const by = m.parentRatingKey;
      const mine = isId(by) ? String(by) === me : said !== 'appears';
      if (said === 'appears') {
        if (!mine) theirs(m);
        continue;
      }
      if (!mine) continue;
      const id = String(m.ratingKey);
      // (Shown as theirs only where the row says so: one it doesn't say
      // the artist of is only given its kind.)
      if (isId(by) && !own.has(id)) own.set(id, m);
      const kind = plexKind(m) || said;
      // (In two hubs: the one that says more than albums.)
      if (kind && (!kinds.has(id) || kinds.get(id) === 'albums')) kinds.set(id, kind);
    }
  }
  return { kinds, own, appears };
}

// Whether a track's credited to the artist whose name is `want` (as norm
// has it): its track artist, the whole credit, or a name either side of a
// featured or guest credit ("Blondie feat. Iggy Pop", "Underworld vs.
// Blondie", "A x B", or names after ";" or " / "), or of a list of names
// with commas (and no "&", "and" or "+": "David Guetta, Sia" is Sia's)
// where `known`, the library's artists' names (as norm has them), says
// that isn't one artist's name of its own ("Tyler, The Creator"). Never a
// part of a name with "&", "and" or "+" in it: Sam & Dave aren't Dave,
// nor Earth, Wind & Fire Earth.
const FEATURING = /\s+(?:feat\.?|ft\.?|featuring|with|vs\.?|x)\s+|\s*;\s*|\s+\/\s+/i;
const JOINED = /&|\+|\sand\s/i;
export function creditedTo(t, want, known = null) {
  const credit = typeof t?.originalTitle === 'string' ? t.originalTitle : '';
  if (!want || !credit) return false;
  if (norm(credit) === want) return true;
  return credit.split(FEATURING).some(
    (part) => norm(part) === want || (known instanceof Set && !JOINED.test(part) && !known.has(norm(part)) && part.split(/\s*,\s*/).some((name) => norm(name) === want)),
  );
}
