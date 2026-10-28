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
  loudness: true, // loudness levelling: louder tracks turned down to match (player.js levelFor)
  loadAhead: 1, // tracks loaded in full ahead, into memory (prefetch.js); 0: off (the next starts loading shortly before it's due)
  keepPlayed: 1, // tracks kept in memory once played, to go back to (prefetch.js); 0: off
  quietEndings: 'quiet', // smart fades start over a quiet ending: off | soft | quiet | hushed (transitions.js)
  shareDevices: true, // your devices share what's playing; one plays (devices.js)
  reportPlays: true, // "Sync recent plays": tell Plex what's played
  skipLive: false, // live tracks and demos left out of what the app picks (mb.js skipLiveOn; on with mbSkipLive where the player has the MusicBrainz features)
  // mode: 'auto' (the app's shared model when there is one) | 'shared' | 'custom' | 'off'
  ai: { mode: 'auto', url: '', apiKey: '', model: '', notes: '' },

  // Experience
  gridSize: 'normal', // small | normal | large
  fontSize: 'normal', // small | normal | large | larger
  ratingSystem: 'tick', // tick (favourite) | stars | thumbs | off
  listRatings: true, // ratings in track lists too
  lovedPlaylist: true, // five-star / thumbs-up tracks kept in ❤️ Tracks
  codecInfo: true, // formats and quality everywhere: album pages, covers, search, the player (formats.js)
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
  showRating: true, // your rating of the track playing
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

  // MusicBrainz features, where the player has them (MUSICBRAINZ_ADVANCED: mb.js)
  mbSkipLive: true, // ...Skip live tracks and demos on, to begin with, where it has them (see skipLive)
  mbMissingAlbums: true, // an artist's albums the library hasn't, on their page
  mbMissingKinds: ['albums', 'singles', 'compilations', 'soundtracks', 'remixes'], // ...those of these kinds (mb.js RELEASE_KINDS)
  mbOriginalYears: true, // albums by the year they first came out

  // Home screen, one for every library: { '*': { order, hidden, options, seen } }
  home: {},
};

// The codec settings before 0.25.0 (codecInfo since).
export const CODEC_SETTINGS = Object.freeze(['codecBadges', 'coverBadges', 'searchCodecs', 'showCodec']);

// Settings kept by an earlier version, as they are now. (`version` is
// what they were last saved by.)
export const SETTINGS_VERSION = 4;
export function migrateSettings(s) {
  if (!(Number(s.version) >= 2)) {
    // 0.19.0: half stars went, and the favourite tick is the rating system
    // to start with (it was five stars, which most never changed).
    if (s.ratingSystem === 'stars' || s.ratingSystem === 'half') s.ratingSystem = 'tick';
    // ...and one Home layout for every library: the one for the library
    // chosen now, or else the one changed last.
    if (s.home && typeof s.home === 'object' && !s.home['*']) {
      const src = store.get('source');
      const layouts = Object.entries(s.home);
      const mine = src && s.home[`${src.serverId || src.uri}:${src.sectionKey}`];
      const layout = mine || layouts[layouts.length - 1]?.[1];
      s.home = layout ? { '*': layout } : {};
    }
  }
  if (!(Number(s.version) >= 3)) {
    // 0.20.0: loudness levelling on, and the next track loaded ahead, to
    // start with (0.19.0 had them off).
    if (s.loudness === false) s.loudness = true;
    if (s.loadAhead === 0) s.loadAhead = 1;
  }
  if (!(Number(s.version) >= 4)) {
    // 0.25.0: one setting for codec information everywhere, for the four
    // there were (album pages, covers, search, the player): off where all
    // four were (one kept from before another was added, 0.23.0's covers,
    // say, isn't all of them). And live updates are the player's to choose
    // (WEBSOCKETS on the container), not each device's.
    if (CODEC_SETTINGS.every((k) => s[k] === false)) s.codecInfo = false;
    for (const k of CODEC_SETTINGS) delete s[k];
    delete s.liveUpdates;
  }
  s.version = SETTINGS_VERSION;
  return s;
}

export const app = {
  config: window.PW_CONFIG || {},
  auth: store.get('auth'), // { token, username, thumb, manual }
  source: store.get('source'), // { serverId, serverName, uri, token, kind, sectionKey, sectionTitle, connections }
  server: null,
  settings: { ...DEFAULT_SETTINGS, ...storedSettings() },
};

function storedSettings() {
  const s = store.get('settings') || {};
  // Until 0.9.1 the codec and the rating were one setting (the codec went
  // with the others in 0.25.0: see migrateSettings).
  if (s.showCodecRating === false) {
    s.showCodec ??= false;
    s.showRating ??= false;
  }
  delete s.showCodecRating;
  return migrateSettings(s);
}

setDeviceName(app.settings.playerName);

export function saveSettings(patch) {
  Object.assign(app.settings, patch);
  store.set('settings', app.settings);
  if ('playerName' in patch) setDeviceName(app.settings.playerName);
  // (What changed, for settings that follow your account: see sync.js.)
  emit('settings-patch', patch);
  emit('settings', app.settings);
}

// Playlists from every music library, or only this one; search one library
// or all of them (Settings › Experience, with more than one music library).
export const playlistScope = () => (app.settings.playlistsAllLibraries === false ? app.source?.sectionKey : undefined);
export const searchScope = () => (app.settings.searchAllLibraries ? undefined : app.source?.sectionKey);

// One Home screen layout, for every server and library (each library had
// its own until 0.19.0).
export const homeKey = () => '*';

// Set once this browser's settings may not be its next account's own (see
// sync.js): they've followed an account, or someone signed out here (any
// version: settings kept from before a sign-in are someone's), or signed in
// over someone else.
export const SYNCED_BEFORE = 'syncedBefore';
// (sync.js: changes here not yet kept for the account, and the account's
// settings as this browser last had them. Not the next account's.)
export const SYNC_PENDING = 'syncPending';
export const SYNC_REV = 'syncRev';
// (missingsync.js: someone signed in over someone else here, so the Missing
// tracks list here may be theirs, never to go to the next account.)
export const MISSING_OVER = 'aiMissingOver';

export function setAuth(auth) {
  const over = app.auth?.token && app.auth.token !== auth?.token;
  if (over || (!app.auth?.token && store.get('settings'))) store.set(SYNCED_BEFORE, true);
  if (over) {
    store.set(SYNC_PENDING, null);
    store.set(SYNC_REV, null);
    store.set(MISSING_OVER, true);
  }
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

// Signing out clears everything kept for you on this device: the sign-in,
// the queue, lists, and the settings that are yours rather than the
// device's (anything for the AI, the name this player goes by, Home
// layouts). How the app looks and plays stays. Then the page loads afresh,
// so nothing of yours is left in it either.
export function signOut() {
  // (Settings that follow your account stay as they are for it: see sync.js.)
  emit('signing-out');
  const { ai, playerName } = DEFAULT_SETTINGS;
  saveSettings({ ai: { ...ai, mode: app.settings.ai?.mode === 'off' ? 'off' : ai.mode }, playerName, home: {} });
  store.set(SYNCED_BEFORE, true);
  store.clear(['clientId', 'settings', SYNCED_BEFORE]);
  // Nothing more is kept from here on (what's playing, say, as the page goes).
  store.freeze();
  app.auth = null;
  app.source = null;
  app.server = null;
  emit('signout');
  // Pictures kept by the browser have the token in their address: the
  // container asks it to forget what it kept from here (over HTTPS; best
  // effort). A moment for that, and for leaving Play Together and the rest.
  // (Sent the way a page's own requests are: browsers ignore the request
  // for one that couldn't carry cookies, though this player sets none.)
  const forget = fetch('signed-out', { cache: 'no-store', credentials: 'same-origin' }).catch(() => {});
  Promise.race([forget, new Promise((r) => setTimeout(r, 1500))]).then(reloadClean);
}

// The page afresh, without this tab's history of pages (and searches) either.
function reloadClean() {
  try {
    sessionStorage.clear();
  } catch {
    /* storage unavailable */
  }
  location.reload();
}

// Signed out (or in as someone else) in another tab: this one follows, so
// nothing of the last account carries on here, and nothing it was doing is
// kept as it goes.
window.addEventListener('storage', (e) => {
  if (e.key !== null && e.key !== 'pw.auth') return;
  if ((store.get('auth')?.token || null) === (app.auth?.token || null)) return;
  store.freeze();
  reloadClean();
});

// The container can proxy one server at /pms (see docker/40-plexamp-web.sh),
// which sidesteps mixed-content and DNS-rebinding problems on home networks.
export function proxyUri() {
  const p = app.config.serverProxy;
  return p ? new URL(p, location.href).toString().replace(/\/+$/, '') : null;
}
