// Settings that follow your Plex account: kept by this player's service for
// your account (see server/settings.js), so every browser you sign in on
// has the same ones, the Home screen too. Only those in SYNCED_SETTINGS
// follow it. The rest are each device's own (DEVICE_SETTINGS): Streaming
// quality (a work laptop on a slow connection, say), its connection, its
// name, sharing playback with your devices, playback speed, how far ahead
// it loads, how many played tracks it keeps in memory, and your own AI
// server (its key never leaves the browser). A
// setting new to the app stays each device's own until it's added to
// SYNCED_SETTINGS, here and in server/settings.js.
//
// A change here is sent a moment later, setting by setting, so changes made
// on two devices at once both stay (the last one to each setting wins).
// What changed elsewhere is picked up when the app starts, when it's shown
// again, and every few minutes while it's on screen.
//
// The first time a browser's settings meet the account's, they're put
// together: the account's are taken for those this browser still has as
// they were to start with, and this browser's own choices are kept for the
// account. Not once someone has signed out here (or signed in over someone
// else): what this browser has then may be theirs, and never goes to
// another account. Keeping them can be turned off for the account
// (Settings › Account): then each device has its own again.
import { app, on, saveSettings, DEFAULT_SETTINGS, SYNCED_BEFORE, SYNC_PENDING, SYNC_REV } from './state.js';
import { store } from './plex.js';
import { dropCached, refresh, parseHash } from './router.js';

export const SYNCED_SETTINGS = Object.freeze([
  'gapless',
  'fades',
  'fadeLength',
  'loudness',
  'quietEndings',
  'reportPlays',
  'gridSize',
  'fontSize',
  'ratingSystem',
  'listRatings',
  'lovedPlaylist',
  'codecBadges',
  'searchCodecs',
  'popularTracks',
  'topListSize',
  'previewButtons',
  'searchAllLibraries',
  'playlistsAllLibraries',
  'oneTapPlayback',
  'mediaSession',
  'tabTitle',
  'keyboardShortcuts',
  'tintBackground',
  'backgroundStyle',
  'showCodec',
  'showRating',
  'showVolume',
  'seekbarStyle',
  'sideBySide',
  'showAlbumYear',
  'showFullPlayer',
  'playbackSpeed',
  'sleepTimer',
  'longForm',
  'quickSkip',
  'skipBack',
  'skipForward',
  'home',
]);
export const DEVICE_SETTINGS = Object.freeze(['quality', 'route', 'liveUpdates', 'shareDevices', 'playerName', 'speed', 'ai', 'loadAhead', 'keepPlayed', 'version']);
const SYNCED = new Set(SYNCED_SETTINGS);

const API = 'api/settings';
const SEND_AFTER = 800;
const PULL_EVERY = 5 * 60000;
const PULL_AGAIN = 30000; // at most this often when the app's shown again

export const syncOn = () => !!app.config.settingsSync && !!app.auth?.token && !!app.source?.serverId;

const sync = {
  started: false,
  read: false, // the account's settings read since the app started: nothing's sent before
  rev: 0, // the account's settings as this browser last had them (how many times they'd changed)
  pending: new Set(), // settings changed here, not sent yet
  sending: null, // ...and those on their way (a Set)
  // For each of those: the account's rev as of its change here, and the
  // value last sent for it, if that isn't known to be kept (it may have
  // been). Kept in the browser too (SYNC_PENDING), so a change that couldn't
  // be sent (offline, or the tab closed first) is sent next time, unless the
  // account had it changed since, elsewhere.
  base: new Map(),
  sent: new Map(),
  // Those that may have been overtaken: kept from last time, or their send
  // failed (and not changed here since). See overtaken.
  stale: new Set(),
  sendTimer: null,
  pullTimer: null,
  lastPull: 0,
  pulling: null,
  applying: false,
  failed: false,
  reached: false, // heard from this player since the app started
  off: false, // turned off for the account
};

async function call(method, body, { keepalive = false } = {}) {
  let res;
  try {
    // (For the server the app's on: they're kept for people who can use it.)
    res = await fetch(`${API}?server=${encodeURIComponent(app.source?.serverId || '')}`, {
      method,
      cache: 'no-store',
      credentials: 'omit',
      keepalive,
      headers: { Accept: 'application/json', 'X-Plex-Token': app.auth?.token || '', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
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
  sync.reached = true;
  return data || {};
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function setRev(rev) {
  sync.rev = Number(rev) || 0;
  store.set(SYNC_REV, sync.rev || null);
}

function keepPending() {
  const out = {};
  for (const [k, at] of sync.base) out[k] = sync.sent.has(k) ? { at, sent: sync.sent.get(k) } : { at };
  store.set(SYNC_PENDING, sync.base.size ? out : null);
}

// A setting changed here, to send (as of the account's settings as last
// had here).
function changedHere(k) {
  sync.pending.add(k);
  sync.stale.delete(k);
  sync.base.set(k, Math.max(sync.base.get(k) ?? 0, sync.rev));
}

// ...and no longer (sent and kept, overtaken, or not to be kept).
function settled(keys) {
  for (const k of keys) {
    if (sync.pending.has(k)) continue;
    sync.base.delete(k);
    sync.sent.delete(k);
    sync.stale.delete(k);
  }
  keepPending();
}

// Of the settings kept for the account, those that apply here, each in the
// shape it has here (anything else is left as it is).
function usable(remote) {
  const out = {};
  for (const [k, v] of Object.entries(remote && typeof remote === 'object' ? remote : {})) {
    if (!SYNCED.has(k)) continue;
    const d = DEFAULT_SETTINGS[k];
    const sameShape = typeof d === typeof v && (typeof d !== 'object' || ((d === null) === (v === null) && Array.isArray(d) === Array.isArray(v)));
    if (sameShape) out[k] = v;
  }
  return out;
}

// Settings from the account, here.
function take(patch) {
  if (!Object.keys(patch).length) return;
  sync.applying = true;
  try {
    saveSettings(patch);
  } finally {
    sync.applying = false;
  }
  // Pages kept to go back to read their settings when they were built; Home
  // on screen is built again with its new layout.
  dropCached(() => true);
  if ('home' in patch && parseHash().path === '/') refresh();
}

// What's kept for the account, here: except settings changed here and not
// sent yet, or on their way (this device's change wins).
function apply(remote) {
  const patch = {};
  for (const [k, v] of Object.entries(usable(remote))) {
    if (sync.pending.has(k) || sync.sending?.has(k)) continue;
    if (!same(app.settings[k], v)) patch[k] = v;
  }
  take(patch);
}

// This device's settings that follow the account.
const mine = () => Object.fromEntries([...SYNCED].filter((k) => k in app.settings).map((k) => [k, app.settings[k]]));

// This browser's settings meet the account's for the first time: the
// account's are taken for those still as they were to start with here, and
// this browser's own choices go to the account.
function firstMeeting(got) {
  const theirs = usable(got.settings);
  const patch = {};
  setRev(got.rev);
  // (Changed here and not sent yet: this browser's own, as of now.)
  for (const k of sync.pending) sync.base.set(k, Math.max(sync.base.get(k) ?? 0, sync.rev));
  sync.stale.clear();
  for (const k of SYNCED) {
    if (!(k in app.settings) || sync.pending.has(k)) continue;
    if (same(app.settings[k], DEFAULT_SETTINGS[k])) {
      if (k in theirs && !same(theirs[k], app.settings[k])) patch[k] = theirs[k];
    } else if (!(k in theirs) || !same(theirs[k], app.settings[k])) {
      changedHere(k);
    }
  }
  keepPending();
  store.set(SYNCED_BEFORE, true);
  take(patch);
  if (sync.pending.size) later(0);
}

// Changes that may have been overtaken (kept from last time, or that
// couldn't be sent, and not changed here since): one the account has had
// changed since isn't sent, and takes the account's, unless what changed
// it was this browser's own send that got there after all (then a later
// change here still goes). Whether any gave way. (Not those on their way.)
function overtaken(got) {
  let gave = false;
  const done = [];
  for (const k of [...sync.stale]) {
    if (sync.sending?.has(k)) continue;
    sync.stale.delete(k);
    const at = Number(got.changed?.[k]) || 0;
    if (at <= (sync.base.get(k) ?? 0)) continue;
    if (sync.sent.has(k) && same(got.settings?.[k], sync.sent.get(k))) {
      // Its own: kept. Then changed again here, or not.
      if (same(app.settings[k], sync.sent.get(k))) {
        sync.pending.delete(k);
        done.push(k);
      } else {
        sync.base.set(k, at);
        sync.sent.delete(k);
      }
      continue;
    }
    sync.pending.delete(k);
    done.push(k);
    gave = true;
  }
  settled(done);
  return gave;
}

function failed(err) {
  sync.failed = true;
  // Off on this player (an older one, or SYNC_SETTINGS=false): nothing more
  // is tried. (Anything else, plex.tv not answering, say, is tried again.)
  if (err.status === 404) stop();
  // Turned off for the account elsewhere.
  if (err.status === 409) {
    sync.off = true;
    sync.pending.clear();
    sync.base.clear();
    sync.sent.clear();
    sync.stale.clear();
    keepPending();
  }
}

async function pull() {
  if (!sync.started || !syncOn()) return;
  if (sync.pulling) return sync.pulling;
  sync.lastPull = Date.now();
  sync.pulling = (async () => {
    try {
      const got = await call('GET');
      const first = !sync.read;
      sync.read = true;
      sync.failed = false;
      sync.off = !!got.off;
      if (sync.off) {
        sync.pending.clear();
        sync.base.clear();
        sync.sent.clear();
        sync.stale.clear();
        keepPending();
        setRev(got.rev);
        return;
      }
      if (!store.get(SYNCED_BEFORE)) return firstMeeting(got);
      const gave = overtaken(got);
      // (The first time since the app started, whatever the rev: what's
      // here may have been changed by another tab, say.)
      if (first || gave || got.rev !== sync.rev) {
        apply(got.settings);
        setRev(got.rev);
      }
      if (sync.pending.size) later(0);
    } catch (err) {
      failed(err);
    } finally {
      sync.pulling = null;
    }
  })();
  return sync.pulling;
}

function later(ms = SEND_AFTER) {
  clearTimeout(sync.sendTimer);
  sync.sendTimer = setTimeout(send, ms);
}

// `now`: the page is going (or out of sight): sent at once, and even if it
// closes before the answer comes.
async function send({ now = false } = {}) {
  if (!now) sync.sendTimer = null;
  if (!sync.started || !syncOn() || !sync.pending.size) return;
  // Not before the account's settings have been read here, to be put
  // together with these (that read sends them).
  if (!sync.read) {
    if (!now) pull();
    return;
  }
  if (!now) {
    // (After what's kept for the account has been read, so a first change
    // here can't hide what's there; and one at a time.)
    await sync.pulling;
    if (sync.sending) return later();
  } else if (sync.sending) {
    return; // (what's still to go is kept for next time)
  }
  if (sync.off) {
    const keys = [...sync.pending];
    sync.pending.clear();
    settled(keys);
    return;
  }
  // (Not those that may have been overtaken: a read decides on those
  // first, then sends what's still to go, these too, so it's still one at a
  // time. Going now, they're kept for next time.)
  if (!now && [...sync.pending].some((k) => sync.stale.has(k))) {
    pull();
    return;
  }
  const keys = [...sync.pending].filter((k) => SYNCED.has(k) && !sync.stale.has(k));
  for (const k of keys) sync.pending.delete(k);
  if (!keys.length) return;
  sync.sending = new Set(keys);
  const set = Object.fromEntries(keys.map((k) => [k, app.settings[k]]));
  for (const k of keys) sync.sent.set(k, set[k]);
  keepPending();
  try {
    const got = await call('PUT', { set }, { keepalive: now });
    sync.sending = null;
    sync.failed = false;
    for (const k of keys) {
      sync.sent.delete(k);
      // Changed again here meanwhile: as of this change, not before it.
      if (sync.pending.has(k)) sync.base.set(k, Math.max(sync.base.get(k) ?? 0, Number(got.rev) || 0));
    }
    settled(keys);
    // What's kept for the account now, other devices' changes too.
    apply(got.settings);
    setRev(got.rev || sync.rev);
  } catch (err) {
    sync.sending = null;
    // Sent again with the next change, when the app's shown again or next
    // time: not what this player wouldn't keep.
    if (err.network || err.status === 401 || err.status === 403 || err.status === 429 || err.status >= 500) {
      for (const k of keys) {
        // (Changed here again meanwhile: that's a fresh change.)
        if (!sync.pending.has(k)) sync.stale.add(k);
        sync.pending.add(k);
      }
    } else settled(keys);
    failed(err);
  }
}

// What's kept for the account, now (when the Account page opens, say).
export const pullSettings = () => pull();

function onVisibility() {
  if (document.visibilityState === 'hidden') {
    // Out of sight (another tab or app, or closing): changes go now.
    if (sync.pending.size) send({ now: true });
    return;
  }
  onOnline();
}

// (What's kept for the account first: sending waits for that.)
function onOnline() {
  if (!sync.read || Date.now() - sync.lastPull > PULL_AGAIN) pull();
  if (sync.pending.size) send();
}

const onPageHide = () => sync.pending.size && send({ now: true });

export function startSync() {
  if (sync.started || !syncOn()) return;
  sync.started = true;
  sync.read = false;
  sync.reached = false;
  sync.rev = Number(store.get(SYNC_REV)) || 0;
  // Changes that couldn't be sent last time (see overtaken).
  const kept = store.get(SYNC_PENDING);
  sync.base = new Map();
  sync.sent = new Map();
  for (const [k, v] of Object.entries(kept && typeof kept === 'object' ? kept : {})) {
    const at = Number(v && typeof v === 'object' ? v.at : v);
    if (!SYNCED.has(k) || !Number.isFinite(at)) continue;
    sync.base.set(k, at);
    if (v && typeof v === 'object' && 'sent' in v) sync.sent.set(k, v.sent);
  }
  sync.pending = new Set(sync.base.keys());
  sync.stale = new Set(sync.base.keys());
  pull();
  sync.pullTimer = setInterval(() => document.visibilityState === 'visible' && pull(), PULL_EVERY);
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', onPageHide);
  window.addEventListener('online', onOnline);
}

export function stop() {
  sync.started = false;
  clearTimeout(sync.sendTimer);
  clearInterval(sync.pullTimer);
  sync.sendTimer = null;
  sync.pullTimer = null;
  sync.pending.clear();
  sync.stale.clear();
  document.removeEventListener('visibilitychange', onVisibility);
  window.removeEventListener('pagehide', onPageHide);
  window.removeEventListener('online', onOnline);
}

// Keeping them for the account, turned on (this device's settings are
// kept, for the others to have) or off (none are kept, and each device has
// its own again).
export async function setAccountSync(on) {
  const got = await call('PUT', { off: !on });
  sync.off = !!got.off;
  sync.read = true;
  setRev(got.rev);
  sync.pending.clear();
  sync.base.clear();
  sync.sent.clear();
  sync.stale.clear();
  keepPending();
  if (on) {
    const sent = await call('PUT', { set: mine() });
    setRev(sent.rev || sync.rev);
    store.set(SYNCED_BEFORE, true);
  }
}

// Whether they're kept for the account (null: not known just now, or this
// player doesn't keep them), as last heard.
export async function accountSyncState() {
  if (!syncOn()) return null;
  await (sync.pulling || pull());
  return sync.reached && !sync.failed ? !sync.off : null;
}

on('settings-patch', (patch) => {
  if (sync.applying || !sync.started) return;
  let any = false;
  for (const k of Object.keys(patch)) {
    if (!SYNCED.has(k)) continue;
    changedHere(k);
    any = true;
  }
  if (!any) return;
  keepPending();
  later();
});

on('signing-out', stop);
on('signout', stop);
