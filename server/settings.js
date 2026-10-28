// Settings that follow a Plex account: the app's settings that aren't a
// device's own (see web/js/sync.js), so every browser someone signs in on
// has the same ones. Kept in a file (settings.json in the data folder),
// written soon after each change, readable by the service only.
//
// Only the settings listed in SYNCED_SETTINGS are kept, each as the kind of
// value it is: no sign-ins, names or addresses. Anything else a browser
// sends (a device's own settings: its name, its connection, its own AI
// server and key) is never kept, and a setting added to the app later
// isn't either, until it's added here.
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const SETTINGS_LIMITS = {
  bytes: 16 * 1024, // one account's settings, as JSON
  accounts: 1000, // accounts this player keeps settings for
  keys: 120, // in any one object (the Home layout's)
  items: 200, // in any one list
  depth: 5,
  text: 300, // characters in any one piece of text (in the Home layout)
};

// The settings that follow an account, and what each is. The app's own list
// (SYNCED_SETTINGS in web/js/sync.js) is the same: a test keeps them so.
export const SYNCED_SETTINGS = Object.freeze({
  gapless: 'boolean',
  fades: 'choice',
  fadeLength: 'number',
  loudness: 'boolean',
  quietEndings: 'choice',
  reportPlays: 'boolean',
  gridSize: 'choice',
  fontSize: 'choice',
  ratingSystem: 'choice',
  listRatings: 'boolean',
  lovedPlaylist: 'boolean',
  codecInfo: 'boolean',
  popularTracks: 'boolean',
  topListSize: 'number',
  previewButtons: 'boolean',
  searchAllLibraries: 'boolean',
  playlistsAllLibraries: 'boolean',
  oneTapPlayback: 'boolean',
  mediaSession: 'boolean',
  tabTitle: 'boolean',
  keyboardShortcuts: 'boolean',
  tintBackground: 'boolean',
  backgroundStyle: 'choice',
  showRating: 'boolean',
  showVolume: 'boolean',
  seekbarStyle: 'choice',
  sideBySide: 'boolean',
  showAlbumYear: 'boolean',
  showFullPlayer: 'boolean',
  playbackSpeed: 'boolean',
  sleepTimer: 'boolean',
  longForm: 'boolean',
  quickSkip: 'boolean',
  skipBack: 'number',
  skipForward: 'number',
  skipLive: 'boolean',
  mbSkipLive: 'boolean',
  mbMissingAlbums: 'boolean',
  mbMissingKinds: 'kinds', // ['albums', 'singles', ...]
  mbOriginalYears: 'boolean',
  home: 'layout', // { '*': { order, hidden, options, seen } }
});

export class SettingsError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const KEY = /^[A-Za-z0-9_*:.-]{1,120}$/;
const CHOICE = /^[A-Za-z0-9_.-]{0,40}$/;
const UNSAFE = new Set(['__proto__', 'constructor', 'prototype']);
const unreadable = () => new SettingsError(400, 'Those settings couldn’t be read.');
const userId = (v) => (Number.isSafeInteger(Number(v)) && Number(v) > 0 ? Number(v) : null);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// A value as it's kept: plain JSON (true/false, numbers, text, lists and
// objects of them), no bigger or deeper than the limits allow.
export function cleanValue(v, depth = 0) {
  if (v === null || typeof v === 'boolean') return v;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw unreadable();
    return v;
  }
  if (typeof v === 'string') {
    if (v.length > SETTINGS_LIMITS.text) throw unreadable();
    return v;
  }
  if (depth >= SETTINGS_LIMITS.depth) throw unreadable();
  if (Array.isArray(v)) {
    if (v.length > SETTINGS_LIMITS.items) throw unreadable();
    return v.map((x) => cleanValue(x, depth + 1));
  }
  if (typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
    const keys = Object.keys(v);
    if (keys.length > SETTINGS_LIMITS.keys) throw unreadable();
    const out = {};
    for (const k of keys) {
      if (!KEY.test(k) || UNSAFE.has(k)) throw unreadable();
      out[k] = cleanValue(v[k], depth + 1);
    }
    return out;
  }
  throw unreadable();
}

// One setting's value, if it's the kind that setting is (else it throws).
function cleanSetting(kind, v) {
  if (kind === 'boolean' && typeof v === 'boolean') return v;
  if (kind === 'number' && typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 1e6) return v;
  if (kind === 'choice' && typeof v === 'string' && CHOICE.test(v)) return v;
  if (kind === 'layout' && v && typeof v === 'object' && !Array.isArray(v)) return cleanValue(v, 0);
  if (kind === 'kinds' && Array.isArray(v) && v.length <= 12 && v.every((x) => typeof x === 'string' && /^[a-z]{1,20}$/.test(x))) return [...new Set(v)];
  throw unreadable();
}

// The settings in `set` that follow an account, as they're kept. Others are
// left out; one of them that isn't what that setting is makes it all
// unreadable (`lenient`: that one is left out instead, reading the file).
export function cleanSettings(set, { lenient = false } = {}) {
  if (!set || typeof set !== 'object' || Array.isArray(set)) throw unreadable();
  const out = {};
  for (const [k, kind] of Object.entries(SYNCED_SETTINGS)) {
    if (!own(set, k)) continue;
    try {
      out[k] = cleanSetting(kind, set[k]);
    } catch (err) {
      if (!lenient) throw err;
    }
  }
  return out;
}

const tooBig = (settings) => Buffer.byteLength(JSON.stringify(settings)) > SETTINGS_LIMITS.bytes;

// One account's settings as read back from the file (anything that isn't
// as it would have been kept is left out).
function checked(raw) {
  try {
    const off = raw?.off === true;
    const settings = off ? {} : cleanSettings(raw?.settings ?? {}, { lenient: true });
    if (tooBig(settings)) return null;
    const n = Number(raw.rev);
    const rev = Number.isSafeInteger(n) && n > 0 ? n : 1;
    // (When each changed; not known: as late as it could be.)
    const changed = {};
    for (const k of Object.keys(settings)) {
      const at = Number(raw.changed?.[k]);
      changed[k] = Number.isSafeInteger(at) && at > 0 && at <= rev ? at : rev;
    }
    return { settings, changed, rev, at: Number(raw.at) || 0, off };
  } catch {
    return null;
  }
}

// The file's version: 3 from 0.25.0 (2 from 0.20.0). Settings kept by an
// earlier one are brought up to date once, as they're read (see upgrade
// and codecInfoOf).
const FILE_VERSION = 3;

// 0.20.0 starts loudness levelling on (0.19.0 started it off). An account
// that kept it off from then most likely kept 0.19.0's start (turning
// keeping them on again sends them all), so it goes, and each device has
// its own, as 0.20.0 starts it: on. Whether anything went.
function upgrade(a) {
  if (a.settings.loudness !== false) return false;
  delete a.settings.loudness;
  delete a.changed.loudness;
  return true;
}

// 0.25.0 has one setting for codec information everywhere (codecInfo), for
// the four there were (album pages, covers, search, the player): off where
// all four were kept, and off, as the app has it (web/js/state.js
// migrateSettings). (Most accounts kept from before 0.23.0 never had
// covers' kept: those stay on.) From the settings as the file had them:
// false, or null (as it starts: on).
const CODEC_SETTINGS = ['codecBadges', 'coverBadges', 'searchCodecs', 'showCodec'];
const codecInfoOf = (raw) => (CODEC_SETTINGS.every((k) => raw?.[k] === false) ? false : null);

// What's said of an account's settings: them, how many times they've
// changed (0: none kept yet), at which of those changes each last did
// (so a browser can tell whether a change it couldn't send was overtaken),
// and whether its person turned keeping them off.
const view = (a) => ({ settings: a ? a.settings : {}, changed: a ? a.changed : {}, rev: a ? a.rev : 0, off: !!a?.off });

export class SettingsStore {
  constructor({ dir = null, log = null, writeDelayMs = 1000 } = {}) {
    this.file = dir ? join(dir, 'settings.json') : null;
    this.log = log;
    this.writeDelayMs = writeDelayMs;
    this.accounts = new Map(); // user id -> { settings, changed, rev, at, off }
    this.timer = null;
    this.load();
  }

  load() {
    if (!this.file || !existsSync(this.file)) return;
    try {
      const data = JSON.parse(readFileSync(this.file, 'utf8'));
      const version = Number(data?.version) || 1;
      let moved = 0;
      let older = false;
      for (const [id, raw] of Object.entries(data?.accounts && typeof data.accounts === 'object' ? data.accounts : {})) {
        const uid = userId(id);
        const a = uid && checked(raw);
        if (!a || this.accounts.size >= SETTINGS_LIMITS.accounts) continue;
        if (version < 2 && upgrade(a)) moved += 1;
        if (version < 3) {
          older = true;
          if (!a.off && !('codecInfo' in a.settings) && codecInfoOf(raw?.settings) === false) {
            a.settings.codecInfo = false;
            a.changed.codecInfo = a.rev;
          }
        }
        this.accounts.set(uid, a);
      }
      if (moved) {
        this.log?.info(`account settings: loudness levelling is on to start with from 0.20.0; ${moved} account${moved === 1 ? '' : 's'} kept it off from 0.19.0, where off was how it started, and now ${moved === 1 ? 'has' : 'have'} it on`);
      }
      // (Written as this version keeps them: from 0.25.0, without the four
      // codec settings.)
      if (older) this.changed();
    } catch (err) {
      this.log?.warn(`account settings: couldn't read ${this.file} (${err.message}); starting without them`);
    }
  }

  // An account's settings (see view).
  get(uid) {
    return view(this.accounts.get(userId(uid)));
  }

  // Some of an account's settings changed: `set` is { name: value } (each
  // replaces what was kept under that name). Or { off: true }: none are
  // kept for it any more (until { off: false }).
  update(uid, body) {
    const id = userId(uid);
    if (!id) throw new SettingsError(400, 'Those settings couldn’t be read.');
    const had = this.accounts.get(id);
    const room = () => {
      if (!had && this.accounts.size >= SETTINGS_LIMITS.accounts) throw new SettingsError(507, 'This player can’t keep settings for any more accounts.');
    };
    if (typeof body?.off === 'boolean') {
      room();
      const a = { settings: {}, changed: {}, rev: (had?.rev || 0) + 1, at: Date.now(), off: body.off };
      this.accounts.set(id, a);
      this.changed();
      return view(a);
    }
    if (had?.off) throw new SettingsError(409, 'Keeping your settings for your account is turned off.');
    const patch = cleanSettings(body?.set);
    // Nothing that follows an account: nothing changes.
    if (!Object.keys(patch).length) return this.get(id);
    room();
    const settings = { ...(had?.settings || {}), ...patch };
    if (tooBig(settings)) throw new SettingsError(413, 'Those settings are too big to keep.');
    const rev = (had?.rev || 0) + 1;
    const changed = { ...(had?.changed || {}) };
    for (const k of Object.keys(patch)) changed[k] = rev;
    const a = { settings, changed, rev, at: Date.now(), off: false };
    this.accounts.set(id, a);
    this.changed();
    return view(a);
  }

  // An account's settings go, and whether it turned keeping them off (each
  // of its devices still has its own copy).
  forget(uid) {
    if (this.accounts.delete(userId(uid))) this.changed();
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
    const tmp = `${this.file}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify({ version: FILE_VERSION, accounts: Object.fromEntries(this.accounts) }), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch (err) {
      this.log?.error(`account settings: couldn't save them to ${this.file}: ${err.message}`);
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
