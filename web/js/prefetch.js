// Loading ahead (Settings › Playback › Load ahead, each device's own): the
// next few tracks in the queue loaded in full, into this browser's memory,
// so a dropped connection (or a slow one, at work) doesn't stop the music
// at the next track. Files are kept as they are; tracks the server
// converts, as their stream's parts (played back through hls.js from
// memory: see cachedLoader).
//
// The track playing comes first: loading ahead only uses the connection
// while it has what it needs (player.roomToFetch), checked all the while,
// and waits (reading nothing more) whenever it needs more. Until it has
// all it'll need (loaded to its end, or played from memory), loading ahead
// is held back too: small parts, each followed by a rest, so it takes half
// of what the connection gives at most, and leaves the track playing at
// least twice its bitrate (see restAfter). After that it goes as fast as
// the connection allows. One track loads at a time, in queue order, asking
// the browser to put it after anything else. The next track coming in as
// it plays (the browser streams it, as it does without this) isn't loaded
// ahead as well.
//
// The last tracks played are kept too (Settings › Playback › Keep played
// tracks, also each device's own), so going back to one plays it at once
// from memory: what was loaded ahead for it, or else what came in as it
// played (a converted stream is kept as hls.js reads it: see
// recordingLoader), or else, for a file, what's read again into memory
// once the tracks ahead are in. Reading one again gives way to a track
// ahead that's due: it's set aside, part-read, and finished after. (A
// file still loading ahead when its track starts goes on the same way.)
//
// What's loaded is only kept while it's wanted: it goes once its track is
// further back than that, when the queue moves on without it, on another
// server, or on signing out, and there's never more than LOAD_AHEAD_BYTES
// of it, the tracks ahead first (the furthest back go to make room for
// them). The app doesn't save it anywhere, and it isn't put in the
// browser's cache.
import { app, on } from './state.js';
import { playbackId, canPlayHlsNatively } from './plex.js';

export const LOAD_AHEAD_MAX = 10; // tracks
export const KEEP_PLAYED_MAX = 5; // tracks
// What this browser keeps at most: as much as the device's memory allows,
// where the browser says how much it has (Chrome and Edge do, but only
// over HTTPS: 64 MB a gigabyte, 128 to 512 MB), or else 384 MB, and 256 MB
// on a phone or tablet (which may have little).
export const LOAD_AHEAD_BYTES = (() => {
  const gb = Number(globalThis.navigator?.deviceMemory) || 0;
  if (gb) return Math.min(512, Math.max(128, gb * 64)) * 1024 * 1024;
  const touch = !!globalThis.matchMedia?.('(pointer: coarse)').matches;
  return (touch ? 256 : 384) * 1024 * 1024;
})();
const LONG_FORM_MS = 20 * 60000; // long mixes play as they come in (and what's after them waits)
const RETRY_AFTER = 60000; // a track that didn't load is tried again after this long
const CHECK_EVERY = 3000;
const WAIT_EVERY = 500; // waiting for the connection, it's looked at this often
const GETTING_GOING = 3; // seconds a download has before how fast it goes counts
const FILE_PART = 1024 * 1024; // a file loads this much at a time...
const FILE_PART_HELD = 128 * 1024; // ...or this, held back (see above)
const RESUMES = 3; // a part of a file is asked for again this many times
// Held back: what's taken of what the connection gives a part, at most, and
// how many times its bitrate is left for the track playing, at least. (A
// connection slower than that waits this long before trying again.)
const SHARE = 0.5;
const HEADROOM = 2;
const SLOW_REST = 30000;

// How long to rest after a part of `bytes` that took `ms`, held back, with
// the track playing at `kbps`.
export function restAfter(bytes, ms, kbps) {
  const speed = (bytes / Math.max(ms, 1)) * 1000; // bytes a second
  const allowed = Math.min(speed * SHARE, speed - ((kbps * 1000) / 8) * HEADROOM);
  if (!(allowed > 0)) return SLOW_REST;
  return Math.min(SLOW_REST, Math.max(0, (bytes / allowed) * 1000 - ms));
}

// The lines of a playlist that name what it lists.
const listed = (text) =>
  String(text)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));

const stopped = () => new DOMException('Loading ahead stopped.', 'AbortError');
// Read to keep, set aside for a track ahead: the rest is read after (see
// Prefetcher.load).
const parked = () => Object.assign(new Error('Set aside for a track ahead.'), { parked: true });
// Due to load: nothing loaded or loading for it, or what didn't load, due
// to be tried again.
const due = (e) => !e || (e.state === 'failed' && Date.now() >= e.retryAt);
// More than can be kept: it plays as it comes in, and isn't tried again
// while it's wanted.
const tooBig = () => Object.assign(new Error('More than can be kept.'), { tooBig: true });

export class Prefetcher {
  constructor(player) {
    this.player = player;
    // qid -> { qid, track, src, playback, state, bytes, blob, url, data, chunks, ctrl, retryAt }: state is
    // loading, done, failed, skipped (too big), recording (see record) or paused (see load).
    this.entries = new Map();
    this.busy = null; // the one loading
    this.timer = null;
    this.played = []; // the tracks played (their qids), the most recent first (see keptTracks)
    on('settings', () => this.plan());
    on('source', (change) => this.sourceChanged(change));
    on('signout', () => this.clear());
    // The queue, the track or the order changed: looked at once the player
    // has finished with it. (A new queue comes a moment before the track to
    // play from it: what's after the track playing until then is any of it.)
    let soon = false;
    const later = () => {
      if (soon) return;
      soon = true;
      queueMicrotask(() => {
        soon = false;
        this.plan();
      });
    };
    for (const type of ['queue', 'track', 'mode']) player.addEventListener(type, later);
    // (And once a track's on, playing or paused: what played from memory
    // before it goes, and what's next can start.)
    player.addEventListener('state', () => player.state !== 'loading' && this.plan());
  }

  get count() {
    return Math.max(0, Math.min(LOAD_AHEAD_MAX, Math.round(Number(app.settings.loadAhead) || 0)));
  }

  get keepCount() {
    return Math.max(0, Math.min(KEEP_PLAYED_MAX, Math.round(Number(app.settings.keepPlayed) || 0)));
  }

  // Whether anything's kept here (playing on this device, signed in).
  get here() {
    const p = this.player;
    return !p.cast && !p.routed && !!app.server && !!app.auth?.token && p.index >= 0;
  }

  // The tracks to have ready, the next first.
  wanted() {
    const p = this.player;
    const n = this.count;
    if (!n || !this.here || p.repeat === 'one') return [];
    const out = [];
    for (let i = p.index + 1; i < p.queue.length && out.length < n; i++) {
      const t = p.queue[i];
      if (!t?.partKey || (t.duration || 0) >= LONG_FORM_MS) break;
      out.push(t);
    }
    return out;
  }

  // The tracks to keep, once played: the one playing, then the last ones
  // played before it, the most recent first (in the queue still: going
  // back to one, the one gone back from is the last played).
  keptTracks() {
    const p = this.player;
    const n = this.keepCount;
    if (!n || !this.here) return [];
    const cur = p.current;
    if (cur && this.played[0] !== cur.qid) this.played = [cur.qid, ...this.played.filter((q) => q !== cur.qid)].slice(0, KEEP_PLAYED_MAX + 1);
    const inQueue = new Map(p.queue.map((t) => [t.qid, t]));
    const keepable = (t) => t?.partKey && (t.duration || 0) < LONG_FORM_MS;
    const out = cur && keepable(cur) ? [cur] : [];
    for (const qid of this.played) {
      if (out.length >= n + (cur && keepable(cur) ? 1 : 0)) break;
      const t = inQueue.get(qid);
      if (t && t.qid !== cur?.qid && keepable(t)) out.push(t);
    }
    return out;
  }

  // What a player has (plays from memory, or is keeping as it comes in),
  // and the track the player is loading: from what's kept, maybe, once
  // loaded.
  inUse() {
    const p = this.player;
    const out = new Set();
    for (const d of p.decks) {
      if (d.prefetched?.qid != null) out.add(d.prefetched.qid);
      if (d.recording?.qid != null) out.add(d.recording.qid);
    }
    if (p.loadingQid != null) out.add(p.loadingQid);
    return out;
  }

  // The track playing, to read into memory once the tracks ahead are in, so
  // it's kept once played: a file coming in as it plays (a converted stream
  // is kept as it comes: see record), as Streaming quality has it.
  // (Only with Load ahead on: off, tracks aren't read in full, nor again.)
  keepable() {
    const p = this.player;
    const t = p.current;
    const d = p.deck;
    if (!this.keepCount || !this.count || !this.here || !t || !d.hasSource() || d.qid !== t.qid || d.isHls || d.forced || d.prefetched || d.recording) return null;
    if (!this.keptTracks().some((k) => k.qid === t.qid)) return null;
    return this.player.sourceFor(t, false).hls ? null : t;
  }

  // The next track ahead to load, in queue order (not the next track coming
  // in as it plays: see streamed). One part-read to keep, then set aside,
  // that's ahead now (gone back from), is due too: the rest of it.
  aheadNext() {
    const streamed = this.streamed();
    return this.wanted().find((t) => t.qid !== streamed && (due(this.entries.get(t.qid)) || this.entries.get(t.qid).state === 'paused')) || null;
  }

  // Whether a track ahead is to load now, as pump has it: reading a track
  // to keep gives way to it.
  aheadDue() {
    const t = this.aheadNext();
    return !!t && !!this.loadable(t);
  }

  // What's next to read to keep, once the tracks ahead are in: the rest of
  // one set aside for a track ahead (the last played first), or else the
  // track playing (see keepable).
  keepNext() {
    if (!this.keepCount || !this.count || !this.here) return null;
    const cur = this.player.current;
    for (const t of this.keptTracks()) {
      if (this.entries.get(t.qid)?.state === 'paused' && (t.qid !== cur?.qid || this.keepable() === t)) return t;
    }
    const t = this.keepable();
    return t && due(this.entries.get(t.qid)) ? t : null;
  }

  // The next track, if it's coming in as it plays (the other player
  // streams it): it isn't loaded ahead as well.
  streamed() {
    const spare = this.player.spare;
    return spare && !spare.prefetched ? (spare.qid ?? spare.loadingQid ?? null) : null;
  }

  used() {
    let n = 0;
    for (const e of this.entries.values()) n += e.bytes;
    return n;
  }

  // Whether a track being loaded ahead will be there within `left` seconds
  // (going as it has so far), or one is about to be (it's next to load, can
  // be, and the connection's free now, or only reading a track to keep,
  // which gives way to it): it's better waited for than streamed as well.
  // Not one that can't be loaded ahead here, is waiting for the
  // connection, or won't be there in time: that's streamed as usual.
  waitingFor(track, left = Infinity) {
    if (!track || !this.wanted().some((t) => t.qid === track.qid)) return false;
    const e = this.entries.get(track.qid);
    if (e) return e.state === 'loading' && this.onTime(e, left);
    return (!this.busy || this.busy.keep) && track.qid !== this.streamed() && !!this.loadable(track) && this.player.roomToFetch();
  }

  // (How fast it's gone while it's been loading: not counting the time
  // it's waited for the connection, which the track playing has to itself
  // by the end, nor its rests once it's no longer held back. While it is,
  // they go on, so they count. Just started, it's on time if it can go on
  // now.)
  onTime(e, left) {
    if (!Number.isFinite(left)) return true;
    const now = performance.now();
    const since = (t) => (t ? now - t : 0);
    const rests = this.player.aheadUnlimited() ? e.rested + since(e.restingSince) : 0;
    const secs = (now - e.started - e.waited - since(e.waitingSince) - rests) / 1000;
    if (secs < GETTING_GOING) return this.player.roomToFetch();
    const rate = e.bytes / secs;
    return rate > 0 && Math.max(0, e.expected - e.bytes) / rate <= left;
  }

  // About how big a track is, loaded as `src` (see player.sourceFor).
  sizeOf(track, src) {
    return ((track.duration || 0) / 1000) * ((src.hls ? src.kbps : Number(track.bitrate) || 1411) * 1000) / 8;
  }

  // How a track would be loaded ahead (or `keeping`: into memory to keep,
  // once played), if it can be here, and there's room for it.
  loadable(track, { keeping = false } = {}) {
    const src = this.player.sourceFor(track, false);
    // Converted, it's played through hls.js (not by browsers that play HLS
    // themselves, as Safari does: those stream it as it plays).
    if (src.hls && canPlayHlsNatively()) return null;
    return this.fits(this.sizeOf(track, src) * 1.05, { keeping }) ? src : null;
  }

  // What could go to make room for a track ahead: played tracks kept that
  // no player has (or part-read, set aside), the furthest back first (the
  // one playing last).
  givers(except = null) {
    const inUse = this.inUse();
    const ahead = new Set(this.wanted().map((t) => t.qid));
    return this.keptTracks()
      .reverse()
      .map((t) => this.entries.get(t.qid))
      .filter((e) => e && e !== except && (e.state === 'done' || e.state === 'paused') && !inUse.has(e.qid) && !ahead.has(e.qid));
  }

  // Whether `bytes` more fit: for a track ahead, counting what played
  // tracks kept could give up; to keep one (`keeping`), only what's free.
  fits(bytes, { keeping = false, except = null } = {}) {
    const free = LOAD_AHEAD_BYTES - this.used();
    if (bytes <= free || keeping) return bytes <= free;
    return bytes <= free + this.givers(except).reduce((n, e) => n + e.bytes, 0);
  }

  // ...and makes the room (letting played tracks go, the furthest back
  // first), if it can.
  makeRoom(bytes, { keeping = false, except = null } = {}) {
    if (!this.fits(bytes, { keeping, except })) return false;
    for (const e of this.givers(except)) {
      if (this.used() + bytes <= LOAD_AHEAD_BYTES) break;
      this.drop(e);
    }
    return this.used() + bytes <= LOAD_AHEAD_BYTES;
  }

  // What's loaded for a track, if it's all there and loaded the way `src`
  // (see player.sourceFor) would load it now.
  ready(track, src) {
    const e = track && this.entries.get(track.qid);
    return e && e.state === 'done' && e.src.hls === src.hls && e.src.kbps === src.kbps ? e : null;
  }

  // The playback a player plays what's kept for a track as: the one it was
  // loaded ahead as, the first time, and a new one after (it's played
  // again: see playbackId).
  playbackFor(e) {
    if (e.used) return playbackId();
    e.used = true;
    return e.playback;
  }

  // Lets go of what's no longer wanted (unless a player has it, or is
  // loading its track: from it, maybe, once loaded), and loads what's next.
  plan() {
    const want = new Set(this.wanted().map((t) => t.qid));
    const keep = new Set(this.keptTracks().map((t) => t.qid));
    const inUse = this.inUse();
    const streamed = this.streamed();
    for (const e of [...this.entries.values()]) {
      // A track that was loading ahead, played (or gone past) before it was
      // all in: what's still to come would only be kept. A file of a track
      // played, to keep (Keep played tracks), goes on as a file read again
      // to keep would, giving way to the tracks ahead (see loadFile);
      // anything else goes, as it would hold them up (and, converted, is a
      // second stream of it: a converted track is kept as it comes in
      // instead, see record).
      let overtaken = e.state === 'loading' && !e.keep && !want.has(e.qid);
      if (overtaken && !e.src.hls && keep.has(e.qid) && this.count) {
        e.keep = true;
        e.used = true; // (playing: played again, it's another playback)
        overtaken = false;
      }
      // (With Load ahead off, nothing's read again to keep: what was being,
      // or was set aside part-read, goes.)
      const unread = e.keep && (e.state === 'loading' || e.state === 'paused') && !this.count;
      if (inUse.has(e.qid) && !overtaken && !unread) continue;
      const now = this.player.sourceFor(e.track, false);
      const stale = e.src.hls !== now.hls || e.src.kbps !== now.kbps;
      // (A stream kept as it came in, that its player let go of before it
      // was all in, isn't anything to play.)
      const unfinished = e.state === 'recording';
      if (overtaken || unread || !(want.has(e.qid) || keep.has(e.qid)) || stale || unfinished || (e.qid === streamed && !keep.has(e.qid))) this.drop(e);
    }
    this.pump();
  }

  // Another server: what's loaded goes. The same one at another address
  // (the connection changed: on the move, or at work) keeps what's loaded,
  // which may be needed most now; what was still loading, or didn't load,
  // is tried again the new way.
  sourceChanged({ serverChanged } = {}) {
    if (serverChanged) return this.clear();
    for (const e of [...this.entries.values()]) {
      if (e.state === 'loading' || e.state === 'paused') this.drop(e);
      else if (e.state === 'failed') e.retryAt = 0;
    }
    this.plan();
  }

  pump() {
    clearTimeout(this.timer);
    this.timer = null;
    if (this.entries.size || this.count || this.keepCount) this.timer = setTimeout(() => this.plan(), CHECK_EVERY);
    if (this.busy) return;
    // The tracks ahead first; then what's to keep, once played.
    let next = this.aheadNext();
    let keeping = false;
    if (!next) {
      next = this.keepNext();
      keeping = true;
    }
    if (!next || !this.player.roomToFetch()) return;
    // (Set aside part-read: the rest of it.)
    const had = this.entries.get(next.qid);
    const paused = had?.state === 'paused' ? had : null;
    const src = paused ? paused.src : this.loadable(next, { keeping });
    if (!src || !this.makeRoom(this.sizeOf(next, src) * 1.05 - (paused?.bytes || 0), { keeping })) return;
    this.load(next, { keeping });
  }

  // An entry for a track, as `src` (see player.sourceFor), as `playback`.
  entry(track, src, playback, state) {
    const e = { qid: track.qid, track, src, playback, state, bytes: 0, blob: null, url: null, data: null, chunks: null, type: '', ctrl: new AbortController(), retryAt: 0 };
    e.started = performance.now();
    e.waited = 0; // ms waiting for the connection (see room)
    e.waitingSince = 0;
    e.rested = 0; // ms resting, held back (see pace)
    e.restingSince = 0;
    e.pausedAt = 0; // set aside part-read (see load)
    e.expected = this.sizeOf(track, src);
    e.used = false; // played from: played again, it's another playback (see playbackFor)
    e.keep = false; // there to keep, once played (it gives way to the tracks ahead)
    // A file's address for an audio element: in memory.
    e.objectUrl = () => (e.url ||= URL.createObjectURL(e.blob));
    return e;
  }

  async load(track, { keeping = false } = {}) {
    const old = this.entries.get(track.qid);
    let e;
    if (old?.state === 'paused') {
      // Read to keep, set aside part-read for a track ahead: the rest, from
      // where it got to (to keep still, or ahead now: gone back from).
      e = old;
      e.state = 'loading';
      e.keep = keeping;
      // (The time it was set aside isn't counted as loading: see onTime.)
      if (e.pausedAt) e.waited += performance.now() - e.pausedAt;
      e.pausedAt = 0;
    } else {
      const playback = playbackId();
      const src = this.player.sourceFor(track, false, playback);
      if (old) this.drop(old);
      e = this.entry(track, src, playback, 'loading');
      // (Read again to keep: it's been playing already.)
      e.keep = keeping;
      e.used = keeping;
      this.entries.set(track.qid, e);
    }
    this.busy = e;
    try {
      if (e.src.hls) await this.loadStream(e);
      else await this.loadFile(e);
      if (this.entries.get(e.qid) === e) e.state = 'done';
    } catch (err) {
      if (this.entries.get(e.qid) === e) {
        if (err?.parked) {
          // Given way to a track ahead: what's in stays, and the rest is
          // read once the tracks ahead are in (see keepNext).
          e.state = 'paused';
          e.pausedAt = performance.now();
        } else {
          // Streamed as it plays instead: tried again a while later, unless
          // it's more than can be kept.
          e.state = err?.tooBig ? 'skipped' : 'failed';
          e.retryAt = Date.now() + RETRY_AFTER;
          e.blob = null;
          e.data = null;
          e.chunks = null;
          e.bytes = 0;
        }
      }
    } finally {
      if (this.busy === e) this.busy = null;
      if (this.entries.size) this.pump();
    }
  }

  // Until the track playing has what it needs (while it doesn't, nothing
  // more is read, which holds back what's on its way), or (`until`)
  // something else comes first.
  async room(e, until = null) {
    const waiting = () => !e.ctrl.signal.aborted && !this.player.roomToFetch() && !until?.();
    if (waiting()) {
      e.waitingSince = performance.now();
      try {
        while (waiting()) await new Promise((r) => setTimeout(r, WAIT_EVERY));
      } finally {
        e.waited += performance.now() - e.waitingSince;
        e.waitingSince = 0;
      }
    }
    if (e.ctrl.signal.aborted) throw stopped();
  }

  // Held back (the track playing still loading): a rest after a part (as
  // long as restAfter says, or until it's no longer held back, or
  // (`stop`) something else comes first).
  async pace(e, bytes, ms, stop = null) {
    if (!bytes || this.player.aheadUnlimited()) return;
    const until = performance.now() + restAfter(bytes, ms, this.player.playingBitrate());
    e.restingSince = performance.now();
    try {
      while (!e.ctrl.signal.aborted && performance.now() < until && !this.player.aheadUnlimited() && !stop?.()) {
        await new Promise((r) => setTimeout(r, Math.min(WAIT_EVERY, Math.max(0, until - performance.now()))));
      }
    } finally {
      e.rested += performance.now() - e.restingSince;
      e.restingSince = 0;
    }
    if (e.ctrl.signal.aborted) throw stopped();
  }

  request(e, url, headers) {
    return fetch(url, { signal: e.ctrl.signal, cache: 'no-store', credentials: 'omit', priority: 'low', ...(headers ? { headers } : {}) });
  }

  async get(e, url, kind) {
    await this.room(e);
    const t = performance.now();
    const res = await this.request(e, url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const got = kind === 'text' ? { body: await res.text(), url: res.url || url } : { body: await res.arrayBuffer(), url: res.url || url };
    await this.pace(e, kind === 'text' ? got.body.length : got.body.byteLength, performance.now() - t);
    return got;
  }

  // More than can be kept, even with room made (see makeRoom).
  over(e, more = 0) {
    if (this.used() + more > LOAD_AHEAD_BYTES && !this.makeRoom(more, { keeping: e.keep, except: e })) throw tooBig();
  }

  // A file, a part at a time, each asked for once the track playing has
  // what it needs (so no more than a part shares the connection with it),
  // and asked for again if its connection drops. A server that won't send
  // parts sends it all at once: that's read as it comes, only while there's
  // room. Read to keep, it gives way to a track ahead that's due, between
  // parts: set aside, part-read, it goes on from there (see load).
  async loadFile(e) {
    const chunks = (e.chunks ||= []);
    const givesWay = () => e.keep && this.aheadDue();
    for (let tries = 0; ; ) {
      const at = e.bytes;
      await this.room(e, givesWay);
      if (givesWay()) throw parked();
      const part = this.player.aheadUnlimited() ? FILE_PART : FILE_PART_HELD;
      const t = performance.now();
      let res;
      let body = null;
      try {
        res = await this.request(e, e.src.url, { Range: `bytes=${at}-${at + part - 1}` });
        if (res.status === 206) body = new Uint8Array(await res.arrayBuffer());
      } catch (err) {
        if (e.ctrl.signal.aborted || ++tries > RESUMES) throw err;
        await new Promise((r) => setTimeout(r, tries * 1000));
        continue;
      }
      // Asked for from just past its end (it's a whole number of parts).
      if (res.status === 416 && at > 0) break;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      e.type ||= res.headers.get('Content-Type') || '';
      if (body) {
        // Where the part is, and the file's size, where the browser can see
        // them (more than can be kept is known now).
        const [, from, to, size] = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(res.headers.get('Content-Range') || '') || [];
        if (from !== undefined && Number(from) !== at) throw new Error('Not the part asked for.');
        if (size) this.over(e, Number(size) - at);
        if (size) e.expected = Number(size);
        chunks.push(body);
        e.bytes += body.byteLength;
        tries = 0;
        this.over(e);
        if (size ? Number(to) + 1 >= Number(size) : body.byteLength < part) break;
        if (!body.byteLength) throw new Error('Nothing came back.');
        await this.pace(e, body.byteLength, performance.now() - t, givesWay);
        continue;
      }
      if (at > 0 || !res.body) throw new Error('The file came back whole, part-way.');
      const length = Number(res.headers.get('Content-Length')) || 0;
      if (length) this.over(e, length);
      if (length) e.expected = length;
      const reader = res.body.getReader();
      try {
        for (;;) {
          await this.room(e, givesWay);
          // (Read to keep, it gives way here too, but can't go on part-way,
          // sent whole: what's in goes, and it's read from the top after.)
          if (givesWay()) {
            chunks.length = 0;
            e.bytes = 0;
            throw parked();
          }
          const t0 = performance.now();
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          e.bytes += value.byteLength;
          this.over(e);
          await this.pace(e, value.byteLength, performance.now() - t0, givesWay);
        }
      } catch (err) {
        reader.cancel().catch(() => {});
        throw err;
      }
      break;
    }
    e.blob = new Blob(chunks, { type: e.type });
    e.chunks = null;
  }

  // A converted stream: its playlists (as the server gives them), then each
  // part, under the addresses hls.js will ask for.
  async loadStream(e) {
    const data = new Map(); // address -> { body, url }
    e.data = data;
    const text = async (url) => {
      const got = await this.get(e, url, 'text');
      data.set(url, got);
      e.bytes += got.body.length;
      return got;
    };
    const master = await text(e.src.url);
    let media = master;
    if (/#EXT-X-STREAM-INF/i.test(master.body)) {
      const variant = listed(master.body)[0];
      if (!variant) throw new Error('No stream in the playlist.');
      media = await text(new URL(variant, master.url).href);
    }
    // (A playlist still growing would be asked for again as it plays.)
    if (!/#EXT-X-ENDLIST/i.test(media.body)) throw new Error('The stream isn’t all listed yet.');
    for (const part of listed(media.body)) {
      const url = new URL(part, media.url).href;
      let got;
      try {
        got = await this.get(e, url, 'binary');
      } catch (err) {
        if (e.ctrl.signal.aborted) throw err;
        got = await this.get(e, url, 'binary'); // once more
      }
      data.set(url, got);
      e.bytes += got.body.byteLength;
      this.over(e);
    }
  }

  // A converted stream coming in as it plays (through hls.js, from the top,
  // not from memory), kept as hls.js reads it (see recordingLoader), so its
  // track is played again from memory once played: an entry for it, or
  // null when it isn't kept (Keep played tracks off, or the other player
  // has what's kept for it). What else there was for it goes: it's coming
  // in anyway, and it's only played from memory when it matches (see
  // ready), which then isn't recorded. `into`: the player it's loading
  // into (what that has goes as it loads).
  record(track, src, playback, into = null) {
    if (!this.keepCount || !this.here || !src.hls || canPlayHlsNatively() || !track?.partKey || (track.duration || 0) >= LONG_FORM_MS) return null;
    const old = this.entries.get(track.qid);
    if (old) {
      if (this.player.decks.some((d) => d !== into && (d.prefetched === old || d.recording === old))) return null;
      this.drop(old);
    }
    const e = this.entry(track, src, playback, 'recording');
    e.keep = true;
    e.used = true; // (playing now)
    e.data = new Map();
    // What hls.js read: playlists as text, parts as bytes (a copy), under
    // the addresses it asked for, with where they came from.
    e.keepPart = (asked, body, from) => this.recorded(e, asked, body, from);
    this.entries.set(track.qid, e);
    return e;
  }

  recorded(e, asked, body, from) {
    if (this.entries.get(e.qid) !== e || e.state !== 'recording' || !e.data) return;
    const size = (b) => (typeof b === 'string' ? b.length : b.byteLength);
    const had = e.data.get(asked);
    e.data.set(asked, { body, url: from || asked });
    e.bytes += size(body) - (had ? size(had.body) : 0);
    if (this.used() > LOAD_AHEAD_BYTES && !this.makeRoom(0, { keeping: true, except: e })) {
      this.drop(e);
      return;
    }
    if (whole(e)) e.state = 'done';
  }

  drop(e) {
    e.ctrl.abort();
    if (e.url) URL.revokeObjectURL(e.url);
    e.url = null;
    e.blob = null;
    e.data = null;
    e.chunks = null;
    e.bytes = 0;
    if (this.entries.get(e.qid) === e) this.entries.delete(e.qid);
    if (this.busy === e) this.busy = null;
  }

  clear() {
    for (const e of [...this.entries.values()]) this.drop(e);
    this.played = [];
    clearTimeout(this.timer);
    this.timer = null;
  }

  // For Settings and tests: what's loaded ahead, and kept, now.
  summary() {
    return [...this.entries.values()].map((e) => ({ id: e.track.id, state: e.state, bytes: e.bytes, hls: e.src.hls, used: e.used, keep: e.keep }));
  }
}

// Whether all of a stream kept as it came in is there: its playlists, and
// every part its playlist lists (once it says that's all of them).
function whole(e) {
  const master = e.data?.get(e.src.url) || e.data?.get(new URL(e.src.url, location.href).href);
  if (typeof master?.body !== 'string') return false;
  let media = master;
  if (/#EXT-X-STREAM-INF/i.test(master.body)) {
    const variant = listed(master.body)[0];
    media = variant ? e.data.get(new URL(variant, master.url).href) : null;
    if (typeof media?.body !== 'string') return false;
  }
  if (!/#EXT-X-ENDLIST/i.test(media.body)) return false;
  const parts = listed(media.body);
  return parts.length > 0 && parts.every((p) => e.data.has(new URL(p, media.url).href));
}

// hls.js's loader, keeping a copy of what it reads (a converted stream
// coming in as it plays: see Prefetcher.record) for its track to be played
// again from memory. (A copy: hls.js hands parts on to its worker.)
export function recordingLoader(Hls, e) {
  const Base = Hls.DefaultConfig.loader;
  const copy = (d) => {
    if (typeof d === 'string') return d;
    if (d instanceof ArrayBuffer) return d.slice(0);
    if (ArrayBuffer.isView(d)) return d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength);
    return null;
  };
  return class RecordingLoader extends Base {
    load(context, config, callbacks) {
      const onSuccess = callbacks.onSuccess;
      super.load(context, config, {
        ...callbacks,
        onSuccess: (response, stats, ctx, details) => {
          try {
            const body = copy(response?.data);
            if (body != null) e.keepPart?.(ctx.url, body, response.url || ctx.url);
          } catch {
            /* keeping it is as it may be: it plays on all the same */
          }
          onSuccess(response, stats, ctx, details);
        },
      });
    }
  };
}

// hls.js's loader, answering from what's been loaded ahead (a copy of it:
// hls.js hands parts on to its worker, which would take the original) and
// asking the network for anything else.
export function cachedLoader(Hls, e) {
  const Base = Hls.DefaultConfig.loader;
  return class CachedLoader extends Base {
    load(context, config, callbacks) {
      const hit = e.data?.get(context.url);
      if (!hit) return super.load(context, config, callbacks);
      this.context = context;
      this.config = config;
      this.callbacks = callbacks;
      const stats = this.stats;
      const t = performance.now();
      stats.loading.start = t;
      stats.loading.first = t;
      stats.loading.end = t;
      const binary = context.responseType === 'arraybuffer';
      const body =
        typeof hit.body === 'string' ? (binary ? new TextEncoder().encode(hit.body).buffer : hit.body) : binary ? hit.body.slice(0) : new TextDecoder().decode(hit.body);
      stats.loaded = typeof body === 'string' ? body.length : body.byteLength;
      stats.total = stats.loaded;
      stats.bwEstimate = 1e9;
      this.answer = setTimeout(() => {
        const cb = this.callbacks;
        if (!cb) return;
        cb.onProgress?.(stats, context, body, null);
        cb.onSuccess({ url: hit.url, data: body, code: 200 }, stats, context, null);
      }, 0);
      return undefined;
    }

    abort() {
      clearTimeout(this.answer);
      super.abort();
    }

    destroy() {
      clearTimeout(this.answer);
      super.destroy();
    }
  };
}
