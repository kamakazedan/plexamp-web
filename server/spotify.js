// Spotify playlists, read for Search › From Spotify by link
// (SPOTIFY_LINK_IMPORT, or SPOTIFY_IMPORT as before 0.22.0: off unless
// whoever runs the player turns it on). Spotify's API only gives a
// playlist's tracks to the account that owns it, so its name and tracks are
// read from the page Spotify shows anyone for it instead: its embed player,
// which lists the first 100 tracks at most. That page isn't an API: Spotify
// can change it, and its terms don't allow reading it like this, which is
// why it's off to begin with.
//
// Only the playlist's id goes to Spotify, from the container: nothing about
// who asked, or their library. The page is read with a time limit and a size
// limit, from a fixed address, following redirects only within it, and only
// plain text and numbers come out of it. What it said is kept for 10 minutes.
export const SPOTIFY_LIMITS = {
  timeoutMs: 15000,
  bytes: 5 * 1024 * 1024, // the page
  shortBytes: 512 * 1024, // a short link's page
  tracks: 1000,
  keepMs: 10 * 60 * 1000,
  kept: 50,
  redirects: 2,
  shown: 100, // the most the page lists
};

export class SpotifyError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const ID = /^[A-Za-z0-9]{22}$/;
const NOT_A_LINK = 'That isn’t a link to a Spotify playlist. In Spotify, choose Share › Copy link to playlist, and paste that.';

// A playlist's id from what was pasted: its link
// (https://open.spotify.com/playlist/ID?si=…, with /intl-xx/ or /embed/ or
// not), a spotify:playlist:ID URI, or the id alone. null for anything else.
export function playlistId(text) {
  const s = String(text ?? '').trim();
  if (!s || s.length > 500) return null;
  if (ID.test(s)) return s;
  let m = /^spotify:(?:user:[^:\s]{1,100}:)?playlist:([A-Za-z0-9]{22})$/.exec(s);
  if (m) return m[1];
  let url;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  if (!['https:', 'http:'].includes(url.protocol) || !/^(open|play)\.spotify\.com$/i.test(url.hostname) || url.username || url.password) return null;
  m = /^\/(?:intl-[a-z]{2}(?:-[a-z0-9]{2,4})?\/)?(?:embed\/)?(?:user\/[^/]{1,100}\/)?playlist\/([A-Za-z0-9]{22})\/?$/i.exec(url.pathname);
  return m ? m[1] : null;
}

// A short link from Spotify's share sheet (https://spotify.link/CODE): its
// code, or null.
export function shortCode(text) {
  let url;
  try {
    url = new URL(String(text ?? '').trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'spotify.link' || url.username || url.password) return null;
  const m = /^\/([A-Za-z0-9_-]{4,40})\/?$/.exec(url.pathname);
  return m ? m[1] : null;
}

// ---------- the page ----------

const SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const hasId = (attrs, id) => new RegExp(`\\bid\\s*=\\s*["']${id}["']`, 'i').test(attrs);
const BASE64 = /^[A-Za-z0-9+/=\s]+$/;

const fromBase64 = (body) => JSON.parse(Buffer.from(body.trim(), 'base64').toString('utf8'));

// JSON, or base64 JSON, or null.
function anyJson(body) {
  try {
    return JSON.parse(body);
  } catch {
    /* not plain JSON */
  }
  if (!BASE64.test(body)) return null;
  try {
    return fromBase64(body);
  } catch {
    return null;
  }
}

const isPlaylist = (d) => !!d && typeof d === 'object' && (d.type === 'playlist' || String(d.uri || '').startsWith('spotify:playlist:')) && Array.isArray(d.trackList);

// The first playlist with a track list in what a script holds (not far down).
function findPlaylist(d, depth = 0) {
  if (!d || typeof d !== 'object' || depth > 8) return null;
  if (isPlaylist(d)) return d;
  for (const v of Array.isArray(d) ? d : Object.values(d)) {
    const hit = findPlaylist(v, depth + 1);
    if (hit) return hit;
  }
  return null;
}

// The playlist in Spotify's embed page, wherever Spotify has put it over the
// years: JSON in a __NEXT_DATA__ script (props.pageProps.state.data.entity),
// base64 JSON in an initial-state (data.entity) or resource script, or any
// other script holding a playlist with its track list. null if none does.
export function embedPlaylist(html) {
  for (const [, attrs, body] of String(html).matchAll(SCRIPT)) {
    if (!body.trim() || /\bsrc\s*=/i.test(attrs)) continue;
    let data = null;
    try {
      if (hasId(attrs, '__NEXT_DATA__')) data = JSON.parse(body)?.props?.pageProps?.state?.data?.entity;
      else if (hasId(attrs, 'initial-state')) data = fromBase64(body)?.data?.entity;
      else if (hasId(attrs, 'resource')) data = fromBase64(body);
      if (!isPlaylist(data)) data = findPlaylist(data ?? anyJson(body));
    } catch {
      data = null;
    }
    if (isPlaylist(data)) return data;
  }
  return null;
}

// Plain text: no control characters, one line, at most n characters.
const plain = (v, n) =>
  typeof v === 'string'
    ? v
        .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, n)
    : '';

const millis = (v) => {
  const n = typeof v === 'number' ? v : typeof v?.totalMilliseconds === 'number' ? v.totalMilliseconds : NaN;
  return Number.isFinite(n) && n > 0 && n < 48 * 3600 * 1000 ? Math.round(n) : undefined;
};

// A track as the app gets it: { title, artist (all of them, as Spotify
// lists them), artists (one by one, when the page names them so), album
// (when it says), duration (ms) }. Podcast episodes and the like are left
// out, and so is anything without a title.
export function trackOf(t) {
  if (!t || typeof t !== 'object') return null;
  const uri = String(t.uri || '');
  if (uri && !/^spotify:(track|local):/.test(uri)) return null;
  const title = plain(t.title ?? t.name, 300);
  if (!title) return null;
  const names = (Array.isArray(t.artists) ? t.artists : [])
    .map((a) => plain(a?.name, 200))
    .filter(Boolean)
    .slice(0, 10);
  const artist = names.length ? names.join(', ') : plain(t.subtitle, 400);
  const album = plain(typeof t.album === 'string' ? t.album : t.album?.name, 300);
  const out = { title, artist };
  if (names.length) out.artists = names;
  if (album) out.album = album;
  const duration = millis(t.duration);
  if (duration) out.duration = duration;
  return out;
}

// ---------- reading it ----------

export class Spotify {
  constructor({ base = 'https://open.spotify.com', shortBase = 'https://spotify.link', version = '', fetchImpl = globalThis.fetch, log } = {}) {
    this.base = String(base).replace(/\/+$/, '');
    this.shortBase = String(shortBase).replace(/\/+$/, '');
    this.fetch = fetchImpl;
    this.agent = `plexamp-web${/^[0-9][0-9.]*$/.test(version) ? `/${version}` : ''} (+https://github.com/kamakazedan/plexamp-web)`;
    this.log = log;
    this.kept = new Map(); // id -> { data, at }
    this.warned = 0;
  }

  // GET `url`: { status, body, location } (location: where it redirects,
  // when that's somewhere else). Redirects are followed only within the
  // address asked; nothing is sent but the request itself (no cookies), and
  // at most `limit` bytes are read.
  async get(url, { signal, limit = SPOTIFY_LIMITS.bytes } = {}) {
    const origin = new URL(url).origin;
    let at = url;
    for (let hop = 0; hop <= SPOTIFY_LIMITS.redirects; hop++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), SPOTIFY_LIMITS.timeoutMs);
      const stop = () => ctrl.abort();
      signal?.addEventListener('abort', stop, { once: true });
      try {
        const res = await this.fetch(at, {
          headers: { Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en', 'User-Agent': this.agent },
          redirect: 'manual',
          signal: ctrl.signal,
        });
        if (res.status >= 300 && res.status < 400) {
          res.body?.cancel?.().catch?.(() => {});
          const next = new URL(res.headers.get('location') || '', at);
          if (next.origin !== origin) return { status: res.status, body: '', location: next.href };
          at = next.href;
          continue;
        }
        return { status: res.status, body: res.status === 200 ? await readUpTo(res, limit) : '', location: null };
      } catch (err) {
        if (err instanceof SpotifyError) throw err;
        throw new SpotifyError(502, signal?.aborted ? 'Stopped.' : 'Spotify couldn’t be reached from this player.');
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', stop);
      }
    }
    throw new SpotifyError(502, 'Spotify sent the request round in circles.');
  }

  // The playlist a short link (spotify.link) leads to: its id, or null.
  async resolveShort(text, { signal } = {}) {
    const code = shortCode(text);
    if (!code) return null;
    const page = await this.get(`${this.shortBase}/${code}`, { signal, limit: SPOTIFY_LIMITS.shortBytes });
    const id = playlistId(page.location || '') || (/https?:\/\/open\.spotify\.com\/(?:intl-[a-z-]{2,8}\/)?playlist\/([A-Za-z0-9]{22})/.exec(page.body) || [])[1];
    return id || null;
  }

  // A public playlist: { id, name, owner, tracks: [trackOf], capped: the
  // page listed as many as it lists, so there may be more }.
  async playlist(id, { signal } = {}) {
    if (!ID.test(String(id))) throw new SpotifyError(400, NOT_A_LINK);
    const hit = this.kept.get(id);
    if (hit && Date.now() - hit.at < SPOTIFY_LIMITS.keepMs) return hit.data;
    const page = await this.get(`${this.base}/embed/playlist/${id}`, { signal });
    if (page.status === 404 || page.status === 400) {
      throw new SpotifyError(404, 'Spotify has no public playlist at that link. Only public playlists can be read: in Spotify, its ⋯ menu has Make public.');
    }
    if (page.status === 429) throw new SpotifyError(503, 'Spotify asked this player to slow down. Try again in a few minutes.');
    if (page.status !== 200) throw new SpotifyError(502, `Spotify answered ${page.status}${page.location ? ' (a redirect elsewhere)' : ''}.`);
    const found = embedPlaylist(page.body);
    if (!found) {
      // (Said at most once an hour: a private playlist's page can look the same.)
      if (Date.now() - this.warned > 3600 * 1000) {
        this.warned = Date.now();
        this.log?.warn?.('spotify: a playlist’s page didn’t have its tracks in it (a private playlist, or Spotify may have changed the page)');
      }
      throw new SpotifyError(502, 'Spotify’s page for that playlist didn’t have its tracks in it. It may be private (only public playlists can be read), or Spotify may have changed the page: then try again later, or update plexamp-web.');
    }
    const tracks = found.trackList.slice(0, SPOTIFY_LIMITS.tracks).map(trackOf).filter(Boolean);
    const owner = plain(found.subtitle || found.authors?.[0]?.name || found.ownerV2?.data?.name || '', 120);
    const data = { id, name: plain(found.name || found.title, 200) || 'Spotify playlist', owner, tracks, capped: found.trackList.length >= SPOTIFY_LIMITS.shown };
    this.kept.delete(id);
    this.kept.set(id, { data, at: Date.now() });
    while (this.kept.size > SPOTIFY_LIMITS.kept) this.kept.delete(this.kept.keys().next().value);
    return data;
  }
}

// A response's text, at most `limit` bytes of it (the rest isn't read).
async function readUpTo(res, limit) {
  if (!res.body?.getReader) {
    const text = await res.text();
    return text.slice(0, limit);
  }
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      reader.cancel().catch(() => {});
      throw new SpotifyError(502, 'Spotify’s page for that playlist was far bigger than expected.');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

export { NOT_A_LINK };
