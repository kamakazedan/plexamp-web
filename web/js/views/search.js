import { app } from '../state.js';
import { normTrack, store } from '../plex.js';
import { replaceQuery, navigate } from '../router.js';
import { h, art, icon, pageHeader, backHeader, sectionHeader, row, iconTile, iconButton, spinner, emptyState, sheet, debounce, fmt } from '../ui.js';
import { artistRow, albumRow, playlistRow, trackRow } from '../components.js';
import { playList, shuffleLibrary, sonicPath } from '../actions.js';
import { aiReady } from '../ai.js';

const RECENT_KEY = () => `recentSearches.${app.source?.serverId || 'default'}`;
const MAX_RECENT = 12;

function recentList() {
  return store.get(RECENT_KEY(), []);
}

function remember(item) {
  const entry = {
    id: String(item.ratingKey),
    type: item.type,
    title: item.title,
    sub: item.type === 'album' ? item.parentTitle : item.type === 'track' ? item.grandparentTitle : null,
    thumb: item.type === 'playlist' ? item.composite || item.thumb : item.type === 'track' ? item.parentThumb || item.thumb : item.thumb,
  };
  const list = recentList().filter((r) => !(r.id === entry.id && r.type === entry.type));
  store.set(RECENT_KEY(), [entry, ...list].slice(0, MAX_RECENT));
}

const hrefFor = (type, id) => ({ artist: `/artist/${id}`, album: `/album/${id}`, playlist: `/playlist/${id}` })[type];

function describe(r) {
  if (r.type === 'artist') return 'Artist';
  if (r.type === 'album') return r.sub ? `Album by ${r.sub}` : 'Album';
  if (r.type === 'playlist') return 'Playlist';
  if (r.type === 'track') return r.sub ? `Track by ${r.sub}` : 'Track';
  return '';
}

export async function searchView({ el, query }) {
  const input = h('input', {
    type: 'search',
    placeholder: 'Artists, albums, tracks',
    'aria-label': 'Search your library',
    autocomplete: 'off',
    enterkeyhint: 'search',
    value: query.q || '',
  });
  const box = h('label.search-box', null, icon('search', 22), input);
  const body = h('div.search-body');
  el.append(pageHeader('Search'), box, body);

  let controller = null;
  const run = async (q) => {
    controller?.abort();
    replaceQuery(q ? `/search?q=${encodeURIComponent(q)}` : '/search');
    if (!q.trim()) {
      body.replaceChildren(browseContent());
      return;
    }
    controller = new AbortController();
    const mine = controller;
    body.replaceChildren(spinner('Searching'));
    try {
      const res = await app.server.search(q.trim(), app.source.sectionKey, { signal: mine.signal, limit: 12 });
      if (mine.signal.aborted) return;
      body.replaceChildren(results(res, q));
    } catch (err) {
      if (!err.aborted) body.replaceChildren(emptyState("Search didn't work. Check your connection and try again."));
    }
  };
  input.addEventListener('input', debounce(() => run(input.value), 280));
  input.addEventListener('keydown', (e) => e.key === 'Enter' && input.blur());
  await run(input.value);
}

function results(res, q) {
  const frag = h('div');
  const add = (title, items, render) => {
    if (!items.length) return;
    frag.append(h('section.block', null, sectionHeader(title), h('div.rows', null, items.map(render))));
  };
  const wrap = (item, el) => {
    el.addEventListener('click', () => remember(item), { capture: true });
    return el;
  };
  add('Artists', res.artist.slice(0, 6), (m) => wrap(m, artistRow(m)));
  add('Albums', res.album.slice(0, 8), (m) => wrap(m, albumRow(m)));
  if (res.track.length) {
    const tracks = res.track.map(normTrack);
    const list = h('div.tracks');
    tracks.forEach((t, i) => {
      const r = trackRow(t, {
        showArt: true,
        subtitle: [t.artist, t.album].filter(Boolean).join(' — '),
        onPlay: () => {
          remember(res.track[i]);
          playList(tracks, i, { title: `Search: ${q}`, href: null });
        },
      });
      list.append(r);
    });
    frag.append(h('section.block', null, sectionHeader('Tracks'), list));
  }
  add('Playlists', res.playlist.slice(0, 6), (m) => wrap(m, playlistRow(m)));
  if (!frag.children.length) frag.append(emptyState(`Nothing in ${app.source.sectionTitle} matches “${q}”.`));
  return frag;
}

function browseContent() {
  const frag = h('div');
  frag.append(
    h(
      'section.block',
      null,
      sectionHeader('Most played'),
      h(
        'div.rows',
        null,
        row({ href: '/top/artists', lead: iconTile('mic'), title: 'Top artists' }),
        row({ href: '/top/albums', lead: iconTile('disc'), title: 'Top albums' }),
        row({ href: '/top/tracks', lead: iconTile('note'), title: 'Top tracks' }),
      ),
    ),
    h(
      'section.block',
      null,
      sectionHeader('Explore'),
      h(
        'div.rows',
        null,
        row({
          href: '/ai-playlist',
          lead: h('span.tile.tile-plain', null, icon('sparkle', 26)),
          title: 'AI playlist',
          subtitle: aiReady() ? 'Describe a playlist and your AI model builds it' : 'Describe a playlist; needs an AI model',
        }),
        row({ href: '/sonic-path', lead: h('span.tile.tile-plain', null, icon('path', 26)), title: 'Sonic path', subtitle: 'A smooth journey from one track to another' }),
        row({ onClick: () => shuffleLibrary(), lead: h('span.tile.tile-plain', null, icon('shuffle', 26)), title: 'Shuffle library', subtitle: `Random tracks from ${app.source.sectionTitle}`, chevron: true }),
      ),
    ),
  );

  const recent = recentList();
  if (recent.length) {
    const block = h('section.block');
    const list = h('div.rows');
    const renderRecent = () => {
      const items = recentList();
      if (!items.length) return block.remove();
      list.replaceChildren(
        ...items.map((r) => {
          const href = hrefFor(r.type, r.id);
          const remove = iconButton('close', `Remove ${r.title}`, (e) => {
            e.preventDefault();
            e.stopPropagation();
            store.set(RECENT_KEY(), recentList().filter((x) => !(x.id === r.id && x.type === r.type)));
            renderRecent();
          });
          return row({
            href: href || undefined,
            onClick: href ? undefined : () => navigate(`/search?q=${encodeURIComponent(r.title)}`),
            image: r.thumb,
            round: r.type === 'artist',
            title: r.title,
            subtitle: describe(r),
            right: remove,
            chevron: false,
          });
        }),
      );
    };
    const moreBtn = iconButton('more', 'Recent search options', () =>
      sheet({
        title: 'Recent searches',
        actions: [{ icon: 'close', label: 'Clear recent searches', onSelect: () => { store.set(RECENT_KEY(), []); block.remove(); } }],
      }),
      { size: 20, cls: 'head-more' },
    );
    block.append(sectionHeader('Recent searches', null, moreBtn), list);
    renderRecent();
    frag.append(block);
  }
  return frag;
}

// ---------- Top artists / albums / tracks ----------

const TOP = {
  artists: { type: 8, title: 'Top artists' },
  albums: { type: 9, title: 'Top albums' },
  tracks: { type: 10, title: 'Top tracks' },
};

export async function topView({ el, params }) {
  const cfg = TOP[params.kind];
  if (!cfg) throw new Error('Unknown list.');
  el.append(backHeader(cfg.title, { fallback: '/search' }));
  const { items } = await app.server.list(app.source.sectionKey, cfg.type, { sort: 'viewCount:desc', size: 100 });
  const played = items.filter((m) => m.viewCount);
  if (!played.length) {
    el.append(emptyState('Nothing played yet. Play counts build up as you listen.'));
    return;
  }
  if (cfg.type === 10) {
    const tracks = played.map(normTrack);
    const list = h('div.tracks');
    tracks.forEach((t, i) =>
      list.append(
        trackRow(t, {
          showArt: true,
          subtitle: t.artist,
          plays: played[i].viewCount,
          onPlay: () => playList(tracks, i, { title: 'Top tracks', href: '/top/tracks' }),
        }),
      ),
    );
    el.append(list);
    return;
  }
  const list = h('div.rows');
  played.forEach((m, i) =>
    list.append(
      row({
        href: cfg.type === 8 ? `/artist/${m.ratingKey}` : `/album/${m.ratingKey}`,
        lead: h('span.rank', null, String(i + 1)),
        image: undefined,
        title: m.title,
        subtitle: [cfg.type === 9 ? m.parentTitle : null, fmt.count(m.viewCount, 'play', 'plays')].filter(Boolean).join(', '),
        right: art(m.thumb, { size: 56, round: cfg.type === 8, fallback: cfg.type === 8 ? 'mic' : 'disc' }),
        chevron: false,
        cls: 'row-ranked',
      }),
    ),
  );
  el.append(list);
}

// ---------- Sonic path ----------

export async function sonicPathView({ el }) {
  el.append(
    backHeader('Sonic path', { fallback: '/search' }),
    h('p.lede', null, 'Pick a starting track and a destination. Plex fills the gap with tracks that move gradually from one sound to the other.'),
  );
  const chosen = { from: null, to: null };
  const go = h('button.btn.btn-primary', { type: 'button', disabled: true, onclick: () => sonicPath(chosen.from, chosen.to) }, icon('play', 20), h('span', null, 'Play path'));
  const update = () => (go.disabled = !(chosen.from && chosen.to));
  el.append(
    trackPicker('From', (t) => ((chosen.from = t), update())),
    trackPicker('To', (t) => ((chosen.to = t), update())),
    h('div.pad.path-go', null, go),
  );
}

function trackPicker(label, onChange) {
  const input = h('input', { type: 'search', placeholder: 'Search for a track', autocomplete: 'off', 'aria-label': `${label} track` });
  const results = h('div.picker-results');
  const selected = h('div.picker-selected');
  const wrap = h('section.picker', null, h('div.picker-label', null, label), selected, h('label.search-box', null, icon('search', 20), input), results);
  let controller;
  const choose = (t) => {
    onChange(t);
    results.replaceChildren();
    input.value = '';
    input.closest('.search-box').hidden = true;
    selected.replaceChildren(
      row({
        image: t.thumb,
        title: t.title,
        subtitle: t.artist,
        right: iconButton('close', `Change ${label.toLowerCase()} track`, () => {
          onChange(null);
          selected.replaceChildren();
          input.closest('.search-box').hidden = false;
          input.focus();
        }),
        chevron: false,
      }),
    );
  };
  input.addEventListener(
    'input',
    debounce(async () => {
      controller?.abort();
      const q = input.value.trim();
      if (!q) return results.replaceChildren();
      controller = new AbortController();
      const mine = controller;
      try {
        const res = await app.server.search(q, app.source.sectionKey, { signal: mine.signal, limit: 8 });
        if (mine.signal.aborted) return;
        const tracks = res.track.map(normTrack);
        results.replaceChildren(
          ...(tracks.length
            ? tracks.map((t) => row({ onClick: () => choose(t), image: t.thumb, title: t.title, subtitle: t.artist, chevron: false }))
            : [h('p.picker-empty', null, 'No tracks match.')]),
        );
      } catch (err) {
        if (!err.aborted) results.replaceChildren(h('p.picker-empty', null, "Search didn't work."));
      }
    }, 280),
  );
  return wrap;
}
