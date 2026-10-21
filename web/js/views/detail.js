import { app } from '../state.js';
import { normTrack } from '../plex.js';
import { back, dropCached, describeError, refresh, popOverlay } from '../router.js';
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
  pointOut,
  learned,
  sheet,
} from '../ui.js';
import { albumCard, artistCard, trackRow, numberedList, collectionCard, playlistArt } from '../components.js';
import { sharingOn, freshShares, shareOf, syncShare, sharedPlaylistChanged, sharedMark, stopSharing, leaveShared } from '../sharing.js';
import { openShareDialog, leaveDialog, shareLine } from './share.js';
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
import { sortChoices, sortedOrder, restoreOrder, saveOrder } from '../sorting.js';

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
        const row = shelf(more.map((m) => albumCard(m, { subtitle: year(m) || '' })));
        el.append(h('section.block', null, sectionHeader(`More by ${album.parentTitle}`, `/artist/${album.parentRatingKey}`, null, row), row));
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
  // On a desktop the photo is a banner as wide as the page, so it's asked
  // for at that width (up to 1920 pixels) rather than stretched.
  const wide = el.clientWidth >= 900;
  el.append(
    head,
    h(
      'section.hero.hero-artist',
      null,
      h('div.artist-photo', null, art(artist.thumb || artist.art, { size: wide ? el.clientWidth : 640, most: wide ? 1920 : 960, fallback: 'mic' })),
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
    const list = numberedList({ total: tracks.length });
    const context = { title: `${artist.title}: popular`, href: `/artist/${artist.ratingKey}` };
    tracks.forEach((t, i) => {
      const r = trackRow(t, { showArt: true, position: true, subtitle: t.album, onPlay: () => playList(tracks, i, context) });
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
      if (artists.length) {
        const row = shelf(artists.map(artistCard));
        similarSlot.replaceWith(h('section.block', null, sectionHeader('Sonically similar', null, null, row), row));
      }
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

// The bar over an unlocked list: what you can do, Sort, and Done. While a
// sort is being saved it says how far it's got, with a Stop button.
function editBar(text, { onDone, onSort }) {
  const textEl = h('span.edit-bar-text', null, text);
  const sortBtn = onSort ? h('button.btn.btn-secondary.edit-sort', { type: 'button', onclick: onSort }, icon('sort', 18), h('span', null, 'Sort')) : null;
  const doneBtn = h('button.btn.btn-primary.edit-done', { type: 'button', onclick: onDone }, 'Done');
  const actions = h('div.edit-bar-actions', null, sortBtn, doneBtn);
  const el = h('div.edit-bar', { hidden: true, role: 'status' }, icon('unlock', 20), textEl, actions);
  return {
    el,
    working(message, onStop) {
      el.classList.add('busy');
      textEl.textContent = message;
      actions.replaceChildren(h('button.btn.btn-secondary.edit-stop', { type: 'button', onclick: onStop }, 'Stop'));
    },
    say(message) {
      textEl.textContent = message;
    },
    idle() {
      el.classList.remove('busy');
      textEl.textContent = text;
      actions.replaceChildren(...[sortBtn, doneBtn].filter(Boolean));
    },
  };
}

// "Sort by": the ways a list of tracks, albums or artists can be sorted.
function chooseSort(kind, title, onPick) {
  const icons = { artist: 'mic', title: kind === 'album' ? 'disc' : 'note', album: 'disc', year: 'calendar', reverse: 'arrowUp' };
  sheet({
    title: 'Sort by',
    subtitle: `“${title}” is saved to Plex in its new order.`,
    actions: sortChoices(kind).map(([by, label]) => ({ icon: icons[by] || 'sort', label, onSelect: () => onPick(by, label) })),
  });
}

// What a sort says while it's saved, and after.
const sortWords = (by, label) =>
  by === 'reverse' ? ['Reversing the order', 'Reversed'] : [`Sorting by ${label.toLowerCase()}`, `Sorted by ${label.toLowerCase()}`];

// While it's saved: how many of those that need moving have moved, and how
// many were in place already ("458" is moves, not tracks: the other 42 of
// a list of 500 stay where they are).
const movedWords = (doing, n, of, { total, checking }) =>
  checking ? `Making sure it’s all in order… ${fmt.number(n)} of ${fmt.number(of)} moved` : `${doing}… ${fmt.number(n)} of ${fmt.number(of)} moved${total > of ? ` (${fmt.number(total - of)} already in place)` : ''}`;

// And after: "Sorted by artist: 458 of 500 tracks moved".
const doneWords = (done, { moved, total }, one, many) => `${done}: ${fmt.number(moved)} of ${fmt.count(total, one, many)} moved`;

const SORT_LIMIT = 5000; // entries; longer lists aren't sorted here

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

// ---------- a playlist's or collection's picture ----------

// Pictures are made smaller in the browser before they go to Plex: this many
// pixels across at most, as a JPEG.
const PICTURE_SIZE = 1200;

async function shrinkPicture(file) {
  let source;
  try {
    source = await createImageBitmap(file);
  } catch {
    // (Safari before 17 can't make one from some files: an <img> can.)
    source = await new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(Object.assign(new Error('Not a picture'), { badImage: true }));
      img.src = url;
    });
  }
  const w = source.width || source.naturalWidth;
  const ht = source.height || source.naturalHeight;
  if (!w || !ht) throw Object.assign(new Error('Not a picture'), { badImage: true });
  const scale = Math.min(1, PICTURE_SIZE / Math.max(w, ht));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(ht * scale));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#16171b'; // under any see-through parts
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  source.close?.();
  if (source.src?.startsWith('blob:')) URL.revokeObjectURL(source.src);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.88));
  if (!blob) throw Object.assign(new Error('Not a picture'), { badImage: true });
  return blob.arrayBuffer();
}

// The artwork at the top of a playlist or collection. While it's unlocked
// a pencil sits over it (on a computer, when the pointer is over it), which
// opens the choice of picture: upload one, go back to one it had, or to the
// one Plex makes. `load` fetches the item again once its picture changes.
function pictureBox(path, { what, id, title, load, onChanged }) {
  let current = art(path, { size: 480, cls: 'hero-art', fallback: 'list' });
  // (Its click, from the sheet, mustn't reach the box: that would open the
  // sheet again.)
  const input = h('input.picture-input', { type: 'file', accept: 'image/*', tabindex: '-1', 'aria-hidden': 'true', onclick: (e) => e.stopPropagation() });
  const pencil = h('button.hero-art-edit', { type: 'button', 'aria-label': `Change the ${what}’s picture`, title: 'Change the picture', onclick: (e) => (e.stopPropagation(), choose()) }, icon('edit', 28));
  const box = h('div.hero-art-box', { onclick: () => box.classList.contains('editable') && choose() }, current, pencil, input);
  let busy = false;

  const setBusy = (on) => {
    busy = on;
    box.classList.toggle('busy', on);
    pencil.replaceChildren(on ? h('span.picture-spinner', { 'aria-hidden': 'true' }) : icon('edit', 28));
    pencil.setAttribute('aria-label', on ? 'Changing the picture…' : `Change the ${what}’s picture`);
  };

  async function refresh() {
    const fresh = await load().catch(() => null);
    const next = fresh ? fresh.thumb || fresh.composite : null;
    if (fresh) onChanged?.(fresh);
    const el = art(next, { size: 480, cls: 'hero-art', fallback: 'list' });
    current.replaceWith(el);
    current = el;
  }

  async function change(job, done) {
    if (busy) return;
    setBusy(true);
    try {
      await job();
      await refresh();
      toast(done);
    } catch (err) {
      toast(err?.badImage ? 'That picture couldn’t be read. Try a JPEG or PNG.' : failMessage(err, what));
    } finally {
      setBusy(false);
    }
  }

  input.addEventListener('change', () => {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (file.type && !file.type.startsWith('image/')) return toast('That isn’t a picture.');
    change(async () => app.server.uploadPoster(id, await shrinkPicture(file)), 'Picture changed');
  });

  async function choose() {
    if (busy) return;
    const posters = await app.server.posters(id).catch(() => []);
    const earlier = posters.filter((p) => !p.selected).slice(0, 12);
    const custom = posters.some((p) => p.selected && /^upload:\/\//.test(p.id));
    const grid = earlier.length
      ? h(
          'div.picture-choices',
          null,
          h('div.picture-choices-label', null, 'Pictures it’s had'),
          h(
            'div.picture-grid',
            null,
            earlier.map((p, i) =>
              h(
                'button.picture-choice',
                {
                  type: 'button',
                  'aria-label': `Use picture ${i + 1}`,
                  onclick: async () => {
                    await popOverlay();
                    change(() => app.server.selectPoster(id, p.id), 'Picture changed');
                  },
                },
                art(p.thumb, { size: 120, fallback: 'list' }),
              ),
            ),
          ),
        )
      : null;
    sheet({
      title: 'Picture',
      subtitle: `For “${title()}”`,
      content: grid,
      actions: [
        // (The file picker opens straight from the tap: browsers want that.)
        { icon: 'image', label: 'Upload a picture…', description: 'From this device. It’s made smaller for Plex.', now: true, onSelect: () => input.click() },
        custom && {
          icon: 'refresh',
          label: what === 'playlist' ? 'Use its tracks’ covers' : 'Remove this picture',
          description: what === 'playlist' ? 'Back to the covers Plex puts together' : 'Back to the picture Plex gives it',
          onSelect: () => change(() => app.server.removePoster(id), what === 'playlist' ? 'Back to its tracks’ covers' : 'Picture removed'),
        },
      ],
    });
  }

  return {
    el: box,
    open: choose,
    setEditing(on) {
      box.classList.toggle('editable', on);
    },
  };
}

// ---------- Playlist ----------

export async function playlistView({ el, params, onDispose, onHide }) {
  const s = app.server;
  const [pl] = await Promise.all([s.playlist(params.id), sharingOn() ? freshShares().catch(() => []) : null]);
  if (!pl) throw Object.assign(new Error('Not found'), { status: 404 });
  // Shared with friends (yours), or shared with you (see sharing.js).
  const share = shareOf(pl.ratingKey);
  // Smart playlists follow their rules in Plex; they can't be edited here.
  // Nor can one shared with you to view only (changes would be undone).
  const editable = !pl.smart && (pl.playlistType || 'audio') === 'audio' && share?.role !== 'view';
  let editing = false;
  let total = pl.leafCount || 0;
  let pager = null;

  const lock = editable ? lockButton('playlist', () => setEditing(!editing)) : null;
  lock?.set(false);
  // Until the lock has been used, a reminder of what it's for.
  const hint = lock ? pointOut(lock.el, 'Locked, so nothing changes by accident. Tap the lock to reorder, sort or remove tracks, or change the picture.', { key: 'lock' }) : () => {};
  const picture = pictureBox(playlistArt(pl), {
    what: 'playlist',
    id: pl.ratingKey,
    title: () => pl.title,
    load: () => s.playlist(pl.ratingKey),
    onChanged: (fresh) => {
      pl.thumb = fresh.thumb;
      pl.composite = fresh.composite;
      dropCached((p) => p === '/' || p === '/playlists' || p === '/library/playlists');
    },
  });
  // A smart playlist can't be unlocked (its rules decide what's in it), but
  // its picture can still change, from its menu.
  const shareActions = () => {
    if (!sharingOn()) return [];
    if (share && share.role !== 'owner') {
      return [{ icon: 'together', label: 'Stop sharing it with me…', description: `Keep it as a playlist of your own, without ${share.owner.title}’s changes`, onSelect: () => leaveDialog(share, { onChange: refresh }) }];
    }
    if (pl.smart || (pl.playlistType || 'audio') !== 'audio') return [];
    return [
      share
        ? { icon: 'together', label: 'Sharing…', description: shareLine(share), onSelect: () => openShareDialog(pl, { onChange: refresh }) }
        : { icon: 'together', label: 'Share with friends…', description: 'Plex friends who can use this server get a copy, kept the same as yours', onSelect: () => openShareDialog(pl, { onChange: refresh }) },
    ];
  };
  const menu = iconButton('more', 'More options', () =>
    playlistMenu(pl, {
      edit: editing ? { onRename: rename, onDelete: remove } : null,
      picture: editing || pl.smart ? () => picture.open() : null,
      extra: shareActions(),
    }),
  );
  const head = backHeader(pl.title, { collapse: true, fallback: '/playlists', actions: [lock?.el, menu] });
  const title = h('h1.hero-title', null, pl.title);
  const countEl = h('span', null, fmt.count(total, 'track', 'tracks'));
  el.append(
    head,
    h(
      'section.hero.hero-album',
      null,
      picture.el,
      h(
        'div.hero-info',
        null,
        title,
        h('div.hero-meta', null, countEl, pl.duration ? `, ${fmt.long(pl.duration)}` : ''),
        pl.smart ? h('div.hero-meta', null, 'Smart playlist') : null,
        share
          ? share.role === 'owner'
            ? h('button.hero-meta.share-line.link-btn', { type: 'button', onclick: () => openShareDialog(pl, { onChange: refresh }) }, icon('together', 18), h('span', null, shareLine(share)))
            : h('div.hero-meta.share-line', null, icon('together', 18), h('span', null, shareLine(share)))
          : null,
        actionButtons([
          { icon: 'play', label: 'Play', primary: true, onClick: () => playPlaylist(pl) },
          { icon: 'shuffle', label: 'Shuffle', onClick: () => playPlaylist(pl, { shuffle: true }) },
        ]),
      ),
    ),
  );
  picture.el.append(sharedMark(pl.ratingKey));
  collapseWhenHidden(head, title);
  if (pl.summary) el.append(h('div.pad.hero-summary', null, clampText(pl.summary, 3)));

  const list = numberedList({ total, album: true });
  const bar = editBar('Drag a track to move it, or remove it, and tap the picture to change it. Changes are saved to Plex as you go; the tracks stay in your library.', {
    onDone: () => setEditing(false),
    onSort: () => chooseSort('track', pl.title, (by, label) => sortBy(by, label)),
  });
  el.append(bar.el, list);

  const rows = () => [...list.children].filter((r) => r.matches('.track'));
  const setCount = (n) => {
    total = Math.max(0, n);
    pl.leafCount = total;
    countEl.textContent = fmt.count(total, 'track', 'tracks');
    list.style.setProperty('--pos-digits', String(Math.max(2, String(total).length)));
  };
  const changed = () => {
    dropCached((p) => p === '/' || p === '/playlists' || p === '/library/playlists');
    // Shared: everyone's copy gets it.
    sharedPlaylistChanged(pl.ratingKey);
  };
  // Opened: brought up to date with everyone else's changes (the page loads
  // again if there were any).
  if (share) syncShare(share).catch(() => {});

  function controls(r) {
    if (editing) addEditControls(r, `“${r.dataset.title}” from the playlist`, removeRow);
    else removeEditControls(r);
  }

  function editActions(r) {
    if (!editing) {
      // Locked: the way in, for anyone looking here to remove a track.
      return editable ? [{ icon: 'unlock', label: 'Edit playlist', description: 'Unlock it to reorder or remove tracks', onSelect: () => setEditing(true) }] : [];
    }
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
      position: true,
      album: true,
      onPlay: () => playPlaylist(pl, { start: Math.max(0, rows().indexOf(r)) }),
      onMenu: () => trackMenu(t, { extra: editActions(r) }),
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
    bar.el.hidden = !on;
    lock?.set(on);
    picture.setEditing(on);
    rows().forEach(controls);
    if (on) {
      learned('lock');
      hint();
    }
  }
  onHide(() => {
    hint();
    if (editing) setEditing(false);
  });

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
    const others = share?.role === 'owner' ? (share.members || []).length : 0;
    const sure = await confirmAction({
      title: `Delete “${pl.title}”?`,
      message: `The playlist is deleted from Plex. The tracks in it stay in your library.${
        others ? ` It stops being shared: the ${others === 1 ? 'friend' : `${others} friends`} you shared it with keep their copies.` : share ? ' It stops being shared with you.' : ''
      }`,
      confirm: 'Delete playlist',
    });
    if (!sure) return;
    try {
      if (share) await (share.role === 'owner' ? stopSharing(share) : leaveShared(share)).catch(() => {});
      await s.deletePlaylist(pl.ratingKey);
      setEditing(false);
      changed();
      toast(`Deleted “${pl.title}”`);
      back('/playlists');
    } catch (err) {
      toast(failMessage(err, 'playlist'));
    }
  }

  // ---------- sorting ----------
  // The new order is worked out from every entry, then saved with the
  // fewest moves (see sorting.js). Undo puts it back the same way.

  let sorting = null;

  // Every entry, page by page (as many as the server gives at a time).
  async function allEntries() {
    const out = [];
    for (;;) {
      const { items, total: t } = await s.playlistItems(pl.ratingKey, { start: out.length, size: 500 });
      out.push(...items);
      if (out.length > SORT_LIMIT) throw Object.assign(new Error(`Playlists of more than ${fmt.number(SORT_LIMIT)} tracks can’t be sorted here.`), { tooLong: true });
      if (!items.length || out.length >= t) break;
    }
    return out;
  }

  // makeTarget(entries) gives the entries' ids (playlistItemID) in the
  // order wanted.
  async function reorder(makeTarget, [doing, done]) {
    if (sorting) return;
    const ctrl = new AbortController();
    sorting = ctrl;
    busy(true);
    bar.working(`${doing}…`, () => ctrl.abort());
    let result = null;
    try {
      result = await saveOrder({
        read: allEntries,
        idOf: (m) => String(m.playlistItemID),
        target: makeTarget,
        move: (id, after) => s.movePlaylistItem(pl.ratingKey, id, after),
        signal: ctrl.signal,
        onProgress: (n, of, p) => bar.say(movedWords(doing, n, of, p)),
      });
      if (!result.moved) {
        toast('It’s in that order already.');
        return;
      }
      changed();
      reload();
      const before = result.before;
      const undo = { action: 'Undo', onAction: () => reorder((now) => restoreOrder(now.map((m) => String(m.playlistItemID)), before), ['Putting it back', 'Put back']), timeout: 8000 };
      toast(result.stopped ? 'Stopped, part way through.' : doneWords(done, result, 'track', 'tracks'), undo);
    } catch (err) {
      toast(err?.tooLong ? err.message : failMessage(err, 'playlist'));
      if (!err?.tooLong) reload(); // (some may have moved)
    } finally {
      sorting = null;
      busy(false);
      bar.idle();
    }
  }

  // While a new order is saved: the list waits, the lock stays as it is, and
  // live updates don't reload the page under it.
  function busy(on) {
    list.classList.toggle('sorting', on);
    el.classList.toggle('is-sorting', on);
    if (lock) lock.el.disabled = on;
  }

  function sortBy(by, label) {
    reorder((entries) => sortedOrder(entries, by).map((m) => String(m.playlistItemID)), sortWords(by, label));
  }

  function showList() {
    pager = pagedList(list, {
      pageSize: 100,
      fetchPage: (start, size) => s.playlistItems(pl.ratingKey, { start, size }),
      render: (m) => rowFor(m),
      empty: 'This playlist is empty.',
      onDispose,
    });
  }

  // The list again, from the top, as Plex now has it.
  function reload() {
    pager?.destroy();
    list.replaceChildren();
    showList();
  }

  showList();
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
  const hint = lock ? pointOut(lock.el, 'Locked, so nothing changes by accident. Tap the lock to reorder, sort or remove what’s in it, or change the picture.', { key: 'lock' }) : () => {};
  const picture = pictureBox(meta.thumb || meta.composite, {
    what: 'collection',
    id: meta.ratingKey,
    title: () => meta.title,
    load: async () => (await s.collection(meta.ratingKey)).meta,
    onChanged: (fresh) => {
      meta.thumb = fresh.thumb;
      meta.composite = fresh.composite;
      dropCached((p) => p === '/' || p === '/search' || p.startsWith('/browse/collections'));
    },
  });
  const menu = iconButton('more', 'More options', () =>
    collectionMenu(meta, { edit: editing ? { onRename: rename, onDelete: remove } : null, picture: editing ? () => picture.open() : null }),
  );
  const head = backHeader(meta.title, { collapse: true, actions: [lock?.el, menu] });
  const title = h('h1.hero-title', null, meta.title);
  const countEl = h('div.hero-meta', null, fmt.count(items.length, 'item', 'items'));
  const buttons = actionButtons([
    { icon: 'play', label: 'Play', primary: true, onClick: () => playCollection(meta) },
    { icon: 'shuffle', label: 'Shuffle', onClick: () => playCollection(meta, { shuffle: true }) },
  ]);
  el.append(
    head,
    h('section.hero.hero-album', null, picture.el, h('div.hero-info', null, title, countEl, buttons)),
  );
  collapseWhenHidden(head, title);
  const bar = editBar('Drag to change the order, or remove what doesn’t belong, and tap the picture to change it. Changes are saved to Plex as you go; nothing leaves your library.', {
    onDone: () => setEditing(false),
    onSort: () => chooseSort(meta.subtype || 'album', meta.title, (by, label) => sortBy(by, label)),
  });
  const body = h('div.collection-body');
  el.append(bar.el, body);
  const changed = () => dropCached((p) => p === '/' || p === '/search' || p.startsWith('/browse/collections'));
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
      const list = numberedList({ total: tracks.length, album: true });
      const unlock = [{ icon: 'unlock', label: 'Edit collection', description: 'Unlock it to reorder or remove tracks', onSelect: () => setEditing(true) }];
      tracks.forEach((t, i) =>
        list.append(
          trackRow(t, {
            showArt: true,
            position: true,
            album: true,
            onPlay: () => playList(tracks, i, { title: meta.title, href: `/collection/${params.id}` }),
            onMenu: editable ? () => trackMenu(t, { extra: unlock }) : undefined,
          }),
        ),
      );
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
    bar.el.hidden = !on;
    lock?.set(on);
    picture.setEditing(on);
    if (on) {
      learned('lock');
      hint();
      renderEditing();
    } else renderLocked();
  }
  onHide(() => {
    hint();
    if (editing) setEditing(false);
  });

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
      back('/search');
    } catch (err) {
      toast(failMessage(err, 'collection'));
    }
  }

  // ---------- sorting (see the playlist's) ----------

  let sorting = null;

  // makeTarget(items) gives the items' ids in the order wanted.
  async function reorder(makeTarget, [doing, done]) {
    if (sorting) return;
    const ctrl = new AbortController();
    sorting = ctrl;
    busy(true);
    bar.working(`${doing}…`, () => ctrl.abort());
    try {
      // A collection keeps an order of its own only when sorted "custom".
      // Its custom order can differ from the one it was showing, so the
      // moves are worked out from the order Plex has once it's custom.
      if (meta.collectionSort !== 2) {
        await s.customOrder(meta.ratingKey);
        meta.collectionSort = 2;
      }
      const result = await saveOrder({
        read: async () => {
          const { items: now } = await s.collection(meta.ratingKey);
          if (now.length > SORT_LIMIT) throw Object.assign(new Error(`Collections of more than ${fmt.number(SORT_LIMIT)} items can’t be sorted here.`), { tooLong: true });
          return now;
        },
        idOf: (m) => String(m.ratingKey),
        target: makeTarget,
        move: (id, after) => s.moveCollectionItem(meta.ratingKey, id, after),
        signal: ctrl.signal,
        onProgress: (n, of, p) => bar.say(movedWords(doing, n, of, p)),
      });
      if (result.moved) {
        changed();
        const before = result.before;
        const undo = { action: 'Undo', onAction: () => reorder((list2) => restoreOrder(list2.map((m) => String(m.ratingKey)), before), ['Putting it back', 'Put back']), timeout: 8000 };
        toast(result.stopped ? 'Stopped, part way through.' : doneWords(done, result, 'item', 'items'), undo);
      } else {
        toast('It’s in that order already.');
      }
      items = (await s.collection(meta.ratingKey)).items;
    } catch (err) {
      toast(err?.tooLong ? err.message : failMessage(err, 'collection'));
      // (Some may have moved.)
      if (!err?.tooLong) items = (await s.collection(meta.ratingKey).catch(() => null))?.items || items;
    } finally {
      sorting = null;
      busy(false);
      bar.idle();
      setCount();
      if (editing) renderEditing();
      else renderLocked();
    }
  }

  function busy(on) {
    list.classList.toggle('sorting', on);
    el.classList.toggle('is-sorting', on);
    if (lock) lock.el.disabled = on;
  }

  function sortBy(by, label) {
    reorder((now) => sortedOrder(now, by).map((m) => String(m.ratingKey)), sortWords(by, label));
  }

  setCount();
  renderLocked();
}

