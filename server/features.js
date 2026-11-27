// What each Plex server's owner turns on or off for everyone who plays from
// it here (Settings › Server owner in the app: see web/js/features.js):
// Missing tracks, and the MusicBrainz features. Only the server's owner
// changes them, as plex.tv says whose it is (see the route in index.js);
// everyone who can use the server reads them. Kept for each server by its
// id: which are on, and how many times they've changed. No accounts, names
// or sign-ins. In a file (features.json in the data folder), written soon
// after each change, readable by the service only; in memory only without
// one.
import { join } from 'node:path';
import { ServiceError } from './errors.js';
import { readDataFile, writeDataFile } from './datafile.js';
import { SERVER_ID } from './clean.js';

export const FEATURES_LIMITS = {
  servers: 1000, // this player keeps them for
};

// Each, and how it starts: the app's own list (FEATURES in
// web/js/features.js) is the same, which a test keeps so.
export const FEATURES = Object.freeze({
  missing: false, // what AI playlists and Spotify imports don't find goes on Missing tracks
  mbCheck: true, // ...where an AI's suggestions are looked up on MusicBrainz first
  mbMissingAlbums: true, // an artist's albums the library hasn't, on their page
  mbMissingKinds: Object.freeze(['albums', 'singles', 'compilations', 'soundtracks', 'remixes']), // ...those of these kinds
  mbOriginalYears: true, // albums by the year they first came out
  mbNamesakes: true, // another artist's albums of the same name kept apart
});

export class FeaturesError extends ServiceError {}

const unreadable = () => new FeaturesError(400, 'Those settings couldn’t be read.');
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const KIND = /^[a-z]{1,20}$/;

// One's value, if it's the kind that one is (else it throws).
function cleanFeature(name, v) {
  const start = FEATURES[name];
  if (typeof start === 'boolean' && typeof v === 'boolean') return v;
  if (Array.isArray(start) && Array.isArray(v) && v.length <= 12 && v.every((x) => typeof x === 'string' && KIND.test(x))) return [...new Set(v)];
  throw unreadable();
}

// Those in `set` that are features, as they're kept. Others are left out;
// one that isn't what that feature is makes it all unreadable (`lenient`:
// that one is left out instead, reading the file).
export function cleanFeatures(set, { lenient = false } = {}) {
  if (!set || typeof set !== 'object' || Array.isArray(set)) throw unreadable();
  const out = {};
  for (const name of Object.keys(FEATURES)) {
    if (!own(set, name)) continue;
    try {
      out[name] = cleanFeature(name, set[name]);
    } catch (err) {
      if (!lenient) throw err;
    }
  }
  return out;
}

const FILE_VERSION = 1;

// What's said of a server's: those its owner has set (the rest are as they
// start), and how many times they've changed (0: never).
const view = (s) => ({ features: s ? { ...s.features } : {}, rev: s ? s.rev : 0 });

export class ServerFeatures {
  constructor({ dir = null, log = null, writeDelayMs = 1000 } = {}) {
    this.file = dir ? join(dir, 'features.json') : null;
    this.log = log;
    this.writeDelayMs = writeDelayMs;
    this.servers = new Map(); // server id -> { features, rev, at }
    this.timer = null;
    this.load();
  }

  // (One that can't be read is kept aside, never written over: see
  // datafile.js.)
  load() {
    const read = (data) => {
      const list = data.version === FILE_VERSION && data.servers && typeof data.servers === 'object' ? Object.entries(data.servers) : [];
      for (const [id, raw] of list) {
        if (!SERVER_ID.test(id) || !raw || typeof raw !== 'object' || this.servers.size >= FEATURES_LIMITS.servers) continue;
        let features;
        try {
          features = cleanFeatures(raw.features ?? {}, { lenient: true });
        } catch {
          continue;
        }
        const rev = Number(raw.rev);
        this.servers.set(id, { features, rev: Number.isSafeInteger(rev) && rev > 0 ? rev : 1, at: Number(raw.at) || 0 });
      }
    };
    if (!readDataFile(this.file, read, { log: this.log, what: 'server owners’ settings' })) this.file = null;
  }

  // A server's (see view).
  get(server) {
    return view(this.servers.get(String(server)));
  }

  // Whether one is on for everyone on `server`: as its owner set it, or as
  // it starts.
  on(server, name) {
    const set = this.servers.get(String(server))?.features;
    const v = set && own(set, name) ? set[name] : FEATURES[name];
    return Array.isArray(v) ? v.length > 0 : v === true;
  }

  // Its owner changed some: `set` is { name: value }, each replacing what
  // was kept. `seed`: only if none were ever set (the owner's app sets them
  // as they had them on their own, the first time it's asked, and two of
  // theirs at once mustn't undo each other's).
  update(server, body) {
    const id = String(server);
    if (!SERVER_ID.test(id)) throw unreadable();
    const had = this.servers.get(id);
    const patch = cleanFeatures(body?.set);
    if ((body?.seed === true && had) || !Object.keys(patch).length) return this.get(id);
    if (!had && this.servers.size >= FEATURES_LIMITS.servers) throw new FeaturesError(507, 'This player can’t keep settings for any more Plex servers.');
    const s = { features: { ...(had?.features || {}), ...patch }, rev: (had?.rev || 0) + 1, at: Date.now() };
    this.servers.set(id, s);
    this.changed();
    return view(s);
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
    try {
      writeDataFile(this.file, { version: FILE_VERSION, servers: Object.fromEntries(this.servers) });
    } catch (err) {
      this.log?.error(`server owners’ settings: couldn't save them to ${this.file}: ${err.message}`);
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
