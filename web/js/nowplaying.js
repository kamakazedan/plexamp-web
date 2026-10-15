// The player bar (mini player on phones, full transport on desktop) and the
// full-screen Now Playing view with its "Up next" queue.
import { app } from './state.js';
import { player } from './player.js';
import { pushOverlay, popOverlay, describeError } from './router.js';
import { h, icon, iconButton, art, fmt, toast, sheet } from './ui.js';
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
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      np.root.classList.add('open');
      np.wave.redraw();
    }),
  );
  np.root.querySelector('.np-grabber')?.focus({ preventScroll: true });
  pushOverlay(() => {
    np.isOpen = false;
    np.root.classList.remove('open');
    np.root.style.transform = '';
    document.body.classList.remove('np-open');
    setTimeout(() => !np.isOpen && (np.root.hidden = true), 320);
  });
}

const kHz = (hz) => (hz / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 });

function toolButton(name, label, onClick, tool) {
  return h('button.np-tool', { type: 'button', 'aria-label': label, title: label, onclick: onClick, dataset: { tool } }, icon(name, 26));
}

function setToggle(btn, on, label) {
  btn.classList.toggle('on', on);
  btn.setAttribute('aria-pressed', String(on));
  if (label) {
    btn.setAttribute('aria-label', label);
    btn.title = label;
  }
}

// Turn Plex loudness samples (dB) into bar heights between 0 and 1. Quiet
// passages pinch the shape, the loud body of a track sits near the top.
function normaliseLevels(values) {
  const v = (values || []).filter(Number.isFinite);
  if (v.length < 8) return null;
  const sorted = [...v].sort((a, b) => a - b);
  const lo = Math.max(sorted[Math.floor(sorted.length * 0.05)], -60);
  const hi = sorted[sorted.length - 1];
  const span = Math.max(6, hi - lo);
  return v.map((x) => 0.06 + 0.94 * Math.min(1, Math.max(0, (x - lo) / span)) ** 0.8);
}

function roundedBar(ctx, x, y, w, hgt, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, hgt, r);
  else ctx.rect(x, y, w, hgt);
}

// Seek bar drawn from the server's loudness analysis, with a plain bar for
// tracks that haven't been analysed. A transparent range input on top keeps
// it usable with touch, mouse, keyboard and screen readers.
function waveform() {
  const canvas = h('canvas', { 'aria-hidden': 'true' });
  const input = h('input', { type: 'range', min: 0, max: 1000, step: 1, value: 0, 'aria-label': 'Playback position' });
  const cur = h('span.wave-time', null, '0:00');
  const total = h('span.wave-time.wave-total', null, '0:00');
  const track = h('div.wave-track', null, canvas, input);
  let levels = null;
  let progress = 0;
  let dragging = false;
  let frame = 0;

  function draw() {
    frame = 0;
    const w = track.clientWidth;
    const ht = track.clientHeight;
    if (!w || !ht) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const cw = Math.round(w * dpr);
    const ch = Math.round(ht * dpr);
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw;
      canvas.height = ch;
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, ht);
    const played = getComputedStyle(document.documentElement).getPropertyValue('--tint-hi').trim() || '#a3b65a';
    const mid = ht / 2;
    const x = Math.max(0, Math.min(w, progress * w));

    if (levels) {
      const n = levels.length;
      const half = mid - 1;
      const shape = new Path2D();
      for (let i = 0; i < n; i++) {
        const px = (i / (n - 1)) * w;
        const py = mid - levels[i] * half;
        if (i) shape.lineTo(px, py);
        else shape.moveTo(px, py);
      }
      for (let i = n - 1; i >= 0; i--) shape.lineTo((i / (n - 1)) * w, mid + levels[i] * half);
      shape.closePath();
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, x, ht);
      ctx.clip();
      ctx.fillStyle = played;
      ctx.fill(shape);
      ctx.restore();
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, 0, w - x, ht);
      ctx.clip();
      ctx.fillStyle = 'rgba(255, 255, 255, 0.2)';
      ctx.fill(shape);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
      ctx.fillRect(x, mid - 0.75, w - x, 1.5);
      ctx.restore();
    } else {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
      roundedBar(ctx, 0, mid - 2, w, 4, 2);
      ctx.fill();
      ctx.fillStyle = played;
      roundedBar(ctx, 0, mid - 2, Math.max(4, x), 4, 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(Math.min(Math.max(x, 7), w - 7), mid, 7, 0, Math.PI * 2);
      ctx.fillStyle = '#fff';
      ctx.fill();
    }
  }

  const redraw = () => {
    if (!frame) frame = requestAnimationFrame(draw);
  };

  input.addEventListener('input', () => {
    dragging = true;
    progress = input.value / 1000;
    cur.textContent = fmt.clock(progress * player.duration);
    redraw();
  });
  input.addEventListener('change', () => {
    dragging = false;
    player.seek(progress * player.duration);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    player.seek(player.time + (e.key === 'ArrowRight' ? 5 : -5));
  });
  if ('ResizeObserver' in window) new ResizeObserver(redraw).observe(track);
  document.addEventListener('tintchange', redraw);

  return {
    el: h('div.np-wave', null, cur, track, total),
    redraw,
    setLevels(values) {
      levels = normaliseLevels(values);
      track.classList.toggle('has-levels', !!levels);
      redraw();
    },
    update() {
      if (dragging) return;
      const d = player.duration;
      const t = player.time;
      progress = d ? Math.min(1, t / d) : 0;
      input.value = Math.round(progress * 1000);
      input.setAttribute('aria-valuetext', `${fmt.clock(t)} of ${fmt.clock(d)}`);
      cur.textContent = fmt.clock(t);
      total.textContent = fmt.clock(d);
      redraw();
    },
  };
}

// Five stars mapped onto Plex's 0–10 rating. Tapping the current rating clears it.
function ratingStars() {
  let value = 0;
  const buttons = [1, 2, 3, 4, 5].map((n) =>
    h('button.star', { type: 'button', 'aria-label': `Rate ${n} star${n > 1 ? 's' : ''}`, onclick: () => choose(n) }, icon('star', 24)),
  );
  const paint = () =>
    buttons.forEach((b, i) => {
      b.classList.toggle('on', i < value);
      b.setAttribute('aria-pressed', String(i === value - 1));
    });
  async function choose(n) {
    const t = player.current;
    if (!t || !app.server) return;
    const before = value;
    value = n === value ? 0 : n;
    paint();
    try {
      const rating = value ? value * 2 : null;
      await app.server.rate(t.id, rating);
      t.userRating = rating;
    } catch (err) {
      value = before;
      paint();
      toast(`Couldn't save the rating. ${describeError(err)}`);
    }
  }
  return {
    el: h('div.np-stars', { role: 'group', 'aria-label': 'Rating' }, buttons),
    set(rating) {
      value = Math.max(0, Math.min(5, Math.round((rating || 0) / 2)));
      paint();
    },
  };
}

function openSleepSheet() {
  const mins = player.sleepAt ? Math.max(1, Math.round((player.sleepAt - Date.now()) / 60000)) : 0;
  sheet({
    title: 'Sleep timer',
    subtitle: player.sleepEndOfTrack
      ? 'Stops at the end of this track'
      : mins
        ? `Stops in ${fmt.count(mins, 'minute', 'minutes')}`
        : 'Pause playback after a set time',
    actions: [
      ...[15, 30, 45, 60].map((m) => ({
        label: `${m} minutes`,
        onSelect: () => {
          player.setSleep(m);
          toast(`Sleep timer set for ${m} minutes`);
        },
      })),
      {
        label: 'End of this track',
        onSelect: () => {
          player.setSleep('track');
          toast('Playback will stop at the end of this track');
        },
      },
      player.sleepActive && {
        icon: 'close',
        label: 'Turn off sleep timer',
        onSelect: () => {
          player.setSleep(null);
          toast('Sleep timer off');
        },
      },
    ],
  });
}

function buildNowPlaying() {
  const artBox = h('div.np-art');
  const wave = waveform();
  const artist = h('a.np-artist');
  const title = h('div.np-title');
  const album = h('a.np-album');
  const codec = h('span.np-codec');
  const quality = h('span.np-quality');
  const stars = ratingStars();
  const prev = iconButton('prev', 'Previous track', () => player.prev(), { size: 40, cls: 'np-skip' });
  const play = iconButton('play', 'Play', () => player.toggle(), { size: 38, cls: 'np-play' });
  const next = iconButton('next', 'Next track', () => player.next(), { size: 40, cls: 'np-skip' });

  const queueBtn = toolButton('queue', 'Up next', () => showQueue(!root.classList.contains('show-queue')), 'queue');
  const radioBtn = toolButton('radio', 'Play similar tracks', () => player.current && similarRadio(player.current), 'radio');
  const shuffleBtn = toolButton('shuffle', 'Shuffle', () => player.setShuffle(!player.shuffle), 'shuffle');
  const moreBtn = toolButton('more', 'More options', () => player.current && trackMenu(player.current), 'more');
  const repeatBtn = toolButton('repeat', 'Repeat', () => player.cycleRepeat(), 'repeat');
  const sleepBtn = toolButton('moon', 'Sleep timer', openSleepSheet, 'sleep');
  const vol = volumeControl();

  const queueList = h('div.tracks.np-queue-list');
  const queueCount = h('span.np-queue-count');
  const queueFrom = h('div.np-queue-from');

  const grabber = h('button.np-grabber', { type: 'button', 'aria-label': 'Close now playing', onclick: () => popOverlay() }, h('span'));
  const close = iconButton('chevronDown', 'Close now playing', () => popOverlay(), { size: 30, cls: 'np-close' });

  const toolbar = h(
    'div.np-toolbar',
    null,
    h('div.np-tools-side', null, queueBtn, radioBtn, shuffleBtn),
    moreBtn,
    h('div.np-tools-side.np-tools-right', null, repeatBtn, sleepBtn, vol.el),
  );
  const main = h(
    'div.np-main',
    null,
    artBox,
    h(
      'div.np-lower',
      null,
      wave.el,
      h('div.np-meta', null, artist, title, album),
      h('div.np-info', null, codec, stars.el, quality),
      h('div.np-transport', null, prev, play, next),
    ),
    toolbar,
  );
  const queuePanel = h(
    'section.np-queue',
    { 'aria-label': 'Up next' },
    h(
      'div.np-queue-head',
      null,
      h('h2', null, 'Up next'),
      queueCount,
      h('button.link-btn', { type: 'button', onclick: () => player.clearUpcoming() }, 'Clear'),
      iconButton('chevronDown', 'Hide up next', () => showQueue(false), { size: 24, cls: 'np-queue-hide' }),
    ),
    queueFrom,
    queueList,
  );
  const root = h(
    'div.np',
    { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Now playing', hidden: true },
    h('div.np-shade'),
    grabber,
    close,
    h('div.np-body', null, main, queuePanel),
  );
  document.getElementById('overlay-root').append(root);

  function showQueue(on) {
    root.classList.toggle('show-queue', on);
    setToggle(queueBtn, on);
    if (on) renderQueue();
  }

  let detailToken = 0;
  async function loadDetail(t) {
    const mine = ++detailToken;
    wave.setLevels(null);
    stars.set(t.userRating);
    codec.textContent = fmt.codec(t.codec);
    const q = app.settings.quality;
    const converted = player.transcoding ? `${q === 'original' ? 320 : q} kbps` : '';
    quality.textContent = converted || (t.bitrate && !['flac', 'alac', 'wav', 'pcm'].includes(t.codec) ? `${fmt.number(t.bitrate)} kbps` : '');
    quality.title = converted ? 'Converted by your server' : '';
    try {
      const d = await app.server.trackDetail(t.id);
      if (mine !== detailToken || !d) return;
      const a = (d.Media?.[0]?.Part?.[0]?.Stream || []).find((s) => s.streamType === 2) || {};
      codec.textContent = fmt.codec(a.codec || t.codec);
      if (!converted) {
        if (a.samplingRate && a.bitDepth) quality.textContent = `${kHz(a.samplingRate)} / ${a.bitDepth}`;
        else if (a.samplingRate && !t.bitrate) quality.textContent = `${kHz(a.samplingRate)} kHz`;
      }
      if (d.userRating !== undefined) stars.set(d.userRating);
      if (!t.year && d.parentYear) album.textContent = `${t.album} (${d.parentYear})`;
      if (a.id) {
        const values = await app.server.levels(a.id);
        if (mine === detailToken) wave.setLevels(values);
      }
    } catch {
      /* keep the basic details */
    }
  }

  function renderTrack() {
    const t = player.current;
    if (!t) {
      if (state.isOpen) popOverlay();
      return;
    }
    artBox.replaceChildren(art(t.thumb, { size: 720, fallback: 'note' }));
    artist.textContent = t.artist;
    if (t.artistId) artist.setAttribute('href', `#/artist/${t.artistId}`);
    else artist.removeAttribute('href');
    title.textContent = t.title;
    album.textContent = t.year ? `${t.album} (${t.year})` : t.album;
    if (t.albumId) album.setAttribute('href', `#/album/${t.albumId}`);
    else album.removeAttribute('href');
    const c = player.context;
    const href = c?.href || (t.albumId ? `/album/${t.albumId}` : null);
    queueFrom.replaceChildren('Playing from ', href ? h('a', { href: `#${href}` }, c?.title || t.album) : c?.title || t.album);
    loadDetail(t);
    wave.update();
  }

  function renderModes() {
    setToggle(shuffleBtn, player.shuffle);
    repeatBtn.replaceChildren(icon(player.repeat === 'one' ? 'repeatOne' : 'repeat', 26));
    setToggle(repeatBtn, player.repeat !== 'off', { off: 'Repeat: off', all: 'Repeat: all', one: 'Repeat: this track' }[player.repeat]);
    setToggle(sleepBtn, player.sleepActive, player.sleepActive ? 'Sleep timer (on)' : 'Sleep timer');
  }

  function renderQueue() {
    if (!root.classList.contains('show-queue') && !window.matchMedia('(min-width: 960px)').matches) return;
    const from = player.index;
    const items = player.queue.slice(from, from + 200);
    queueCount.textContent = player.upcoming.length ? fmt.count(player.upcoming.length, 'track', 'tracks') : '';
    queueList.replaceChildren(
      ...items.map((t, i) => trackRow(t, { showArt: true, queueIndex: from + i, subtitle: t.artist, onPlay: () => player.jump(from + i) })),
    );
    if (items.length <= 1) queueList.append(h('p.np-queue-empty', null, 'Nothing else queued. Play similar tracks or add music from your library.'));
  }

  const state = {
    root,
    wave,
    isOpen: false,
    showQueue,
    render() {
      renderTrack();
      renderQueue();
      setPlayButton(play, 38);
      renderModes();
      wave.update();
    },
  };

  player.addEventListener('track', () => state.isOpen && (renderTrack(), renderQueue()));
  player.addEventListener('queue', () => state.isOpen && renderQueue());
  player.addEventListener('state', () => setPlayButton(play, 38));
  player.addEventListener('mode', renderModes);
  player.addEventListener('sleep', renderModes);
  player.addEventListener('time', () => state.isOpen && wave.update());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.isOpen && !document.querySelector('.sheet')) popOverlay();
  });
  enableGestures(root, artBox, grabber);
  return state;
}

// Drag the player down to close it; swipe the artwork sideways to skip.
function enableGestures(root, artBox, handle) {
  let start = null;
  let axis = null;
  const down = (e) => {
    if (e.pointerType === 'mouse') return;
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
    root.style.transform = '';
    artBox.style.transform = '';
    if (axis === 'y' && dy > 110) popOverlay();
    else if (axis === 'x' && start.onArt && Math.abs(dx) > 70) dx < 0 ? player.next() : player.prev();
    start = null;
  };
  for (const el of [handle, artBox]) el.addEventListener('pointerdown', down);
  window.addEventListener('pointermove', move, { passive: true });
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
}
