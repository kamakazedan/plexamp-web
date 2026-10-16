// Who is this? Answers it for the service from a Plex token, using plex.tv:
// the account behind a token, the servers it can use, and its friends.
// Tokens are only held as SHA-256 hashes, as cache keys.
import { createHash, randomBytes } from 'node:crypto';
import { log } from './log.js';

const CLIENT_ID = `plexamp-web-service-${randomBytes(6).toString('hex')}`;
const TOKEN_SHAPE = /^[A-Za-z0-9_.~-]{1,200}$/;

export class AuthError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const validToken = (t) => typeof t === 'string' && TOKEN_SHAPE.test(t);
const hash = (t) => createHash('sha256').update(t).digest('hex');

// A small cache with expiry and a size cap.
class TTLCache {
  constructor(max = 2000) {
    this.max = max;
    this.map = new Map();
  }
  get(key) {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (hit.exp < Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    return hit.value;
  }
  set(key, value, ttl) {
    if (this.map.size >= this.max) this.map.delete(this.map.keys().next().value);
    this.map.set(key, { value, exp: Date.now() + ttl });
  }
}

const decodeXml = (s) =>
  s.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, (m, e) => {
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e.toLowerCase()];
    if (named) return named;
    const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : m;
  });

export function attrs(tag) {
  const out = {};
  for (const m of tag.matchAll(/([\w:-]+)="([^"]*)"/g)) out[m[1]] = decodeXml(m[2]);
  return out;
}

const safeThumb = (url) => (typeof url === 'string' && /^https:\/\/([a-z0-9-]+\.)*plex\.tv\//i.test(url) ? url.slice(0, 500) : null);
const cleanName = (s) => String(s || '').replace(/[\u0000-\u001f]/g, '').slice(0, 80);

export class PlexAuth {
  constructor({ plexTvUrl = 'https://plex.tv', plexServerUrl = '' } = {}) {
    this.plexTv = plexTvUrl.replace(/\/+$/, '');
    this.pms = plexServerUrl.replace(/\/+$/, '');
    this.users = new TTLCache();
    this.denied = new TTLCache();
    this.access = new TTLCache();
    this.friendLists = new TTLCache(200);
    this.resourceLists = new TTLCache(500);
    this.serverId = null;
  }

  async fetchJSON(url, token, { timeout = 10000, accept = 'application/json' } = {}) {
    const headers = {
      Accept: accept,
      'X-Plex-Product': 'plexamp-web',
      'X-Plex-Client-Identifier': CLIENT_ID,
    };
    if (token) headers['X-Plex-Token'] = token;
    let res;
    try {
      res = await fetch(url, { headers, signal: AbortSignal.timeout(timeout) });
    } catch (err) {
      throw Object.assign(new Error(`couldn't reach ${new URL(url).host}: ${err.cause?.code || err.name || 'network error'}`), { network: true });
    }
    if (res.status === 401 || res.status === 403 || res.status === 422) throw new AuthError(401, 'Plex didn’t accept this sign-in.');
    if (!res.ok) throw Object.assign(new Error(`${new URL(url).host} answered ${res.status}`), { upstream: res.status });
    return accept === 'application/json' ? res.json() : res.text();
  }

  // The Plex server this container fronts (PLEX_SERVER_URL), by machine ID.
  // Asked again at most every 15 seconds while the server doesn't answer.
  async loadServerId() {
    if (this.serverId || !this.pms) return this.serverId;
    if (Date.now() < (this.identityRetryAt || 0)) return null;
    this.identityProbe ||= (async () => {
      try {
        const data = await this.fetchJSON(`${this.pms}/identity`, null, { timeout: 5000 });
        this.serverId = data?.MediaContainer?.machineIdentifier || null;
        if (this.serverId) log.debug(`Plex server at PLEX_SERVER_URL is ${this.serverId}`);
      } catch (err) {
        log.debug(`couldn't read the Plex server's identity yet: ${err.message}`);
      }
      if (!this.serverId) this.identityRetryAt = Date.now() + 15000;
      return this.serverId;
    })().finally(() => {
      this.identityProbe = null;
    });
    return this.identityProbe;
  }

  // The plex.tv account behind a token: { id, uuid, username, title, thumb }.
  async identify(token) {
    if (!validToken(token)) throw new AuthError(401, 'Sign in to Plex first.');
    const key = hash(token);
    const hit = this.users.get(key);
    if (hit) return hit;
    if (this.denied.get(key)) throw new AuthError(401, 'Plex didn’t accept this sign-in.');
    try {
      const u = await this.fetchJSON(`${this.plexTv}/api/v2/user`, token);
      if (!u || u.id == null) throw new AuthError(401, 'Plex didn’t accept this sign-in.');
      const user = {
        id: Number(u.id),
        uuid: String(u.uuid || ''),
        username: cleanName(u.username),
        title: cleanName(u.friendlyName || u.title || u.username || 'Plex user'),
        thumb: safeThumb(u.thumb),
      };
      this.users.set(key, user, 15 * 60000);
      return user;
    } catch (err) {
      if (err instanceof AuthError) this.denied.set(key, true, 60000);
      throw err;
    }
  }

  // Can this token use the Plex server with this machine ID, and does its
  // account own it? { ok, owned }
  async serverAccess(token, serverId) {
    if (!serverId) return { ok: false, owned: false };
    const key = `${hash(token)}|${serverId}`;
    const hit = this.access.get(key);
    if (hit !== undefined) return hit;
    const list = await this.fetchJSON(`${this.plexTv}/api/v2/resources?includeHttps=1`, token);
    const r = (Array.isArray(list) ? list : []).find(
      (x) => x?.clientIdentifier === serverId && String(x.provides || '').split(',').includes('server'),
    );
    const access = { ok: !!r, owned: !!r?.owned };
    this.access.set(key, access, 10 * 60000);
    return access;
  }

  // The account's servers and devices on plex.tv, with their connections
  // (for casting to its players). Kept for a minute.
  async resources(token) {
    const key = hash(token);
    const hit = this.resourceLists.get(key);
    if (hit) return hit;
    const list = await this.fetchJSON(`${this.plexTv}/api/v2/resources?includeHttps=1&includeRelay=0&includeIPv6=1`, token);
    const out = Array.isArray(list) ? list.slice(0, 200) : [];
    this.resourceLists.set(key, out, 60000);
    return out;
  }

  async canUseServer(token, serverId) {
    return (await this.serverAccess(token, serverId)).ok;
  }

  // A Plex server can be set to let some networks in without signing in
  // ("List of IP addresses and networks that are allowed without auth").
  // If this container is on such a network, the server accepts any token, so
  // asking it whether a token is good proves nothing. Checked with a random
  // token, and remembered for ten minutes.
  async serverIsOpen() {
    if (!this.pms) return false;
    const hit = this.access.get('pms-open');
    if (hit !== undefined) return hit;
    this.openProbe ||= (async () => {
      let open;
      try {
        await this.fetchJSON(`${this.pms}/library/sections?X-Plex-Container-Size=0`, `pw-probe-${randomBytes(12).toString('hex')}`, { timeout: 8000 });
        open = true;
      } catch (err) {
        if (!(err instanceof AuthError)) {
          // Couldn't tell (the server is down or slow). Remembered briefly,
          // so requests don't each wait for another try.
          this.access.set('pms-open', null, 15000);
          throw err;
        }
        open = false;
      }
      if (open && this.access.get('pms-open-warned') === undefined) {
        this.access.set('pms-open-warned', true, 6 * 3600000);
        log.warn(
          'the Plex server at PLEX_SERVER_URL lets this container in without signing in (its "List of IP addresses and networks that are allowed without auth" includes this container). ' +
            'Plex can treat requests from such a network as yours, whoever sends them, so requests to /pms/ are now checked with plex.tv and only your own Plex sign-in gets through; friends are refused there until this is fixed. ' +
            'To fix it, remove this container\'s address from that list in Plex (Settings > Network).',
        );
      }
      this.access.set('pms-open', open, 10 * 60000);
      return open;
    })().finally(() => {
      this.openProbe = null;
    });
    return this.openProbe;
  }

  // Does the Plex server at PLEX_SERVER_URL accept this token? Used when
  // plex.tv can't vouch for it (a server token rather than an account token,
  // or plex.tv unreachable), and never when the server accepts anything.
  async serverAccepts(token) {
    if (!this.pms || !validToken(token)) return false;
    if (await this.serverIsOpen()) return false;
    const key = `pms|${hash(token)}`;
    const hit = this.access.get(key);
    if (hit !== undefined) return hit;
    try {
      await this.fetchJSON(`${this.pms}/library/sections?X-Plex-Container-Size=0`, token, { timeout: 8000 });
      this.access.set(key, true, 2 * 60000);
      return true;
    } catch (err) {
      if (err instanceof AuthError) {
        this.access.set(key, false, 60000);
        return false;
      }
      throw err;
    }
  }

  // Friends and Plex Home users, with the servers each can use.
  async friends(token) {
    const key = hash(token);
    const hit = this.friendLists.get(key);
    if (hit) return hit;
    const xml = await this.fetchJSON(`${this.plexTv}/api/users`, token, { accept: 'application/xml' });
    const users = [];
    for (const m of String(xml).matchAll(/<User\b([^>]*?)(\/>|>([\s\S]*?)<\/User>)/g)) {
      const a = attrs(m[1]);
      if (!a.id) continue;
      const servers = [...String(m[3] || '').matchAll(/<Server\b([^>]*)\/?>/g)].map((s) => attrs(s[1]).machineIdentifier).filter(Boolean);
      users.push({
        id: Number(a.id),
        title: cleanName(a.title || a.username || 'Plex user'),
        username: cleanName(a.username),
        thumb: safeThumb(a.thumb),
        home: a.home === '1',
        servers,
      });
    }
    this.friendLists.set(key, users, 5 * 60000);
    return users;
  }
}
