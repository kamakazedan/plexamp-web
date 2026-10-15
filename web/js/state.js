// Shared app state, settings and a tiny event bus.
import { store, PlexServer } from './plex.js';

const bus = new EventTarget();

export function emit(name, detail) {
  bus.dispatchEvent(new CustomEvent(name, { detail }));
}

export function on(name, fn) {
  const handler = (e) => fn(e.detail);
  bus.addEventListener(name, handler);
  return () => bus.removeEventListener(name, handler);
}

const DEFAULT_SETTINGS = {
  quality: 'original', // 'original' or a transcode bitrate in kbps, e.g. '320'
  gapless: true,
  reportPlays: true,
  tintBackground: true,
};

export const app = {
  config: window.PW_CONFIG || {},
  auth: store.get('auth'), // { token, username, thumb, manual }
  source: store.get('source'), // { serverId, serverName, uri, token, kind, sectionKey, sectionTitle, connections }
  server: null,
  settings: { ...DEFAULT_SETTINGS, ...(store.get('settings') || {}) },
};

export function saveSettings(patch) {
  Object.assign(app.settings, patch);
  store.set('settings', app.settings);
  emit('settings', app.settings);
}

export function setAuth(auth) {
  app.auth = auth;
  store.set('auth', auth);
}

// `serverChanged` tells listeners (the player, the backdrop) whether this is
// a different server or just a new address/library on the same one.
export function setSource(source) {
  const prev = app.source;
  app.source = source;
  store.set('source', source);
  app.server = source ? new PlexServer({ uri: source.uri, token: source.token, name: source.serverName, id: source.serverId }) : null;
  emit('source', { source, serverChanged: !prev || !source || prev.serverId !== source.serverId });
}

export function signOut() {
  store.clear(['clientId', 'settings']);
  app.auth = null;
  app.source = null;
  app.server = null;
  emit('signout');
}

// The container can proxy one server at /pms (see docker/40-plexamp-web.sh),
// which sidesteps mixed-content and DNS-rebinding problems on home networks.
export function proxyUri() {
  const p = app.config.serverProxy;
  return p ? new URL(p, location.href).toString().replace(/\/+$/, '') : null;
}
