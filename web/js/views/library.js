import { app, playlistScope, on } from '../state.js';
import { normTrack, store } from '../plex.js';
import { navigate, parseHash, refresh, keepState } from '../router.js';
import { h, icon, pageHeader, backHeader, row, grid, pagedList, sheet, iconButton, iconTile, emptyState, debounce, fmt, sectionHeader } from '../ui.js';
import { mapLimit, norm } from '../ai.js';
import { albumCard, artistRow, playlistCard, collectionCard, trackRow, numberedList } from '../components.js';
import { playList } from '../actions.js';
import { isLovedTitle } from '../ratings.js';
import { importPicker, backUpPlaylists } from './playlistfiles.js';
import { sharingOn, freshShares, invitations } from '../sharing.js';
import { invitationRows } from './share.js';

// ---------- Browsing the library (in Search) ----------

// The counts last seen for each library, kept in the browser (and cleared on
// signing out, as everything of yours is), so the tiles show at once, in
// their places: brought up to date in place as the server answers, with a
// list that's gone or new left for next time, so nothing moves while
// you're looking. The first time, every tile has its place until its count
// is in (one the library doesn't have says so, and goes next time).
const COUNTS_KEY = 'libraryCounts';
const COUNTS_KEPT = 12; // libraries
const COUNTS_FRESH = 5 * 60000; // asked again after this long

const libraryKey = () => `${app.source.serverId || app.source.uri}:${app.source.sectionKey}`;
function keptCounts(lib) {
  const all = store.get(COUNTS_KEY);
  const counts = all && typeof all === 'object' ? all[lib]?.counts : null;
  return counts && typeof counts === 'object' ? counts : null;
}
// `fresh`: the counts the server gave (id -> count). The others keep what's
// kept for them as it is now (by another tab meanwhile, say): a count that
// couldn't be had isn't taken for none, nor for an older one.
function keepCounts(lib, fresh, ids) {
  const was = keptCounts(lib) || {};
  const counts = {};
  for (const id of ids) {
    if (fresh.has(id)) counts[id] = fresh.get(id);
    else if (Number.isFinite(Number(was[id]))) counts[id] = Number(was[id]);
  }
  const all = { ...(store.get(COUNTS_KEY) || {}), [lib]: { counts, at: Date.now() } };
  const recent = Object.keys(all)
    .sort((a, b) => (all[b]?.at || 0) - (all[a]?.at || 0))
    .slice(0, COUNTS_KEPT);
  store.set(COUNTS_KEY, Object.fromEntries(recent.map((k) => [k, all[k]])));
}

// Tiles for the library's lists, each with its count.
export function libraryTiles() {
  const s = app.server;
  const sec = app.source.sectionKey;
  const lib = libraryKey();
  const kept = keptCounts(lib);
  // (Asked of the server at most every few minutes.)
  const ask = (id, fn) => s.memo(`libraryCount:${sec}:${id}`, fn, COUNTS_FRESH);
  const collectionsP = () => ask('collections', () => s.collections(sec));
  const albumsP = () => ask('albums', () => s.count(sec, 9));
  const tags = (field, type) => async () => (await s.tags(sec, field, type)).length;
  // If the server ignores a filter it returns every album; that counts as
  // "not supported" rather than a misleading count.
  const filteredAlbums = (filters) => async () => {
    const [n, all] = await Promise.all([s.count(sec, 9, filters), albumsP()]);
    return n === all ? 0 : n;
  };

  const entries = [
    { id: 'artists', title: 'Artists', icon: 'mic', href: '/browse/artists', count: () => s.count(sec, 8), unit: ['artist', 'artists'] },
    { id: 'albums', title: 'Albums', icon: 'disc', href: '/browse/albums', count: () => albumsP(), unit: ['album', 'albums'] },
    { id: 'tracks', title: 'Tracks', icon: 'note', href: '/browse/tracks', count: () => s.count(sec, 10), unit: ['track', 'tracks'] },
    { id: 'compilations', title: 'Compilations', icon: 'stack', href: '/browse/albums?subformat=Compilation&title=Compilations', count: filteredAlbums({ subformat: 'Compilation' }), unit: ['compilation', 'compilations'], optional: true },
    { id: 'soundtracks', title: 'Soundtracks', icon: 'film', href: '/browse/albums?subformat=Soundtrack&title=Soundtracks', count: filteredAlbums({ subformat: 'Soundtrack' }), unit: ['soundtrack', 'soundtracks'], optional: true },
    { id: 'collections', title: 'Collections', icon: 'collection', href: '/browse/collections?title=Collections', count: async () => (await collectionsP()).length, unit: ['collection', 'collections'], optional: true },
    { id: 'genres', title: 'Genres', icon: 'tag', href: '/tags/genre/9?title=Genres', count: tags('genre', 9), unit: ['genre', 'genres'], optional: true },
    { id: 'artistGenres', title: 'Artist genres', icon: 'tag', href: '/tags/genre/8?title=Artist%20genres', count: tags('genre', 8), unit: ['genre', 'genres'], optional: true },
    { id: 'styles', title: 'Styles', icon: 'palette', href: '/tags/style/9?title=Styles', count: tags('style', 9), unit: ['style', 'styles'], optional: true },
    { id: 'moods', title: 'Moods', icon: 'smile', href: '/tags/mood/9?title=Moods', count: tags('mood', 9), unit: ['mood', 'moods'], optional: true },
    { id: 'decades', title: 'Decades', icon: 'calendar', href: '/tags/decade/9?title=Decades', count: tags('decade', 9), unit: ['decade', 'decades'], optional: true },
  ];

  const tiles = h('div.browse-tiles');
  const fresh = new Map(); // the counts the server gave
  const asked = entries.map((e) => {
    const before = kept?.[e.id];
    // A list the library didn't have last time isn't shown (if it has one
    // now, it's there next time).
    const shown = !e.optional || !kept || Number(before) > 0;
    let tile = null;
    let count = null;
    if (shown) {
      count = h(`span.browse-count${Number.isFinite(Number(before)) ? '' : '.loading'}`, null, Number.isFinite(Number(before)) ? fmt.count(Number(before), ...e.unit) : ' ');
      tile = h('a.browse-tile', { href: `#${e.href}` }, h('span.browse-icon', null, icon(e.icon, 22)), h('span.browse-text', null, h('span.browse-title', null, e.title), count));
      tiles.append(tile);
    }
    // (A count that couldn't be had says so, and what was kept stays: see
    // keepCounts.)
    return ask(e.id, e.count).then(
      (n) => {
        fresh.set(e.id, Number(n) || 0);
        if (!tile) return;
        count.classList.remove('loading');
        if (e.optional && !n) {
          // Kept in its place (this time): it says there's none, and can't be opened.
          count.textContent = 'None';
          tile.classList.add('browse-none');
          tile.removeAttribute('href');
          tile.setAttribute('aria-disabled', 'true');
          return;
        }
        count.textContent = fmt.count(n, ...e.unit);
      },
      () => {
        if (!count) return;
        count.classList.remove('loading');
        count.textContent = 'Unavailable';
      },
    );
  });
  // (Nothing to keep when none came: offline, say, or the page going, which
  // stops what it asked for.)
  Promise.allSettled(asked).then(() => {
    if (fresh.size && app.source && libraryKey() === lib) keepCounts(lib, fresh, entries.map((e) => e.id));
  });
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

export async function browseView({ el, params, query, saved, key, onDispose }) {
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
  const within = searchWithin({ kind, filters, title, sort: query.sort, typed: saved?.within || '', onWords: (q) => showWords(q) });
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
          'span.chip-item',
          { role: 'listitem' },
          h(
            'button.chip.filter-chip',
            // (What's typed in the search box stays.)
            { type: 'button', 'aria-label': `Remove ${l.label}`, onclick: () => navigate(browseHref(kind, { ...rest, within: '1' }, query.sort), { replace: true, keep: true }) },
            h('span', null, l.label),
            icon('close', 16),
          ),
        );
      }),
    );
    chips.hidden = false;
  });

  const s = app.server;
  const sec = app.source.sectionKey;
  const r = renderer(type, title);
  const counted = (n) => {
    countEl.textContent = fmt.count(n, r.unit[0], r.unit[1]);
  };
  // The list as it is, and (while something's typed in the box) what in it
  // matches, shown in its place as you type; each with what loads more of
  // it, which stops while it's out of sight.
  const box = (list) => h('div.list-box', null, list);
  const listed = (wrap, extra, empty) =>
    pagedList(wrap, {
      pageSize: r.pageSize,
      fetchPage: (start, size) => s.list(sec, type, { sort, start, size, filters: plexFilters({ ...filters, ...extra }) }),
      render: r.render,
      onTotal: (n) => {
        if (wrap.isConnected && !wrap.closest('[hidden]')) counted(n);
        wrap.dataset.total = String(n);
        wrap.style.setProperty('--pos-digits', String(Math.max(2, String(n).length)));
      },
      empty,
      onDispose,
    });
  const container = r.wrap();
  const all = box(container);
  el.append(all);
  listed(container, {}, 'Nothing matches.');
  const matches = box(null);
  matches.hidden = true;
  el.append(matches);
  let typed = null; // { list, words }

  function showWords(raw) {
    const words = raw.trim();
    if (typed?.words === words) return;
    typed?.list.destroy();
    typed = null;
    matches.replaceChildren();
    keepState(words ? { within: words } : null, key);
    if (!words) {
      matches.hidden = true;
      all.hidden = false;
      if (container.dataset.total) counted(Number(container.dataset.total));
      return;
    }
    all.hidden = true;
    matches.hidden = false;
    countEl.textContent = ' ';
    const list = r.wrap();
    matches.append(list);
    typed = { words, list: listed(list, { words }, `Nothing in ${title} matches “${words}”.`) };
  }
  if (saved?.within) showWords(saved.within);
}

// "Search in 1990s": what's typed narrows the list as you type, to what has
// it in its name or title (shown in the list's place: see browseView), and
// another tag that matches (a genre, a style or a mood) is offered too, with
// how many it has.
function searchWithin({ kind, filters, title: name, sort, typed = '', onWords }) {
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
    value: typed,
  });
  const results = h('div.rows.within-results', { hidden: true });
  const clear = iconButton(
    'close',
    'Clear',
    () => {
      input.value = '';
      show('');
      input.focus();
    },
    { size: 22, cls: 'search-clear' },
  );
  clear.hidden = !typed;
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
    onWords(q ? raw : '');
    if (!q) {
      results.hidden = true;
      results.replaceChildren();
      return;
    }
    // Tags from the fields not used yet, best matches first.
    const fields = FIELDS[kind].filter(([f]) => !(f in base));
    if (!fields.length) {
      results.hidden = true;
      return;
    }
    const lists = await Promise.all(fields.map(([f]) => s.tags(sec, f, type).catch(() => [])));
    if (mine !== seq) return;
    const found = [];
    fields.forEach(([field, label, ic], i) => {
      for (const t of lists[i]) {
        const n = norm(t.title);
        const at = n.indexOf(q);
        if (at >= 0) found.push({ field, label, ic, tag: t, rank: (at === 0 ? 0 : 1) * 1000 + n.length });
      }
    });
    found.sort((a, b) => a.rank - b.rank);
    const options = found.slice(0, 6);
    const counts = await mapLimit(options, 5, (o) => s.count(sec, type, plexFilters({ ...base, [o.field]: o.tag.key })).catch(() => 0));
    if (mine !== seq) return;
    const rows = options
      .map((o, i) => ({ ...o, n: counts[i] }))
      .filter((o) => o.n > 0)
      .slice(0, 3)
      .map((o) =>
        row({
          onClick: () => pick(o.field, o.tag.key),
          lead: iconTile(o.ic),
          title: o.tag.title,
          subtitle: `${o.label} · ${fmt.count(o.n, ...unit)}`,
          chevron: true,
          cls: 'within-option',
        }),
      );
    results.replaceChildren(...rows);
    results.hidden = !rows.length;
  }

  const later = debounce(() => show(input.value), 250);
  input.addEventListener('input', () => {
    clear.hidden = !input.value;
    later();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      // (What matches is shown already: the keyboard goes.)
      e.preventDefault();
      show(input.value);
      input.blur();
    }
    if (e.key === 'Escape' && input.value) {
      e.preventDefault();
      e.stopPropagation();
      input.value = '';
      show('');
    }
  });
  // (What was typed before, back: once the page has its lists.)
  if (typed) queueMicrotask(() => show(typed));
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
        // (What's typed in the search box stays.)
        navigate(`${path}?${q}`, { replace: true, keep: true });
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
