// Missing tracks that follow each Plex account (see web/js/missingsync.js):
// for each Plex server, each account's list of what its AI playlists
// suggested, and its imports from Spotify had, that the server's music
// libraries don't, so every browser the account signs in on has the same
// one; and for the server's owner, everyone's, so they can see what's
// missing from their server and go and find it. Changed by the changes
// browsers send, each made once however often it's sent, by the browser's
// own rules (missinglist.js, a copy of web/js/missinglist.js).
//
// Everyone's is kept as they use it (the app tells friends that the
// server's owner sees theirs).
//
// Never what an AI playlist was asked for, or a Spotify playlist's name:
// those stay on the device that asked (a Spotify one's playlists are counted
// by listId, twelve bits of a hash of each name, too few to check a name
// guessed). No sign-ins or names: the owner
// sees whose each is by their own Plex friends, as plex.tv has them, looked
// up as they look (see the route in index.js).
//
// Kept in a file (missing.json in the data folder), written soon after each
// change, readable by the service only.
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { MISSING_LIMITS, MISSING_LISTS, applyOp, applyForget, idOf, shortList, shortLists, sourceOf, trimMissing } from './missinglist.js';

export const MISSING_STORE_LIMITS = {
  accounts: 500, // with a list on this player (on any server)
  servers: 10, // that one account has lists for
  entries: 100000, // on all the lists together
  ops: 50, // changes in one request
  items: 1000, // in one change (what an import of one playlist didn't find)
  entriesPerOp: 500, // put together or back in one change
  keys: 2000, // found, unreal or ids in one change
  // Changes remembered for each list, so one sent again (as a page went, its
  // answer never read) is made once: the latest so many, for so long.
  done: 2000,
  doneMs: 60 * 86400000,
};

// The file's: 2 since 0.25.0 (see load).
const MISSING_FILE_VERSION = 2;

export class MissingError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const SERVER_ID = /^[A-Za-z0-9._-]{1,100}$/;
const SECTION = /^[A-Za-z0-9_.:-]{1,40}$/;
const LIST = /^[a-z0-9]{1,8}$/;
const OP_ID = /^[a-f0-9]{8,32}$/;
const KEY_MAX = 400;
const KINDS = new Set(['track', 'artist']);
const userId = (v) => (Number.isSafeInteger(Number(v)) && Number(v) > 0 ? Number(v) : null);
// Text as it's kept: at most `n` characters, no control characters.
const text = (v, n) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, n) : '');
// A time in seconds: since 2001, and not more than a day ahead.
const when = (v, now) => (Number.isSafeInteger(v) && v > 1e9 && v <= now + 86400 ? v : null);
const counted = (v) => (Number.isSafeInteger(v) && v >= 1 && v <= 1e6 ? v : 1);
const unreadable = () => new MissingError(400, 'Those changes couldn’t be read.');

// An entry as it's kept (see missinglist.js), or null if it can't be one.
export function cleanEntry(raw, now) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !KINDS.has(raw.kind)) return null;
  const artist = text(raw.artist, 120);
  const title = raw.kind === 'track' ? text(raw.title, 160) : '';
  if (!artist && !title) return null;
  const section = typeof raw.section === 'string' || Number.isSafeInteger(raw.section) ? String(raw.section) : '';
  if (!SECTION.test(section)) return null;
  const last = when(raw.last, now);
  if (!last) return null;
  const e = { kind: raw.kind, artist, title };
  if (raw.via === 'spotify') {
    e.via = 'spotify';
    // (A playlist kept before 0.25.0, by the whole hash of its name, is cut
    // down: see listId.)
    e.lists = Array.isArray(raw.lists) ? shortLists(raw.lists.filter((x) => typeof x === 'string' && LIST.test(x))).slice(0, MISSING_LISTS) : [];
  }
  e.times = counted(raw.times);
  e.first = Math.min(when(raw.first, now) || last, last);
  e.last = last;
  e.section = section;
  e.library = text(raw.library, 200);
  if (raw.mb === 'real') e.mb = 'real';
  return e;
}

// Keys or ids, as a change has them: a list of short pieces of text.
function keys(v) {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > MISSING_STORE_LIMITS.keys) return null;
  if (!v.every((k) => typeof k === 'string' && k.length <= KEY_MAX)) return null;
  return [...new Set(v)];
}

// One change as it's made, or null if it can't be read (see
// web/js/missingsync.js for what each is). `everyone` (for the server's
// owner) only takes some off everyone's, or clears it.
export function cleanOp(raw, now) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (typeof raw.id !== 'string' || !OP_ID.test(raw.id)) return null;
  const id = raw.id;
  const everyone = raw.everyone === true;
  if (everyone && raw.type !== 'forget' && raw.type !== 'clear') return null;
  if (raw.type === 'note') {
    const section = typeof raw.section === 'string' ? raw.section : '';
    if (!SECTION.test(section) || !Array.isArray(raw.items) || raw.items.length > MISSING_STORE_LIMITS.items) return null;
    const items = [];
    // (One that isn't a track or an artist is left out, not the change.)
    for (const x of raw.items) {
      if (!x || typeof x !== 'object' || !KINDS.has(x.kind)) continue;
      items.push({ kind: x.kind, artist: text(x.artist, 120), title: x.kind === 'track' ? text(x.title, 160) : '', ...(x.mb === 'real' ? { mb: 'real' } : {}) });
    }
    const found = keys(raw.found);
    const unreal = keys(raw.unreal);
    if (!found || !unreal) return null;
    const via = raw.via === 'spotify' ? 'spotify' : '';
    if (via && !(typeof raw.list === 'string' && LIST.test(raw.list))) return null;
    return { type: 'note', id, items, found, unreal, via, ...(via ? { list: shortList(raw.list) } : {}), section, library: text(raw.library, 200), at: when(raw.at, now) || now };
  }
  if (raw.type === 'merge' || raw.type === 'restore') {
    if (!Array.isArray(raw.entries) || raw.entries.length > MISSING_STORE_LIMITS.entriesPerOp) return null;
    return { type: raw.type, id, entries: raw.entries.map((e) => cleanEntry(e, now)).filter(Boolean) };
  }
  if (raw.type === 'forget') {
    const ids = keys(raw.ids);
    return ids ? { type: 'forget', id, ids, everyone } : null;
  }
  if (raw.type === 'clear') return { type: 'clear', id, everyone };
  if (raw.type === 'mb') {
    const real = keys(raw.real);
    const dropped = keys(raw.dropped);
    return real && dropped ? { type: 'mb', id, real, dropped } : null;
  }
  // (0.24.0's share and unshare, a friend's choice then, aren't changes any
  // more: everyone's is kept.)
  return null;
}

// Entries as they're sent and kept: without the server (it's the list's).
const bare = ({ server, ...e }) => e;
const copy = (m) => ({ ...m, ...(Array.isArray(m.lists) ? { lists: [...m.lists] } : {}) });
const same = (a, b) => a.length === b.length && a.every((m, i) => JSON.stringify(m) === JSON.stringify(b[i]));

export class MissingStore {
  constructor({ dir = null, log = null, writeDelayMs = 1500, now = () => Date.now() } = {}) {
    this.file = dir ? join(dir, 'missing.json') : null;
    this.log = log;
    this.writeDelayMs = writeDelayMs;
    this.now = now;
    // (A fresh start's revs never pass for one from before: a change that
    // didn't get to the file could otherwise have the same.)
    this.epoch = randomBytes(4).toString('hex');
    // server id -> { rev, accounts: Map(user id -> { rev, entries, done: [[op id, ms]] }) }
    this.servers = new Map();
    this.total = 0; // entries on all the lists
    this.timer = null;
    this.load();
  }

  seconds() {
    return Math.floor(this.now() / 1000);
  }

  load() {
    if (!this.file || !existsSync(this.file)) return;
    try {
      const data = JSON.parse(readFileSync(this.file, 'utf8'));
      const now = this.seconds();
      // (Written before 0.25.0: again, soon, as it's kept now, without the
      // whole hash of a Spotify playlist's name, or 0.24.0's `shared`.)
      if ((Number(data?.version) || 1) < MISSING_FILE_VERSION) this.changed();
      for (const [server, s] of Object.entries(data?.servers && typeof data.servers === 'object' ? data.servers : {})) {
        if (!SERVER_ID.test(server) || !s || typeof s !== 'object') continue;
        for (const [key, a] of Object.entries(s.accounts && typeof s.accounts === 'object' ? s.accounts : {})) {
          const uid = userId(key);
          if (!uid || !a || typeof a !== 'object') continue;
          // (One of each, the last: as it would have been kept.)
          const byId = new Map();
          for (const raw of Array.isArray(a.entries) ? a.entries : []) {
            const e = cleanEntry(raw, now);
            if (!e) continue;
            byId.delete(idOf(e));
            byId.set(idOf(e), { ...e, server });
          }
          // (0.24.0's `shared`, a friend's choice then, goes: everyone's is
          // kept.)
          const entries = trimMissing([...byId.values()]);
          if (!entries.length || !this.room(server, uid) || this.total + entries.length > MISSING_STORE_LIMITS.entries) continue;
          const rec = this.record(server, uid, { create: true });
          rec.entries = entries;
          rec.rev = Number.isSafeInteger(a.rev) && a.rev > 0 ? a.rev : 1;
          rec.done = (Array.isArray(a.done) ? a.done : [])
            .filter((x) => Array.isArray(x) && typeof x[0] === 'string' && OP_ID.test(x[0]) && Number.isSafeInteger(x[1]))
            .map(([id, at]) => [id, at]);
          this.prune(rec);
          this.total += entries.length;
        }
        const kept = this.servers.get(server);
        if (kept) kept.rev = Number.isSafeInteger(s.rev) && s.rev > 0 ? s.rev : 1;
      }
    } catch (err) {
      this.log?.warn(`missing tracks: couldn't read ${this.file} (${err.message}); starting without them`);
    }
  }

  // An account's list for a server (made, with `create`).
  record(server, uid, { create = false } = {}) {
    let s = this.servers.get(server);
    if (!s) {
      if (!create) return null;
      s = { rev: 0, accounts: new Map() };
      this.servers.set(server, s);
    }
    let a = s.accounts.get(uid);
    if (!a && create) {
      a = { rev: 0, entries: [], done: [] };
      s.accounts.set(uid, a);
    }
    return a || null;
  }

  // Whether there's room for this account to have a list for this server
  // (it has one, or neither it nor the player has as many as it can).
  room(server, uid) {
    const kept = (a) => a.entries.length > 0;
    const have = this.servers.get(server)?.accounts.get(uid);
    if (have && kept(have)) return true;
    let mine = 0;
    const everyone = new Set();
    for (const [, s] of this.servers) {
      for (const [id, a] of s.accounts) {
        if (!kept(a)) continue;
        everyone.add(id);
        if (id === uid) mine += 1;
      }
    }
    return mine < MISSING_STORE_LIMITS.servers && (everyone.has(uid) || everyone.size < MISSING_STORE_LIMITS.accounts);
  }

  revs(server, uid) {
    const s = this.servers.get(server);
    return { mine: `${this.epoch}.${s?.accounts.get(uid)?.rev || 0}`, all: `${this.epoch}.${s?.rev || 0}` };
  }

  // An account's own list for a server ({ rev, entries, done }), and for its
  // owner everyone else's (`others`: one for each entry, with how many of
  // each kind and whose, by Plex id), left out where `have` ({ mine, all })
  // says they're as they were.
  view(uid, server, { owner = false, have = {} } = {}) {
    const id = userId(uid);
    const rev = this.revs(server, id);
    const a = this.servers.get(server)?.accounts.get(id);
    const out = { rev };
    if (have.mine !== rev.mine) {
      out.entries = (a?.entries || []).map(bare);
      out.done = a ? a.done.map(([op]) => op) : [];
    }
    if (owner && have.all !== rev.all) out.others = this.others(server, id);
    return out;
  }

  // Everyone else's on a server, put together: one for each entry (by its
  // id), with how often AI playlists suggested it (`ai`) and how many Spotify
  // playlists had it (`spotify`; `more`: past what's counted for someone), as
  // the latest has it, and whose (`who`: Plex ids).
  others(server, uid) {
    const s = this.servers.get(server);
    if (!s) return [];
    const rows = new Map();
    for (const [id, a] of s.accounts) {
      if (id === uid) continue;
      for (const e of a.entries) {
        const key = idOf(e);
        let r = rows.get(key);
        if (!r) {
          r = { kind: e.kind, artist: e.artist, title: e.title, section: e.section, library: e.library, ai: 0, spotify: 0, first: e.first, last: e.last, who: [] };
          rows.set(key, r);
        }
        if (sourceOf(e) === 'spotify') {
          r.spotify += e.times || 1;
          if ((e.lists?.length || 0) >= MISSING_LISTS) r.more = true;
        } else r.ai += e.times || 1;
        if (e.last > r.last) Object.assign(r, { last: e.last, artist: e.artist, title: e.title, library: e.library });
        r.first = Math.min(r.first, e.first);
        if (e.mb === 'real') r.mb = 'real';
        if (!r.who.includes(id)) r.who.push(id);
      }
    }
    return [...rows.values()];
  }

  // A list changed: its new entries, counted.
  commit(server, rec, list) {
    if (same(rec.entries, list)) return false;
    this.total += list.length - rec.entries.length;
    rec.entries = list;
    rec.rev += 1;
    this.servers.get(server).rev += 1;
    this.changed();
    return true;
  }

  // The changes remembered (see MISSING_STORE_LIMITS.done).
  prune(rec) {
    const since = this.now() - MISSING_STORE_LIMITS.doneMs;
    rec.done = rec.done.filter(([, at]) => at >= since).slice(-MISSING_STORE_LIMITS.done);
  }

  remember(rec, opId) {
    rec.done.push([opId, this.now()]);
    this.prune(rec);
  }

  // Changes from one account to its list for a server, in order (each made
  // once, however often it's sent), and from the server's owner,
  // `everyone`'s: taking some off everyone's list for it, or clearing it. A
  // change that can't be read, or that isn't theirs to make, is left out
  // (`skipped`), as is one that needs more room than the player has left
  // (`refused`, by id; `full`). Returns the revs from before and after.
  apply(uid, server, ops, { owner = false } = {}) {
    const id = userId(uid);
    if (!id || !SERVER_ID.test(server) || !Array.isArray(ops)) throw unreadable();
    if (ops.length > MISSING_STORE_LIMITS.ops) throw new MissingError(413, 'Too many changes at once.');
    const now = this.seconds();
    const before = this.revs(server, id);
    let skipped = 0;
    const refused = [];
    for (const raw of ops) {
      const op = cleanOp(raw, now);
      if (!op || (op.everyone && !owner)) {
        skipped += 1;
        continue;
      }
      if (this.record(server, id)?.done.some(([d]) => d === op.id)) continue;
      const done = op.everyone ? this.everyone(server, op) : this.own(server, id, op);
      if (done === 'full') {
        refused.push(op.id);
        continue;
      }
      // (Sent again, say as the page went, it's made once: even one that
      // takes some off, which would take off what's been added since.)
      this.remember(this.record(server, id, { create: true }), op.id);
    }
    return { before, rev: this.revs(server, id), skipped, refused, full: refused.length > 0 };
  }

  // A change to the account's own list.
  own(server, uid, op) {
    const adds = (op.type === 'note' && op.items.length) || ((op.type === 'merge' || op.type === 'restore') && op.entries.length);
    let rec = this.record(server, uid);
    if (!rec?.entries.length && !adds) return 'same';
    if (!rec?.entries.length && !this.room(server, uid)) return 'full';
    rec ||= this.record(server, uid, { create: true });
    const list = applyOp(rec.entries.map(copy), op, { server });
    if (list.length > rec.entries.length && this.total + list.length - rec.entries.length > MISSING_STORE_LIMITS.entries) return 'full';
    this.commit(server, rec, list);
    return 'done';
  }

  // The server's owner's change to everyone's list for it: taking some off
  // (taken off, or found in the library now), or clearing it.
  everyone(server, op) {
    const s = this.servers.get(server);
    if (!s) return 'same';
    for (const [, rec] of s.accounts) this.commit(server, rec, op.type === 'clear' ? [] : applyForget(rec.entries, op.ids, { server }));
    return 'done';
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
    const servers = {};
    for (const [server, s] of this.servers) {
      const accounts = {};
      for (const [uid, a] of s.accounts) {
        if (a.entries.length) accounts[uid] = { rev: a.rev, entries: a.entries.map(bare), done: a.done };
      }
      servers[server] = { rev: s.rev, accounts };
    }
    const tmp = `${this.file}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify({ version: MISSING_FILE_VERSION, servers }), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch (err) {
      this.log?.error(`missing tracks: couldn't save them to ${this.file}: ${err.message}`);
    }
  }

  // Anything not written yet, now (when the service stops).
  flush() {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
    this.write();
  }
}

export { MISSING_LIMITS };
