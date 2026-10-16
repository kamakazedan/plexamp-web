import { app } from '../state.js';
import { normTrack } from '../plex.js';
import { back, dropCached, describeError, refresh } from '../router.js';
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
} from '../ui.js';
import { albumCard, artistCard, trackRow, collectionCard } from '../components.js';
import {
  playAlbum,
  playArtist,
  playPlaylist,
  playCollection,
  artistRadio,
  albumMenu,
  artistMenu,
  playlistMenu,
  collectionMenu,
  playList,
  trackMenu,
} from '../actions.js';
import { isAdmin } from '../editing.js';

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
const kHz = (hz) => (hz / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 });

// The album's best-known tracks (Plex's play counts from Last.fm), for the
// "popular" badge: up to three, and only clear favourites.
function popularIds(tracks) {
  if (app.settings.popularTracks === false || tracks.length < 4) return new Set();
  const counted = tracks.filter((t) => t.ratingCount > 0).sort((a, b) => b.ratingCount - a.ratingCount);
  if (counted.length < 2) return new Set();
  const top = counted[0].ratingCount;
  return new Set(counted.slice(0, 3).filter((t) => t.ratingCount >= top * 0.3).map((t) => t.id));
}

// "FLAC 24/96" style badge; bit depth and sample rate come from a track's
// stream details.
function codecBadge(tracks) {
  if (app.settings.codecBadges === false) return null;
  const codecs = [...new Set(tracks.map((t) => t.codec).filter(Boolean))];
  if (!codecs.length) return null;
  const badge = h('span.codec-badge', null, codecs.length === 1 ? fmt.codec(codecs[0]) : 'Mixed formats');
  if (codecs.length === 1) {
    app.server
      .trackDetail(tracks[0].id)
      .then((d) => {
        const a = (d?.Media?.[0]?.Part?.[0]?.Stream || []).find((x) => x.streamType === 2);
        if (!a?.bitDepth || !a.samplingRate) return;
        badge.textContent = `${fmt.codec(codecs[0])} ${a.bitDepth}/${kHz(a.samplingRate)}`;
        if (a.bitDepth > 16 || a.samplingRate > 48000) {
          badge.classList.add('hires');
          badge.title = 'High resolution';
        }
      })
      .catch(() => {});
  }
  return badge;
}

// ---------- Album ----------

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

  const head = backHeader(artist.title, { collapse: true, actions: iconButton('more', 'More options', () => artistMenu(artist)) });
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

function editBar(text, onDone) {
  return h(
    'div.edit-bar',
    { hidden: true, role: 'status' },
    icon('unlock', 20),
    h('span.edit-bar-text', null, text),
    h('button.btn.btn-primary.edit-done', { type: 'button', onclick: onDone }, 'Done'),
  );
}

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

// ---------- Playlist ----------

export async function playlistView({ el, params, onDispose, onHide }) {
  const s = app.server;
  const pl = await s.playlist(params.id);
  if (!pl) throw Object.assign(new Error('Not found'), { status: 404 });
  // Smart playlists follow their rules in Plex; they can't be edited here.
  const editable = !pl.smart && (pl.playlistType || 'audio') === 'audio';
  let editing = false;
  let total = pl.leafCount || 0;
  let pager = null;

  const lock = editable ? lockButton('playlist', () => setEditing(!editing)) : null;
  lock?.set(false);
  const menu = iconButton('more', 'More options', () =>
    playlistMenu(pl, { edit: editing ? { onRename: rename, onDelete: remove } : null }),
  );
  const head = backHeader(pl.title, { collapse: true, fallback: '/library/playlists', actions: [lock?.el, menu] });
  const title = h('h1.hero-title', null, pl.title);
  const countEl = h('span', null, fmt.count(total, 'track', 'tracks'));
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
        h('div.hero-meta', null, countEl, pl.duration ? `, ${fmt.long(pl.duration)}` : ''),
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
  const bar = editBar('Drag a track to move it, or remove it. Changes are saved to Plex as you go; the tracks stay in your library.', () => setEditing(false));
  el.append(bar, list);

  const rows = () => [...list.children].filter((r) => r.matches('.track'));
  const setCount = (n) => {
    total = Math.max(0, n);
    pl.leafCount = total;
    countEl.textContent = fmt.count(total, 'track', 'tracks');
  };
  const changed = () => dropCached((p) => p === '/' || p === '/library/playlists' || p === '/library');

  function controls(r) {
    if (editing) addEditControls(r, `“${r.dataset.title}” from the playlist`, removeRow);
    else removeEditControls(r);
  }

  function editActions(r) {
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
      onPlay: () => playPlaylist(pl, { start: Math.max(0, rows().indexOf(r)) }),
      onMenu: () => trackMenu(t, { extra: editing ? editActions(r) : [] }),
    });
    r.dataset.pid = m.playlistItemID ?? '';
    r.dataset.title = t.title;
    controls(r);
    return r;
  }

  function setEditing(on) {
    editing = on;
    el.classList.toggle('is-editing', on);
    list.classList.toggle('editing', on);
    bar.hidden = !on;
    lock?.set(on);
    rows().forEach(controls);
  }
  onHide(() => editing && setEditing(false));

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
    const sure = await confirmAction({
      title: `Delete “${pl.title}”?`,
      message: 'The playlist is deleted from Plex. The tracks in it stay in your library.',
      confirm: 'Delete playlist',
    });
    if (!sure) return;
    try {
      await s.deletePlaylist(pl.ratingKey);
      setEditing(false);
      changed();
      toast(`Deleted “${pl.title}”`);
      back('/library/playlists');
    } catch (err) {
      toast(failMessage(err, 'playlist'));
    }
  }

  pager = pagedList(list, {
    pageSize: 100,
    fetchPage: (start, size) => s.playlistItems(pl.ratingKey, { start, size }),
    render: (m) => rowFor(m),
    empty: 'This playlist is empty.',
    onDispose,
  });
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
  const menu = iconButton('more', 'More options', () => collectionMenu(meta, { edit: editing ? { onRename: rename, onDelete: remove } : null }));
  const head = backHeader(meta.title, { collapse: true, actions: [lock?.el, menu] });
  const title = h('h1.hero-title', null, meta.title);
  const countEl = h('div.hero-meta', null, fmt.count(items.length, 'item', 'items'));
  const buttons = actionButtons([
    { icon: 'play', label: 'Play', primary: true, onClick: () => playCollection(meta) },
    { icon: 'shuffle', label: 'Shuffle', onClick: () => playCollection(meta, { shuffle: true }) },
  ]);
  el.append(
    head,
    h('section.hero.hero-album', null, art(meta.thumb || meta.composite, { size: 480, cls: 'hero-art', fallback: 'list' }), h('div.hero-info', null, title, countEl, buttons)),
  );
  collapseWhenHidden(head, title);
  const bar = editBar('Drag to change the order, or remove what doesn’t belong. Changes are saved to Plex as you go; nothing leaves your library.', () =>
    setEditing(false),
  );
  const body = h('div.collection-body');
  el.append(bar, body);
  const changed = () => dropCached((p) => p === '/' || p === '/library' || p.startsWith('/browse/collections'));
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
      const list = h('div.tracks');
      tracks.forEach((t, i) => list.append(trackRow(t, { showArt: true, onPlay: () => playList(tracks, i, { title: meta.title, href: `/collection/${params.id}` }) })));
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
    editing = on;
    el.classList.toggle('is-editing', on);
    bar.hidden = !on;
    lock?.set(on);
    if (on) renderEditing();
    else renderLocked();
  }
  onHide(() => editing && setEditing(false));

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
      back('/library');
    } catch (err) {
      toast(failMessage(err, 'collection'));
    }
  }

  setCount();
  renderLocked();
}

