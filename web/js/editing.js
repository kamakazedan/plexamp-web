// Adding music to playlists and collections, and who may change
// collections. Playlists belong to whoever is signed in; collections are
// part of the library, so only the server's admin (its owner) can change
// them.
import { app, on, playlistScope } from './state.js';
import { normTrack, listServers } from './plex.js';
import { navigate, dropCached, describeError } from './router.js';
import { sheet, toast, askText, fmt } from './ui.js';
import { shareOf, sharedPlaylistChanged } from './sharing.js';

// ---------- who's the admin ----------

let admin = { key: null, value: null };
on('source', () => (admin = { key: null, value: null }));
on('signout', () => (admin = { key: null, value: null }));

// Signed in with Plex: plex.tv says whether this account owns the server.
// Otherwise (a server address and token), whether the server lets this
// token see its settings, which only its admin can.
export async function isAdmin() {
  const s = app.server;
  if (!s || !app.source) return false;
  const key = `${app.source.serverId || app.source.uri}|${s.token}`;
  if (admin.key === key && admin.value !== null) return admin.value;
  if (admin.key === key && admin.pending) return admin.pending;
  admin.key = key;
  admin.pending = (async () => {
    let value = null;
    if (app.auth?.token && !app.auth.manual) {
      try {
        const id = await s.machineId();
        const mine = (await listServers(app.auth.token)).find((x) => x.id === id);
        if (mine) value = mine.owned;
      } catch {
        /* plex.tv unreachable: ask the server */
      }
    }
    if (value === null) {
      try {
        await s.get('/:/prefs');
        value = true;
      } catch {
        value = false;
      }
    }
    if (admin.key === key) admin = { key, value, pending: null };
    return value;
  })();
  return admin.pending;
}

// The answer if it's known already (menus are built without waiting), and
// a lookup started for next time.
export function isAdminNow() {
  const s = app.server;
  const key = s && app.source ? `${app.source.serverId || app.source.uri}|${s.token}` : null;
  if (admin.key === key && admin.value !== null) return admin.value;
  isAdmin().catch(() => {});
  return false;
}

// ---------- what an item holds ----------

const TRACK_LIMIT = 5000;

// Tracks of a list of items, in order: tracks as they are, albums and
// artists by their tracks, playlists by their entries. At most `limit`.
export async function tracksOf(items, { limit = TRACK_LIMIT } = {}) {
  const s = app.server;
  const out = [];
  for (const m of items) {
    if (out.length >= limit) break;
    const type = m.type || 'track';
    if (type === 'track') out.push(m.partKey !== undefined ? m : normTrack(m));
    else if (type === 'album') out.push(...(await s.children(m.ratingKey)).filter((x) => x.type === 'track').map(normTrack));
    else if (type === 'artist') out.push(...(await s.allLeaves(m.ratingKey)).filter((x) => x.type === 'track').map(normTrack));
    else if (type === 'playlist') {
      for (let start = 0; out.length < limit; start += 500) {
        const { items: page, total } = await s.playlistItems(m.ratingKey, { start, size: 500 });
        out.push(...page.filter((x) => x.type === 'track').map(normTrack));
        if (!page.length || start + page.length >= total) break;
      }
    } else if (type === 'collection') {
      const { items: kids } = await s.collection(m.ratingKey);
      out.push(...(await tracksOf(kids, { limit: limit - out.length })));
    }
  }
  return out.slice(0, limit);
}

const ids = (list) => [...new Set(list.map((t) => String(t.id || t.ratingKey)).filter((x) => /^\d+$/.test(x)))];
const countOf = (n, one = 'track', many = 'tracks') => fmt.count(n, one, many);

// Pages showing playlists or collections load fresh next time.
export function refreshLists(kind) {
  if (kind === 'playlist') dropCached((p) => p === '/' || p === '/playlists' || p.startsWith('/playlist/'));
  else dropCached((p) => p === '/' || p === '/search' || p.startsWith('/collection/') || p.startsWith('/browse/collections'));
}

// ---------- playlists ----------

// Add music to one of your playlists, or a new one. `what` is a short
// description for the sheet ("3 tracks", an album's name); `load` gives the
// tracks (it can be slow, so it runs after a playlist is picked). `extra`:
// more choices, shown after New playlist (Add to a collection, say).
export async function addToPlaylist({ what, load, suggest = '', title = 'Add to playlist', extra = [] }) {
  const s = app.server;
  let lists = [];
  try {
    // Not smart ones (their rules decide what's in them), nor ones shared
    // with you to view only (what's added would be undone).
    lists = (await s.playlists(playlistScope())).filter((p) => !p.smart && (p.playlistType || 'audio') === 'audio' && shareOf(p.ratingKey)?.role !== 'view');
  } catch (err) {
    toast(describeError(err));
    return;
  }
  lists.sort((a, b) => (b.lastViewedAt || b.updatedAt || 0) - (a.lastViewedAt || a.updatedAt || 0));
  sheet({
    title,
    subtitle: what,
    actions: [
      { icon: 'plus', label: 'New playlist…', onSelect: () => newPlaylist({ load, suggest }) },
      ...extra,
      ...lists.map((p) => ({
        icon: 'list',
        label: p.title,
        description: countOf(p.leafCount || 0),
        onSelect: () => addTo(p, load),
      })),
    ],
  });
}

// Track ids already in a playlist (null for very long ones: not checked).
async function inPlaylist(pl) {
  if ((pl.leafCount || 0) > TRACK_LIMIT) return null;
  const found = new Set();
  for (let start = 0; start < TRACK_LIMIT; start += 500) {
    const { items, total } = await app.server.playlistItems(pl.ratingKey, { start, size: 500 });
    items.forEach((m) => found.add(String(m.ratingKey)));
    if (!items.length || start + items.length >= total) break;
  }
  return found;
}

// Tracks already in the playlist aren't added again.
async function addTo(pl, load) {
  try {
    const tracks = await load();
    if (!tracks.length) return toast('There’s nothing to add.');
    const have = await inPlaylist(pl);
    const fresh = have ? tracks.filter((t) => !have.has(String(t.id))) : tracks;
    if (!fresh.length) return toast(tracks.length === 1 ? `“${tracks[0].title}” is already in “${pl.title}”` : `They’re all in “${pl.title}” already`);
    await app.server.addToPlaylist(pl.ratingKey, ids(fresh));
    refreshLists('playlist');
    sharedPlaylistChanged(pl.ratingKey);
    const skipped = tracks.length - fresh.length;
    const added = fresh.length === 1 ? `“${fresh[0].title}”` : countOf(fresh.length);
    toast(`Added ${added} to “${pl.title}”${skipped ? ` (${fmt.count(skipped, 'was', 'were')} there already)` : ''}`, {
      action: 'Open',
      onAction: () => navigate(`/playlist/${pl.ratingKey}`),
    });
  } catch (err) {
    toast(err?.status === 401 || err?.status === 403 ? 'You can’t change that playlist.' : describeError(err));
  }
}

async function newPlaylist({ load, suggest }) {
  const title = await askText({ title: 'New playlist', label: 'Name', value: suggest, confirm: 'Create' });
  if (!title) return;
  try {
    const tracks = await load();
    if (!tracks.length) return toast('There’s nothing to add.');
    const pl = await app.server.createPlaylist(title, ids(tracks));
    refreshLists('playlist');
    toast(`Made “${title}”`, pl ? { action: 'Open', onAction: () => navigate(`/playlist/${pl.ratingKey}`) } : {});
  } catch (err) {
    toast(describeError(err));
  }
}

// ---------- collections (admin only) ----------

export const COLLECTION_TYPE = { artist: 8, album: 9, track: 10 };
const UNITS = { artist: ['artist', 'artists'], album: ['album', 'albums'], track: ['track', 'tracks'] };

// Add items of one kind (artists, albums or tracks) to a collection of that
// kind, or a new one. `load` gives the items.
export async function addToCollection({ kind, what, load, suggest = '' }) {
  if (!(await isAdmin())) return toast('Only the server’s admin can change collections.');
  const s = app.server;
  const sec = app.source.sectionKey;
  let list = [];
  try {
    list = (await s.collections(sec)).filter((c) => (c.subtype || 'album') === kind && !c.smart);
  } catch (err) {
    toast(describeError(err));
    return;
  }
  list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  sheet({
    title: `Add to ${kind} collection`,
    subtitle: what,
    actions: [
      { icon: 'plus', label: 'New collection…', onSelect: () => newCollection({ kind, load, suggest }) },
      ...list.map((c) => ({
        icon: 'collection',
        label: c.title,
        description: fmt.count(c.childCount || 0, ...UNITS[kind]),
        onSelect: () => collect(c, kind, load),
      })),
    ],
  });
}

async function collect(c, kind, load) {
  try {
    const items = await load();
    if (!items.length) return toast('There’s nothing to add.');
    await app.server.addToCollection(c.ratingKey, ids(items));
    refreshLists('collection');
    toast(`Added ${items.length === 1 ? `“${items[0].title}”` : fmt.count(items.length, ...UNITS[kind])} to “${c.title}”`, {
      action: 'Open',
      onAction: () => navigate(`/collection/${c.ratingKey}`),
    });
  } catch (err) {
    toast(err?.status === 401 || err?.status === 403 ? 'Only the server’s admin can change collections.' : describeError(err));
  }
}

async function newCollection({ kind, load, suggest }) {
  const title = await askText({ title: `New ${kind} collection`, label: 'Name', value: suggest, confirm: 'Create' });
  if (!title) return;
  try {
    const items = await load();
    if (!items.length) return toast('There’s nothing to add.');
    const c = await app.server.createCollection(app.source.sectionKey, COLLECTION_TYPE[kind], title, ids(items));
    refreshLists('collection');
    toast(`Made “${title}”`, c ? { action: 'Open', onAction: () => navigate(`/collection/${c.ratingKey}`) } : {});
  } catch (err) {
    toast(err?.status === 401 || err?.status === 403 ? 'Only the server’s admin can change collections.' : describeError(err));
  }
}
