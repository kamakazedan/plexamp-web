// The player bar (mini player on phones, full transport on desktop) and the
// full-screen Now Playing view with its "Up next" queue.
import { app, on } from './state.js';
import { player } from './player.js';
import { pushOverlay, popOverlay, describeError, navigate } from './router.js';
import { canPlayCodec } from './plex.js';
import { h, icon, iconButton, art, avatar, skipIcon, fmt, toast, sheet } from './ui.js';
import { trackMenu, queueMenu } from './actions.js';
import { trackRow } from './components.js';
import { guestDJ, DJS, djName } from './dj.js';
import { aiReady } from './ai.js';
import { live } from './live.js';
import { together } from './together.js';
import { levelSamples } from './transitions.js';
import { cast, openCastSheet, castLabel } from './cast.js';
import { devices } from './devices.js';
import { rateTrack, ratingEvents, ratingMode, LOVED, LOVED_TITLE } from './ratings.js';

const SPEEDS = [0.5, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];

// Things that work differently in a Play Together session.
function sessionOnly(what) {
  toast(`${what} isn’t available while listening together.`);
}

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
  const shuffleLabel = player.remote ? 'Shuffle up next for everyone' : 'Shuffle';
  shuffleBtn.setAttribute('aria-label', shuffleLabel);
  shuffleBtn.title = shuffleLabel;
  setIcon(repeatBtn, player.repeat === 'one' ? 'repeatOne' : 'repeat', size);
  repeatBtn.classList.toggle('on', player.repeat !== 'off');
  repeatBtn.classList.toggle('unavailable', !!player.remote);
  const label = player.remote ? 'Repeat (not available while listening together)' : { off: 'Repeat: off', all: 'Repeat: all', one: 'Repeat: this track' }[player.repeat];
  repeatBtn.setAttribute('aria-label', label);
  repeatBtn.title = label;
}

// The cast button: lit, and saying where, while it plays somewhere else.
function paintCast(btn, size) {
  const where = devices.playingOn || castLabel();
  btn.replaceChildren(icon(where ? 'casting' : 'cast', size));
  btn.classList.toggle('on', !!where);
  btn.setAttribute('aria-pressed', String(!!where));
  const label = where ? `Playing on ${where}` : 'Play on…';
  btn.setAttribute('aria-label', label);
  btn.title = label;
}

function cycleRepeat() {
  if (!player.cycleRepeat()) sessionOnly('Repeat');
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

// The speaker shows fewer sound waves as the volume goes down: under 75%,
// 50% and 25%.
function volumeIcon(v, muted) {
  if (muted || v <= 0) return 'speakerOff';
  if (v < 0.25) return 'speaker0';
  if (v < 0.5) return 'speaker1';
  if (v < 0.75) return 'speaker2';
  return 'speaker3';
}

const VOLUME_MARKS = [25, 50, 75];

// Volume slider with marks at 25, 50 and 75%. While dragging, it settles on
// a mark within 2% of it (the arrow keys still move 1% at a time), and the
// level shows above the handle.
function volumeControl() {
  // While another of your devices plays, this one is muted: its speaker
  // moves the music here ("Listen here"), and the slider sets that
  // device's volume.
  const btn = iconButton('speaker3', 'Mute', () => (devices.isRemote ? devices.takeOver() : player.toggleMute()), { size: 22 });
  const input = h('input.scrub.vol', { type: 'range', min: 0, max: 100, step: 1, 'aria-label': 'Volume' });
  const tip = h('span.vol-tip', { 'aria-hidden': 'true' }, '100%');
  const marks = h(
    'span.vol-marks',
    { 'aria-hidden': 'true' },
    VOLUME_MARKS.map((m) => {
      const tick = h('i');
      tick.style.setProperty('--m', String(m / 100));
      return tick;
    }),
  );
  const slider = h('div.vol-slider', null, marks, input, tip);
  const el = h('div.volume', null, btn, slider);
  let dragging = false;
  let fade = 0;

  const paint = (pct) => {
    input.style.setProperty('--p', `${pct}%`);
    slider.style.setProperty('--pv', String(pct / 100));
    tip.textContent = `${pct}%`;
    input.setAttribute('aria-valuetext', `${pct}%`);
    input.title = `Volume ${pct}%`;
  };
  // The level stays up a moment after a change (keys, wheel or a drag).
  const flash = () => {
    el.classList.add('adjusting');
    clearTimeout(fade);
    fade = setTimeout(() => !dragging && el.classList.remove('adjusting'), 900);
  };
  input.addEventListener('pointerdown', () => {
    dragging = true;
    el.classList.add('adjusting');
  });
  const release = () => {
    if (!dragging) return;
    dragging = false;
    flash();
  };
  input.addEventListener('pointerup', release);
  input.addEventListener('pointercancel', release);
  input.addEventListener('lostpointercapture', release);
  input.addEventListener('input', () => {
    let v = Number(input.value);
    const mark = dragging ? VOLUME_MARKS.find((m) => Math.abs(v - m) <= 2) : undefined;
    if (mark !== undefined && v !== mark) {
      v = mark;
      input.value = String(mark);
    }
    player.setVolume(v / 100);
    paint(v);
    flash();
  });
  const update = () => {
    const v = player.muted ? 0 : player.volume;
    const pct = Math.round(v * 100);
    input.value = String(pct);
    paint(pct);
    const elsewhere = devices.isRemote;
    const level = elsewhere ? 'speakerOff' : volumeIcon(v, player.muted);
    setIcon(btn, level, 22);
    btn.dataset.level = level;
    btn.classList.toggle('listen-here', elsewhere);
    const label = elsewhere ? `Listen here (playing on ${devices.playingOn})` : player.muted ? 'Unmute' : 'Mute';
    btn.setAttribute('aria-label', label);
    btn.title = label;
    input.setAttribute('aria-label', elsewhere ? `Volume on ${devices.playingOn}` : 'Volume');
  };
  update();
  player.addEventListener('volume', update);
  devices.addEventListener('change', update);
  return { el, update };
}

// ---------- player bar ----------

export function initPlayerBar(root) {
  const fill = h('div.pb-progress-fill');
  const artBox = h('div.pb-art');
  const artistEl = h('div.pb-artist');
  const titleEl = h('div.pb-title');
  // "Playing on Dan's Mac", in place of the artist, while it plays elsewhere.
  const whereEl = h('div.pb-where', { hidden: true });
  const main = h(
    'button.pb-main',
    { type: 'button', 'aria-label': 'Open now playing', onclick: () => openNowPlaying() },
    artBox,
    h('div.pb-text', null, artistEl, whereEl, titleEl),
  );

  const here = iconButton('speakerOff', 'Listen here', () => devices.takeOver(), { size: 26, cls: 'pb-here' });
  here.hidden = true;
  const play = iconButton('play', 'Play', () => player.toggle(), { size: 32, cls: 'pb-play' });
  const next = iconButton('next', 'Next track', () => player.next(), { size: 28, cls: 'pb-next' });

  const dShuffle = iconButton('shuffle', 'Shuffle', () => player.setShuffle(!player.shuffle), { size: 20, cls: 'mode-btn' });
  const dPrev = iconButton('prev', 'Previous track', () => player.prev(), { size: 22 });
  const dPlay = iconButton('play', 'Play', () => player.toggle(), { size: 22, cls: 'pb-dplay' });
  const dNext = iconButton('next', 'Next track', () => player.next(), { size: 22 });
  const dRepeat = iconButton('repeat', 'Repeat', cycleRepeat, { size: 20, cls: 'mode-btn' });
  const scrub = scrubber('.pb-scrub');
  const vol = volumeControl();
  const dCast = iconButton('cast', 'Play on…', openCastSheet, { size: 20, cls: 'mode-btn pb-cast' });

  root.replaceChildren(
    h(
      'div.pb',
      null,
      h('div.pb-progress', { 'aria-hidden': 'true' }, fill),
      main,
      h('div.pb-center', null, h('div.pb-controls', null, dShuffle, dPrev, dPlay, dNext, dRepeat), scrub.el),
      h('div.pb-actions', null, here, play, next),
      h(
        'div.pb-right',
        null,
        iconButton('queue', 'Up next', () => openNowPlaying({ queue: true }), { size: 22 }),
        dCast,
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
  const onMode = () => {
    setModeButtons(dShuffle, dRepeat, 20);
    paintCast(dCast, 20);
    const where = devices.playingOn || castLabel();
    whereEl.hidden = !where;
    artistEl.hidden = !!where;
    if (where) whereEl.replaceChildren(icon(cast.active || devices.isRemote ? 'casting' : 'airplay', 16), h('span', null, `Playing on ${where}`));
    here.hidden = !devices.isRemote;
    if (devices.isRemote) {
      here.title = `Listen here (playing on ${devices.playingOn})`;
      here.setAttribute('aria-label', here.title);
    }
  };

  player.addEventListener('track', onTrack);
  player.addEventListener('state', onState);
  player.addEventListener('time', onTime);
  player.addEventListener('mode', onMode);
  cast.addEventListener('change', onMode);
  devices.addEventListener('change', onMode);
  player.addEventListener('playerror', (e) => {
    const { track, remote } = e.detail;
    if (remote) {
      toast(`Can’t play “${track.title}” on this device. You’ll hear the next track with everyone.`, { action: 'Try again', onAction: () => together.listen(), timeout: 7000 });
    } else {
      toast(`Can't play “${track.title}”.${player.nextIndex() !== -1 ? ' Skipping.' : ''}`);
    }
  });
  // "Show full player": open Now Playing when something new starts.
  player.addEventListener('started', () => app.settings.showFullPlayer && setTimeout(() => openNowPlaying(), 50));
  const onSettings = () => {
    vol.el.hidden = app.settings.showVolume === false;
  };
  on('settings', onSettings);
  onSettings();
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

const QUALITY_NAMES = { 320: 'High (320 kbps)', 192: 'Normal (192 kbps)', 128: 'Data saver (128 kbps)' };

// A track your server converts as it plays (Settings › Playback › Streaming
// quality, or a format this browser can't play): a mark by its bitrate
// saying so, and why, as its tooltip and, tapped (touch screens have no
// hover), in a message.
function convertedMark(t, q, kbps) {
  const format = fmt.codec(t.codec);
  const why =
    q !== 'original'
      ? `Converted to ${kbps} kbps by your server as it plays, as Streaming quality is set to ${QUALITY_NAMES[kbps] || `${kbps} kbps`} in Settings › Playback.${format ? ` The file is ${format}.` : ''}`
      : t.codec && !canPlayCodec(t.codec)
        ? `Converted to ${kbps} kbps by your server as it plays: this browser can’t play ${format} files as they are.`
        : `Converted to ${kbps} kbps by your server as it plays: the file didn’t play as it is here.`;
  return h(
    'button.np-converted',
    {
      type: 'button',
      title: why,
      'aria-label': why,
      onclick: (e) => {
        e.stopPropagation();
        toast(why, q === 'original' ? { timeout: 7000 } : { timeout: 7000, action: 'Settings', onAction: () => popOverlay().then(() => navigate('/settings/playback')) });
      },
    },
    icon('convert', 16),
  );
}

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
    const style = app.settings.seekbarStyle || 'smooth';

    if (levels && style === 'bars') {
      // One rounded bar per few pixels, sampled from the loudness curve.
      const step = 4;
      const n = Math.max(8, Math.floor(w / step));
      const half = mid - 1;
      for (let i = 0; i < n; i++) {
        const v = levels[Math.min(levels.length - 1, Math.floor((i / n) * levels.length))];
        const bh = Math.max(2, v * half * 2);
        const bx = i * step;
        ctx.fillStyle = bx + step / 2 <= x ? played : 'rgba(255, 255, 255, 0.28)';
        roundedBar(ctx, bx, mid - bh / 2, step - 1.5, bh, 1);
        ctx.fill();
      }
    } else if (levels && style === 'smooth') {
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

// Ratings on Plex's 0–10 scale, shown the way Settings › Experience says: a
// favourite tick (ticked is 10), five stars, thumbs up/down, or not at all.
// Tapping the current rating clears it.
function ratingControl() {
  let value = 0;
  const el = h('div.np-stars', { role: 'group', 'aria-label': 'Rating' });

  function paint() {
    const mode = ratingMode();
    el.hidden = mode === 'off';
    el.dataset.mode = mode;
    if (mode === 'tick') {
      const on = value === LOVED;
      const b = h(
        'button.np-fav',
        { type: 'button', 'aria-label': 'Favourite', title: on ? `Favourite: in ${LOVED_TITLE}` : `Favourite: add to ${LOVED_TITLE}`, 'aria-pressed': String(on), onclick: () => choose(on ? 0 : LOVED) },
        icon(on ? 'favourited' : 'favourite', 28),
      );
      b.classList.toggle('on', on);
      el.replaceChildren(b);
      return;
    }
    if (mode === 'thumbs') {
      const up = h('button.thumb', { type: 'button', 'aria-label': 'Thumbs up', 'aria-pressed': String(value >= 6), onclick: () => choose(value >= 6 ? 0 : 10) }, icon('thumbUp', 24));
      const down = h('button.thumb', { type: 'button', 'aria-label': 'Thumbs down', 'aria-pressed': String(value > 0 && value <= 4), onclick: () => choose(value > 0 && value <= 4 ? 0 : 2) }, icon('thumbDown', 24));
      up.classList.toggle('on', value >= 6);
      down.classList.toggle('on', value > 0 && value <= 4);
      el.replaceChildren(down, up);
      return;
    }
    el.replaceChildren(
      ...[1, 2, 3, 4, 5].map((n) => {
        const full = value >= n * 2;
        const b = h(`button.star${full ? '.on' : ''}`, { type: 'button', 'aria-label': `Rate ${n} star${n > 1 ? 's' : ''}`, 'aria-pressed': String(full && value < n * 2 + 2) }, icon('star', 24));
        b.addEventListener('click', () => choose(n * 2 === value ? 0 : n * 2));
        return b;
      }),
    );
  }

  async function choose(next) {
    const t = player.current;
    if (!t || !app.server) return;
    const before = value;
    value = next;
    paint();
    try {
      await rateTrack(t, value || null);
    } catch (err) {
      value = before;
      paint();
      toast(`Couldn't save the rating. ${describeError(err)}`);
    }
  }

  on('settings', paint);
  // Rated somewhere else in the app (a track list) while it's playing.
  ratingEvents.addEventListener('rated', (e) => {
    const t = player.current;
    if (!t || t.id !== e.detail.id) return;
    t.userRating = e.detail.rating;
    api.set(e.detail.rating);
  });
  const api = {
    el,
    set(rating) {
      const v = Math.max(0, Math.min(10, Math.round(rating || 0)));
      // Stars round to the nearest star (a half-star rating from another Plex
      // app); the tick and thumbs keep Plex's own value.
      value = ratingMode() === 'stars' ? Math.round(v / 2) * 2 : v;
      paint();
    },
  };
  return api;
}

function openSpeedSheet() {
  sheet({
    title: 'Playback speed',
    subtitle: 'For this device. Pitch stays the same.',
    actions: SPEEDS.map((v) => ({
      label: v === 1 ? 'Normal (1×)' : `${v}×`,
      checked: player.speed === v,
      onSelect: () => player.setSpeed(v),
    })),
  });
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

function openDJSheet() {
  if (player.remote) return sessionOnly('Guest DJ');
  const active = guestDJ.active;
  const ai = aiReady();
  sheet({
    title: 'Guest DJ',
    variant: 'dialog',
    actions: [
      active && {
        icon: 'close',
        label: 'Turn off Guest DJ',
        description: `${active.name} is choosing tracks now.`,
        onSelect: () => {
          const { removed, back } = guestDJ.set(null);
          toast(removed || back ? 'Guest DJ off. What’s to come is as it was before.' : 'Guest DJ off');
        },
      },
      // The AI DJ only where AI can be used; the "your queue" DJs after a
      // heading.
      ...DJS.filter((d) => !d.needsAI || ai).flatMap((d, i, all) => [
        d.kind === 'reorder' && all[i - 1]?.kind !== 'reorder' ? { heading: 'Only what’s in your queue: these add nothing new' } : null,
        {
          icon: 'dj',
          label: d.name,
          description: d.description,
          checked: active?.id === d.id,
          onSelect: () => {
            guestDJ.set(d.id);
            toast(`${d.name} is on`);
          },
        },
      ]),
    ],
  });
}

function buildNowPlaying() {
  const artBox = h('div.np-art');
  const wave = waveform();
  const artist = h('a.np-artist');
  const title = h('div.np-title');
  const album = h('a.np-album');
  const djNote = h('div.np-dj', { hidden: true });
  const codec = h('span.np-codec');
  const quality = h('span.np-quality');
  const stars = ratingControl();
  const prev = iconButton('prev', 'Previous track', () => player.prev(), { size: 40, cls: 'np-skip' });
  const play = iconButton('play', 'Play', () => player.toggle(), { size: 38, cls: 'np-play' });
  const next = iconButton('next', 'Next track', () => player.next(), { size: 40, cls: 'np-skip' });
  // Quick skip (and long-form) buttons, labelled with the chosen times.
  const back = h('button.icon-btn.np-jump', { type: 'button', onclick: () => player.skipBy(-(Number(app.settings.skipBack) || 10)) });
  const fwd = h('button.icon-btn.np-jump', { type: 'button', onclick: () => player.skipBy(Number(app.settings.skipForward) || 30) });

  const queueBtn = toolButton('queue', 'Up next', () => showQueue(!root.classList.contains('show-queue')), 'queue');
  const djBtn = toolButton('dj', 'Guest DJ', openDJSheet, 'dj');
  const shuffleBtn = toolButton('shuffle', 'Shuffle', () => player.setShuffle(!player.shuffle), 'shuffle');
  const moreBtn = toolButton('more', 'More options', () => player.current && trackMenu(player.current), 'more');
  const repeatBtn = toolButton('repeat', 'Repeat', cycleRepeat, 'repeat');
  const sleepBtn = toolButton('moon', 'Sleep timer', openSleepSheet, 'sleep');
  const speedBtn = toolButton('speed', 'Playback speed', openSpeedSheet, 'speed');
  const vol = volumeControl();
  // Who's listening, in a Play Together session.
  const listeners = h('button.np-listeners', {
    type: 'button',
    hidden: true,
    onclick: () => popOverlay().then(() => navigate('/together')),
  });
  const castBtn = toolButton('cast', 'Play on…', openCastSheet, 'cast');
  // Where it's playing, when that's not here.
  // Where it's playing, when that's not here; and, for another of your
  // devices, a way to listen here instead.
  const castChip = h('button.np-where-label', { type: 'button', onclick: openCastSheet });
  const hereBtn = h('button.np-where-here', { type: 'button', hidden: true, onclick: () => devices.takeOver() }, icon('speakerOff', 18), h('span', null, 'Listen here'));
  const whereBox = h('div.np-where', { hidden: true }, castChip, hereBtn);

  const queueList = h('div.tracks.np-queue-list');
  const queueCount = h('span.np-queue-count');
  const queueFrom = h('div.np-queue-from');

  const grabber = h('button.np-grabber', { type: 'button', 'aria-label': 'Close now playing', onclick: () => popOverlay() }, h('span'));
  const close = iconButton('chevronDown', 'Close now playing', () => popOverlay(), { size: 30, cls: 'np-close' });

  const toolbar = h(
    'div.np-toolbar',
    null,
    h('div.np-tools-side', null, queueBtn, djBtn, shuffleBtn),
    moreBtn,
    h('div.np-tools-side.np-tools-right', null, castBtn, repeatBtn, speedBtn, sleepBtn, vol.el),
  );
  const main = h(
    'div.np-main',
    null,
    artBox,
    h(
      'div.np-lower',
      null,
      wave.el,
      h('div.np-meta', null, artist, title, album, djNote, whereBox),
      h('div.np-info', null, codec, stars.el, quality),
      h('div.np-transport', null, back, prev, play, next, fwd),
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
      iconButton('more', 'Up next options', () => queueMenu(), { size: 24, cls: 'np-queue-more' }),
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
    listeners,
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
    const converted = player.transcoding;
    const kbps = q === 'original' ? 320 : Number(q) || 320;
    if (converted) quality.replaceChildren(convertedMark(t, q, kbps), `${kbps} kbps`);
    else quality.textContent = t.bitrate && !['flac', 'alac', 'wav', 'pcm'].includes(t.codec) ? `${fmt.number(t.bitrate)} kbps` : '';
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
      if (!t.year && d.parentYear && app.settings.showAlbumYear !== false) album.textContent = `${t.album} (${d.parentYear})`;
      if (a.id) {
        const values = await app.server.levels(a.id, levelSamples(t.duration));
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
    album.textContent = t.year && app.settings.showAlbumYear !== false ? `${t.album} (${t.year})` : t.album;
    if (t.albumId) album.setAttribute('href', `#/album/${t.albumId}`);
    else album.removeAttribute('href');
    // A DJ's pick, or a track a "your queue" DJ moved up.
    djNote.hidden = !t.dj && !t.djMoved;
    if (t.dj) djNote.replaceChildren(icon('dj', 16), h('span', null, t.djNote ? `${djName(t.dj)}: ${t.djNote}` : `Added by ${djName(t.dj)}`));
    else if (t.djMoved) djNote.replaceChildren(icon('dj', 16), h('span', null, `${djName(t.djMoved)} moved this up${t.djNote ? `: ${t.djNote}` : ''}`));
    const c = player.context;
    const href = c?.href || (t.albumId ? `/album/${t.albumId}` : null);
    queueFrom.replaceChildren('Playing from ', href ? h('a', { href: `#${href}` }, c?.title || t.album) : c?.title || t.album || '');
    loadDetail(t);
    wave.update();
  }

  function renderModes() {
    const remote = !!player.remote;
    setToggle(shuffleBtn, player.shuffle, remote ? 'Shuffle up next for everyone' : 'Shuffle');
    repeatBtn.replaceChildren(icon(player.repeat === 'one' ? 'repeatOne' : 'repeat', 26));
    setToggle(repeatBtn, player.repeat !== 'off', remote ? 'Repeat (not available while listening together)' : { off: 'Repeat: off', all: 'Repeat: all', one: 'Repeat: this track' }[player.repeat]);
    repeatBtn.classList.toggle('unavailable', remote);
    setToggle(sleepBtn, player.sleepActive, player.sleepActive ? 'Sleep timer (on)' : 'Sleep timer');
    sleepBtn.hidden = !app.settings.sleepTimer;
    const dj = guestDJ.active;
    setToggle(djBtn, !!dj, remote ? 'Guest DJ (not available while listening together)' : dj ? `Guest DJ: ${dj.name}` : 'Guest DJ');
    djBtn.classList.toggle('unavailable', remote);
    djBtn.classList.toggle('is-busy', guestDJ.busy);
    speedBtn.hidden = !app.settings.playbackSpeed || remote;
    setToggle(speedBtn, player.speed !== 1, player.speed !== 1 ? `Playback speed (${player.speed}×)` : 'Playback speed');
    vol.el.hidden = app.settings.showVolume === false;
    // The format and quality, and the rating, each if they're wanted.
    const info = main.querySelector('.np-info');
    const showCodec = app.settings.showCodec !== false;
    const showRating = app.settings.showRating !== false && ratingMode() !== 'off';
    info.hidden = !showCodec && !showRating;
    info.classList.toggle('no-codec', !showCodec);
    info.classList.toggle('no-rating', !showRating);
    // Skip buttons: "quick skip" always, "long-form" for long tracks.
    const skips = !!app.settings.quickSkip || (!!app.settings.longForm && player.isLongForm);
    back.hidden = fwd.hidden = !skips;
    const b = Number(app.settings.skipBack) || 10;
    const f = Number(app.settings.skipForward) || 30;
    back.replaceChildren(skipIcon(-1, b, 34));
    fwd.replaceChildren(skipIcon(1, f, 34));
    back.setAttribute('aria-label', `Back ${b} seconds`);
    fwd.setAttribute('aria-label', `Forward ${f} seconds`);
    back.title = back.getAttribute('aria-label');
    fwd.title = fwd.getAttribute('aria-label');
    renderListeners();
    renderCasting();
  }

  function renderCasting() {
    paintCast(castBtn, 26);
    const where = devices.playingOn || castLabel();
    whereBox.hidden = !where;
    hereBtn.hidden = !devices.isRemote;
    if (where) {
      castChip.replaceChildren(icon(cast.active || devices.isRemote ? 'casting' : 'airplay', 18), h('span', null, `Playing on ${where}`));
      castChip.setAttribute('aria-label', `Playing on ${where}. Choose where it plays.`);
    }
  }

  function renderListeners() {
    const s = together.active ? together.session : null;
    listeners.hidden = !s;
    if (!s) return;
    const others = s.members.filter((m) => m.id !== s.you);
    const names = others.map((m) => m.title);
    const text = !others.length ? 'Play Together: just you so far' : others.length === 1 ? `Listening with ${names[0]}` : `Listening with ${names[0]} and ${fmt.count(others.length - 1, 'other', 'others')}`;
    listeners.replaceChildren(h('span.np-listeners-faces', null, others.slice(0, 3).map((m) => avatar(m.thumb, m.title))), h('span', null, text));
    listeners.setAttribute('aria-label', `${text}. Open Play Together.`);
  }

  function renderQueue() {
    if (!root.classList.contains('show-queue') && !window.matchMedia('(min-width: 960px)').matches) return;
    const from = player.index;
    const items = player.queue.slice(from, from + 200);
    queueCount.textContent = player.upcoming.length ? fmt.count(player.upcoming.length, 'track', 'tracks') : '';
    const you = together.session?.you;
    const added = (t) => (t.addedBy ? `added by ${t.addedBy.id === you ? 'you' : t.addedBy.title}` : '');
    queueList.replaceChildren(
      ...items.map((t, i) =>
        trackRow(t, {
          showArt: true,
          queueIndex: from + i,
          subtitle: [t.artist, t.dj ? djName(t.dj) : t.djMoved ? `moved up by ${djName(t.djMoved)}` : added(t)].filter(Boolean).join(' · '),
          onPlay: () => player.jump(from + i),
        }),
      ),
    );
    if (items.length <= 1) {
      queueList.append(
        h('p.np-queue-empty', null, player.remote ? 'Nothing else queued. Anyone in the session can add music with Play next or Add to queue.' : 'Nothing else queued. Turn on a Guest DJ or add music from your library.'),
      );
    }
  }

  const state = {
    root,
    wave,
    isOpen: false,
    showQueue,
    reloadDetail: () => player.current && loadDetail(player.current),
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
  player.addEventListener('speed', renderModes);
  player.addEventListener('track', renderModes);
  guestDJ.addEventListener('change', renderModes);
  guestDJ.addEventListener('busy', renderModes);
  together.addEventListener('change', renderModes);
  cast.addEventListener('change', renderModes);
  devices.addEventListener('change', renderModes);
  on('settings', () => {
    renderModes();
    wave.redraw();
    if (state.isOpen && player.current) renderTrack();
  });
  // A rating or other change made in another Plex app shows up here.
  live.addEventListener('items', (e) => {
    const t = player.current;
    if (!t || !e.detail.ids.includes(String(t.id))) return;
    app.server?.cache.delete(`track:${t.id}`);
    if (state.isOpen) loadDetail(t);
  });
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
