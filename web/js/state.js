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
  skipDisliked: true, // tracks you've rated down (thumbs down, one star) never in what the app picks (picks.js)
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
  mbNamesakes: true, // another artist's albums of the same name kept apart on an artist's page

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

// Set once this browser's settings may not be its next account's own (see
// sync.js): they've followed an account, or someone signed out here (any
// version: settings kept from before a sign-in are someone's), or signed in
// over someone else.
export const SYNCED_BEFORE = 'syncedBefore';

// Someone signed out or switched user here (see leave): what's kept for
// the next person, as it was kept ({ switch, auth, source, and their
// settings where they had some kept here }, or { settings } on signing
// out), till the first start since.
const LEFT = 'left';

// (sync.js: changes here not yet kept for the account, and the account's
// settings as this browser last had them. Not the next account's.)
export const SYNC_PENDING = 'syncPending';
export const SYNC_REV = 'syncRev';

// Each person's settings on this device, kept while someone else in their
// Plex Home uses it (see switchAccount), by their Plex account's id:
// 'profile.<id>': { settings, syncPending, syncRev }, put back when they
// switch back. All of them go on signing out, or signing in over someone.
const PROFILE = 'profile.';
const profileKey = (id) => (/^[A-Za-z0-9_-]{1,64}$/.test(String(id ?? '')) ? `${PROFILE}${id}` : null);

// What stays once someone has left: this device's id, what this browser
// has met, a sign-in being started (Sign in with Plex), and what leaving
// kept, exactly as it was kept: the next person's sign-in and server, or
// this device's settings. Anything else (what another tab of theirs kept
// in the moment before it heard, its queue, say) goes, as does anything
// put in place of what was kept: then the next person signs in, or chooses
// a server, or has the settings to begin with, afresh. Right before the
// page goes (`stay`: the first start does it again), and at the first start
// since, before anything's read. (Clearing isn't held back by the freeze.)
function settleLeft(stay = false) {
  const left = store.get(LEFT);
  if (!left) return;
  if (typeof left !== 'object') return void store.set(LEFT, null); // (one kept by a build of 0.29.0 before it was released)
  const same = (key, value) => JSON.stringify(store.get(key)) === JSON.stringify(value ?? null);
  const keep = ['clientId', SYNCED_BEFORE, 'pendingPin'];
  if (stay) keep.push(LEFT);
  if (left.switch) {
    if (same('auth', left.auth)) keep.push('auth');
    if (same('source', left.source)) keep.push('source');
    // (Theirs, kept from when they last switched away from here.)
    if (left.settings && same('settings', left.settings)) {
      keep.push('settings');
      if (same(SYNC_PENDING, left.syncPending)) keep.push(SYNC_PENDING);
      if (same(SYNC_REV, left.syncRev)) keep.push(SYNC_REV);
    }
    keep.push(...store.keys(PROFILE));
  } else if (same('settings', left.settings)) {
    keep.push('settings');
  }
  store.clear(keep);
}
settleLeft();

export const app = {
  config: window.PW_CONFIG || {},
  auth: store.get('auth'), // { token, username, thumb, manual, offline }
  source: store.get('source'), // { serverId, serverName, uri, token, kind, sectionKey, sectionTitle, connections }
  server: null,
  settings: { ...DEFAULT_SETTINGS, ...storedSettings() },
};
store.own(app.auth?.token);

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

// (missingsync.js: someone signed in over someone else here, so the Missing
// tracks list here may be theirs, never to go to the next account.)
export const MISSING_OVER = 'aiMissingOver';

// Signed in with a Plex account (or a server token): not with the player's
// offline password (see offline.js), which is no Plex account, so nothing that
// needs one is used then.
export const plexAccount = () => !!app.auth?.token && !app.auth.offline;

export function setAuth(auth) {
  const over = app.auth?.token && app.auth.token !== auth?.token;
  if (over || (!app.auth?.token && store.get('settings'))) store.set(SYNCED_BEFORE, true);
  if (over) {
    store.set(SYNC_PENDING, null);
    store.set(SYNC_REV, null);
    store.set(MISSING_OVER, true);
    for (const k of store.keys(PROFILE)) store.set(k, null);
  }
  app.auth = auth;
  store.set('auth', auth);
  store.own(auth?.token);
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
  leave(null);
}

// Switching to someone else in your Plex Home (Settings › Account): as
// signing out, but your settings are kept on this device for you (by your
// Plex account's id, `next.from`), none of them theirs: they get the ones
// kept for them here (`next.to`) from when they last switched away, or
// else every setting as it is to begin with (and theirs from their
// account, where the player keeps them for it). Your queue and the rest go,
// as on signing out. Then the page loads afresh, signed in as them
// (`next.auth`), on the same server and library where they can use those
// (`next.source`), or else they choose.
export function switchAccount(next) {
  leave(next);
}

function leave(next) {
  // (Settings that follow your account stay as they are for it: see sync.js.)
  emit('signing-out');
  if (!next) {
    const { ai, playerName } = DEFAULT_SETTINGS;
    saveSettings({ ai: { ...ai, mode: app.settings.ai?.mode === 'off' ? 'off' : ai.mode }, playerName, home: {} });
  }
  store.set(SYNCED_BEFORE, true);
  // (Switching: yours kept for you, and theirs, kept from before, taken
  // out to be theirs again. Signing out: everyone's go.)
  const mine = next && profileKey(next.from);
  const theirsKey = next && profileKey(next.to);
  if (mine) store.set(mine, { settings: app.settings, syncPending: store.get(SYNC_PENDING), syncRev: store.get(SYNC_REV) });
  const kept = theirsKey ? store.get(theirsKey) : null;
  const theirs = kept && typeof kept === 'object' && kept.settings && typeof kept.settings === 'object' && theirsKey !== mine ? kept : null;
  const profiles = next ? store.keys(PROFILE).filter((k) => k !== theirsKey) : [];
  store.clear(next ? ['clientId', SYNCED_BEFORE, ...profiles] : ['clientId', 'settings', SYNCED_BEFORE]);
  // (This page is the next person's now, or nobody's: see the store.)
  store.own(next?.auth?.token);
  if (next) {
    store.set('auth', next.auth);
    if (next.source) store.set('source', next.source);
    if (theirs) {
      store.set('settings', theirs.settings);
      if (theirs.syncPending) store.set(SYNC_PENDING, theirs.syncPending);
      if (theirs.syncRev) store.set(SYNC_REV, theirs.syncRev);
    }
  }
  store.set(
    LEFT,
    next
      ? { switch: true, auth: next.auth, source: next.source ?? null, ...(theirs ? { settings: theirs.settings, syncPending: theirs.syncPending ?? null, syncRev: theirs.syncRev ?? null } : {}) }
      : { settings: store.get('settings') },
  );
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
  Promise.race([forget, new Promise((r) => setTimeout(r, 1500))]).then(() => {
    settleLeft(true);
    reloadClean(!!next);
  });
}

// The page afresh, without this tab's history of pages (and searches) either
// (`home`: at Home).
function reloadClean(home = false) {
  try {
    sessionStorage.clear();
  } catch {
    /* storage unavailable */
  }
  if (home) history.replaceState(null, '', `${location.pathname}${location.search}#/`);
  location.reload();
}

// Signed out (or in as someone else, or switched to someone else in the
// Plex Home) in another tab: this one follows, at Home, so nothing of the
// last account carries on here (not even the page it was on), and nothing
// it was doing is kept as it goes.
window.addEventListener('storage', (e) => {
  if (e.key !== null && e.key !== 'pw.auth') return;
  if ((store.get('auth')?.token || null) === (app.auth?.token || null)) return;
  store.freeze();
  reloadClean(true);
});

// The container can proxy one server at /pms (see docker/40-plexamp-web.sh),
// which sidesteps mixed-content and DNS-rebinding problems on home networks.
export function proxyUri() {
  const p = app.config.serverProxy;
  return p ? new URL(p, location.href).toString().replace(/\/+$/, '') : null;
}
