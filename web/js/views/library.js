import { app, playlistScope } from '../state.js';
import { normTrack } from '../plex.js';
import { navigate, parseHash } from '../router.js';
import { h, pageHeader, backHeader, row, grid, pagedList, sheet, iconButton, emptyState, fmt } from '../ui.js';
import { albumCard, artistRow, playlistCard, collectionCard, trackRow } from '../components.js';
import { playList } from '../actions.js';

// ---------- Library index ----------

export async function libraryView({ el }) {
  const s = app.server;
  const sec = app.source.sectionKey;
  el.append(pageHeader('Library'));
  const list = h('div.rows.library-rows');
  el.append(list);

  const collectionsP = s.collections(sec).catch(() => []);
  const bySubtype = (st) => collectionsP.then((cs) => cs.filter((c) => (c.subtype || 'album') === st).length);
  const albumsP = s.count(sec, 9);

  const entries = [
    { title: 'Artists', href: '/browse/artists', count: () => s.count(sec, 8), unit: ['artist', 'artists'] },
    { title: 'Albums', href: '/browse/albums', count: () => albumsP, unit: ['album', 'albums'] },
    {
      title: 'Compilations',
      href: `/browse/albums?subformat=Compilation&title=Compilations`,
      count: () => filteredAlbumCount({ subformat: 'Compilation' }),
      unit: ['compilation', 'compilations'],
      optional: true,
    },
    {
      title: 'Soundtracks',
      href: `/browse/albums?subformat=Soundtrack&title=Soundtracks`,
      count: () => filteredAlbumCount({ subformat: 'Soundtrack' }),
      unit: ['soundtrack', 'soundtracks'],
      optional: true,
    },
    { title: 'Tracks', href: '/browse/tracks', count: () => s.count(sec, 10), unit: ['track', 'tracks'] },
    { title: 'Playlists', href: '/library/playlists', count: async () => (await s.playlists(playlistScope())).length, unit: ['playlist', 'playlists'] },
    { title: 'Artist collections', href: '/browse/collections?subtype=artist&title=Artist%20collections', count: () => bySubtype('artist'), unit: ['collection', 'collections'], optional: true },
    { title: 'Album collections', href: '/browse/collections?subtype=album&title=Album%20collections', count: () => bySubtype('album'), unit: ['collection', 'collections'], optional: true },
    { title: 'Track collections', href: '/browse/collections?subtype=track&title=Track%20collections', count: () => bySubtype('track'), unit: ['collection', 'collections'], optional: true },
    { title: 'Artist genres', href: '/tags/genre/8?title=Artist%20genres', count: async () => (await s.tags(sec, 'genre', 8)).length, unit: ['genre', 'genres'], optional: true },
    { title: 'Album genres', href: '/tags/genre/9?title=Album%20genres', count: async () => (await s.tags(sec, 'genre', 9)).length, unit: ['genre', 'genres'], optional: true },
    { title: 'Styles', href: '/tags/style/9?title=Styles', count: async () => (await s.tags(sec, 'style', 9)).length, unit: ['style', 'styles'], optional: true },
    { title: 'Moods', href: '/tags/mood/9?title=Moods', count: async () => (await s.tags(sec, 'mood', 9)).length, unit: ['mood', 'moods'], optional: true },
    { title: 'Decades', href: '/tags/decade/9?title=Decades', count: async () => (await s.tags(sec, 'decade', 9)).length, unit: ['decade', 'decades'], optional: true },
  ];

  // If the server ignores a filter it returns every album; treat that as
  // "not supported" rather than showing a misleading count.
  async function filteredAlbumCount(filters) {
    const [n, all] = await Promise.all([s.count(sec, 9, filters), albumsP]);
    return n === all ? 0 : n;
  }

  for (const e of entries) {
    const sub = h('span.count', null, ' ');
    const r = row({ href: e.href, title: e.title, subtitle: sub });
    if (e.optional) r.hidden = true;
    list.append(r);
    e.count().then(
      (n) => {
        if (e.optional && !n) return r.remove();
        sub.textContent = fmt.count(n, ...e.unit);
        r.hidden = false;
      },
      () => (e.optional ? r.remove() : (sub.textContent = 'Unavailable')),
    );
  }
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
      fallback: '/library',
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
  el.append(backHeader('Playlists', { fallback: '/library' }));
  const pls = await app.server.playlists(playlistScope());
  if (!pls.length) {
    el.append(emptyState('No music playlists on this server yet. Playlists you make in Plex show up here.'));
    return;
  }
  el.append(grid(pls.map((m) => playlistCard(m)), { centered: true, cls: 'grid-playlists' }));
}

// ---------- Collections ----------

async function collectionsView({ el, query }) {
  el.append(backHeader(query.title || 'Collections', { fallback: '/library' }));
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
  el.append(backHeader(query.title || 'Browse', { fallback: '/library' }));
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
  el.append(backHeader(title, { fallback: '/library' }), countEl);
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
