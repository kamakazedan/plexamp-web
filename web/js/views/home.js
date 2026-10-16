import { app, playlistScope } from '../state.js';
import { normTrack } from '../plex.js';
import { h, icon, card, pageHeader, backHeader, sectionHeader, shelf, grid, wideCard, skeletonShelf, emptyState, fmt } from '../ui.js';
import { albumCard, playlistCard, collectionCard, trackRow, playlistArt } from '../components.js';
import { artistRadio, playArtist, playList, shuffleLibrary, deepCutsRadio, timeTravelRadio, randomAlbum } from '../actions.js';
import { openSourceSheet } from './settings.js';
import { live } from '../live.js';
import { homeLayout, sectionById, PERIODS, GAPS } from '../home-sections.js';

const lastPlayed = (m) => m.lastViewedAt || 0;
const recency = (m) => lastPlayed(m) || m.updatedAt || m.addedAt || 0;
const q = (params) => new URLSearchParams(params).toString();

// Data more than one section uses, fetched once per visit.
function shared(s, sec) {
  const cache = new Map();
  const once = (key, fn) => {
    if (!cache.has(key)) cache.set(key, fn());
    return cache.get(key);
  };
  return {
    playlists: () => once('playlists', () => s.playlists(playlistScope()).catch(() => [])),
    recentAlbums: () => once('recentAlbums', () => s.list(sec, 9, { sort: 'lastViewedAt:desc', size: 24 }).then((r) => r.items.filter(lastPlayed))),
  };
}

export async function homeView({ el }) {
  const s = app.server;
  const src = app.source;
  const sec = src.sectionKey;
  el.append(
    pageHeader(src.sectionTitle, { subtitle: `on ${src.serverName}`, onSubtitle: openSourceSheet }),
    h('div.scan-status', { role: 'status' }, h('span.scan-dot'), h('span.scan-text', null, live.scanning?.title || '')),
  );

  const layout = homeLayout();
  const data = shared(s, sec);
  const blocks = layout.order
    .filter((id) => !layout.hidden.has(id))
    .map((id) => SECTION_VIEWS[id] && block(id, SECTION_VIEWS[id], { s, sec, src, data, options: layout.options[id] || {} }))
    .filter(Boolean);
  el.append(...blocks.map((b) => b.el));

  const results = await Promise.allSettled(blocks.map((b) => b.load()));
  const failed = results.filter((r) => r.status === 'rejected');
  if (blocks.length && failed.length === results.length) throw failed[0].reason;
  if (!el.querySelector('.block')) {
    el.append(
      emptyState(
        blocks.length
          ? 'Nothing to show yet. Browse your library and start playing, and your recent music will appear here.'
          : 'Every Home section is turned off for this library. Choose what to show in Settings › Experience › Home screen.',
        h('a.btn.btn-secondary', { href: blocks.length ? '#/search' : '#/settings/home' }, blocks.length ? 'Browse library' : 'Choose sections'),
      ),
    );
  }
}

// A section on screen: a heading and a placeholder until its content loads
// (or it removes itself when there's nothing to show).
function block(id, view, ctx) {
  const el = h('section.block', { dataset: { section: id } }, sectionHeader(view.title?.(ctx) || sectionById(id).title), skeletonShelf(4, view.wide));
  const load = async () => {
    let result;
    try {
      result = await view.load(ctx);
    } catch (err) {
      el.remove();
      throw err;
    }
    if (!result || !result.content) return el.remove();
    el.replaceChildren(sectionHeader(result.title || view.title?.(ctx) || sectionById(id).title, result.href || null), result.content);
  };
  return { el, load };
}

function trackCard(t, onPlay) {
  return card({ href: t.albumId ? `/album/${t.albumId}` : '/', image: t.thumb, title: t.title, subtitle: t.artist, fallback: 'note', onPlay });
}

const decadeName = (y) => `${String(y).slice(2)}s`;

const SECTION_VIEWS = {
  mixes: {
    async load({ s, sec }) {
      const { items } = await s.list(sec, 8, { sort: 'lastViewedAt:desc', size: 12 });
      const artists = items.filter((m) => lastPlayed(m) && m.title !== 'Various Artists').slice(0, 10);
      if (!artists.length) return null;
      const cards = artists.map((m) => {
        const c = card({
          href: `/artist/${m.ratingKey}`,
          image: m.thumb,
          title: `${m.title} mix`,
          subtitle: 'Artist radio',
          fallback: 'mic',
          onPlay: () => artistRadio(m),
          onShuffle: () => playArtist(m, { shuffle: true }),
        });
        c.classList.add('mix-card');
        return c;
      });
      return { content: shelf(cards) };
    },
  },

  recentPlays: {
    wide: true,
    async load({ data }) {
      const [albums, pls] = await Promise.all([data.recentAlbums(), data.playlists()]);
      const items = [...albums, ...pls.filter(lastPlayed)].sort((a, b) => lastPlayed(b) - lastPlayed(a)).slice(0, 12);
      if (!items.length) return null;
      return {
        href: '/recent',
        content: shelf(
          items.map((m) =>
            m.type === 'playlist'
              ? wideCard({ href: `/playlist/${m.ratingKey}`, image: playlistArt(m), title: m.title, subtitle: fmt.ago(m.lastViewedAt), fallback: 'list' })
              : wideCard({ href: `/album/${m.ratingKey}`, image: m.thumb, title: m.title, subtitle: fmt.ago(m.lastViewedAt) }),
          ),
        ),
      };
    },
  },

  recentPlaylists: {
    async load({ data }) {
      const recent = (await data.playlists()).slice().sort((a, b) => recency(b) - recency(a)).slice(0, 12);
      if (!recent.length) return null;
      return { href: '/playlists', content: shelf(recent.map((m) => playlistCard(m))) };
    },
  },

  // Collections, laid out just like Recent playlists.
  collections: {
    async load({ s, sec }) {
      const all = await s.collections(sec);
      const recent = all.slice().sort((a, b) => recency(b) - recency(a)).slice(0, 12);
      if (!recent.length) return null;
      return { href: `/browse/collections?${q({ title: 'Collections' })}`, content: shelf(recent.map((m) => collectionCard(m))) };
    },
  },

  moreInGenre: {
    async load({ s, sec, data }) {
      const albums = await data.recentAlbums();
      const name = albums.map((m) => m.Genre?.[0]?.tag).find(Boolean);
      if (!name) return null;
      const tag = (await s.tags(sec, 'genre', 9)).find((t) => String(t.title).toLowerCase() === name.toLowerCase());
      if (!tag) return null;
      const { items } = await s.list(sec, 9, { sort: 'random', size: 20, filters: { genre: tag.key } });
      if (items.length < 2) return null;
      return { title: `More in ${tag.title}`, href: `/browse/albums?${q({ genre: tag.key, title: tag.title })}`, content: shelf(items.map((m) => albumCard(m))) };
    },
  },

  recentlyAdded: {
    title: ({ src }) => `Recently added in ${src.sectionTitle}`,
    async load({ s, sec }) {
      const { items } = await s.list(sec, 9, { sort: 'addedAt:desc', size: 24 });
      if (!items.length) return null;
      return { href: `/browse/albums?${q({ sort: 'addedAt:desc', title: 'Recently added' })}`, content: shelf(items.map((m) => albumCard(m))) };
    },
  },

  topAlbums: {
    title: ({ options }) => `Top albums from ${(PERIODS[options.period] || PERIODS.month).label}`,
    async load({ s, sec, options }) {
      const p = PERIODS[options.period] || PERIODS.month;
      const { items } = await s.list(sec, 9, { sort: 'viewCount:desc', size: 20, filters: p.filter ? { 'lastViewedAt>>': p.filter } : {} });
      const played = items.filter((m) => m.viewCount);
      if (!played.length) return null;
      return { content: shelf(played.map((m) => albumCard(m))) };
    },
  },

  // Radio from the whole library, like Plexamp's stations.
  stations: {
    wide: true,
    async load({ src }) {
      const tile = (name, title, subtitle, onClick) =>
        h(
          'button.wide-card.station',
          { type: 'button', onclick: onClick, 'aria-label': `Play ${title}` },
          h('span.station-icon', null, icon(name, 30)),
          h('div.wide-text', null, h('div.wide-title', null, title), h('div.wide-sub', null, subtitle)),
        );
      return {
        content: shelf([
          tile('radio', 'Library radio', `Anything from ${src.sectionTitle}`, () => shuffleLibrary()),
          tile('disc', 'Deep cuts radio', 'What you’ve played least', () => deepCutsRadio()),
          tile('refresh', 'Time travel radio', 'A random decade', () => timeTravelRadio()),
          tile('shuffle', 'Random album', 'Start to finish', () => randomAlbum()),
        ]),
      };
    },
  },

  mostPlayed: {
    title: ({ options }) => `Most played in ${(PERIODS[options.period] || PERIODS.month).label}`,
    async load({ s, sec, options }) {
      const p = PERIODS[options.period] || PERIODS.month;
      const { items } = await s.list(sec, 10, { sort: 'viewCount:desc', size: 20, filters: p.filter ? { 'lastViewedAt>>': p.filter } : {} });
      const tracks = items.filter((m) => m.viewCount).map(normTrack);
      if (!tracks.length) return null;
      const context = { title: `Most played in ${p.label}`, href: null };
      return { content: shelf(tracks.map((t, i) => trackCard(t, () => playList(tracks, i, context)))) };
    },
  },

  moreFromLabel: {
    async load({ s, sec, data }) {
      const albums = await data.recentAlbums();
      const label = albums.map((m) => m.studio).find(Boolean);
      if (!label) return null;
      const { items } = await s.list(sec, 9, { sort: 'random', size: 24, filters: { studio: label } });
      // Only albums that really are on the label, in case the server
      // doesn't filter by it.
      const same = items.filter((m) => m.studio === label);
      if (same.length < 2) return null;
      return { title: `More from ${label}`, content: shelf(same.map((m) => albumCard(m))) };
    },
  },

  history: {
    wide: true,
    async load({ s, sec }) {
      const { items } = await s.list(sec, 10, { sort: 'lastViewedAt:desc', size: 30 });
      const played = items.filter(lastPlayed);
      if (!played.length) return null;
      const tracks = played.map(normTrack);
      const list = h('div.tracks.home-history');
      tracks.slice(0, 6).forEach((t, i) =>
        list.append(
          trackRow(t, {
            showArt: true,
            rating: false,
            subtitle: [t.artist, fmt.ago(played[i].lastViewedAt)].filter(Boolean).join(' · '),
            onPlay: () => playList(tracks, i, { title: 'History', href: null }),
          }),
        ),
      );
      return { href: `/browse/tracks?${q({ sort: 'lastViewedAt:desc', title: 'History' })}`, content: list };
    },
  },

  notPlayed: {
    title: ({ options }) => `Haven’t played in ${(GAPS[options.period] || GAPS.half).label}`,
    async load({ s, sec, options }) {
      const p = GAPS[options.period] || GAPS.half;
      const { items } = await s.list(sec, 9, { sort: 'random', size: 20, filters: { 'lastViewedAt<<': p.filter } });
      const cutoff = Date.now() / 1000 - Number(p.filter.replace(/\D/g, '')) * 86400;
      const old = items.filter((m) => lastPlayed(m) && lastPlayed(m) < cutoff);
      if (!old.length) return null;
      return { content: shelf(old.map((m) => albumCard(m))) };
    },
  },
};

for (const y of [1970, 1980, 1990, 2000, 2010, 2020]) {
  SECTION_VIEWS[`decade${y}`] = {
    async load({ s, sec }) {
      const { items } = await s.list(sec, 9, { sort: 'viewCount:desc', size: 20, filters: { decade: y } });
      if (!items.length) return null;
      const title = `Best of the ${decadeName(y)}`;
      return { href: `/browse/albums?${q({ decade: y, sort: 'viewCount:desc', title })}`, content: shelf(items.map((m) => albumCard(m))) };
    },
  };
}

// Full list behind the "Recent plays" heading.
export async function recentView({ el }) {
  const s = app.server;
  el.append(backHeader('Recent plays'));
  const [albums, pls] = await Promise.all([
    s.list(app.source.sectionKey, 9, { sort: 'lastViewedAt:desc', size: 60 }).then((r) => r.items.filter(lastPlayed)),
    s.playlists(playlistScope()).catch(() => []),
  ]);
  const items = [...albums, ...pls.filter(lastPlayed)].sort((a, b) => lastPlayed(b) - lastPlayed(a));
  if (!items.length) {
    el.append(emptyState('Nothing played yet.'));
    return;
  }
  el.append(grid(items.map((m) => (m.type === 'playlist' ? playlistCard(m) : albumCard(m, { subtitle: fmt.ago(m.lastViewedAt) }))), { centered: true }));
}
