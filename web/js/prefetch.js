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
// What's loaded is only kept while it's wanted: it goes once its track has
// played (none are kept after), when the queue moves on without it, on
// another server, or on signing out, and there's never more than
// LOAD_AHEAD_BYTES of it. The app doesn't save it anywhere, and it isn't
// put in the browser's cache.
import { app, on } from './state.js';
import { playbackId, canPlayHlsNatively } from './plex.js';

export const LOAD_AHEAD_MAX = 10; // tracks
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
// More than can be kept: it plays as it comes in, and isn't tried again
// while it's wanted.
const tooBig = () => Object.assign(new Error('More than can be kept.'), { tooBig: true });

export class Prefetcher {
  constructor(player) {
    this.player = player;
    this.entries = new Map(); // qid -> { qid, track, src, playback, state, bytes, blob, url, data, ctrl, retryAt }
    this.busy = null; // the one loading
    this.timer = null;
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

  // The tracks to have ready, the next first.
  wanted() {
    const p = this.player;
    const n = this.count;
    if (!n || p.cast || p.routed || !app.server || !app.auth?.token || p.index < 0 || p.repeat === 'one') return [];
    const out = [];
    for (let i = p.index + 1; i < p.queue.length && out.length < n; i++) {
      const t = p.queue[i];
      if (!t?.partKey || (t.duration || 0) >= LONG_FORM_MS) break;
      out.push(t);
    }
    return out;
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
  // be, and the connection's free now): it's better waited for than
  // streamed as well. Not one that can't be loaded ahead here, is waiting
  // for the connection, or won't be there in time: that's streamed as
  // usual.
  waitingFor(track, left = Infinity) {
    if (!track || !this.wanted().some((t) => t.qid === track.qid)) return false;
    const e = this.entries.get(track.qid);
    if (e) return e.state === 'loading' && this.onTime(e, left);
    return !this.busy && track.qid !== this.streamed() && !!this.loadable(track) && this.player.roomToFetch();
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

  // How a track would be loaded ahead, if it can be here, and there's room
  // for it.
  loadable(track) {
    const src = this.player.sourceFor(track, false);
    // Converted, it's played through hls.js (not by browsers that play HLS
    // themselves, as Safari does: those stream it as it plays).
    if (src.hls && canPlayHlsNatively()) return null;
    return this.used() + this.sizeOf(track, src) * 1.05 > LOAD_AHEAD_BYTES ? null : src;
  }

  // What's loaded for a track, if it's all there and loaded the way `src`
  // (see player.sourceFor) would load it now.
  ready(track, src) {
    const e = track && this.entries.get(track.qid);
    return e && e.state === 'done' && e.src.hls === src.hls && e.src.kbps === src.kbps ? e : null;
  }

  // Lets go of what's no longer wanted (unless a deck plays it, or the
  // player is loading its track: from it, maybe, once loaded), and loads
  // what's next.
  plan() {
    const want = new Set(this.wanted().map((t) => t.qid));
    const inUse = new Set(this.player.decks.map((d) => d.prefetched?.qid).filter((q) => q != null));
    if (this.player.loadingQid != null) inUse.add(this.player.loadingQid);
    const streamed = this.streamed();
    for (const e of [...this.entries.values()]) {
      if (inUse.has(e.qid)) continue;
      const now = this.player.sourceFor(e.track, false);
      const stale = e.src.hls !== now.hls || e.src.kbps !== now.kbps;
      if (!want.has(e.qid) || stale || e.qid === streamed) this.drop(e);
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
      if (e.state === 'loading') this.drop(e);
      else if (e.state === 'failed') e.retryAt = 0;
    }
    this.plan();
  }

  pump() {
    clearTimeout(this.timer);
    this.timer = null;
    if (this.entries.size || this.count) this.timer = setTimeout(() => this.plan(), CHECK_EVERY);
    if (this.busy) return;
    const streamed = this.streamed();
    const next = this.wanted().find((t) => {
      const e = this.entries.get(t.qid);
      return t.qid !== streamed && (!e || (e.state === 'failed' && Date.now() >= e.retryAt));
    });
    if (!next || !this.player.roomToFetch() || !this.loadable(next)) return;
    this.load(next);
  }

  async load(track) {
    const playback = playbackId();
    const src = this.player.sourceFor(track, false, playback);
    const old = this.entries.get(track.qid);
    if (old) this.drop(old);
    const e = { qid: track.qid, track, src, playback, state: 'loading', bytes: 0, blob: null, url: null, data: null, ctrl: new AbortController(), retryAt: 0 };
    e.started = performance.now();
    e.waited = 0; // ms waiting for the connection (see room)
    e.waitingSince = 0;
    e.rested = 0; // ms resting, held back (see pace)
    e.restingSince = 0;
    e.expected = this.sizeOf(track, src);
    // A file's address for an audio element: in memory.
    e.objectUrl = () => (e.url ||= URL.createObjectURL(e.blob));
    this.entries.set(track.qid, e);
    this.busy = e;
    try {
      if (src.hls) await this.loadStream(e);
      else await this.loadFile(e);
      if (this.entries.get(e.qid) === e) e.state = 'done';
    } catch (err) {
      if (this.entries.get(e.qid) === e) {
        // Streamed as it plays instead: tried again a while later, unless
        // it's more than can be kept.
        e.state = err?.tooBig ? 'skipped' : 'failed';
        e.retryAt = Date.now() + RETRY_AFTER;
        e.blob = null;
        e.data = null;
        e.bytes = 0;
      }
    } finally {
      if (this.busy === e) this.busy = null;
      if (this.entries.size) this.pump();
    }
  }

  // Until the track playing has what it needs (while it doesn't, nothing
  // more is read, which holds back what's on its way).
  async room(e) {
    if (!e.ctrl.signal.aborted && !this.player.roomToFetch()) {
      e.waitingSince = performance.now();
      try {
        while (!e.ctrl.signal.aborted && !this.player.roomToFetch()) await new Promise((r) => setTimeout(r, WAIT_EVERY));
      } finally {
        e.waited += performance.now() - e.waitingSince;
        e.waitingSince = 0;
      }
    }
    if (e.ctrl.signal.aborted) throw stopped();
  }

  // Held back (the track playing still loading): a rest after a part (as
  // long as restAfter says, or until it's no longer held back).
  async pace(e, bytes, ms) {
    if (!bytes || this.player.aheadUnlimited()) return;
    const until = performance.now() + restAfter(bytes, ms, this.player.playingBitrate());
    e.restingSince = performance.now();
    try {
      while (!e.ctrl.signal.aborted && performance.now() < until && !this.player.aheadUnlimited()) {
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

  over() {
    if (this.used() > LOAD_AHEAD_BYTES) throw tooBig();
  }

  // A file, a part at a time, each asked for once the track playing has
  // what it needs (so no more than a part shares the connection with it),
  // and asked for again if its connection drops. A server that won't send
  // parts sends it all at once: that's read as it comes, only while there's
  // room.
  async loadFile(e) {
    const chunks = [];
    let type = '';
    for (let tries = 0; ; ) {
      const at = e.bytes;
      await this.room(e);
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
      type ||= res.headers.get('Content-Type') || '';
      if (body) {
        // Where the part is, and the file's size, where the browser can see
        // them (more than can be kept is known now).
        const [, from, to, size] = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(res.headers.get('Content-Range') || '') || [];
        if (from !== undefined && Number(from) !== at) throw new Error('Not the part asked for.');
        if (size && this.used() - at + Number(size) > LOAD_AHEAD_BYTES) throw tooBig();
        if (size) e.expected = Number(size);
        chunks.push(body);
        e.bytes += body.byteLength;
        tries = 0;
        this.over();
        if (size ? Number(to) + 1 >= Number(size) : body.byteLength < part) break;
        if (!body.byteLength) throw new Error('Nothing came back.');
        await this.pace(e, body.byteLength, performance.now() - t);
        continue;
      }
      if (at > 0 || !res.body) throw new Error('The file came back whole, part-way.');
      const length = Number(res.headers.get('Content-Length')) || 0;
      if (length && this.used() + length > LOAD_AHEAD_BYTES) throw tooBig();
      if (length) e.expected = length;
      const reader = res.body.getReader();
      try {
        for (;;) {
          await this.room(e);
          const t0 = performance.now();
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          e.bytes += value.byteLength;
          this.over();
          await this.pace(e, value.byteLength, performance.now() - t0);
        }
      } catch (err) {
        reader.cancel().catch(() => {});
        throw err;
      }
      break;
    }
    e.blob = new Blob(chunks, { type });
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
      this.over();
    }
  }

  drop(e) {
    e.ctrl.abort();
    if (e.url) URL.revokeObjectURL(e.url);
    e.url = null;
    e.blob = null;
    e.data = null;
    e.bytes = 0;
    if (this.entries.get(e.qid) === e) this.entries.delete(e.qid);
    if (this.busy === e) this.busy = null;
  }

  clear() {
    for (const e of [...this.entries.values()]) this.drop(e);
    clearTimeout(this.timer);
    this.timer = null;
  }

  // For Settings and tests: what's loaded ahead now.
  summary() {
    return [...this.entries.values()].map((e) => ({ id: e.track.id, state: e.state, bytes: e.bytes, hls: e.src.hls }));
  }
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
