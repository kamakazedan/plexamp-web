// Playback engine: queue, shuffle/repeat, gapless hand-off between two audio
// elements, server-side conversion fallback, lock-screen controls and play
// reporting back to Plex.
//
// In a Play Together session the queue belongs to the session: transport
// and queue changes are sent to it (this.remote), and its state comes back
// through syncRemote(), which keeps local playback on the session's clock.
import { app, on } from './state.js';
import { store, canPlayCodec, canPlayHlsNatively } from './plex.js';
import { shuffleArray } from './ui.js';
import { debugLog } from './debug.js';

const PRELOAD_AT = 25; // seconds before the end of a track
const SILENT_WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';
// Bundled into the image at a pinned version (see the Dockerfile), so no
// code is ever loaded from another site.
const HLS_JS = 'vendor/hls.min.js';
// Tracks at least this long count as long-form (DJ mixes, audiobooks).
export const LONG_FORM_MS = 20 * 60000;

let hlsLoader = null;
function loadHls() {
  if (window.Hls) return Promise.resolve(window.Hls);
  hlsLoader ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = HLS_JS;
    s.onload = () => (window.Hls ? resolve(window.Hls) : reject(new Error('Could not load the stream player.')));
    s.onerror = () => {
      hlsLoader = null;
      reject(new Error('Could not load the stream player.'));
    };
    document.head.append(s);
  });
  return hlsLoader;
}

let qidSeq = 1;
const withQid = (t) => ({ ...t, qid: qidSeq++ });
const resolve = (v) => (typeof v === 'function' ? v() : v);

// One <audio> element plus, when needed, an hls.js instance feeding it.
export class Deck {
  constructor() {
    this.el = new Audio();
    this.el.preload = 'auto';
    this.hls = null;
    this.qid = null;
    this.loadingQid = null;
    this.isHls = false;
    this.onFatal = null;
  }

  async load(url, isHls) {
    this.reset();
    this.isHls = isHls;
    if (isHls && !canPlayHlsNatively()) {
      const Hls = await loadHls();
      if (!Hls.isSupported()) throw new Error('This browser cannot play converted streams.');
      this.hls = new Hls({ maxBufferLength: 30 });
      this.hls.on(Hls.Events.ERROR, (_, data) => data?.fatal && this.onFatal?.());
      this.hls.loadSource(url);
      this.hls.attachMedia(this.el);
    } else {
      this.el.src = url;
      this.el.load();
    }
  }

  hasSource() {
    return !!(this.el.getAttribute('src') || this.hls);
  }

  reset() {
    if (this.hls) {
      this.hls.destroy();
      this.hls = null;
    }
    if (this.el.getAttribute('src') !== null) {
      this.el.removeAttribute('src');
      this.el.load();
    }
    this.qid = null;
    this.loadingQid = null;
    this.isHls = false;
  }
}

class Player extends EventTarget {
  constructor() {
    super();
    this.decks = [new Deck(), new Deck()];
    this.active = 0;
    this.queue = [];
    this.original = null; // unshuffled order
    this.index = -1;
    this.context = null; // { title, href } — "Playing from"
    this.shuffle = false;
    this.repeat = 'off'; // off | all | one
    this.state = 'idle'; // idle | loading | playing | paused
    this.volume = store.get('volume', 1);
    this.muted = false;
    this.speed = 1;
    this.transcoding = false;
    this.triedTranscode = false;
    this.errorsInRow = 0;
    this.restoredAt = 0;
    this.pendingSeek = null; // seconds, or a function returning seconds
    this.loadToken = 0;
    this.loadingQid = null;
    this.loadAutoplay = false;
    this.lastReport = 0;
    this.lastPersist = 0;
    this.lastPosState = 0;
    this.lastProgress = 0;
    this.timeQueued = false;
    this.unlocked = false;
    this.switching = false; // ignore the pause event fired while changing tracks
    this.sleepAt = null; // epoch ms when the sleep timer pauses playback
    this.sleepEndOfTrack = false;
    this.sleepTimer = null;
    // Play Together: the session's controls while in one, else null.
    this.remote = null;
    this.failedQid = null; // a session track this device couldn't play
    this.driftHold = 0;
    this.aheadOf = null;

    this.history = []; // ids of tracks played this session, oldest first (DJ modes avoid repeats)

    this.decks.forEach((d, i) => this.bind(d, i));
    this.addEventListener('track', () => {
      const t = this.current;
      if (!t || this.history[this.history.length - 1] === t.id) return;
      this.history.push(t.id);
      if (this.history.length > 300) this.history.splice(0, this.history.length - 300);
    });
    this.applyVolume();
    this.setupMediaSession();
    window.addEventListener('pagehide', () => {
      this.persist(true);
      this.saveProgress(true);
      if (this.state === 'playing') this.report('stopped', this.current, this.time, true);
    });
    on('source', ({ serverChanged }) => serverChanged && this.restore());
    on('signout', () => this.reset());
    on('settings', (s) => {
      if (!s.playbackSpeed && this.speed !== 1) this.setSpeed(1);
      this.setupMediaSession();
      this.updateMediaSession();
    });
    if (app.settings.playbackSpeed) this.speed = Number(app.settings.speed) || 1;
  }

  // ---------- getters ----------

  get deck() {
    return this.decks[this.active];
  }
  get spare() {
    return this.decks[this.active ^ 1];
  }
  get audio() {
    return this.deck.el;
  }
  get current() {
    return this.queue[this.index] || null;
  }
  get upcoming() {
    return this.queue.slice(this.index + 1);
  }
  get time() {
    if (!this.deck.hasSource()) return this.restoredAt || 0;
    return this.audio.currentTime || 0;
  }
  get duration() {
    const d = this.audio.duration;
    if (Number.isFinite(d) && d > 0) return d;
    return (this.current?.duration || 0) / 1000;
  }
  get isPlaying() {
    return this.state === 'playing' || this.state === 'loading';
  }
  get isLongForm() {
    return (this.current?.duration || 0) >= LONG_FORM_MS;
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  // ---------- element events ----------

  bind(deck, i) {
    const el = deck.el;
    const mine = () => i === this.active;
    deck.onFatal = () => (mine() ? this.onError() : deck.reset());
    el.addEventListener('playing', () => {
      if (!mine()) return;
      this.switching = false;
      this.errorsInRow = 0;
      this.setState('playing');
    });
    el.addEventListener('pause', () => {
      if (!mine() || el.ended || this.switching) return;
      this.setState('paused');
      this.saveProgress(true);
    });
    el.addEventListener('waiting', () => mine() && this.setState('loading'));
    el.addEventListener('timeupdate', () => mine() && this.onTime());
    el.addEventListener('durationchange', () => mine() && this.queueTime());
    el.addEventListener('loadedmetadata', () => {
      if (!mine() || this.pendingSeek == null) return;
      try {
        el.currentTime = resolve(this.pendingSeek);
      } catch {
        /* not seekable yet */
      }
      this.pendingSeek = null;
      this.queueTime();
    });
    el.addEventListener('ended', () => mine() && this.onEnded());
    el.addEventListener('error', () => {
      if (!deck.hasSource()) return;
      if (mine()) this.onError();
      else deck.reset(); // a failed preload: just load it normally later
    });
  }

  queueTime() {
    if (this.timeQueued) return;
    this.timeQueued = true;
    requestAnimationFrame(() => {
      this.timeQueued = false;
      this.emit('time');
    });
  }

  onTime() {
    if (this.sleepAt && Date.now() >= this.sleepAt) this.fireSleep();
    this.queueTime();
    this.maybePreload();
    this.followClock();
    if (this.state === 'playing') this.report('playing');
    const now = Date.now();
    if (now - this.lastPersist > 5000) {
      this.lastPersist = now;
      this.persist(true);
      this.saveProgress();
    }
    if (now - this.lastPosState > 1000) {
      this.lastPosState = now;
      this.updatePositionState();
    }
  }

  setState(s) {
    if (s === this.state) return;
    this.state = s;
    const ms = navigator.mediaSession;
    if (ms && s !== 'loading' && app.settings.mediaSession !== false) ms.playbackState = s === 'playing' ? 'playing' : s === 'paused' ? 'paused' : 'none';
    if (s === 'playing' || s === 'paused') this.report(s, this.current, this.time, true);
    this.emit('state');
  }

  // ---------- sources ----------

  sourceFor(track, forceTranscode) {
    const s = app.server;
    const quality = app.settings.quality;
    const direct = quality === 'original' && !forceTranscode && track.partKey && (!track.codec || canPlayCodec(track.codec));
    if (direct) return { url: s.directUrl(track), hls: false };
    return { url: s.transcodeUrl(track, quality === 'original' ? 320 : Number(quality) || 320), hls: true };
  }

  async load(index, { autoplay = true, startAt = 0, transcode = false, reportPrev = true } = {}) {
    const prev = this.current;
    if (reportPrev && prev && this.deck.hasSource() && this.state !== 'idle') this.report('stopped', prev, this.time, true);
    this.saveProgress(true);
    this.index = index;
    const track = this.current;
    if (!track || !app.server) return this.reset();

    const token = ++this.loadToken;
    const src = this.sourceFor(track, transcode);
    this.triedTranscode = src.hls;
    this.transcoding = src.hls;
    this.restoredAt = 0;
    if (!startAt && !this.remote) startAt = this.savedProgress(track);
    this.pendingSeek = resolve(startAt) > 0 ? startAt : null;
    this.lastReport = 0;
    this.loadAutoplay = autoplay;
    this.loadingQid = track.qid;
    this.switching = autoplay;
    if (this.failedQid !== track.qid) this.failedQid = null;
    this.setState('loading');
    this.emit('track');
    this.updateMediaSession();

    const spare = this.spare;
    if (!transcode && spare.qid === track.qid && spare.isHls === src.hls) {
      // Already buffered by the preloader: switch decks. Its metadata has
      // loaded already, so a start position is applied here.
      this.deck.el.pause();
      this.deck.reset();
      this.active ^= 1;
      if (this.pendingSeek != null && this.audio.readyState >= 1) {
        try {
          this.audio.currentTime = resolve(this.pendingSeek);
        } catch {
          /* not seekable yet */
        }
        this.pendingSeek = null;
      }
    } else {
      this.deck.el.pause();
      spare.reset();
      try {
        await this.deck.load(src.url, src.hls);
      } catch (err) {
        if (token === this.loadToken) {
          this.loadingQid = null;
          this.onError(err);
        }
        return;
      }
      if (token !== this.loadToken) return;
      this.deck.qid = track.qid;
    }
    this.loadingQid = null;
    this.applyVolume();
    this.applySpeed();
    this.persist();
    if (this.loadAutoplay) this._play();
    else this.setState('paused');
  }

  maybePreload() {
    if (!app.settings.gapless || this.repeat === 'one') return;
    const remaining = this.duration - this.time;
    if (!(remaining > 0 && remaining < PRELOAD_AT)) return;
    const ni = this.nextIndex();
    if (ni === -1) return;
    const next = this.queue[ni];
    const spare = this.spare;
    if (spare.qid === next.qid || spare.loadingQid === next.qid) return;
    const src = this.sourceFor(next, false);
    spare
      .load(src.url, src.hls)
      .then(() => {
        spare.qid = next.qid;
        spare.el.volume = this.volume;
        spare.el.muted = this.muted;
      })
      .catch(() => spare.reset());
    spare.loadingQid = next.qid;
  }

  // ---------- transport ----------
  // Public methods are what buttons, keys and the lock screen call. In a
  // Play Together session they go to the session; the _underscored ones
  // act on this device only.

  play() {
    if (this.remote) return this.remote.play();
    this._play();
  }

  _play() {
    if (!this.current) return;
    this.unlock();
    if (!this.deck.hasSource()) {
      this.load(this.index, { startAt: this.restoredAt || 0, reportPrev: false });
      return;
    }
    this.audio.play()?.catch((err) => this.onPlayError(err));
  }

  pause() {
    if (this.remote) return this.remote.pause();
    this._pause();
  }

  _pause() {
    this.switching = false;
    this.loadAutoplay = false;
    this.audio.pause();
    if (this.state === 'loading') this.setState('paused');
  }

  toggle() {
    if (this.remote) return this.remote.toggle();
    if (this.isPlaying) this._pause();
    else this._play();
  }

  seek(sec) {
    if (this.remote) return this.remote.seek(sec);
    this._seek(sec);
  }

  skipBy(sec) {
    this.seek(Math.max(0, this.time + sec));
  }

  _seek(sec, report = true) {
    if (!this.current) return;
    const d = this.duration;
    const t = Math.max(0, Math.min(sec, d ? d - 0.25 : sec));
    if (!this.deck.hasSource()) {
      this.restoredAt = t;
    } else {
      try {
        this.audio.currentTime = t;
      } catch {
        /* not seekable */
      }
    }
    this.queueTime();
    this.updatePositionState();
    if (report) this.report(this.isPlaying ? 'playing' : 'paused', this.current, t, true);
  }

  nextIndex() {
    const i = this.index + 1;
    if (i < this.queue.length) return i;
    if (this.repeat === 'all' && this.queue.length && !this.remote) return 0;
    return -1;
  }

  next() {
    if (this.remote) return this.remote.command({ type: 'next' });
    const ni = this.nextIndex();
    if (ni !== -1) this.load(ni);
  }

  prev() {
    if (this.remote) return this.remote.command({ type: 'prev' });
    if (this.time > 3 || this.index <= 0) this._seek(0);
    else this.load(this.index - 1);
  }

  onEnded() {
    const track = this.current;
    this.clearProgress(track);
    if (this.remote) {
      // Tell the session, and carry on with the next track straight away
      // (it's usually buffered) rather than waiting to hear back.
      this.report('stopped', track, this.duration, true);
      this.remote.ended(track);
      if (this.index + 1 < this.queue.length) {
        this.aheadOf = { sid: track.sid, until: performance.now() + 5000 };
        this.load(this.index + 1, { reportPrev: false });
      } else {
        this.setState('paused');
      }
      return;
    }
    if (this.sleepEndOfTrack) {
      // Sleep timer set to "end of this track": stop here, ready at the next one.
      this.report('stopped', track, this.duration, true);
      this.sleepEndOfTrack = false;
      const ni = this.nextIndex();
      if (ni !== -1) this.load(ni, { autoplay: false, reportPrev: false });
      else this.setState('paused');
      this.emit('sleep');
      return;
    }
    if (this.repeat === 'one') {
      this.report('stopped', track, this.duration, true);
      this.audio.currentTime = 0;
      this._play();
      return;
    }
    this.report('stopped', track, this.duration, true);
    const ni = this.nextIndex();
    if (ni === -1) {
      this.setState('paused');
      this.deck.reset();
      this.restoredAt = 0;
      this.emit('time');
      return;
    }
    const next = this.queue[ni];
    const spare = this.spare;
    if (spare.qid === next.qid) {
      // Gapless hand-off: the next track is already buffered.
      const old = this.deck;
      this.active ^= 1;
      this.index = ni;
      this.transcoding = spare.isHls;
      this.triedTranscode = spare.isHls;
      this.lastReport = 0;
      this.applySpeed();
      this.audio.play()?.catch((err) => this.onPlayError(err));
      old.reset();
      this.emit('track');
      this.updateMediaSession();
      this.persist();
    } else {
      this.load(ni, { reportPrev: false });
    }
  }

  onPlayError(err) {
    this.switching = false;
    if (err?.name === 'NotAllowedError') {
      this.setState('paused');
      // The browser wants a tap before it plays sound (e.g. after a reload).
      this.remote?.blocked();
    } else if (err?.name !== 'AbortError') console.warn('play() failed', err);
  }

  onError(err) {
    const track = this.current;
    if (!track) return;
    const media = this.audio.error;
    debugLog(
      'player',
      `couldn’t play “${track.title}” (${track.codec || 'unknown format'}, ${this.transcoding ? 'converted by the server' : 'original file'}): ${err?.message || (media ? `media error ${media.code}${media.message ? `, ${media.message}` : ''}` : 'stream error')}`,
      'warn',
    );
    if (!this.triedTranscode && track.partKey) {
      // The browser couldn't decode the original file: ask the server to convert it.
      this.load(this.index, { startAt: this.remote ? () => this.remote.expectedTime(track.sid) ?? this.time : this.time, transcode: true, reportPrev: false });
      return;
    }
    this.errorsInRow += 1;
    if (this.remote) {
      // Only this device can't play it; the session carries on, and this
      // device picks up again at the next track.
      this.failedQid = track.qid;
      this.setState('paused');
      this.emit('playerror', { track, err, remote: true });
      return;
    }
    this.emit('playerror', { track, err });
    if (this.errorsInRow >= 3 || this.nextIndex() === -1) {
      this.setState('paused');
      return;
    }
    setTimeout(() => this.current === track && this.next(), 1200);
  }

  // iOS only lets an element start playback on its own once it has played
  // after a tap, so warm up the second element on the first tap.
  // `all`: warm up both elements, for a tap whose playback starts only after
  // some requests (joining a Play Together session).
  unlock({ all = false } = {}) {
    if (this.unlocked && !all) return;
    this.unlocked = true;
    for (const deck of all ? this.decks : [this.spare]) {
      const s = deck.el;
      if (s.getAttribute('src') || deck.hls) continue;
      s.src = SILENT_WAV;
      s.play()
        .then(() => s.pause())
        .catch(() => {})
        .finally(() => {
          if (s.getAttribute('src') === SILENT_WAV) {
            s.removeAttribute('src');
            s.load();
          }
        });
    }
  }

  // ---------- Play Together ----------

  // remote: { play, pause, toggle, seek, command, ended, expectedTime, sleep, blocked }
  setRemote(remote) {
    if (remote === this.remote) return;
    this.remote = remote;
    this.failedQid = null;
    if (remote) {
      this.repeat = 'off';
      this.shuffle = false;
      this.original = null;
      this.setSpeed(1, { save: false });
    } else {
      this.aheadOf = null;
      this.speed = app.settings.playbackSpeed ? Number(app.settings.speed) || 1 : 1;
      this.applySpeed();
      // Keep the session's queue to carry on with, as this device's own.
      this.queue = this.queue.map(({ sid, addedBy, ...t }) => t);
      this.index = Math.min(this.index, this.queue.length - 1);
      this.persist();
      this.emit('queue');
    }
    this.emit('mode');
  }

  // The session's state: { items, index, playing, position() (ms, now),
  // context }. Loads, plays, pauses or seeks so this device matches it.
  syncRemote({ items, index, playing, position, context, force = false }) {
    // Keep the objects (and so the qids) of tracks already in the queue, so
    // a preloaded or playing deck still matches them.
    const known = new Map(this.queue.filter((t) => t.sid).map((t) => [t.sid, t]));
    this.queue = items.map((it) => {
      const k = known.get(it.sid);
      return k ? Object.assign(k, it) : { ...it, qid: `s:${it.sid}` };
    });
    // This device moved on to the next track a moment before the session
    // did (see onEnded): stay there rather than going back.
    const ahead = this.aheadOf && performance.now() < this.aheadOf.until && items[index]?.sid === this.aheadOf.sid && index + 1 < items.length;
    if (!ahead) this.aheadOf = null;
    const at = ahead ? index + 1 : index;
    const changedTrack = this.queue[at]?.qid !== this.current?.qid;
    this.index = this.queue.length ? at : -1;
    this.context = context || null;
    this.emit('queue');
    const cur = this.current;
    if (!cur) {
      for (const d of this.decks) {
        d.el.pause();
        d.reset();
      }
      this.state = 'idle';
      this.emit('track');
      this.emit('state');
      this.updateMediaSession();
      return;
    }
    if (force) this.failedQid = null;
    const sec = () => position() / 1000;
    if (this.loadingQid === cur.qid) {
      // Already loading it: just update where and whether to start.
      this.pendingSeek = sec;
      this.loadAutoplay = playing;
      this.switching = playing;
      return;
    }
    if (this.failedQid === cur.qid) {
      if (changedTrack) this.emit('track');
      return;
    }
    if (this.deck.qid !== cur.qid || !this.deck.hasSource()) {
      this.load(this.index, { autoplay: playing, startAt: sec, reportPrev: true });
      return;
    }
    if (changedTrack) this.emit('track');
    if (ahead) return; // the session's clock is still on the previous track
    if (playing) {
      if (!this.isPlaying) {
        this._seek(sec(), false);
        this._play();
      } else {
        this.followClock(true);
      }
    } else {
      if (this.isPlaying) this._pause();
      if (Math.abs(this.time - sec()) > 0.5) this._seek(sec(), false);
    }
  }

  // Stay on the session's clock: nudge the playback rate for small drift,
  // jump for large drift.
  followClock(now = false) {
    if (!this.remote || this.state !== 'playing' || this.switching) return;
    const t = performance.now();
    if (!now && t < this.driftHold) return;
    const expected = this.remote.expectedTime(this.current?.sid);
    const el = this.audio;
    if (expected == null) {
      el.playbackRate = 1;
      return;
    }
    const d = this.duration;
    if (expected < 1 || (d && expected > d - 2)) {
      el.playbackRate = 1;
      return;
    }
    const drift = el.currentTime - expected; // positive: ahead of the others
    if (Math.abs(drift) > 1.5) {
      try {
        el.currentTime = expected + 0.15; // a jump takes a moment to land
      } catch {
        /* not seekable */
      }
      el.playbackRate = 1;
      this.driftHold = t + 3000;
    } else if (Math.abs(drift) > 0.15) {
      el.playbackRate = drift > 0 ? 0.97 : 1.03;
    } else {
      el.playbackRate = 1;
    }
  }

  // ---------- sleep timer ----------

  // minutes: a number, 'track' for the end of the current track, or null to cancel.
  setSleep(minutes) {
    clearTimeout(this.sleepTimer);
    this.sleepAt = null;
    this.sleepEndOfTrack = false;
    if (minutes === 'track') {
      this.sleepEndOfTrack = true;
    } else if (minutes) {
      this.sleepAt = Date.now() + minutes * 60000;
      this.sleepTimer = setTimeout(() => this.fireSleep(), minutes * 60000);
    }
    this.emit('sleep');
  }

  get sleepActive() {
    return !!(this.sleepAt || this.sleepEndOfTrack);
  }

  fireSleep() {
    clearTimeout(this.sleepTimer);
    this.sleepAt = null;
    this.sleepEndOfTrack = false;
    // In a session, stop listening on this device rather than pausing
    // everyone else.
    if (this.remote) this.remote.sleep();
    else this._pause();
    this.emit('sleep');
  }

  // ---------- volume and speed ----------

  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.volume > 0) this.muted = false;
    store.set('volume', this.volume);
    this.applyVolume();
    this.emit('volume');
  }

  toggleMute() {
    this.muted = !this.muted;
    this.applyVolume();
    this.emit('volume');
  }

  applyVolume() {
    for (const d of this.decks) {
      d.el.volume = this.volume;
      d.el.muted = this.muted;
    }
  }

  setSpeed(rate, { save = true } = {}) {
    this.speed = Math.max(0.5, Math.min(2, Number(rate) || 1));
    if (this.remote) this.speed = 1;
    this.applySpeed();
    if (save && app.settings.speed !== this.speed) {
      app.settings.speed = this.speed;
      store.set('settings', app.settings);
    }
    this.emit('speed');
  }

  applySpeed() {
    for (const d of this.decks) {
      if ('preservesPitch' in d.el) d.el.preservesPitch = true;
      d.el.playbackRate = this.remote ? 1 : this.speed;
    }
  }

  // ---------- long-form progress ----------
  // With "long-form controls" on, tracks over 20 minutes remember where you
  // stopped (per track, on this device) and start there next time.

  progressStore() {
    return store.get('progress', {});
  }

  savedProgress(track) {
    if (!app.settings.longForm || !track || (track.duration || 0) < LONG_FORM_MS) return 0;
    const sec = Number(this.progressStore()[track.id]) || 0;
    return sec > 15 && sec < track.duration / 1000 - 30 ? sec : 0;
  }

  saveProgress(now = false) {
    const t = this.current;
    if (!app.settings.longForm || this.remote || !t || (t.duration || 0) < LONG_FORM_MS || !this.deck.hasSource()) return;
    const at = Date.now();
    if (!now && at - this.lastProgress < 5000) return;
    this.lastProgress = at;
    const all = this.progressStore();
    delete all[t.id];
    all[t.id] = Math.round(this.time);
    const keys = Object.keys(all);
    if (keys.length > 100) for (const k of keys.slice(0, keys.length - 100)) delete all[k];
    store.set('progress', all);
  }

  clearProgress(track) {
    if (!track) return;
    const all = this.progressStore();
    if (all[track.id] === undefined) return;
    delete all[track.id];
    store.set('progress', all);
  }

  // ---------- queue ----------
  // In a session these become session commands; the session then sends
  // back the new queue.

  playTracks(tracks, start = 0, { context = null, shuffle = false } = {}) {
    if (!tracks?.length) return;
    if (this.remote) {
      let list = tracks.slice(start);
      if (shuffle) list = shuffleArray(tracks);
      return this.remote.command({ type: 'playNow', tracks: list.slice(0, 500), start: 0 });
    }
    let list = tracks.map(withQid);
    this.original = list.slice();
    if (shuffle) {
      const first = start > 0 ? list[start] : list[Math.floor(Math.random() * list.length)];
      list = [first, ...shuffleArray(list.filter((t) => t !== first))];
      start = 0;
    }
    this.shuffle = shuffle;
    this.queue = list;
    this.context = context;
    this.emit('queue');
    this.emit('mode');
    this.emit('started');
    this.load(Math.min(start, list.length - 1));
  }

  playNext(tracks) {
    if (this.remote) return this.remote.command({ type: 'add', where: 'next', tracks: tracks.slice(0, 500) });
    if (!this.current) return this.playTracks(tracks, 0);
    const items = tracks.map(withQid);
    this.queue.splice(this.index + 1, 0, ...items);
    if (this.original) {
      const pos = this.original.indexOf(this.current);
      this.original.splice(pos + 1, 0, ...items);
    }
    this.emit('queue');
    this.persist();
  }

  addToQueue(tracks) {
    if (this.remote) return this.remote.command({ type: 'add', tracks: tracks.slice(0, 500) });
    if (!this.current) return this.playTracks(tracks, 0);
    const items = tracks.map(withQid);
    this.queue.push(...items);
    this.original?.push(...items);
    this.emit('queue');
    this.persist();
  }

  replaceUpcoming(tracks, context) {
    // A shared queue isn't wiped for one person: the tracks go next instead.
    if (this.remote) return this.playNext(tracks);
    const items = tracks.map(withQid);
    this.queue = this.queue.slice(0, this.index + 1).concat(items);
    this.original = this.queue.slice();
    this.shuffle = false;
    if (context) this.context = context;
    this.emit('queue');
    this.emit('mode');
    this.persist();
  }

  jump(i) {
    if (this.remote) {
      if (i === this.index) return this.remote.play();
      return this.queue[i] && this.remote.command({ type: 'jump', sid: this.queue[i].sid });
    }
    if (i === this.index) this._play();
    else if (this.queue[i]) this.load(i);
  }

  remove(i) {
    if (i === this.index || !this.queue[i]) return;
    if (this.remote) return this.remote.command({ type: 'remove', sid: this.queue[i].sid });
    const [t] = this.queue.splice(i, 1);
    if (i < this.index) this.index -= 1;
    if (this.original) this.original = this.original.filter((x) => x !== t);
    if (this.spare.qid === t.qid) this.spare.reset();
    this.emit('queue');
    this.persist();
  }

  clearUpcoming() {
    if (this.remote) return this.remote.command({ type: 'clear' });
    this.queue = this.queue.slice(0, this.index + 1);
    this.original = this.queue.slice();
    this.spare.reset();
    this.emit('queue');
    this.persist();
  }

  // In a session, shuffling mixes up what's next for everyone, once.
  setShuffle(on) {
    if (this.remote) return this.remote.command({ type: 'shuffle' });
    if (on === this.shuffle || !this.queue.length) {
      this.shuffle = on;
      this.emit('mode');
      return;
    }
    const cur = this.current;
    this.shuffle = on;
    if (on) {
      this.original = this.queue.slice();
      this.queue = this.queue.slice(0, this.index + 1).concat(shuffleArray(this.queue.slice(this.index + 1)));
    } else if (this.original) {
      this.queue = this.original.slice();
      this.index = Math.max(0, this.queue.indexOf(cur));
    }
    this.spare.reset();
    this.emit('queue');
    this.emit('mode');
    this.persist();
  }

  cycleRepeat() {
    if (this.remote) return false;
    this.repeat = { off: 'all', all: 'one', one: 'off' }[this.repeat] || 'off';
    this.emit('mode');
    this.persist();
    return true;
  }

  // ---------- reporting ----------

  report(state, track = this.current, time = this.time, force = false) {
    if (!track || !app.server || !app.settings.reportPlays) return;
    const now = Date.now();
    if (!force && now - this.lastReport < 10000) return;
    this.lastReport = now;
    app.server.timeline(track, state, time * 1000);
  }

  // ---------- lock screen / media keys ----------

  setupMediaSession() {
    const ms = navigator.mediaSession;
    if (!ms) return;
    const on = app.settings.mediaSession !== false;
    const set = (action, fn) => {
      try {
        ms.setActionHandler(action, on ? fn : null);
      } catch {
        /* unsupported action */
      }
    };
    set('play', () => this.play());
    set('pause', () => this.pause());
    set('stop', () => this.pause());
    set('previoustrack', () => this.prev());
    set('nexttrack', () => this.next());
    set('seekto', (d) => this.seek(d.seekTime));
    set('seekbackward', (d) => this.skipBy(-(d.seekOffset || Number(app.settings.skipBack) || 10)));
    set('seekforward', (d) => this.skipBy(d.seekOffset || Number(app.settings.skipForward) || 30));
  }

  updateMediaSession() {
    const ms = navigator.mediaSession;
    if (!ms || typeof MediaMetadata === 'undefined') return;
    const t = this.current;
    if (!t || !app.server || app.settings.mediaSession === false) {
      ms.metadata = null;
      return;
    }
    const art = (n) => ({ src: app.server.art(t.thumb, n), sizes: `${n}x${n}`, type: 'image/jpeg' });
    ms.metadata = new MediaMetadata({
      title: t.title,
      artist: t.artist,
      album: t.album,
      artwork: t.thumb ? [art(256), art(512)] : [],
    });
  }

  updatePositionState() {
    const ms = navigator.mediaSession;
    const d = this.duration;
    if (!ms?.setPositionState || !d || app.settings.mediaSession === false) return;
    try {
      ms.setPositionState({ duration: d, position: Math.min(this.time, d), playbackRate: this.remote ? 1 : this.speed });
    } catch {
      /* invalid state while loading */
    }
  }

  // ---------- persistence ----------

  storeKey() {
    return app.source ? `player.${app.source.serverId || app.source.uri}` : null;
  }

  persist(now = false) {
    clearTimeout(this.persistTimer);
    if (this.remote) return; // the session keeps its own queue
    const save = () => {
      const key = this.storeKey();
      if (!key) return;
      if (!this.queue.length) return store.set(key, null);
      const from = Math.max(0, this.index - 50);
      const slice = this.queue.slice(from, from + 1500).map(({ qid, sid, addedBy, ...t }) => t);
      store.set(key, {
        queue: slice,
        index: this.index - from,
        position: this.time,
        context: this.context,
        shuffle: this.shuffle,
        repeat: this.repeat,
      });
    };
    if (now) save();
    else this.persistTimer = setTimeout(save, 800);
  }

  // Bring back the last queue for this server, paused at the saved position.
  restore() {
    this.reset();
    const key = this.storeKey();
    const saved = key && store.get(key);
    if (!saved?.queue?.length) return;
    this.queue = saved.queue.map(withQid);
    this.original = this.queue.slice();
    this.index = Math.max(0, Math.min(saved.index || 0, this.queue.length - 1));
    this.context = saved.context || null;
    this.shuffle = !!saved.shuffle;
    this.repeat = saved.repeat || 'off';
    this.restoredAt = saved.position || 0;
    this.state = 'paused';
    this.emit('queue');
    this.emit('mode');
    this.emit('track');
    this.emit('state');
    this.queueTime();
    this.updateMediaSession();
  }

  reset() {
    this.loadToken += 1;
    this.loadingQid = null;
    for (const d of this.decks) {
      d.el.pause();
      d.reset();
    }
    this.queue = [];
    this.original = null;
    this.index = -1;
    this.context = null;
    this.restoredAt = 0;
    this.state = 'idle';
    this.emit('queue');
    this.emit('track');
    this.emit('state');
    this.queueTime();
    this.updateMediaSession();
  }
}

export const player = new Player();
