// Your devices: one listening session across the devices signed in to the
// same Plex account and playing from the same server.
//
// One device plays (the active one). It reports what it's playing; the
// others show that and send it commands (pause, skip, play this album), and
// any of them can take over, which moves the music there. Unlike Play
// Together, nothing here plays or advances by itself: the active device's
// own player is in charge, with its crossfades, Guest DJ and the rest, and
// this only passes its state and commands along. Held in memory only.
import { cleanTrack } from './together.js';

export const LIMITS = {
  homes: 2000, // accounts × servers
  devices: 16, // per account and server
  queue: 600, // the part of the queue around the current track that's shared
  tracksAtOnce: 1000, // in one command
  commands: 50, // waiting for the active device
  commandTracks: 2000, // in those commands, between them
  goneMs: 50000, // not heard from for this long: gone (and no longer playing)
  keepMs: 24 * 3600000, // the last state, kept for a device that comes back
  waitMs: 25000,
};

export class DevicesError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const SERVER_ID = /^[A-Za-z0-9._:-]{1,100}$/;
const DEVICE_ID = /^[A-Za-z0-9_-]{8,64}$/;
const QID = /^[A-Za-z0-9:_-]{1,40}$/;
const HREF = /^\/(?!\/)[A-Za-z0-9/_-]{0,80}$/;
const REPEAT = new Set(['off', 'all', 'one']);
const str = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max);
const int = (v, max) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= 0 && n <= max ? n : 0;
};
const qidOf = (v) => (QID.test(String(v ?? '')) ? String(v) : null);

// A track as the active device has it in its queue: what Play Together
// keeps (each field checked), plus where it sits on its album, its rating,
// and its place in that device's queue.
export function cleanQueueTrack(t) {
  const c = cleanTrack(t);
  const qid = qidOf(t?.qid);
  if (!c || !qid) return null;
  return {
    ...c,
    index: int(t.index, 10000) || null,
    disc: int(t.disc, 1000) || null,
    userRating: t.userRating == null ? null : int(t.userRating, 10) || null,
    dj: /^[a-z0-9-]{1,30}$/.test(String(t.dj || '')) ? String(t.dj) : null,
    qid,
  };
}

const cleanTracks = (list, max) => (Array.isArray(list) ? list.slice(0, max).map(cleanTrack).filter(Boolean) : []);

export function cleanContext(c) {
  if (!c || typeof c !== 'object') return null;
  const title = str(c.title, 200);
  if (!title) return null;
  return { title, href: HREF.test(String(c.href || '')) ? String(c.href) : null };
}

export function cleanDevice(d) {
  if (!d || !DEVICE_ID.test(String(d.id || ''))) return null;
  return { id: String(d.id), name: str(d.name, 60).trim() || 'A browser' };
}

// Commands one device can send the one that's playing, each checked.
export function cleanCommand(c) {
  const type = String(c?.type || '');
  switch (type) {
    case 'play':
    case 'pause':
    case 'next':
    case 'prev':
      return { type };
    case 'seek':
      return { type, position: int(c.position, 24 * 3600000) };
    case 'jump':
    case 'remove':
    case 'move-to-top': {
      const qid = qidOf(c.qid);
      return qid ? { type, qid } : null;
    }
    case 'play-tracks': {
      const tracks = cleanTracks(c.tracks, LIMITS.tracksAtOnce);
      if (!tracks.length) return null;
      const start = Math.max(0, Math.min(Math.round(Number(c.start)) || 0, tracks.length - 1));
      return { type, tracks, start, shuffle: !!c.shuffle, context: cleanContext(c.context) };
    }
    case 'add':
      return { type, tracks: cleanTracks(c.tracks, LIMITS.tracksAtOnce), next: !!c.next };
    case 'replace-upcoming':
      return { type, tracks: cleanTracks(c.tracks, LIMITS.tracksAtOnce), context: c.context === undefined ? undefined : cleanContext(c.context) };
    case 'shuffle':
      return { type, on: !!c.on };
    case 'repeat':
      return REPEAT.has(String(c.mode)) ? { type, mode: String(c.mode) } : null;
    case 'volume': {
      const v = Number(c.volume);
      return Number.isFinite(v) ? { type, volume: Math.max(0, Math.min(1, v)) } : null;
    }
    default:
      return null;
  }
}

export class Devices {
  constructor({ now = () => Date.now(), onChange = () => {} } = {}) {
    this.now = now;
    this.onChange = onChange;
    this.homes = new Map(); // `${userId}|${serverId}` -> home
  }

  // The home of an account on a server: its devices, which one plays, what
  // it's playing, and commands waiting for it.
  home(userId, serverId, { create = true } = {}) {
    if (!SERVER_ID.test(String(serverId || ''))) throw new DevicesError(400, 'Choose a music library first.');
    const key = `${userId}|${serverId}`;
    let h = this.homes.get(key);
    if (!h && create) {
      if (this.homes.size >= LIMITS.homes) this.sweep();
      if (this.homes.size >= LIMITS.homes) throw new DevicesError(429, 'This player is keeping track of too many devices. Try again later.');
      h = { key, devices: new Map(), active: null, state: null, queue: [], queueVersion: 0, commands: [], seq: 0, acked: 0, version: 1, waiters: new Set(), touched: this.now() };
      this.homes.set(key, h);
    }
    return h || null;
  }

  // A device is here (every request says so).
  seen(h, device) {
    const d = cleanDevice(device);
    if (!d) throw new DevicesError(400, 'This device needs an id.');
    const now = this.now();
    const known = h.devices.get(d.id);
    if (known) {
      if (known.name !== d.name) {
        known.name = d.name;
        this.bump(h);
      }
      known.seen = now;
    } else {
      if (h.devices.size >= LIMITS.devices) {
        // The one not seen for longest makes room (never the one playing).
        const oldest = [...h.devices.values()].filter((x) => x.id !== h.active).sort((a, b) => a.seen - b.seen)[0];
        if (oldest) h.devices.delete(oldest.id);
      }
      h.devices.set(d.id, { ...d, seen: now });
      this.bump(h);
    }
    h.touched = now;
    return d;
  }

  bump(h) {
    h.version += 1;
    for (const wake of [...h.waiters]) wake();
    this.onChange(h);
  }

  // This device plays from now on; the one that did stops (it sees it's no
  // longer the active one). Commands waiting for that one are dropped.
  activate(h, device) {
    const d = this.seen(h, device);
    if (h.active !== d.id) {
      h.active = d.id;
      h.commands = [];
      if (h.state) h.state.by = d.id;
      this.bump(h);
    }
  }

  // The playing device stops being the active one (closed, paused for a
  // while, or the setting turned off); what it was playing is kept, paused.
  release(h, deviceId) {
    if (h.active !== deviceId) return false;
    h.active = null;
    h.commands = [];
    if (h.state?.playing) {
      h.state.position = this.position(h);
      h.state.playing = false;
      h.state.at = this.now();
    }
    this.bump(h);
    return true;
  }

  // The active device says what it's playing. `queue` comes only when it
  // changed; `ack` is the last command it carried out.
  report(h, device, body = {}) {
    const d = this.seen(h, device);
    if (h.active !== d.id) throw new DevicesError(409, 'Another of your devices is playing now.');
    if (Array.isArray(body.queue)) {
      h.queue = body.queue.slice(0, LIMITS.queue).map(cleanQueueTrack).filter(Boolean);
      h.queueVersion += 1;
    }
    const qid = qidOf(body.qid);
    const cur = h.queue.find((t) => t.qid === qid) || null;
    h.state = {
      qid: cur ? qid : null,
      playing: !!body.playing && !!cur,
      position: Math.min(int(body.position, 24 * 3600000), cur?.duration || 24 * 3600000),
      duration: int(body.duration, 24 * 3600000) || cur?.duration || 0,
      at: this.now(),
      shuffle: !!body.shuffle,
      repeat: REPEAT.has(String(body.repeat)) ? String(body.repeat) : 'off',
      volume: Number.isFinite(Number(body.volume)) ? Math.max(0, Math.min(1, Number(body.volume))) : 1,
      context: cleanContext(body.context),
      // Playing on a Plex player or speaker from there, rather than itself.
      output: str(body.output, 80) || null,
      by: d.id,
    };
    const ack = Math.min(int(body.ack, Number.MAX_SAFE_INTEGER), h.seq);
    if (ack) {
      h.commands = h.commands.filter((c) => c.id > ack);
      h.acked = Math.max(h.acked, ack);
    }
    this.bump(h);
  }

  // A command for the device that's playing.
  command(h, device, body = {}) {
    const from = this.seen(h, device);
    if (!h.active) throw new DevicesError(409, 'None of your devices is playing now.');
    const cmd = cleanCommand(body);
    if (!cmd) throw new DevicesError(400, 'That command isn’t right.');
    h.seq += 1;
    h.commands.push({ ...cmd, id: h.seq, from: from.id, at: this.now() });
    // The playing device carries commands out at once; if it doesn't, the
    // oldest make way, so what's held stays small.
    let tracks = h.commands.reduce((n, c) => n + (c.tracks?.length || 0), 0);
    while (h.commands.length > LIMITS.commands || (tracks > LIMITS.commandTracks && h.commands.length > 1)) {
      tracks -= h.commands.shift().tracks?.length || 0;
    }
    this.bump(h);
    return h.seq;
  }

  // Where the active device is in its track now (ms), by its last report.
  position(h, now = this.now()) {
    const s = h.state;
    if (!s) return 0;
    const p = s.playing ? s.position + (now - s.at) : s.position;
    return s.duration ? Math.min(p, s.duration) : p;
  }

  // Devices gone quiet are forgotten; one that was playing stops being the
  // active one. Homes nobody has used for a day are dropped. Returns the
  // names of the playing devices let go.
  sweep() {
    const now = this.now();
    const quiet = [];
    for (const [key, h] of this.homes) {
      for (const d of [...h.devices.values()]) {
        if (now - d.seen <= LIMITS.goneMs) continue;
        if (h.active === d.id && this.release(h, d.id)) quiet.push(d.name);
        h.devices.delete(d.id);
        this.bump(h);
      }
      if (now - h.touched > LIMITS.keepMs && !h.waiters.size) this.homes.delete(key);
    }
    return quiet;
  }

  wait(h, since, ms) {
    if (h.version > since) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = (changed) => {
        clearTimeout(timer);
        h.waiters.delete(wake);
        resolve(changed);
      };
      const wake = () => done(true);
      const timer = setTimeout(() => done(false), Math.max(0, Math.min(ms, LIMITS.waitMs)));
      h.waiters.add(wake);
    });
  }

  // What a device sees: the devices, which one plays and what. The queue
  // only when it's changed since `queueVersion`; commands only for the
  // active device, those after `after`.
  view(h, deviceId, { queueVersion = -1, after = 0 } = {}) {
    const now = this.now();
    const active = h.active ? h.devices.get(h.active) : null;
    return {
      version: h.version,
      now,
      you: deviceId,
      active: active ? { id: active.id, name: active.name } : null,
      devices: [...h.devices.values()].map((d) => ({ id: d.id, name: d.name, active: d.id === h.active, here: now - d.seen <= LIMITS.goneMs })),
      state: h.state ? { ...h.state, position: Math.round(this.position(h, now)), at: now } : null,
      queueVersion: h.queueVersion,
      queue: queueVersion === h.queueVersion ? undefined : h.queue,
      // The last command the playing device carried out, so the one that
      // sent it can tell when that device isn't answering.
      acked: h.acked,
      commands: deviceId === h.active ? h.commands.filter((c) => c.id > after) : [],
    };
  }
}
