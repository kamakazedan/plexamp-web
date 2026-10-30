// Offline mode (OFFLINE_KEY on the container, with PLEX_SERVER_URL): while
// plex.tv isn't answering the player, nobody can sign in with Plex. Then,
// and only then, this player can be signed in to with its offline key (see
// server/offline.js): its Plex server, as the server lets the player's
// container in without signing in, which is as the server's owner. Signed
// in so, the app asks every so often whether that's still on; once plex.tv
// has been answering again for a while, it isn't, and the app signs out
// (sign in with Plex then). Nothing that needs a Plex account (settings and
// missing tracks that follow it, Play Together, your devices, shared
// playlists, Play on) is used meanwhile: see plexAccount in state.js.
import { app, on, setAuth, setSource, signOut, proxyUri } from './state.js';
import { PlexServer } from './plex.js';
import { debugLog } from './debug.js';

const WATCH_EVERY = 15000;

// Whether the player has a /pms/ proxy, whose service says how plex.tv is
// (and, with OFFLINE_KEY, takes the key).
export const offlineAsked = () => !!app.config.serverProxy;

async function api(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(`api/offline${path}`, {
    method,
    headers: { Accept: 'application/json', ...(token ? { 'X-Plex-Token': token } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'omit',
    cache: 'no-store',
    signal: AbortSignal.timeout(20000),
  });
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* no body */
  }
  if (!res.ok) throw Object.assign(new Error(data.error || `The player answered ${res.status}.`), { status: res.status, reason: data.reason || '' });
  return data;
}

// How plex.tv is, as the player sees it, and whether the key can be used:
// { configured, on, plexTv: 'up' | 'down', why, session }.
export function offlineState(token = null) {
  return api('', { token });
}

// The offline key: signed in with it, on the player's Plex server (its
// first music library: the Home screen's switcher has the others).
export async function signInOffline(key) {
  const { token } = await api('/session', { method: 'POST', body: { key } });
  const uri = proxyUri();
  const ps = new PlexServer({ uri, token });
  let root;
  let sections;
  try {
    root = await ps.get('/', null, { timeout: 8000 });
    sections = await ps.musicSections();
    if (!sections.length) throw new Error('That server has no music libraries.');
  } catch (err) {
    // (Not signed in after all: the session goes, rather than lasting on the
    // player unused.)
    api('/session', { method: 'DELETE', token }).catch(() => {});
    throw err;
  }
  setAuth({ token, username: 'Offline key', thumb: null, manual: true, offline: true });
  setSource({
    serverId: root.machineIdentifier || uri,
    serverName: root.friendlyName || 'Plex',
    uri,
    kind: 'proxy',
    token,
    connections: [],
    sectionKey: String(sections[0].key),
    sectionTitle: sections[0].title,
  });
}

// Signed in with the key: whether that's still on, every so often, and as
// the app's shown again. Once it isn't, signed out, to the sign-in page,
// which says why.
let watching = null;
export function watchOffline() {
  if (watching || !app.auth?.offline) return;
  const token = app.auth.token;
  const check = async () => {
    if (app.auth?.token !== token) return stopWatching();
    let state;
    try {
      state = await offlineState(token);
    } catch (err) {
      debugLog('offline', `couldn't ask the player whether offline mode is still on: ${err.message}`, 'warn');
      return;
    }
    if (state.session !== 'ended' || app.auth?.token !== token) return;
    // (`gone`: plex.tv still isn't answering, so it ended otherwise: the
    // player restarted, or it was 14 days.)
    const why = state.plexTv === 'down' ? 'gone' : 'ended';
    debugLog('offline', why === 'ended' ? 'plex.tv is answering again, so the offline key’s session has ended: signing out' : 'the offline key’s session has ended: signing out');
    stopWatching();
    history.replaceState(null, '', `${location.pathname}${location.search}#/login?offline=${why}`);
    signOut();
  };
  const onShown = () => !document.hidden && check();
  watching = { timer: setInterval(check, WATCH_EVERY), onShown };
  document.addEventListener('visibilitychange', onShown);
  check();
}

function stopWatching() {
  if (!watching) return;
  clearInterval(watching.timer);
  document.removeEventListener('visibilitychange', watching.onShown);
  watching = null;
}

// Signing out of the key's session ends it on the player too.
on('signing-out', () => {
  stopWatching();
  if (!app.auth?.offline) return;
  fetch('api/offline/session', { method: 'DELETE', headers: { 'X-Plex-Token': app.auth.token }, credentials: 'omit', keepalive: true }).catch(() => {});
});
