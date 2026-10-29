// Client for plex.tv (sign-in, server discovery) and Plex Media Server.
// Plex accepts its X-Plex-* values as query parameters, so every request is
// sent without custom headers. That keeps browser requests "simple" and
// avoids CORS preflights against the server.
import { debugLog, safeUrl } from './debug.js';

// The version matches the newest entry in CHANGELOG.md (CI checks).
export const APP_INFO = { product: 'plexamp-web', version: '0.30.0' };

const PLEX_TV = 'https://plex.tv';
const CLIENTS = 'https://clients.plex.tv';

// ---------- persistence ----------

// Signed out (here or in another tab): nothing more is kept, while the page
// goes (see signOut in state.js). Nor once someone else is signed in here,
// or nobody is, from another tab (`owner`: the token this page is signed in
// with, or null, once state.js says): the page is about to follow (see its
// storage listener), and nothing of its own goes to the next person, not
// even in the moment before it hears.
let frozen = false;
let owner;
const keptToken = () => {
  try {
    return JSON.parse(localStorage.getItem('pw.auth'))?.token ?? null;
  } catch {
    return null;
  }
};

export const store = {
  get(key, fallback = null) {
    try {
      const raw = localStorage.getItem(`pw.${key}`);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  // Whether it was kept.
  set(key, value) {
    if (frozen) return false;
    if (owner !== undefined && key !== 'auth' && keptToken() !== owner) return false;
    try {
      if (value === null || value === undefined) localStorage.removeItem(`pw.${key}`);
      else localStorage.setItem(`pw.${key}`, JSON.stringify(value));
      return true;
    } catch {
      /* storage unavailable (private mode, quota): carry on without it */
      return false;
    }
  },
  clear(keepKeys = []) {
    try {
      const keep = new Set(keepKeys.map((k) => `pw.${k}`));
      Object.keys(localStorage)
        .filter((k) => k.startsWith('pw.') && !keep.has(k))
        .forEach((k) => localStorage.removeItem(k));
    } catch {
      /* ignore */
    }
  },
  freeze() {
    frozen = true;
  },
  // Whose this page is: the token it's signed in with (none: nobody).
  own(token) {
    owner = token || null;
  },
};

// 16 random hex characters.
const randomId = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('');

export function clientId() {
  let id = store.get('clientId');
  if (!id) {
    id = crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    store.set('clientId', id);
  }
  return id;
}

// One track's playback, as Plex knows it: X-Plex-Session-Identifier, which
// Plex's API describes as unique per playback, for clients that can play
// more than one thing at once (a browser with several tabs). A track's
// stream and its play reports carry the same one, and no other track's do:
// this browser's client ID is the same in every tab, and while one track
// ends, the next one's stream is already starting.
export const playbackId = () => (crypto.randomUUID ? crypto.randomUUID() : randomId());

function browserName() {
  const ua = navigator.userAgent;
  if (/Firefox\//.test(ua)) return 'Firefox';
  if (/Chrome\/|CriOS\//.test(ua)) return 'Chrome';
  if (/Safari\//.test(ua)) return 'Safari';
  return 'Chrome';
}

function osName() {
  const ua = navigator.userAgent;
  if (/Android/.test(ua)) return 'Android';
  if (/iPhone|iPad|iPod/.test(ua)) return 'iOS';
  if (/Mac OS X/.test(ua)) return 'macOS';
  if (/Windows/.test(ua)) return 'Windows';
  if (/Linux/.test(ua)) return 'Linux';
  return 'Web';
}

// The name this player shows in Plex (its dashboard, "Now playing" lists).
let deviceName = '';
export function setDeviceName(name) {
  deviceName = String(name || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 60);
}

export function defaultDeviceName() {
  return `${APP_INFO.product} (${browserName()})`;
}

// What your other devices call this one: the player name you gave it, or
// "Firefox on Windows".
export function deviceLabel() {
  return deviceName || `${browserName()} on ${osName()}`;
}

function plexParams(token) {
  const browser = browserName();
  const params = {
    'X-Plex-Product': APP_INFO.product,
    'X-Plex-Version': APP_INFO.version,
    'X-Plex-Client-Identifier': clientId(),
    // The server picks its playback profile from the platform, so report the
    // real browser the way Plex's own web app does.
    'X-Plex-Platform': browser,
    'X-Plex-Device': osName(),
    'X-Plex-Device-Name': deviceName || `${APP_INFO.product} (${browser})`,
  };
  if (token) params['X-Plex-Token'] = token;
  return params;
}

function withParams(url, params) {
  const u = new URL(url, location.href);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, v);
  }
  return u.toString();
}

const asArray = (v) => (Array.isArray(v) ? v : v ? [v] : []);

// `discard`: the answer isn't needed, so it isn't read (Plex can answer a
// change with the whole list it changed: sorting a long playlist makes
// hundreds of changes).
// `body`: bytes to send (a picture); they go without a Content-Type, as
// Plex works out what they are, so the request needs no CORS preflight.
async function request(url, { method = 'GET', timeout = 20000, signal, discard = false, body } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  const onAbort = () => ctrl.abort();
  signal?.addEventListener('abort', onAbort);
  try {
    let res;
    try {
      res = await fetch(url, { method, headers: { Accept: 'application/json' }, signal: ctrl.signal, credentials: 'omit', ...(body ? { body } : {}) });
    } catch (cause) {
      const err = new Error(signal?.aborted ? 'aborted' : 'network');
      err.network = !signal?.aborted;
      err.aborted = !!signal?.aborted;
      err.cause = cause;
      if (err.network) debugLog('plex', `${method} ${safeUrl(url)} failed: ${ctrl.signal.aborted ? `no answer within ${timeout / 1000} s` : 'network error (unreachable, blocked, or refused by CORS)'}`, 'warn');
      throw err;
    }
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      debugLog('plex', `${method} ${safeUrl(url)} answered ${res.status}`, 'warn');
      throw err;
    }
    if (discard) {
      res.body?.cancel().catch(() => {});
      return {};
    }
    const text = await res.text();
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      return {}; // a few endpoints answer with XML or an empty body on success
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

// ---------- plex.tv sign-in (PIN flow) ----------

export async function createPin() {
  return request(withParams(`${PLEX_TV}/api/v2/pins`, { strong: 'true', ...plexParams() }), { method: 'POST' });
}

export function authUrl(pin, forwardUrl) {
  const p = new URLSearchParams({
    clientID: clientId(),
    code: pin.code,
    'context[device][product]': APP_INFO.product,
    'context[device][version]': APP_INFO.version,
    'context[device][platform]': browserName(),
    'context[device][device]': osName(),
  });
  if (forwardUrl) p.set('forwardUrl', forwardUrl);
  return `https://app.plex.tv/auth/#!?${p.toString()}`;
}

export async function checkPin(id) {
  const pin = await request(withParams(`${PLEX_TV}/api/v2/pins/${id}`, plexParams()));
  return pin.authToken || null;
}

export async function getUser(token) {
  return request(withParams(`${PLEX_TV}/api/v2/user`, plexParams(token)));
}

// ---------- Plex Home ----------

// The people in the Plex Home of the account a token is for (managed users
// among them), as plex.tv lists them: [{ id, uuid, title, thumb, admin,
// restricted (a managed user), guest, protected (with a PIN) }]; none (or
// only them) where it isn't in a Plex Home.
const HOME_UUID = /^[A-Za-z0-9_-]{1,64}$/;
const yes = (v) => v === true || v === 1 || v === '1';
export async function homeUsers(token) {
  const url = (base) => withParams(`${base}/api/v2/home/users`, plexParams(token));
  let home;
  try {
    home = await request(url(CLIENTS));
  } catch (err) {
    if (err.status) throw err;
    home = await request(url(PLEX_TV));
  }
  return asArray(home?.users)
    .filter((u) => u && typeof u === 'object' && HOME_UUID.test(String(u.uuid ?? '')))
    .map((u) => ({
      id: String(u.id ?? ''),
      uuid: String(u.uuid),
      title: String(u.friendlyName || u.title || u.username || 'Plex user').slice(0, 100),
      thumb: typeof u.thumb === 'string' && /^https:\/\//.test(u.thumb) ? u.thumb : null,
      admin: yes(u.admin),
      restricted: yes(u.restricted),
      guest: yes(u.guest),
      protected: yes(u.protected),
    }));
}

// Switches to one of them (`pin`: theirs, where they have one): plex.tv's
// account for them, with its token (`authToken`). (The PIN goes to plex.tv
// only, the way Plex's own apps send it; it isn't kept, and debug.js keeps
// it out of the log.)
export async function switchHomeUser(token, uuid, pin) {
  if (!HOME_UUID.test(String(uuid ?? ''))) throw Object.assign(new Error('Not someone in your Plex Home.'), { status: 400 });
  const user = await request(withParams(`${CLIENTS}/api/v2/home/users/${uuid}/switch`, { ...plexParams(token), pin: pin || undefined }), { method: 'POST' });
  if (typeof user?.authToken !== 'string' || !/^[A-Za-z0-9_.~-]{1,200}$/.test(user.authToken)) throw Object.assign(new Error('plex.tv didn’t switch to them.'), { status: 502 });
  return user;
}

// ---------- server discovery ----------

export async function listServers(token) {
  const params = { includeHttps: 1, includeRelay: 1, includeIPv6: 1, ...plexParams(token) };
  let resources;
  try {
    resources = await request(withParams(`${CLIENTS}/api/v2/resources`, params));
  } catch (err) {
    if (err.status === 401) throw err;
    resources = await request(withParams(`${PLEX_TV}/api/v2/resources`, params));
  }
  return asArray(resources)
    .filter((r) => (r.provides || '').split(',').includes('server'))
    .map((r) => ({
      id: r.clientIdentifier,
      name: r.name,
      owned: !!r.owned,
      sharedBy: r.sourceTitle || null,
      token: r.accessToken || token,
      connections: asArray(r.connections).map((c) => ({
        uri: c.uri,
        local: !!c.local,
        relay: !!c.relay,
        protocol: c.protocol,
      })),
    }));
}

// How good a route to a server is (lower is better), for the route chosen
// in Settings › Connection (app.settings.route):
//   best (the default): its address on the home network first. Next, this
//     container's /pms/ proxy, when it fronts this server: it reaches the
//     server on the home network even when the browser can't, such as when
//     the router won't look up plex.direct addresses that point into the
//     home network (DNS rebinding protection), or the browser keeps a page
//     on the internet from reaching the home network. Then remote addresses,
//     and the relay is the last resort.
//   container: this container's proxy first.
//   direct: the server's own addresses first (the container's proxy before
//     the relay).
const ROUTE_RANKS = {
  best: { local: 0, proxy: 1, remote: 2, relay: 3 },
  container: { proxy: 0, local: 1, remote: 2, relay: 3 },
  direct: { local: 0, remote: 1, proxy: 2, relay: 3 },
};
export const ROUTE_KINDS = ['local', 'proxy', 'remote', 'relay'];
export const routeRank = (kind, prefer = 'best') => (ROUTE_RANKS[prefer] || ROUTE_RANKS.best)[kind] ?? 9;

// Every route to a server, tried at once: [{ uri, kind, ok, ms, why }], `why`
// saying why one can't be used ('http': a plain http address, which a page
// served over https can't use; 'insecure': a plain http address over the
// internet, which would carry your sign-in unencrypted; 'timeout';
// 'network'; 'status' (it answered with an error, `status`); 'other': it
// leads to another server). Each is asked who it is, and only counts if
// it's this very server. The question carries the server's sign-in, as the
// app's requests over that route would: a Plex server only lets a page on
// another address read its answer when the request carries one, so without
// it every route but this container's proxy looks dead (as in 0.16.0). It
// only goes where the route rules above allow: https addresses, whose
// certificate the browser checks (a plex.direct one is made for this very
// server), plain http only on the home network, and this player's own
// address.
export async function probeConnections(server, { proxy = null, timeout = 6000 } = {}) {
  const pageIsHttps = location.protocol === 'https:';
  const candidates = server.connections.map((c) => {
    const kind = c.relay ? 'relay' : c.local ? 'local' : 'remote';
    const http = c.protocol === 'http' || /^http:/i.test(c.uri);
    return { uri: c.uri, kind, why: http && pageIsHttps ? 'http' : http && kind !== 'local' ? 'insecure' : null };
  });
  if (proxy) candidates.push({ uri: proxy, kind: 'proxy', why: null });
  return Promise.all(
    candidates.map(async ({ uri, kind, why }) => {
      if (why) return { uri, kind, ok: false, why };
      const t0 = performance.now();
      try {
        const id = await request(withParams(`${uri}/identity`, plexParams(server.token)), { timeout });
        if (id?.MediaContainer?.machineIdentifier !== server.id) return { uri, kind, ok: false, why: 'other' };
        return { uri, kind, ok: true, ms: Math.round(performance.now() - t0) };
      } catch (err) {
        if (err?.status) return { uri, kind, ok: false, why: 'status', status: err.status };
        return { uri, kind, ok: false, why: performance.now() - t0 >= timeout - 100 ? 'timeout' : 'network' };
      }
    }),
  );
}

// The best route that answers (see ROUTE_RANKS), or null.
export async function pickConnection(server, { proxy = null, timeout = 6000, prefer = 'best' } = {}) {
  const alive = (await probeConnections(server, { proxy, timeout })).filter((c) => c.ok).sort((a, b) => routeRank(a.kind, prefer) - routeRank(b.kind, prefer));
  return alive[0] ? { uri: alive[0].uri, kind: alive[0].kind } : null;
}

// ---------- normalisers ----------

// Flatten a Plex track into the small shape the player and UI use. This is
// also what gets saved with the queue, so keep it lean.
export function normTrack(m) {
  const media = asArray(m.Media)[0] || {};
  const part = asArray(media.Part)[0] || {};
  return {
    id: String(m.ratingKey),
    title: m.title || 'Untitled',
    artist: m.originalTitle || m.grandparentTitle || '',
    albumArtist: m.grandparentTitle || '',
    artistId: m.grandparentRatingKey ? String(m.grandparentRatingKey) : null,
    album: m.parentTitle || '',
    albumId: m.parentRatingKey ? String(m.parentRatingKey) : null,
    thumb: m.parentThumb || m.thumb || m.grandparentThumb || null,
    duration: m.duration || part.duration || 0,
    index: m.index ?? null,
    disc: m.parentIndex ?? null,
    year: m.parentYear || m.year || null,
    codec: (media.audioCodec || '').toLowerCase(),
    bitrate: media.bitrate || null,
    partKey: part.key || null,
    viewCount: m.viewCount || 0,
    userRating: m.userRating ?? null,
    ratingCount: m.ratingCount || 0,
    lastViewedAt: m.lastViewedAt || null,
  };
}

// Lossless formats, and how good a copy sounds, to choose between two of
// one recording (an album and its hi-res edition, say): lossless first, then
// the higher bitrate.
const LOSSLESS = new Set(['flac', 'alac', 'wav', 'aiff', 'aif', 'pcm', 'dsd', 'dsf', 'dff', 'ape', 'wv', 'wavpack', 'tta', 'mlp']);
export const isLossless = (codec) => LOSSLESS.has(String(codec || '').toLowerCase());
export const audioQuality = (t) => (isLossless(t?.codec) ? 100000 : 0) + (Number(t?.bitrate) || 0);

// Plex's four corner colours for artwork, checked to be hex colours (they
// end up in CSS).
const HEX = /^#?[0-9a-f]{6}$/i;
export function cleanColors(c) {
  if (!c) return null;
  const keys = ['topLeft', 'topRight', 'bottomRight', 'bottomLeft'];
  return keys.every((k) => HEX.test(String(c[k] || ''))) ? Object.fromEntries(keys.map((k) => [k, String(c[k]).replace('#', '')])) : null;
}

export function ultraBlurOf(item) {
  return cleanColors(asArray(item?.UltraBlurColors)[0]);
}

// Listings that may be opened from a link (see byPath).
export function isListingPath(path) {
  return typeof path === 'string' && /^\/library\/sections\/\d+\/all(\?[^#]*)?$/.test(path) && !path.includes('..');
}

export const TAG_FIELDS = new Set(['genre', 'style', 'mood', 'decade', 'year', 'studio', 'country']);
const MEMO_LIMIT = 300;
const TYPES_LIMIT = 5000; // albums' release types kept (see albumTypes)
const WRITE_BATCH = 200; // items per request when adding to a playlist or collection
const HUB_COUNT = 100; // items in each of an artist's hubs (see artistHubs)
const ARTIST_PAGE = 1000; // albums asked for at a time (see artistAlbums)
// What's in a list as no more than each entry's id and whose it is (its
// album's and artist's ids, and who a track's credited to), and the list's
// size: Plex leaves the rest out, where it can (a server that can't sends
// it all).
const LIGHT = {
  includeFields: 'ratingKey,parentRatingKey,grandparentRatingKey,originalTitle,size,totalSize,offset,leafCount',
  excludeElements: 'Media,Genre,Mood,Style,Collection,Label,Guid,Field,Image,UltraBlurColors,Country',
};
// Albums' details as albumTypes asks for them: their release types, without
// what else their details have (their summaries, tags and the rest), where
// Plex can leave that out.
const TYPES_ONLY = {
  excludeElements: `${LIGHT.excludeElements},Review,Location,Similar`,
  excludeFields: 'summary',
};

const chunks = (list, size) => {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
};

// ---------- Plex Media Server ----------

export class PlexServer {
  constructor({ uri, token, name, id }) {
    this.uri = uri.replace(/\/+$/, '');
    this.token = token;
    this.name = name || 'Plex Media Server';
    this.id = id || null;
    this.cache = new Map();
    this.types = new Map(); // album id -> { Format, Subformat } (see albumTypes)
    this.typing = new Map(); // album id -> its types being asked for
  }

  // The app's own X-Plex-* values (the token above all) come last, so no
  // parameter from elsewhere, such as a filter in a link, can replace them.
  // `token` is only ever the server's own temporary token (for casting), or
  // '' for none at all.
  url(path, params = {}, token = this.token) {
    return withParams(this.uri + path, { ...params, ...plexParams(token) });
  }

  async get(path, params, opts) {
    const data = await request(this.url(path, params), opts);
    return data.MediaContainer || {};
  }

  // Small memo for data that rarely changes during a session. It holds at
  // most MEMO_LIMIT answers: a long session (a Guest DJ looks up every
  // track's album) mustn't keep everything it ever looked up.
  memo(key, fn, ttl = 60000) {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < ttl) {
      // Most recently used last, so the least recently used go first.
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit.value;
    }
    const value = fn().catch((err) => {
      if (this.cache.get(key)?.value === value) this.cache.delete(key);
      throw err;
    });
    this.cache.delete(key);
    this.cache.set(key, { at: Date.now(), value });
    while (this.cache.size > MEMO_LIMIT) this.cache.delete(this.cache.keys().next().value);
    return value;
  }

  identity(opts) {
    return this.get('/identity', null, opts);
  }

  async musicSections(opts) {
    const mc = await this.get('/library/sections', null, opts);
    return asArray(mc.Directory).filter((d) => d.type === 'artist');
  }

  // Plex metadata types: 8 artist, 9 album, 10 track, 15 playlist, 18 collection
  async list(section, type, { sort, start = 0, size = 60, filters = {}, signal } = {}) {
    const mc = await this.get(
      `/library/sections/${section}/all`,
      { type, sort, ...filters, 'X-Plex-Container-Start': start, 'X-Plex-Container-Size': size },
      { signal },
    );
    return { items: asArray(mc.Metadata), total: mc.totalSize ?? mc.size ?? 0 };
  }

  async count(section, type, filters = {}) {
    const mc = await this.get(`/library/sections/${section}/all`, {
      type,
      ...filters,
      'X-Plex-Container-Start': 0,
      'X-Plex-Container-Size': 0,
    });
    return mc.totalSize ?? mc.size ?? 0;
  }

  // Page through a library listing the server handed us (e.g. a genre's
  // fastKey). These paths can arrive in a link, so only library listings
  // are accepted: a crafted link can't send the server anywhere else.
  async byPath(path, { start = 0, size = 60 } = {}) {
    if (!isListingPath(path)) throw Object.assign(new Error('That isn’t a library listing.'), { status: 400 });
    const mc = await this.get(path, { 'X-Plex-Container-Start': start, 'X-Plex-Container-Size': size });
    return { items: asArray(mc.Metadata), total: mc.totalSize ?? mc.size ?? 0 };
  }

  // (`params`: { includeGuids: 1 } for the other services' ids for it, say:
  // MusicBrainz's.)
  async metadata(id, params) {
    const mc = await this.get(`/library/metadata/${id}`, params);
    return asArray(mc.Metadata)[0] || null;
  }

  // (An artist's children are their albums proper, Plex's "true albums":
  // their singles, EPs, live albums, compilations and the rest are only in
  // artistAlbums, and Plex's rows for their page.)
  async children(id) {
    return asArray((await this.get(`/library/metadata/${id}/children`)).Metadata);
  }

  // Every album of an artist's, of every kind: the library's albums by
  // them, ARTIST_PAGE at a time, on until Plex's count of them (or a short
  // page where it gives none; one bigger than was asked for is a server
  // that gave them all at once, and the same page again one that doesn't
  // page). As the library lists them: without what kind each is.
  async artistAlbums(section, artistId, { signal } = {}) {
    if (!/^\d+$/.test(String(artistId)) || !/^\d+$/.test(String(section))) return [];
    const out = [];
    let last = null;
    for (let start = 0; start < ARTIST_PAGE * 50; ) {
      const mc = await this.get(
        `/library/sections/${section}/all`,
        { type: 9, 'artist.id': artistId, 'X-Plex-Container-Start': start, 'X-Plex-Container-Size': ARTIST_PAGE },
        { signal },
      );
      const items = asArray(mc.Metadata);
      const sig = items.map((m) => m?.ratingKey).join(',');
      if (start && sig === last) break;
      last = sig;
      out.push(...items);
      start += items.length;
      if (!items.length || items.length > ARTIST_PAGE || (mc.totalSize != null ? start >= mc.totalSize : items.length < ARTIST_PAGE)) break;
    }
    return out;
  }

  async allLeaves(id) {
    return asArray((await this.get(`/library/metadata/${id}/allLeaves`)).Metadata);
  }

  // Secondary listings: genre, style, mood, decade... filtered by item type.
  tags(section, field, type) {
    if (!TAG_FIELDS.has(field) || !/^\d+$/.test(String(type)) || !/^\d+$/.test(String(section))) {
      return Promise.reject(Object.assign(new Error('Unknown list.'), { status: 400 }));
    }
    return this.memo(`tags:${section}:${field}:${type}`, async () =>
      asArray((await this.get(`/library/sections/${section}/${field}`, { type })).Directory),
    );
  }

  collections(section) {
    return this.memo(`collections:${section}`, async () =>
      asArray((await this.get(`/library/sections/${section}/collections`)).Metadata),
    );
  }

  async collection(id) {
    const [meta, items] = await Promise.all([
      this.get(`/library/collections/${id}`),
      this.get(`/library/collections/${id}/children`),
    ]);
    return { meta: asArray(meta.Metadata)[0] || null, items: asArray(items.Metadata) };
  }

  // A page of what's in a collection, in its order (`ids`: only each one's
  // id, as LIGHT asks).
  async collectionItems(id, { start = 0, size = 500, ids = false, signal } = {}) {
    const mc = await this.get(
      `/library/collections/${id}/children`,
      {
        ...(ids ? LIGHT : {}),
        'X-Plex-Container-Start': start,
        'X-Plex-Container-Size': size,
      },
      { signal },
    );
    // (`counted`: how many Plex says there are, null if it doesn't say.)
    return { items: asArray(mc.Metadata), total: mc.totalSize ?? mc.size ?? 0, counted: mc.totalSize ?? null };
  }

  // Music playlists; with a section, only those with music from it.
  playlists(section) {
    return this.memo(`playlists:${section || 'all'}`, async () =>
      asArray((await this.get('/playlists', { playlistType: 'audio', sectionID: section || undefined })).Metadata),
    );
  }

  forgetPlaylists() {
    for (const k of this.cache.keys()) if (k.startsWith('playlists:')) this.cache.delete(k);
  }

  async playlist(id, opts) {
    return asArray((await this.get(`/playlists/${id}`, null, opts)).Metadata)[0] || null;
  }

  // (`ids`: only each entry's id, as LIGHT asks.)
  async playlistItems(id, { start = 0, size = 100, ids = false, signal } = {}) {
    const mc = await this.get(
      `/playlists/${id}/items`,
      {
        ...(ids ? LIGHT : {}),
        'X-Plex-Container-Start': start,
        'X-Plex-Container-Size': size,
      },
      { signal },
    );
    return { items: asArray(mc.Metadata), total: mc.totalSize ?? mc.leafCount ?? mc.size ?? 0, counted: mc.totalSize ?? mc.leafCount ?? null };
  }

  // Plex's hubs for an artist's page (Plexamp's rows: their releases by
  // kind, what they appear on, their popular tracks...), `count` items in
  // each at most. See hubs.js.
  async artistHubs(id, { count = HUB_COUNT } = {}) {
    if (!/^\d+$/.test(String(id))) return [];
    return asArray((await this.get(`/hubs/metadata/${id}`, { count })).Hub);
  }

  // Searches one library, or every library on the server without one.
  async search(query, section, { signal, limit = 10 } = {}) {
    const mc = await this.get('/hubs/search', { query, sectionId: section || undefined, limit }, { signal });
    const out = { artist: [], album: [], track: [], playlist: [] };
    for (const hub of asArray(mc.Hub)) {
      if (out[hub.type]) out[hub.type] = asArray(hub.Metadata);
    }
    return out;
  }

  // Same filters python-plexapi uses for an artist's popular tracks.
  async popularTracks(section, artistId, limit = 20) {
    const { items } = await this.list(section, 10, {
      sort: 'ratingCount:desc',
      size: limit,
      filters: { 'artist.id': artistId, group: 'title', 'ratingCount>>': 0 },
    });
    return items;
  }

  // Sonically similar items (tracks for a track, artists for an artist).
  // Needs sonic analysis on the server; returns [] when it isn't available.
  async nearest(id, { limit = 50, maxDistance = 0.25 } = {}) {
    return asArray((await this.get(`/library/metadata/${id}/nearest`, { limit, maxDistance })).Metadata);
  }

  async computePath(section, startID, endID) {
    return asArray((await this.get(`/library/sections/${section}/computePath`, { startID, endID })).Metadata);
  }

  async randomTracks(section, size = 100) {
    return (await this.list(section, 10, { sort: 'random', size })).items;
  }

  trackDetail(id) {
    return this.memo(`track:${id}`, () => this.metadata(id), 10 * 60000);
  }

  // Several items' full details in one request (Plex takes a list of ids):
  // ids must be numbers, as everywhere they go into an address.
  async metadataMany(ids, params) {
    const out = [];
    const clean = [...new Set(ids.map(String))].filter((id) => /^\d+$/.test(id));
    for (const part of chunks(clean, 40)) out.push(...asArray((await this.get(`/library/metadata/${part.join(',')}`, params)).Metadata));
    return out;
  }

  // Several items' details, kept as memo() keeps them (under `kind:id`, for
  // `ttl`): those not asked about lately in one request. In the same order
  // as `ids`, null for any Plex didn't give.
  async manyKept(kind, ids, ttl) {
    const want = ids.map(String);
    const fresh = (id) => {
      const hit = this.cache.get(`${kind}:${id}`);
      return hit && Date.now() - hit.at < ttl;
    };
    const ask = [...new Set(want.filter((id) => !fresh(id)))];
    if (ask.length) {
      const got = await this.metadataMany(ask);
      for (const m of got) this.cache.set(`${kind}:${m.ratingKey}`, { at: Date.now(), value: Promise.resolve(m) });
      while (this.cache.size > MEMO_LIMIT) this.cache.delete(this.cache.keys().next().value);
    }
    return Promise.all(want.map((id) => (fresh(id) ? this.cache.get(`${kind}:${id}`).value : Promise.resolve(null)).catch(() => null)));
  }

  // Tracks' full details (their streams' formats included), as trackDetail
  // gives them.
  tracksDetail(ids) {
    return this.manyKept('track', ids, 10 * 60000);
  }

  // Albums' release types (Format: album, EP, single...; Subformat: live, a
  // compilation...), which Plex's lists of an artist's albums leave out (an
  // album's own details have them): read from those, 40 albums to a
  // request, three requests at a time (those already being asked about,
  // for another page, waited for), and kept while the app's open, in a list
  // of their own (a big discography mustn't push what else is kept out).
  // In the same order as `ids`: { Format, Subformat } (empty lists where
  // Plex says none), or null where Plex couldn't be asked this time.
  async albumTypes(ids) {
    const asked = [...new Set(ids.map(String))].filter((id) => /^\d+$/.test(id));
    const parts = chunks(
      asked.filter((id) => !this.types.has(id) && !this.typing.has(id)),
      40,
    ).map((part) => {
      let done;
      const job = new Promise((resolve) => (done = resolve));
      for (const id of part) this.typing.set(id, job);
      return { part, done };
    });
    const lane = async () => {
      for (let p = parts.shift(); p; p = parts.shift()) {
        try {
          const got = await this.metadataMany(p.part, TYPES_ONLY);
          const byId = new Map(got.map((m) => [String(m.ratingKey), m]));
          // (One Plex didn't give has nothing to say.)
          for (const id of p.part) this.types.set(id, { Format: asArray(byId.get(id)?.Format), Subformat: asArray(byId.get(id)?.Subformat) });
        } catch {
          /* asked again next time */
        } finally {
          for (const id of p.part) this.typing.delete(id);
          p.done();
        }
      }
    };
    const waiting = asked.map((id) => this.typing.get(id)).filter(Boolean);
    await Promise.all([lane(), lane(), lane(), ...waiting]);
    const out = ids.map((id) => this.types.get(String(id)) || null);
    while (this.types.size > TYPES_LIMIT) this.types.delete(this.types.keys().next().value);
    return out;
  }

  // Albums and artists, as albumMeta gives albums: their genres, styles,
  // moods and (artists) similar artists.
  albumsMeta(ids) {
    return this.manyKept('album', ids, 30 * 60000);
  }

  artistsMeta(ids) {
    return this.manyKept('artist', ids, 30 * 60000);
  }

  // How good an album's copy sounds (see audioQuality): its best track.
  albumQuality(id) {
    return this.memo(`albumq:${id}`, async () => Math.max(0, ...(await this.children(id)).filter((m) => m.type === 'track').map((m) => audioQuality(normTrack(m)))), 10 * 60000);
  }

  // Loudness over the length of a track (dB values), used to draw the
  // waveform seek bar. Only present once the server has analysed loudness.
  levels(streamId, subsample = 160) {
    return this.memo(
      `levels:${streamId}:${subsample}`,
      async () => asArray((await this.get(`/library/streams/${streamId}/levels`, { subsample })).Level).map((l) => Number(l.v)),
      60 * 60000,
    );
  }

  // Album details change rarely; DJ modes look these up for every track.
  albumMeta(id) {
    return this.memo(`album:${id}`, () => this.metadata(id), 30 * 60000);
  }

  async machineId() {
    if (this.id && !/^https?:/.test(this.id)) return this.id;
    const mc = await this.identity();
    this.id = mc.machineIdentifier;
    return this.id;
  }

  // ---------- changing playlists and collections ----------
  // Items are given to Plex as a "server://" address listing their ids, a
  // batch at a time (a long list would make the address too long).

  async libraryUri(ids) {
    return `server://${await this.machineId()}/com.plexapp.plugins.library/library/metadata/${ids.join(',')}`;
  }

  async send(method, path, params, { discard = false, body, timeout } = {}) {
    const data = await request(this.url(path, params), { method, discard, body, ...(timeout ? { timeout } : {}) });
    return data?.MediaContainer || {};
  }

  // ---------- a playlist's or collection's picture ----------
  // (Plex calls them posters.) Only pictures on the server itself are
  // offered: ones uploaded to it, not addresses elsewhere.

  async posters(id) {
    const mc = await this.get(`/library/metadata/${id}/posters`);
    return [...asArray(mc.Metadata), ...asArray(mc.Photo)]
      .filter((p) => typeof p.key === 'string' && p.key.startsWith('/') && !p.key.startsWith('//') && typeof p.ratingKey === 'string')
      .map((p) => ({ id: p.ratingKey, key: p.key, thumb: typeof p.thumb === 'string' && p.thumb.startsWith('/') && !p.thumb.startsWith('//') ? p.thumb : p.key, selected: !!Number(p.selected) || p.selected === true }));
  }

  // A picture (its bytes) becomes the item's.
  async uploadPoster(id, bytes) {
    await this.send('POST', `/library/metadata/${id}/posters`, {}, { body: bytes, discard: true, timeout: 90000 });
    this.forgetPictures(id);
  }

  // One the item had before (from posters()).
  async selectPoster(id, poster) {
    await this.send('PUT', `/library/metadata/${id}/poster`, { url: poster }, { discard: true });
    this.forgetPictures(id);
  }

  // Back to the picture Plex makes (for a playlist, its tracks' covers).
  async removePoster(id) {
    await this.send('DELETE', `/library/metadata/${id}/thumb`, {}, { discard: true });
    this.forgetPictures(id);
  }

  forgetPictures() {
    this.forgetPlaylists();
    for (const k of this.cache.keys()) if (k.startsWith('collections:')) this.cache.delete(k);
  }

  async createPlaylist(title, ids) {
    const [first, ...rest] = chunks(ids, WRITE_BATCH);
    const mc = await this.send('POST', '/playlists', { type: 'audio', title, smart: 0, uri: await this.libraryUri(first || []) });
    const pl = asArray(mc.Metadata)[0] || null;
    if (pl) for (const batch of rest) await this.send('PUT', `/playlists/${pl.ratingKey}/items`, { uri: await this.libraryUri(batch) });
    this.forgetPlaylists();
    return pl;
  }

  // Adds to the end; returns the playlist (with its new track count).
  async addToPlaylist(id, ids) {
    let mc = {};
    for (const batch of chunks(ids, WRITE_BATCH)) mc = await this.send('PUT', `/playlists/${id}/items`, { uri: await this.libraryUri(batch) });
    this.forgetPlaylists();
    return asArray(mc.Metadata)[0] || null;
  }

  // Playlist entries have their own ids (playlistItemID): the same track can
  // be in a playlist twice. Removing an entry leaves the track in the library.
  async removeFromPlaylist(id, itemId) {
    await this.send('DELETE', `/playlists/${id}/items/${itemId}`);
    this.forgetPlaylists();
  }

  // Moves an entry to just after another one, or to the top without one.
  async movePlaylistItem(id, itemId, afterId = null) {
    await this.send('PUT', `/playlists/${id}/items/${itemId}/move`, afterId ? { after: afterId } : {}, { discard: true });
    this.forgetPlaylists();
  }

  async renamePlaylist(id, title) {
    await this.send('PUT', `/playlists/${id}`, { title });
    this.forgetPlaylists();
  }

  // A playlist's title or summary (what's given).
  async editPlaylist(id, { title, summary } = {}) {
    await this.send('PUT', `/playlists/${id}`, { title, summary });
    this.forgetPlaylists();
  }

  async deletePlaylist(id) {
    await this.send('DELETE', `/playlists/${id}`);
    this.forgetPlaylists();
  }

  // Collections hold one kind of item: artists (8), albums (9) or tracks (10).
  async createCollection(section, type, title, ids) {
    const [first, ...rest] = chunks(ids, WRITE_BATCH);
    const mc = await this.send('POST', '/library/collections', { type, title, smart: 0, sectionId: section, uri: await this.libraryUri(first || []) });
    const c = asArray(mc.Metadata)[0] || null;
    if (c) for (const batch of rest) await this.send('PUT', `/library/collections/${c.ratingKey}/items`, { uri: await this.libraryUri(batch) });
    this.forgetCollections();
    return c;
  }

  async addToCollection(id, ids) {
    for (const batch of chunks(ids, WRITE_BATCH)) await this.send('PUT', `/library/collections/${id}/items`, { uri: await this.libraryUri(batch) });
    this.forgetCollections();
  }

  async removeFromCollection(id, itemId) {
    await this.send('DELETE', `/library/collections/${id}/items/${itemId}`);
    this.forgetCollections();
  }

  // Items keep a custom order only once the collection is sorted "custom".
  async moveCollectionItem(id, itemId, afterId = null) {
    await this.send('PUT', `/library/collections/${id}/items/${itemId}/move`, afterId ? { after: afterId } : {}, { discard: true });
  }

  async customOrder(id) {
    await this.send('PUT', `/library/collections/${id}/prefs`, { collectionSort: 2 });
  }

  async renameCollection(section, id, title) {
    await this.send('PUT', `/library/sections/${section}/all`, { type: 18, id, 'title.value': title, 'title.locked': 1 });
    this.forgetCollections();
  }

  async deleteCollection(id) {
    await this.send('DELETE', `/library/collections/${id}`);
    this.forgetCollections();
  }

  // An album's year (`year`, and the day it came out: `date`, YYYY-MM-DD)
  // or genres (`genres`: all it's to have; `removeGenres`: those it's not
  // to have any more) changed, each locked so Plex's next refresh of its
  // metadata leaves it be: for the server's admin (the MusicBrainz
  // features' review: mbreview.js). Genres go as Plex's own apps send them:
  // each one escaped, then all of them as one value.
  // (`unlock`: as an Undo, the fields changed are left unlocked again, for
  // Plex's next refresh; `date` '' clears it.)
  async editAlbum(section, id, { year, date, genres, removeGenres, unlock = false } = {}) {
    const params = { type: 9, id };
    const locked = unlock ? 0 : 1;
    if (year) Object.assign(params, { 'year.value': year, 'year.locked': locked });
    if (date != null) Object.assign(params, { 'originallyAvailableAt.value': date, 'originallyAvailableAt.locked': locked });
    if (genres?.length) {
      genres.forEach((g, i) => (params[`genre[${i}].tag.tag`] = g));
      params['genre.locked'] = locked;
    }
    if (removeGenres?.length) {
      params['genre[].tag.tag-'] = removeGenres.map((g) => encodeURIComponent(g)).join(',');
      params['genre.locked'] = locked;
    }
    await this.send('PUT', `/library/sections/${section}/all`, params);
    this.cache.delete(`album:${id}`);
  }

  forgetCollections() {
    for (const k of this.cache.keys()) if (k.startsWith('collections:')) this.cache.delete(k);
  }

  // ---------- play queues (casting) ----------
  // A play queue lives on the server: a player we cast to plays it from
  // there. Each entry has its own playQueueItemID.

  async createPlayQueue(ids, selectedId, { repeat = 0 } = {}) {
    return this.send('POST', '/playQueues', {
      type: 'audio',
      uri: await this.libraryUri(ids),
      key: `/library/metadata/${selectedId}`,
      shuffle: 0,
      repeat,
      continuous: 0,
      own: 1,
    });
  }

  playQueue(id) {
    return this.get(`/playQueues/${id}`, { window: 500, own: 1 });
  }

  // next: right after the playing entry, otherwise at the end.
  async addToPlayQueue(id, ids, { next = false } = {}) {
    return this.send('PUT', `/playQueues/${id}`, { uri: await this.libraryUri(ids), next: next ? 1 : 0 });
  }

  removeFromPlayQueue(id, itemId) {
    return this.send('DELETE', `/playQueues/${id}/items/${itemId}`);
  }

  movePlayQueueItem(id, itemId, afterId) {
    return this.send('PUT', `/playQueues/${id}/items/${itemId}/move`, afterId ? { after: afterId } : {});
  }

  // A temporary token from the server, for a device we cast to (it never
  // gets the account's own token).
  async transientToken() {
    const mc = await this.get('/security/token', { type: 'delegation', scope: 'all' });
    const t = mc.token;
    if (typeof t !== 'string' || !/^[A-Za-z0-9_.~-]{8,200}$/.test(t)) throw new Error('The server didn’t give a temporary token.');
    return t;
  }

  // Star rating on Plex's 0–10 scale; null clears it.
  async rate(id, rating) {
    const url = this.url('/:/rate', { key: id, identifier: 'com.plexapp.plugins.library', rating: rating ?? -1 });
    try {
      await request(url, { method: 'PUT' });
    } catch (err) {
      // If the browser's preflight for PUT is refused, the server also
      // accepts this command as a plain GET.
      if (!err.network) throw err;
      await request(url);
    }
    const hit = this.cache.get(`track:${id}`);
    hit?.value.then((d) => d && (d.userRating = rating ?? undefined)).catch(() => {});
  }

  ultraBlur(thumb) {
    return this.memo(
      `ub:${thumb}`,
      async () => cleanColors(asArray((await this.get('/services/ultrablur/colors', { url: thumb })).UltraBlurColors)[0]),
      60 * 60000,
    );
  }

  // Tell the server what is playing. This drives play counts, "recent plays"
  // and the Now Playing view on the Plex dashboard. `playback`: the
  // track's playback (see playbackId), as its stream was started with.
  timeline(track, state, timeMs, playback) {
    const url = this.url('/:/timeline', {
      ratingKey: track.id,
      key: `/library/metadata/${track.id}`,
      identifier: 'com.plexapp.plugins.library',
      state,
      time: Math.max(0, Math.round(timeMs)),
      duration: track.duration || undefined,
      'X-Plex-Session-Identifier': playback || undefined,
    });
    return fetch(url, { headers: { Accept: 'application/json' }, keepalive: true }).catch(() => {});
  }

  // Artwork, always through the server's image transcoder, including images
  // hosted elsewhere: the browser then only ever talks to the Plex server.
  art(path, size = 300) {
    if (!path || typeof path !== 'string') return '';
    if (!path.startsWith('/') && !/^https?:\/\//i.test(path)) return '';
    return this.url('/photo/:/transcode', { width: size, height: size, minSize: 1, upscale: 1, url: path });
  }

  // The original file, played as-is by the browser.
  // `token`: another token to use (AirPlay and Cast get the server's
  // temporary one); '' for none at all.
  directUrl(track, token) {
    return track.partKey ? this.url(track.partKey, {}, token ?? this.token) : null;
  }

  // Server-side conversion for formats the browser can't decode, or to save
  // data. Uses the same universal transcoder endpoint as python-plexapi.
  // `playback`: the track's playback (see playbackId); a stream started
  // again part-way through the track keeps it (it's the same playback).
  transcodeUrl(track, bitrate = 320, token = this.token, playback = playbackId()) {
    // A stream's files are fetched by its session id alone (no token: see
    // pms-proxy.inc), so it's one nobody could guess, in both the names Plex
    // servers take it by.
    const session = `${clientId()}-${track.id}-${randomId()}`;
    return this.url(
      '/audio/:/transcode/universal/start.m3u8',
      {
        path: `/library/metadata/${track.id}`,
        mediaIndex: 0,
        partIndex: 0,
        protocol: 'hls',
        directPlay: 0,
        directStream: 0,
        directStreamAudio: 0,
        hasMDE: 1,
        musicBitrate: bitrate,
        session,
        transcodeSessionId: session,
        'X-Plex-Session-Identifier': playback,
        'X-Plex-Client-Profile-Extra':
          'add-transcode-target(type=musicProfile&context=streaming&protocol=hls&container=mpegts&audioCodec=aac,mp3)',
      },
      token,
    );
  }
}

// ---------- browser format support ----------

const probe = typeof Audio !== 'undefined' ? new Audio() : null;
const MIME = {
  mp3: 'audio/mpeg',
  aac: 'audio/mp4; codecs="mp4a.40.2"',
  flac: 'audio/flac',
  alac: 'audio/mp4; codecs="alac"',
  opus: 'audio/ogg; codecs="opus"',
  vorbis: 'audio/ogg; codecs="vorbis"',
  wav: 'audio/wav',
  pcm: 'audio/wav',
};

export function canPlayCodec(codec) {
  const mime = MIME[(codec || '').toLowerCase()];
  return !!(probe && mime && probe.canPlayType(mime) !== '');
}

export function canPlayHlsNatively() {
  return !!(probe && probe.canPlayType('application/vnd.apple.mpegurl') !== '');
}
