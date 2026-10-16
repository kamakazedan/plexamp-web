import { app, playlistScope } from '../state.js';
import { normTrack } from '../plex.js';
import { navigate, parseHash } from '../router.js';
import { h, icon, pageHeader, backHeader, row, grid, pagedList, sheet, iconButton, emptyState, fmt } from '../ui.js';
import { albumCard, artistRow, playlistCard, collectionCard, trackRow } from '../components.js';
import { playList } from '../actions.js';
import { isLovedTitle } from '../ratings.js';

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
const TITLES = { artists: 'Artists', albums: 'Albums', tracks: 'Tracks' };
const RESERVED = new Set(['sort', 'title']);

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
  el.append(
    backHeader(title, {
      fallback: '/search',
      actions: iconButton('sort', 'Sort', () => openSort(sorts, sort)),
    }),
    countEl,
  );

  const s = app.server;
  const sec = app.source.sectionKey;
  const r = renderer(type, title);
  const container = r.wrap();
  el.append(container);
  pagedList(container, {
    pageSize: r.pageSize,
    fetchPage: (start, size) => s.list(sec, type, { sort, start, size, filters }),
    render: r.render,
    onTotal: (n) => (countEl.textContent = fmt.count(n, r.unit[0], r.unit[1])),
    empty: 'Nothing matches.',
    onDispose,
  });
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
      wrap: () => h('div.tracks'),
      pageSize: 100,
      unit: ['track', 'tracks'],
      render: (m, i, all) =>
        trackRow(normTrack(m), {
          showArt: true,
          subtitle: [m.originalTitle || m.grandparentTitle, m.parentTitle].filter(Boolean).join(' — '),
          onPlay: () => playList(all.map(normTrack), i, { title, href: null }),
        }),
    };
  }
  if (t === 15) return { wrap: () => grid([], { centered: true }), render: (m) => playlistCard(m), pageSize: 60, unit: ['playlist', 'playlists'] };
  return { wrap: () => grid([], { centered: true }), render: (m) => collectionCard(m), pageSize: 60, unit: ['item', 'items'] };
}

// ---------- Playlists ----------

export async function playlistsView({ el }) {
  const pls = await app.server.playlists(playlistScope());
  el.append(pageHeader('Playlists', { subtitle: pls.length ? fmt.count(pls.length, 'playlist', 'playlists') : null }));
  if (!pls.length) {
    el.append(emptyState('No music playlists yet. To make one, choose Add to playlist… in the menu of a track, album or artist.'));
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

export async function tagsView({ el, params, query }) {
  const { field, type } = params;
  el.append(backHeader(query.title || 'Browse', { fallback: '/search' }));
  const sec = app.source.sectionKey;
  const tags = await app.server.tags(sec, field, type);
  if (!tags.length) {
    el.append(emptyState('Nothing here.'));
    return;
  }
  const list = h('div.rows');
  for (const t of tags) {
    const path = t.fastKey || `/library/sections/${sec}/all?type=${type}&${field}=${encodeURIComponent(t.key)}`;
    const q = new URLSearchParams({ type, title: t.title, path });
    list.append(row({ href: `/items?${q}`, title: t.title, subtitle: t.count ? fmt.number(t.count) : null }));
  }
  el.append(list);
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
    onTotal: (n) => (countEl.textContent = fmt.count(n, r.unit[0], r.unit[1])),
    onDispose,
  });
}
