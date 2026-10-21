import { app, playlistScope, on } from '../state.js';
import { normTrack } from '../plex.js';
import { navigate, parseHash, refresh } from '../router.js';
import { h, icon, pageHeader, backHeader, row, grid, pagedList, sheet, iconButton, iconTile, emptyState, debounce, fmt, sectionHeader } from '../ui.js';
import { mapLimit, norm } from '../ai.js';
import { albumCard, artistRow, playlistCard, collectionCard, trackRow, numberedList } from '../components.js';
import { playList } from '../actions.js';
import { isLovedTitle } from '../ratings.js';
import { importPicker, backUpPlaylists } from './playlistfiles.js';
import { sharingOn, freshShares, invitations } from '../sharing.js';
import { invitationRows } from './share.js';

// ---------- Browsing the library (in Search) ----------

// Tiles for the library's lists, each with its count. Lists the library
// doesn't have (no soundtracks, no moods) leave once their count is in.
export function libraryTiles() {
  const s = app.server;
  const sec = app.source.sectionKey;
  const collectionsP = s.collections(sec).catch(() => []);
  const albumsP = s.count(sec, 9);
  const tags = (field, type) => async () => (await s.tags(sec, field, type)).length;
  // If the server ignores a filter it returns every album; that counts as
  // "not supported" rather than a misleading count.
  const filteredAlbums = (filters) => async () => {
    const [n, all] = await Promise.all([s.count(sec, 9, filters), albumsP]);
    return n === all ? 0 : n;
  };

  const entries = [
    { title: 'Artists', icon: 'mic', href: '/browse/artists', count: () => s.count(sec, 8), unit: ['artist', 'artists'] },
    { title: 'Albums', icon: 'disc', href: '/browse/albums', count: () => albumsP, unit: ['album', 'albums'] },
    { title: 'Tracks', icon: 'note', href: '/browse/tracks', count: () => s.count(sec, 10), unit: ['track', 'tracks'] },
    { title: 'Compilations', icon: 'stack', href: '/browse/albums?subformat=Compilation&title=Compilations', count: filteredAlbums({ subformat: 'Compilation' }), unit: ['compilation', 'compilations'], optional: true },
    { title: 'Soundtracks', icon: 'film', href: '/browse/albums?subformat=Soundtrack&title=Soundtracks', count: filteredAlbums({ subformat: 'Soundtrack' }), unit: ['soundtrack', 'soundtracks'], optional: true },
    { title: 'Collections', icon: 'collection', href: '/browse/collections?title=Collections', count: async () => (await collectionsP).length, unit: ['collection', 'collections'], optional: true },
    { title: 'Genres', icon: 'tag', href: '/tags/genre/9?title=Genres', count: tags('genre', 9), unit: ['genre', 'genres'], optional: true },
    { title: 'Artist genres', icon: 'tag', href: '/tags/genre/8?title=Artist%20genres', count: tags('genre', 8), unit: ['genre', 'genres'], optional: true },
    { title: 'Styles', icon: 'palette', href: '/tags/style/9?title=Styles', count: tags('style', 9), unit: ['style', 'styles'], optional: true },
    { title: 'Moods', icon: 'smile', href: '/tags/mood/9?title=Moods', count: tags('mood', 9), unit: ['mood', 'moods'], optional: true },
    { title: 'Decades', icon: 'calendar', href: '/tags/decade/9?title=Decades', count: tags('decade', 9), unit: ['decade', 'decades'], optional: true },
  ];

  const tiles = h('div.browse-tiles');
  for (const e of entries) {
    const count = h('span.browse-count', null, '\u00a0');
    const tile = h(
      'a.browse-tile',
      { href: `#${e.href}` },
      h('span.browse-icon', null, icon(e.icon, 22)),
      h('span.browse-text', null, h('span.browse-title', null, e.title), count),
    );
    if (e.optional) tile.hidden = true;
    tiles.append(tile);
    e.count().then(
      (n) => {
        if (e.optional && !n) return tile.remove();
        count.textContent = fmt.count(n, ...e.unit);
        tile.hidden = false;
      },
      () => (e.optional ? tile.remove() : (count.textContent = 'Unavailable')),
    );
  }
  return tiles;
}

// ---------- Browse lists ----------

const SORTS = {
  artists: [
    ['titleSort', 'Name'],
    ['addedAt:desc', 'Recently added'],
    ['lastViewedAt:desc', 'Recently played'],
    ['viewCount:desc', 'Most played'],
  ],
  albums: [
    ['titleSort', 'Name'],
    ['artist.titleSort', 'Artist'],
    ['year:desc', 'Release year'],
    ['addedAt:desc', 'Recently added'],
    ['lastViewedAt:desc', 'Recently played'],
    ['viewCount:desc', 'Most played'],
  ],
  tracks: [
    ['titleSort', 'Name'],
    ['artist.titleSort', 'Artist'],
    ['album.titleSort', 'Album'],
    ['addedAt:desc', 'Recently added'],
    ['lastViewedAt:desc', 'Recently played'],
    ['viewCount:desc', 'Most played'],
  ],
};
const TYPES = { artists: 8, albums: 9, tracks: 10 };
const KINDS = { 8: 'artists', 9: 'albums', 10: 'tracks' };
const TITLES = { artists: 'Artists', albums: 'Albums', tracks: 'Tracks' };
const UNITS = { artists: ['artist', 'artists'], albums: ['album', 'albums'], tracks: ['track', 'tracks'] };
const RESERVED = new Set(['sort', 'title', 'within']);

// Tags that narrow each kind of list: [field, name, icon].
const FIELDS = {
  albums: [
    ['genre', 'Genre', 'tag'],
    ['style', 'Style', 'palette'],
    ['mood', 'Mood', 'smile'],
    ['decade', 'Decade', 'calendar'],
  ],
  artists: [
    ['genre', 'Genre', 'tag'],
    ['style', 'Style', 'palette'],
    ['mood', 'Mood', 'smile'],
  ],
  tracks: [],
};
const SUBFORMATS = { Compilation: 'Compilations', Soundtrack: 'Soundtracks' };

// A list's filters as Plex takes them. Words in the title are "words" here,
// as "title" names the page.
const plexFilters = (filters) => {
  const { words, ...rest } = filters;
  return words ? { ...rest, title: words } : rest;
};

// A list of albums or artists with these filters ({ genre: key, ... }).
export function browseHref(kind, filters, sort) {
  const q = new URLSearchParams(filters);
  if (sort) q.set('sort', sort);
  const qs = q.toString();
  return `/browse/${kind}${qs ? `?${qs}` : ''}`;
}

// Names for a list's filters ("Rock", "1990s"), from the library's tags.
async function filterLabels(kind, filters) {
  const s = app.server;
  const sec = app.source.sectionKey;
  const type = TYPES[kind];
  const out = [];
  for (const [key, value] of Object.entries(filters)) {
    let label = null;
    if (key === 'words') label = `“${value}”`;
    else if (key === 'subformat') label = SUBFORMATS[value] || null;
    else if (FIELDS[kind]?.some(([f]) => f === key)) {
      const tags = await s.tags(sec, key, type).catch(() => []);
      label = tags.find((t) => String(t.key) === String(value))?.title || null;
    }
    if (label) out.push({ key, value, label });
  }
  return out;
}

export async function browseView({ el, params, query, onDispose }) {
  const kind = params.kind;
  if (kind === 'collections') return collectionsView({ el, query });
  const type = TYPES[kind];
  if (!type) throw new Error('Unknown list.');
  const sorts = SORTS[kind];
  const sort = query.sort || sorts[0][0];
  const filters = Object.fromEntries(Object.entries(query).filter(([k]) => !RESERVED.has(k)));
  const title = query.title || TITLES[kind];

  const countEl = h('div.list-count');
  const head = backHeader(title, {
    fallback: '/search',
    actions: iconButton('sort', 'Sort', () => openSort(sorts, sort)),
  });
  const chips = h('div.chips.filter-chips', { hidden: true, role: 'list', 'aria-label': 'Filters' });
  const within = searchWithin({ kind, filters, title, sort: query.sort });
  el.append(head, chips, within, countEl);

  // Pages put aside are kept, and still brought up to date.
  let disposed = false;
  onDispose(() => (disposed = true));

  // The filters by name, each removable; the page is named after them.
  filterLabels(kind, filters).then((labels) => {
    if (!labels.length || disposed) return;
    // Named after its filters, unless it has a name of its own ("Best of the 90s").
    if (!query.title && labels.length === Object.keys(filters).length) {
      const name = labels.map((l) => l.label).join(' · ');
      head.querySelector('.back-title').textContent = name;
      within.rename(name);
    }
    if (labels.length < 2 && !query.within) return;
    chips.replaceChildren(
      ...labels.map((l) => {
        const rest = Object.fromEntries(Object.entries(filters).filter(([k]) => k !== l.key));
        return h(
          'button.chip.filter-chip',
          { type: 'button', role: 'listitem', 'aria-label': `Remove ${l.label}`, onclick: () => navigate(browseHref(kind, { ...rest, within: '1' }, query.sort), { replace: true }) },
          h('span', null, l.label),
          icon('close', 16),
        );
      }),
    );
    chips.hidden = false;
  });

  const s = app.server;
  const sec = app.source.sectionKey;
  const r = renderer(type, title);
  const container = r.wrap();
  el.append(container);
  pagedList(container, {
    pageSize: r.pageSize,
    fetchPage: (start, size) => s.list(sec, type, { sort, start, size, filters: plexFilters(filters) }),
    render: r.render,
    onTotal: (n) => {
      countEl.textContent = fmt.count(n, r.unit[0], r.unit[1]);
      container.style.setProperty('--pos-digits', String(Math.max(2, String(n).length)));
    },
    empty: 'Nothing matches.',
    onDispose,
  });
}

// "Search in 1990s": narrows the list by another tag (a genre, a style, a
// mood or a decade) or by words in the title. Only choices with something
// to show are offered, with how many.
function searchWithin({ kind, filters, title: name, sort }) {
  let title = name;
  const s = app.server;
  const sec = app.source.sectionKey;
  const type = TYPES[kind];
  const unit = UNITS[kind];
  const base = filters;
  const input = h('input', {
    type: 'search',
    placeholder: `Search in ${title}`,
    'aria-label': `Search in ${title}`,
    autocomplete: 'off',
    enterkeyhint: 'search',
  });
  const results = h('div.rows.within-results', { hidden: true });
  const clear = iconButton('close', 'Clear', () => {
    input.value = '';
    show('');
    input.focus();
  }, { size: 22, cls: 'search-clear' });
  clear.hidden = true;
  const wrap = h('div.within', null, h('label.search-box.has-clear.within-box', null, icon('search', 22), input, clear), results);
  wrap.rename = (n) => {
    title = n;
    input.placeholder = `Search in ${n}`;
    input.setAttribute('aria-label', `Search in ${n}`);
  };
  let seq = 0;

  const pick = (key, value) => navigate(browseHref(kind, { ...base, [key]: value, within: '1' }, sort));

  async function show(raw) {
    const mine = ++seq;
    const q = norm(raw);
    clear.hidden = !raw;
    if (!q) {
      results.hidden = true;
      results.replaceChildren();
      return;
    }
    // Tags from the fields not used yet, best matches first.
    const fields = FIELDS[kind].filter(([f]) => !(f in base));
    const lists = await Promise.all(fields.map(([f]) => s.tags(sec, f, type).catch(() => [])));
    if (mine !== seq) return;
    const found = [];
    fields.forEach(([field, name, ic], i) => {
      for (const t of lists[i]) {
        const n = norm(t.title);
        const at = n.indexOf(q);
        if (at >= 0) found.push({ field, name, ic, tag: t, rank: (at === 0 ? 0 : 1) * 1000 + n.length });
      }
    });
    found.sort((a, b) => a.rank - b.rank);
    const options = found.slice(0, 10);
    const [counts, titled] = await Promise.all([
      mapLimit(options, 5, (o) => s.count(sec, type, plexFilters({ ...base, [o.field]: o.tag.key })).catch(() => 0)),
      s.count(sec, type, plexFilters({ ...base, words: raw.trim() })).catch(() => 0),
    ]);
    if (mine !== seq) return;
    const rows = options
      .map((o, i) => ({ ...o, n: counts[i] }))
      .filter((o) => o.n > 0)
      .slice(0, 8)
      .map((o) =>
        row({
          onClick: () => pick(o.field, o.tag.key),
          lead: iconTile(o.ic),
          title: o.tag.title,
          subtitle: `${o.name} · ${fmt.count(o.n, ...unit)}`,
          chevron: true,
          cls: 'within-option',
        }),
      );
    if (titled > 0) {
      rows.push(
        row({
          onClick: () => pick('words', raw.trim()),
          lead: iconTile('search'),
          title: `“${raw.trim()}”`,
          subtitle: `In the ${kind === 'artists' ? 'name' : 'title'} · ${fmt.count(titled, ...unit)}`,
          chevron: true,
          cls: 'within-option',
        }),
      );
    }
    results.replaceChildren(...(rows.length ? rows : [h('p.within-none', null, `Nothing in ${title} matches “${raw.trim()}”.`)]));
    results.hidden = false;
  }

  const later = debounce(() => show(input.value), 250);
  input.addEventListener('input', () => {
    clear.hidden = !input.value;
    later();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      results.querySelector('.within-option')?.click();
    }
    if (e.key === 'Escape' && input.value) {
      e.preventDefault();
      e.stopPropagation();
      input.value = '';
      show('');
    }
  });
  return wrap;
}

function openSort(sorts, current) {
  sheet({
    title: 'Sort by',
    actions: sorts.map(([value, label]) => ({
      label,
      checked: value === current,
      onSelect: () => {
        const { path, query } = parseHash();
        const q = new URLSearchParams({ ...query, sort: value });
        navigate(`${path}?${q}`, { replace: true });
      },
    })),
  });
}

function renderer(type, title) {
  const t = Number(type);
  if (t === 8) return { wrap: () => h('div.rows'), render: (m) => artistRow(m), pageSize: 100, unit: ['artist', 'artists'] };
  if (t === 9) return { wrap: () => grid([], { centered: true }), render: (m) => albumCard(m), pageSize: 60, unit: ['album', 'albums'] };
  if (t === 10) {
    return {
      wrap: () => numberedList({ album: true }),
      pageSize: 100,
      unit: ['track', 'tracks'],
      render: (m, i, all) =>
        trackRow(normTrack(m), {
          showArt: true,
          position: true,
          album: true,
          subAlbum: true,
          subtitle: m.originalTitle || m.grandparentTitle || '',
          onPlay: () => playList(all.map(normTrack), i, { title, href: null }),
        }),
    };
  }
  if (t === 15) return { wrap: () => grid([], { centered: true }), render: (m) => playlistCard(m), pageSize: 60, unit: ['playlist', 'playlists'] };
  return { wrap: () => grid([], { centered: true }), render: (m) => collectionCard(m), pageSize: 60, unit: ['item', 'items'] };
}

// ---------- Playlists ----------

// Importing from a file, and backing up to one (see playlistfiles.js).
function playlistsMenu() {
  sheet({
    title: 'Playlists',
    actions: [
      {
        icon: 'arrowUp',
        label: 'Import playlists…',
        description: `From a file exported from plexamp-web. Their tracks are looked for in ${app.source.sectionTitle}.`,
        now: true,
        onSelect: () => importPicker(),
      },
      {
        icon: 'arrowDown',
        label: 'Back up your playlists',
        description: 'All of yours on this server, in one file, to import again later or on another server. Smart playlists aren’t included.',
        onSelect: () => backUpPlaylists(),
      },
    ],
  });
}

export async function playlistsView({ el, onDispose }) {
  const [pls] = await Promise.all([app.server.playlists(playlistScope()), sharingOn() ? freshShares().catch(() => []) : null]);
  const menu = iconButton('more', 'Import and back up', playlistsMenu, { cls: 'playlists-menu' });
  el.append(pageHeader('Playlists', { subtitle: pls.length ? fmt.count(pls.length, 'playlist', 'playlists') : null, actions: [menu] }));
  // Shared with you by Plex friends, to add (or not).
  const invites = h('section.block.invites');
  const paintInvites = () => {
    const list = invitations();
    invites.hidden = !list.length;
    invites.replaceChildren(...(list.length ? [sectionHeader('Shared with you'), h('div.rows', null, invitationRows(list, { onChange: () => refresh() }))] : []));
  };
  paintInvites();
  onDispose?.(on('shares', paintInvites));
  el.append(invites);
  if (!pls.length) {
    el.append(
      emptyState(
        'No music playlists yet. To make one, choose Add to playlist… in the menu of a track, album or artist, or import some from a file.',
        h('button.btn.btn-secondary', { type: 'button', onclick: () => importPicker() }, 'Import playlists…'),
      ),
    );
    return;
  }
  // ❤️ Tracks first, as in Plexamp.
  const sorted = [...pls.filter((p) => isLovedTitle(p.title)), ...pls.filter((p) => !isLovedTitle(p.title))];
  el.append(grid(sorted.map((m) => playlistCard(m)), { centered: true, cls: 'grid-playlists' }));
}

// ---------- Collections ----------

async function collectionsView({ el, query }) {
  el.append(backHeader(query.title || 'Collections', { fallback: '/search' }));
  const all = await app.server.collections(app.source.sectionKey);
  const items = all.filter((c) => !query.subtype || (c.subtype || 'album') === query.subtype);
  if (!items.length) {
    el.append(emptyState('No collections here.'));
    return;
  }
  el.append(grid(items.map((m) => collectionCard(m)), { centered: true }));
}

// ---------- Genres, styles, moods, decades ----------

// How many albums (or artists) have each tag: tags nothing in the library
// uses any more are left out, and the rest show their count.
export async function tagsView({ el, params, query, onDispose }) {
  let disposed = false;
  onDispose?.(() => (disposed = true));
  const { field, type } = params;
  const kind = KINDS[type];
  el.append(backHeader(query.title || 'Browse', { fallback: '/search' }));
  const s = app.server;
  const sec = app.source.sectionKey;
  const tags = await s.tags(sec, field, type);
  if (!tags.length || !kind) {
    el.append(emptyState('Nothing here.'));
    return;
  }
  const list = h('div.rows');
  const rows = tags.map((t) => {
    const count = h('span.row-count');
    const r = row({ href: browseHref(kind, { [field]: String(t.key), title: t.title }), title: t.title, subtitle: count });
    list.append(r);
    return { t, r, count };
  });
  el.append(list);
  await mapLimit(rows, 6, async ({ t, r, count }) => {
    if (disposed) return;
    const n = await s.memo(`tagCount:${sec}:${type}:${field}:${t.key}`, () => s.count(sec, type, { [field]: String(t.key) }), 10 * 60000).catch(() => null);
    if (n === 0) r.remove();
    else if (n) count.textContent = fmt.count(n, ...UNITS[kind]);
  });
  if (!list.children.length && !disposed) list.replaceWith(emptyState('Nothing here.'));
}

// Generic paged listing for any server path (e.g. a genre's albums).
export async function itemsView({ el, query, onDispose }) {
  const title = query.title || 'Browse';
  const countEl = h('div.list-count');
  el.append(backHeader(title, { fallback: '/search' }), countEl);
  const r = renderer(query.type, title);
  const container = r.wrap();
  el.append(container);
  pagedList(container, {
    pageSize: r.pageSize,
    fetchPage: (start, size) => app.server.byPath(query.path, { start, size }),
    render: r.render,
    onTotal: (n) => {
      countEl.textContent = fmt.count(n, r.unit[0], r.unit[1]);
      container.style.setProperty('--pos-digits', String(Math.max(2, String(n).length)));
    },
    onDispose,
  });
}
