// Your devices. Signed in to the same Plex account and playing from the same
// server, your devices share one listening session (Settings › Playback ›
// Share playback with your devices, on unless turned off).
//
// One device plays: the active one. It reports what it's playing, through
// the container's service (server/devices.js). The others show that, with
// their own sound off, and control it: play, pause, skip, seek, queue
// changes and new music all go to the device that's playing. "Listen here"
// (the muted speaker) moves the music to this device, from the same spot,
// and the one that was playing goes quiet and follows along instead.
//
// While another device plays, the player is in the same remote mode as when
// casting to a Plex player (player.cast is this module's `remote`).
import { app, on } from './state.js';
import { clientId, deviceLabel } from './plex.js';
import { player } from './player.js';
import { together } from './together.js';
import { toast, shuffleArray } from './ui.js';
import { debugLog } from './debug.js';

const API = 'api/devices';
const WAIT_SECONDS = 25;
const HEARTBEAT_MS = 20000;
const REPORT_DELAY = 250;
// Paused this long, a device stops being the one that plays, so another can
// carry on from where it was without taking it over.
const IDLE_RELEASE_MS = 10 * 60000;
const WINDOW = 600; // tracks of the queue shared, around the current one
const MAX_TRACKS = 1000; // sent in one command (see server/devices.js)
const clientNow = () => performance.timeOrigin + performance.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A tab's own id: two tabs in one browser are two devices.
function tabId() {
  try {
    let id = sessionStorage.getItem('pw.tab');
    if (!id) {
      id = Math.random().toString(36).slice(2, 10).padEnd(8, '0');
      sessionStorage.setItem('pw.tab', id);
    }
    return id;
  } catch {
    return 'tab00000';
  }
}

// What's sent of a track: what the other devices need to show and play it.
const slim = (t) => ({
  id: t.id,
  title: t.title,
  artist: t.artist,
  albumArtist: t.albumArtist,
  album: t.album,
  artistId: t.artistId,
  albumId: t.albumId,
  thumb: t.thumb,
  duration: t.duration,
  year: t.year,
  codec: t.codec,
  bitrate: t.bitrate,
  partKey: t.partKey,
  index: t.index,
  disc: t.disc,
  userRating: t.userRating,
  dj: t.dj,
  qid: t.qid == null ? undefined : String(t.qid),
});

class DevicesError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.status = status;
  }
}

class Devices extends EventTarget {
  constructor() {
    super();
    this.role = 'off'; // off | idle (playing nothing, or on its own) | active (playing) | remote (another device plays)
    this.serverId = null;
    this.active = null; // { id, name }: the device playing, when it's another one
    this.list = []; // all of your devices: [{ id, name, active, here }]
    this.state = null; // what the playing device last said
    this.queue = []; // its queue (around the current track)
    this.queueVersion = -1;
    this.version = 0;
    this.offset = 0; // the service's clock minus this device's (ms)
    this.samples = [];
    this.lastCmd = 0;
    this.acked = 0; // the last command the playing device carried out
    this.gen = 0;
    this.ctrl = null;
    this.reportTimer = 0;
    this.heartbeat = 0;
    this.ticker = 0;
    this.idleTimer = 0;
    this.sentFrom = -1; // where the queue sent last time started
    this.queueDirty = true;
    this.lastReport = null; // { position, at, playing } of the last report
    this.volumeTimer = 0;
    this.volumeAt = 0; // when the volume was last changed here
    this.taking = false; // "Listen here" on its way

    // The player's controls while another device plays (see player.cast).
    this.remote = {
      kind: 'device', // (a Plex player's controls, from cast.js, have none)
      time: () => this.time(),
      duration: () => (this.state?.duration || player.current?.duration || 0) / 1000,
      play: () => this.send({ type: 'play' }, { playing: true }),
      pause: () => this.send({ type: 'pause' }, { playing: false }),
      seek: (sec) => this.send({ type: 'seek', position: Math.round(sec * 1000) }, { position: sec * 1000 }),
      next: () => this.send({ type: 'next' }),
      prev: () => this.send({ type: 'prev' }),
      jump: (i) => this.byIndex('jump', i),
      remove: (i) => this.byIndex('remove', i),
      moveToTop: (i) => this.byIndex('move-to-top', i),
      playTracks: (tracks, start = 0, { context, shuffle } = {}) => {
        let list = tracks;
        let at = start;
        if (tracks.length > MAX_TRACKS) {
          if (shuffle) {
            // A random thousand, with the chosen track (if any) among them.
            const first = start > 0 ? tracks[start] : null;
            list = shuffleArray(tracks.filter((t) => t !== first)).slice(0, MAX_TRACKS - (first ? 1 : 0));
            if (first) list.push(first);
            at = first ? list.length - 1 : 0;
          } else {
            // A thousand from just before the chosen track.
            const from = Math.max(0, Math.min(start - 100, tracks.length - MAX_TRACKS));
            list = tracks.slice(from, from + MAX_TRACKS);
            at = start - from;
          }
        }
        return this.send({ type: 'play-tracks', tracks: list.map(slim), start: at, shuffle: !!shuffle, context: context || null });
      },
      add: (tracks, { next }) => this.send({ type: 'add', tracks: tracks.slice(0, MAX_TRACKS).map(slim), next: !!next }),
      replaceUpcoming: (tracks, context) => this.send({ type: 'replace-upcoming', tracks: tracks.slice(0, MAX_TRACKS).map(slim), context }),
      setShuffle: (on) => this.send({ type: 'shuffle', on }),
      setRepeat: (mode) => this.send({ type: 'repeat', mode }),
      setVolume: (v) => {
        this.volumeAt = clientNow();
        clearTimeout(this.volumeTimer);
        this.volumeTimer = setTimeout(() => this.send({ type: 'volume', volume: v }), 150);
      },
      // Play Together starting on this device: it plays here then.
      stop: () => this.stop(),
    };

    on('signout', () => this.stop({ release: false }));
    on('source', () => this.update());
    on('settings', () => this.update());
    together.addEventListener('change', () => this.update());
    for (const kind of ['state', 'track', 'queue', 'mode', 'volume']) player.addEventListener(kind, () => this.onPlayer(kind));
    player.addEventListener('time', () => this.onTime());
    document.addEventListener('visibilitychange', () => !document.hidden && this.role !== 'off' && this.poke());
    // Closing the page while it plays: the others can carry on at once.
    addEventListener('pagehide', () => this.role === 'active' && this.post('release', {}, { keepalive: true }).catch(() => {}));
  }

  get id() {
    return `${clientId()}-${tabId()}`;
  }

  get wanted() {
    return !!app.config.devices && app.settings.shareDevices !== false && !!app.auth?.token && !!app.source?.serverId && !together.active;
  }

  get isRemote() {
    return this.role === 'remote';
  }

  // Where the music is, when it's not here: "Dan's Mac", or the speaker that
  // device plays on.
  get playingOn() {
    return this.isRemote ? this.state?.output || this.active?.name || 'another device' : null;
  }

  emit(type) {
    this.dispatchEvent(new Event(type));
  }

  // ---------- requests ----------

  async request(path, { method = 'GET', body, timeout = 15000, signal, keepalive = false } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    const abort = () => ctrl.abort();
    signal?.addEventListener('abort', abort);
    const t0 = clientNow();
    let res;
    try {
      res = await fetch(`${API}${path}`, {
        method,
        cache: 'no-store',
        credentials: 'same-origin',
        keepalive,
        headers: { Accept: 'application/json', 'X-Plex-Token': app.auth?.token || '', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
    } catch {
      const e = new DevicesError(signal?.aborted ? 'aborted' : 'Can’t reach this player’s server.');
      e.aborted = !!signal?.aborted;
      throw e;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
    const t1 = clientNow();
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* empty */
    }
    if (!res.ok) throw new DevicesError(data?.error || `Something went wrong (${res.status}).`, res.status);
    if (Number.isFinite(data?.now)) this.sample(data.now, t0, t1);
    return data || {};
  }

  post(action, body = {}, opts = {}) {
    return this.request(`/${action}`, { method: 'POST', body: { server: this.serverId, device: { id: this.id, name: deviceLabel() }, ...body }, ...opts });
  }

  // The service stamps answers with its time; the quickest answers pin the
  // difference down best.
  sample(serverNow, t0, t1) {
    this.samples.push({ rtt: t1 - t0, offset: serverNow - (t0 + t1) / 2 });
    if (this.samples.length > 10) this.samples.shift();
    this.offset = this.samples.reduce((a, b) => (b.rtt < a.rtt ? b : a)).offset;
  }

  serverNow() {
    return clientNow() + this.offset;
  }

  // ---------- on and off ----------

  // Joins in or leaves as things change: signed in, the library's server,
  // the setting, Play Together.
  update() {
    if (!this.wanted) {
      if (this.role !== 'off') this.stop();
      return;
    }
    if (this.role !== 'off' && this.serverId !== app.source.serverId) this.stop();
    if (this.role === 'off') this.start();
  }

  start() {
    this.serverId = app.source.serverId;
    this.role = 'idle';
    this.version = 0;
    this.queueVersion = -1;
    this.queue = [];
    this.state = null;
    this.active = null;
    this.lastCmd = 0;
    this.queueDirty = true;
    this.gen += 1;
    this.ctrl = new AbortController();
    this.loop(this.gen);
  }

  // Stops taking part: if this device was playing, the others can carry on
  // from where it was; if another device was playing, its queue stays here,
  // paused, and this one plays on its own from now on.
  stop({ release = true } = {}) {
    const was = this.role;
    this.gen += 1;
    this.ctrl?.abort();
    this.role = 'off';
    clearTimeout(this.reportTimer);
    clearInterval(this.heartbeat);
    clearTimeout(this.idleTimer);
    clearInterval(this.ticker);
    if (was === 'active' && release) this.post('release').catch(() => {});
    if (was === 'remote') this.leaveRemote({ adopt: release });
    this.active = null;
    this.emit('change');
  }

  // Ask again now (the page came back from the background).
  poke() {
    if (this.role === 'off') return;
    this.gen += 1;
    this.ctrl?.abort();
    this.ctrl = new AbortController();
    this.loop(this.gen);
  }

  // ---------- following ----------

  async loop(gen) {
    let backoff = 1000;
    let wait = 0; // the first answer straight away
    while (gen === this.gen) {
      const asked = clientNow();
      const before = this.version;
      try {
        const q = new URLSearchParams({
          server: this.serverId,
          device: this.id,
          name: deviceLabel(),
          since: String(this.version),
          queue: String(this.queueVersion),
          after: String(this.lastCmd),
          wait: String(wait),
        });
        const view = await this.request(`?${q}`, { timeout: (WAIT_SECONDS + 15) * 1000, signal: this.ctrl.signal });
        if (gen !== this.gen) return;
        backoff = 1000;
        this.apply(view, { first: wait === 0 });
        // An answer at once with nothing new (this device has other
        // requests waiting already): a moment before asking again.
        if (wait && view.version === before && clientNow() - asked < 500) await sleep(3000);
        wait = WAIT_SECONDS;
      } catch (err) {
        if (gen !== this.gen || err.aborted) return;
        if ([401, 403, 404].includes(err.status)) {
          // Not available here (signed in with a server token, say).
          debugLog('devices', `not sharing playback between devices: ${err.message}`);
          this.stop({ release: false });
          return;
        }
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 15000);
      }
    }
  }

  apply(v, { first = false } = {}) {
    if (!v || v.version < this.version) return;
    this.version = v.version;
    if (Array.isArray(v.queue)) {
      this.queue = v.queue;
      this.queueVersion = v.queueVersion;
      this.queueChanged = true;
    }
    this.state = v.state || null;
    this.list = Array.isArray(v.devices) ? v.devices : [];
    this.acked = Number(v.acked) || 0;
    const activeId = v.active?.id || null;
    if (activeId === this.id) {
      this.active = null;
      if (this.taking) return; // takeOver() carries on from here
      if (this.role === 'remote') this.leaveRemote({ adopt: false });
      if (this.role !== 'active') this.becomeActive();
      this.runCommands(v.commands || []);
    } else if (activeId) {
      this.active = v.active;
      if (this.role === 'active') this.lostTo(v.active);
      else if (this.role !== 'remote') this.becomeRemote();
      this.mirror();
    } else {
      this.active = null;
      if (this.role === 'remote') {
        // The device that was playing has gone (or stopped a while ago):
        // what it was playing stays here, ready to carry on.
        this.leaveRemote({ adopt: true });
      } else if (this.role === 'active') {
        // This device went quiet for too long: still playing, it's the one again.
        this.role = 'idle';
        if (player.isPlaying) this.activate();
      } else if (first) {
        this.carryOn();
      }
    }
    this.emit('change');
  }

  // Nothing plays anywhere, but one of your other devices was playing
  // something (and has stopped, or closed): carry on from there.
  carryOn() {
    const st = this.state;
    if (!st?.qid || !this.queue.length || st.by === this.id || player.isPlaying || player.cast || player.remote) return;
    const index = this.queue.findIndex((t) => t.qid === st.qid);
    if (index < 0) return;
    const cur = this.queue[index];
    if (player.current?.id === cur.id && Math.abs(player.time - st.position / 1000) < 5) return;
    debugLog('devices', `carrying on from what another device was playing`);
    player.adoptQueue({ queue: this.queue, index, position: st.position / 1000, context: st.context, shuffle: st.shuffle, repeat: st.repeat });
  }

  // ---------- playing here ----------

  // This device started playing: it's the one that plays now.
  async activate() {
    if (this.role === 'off' || this.role === 'remote' || this.claiming) return;
    this.claiming = true;
    try {
      const view = await this.post('activate');
      this.queueDirty = true;
      this.apply(view);
    } catch (err) {
      debugLog('devices', `couldn't say this device plays now: ${err.message}`, 'warn');
    } finally {
      this.claiming = false;
    }
  }

  becomeActive() {
    this.role = 'active';
    this.queueDirty = true;
    clearInterval(this.ticker);
    clearInterval(this.heartbeat);
    this.heartbeat = setInterval(() => player.isPlaying && this.report(), HEARTBEAT_MS);
    this.watchIdle();
    this.reportSoon(0);
  }

  onPlayer(kind) {
    if (this.role === 'idle' && kind === 'state' && player.isPlaying && player.current && !player.remote && player.cast !== this.remote) {
      this.activate();
      return;
    }
    if (this.role !== 'active') return;
    if (kind === 'queue') this.queueDirty = true;
    if (kind === 'state') this.watchIdle();
    this.reportSoon();
  }

  // A seek here (the time jumped from where it was going): the others hear of it.
  onTime() {
    const r = this.lastReport;
    if (this.role !== 'active' || !r || this.reportTimer) return;
    const expected = r.position + (r.playing ? clientNow() - r.at : 0);
    if (Math.abs(player.time * 1000 - expected) > 2000) this.reportSoon();
  }

  // Paused for a long while: stop being the device that plays.
  watchIdle() {
    clearTimeout(this.idleTimer);
    if (this.role !== 'active' || player.isPlaying) return;
    this.idleTimer = setTimeout(() => {
      if (this.role !== 'active' || player.isPlaying) return;
      this.role = 'idle';
      clearInterval(this.heartbeat);
      this.post('release').catch(() => {});
    }, IDLE_RELEASE_MS);
  }

  reportSoon(delay = REPORT_DELAY) {
    if (this.role !== 'active') return;
    clearTimeout(this.reportTimer);
    this.reportTimer = setTimeout(() => {
      this.reportTimer = 0;
      this.report();
    }, delay);
  }

  async report() {
    if (this.role !== 'active') return;
    const p = player;
    // The queue around the current track, starting at a round number so it
    // isn't sent again at every track.
    const from = Math.max(0, Math.floor(Math.max(0, p.index - 100) / 200) * 200);
    const body = {
      qid: p.current ? String(p.current.qid) : null,
      playing: p.isPlaying,
      position: Math.round(p.time * 1000),
      duration: Math.round((p.duration || 0) * 1000),
      shuffle: p.shuffle,
      repeat: p.repeat,
      volume: p.muted ? 0 : p.volume,
      context: p.context,
      output: p.cast && p.cast !== this.remote ? p.cast.target?.name || null : p.routed ? 'an AirPlay or Cast device' : null,
      ack: this.lastCmd,
    };
    if (this.queueDirty || from !== this.sentFrom) {
      body.queue = p.queue.slice(from, from + WINDOW).map(slim);
      this.queueDirty = false;
      this.sentFrom = from;
    }
    this.lastReport = { position: body.position, at: clientNow(), playing: body.playing };
    try {
      await this.post('report', body);
    } catch (err) {
      if (body.queue) this.queueDirty = true;
      // Another device plays now: the next answer says which.
      if (err.status === 409) this.poke();
    }
  }

  // Commands from your other devices, in order, each once.
  runCommands(cmds) {
    let ran = false;
    for (const c of cmds) {
      if (!(c.id > this.lastCmd)) continue;
      this.lastCmd = c.id;
      ran = true;
      try {
        this.execute(c);
      } catch (err) {
        debugLog('devices', `a command from another device failed: ${err.message}`, 'warn');
      }
    }
    if (ran) this.reportSoon();
  }

  execute(c) {
    const at = (qid) => player.queue.findIndex((t) => String(t.qid) === qid);
    switch (c.type) {
      case 'play':
        return player.play();
      case 'pause':
        return player.pause();
      case 'next':
        return player.next();
      case 'prev':
        return player.prev();
      case 'seek':
        return player.seek(c.position / 1000);
      case 'jump': {
        const i = at(c.qid);
        return i >= 0 && player.jump(i);
      }
      case 'remove': {
        const i = at(c.qid);
        return i >= 0 && player.remove(i);
      }
      case 'move-to-top': {
        const i = at(c.qid);
        return i >= 0 && player.moveToTop(i);
      }
      case 'play-tracks':
        return player.playTracks(c.tracks, c.start, { context: c.context, shuffle: c.shuffle });
      case 'add':
        return c.next ? player.playNext(c.tracks) : player.addToQueue(c.tracks);
      case 'replace-upcoming':
        return player.replaceUpcoming(c.tracks, c.context);
      case 'shuffle':
        return player.setShuffle(c.on);
      case 'repeat':
        return player.setRepeat(c.mode);
      case 'volume':
        return player.setVolume(c.volume);
      default:
        return undefined;
    }
  }

  // ---------- another device plays ----------

  becomeRemote() {
    clearTimeout(this.reportTimer);
    clearInterval(this.heartbeat);
    clearTimeout(this.idleTimer);
    this.reportTimer = 0;
    // Playing on a Plex player from here: it stops, as this device does.
    if (player.cast && player.cast !== this.remote) {
      player.cast.pause?.();
      player.cast.stop?.({ here: false, quiet: true });
    }
    this.role = 'remote';
    this.queueChanged = true;
    player.setCast(this.remote);
    clearInterval(this.ticker);
    // The clock moves smoothly between answers.
    this.ticker = setInterval(() => player.isPlaying && player.queueTime(), 250);
  }

  // Another device took over: this one goes quiet and follows it.
  lostTo(dev) {
    this.becomeRemote();
    toast(`Now playing on ${dev.name}`, { action: 'Listen here', onAction: () => this.takeOver(), timeout: 6000 });
  }

  // Shows what the playing device is playing.
  mirror() {
    if (this.role !== 'remote') return;
    const st = this.state;
    const index = st ? this.queue.findIndex((t) => t.qid === st.qid) : -1;
    player.castUpdate({
      queue: this.queueChanged ? this.queue.map((t) => ({ ...t })) : undefined,
      index: index >= 0 ? index : undefined,
      state: st?.playing ? 'playing' : 'paused',
      // Not while the volume is being changed here.
      volume: st && clientNow() - this.volumeAt > 2500 ? st.volume : undefined,
      context: st ? st.context : undefined,
    });
    this.queueChanged = false;
    if (st && (player.shuffle !== st.shuffle || player.repeat !== st.repeat)) {
      player.shuffle = st.shuffle;
      player.repeat = st.repeat;
      player.emit('mode');
    }
  }

  // Where the playing device is in its track now (s).
  time() {
    const st = this.state;
    if (!st) return 0;
    let ms = st.position + (st.playing ? this.serverNow() - st.at : 0);
    if (st.duration) ms = Math.min(ms, st.duration);
    return Math.max(0, ms) / 1000;
  }

  // A command for the device that's playing; `expect` shows its effect here
  // straight away (until that device says otherwise).
  async send(cmd, expect = null) {
    if (this.role !== 'remote') return;
    if (expect && this.state) {
      const st = this.state;
      const now = this.serverNow();
      st.position = expect.position ?? this.time() * 1000;
      st.at = now;
      if ('playing' in expect) st.playing = expect.playing;
      this.mirror();
      player.queueTime();
    }
    try {
      const { id } = await this.post('command', { command: cmd });
      // The device that plays carries commands out at once; if it hasn't
      // after a few seconds, it's probably gone (closed, asleep).
      clearTimeout(this.answerTimer);
      this.answerTimer = setTimeout(() => {
        if (this.role !== 'remote' || this.acked >= id) return;
        toast(`${this.active?.name || 'Your other device'} isn’t answering.`, { action: 'Listen here', onAction: () => this.takeOver(), timeout: 7000 });
      }, 5000);
    } catch (err) {
      toast(err.status === 409 ? 'Nothing is playing on your other devices now.' : `Couldn’t reach your other device. ${err.message}`);
      this.poke();
    }
  }

  byIndex(type, i) {
    const t = player.queue[i];
    if (t?.qid != null) this.send({ type, qid: String(t.qid) });
  }

  // "Listen here": the music moves to this device, from where it's got to,
  // and the device that was playing goes quiet.
  async takeOver({ play } = {}) {
    if (this.role !== 'remote' || this.taking) return false;
    // Within the tap, so the sound can start after the request below.
    player.unlock({ all: true });
    const st = this.state;
    const start = play ?? !!st?.playing;
    const at = this.time();
    this.taking = true;
    try {
      await this.post('activate');
    } catch (err) {
      toast(`Couldn’t move the music here. ${err.message}`);
      return false;
    } finally {
      this.taking = false;
    }
    debugLog('devices', `playing here now, taken over from ${this.active?.name || 'another device'}`);
    this.role = 'active';
    this.leaveRemote({ adopt: true, play: start, at });
    this.becomeActive();
    this.emit('change');
    return true;
  }

  // Back to playing on its own: the playing device's queue becomes this
  // one's (`adopt`), ready at the same spot, or playing from it (`play`).
  leaveRemote({ adopt = true, play = false, at } = {}) {
    clearInterval(this.ticker);
    const st = this.state;
    const position = at ?? this.time();
    if (player.cast === this.remote) player.setCast(null);
    if (this.role === 'remote') this.role = 'idle';
    if (!adopt || !this.queue.length) return;
    const index = Math.max(0, this.queue.findIndex((t) => t.qid === st?.qid));
    player.adoptQueue({ queue: this.queue, index, position, context: st?.context || null, shuffle: !!st?.shuffle, repeat: st?.repeat || 'off', play });
  }
}

export const devices = new Devices();
