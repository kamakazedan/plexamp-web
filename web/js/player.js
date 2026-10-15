// Playback engine: queue, shuffle/repeat, gapless hand-off between two audio
// elements, server-side conversion fallback, lock-screen controls and play
// reporting back to Plex.
import { app, on } from './state.js';
import { store, canPlayCodec, canPlayHlsNatively } from './plex.js';
import { shuffleArray } from './ui.js';

const PRELOAD_AT = 25; // seconds before the end of a track
const SILENT_WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';
const HLS_JS = 'https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js';

let hlsLoader = null;
function loadHls() {
  if (window.Hls) return Promise.resolve(window.Hls);
  hlsLoader ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = HLS_JS;
    s.onload = () => resolve(window.Hls);
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

// One <audio> element plus, when needed, an hls.js instance feeding it.
class Deck {
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
    this.transcoding = false;
    this.triedTranscode = false;
    this.errorsInRow = 0;
    this.restoredAt = 0;
    this.pendingSeek = null;
    this.loadToken = 0;
    this.lastReport = 0;
    this.lastPersist = 0;
    this.lastPosState = 0;
    this.timeQueued = false;
    this.unlocked = false;
    this.switching = false; // ignore the pause event fired while changing tracks

    this.decks.forEach((d, i) => this.bind(d, i));
    this.applyVolume();
    this.setupMediaSession();
    window.addEventListener('pagehide', () => {
      this.persist(true);
      if (this.state === 'playing') this.report('stopped', this.current, this.time, true);
    });
    on('source', ({ serverChanged }) => serverChanged && this.restore());
    on('signout', () => this.reset());
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
    el.addEventListener('pause', () => mine() && !el.ended && !this.switching && this.setState('paused'));
    el.addEventListener('waiting', () => mine() && this.setState('loading'));
    el.addEventListener('timeupdate', () => mine() && this.onTime());
    el.addEventListener('durationchange', () => mine() && this.queueTime());
    el.addEventListener('loadedmetadata', () => {
      if (!mine() || this.pendingSeek == null) return;
      try {
        el.currentTime = this.pendingSeek;
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
    this.queueTime();
    this.maybePreload();
    if (this.state === 'playing') this.report('playing');
    const now = Date.now();
    if (now - this.lastPersist > 5000) {
      this.lastPersist = now;
      this.persist(true);
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
    if (ms && s !== 'loading') ms.playbackState = s === 'playing' ? 'playing' : s === 'paused' ? 'paused' : 'none';
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
    this.index = index;
    const track = this.current;
    if (!track || !app.server) return this.reset();

    const token = ++this.loadToken;
    const src = this.sourceFor(track, transcode);
    this.triedTranscode = src.hls;
    this.transcoding = src.hls;
    this.restoredAt = 0;
    this.pendingSeek = startAt > 0 ? startAt : null;
    this.lastReport = 0;
    this.switching = autoplay;
    this.setState('loading');
    this.emit('track');
    this.updateMediaSession();

    const spare = this.spare;
    if (!transcode && spare.qid === track.qid && spare.isHls === src.hls) {
      // Already buffered by the preloader: switch decks.
      this.deck.el.pause();
      this.deck.reset();
      this.active ^= 1;
    } else {
      this.deck.el.pause();
      spare.reset();
      try {
        await this.deck.load(src.url, src.hls);
      } catch (err) {
        if (token === this.loadToken) this.onError(err);
        return;
      }
      if (token !== this.loadToken) return;
      this.deck.qid = track.qid;
    }
    this.applyVolume();
    this.persist();
    if (autoplay) this.play();
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

  play() {
    if (!this.current) return;
    this.unlock();
    if (!this.deck.hasSource()) {
      this.load(this.index, { startAt: this.restoredAt || 0, reportPrev: false });
      return;
    }
    this.audio.play()?.catch((err) => this.onPlayError(err));
  }

  pause() {
    this.switching = false;
    this.audio.pause();
    if (this.state === 'loading') this.setState('paused');
  }

  toggle() {
    if (this.isPlaying) this.pause();
    else this.play();
  }

  seek(sec) {
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
    this.report(this.isPlaying ? 'playing' : 'paused', this.current, t, true);
  }

  nextIndex() {
    const i = this.index + 1;
    if (i < this.queue.length) return i;
    if (this.repeat === 'all' && this.queue.length) return 0;
    return -1;
  }

  next() {
    const ni = this.nextIndex();
    if (ni !== -1) this.load(ni);
  }

  prev() {
    if (this.time > 3 || this.index <= 0) this.seek(0);
    else this.load(this.index - 1);
  }

  onEnded() {
    const track = this.current;
    if (this.repeat === 'one') {
      this.report('stopped', track, this.duration, true);
      this.audio.currentTime = 0;
      this.play();
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
    if (err?.name === 'NotAllowedError') this.setState('paused');
    else if (err?.name !== 'AbortError') console.warn('play() failed', err);
  }

  onError(err) {
    const track = this.current;
    if (!track) return;
    if (!this.triedTranscode && track.partKey) {
      // The browser couldn't decode the original file: ask the server to convert it.
      this.load(this.index, { startAt: this.time, transcode: true, reportPrev: false });
      return;
    }
    this.errorsInRow += 1;
    this.emit('playerror', { track, err });
    if (this.errorsInRow >= 3 || this.nextIndex() === -1) {
      this.setState('paused');
      return;
    }
    setTimeout(() => this.current === track && this.next(), 1200);
  }

  // iOS only lets an element start playback on its own once it has played
  // after a tap, so warm up the second element on the first tap.
  unlock() {
    if (this.unlocked) return;
    this.unlocked = true;
    const s = this.spare.el;
    if (s.getAttribute('src')) return;
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

  // ---------- volume ----------

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

  // ---------- queue ----------

  playTracks(tracks, start = 0, { context = null, shuffle = false } = {}) {
    if (!tracks?.length) return;
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
    this.load(Math.min(start, list.length - 1));
  }

  playNext(tracks) {
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
    if (!this.current) return this.playTracks(tracks, 0);
    const items = tracks.map(withQid);
    this.queue.push(...items);
    this.original?.push(...items);
    this.emit('queue');
    this.persist();
  }

  replaceUpcoming(tracks, context) {
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
    if (i === this.index) this.play();
    else if (this.queue[i]) this.load(i);
  }

  remove(i) {
    if (i === this.index || !this.queue[i]) return;
    const [t] = this.queue.splice(i, 1);
    if (i < this.index) this.index -= 1;
    if (this.original) this.original = this.original.filter((x) => x !== t);
    if (this.spare.qid === t.qid) this.spare.reset();
    this.emit('queue');
    this.persist();
  }

  clearUpcoming() {
    this.queue = this.queue.slice(0, this.index + 1);
    this.original = this.queue.slice();
    this.spare.reset();
    this.emit('queue');
    this.persist();
  }

  setShuffle(on) {
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
    this.repeat = { off: 'all', all: 'one', one: 'off' }[this.repeat] || 'off';
    this.emit('mode');
    this.persist();
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
    const set = (action, fn) => {
      try {
        ms.setActionHandler(action, fn);
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
    set('seekbackward', (d) => this.seek(this.time - (d.seekOffset || 10)));
    set('seekforward', (d) => this.seek(this.time + (d.seekOffset || 10)));
  }

  updateMediaSession() {
    const ms = navigator.mediaSession;
    if (!ms || typeof MediaMetadata === 'undefined') return;
    const t = this.current;
    if (!t || !app.server) {
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
    if (!ms?.setPositionState || !d) return;
    try {
      ms.setPositionState({ duration: d, position: Math.min(this.time, d), playbackRate: 1 });
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
    const save = () => {
      const key = this.storeKey();
      if (!key) return;
      if (!this.queue.length) return store.set(key, null);
      const from = Math.max(0, this.index - 50);
      const slice = this.queue.slice(from, from + 1500).map(({ qid, ...t }) => t);
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
