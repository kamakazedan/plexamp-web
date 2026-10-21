// Media-aware building blocks: cards and rows that know how to play things
// and highlight whatever is currently playing.
import { app } from './state.js';
import { player } from './player.js';
import { playAlbum, playPlaylist, playCollection, trackMenu } from './actions.js';
import { h, art, card, row, icon, fmt, nowBars, sheet, toast } from './ui.js';
import { togglePreview, isPreviewing } from './preview.js';
import { rowRating } from './ratings.js';
import { sharedMark } from './sharing.js';

export function albumCard(m, { subtitle } = {}) {
  return card({
    href: `/album/${m.ratingKey}`,
    image: m.thumb,
    title: m.title,
    subtitle: subtitle !== undefined ? subtitle : m.parentTitle,
    fallback: 'disc',
    onPlay: () => playAlbum(m),
    onShuffle: () => playAlbum(m, { shuffle: true }),
  });
}

export function artistCard(m) {
  return card({ href: `/artist/${m.ratingKey}`, image: m.thumb, title: m.title, round: true, fallback: 'mic' });
}

// A playlist's picture: the one you set for it in Plex (its thumb), or else
// the mosaic Plex makes from its tracks (its composite).
export const playlistArt = (m) => m?.thumb || m?.composite || null;

export function playlistCard(m) {
  const c = card({
    href: `/playlist/${m.ratingKey}`,
    image: playlistArt(m),
    title: m.title,
    subtitle: fmt.long(m.duration) || fmt.count(m.leafCount || 0, 'track', 'tracks'),
    fallback: 'list',
    onPlay: () => playPlaylist(m),
    onShuffle: () => playPlaylist(m, { shuffle: true }),
  });
  // Shared with friends, or by one (top left of its picture).
  c.querySelector('.card-art')?.append(sharedMark(m.ratingKey));
  return c;
}

const COLLECTION_UNITS = { album: ['album', 'albums'], artist: ['artist', 'artists'], track: ['track', 'tracks'] };

export function collectionCard(m) {
  const unit = COLLECTION_UNITS[m.subtype] || ['item', 'items'];
  return card({
    href: `/collection/${m.ratingKey}`,
    image: m.thumb || m.composite,
    title: m.title,
    subtitle: m.childCount ? fmt.count(m.childCount, ...unit) : '',
    fallback: 'list',
    onPlay: () => playCollection(m),
    onShuffle: () => playCollection(m, { shuffle: true }),
  });
}

export function artistRow(m) {
  return row({ href: `/artist/${m.ratingKey}`, image: m.thumb, round: true, title: m.title, fallback: 'mic', chevron: false });
}

export function albumRow(m) {
  return row({
    href: `/album/${m.ratingKey}`,
    image: m.thumb,
    title: m.title,
    subtitle: [m.parentTitle, m.year].filter(Boolean).join(', '),
    fallback: 'disc',
    chevron: false,
  });
}

export function playlistRow(m) {
  return row({
    href: `/playlist/${m.ratingKey}`,
    image: playlistArt(m),
    title: m.title,
    subtitle: fmt.count(m.leafCount || 0, 'track', 'tracks'),
    fallback: 'list',
    chevron: false,
  });
}

// With "1-tap playback" off, tapping a track while something is playing
// asks what to do with it instead of replacing what's playing.
function tapTrack(track, onPlay, inQueue) {
  if (app.settings.oneTapPlayback !== false || inQueue || !player.current || !player.isPlaying) return onPlay?.();
  sheet({
    title: track.title,
    subtitle: [track.artist, track.album].filter(Boolean).join(' — '),
    image: track.thumb,
    actions: [
      { icon: 'play', label: 'Play now', onSelect: () => onPlay?.() },
      { icon: 'playNext', label: 'Play next', onSelect: () => (player.playNext([track]), toast('Playing next')) },
      { icon: 'addQueue', label: 'Add to queue', onSelect: () => (player.addToQueue([track]), toast('Added to queue')) },
    ],
  });
}

// A playable track row. `onPlay` decides what plays (usually the whole list
// starting from this row). `popular` marks one of the album's best-known
// tracks. `onMenu` replaces the usual menu (pages add their own actions).
// `rating`: the track's rating control (as Settings › Experience says), on
// by default except in the queue. In a numbered list (numberedList), `position`
// puts its place in the list before it, and `album` its album in a column
// of its own where there's room; `subAlbum` adds the album to the subtitle
// where there isn't. `badge`: something before the subtitle (search's
// formats), where a long title doesn't hide it.
export function trackRow(
  track,
  { number, position = false, album = false, subAlbum = false, showArt = false, subtitle, onPlay, queueIndex, plays, popular = false, onMenu, rating, badge = null } = {},
) {
  const lead = showArt
    ? h('div.track-lead.track-art', null, art(track.thumb, { size: 48, fallback: 'note' }))
    : h('div.track-lead.track-num', null, h('span.num', null, number ?? ''));
  const text = subtitle !== undefined ? subtitle : track.artist;
  const sub = subAlbum && track.album ? [text, h('span.track-sub-album', null, `${text ? ' — ' : ''}${track.album}`)] : text;
  const right = plays !== undefined ? fmt.count(plays, 'play', 'plays') : track.duration ? fmt.clock(track.duration / 1000) : '';
  const albumCol = !album
    ? null
    : track.album && track.albumId
      ? h('a.track-album', { href: `#/album/${track.albumId}`, title: track.album }, track.album)
      : h('span.track-album', null, track.album || '');
  const inQueue = queueIndex !== undefined;
  const preview =
    app.settings.previewButtons && !inQueue && track.partKey
      ? h(
          `button.icon-btn.track-preview${isPreviewing(track) ? '.on' : ''}`,
          { type: 'button', 'aria-label': `Preview ${track.title}`, title: 'Preview', 'aria-pressed': 'false', onclick: (e) => togglePreview(track, e.currentTarget) },
          icon('headphones', 20),
        )
      : null;
  const el = h(
    'div.track',
    { dataset: { trackId: track.id, qid: inQueue ? String(queueIndex) : '' } },
    h(
      'button.track-main',
      { type: 'button', onclick: () => tapTrack(track, onPlay, inQueue), 'aria-label': `Play ${track.title}` },
      position ? h('span.track-pos') : null,
      lead,
      h(
        'div.track-text',
        null,
        h('div.track-title', null, track.title, popular ? h('span.popular-badge', { title: 'Popular', 'aria-label': 'Popular' }, icon('flame', 15)) : null),
        sub || badge ? h('div.track-sub', null, badge, sub) : null,
      ),
    ),
    albumCol,
    (rating ?? !inQueue) ? rowRating(track) : null,
    h('span.track-dur', null, right),
    preview,
    h(
      'button.icon-btn.track-more',
      { type: 'button', 'aria-label': `More options for ${track.title}`, onclick: () => (onMenu ? onMenu() : trackMenu(track, { queueIndex })) },
      icon('more', 22),
    ),
  );
  markRow(el);
  return el;
}

// A list of tracks numbered from 1, as playlists are (the rows given
// `position`): the numbers come from the rows' order, so they stay right as
// rows are dragged, removed or added. `total`, if known, sizes the number
// column; `album`: room for an album column, shown where the list is wide
// enough (a phone shows the album under the title, if anywhere).
export function numberedList({ total = 0, album = false, cls = '' } = {}) {
  const list = h(`div.tracks.numbered${album ? '.with-album' : ''}${cls}`);
  list.style.setProperty('--pos-digits', String(Math.max(2, String(Math.max(0, Math.floor(total))).length)));
  return list;
}

// The playing bars are only added to the row that's playing: a list can
// have thousands of rows.
function markRow(el) {
  const cur = player.current;
  const isCur = !!cur && el.dataset.trackId === cur.id && (el.dataset.qid === '' || Number(el.dataset.qid) === player.index);
  if (!isCur && !el.classList.contains('is-current')) return;
  el.classList.toggle('is-current', isCur);
  el.classList.toggle('is-playing', isCur && player.isPlaying);
  const lead = el.querySelector('.track-lead');
  const bars = lead?.querySelector(':scope > .bars');
  if (isCur && !bars) lead?.append(nowBars());
  else if (!isCur) bars?.remove();
}

export function syncCurrent(root = document) {
  root.querySelectorAll('.track[data-track-id]').forEach(markRow);
}

player.addEventListener('track', () => syncCurrent());
player.addEventListener('state', () => syncCurrent());
player.addEventListener('queue', () => syncCurrent());
