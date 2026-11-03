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
// ("Rumours - 35th Anniversary Edition", "Abbey Road - Remastered 2009"),
// or what kind ("Shadows - EP", "Heat - Single", as stores title them).
const EDITION = /\b(remaster(ed)?|deluxe|edition|expanded|anniversary|bonus|version|reissue|mono|stereo|special|legacy|\d{4} mix|ep|single)\b/;
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

// ---------- years and genres to fix ----------

// Words in a title's asides (in brackets, or after a dash) that make it
// another recording, not another edition of the same one: a remix, an
// edit, a live or acoustic one, a re-recording ("(The Cube Guys Remix)",
// "[Radio Edit]", " - Live", "(Taylor's Version)", "(2021 Version)"). And
// those that only say which edition, or what kind, it is ("(Deluxe
// Edition)", "(2011 Remaster)", " - EP", "(Disc 1)", "(Explicit)").
const VERSIONED = /\b(re ?mix(es|ed)?|rmx|mix(es)?|edit(s|ed)?|re ?work(s|ed)?|bootleg|vip|dub|live|unplugged|acoustic|instrumentals?|a ?cappella|demos?|extended|radio|club|re ?record(ed|ing)?|covers?|karaoke|versions?|sped ?up|slowed|stripped|reprise)\b/;
const EDITION_ONLY = /^(?:(?:\d{4}|\d+(?:st|nd|rd|th)?|digital(?:ly)?|the|and|super|special|deluxe|expanded|anniversary|bonus|tracks?|reissue|remaster(?:ed)?|mono|stereo|legacy|collector s|limited|edition|version|ep|single|lp|dis[ck]|cd|box(?: set)?|explicit|clean|japan(?:ese)?)\s*)+$/;
// (A "version" only beside words that say which edition it is: "(Deluxe
// Version)", "(Remastered Version)". "(2021 Version)" and "(Single Version)"
// are other recordings.)
const EDITION_WORDS = /\b(super|special|deluxe|expanded|anniversary|bonus|reissue|remaster(ed)?|mono|stereo|legacy|collector s|limited|digital(ly)?|explicit|clean|japan(ese)?)\b/;
// ...and any "… Edition" that doesn't say another recording ("(Platinum
// Edition)", "(Tour Edition)").
const editionOnly = (text) => (EDITION_ONLY.test(text) && (!/\bversion\b/.test(text) || EDITION_WORDS.test(text))) || (/ edition$/.test(text) && !VERSIONED.test(text));

// A title's asides, as norm has them: [{ text, versioned }] (`versioned`:
// it says another recording; one that only says which edition isn't
// listed).
export function asides(title) {
  const raw = String(title || '');
  const [head, ...tail] = raw.split(/\s+[-–—:]\s+/);
  const parts = [...head.matchAll(/\(([^()]*)\)|\[([^[\]]*)\]/g)].map((m) => m[1] ?? m[2]).concat(tail);
  return parts
    .map((p) => norm(p))
    .filter((p) => p && !editionOnly(p))
    .map((text) => ({ text, versioned: VERSIONED.test(text) }));
}

// An album's title as it's matched exactly: its title as norm has it, with
// every aside but those that only say which edition it is ("Rumours (2004
// Remaster)" is "Rumours"; "The Beat Goes On (Radio Edit) [The Cube Guys
// Remix]" is all of that).
export function exactKey(title) {
  const head = norm(String(title || '').split(/\s+[-–—:]\s+/)[0]);
  return head ? [head, ...asides(title).map((a) => a.text).sort()].join(' | ') : '';
}

// The release group of an artist's that's this album, by its title alone,
// for its year and genres to be fixed: a studio album of that very title
// (as exactKey has it: MusicBrainz's kind for it is an album's, as kindOf
// has it), never a single or an EP (an artist's singles of one title come
// out again and again, remixed and re-recorded, so which it is can't be
// told from its title), nor a compilation, a live album or the like (their
// titles come again too: "Greatest Hits", "Live"); and of several of that
// title, the one that first came out the year Plex has (`year`), or none:
// which it is can't be told.
export function exactGroup(groups, title, year = null) {
  const want = exactKey(title);
  if (!want || !Array.isArray(groups)) return null;
  const same = groups.filter((g) => g && g.primary === 'Album' && kindOf(g.primary, g.secondary) === 'albums' && exactKey(g.title) === want);
  if (same.length < 2) return same[0] || null;
  const y = Number(year) || null;
  return (y && same.find((g) => firstYear(g) === y)) || null;
}

// The same album title (as albumKey has it), but for a letter or two (as
// sameTitle has it, but never one with more after it: "Rivers of Babylon"
// isn't "Rivers of Babylon: Presenting Boney M.").
export function sameAlbumTitle(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  if (ONE_CHARACTER_WORDS.test(a) || ONE_CHARACTER_WORDS.test(b) || numbersOf(a) !== numbersOf(b)) return false;
  return Math.min(a.length, b.length) >= 6 && editDistance(a, b) <= Math.max(1, Math.floor(Math.min(a.length, b.length) / 10));
}

// Whether two titles are of the same recording, as far as they say: the
// same asides that say another recording (a remix, live...), whatever
// else they say ("Yeah Yeah" and "Yeah Yeah (Remixes)" aren't).
const versionsOf = (title) =>
  asides(title)
    .filter((a) => a.versioned)
    .map((a) => a.text)
    .sort()
    .join(' | ');
export function sameVersion(a, b) {
  return versionsOf(a) === versionsOf(b);
}

// A release short enough (a single or an EP, or six tracks or fewer: an
// album's count of them, `tracks`, 0 where it isn't known) that its tracks
// must be looked at (see versionedTracks) before it's taken as the release
// group Plex has it as, whose first year can be an original's it's a remix
// of; and too short to be taken for one by its title alone (see
// exactAlbum).
export const SHORT_RELEASE = 6;
export function shortRelease(tracks, g) {
  return (Number(tracks) || 0) <= SHORT_RELEASE || g?.primary === 'Single' || g?.primary === 'EP';
}

// Whether the release group Plex has an album as (by Plex's MusicBrainz id
// for it) is that album as its titles say too: the same title, but for a
// letter or two, and the same recording (not "Yeah Yeah (Remixes)" as
// "Yeah Yeah"). Plex can have one wrong.
export function titlesAgree(g, title) {
  return !!g && sameAlbumTitle(albumKey(g.title), albumKey(title)) && sameVersion(g.title, title);
}

// The release group of an artist's that's this very album, for when it
// first came out: the one Plex has it as (`id`, Plex's MusicBrainz id for
// it, where it's one of these), where the titles agree; or else, for an
// album of more than SHORT_RELEASE tracks (`tracks`, Plex's count of them),
// the studio album of its exact title (exactGroup); or none. A single, an
// EP, a compilation or a live album is only ever the one Plex has it as.
// (Plex's id for it, and its title saying it's another: which it is can't
// be told.) By its title, the kind Plex has for it must be MusicBrainz's
// too: see kindsAgree.
export function exactAlbum(groups, title, { id = null, year = null, tracks = 0 } = {}) {
  const list = Array.isArray(groups) ? groups : [];
  const byId = id ? list.find((g) => g?.id === id) : null;
  if (byId) return titlesAgree(byId, title) ? byId : null;
  return (Number(tracks) || 0) > SHORT_RELEASE ? exactGroup(list, title, year) : null;
}

// Whether the kind Plex has for an album (`kind`, as plexKind has it: null
// where Plex hasn't said) is the one MusicBrainz has for a release group of
// its title: a live album isn't a studio album of its title, nor a single
// an album.
export const kindsAgree = (kind, g) => !kind || !g || kind === kindOf(g.primary, g.secondary);

// Whether an album is another recording than its title says, by its tracks:
// one of them says it's a remix, an edit, live... and the album's title
// doesn't ("Yeah Yeah", of "Yeah Yeah (Chocolate Puma Remix)"). An album
// whose title says so itself ("Yeah Yeah (Remixes)") is as it says.
export function versionedTracks(albumTitle, trackTitles) {
  if (versionsOf(albumTitle)) return false;
  const own = ` ${exactKey(albumTitle).replace(/ \| /g, ' ')} `;
  return (Array.isArray(trackTitles) ? trackTitles : []).some((t) => asides(t).some((a) => a.versioned && !own.includes(` ${a.text} `)));
}
