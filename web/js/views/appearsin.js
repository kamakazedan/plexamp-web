// "Appears in", from a track's menu: the albums the song is on, and the
// playlists and collections it's in. Each row opens the album, playlist or
// collection.
import { app } from '../state.js';
import { normTrack } from '../plex.js';
import { describeError } from '../router.js';
import { h, art, icon, backHeader, row, sectionHeader, emptyState, spinner, fmt } from '../ui.js';
import { playlistArt } from '../components.js';
import { appearsIn, albumsWith } from '../membership.js';
import { addToPlaylist, addToCollection, isAdminNow } from '../editing.js';

const COLLECTION_KINDS = { track: 'Track collection', album: 'Album collection', artist: 'Artist collection' };
const byTitle = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
const LOOKING = 'Looking through your playlists and collections…';

export async function appearsInView({ el, params, onDispose }) {
  const s = app.server;
  if (!/^\d+$/.test(String(params.id))) throw Object.assign(new Error('Not found'), { status: 404 });
  const meta = await s.trackDetail(params.id);
  if (!meta || meta.type !== 'track') throw Object.assign(new Error('Not found'), { status: 404 });
  const t = normTrack(meta);
  const ctrl = new AbortController();
  onDispose?.(() => ctrl.abort());
  const library = meta.librarySectionTitle || app.source?.sectionTitle || 'your library';

  const progress = h('span', null, LOOKING);
  const status = h('div.appears-status', { role: 'status' }, spinner('Looking'), progress);
  const albumRows = h('div.rows.appears-albums');
  const plRows = h('div.rows.appears-playlists');
  const colRows = h('div.rows.appears-collections');
  const albumBlock = h('section.block', { hidden: true }, sectionHeader('Albums'), albumRows);
  const plBlock = h('section.block', { hidden: true }, sectionHeader('Playlists'), plRows);
  const colBlock = h('section.block', { hidden: true }, sectionHeader('Collections'), colRows);
  const empty = h('div', { hidden: true });
  const note = h('p.hint.pad.appears-note', { hidden: true });
  const foot = h(
    'div.pad.button-row.appears-actions',
    null,
    h(
      'button.btn.btn-secondary',
      { type: 'button', onclick: () => addToPlaylist({ what: t.title, load: async () => [t] }) },
      icon('playlistAdd', 20),
      h('span', null, 'Add to a playlist…'),
    ),
    isAdminNow()
      ? h(
          'button.btn.btn-secondary',
          { type: 'button', onclick: () => addToCollection({ kind: 'track', what: t.title, load: async () => [t] }) },
          icon('collection', 20),
          h('span', null, 'Add to a collection…'),
        )
      : null,
  );

  el.append(
    backHeader('Appears in'),
    h(
      'div.appears-track',
      null,
      art(t.thumb, { size: 64, fallback: 'note' }),
      h('div.appears-track-text', null, h('div.appears-track-title', null, t.title), h('div.appears-track-sub', null, [t.artist, t.album].filter(Boolean).join(' — '))),
    ),
    status,
    albumBlock,
    plBlock,
    colBlock,
    empty,
    note,
    foot,
  );

  // Rows go in by name, as they're found.
  function insert(list, rowEl, title) {
    rowEl.dataset.sortTitle = title;
    const after = [...list.children].find((r) => byTitle.compare(r.dataset.sortTitle || '', title) > 0);
    list.insertBefore(rowEl, after || null);
  }

  const sameName = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();

  // An album with the song: who it's by and when, which one this track is
  // from, and the song's name there when it's another version ("Radio Edit").
  function albumRow(a) {
    const parts = [a.artist, a.year || ''];
    if (a.current) parts.push('this track');
    const others = a.versions.filter((v) => !v.current && !sameName(v.title, t.title));
    if (others.length) parts.push(others.map((v) => `“${v.title}”${v.duration ? ` (${fmt.clock(v.duration / 1000)})` : ''}`).join(', '));
    return row({ href: `/album/${a.id}`, image: a.thumb, fallback: 'disc', title: a.title, subtitle: parts.filter(Boolean).join(' · '), cls: 'appears-row appears-album' });
  }

  function playlistRow({ list: pl, times, every }) {
    const what = [pl.smart ? 'Smart playlist' : 'Playlist', fmt.count(pl.leafCount || 0, 'track', 'tracks')];
    if (every) what.push(`every track in ${library}`);
    else if (times > 1) what.push(`in it ${times} times`);
    return row({ href: `/playlist/${pl.ratingKey}`, image: playlistArt(pl), fallback: 'list', title: pl.title, subtitle: what.join(' · '), cls: 'appears-row' });
  }

  function collectionRow({ list: c, via }) {
    const kind = COLLECTION_KINDS[via] || 'Collection';
    const what = via === 'album' ? `${kind}, with “${t.album}”` : via === 'artist' ? `${kind}, with ${t.albumArtist || t.artist}` : kind;
    return row({ href: `/collection/${c.ratingKey}`, image: c.thumb || c.composite, fallback: 'list', title: c.title, subtitle: what, cls: 'appears-row' });
  }

  // Lists too long to read (other than a smart playlist of everything).
  function skippedNote(lists) {
    const describe = (l) => [l.smart ? 'smart playlist' : 'playlist', fmt.count(Number(l.leafCount ?? l.childCount) || 0, 'track', 'tracks')];
    if (lists.length === 1) {
      const [kind, size] = describe(lists[0]);
      return `${lists[0].title}, a ${kind} of ${size}, is too long to look through, so it isn’t included.`;
    }
    return `Too long to look through, so not included: ${lists.map((l) => `${l.title} (${describe(l).join(', ')})`).join('; ')}.`;
  }

  // The albums come back quickly, while the lists are read.
  const albums = albumsWith(meta, { signal: ctrl.signal }).then(
    (list) => {
      if (ctrl.signal.aborted) return [];
      albumRows.replaceChildren(...list.map(albumRow));
      albumBlock.hidden = !list.length;
      return list;
    },
    () => [],
  );

  try {
    const res = await appearsIn(t, {
      signal: ctrl.signal,
      onProgress: (done, total) => {
        progress.textContent = total ? `${LOOKING} ${done} of ${total}` : LOOKING;
      },
      onFound: (kind, entry) => {
        if (kind === 'playlist') {
          insert(plRows, playlistRow(entry), entry.list.title);
          plBlock.hidden = false;
        } else {
          insert(colRows, collectionRow(entry), entry.list.title);
          colBlock.hidden = false;
        }
      },
    });
    const onAlbums = (await albums).length;
    if (ctrl.signal.aborted) return;
    const found = res.playlists.length + res.collections.length;
    const said = [
      onAlbums && `On ${fmt.count(onAlbums, 'album', 'albums')}`,
      found &&
        `${onAlbums ? 'in' : 'In'} ${[res.playlists.length && fmt.count(res.playlists.length, 'playlist', 'playlists'), res.collections.length && fmt.count(res.collections.length, 'collection', 'collections')].filter(Boolean).join(' and ')}`,
    ].filter(Boolean);
    status.replaceChildren(said.length ? `${said.join(', ')}.` : '');
    status.hidden = !said.length;
    if (!found) {
      empty.replaceChildren(emptyState('It isn’t in any of your playlists, or in a collection.'));
      empty.hidden = false;
    }
    if (res.skipped.length) {
      note.textContent = skippedNote(res.skipped);
      note.hidden = false;
    }
  } catch (err) {
    if (ctrl.signal.aborted) return;
    status.replaceChildren(describeError(err));
    status.classList.add('warn');
  }
}
