// Missing tracks that follow your Plex account: this player's service keeps
// each Plex server's list for your account (see server/missing.js), so
// every browser you sign in on with this player has the same one; and for
// the server's owner, everyone's, so they can see what's missing from their
// server and go and find it (friends are told so where theirs are listed).
//
// What an AI playlist was asked for, and a Spotify playlist's name, are never
// sent: they stay on the device that asked (and are shown there while it's
// the one that noted it last).
//
// A change (see missing.js) is made to the list here at once, and sent a
// moment later: as the change, not the list, so changes made on two devices
// at once all count. Until the player has it (offline, or the tab closed
// first), it's kept in the browser, each under a name of its own (so no tab
// writes over another's), and it's made once however often it's sent. What
// changed elsewhere is picked up when the app starts, when it's shown again,
// every few minutes while it's on screen, and when Missing tracks is opened.
//
// The first time a browser's list for a server meets the account's, the two
// are put together. Not once someone else may have been signed in here
// (signed in over someone): what this browser has then may be theirs, and
// never goes to another account. Signing out clears it here, as before; the
// account's stays with the player. Everyone else's, for the server's owner,
// is only ever in memory.
import { app, on, emit, MISSING_OVER } from './state.js';
import { store } from './plex.js';
import { applyOp, idOf, listId, shortList, shortLists, sourceOf } from './missinglist.js';

const LIST = 'aiMissing'; // the list here, every server's
// Each change still to go: aiMissingOp.<when><n><tab>, in the order they
// were made, as { account, server, op, prompt }.
const OP = 'aiMissingOp.';
const SYNCED = 'aiMissingSynced'; // whose the list here is, and each server's as last had: { account, servers: { id: rev } }

const API = 'api/missing';
const SEND_AFTER = 800;
const PULL_EVERY = 5 * 60000;
const PULL_AGAIN = 30000; // at most this often when the app's shown again
const QUEUE_MAX = 500; // changes still to go (more: see compact)
const QUEUE_BYTES = 1024 * 1024;
const BATCH_OPS = 40;
const BATCH_BYTES = 300 * 1024; // (the player takes up to 512 KB)
const KEEPALIVE_BYTES = 60 * 1024; // what a page that's going can still send
const MERGE_CHUNK = 200; // entries in one change (the player takes up to 500)
// Sizes in bytes, as nginx and the service count them (names in other
// scripts are 2 or 3 bytes a character).
const bytes = (v) => new TextEncoder().encode(JSON.stringify(v)).length;

const valid = (m) => !!m && (m.kind === 'track' || m.kind === 'artist') && typeof m.artist === 'string';

// A Spotify one's playlists, as they're counted now: one counted before
// 0.25.0, by the whole hash of its name, is cut down (see listId).
const longLists = (m) => Array.isArray(m?.lists) && m.lists.some((x) => shortList(x) !== x);
const shortened = (m) => (longLists(m) ? { ...m, lists: shortLists(m.lists) } : m);

// The list here. (0.12.0 kept what MusicBrainz didn't know, and albums,
// hidden: they go.)
export function loadMissing() {
  const list = store.get(LIST, []);
  return Array.isArray(list) ? list.filter((m) => valid(m) && m.mb !== 'unknown' && m.mb !== 'album').map(shortened) : [];
}

// Whether it was kept (the browser may be out of room).
export function saveMissing(list) {
  const kept = store.set(LIST, list);
  emit('missing');
  return kept;
}

{
  const kept = store.get(LIST, []);
  if (Array.isArray(kept) && kept.some((m) => m?.mb === 'unknown' || m?.mb === 'album' || longLists(m))) store.set(LIST, loadMissing());
}

const ms = {
  started: false,
  read: new Set(), // servers whose list for the account has been read since the app started: nothing's sent before
  account: null, // the account's Plex id, as the player said
  owner: new Map(), // server id -> whether the player says this account owns it
  others: new Map(), // server id -> { all, rows }: everyone else's, for the server's owner
  pulling: null,
  pullAgain: false, // a read that came back while a change was on its way: read again after it
  sending: null,
  sendTimer: null,
  pullTimer: null,
  lastPull: 0,
  reached: false, // heard from this player since the app started
  failed: false,
  full: new Set(), // servers the player had no room for, for this account: this device's own for now
  refused: new Set(), // servers it won't keep them for, for this account (one it can't use, say)
  off: false, // this player doesn't keep them
};

const serverNow = () => app.source?.serverId || '';

// The player keeps lists for accounts, and could for this one on the server
// in use (`room`: and has room for it, as far as it's said).
const keeps = () => !!app.config.missingSync && !!app.auth?.token && !!serverNow() && !ms.off && !ms.refused.has(serverNow());
export const missingSyncOn = () => keeps() && !ms.full.has(serverNow());

function synced() {
  const s = store.get(SYNCED, null);
  return { account: Number(s?.account) || null, servers: s?.servers && typeof s.servers === 'object' ? { ...s.servers } : {} };
}

const keepSynced = (s) => store.set(SYNCED, s);

// Whether this account's list for `server` follows it: everyone's for the
// server in use does, where the player keeps them (and has room).
export const syncs = (server = serverNow()) => missingSyncOn() && server === serverNow();

// 12 random hex characters: a change, by name.
export const randomId = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, '0')).join('');

// ---------- changes still to go ----------

let made = 0;
const tab = randomId().slice(0, 4);

// In the order they were made: `server`'s, or every server's.
function queued(server) {
  const out = [];
  let names = [];
  try {
    names = Object.keys(localStorage);
  } catch {
    return out;
  }
  for (const name of names) {
    if (!name.startsWith(`pw.${OP}`)) continue;
    const key = name.slice(3);
    const x = store.get(key);
    if (!x || typeof x.server !== 'string' || !x.op || typeof x.op.id !== 'string') {
      store.set(key, null);
      continue;
    }
    if (!server || x.server === server) out.push({ ...x, key });
  }
  return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

const enqueue = (item) => store.set(`${OP}${Date.now().toString(36).padStart(9, '0')}${String(made++ % 1e6).padStart(6, '0')}${tab}`, item);
const dequeue = (items) => items.forEach((x) => store.set(x.key, null));
// (What a change added is on the list here too: see compact.)
const adds = (x) => x.op.type === 'note' || x.op.type === 'merge' || x.op.type === 'restore';

// Kept on this device only (this player doesn't keep them, as is): the next
// time they follow the account, this browser's list is put together with
// the account's rather than taken for it.
function onThisDeviceOnly() {
  store.set(SYNCED, null);
  dequeue(queued());
}
if (!app.config.missingSync) onThisDeviceOnly();

// A change made here (missing.js has made it to the list already), to send
// for `server`'s list. `prompt`: what it was for, kept here only. Kept too:
// what's taken off a list the player had no room for (it goes with the list
// next time).
export function queueMissing(server, op, { prompt } = {}) {
  const takenOff = keeps() && server === serverNow() && ms.full.has(server) && !adds({ op });
  if (!syncs(server) && !takenOff) return;
  enqueue({ account: ms.account, server, op: { ...op, id: randomId() }, ...(prompt != null ? { prompt: String(prompt).slice(0, 200) } : {}) });
  // (Many changes still to go, a big import offline say: as few as can be,
  // and at most so many, the oldest going.)
  const q = queued(server);
  if (q.length > QUEUE_MAX || bytes(q) > QUEUE_BYTES) compact(server);
  const left = queued(server);
  if (left.length > QUEUE_MAX) dequeue(left.slice(0, left.length - QUEUE_MAX));
  later();
}

// A server's changes still to go, as few as can be: what was taken off (or
// cleared, or what MusicBrainz said) as it was, then what was added as the
// list here has it now (put together with the account's: see applyMerge),
// which has it all. For a browser's list meeting the account's the first
// time, and a queue grown long.
function compact(server) {
  const here = loadMissing()
    .filter((m) => m.server === server)
    .map(withLists);
  dequeue(queued(server).filter(adds));
  for (let i = 0; i < here.length; i += MERGE_CHUNK) enqueue({ account: ms.account, server, op: { type: 'merge', id: randomId(), entries: here.slice(i, i + MERGE_CHUNK) } });
}

// A change as it's sent: what's this device's own stays here.
const bare = ({ prompt, server, ...e }) => e;
const forSending = (op) => (op.type === 'merge' || op.type === 'restore' ? { ...op, entries: op.entries.map(bare) } : op);
// (A Spotify one kept before 0.22.0: the playlist it was last in.)
const withLists = (m) => (m.via === 'spotify' && !Array.isArray(m.lists) ? { ...m, lists: [listId(m.prompt)] } : m);

// ---------- with the player ----------

async function call(method, { query = {}, body, keepalive = false } = {}) {
  const params = new URLSearchParams({ server: serverNow(), ...query });
  let res;
  try {
    res = await fetch(`${API}?${params}`, {
      method,
      cache: 'no-store',
      credentials: 'omit',
      keepalive,
      headers: { Accept: 'application/json', 'X-Plex-Token': app.auth?.token || '', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw Object.assign(new Error('Can’t reach this player’s server.'), { network: true });
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* empty or not JSON */
  }
  if (!res.ok) throw Object.assign(new Error(data?.error || `Something went wrong (${res.status}).`), { status: res.status });
  ms.reached = true;
  return data || {};
}

// This server's list, this device's own for now: `full` (the player has no
// room for it, for this account), `refused` (it won't keep it for this
// account, on a server it can't use, say). What was added here stays, to be
// put together with the account's next time; what was taken off still goes
// then, while there's room (not on a server it won't keep them for).
function deviceOnly(server, why) {
  ms[why].add(server);
  const s = synced();
  delete s.servers[server];
  keepSynced(s);
  dequeue(queued(server).filter((x) => why === 'refused' || adds(x)));
  emit('missing');
}

function failed(err, server = serverNow()) {
  ms.failed = true;
  // Off on this player (an older one, or SYNC_MISSING_TRACKS=false): each
  // device keeps its own, as before. (Anything else but these is tried
  // again.)
  if (err.status === 404) {
    ms.off = true;
    stop();
    onThisDeviceOnly();
  } else if (err.status === 401 || err.status === 403) deviceOnly(server, 'refused');
}

// The account's list for a server, here: the player's, with this device's
// changes it doesn't have yet made to it again (`ops`), and what each was
// for where this device noted it last.
function rebuild(server, entries, ops) {
  const before = loadMissing();
  const prev = new Map(before.filter((m) => m.server === server).map((m) => [idOf(m), m]));
  let list = entries.filter(valid).map((e) => {
    const m = { ...e, server };
    const p = prev.get(idOf(m));
    if (p?.prompt != null && p.last === m.last && sourceOf(p) === sourceOf(m)) m.prompt = p.prompt;
    return m;
  });
  for (const x of ops) list = applyOp(list, x.op, { server, prompt: x.prompt });
  saveMissing([...before.filter((m) => m.server !== server), ...list]);
}

// What the player said of `server`'s list.
function take(server, got) {
  // (Whose the server is, not said: nothing's taken from this read.)
  if (typeof got.owner !== 'boolean') return;
  const account = Number(got.account) || null;
  let s = synced();
  // Whose is the list here? This account's, unless it was someone else's
  // (or may have been: someone signed in over someone).
  if ((s.account && s.account !== account) || (!s.account && store.get(MISSING_OVER))) {
    saveMissing([]);
    dequeue(queued());
    s = { account, servers: {} };
  }
  // (Changes made as someone else: never sent as this account.)
  dequeue(queued().filter((x) => x.account && x.account !== account));
  s.account = account;
  ms.account = account;
  store.set(MISSING_OVER, null);
  ms.owner.set(server, got.owner);
  if (got.owner === false) ms.others.delete(server);
  if (got.owner === true && Array.isArray(got.others)) {
    ms.others.set(server, { all: got.rev?.all || '', rows: got.others.filter(valid).map((r) => ({ ...r, server })) });
  }
  ms.read.add(server);
  if (!syncs(server)) {
    // (No room on the player for it meanwhile: this device's own for now,
    // as deviceOnly left it.)
    keepSynced(s);
    emit('missing');
    return;
  }
  // (Those it has already: off the queue.)
  if (Array.isArray(got.done)) {
    const done = new Set(got.done);
    dequeue(queued(server).filter((x) => done.has(x.op.id)));
  }
  // The first time this browser's list for this server meets the account's:
  // they're put together (see compact).
  if (!(server in s.servers)) {
    compact(server);
    s.servers[server] = '';
  }
  if (Array.isArray(got.entries)) {
    rebuild(server, got.entries, queued(server));
    s.servers[server] = got.rev?.mine || '';
  }
  keepSynced(s);
  emit('missing');
  if (queued(server).length) later(0);
}

async function pull({ force = false } = {}) {
  if (!ms.started || !missingSyncOn()) return;
  if (ms.pulling) return ms.pulling;
  const server = serverNow();
  ms.lastPull = Date.now();
  ms.pulling = (async () => {
    try {
      const s = synced();
      const query = {};
      // (As last had here: only what's changed since comes.)
      if (!force && s.account && s.servers[server] && ms.read.has(server)) query.mine = s.servers[server];
      const o = ms.others.get(server);
      if (!force && o?.all) query.all = o.all;
      const got = await call('GET', { query });
      // (Another server meanwhile: it has a read of its own.)
      if (serverNow() !== server || !ms.started) return;
      ms.failed = false;
      // A change on its way meanwhile: what this says may be from before it
      // or after, so it's read again once that's there.
      if (ms.sending) {
        ms.pullAgain = true;
        return;
      }
      take(server, got);
    } catch (err) {
      failed(err, server);
    } finally {
      ms.pulling = null;
    }
  })();
  return ms.pulling;
}

function later(delay = SEND_AFTER) {
  clearTimeout(ms.sendTimer);
  ms.sendTimer = setTimeout(send, delay);
}

// `now`: the page is going (or out of sight): sent at once, and even if it
// closes before the answer comes (what's too big for that goes next time).
async function send({ now = false } = {}) {
  if (!now) ms.sendTimer = null;
  if (!ms.started || !missingSyncOn()) return;
  const server = serverNow();
  if (!syncs(server)) return;
  // Not before the account's list has been read here: it says whose this
  // browser's list is, whether it follows the account, and which of these
  // the player has already.
  if (!ms.read.has(server)) {
    if (!now) pull();
    return;
  }
  if (ms.sending) {
    if (!now) later();
    return;
  }
  const batch = [];
  let total = 0;
  for (const x of queued(server)) {
    if (x.account && x.account !== ms.account) continue;
    const size = bytes(forSending(x.op));
    if (batch.length && (batch.length >= BATCH_OPS || total + size > (now ? KEEPALIVE_BYTES : BATCH_BYTES))) break;
    if (now && size > KEEPALIVE_BYTES) break;
    batch.push(x);
    total += size;
  }
  if (!batch.length) return;
  const have = synced().servers[server];
  const theirs = ms.others.get(server);
  ms.sending = (async () => {
    let stale = false;
    try {
      const got = await call('POST', { body: { ops: batch.map((x) => forSending(x.op)) }, keepalive: now });
      ms.failed = false;
      dequeue(batch);
      if (got.refused?.length) {
        // No room on the player for this server's list, for this account:
        // it's this device's own for now (nothing of it goes), and put
        // together with the account's next time.
        deviceOnly(server, 'full');
      } else {
        // The list here is the account's as the player has it now, unless
        // something else changed it meanwhile, or a change wasn't kept: then
        // it's read again.
        const s = synced();
        if (!got.skipped && have && got.before?.mine === have && got.rev?.mine) s.servers[server] = got.rev.mine;
        else stale = true;
        keepSynced(s);
        if (theirs && ms.others.get(server) === theirs) {
          if (!got.skipped && got.before?.all && got.before.all === theirs.all && got.rev?.all) theirs.all = got.rev.all;
          else stale = true;
        }
      }
    } catch (err) {
      failed(err, server);
      // What the player can never take (a change it can't read) isn't sent
      // again; the rest is, later.
      if (err.status === 400 || err.status === 413) {
        dequeue(batch);
        stale = true;
      }
    } finally {
      ms.sending = null;
    }
    if (!ms.started) return;
    // (A read that came back meanwhile, of this server or one switched to:
    // again.)
    if (ms.pullAgain) {
      ms.pullAgain = false;
      pull({ force: true });
      return;
    }
    if (!syncs(server)) return;
    if (stale && !now) pull({ force: true });
    else if (!now && !ms.failed && queued(server).length) later(0);
  })();
  return ms.sending;
}

// ---------- for missing.js and Missing tracks ----------

// Everyone else's on `server`, for its owner (none for anyone else, or until
// the player has said).
export const missingOthers = (server) => ms.others.get(server)?.rows || [];

// ...changed here as this device's change to everyone's is (it's sent as
// that change).
export function editMissingOthers(server, fn) {
  const o = ms.others.get(server);
  if (!o) return;
  o.rows = fn(o.rows);
  emit('missing');
}

// Whether the player says this account owns `server` (undefined: not known).
export const ownsServer = (server) => ms.owner.get(server);

// Whether the player had no room for this account's list for the server in
// use, so it's this device's own for now.
export const missingPlayerFull = (server = serverNow()) => ms.full.has(server);

// What's kept for the account, now (when Missing tracks opens, say).
export const pullMissing = (opts) => pull(opts);

function onVisibility() {
  if (document.visibilityState === 'hidden') {
    // Out of sight (another tab or app, or closing): changes go now.
    send({ now: true });
    return;
  }
  onOnline();
}

function onOnline() {
  if (!ms.read.has(serverNow()) || Date.now() - ms.lastPull > PULL_AGAIN) pull();
  else send();
}

const onPageHide = () => send({ now: true });

export function startMissingSync() {
  if (ms.started || !missingSyncOn()) return;
  ms.started = true;
  ms.reached = false;
  pull();
  ms.pullTimer = setInterval(() => document.visibilityState === 'visible' && pull(), PULL_EVERY);
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', onPageHide);
  window.addEventListener('online', onOnline);
}

export function stop() {
  ms.started = false;
  clearTimeout(ms.sendTimer);
  clearInterval(ms.pullTimer);
  ms.sendTimer = null;
  ms.pullTimer = null;
  ms.read.clear();
  document.removeEventListener('visibilitychange', onVisibility);
  window.removeEventListener('pagehide', onPageHide);
  window.removeEventListener('online', onOnline);
}

// Another server: its list for the account, read.
on('source', ({ serverChanged } = {}) => {
  if (!ms.started) return;
  if (serverChanged) pull();
});
// Signing out: what's still to go, first (as the page goes).
on('signing-out', () => {
  send({ now: true });
  stop();
});
on('signout', () => {
  stop();
  ms.account = null;
  ms.owner.clear();
  ms.others.clear();
  ms.full.clear();
  ms.refused.clear();
});
