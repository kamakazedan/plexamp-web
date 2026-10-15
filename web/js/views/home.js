import { app } from '../state.js';
import { h, pageHeader, backHeader, sectionHeader, shelf, grid, wideCard, skeletonShelf, emptyState, fmt } from '../ui.js';
import { albumCard, playlistCard } from '../components.js';
import { openSourceSheet } from './settings.js';

const lastPlayed = (m) => m.lastViewedAt || 0;

export async function homeView({ el }) {
  const s = app.server;
  const src = app.source;
  el.append(pageHeader(src.sectionTitle, { subtitle: `on ${src.serverName}`, onSubtitle: openSourceSheet }));

  const playlistsBlock = h('section.block', null, sectionHeader('Recent playlists', '/library/playlists'), skeletonShelf(4));
  const recentBlock = h('section.block', null, sectionHeader('Recent plays', '/recent'), skeletonShelf(2, true));
  const addedBlock = h(
    'section.block',
    null,
    sectionHeader(`Recently added in ${src.sectionTitle}`, `/browse/albums?sort=addedAt:desc&title=${encodeURIComponent('Recently added')}`),
    skeletonShelf(4),
  );
  el.append(playlistsBlock, recentBlock, addedBlock);

  const playlistsP = s.playlists();
  const recentAlbumsP = s.list(src.sectionKey, 9, { sort: 'lastViewedAt:desc', size: 24 }).then((r) => r.items.filter(lastPlayed));
  const addedP = s.list(src.sectionKey, 9, { sort: 'addedAt:desc', size: 24 }).then((r) => r.items);

  const fill = (block, content) => {
    const old = block.querySelector('.shelf, .empty-inline');
    if (content) old.replaceWith(content);
    else block.remove();
  };

  const results = await Promise.allSettled([
    playlistsP.then((pls) => {
      const recent = pls.slice().sort((a, b) => (lastPlayed(b) || b.updatedAt || 0) - (lastPlayed(a) || a.updatedAt || 0)).slice(0, 12);
      fill(playlistsBlock, recent.length ? shelf(recent.map((m) => playlistCard(m))) : null);
    }),
    Promise.all([recentAlbumsP, playlistsP.catch(() => [])]).then(([albums, pls]) => {
      const items = [...albums, ...pls.filter(lastPlayed)].sort((a, b) => lastPlayed(b) - lastPlayed(a)).slice(0, 12);
      fill(
        recentBlock,
        items.length
          ? shelf(
              items.map((m) =>
                m.type === 'playlist'
                  ? wideCard({ href: `/playlist/${m.ratingKey}`, image: m.composite || m.thumb, title: m.title, subtitle: fmt.ago(m.lastViewedAt), fallback: 'list' })
                  : wideCard({ href: `/album/${m.ratingKey}`, image: m.thumb, title: m.title, subtitle: fmt.ago(m.lastViewedAt) }),
              ),
            )
          : null,
      );
    }),
    addedP.then((albums) => fill(addedBlock, albums.length ? shelf(albums.map((m) => albumCard(m))) : null)),
  ]);

  const failed = results.filter((r) => r.status === 'rejected');
  if (failed.length === results.length) throw failed[0].reason;
  if (!el.querySelector('.block')) {
    el.append(
      emptyState(
        'Nothing to show yet. Browse your library and start playing, and your recent music will appear here.',
        h('a.btn.btn-secondary', { href: '#/library' }, 'Browse library'),
      ),
    );
  }
}

// Full list behind the "Recent plays" heading.
export async function recentView({ el }) {
  const s = app.server;
  el.append(backHeader('Recent plays'));
  const [albums, pls] = await Promise.all([
    s.list(app.source.sectionKey, 9, { sort: 'lastViewedAt:desc', size: 60 }).then((r) => r.items.filter(lastPlayed)),
    s.playlists().catch(() => []),
  ]);
  const items = [...albums, ...pls.filter(lastPlayed)].sort((a, b) => lastPlayed(b) - lastPlayed(a));
  if (!items.length) {
    el.append(emptyState('Nothing played yet.'));
    return;
  }
  el.append(grid(items.map((m) => (m.type === 'playlist' ? playlistCard(m) : albumCard(m, { subtitle: fmt.ago(m.lastViewedAt) }))), { centered: true }));
}
