// What kind of release an album is, and which of an artist's MusicBrainz
// release groups it is: the same rules in the app (an artist's page, the
// MusicBrainz features: mb.js) and in the player's service
// (server/musicbrainz.js). server/releases.js is a copy of this file (a test
// keeps them the same), so nothing is imported here.

// A name as it's compared (as missinglist.js norm has it): case, accents,
// "&" and "and", what's in brackets, a leading "The" and punctuation don't
// count; and a name with letters of another script in it (宇多田ヒカル,
// Кино) keeps all its letters and numbers, as they're written (NFKC), but
// for Arabic's and Hebrew's vowel points and the tatweel.
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
export function sameTitle(a, b) {
  if (!a || !b) return false;
  if (a === b || a.startsWith(`${b} `) || b.startsWith(`${a} `)) return true;
  if (ONE_CHARACTER_WORDS.test(a) || ONE_CHARACTER_WORDS.test(b)) return false;
  if (a.replace(/\D+/g, ' ').trim() !== b.replace(/\D+/g, ' ').trim()) return false;
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
// one of the album's own kind (`kind`, if it's known), then an album before
// an EP before anything else, then the earliest.
export function matchGroup(groups, title, kind = null) {
  const want = albumKey(title);
  if (!want || !Array.isArray(groups)) return null;
  const exact = groups.filter((g) => albumKey(g.title) === want);
  const near = exact.length ? exact : groups.filter((g) => sameTitle(albumKey(g.title), want));
  if (!near.length) return null;
  const rank = (g) => (kind && kindOf(g.primary, g.secondary) === kind ? 0 : 1) * 10 + (g.primary === 'Album' ? 0 : g.primary === 'EP' ? 1 : 2);
  return near.slice().sort((a, b) => rank(a) - rank(b) || (a.date || '9999').localeCompare(b.date || '9999'))[0];
}
