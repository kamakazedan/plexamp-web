// Playback engine: queue, shuffle/repeat, transitions between tracks on two
// audio elements (gapless, or crossfading where the music really ends),
// server-side conversion fallback, lock-screen controls and play reporting
// back to Plex.
//
// In a Play Together session the queue belongs to the session: transport
// and queue changes are sent to it (this.remote), and its state comes back
// through syncRemote(), which keeps local playback on the session's clock.
//
// Casting to another Plex player (this.cast, see cast.js), this device
// plays nothing: transport and queue changes go to that player, and what it
// does comes back through castUpdate().
import { app, on } from './state.js';
import { store, canPlayCodec, canPlayHlsNatively, isLossless, playbackId } from './plex.js';
import { shuffleArray } from './ui.js';
import { debugLog, debugOn } from './debug.js';
import { loudnessOf, audibleSpan, followsOnAlbum, canFade } from './transitions.js';
import { Prefetcher, cachedLoader, recordingLoader } from './prefetch.js';
import { connection, connectionLost, connectionBack, serverAnswers } from './connection.js';
import { keepPlayed, flush } from './outbox.js';

const PRELOAD_AT = 25; // seconds before the next track starts
// ...once this one has loaded to its end, or has this much buffered (and,
// playing a file as it is, the browser isn't still fetching it): on a slow
// connection the next track's download would take what this one needs.
const PRELOAD_AHEAD = 15;
// Loading ahead (prefetch.js), the next track is waited for until this
// long before it's due, then streamed as usual.
const PRELOAD_LAST = 10;
// A converted next track loads this many seconds while it waits its turn
// (past where its music starts, for a smart crossfade).
const PRELOAD_BUFFER = 10;
// An element takes a moment to start sounding, so for a gapless change the
// next track is started this much before the current one ends.
const GAPLESS_LEAD = 0.06;
const MAX_SKIP_IN = 20; // at most this much silence is skipped at the start of a track
const MAX_QUIET_LEAD = 15; // a fade starts at most this long before the music ends, over a quiet ending
const SMART_FADE_MIN = 2; // a fade over a quiet ending takes at least this long (or Crossfade length, if that's shorter)

// Smart crossfade length: a fade that starts over a quiet ending (at
// `from`, in `span`: see transitions.js audibleSpan) lasts until the track
// is nearly silent, so the next one reaches full volume just as this one
// fades away. Where it's nearly silent already, it's quick; where it never
// gets that quiet before its music ends (at `end`), it lasts until then.
// At least SMART_FADE_MIN seconds (or `set`, Crossfade length, if that's
// shorter), and never past the end of the music.
export function smartFade(span, from, end, set) {
  const hushed = span?.quietFrom?.hushed;
  const until = hushed == null ? end : Math.max(from, Math.min(end, hushed));
  const least = Math.min(set, SMART_FADE_MIN);
  return Math.min(end - from, MAX_QUIET_LEAD, Math.max(least, until - from));
}
const SILENT_WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';
// Apple's browsers (Safari, and every browser on an iPhone or iPad) let an
// audio element start playback on its own only once it's played after a
// tap (see Player.unlock). Others mostly go by the page (once it's been
// tapped, anything on it can play), but not all: an Android app's web view
// may want a tap for each element too. Elsewhere the silent sound is
// muted: starting audibly as a track does, it now and then stops the
// track, in Chrome. (Apple's have it as they always have.)
const APPLE = /Apple/.test(globalThis.navigator?.vendor || '');
// Bundled into the image at a pinned version (see the Dockerfile), so no
// code is ever loaded from another site.
const HLS_JS = 'vendor/hls.min.js';
// Tracks at least this long count as long-form (DJ mixes, audiobooks).
export const LONG_FORM_MS = 20 * 60000;

// A converted stream that fails part-way (see onStreamError): with no more
// than this missing at its end (or before the change to the next track),
// the track ends where what's buffered does.
const END_SLACK = 5;
// Otherwise it's started again where it got to: at most this many times
// without getting this many seconds further (once for a track that never
// started), after these waits, and not while there's more than this left
// of what's buffered to play.
// An original file waiting for data part-way (no more of it coming, as a
// proxy that holds the connection open without sending anything does):
// said after `say` ms (in debug mode), and loaded again from where it got
// to after `reload` ms with nothing more come in, once a track. One fading
// out as the next track fades in: on to that one after `fade` ms.
const STALL = { say: 8000, reload: 30000, fade: 3000 };
// A track whose connection drops again, after playing on this many seconds
// since it last did, is as one whose connection drops the first time (see
// dropped).
const DROPS_FORGOTTEN_S = 60;
const RESCUE_TRIES = 3;
const RESCUE_PROGRESS = 20;
const RESCUE_WAITS = [250, 3000, 6000];
const RESCUE_LEFT = 3;
// A dropped connection with at least this much still to play is tried
// again on the same stream (nothing is heard of it), up to this many times.
const RESCUE_AHEAD = 10;
const RESCUE_SOFT = 4;

// How hls.js fetches a stream the server converts. Left to itself, it gives
// up on a stream at the start if the browser calls the first request a
// network error, or the server answers it with an error (a proxy that drops
// a connection now and then, Plex still starting the conversion): that ends
// the track. These try again, and give up at once only when the server
// refuses (signed out, no access).
function retries(maxNumRetry, retryDelayMs, maxRetryDelayMs) {
  return {
    maxNumRetry,
    retryDelayMs,
    maxRetryDelayMs,
    shouldRetry: (_config, count, _timeout, res) => retryable(res?.code, count, maxNumRetry),
  };
}
// The decision, by the status of the answer (0 or none: no answer at all).
export function retryable(code, count, most) {
  if (code === 401 || code === 403) return false;
  // Other client errors (a playlist that isn't there): one more try.
  if (code >= 400 && code < 500 && code !== 408 && code !== 425 && code !== 429) return count < Math.min(1, most);
  return count < most;
}
const loadPolicy = (maxTimeToFirstByteMs, maxLoadTimeMs, timeoutRetry, errorRetry) => ({
  default: { maxTimeToFirstByteMs, maxLoadTimeMs, timeoutRetry, errorRetry },
});
export const HLS_CONFIG = {
  // How far ahead: hls.js loads until it has maxBufferLength seconds or
  // maxBufferSize bytes, whichever is more, up to maxMaxBufferLength
  // seconds; for music that's the whole track, or ten minutes of it (these
  // are hls.js's own). Half a minute is kept behind the playhead (by
  // default hls.js keeps everything already played, which for a long mix
  // adds up).
  maxBufferLength: 30,
  maxBufferSize: 60 * 1000 * 1000,
  maxMaxBufferLength: 600,
  backBufferLength: 30,
  manifestLoadPolicy: loadPolicy(Infinity, 30000, retries(2, 0, 0), retries(3, 1000, 4000)),
  playlistLoadPolicy: loadPolicy(15000, 30000, retries(2, 0, 0), retries(3, 1000, 4000)),
  // A part of the stream: hls.js tries it again whatever went wrong (the
  // stream has no alternatives), this many times.
  fragLoadPolicy: loadPolicy(15000, 120000, retries(3, 0, 0), retries(5, 500, 2000)),
};

// For the debug log: what went wrong in a converted stream (never its
// address, which names the stream's session).
function streamTrouble(data) {
  if (!data) return 'stream error';
  const part = Number.isInteger(data.frag?.sn) ? ` (part ${data.frag.sn})` : '';
  const code = data.response?.code;
  const answer = code ? `, HTTP ${code}` : code === 0 ? ', no answer' : '';
  return `${data.details || data.type || 'stream error'}${part}${answer}`;
}

// A converted stream's element that won't play on from where it is: after
// a decoding problem (the browser's or hls.js's), or with nothing loaded.
function isStuck(el, data) {
  return data?.type === 'mediaError' || !!el.error || el.readyState < 1;
}

// Where what's buffered from `t` on ends (`t` itself if nothing is).
function bufferedEnd(el, t) {
  const b = el.buffered;
  for (let i = 0; i < (b?.length || 0); i++) {
    if (b.start(i) <= t + 0.5 && b.end(i) > t) return b.end(i);
  }
  return t;
}

// Whether a deck has its track loaded as `src` (see sourceFor) would load
// it: as the file, or converted at the same bitrate.
function sameSource(deck, src) {
  return deck.isHls === src.hls && (!src.hls || deck.kbps === src.kbps);
}

// An element with what it needs to play from where it is (not still
// moving there: some browsers lower readyState only once a seek is under
// way).
const canSound = (el) => el.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA && !el.seeking;

// Loudness levelling (Settings › Playback). Plex's loudness analysis gives
// each track a gain, and its album one: the change in dB that brings it to
// ReplayGain's reference loudness, −18 LUFS. Tracks are brought to 4 dB
// above that (−14 LUFS, where Spotify and TIDAL play, and what Plexamp's
// +4 dB preamp aims for), and only ever turned down, as TIDAL does: nothing
// is boosted, so nothing clips, and no limiter is needed.
const LEVEL_ABOVE_REFERENCE = 4;
// How long a track waits for its details (its gains) before it plays.
const LEVEL_WAIT = 1500;
export function levelFor(gains, useAlbum) {
  const g = !gains ? null : useAlbum ? (gains.album ?? gains.track) : (gains.track ?? gains.album);
  return Number.isFinite(g) ? 10 ** (Math.min(0, g + LEVEL_ABOVE_REFERENCE) / 20) : 1;
}

// A track's gains (dB), from its full details; null if it isn't analysed.
export async function gainsOf(track) {
  const d = track?.id && app.server ? await app.server.trackDetail(track.id) : null;
  const stream = (d?.Media?.[0]?.Part?.[0]?.Stream || []).find((x) => x.streamType === 2);
  const num = (v) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  const loudness = num(stream?.loudness);
  const trackGain = num(stream?.gain) ?? (loudness == null ? null : -18 - loudness);
  const albumGain = num(stream?.albumGain);
  return trackGain == null && albumGain == null ? null : { track: trackGain, album: albumGain };
}

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
const tokenKey = (server) => `${server.id}|${server.token}`;

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
    this.gain = 1; // this element's part in a crossfade (its volume is the player's times this)
    // Loudness levelling: the track's gains (see gainsOf; undefined until
    // asked for), whether its album's is used, and what its volume is
    // multiplied by.
    this.gains = undefined;
    this.useAlbum = false;
    this.level = 1;
    this.playback = null; // the track's playback, as Plex knows it (see playbackId)
    this.kbps = null; // a converted stream's bitrate
    this.endsAt = null; // a stream that stopped short: where its sound ends (see onStreamError)
    this.played = false; // has played since it was loaded
    // Converted whatever Streaming quality says, as the file doesn't play
    // as it is here (see couldntPlay).
    this.forced = false;
    this.stall = null; // debug mode: playback waiting for data, since when
    this.prefetched = null; // what was loaded ahead for its track, played from memory (see prefetch.js)
    this.recording = null; // ...or, a converted stream coming in, what's kept of it as it comes (to play again)
    this.gen = 0;
  }

  // `playback`: the track's playback (see playbackId); `startAt`: where a
  // converted stream starts (seconds); `ahead`: if set, it loads only that
  // many seconds ahead (until loadAhead); `kbps`: a converted stream's
  // bitrate; `prefetched`: the track, loaded ahead (played from memory);
  // `recording`: a converted stream's entry to keep what's read in (see
  // Prefetcher.record).
  async load(url, isHls, { playback = null, startAt = 0, ahead = null, kbps = null, prefetched = null, recording = null } = {}) {
    this.reset();
    // (What was loaded ahead, let go of meanwhile: from the network, then,
    // the same way.)
    if (prefetched && !(isHls ? prefetched.data : prefetched.blob)) prefetched = null;
    const gen = this.gen;
    this.isHls = isHls;
    this.kbps = isHls ? kbps : null;
    this.playback = playback;
    this.prefetched = prefetched;
    this.recording = !prefetched && isHls && !canPlayHlsNatively() ? recording : null;
    if (isHls && !canPlayHlsNatively()) {
      const Hls = await loadHls();
      if (gen !== this.gen) throw new DOMException('Another track was loaded.', 'AbortError');
      if (!Hls.isSupported()) throw new Error('This browser cannot play converted streams.');
      // (From memory, it's all buffered at once.)
      const limit = ahead && !prefetched ? { maxBufferLength: ahead, maxBufferSize: 0 } : {};
      const from = prefetched ? { loader: cachedLoader(Hls, prefetched) } : this.recording ? { loader: recordingLoader(Hls, this.recording) } : {};
      const hls = new Hls({ ...HLS_CONFIG, ...limit, ...from, startPosition: startAt > 0 ? startAt : -1 });
      this.hls = hls;
      // Called once hls.js has decided (it's tried again by then, as far as
      // it will): a fatal error goes to the player, the rest to the debug log.
      hls.on(Hls.Events.ERROR, (_, data) => {
        if (this.hls !== hls) return;
        if (data?.fatal) this.onFatal?.(data);
        else if (data?.type === 'networkError' && debugOn()) debugLog('player', `converted stream: ${streamTrouble(data)}, trying again`);
      });
      hls.loadSource(url);
      hls.attachMedia(this.el);
    } else {
      this.el.src = prefetched && !isHls ? prefetched.objectUrl() : url;
      this.el.load();
    }
  }

  hasSource() {
    return !!(this.el.getAttribute('src') || this.hls);
  }

  // A converted stream loaded as the next track, now playing: it loads as
  // far ahead as usual.
  loadAhead() {
    if (!this.hls) return;
    this.hls.config.maxBufferLength = HLS_CONFIG.maxBufferLength;
    this.hls.config.maxBufferSize = HLS_CONFIG.maxBufferSize;
  }

  reset() {
    this.gen += 1;
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
    this.gain = 1;
    this.gains = undefined;
    this.useAlbum = false;
    this.level = 1;
    this.playback = null;
    this.kbps = null;
    this.endsAt = null;
    this.played = false;
    this.forced = false;
    this.stall = null;
    this.prefetched = null;
    this.recording = null;
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
    this.why = null; // debug mode: why it's about to pause (see noteWhy)
    this.volume = store.get('volume', 1);
    this.muted = false;
    this.speed = 1;
    this.transcoding = false;
    this.triedTranscode = false;
    this.errorsInRow = 0;
    // A converted stream being started again (see onStreamError): how it's
    // gone for this track, and the wait before the next start.
    this.rescue = null; // { qid, from, tries, played, soft (times carried on on the same stream) }
    this.rescueTimer = null;
    this.rescueOnline = null;
    this.rescueGo = null;
    this.drops = null; // { qid, n, at }: how many times the connection to a track's stream has dropped (see dropped)
    this.asIs = null; // the track whose file has played as it is here (see couldntPlay)
    this.asIsAgain = null; // ...the one whose file was loaded as it is once more, the server handing it over
    this.fileFails = null; // { qid, n }: how many times the server failed a track's file, asked for it (see couldntPlay)
    this.stallRetry = null; // the one loaded again after waiting for data too long (see watchStall)
    this.stallLimits = { ...STALL };
    this.restoredAt = 0;
    this.pendingSeek = null; // seconds, or a function returning seconds (see setPendingSeek)
    this.startingAt = null; // where it was when set, in seconds
    this.loadToken = 0;
    this.loadingQid = null;
    this.loadAutoplay = false;
    this.lastReport = 0;
    this.lastPersist = 0;
    this.persistTimer = null;
    this.persistPending = false;
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
    // Casting to a Plex player: its controls (cast.js), else null.
    this.cast = null;
    // For AirPlay and Google Cast through the browser: a temporary token from
    // the server, used in media addresses while they go to another device.
    this.mediaToken = null; // { value, key }: the server's temporary token, for one server and account
    this.useMediaToken = false;
    this.failedQid = null; // a session track this device couldn't play
    this.held = null; // a track waiting for the connection (see holdFor)
    this.driftHold = 0;
    this.aheadOf = null;

    this.history = []; // ids of tracks played this session, oldest first (DJ modes avoid repeats)
    // The change to the next track under way: { plan, out, inn } (see nextPlan).
    this.transition = null;
    this.transitionTimer = null;
    this.fadeTimer = null;
    this.spans = new Map(); // track id -> where its music starts and ends, null if unknown

    this.decks.forEach((d, i) => this.bind(d, i));
    this.ahead = new Prefetcher(this); // loading ahead (Settings › Playback)
    this.addEventListener('track', () => {
      const t = this.current;
      if (!t || this.history[this.history.length - 1] === t.id) return;
      this.history.push(t.id);
      if (this.history.length > 300) this.history.splice(0, this.history.length - 300);
    });
    this.applyVolume();
    this.setupMediaSession();
    window.addEventListener('pagehide', () => {
      if (this.persistPending) this.persist(true);
      this.savePosition();
      this.saveProgress(true);
      if (this.state === 'playing') this.report('stopped', this.current, this.time, true);
    });
    on('source', ({ serverChanged }) => serverChanged && this.restore());
    on('signout', () => {
      this.mediaToken = null;
      this.useMediaToken = false;
      this.reset();
    });
    this.quality = app.settings.quality;
    this.qualityLater = false; // a change of Streaming quality waiting for a change of track to finish
    this.loudness = !!app.settings.loudness;
    this.resumeAs = null; // { qid, playback, forced }: a paused track's source, dropped as Streaming quality changed (see qualityChanged)
    on('settings', (s) => {
      if (!s.playbackSpeed && this.speed !== 1) this.setSpeed(1);
      // Its button gone, a sleep timer that's set goes too.
      if (!s.sleepTimer && this.sleepActive) this.setSleep(null);
      if (s.quality !== this.quality) {
        this.quality = s.quality;
        this.qualityChanged();
      }
      if (!!s.loudness !== this.loudness) {
        this.loudness = !!s.loudness;
        for (const d of this.decks) this.levelDeck(d);
      }
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
    if (this.cast) return this.cast.time();
    // Waiting for the connection (see holdFor): where it goes on from.
    if (this.held && this.held.qid === this.current?.qid) return this.held.at;
    // Starting part-way (a stream started again, say): there until it's
    // ready to be moved there.
    if (this.startingAt != null && (!this.deck.hasSource() || this.audio.readyState < 1)) return this.startingAt;
    if (!this.deck.hasSource()) return this.restoredAt || 0;
    return this.audio.currentTime || 0;
  }
  get duration() {
    const d = this.cast ? this.cast.duration() : this.audio.duration;
    const length = Number.isFinite(d) && d > 0 ? d : (this.current?.duration || 0) / 1000;
    // A converted stream that stopped short ends where its sound does.
    const end = this.cast ? null : this.deck.endsAt;
    return end != null && end > 0 && end < length ? end : length;
  }
  // Playing through AirPlay or Google Cast (the browser's own picker): the
  // browser sends this element's sound to the device, so playback stays on
  // this one element (no crossfades: the other element isn't connected).
  get routed() {
    return this.deck.el.remote?.state === 'connected';
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
    // (Pauses asked for here are told apart from the browser's own: see
    // 'pause' below.)
    const pause = el.pause.bind(el);
    el.pause = () => {
      if (!el.paused) el.pausedHere = true;
      return pause();
    };
    // (Loading something else drops the 'pause' still to come: so it's
    // forgotten as the audio loads, or plays, again.)
    const forget = () => (el.pausedHere = false);
    el.addEventListener('play', forget);
    el.addEventListener('emptied', forget);
    // A next track that fails while it's fading in: the change is called
    // off, and it's loaded again when it's due.
    const spareFailed = () => {
      if (this.transition?.inn === deck) this.cancelTransition();
      deck.reset();
    };
    deck.onFatal = (data) => (mine() ? this.onStreamError(deck, data) : spareFailed());
    el.addEventListener('playing', () => {
      // (A next track starts playing before it's the current one.)
      deck.played = true;
      if (this.rescue && this.rescue.qid === deck.qid) this.rescue.played = true;
      if (!mine()) return;
      this.switching = false;
      this.errorsInRow = 0;
      this.noteStall(deck, true);
      this.unwatchStall(deck);
      this.setState('playing');
    });
    el.addEventListener('pause', () => {
      const here = el.pausedHere;
      el.pausedHere = false;
      if (el.ended || this.switching) return;
      const tr = this.transition;
      if (tr) {
        // During a change of track it's paused once both tracks are.
        if (tr.out.el.paused && tr.inn.el.paused) {
          if (!here) this.noteWhy(this.notHere(el), { warn: true });
          this.setState('paused');
          this.saveProgress(true);
        }
        return;
      }
      if (!mine()) return;
      if (!here) this.noteWhy(this.notHere(el), { warn: true });
      this.setState('paused');
      this.saveProgress(true);
    });
    el.addEventListener('waiting', () => {
      if (!mine() || this.endReached(deck, 1)) return;
      this.noteStall(deck);
      this.watchStall(deck);
      this.setState('loading');
      // A stream waiting to be started again (see onStreamError) that's
      // run out of what's buffered, or been moved past it: now. One that
      // stopped short of its end, moved back from there: from there.
      if (this.rescueTimer) this.rescueGo?.();
      else if (deck.endsAt != null && !this.rescueOnline) {
        deck.endsAt = null;
        this.onStreamError(deck, { type: 'networkError', details: 'moved back into a stream that had stopped' });
      }
    });
    el.addEventListener('timeupdate', () => mine() && this.onTime());
    el.addEventListener('durationchange', () => mine() && this.queueTime());
    el.addEventListener('loadedmetadata', () => {
      // (A file that's played as it is here: see couldntPlay.)
      if (mine() && !deck.isHls && deck.qid != null) this.asIs = deck.qid;
      if (!mine() || this.pendingSeek == null) return;
      try {
        el.currentTime = resolve(this.pendingSeek);
      } catch {
        /* not seekable yet */
      }
      this.setPendingSeek(null);
      this.queueTime();
    });
    el.addEventListener('ended', () => mine() && this.onEnded());
    el.addEventListener('error', () => {
      if (!deck.hasSource()) return;
      if (!mine()) spareFailed(); // a failed preload: just load it normally later
      else if (deck.isHls) this.onStreamError(deck, { type: 'mediaError', details: `media error ${el.error?.code ?? ''}`.trim() });
      else this.onError();
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
    if (this.endReached(this.deck)) return;
    this.queueTime();
    this.learnSpans();
    this.maybePreload();
    this.planTransition();
    this.followClock();
    if (this.state === 'playing') this.report('playing');
    const now = Date.now();
    if (now - this.lastPersist > 5000) {
      this.lastPersist = now;
      this.savePosition();
      this.saveProgress();
    }
    if (now - this.lastPosState > 1000) {
      this.lastPosState = now;
      this.updatePositionState();
    }
  }

  setState(s) {
    if (s === this.state) return;
    // (Not while another device or a Plex player plays: it paused there,
    // and says why there.)
    // A load that wasn't to play ends paused too: from loading, only when
    // something was noted.
    const noted = this.why && performance.now() - this.why.at < 5000 ? this.why : null;
    if (s === 'paused' && (this.state === 'playing' || (this.state === 'loading' && noted)) && debugOn() && !this.cast) {
      const t = this.current;
      debugLog('player', `paused${t ? ` “${t.title}” at ${this.time.toFixed(1)} s` : ''}${this.state === 'loading' ? ' (while loading)' : ''}: ${noted?.text || 'no reason noted'}`, noted?.warn ? 'warn' : 'info');
    }
    if (s === 'paused' || s === 'playing') this.why = null;
    this.state = s;
    const ms = navigator.mediaSession;
    if (ms && s !== 'loading' && app.settings.mediaSession !== false) ms.playbackState = s === 'playing' ? 'playing' : s === 'paused' ? 'paused' : 'none';
    if (s === 'playing' || s === 'paused') this.report(s, this.current, this.time, true);
    this.emit('state');
  }

  // ---------- sources ----------

  // Given to AirPlay and Cast: the server's temporary token, never the account's own.
  setMediaToken(value) {
    this.mediaToken = app.server ? { value, key: tokenKey(app.server) } : null;
  }

  // `playback`: the track's playback, for a converted stream (see playbackId).
  sourceFor(track, forceTranscode, playback) {
    const s = app.server;
    const quality = app.settings.quality;
    // On AirPlay or Cast, a temporary token for another server or account
    // isn't used, and neither is the account's own: nothing plays until
    // there's one for this server.
    const token = this.useMediaToken ? (this.mediaToken?.key === tokenKey(s) ? this.mediaToken.value : '') : undefined;
    // A lower quality is asked for: tracks already at it or below (a 128 kbps
    // MP3, say) play as they are; converting them would only use more data.
    const already = quality !== 'original' && !isLossless(track.codec) && track.bitrate > 0 && track.bitrate <= (Number(quality) || 320);
    const direct = (quality === 'original' || already) && !forceTranscode && track.partKey && (!track.codec || canPlayCodec(track.codec));
    if (direct) return { url: s.directUrl(track, token), hls: false, kbps: null };
    const kbps = quality === 'original' ? 320 : Number(quality) || 320;
    return { url: s.transcodeUrl(track, kbps, token, playback), hls: true, kbps };
  }

  // `transcode`: converted whatever Streaming quality says (see
  // Deck.forced); `resume`: the same track again, as the same playback (a
  // stream started again, or the server converting a file that didn't play
  // as it is).
  async load(index, { autoplay = true, startAt = 0, transcode = false, reportPrev = true, resume = false } = {}) {
    this.cancelTransition();
    this.cancelRescue();
    for (const d of this.decks) this.unwatchStall(d);
    this.qualityLater = false; // (it loads as Streaming quality now says)
    if (!resume) {
      this.rescue = null;
      this.drops = null;
      this.stallRetry = null;
    }
    const prev = this.current;
    // (A track held while paused, as Streaming quality changed, is played
    // again as the same playback: see qualityChanged.)
    const held = this.resumeAs?.qid === prev?.qid ? this.resumeAs : null;
    if (reportPrev) this.endHere(prev);
    this.resumeAs = null;
    this.saveProgress(true);
    // (Only now: a track waiting for the connection was where its hold has
    // it, for the two above: see time.)
    this.cancelHold();
    this.index = index;
    const track = this.current;
    if (!track || !app.server) return this.reset();

    const token = ++this.loadToken;
    const quality = app.settings.quality;
    // Loaded ahead, or kept once played (prefetch.js): from memory, as the
    // playback it was loaded ahead as (or, played again, another). Not to
    // start a track again, which goes back to its stream.
    const pre = !resume && !transcode ? this.ahead.ready(track, this.sourceFor(track, false)) : null;
    const playback =
      (pre && this.ahead.playbackFor(pre)) || (resume && this.deck.qid === track.qid && this.deck.playback) || (resume && held?.qid === track.qid && held.playback) || playbackId();
    const src = pre?.src || this.sourceFor(track, transcode, playback);
    this.triedTranscode = src.hls;
    this.transcoding = src.hls;
    this.restoredAt = 0;
    if (!startAt && !this.remote) startAt = this.savedProgress(track);
    this.setPendingSeek(resolve(startAt) > 0 ? startAt : null);
    this.lastReport = 0;
    this.loadAutoplay = autoplay;
    this.loadingQid = track.qid;
    this.switching = autoplay;
    if (this.failedQid !== track.qid) this.failedQid = null;
    this.setState('loading');
    this.emit('track');
    this.updateMediaSession();

    const spare = this.spare;
    if (!transcode && !this.routed && spare.qid === track.qid && sameSource(spare, src)) {
      // Already buffered by the preloader: switch decks. Its metadata has
      // loaded already, so a start position is applied here.
      this.deck.el.pause();
      this.deck.reset();
      this.active ^= 1;
      this.deck.loadAhead();
      if (this.pendingSeek != null) {
        if (this.audio.readyState >= 1) {
          try {
            this.audio.currentTime = resolve(this.pendingSeek);
          } catch {
            /* not seekable yet */
          }
          this.setPendingSeek(null);
        }
      } else if (this.audio.currentTime > 0.3) {
        // Waiting where a change of track would have started it: from the top.
        try {
          this.audio.currentTime = 0;
        } catch {
          /* not seekable */
        }
      }
    } else {
      this.deck.el.pause();
      spare.reset();
      // A converted stream played from the top (as Streaming quality has
      // it): kept as it comes in, to play again (Keep played tracks).
      const recording = !pre && !transcode && src.hls && this.startingAt == null ? this.ahead.record(track, src, playback, this.deck) : null;
      try {
        await this.deck.load(src.url, src.hls, { playback, startAt: this.startingAt || 0, kbps: src.kbps, prefetched: pre, recording });
      } catch (err) {
        // (Stopped, as the deck was reset, with no other track loading
        // since: nothing's loading now, either.)
        if (token === this.loadToken) {
          this.loadingQid = null;
          if (err?.name !== 'AbortError') this.onError(err);
        }
        return;
      }
      if (token !== this.loadToken) return;
      this.deck.qid = track.qid;
      this.deck.forced = transcode || false;
    }
    // Loudness levelling: its level before it plays (its details are
    // usually in hand already: Now Playing and smart fades ask for them).
    const levelled = this.levelDeck(this.deck);
    if (this.levelling && this.deck.gains === undefined) {
      await Promise.race([levelled, new Promise((r) => setTimeout(r, LEVEL_WAIT))]);
      if (token !== this.loadToken) return;
    }
    this.loadingQid = null;
    this.applyVolume();
    this.applySpeed();
    this.persist();
    if (this.loadAutoplay) this._play();
    else this.setState('paused');
    // Streaming quality changed while it loaded: the new way, from here.
    if (app.settings.quality !== quality) this.qualityChanged();
  }

  get fades() {
    return this.remote ? 'off' : app.settings.fades || 'off';
  }

  // Load the next track into the other element a little before it's due.
  maybePreload() {
    if (this.transition || this.repeat === 'one' || this.routed) return;
    if (!app.settings.gapless && this.fades === 'off') return;
    const ni = this.nextIndex();
    if (ni === -1 || !(this.duration > 0)) return;
    const plan = this.nextPlan();
    if ((plan ? plan.at : this.duration) - this.time > PRELOAD_AT) return;
    const next = this.queue[ni];
    const spare = this.spare;
    // Loaded ahead already (prefetch.js), it needs nothing from the network;
    // loading ahead now, it's waited for if it'll be there shortly before
    // it's due.
    const pre = this.ahead.ready(next, this.sourceFor(next, false));
    if (spare.qid === next.qid || spare.loadingQid === next.qid || (!pre && !this.roomToPreload())) return;
    const due = (plan ? plan.at : this.duration) - this.time;
    if (!pre && due > PRELOAD_LAST && this.ahead.waitingFor(next, due - PRELOAD_LAST)) return;
    const playback = (pre && this.ahead.playbackFor(pre)) || playbackId();
    const src = pre?.src || this.sourceFor(next, false, playback);
    // From the top (it may be played from there), as far as where the
    // change of track would start it and some way past. (A converted stream
    // coming in is kept as it comes, to play again: see Prefetcher.record.)
    const ahead = PRELOAD_BUFFER + (plan?.startAt || 0);
    const recording = pre ? null : this.ahead.record(next, src, playback, spare);
    const loading = spare.load(src.url, src.hls, { playback, ahead, kbps: src.kbps, prefetched: pre, recording });
    const gen = spare.gen;
    spare.loadingQid = next.qid;
    // Coming in as it plays: it isn't loaded ahead as well.
    if (!pre) this.ahead.plan();
    loading
      .then(() => {
        if (spare.gen !== gen) return;
        spare.qid = next.qid;
        this.applyVolume();
        this.levelDeck(spare);
      })
      .catch(() => spare.gen === gen && spare.reset());
  }

  // Streaming quality changed: the track playing carries on from where it
  // is, the new way (converted as the file doesn't play here, at the new
  // bitrate), and a next track loaded the old way is loaded again when due.
  // During a change of track, once it's done (changing either track then
  // would be heard); paused, once it's played again.
  qualityChanged() {
    if (this.cast) return;
    if (this.transition) {
      this.qualityLater = true;
      return;
    }
    this.qualityLater = false;
    // (A stream that kept dropping is a new one now: see dropped.)
    this.drops = null;
    const ni = this.nextIndex();
    const next = ni === -1 ? null : this.queue[ni];
    const spare = this.spare;
    const preloaded = spare.qid ?? spare.loadingQid;
    if (preloaded != null && next && preloaded === next.qid && !sameSource(spare, this.sourceFor(next, false))) spare.reset();
    const t = this.current;
    const deck = this.deck;
    if (!t || this.routed) return;
    if (!deck.hasSource()) {
      // Paused after an earlier change (see below): it still loads the new way when played.
      if (this.resumeAs?.qid === t.qid) this.transcoding = this.sourceFor(t, this.resumeAs.forced).hls;
      return;
    }
    if (deck.qid !== t.qid) return;
    const forced = deck.forced === true;
    if (sameSource(deck, this.sourceFor(t, forced))) return;
    const at = this.time;
    const playing = this.isPlaying && !deck.el.paused;
    if (!playing && !this.remote) {
      // Paused: it loads the new way when played, from where it is, as the
      // same playback (still converted, if the file doesn't play here).
      // Nothing is fetched meanwhile, or shown to your other devices as
      // playing.
      this.savePosition();
      this.saveProgress(true);
      this.cancelRescue();
      this.setPendingSeek(null);
      this.resumeAs = { qid: t.qid, playback: deck.playback, forced };
      deck.reset();
      this.restoredAt = at;
      this.transcoding = this.sourceFor(t, forced).hls;
      this.queueTime();
      return;
    }
    this.load(this.index, {
      autoplay: playing,
      startAt: this.remote ? () => this.remote?.expectedTime(t.sid) ?? at : at,
      transcode: forced,
      reportPrev: false,
      resume: true,
    });
  }

  // Debug mode: how long playback waited for data part-way through a track
  // (`over`: it plays again), how much was buffered, and whether the next
  // track was loading meanwhile.
  noteStall(deck, over = false) {
    if (!debugOn()) return;
    const el = deck.el;
    if (!over) {
      if (deck.played && !deck.stall) deck.stall = { since: performance.now(), t: el.currentTime, ahead: bufferedEnd(el, el.currentTime) - el.currentTime };
      return;
    }
    const s = deck.stall;
    deck.stall = null;
    const waited = s ? (performance.now() - s.since) / 1000 : 0;
    if (waited < 0.3) return;
    const spare = this.spare;
    const next = spare.loadingQid != null || spare.qid != null ? 'the next track loading' : 'nothing else loading';
    debugLog(
      'player',
      `waited ${waited.toFixed(1)} s for “${this.current?.title}” at ${s.t.toFixed(1)} s of ${this.duration.toFixed(1)} (${deck.isHls ? 'converted' : 'original file'}, ${s.ahead.toFixed(1)} s buffered, ${next})`,
    );
  }

  // An original file waiting for data: said once it's waited a while (debug
  // mode), and if nothing more has come in after a longer while, it's loaded
  // again from where it got to (once a track: past that, the browser's own
  // retries). Converted streams have their own (see onStreamError).
  watchStall(deck) {
    this.unwatchStall(deck);
    const el = deck.el;
    const qid = deck.qid;
    const gen = deck.gen;
    const t0 = el.currentTime;
    const got = bufferedEnd(el, t0);
    // (Still this load of this track, waiting: not one loaded since, the
    // same track again, say. During a change of track: see stallFade.)
    const stillHere = () => deck.gen === gen && deck.qid === qid && this.deck === deck && this.state === 'loading' && !el.paused;
    const waiting = () => stillHere() && !this.transition;
    deck.stallSay = setTimeout(() => {
      if (!stillHere()) return;
      debugLog(
        'player',
        `still waiting for data for “${this.current?.title}” at ${el.currentTime.toFixed(1)} s, after ${this.stallLimits.say / 1000} s (${deck.isHls ? 'converted' : 'original file'}, buffered to ${bufferedEnd(el, el.currentTime).toFixed(1)} s, network ${el.networkState}, ready ${el.readyState})`,
        'warn',
      );
    }, this.stallLimits.say);
    // Fading out as the next track fades in: the fade (timed by this one)
    // would wait with it, so it's done with, and the next one plays on.
    deck.stallFade = setTimeout(() => {
      if (!stillHere() || this.transition?.out !== deck) return;
      debugLog('player', `“${this.current?.title}” stopped coming as it faded out: on to the next track`, 'warn');
      this.finishTransition();
      const now = this.deck.el;
      if (!now.paused && now.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) this.setState('playing');
    }, this.stallLimits.fade);
    if (deck.isHls) return;
    deck.stallReload = setTimeout(() => {
      const track = this.current;
      if (!waiting() || !track || track.qid !== qid || this.stallRetry === qid) return;
      // Offline: watched again once it's back.
      if (navigator.onLine === false) return addEventListener('online', () => waiting() && this.watchStall(deck), { once: true });
      if (bufferedEnd(el, el.currentTime) > got + 0.5) return this.watchStall(deck); // something came in: wait again
      this.stallRetry = qid;
      const at = el.currentTime;
      debugLog('player', `nothing more of “${track.title}” came in for ${this.stallLimits.reload / 1000} s: loading the file again from ${at.toFixed(1)} s`, 'warn');
      // (In a Play Together session, from where the session has got to.)
      const startAt = this.remote ? () => this.remote?.expectedTime(track.sid) ?? at : at;
      this.load(this.index, { startAt, reportPrev: false, resume: true });
    }, this.stallLimits.reload);
  }

  unwatchStall(deck) {
    clearTimeout(deck.stallSay);
    clearTimeout(deck.stallReload);
    clearTimeout(deck.stallFade);
    deck.stallSay = deck.stallReload = deck.stallFade = 0;
  }

  // Whether the next track can start loading without taking what this one
  // still needs: this one has loaded to its end, or has PRELOAD_AHEAD
  // seconds buffered (playing a file as it is, with the browser no longer
  // fetching it: it has what it wants for now).
  roomToPreload() {
    const el = this.audio;
    const t = el.currentTime || 0;
    const ahead = bufferedEnd(el, t) - t;
    const left = this.duration - t;
    if (ahead >= left - 0.5) return true;
    if (this.deck.isHls) return ahead >= Math.min(PRELOAD_AHEAD, left);
    return ahead >= PRELOAD_AHEAD && el.networkState !== HTMLMediaElement.NETWORK_LOADING;
  }

  // Whether loading ahead (prefetch.js) can use the connection now: the
  // track playing has what it needs (it plays from memory, or has loaded to
  // its end, or, a file, as far as the browser wants for now), and the next
  // one isn't coming from the network.
  roomToFetch() {
    if (this.cast || this.routed || !this.deck.hasSource() || this.state === 'loading' || this.loadingQid != null) return false;
    const spare = this.spare;
    if (spare.loadingQid != null && !spare.prefetched) return false;
    if (this.aheadUnlimited()) return true;
    const el = this.audio;
    const t = el.currentTime || 0;
    return !this.deck.isHls && bufferedEnd(el, t) - t >= PRELOAD_AHEAD && el.networkState !== HTMLMediaElement.NETWORK_LOADING;
  }

  // Whether the track playing has all it'll need from the network (it plays
  // from memory, or has loaded to its end): loading ahead goes as fast as
  // the connection allows then. (Before, it's held back: see prefetch.js.)
  aheadUnlimited() {
    if (this.deck.prefetched) return true;
    const el = this.audio;
    const t = el.currentTime || 0;
    return this.duration > 0 && bufferedEnd(el, t) - t >= this.duration - t - 0.5;
  }

  // The track playing's bitrate (kbps) as it comes in: its converted
  // stream's, or its file's (a CD's, if Plex doesn't say).
  playingBitrate() {
    if (this.deck.isHls) return this.deck.kbps || 320;
    return Number(this.current?.bitrate) || 1411;
  }

  // ---------- loudness levelling ----------

  // On, where the browser lets a page set the volume (not iPhone or iPad).
  get levelling() {
    return this.loudness && canFade;
  }

  // An album played in order (the track before or after this one follows
  // on, on the same album): its album's gain, which keeps the album's own
  // ups and downs from track to track.
  albumOrder(i) {
    const t = this.queue[i];
    return !!t && (followsOnAlbum(this.queue[i - 1], t) || followsOnAlbum(t, this.queue[i + 1]));
  }

  setLevel(deck, gains, useAlbum) {
    deck.gains = gains;
    deck.useAlbum = useAlbum;
    deck.level = this.levelling ? levelFor(gains, useAlbum) : 1;
    this.applyVolume();
  }

  // A deck's level, for the track it has (its gains asked for if need be).
  async levelDeck(deck) {
    const qid = deck.qid ?? deck.loadingQid;
    const i = qid == null ? -1 : this.queue.findIndex((t) => t.qid === qid);
    if (i === -1) return;
    const useAlbum = this.albumOrder(i);
    if (!this.levelling || deck.gains !== undefined) {
      this.setLevel(deck, deck.gains, useAlbum);
      return;
    }
    const gains = await gainsOf(this.queue[i]).catch(() => null);
    if ((deck.qid ?? deck.loadingQid) === qid && deck.gains === undefined) this.setLevel(deck, gains, useAlbum);
  }

  // ---------- transitions ----------
  // How the next track takes over, worked out afresh as the end nears:
  //   gapless  it starts as this one ends (albums, or with Crossfade off)
  //   fade     it fades in as this one fades out, ending where this one's
  //            music ends ("smart" skips the silence after it, and before
  //            the next track's music starts, and starts over a quiet
  //            ending rather than waiting for it to play out)
  //   cut      straight on where the music ends, for browsers that can't
  //            fade (Safari on iPhone and iPad)
  // The next track becomes the current one once the change is done, so its
  // clock then shows how much of it has played already.
  // Returns { ni, next, kind, at, fade, startAt } or null; `at` is when the
  // change starts (seconds into this track), `startAt` where the next track
  // starts.
  nextPlan() {
    if (this.remote || this.routed || this.repeat === 'one' || this.sleepEndOfTrack) return null;
    const cur = this.current;
    const ni = this.nextIndex();
    const d = this.duration;
    if (!cur || ni === -1 || !(d > 0)) return null;
    const next = this.queue[ni];
    const mode = this.fades;
    // Where the browser can't play two tracks at once reliably (it can't
    // fade either), the next one starts as the current one is stopped.
    const gapless = app.settings.gapless ? { ni, next, kind: canFade ? 'gapless' : 'cut', at: Math.max(0, d - GAPLESS_LEAD), startAt: 0 } : null;
    if (mode === 'off' || (mode === 'smart' && followsOnAlbum(cur, next))) return gapless;
    let end = d;
    let startAt = 0;
    let quietFrom = null;
    if (mode === 'smart') {
      const a = this.spans.get(cur.id);
      const b = this.spans.get(next.id);
      if (a) end = Math.min(d, a.end);
      if (b && b.start <= MAX_SKIP_IN) startAt = b.start;
      quietFrom = a?.quietFrom?.[app.settings.quietEndings ?? 'quiet'] ?? null;
    }
    // Without a fade, a quiet ending plays out: cutting it off part-way
    // would be heard.
    if (!canFade) return end < d - 1 || startAt ? { ni, next, kind: 'cut', at: end, startAt } : gapless;
    const nextLen = (next.duration || 0) / 1000 || Infinity;
    const set = Math.max(0.5, Math.min(Number(app.settings.fadeLength) || 5, end / 3, nextLen / 3));
    let at = end - set;
    let fade = set;
    // Over a quiet ending, the fade starts where it does, but no more than
    // MAX_QUIET_LEAD seconds before the music ends (and not in the first half
    // of the track, or so near the end there's no time for SMART_FADE_MIN
    // seconds of it), and lasts as long as the ending takes to go nearly
    // silent (smartFade): its own length, not Crossfade length.
    if (quietFrom != null) {
      at = Math.min(Math.max(quietFrom, end - MAX_QUIET_LEAD, end / 2), end - Math.min(set, SMART_FADE_MIN));
      fade = Math.max(0.5, Math.min(smartFade(this.spans.get(cur.id), at, end, set), nextLen / 3));
    }
    return { ni, next, kind: 'fade', at: Math.max(0, at), fade, startAt };
  }

  // Where the music starts and ends in the current track and the next one
  // (for "smart" crossfades), from the server's loudness analysis.
  learnSpans() {
    if (this.fades !== 'smart') return;
    this.learn(this.current);
    if (this.duration - this.time < 60) {
      const ni = this.nextIndex();
      if (ni !== -1) this.learn(this.queue[ni]);
    }
  }

  async learn(track) {
    if (!track?.id || this.spans.has(track.id) || !app.server) return;
    this.spans.set(track.id, null); // asked once; null until known (or for good, if it isn't analysed)
    while (this.spans.size > 40) this.spans.delete(this.spans.keys().next().value);
    try {
      const values = await loudnessOf(track);
      if (values && this.spans.has(track.id)) this.spans.set(track.id, audibleSpan(values, (track.duration || 0) / 1000));
    } catch {
      /* no analysis: the change happens at the end of the file */
    }
  }

  // Called as the track plays: when the change is less than a second or so
  // away, time it precisely (time updates only come a few times a second).
  planTransition() {
    if (this.transition || this.transitionTimer || this.state !== 'playing' || this.switching) return;
    const plan = this.nextPlan();
    if (!plan || this.spare.qid !== plan.next.qid) return;
    const wait = (plan.at - this.audio.currentTime) / (this.audio.playbackRate || 1);
    if (wait > 1.2) return;
    this.transitionTimer = setTimeout(() => {
      this.transitionTimer = null;
      this.beginTransition();
    }, Math.max(0, wait * 1000));
  }

  beginTransition() {
    const plan = this.nextPlan();
    const out = this.deck;
    const inn = this.spare;
    if (!plan || this.transition || this.state !== 'playing' || inn.qid !== plan.next.qid || !inn.hasSource()) return;
    const now = out.el.currentTime;
    if (plan.at - now > 0.25) return; // not yet (it moved): planned again on the next time update
    const ready = canSound(inn.el) && Math.abs((inn.el.currentTime || 0) - plan.startAt) <= 0.3;
    if (plan.kind === 'cut' || (plan.kind === 'fade' && now >= plan.at + plan.fade && ready)) {
      this.switchToSpare(plan.ni, { startAt: plan.startAt });
      return;
    }
    // `from` and `p`: the fade's timing (see stepFade), and how far it's got.
    this.transition = { plan, out, inn, from: null, p: 0 };
    try {
      if (Math.abs((inn.el.currentTime || 0) - plan.startAt) > 0.3) inn.el.currentTime = plan.startAt;
    } catch {
      /* not seekable: it starts from the top */
    }
    inn.gain = plan.kind === 'fade' ? 0 : 1;
    this.applyVolume();
    this.applySpeed();
    inn.el.play()?.catch(() => this.transition?.inn === inn && this.cancelTransition());
    if (plan.kind === 'fade') {
      this.stepFade();
      this.fadeTimer = setInterval(() => this.stepFade(), 40);
    } else {
      // Gapless: the current track's end completes the change (onEnded);
      // this is in case its end never comes.
      const left = (this.duration - now) / (out.el.playbackRate || 1);
      this.fadeTimer = setTimeout(() => !this.transition?.out.el.paused && this.finishTransition(), (left + 2) * 1000);
    }
  }

  // Equal-power crossfade, driven by how far the outgoing track has played
  // (so pausing pauses the fade, and the playback speed is allowed for).
  // It goes on only while the next track sounds: until it does, or while
  // it waits for data part-way (its stream still on its way, on a slow
  // connection), the fade holds where it's got to (this one at full
  // volume, before it starts), and then fits into what's left before this
  // one's music ends.
  stepFade() {
    const tr = this.transition;
    if (!tr || tr.out.el.paused) return;
    if (tr.out.el.ended) {
      this.finishTransition();
      return;
    }
    const now = tr.out.el.currentTime;
    const end = tr.plan.at + tr.plan.fade;
    if (tr.inn.el.paused || !canSound(tr.inn.el)) {
      tr.from = null; // worked out again when it sounds
      return;
    }
    if (tr.from == null) {
      // Timed so that it's `p` of the way through now, and done at `end`.
      const t = Math.max(now, tr.plan.at);
      tr.from = (t - tr.p * end) / (1 - tr.p);
    }
    const p = end > tr.from ? (now - tr.from) / (end - tr.from) : 1;
    if (p >= 1) {
      this.finishTransition();
      return;
    }
    const x = Math.max(0, Math.min(1, p));
    tr.p = x;
    tr.out.gain = Math.cos((x * Math.PI) / 2);
    tr.inn.gain = Math.sin((x * Math.PI) / 2);
    this.applyVolume();
  }

  finishTransition() {
    const tr = this.transition;
    if (!tr) return;
    clearInterval(this.fadeTimer);
    this.fadeTimer = null;
    this.transition = null;
    // Found again: the queue may have moved (a track before it removed).
    const ni = this.queue.indexOf(tr.plan.next);
    this.switchToSpare(ni >= 0 ? ni : tr.plan.ni);
  }

  // Call off a change under way: the next track goes back to waiting where
  // it would start, and the current one plays on at full volume.
  cancelTransition() {
    clearTimeout(this.transitionTimer);
    this.transitionTimer = null;
    const tr = this.transition;
    if (!tr) return;
    clearInterval(this.fadeTimer);
    this.fadeTimer = null;
    this.transition = null;
    tr.inn.el.pause();
    try {
      tr.inn.el.currentTime = tr.plan.startAt || 0;
    } catch {
      /* not seekable */
    }
    tr.out.gain = 1;
    tr.inn.gain = 1;
    this.applyVolume();
    // Streaming quality changed during it: now, once what called it off is
    // done (see qualityChanged).
    if (this.qualityLater) queueMicrotask(() => this.qualityLater && !this.transition && this.qualityChanged());
  }

  // After the queue changes: a change to a track that's no longer next is
  // called off.
  queueChanged() {
    const tr = this.transition;
    if (!tr) return;
    const ni = this.nextIndex();
    if (ni === -1 || this.queue[ni].qid !== tr.plan.next.qid) this.cancelTransition();
  }

  // The other element (with the next track loaded, and perhaps playing)
  // becomes the current one.
  switchToSpare(ni, { reported = false, startAt = null } = {}) {
    this.cancelRescue();
    this.rescue = null;
    this.setPendingSeek(null); // (the next track starts where `startAt` says)
    const prev = this.current;
    if (!reported) {
      this.clearProgress(prev);
      this.report('stopped', prev, this.duration, true);
    }
    const old = this.deck;
    this.active ^= 1;
    this.index = ni;
    const deck = this.deck;
    deck.gain = 1;
    deck.loadAhead();
    this.transcoding = deck.isHls;
    this.triedTranscode = deck.isHls;
    this.lastReport = 0;
    if (startAt != null && deck.el.paused) {
      try {
        if (Math.abs(deck.el.currentTime - startAt) > 0.3) deck.el.currentTime = startAt;
      } catch {
        /* not seekable */
      }
    }
    old.el.pause();
    old.reset();
    this.applyVolume();
    this.applySpeed();
    if (deck.el.paused) this.audio.play()?.catch((err) => this.onPlayError(err));
    // Waiting for data already (it says when it plays: see bind).
    else if (deck.el.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) this.setState('loading');
    this.emit('track');
    this.updateMediaSession();
    this.persist();
    // Streaming quality changed during the change of track: now.
    if (this.qualityLater) this.qualityChanged();
  }

  // ---------- transport ----------
  // Public methods are what buttons, keys and the lock screen call. In a
  // Play Together session they go to the session; the _underscored ones
  // act on this device only.

  play(why = 'the app') {
    if (this.remote) return this.remote.play();
    if (this.cast) return this.cast.play();
    this.noteWhy(why, { play: true });
    this._play();
  }

  _play() {
    if (!this.current || this.cast) return;
    this.unlock();
    // (Waiting for the connection: tried again now, playing once it's back.)
    if (this.held?.qid === this.current.qid) {
      this.loadAutoplay = true;
      this.setState('loading');
      this.held.again();
      return;
    }
    if (!this.deck.hasSource()) {
      const held = this.resumeAs?.qid === this.current.qid ? this.resumeAs : null;
      this.load(this.index, { startAt: this.restoredAt || 0, reportPrev: false, transcode: held?.forced || false, resume: !!held });
      return;
    }
    this.transition?.inn.el.play()?.catch(() => {});
    this.audio.play()?.catch((err) => this.onPlayError(err));
  }

  // `why`: who asked, for the log in debug mode ("the space bar", "a pause
  // from Dan's phone"). In a Play Together session this device pauses too.
  pause(why = 'the app') {
    this.noteWhy(why);
    if (this.remote) return this.remote.pause();
    if (this.cast) return this.cast.pause();
    this._pause();
  }

  _pause() {
    if (this.cast) return;
    this.switching = false;
    this.loadAutoplay = false;
    clearTimeout(this.transitionTimer);
    this.transitionTimer = null;
    this.audio.pause();
    if (this.transition) {
      // Both tracks pause, and the fade carries on from here.
      this.transition.inn.el.pause();
      this.setState('paused');
      this.saveProgress(true);
    }
    if (this.state === 'loading') this.setState('paused');
  }

  toggle(why = 'the play/pause button') {
    this.noteWhy(why, { play: !this.isPlaying });
    if (this.remote) return this.remote.toggle();
    if (this.cast) return this.isPlaying ? this.cast.pause() : this.cast.play();
    if (this.isPlaying) this._pause();
    else this._play();
  }

  // Debug mode: why it's about to pause (logged as it does: see setState),
  // or start playing (logged now). `warn`: not something asked for.
  noteWhy(text, { play = false, warn = false } = {}) {
    if (!debugOn()) return;
    if (play) debugLog('player', `play: ${text}`);
    else this.why = { text, warn, at: performance.now() };
  }

  // A pause of the audio this app didn't ask for: the browser's own, or the
  // system's (its media controls, with Media keys and lock screen off here).
  notHere(el) {
    let buffered = 0;
    try {
      buffered = el.buffered.length ? el.buffered.end(el.buffered.length - 1) : 0;
    } catch {
      /* none */
    }
    const about = [
      document.hidden ? 'the page in the background' : 'the page in view',
      navigator.onLine === false ? 'offline' : '',
      `buffered to ${buffered.toFixed(1)} s`,
      el.error ? `media error ${el.error.code}` : '',
      app.settings.mediaSession === false ? 'Media keys and lock screen off' : '',
    ].filter(Boolean);
    return `the browser or the system, not this app (${about.join(', ')})`;
  }

  seek(sec) {
    if (this.remote) return this.remote.seek(sec);
    if (this.cast) return this.cast.seek(sec);
    this._seek(sec);
  }

  skipBy(sec) {
    this.seek(Math.max(0, this.time + sec));
  }

  _seek(sec, report = true) {
    if (!this.current) return;
    this.cancelTransition();
    const d = this.duration;
    const t = Math.max(0, Math.min(sec, d ? d - 0.25 : sec));
    // (Waiting for the connection: from there once it's back.)
    if (this.held?.qid === this.current.qid) {
      this.held.at = t;
      this.restoredAt = t;
      this.queueTime();
      return;
    }
    if (!this.deck.hasSource()) {
      this.restoredAt = t;
    } else {
      try {
        this.audio.currentTime = t;
      } catch {
        /* not seekable */
      }
    }
    // Still loading, to start part-way: it starts here instead.
    if (this.pendingSeek != null) this.setPendingSeek(t);
    this.queueTime();
    this.updatePositionState();
    if (report) this.report(this.isPlaying ? 'playing' : 'paused', this.current, t, true);
  }

  // Where the track that's loading starts (seconds, or a function returning
  // them, as a Play Together session's clock), applied once it's loaded;
  // null: from the top. Meanwhile the clock shows where it starts.
  setPendingSeek(v) {
    this.pendingSeek = v;
    this.startingAt = v == null ? null : Number(resolve(v)) || 0;
  }

  nextIndex() {
    const i = this.index + 1;
    if (i < this.queue.length) return i;
    if (this.repeat === 'all' && this.queue.length && !this.remote) return 0;
    return -1;
  }

  next() {
    if (this.remote) return this.remote.command({ type: 'next' });
    if (this.cast) return this.cast.next();
    if (this.transition) return this.finishTransition(); // already on its way: straight there
    const ni = this.nextIndex();
    if (ni !== -1) this.load(ni);
  }

  prev() {
    if (this.remote) return this.remote.command({ type: 'prev' });
    if (this.cast) return this.cast.prev();
    this.cancelTransition();
    if (this.time > 3 || this.index <= 0) this._seek(0);
    else this.load(this.index - 1);
  }

  onEnded() {
    if (this.transition) {
      this.finishTransition();
      return;
    }
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
        this.noteWhy('the end of the Play Together queue');
        this.setState('paused');
      }
      return;
    }
    if (this.sleepEndOfTrack) {
      // Sleep timer set to "end of this track": stop here, ready at the next one.
      this.noteWhy('the sleep timer, at the end of the track');
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
      this.rescue = null;
      this.audio.currentTime = 0;
      this._play();
      return;
    }
    this.report('stopped', track, this.duration, true);
    const ni = this.nextIndex();
    if (ni === -1) {
      this.noteWhy('the end of the queue');
      this.setState('paused');
      this.deck.reset();
      this.restoredAt = 0;
      this.emit('time');
      return;
    }
    // The next track is usually loaded already (a change that didn't get
    // to start, e.g. while the page was busy): straight on to it.
    if (this.spare.qid === this.queue[ni].qid) this.switchToSpare(ni, { reported: true });
    else this.load(ni, { reportPrev: false });
  }

  onPlayError(err) {
    this.switching = false;
    if (err?.name === 'NotAllowedError') {
      // (Said with the pause line as it pauses, or alone when it was paused.)
      const refused = `the browser wouldn’t start the sound${this.current ? ` of “${this.current.title}”` : ''} without a tap (NotAllowedError)`;
      if (this.state === 'playing' || this.state === 'loading') this.noteWhy(refused, { warn: true });
      else debugLog('player', refused, 'warn');
      this.setState('paused');
      // The browser wants a tap before it plays sound (e.g. after a reload).
      this.remote?.blocked();
    } else if (err?.name === 'NotSupportedError') {
      // (A source that didn't load, or won't play: the element's error too,
      // which is seen to there: a drop, or a file converted. See onError.)
      debugLog('player', `play() failed: ${err.message || err.name}`);
    } else if (err?.name !== 'AbortError' && navigator.onLine !== false) {
      // (Offline, a source that can't load is the element's error, which
      // waits for the connection: see onError.)
      console.warn('play() failed', err);
    }
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
    // The connection gone (the browser offline, or the server not
    // answering): the track waits for it, where it got to, rather than
    // being converted or skipped as one that won't play is (holdFor). Not
    // in Play Together, which carries on without this device, as below.
    if (!this.remote && !this.cast) {
      const at = this.time;
      const token = this.loadToken;
      const autoplay = this.loadAutoplay || this.state === 'playing' || this.state === 'loading';
      serverAnswers().then((answers) => {
        if (this.current !== track || this.loadToken !== token || this.held) return;
        if (answers || this.remote || this.cast) this.couldntPlay(track, err, media, { at, autoplay });
        else this.holdFor(track, at, autoplay);
      });
      return;
    }
    this.couldntPlay(track, err, media);
  }

  // `at`, `autoplay`: where it had got to as it failed, and whether it was
  // to play (see onError).
  couldntPlay(track, err, media, { at = this.time, autoplay = this.isPlaying } = {}) {
    const startAt = this.remote ? () => this.remote?.expectedTime(track.sid) ?? this.time : at;
    const code = media?.code;
    // The connection to its stream dropped (the server answering otherwise).
    if (track.partKey && code === MediaError.MEDIA_ERR_NETWORK) {
      this.dropped(track, { at, autoplay, startAt });
      return;
    }
    if (this.triedTranscode || !track.partKey) {
      this.couldntPlayHere(track, err);
      return;
    }
    // The browser couldn't play the file as it is, it says ("not supported"):
    // as it says too of a file that didn't come (no answer to it, or the
    // server failing it: a weak signal, say). So for a file that's played as
    // it is here already, or whose connection's dropped, a drop; otherwise
    // the server's asked for it: a drop if it doesn't hand it over; if it
    // does, the file as it is once more (the connection may have been gone
    // a moment), and only then, failing again with the server handing it
    // over, converted (as a file of a format this browser can't play is). A
    // file the server keeps failing (an answer of 500 or more, three times):
    // a track that won't play here. Another error (it came, but couldn't be
    // decoded): converted, as before.
    if (code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED) {
      if (this.asIs === track.qid || this.drops?.qid === track.qid) {
        this.dropped(track, { at, autoplay, startAt });
        return;
      }
      const token = this.loadToken;
      this.fileComes(track).then((comes) => {
        if (this.current !== track || this.loadToken !== token || this.held) return;
        if (comes === true) {
          if (this.asIsAgain === track.qid) {
            this.load(this.index, { startAt, transcode: true, reportPrev: false, resume: true });
          } else {
            this.asIsAgain = track.qid;
            this.load(this.index, { startAt, reportPrev: false, resume: true });
          }
          return;
        }
        if (comes === 'failed') {
          const n = (this.fileFails?.qid === track.qid ? this.fileFails.n : 0) + 1;
          this.fileFails = { qid: track.qid, n };
          if (n >= 3) {
            this.couldntPlayHere(track, err);
            return;
          }
        }
        this.dropped(track, { at, autoplay, startAt });
      });
      return;
    }
    this.load(this.index, { startAt, transcode: true, reportPrev: false, resume: true });
  }

  // The connection to a track's stream dropped, or it didn't come: the same
  // stream again, from where it got to, at once the first time, then a
  // while later each time it drops again (but as the first, once it's
  // played on a minute since: DROPS_FORGOTTEN_S). Never another quality
  // instead (Streaming quality is the listener's to say): once it keeps
  // dropping, the player suggests a lower one ('dropping': see
  // nowplaying.js). In Play Together, which carries on without this device,
  // only a few times, then as a track that won't play here.
  dropped(track, { at, autoplay, startAt }) {
    const recent = this.drops?.qid === track.qid && at - this.drops.at < DROPS_FORGOTTEN_S;
    const n = (recent ? this.drops.n : 0) + 1;
    this.drops = { qid: track.qid, n, at };
    if (n >= 2) this.emit('dropping', { track });
    const again = { startAt, transcode: this.deck.forced || false, reportPrev: false, resume: true };
    if (n === 1 || (this.remote && n <= 3)) {
      this.load(this.index, again);
      return;
    }
    if (this.remote) {
      this.couldntPlayHere(track, null);
      return;
    }
    this.holdFor(track, at, autoplay, { delay: Math.min(30000, 2000 * 2 ** (n - 2)), gone: false, transcode: again.transcode });
  }

  // Whether the server hands over a track's file as it is: true; false for
  // no answer (the connection dropping), 'failed' for an answer of 500 or
  // more (the server failing it), which a media element's error can't be
  // told from (Chromium's says the format's wrong either way). Only the
  // answer's start is read: the rest is let go.
  async fileComes(track) {
    if (!app.server || navigator.onLine === false) return false;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await fetch(this.sourceFor(track, false).url, { cache: 'no-store', signal: ctrl.signal });
      return res.status < 500 ? true : 'failed';
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
      ctrl.abort();
    }
  }

  // A track that won't play on this device: the next one, as it can.
  couldntPlayHere(track, err) {
    this.errorsInRow += 1;
    if (this.remote) {
      // Only this device can't play it; the session carries on, and this
      // device picks up again at the next track.
      this.failedQid = track.qid;
      this.noteWhy('this device couldn’t play the track', { warn: true });
      this.setState('paused');
      this.emit('playerror', { track, err, remote: true });
      return;
    }
    this.emit('playerror', { track, err });
    if (this.errorsInRow >= 3 || this.nextIndex() === -1) {
      this.noteWhy(this.errorsInRow >= 3 ? 'three tracks in a row couldn’t be played' : 'the last track couldn’t be played', { warn: true });
      this.setState('paused');
      return;
    }
    setTimeout(() => this.current === track && this.next(), 1200);
  }

  // A stream the server converts failed part-way, after hls.js had tried
  // again as far as it would (or the browser gave up on it). A network that
  // drops connections now and then (some office proxies), or a server that
  // stopped the stream (after a long pause, say), shouldn't cost the track:
  //   - changing to the next track already, or with no more than the last
  //     few seconds missing before it would (or before the end), it ends
  //     where what's buffered does;
  //   - a dropped connection with plenty still to play: the same stream,
  //     from where it stopped loading (nothing is heard of it), once;
  //   - otherwise a new stream from the server, from where it got to, once
  //     what's buffered has played (RESCUE_TRIES times without getting
  //     further).
  // Only then is it skipped, as before.
  onStreamError(deck, data = {}) {
    const track = this.current;
    if (!track || deck !== this.deck || this.cast || this.rescueTimer || this.rescueOnline) return;
    const el = deck.el;
    // Where it got to (a stream started again that fails before it's loaded
    // is still where that one was to start).
    const t = this.time;
    const end = bufferedEnd(el, t);
    const d = this.duration;
    // After a decoding problem, or with nothing loaded yet, the element
    // doesn't play on: what's buffered isn't heard.
    const stuck = isStuck(el, data);
    debugLog('player', `converted stream of “${track.title}” stopped at ${t.toFixed(1)} s of ${d.toFixed(1)} (buffered to ${end.toFixed(1)}): ${streamTrouble(data)}`, 'warn');
    const plan = this.transition ? null : this.nextPlan();
    const needed = plan ? Math.min(d, plan.at + (plan.kind === 'fade' ? plan.fade : 0)) : d;
    const reach = stuck ? t : end;
    // (In Play Together, a track ends when the session's clock says so: one
    // this device can't play is started again, then left to the others.)
    if (this.transition || (d > 0 && reach > 0 && reach >= needed - END_SLACK && !(stuck && this.remote))) {
      this.rescue = null;
      if (stuck) {
        this.endNow();
      } else {
        deck.endsAt = Math.max(end, t);
        this.endReached(deck, 1);
      }
      return;
    }
    const r = this.rescueFor(track, deck, t);
    if (data.type === 'networkError' && deck.hls && r.soft < RESCUE_SOFT && !(data.response?.code >= 400) && end - t >= RESCUE_AHEAD) {
      r.soft += 1;
      deck.hls.startLoad(end, true);
      return;
    }
    if (r.tries >= (r.played ? RESCUE_TRIES : 1)) {
      this.onError(new Error(`the converted stream kept stopping (${streamTrouble(data)})`));
      return;
    }
    // A dropped connection: what's buffered plays first (starting again
    // stops it).
    const left = !stuck && !el.paused ? (end - t - RESCUE_LEFT) / (el.playbackRate || 1) : 0;
    const wait = Math.max(RESCUE_WAITS[r.tries] ?? RESCUE_WAITS[RESCUE_WAITS.length - 1], left * 1000);
    r.tries += 1;
    const go = () => {
      if (this.rescueGo !== go) return;
      this.cancelRescue();
      if (this.current?.qid !== track.qid || this.deck !== deck || deck.qid !== track.qid) return;
      // Where it is now (it may have played on, or been moved, meanwhile).
      const at = this.time;
      if (this.transition) {
        // The change to the next track has started meanwhile.
        if (isStuck(el, data)) {
          this.endNow();
        } else {
          deck.endsAt = Math.max(bufferedEnd(el, at), at);
          this.endReached(deck, 1);
        }
        return;
      }
      r.from = at;
      debugLog('player', `starting the converted stream of “${track.title}” again at ${at.toFixed(1)} s (${r.tries} of ${RESCUE_TRIES})`);
      this.load(this.index, {
        autoplay: !el.paused || this.loadAutoplay,
        startAt: this.remote ? () => this.remote?.expectedTime(track.sid) ?? at : at,
        // Converted as the file doesn't play here (or its connection kept
        // dropping), or as Streaming quality says.
        transcode: deck.forced,
        reportPrev: false,
        resume: true,
      });
    };
    this.rescueGo = go;
    if (navigator.onLine === false) {
      // Offline: once the connection is back.
      this.rescueOnline = go;
      window.addEventListener('online', go, { once: true });
    } else {
      // (Sooner if it runs out first: see the waiting event in bind.)
      this.rescueTimer = setTimeout(go, wait);
    }
  }

  // How starting the stream again has gone for this track; it starts
  // afresh once the track has got RESCUE_PROGRESS seconds further, or been
  // moved back.
  rescueFor(track, deck, t) {
    let r = this.rescue;
    if (!r || r.qid !== track.qid || t - r.from >= RESCUE_PROGRESS || t < r.from - 1) {
      r = this.rescue = { qid: track.qid, from: t, tries: 0, played: false, soft: 0 };
    }
    r.played ||= deck.played;
    return r;
  }

  cancelRescue() {
    clearTimeout(this.rescueTimer);
    this.rescueTimer = null;
    if (this.rescueOnline) window.removeEventListener('online', this.rescueOnline);
    this.rescueOnline = null;
    this.rescueGo = null;
  }

  // ---------- the connection gone ----------

  // A track that couldn't load, or stopped coming, as the connection's gone
  // (see onError): it waits for it, at `at` (or where it's moved to
  // meanwhile: see _seek), and once the server answers again loads from
  // there (playing, if it was to play and hasn't been paused since), as the
  // same playback. Asked again as the browser says it's online, or the app
  // finds the connection's back (connection.js), and every so often anyway
  // (a phone that loses its signal doesn't always say it's offline). What's
  // loaded already, and changing to it, needs no connection: Next and the
  // rest still work meanwhile. `gone`: false for a stream whose connection
  // keeps dropping, the server answering otherwise (see couldntPlay): it
  // waits `delay` ms, then loads again (as it was: `transcode`), as long as
  // the server answers then.
  holdFor(track, at, autoplay, { delay = 2500, gone = true, transcode = false } = {}) {
    this.cancelHold();
    const qid = track.qid;
    const hold = { qid, at, gone, tries: 0, timer: 0 };
    this.held = hold;
    this.loadAutoplay = autoplay;
    this.setState(autoplay ? 'loading' : 'paused');
    if (gone) {
      debugLog('player', `the connection’s gone: “${track.title}” waits for it, at ${at.toFixed(1)} s`, 'warn');
      connectionLost();
    } else {
      debugLog('player', `the connection to “${track.title}” keeps dropping: loaded again in ${Math.round(delay / 1000)} s, from ${at.toFixed(1)} s`, 'warn');
    }
    // (Not once another device or a Plex player plays: that's theirs.)
    const still = () => this.held === hold && this.current?.qid === qid && !this.cast && !this.remote;
    hold.again = async () => {
      if (!still() || hold.asking) return;
      clearTimeout(hold.timer);
      hold.asking = true;
      const answers = await serverAnswers();
      hold.asking = false;
      if (!still()) return;
      if (!answers) {
        // (Waiting for a stream that kept dropping, and now the server's
        // not answering either: the connection's gone.)
        if (!hold.gone) {
          hold.gone = true;
          connectionLost();
        }
        hold.tries += 1;
        hold.timer = setTimeout(hold.again, Math.min(30000, 2500 * 2 ** Math.min(hold.tries, 4)));
        return;
      }
      const play = this.loadAutoplay && this.state !== 'paused';
      this.cancelHold();
      connectionBack();
      debugLog('player', `${hold.gone ? 'the connection’s back' : 'again'}: “${track.title}” from ${hold.at.toFixed(1)} s`);
      this.load(this.index, { autoplay: play, startAt: hold.at, transcode, reportPrev: false, resume: true });
    };
    window.addEventListener('online', hold.again);
    connection.addEventListener('back', hold.again);
    hold.timer = setTimeout(hold.again, delay);
  }

  cancelHold() {
    const hold = this.held;
    if (!hold) return;
    clearTimeout(hold.timer);
    window.removeEventListener('online', hold.again);
    connection.removeEventListener('back', hold.again);
    this.held = null;
  }

  // A stream that stopped short (see onStreamError): once it's played to
  // where what's buffered ends, the track has ended. `slack`: how close
  // counts.
  endReached(deck, slack = 0.4) {
    if (deck.endsAt == null || deck !== this.deck || deck.el.paused || deck.el.currentTime < deck.endsAt - slack) return false;
    deck.endsAt = null;
    this.endNow();
    return true;
  }

  // The track has ended where its stream stopped.
  endNow() {
    if (this.repeat === 'one' && !this.transition && !this.sleepEndOfTrack && !this.remote) {
      // From the top, from a new stream (this one stopped).
      this.report('stopped', this.current, this.duration, true);
      this.clearProgress(this.current);
      this.load(this.index, { startAt: 0, reportPrev: false });
      return;
    }
    this.onEnded();
  }

  // Apple's browsers, and some Android web views, only let an element start
  // playback on its own once it has played after a tap, so warm up the
  // second element on the first tap (muted, except in Apple's browsers: see
  // APPLE). `all`: warm up both elements, for a tap whose playback starts
  // only after some requests (joining a Play Together session).
  unlock({ all = false } = {}) {
    if (this.unlocked && !all) return;
    this.unlocked = true;
    for (const deck of all ? this.decks : [this.spare]) {
      const s = deck.el;
      if (s.getAttribute('src') || deck.hls) continue;
      if (!APPLE) s.muted = true;
      s.src = SILENT_WAV;
      s.play()
        .then(() => s.pause())
        .catch(() => {})
        .finally(() => {
          if (s.getAttribute('src') === SILENT_WAV) {
            s.removeAttribute('src');
            s.load();
          }
          s.muted = this.muted;
        });
    }
  }

  // ---------- Play Together ----------

  // remote: { play, pause, toggle, seek, command, ended, expectedTime, sleep, blocked }
  setRemote(remote) {
    if (remote === this.remote) return;
    if (remote && this.cast) this.cast.stop({ here: false }); // a session plays here
    this.cancelTransition();
    // (A track waiting for the connection: the session's to play now.)
    this.cancelHold();
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
    // What this device had (its own track, when joining): if another takes
    // its place, its playback ends here (see endHere).
    const before = this.current;
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
    const changedTrack = this.queue[at]?.qid !== before?.qid;
    this.index = this.queue.length ? at : -1;
    this.context = context || null;
    this.emit('queue');
    const cur = this.current;
    if (!cur) {
      this.endHere(before);
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
      this.setPendingSeek(sec);
      this.loadAutoplay = playing;
      this.switching = playing;
      return;
    }
    if (this.failedQid === cur.qid) {
      if (changedTrack) this.emit('track');
      return;
    }
    if (this.deck.qid !== cur.qid || !this.deck.hasSource()) {
      // (The queue has moved on already, so load() can't tell what's left.)
      if (before?.qid !== cur.qid) this.endHere(before);
      this.load(this.index, { autoplay: playing, startAt: sec, reportPrev: false });
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
      if (this.isPlaying) {
        this.noteWhy('Play Together: the session paused');
        this._pause();
      }
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
      this.cancelTransition(); // stop at the end of this one, not the next
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
    this.noteWhy('the sleep timer');
    if (this.remote) this.remote.sleep();
    else if (this.cast) this.cast.pause();
    else this._pause();
    this.emit('sleep');
  }

  // ---------- volume and speed ----------

  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.volume > 0) this.muted = false;
    if (this.cast) this.cast.setVolume(this.volume);
    else store.set('volume', this.volume);
    this.applyVolume();
    this.emit('volume');
  }

  toggleMute() {
    this.muted = !this.muted;
    if (this.cast) this.cast.setVolume(this.muted ? 0 : this.volume);
    this.applyVolume();
    this.emit('volume');
  }

  applyVolume() {
    for (const d of this.decks) {
      d.el.volume = Math.max(0, Math.min(1, this.volume * d.gain * d.level));
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
    if (this.cast) return this.cast.playTracks(tracks, start, { context, shuffle });
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
    // What was playing ends here, as its own playback, while it's still the
    // queue's (once the new queue is in, the track where it was is another).
    this.endHere(this.current);
    this.shuffle = shuffle;
    this.queue = list;
    this.context = context;
    this.emit('queue');
    this.emit('mode');
    this.emit('started');
    this.load(Math.min(start, list.length - 1), { reportPrev: false });
  }

  playNext(tracks) {
    if (this.remote) return this.remote.command({ type: 'add', where: 'next', tracks: tracks.slice(0, 500) });
    if (this.cast) return this.cast.add(tracks, { next: true });
    if (!this.current) return this.playTracks(tracks, 0);
    const items = tracks.map(withQid);
    this.queue.splice(this.index + 1, 0, ...items);
    if (this.original) {
      const pos = this.original.indexOf(this.current);
      this.original.splice(pos + 1, 0, ...items);
    }
    this.queueChanged();
    this.emit('queue');
    this.persist();
  }

  addToQueue(tracks) {
    if (this.remote) return this.remote.command({ type: 'add', tracks: tracks.slice(0, 500) });
    if (this.cast) return this.cast.add(tracks, { next: false });
    if (!this.current) return this.playTracks(tracks, 0);
    const items = tracks.map(withQid);
    this.queue.push(...items);
    this.original?.push(...items);
    this.queueChanged();
    this.emit('queue');
    this.persist();
  }

  replaceUpcoming(tracks, context) {
    // A shared queue isn't wiped for one person: the tracks go next instead.
    if (this.remote) return this.playNext(tracks);
    if (this.cast) return this.cast.replaceUpcoming(tracks, context);
    const items = tracks.map(withQid);
    this.queue = this.queue.slice(0, this.index + 1).concat(items);
    this.original = this.queue.slice();
    this.shuffle = false;
    if (context) this.context = context;
    this.queueChanged();
    this.emit('queue');
    this.emit('mode');
    this.persist();
  }

  // An upcoming track becomes the next one to play.
  moveToTop(i) {
    const t = this.queue[i];
    if (!t || i <= this.index + 1) return;
    if (this.remote) return this.remote.command({ type: 'move', sid: t.sid, to: this.index + 1 });
    if (this.cast) return this.cast.moveToTop(i);
    this.queue.splice(i, 1);
    this.queue.splice(this.index + 1, 0, t);
    // In the unshuffled order too, so turning shuffle off keeps it next.
    if (this.original && this.original.includes(t) && this.original.includes(this.current)) {
      this.original.splice(this.original.indexOf(t), 1);
      this.original.splice(this.original.indexOf(this.current) + 1, 0, t);
    }
    this.queueChanged();
    this.emit('queue');
    this.persist();
  }

  // An upcoming track goes back after another one still to come (undoing a
  // Guest DJ's move, dj.js). Here only: not on another player.
  putAfter(t, after) {
    if (this.remote || this.cast) return false;
    const i = this.queue.indexOf(t);
    const j = this.queue.indexOf(after);
    if (i <= this.index || j <= this.index || i === j + 1) return false;
    this.queue.splice(i, 1);
    this.queue.splice(this.queue.indexOf(after) + 1, 0, t);
    if (this.original?.includes(t) && this.original.includes(after)) {
      this.original.splice(this.original.indexOf(t), 1);
      this.original.splice(this.original.indexOf(after) + 1, 0, t);
    }
    this.queueChanged();
    this.emit('queue');
    this.persist();
    return true;
  }

  jump(i) {
    if (this.cast) return this.cast.jump(i);
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
    if (this.cast) return this.cast.remove(i);
    const [t] = this.queue.splice(i, 1);
    if (i < this.index) this.index -= 1;
    if (this.original) this.original = this.original.filter((x) => x !== t);
    this.queueChanged();
    if (this.spare.qid === t.qid) this.spare.reset();
    this.emit('queue');
    this.persist();
  }

  clearUpcoming() {
    if (this.remote) return this.remote.command({ type: 'clear' });
    if (this.cast) return this.cast.replaceUpcoming([]);
    this.queue = this.queue.slice(0, this.index + 1);
    this.original = this.queue.slice();
    this.cancelTransition();
    this.spare.reset();
    this.emit('queue');
    this.persist();
  }

  // In a session, shuffling mixes up what's next for everyone, once.
  setShuffle(on) {
    if (this.remote) return this.remote.command({ type: 'shuffle' });
    if (this.cast) return this.cast.setShuffle(on);
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
    this.cancelTransition();
    this.spare.reset();
    this.emit('queue');
    this.emit('mode');
    this.persist();
  }

  cycleRepeat() {
    if (this.remote) return false;
    return this.setRepeat({ off: 'all', all: 'one', one: 'off' }[this.repeat] || 'off');
  }

  setRepeat(mode) {
    if (this.remote || !['off', 'all', 'one'].includes(mode)) return false;
    this.repeat = mode;
    this.cast?.setRepeat(this.repeat);
    if (this.repeat === 'one') this.cancelTransition();
    this.emit('mode');
    this.persist();
    return true;
  }

  // Another device's queue becomes this one's (your devices, devices.js):
  // ready at `position` (seconds) in track `index`, or playing from there.
  adoptQueue({ queue, index = 0, position = 0, context = null, shuffle = false, repeat = 'off', play = false }) {
    if (!queue?.length || this.remote) return;
    this.reset();
    this.queue = queue.map(({ qid, pqid, sid, ...t }) => withQid(t));
    this.original = shuffle ? null : this.queue.slice();
    this.index = Math.max(0, Math.min(index, this.queue.length - 1));
    this.context = context;
    this.shuffle = !!shuffle;
    this.repeat = ['off', 'all', 'one'].includes(repeat) ? repeat : 'off';
    this.restoredAt = Math.max(0, position || 0);
    this.state = 'paused';
    this.emit('queue');
    this.emit('mode');
    this.emit('track');
    this.emit('state');
    this.queueTime();
    this.updateMediaSession();
    this.persist(true);
    if (play) this.load(this.index, { startAt: this.restoredAt, autoplay: true, reportPrev: false });
  }

  // ---------- casting ----------

  // Start or stop casting to a Plex player (cast.js): this device stops
  // playing, and keeps the queue on show.
  setCast(c) {
    if (c === this.cast) return;
    this.cancelTransition();
    if (c) {
      // (A track waiting for the connection: the Plex player's now, from
      // where it was waiting, as time has it.)
      this.restoredAt = this.time;
      this.cancelHold();
      this.setPendingSeek(null);
      this.cancelRescue();
      this.resumeAs = null;
      this.loadToken += 1;
      this.loadingQid = null;
      this.switching = false;
      for (const d of this.decks) {
        d.el.pause();
        d.reset();
      }
      this.original = null;
    }
    this.cast = c;
    this.emit('mode');
    this.emit('cast');
  }

  // While casting: what the other player is doing. The queue is the play
  // queue on the server; entries keep their qid while they're in it.
  castUpdate({ queue, index, state, volume, context } = {}) {
    if (!this.cast) return;
    const before = this.current?.qid;
    if (queue) {
      this.queue = queue;
      this.original = null;
    }
    if (index !== undefined) this.index = this.queue.length ? Math.max(0, Math.min(index, this.queue.length - 1)) : -1;
    if (context !== undefined) this.context = context;
    if (queue) this.emit('queue');
    if (this.current?.qid !== before) {
      this.emit('track');
      this.updateMediaSession();
    }
    if (volume != null && Math.abs(volume - this.volume) > 0.004) {
      this.volume = volume;
      this.emit('volume');
    }
    if (state && state !== this.state) this.setState(state);
    this.queueTime();
    this.updatePositionState();
  }

  // Just before the browser's AirPlay or Cast picker opens: the playing
  // track's address changes to the server's temporary token (and carries on
  // from the same spot), so the device it's handed to never gets the
  // account's own token. Converted streams can't be sent to a device anyway.
  // False when there's no temporary token for this server yet.
  prepareRemote() {
    if (this.cast || this.remote || !app.server || this.mediaToken?.key !== tokenKey(app.server)) return false;
    this.useMediaToken = true;
    const t = this.current;
    const deck = this.deck;
    if (!t || !deck.hasSource() || deck.hls) return true;
    const at = deck.el.currentTime || 0;
    const playing = !deck.el.paused;
    const src = this.sourceFor(t, this.transcoding, deck.playback);
    this.cancelTransition();
    this.spare.reset();
    this.switching = playing;
    deck.el.src = src.url;
    deck.el.load();
    this.setPendingSeek(at);
    if (playing) deck.el.play()?.catch((err) => this.onPlayError(err));
    return true;
  }

  // ---------- reporting ----------

  // `track` is being left for another: Plex hears its playback here has
  // stopped, where it got to, if there was one (its stream loaded here, or
  // held while paused: see qualityChanged).
  endHere(track) {
    if (!track || this.state === 'idle') return;
    const here = this.deck.qid === track.qid ? this.deck.hasSource() : this.resumeAs?.qid === track.qid;
    if (here) this.report('stopped', track, this.time, true);
  }

  report(state, track = this.current, time = this.time, force = false) {
    // A player we cast to tells Plex what it plays itself.
    if (!track || !app.server || !app.settings.reportPlays || this.cast) return;
    const now = Date.now();
    if (!force && now - this.lastReport < 10000) return;
    this.lastReport = now;
    // As the track's playback, which its stream was started with (the
    // playing one's, if both have it: a queue of one track, repeated).
    const deck = this.deck.qid === track.qid ? this.deck : this.decks.find((d) => d.qid != null && d.qid === track.qid);
    const playback = deck?.playback || (this.resumeAs?.qid === track.qid ? this.resumeAs.playback : null);
    // (Whether it may get there: not while the browser's offline.)
    const sentAt = navigator.onLine === false ? null : Date.now();
    const sent = app.server.timeline(track, state, time * 1000, playback);
    // A track's last report (played to its end from what was loaded ahead,
    // say) that couldn't get there (no answer of the server's under 500):
    // kept, and sent from there (outbox.js), so the play counts as it would
    // have (but not twice: not if Plex has it as played already, as it may
    // from this one, its answer lost), once the connection's back, or in a
    // while, if the server answers again already.
    if (state !== 'stopped') return;
    const s = app.server;
    sent.then(async (status) => {
      if ((status > 0 && status < 500) || app.server !== s) return;
      keepPlayed(track, time * 1000, playback, sentAt);
      const answers = await serverAnswers();
      if (app.server !== s) return;
      if (answers) flush();
      else connectionLost();
    });
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
    const keys = 'media keys, a headset or the system’s media controls';
    set('play', () => this.play(keys));
    set('pause', () => this.pause(keys));
    set('stop', () => this.pause(`${keys} (stop)`));
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

  // The queue is saved when it changes, and where you are in the track every
  // few seconds as a small separate value: the queue can be 1,500 tracks,
  // too much to write over and over while playing.
  persist(now = false) {
    clearTimeout(this.persistTimer);
    this.persistPending = false;
    if (this.remote) return; // the session keeps its own queue
    const save = () => {
      this.persistPending = false;
      const key = this.storeKey();
      if (!key) return;
      store.set(`${key}.at`, null);
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
    else {
      this.persistPending = true;
      this.persistTimer = setTimeout(save, 800);
    }
  }

  savePosition() {
    const key = this.storeKey();
    const t = this.current;
    if (this.remote || !key || !t || !this.deck.hasSource()) return;
    store.set(`${key}.at`, { id: t.id, position: Math.round(this.time * 10) / 10 });
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
    const at = store.get(`${key}.at`);
    this.restoredAt = (at && at.id === this.current?.id ? at.position : saved.position) || 0;
    this.state = 'paused';
    this.emit('queue');
    this.emit('mode');
    this.emit('track');
    this.emit('state');
    this.queueTime();
    this.updateMediaSession();
  }

  reset() {
    this.cancelTransition();
    this.cancelRescue();
    this.cancelHold();
    this.qualityLater = false;
    this.resumeAs = null;
    this.loadToken += 1;
    this.loadingQid = null;
    this.setPendingSeek(null);
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
