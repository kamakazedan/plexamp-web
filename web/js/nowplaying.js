// The player bar (mini player on phones, full transport on desktop) and the
// full-screen Now Playing view with its "Up next" queue.
import { app } from './state.js';
import { player } from './player.js';
import { pushOverlay, popOverlay } from './router.js';
import { h, icon, iconButton, art, fmt, toast } from './ui.js';
import { trackMenu, similarRadio } from './actions.js';
import { trackRow } from './components.js';

const setIcon = (btn, name, size) => {
  btn.replaceChildren(icon(name, size));
};

function setPlayButton(btn, size) {
  const playing = player.isPlaying;
  setIcon(btn, playing ? 'pause' : 'play', size);
  btn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  btn.title = playing ? 'Pause' : 'Play';
  btn.classList.toggle('is-loading', player.state === 'loading');
}

function setModeButtons(shuffleBtn, repeatBtn, size) {
  shuffleBtn.classList.toggle('on', player.shuffle);
  shuffleBtn.setAttribute('aria-pressed', String(player.shuffle));
  setIcon(repeatBtn, player.repeat === 'one' ? 'repeatOne' : 'repeat', size);
  repeatBtn.classList.toggle('on', player.repeat !== 'off');
  const label = { off: 'Repeat: off', all: 'Repeat: all', one: 'Repeat: this track' }[player.repeat];
  repeatBtn.setAttribute('aria-label', label);
  repeatBtn.title = label;
}

function scrubber(cls = '') {
  const input = h('input.scrub', { type: 'range', min: 0, max: 1000, step: 1, value: 0, 'aria-label': 'Playback position' });
  const cur = h('span.t-cur', null, '0:00');
  const rem = h('span.t-rem', null, '0:00');
  let dragging = false;
  const paint = () => input.style.setProperty('--p', `${input.value / 10}%`);
  input.addEventListener('input', () => {
    dragging = true;
    cur.textContent = fmt.clock((input.value / 1000) * player.duration);
    paint();
  });
  input.addEventListener('change', () => {
    dragging = false;
    player.seek((input.value / 1000) * player.duration);
  });
  return {
    el: h(`div.scrub-wrap${cls}`, null, cur, input, rem),
    update() {
      if (dragging) return;
      const d = player.duration;
      const t = player.time;
      input.value = d ? Math.round((t / d) * 1000) : 0;
      input.setAttribute('aria-valuetext', `${fmt.clock(t)} of ${fmt.clock(d)}`);
      paint();
      cur.textContent = fmt.clock(t);
      rem.textContent = d ? `-${fmt.clock(Math.max(0, d - t))}` : '0:00';
    },
  };
}

function volumeControl() {
  const btn = iconButton('speaker', 'Mute', () => player.toggleMute(), { size: 22 });
  const input = h('input.scrub.vol', { type: 'range', min: 0, max: 100, step: 1, 'aria-label': 'Volume' });
  input.addEventListener('input', () => {
    player.setVolume(input.value / 100);
    input.style.setProperty('--p', `${input.value}%`);
  });
  const update = () => {
    const v = player.muted ? 0 : player.volume;
    input.value = Math.round(v * 100);
    input.style.setProperty('--p', `${input.value}%`);
    setIcon(btn, v === 0 ? 'speakerOff' : 'speaker', 22);
    btn.setAttribute('aria-label', player.muted ? 'Unmute' : 'Mute');
  };
  update();
  player.addEventListener('volume', update);
  return { el: h('div.volume', null, btn, input), update };
}

// ---------- player bar ----------

export function initPlayerBar(root) {
  const fill = h('div.pb-progress-fill');
  const artBox = h('div.pb-art');
  const artistEl = h('div.pb-artist');
  const titleEl = h('div.pb-title');
  const main = h('button.pb-main', { type: 'button', 'aria-label': 'Open now playing', onclick: () => openNowPlaying() }, artBox, h('div.pb-text', null, artistEl, titleEl));

  const play = iconButton('play', 'Play', () => player.toggle(), { size: 32, cls: 'pb-play' });
  const next = iconButton('next', 'Next track', () => player.next(), { size: 28, cls: 'pb-next' });

  const dShuffle = iconButton('shuffle', 'Shuffle', () => player.setShuffle(!player.shuffle), { size: 20, cls: 'mode-btn' });
  const dPrev = iconButton('prev', 'Previous track', () => player.prev(), { size: 22 });
  const dPlay = iconButton('play', 'Play', () => player.toggle(), { size: 22, cls: 'pb-dplay' });
  const dNext = iconButton('next', 'Next track', () => player.next(), { size: 22 });
  const dRepeat = iconButton('repeat', 'Repeat', () => player.cycleRepeat(), { size: 20, cls: 'mode-btn' });
  const scrub = scrubber('.pb-scrub');
  const vol = volumeControl();

  root.replaceChildren(
    h(
      'div.pb',
      null,
      h('div.pb-progress', { 'aria-hidden': 'true' }, fill),
      main,
      h('div.pb-center', null, h('div.pb-controls', null, dShuffle, dPrev, dPlay, dNext, dRepeat), scrub.el),
      h('div.pb-actions', null, play, next),
      h(
        'div.pb-right',
        null,
        iconButton('queue', 'Up next', () => openNowPlaying({ queue: true }), { size: 22 }),
        vol.el,
        iconButton('expand', 'Open now playing', () => openNowPlaying(), { size: 20 }),
      ),
    ),
  );

  const onTrack = () => {
    const t = player.current;
    document.body.classList.toggle('no-player', !t);
    if (!t) return;
    artBox.replaceChildren(art(t.thumb, { size: 64, fallback: 'note' }));
    artistEl.textContent = t.artist;
    titleEl.textContent = t.title;
    main.setAttribute('aria-label', `Now playing: ${t.title} by ${t.artist}. Open player.`);
  };
  const onState = () => {
    setPlayButton(play, 32);
    setPlayButton(dPlay, 22);
  };
  const onTime = () => {
    const d = player.duration;
    fill.style.transform = `scaleX(${d ? Math.min(1, player.time / d) : 0})`;
    scrub.update();
  };
  const onMode = () => setModeButtons(dShuffle, dRepeat, 20);

  player.addEventListener('track', onTrack);
  player.addEventListener('state', onState);
  player.addEventListener('time', onTime);
  player.addEventListener('mode', onMode);
  player.addEventListener('playerror', (e) => toast(`Can't play “${e.detail.track.title}”.${player.nextIndex() !== -1 ? ' Skipping.' : ''}`));
  onTrack();
  onState();
  onTime();
  onMode();
}

// ---------- Now Playing ----------

let np = null;

export function openNowPlaying({ queue = false } = {}) {
  if (!player.current) return;
  np ||= buildNowPlaying();
  np.showQueue(queue);
  if (np.isOpen) return;
  np.isOpen = true;
  np.render();
  np.root.hidden = false;
  document.body.classList.add('np-open');
  requestAnimationFrame(() => requestAnimationFrame(() => np.root.classList.add('open')));
  np.root.querySelector('.np-close')?.focus({ preventScroll: true });
  pushOverlay(() => {
    np.isOpen = false;
    np.root.classList.remove('open');
    np.root.style.transform = '';
    document.body.classList.remove('np-open');
    setTimeout(() => !np.isOpen && (np.root.hidden = true), 320);
  });
}

function buildNowPlaying() {
  const fromTitle = h('a.np-from-title');
  const artBox = h('div.np-art');
  const title = h('div.np-title');
  const artist = h('a.np-artist');
  const format = h('div.np-format');
  const scrub = scrubber('.np-scrub');
  const shuffle = iconButton('shuffle', 'Shuffle', () => player.setShuffle(!player.shuffle), { size: 24, cls: 'mode-btn' });
  const prev = iconButton('prev', 'Previous track', () => player.prev(), { size: 34 });
  const play = iconButton('play', 'Play', () => player.toggle(), { size: 36, cls: 'np-play' });
  const next = iconButton('next', 'Next track', () => player.next(), { size: 34 });
  const repeat = iconButton('repeat', 'Repeat', () => player.cycleRepeat(), { size: 24, cls: 'mode-btn' });
  const queueBtn = h('button.np-pill', { type: 'button', 'aria-pressed': 'false', onclick: () => showQueue(!root.classList.contains('show-queue')) }, icon('queue', 20), h('span', null, 'Up next'));
  const similarBtn = h('button.np-pill', { type: 'button', onclick: () => player.current && similarRadio(player.current) }, icon('radio', 20), h('span', null, 'Similar'));
  const vol = volumeControl();
  const queueList = h('div.tracks.np-queue-list');
  const queueCount = h('span.np-queue-count');

  const top = h(
    'header.np-top',
    null,
    iconButton('chevronDown', 'Close now playing', () => popOverlay(), { size: 30, cls: 'np-close' }),
    h('div.np-from', null, h('div.np-from-k', null, 'Playing from'), fromTitle),
    iconButton('more', 'More options', () => player.current && trackMenu(player.current), { size: 26 }),
  );

  const mainCol = h(
    'div.np-main',
    null,
    artBox,
    h('div.np-meta', null, title, artist, format),
    scrub.el,
    h('div.np-controls', null, shuffle, prev, play, next, repeat),
    h('div.np-extras', null, queueBtn, similarBtn, vol.el),
  );
  const queuePanel = h(
    'section.np-queue',
    { 'aria-label': 'Up next' },
    h('div.np-queue-head', null, h('h2', null, 'Up next'), queueCount, h('button.link-btn', { type: 'button', onclick: () => player.clearUpcoming() }, 'Clear')),
    queueList,
  );
  const root = h('div.np', { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Now playing', hidden: true }, h('div.np-shade'), top, h('div.np-body', null, mainCol, queuePanel));
  document.getElementById('overlay-root').append(root);

  function showQueue(on) {
    root.classList.toggle('show-queue', on);
    queueBtn.setAttribute('aria-pressed', String(on));
    if (on) renderQueue();
  }

  function renderTrack() {
    const t = player.current;
    if (!t) {
      if (state.isOpen) popOverlay();
      return;
    }
    artBox.replaceChildren(art(t.thumb, { size: 640, fallback: 'note' }));
    title.textContent = t.title;
    artist.textContent = t.artist;
    if (t.artistId) artist.setAttribute('href', `#/artist/${t.artistId}`);
    else artist.removeAttribute('href');
    const c = player.context;
    fromTitle.textContent = c?.title || t.album;
    const href = c?.href || (t.albumId ? `/album/${t.albumId}` : null);
    if (href) fromTitle.setAttribute('href', `#${href}`);
    else fromTitle.removeAttribute('href');
    renderFormat(t);
  }

  let formatToken = 0;
  async function renderFormat(t) {
    const mine = ++formatToken;
    if (player.transcoding) {
      const q = app.settings.quality;
      format.textContent = `Converted by your server, ${q === 'original' ? 320 : q} kbps`;
      return;
    }
    format.textContent = [fmt.codec(t.codec), t.bitrate ? `${fmt.number(t.bitrate)} kbps` : ''].filter(Boolean).join(' ');
    try {
      const detail = await app.server.trackDetail(t.id);
      if (mine !== formatToken) return;
      const streams = detail?.Media?.[0]?.Part?.[0]?.Stream || [];
      const a = streams.find((s) => s.streamType === 2) || {};
      const bits = a.bitDepth ? `${a.bitDepth}-bit` : '';
      const rate = a.samplingRate ? `${(a.samplingRate / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} kHz` : '';
      if (bits || rate) format.textContent = [fmt.codec(a.codec || t.codec), bits, rate].filter(Boolean).join(' ');
    } catch {
      /* keep the basic line */
    }
  }

  function renderQueue() {
    if (!root.classList.contains('show-queue') && !window.matchMedia('(min-width: 960px)').matches) return;
    const from = player.index;
    const items = player.queue.slice(from, from + 200);
    queueCount.textContent = player.upcoming.length ? fmt.count(player.upcoming.length, 'track', 'tracks') : '';
    queueList.replaceChildren(
      ...items.map((t, i) =>
        trackRow(t, {
          showArt: true,
          queueIndex: from + i,
          subtitle: t.artist,
          onPlay: () => player.jump(from + i),
        }),
      ),
    );
    if (items.length <= 1) queueList.append(h('p.np-queue-empty', null, 'Nothing else queued. Play similar tracks or add music from your library.'));
  }

  const state = {
    root,
    isOpen: false,
    showQueue,
    render() {
      renderTrack();
      renderQueue();
      setPlayButton(play, 36);
      setModeButtons(shuffle, repeat, 24);
      scrub.update();
    },
  };

  player.addEventListener('track', () => state.isOpen && (renderTrack(), renderQueue()));
  player.addEventListener('queue', () => state.isOpen && renderQueue());
  player.addEventListener('state', () => setPlayButton(play, 36));
  player.addEventListener('mode', () => setModeButtons(shuffle, repeat, 24));
  player.addEventListener('time', () => state.isOpen && scrub.update());
  enableGestures(root, artBox, top);
  return state;
}

// Drag the player down to close it; swipe the artwork sideways to skip.
function enableGestures(root, artBox, top) {
  let start = null;
  let axis = null;
  const down = (e) => {
    if (e.pointerType === 'mouse' || e.target.closest('button, a, input')) return;
    start = { x: e.clientX, y: e.clientY, onArt: artBox.contains(e.target) };
    axis = null;
  };
  const move = (e) => {
    if (!start) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    if (!axis && Math.hypot(dx, dy) > 10) axis = Math.abs(dy) > Math.abs(dx) ? 'y' : 'x';
    if (axis === 'y' && dy > 0) {
      root.style.transition = 'none';
      root.style.transform = `translateY(${dy}px)`;
    } else if (axis === 'x' && start.onArt) {
      artBox.style.transform = `translateX(${dx * 0.6}px)`;
    }
  };
  const up = (e) => {
    if (!start) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    root.style.transition = '';
    artBox.style.transform = '';
    if (axis === 'y' && dy > 110) {
      root.style.transform = '';
      popOverlay();
    } else {
      root.style.transform = '';
      if (axis === 'x' && start.onArt && Math.abs(dx) > 70) dx < 0 ? player.next() : player.prev();
    }
    start = null;
  };
  for (const el of [top, artBox]) el.addEventListener('pointerdown', down);
  window.addEventListener('pointermove', move, { passive: true });
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
}
