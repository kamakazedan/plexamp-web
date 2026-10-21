// Shared app state, settings and a tiny event bus.
import { store, PlexServer, setDeviceName } from './plex.js';

const bus = new EventTarget();

export function emit(name, detail) {
  bus.dispatchEvent(new CustomEvent(name, { detail }));
}

export function on(name, fn) {
  const handler = (e) => fn(e.detail);
  bus.addEventListener(name, handler);
  return () => bus.removeEventListener(name, handler);
}

export const DEFAULT_SETTINGS = {
  quality: 'original', // 'original' or a transcode bitrate in kbps, e.g. '320'
  route: 'best', // to the server: 'best', 'container' or 'direct' (see plex.js ROUTE_RANKS)
  gapless: true,
  fades: 'smart', // crossfade between tracks: off | smart (where the music ends; not within albums) | always
  fadeLength: 5, // seconds
  quietEndings: 'quiet', // smart fades start over a quiet ending: off | soft | quiet | hushed (transitions.js)
  shareDevices: true, // your devices share what's playing; one plays (devices.js)
  reportPlays: true, // "Sync recent plays": tell Plex what's played
  liveUpdates: 'auto', // 'auto' (WebSocket first) | 'nows' (no WebSockets) | 'off'
  // mode: 'auto' (the app's shared model when there is one) | 'shared' | 'custom' | 'off'
  ai: { mode: 'auto', url: '', apiKey: '', model: '', notes: '' },

  // Experience
  gridSize: 'normal', // small | normal | large
  fontSize: 'normal', // small | normal | large | larger
  ratingSystem: 'stars', // stars | half | thumbs | off
  listRatings: true, // ratings in track lists too
  lovedPlaylist: true, // five-star / thumbs-up tracks kept in ❤️ Tracks
  codecBadges: true,
  searchCodecs: true, // each track's format in search results
  popularTracks: true,
  topListSize: 25,
  previewButtons: false,
  searchAllLibraries: false,
  playlistsAllLibraries: true,
  oneTapPlayback: true,
  mediaSession: true, // media keys and lock screen controls
  tabTitle: true, // what's playing in the browser tab's title
  keyboardShortcuts: true,
  playerName: '', // shown in Plex's dashboard; empty: "plexamp-web (Browser)"

  // Appearance
  tintBackground: true,
  backgroundStyle: 'gradient', // gradient (album colours) | artwork (blurred cover) | plain

  // Player
  showCodec: true, // the track's format and quality, in the player
  showRating: true, // your rating of it, there
  showVolume: true,
  seekbarStyle: 'smooth', // smooth | bars | simple
  sideBySide: true,
  showAlbumYear: true,
  showFullPlayer: false,
  playbackSpeed: false,
  speed: 1,
  sleepTimer: false, // the sleep timer's button in the player
  longForm: false,
  quickSkip: false,
  skipBack: 10,
  skipForward: 30,

  // Home screen, per library: { [serverId:sectionKey]: { order, hidden, options } }
  home: {},
};

export const app = {
  config: window.PW_CONFIG || {},
  auth: store.get('auth'), // { token, username, thumb, manual }
  source: store.get('source'), // { serverId, serverName, uri, token, kind, sectionKey, sectionTitle, connections }
  server: null,
  settings: { ...DEFAULT_SETTINGS, ...storedSettings() },
};

function storedSettings() {
  const s = store.get('settings') || {};
  // Until 0.9.1 the codec and the rating were one setting.
  if (s.showCodecRating === false) {
    s.showCodec ??= false;
    s.showRating ??= false;
  }
  delete s.showCodecRating;
  return s;
}

setDeviceName(app.settings.playerName);

export function saveSettings(patch) {
  Object.assign(app.settings, patch);
  store.set('settings', app.settings);
  if ('playerName' in patch) setDeviceName(app.settings.playerName);
  emit('settings', app.settings);
}

// Playlists from every music library, or only this one; search one library
// or all of them (Settings › Experience, with more than one music library).
export const playlistScope = () => (app.settings.playlistsAllLibraries === false ? app.source?.sectionKey : undefined);
export const searchScope = () => (app.settings.searchAllLibraries ? undefined : app.source?.sectionKey);

// Home screen layouts are kept per library.
export function homeKey(src = app.source) {
  return src ? `${src.serverId || src.uri}:${src.sectionKey}` : 'none';
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
  // Settings stay with the device, except secrets: an AI API key belongs to
  // whoever entered it.
  if (app.settings.ai?.apiKey) saveSettings({ ai: { ...app.settings.ai, apiKey: '' } });
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
