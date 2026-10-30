// What kind of release an album is, and which of an artist's MusicBrainz
// release groups it is: the same rules in the app (an artist's page, the
// MusicBrainz features: mb.js) and in the player's service
// (server/musicbrainz.js). server/releases.js is a copy of this file (a test
// keeps them the same), so nothing is imported here.

// A name as it's compared (as missinglist.js norm has it): case, accents,
// "&" and "and", what's in brackets, a leading "The" and punctuation don't
// count; and a name with letters of another script in it (宇多田ヒカル,
// Кино) keeps all its letters and numbers, as they're written (NFKC), but
// for what's written one way or the other: Arabic's and Hebrew's vowel
// points and the tatweel, Greek's accents, Russian's ё, Persian's ی and ک.
const plain = (v) =>
  String(v || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .replace(/^the\s+/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
const written = (v) =>
  String(v || '')
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[\u0640\u064b-\u065f\u0670\u0591-\u05bd\u05bf\u05c1\u05c2\u05c4\u05c5\u05c7]/g, '')
    .replace(/&/g, ' and ')
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .replace(/^the\s+/, '')
    .toLowerCase()
    .replace(/\p{Script=Greek}+/gu, (g) => g.normalize('NFD').replace(/\p{M}+/gu, '').normalize('NFC'))
    .replace(/ё/g, 'е')
    .replace(/[يى]/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ')
    .trim();
const OTHER_SCRIPT = /[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}\p{N}\p{M}\s]/u;
export const norm = (v) => {
  const w = written(v);
  return OTHER_SCRIPT.test(w) ? w : plain(v) || w;
};

function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

// Titles (as norm has them) close enough to be the same: one the other with
// more after it, or a letter or two different (not in Chinese, Japanese or
// Korean, where one character can be another word, nor a number).
const ONE_CHARACTER_WORDS = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const numbersOf = (s) => s.replace(/\P{Nd}+/gu, ' ').trim().replace(/(^| )0+(?=\p{Nd})/gu, '$1');
export function sameTitle(a, b) {
  if (!a || !b) return false;
  if (a === b || a.startsWith(`${b} `) || b.startsWith(`${a} `)) return true;
  if (ONE_CHARACTER_WORDS.test(a) || ONE_CHARACTER_WORDS.test(b)) return false;
  if (numbersOf(a) !== numbersOf(b)) return false;
  return Math.min(a.length, b.length) >= 6 && editDistance(a, b) <= Math.max(1, Math.floor(Math.min(a.length, b.length) / 10));
}

// The kinds of release, as an artist's page groups them, in that order.
export const RELEASE_KINDS = [
  ['albums', 'Albums'],
  ['singles', 'Singles & EPs'],
  ['live', 'Live albums'],
  ['compilations', 'Compilations'],
  ['soundtracks', 'Soundtracks'],
  ['remixes', 'Remixes'],
  ['djmixes', 'DJ mixes'],
  ['mixtapes', 'Mixtapes'],
  ['demos', 'Demos'],
  ['other', 'Other'],
];

// A release's kind from its types (MusicBrainz's primary type and secondary
// types, or Plex's Format and Subformat, which come from MusicBrainz): the
// first of its secondary types that has a kind of its own, else its
// primary type.
export function kindOf(primary, secondary = []) {
  const sub = (Array.isArray(secondary) ? secondary : [secondary]).join(' ').toLowerCase();
  if (sub.includes('compilation')) return 'compilations';
  if (sub.includes('live')) return 'live';
  if (sub.includes('soundtrack')) return 'soundtracks';
  if (sub.includes('remix')) return 'remixes';
  if (sub.includes('dj')) return 'djmixes';
  if (sub.includes('mixtape')) return 'mixtapes';
  if (sub.includes('demo')) return 'demos';
  if (/spokenword|interview|audiobook|audio drama|field recording/.test(sub)) return 'other';
  const p = String(primary || '').toLowerCase();
  if (/\b(ep|single)\b/.test(p)) return 'singles';
  return !p || p === 'album' ? 'albums' : 'other';
}

const tags = (v) => (Array.isArray(v) ? v.map((t) => t?.tag) : [v]).filter((t) => typeof t === 'string' && t);
// A Plex album's kind, from its Format and Subformat (null: Plex hasn't
// said, as its listing of an artist's albums doesn't).
export function plexKind(m) {
  const format = tags(m?.Format ?? m?.format);
  const sub = tags(m?.Subformat ?? m?.subformat);
  return format.length || sub.length ? kindOf(format.join(' '), sub) : null;
}

// The year a release group first came out ("1977-05-08"), or null.
export const firstYear = (g) => (/^\d{4}/.test(g?.date || '') ? Number(g.date.slice(0, 4)) : null);

// An album's title as it's matched: as norm has it (without what's in
// brackets), and without what says which edition it is after a dash
// ("Rumours - 35th Anniversary Edition", "Abbey Road - Remastered 2009").
const EDITION = /\b(remaster(ed)?|deluxe|edition|expanded|anniversary|bonus|version|reissue|mono|stereo|special|legacy|\d{4} mix)\b/;
export function albumKey(title) {
  const raw = String(title || '');
  const parts = raw.split(/\s+[-–—:]\s+/);
  return norm(parts.length > 1 && EDITION.test(norm(parts.slice(1).join(' '))) ? parts[0] : raw);
}

// The release group of an artist's that's this album: the same title (as
// albumKey has it), or else near enough (as sameTitle judges); of several,
// those of the album's own kind (`kind`, if it's known), then albums before
// EPs before anything else; and of several still (a self-titled album, say:
// Weezer has six, and a re-recording can have its first's title), the one
// that first came out the year Plex has for the album (`year`), or none:
// which it is can't be told.
export function matchGroup(groups, title, kind = null, year = null) {
  const want = albumKey(title);
  if (!want || !Array.isArray(groups)) return null;
  const exact = groups.filter((g) => albumKey(g.title) === want);
  let near = exact.length ? exact : groups.filter((g) => sameTitle(albumKey(g.title), want));
  if (kind) {
    const own = near.filter((g) => kindOf(g.primary, g.secondary) === kind);
    if (own.length) near = own;
  }
  for (const primary of ['Album', 'EP']) {
    const of = near.filter((g) => g.primary === primary);
    if (of.length) {
      near = of;
      break;
    }
  }
  if (near.length > 1) {
    const y = Number(year) || null;
    near = y ? near.filter((g) => firstYear(g) === y) : [];
  }
  return near.slice().sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999'))[0] || null;
}

// The albums on an artist's page that are another artist's of the same name
// (Plex can have two artists of one name as one, their albums together):
// Map(album id -> that artist, one of `namesakes`), from MusicBrainz, and
// from nothing less than all of this:
//   - who the page's artist is, is plain: Plex says (their MusicBrainz id,
//     `byId`), and MusicBrainz has one of the page's albums for them at
//     least; or else two at least, and more than for the namesake;
//   - MusicBrainz has the album for one of the namesakes, by its very
//     title (as albumKey has it), first out within a year of the year Plex
//     has for it, and for no other namesake;
//   - nothing of that title, or near it, for the page's artist;
//   - it isn't titled as the artist is (a self-titled album, by its name:
//     artists of one name have those by construction);
//   - and what MusicBrainz lists of each of them is all they have (not
//     `capped`, as it is for those with more than it's asked for).
// Anything less, and an album stays theirs, as Plex has it. `items`: the
// page's albums, [{ id, title, year }]; `name`: the artist's; `groups`:
// their release groups (`capped`: as above); `namesakes`: [{ id, name,
// groups, capped }].
export function apartFromNamesakes(items, { name = '', groups = [], capped = false, byId = false, namesakes = [] } = {}) {
  const out = new Map();
  if (!Array.isArray(items) || !items.length || !Array.isArray(namesakes) || !namesakes.length) return out;
  if (capped || namesakes.some((n) => n?.capped)) return out;
  const near = (gs, key) => (Array.isArray(gs) ? gs : []).some((g) => sameTitle(albumKey(g.title), key));
  const theirs = items.filter((it) => near(groups, albumKey(it.title))).length;
  if (theirs < (byId ? 1 : 2)) return out;
  const self = albumKey(name);
  const found = new Map();
  for (const it of items) {
    const key = albumKey(it.title);
    const y = Number(it.year) || null;
    if (!key || !y || key === self || near(groups, key)) continue;
    const hits = namesakes.filter((n) => (Array.isArray(n?.groups) ? n.groups : []).some((g) => albumKey(g.title) === key && firstYear(g) && Math.abs(firstYear(g) - y) <= 1));
    if (hits.length !== 1) continue;
    if (!found.has(hits[0])) found.set(hits[0], []);
    found.get(hits[0]).push(it);
  }
  for (const [n, list] of found) {
    if (!byId && list.length >= theirs) continue;
    for (const it of list) out.set(String(it.id), n);
  }
  return out;
}

// ---------- artists Plex has more than once ----------

// A name that's several in one, as a tag can be ("Alphabeat;FORCE":
// several artists joined by ";", which Plex takes for one artist's name):
// its names, or null where it's one. (Only ";": "&", "," and "and" are in
// plenty of one artist's name.)
export function joinedParts(name) {
  const parts = String(name || '')
    .split(';')
    .map((p) => p.trim())
    .filter(Boolean);
  return parts.length > 1 ? parts : null;
}

// An album that's this release group's, plainly: by its very title (as
// albumKey has it), first out within a year of the year Plex has for it,
// and not titled as the artist is (artists of one name have self-titled
// albums by construction).
function plainly(groups, it, self) {
  const key = albumKey(it?.title);
  const y = Number(it?.year) || null;
  if (!key || !y || key === self) return false;
  return (Array.isArray(groups) ? groups : []).some((g) => albumKey(g.title) === key && firstYear(g) && Math.abs(firstYear(g) - y) <= 1);
}

// Album titles plenty of artists have: of one word ("Live", "Christmas",
// "Love", "Home"), of three letters or fewer ("Up"), live at somewhere
// ("Live in Tokyo"), or of stock words and numbers alone ("Greatest Hits
// Vol. 2", "BBC Sessions", "The Complete Recordings", "Second Album",
// "II"), the artist's own name aside ("The Best of Alphabeat", "Alphabeat
// Live"). `key`: the title as albumKey has it; `self`: the artist's name,
// as albumKey has it. An album of one such title that's an artist's, by its
// title and year, isn't plain evidence on its own that it's that artist's
// rather than another's of the name.
const STOCK = new Set(
  `a an and the of in at on from to for with by
  best very greatest hits hit essential essentials singles single b side sides rarities rare
  remix remixes remixed mix mixes collection collected complete recordings recorded anthology
  demo demos live unplugged acoustic instrumental instrumentals untitled unreleased ep lp album albums
  mixtape sampler compilation retrospective gold platinum covers cover sessions session debut
  christmas xmas holiday holidays songs song love ballads bbc peel mtv radio tracks bonus
  remastered remaster deluxe edition expanded version versions vol volume part pt no chapter book
  first second third new early years favourites favorites selected works anniversary special
  one two three four five six seven eight nine ten`.split(/\s+/),
);
const ROMAN = /^(?=[mdclxvi])m{0,3}(?:cm|cd|d?c{0,3})(?:xc|xl|l?x{0,3})(?:ix|iv|v?i{0,3})$/;
export function genericTitle(key, self = '') {
  let k = String(key || '');
  if (self && k !== self) k = ` ${k} `.replace(` ${self} `, ' ').trim();
  const words = k.split(' ').filter(Boolean);
  if (k.length < 4 || words.length < 2 || /^live (?:in|at|from|on) /.test(k)) return true;
  return words.every((w) => STOCK.has(w) || /^\d+$/.test(w) || ROMAN.test(w));
}

// Whether library artists are one artist, the artist of `name`, to merge
// them in Plex (its owner's to do): those of that very name (Plex makes two
// of one from files tagged otherwise), or with that name among several in
// theirs (`joined`: see joinedParts), and the artist of that name. `entries`:
// [{ mbid, albums: [{ title, year }] }] (`mbid`: the MusicBrainz id Plex
// has, where it has one; `joined`, the first is the artist of the plain
// name, the second the one of several names in one); and what MusicBrainz
// has of the name (`artist`, `groups`, `capped`, `namesakes` and
// `moreNamesakes`, as mb.js artistOnMB gives them: asked by the id Plex has
// for one of them, if it has one). 'same' only on plain evidence, album by
// album (even where Plex has the same MusicBrainz id for each: Plex can
// have taken an artist MusicBrainz doesn't know for the one of the name it
// does):
//   - MusicBrainz has the artist (by that id, where Plex has one, and Plex
//     has no other), and what's listed of them is all they have (not
//     `capped`), and of the others of the name too (nor more of those than
//     are listed: `moreNamesakes`);
//   - none of them has an album that's plainly another artist's of the name
//     (`namesakes`) and not this one's;
//   - and each has albums that are plainly that artist's (see plainly) and
//     not another's: two at least, or one of a title few others have (see
//     genericTitle). `joined`: the artist of the plain name does, and the
//     one of several names does too, unless MusicBrainz has no other artist
//     of the name at all (the name the tag gives is theirs, then).
// 'different': Plex has different ids for them (but `joined`: which of
// the names Plex has an id for can't be told), or an album of one is
// plainly another's of the name and not this one's (by a title few others
// have). Anything else: 'unknown', and they're left as they are.
export function sameArtist(entries, { name = '', artist = null, groups = [], capped = false, namesakes = [], moreNamesakes = false, joined = false } = {}) {
  if (!Array.isArray(entries) || entries.length < 2) return 'unknown';
  const ids = [...new Set(entries.map((e) => e?.mbid).filter(Boolean))];
  if (ids.length > 1) return joined ? 'unknown' : 'different';
  if (!artist?.id || (ids.length === 1 && artist.id !== ids[0]) || capped) return 'unknown';
  const others = Array.isArray(namesakes) ? namesakes : [];
  const self = albumKey(name);
  const albumsOf = (e) => (Array.isArray(e?.albums) ? e.albums : []);
  const theirs = (it) => plainly(groups, it, self);
  const another = (it) => others.some((n) => plainly(n?.groups, it, self));
  const apart = entries.flatMap((e) => albumsOf(e).filter((it) => another(it) && !theirs(it)));
  if (apart.some((it) => !genericTitle(albumKey(it.title), self))) return 'different';
  if (apart.length || moreNamesakes || others.some((n) => n?.capped)) return 'unknown';
  const plain = (e) => {
    const keys = new Set(albumsOf(e).filter((it) => theirs(it) && !another(it)).map((it) => albumKey(it.title)));
    return keys.size >= 2 || [...keys].some((k) => !genericTitle(k, self));
  };
  if (joined) return plain(entries[0]) && (plain(entries[1]) || !others.length) ? 'same' : 'unknown';
  return entries.every(plain) ? 'same' : 'unknown';
}
