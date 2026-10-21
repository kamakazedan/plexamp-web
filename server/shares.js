// Shared playlists: someone's playlist, shared with Plex friends who can use
// the same Plex server, and kept the same in everyone's copy of it. Plex has
// no shared playlists of its own, so everyone's copy is an ordinary playlist
// in their own Plex account. What's kept here, for each one: the playlist
// as it is now (its title, and its tracks by their ids on the server), who
// it's shared with and whether they can change it, and for each person,
// which playlist is their copy and what it held when it was last brought up
// to date, so the changes made to it since (here or in another app) can be
// told apart from everyone else's. Nobody's Plex sign-in is kept: each
// person's browser brings their own copy up to date, with their own.
//
// Kept in a file (shares.json in the data folder), written soon after each
// change, readable by the service only.
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

export const SHARE_LIMITS = {
  tracks: 5000, // in a shared playlist
  members: 30, // people one is shared with
  perOwner: 50, // playlists one person shares
  total: 2000, // shared playlists on this player
  title: 200,
};

export class ShareError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const ID = /^[a-f0-9]{24}$/;
const TRACK = /^\d{1,12}$/;
const SERVER = /^[A-Za-z0-9._-]{1,100}$/;
const PLAYLIST = /^\d{1,12}$/;
const ROLES = new Set(['view', 'edit']);
// How long one of someone's devices has to bring their copy up to date
// (between sync and synced) before another may.
export const LEASE_MS = 5 * 60 * 1000;
const LEASE = /^[a-f0-9]{24}$/;

// Text as it's kept: one line, at most `n` characters.
const line = (v, n) =>
  String(v ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .trim()
    .slice(0, n);
const userId = (v) => (Number.isSafeInteger(Number(v)) && Number(v) > 0 ? Number(v) : null);
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const unreadable = () => new ShareError(400, 'That request couldn’t be read.');

// A track list from a request: ids only, and not too many.
export function cleanTracks(list) {
  if (!Array.isArray(list)) throw unreadable();
  if (list.length > SHARE_LIMITS.tracks) throw new ShareError(413, `Playlists of more than ${SHARE_LIMITS.tracks.toLocaleString('en')} tracks can’t be shared.`);
  const out = list.map((x) => String(x));
  if (!out.every((id) => TRACK.test(id))) throw unreadable();
  return out;
}

// ---------- merging ----------

const counted = (list) => list.reduce((m, k) => m.set(k, (m.get(k) || 0) + 1), new Map());
const strip = (k) => k.slice(0, k.lastIndexOf('#'));

// The tracks `base` has more of than `mine` (each once, in base's order).
export function missingFrom(base, mine) {
  const have = counted(mine);
  const out = [];
  for (const [id, n] of counted(base)) if (n > (have.get(id) || 0)) out.push(id);
  return out;
}

// `mine`, with the entries of `hidden` tracks it's missing (since `base`)
// put back where they were in `base`: tracks that can't be seen in a copy
// (from a library that isn't shared with them any more, say) aren't tracks
// taken out of it.
export function withUnseen(base, mine, hidden) {
  const want = counted(base);
  const have = counted(mine);
  const missing = new Set();
  for (const id of hidden) {
    const n = want.get(id) || 0;
    for (let i = (have.get(id) || 0) + 1; i <= n; i++) missing.add(`${id}#${i}`);
  }
  if (!missing.size) return mine.slice();
  const out = keyed(mine);
  const inOut = new Set(out);
  let prev = null;
  for (const k of keyed(base)) {
    if (missing.has(k)) {
      out.splice(prev === null ? 0 : out.indexOf(prev) + 1, 0, k);
      inOut.add(k);
      prev = k;
    } else if (inOut.has(k)) prev = k;
  }
  return out.map(strip);
}

// Each track as "id#n" (its nth time in the list): a track that's in a list
// twice is two entries.
function keyed(list) {
  const seen = new Map();
  return list.map((id) => {
    const n = (seen.get(id) || 0) + 1;
    seen.set(id, n);
    return `${id}#${n}`;
  });
}

// Whether `list` has the entries it shares with `base` in another order.
function reordered(base, list) {
  const inBase = new Set(base);
  const inList = new Set(list);
  return !same(
    list.filter((k) => inBase.has(k)),
    base.filter((k) => inList.has(k)),
  );
}

// A three-way merge, for one person's copy of a shared playlist: `base` is
// what their copy held when it was last brought up to date, `mine` what it
// holds now, `theirs` the shared playlist now (with everyone else's changes
// since). Tracks added on either side are in, tracks taken out on either
// side are out. The order is the shared playlist's if it was reordered
// meanwhile, otherwise this copy's; tracks added on the other side go after
// the track they followed there (at the end, if that's where they were).
export function mergeTracks(base, mine, theirs) {
  if (same(mine, base)) return theirs.slice();
  if (same(theirs, base)) return mine.slice();
  const B = keyed(base);
  const L = keyed(mine);
  const R = keyed(theirs);
  const inB = new Set(B);
  const inL = new Set(L);
  const inR = new Set(R);
  const kept = (k) => (inB.has(k) ? inL.has(k) && inR.has(k) : inL.has(k) || inR.has(k));
  const [first, second] = reordered(B, R) || !reordered(B, L) ? [R, L] : [L, R];
  const out = first.filter(kept);
  const placed = new Set(out);
  // Past the last of the other side's entries that are placed already: an
  // addition at its end.
  let end = second.length - 1;
  while (end >= 0 && !placed.has(second[end])) end -= 1;
  second.forEach((k, i) => {
    if (placed.has(k) || !kept(k)) return;
    if (i > end) {
      out.push(k);
    } else {
      let j = i - 1;
      while (j >= 0 && !placed.has(second[j])) j -= 1;
      out.splice(j < 0 ? 0 : out.indexOf(second[j]) + 1, 0, k);
    }
    placed.add(k);
  });
  return out.map(strip);
}

// ---------- what's kept ----------

// A share from the file, checked (the file could have been edited), or null.
function checked(s) {
  try {
    if (!s || !ID.test(s.id) || !SERVER.test(s.server) || !userId(s.owner?.id)) return null;
    const members = (Array.isArray(s.members) ? s.members : [])
      .filter((m) => userId(m?.id) && ROLES.has(m.role) && userId(m.id) !== userId(s.owner.id))
      .slice(0, SHARE_LIMITS.members)
      .map((m) => ({ id: userId(m.id), title: line(m.title, 100) || 'Plex user', role: m.role, joined: m.joined === true, invited: Number(m.invited) || 0 }));
    const copies = {};
    for (const [k, c] of Object.entries(s.copies && typeof s.copies === 'object' ? s.copies : {})) {
      const id = userId(k);
      if (!id || !PLAYLIST.test(String(c?.playlist || '')) || (id !== userId(s.owner.id) && !members.some((m) => m.id === id))) continue;
      copies[id] = { playlist: String(c.playlist), tracks: cleanTracks(c.tracks), title: line(c.title, SHARE_LIMITS.title), version: Number(c.version) || 0, seq: Number(c.seq) || 1 };
    }
    if (!copies[userId(s.owner.id)]) return null;
    return {
      id: s.id,
      server: s.server,
      owner: { id: userId(s.owner.id), title: line(s.owner.title, 100) || 'Plex user' },
      title: line(s.title, SHARE_LIMITS.title) || 'Shared playlist',
      version: Math.max(1, Number(s.version) || 1),
      tracks: cleanTracks(s.tracks),
      members,
      copies,
      created: Number(s.created) || Date.now(),
      updated: Number(s.updated) || Date.now(),
    };
  } catch {
    return null;
  }
}

export class Shares {
  // dir: the folder the file goes in (none: kept in memory only, for tests).
  constructor({ dir = null, log = null, writeDelayMs = 300 } = {}) {
    this.file = dir ? join(dir, 'shares.json') : null;
    this.log = log;
    this.writeDelayMs = writeDelayMs;
    this.list = new Map();
    // `${share id}|${user id}` -> { id, until }: the device bringing that copy
    // up to date (in memory only).
    this.leases = new Map();
    this.timer = null;
    this.load();
  }

  load() {
    if (!this.file || !existsSync(this.file)) return;
    try {
      const data = JSON.parse(readFileSync(this.file, 'utf8'));
      for (const raw of Array.isArray(data?.shares) ? data.shares : []) {
        const s = checked(raw);
        if (s) this.list.set(s.id, s);
      }
    } catch (err) {
      this.log?.warn(`shared playlists: couldn't read ${this.file} (${err.message}); starting without them`);
    }
  }

  // Written soon after a change (a burst of changes, once).
  changed() {
    if (!this.file || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.write();
    }, this.writeDelayMs);
    this.timer.unref?.();
  }

  write() {
    if (!this.file) return;
    const tmp = `${this.file}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify({ version: 1, shares: [...this.list.values()] }), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch (err) {
      this.log?.error(`shared playlists: couldn't save them to ${this.file}: ${err.message}`);
    }
  }

  // Anything not written yet, now (when the service stops).
  flush() {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
    this.write();
  }

  get(id) {
    const s = ID.test(String(id || '')) ? this.list.get(String(id)) : null;
    if (!s) throw new ShareError(404, 'That shared playlist isn’t shared any more.');
    return s;
  }

  // 'owner', 'edit', 'view' or null (not shared with them).
  roleOf(s, uid) {
    if (s.owner.id === uid) return 'owner';
    return s.members.find((m) => m.id === uid)?.role || null;
  }

  // The ones a person shares or has been invited to, on one server.
  forUser(uid, server) {
    return [...this.list.values()].filter((s) => s.server === server && this.roleOf(s, uid));
  }

  // What a person sees of one: its owner sees who it's shared with; the
  // people it's shared with see whose it is.
  view(s, uid) {
    const role = this.roleOf(s, uid);
    const member = s.members.find((m) => m.id === uid);
    const v = {
      id: s.id,
      server: s.server,
      title: s.title,
      owner: { id: s.owner.id, title: s.owner.title },
      role,
      joined: role === 'owner' || !!member?.joined,
      copy: s.copies[uid]?.playlist || null,
      // How many times their copy has been brought up to date (see sync).
      at: s.copies[uid]?.seq ?? null,
      version: s.version,
      count: s.tracks.length,
      updated: s.updated,
    };
    if (role === 'owner') v.members = s.members.map((m) => ({ id: m.id, title: m.title, role: m.role, joined: m.joined }));
    return v;
  }

  // members: [{ id, title, role }], checked by the caller to be the owner's
  // Plex friends.
  create(owner, { server, playlist, title, tracks, members = [] }) {
    if (!SERVER.test(String(server || '')) || !PLAYLIST.test(String(playlist || ''))) throw unreadable();
    const list = cleanTracks(tracks);
    if (!list.length) throw new ShareError(400, 'Add some tracks to the playlist first.');
    const theirs = [...this.list.values()].filter((s) => s.owner.id === owner.id);
    if (theirs.some((s) => s.server === server && s.copies[owner.id]?.playlist === String(playlist))) throw new ShareError(409, 'That playlist is shared already.');
    if (theirs.length >= SHARE_LIMITS.perOwner) throw new ShareError(429, `You can share up to ${SHARE_LIMITS.perOwner} playlists.`);
    if (this.list.size >= SHARE_LIMITS.total) throw new ShareError(507, 'This player can’t keep any more shared playlists.');
    const name = line(title, SHARE_LIMITS.title) || 'Shared playlist';
    let id;
    do id = randomBytes(12).toString('hex');
    while (this.list.has(id));
    const now = Date.now();
    const s = {
      id,
      server,
      owner: { id: owner.id, title: line(owner.title, 100) || 'Plex user' },
      title: name,
      version: 1,
      tracks: list,
      members: [],
      copies: { [owner.id]: { playlist: String(playlist), tracks: list.slice(), title: name, version: 1, seq: 1 } },
      created: now,
      updated: now,
    };
    this.setMembers(s, members);
    this.list.set(id, s);
    this.changed();
    return s;
  }

  // Who it's shared with, as a whole: new people are invited, people left
  // out stop sharing it (keeping their copy, as an ordinary playlist).
  setMembers(s, members = []) {
    if (!Array.isArray(members)) throw unreadable();
    const next = [];
    for (const m of members) {
      const id = userId(m?.id);
      if (!id || id === s.owner.id || next.some((x) => x.id === id)) continue;
      if (!ROLES.has(m.role)) throw unreadable();
      const was = s.members.find((x) => x.id === id);
      next.push({ id, title: line(m.title, 100) || was?.title || 'Plex user', role: m.role, joined: !!was?.joined, invited: was?.invited || Date.now() });
    }
    if (next.length > SHARE_LIMITS.members) throw new ShareError(413, `A playlist can be shared with up to ${SHARE_LIMITS.members} people.`);
    for (const k of Object.keys(s.copies)) {
      if (Number(k) === s.owner.id || next.some((m) => m.id === Number(k))) continue;
      delete s.copies[k];
      this.leases.delete(`${s.id}|${k}`);
    }
    s.members = next;
    s.updated = Date.now();
    this.changed();
  }

  // It stops being shared: everyone keeps their copy.
  remove(s) {
    this.list.delete(s.id);
    for (const k of this.leases.keys()) if (k.startsWith(`${s.id}|`)) this.leases.delete(k);
    this.changed();
  }

  // Someone it's shared with has made their copy (holding `tracks`, the
  // shared playlist at `version`).
  join(s, user, { playlist, tracks, version, title } = {}) {
    const m = s.members.find((x) => x.id === user.id);
    if (!m) throw new ShareError(403, 'That playlist isn’t shared with you.');
    if (!PLAYLIST.test(String(playlist || ''))) throw unreadable();
    m.joined = true;
    m.title = line(user.title, 100) || m.title;
    s.copies[user.id] = { playlist: String(playlist), tracks: cleanTracks(tracks), title: line(title, SHARE_LIMITS.title), version: Number(version) || 0, seq: 1 };
    this.changed();
  }

  // Someone it's shared with turns it down, or stops sharing it (keeping
  // their copy).
  leave(s, uid) {
    s.members = s.members.filter((m) => m.id !== uid);
    delete s.copies[uid];
    this.leases.delete(`${s.id}|${uid}`);
    this.changed();
  }

  // Someone's copy, holding `tracks` (and called `title`) now, against the
  // shared playlist: what it should hold. Changes made to it since it was
  // last brought up to date go into the shared playlist, unless they can
  // only view it: then theirs are undone. Its owner's title is the shared
  // one. Nothing is kept about their copy until they say it's up to date
  // (synced).
  //   since: how many times they last saw their copy brought up to date
  //     (view's `at`). If another of their devices has brought it up to
  //     date since, what they read may be from before that device changed
  //     it, and would look like changes of their own: { stale: true, at }
  //     says to read it again first.
  //   lease: while one of their devices is bringing their copy up to date
  //     (from its sync to its synced, which give back the lease it's
  //     given), another can't: { busy: true }.
  //   unseen: tracks missing from their copy since it was last brought up
  //     to date are only taken for tracks they took out once they've said
  //     which of them they can't see any more (a library that isn't shared
  //     with them now, say): until then, { confirm: [those tracks] }.
  sync(s, user, { tracks, title, since, lease, unseen } = {}) {
    const role = this.roleOf(s, user.id);
    const copy = s.copies[user.id];
    if (!role || !copy) throw new ShareError(409, 'Add the playlist first.');
    const held = this.leaseOf(s, user.id);
    if (held && held.id !== lease) return { busy: true };
    if (since !== undefined && since !== null && Number(since) !== copy.seq) return { stale: true, at: copy.seq };
    let mine = cleanTracks(tracks);
    const hidden = unseen === undefined || unseen === null ? null : cleanTracks(unseen);
    const gone = missingFrom(copy.tracks, mine);
    // Tracks still in their copy, but hidden from them: as if they could see
    // them (`held`: what the copy holds, then), now and when it's said to be
    // up to date (see synced).
    let kept = [];
    if (gone.length) {
      if (!hidden) return { confirm: gone };
      const missing = new Set(gone);
      kept = [...new Set(hidden.filter((id) => missing.has(id)))];
      mine = withUnseen(copy.tracks, mine, kept);
    }
    const changedMine = !same(mine, copy.tracks);
    let undone = false;
    let changed = false;
    if (role === 'view') {
      undone = changedMine && !same(mine, s.tracks);
    } else {
      const merged = mergeTracks(copy.tracks, mine, s.tracks);
      if (merged.length > SHARE_LIMITS.tracks) throw new ShareError(413, `Playlists of more than ${SHARE_LIMITS.tracks.toLocaleString('en')} tracks can’t be shared.`);
      if (!same(merged, s.tracks)) {
        s.tracks = merged;
        changed = true;
      }
    }
    const name = line(title, SHARE_LIMITS.title);
    if (role === 'owner' && name && name !== copy.title && name !== s.title) {
      s.title = name;
      changed = true;
    }
    if (changed) {
      s.version += 1;
      s.updated = Date.now();
      this.changed();
    }
    const out = { version: s.version, tracks: s.tracks, title: s.title, wasTitle: copy.title, changed, undone, lease: this.lease(s, user.id, held, kept) };
    if (kept.length) out.held = mine;
    return out;
  }

  // Their copy holds the shared playlist (as at `version`) now. Resolves to
  // { at }: how many times it's been brought up to date (see sync's since).
  synced(s, user, { version, tracks, title, lease } = {}) {
    const copy = s.copies[user.id];
    if (!copy) throw new ShareError(409, 'Add the playlist first.');
    const held = this.leaseOf(s, user.id);
    if (held && held.id !== lease) throw new ShareError(409, 'Your copy is being brought up to date on another device.');
    const list = cleanTracks(tracks);
    // Hidden tracks their copy still holds (they can't take them out, nor
    // see them to say so) stay in what it holds: taken out by someone else
    // meanwhile, they'd otherwise look like tracks of theirs, added once
    // they can see them again.
    copy.tracks = held?.unseen?.length ? withUnseen(copy.tracks, list, held.unseen) : list;
    copy.title = line(title, SHARE_LIMITS.title);
    copy.version = Number(version) || copy.version;
    copy.seq += 1;
    this.leases.delete(`${s.id}|${user.id}`);
    this.changed();
    return { at: copy.seq };
  }

  // A device bringing someone's copy up to date that's taking a while (a
  // long playlist): its lease, for longer.
  renew(s, user, { lease } = {}) {
    const held = this.leaseOf(s, user.id);
    if (!held || held.id !== lease) throw new ShareError(409, 'Your copy is being brought up to date on another device.');
    held.until = Date.now() + LEASE_MS;
    return { ok: true };
  }

  // The lease on someone's copy, if one of their devices has one now.
  leaseOf(s, uid) {
    const held = this.leases.get(`${s.id}|${uid}`);
    return held && held.until > Date.now() ? held : null;
  }

  // A lease on someone's copy for the device asking (the one it holds, if it
  // holds one, for longer), with the hidden tracks its copy holds.
  lease(s, uid, held, unseen = []) {
    const now = Date.now();
    if (this.leases.size > 1000) for (const [k, l] of this.leases) if (l.until <= now) this.leases.delete(k);
    const id = held && LEASE.test(held.id) ? held.id : randomBytes(12).toString('hex');
    this.leases.set(`${s.id}|${uid}`, { id, until: now + LEASE_MS, unseen });
    return id;
  }
}
