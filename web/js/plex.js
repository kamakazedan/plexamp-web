// Client for plex.tv (sign-in, server discovery) and Plex Media Server.
// Plex accepts its X-Plex-* values as query parameters, so every request is
// sent without custom headers. That keeps browser requests "simple" and
// avoids CORS preflights against the server.

export const APP_INFO = { product: 'plexamp-web', version: '0.1.0' };

const PLEX_TV = 'https://plex.tv';
const CLIENTS = 'https://clients.plex.tv';

// ---------- persistence ----------

export const store = {
  get(key, fallback = null) {
    try {
      const raw = localStorage.getItem(`pw.${key}`);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      if (value === null || value === undefined) localStorage.removeItem(`pw.${key}`);
      else localStorage.setItem(`pw.${key}`, JSON.stringify(value));
    } catch {
      /* storage unavailable (private mode, quota): carry on without it */
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
};

export function clientId() {
  let id = store.get('clientId');
  if (!id) {
    id = crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    store.set('clientId', id);
  }
  return id;
}

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
    'X-Plex-Device-Name': `${APP_INFO.product} (${browser})`,
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

async function request(url, { method = 'GET', timeout = 20000, signal } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  const onAbort = () => ctrl.abort();
  signal?.addEventListener('abort', onAbort);
  try {
    let res;
    try {
      res = await fetch(url, { method, headers: { Accept: 'application/json' }, signal: ctrl.signal });
    } catch (cause) {
      const err = new Error(signal?.aborted ? 'aborted' : 'network');
      err.network = !signal?.aborted;
      err.aborted = !!signal?.aborted;
      err.cause = cause;
      throw err;
    }
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      throw err;
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

// Probe every connection at once and keep the best one that answers:
// local beats remote, and the relay is the last resort.
export async function pickConnection(server, timeout = 6000) {
  const pageIsHttps = location.protocol === 'https:';
  const candidates = server.connections.filter((c) => !(pageIsHttps && c.protocol === 'http'));
  const rank = (c) => (c.relay ? 2 : c.local ? 0 : 1);
  const alive = (
    await Promise.all(
      candidates.map(async (c) => {
        try {
          await request(withParams(`${c.uri}/identity`, plexParams(server.token)), { timeout });
          return c;
        } catch {
          return null;
        }
      }),
    )
  )
    .filter(Boolean)
    .sort((a, b) => rank(a) - rank(b));
  const best = alive[0];
  if (!best) return null;
  return { uri: best.uri, kind: best.relay ? 'relay' : best.local ? 'local' : 'remote' };
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
  };
}

export function ultraBlurOf(item) {
  const c = asArray(item?.UltraBlurColors)[0];
  return c && c.topLeft ? c : null;
}

// ---------- Plex Media Server ----------

export class PlexServer {
  constructor({ uri, token, name, id }) {
    this.uri = uri.replace(/\/+$/, '');
    this.token = token;
    this.name = name || 'Plex Media Server';
    this.id = id || null;
    this.cache = new Map();
  }

  url(path, params = {}) {
    return withParams(this.uri + path, { ...plexParams(this.token), ...params });
  }

  async get(path, params, opts) {
    const data = await request(this.url(path, params), opts);
    return data.MediaContainer || {};
  }

  // Small memo for data that rarely changes during a session.
  memo(key, fn, ttl = 60000) {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < ttl) return hit.value;
    const value = fn().catch((err) => {
      this.cache.delete(key);
      throw err;
    });
    this.cache.set(key, { at: Date.now(), value });
    return value;
  }

  identity(opts) {
    return this.get('/identity', null, opts);
  }

  async musicSections() {
    const mc = await this.get('/library/sections');
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

  // Page through any listing path the server hands us (e.g. a genre's fastKey).
  async byPath(path, { start = 0, size = 60 } = {}) {
    const mc = await this.get(path, { 'X-Plex-Container-Start': start, 'X-Plex-Container-Size': size });
    return { items: asArray(mc.Metadata), total: mc.totalSize ?? mc.size ?? 0 };
  }

  async metadata(id) {
    const mc = await this.get(`/library/metadata/${id}`);
    return asArray(mc.Metadata)[0] || null;
  }

  async children(id) {
    return asArray((await this.get(`/library/metadata/${id}/children`)).Metadata);
  }

  async allLeaves(id) {
    return asArray((await this.get(`/library/metadata/${id}/allLeaves`)).Metadata);
  }

  // Secondary listings: genre, style, mood, decade... filtered by item type.
  tags(section, field, type) {
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

  playlists() {
    return this.memo('playlists', async () =>
      asArray((await this.get('/playlists', { playlistType: 'audio' })).Metadata),
    );
  }

  async playlist(id) {
    return asArray((await this.get(`/playlists/${id}`)).Metadata)[0] || null;
  }

  async playlistItems(id, { start = 0, size = 100 } = {}) {
    const mc = await this.get(`/playlists/${id}/items`, {
      'X-Plex-Container-Start': start,
      'X-Plex-Container-Size': size,
    });
    return { items: asArray(mc.Metadata), total: mc.totalSize ?? mc.leafCount ?? mc.size ?? 0 };
  }

  async search(query, section, { signal, limit = 10 } = {}) {
    const mc = await this.get('/hubs/search', { query, sectionId: section, limit }, { signal });
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

  ultraBlur(thumb) {
    return this.memo(
      `ub:${thumb}`,
      async () => asArray((await this.get('/services/ultrablur/colors', { url: thumb })).UltraBlurColors)[0] || null,
      60 * 60000,
    );
  }

  // Tell the server what is playing. This drives play counts, "recent plays"
  // and the Now Playing view on the Plex dashboard.
  timeline(track, state, timeMs) {
    const url = this.url('/:/timeline', {
      ratingKey: track.id,
      key: `/library/metadata/${track.id}`,
      identifier: 'com.plexapp.plugins.library',
      state,
      time: Math.max(0, Math.round(timeMs)),
      duration: track.duration || undefined,
    });
    return fetch(url, { headers: { Accept: 'application/json' }, keepalive: true }).catch(() => {});
  }

  art(path, size = 300) {
    if (!path) return '';
    if (/^https?:/.test(path)) return path;
    return this.url('/photo/:/transcode', { width: size, height: size, minSize: 1, upscale: 1, url: path });
  }

  // The original file, played as-is by the browser.
  directUrl(track) {
    return track.partKey ? this.url(track.partKey) : null;
  }

  // Server-side conversion for formats the browser can't decode, or to save
  // data. Uses the same universal transcoder endpoint as python-plexapi.
  transcodeUrl(track, bitrate = 320) {
    return this.url('/audio/:/transcode/universal/start.m3u8', {
      path: `/library/metadata/${track.id}`,
      mediaIndex: 0,
      partIndex: 0,
      protocol: 'hls',
      directPlay: 0,
      directStream: 0,
      directStreamAudio: 0,
      hasMDE: 1,
      musicBitrate: bitrate,
      transcodeSessionId: `${clientId()}-${track.id}`,
      'X-Plex-Session-Identifier': clientId(),
      'X-Plex-Client-Profile-Extra':
        'add-transcode-target(type=musicProfile&context=streaming&protocol=hls&container=mpegts&audioCodec=aac,mp3)',
    });
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
