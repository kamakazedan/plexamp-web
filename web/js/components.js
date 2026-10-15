// Media-aware building blocks: cards and rows that know how to play things
// and highlight whatever is currently playing.
import { player } from './player.js';
import { playAlbum, playPlaylist, trackMenu } from './actions.js';
import { h, art, card, row, icon, fmt, nowBars } from './ui.js';

export function albumCard(m, { subtitle } = {}) {
  return card({
    href: `/album/${m.ratingKey}`,
    image: m.thumb,
    title: m.title,
    subtitle: subtitle !== undefined ? subtitle : m.parentTitle,
    fallback: 'disc',
    onPlay: () => playAlbum(m),
  });
}

export function artistCard(m) {
  return card({ href: `/artist/${m.ratingKey}`, image: m.thumb, title: m.title, round: true, fallback: 'mic' });
}

export function playlistCard(m) {
  return card({
    href: `/playlist/${m.ratingKey}`,
    image: m.composite || m.thumb,
    title: m.title,
    subtitle: fmt.long(m.duration) || fmt.count(m.leafCount || 0, 'track', 'tracks'),
    fallback: 'list',
    onPlay: () => playPlaylist(m),
  });
}

export function collectionCard(m) {
  return card({
    href: `/collection/${m.ratingKey}`,
    image: m.thumb || m.composite,
    title: m.title,
    subtitle: m.childCount ? fmt.count(m.childCount, 'item', 'items') : '',
    fallback: 'list',
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
    image: m.composite || m.thumb,
    title: m.title,
    subtitle: fmt.count(m.leafCount || 0, 'track', 'tracks'),
    fallback: 'list',
    chevron: false,
  });
}

// A playable track row. `onPlay` decides what plays (usually the whole list
// starting from this row).
export function trackRow(track, { number, showArt = false, subtitle, onPlay, queueIndex, plays } = {}) {
  const lead = showArt
    ? h('div.track-lead.track-art', null, art(track.thumb, { size: 48, fallback: 'note' }), nowBars())
    : h('div.track-lead.track-num', null, h('span.num', null, number ?? ''), nowBars());
  const sub = subtitle !== undefined ? subtitle : track.artist;
  const right = plays !== undefined ? fmt.count(plays, 'play', 'plays') : track.duration ? fmt.clock(track.duration / 1000) : '';
  const el = h(
    'div.track',
    { dataset: { trackId: track.id, qid: queueIndex !== undefined ? String(queueIndex) : '' } },
    h(
      'button.track-main',
      { type: 'button', onclick: onPlay, 'aria-label': `Play ${track.title}` },
      lead,
      h('div.track-text', null, h('div.track-title', null, track.title), sub ? h('div.track-sub', null, sub) : null),
      h('span.track-dur', null, right),
    ),
    h(
      'button.icon-btn.track-more',
      { type: 'button', 'aria-label': `More options for ${track.title}`, onclick: () => trackMenu(track, { queueIndex }) },
      icon('more', 22),
    ),
  );
  markRow(el);
  return el;
}

function markRow(el) {
  const cur = player.current;
  const isCur = !!cur && el.dataset.trackId === cur.id && (el.dataset.qid === '' || Number(el.dataset.qid) === player.index);
  el.classList.toggle('is-current', isCur);
  el.classList.toggle('is-playing', isCur && player.isPlaying);
}

export function syncCurrent(root = document) {
  root.querySelectorAll('.track[data-track-id]').forEach(markRow);
}

player.addEventListener('track', () => syncCurrent());
player.addEventListener('state', () => syncCurrent());
player.addEventListener('queue', () => syncCurrent());
