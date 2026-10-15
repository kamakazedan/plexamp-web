// Play Together: shared listening sessions.
//
// The service keeps the one true state of each session (queue, which track,
// playing or paused, and where in the track at a given moment). Members send
// commands and wait for changes with long-polling, which is plain HTTP and
// works through proxies that block WebSockets. Positions are worked out from
// the clock, so tracks advance on time even if nobody is sending anything.
import { randomBytes } from 'node:crypto';

export const LIMITS = {
  sessions: 100,
  members: 12,
  invites: 25,
  queue: 1000,
  addAtOnce: 500,
  events: 25,
  idleMs: 30 * 60000, // no member seen for this long: the session ends
  maxAgeMs: 24 * 3600000,
  hereMs: 45000, // seen this recently counts as "here"
  waitMs: 25000,
};

export class TogetherError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const ID = /^\d{1,12}$/;
const SERVER_ID = /^[A-Za-z0-9._:-]{1,100}$/;
const str = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max);
const int = (v, max) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= 0 && n <= max ? n : 0;
};

// Plex's own shapes for a track's file and artwork. Anything else from a
// member is dropped, so nobody can point everyone's player at another
// address or a different part of the server.
export const PART_KEY = /^\/library\/parts\/\d{1,12}(\/\d{1,14})?\/file\.[A-Za-z0-9]{1,8}$/;
export const THUMB = /^\/library\/metadata\/\d{1,12}\/(thumb|art)(\/\d{1,14})?$/;

// Only fields the app needs, each checked, so one member can't send others
// something unexpected (an outside image URL, a path to another endpoint).
export function cleanTrack(t) {
  if (!t || typeof t !== 'object' || !ID.test(String(t.id))) return null;
  const partKey = PART_KEY.test(String(t.partKey || '')) ? String(t.partKey) : null;
  const thumb = THUMB.test(String(t.thumb || '')) ? String(t.thumb) : null;
  return {
    id: String(t.id),
    title: str(t.title, 300) || 'Untitled',
    artist: str(t.artist, 300),
    albumArtist: str(t.albumArtist, 300),
    album: str(t.album, 300),
    artistId: ID.test(String(t.artistId)) ? String(t.artistId) : null,
    albumId: ID.test(String(t.albumId)) ? String(t.albumId) : null,
    thumb,
    duration: int(t.duration, 24 * 3600000),
    year: int(t.year, 3000) || null,
    codec: /^[a-z0-9]{1,12}$/i.test(String(t.codec || '')) ? String(t.codec).toLowerCase() : '',
    bitrate: int(t.bitrate, 100000) || null,
    partKey,
  };
}

export function cleanServer(s) {
  if (!s || !SERVER_ID.test(String(s.id || '')) || !ID.test(String(s.section || ''))) return null;
  return { id: String(s.id), name: str(s.name, 100) || 'Plex', section: String(s.section), sectionTitle: str(s.sectionTitle, 100) || 'Music' };
}

const person = (u) => ({ id: u.id, title: u.title, thumb: u.thumb || null });

export class Together {
  constructor({ now = () => Date.now(), onChange = () => {} } = {}) {
    this.now = now;
    this.onChange = onChange;
    this.sessions = new Map();
  }

  // ---------- lookups ----------

  get(id) {
    const s = typeof id === 'string' ? this.sessions.get(id) : null;
    if (!s) throw new TogetherError(404, 'This session has ended.');
    return s;
  }

  roleOf(s, userId) {
    if (s.host.id === userId) return 'host';
    if (s.members.has(userId)) return 'member';
    if (s.invited.has(userId)) return 'invited';
    return null;
  }

  // Sessions a user hosts, has joined, or is invited to.
  forUser(userId) {
    const out = [];
    for (const s of this.sessions.values()) {
      const role = s.ended ? null : this.roleOf(s, userId);
      if (role) out.push(this.summary(s, role));
    }
    return out;
  }

  // Everyone listens in one session at a time: joining or starting one
  // leaves any other.
  leaveOthers(user, keep) {
    for (const s of this.sessions.values()) {
      if (s !== keep && !s.ended && s.members.has(user.id)) this.leave(s, user);
    }
  }

  // ---------- lifecycle ----------

  create(host, { server, invite = [], queue = [], index = 0, position = 0, playing = false }) {
    const srv = cleanServer(server);
    if (!srv) throw new TogetherError(400, 'Choose a music library first.');
    this.leaveOthers(host, null);
    if (this.sessions.size >= LIMITS.sessions) throw new TogetherError(429, 'This player has too many sessions running. Try again later.');
    const now = this.now();
    const items = this.items(queue, host).slice(0, LIMITS.queue);
    const s = {
      id: randomBytes(12).toString('base64url'),
      createdAt: now,
      host: person(host),
      server: srv,
      members: new Map([[host.id, { ...person(host), host: true, seen: now }]]),
      invited: new Map(),
      queue: items,
      index: items.length ? Math.min(int(index, items.length - 1), items.length - 1) : 0,
      playing: !!playing && items.length > 0,
      position: Math.min(int(position, 24 * 3600000), items[Math.min(int(index, items.length), items.length - 1)]?.duration || Infinity),
      at: now,
      version: 1,
      events: [],
      ended: null,
      timer: null,
      waiters: new Set(),
    };
    this.invite(s, host, invite);
    this.event(s, `${host.title} started the session.`);
    this.sessions.set(s.id, s);
    this.schedule(s);
    return s;
  }

  invite(s, by, people) {
    if (s.host.id !== by.id) throw new TogetherError(403, 'Only the person who started the session can invite people.');
    for (const p of people || []) {
      if (!p || !Number.isFinite(Number(p.id)) || Number(p.id) === s.host.id) continue;
      if (s.members.has(Number(p.id))) continue;
      if (s.invited.size >= LIMITS.invites) throw new TogetherError(400, `You can invite up to ${LIMITS.invites} people.`);
      s.invited.set(Number(p.id), { id: Number(p.id), title: str(p.title, 80) || 'Plex user', thumb: p.thumb || null });
    }
    this.bump(s);
  }

  join(s, user) {
    if (s.ended) throw new TogetherError(410, s.ended);
    const role = this.roleOf(s, user.id);
    if (!role) throw new TogetherError(403, 'You haven’t been invited to this session.');
    if (role === 'invited') {
      if (s.members.size >= LIMITS.members) throw new TogetherError(400, 'This session is full.');
      this.leaveOthers(user, s);
      s.invited.delete(user.id);
      s.members.set(user.id, { ...person(user), host: false, seen: this.now() });
      this.event(s, `${user.title} joined.`);
      this.bump(s);
    } else {
      this.seen(s, user.id);
    }
    return s;
  }

  // Leaving (or declining an invitation). When the host leaves, the person
  // who has been in the session longest takes over; the last one out ends it.
  leave(s, user) {
    if (s.ended) return s;
    const wasInvited = s.invited.delete(user.id);
    if (!s.members.has(user.id)) {
      if (wasInvited) {
        this.event(s, `${user.title} said no thanks.`);
        this.bump(s);
      }
      return s;
    }
    s.members.delete(user.id);
    if (!s.members.size) return this.end(s, 'Everyone left, so the session ended.');
    if (s.host.id === user.id) {
      const next = s.members.values().next().value;
      next.host = true;
      s.host = person(next);
      this.event(s, `${user.title} left. ${next.title} is the host now.`);
    } else {
      this.event(s, `${user.title} left.`);
    }
    this.bump(s);
    return s;
  }

  // The host can take back an invitation or ask someone to leave.
  remove(s, by, userId) {
    if (s.host.id !== by.id) throw new TogetherError(403, 'Only the host can remove people.');
    if (userId === by.id) throw new TogetherError(400, 'Leave the session instead.');
    const invited = s.invited.get(userId);
    const member = s.members.get(userId);
    if (!invited && !member) return s;
    s.invited.delete(userId);
    s.members.delete(userId);
    this.event(s, member ? `${by.title} removed ${member.title}.` : `${by.title} withdrew the invitation for ${invited.title}.`);
    this.bump(s);
    return s;
  }

  end(s, why) {
    if (s.ended) return s;
    s.ended = why || 'The session ended.';
    s.playing = false;
    clearTimeout(s.timer);
    this.bump(s);
    // Members polling right now get the final state; then it's forgotten.
    setTimeout(() => this.sessions.get(s.id) === s && this.sessions.delete(s.id), 60000).unref?.();
    return s;
  }

  // Drop sessions nobody has looked at for a while.
  sweep() {
    const now = this.now();
    for (const s of this.sessions.values()) {
      const lastSeen = Math.max(...[...s.members.values()].map((m) => m.seen));
      if (s.ended) continue;
      if (now - lastSeen > LIMITS.idleMs) this.end(s, 'The session ended because nobody was listening.');
      else if (now - s.createdAt > LIMITS.maxAgeMs) this.end(s, 'The session ended after 24 hours.');
    }
  }

  seen(s, userId) {
    const m = s.members.get(userId);
    if (m) m.seen = this.now();
  }

  // ---------- playback state ----------

  position(s, now = this.now()) {
    const dur = s.queue[s.index]?.duration || 0;
    const p = s.playing ? s.position + (now - s.at) : s.position;
    return dur ? Math.min(p, dur) : p;
  }

  // Move past tracks that have finished, carrying over the time since.
  settle(s, now = this.now()) {
    if (s.ended || !s.playing) return false;
    let changed = false;
    for (let guard = 0; guard < LIMITS.queue + 1; guard++) {
      const item = s.queue[s.index];
      if (!item) {
        s.playing = false;
        changed = true;
        break;
      }
      if (!item.duration) break;
      const p = s.position + (now - s.at);
      if (p < item.duration) break;
      if (s.index + 1 < s.queue.length) {
        s.index += 1;
        s.position = p - item.duration;
        s.at = now;
      } else {
        s.playing = false;
        s.position = item.duration;
        s.at = now;
      }
      changed = true;
    }
    return changed;
  }

  schedule(s) {
    clearTimeout(s.timer);
    if (s.ended || !s.playing) return;
    const item = s.queue[s.index];
    if (!item?.duration) return;
    const wait = Math.max(0, item.duration - this.position(s)) + 30;
    s.timer = setTimeout(() => {
      if (this.settle(s)) this.bump(s);
      else this.schedule(s);
    }, wait);
    s.timer.unref?.();
  }

  // ---------- commands ----------

  items(tracks, by) {
    const list = Array.isArray(tracks) ? tracks.slice(0, LIMITS.addAtOnce) : [];
    return list.map(cleanTrack).filter(Boolean).map((t) => ({ ...t, sid: randomBytes(6).toString('base64url'), addedBy: person(by) }));
  }

  command(s, user, cmd) {
    if (s.ended) throw new TogetherError(410, s.ended);
    if (!s.members.has(user.id)) throw new TogetherError(403, 'Join the session first.');
    const now = this.now();
    this.settle(s, now);
    this.seen(s, user.id);
    const type = String(cmd?.type || '');
    const cur = s.queue[s.index];
    const at = (sid) => s.queue.findIndex((q) => q.sid === sid);
    const pos = (v) => Math.max(0, Math.min(Number(v) || 0, cur?.duration || 24 * 3600000));
    const who = user.title;
    const name = (t) => `“${t.title}”`;

    switch (type) {
      case 'play':
        if (!cur) throw new TogetherError(400, 'There’s nothing in the queue.');
        if (!s.playing) {
          s.position = cmd.position == null ? this.position(s, now) : pos(cmd.position);
          s.playing = true;
          s.at = now;
          this.event(s, `${who} pressed play.`);
        }
        break;
      case 'pause':
        if (s.playing) {
          s.position = cmd.position == null ? this.position(s, now) : pos(cmd.position);
          s.playing = false;
          s.at = now;
          this.event(s, `${who} paused.`);
        }
        break;
      case 'seek':
        if (!cur) break;
        s.position = pos(cmd.position);
        s.at = now;
        this.event(s, `${who} skipped to ${Math.floor(s.position / 60000)}:${String(Math.floor((s.position % 60000) / 1000)).padStart(2, '0')}.`);
        break;
      case 'next':
        if (s.index + 1 < s.queue.length) {
          s.index += 1;
          s.position = 0;
          s.at = now;
          this.event(s, `${who} skipped to ${name(s.queue[s.index])}.`);
        } else if (cur) {
          s.playing = false;
          s.position = cur.duration || 0;
          s.at = now;
          this.event(s, `${who} skipped the last track.`);
        }
        break;
      case 'prev':
        if (this.position(s, now) > 3000 || s.index === 0) s.position = 0;
        else {
          s.index -= 1;
          s.position = 0;
          this.event(s, `${who} went back to ${name(s.queue[s.index])}.`);
        }
        s.at = now;
        break;
      case 'ended': {
        // A member's player reached the end; trust it if the clock agrees.
        if (!cur || cur.sid !== cmd.sid) break;
        const left = (cur.duration || 0) - this.position(s, now);
        if (cur.duration && left > 3000) break;
        if (s.index + 1 < s.queue.length) {
          s.index += 1;
          s.position = 0;
        } else {
          s.playing = false;
          s.position = cur.duration || 0;
        }
        s.at = now;
        break;
      }
      case 'jump': {
        const i = at(cmd.sid);
        if (i < 0) throw new TogetherError(404, 'That track isn’t in the queue any more.');
        s.index = i;
        s.position = 0;
        s.playing = true;
        s.at = now;
        this.event(s, `${who} played ${name(s.queue[i])}.`);
        break;
      }
      case 'add':
      case 'playNow': {
        const items = this.items(cmd.tracks, user);
        if (!items.length) throw new TogetherError(400, 'Nothing to add.');
        if (s.queue.length + items.length > LIMITS.queue) throw new TogetherError(400, `The queue can hold up to ${LIMITS.queue} tracks.`);
        const where = type === 'playNow' || cmd.where === 'next' ? (cur ? s.index + 1 : 0) : s.queue.length;
        s.queue.splice(where, 0, ...items);
        if (!cur) {
          s.index = 0;
          s.position = 0;
          s.at = now;
        }
        if (type === 'playNow') {
          s.index = where + Math.min(int(cmd.start, items.length - 1), items.length - 1);
          s.position = 0;
          s.playing = true;
          s.at = now;
          this.event(s, `${who} played ${items.length === 1 ? name(items[0]) : `${items.length} tracks`}.`);
        } else {
          this.event(s, `${who} added ${items.length === 1 ? name(items[0]) : `${items.length} tracks`}${cmd.where === 'next' ? ' to play next' : ''}.`);
        }
        break;
      }
      case 'remove': {
        const i = at(cmd.sid);
        if (i < 0) break;
        if (i === s.index) throw new TogetherError(400, 'Skip the track that’s playing instead of removing it.');
        const [gone] = s.queue.splice(i, 1);
        if (i < s.index) s.index -= 1;
        this.event(s, `${who} removed ${name(gone)}.`);
        break;
      }
      case 'move': {
        const i = at(cmd.sid);
        const to = Math.round(Number(cmd.to));
        if (i <= s.index || !(to > s.index && to < s.queue.length)) throw new TogetherError(400, 'Only upcoming tracks can be moved.');
        const [item] = s.queue.splice(i, 1);
        s.queue.splice(to, 0, item);
        break;
      }
      case 'clear':
        if (s.queue.length > s.index + 1) {
          s.queue.splice(s.index + 1);
          this.event(s, `${who} cleared Up next.`);
        }
        break;
      case 'shuffle': {
        const rest = s.queue.splice(s.index + 1);
        for (let i = rest.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [rest[i], rest[j]] = [rest[j], rest[i]];
        }
        s.queue.push(...rest);
        if (rest.length > 1) this.event(s, `${who} shuffled Up next.`);
        break;
      }
      default:
        throw new TogetherError(400, 'Unknown command.');
    }
    if (!s.queue[s.index]) s.playing = false;
    this.bump(s);
    return s;
  }

  // ---------- change notification ----------

  event(s, text) {
    s.events.push({ at: this.now(), text: str(text, 200) });
    if (s.events.length > LIMITS.events) s.events.splice(0, s.events.length - LIMITS.events);
  }

  bump(s) {
    s.version += 1;
    this.schedule(s);
    for (const w of s.waiters) w();
    s.waiters.clear();
    this.onChange(s);
  }

  // Resolves when the session changes after `since`, or after `ms`.
  wait(s, since, ms) {
    if (s.version > since || s.ended) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = (changed) => {
        clearTimeout(timer);
        s.waiters.delete(wake);
        resolve(changed);
      };
      const wake = () => done(true);
      const timer = setTimeout(() => done(false), Math.max(0, Math.min(ms, LIMITS.waitMs)));
      s.waiters.add(wake);
    });
  }

  // ---------- what each person sees ----------

  summary(s, role) {
    const cur = s.queue[s.index];
    return {
      id: s.id,
      role,
      host: s.host,
      server: s.server,
      ended: s.ended,
      members: [...s.members.values()].map((m) => ({ id: m.id, title: m.title, thumb: m.thumb })),
      nowPlaying: cur ? { title: cur.title, artist: cur.artist, thumb: cur.thumb } : null,
      playing: s.playing,
    };
  }

  view(s, userId) {
    const role = this.roleOf(s, userId);
    if (!role) throw new TogetherError(403, 'You haven’t been invited to this session.');
    const now = this.now();
    if (role === 'invited') return { ...this.summary(s, role), version: s.version, now };
    this.settle(s, now) && this.bump(s);
    return {
      id: s.id,
      version: s.version,
      now,
      role,
      you: userId,
      host: s.host,
      server: s.server,
      ended: s.ended,
      members: [...s.members.values()].map((m) => ({ id: m.id, title: m.title, thumb: m.thumb, host: m.host, here: now - m.seen < LIMITS.hereMs })),
      invited: [...s.invited.values()],
      queue: s.queue,
      index: s.index,
      playing: s.playing,
      position: Math.round(this.position(s, now)),
      at: now,
      events: s.events.slice(-12),
    };
  }
}
