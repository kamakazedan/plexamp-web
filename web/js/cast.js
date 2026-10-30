// "Play on": where the music plays. This device; another Plex player on the
// network (Plexamp on a Raspberry Pi, say), with this app as its remote; or
// an AirPlay or Google Cast device through the browser's own picker.
//
// Casting to a Plex player: the queue becomes a play queue on the Plex
// server, the player is told (through the container's service, see
// server/cast.js) to play it with a temporary token from the server, and
// this app follows what the player does by asking it every second. Changes
// to the queue go to the play queue, and the player is told to look again.
import { app, on, plexAccount } from './state.js';
import { player } from './player.js';
import { normTrack, store } from './plex.js';
import { popOverlay, describeError } from './router.js';
import { h, icon, sheet, toast, shuffleArray } from './ui.js';
import { together } from './together.js';
import { debugLog } from './debug.js';
import { devices } from './devices.js';

const POLL_MS = 1000;
// A temporary token is asked for afresh for each device (it stops working
// if the server restarts), but one is shared by requests within a minute.
const TOKEN_TTL = 60000;
const WINDOW_BEFORE = 50; // tracks before the current one that go with it
const WINDOW_AFTER = 300;
const saveKey = () => (app.source ? `cast.${app.source.serverId || app.source.uri}` : null);

class CastError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.status = status;
  }
}

async function api(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(`api/cast/${path}`, {
      method,
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { Accept: 'application/json', 'X-Plex-Token': app.auth?.token || '', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(12000),
    });
  } catch {
    throw new CastError('Can’t reach this player’s server.');
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* empty */
  }
  if (!res.ok) throw new CastError(data?.error || `Something went wrong (${res.status}).`, res.status);
  return data || {};
}

const asList = (v) => (Array.isArray(v) ? v : v ? [v] : []);

// The play queue's entries as queue tracks: each keeps its entry's id, so it
// keeps its place (and its qid) while it's in the queue.
function entriesOf(mc) {
  return asList(mc.Metadata)
    .filter((m) => m.type === 'track' && m.playQueueItemID != null)
    .map((m) => ({ ...normTrack(m), qid: `c:${m.playQueueItemID}`, pqid: String(m.playQueueItemID) }));
}

class Cast extends EventTarget {
  constructor() {
    super();
    this.target = null; // { id, name, product } while casting
    this.pq = null; // { id, version }
    this.last = null; // the player's last timeline, with `at` (performance.now())
    this.pending = null; // { state, time } changed here, until the player says so too
    this.pollTimer = 0;
    this.pollRun = 0; // which polling loop is current (an older one stops)
    this.tickTimer = 0;
    this.failures = 0;
    this.volumeTimer = 0;
    this.volumeAt = 0;
    this.token = null; // { value, at, key }: for one server and account
    this.tokenRefused = false; // the server wouldn't give one out
    on('signout', () => {
      this.token = null;
      this.stop({ here: false, quiet: true });
    });
    on('source', ({ serverChanged }) => {
      this.token = null;
      if (serverChanged) this.stop({ here: false, quiet: true });
      this.tokenRefused = false;
      // Still on AirPlay or Cast: a temporary token for this server.
      if (player.useMediaToken) fetchMediaToken();
    });
  }

  get active() {
    return !!this.target;
  }

  // Plex players are listed when the container's service is there to reach
  // them and you're signed in with Plex.
  get available() {
    return !!app.config.cast && plexAccount();
  }

  emit(type) {
    this.dispatchEvent(new Event(type));
  }

  async players() {
    if (!this.available) return [];
    return asList((await api('players')).players);
  }

  // A temporary token from the server, for whatever device plays: it never
  // gets the account's own.
  async temporaryToken() {
    const server = app.server;
    const key = `${server.id}|${server.token}`;
    if (this.token?.key === key && Date.now() - this.token.at < TOKEN_TTL) return this.token.value;
    const value = await server.transientToken();
    // Signed out, or on another server, while it was being asked for: not kept.
    if (app.server !== server) throw Object.assign(new CastError('The server changed while this was being set up.'), { aborted: true });
    this.token = { value, at: Date.now(), key };
    return value;
  }

  // ---------- starting and stopping ----------

  // `play`: start playing there (default: if it's playing here).
  async start(device, { play } = {}) {
    if (together.active) throw new CastError('Leave Play Together first: a session plays on each person’s own device.');
    if (this.target?.id === device.id) return;
    if (this.target) await this.stop({ here: false, quiet: true });
    const cur = player.current;
    const at = player.time;
    const playing = play ?? player.isPlaying;
    const before = { queue: player.queue, index: player.index, context: player.context };
    this.target = { id: device.id, name: device.name, product: device.product || '' };
    this.last = null;
    this.pending = null;
    this.failures = 0;
    player.setCast(this);
    this.emit('change');
    try {
      if (cur) await this.send(player.queue, player.index, at, { play: playing, context: player.context });
      else player.castUpdate({ state: 'paused' });
    } catch (err) {
      // Nothing changes here: the queue and the spot are as they were.
      this.target = null;
      this.pq = null;
      player.setCast(null);
      Object.assign(player, before, { restoredAt: at, state: 'paused' });
      player.emit('queue');
      player.emit('track');
      player.emit('state');
      this.emit('change');
      throw err;
    }
    this.save();
    this.startPolling();
  }

  // Back to this device (here) at the player's spot, or just let go of the
  // player (it carries on).
  async stop({ here = true, quiet = false } = {}) {
    if (!this.target) return;
    const target = this.target;
    const wasPlaying = player.isPlaying;
    const at = this.time();
    this.stopPolling();
    this.target = null;
    this.pq = null;
    this.save();
    if (here) {
      // The player stops, and this device carries on from the same spot.
      api(`players/${encodeURIComponent(target.id)}/command`, { method: 'POST', body: { command: 'pause' } }).catch(() => {});
    }
    // The queue keeps its tracks; they become this device's own again.
    const queue = player.queue.map(({ pqid, ...t }) => t);
    player.setCast(null);
    player.queue = queue;
    player.restoredAt = at;
    player.state = 'paused';
    player.volume = store.get('volume', 1);
    player.applyVolume();
    player.emit('volume');
    player.emit('queue');
    player.emit('state');
    player.persist();
    this.emit('change');
    if (here && player.current) player.load(player.index, { startAt: at, autoplay: wasPlaying, reportPrev: false });
    if (!quiet) toast(here ? `Playing on this device` : `Stopped controlling ${target.name}`);
  }

  // Remembered, so a reload picks the player up again.
  save() {
    const key = saveKey();
    if (!key) return;
    store.set(key, this.target && this.pq ? { ...this.target, playQueueID: this.pq.id } : null);
  }

  // After a reload: still playing our play queue there? Then carry on as its
  // remote.
  async resume() {
    const key = saveKey();
    const saved = key && store.get(key);
    if (!saved?.id || !this.available || this.target) return;
    try {
      const t = await api(`players/${encodeURIComponent(saved.id)}/timeline`);
      if (t.state === 'stopped' || String(t.playQueueID) !== String(saved.playQueueID)) throw new Error('moved on');
      this.target = { id: saved.id, name: saved.name, product: saved.product || '' };
      this.pq = { id: saved.playQueueID, version: null };
      player.setCast(this);
      await this.refetch();
      this.take(t);
      this.emit('change');
      this.startPolling();
    } catch {
      store.set(key, null);
    }
  }

  // ---------- the play queue ----------

  // A new play queue from these tracks, played from track `index` at `at`
  // seconds.
  async send(tracks, index, at, { play = true, context } = {}) {
    const s = app.server;
    const from = Math.max(0, index - WINDOW_BEFORE);
    const list = tracks.slice(from, index + WINDOW_AFTER + 1).filter((t) => /^\d+$/.test(String(t.id)));
    const sel = tracks[index];
    if (!sel || !list.length) throw new CastError('There’s nothing to play.');
    const repeat = player.repeat === 'one' ? 1 : player.repeat === 'all' ? 2 : 0;
    const [mc, token, serverId] = await Promise.all([s.createPlayQueue(list.map((t) => t.id), sel.id, { repeat }), this.temporaryToken(), s.machineId()]);
    if (!mc.playQueueID) throw new CastError('The server couldn’t make a play queue.');
    this.pq = { id: String(mc.playQueueID), version: mc.playQueueVersion ?? null };
    const queue = entriesOf(mc);
    const i = Math.max(0, queue.findIndex((t) => t.pqid === String(mc.playQueueSelectedItemID)));
    player.castUpdate({ queue, index: i, state: play ? 'loading' : 'paused', context });
    await api(`players/${encodeURIComponent(this.target.id)}/play`, {
      method: 'POST',
      body: { key: `/library/metadata/${queue[i].id}`, offset: Math.round(at * 1000), playQueueID: Number(this.pq.id), serverId, token },
    });
    if (!play) await this.command('pause');
    this.pending = { state: play ? 'playing' : 'paused', time: at, at: performance.now(), until: performance.now() + 4000 };
    this.save();
  }

  // The play queue again, from the server: the queue shown here follows it.
  async refetch() {
    if (!this.pq) return;
    const mc = await app.server.playQueue(this.pq.id);
    this.pq.version = mc.playQueueVersion ?? null;
    this.adopt(mc);
  }

  adopt(mc) {
    const queue = entriesOf(mc);
    const playingId = this.last?.playQueueItemID || player.current?.pqid || String(mc.playQueueSelectedItemID || '');
    const i = queue.findIndex((t) => t.pqid === playingId);
    player.castUpdate({ queue, index: i >= 0 ? i : Math.max(0, Math.min(player.index, queue.length - 1)) });
  }

  // After changing the play queue: the player is told to fetch it again.
  async changed(mc) {
    if (mc?.playQueueID) {
      this.pq.version = mc.playQueueVersion ?? this.pq.version;
      this.adopt(mc);
    } else await this.refetch();
    await this.command('refreshPlayQueue', { playQueueID: Number(this.pq.id) });
  }

  async edit(fn) {
    if (!this.pq) return;
    try {
      await this.changed(await fn(app.server, this.pq.id));
    } catch (err) {
      toast(describeError(err));
      this.refetch().catch(() => {});
    }
  }

  // ---------- following the player ----------

  startPolling() {
    this.stopPolling();
    const run = this.pollRun;
    const tick = async () => {
      if (!this.target || run !== this.pollRun) return;
      try {
        const t = await api(`players/${encodeURIComponent(this.target.id)}/timeline`);
        this.failures = 0;
        await this.take(t);
      } catch (err) {
        this.failures += 1;
        if (this.failures === 3) debugLog('cast', `lost touch with ${this.target?.name}: ${err.message}`, 'warn');
        if (this.failures >= 6) {
          const name = this.target?.name || 'the player';
          this.stop({ here: false, quiet: true });
          toast(`Lost touch with ${name}.`);
          return;
        }
      }
      if (this.target && run === this.pollRun) this.pollTimer = setTimeout(tick, POLL_MS);
    };
    this.pollTimer = setTimeout(tick, 300);
    // The clock moves smoothly between answers.
    this.tickTimer = setInterval(() => player.isPlaying && player.queueTime(), 250);
  }

  stopPolling() {
    this.pollRun += 1;
    clearTimeout(this.pollTimer);
    clearInterval(this.tickTimer);
    this.pollTimer = 0;
    this.tickTimer = 0;
  }

  // A timeline from the player: { state, time, duration, playQueueID,
  // playQueueItemID, playQueueVersion, volume, ... }.
  async take(t) {
    if (!this.target) return;
    const now = performance.now();
    const prev = this.last;
    this.last = { ...t, at: now };
    if (this.pending && (now > this.pending.until || t.state === this.pending.state)) this.pending = null;
    // Another play queue: someone started something else there (Plexamp,
    // say). Follow it if this account can see it.
    if (t.playQueueID && this.pq && String(t.playQueueID) !== String(this.pq.id)) {
      this.pq = { id: String(t.playQueueID), version: null };
      try {
        await this.refetch();
        this.save();
      } catch {
        const name = this.target.name;
        this.stop({ here: false, quiet: true });
        toast(`${name} is playing something else now.`);
        return;
      }
    } else if (t.playQueueVersion != null && this.pq && this.pq.version != null && t.playQueueVersion !== this.pq.version) {
      await this.refetch().catch(() => {});
    }
    let index;
    if (t.playQueueItemID) {
      const i = player.queue.findIndex((x) => x.pqid === String(t.playQueueItemID));
      if (i >= 0) index = i;
      else await this.refetch().catch(() => {});
    }
    const state = this.pending?.state || (t.state === 'playing' ? 'playing' : t.state === 'buffering' ? 'loading' : 'paused');
    const volume = t.volume != null && performance.now() - this.volumeAt > 2500 ? t.volume / 100 : null;
    const moved = index !== undefined && index !== player.index;
    player.castUpdate({ index, state, volume });
    this.emit('timeline');
    // Sleep timer set to "end of this track", and the player moved on by
    // itself (the last track was at its end): stop, ready at the next one.
    if (moved && player.sleepEndOfTrack && prev?.duration && prev.time != null) {
      const reached = prev.time + (prev.state === 'playing' ? now - prev.at : 0);
      if (prev.duration - reached < 4000) {
        player.fireSleep();
        this.seek(0);
      }
    }
  }

  time() {
    const p = this.pending;
    if (p) return p.state === 'playing' ? p.time + (performance.now() - p.at) / 1000 : p.time;
    const t = this.last;
    if (!t || t.time == null) return player.restoredAt || 0;
    let sec = t.time / 1000;
    if (t.state === 'playing') sec += (performance.now() - t.at) / 1000;
    const d = this.duration();
    return d ? Math.min(sec, d) : sec;
  }

  duration() {
    const t = this.last;
    if (t?.duration) return t.duration / 1000;
    return (player.current?.duration || 0) / 1000;
  }

  // ---------- commands ----------

  async command(command, params = {}) {
    if (!this.target) return;
    try {
      await api(`players/${encodeURIComponent(this.target.id)}/command`, { method: 'POST', body: { command, ...params } });
    } catch (err) {
      toast(err.message);
      throw err;
    }
  }

  // Shown at once, before the player confirms.
  expect(state, time = this.time()) {
    this.pending = { state, time, at: performance.now(), until: performance.now() + 4000 };
    player.castUpdate({ state: state === 'playing' ? 'playing' : 'paused' });
  }

  play() {
    if (!this.pq) {
      if (player.current) return this.send(player.queue, player.index, player.time).catch((err) => toast(err.message));
      return;
    }
    this.expect('playing');
    this.command('play').catch(() => {});
  }

  pause() {
    this.expect('paused');
    this.command('pause').catch(() => {});
  }

  seek(sec) {
    const d = this.duration();
    const t = Math.max(0, Math.min(sec, d ? d - 0.25 : sec));
    this.expect(player.isPlaying ? 'playing' : 'paused', t);
    this.command('seekTo', { offset: Math.round(t * 1000) }).catch(() => {});
  }

  next() {
    if (player.index + 1 >= player.queue.length) return;
    this.command('skipNext').catch(() => {});
  }

  prev() {
    this.command('skipPrevious').catch(() => {});
  }

  jump(i) {
    const t = player.queue[i];
    if (!t) return;
    if (i === player.index) return this.play();
    this.command('skipTo', { key: `/library/metadata/${t.id}`, playQueueItemID: Number(t.pqid) }).catch(() => {});
  }

  // Sent a moment after the slider stops moving.
  setVolume(v) {
    this.volumeAt = performance.now();
    clearTimeout(this.volumeTimer);
    this.volumeTimer = setTimeout(() => {
      this.volumeTimer = 0;
      this.volumeAt = performance.now();
      this.command('setParameters', { volume: Math.round(v * 100) }).catch(() => {});
    }, 200);
  }

  setRepeat(mode) {
    this.command('setParameters', { repeat: mode === 'one' ? 1 : mode === 'all' ? 2 : 0 }).catch(() => {});
    player.emit('mode');
  }

  // Shuffling, and other changes that replace what's next, send a new play
  // queue from the current track (and the current spot).
  async resend(queue, index) {
    try {
      await this.send(queue, index, this.time(), { play: player.isPlaying, context: player.context });
    } catch (err) {
      toast(describeError(err));
    }
  }

  playTracks(tracks, start, { context, shuffle } = {}) {
    let list = tracks.map((t) => ({ ...t }));
    let i = Math.min(start, list.length - 1);
    if (shuffle) {
      const first = start > 0 ? list[start] : list[Math.floor(Math.random() * list.length)];
      list = [first, ...shuffleArray(list.filter((t) => t !== first))];
      i = 0;
    }
    player.shuffle = !!shuffle;
    player.emit('mode');
    player.emit('started');
    this.send(list, i, 0, { play: true, context: context || null }).catch((err) => toast(describeError(err)));
  }

  setShuffle(on) {
    player.shuffle = on;
    player.emit('mode');
    if (!on || player.upcoming.length < 2) return;
    const q = player.queue;
    const i = player.index;
    this.resend([...q.slice(0, i + 1), ...shuffleArray(q.slice(i + 1))], i);
  }

  replaceUpcoming(tracks, context) {
    const i = player.index;
    if (context !== undefined) player.context = context;
    this.resend([...player.queue.slice(0, i + 1), ...tracks], i);
  }

  add(tracks, { next }) {
    const ids = tracks.map((t) => t.id).filter((id) => /^\d+$/.test(String(id)));
    if (!ids.length) return;
    if (!this.pq) return this.send(tracks, 0, 0).catch((err) => toast(describeError(err)));
    this.edit((s, id) => s.addToPlayQueue(id, ids, { next }));
  }

  remove(i) {
    const t = player.queue[i];
    if (!t || i === player.index) return;
    this.edit((s, id) => s.removeFromPlayQueue(id, t.pqid));
  }

  moveToTop(i) {
    const t = player.queue[i];
    const cur = player.current;
    if (!t || !cur || i <= player.index + 1) return;
    this.edit((s, id) => s.movePlayQueueItem(id, t.pqid, cur.pqid));
  }
}

export const cast = new Cast();

// ---------- AirPlay and Google Cast, through the browser ----------

// Shown only where the browser says there's a device to send to (Safari's
// AirPlay, Chrome on Android's Cast). Browsers that can't tell don't get it.
const available = new Map(); // element -> boolean
for (const d of player.decks) {
  d.el.remote?.watchAvailability?.((yes) => {
    available.set(d.el, !!yes);
    cast.emit('change');
  }).catch(() => available.delete(d.el));
}

export function remotePlaybackSupported() {
  const el = player.audio;
  return !!el?.remote && typeof el.remote.prompt === 'function' && !el.disableRemotePlayback && (player.routed || available.get(el) === true);
}

// The server's temporary token, for AirPlay and Cast devices.
function fetchMediaToken(then) {
  if (!app.server) return;
  cast.temporaryToken().then(
    (t) => {
      cast.tokenRefused = false;
      player.setMediaToken(t);
      then?.();
    },
    (err) => {
      // Refused, or an answer that isn't a token (rather than no answer).
      if (err?.status === 401 || err?.status === 403 || (!err?.status && !err?.network && !err?.aborted)) cast.tokenRefused = true;
    },
  );
}

// Opens the browser's own device picker for the element that's playing.
function promptRemote() {
  const el = player.audio;
  if (!player.deck.hasSource() || cast.active) {
    toast(cast.active ? `Playing on ${cast.target.name} now: choose This device first.` : 'Play something first, then choose where it plays.');
    return;
  }
  // The device is only ever given the server's temporary token: without one, nothing's sent.
  if (!player.prepareRemote()) {
    if (cast.tokenRefused) toast('Your Plex server didn’t give out a token for other devices, so tracks can’t be sent to one from here.');
    else {
      toast('Getting ready to play on another device: try again in a moment.');
      fetchMediaToken();
    }
    return;
  }
  try {
    el.remote.prompt().then(
      () => {},
      (err) => {
        if (el.remote.state !== 'connected') player.useMediaToken = false;
        if (err?.name === 'NotSupportedError') toast('This track can’t be sent to another device from this browser.');
        else if (err?.name !== 'NotAllowedError' && err?.name !== 'AbortError') toast('Couldn’t open the list of devices.');
      },
    );
  } catch {
    toast('Couldn’t open the list of devices.');
  }
}

// The browser tells us when an element connects to, or leaves, a device.
for (const d of player.decks) {
  const r = d.el.remote;
  if (!r?.addEventListener) continue;
  const changed = () => {
    if (r.state === 'connected') {
      // One element plays from now on: the other one isn't connected.
      player.cancelTransition();
      player.spare.reset();
      // Connected from the browser's own controls rather than Play on: the
      // track changes to the server's temporary token straight away (once
      // there is one), so the device doesn't keep the account's own. (Not
      // while it's connecting, which a new address could interrupt.)
      if (!player.useMediaToken && d === player.deck && !player.prepareRemote()) {
        fetchMediaToken(() => r.state === 'connected' && !player.useMediaToken && player.prepareRemote());
      }
    } else if (r.state === 'disconnected' && !player.routed) {
      player.useMediaToken = false;
    }
    player.emit('mode');
    cast.emit('change');
  };
  r.addEventListener('connect', changed);
  r.addEventListener('connecting', changed);
  r.addEventListener('disconnect', changed);
}

// ---------- the "Play on" sheet ----------

function choice({ iconName, label, description, checked = false, muted = false, onSelect }) {
  return h(
    `button.sheet-action${description ? '.has-desc' : ''}${muted ? '.muted' : ''}`,
    {
      type: 'button',
      'aria-pressed': String(checked),
      disabled: muted && !onSelect,
      onclick: onSelect ? async () => {
        await popOverlay();
        onSelect();
      } : null,
    },
    icon(iconName, 24),
    h('span.sheet-action-text', null, h('span.sheet-action-label', null, label), description ? h('span.sheet-action-desc', null, description) : null),
    checked ? icon('check', 22, 'sheet-check') : null,
  );
}

const describe = (p) => [p.product, p.device].filter(Boolean).join(' · ') + (p.online ? '' : ' (may be off)');

export function openCastSheet() {
  // Asked for straight away, so it's ready if AirPlay or Cast is picked.
  fetchMediaToken();
  const list = h('div.sheet-actions.cast-list');
  const elsewhere = devices.isRemote; // another of your devices plays
  const here = !cast.active && !player.routed && !elsewhere;
  const rows = [
    choice({
      iconName: 'speaker3',
      label: 'This device',
      description: elsewhere
        ? `Listen here: the music moves from ${devices.playingOn}`
        : player.routed
          ? 'Stop playing on the AirPlay or Cast device in the browser’s own controls'
          : null,
      checked: here,
      onSelect: () => (elsewhere ? devices.takeOver() : cast.active ? cast.stop({ here: true }) : null),
    }),
  ];
  if (elsewhere) {
    rows.push(choice({ iconName: 'casting', label: devices.active?.name || devices.playingOn, description: 'One of your devices: playing now', checked: true, onSelect: () => {} }));
  }
  const players = h('div.cast-players');
  if (cast.available) {
    if (together.active) players.append(choice({ iconName: 'cast', label: 'Plex players', description: 'Not while listening together', muted: true }));
    else players.append(choice({ iconName: 'cast', label: 'Looking for Plex players…', muted: true }));
  }
  rows.push(players);
  if (remotePlaybackSupported() && !elsewhere) {
    rows.push(
      choice({
        iconName: 'airplay',
        label: player.routed ? 'AirPlay or Cast device (playing)' : 'AirPlay or Cast…',
        description: 'Opens this browser’s list of nearby speakers and TVs',
        checked: player.routed,
        onSelect: null,
      }),
    );
    // The picker must open straight from the tap: no waiting on the sheet.
    rows.at(-1).onclick = () => {
      promptRemote();
      popOverlay();
    };
  }
  list.append(...rows);
  const note = h(
    'p.cast-note',
    null,
    'Alexa speakers only play from Amazon’s approved music services, so no app can cast to them. To play there, pair the speaker with this device over Bluetooth. In Chrome on a computer, Chrome’s own Cast menu can also play this tab on a Google speaker.',
  );
  sheet({ title: 'Play on', content: h('div', null, list, note) });

  if (!cast.available || together.active) return;
  cast
    .players()
    .then((found) => {
      const shown = found.length
        ? found.map((p) =>
            choice({
              iconName: 'cast',
              label: p.name,
              description: describe(p),
              checked: cast.target?.id === p.id,
              onSelect: async () => {
                if (cast.target?.id === p.id) return;
                // Playing on another of your devices: from there to this player.
                const playing = player.isPlaying;
                if (devices.isRemote && !(await devices.takeOver({ play: false }))) return;
                cast.start(p, { play: playing }).catch((err) => toast(err.message));
              },
            }),
          )
        : [choice({ iconName: 'cast', label: 'No Plex players found', description: 'Plexamp and other Plex players signed in to your account, on this network, show up here', muted: true })];
      players.replaceChildren(...shown);
    })
    .catch((err) =>
      players.replaceChildren(
        choice({ iconName: 'cast', label: err.status === 403 ? 'Plex players' : 'Couldn’t look for Plex players', description: err.message, muted: true }),
      ),
    );
}

// Where it's playing, for the player's chip ("Playing on Living Room").
export function castLabel() {
  if (cast.active) return cast.target.name;
  if (player.routed) return 'an AirPlay or Cast device';
  return null;
}
