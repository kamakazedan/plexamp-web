import { app } from '../state.js';
import { normTrack } from '../plex.js';
import { back, dropCached, describeError, refresh, popOverlay } from '../router.js';
import {
  h,
  art,
  icon,
  backHeader,
  collapseWhenHidden,
  sectionHeader,
  shelf,
  grid,
  row,
  iconButton,
  clampText,
  pagedList,
  emptyState,
  enableDrag,
  askText,
  confirmAction,
  toast,
  fmt,
  pointOut,
  learned,
  sheet,
  download,
  fileDate,
} from '../ui.js';
import { albumCard, artistCard, trackRow, numberedList, collectionCard, playlistCard, playlistArt } from '../components.js';
import { sharingOn, freshShares, sharesSoon, shareOf, syncShare, sharedPlaylistChanged, sharedMark, stopSharing, leaveShared } from '../sharing.js';
import { openShareDialog, leaveDialog, shareLine } from './share.js';
import {
  playAlbum,
  playArtist,
  playPlaylist,
  playCollection,
  artistRadio,
  playlistRadio,
  albumMenu,
  artistMenu,
  playlistMenu,
  collectionMenu,
  playList,
  trackMenu,
} from '../actions.js';
import { isAdmin } from '../editing.js';
import { codecsOf, albumFormatOf, audioStream, wantsDetail } from '../formats.js';
import { norm } from '../missinglist.js';
import { browseHref } from './library.js';
import { mbFeatures, mbOn, artistOnMB, albumsOnMB, matchGroup, albumKey, kindOf, plexKind, firstYear, RELEASE_KINDS, KIND_NAMES } from '../mb.js';
import { releasesFromHubs, albumOfTrack, creditedTo } from '../hubs.js';
import { artistAppearsIn } from '../membership.js';
import { chooseMissingKinds, missingKinds } from './mbsettings.js';
import { copyText, toCsv } from '../missing.js';
import { clearSelection } from '../selection.js';
import { sortChoices, sortedOrder, restoreOrder, saveOrder } from '../sorting.js';

function actionButtons(buttons) {
  return h(
    'div.hero-actions',
    null,
    buttons.map((b) =>
      h(
        `button.btn.${b.primary ? 'btn-primary' : 'btn-secondary'}`,
        { type: 'button', onclick: b.onClick, 'aria-label': b.label },
        icon(b.icon, 20),
        h('span', null, b.label),
      ),
    ),
  );
}

const year = (m) => m.year || (m.originallyAvailableAt || '').slice(0, 4) || null;

// The album's best-known tracks (Plex's play counts from Last.fm), for the
// "popular" badge: up to three, and only clear favourites.
function popularIds(tracks) {
  if (app.settings.popularTracks === false || tracks.length < 4) return new Set();
  const counted = tracks.filter((t) => t.ratingCount > 0).sort((a, b) => b.ratingCount - a.ratingCount);
  if (counted.length < 2) return new Set();
  const top = counted[0].ratingCount;
  return new Set(counted.slice(0, 3).filter((t) => t.ratingCount >= top * 0.3).map((t) => t.id));
}

// "FLAC 24/96" style badge (formats.js); bit depth and sample rate come
// from the first track's stream details.
function codecBadge(tracks) {
  if (app.settings.codecInfo === false) return null;
  const codecs = codecsOf(tracks);
  const f = albumFormatOf(codecs);
  if (!f) return null;
  const badge = h('span.codec-badge', null, f.text);
  if (wantsDetail(codecs)) {
    app.server
      .trackDetail(tracks[0].id)
      .then((d) => {
        const more = albumFormatOf(codecs, audioStream(d));
        if (!more) return;
        badge.textContent = more.text;
        if (more.hires) {
          badge.classList.add('hires');
          badge.title = 'High resolution';
        }
      })
      .catch(() => {});
  }
  return badge;
}

// ---------- Album ----------

const FIRST_WAIT = 3000; // ms the player may wait on MusicBrainz for when an album first came out

export async function albumView({ el, params }) {
  const s = app.server;
  const [album, children] = await Promise.all([s.metadata(params.id), s.children(params.id)]);
  if (!album) throw Object.assign(new Error('Not found'), { status: 404 });
  const tracks = children.filter((m) => m.type === 'track').map(normTrack);

  const head = backHeader(album.title, { collapse: true, actions: iconButton('more', 'More options', () => albumMenu(album)) });
  const title = h('h1.hero-title', null, album.title);
  const genre = (album.Genre || [])[0]?.tag;
  const meta = [year(album), genre].filter(Boolean).join(', ');
  const badge = codecBadge(tracks);
  const popular = popularIds(tracks);
  // When it first came out, where MusicBrainz says that was before the year
  // Plex has (a remaster's or a reissue's): with Original release years,
  // and the player's MusicBrainz features (mb.js).
  const first = h('div.hero-meta.hero-first', { hidden: true });

  el.append(
    head,
    h(
      'section.hero.hero-album',
      null,
      art(album.thumb, { size: 480, cls: 'hero-art', fallback: 'disc' }),
      h(
        'div.hero-info',
        null,
        title,
        album.parentRatingKey ? h('a.hero-link', { href: `#/artist/${album.parentRatingKey}` }, album.parentTitle) : h('div.hero-link', null, album.parentTitle),
        meta || badge ? h('div.hero-meta', null, meta, badge) : null,
        first,
        actionButtons([
          { icon: 'play', label: 'Play', primary: true, onClick: () => playAlbum(album, { tracks }) },
          { icon: 'shuffle', label: 'Shuffle', onClick: () => playAlbum(album, { tracks, shuffle: true }) },
        ]),
      ),
    ),
  );
  collapseWhenHidden(head, title);

  const list = h('div.tracks.album-tracks');
  const discs = new Set(tracks.map((t) => t.disc ?? 1));
  let lastDisc = null;
  tracks.forEach((t, i) => {
    if (discs.size > 1 && t.disc !== lastDisc) {
      lastDisc = t.disc;
      list.append(h('div.disc-head', null, `Disc ${t.disc ?? 1}`));
    }
    list.append(
      trackRow(t, {
        number: t.index ?? i + 1,
        subtitle: t.artist && t.artist !== t.albumArtist ? t.artist : '',
        onPlay: () => playAlbum(album, { tracks, start: i }),
        popular: popular.has(t.id),
      }),
    );
  });
  el.append(list);

  const total = tracks.reduce((n, t) => n + (t.duration || 0), 0);
  el.append(
    h(
      'div.detail-foot',
      null,
      h('div', null, `${fmt.count(tracks.length, 'track', 'tracks')}, ${fmt.long(total)}`),
      album.studio ? h('div', null, album.studio) : null,
    ),
  );
  if (album.summary) el.append(h('section.block.about', null, sectionHeader('About this album'), h('div.pad', null, clampText(album.summary, 4))));

  if (mbOn('mbOriginalYears') && album.parentTitle && norm(album.parentTitle) !== 'various artists') {
    albumsOnMB([{ artist: album.parentTitle, title: album.title, year: Number(year(album)) || null }], { wait: FIRST_WAIT })
      .then(([g]) => {
        const was = firstYear(g && typeof g === 'object' ? g : null);
        const own = Number(year(album)) || null;
        if (!was || (own && was >= own)) return;
        first.textContent = `First released in ${was}`;
        first.hidden = false;
      })
      .catch(() => {});
  }

  // More by the artist: their albums proper (Plex's /children of the
  // artist), or, where those are none but this, their other releases.
  if (album.parentRatingKey) {
    const others = (list) => list.filter((m) => m?.type === 'album' && String(m.ratingKey) !== String(album.ratingKey) && (!isId(m.parentRatingKey) || String(m.parentRatingKey) === String(album.parentRatingKey)));
    s.children(album.parentRatingKey)
      .then(async (proper) => {
        let more = others(proper);
        if (!more.length) more = others(await s.artistAlbums(album.librarySectionID ?? app.source.sectionKey, album.parentRatingKey));
        if (!more.length) return;
        const row = shelf(more.map((m) => albumCard(m, { subtitle: year(m) || '' })));
        el.append(h('section.block', null, sectionHeader(`More by ${album.parentTitle}`, `/artist/${album.parentRatingKey}`, null, row), row));
      })
      .catch(() => {});
  }
}

// ---------- Artist ----------

// An artist's releases, by kind, in this order (releases.js RELEASE_KINDS:
// Albums, Singles & EPs, Live albums, Compilations...), all of them as Plex
// has them, as Plexamp shows them: the library's albums by them (plex.js
// artistAlbums), their albums proper among them (Plex's /children of the
// artist, its "true albums": nothing else is), and the rest by Plex's rows
// for their page (hubs.js) or their own release types (Format, the main
// one: album, EP, single; Subformat, what else: live, a compilation...).
// MusicBrainz never changes which kind one is. Albums are a grid, the rest
// shelves. Then what they appear on: others' albums with their tracks on
// (compilations, soundtracks, someone else's with them featured); and what
// of yours they're in: your playlists and collections with their music.

const TYPES_WAIT = 700; // ms the albums wait for their kinds, before they're shown as they are
// Albums whose release types one page asks for, at most (40 to a request):
// the rest of a discography that big (Various Artists' can be thousands)
// goes by Plex's rows for the page, as far as those go.
const TYPES_ASKED = 1000;
const keptFor = (id) => `${app.source?.serverId || app.source?.uri || ''}|${id}`;
const idOf = (m) => String(m?.ratingKey ?? '');
const isId = (v) => /^\d+$/.test(String(v ?? ''));

// An album's kind, as Plex says (`st`: `proper`, their albums proper, by
// id, or null where Plex couldn't be asked; `separated`, whether Plex keeps
// those apart from the rest here: the library has albums of theirs that
// aren't (an older server's /children has them all); `rows`, what its rows
// say (hubs.js releasesFromHubs); `types`, albums' release types from their
// details, by id; `settled`, once all of that is in; `various`, whether
// they're Various Artists): the row it's in, where that says more than
// albums, else Albums for one of their albums proper where Plex keeps those
// apart, else its own types, else Albums for one of their albums proper.
// Null while that's still being asked; then, for one Plex says nothing
// more of, Compilations for Various Artists (an album of theirs is one),
// else Albums, or Other for one that Plex keeps apart from their albums
// proper.
export function releaseKind(m, st) {
  const id = idOf(m);
  const row = st.rows?.kinds?.get(id) || null;
  if (row && row !== 'albums') return row;
  const proper = !!st.proper?.has(id);
  if (proper && st.separated) return 'albums';
  const said = plexKind(m) || plexKind(st.types?.get(id));
  if (said) return said;
  if (proper) return 'albums';
  if (!st.settled) return null;
  if (st.various && !row) return 'compilations';
  return row || !st.separated ? 'albums' : 'other';
}

// Their albums, each once: the library's, those proper (as /children has
// them, where the library's listing hasn't), and those Plex's rows have;
// those of others' (that the listing may have, for who's on them) left out.
function ownAlbums(me, ...lists) {
  const out = new Map();
  for (const m of lists.flat()) {
    if (!m || m.type !== 'album' || !isId(m.ratingKey) || out.has(idOf(m))) continue;
    if (isId(m.parentRatingKey) && String(m.parentRatingKey) !== me) continue;
    out.set(idOf(m), m);
  }
  return [...out.values()];
}

// The library's artist of that name (as the app compares names), or null:
// looked for as search does (the name itself first), and kept a while for
// every artist page that names them, in a list of their own too.
const NAMED_KEPT = 2000;
const NAMED_MS = 30 * 60000;
const named = new Map(); // `${server}|${section}|${name}` -> { at, job }
function artistNamed(s, sec, name) {
  const want = norm(name);
  if (!want) return Promise.resolve(null);
  const key = `${keptFor(sec)}|${want}`;
  const hit = named.get(key);
  if (hit && Date.now() - hit.at < NAMED_MS) return hit.job;
  const job = s
    .search(name, sec, { limit: 10 })
    .then((res) => (res.artist || []).find((a) => norm(a.title) === want) || null)
    .catch(() => {
      named.delete(key);
      return null;
    });
  named.delete(key);
  named.set(key, { at: Date.now(), job });
  while (named.size > NAMED_KEPT) named.delete(named.keys().next().value);
  return job;
}

// The artists Plex says are like this one (its metadata's similar artists)
// that this library has, in Plex's order: looked for four at a time, until
// there are `limit`.
async function similarInLibrary(s, sec, artist, limit) {
  const names = [...new Set((artist.Similar || []).map((t) => t?.tag).filter((t) => typeof t === 'string' && t.trim()))].slice(0, 40);
  const seen = new Set([String(artist.ratingKey)]);
  const out = [];
  for (let i = 0; i < names.length && out.length < limit; i += 4) {
    const found = await Promise.all(names.slice(i, i + 4).map((name) => artistNamed(s, sec, name)));
    for (const a of found) if (a && !seen.has(String(a.ratingKey)) && seen.add(String(a.ratingKey))) out.push(a);
  }
  return out.slice(0, limit);
}

// Those that sound like it (Plex's sonic analysis): its nearest artists.
async function sonicallySimilar(s, artist, { limit, maxDistance }) {
  const items = await s.nearest(artist.ratingKey, { limit, maxDistance }).catch(() => []);
  return items.filter((m) => m.type === 'artist' && String(m.ratingKey) !== String(artist.ratingKey));
}

// What an artist appears on, where Plex's rows for their page don't say:
// the albums of others' with a track credited to them (hubs.js
// creditedTo), as Plex's search finds them (by who a track's by, as well as
// its title), and its list of tracks by title (which takes in who they're
// by, on some servers). Kept a few minutes, for going back to the page.
const APPEARS_SEARCH = 100; // tracks looked through, of each
const APPEARS_KEPT_MS = 5 * 60000;
const ROWS_KEPT_MS = 5 * 60000; // what Plex's rows for an artist's page say
function appearsBySearch(s, sec, artist) {
  const me = String(artist.ratingKey);
  const want = norm(artist.title);
  if (!want) return Promise.resolve([]);
  return s.memo(
    `appears:${sec}:${me}`,
    async () => {
      const [found, listed] = await Promise.all([
        s.search(artist.title, sec, { limit: APPEARS_SEARCH }).catch(() => null),
        s.list(sec, 10, { filters: { title: artist.title }, size: APPEARS_SEARCH }).catch(() => null),
      ]);
      // (The library's artists the search found: a credit that's one of
      // theirs is never split. None where the search failed: nothing is.)
      const known = found ? new Set((found.artist || []).map((a) => norm(a.title)).filter(Boolean)) : null;
      const out = new Map();
      for (const t of [...(found?.track || []), ...(listed?.items || [])]) {
        const album = albumOfTrack(t);
        if (!album || album.parentRatingKey === me || out.has(album.ratingKey)) continue;
        // (Plex's search may look further than this library.)
        if (t.librarySectionID != null && String(t.librarySectionID) !== String(sec)) continue;
        if (creditedTo(t, want, known)) out.set(album.ratingKey, album);
      }
      return [...out.values()];
    },
    APPEARS_KEPT_MS,
  );
}

// A tag's key, for a library list filtered by it ("style=123").
const tagKey = (t) => (t?.id != null ? String(t.id) : t?.filter ? String(t.filter).split('=').pop() : '');

const SHELF_ARTISTS = 20;
const ALL_ARTISTS = 60;
const MISSING_SHOWN = 50; // of each kind, on an artist's page

// An artist's MusicBrainz id, where Plex has it (its Guid, asked for with
// includeGuids).
const mbidOf = (artist) =>
  (Array.isArray(artist?.Guid) ? artist.Guid : [])
    .map((g) => String(g?.id || ''))
    .find((g) => /^mbid:\/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(g))
    ?.slice(7) || null;

export async function artistView({ el, params, onDispose }) {
  const s = app.server;
  const sec = app.source.sectionKey;
  const artist = await s.metadata(params.id, mbFeatures() ? { includeGuids: 1 } : undefined);
  if (!artist) throw Object.assign(new Error('Not found'), { status: 404 });

  const head = backHeader(artist.title, { collapse: true, actions: iconButton('more', 'More options', () => artistMenu(artist)) });
  const title = h('h1.hero-title', null, artist.title);
  // On a desktop the photo is a banner as wide as the page, so it's asked
  // for at that width (up to 1920 pixels) rather than stretched.
  const wide = el.clientWidth >= 900;
  el.append(
    head,
    h(
      'section.hero.hero-artist',
      null,
      h('div.artist-photo', null, art(artist.thumb || artist.art, { size: wide ? el.clientWidth : 640, most: wide ? 1920 : 960, fallback: 'mic' })),
      h(
        'div.hero-info',
        null,
        title,
        actionButtons([
          { icon: 'play', label: 'Play', primary: true, onClick: () => playArtist(artist) },
          { icon: 'shuffle', label: 'Shuffle', onClick: () => playArtist(artist, { shuffle: true }) },
          { icon: 'radio', label: 'Radio', onClick: () => artistRadio(artist) },
        ]),
      ),
    ),
  );
  collapseWhenHidden(head, title);

  const popularSlot = h('div');
  const albumsBox = h('div.artist-albums');
  const appearsBox = h('div.artist-appears');
  const inBox = h('div.artist-appears-in');
  const missingBox = h('div.artist-missing');
  const similarSlot = h('div');
  const sonicSlot = h('div');
  el.append(popularSlot, albumsBox, appearsBox, inBox, missingBox, similarSlot, sonicSlot);
  // Its styles, each opening the library's artists of that style.
  const styles = (artist.Style || []).filter((t) => t?.tag && tagKey(t));
  if (styles.length) {
    el.append(
      h(
        'section.block.artist-styles',
        null,
        sectionHeader('Styles'),
        h(
          'div.chips.artist-style-chips',
          { role: 'list' },
          styles.map((t) => h('span.chip-item', { role: 'listitem' }, h('a.chip', { href: `#${browseHref('artists', { style: tagKey(t), title: t.tag })}` }, t.tag))),
        ),
      ),
    );
  }
  if (artist.summary) el.append(h('section.block.about', null, sectionHeader('About'), h('div.pad', null, clampText(artist.summary, 4))));

  const popularP = s.popularTracks(sec, artist.ratingKey, 20).then((items) => {
    const tracks = items.map(normTrack);
    if (!tracks.length) return;
    const list = numberedList({ total: tracks.length });
    const context = { title: `${artist.title}: popular`, href: `/artist/${artist.ratingKey}` };
    tracks.forEach((t, i) => {
      const r = trackRow(t, { showArt: true, position: true, subtitle: t.album, onPlay: () => playList(tracks, i, context) });
      if (i >= 5) r.hidden = true;
      list.append(r);
    });
    const more =
      tracks.length > 5
        ? h(
            'button.link-btn.pad',
            {
              type: 'button',
              onclick: () => {
                const open = more.dataset.open === '1';
                list.querySelectorAll('.track').forEach((r, i) => (r.hidden = !open ? false : i >= 5));
                more.dataset.open = open ? '0' : '1';
                more.textContent = open ? 'Show more' : 'Show less';
              },
            },
            'Show more',
          )
        : null;
    popularSlot.replaceWith(h('section.block', null, sectionHeader('Popular tracks'), list, more));
  });

  // What MusicBrainz says of them, with the player's MusicBrainz features
  // (mb.js), where it's wanted: their release groups, for when their albums
  // first came out (Original release years) and those the library hasn't
  // (Missing albums on artist pages). (Not for Various Artists: theirs is
  // no one's discography.)
  const various = norm(artist.title) === 'various artists';
  const wantMB = (mbOn('mbOriginalYears') || mbOn('mbMissingAlbums')) && !various;
  const mbP = wantMB ? artistOnMB(artist.title, { id: mbidOf(artist) }).catch(() => null) : Promise.resolve(null);
  // Plex's rows for the page (hubs.js): which kind each of their albums is,
  // and what they appear on.
  // (What they say, not the rows themselves, kept a few minutes: going
  // back to the page.)
  const hubsP = s
    .memo(`rows:${artist.ratingKey}`, () => s.artistHubs(artist.ratingKey).then((hubs) => releasesFromHubs(hubs, artist.ratingKey)), ROWS_KEPT_MS)
    .catch(() => null);

  // Their releases by kind (see releaseKind), each with its year (when it
  // first came out, with Original release years, where MusicBrainz says
  // that was earlier than the year Plex has), newest first. The library's
  // albums by them and their albums proper are asked for together, then
  // Plex's rows for the page and the release types of those that aren't
  // albums proper (40 to a request, kept while the app's open): for most
  // artists a request or two, waited for, as MusicBrainz is; or else the
  // albums proper are shown, and the rest as they come. `st` is what's in
  // so far (see releaseKind).
  const me = String(artist.ratingKey);
  const st = { proper: null, separated: false, rows: null, types: null, settled: false, listed: [], properList: [], various };
  let mb = null;
  const albumsNow = () => ownAlbums(me, st.listed, st.properList, [...(st.rows?.own?.values() || [])]);
  const placed = (albums) => {
    const groups = mb?.groups || [];
    const origin = mbOn('mbOriginalYears');
    return albums.map((m) => {
      const kind = releaseKind(m, st);
      const own = Number(year(m)) || null;
      const g = groups.length ? matchGroup(groups, m.title, kind, own) : null;
      const was = origin ? firstYear(g) : null;
      return { m, kind, year: was && (!own || was < own) ? was : own };
    });
  };
  let painted = '';
  const paintAlbums = () => {
    const albums = albumsNow();
    paintMissing(albums);
    // (Those whose kind isn't known yet wait for it.)
    const list = placed(albums)
      .filter((x) => x.kind)
      .sort((a, b) => (b.year || 0) - (a.year || 0));
    const kinds = new Map();
    for (const x of list) {
      if (!kinds.has(x.kind)) kinds.set(x.kind, []);
      kinds.get(x.kind).push(x);
    }
    // (Grouped as they were: left as they are, so what has focus keeps it.)
    const shape = JSON.stringify([!kinds.size && st.settled, [...kinds].map(([k, xs]) => [k, xs.map((x) => [x.m.ratingKey, x.year])])]);
    if (shape === painted) return;
    painted = shape;
    const blocks = RELEASE_KINDS.filter(([k]) => kinds.has(k)).map(([k, name]) => {
      const cards = kinds.get(k).map((x) => albumCard(x.m, { subtitle: x.year ? String(x.year) : '' }));
      if (k === 'albums') return h('section.block', { dataset: { group: name } }, sectionHeader(name), grid(cards, { centered: true }));
      const strip = shelf(cards);
      return h('section.block', { dataset: { group: name } }, sectionHeader(name, null, null, strip), strip);
    });
    albumsBox.replaceChildren(...(blocks.length ? blocks : st.settled ? [emptyState('No albums for this artist.')] : []));
  };

  // Not in your library (Missing albums on artist pages): their release
  // groups on MusicBrainz that none of the library's albums is, of the
  // kinds chosen (Kinds…), newest first, by kind, each linked to
  // MusicBrainz; to copy or download, all of them.
  // (What the library has is known once all of their albums are in: until
  // then, nothing's said to be missing.)
  let missingPainted = '';
  const paintMissing = (albums) => {
    const groups = mb?.groups || [];
    if (!mbOn('mbMissingAlbums') || !groups.length || !st.settled) {
      missingPainted = '';
      return missingBox.replaceChildren();
    }
    const have = new Set();
    const titles = new Set();
    for (const m of albums) {
      const g = matchGroup(groups, m.title, releaseKind(m, st), Number(year(m)) || null);
      if (g) have.add(g.id);
      titles.add(albumKey(m.title));
    }
    const chosen = missingKinds();
    const missing = groups
      .filter((g) => !have.has(g.id) && !titles.has(albumKey(g.title)) && chosen.includes(kindOf(g.primary, g.secondary)))
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    // (As it was: left as it is, so what has focus keeps it.)
    const shape = JSON.stringify([chosen, missing.map((g) => g.id)]);
    if (shape === missingPainted) return;
    missingPainted = shape;
    const kindsButton = h('button.link-btn.mb-kinds-btn', { type: 'button', onclick: () => chooseMissingKinds(() => paintMissing(albumsNow())) }, 'Kinds…');
    const head = sectionHeader('Not in your library', null, kindsButton);
    if (!missing.length) {
      missingBox.replaceChildren(h('section.block.mb-missing', null, head, h('p.hint.pad', null, `Your library has all of ${artist.title}’s that MusicBrainz has, of the kinds chosen.`)));
      return;
    }
    const name = (g) => KIND_NAMES[kindOf(g.primary, g.secondary)];
    const line = (g) => [artist.title, g.title, name(g), firstYear(g)].filter(Boolean).join(' — ');
    const link = (g) => `https://musicbrainz.org/release-group/${g.id}`;
    const blocks = RELEASE_KINDS.map(([k, label]) => [label, missing.filter((g) => kindOf(g.primary, g.secondary) === k)])
      .filter(([, list]) => list.length)
      .map(([label, list]) =>
        h(
          'div.mb-missing-kind',
          { dataset: { kind: label } },
          h('h3.mb-missing-head.pad', null, `${label} (${fmt.number(list.length)})`),
          h(
            'div.rows',
            null,
            list.slice(0, MISSING_SHOWN).map((g) =>
              h(
                'a.row.mb-missing-row',
                { href: link(g), target: '_blank', rel: 'noopener noreferrer' },
                h('div.row-main', null, h('div.row-title', null, g.title), h('div.row-sub', null, firstYear(g) ? `First released in ${firstYear(g)}` : 'When it came out isn’t known')),
                icon('external', 20, 'chev'),
              ),
            ),
          ),
          list.length > MISSING_SHOWN ? h('p.hint.pad', null, `and ${fmt.number(list.length - MISSING_SHOWN)} more (the copy and the download have them all)`) : null,
        ),
      );
    const fileName = `${artist.title.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'artist'}`;
    missingBox.replaceChildren(
      h(
        'section.block.mb-missing',
        null,
        head,
        h(
          'p.hint.pad',
          null,
          `${artist.title}’s releases on MusicBrainz that your library hasn’t, of ${chosen.length === RELEASE_KINDS.length ? 'every kind' : `these kinds: ${RELEASE_KINDS.filter(([k]) => chosen.includes(k)).map(([, label]) => label).join(', ')}`}.`,
        ),
        ...blocks,
        h(
          'div.pad.button-row.mb-missing-actions',
          null,
          h(
            'button.btn.btn-secondary.mb-missing-copy',
            { type: 'button', onclick: async () => toast((await copyText(`${missing.map(line).join('\n')}\n`)) ? 'Copied: artist — album — kind — year, one to a line' : 'Couldn’t copy here. Download it instead.') },
            icon('stack', 20),
            h('span', null, 'Copy the list'),
          ),
          h(
            'button.btn.btn-secondary.mb-missing-csv',
            {
              type: 'button',
              onclick: () => {
                const rows = missing.map((g) => [artist.title, g.title, name(g), firstYear(g) || '', g.id, link(g)]);
                download(toCsv(['Artist', 'Album', 'Kind', 'First released', 'MusicBrainz release group', 'Link'], rows), `missing-albums-${fileName}-${fileDate()}.csv`, 'text/csv;charset=utf-8');
                toast('Downloaded, to open in a spreadsheet');
              },
            },
            icon('arrowDown', 20),
            h('span', null, 'Download (CSV)'),
          ),
        ),
      ),
    );
  };

  // (Asked of the library the artist's in; let go of if the page is.)
  const ctrl = new AbortController();
  onDispose?.(() => ctrl.abort());
  const listedP = s.artistAlbums(artist.librarySectionID ?? sec, artist.ratingKey, { signal: ctrl.signal }).catch(() => null);
  const properP = s.children(artist.ratingKey).catch(() => null);
  // (Once they're first shown: what comes after them waits for no more.)
  let shown;
  const shownP = new Promise((r) => (shown = r));
  const albumsP = Promise.all([listedP, properP]).then(async ([listed, proper]) => {
    if (!listed && !proper) throw new Error('Plex didn’t say what albums they have.');
    st.listed = listed || [];
    st.properList = (proper || []).filter((m) => m?.type === 'album');
    st.proper = proper ? new Set(st.properList.map(idOf)) : null;
    st.separated = !!st.proper && ownAlbums(me, st.listed).some((m) => !st.proper.has(idOf(m)));
    // The release types of those that don't say (but albums proper, where
    // Plex keeps those apart).
    const ask = ownAlbums(me, st.listed, st.properList)
      .filter((m) => !(st.separated && st.proper.has(idOf(m))) && !plexKind(m))
      .slice(0, TYPES_ASKED);
    const typesP = (ask.length ? s.albumTypes(ask.map(idOf)) : Promise.resolve([])).then(
      (got) => (st.types = new Map(ask.map((m, i) => [idOf(m), got[i]]).filter(([, t]) => t))),
      () => null,
    );
    const rowsP = hubsP.then((rows) => (st.rows = rows));
    const mbIn = mbP.then((got) => (mb = got));
    const all = Promise.all([typesP, rowsP]).then(() => (st.settled = true));
    const soon = await Promise.race([Promise.all([all, mbIn]).then(() => true), new Promise((r) => setTimeout(r, TYPES_WAIT))]);
    if (soon) return paintAlbums();
    // (Shown as it is, then again with each, as it comes.)
    paintAlbums();
    shown();
    await Promise.all([typesP.then(paintAlbums), rowsP.then(paintAlbums), mbIn.then(paintAlbums), all.then(paintAlbums)]);
  });
  albumsP.finally(() => shown()).catch(() => {});

  // Appears on: others' albums they're on, newest first, as Plex's rows
  // for the page have them (and the library's albums by them, where those
  // take in what they're on), or else as its search finds them. (Not for
  // Various Artists, who are on everything of theirs.)
  const appearsP = various
    ? null
    : Promise.all([hubsP, listedP]).then(async ([rows, listed]) => {
        const seen = new Set();
        const theirs = [...(rows?.appears || []), ...(listed || []).filter((m) => m?.type === 'album' && isId(m.parentRatingKey) && String(m.parentRatingKey) !== me)].filter(
          (m) => !seen.has(idOf(m)) && seen.add(idOf(m)),
        );
        const albums = theirs.length ? theirs : await appearsBySearch(s, sec, artist);
        if (!albums.length) return;
        const cards = albums
          .slice()
          .sort((a, b) => (Number(year(b)) || 0) - (Number(year(a)) || 0))
          .map((m) => albumCard(m, { subtitle: [m.parentTitle, year(m)].filter(Boolean).join(' · ') }));
        const strip = shelf(cards);
        appearsBox.replaceChildren(h('section.block', { dataset: { group: 'Appears on' } }, sectionHeader('Appears on', null, null, strip), strip));
      });

  // Appears in: your playlists and collections with their music in them
  // (see appearsInShelf), looked for once their albums are shown (not
  // waiting for MusicBrainz) and the page has come near it. (Not for
  // Various Artists, who are in everything.)
  if (!various) {
    shownP
      .then(() => whenNear(inBox, ctrl.signal))
      .then(() => appearsInShelf(inBox, artist, ctrl.signal))
      .catch(() => {});
  }

  // Similar artists (Plex's, those in this library) and sonically similar
  // ones, each a shelf, with a page of more.
  const artistShelf = (slot, heading, href, artists) => {
    if (!artists.length) return;
    const strip = shelf(artists.map(artistCard));
    slot.replaceWith(h('section.block', { dataset: { similar: href.split('/').pop() } }, sectionHeader(heading, href, null, strip), strip));
  };
  const similarP = similarInLibrary(s, sec, artist, SHELF_ARTISTS).then((artists) => artistShelf(similarSlot, 'Similar artists', `/artist/${artist.ratingKey}/similar`, artists));
  const sonicP = sonicallySimilar(s, artist, { limit: SHELF_ARTISTS }).then((artists) => artistShelf(sonicSlot, 'Sonically similar artists', `/artist/${artist.ratingKey}/sonic`, artists));

  // (Appears in isn't waited for: it's looked for as the page is read.)
  await Promise.allSettled([popularP, albumsP, appearsP, similarP, sonicP]);
}

// Once `el` is near being seen (or at once, where the browser can't tell),
// unless `signal` says the page has gone.
function whenNear(el, signal) {
  return new Promise((resolve, reject) => {
    const gone = () => reject(Object.assign(new Error('aborted'), { aborted: true }));
    if (signal.aborted) return gone();
    if (!('IntersectionObserver' in window)) return resolve();
    const io = new IntersectionObserver(
      (es) => {
        if (!es.some((e) => e.isIntersecting)) return;
        io.disconnect();
        resolve();
      },
      { rootMargin: '600px 0px' },
    );
    io.observe(el);
    signal.addEventListener('abort', () => {
      io.disconnect();
      gone();
    });
  });
}

// An artist's Appears in (membership.js artistAppearsIn), in `box`: a shelf
// of your playlists, then the collections, each by name, as they're found,
// each saying how many of theirs it has. While they're looked for, it says
// so; with none, it goes.
const LOOKING_IN = 'Looking through your playlists and collections…';
const byName = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
async function appearsInShelf(box, artist, signal) {
  const status = h('p.hint.pad.appears-in-status', { role: 'status' }, LOOKING_IN);
  const strip = shelf([]);
  const track = strip.firstElementChild;
  box.replaceChildren(h('section.block', { dataset: { group: 'Appears in' } }, sectionHeader('Appears in', null, null, strip), status, strip));
  const of = (n, one, many) => (n === 1 ? one : `${fmt.number(n)} ${many}`);
  const say = (kind, e) => {
    if (kind === 'playlist') return e.every ? 'Every track in your library' : of(e.count, 'A track of theirs', 'of their tracks');
    if (e.via === 'artist') return 'Artist collection';
    return e.via === 'album' ? of(e.count, 'An album of theirs', 'of their albums') : of(e.count, 'A track of theirs', 'of their tracks');
  };
  const add = (kind, e) => {
    const c = (kind === 'playlist' ? playlistCard : collectionCard)(e.list, { subtitle: say(kind, e) });
    c.dataset.inKind = kind === 'playlist' ? '0' : '1';
    c.dataset.inTitle = e.list.title || '';
    // (Playlists first, then collections, each by name. A shelf at its
    // start stays there: the browser would keep the card it was on in view.)
    const after = [...track.children].find((x) => x.dataset.inKind > c.dataset.inKind || (x.dataset.inKind === c.dataset.inKind && byName.compare(x.dataset.inTitle, c.dataset.inTitle) > 0));
    const atStart = strip.scrollLeft <= 1;
    track.insertBefore(c, after || null);
    if (atStart) strip.scrollLeft = 0;
  };
  try {
    const res = await artistAppearsIn(artist, {
      signal,
      onFound: add,
      onProgress: (done, total) => {
        status.textContent = total ? `${LOOKING_IN} ${fmt.number(done)} of ${fmt.number(total)}` : LOOKING_IN;
      },
    });
    if (signal.aborted) return;
    if (!res.playlists.length && !res.collections.length) return box.replaceChildren();
    if (res.skipped.length) status.textContent = `Too long to look through, so not included: ${res.skipped.map((l) => l.title).join(', ')}.`;
    else status.remove();
  } catch (err) {
    if (signal.aborted || err?.aborted) return;
    if (track.children.length) status.textContent = describeError(err);
    else box.replaceChildren();
  }
}

// All of an artist's similar artists in the library (`kind`: 'similar',
// Plex's; 'sonic', those that sound like it, further than the shelf goes).
export async function similarArtistsView({ el, params, kind }) {
  const s = app.server;
  const sec = app.source.sectionKey;
  if (!/^\d+$/.test(String(params.id))) throw Object.assign(new Error('Not found'), { status: 404 });
  const artist = await s.metadata(params.id);
  if (!artist || artist.type !== 'artist') throw Object.assign(new Error('Not found'), { status: 404 });
  const sonic = kind === 'sonic';
  el.append(backHeader(sonic ? `Sounds like ${artist.title}` : `Similar to ${artist.title}`, { fallback: `/artist/${artist.ratingKey}` }));
  const artists = sonic ? await sonicallySimilar(s, artist, { limit: ALL_ARTISTS, maxDistance: 0.4 }) : await similarInLibrary(s, sec, artist, ALL_ARTISTS);
  el.append(
    h('p.lede', null, sonic ? `Artists in your library who sound like ${artist.title}, nearest first, by your server’s sonic analysis.` : `Artists in your library that Plex says are like ${artist.title}.`),
    artists.length
      ? grid(artists.map(artistCard), { centered: true })
      : emptyState(sonic ? 'Your server hasn’t found any that sound like them (it needs sonic analysis for that).' : `None of the artists Plex says are like ${artist.title} are in your library.`),
  );
}

// ---------- editing (playlists and collections) ----------
// Lists are locked: rows play when tapped, and nothing can be moved or
// removed by accident. Unlocking (the lock button) shows a handle to drag
// each row and a button to remove it; every change is saved to Plex at
// once, removals can be undone, and the list locks again when you leave.

function lockButton(label, onToggle) {
  const btn = iconButton('lock', `Edit ${label}`, onToggle);
  btn.classList.add('lock-btn');
  return {
    el: btn,
    set(on) {
      btn.replaceChildren(icon(on ? 'unlock' : 'lock', 24));
      btn.classList.toggle('on', on);
      btn.setAttribute('aria-pressed', String(on));
      btn.setAttribute('aria-label', on ? `Lock ${label}` : `Edit ${label}`);
      btn.title = on ? `Done (lock the ${label})` : `Edit ${label} (unlock)`;
    },
  };
}

// The bar over an unlocked list: what you can do, Sort, and Done. While a
// sort is being saved it says how far it's got, with a Stop button.
function editBar(text, { onDone, onSort }) {
  const textEl = h('span.edit-bar-text', null, text);
  const sortBtn = onSort ? h('button.btn.btn-secondary.edit-sort', { type: 'button', onclick: onSort }, icon('sort', 18), h('span', null, 'Sort')) : null;
  const doneBtn = h('button.btn.btn-primary.edit-done', { type: 'button', onclick: onDone }, 'Done');
  const actions = h('div.edit-bar-actions', null, sortBtn, doneBtn);
  const el = h('div.edit-bar', { hidden: true, role: 'status' }, icon('unlock', 20), textEl, actions);
  return {
    el,
    working(message, onStop) {
      el.classList.add('busy');
      textEl.textContent = message;
      actions.replaceChildren(h('button.btn.btn-secondary.edit-stop', { type: 'button', onclick: onStop }, 'Stop'));
    },
    say(message) {
      textEl.textContent = message;
    },
    idle() {
      el.classList.remove('busy');
      textEl.textContent = text;
      actions.replaceChildren(...[sortBtn, doneBtn].filter(Boolean));
    },
  };
}

// "Sort by": the ways a list of tracks, albums or artists can be sorted.
function chooseSort(kind, title, onPick) {
  const icons = { artist: 'mic', title: kind === 'album' ? 'disc' : 'note', album: 'disc', year: 'calendar', reverse: 'arrowUp' };
  sheet({
    title: 'Sort by',
    subtitle: `“${title}” is saved to Plex in its new order.`,
    actions: sortChoices(kind).map(([by, label]) => ({ icon: icons[by] || 'sort', label, onSelect: () => onPick(by, label) })),
  });
}

// What a sort says while it's saved, and after.
const sortWords = (by, label) =>
  by === 'reverse' ? ['Reversing the order', 'Reversed'] : [`Sorting by ${label.toLowerCase()}`, `Sorted by ${label.toLowerCase()}`];

// While it's saved: how many of those that need moving have moved, and how
// many were in place already ("458" is moves, not tracks: the other 42 of
// a list of 500 stay where they are).
const movedWords = (doing, n, of, { total, checking }) =>
  checking ? `Making sure it’s all in order… ${fmt.number(n)} of ${fmt.number(of)} moved` : `${doing}… ${fmt.number(n)} of ${fmt.number(of)} moved${total > of ? ` (${fmt.number(total - of)} already in place)` : ''}`;

// And after: "Sorted by artist: 458 of 500 tracks moved".
const doneWords = (done, { moved, total }, one, many) => `${done}: ${fmt.number(moved)} of ${fmt.count(total, one, many)} moved`;

const SORT_LIMIT = 5000; // entries; longer lists aren't sorted here

// The remove button and drag handle on a row in an unlocked list.
function addEditControls(r, label, onRemove) {
  if (r.querySelector(':scope > .row-remove')) return;
  r.prepend(
    h('button.icon-btn.row-remove', { type: 'button', 'aria-label': `Remove ${label}`, title: 'Remove', onclick: () => onRemove(r) }, icon('remove', 22)),
  );
  r.append(h('span.drag-handle', { title: 'Drag to reorder', 'aria-hidden': 'true' }, icon('grip', 22)));
}

function removeEditControls(r) {
  r.querySelector(':scope > .row-remove')?.remove();
  r.querySelector(':scope > .drag-handle')?.remove();
}

const failMessage = (err, what) => (err?.status === 401 || err?.status === 403 ? `You can’t change this ${what}.` : describeError(err));

// ---------- a playlist's or collection's picture ----------

// Pictures are made smaller in the browser before they go to Plex: this many
// pixels across at most, as a JPEG.
const PICTURE_SIZE = 1200;

async function shrinkPicture(file) {
  let source;
  try {
    source = await createImageBitmap(file);
  } catch {
    // (Safari before 17 can't make one from some files: an <img> can.)
    source = await new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(Object.assign(new Error('Not a picture'), { badImage: true }));
      img.src = url;
    });
  }
  const w = source.width || source.naturalWidth;
  const ht = source.height || source.naturalHeight;
  if (!w || !ht) throw Object.assign(new Error('Not a picture'), { badImage: true });
  const scale = Math.min(1, PICTURE_SIZE / Math.max(w, ht));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(ht * scale));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#16171b'; // under any see-through parts
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  source.close?.();
  if (source.src?.startsWith('blob:')) URL.revokeObjectURL(source.src);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.88));
  if (!blob) throw Object.assign(new Error('Not a picture'), { badImage: true });
  return blob.arrayBuffer();
}

// The artwork at the top of a playlist or collection. While it's unlocked
// a pencil sits over it (on a computer, when the pointer is over it), which
// opens the choice of picture: upload one, go back to one it had, or to the
// one Plex makes. `load` fetches the item again once its picture changes.
function pictureBox(path, { what, id, title, load, onChanged }) {
  let current = art(path, { size: 480, cls: 'hero-art', fallback: 'list' });
  // (Its click, from the sheet, mustn't reach the box: that would open the
  // sheet again.)
  const input = h('input.picture-input', { type: 'file', accept: 'image/*', tabindex: '-1', 'aria-hidden': 'true', onclick: (e) => e.stopPropagation() });
  const pencil = h('button.hero-art-edit', { type: 'button', 'aria-label': `Change the ${what}’s picture`, title: 'Change the picture', onclick: (e) => (e.stopPropagation(), choose()) }, icon('edit', 28));
  const box = h('div.hero-art-box', { onclick: () => box.classList.contains('editable') && choose() }, current, pencil, input);
  let busy = false;

  const setBusy = (on) => {
    busy = on;
    box.classList.toggle('busy', on);
    pencil.replaceChildren(on ? h('span.picture-spinner', { 'aria-hidden': 'true' }) : icon('edit', 28));
    pencil.setAttribute('aria-label', on ? 'Changing the picture…' : `Change the ${what}’s picture`);
  };

  async function refresh() {
    const fresh = await load().catch(() => null);
    const next = fresh ? fresh.thumb || fresh.composite : null;
    if (fresh) onChanged?.(fresh);
    const el = art(next, { size: 480, cls: 'hero-art', fallback: 'list' });
    current.replaceWith(el);
    current = el;
  }

  async function change(job, done) {
    if (busy) return;
    setBusy(true);
    try {
      await job();
      await refresh();
      toast(done);
    } catch (err) {
      toast(err?.badImage ? 'That picture couldn’t be read. Try a JPEG or PNG.' : failMessage(err, what));
    } finally {
      setBusy(false);
    }
  }

  input.addEventListener('change', () => {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (file.type && !file.type.startsWith('image/')) return toast('That isn’t a picture.');
    change(async () => app.server.uploadPoster(id, await shrinkPicture(file)), 'Picture changed');
  });

  async function choose() {
    if (busy) return;
    const posters = await app.server.posters(id).catch(() => []);
    const earlier = posters.filter((p) => !p.selected).slice(0, 12);
    const custom = posters.some((p) => p.selected && /^upload:\/\//.test(p.id));
    const grid = earlier.length
      ? h(
          'div.picture-choices',
          null,
          h('div.picture-choices-label', null, 'Pictures it’s had'),
          h(
            'div.picture-grid',
            null,
            earlier.map((p, i) =>
              h(
                'button.picture-choice',
                {
                  type: 'button',
                  'aria-label': `Use picture ${i + 1}`,
                  onclick: async () => {
                    await popOverlay();
                    change(() => app.server.selectPoster(id, p.id), 'Picture changed');
                  },
                },
                art(p.thumb, { size: 120, fallback: 'list' }),
              ),
            ),
          ),
        )
      : null;
    sheet({
      title: 'Picture',
      subtitle: `For “${title()}”`,
      content: grid,
      actions: [
        // (The file picker opens straight from the tap: browsers want that.)
        { icon: 'image', label: 'Upload a picture…', description: 'From this device. It’s made smaller for Plex.', now: true, onSelect: () => input.click() },
        custom && {
          icon: 'refresh',
          label: what === 'playlist' ? 'Use its tracks’ covers' : 'Remove this picture',
          description: what === 'playlist' ? 'Back to the covers Plex puts together' : 'Back to the picture Plex gives it',
          onSelect: () => change(() => app.server.removePoster(id), what === 'playlist' ? 'Back to its tracks’ covers' : 'Picture removed'),
        },
      ],
    });
  }

  return {
    el: box,
    open: choose,
    setEditing(on) {
      box.classList.toggle('editable', on);
    },
  };
}

// ---------- Playlist ----------

export async function playlistView({ el, params, onDispose, onHide }) {
  const s = app.server;
  const hash = location.hash;
  // (The shares are waited for a few seconds at most, so a slow service
  // doesn't hold the playlist back. Till they're in, it can't be unlocked
  // (one shared with you to view only mustn't change); once they are, it
  // can, or, where it turns out to be shared, the page is shown again (or,
  // put aside, the next time it's opened), as that changes what can be
  // done with it. Where they can't be had, it's taken as not shared, as
  // before.)
  const [pl, shares] = await Promise.all([s.playlist(params.id), sharingOn() ? sharesSoon() : []]);
  if (!pl) throw Object.assign(new Error('Not found'), { status: 404 });
  let sharesKnown = shares !== null;
  // Shared with friends (yours), or shared with you (see sharing.js).
  const share = shareOf(pl.ratingKey);
  // Smart playlists follow their rules in Plex; they can't be edited here.
  // Nor can one shared with you to view only (changes would be undone).
  const editable = !pl.smart && (pl.playlistType || 'audio') === 'audio' && share?.role !== 'view';
  const canEdit = () => editable && sharesKnown;
  let editing = false;
  let total = pl.leafCount || 0;
  let pager = null;

  const lock = editable ? lockButton('playlist', () => canEdit() && setEditing(!editing)) : null;
  lock?.set(false);
  if (lock && !sharesKnown) {
    lock.el.disabled = true;
    lock.el.title = 'Checking whether it’s shared…';
  }
  if (!sharesKnown) {
    freshShares()
      .catch(() => null)
      .then(() => {
        if (shareOf(pl.ratingKey)) {
          // (Any other kept page of it too: built again when it's opened.)
          dropCached((p) => p === `/playlist/${pl.ratingKey}`);
          if (location.hash === hash) refresh();
          return;
        }
        sharesKnown = true;
        if (lock) {
          lock.el.disabled = false;
          lock.set(editing);
        }
      });
  }
  // Until the lock has been used, a reminder of what it's for.
  const hint = lock ? pointOut(lock.el, 'Locked, so nothing changes by accident. Tap the lock to reorder, sort or remove tracks, or change the picture.', { key: 'lock' }) : () => {};
  const picture = pictureBox(playlistArt(pl), {
    what: 'playlist',
    id: pl.ratingKey,
    title: () => pl.title,
    load: () => s.playlist(pl.ratingKey),
    onChanged: (fresh) => {
      pl.thumb = fresh.thumb;
      pl.composite = fresh.composite;
      dropCached((p) => p === '/' || p === '/playlists' || p === '/library/playlists');
    },
  });
  // A smart playlist can't be unlocked (its rules decide what's in it), but
  // its picture can still change, from its menu.
  // (Not till what's shared is known: it decides which they are.)
  const shareActions = () => {
    if (!sharingOn() || !sharesKnown) return [];
    if (share && share.role !== 'owner') {
      return [{ icon: 'together', label: 'Stop sharing it with me…', description: `Keep it as a playlist of your own, without ${share.owner.title}’s changes`, onSelect: () => leaveDialog(share, { onChange: refresh }) }];
    }
    if (pl.smart || (pl.playlistType || 'audio') !== 'audio') return [];
    return [
      share
        ? { icon: 'together', label: 'Sharing…', description: shareLine(share), onSelect: () => openShareDialog(pl, { onChange: refresh }) }
        : { icon: 'together', label: 'Share with friends…', description: 'Plex friends who can use this server get a copy, kept the same as yours', onSelect: () => openShareDialog(pl, { onChange: refresh }) },
    ];
  };
  const menu = iconButton('more', 'More options', () =>
    playlistMenu(pl, {
      edit: editing ? { onRename: rename, onDelete: remove } : null,
      picture: editing || pl.smart ? () => picture.open() : null,
      extra: shareActions(),
    }),
  );
  const head = backHeader(pl.title, { collapse: true, fallback: '/playlists', actions: [lock?.el, menu] });
  const title = h('h1.hero-title', null, pl.title);
  const countEl = h('span', null, fmt.count(total, 'track', 'tracks'));
  el.append(
    head,
    h(
      'section.hero.hero-album',
      null,
      picture.el,
      h(
        'div.hero-info',
        null,
        title,
        h('div.hero-meta', null, countEl, pl.duration ? `, ${fmt.long(pl.duration)}` : ''),
        pl.smart ? h('div.hero-meta', null, 'Smart playlist') : null,
        share
          ? share.role === 'owner'
            ? h('button.hero-meta.share-line.link-btn', { type: 'button', onclick: () => openShareDialog(pl, { onChange: refresh }) }, icon('together', 18), h('span', null, shareLine(share)))
            : h('div.hero-meta.share-line', null, icon('together', 18), h('span', null, shareLine(share)))
          : null,
        actionButtons([
          { icon: 'play', label: 'Play', primary: true, onClick: () => playPlaylist(pl) },
          { icon: 'shuffle', label: 'Shuffle', onClick: () => playPlaylist(pl, { shuffle: true }) },
          { icon: 'radio', label: 'Radio', onClick: () => playlistRadio(pl) },
        ]),
      ),
    ),
  );
  picture.el.append(sharedMark(pl.ratingKey));
  collapseWhenHidden(head, title);
  if (pl.summary) el.append(h('div.pad.hero-summary', null, clampText(pl.summary, 3)));

  const list = numberedList({ total, album: true });
  const bar = editBar('Drag a track to move it, or remove it, and tap the picture to change it. Changes are saved to Plex as you go; the tracks stay in your library.', {
    onDone: () => setEditing(false),
    onSort: () => chooseSort('track', pl.title, (by, label) => sortBy(by, label)),
  });
  el.append(bar.el, list);

  const rows = () => [...list.children].filter((r) => r.matches('.track'));
  const setCount = (n) => {
    total = Math.max(0, n);
    pl.leafCount = total;
    countEl.textContent = fmt.count(total, 'track', 'tracks');
    list.style.setProperty('--pos-digits', String(Math.max(2, String(total).length)));
  };
  const changed = () => {
    dropCached((p) => p === '/' || p === '/playlists' || p === '/library/playlists');
    // Shared: everyone's copy gets it.
    sharedPlaylistChanged(pl.ratingKey);
  };
  // Opened: brought up to date with everyone else's changes (the page loads
  // again if there were any).
  if (share) syncShare(share).catch(() => {});

  function controls(r) {
    if (editing) addEditControls(r, `“${r.dataset.title}” from the playlist`, removeRow);
    else removeEditControls(r);
  }

  function editActions(r) {
    if (!editing) {
      // Locked: the way in, for anyone looking here to remove a track.
      return canEdit() ? [{ icon: 'unlock', label: 'Edit playlist', description: 'Unlock it to reorder or remove tracks', onSelect: () => setEditing(true) }] : [];
    }
    return [
      r !== rows()[0] && { icon: 'moveTop', label: 'Move to top', onSelect: () => moveTo(r, 'top') },
      r !== rows().at(-1) && { icon: 'arrowDown', label: 'Move to bottom', onSelect: () => moveTo(r, 'bottom') },
      { icon: 'remove', label: 'Remove from playlist', danger: true, onSelect: () => removeRow(r) },
    ];
  }

  function rowFor(m) {
    const t = normTrack(m);
    const r = trackRow(t, {
      showArt: true,
      position: true,
      album: true,
      onPlay: () => playPlaylist(pl, { start: Math.max(0, rows().indexOf(r)) }),
      onMenu: ({ select }) => trackMenu(t, { extra: editActions(r), select: editing ? null : select }),
    });
    r.dataset.pid = m.playlistItemID ?? '';
    r.dataset.title = t.title;
    controls(r);
    return r;
  }

  function setEditing(on) {
    // (Unlocked, its tracks are moved or removed, not chosen.)
    if (on) clearSelection();
    editing = on;
    el.classList.toggle('is-editing', on);
    list.classList.toggle('editing', on);
    bar.el.hidden = !on;
    lock?.set(on);
    picture.setEditing(on);
    rows().forEach(controls);
    if (on) {
      learned('lock');
      hint();
    }
  }
  onHide(() => {
    hint();
    if (editing) setEditing(false);
  });

  async function removeRow(r) {
    const next = r.nextElementSibling;
    const prevPid = r.previousElementSibling?.dataset.pid || null;
    r.remove();
    setCount(total - 1);
    try {
      await s.removeFromPlaylist(pl.ratingKey, r.dataset.pid);
    } catch (err) {
      list.insertBefore(r, next && next.parentElement === list ? next : null);
      setCount(total + 1);
      toast(failMessage(err, 'playlist'));
      return;
    }
    changed();
    toast(`Removed “${r.dataset.title}”`, { action: 'Undo', onAction: () => undoRemove(r, prevPid, next), timeout: 6000 });
  }

  // Put it back where it was: add it again (it goes to the end), then move
  // the new entry after the one that was before it.
  async function undoRemove(r, prevPid, next) {
    try {
      const updated = await s.addToPlaylist(pl.ratingKey, [r.dataset.trackId]);
      const n = updated?.leafCount ?? total + 1;
      const { items } = await s.playlistItems(pl.ratingKey, { start: Math.max(0, n - 1), size: 1 });
      const entry = items.at(-1);
      if (!entry) throw new Error('The playlist didn’t answer.');
      await s.movePlaylistItem(pl.ratingKey, entry.playlistItemID, prevPid);
      r.dataset.pid = entry.playlistItemID;
      const before = next && next.parentElement === list ? next : prevPid ? rows().find((x) => x.dataset.pid === prevPid)?.nextElementSibling : rows()[0];
      list.insertBefore(r, before || null);
      setCount(n);
      controls(r);
      changed();
    } catch (err) {
      toast(failMessage(err, 'playlist'));
      refresh();
    }
  }

  async function moveTo(r, where) {
    try {
      if (where === 'top') {
        list.prepend(r);
        await s.movePlaylistItem(pl.ratingKey, r.dataset.pid, null);
      } else if (pager?.done) {
        const last = rows().at(-1);
        list.append(r);
        await s.movePlaylistItem(pl.ratingKey, r.dataset.pid, last.dataset.pid);
      } else {
        // Not all of it is loaded: move it after the last entry, then load
        // the page again.
        const { items } = await s.playlistItems(pl.ratingKey, { start: Math.max(0, total - 1), size: 1 });
        await s.movePlaylistItem(pl.ratingKey, r.dataset.pid, items.at(-1)?.playlistItemID || null);
        refresh();
        return;
      }
      changed();
    } catch (err) {
      toast(failMessage(err, 'playlist'));
      refresh();
    }
  }

  enableDrag(list, {
    item: '.track',
    onDrop: async ({ item }) => {
      const prev = item.previousElementSibling;
      try {
        await s.movePlaylistItem(pl.ratingKey, item.dataset.pid, prev?.dataset.pid || null);
        changed();
      } catch (err) {
        toast(failMessage(err, 'playlist'));
        refresh();
      }
    },
  });

  async function rename() {
    const name = await askText({ title: 'Rename playlist', label: 'Name', value: pl.title });
    if (!name || name === pl.title) return;
    try {
      await s.renamePlaylist(pl.ratingKey, name);
      pl.title = name;
      title.textContent = name;
      head.querySelector('.back-title').textContent = name;
      changed();
    } catch (err) {
      toast(failMessage(err, 'playlist'));
    }
  }

  async function remove() {
    const others = share?.role === 'owner' ? (share.members || []).length : 0;
    const sure = await confirmAction({
      title: `Delete “${pl.title}”?`,
      message: `The playlist is deleted from Plex. The tracks in it stay in your library.${
        others ? ` It stops being shared: the ${others === 1 ? 'friend' : `${others} friends`} you shared it with keep their copies.` : share ? ' It stops being shared with you.' : ''
      }`,
      confirm: 'Delete playlist',
    });
    if (!sure) return;
    try {
      if (share) await (share.role === 'owner' ? stopSharing(share) : leaveShared(share)).catch(() => {});
      await s.deletePlaylist(pl.ratingKey);
      setEditing(false);
      changed();
      toast(`Deleted “${pl.title}”`);
      back('/playlists');
    } catch (err) {
      toast(failMessage(err, 'playlist'));
    }
  }

  // ---------- sorting ----------
  // The new order is worked out from every entry, then saved with the
  // fewest moves (see sorting.js). Undo puts it back the same way.

  let sorting = null;

  // Every entry, page by page (as many as the server gives at a time).
  async function allEntries() {
    const out = [];
    for (;;) {
      const { items, total: t } = await s.playlistItems(pl.ratingKey, { start: out.length, size: 500 });
      out.push(...items);
      if (out.length > SORT_LIMIT) throw Object.assign(new Error(`Playlists of more than ${fmt.number(SORT_LIMIT)} tracks can’t be sorted here.`), { tooLong: true });
      if (!items.length || out.length >= t) break;
    }
    return out;
  }

  // makeTarget(entries) gives the entries' ids (playlistItemID) in the
  // order wanted.
  async function reorder(makeTarget, [doing, done]) {
    if (sorting) return;
    const ctrl = new AbortController();
    sorting = ctrl;
    busy(true);
    bar.working(`${doing}…`, () => ctrl.abort());
    let result = null;
    try {
      result = await saveOrder({
        read: allEntries,
        idOf: (m) => String(m.playlistItemID),
        target: makeTarget,
        move: (id, after) => s.movePlaylistItem(pl.ratingKey, id, after),
        signal: ctrl.signal,
        onProgress: (n, of, p) => bar.say(movedWords(doing, n, of, p)),
      });
      if (!result.moved) {
        toast('It’s in that order already.');
        return;
      }
      changed();
      reload();
      const before = result.before;
      const undo = { action: 'Undo', onAction: () => reorder((now) => restoreOrder(now.map((m) => String(m.playlistItemID)), before), ['Putting it back', 'Put back']), timeout: 8000 };
      toast(result.stopped ? 'Stopped, part way through.' : doneWords(done, result, 'track', 'tracks'), undo);
    } catch (err) {
      toast(err?.tooLong ? err.message : failMessage(err, 'playlist'));
      if (!err?.tooLong) reload(); // (some may have moved)
    } finally {
      sorting = null;
      busy(false);
      bar.idle();
    }
  }

  // While a new order is saved: the list waits, the lock stays as it is, and
  // live updates don't reload the page under it.
  function busy(on) {
    list.classList.toggle('sorting', on);
    el.classList.toggle('is-sorting', on);
    if (lock) lock.el.disabled = on;
  }

  function sortBy(by, label) {
    reorder((entries) => sortedOrder(entries, by).map((m) => String(m.playlistItemID)), sortWords(by, label));
  }

  function showList() {
    pager = pagedList(list, {
      pageSize: 100,
      fetchPage: (start, size) => s.playlistItems(pl.ratingKey, { start, size }),
      render: (m) => rowFor(m),
      empty: 'This playlist is empty.',
      onDispose,
    });
  }

  // The list again, from the top, as Plex now has it.
  function reload() {
    pager?.destroy();
    list.replaceChildren();
    showList();
  }

  showList();
}

// ---------- Collection ----------

const KIND_UNITS = { artist: ['artist', 'artists'], album: ['album', 'albums'], track: ['track', 'tracks'] };

export async function collectionView({ el, params, onHide }) {
  const s = app.server;
  const { meta, items: loaded } = await s.collection(params.id);
  if (!meta) throw Object.assign(new Error('Not found'), { status: 404 });
  let items = loaded;
  // Only the server's admin can change a collection; smart ones follow
  // their rules.
  const editable = !meta.smart && (await isAdmin());
  let editing = false;

  const lock = editable ? lockButton('collection', () => setEditing(!editing)) : null;
  lock?.set(false);
  const hint = lock ? pointOut(lock.el, 'Locked, so nothing changes by accident. Tap the lock to reorder, sort or remove what’s in it, or change the picture.', { key: 'lock' }) : () => {};
  const picture = pictureBox(meta.thumb || meta.composite, {
    what: 'collection',
    id: meta.ratingKey,
    title: () => meta.title,
    load: async () => (await s.collection(meta.ratingKey)).meta,
    onChanged: (fresh) => {
      meta.thumb = fresh.thumb;
      meta.composite = fresh.composite;
      dropCached((p) => p === '/' || p === '/search' || p.startsWith('/browse/collections'));
    },
  });
  const menu = iconButton('more', 'More options', () =>
    collectionMenu(meta, { edit: editing ? { onRename: rename, onDelete: remove } : null, picture: editing ? () => picture.open() : null }),
  );
  const head = backHeader(meta.title, { collapse: true, actions: [lock?.el, menu] });
  const title = h('h1.hero-title', null, meta.title);
  const countEl = h('div.hero-meta', null, fmt.count(items.length, 'item', 'items'));
  const buttons = actionButtons([
    { icon: 'play', label: 'Play', primary: true, onClick: () => playCollection(meta) },
    { icon: 'shuffle', label: 'Shuffle', onClick: () => playCollection(meta, { shuffle: true }) },
  ]);
  el.append(
    head,
    h('section.hero.hero-album', null, picture.el, h('div.hero-info', null, title, countEl, buttons)),
  );
  collapseWhenHidden(head, title);
  const bar = editBar('Drag to change the order, or remove what doesn’t belong, and tap the picture to change it. Changes are saved to Plex as you go; nothing leaves your library.', {
    onDone: () => setEditing(false),
    onSort: () => chooseSort(meta.subtype || 'album', meta.title, (by, label) => sortBy(by, label)),
  });
  const body = h('div.collection-body');
  el.append(bar.el, body);
  const changed = () => dropCached((p) => p === '/' || p === '/search' || p.startsWith('/browse/collections'));
  const setCount = () => {
    countEl.textContent = fmt.count(items.length, 'item', 'items');
    buttons.hidden = !items.length;
    meta.childCount = items.length;
  };

  // Locked: tracks as a track list, albums and artists as cards.
  function renderLocked() {
    const tracks = items.filter((m) => m.type === 'track').map(normTrack);
    const kids = [];
    if (tracks.length) {
      const list = numberedList({ total: tracks.length, album: true });
      const unlock = [{ icon: 'unlock', label: 'Edit collection', description: 'Unlock it to reorder or remove tracks', onSelect: () => setEditing(true) }];
      tracks.forEach((t, i) =>
        list.append(
          trackRow(t, {
            showArt: true,
            position: true,
            album: true,
            onPlay: () => playList(tracks, i, { title: meta.title, href: `/collection/${params.id}` }),
            onMenu: editable ? ({ select }) => trackMenu(t, { extra: unlock, select }) : undefined,
          }),
        ),
      );
      kids.push(list);
    }
    const others = items.filter((m) => m.type !== 'track');
    if (others.length) {
      kids.push(grid(others.map((m) => (m.type === 'artist' ? artistCard(m) : m.type === 'collection' ? collectionCard(m) : albumCard(m))), { centered: true }));
    }
    if (!items.length) kids.push(emptyState('This collection is empty.'));
    body.replaceChildren(...kids);
  }

  // Unlocked: everything as rows, to drag or remove.
  const list = h('div.rows.edit-rows');
  function itemRow(m) {
    const t = m.type === 'track' ? normTrack(m) : null;
    const sub = t ? [t.artist, t.album].filter(Boolean).join(' — ') : m.type === 'album' ? m.parentTitle : '';
    const r = row({ image: t ? t.thumb : m.thumb, round: m.type === 'artist', fallback: m.type === 'artist' ? 'mic' : m.type === 'track' ? 'note' : 'disc', title: m.title, subtitle: sub });
    r.classList.add('edit-row');
    r.dataset.key = m.ratingKey;
    r.dataset.title = m.title;
    addEditControls(r, `“${m.title}” from the collection`, removeItem);
    return r;
  }
  function renderEditing() {
    list.replaceChildren(...items.map(itemRow));
    body.replaceChildren(items.length ? list : emptyState('This collection is empty.'));
  }

  function setEditing(on) {
    if (on) clearSelection();
    editing = on;
    el.classList.toggle('is-editing', on);
    bar.el.hidden = !on;
    lock?.set(on);
    picture.setEditing(on);
    if (on) {
      learned('lock');
      hint();
      renderEditing();
    } else renderLocked();
  }
  onHide(() => {
    hint();
    if (editing) setEditing(false);
  });

  async function removeItem(r) {
    const key = r.dataset.key;
    const at = items.findIndex((m) => String(m.ratingKey) === key);
    const item = items[at];
    const next = r.nextElementSibling;
    r.remove();
    items = items.filter((m) => m !== item);
    setCount();
    try {
      await s.removeFromCollection(meta.ratingKey, key);
    } catch (err) {
      items.splice(at, 0, item);
      list.insertBefore(r, next && next.parentElement === list ? next : null);
      setCount();
      toast(failMessage(err, 'collection'));
      return;
    }
    changed();
    toast(`Removed “${item.title}”`, {
      action: 'Undo',
      timeout: 6000,
      onAction: async () => {
        try {
          await s.addToCollection(meta.ratingKey, [key]);
          const prev = items[at - 1];
          if (meta.collectionSort === 2) await s.moveCollectionItem(meta.ratingKey, key, prev ? prev.ratingKey : null);
          items.splice(at, 0, item);
          setCount();
          if (editing) list.insertBefore(r, list.children[at] || null);
          else renderLocked();
          changed();
        } catch (err) {
          toast(failMessage(err, 'collection'));
          refresh();
        }
      },
    });
  }

  enableDrag(list, {
    item: '.edit-row',
    onDrop: async ({ item, order }) => {
      const prev = item.previousElementSibling;
      try {
        // A collection keeps a custom order only when sorted that way.
        if (meta.collectionSort !== 2) {
          await s.customOrder(meta.ratingKey);
          meta.collectionSort = 2;
        }
        await s.moveCollectionItem(meta.ratingKey, item.dataset.key, prev?.dataset.key || null);
        const byKey = new Map(items.map((m) => [String(m.ratingKey), m]));
        items = order.map((r) => byKey.get(r.dataset.key)).filter(Boolean);
        changed();
      } catch (err) {
        toast(failMessage(err, 'collection'));
        refresh();
      }
    },
  });

  async function rename() {
    const name = await askText({ title: 'Rename collection', label: 'Name', value: meta.title });
    if (!name || name === meta.title) return;
    try {
      await s.renameCollection(app.source.sectionKey, meta.ratingKey, name);
      meta.title = name;
      title.textContent = name;
      head.querySelector('.back-title').textContent = name;
      changed();
    } catch (err) {
      toast(failMessage(err, 'collection'));
    }
  }

  async function remove() {
    const unit = KIND_UNITS[meta.subtype] || ['item', 'items'];
    const sure = await confirmAction({
      title: `Delete “${meta.title}”?`,
      message: `The collection is deleted from Plex. The ${unit[1]} in it stay in your library.`,
      confirm: 'Delete collection',
    });
    if (!sure) return;
    try {
      await s.deleteCollection(meta.ratingKey);
      setEditing(false);
      changed();
      toast(`Deleted “${meta.title}”`);
      back('/search');
    } catch (err) {
      toast(failMessage(err, 'collection'));
    }
  }

  // ---------- sorting (see the playlist's) ----------

  let sorting = null;

  // makeTarget(items) gives the items' ids in the order wanted.
  async function reorder(makeTarget, [doing, done]) {
    if (sorting) return;
    const ctrl = new AbortController();
    sorting = ctrl;
    busy(true);
    bar.working(`${doing}…`, () => ctrl.abort());
    try {
      // A collection keeps an order of its own only when sorted "custom".
      // Its custom order can differ from the one it was showing, so the
      // moves are worked out from the order Plex has once it's custom.
      if (meta.collectionSort !== 2) {
        await s.customOrder(meta.ratingKey);
        meta.collectionSort = 2;
      }
      const result = await saveOrder({
        read: async () => {
          const { items: now } = await s.collection(meta.ratingKey);
          if (now.length > SORT_LIMIT) throw Object.assign(new Error(`Collections of more than ${fmt.number(SORT_LIMIT)} items can’t be sorted here.`), { tooLong: true });
          return now;
        },
        idOf: (m) => String(m.ratingKey),
        target: makeTarget,
        move: (id, after) => s.moveCollectionItem(meta.ratingKey, id, after),
        signal: ctrl.signal,
        onProgress: (n, of, p) => bar.say(movedWords(doing, n, of, p)),
      });
      if (result.moved) {
        changed();
        const before = result.before;
        const undo = { action: 'Undo', onAction: () => reorder((list2) => restoreOrder(list2.map((m) => String(m.ratingKey)), before), ['Putting it back', 'Put back']), timeout: 8000 };
        toast(result.stopped ? 'Stopped, part way through.' : doneWords(done, result, 'item', 'items'), undo);
      } else {
        toast('It’s in that order already.');
      }
      items = (await s.collection(meta.ratingKey)).items;
    } catch (err) {
      toast(err?.tooLong ? err.message : failMessage(err, 'collection'));
      // (Some may have moved.)
      if (!err?.tooLong) items = (await s.collection(meta.ratingKey).catch(() => null))?.items || items;
    } finally {
      sorting = null;
      busy(false);
      bar.idle();
      setCount();
      if (editing) renderEditing();
      else renderLocked();
    }
  }

  function busy(on) {
    list.classList.toggle('sorting', on);
    el.classList.toggle('is-sorting', on);
    if (lock) lock.el.disabled = on;
  }

  function sortBy(by, label) {
    reorder((now) => sortedOrder(now, by).map((m) => String(m.ratingKey)), sortWords(by, label));
  }

  setCount();
  renderLocked();
}

