// What the Plex server's owner has on for everyone who plays from it with
// this player (Settings › Server owner): Missing tracks, and the MusicBrainz
// features. The player keeps them (server/features.js), and only the
// server's owner can change them there; everyone else has them as the
// owner set them. Read when the app opens, when the server changes, and
// when Settings is opened; kept on this device as they were last read, to
// go by till they're read again, and as they start before they ever were
// (or where the player doesn't keep them).
import { app, emit, plexAccount } from './state.js';
import { store } from './plex.js';
import { serviceFetch } from './service.js';
import { loadMissing } from './missingsync.js';

// Each, and how it starts: as the player has them (FEATURES in
// server/features.js), which a test keeps the same.
export const FEATURES = Object.freeze({
  missing: false,
  mbCheck: true,
  mbMissingAlbums: true,
  mbMissingKinds: Object.freeze(['albums', 'singles', 'compilations', 'soundtracks', 'remixes']),
  mbOriginalYears: true,
  mbNamesakes: true,
});

// The MusicBrainz ones: artist and album pages are built with them.
export const MB_FEATURES = ['mbMissingAlbums', 'mbMissingKinds', 'mbOriginalYears', 'mbNamesakes'];

const KEPT = 'serverFeatures'; // { server id: { features, rev, owner } }, as last read
const API = 'api/features';
const CALL_TIMEOUT = 20000;
const READ_AGAIN = 10 * 60000; // at most this often, unless Settings asks

const serverNow = () => app.source?.serverId || '';
const query = (server) => `${API}?${new URLSearchParams({ server })}`;

function kept() {
  const k = store.get(KEPT, null);
  return k && typeof k === 'object' && !Array.isArray(k) ? k : {};
}

const fs = {
  off: false, // the player doesn't keep them (an older one, or no service)
  reading: null,
  readAt: new Map(), // server id -> when last read
};

// Which are on for the server in use (or `server`): as its owner set them,
// else as they start.
export function features(server = serverNow()) {
  const set = (!fs.off && kept()[server]?.features) || {};
  const out = {};
  for (const [k, start] of Object.entries(FEATURES)) {
    const v = set[k];
    out[k] = Array.isArray(start) ? (Array.isArray(v) ? v : [...start]) : typeof v === 'boolean' ? v : start;
  }
  return out;
}

export const featureOn = (name, server) => features(server)[name] === true;

// Whether this account owns the server in use, as the player last said
// (null: it hasn't yet, or doesn't keep these).
export const ownerHere = (server = serverNow()) => (fs.off ? null : (kept()[server]?.owner ?? null));

// They can be changed here: the player keeps them, and says this is the
// server's owner.
export const canSetFeatures = () => ownerHere() === true;

// What the player said of a server's (`mb`: whether a MusicBrainz one
// changed, for the pages built with them).
function keep(server, got) {
  const before = features(server);
  const k = kept();
  k[server] = { features: got.features && typeof got.features === 'object' ? got.features : {}, rev: Number(got.rev) || 0, owner: got.owner === true };
  store.set(KEPT, k);
  const now = features(server);
  emit('features', { server, mb: MB_FEATURES.some((f) => JSON.stringify(before[f]) !== JSON.stringify(now[f])) });
}

// Read from the player (`force`: even if they were a moment ago).
export function readFeatures({ force = false } = {}) {
  const server = serverNow();
  if (!server || !plexAccount() || fs.off) return Promise.resolve();
  if (!force && Date.now() - (fs.readAt.get(server) || 0) < READ_AGAIN) return Promise.resolve();
  if (fs.reading) return fs.reading;
  fs.reading = (async () => {
    try {
      const res = await serviceFetch(query(server), { timeout: CALL_TIMEOUT });
      // (Not kept by this player: as they start, for everyone.)
      if (res.status === 404) {
        fs.off = true;
        emit('features', { server, mb: true });
        return;
      }
      if (!res.ok || !res.data || serverNow() !== server) return;
      fs.readAt.set(server, Date.now());
      keep(server, res.data);
      if (res.data.owner === true && !res.data.rev) await seed(server);
    } catch {
      /* not reachable just now: as last read */
    } finally {
      fs.reading = null;
    }
  })();
  return fs.reading;
}

// The first time the owner's app reads them for a server and none were
// ever set: as the owner had them till now, when each was a setting of
// theirs (Show missing tracks, and Check suggestions on MusicBrainz, in
// Settings › AI; the MusicBrainz features in Settings › MusicBrainz), so
// nothing changes for them by itself. Missing tracks is on where theirs
// has anything on it (from an import, say). Never over what another of
// their devices set meanwhile (`seed`).
async function seed(server) {
  const s = app.settings;
  const ai = s.ai || {};
  const set = {
    missing: ai.missing === true || loadMissing().some((m) => m.server === server),
    mbCheck: ai.musicbrainz !== false,
    mbMissingAlbums: s.mbMissingAlbums !== false,
    mbMissingKinds: Array.isArray(s.mbMissingKinds) ? s.mbMissingKinds : [...FEATURES.mbMissingKinds],
    mbOriginalYears: s.mbOriginalYears !== false,
    mbNamesakes: s.mbNamesakes !== false,
  };
  try {
    await put(server, { seed: true, set });
  } catch {
    /* as they start, till it's read again */
  }
}

async function put(server, body) {
  const res = await serviceFetch(query(server), { method: 'PUT', body, timeout: CALL_TIMEOUT });
  if (!res.ok) throw Object.assign(new Error(res.data?.error || `Something went wrong (${res.status}).`), { status: res.status });
  keep(server, res.data);
  return res.data;
}

// The owner changed some (`patch`: { name: value }): here at once, then on
// the player. Put back as they were if it doesn't take them (it throws).
export async function setFeatures(patch) {
  const server = serverNow();
  const was = kept()[server];
  keep(server, { features: { ...(was?.features || {}), ...patch }, rev: was?.rev || 0, owner: true });
  try {
    await put(server, { set: patch });
  } catch (err) {
    const k = kept();
    if (was) k[server] = was;
    else delete k[server];
    store.set(KEPT, k);
    emit('features', { server, mb: true });
    throw err.network ? Object.assign(new Error('Can’t reach this player’s server.'), { network: true }) : err;
  }
}
