// Shared playlists: one of your playlists, shared with Plex friends who can
// use the same Plex server, kept the same in everyone's copy (the player's
// service keeps the shared playlist and who it's shared with: see
// server/shares.js). Your copy is an ordinary playlist in your Plex account.
// It's brought up to date when plexamp-web opens, when you open it, after
// you change it here, when Plex says it changed, and every few minutes
// while the app is open; changes made to it in other apps (Plexamp, Plex
// Web) go to everyone then too. Your Plex sign-in is only ever sent to the
// player's own service, which asks plex.tv who you are, and isn't kept.
import { app, on, emit } from './state.js';
import { store } from './plex.js';
import { live } from './live.js';
import { parseHash, refresh, dropCached } from './router.js';
import { toast, icon } from './ui.js';
import { playlistEntries, changePlaylist } from './playlistio.js';

const API = 'api/shares';
// While the app is open: a quick look for others' changes every minute, and
// every few minutes for changes to your copy made in other apps (Plex says
// so at once, when it can).
const EVERY = 60000;
const ALL_EVERY = 5;
const KEY = 'shares'; // what each copy held when last brought up to date, on this device

export const sharingOn = () => !!app.config.sharing && !!app.auth?.token && !!app.source?.serverId;

let list = []; // the shares for the account and server in use (views, see server/shares.js)
let listKey = null;
let listAt = 0;
let loading = null;
let lastAll = 0;
const busy = new Map(); // share id -> its sync under way
const leases = new Map(); // share id -> this tab's turn at bringing your copy up to date (see syncOne)
const quietUntil = new Map(); // copy id -> time: Plex's notices of our own changes

const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const keyNow = () => (sharingOn() ? `${app.source.serverId}|${app.auth.username || ''}` : null);

// `token`: whose request it is (the account signed in now, unless given: a
// sync that started before a sign-out goes on as whoever started it).
async function api(path = '', { method = 'GET', body, signal, token = app.auth?.token } = {}) {
  let res;
  try {
    res = await fetch(`${API}${path}`, {
      method,
      cache: 'no-store',
      credentials: 'omit',
      headers: { Accept: 'application/json', 'X-Plex-Token': token || '', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });
  } catch {
    throw Object.assign(new Error('Can’t reach this player’s server.'), { network: true, aborted: !!signal?.aborted });
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* empty or not JSON */
  }
  if (!res.ok) {
    const fallback = res.status === 404 && !data ? 'Shared playlists aren’t available on this player.' : `Something went wrong (${res.status}).`;
    throw Object.assign(new Error(data?.error || fallback), { status: res.status });
  }
  return data || {};
}

// ---------- what's shared ----------

export const sharesNow = () => (listKey && listKey === keyNow() ? list : []);
// The share a playlist of yours is a copy of (yours, or one you've added).
export const shareOf = (playlistId) => sharesNow().find((s) => s.joined && s.copy === String(playlistId)) || null;
// Playlists shared with you, not added yet.
export const invitations = () => sharesNow().filter((s) => !s.joined);

// `key`: the account and server they're for.
function setList(next, key) {
  list = next;
  listKey = key;
  emit('shares', sharesNow());
  paintMarks();
}

// One left out of the list (which stays the list for the account and server
// it was for).
function drop(id) {
  if (listKey) setList(list.filter((x) => x.id !== id), listKey);
}

// As loadShares, but what was loaded in the last half minute will do.
export function freshShares() {
  if (listKey && listKey === keyNow() && Date.now() - listAt < 30000) return Promise.resolve(list);
  return loadShares();
}

// The same, waited for SHARES_WAIT at most, so a page of playlists isn't
// held back by a service that's slow to answer (it asks plex.tv who's who):
// null if they aren't in by then (they're shown when they are).
const SHARES_WAIT = 3000;
export function sharesSoon() {
  return Promise.race([freshShares().catch(() => []), new Promise((r) => setTimeout(() => r(null), SHARES_WAIT))]);
}

// The shares for this account on this server, from the service. An answer
// that comes once another server (or account) is in use is let go.
export function loadShares() {
  if (!sharingOn()) {
    if (list.length) setList([], null);
    return Promise.resolve([]);
  }
  const key = keyNow();
  if (loading?.key === key) return loading.job;
  const server = app.source.serverId;
  const job = (async () => {
    try {
      const { shares = [] } = await api(`?server=${encodeURIComponent(server)}`);
      if (keyNow() !== key) return sharesNow();
      listAt = Date.now();
      setList(Array.isArray(shares) ? shares.filter((x) => x?.server === server) : [], key);
      return list;
    } finally {
      if (loading?.job === job) loading = null;
    }
  })();
  loading = { key, job };
  return job;
}

// ---------- marks on playlists ----------

// The shared mark on a playlist's picture (cards, its page): shown while it's
// shared (yours) or a copy of one shared with you.
export function sharedMark(playlistId) {
  const el = document.createElement('span');
  el.className = 'shared-mark';
  el.dataset.pl = String(playlistId);
  el.setAttribute('role', 'img');
  el.append(icon('together', 18));
  paintMark(el);
  return el;
}

function paintMark(el) {
  const s = shareOf(el.dataset.pl);
  el.hidden = !s;
  const what = !s ? '' : s.role === 'owner' ? 'Shared by you' : `Shared by ${s.owner.title}`;
  el.setAttribute('aria-label', what);
  el.title = what;
}

function paintMarks() {
  document.querySelectorAll('.shared-mark[data-pl]').forEach(paintMark);
}

// ---------- bringing copies up to date ----------

const remembered = (id) => store.get(KEY, {})?.[id] || null;
function remember(id, value) {
  const all = store.get(KEY, {}) || {};
  if (value) all[id] = value;
  else delete all[id];
  // Only those still shared.
  const ids = new Set(list.map((s) => s.id));
  for (const k of Object.keys(all)) if (!ids.has(k) && k !== id) delete all[k];
  store.set(KEY, all);
}

// Brings your copy of one up to date (and the shared playlist, with your
// changes, if you can change it). Resolves to { changed: your copy changed,
// undone: your own changes were undone (you can only view it), gone: your
// copy had been deleted, so it's stopped being shared with you (or, yours,
// stopped being shared) }. `force`: even if neither seems to have changed.
export function syncShare(share, { force = false } = {}) {
  const under = busy.get(share.id);
  // One at a time; a change made meanwhile gets a go of its own after.
  if (under) return force ? under.catch(() => {}).then(() => syncShare(share, { force })) : under;
  const job = syncOne(share, { force }).finally(() => busy.delete(share.id));
  busy.set(share.id, job);
  return job;
}

async function syncOne(share, { force }) {
  // Its own server's, and only while that's the one in use: a copy isn't
  // looked for on another server (not finding it there would look like it
  // had been deleted).
  if (!sharingOn() || share.server !== app.source.serverId) return { changed: false };
  // All of it on this server, as this account, even if another is in use by
  // the time it's done.
  const s = app.server;
  const key = keyNow();
  const token = app.auth.token;
  const call = (path, opts) => api(path, { ...opts, token });
  let pl = null;
  try {
    pl = await s.playlist(share.copy);
  } catch (err) {
    if (err?.status !== 404) throw err;
  }
  if (!pl) return keyNow() === key ? copyGone(share, token, key) : { changed: false };
  const seen = remembered(share.id);
  if (!force && seen && seen.v === share.version && seen.u === (pl.updatedAt || 0) && seen.n === (pl.leafCount || 0) && seen.t === pl.title) {
    return { changed: false };
  }
  // (A turn this tab was given, kept if it stopped halfway: it can go on.)
  const ask = (tracks, since, unseen) =>
    call(`/${share.id}/sync`, { method: 'POST', body: { tracks, title: pl.title, since: since ?? null, lease: leases.get(share.id) || null, unseen } });
  // Tracks missing from your copy since it was last brought up to date are
  // ones you took out, unless you can't see them any more (from a library
  // that isn't shared with you now, say): those stay for everyone else.
  // The player asks which, when there are any (confirm).
  let unseen = null;
  let since = share.at;
  let mine = await tracksIn(share.copy, s);
  let r = await ask(mine, since, unseen);
  if (r.stale) {
    // Another of your devices brought it up to date meanwhile: what was read
    // may be from before it did, so it's read again.
    pl = (await s.playlist(share.copy)) || pl;
    mine = await tracksIn(share.copy, s);
    since = r.at;
    r = await ask(mine, since, unseen);
  }
  if (r.confirm) {
    unseen = await unseenOf(r.confirm.map(String), s);
    r = await ask(mine, since, unseen);
  }
  // Another of your devices is bringing it up to date right now: next time.
  if (r.stale || r.busy || r.confirm) return { changed: false, busy: true };
  if (r.lease) leases.set(share.id, r.lease);
  // (Never taken as empty: that would empty your copy.)
  if (!Array.isArray(r.tracks)) throw new Error('The player’s answer couldn’t be read.');
  const want = r.tracks.map(String);
  quietUntil.set(String(share.copy), Date.now() + 8000);
  // A long one: this tab keeps its turn for as long as it takes.
  const renew = setInterval(() => {
    call(`/${share.id}/lease`, { method: 'POST', body: { lease: leases.get(share.id) || null } }).catch(() => {});
    quietUntil.set(String(share.copy), Date.now() + 8000);
  }, 60000);
  let changed = false;
  let base = want;
  let title = pl.title;
  let done;
  try {
    // Only the difference between what was read and what's wanted is made,
    // on this playlist's own server: anything else that changed in it
    // meanwhile stays, and goes in next time. What Plex leaves out (tracks
    // you can't have) isn't taken for tracks you took out.
    // (`held`: your copy, with the tracks in it you can't see, which stay.)
    const from = Array.isArray(r.held) ? r.held.map(String) : mine;
    if (!same(from, want)) ({ changed, base } = await changePlaylist(share.copy, from, want, { server: s }));
    // Renamed by whoever shared it: yours too, unless you've named it yourself.
    if (share.role !== 'owner' && r.title && r.title !== pl.title && pl.title === r.wasTitle) {
      await s.editPlaylist(share.copy, { title: r.title });
      title = r.title;
      changed = true;
    }
    done = await call(`/${share.id}/synced`, { method: 'POST', body: { version: r.version, tracks: base, title, lease: leases.get(share.id) || null } });
  } finally {
    clearInterval(renew);
  }
  leases.delete(share.id);
  quietUntil.set(String(share.copy), Date.now() + 4000);
  const now = changed ? await s.playlist(share.copy).catch(() => null) : pl;
  // Signed out (or on another server) meanwhile: nothing's kept, or shown.
  if (keyNow() !== key) return { changed: false };
  remember(share.id, { v: r.version, u: now?.updatedAt || 0, n: now?.leafCount || 0, t: now?.title || title });
  Object.assign(share, { version: r.version, at: done?.at ?? null, title: r.title || share.title, count: want.length });
  if (changed) shownChanged(share.copy);
  return { changed, undone: !!r.undone };
}

// Which of these tracks this account can't see (on `server`): Plex gives
// only those it can. Refused (403, 404) for some of them, they're asked
// about in halves, down to one at a time.
async function unseenOf(ids, server) {
  const seen = new Set();
  const look = async (part) => {
    try {
      for (const m of await server.metadataMany(part)) seen.add(String(m.ratingKey));
    } catch (err) {
      if (err?.status !== 404 && err?.status !== 403) throw err;
      if (part.length > 1) {
        const half = Math.ceil(part.length / 2);
        await look(part.slice(0, half));
        await look(part.slice(half));
      }
    }
  };
  for (let i = 0; i < ids.length; i += 40) await look(ids.slice(i, i + 40));
  return ids.filter((id) => !seen.has(id));
}

// The tracks in a playlist (ids, in order), on `server`.
async function tracksIn(id, server = app.server) {
  return (await playlistEntries(id, { limit: 100000, server })).items.map((m) => String(m.ratingKey));
}

// Your copy was deleted (here or in another app): one shared with you
// stops being shared with you; yours stops being shared (everyone else
// keeps theirs).
async function copyGone(share, token, key) {
  await api(share.role === 'owner' ? `/${share.id}` : `/${share.id}/leave`, { method: share.role === 'owner' ? 'DELETE' : 'POST', token }).catch(() => {});
  if (keyNow() !== key) return { changed: false };
  remember(share.id, null);
  drop(share.id);
  return { gone: true };
}

// The pages showing it load it again: the one open now, unless it's being
// changed there, or tracks or albums are being chosen on it (selection.js:
// it's loaded again next time).
function shownChanged(copyId) {
  app.server?.forgetPlaylists();
  const page = (p) => p === '/' || p === '/playlists' || p === `/playlist/${copyId}`;
  dropCached(page);
  if (page(parseHash().path) && !document.querySelector('.view.is-editing, .view.is-sorting, .sheet.open') && !document.body.classList.contains('selecting')) refresh();
}

function tell(share, r) {
  if (r.undone) {
    toast(`Your changes to “${share.title}” were undone: ${share.owner.title} shared it with you to view, not edit.`, { timeout: 7000 });
  } else if (r.changed) {
    toast(share.role === 'owner' ? `“${share.title}” has changes from the people you share it with` : `“${share.title}” has changes (shared by ${share.owner.title})`);
  }
}

// Every copy of yours, brought up to date (one at a time). `remoteOnly`:
// only those someone else has changed since (a quick look, often).
export async function syncAll({ remoteOnly = false } = {}) {
  if (!sharingOn()) return;
  if (!remoteOnly) lastAll = Date.now();
  const key = keyNow();
  let shares;
  try {
    shares = await loadShares();
  } catch {
    return; // the service can't be reached: next time
  }
  for (const share of shares.filter((x) => x.joined && x.copy)) {
    // Another server (or account) in use now: these aren't its.
    if (keyNow() !== key) return;
    if (isBeingEdited(share.copy)) continue;
    if (remoteOnly && remembered(share.id)?.v === share.version) continue;
    try {
      const r = await syncShare(share);
      if (keyNow() === key) tell(share, r);
    } catch {
      /* next time */
    }
  }
}

const isBeingEdited = (copyId) => parseHash().path === `/playlist/${copyId}` && !!document.querySelector('.view.is-editing, .view.is-sorting');

// After a change made here to a playlist of yours: if it's shared, everyone
// gets it.
const pending = new Map();
export function sharedPlaylistChanged(playlistId) {
  changedSoon(String(playlistId), 0);
}

function changedSoon(id, tries) {
  if (!shareOf(id)) return;
  clearTimeout(pending.get(id));
  pending.set(
    id,
    setTimeout(
      async () => {
        pending.delete(id);
        const share = shareOf(id);
        if (!share) return;
        try {
          const r = await syncShare(share, { force: true });
          if (r.undone) tell(share, r);
          // Another of your devices is bringing it up to date: once it has.
          else if (r.busy && tries < 10) changedSoon(id, tries + 1);
        } catch {
          /* next time */
        }
      },
      tries ? 15000 : 1500,
    ),
  );
}

// ---------- sharing ----------

export function friends() {
  return api(`/friends?server=${encodeURIComponent(app.source.serverId)}`).then((d) => d.friends || []);
}

// Shares a playlist of yours, on `server` (the one in use when it was
// chosen): members [{ id, role: 'view' | 'edit' }].
export async function sharePlaylist(pl, members, { server = app.source?.serverId } = {}) {
  const key = keyNow();
  const changed = () => new Error('Another Plex server is in use now: share it from there.');
  if (!key) throw new Error('Shared playlists aren’t available here.');
  if (server !== app.source.serverId) throw changed();
  const tracks = await tracksIn(pl.ratingKey, app.server);
  if (keyNow() !== key) throw changed();
  const view = await api('', {
    method: 'POST',
    body: { server, playlist: String(pl.ratingKey), title: pl.title, tracks, members },
  });
  await loadShares().catch(() => {
    if (keyNow() === key) setList([...sharesNow().filter((x) => x.id !== view.id), view], key);
  });
  return view;
}

export async function setMembers(share, members) {
  const view = await api(`/${share.id}/members`, { method: 'PUT', body: { members } });
  await loadShares().catch(() => {});
  return view;
}

export async function stopSharing(share) {
  await api(`/${share.id}`, { method: 'DELETE' });
  remember(share.id, null);
  drop(share.id);
}

// One shared with you: added to your playlists (a copy, made now), or not.
export async function addShared(share) {
  if (share.server !== app.source?.serverId) throw new Error('That playlist is on another Plex server.');
  const s = app.server;
  const token = app.auth.token;
  const one = await api(`/${share.id}`, { token });
  const tracks = (one.tracks || []).map(String);
  if (!tracks.length) throw new Error('There’s nothing in it yet. Try again once there is.');
  const pl = await s.createPlaylist(one.title, tracks);
  if (!pl) throw new Error('Plex didn’t make the playlist.');
  // What it holds: Plex leaves out tracks you can't have (see syncOne). Not
  // known, it isn't guessed (those would look like tracks you took out).
  let held;
  try {
    held = await tracksIn(pl.ratingKey, s).catch(() => tracksIn(pl.ratingKey, s));
  } catch {
    await s.deletePlaylist(pl.ratingKey).catch(() => {});
    throw new Error('Plex didn’t say what went into your copy, so it wasn’t added. Try again.');
  }
  await api(`/${share.id}/join`, { method: 'POST', token, body: { playlist: String(pl.ratingKey), version: one.version, tracks: held, title: one.title } });
  quietUntil.set(String(pl.ratingKey), Date.now() + 8000);
  await loadShares().catch(() => {});
  return pl;
}

export async function declineShared(share) {
  await api(`/${share.id}/decline`, { method: 'POST' });
  drop(share.id);
}

// Stops one shared with you being shared with you: your copy stays, as an
// ordinary playlist.
export async function leaveShared(share) {
  await api(`/${share.id}/leave`, { method: 'POST' });
  remember(share.id, null);
  drop(share.id);
}

// ---------- when ----------

let timer = null;
let soon = null;

function start() {
  clearTimeout(soon);
  clearInterval(timer);
  timer = null;
  if (!sharingOn()) {
    if (list.length) setList([], null);
    return;
  }
  // A moment after the app opens (its first page comes first).
  soon = setTimeout(syncAll, 2500);
  let ticks = 0;
  timer = setInterval(() => {
    if (document.hidden) return;
    ticks += 1;
    syncAll({ remoteOnly: ticks % ALL_EVERY !== 0 });
  }, EVERY);
}

export function initSharing() {
  start();
  on('source', start);
  on('signout', () => {
    clearTimeout(soon);
    clearInterval(timer);
    timer = null;
    setList([], null);
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && sharingOn() && Date.now() - lastAll > 60000) syncAll();
  });
  // Plex says a playlist changed (here or in another app): if it's a shared
  // one of yours, everyone gets it (not for our own changes, just made).
  live.addEventListener('playlists', (e) => {
    for (const id of (e.detail?.ids || []).map(String)) {
      if ((quietUntil.get(id) || 0) > Date.now()) continue;
      sharedPlaylistChanged(id);
    }
  });
}

