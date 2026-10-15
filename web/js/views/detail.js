import { app } from '../state.js';
import { normTrack } from '../plex.js';
import {
  h,
  art,
  icon,
  backHeader,
  collapseWhenHidden,
  sectionHeader,
  shelf,
  grid,
  iconButton,
  clampText,
  pagedList,
  emptyState,
  fmt,
} from '../ui.js';
import { albumCard, artistCard, trackRow, collectionCard } from '../components.js';
import { playAlbum, playArtist, playPlaylist, artistRadio, albumMenu, playlistMenu, playList } from '../actions.js';

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

// ---------- Album ----------

export async function albumView({ el, params }) {
  const s = app.server;
  const [album, children] = await Promise.all([s.metadata(params.id), s.children(params.id)]);
  if (!album) throw Object.assign(new Error('Not found'), { status: 404 });
  const tracks = children.filter((m) => m.type === 'track').map(normTrack);

  const head = backHeader(album.title, { collapse: true, actions: iconButton('more', 'More options', () => albumMenu(album)) });
  const title = h('h1.hero-title', null, album.title);
  const genre = (album.Genre || [])[0]?.tag;
  const codecs = [...new Set(tracks.map((t) => t.codec).filter(Boolean))];
  const meta = [year(album), genre, codecs.length === 1 ? fmt.codec(codecs[0]) : null].filter(Boolean).join(', ');

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
        meta ? h('div.hero-meta', null, meta) : null,
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

  if (album.parentRatingKey) {
    s.children(album.parentRatingKey)
      .then((others) => {
        const more = others.filter((m) => String(m.ratingKey) !== String(album.ratingKey));
        if (!more.length) return;
        el.append(
          h(
            'section.block',
            null,
            sectionHeader(`More by ${album.parentTitle}`, `/artist/${album.parentRatingKey}`),
            shelf(more.map((m) => albumCard(m, { subtitle: year(m) || '' }))),
          ),
        );
      })
      .catch(() => {});
  }
}

// ---------- Artist ----------

const GROUP_ORDER = ['Albums', 'Singles & EPs', 'Live albums', 'Compilations', 'Soundtracks', 'Remixes'];

function albumGroup(m) {
  const tag = (v) => (Array.isArray(v) ? v[0]?.tag : v) || '';
  const sub = String(tag(m.Subformat) || tag(m.subformat)).toLowerCase();
  const format = String(tag(m.Format) || tag(m.format)).toLowerCase();
  if (sub.includes('compilation')) return 'Compilations';
  if (sub.includes('live')) return 'Live albums';
  if (sub.includes('soundtrack')) return 'Soundtracks';
  if (sub.includes('remix')) return 'Remixes';
  if (format === 'ep' || format === 'single') return 'Singles & EPs';
  return 'Albums';
}

export async function artistView({ el, params }) {
  const s = app.server;
  const sec = app.source.sectionKey;
  const artist = await s.metadata(params.id);
  if (!artist) throw Object.assign(new Error('Not found'), { status: 404 });

  const head = backHeader(artist.title, { collapse: true });
  const title = h('h1.hero-title', null, artist.title);
  el.append(
    head,
    h(
      'section.hero.hero-artist',
      null,
      h('div.artist-photo', null, art(artist.thumb || artist.art, { size: 640, fallback: 'mic' })),
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
  const albumsSlot = h('div');
  const similarSlot = h('div');
  el.append(popularSlot, albumsSlot, similarSlot);
  if (artist.summary) el.append(h('section.block.about', null, sectionHeader('About'), h('div.pad', null, clampText(artist.summary, 4))));

  const popularP = s.popularTracks(sec, artist.ratingKey, 20).then((items) => {
    const tracks = items.map(normTrack);
    if (!tracks.length) return;
    const list = h('div.tracks');
    const context = { title: `${artist.title}: popular`, href: `/artist/${artist.ratingKey}` };
    tracks.forEach((t, i) => {
      const r = trackRow(t, { showArt: true, subtitle: t.album, onPlay: () => playList(tracks, i, context) });
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

  const albumsP = s.children(artist.ratingKey).then((albums) => {
    const sorted = albums.slice().sort((a, b) => (year(b) || 0) - (year(a) || 0));
    const groups = new Map();
    for (const m of sorted) {
      const g = albumGroup(m);
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(m);
    }
    const blocks = GROUP_ORDER.filter((g) => groups.has(g)).map((g) =>
      h('section.block', null, sectionHeader(g), grid(groups.get(g).map((m) => albumCard(m, { subtitle: year(m) || '' })), { centered: true })),
    );
    albumsSlot.replaceWith(...(blocks.length ? blocks : [emptyState('No albums for this artist.')]));
  });

  const similarP = s
    .nearest(artist.ratingKey, { limit: 20 })
    .then((items) => {
      const artists = items.filter((m) => m.type === 'artist');
      if (artists.length) similarSlot.replaceWith(h('section.block', null, sectionHeader('Sonically similar'), shelf(artists.map(artistCard))));
    })
    .catch(() => {});

  await Promise.allSettled([popularP, albumsP, similarP]);
}

// ---------- Playlist ----------

export async function playlistView({ el, params }) {
  const s = app.server;
  const pl = await s.playlist(params.id);
  if (!pl) throw Object.assign(new Error('Not found'), { status: 404 });
  const head = backHeader(pl.title, { collapse: true, fallback: '/library/playlists', actions: iconButton('more', 'More options', () => playlistMenu(pl)) });
  const title = h('h1.hero-title', null, pl.title);
  el.append(
    head,
    h(
      'section.hero.hero-album',
      null,
      art(pl.composite || pl.thumb, { size: 480, cls: 'hero-art', fallback: 'list' }),
      h(
        'div.hero-info',
        null,
        title,
        h('div.hero-meta', null, [fmt.count(pl.leafCount || 0, 'track', 'tracks'), fmt.long(pl.duration)].filter(Boolean).join(', ')),
        pl.smart ? h('div.hero-meta', null, 'Smart playlist') : null,
        actionButtons([
          { icon: 'play', label: 'Play', primary: true, onClick: () => playPlaylist(pl) },
          { icon: 'shuffle', label: 'Shuffle', onClick: () => playPlaylist(pl, { shuffle: true }) },
        ]),
      ),
    ),
  );
  collapseWhenHidden(head, title);
  if (pl.summary) el.append(h('div.pad.hero-summary', null, clampText(pl.summary, 3)));

  const list = h('div.tracks');
  el.append(list);
  pagedList(list, {
    pageSize: 100,
    fetchPage: (start, size) => s.playlistItems(pl.ratingKey, { start, size }),
    render: (m, i) => {
      const t = normTrack(m);
      return trackRow(t, { showArt: true, onPlay: () => playPlaylist(pl, { start: i }) });
    },
    empty: 'This playlist is empty.',
  });
}

// ---------- Collection ----------

export async function collectionView({ el, params }) {
  const { meta, items } = await app.server.collection(params.id);
  if (!meta) throw Object.assign(new Error('Not found'), { status: 404 });
  const head = backHeader(meta.title, { collapse: true });
  const title = h('h1.hero-title', null, meta.title);
  el.append(
    head,
    h(
      'section.hero.hero-album',
      null,
      art(meta.thumb || meta.composite, { size: 480, cls: 'hero-art', fallback: 'list' }),
      h('div.hero-info', null, title, h('div.hero-meta', null, fmt.count(items.length, 'item', 'items'))),
    ),
  );
  collapseWhenHidden(head, title);
  const tracks = items.filter((m) => m.type === 'track').map(normTrack);
  if (tracks.length) {
    const list = h('div.tracks');
    tracks.forEach((t, i) => list.append(trackRow(t, { showArt: true, onPlay: () => playList(tracks, i, { title: meta.title, href: `/collection/${params.id}` }) })));
    el.append(list);
  }
  const others = items.filter((m) => m.type !== 'track');
  if (others.length) {
    el.append(
      grid(
        others.map((m) => (m.type === 'artist' ? artistCard(m) : m.type === 'collection' ? collectionCard(m) : albumCard(m))),
        { centered: true },
      ),
    );
  }
  if (!items.length) el.append(emptyState('This collection is empty.'));
}
