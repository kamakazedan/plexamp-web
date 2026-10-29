// Who is this? Answers it for the service from a Plex token, using plex.tv:
// the account behind a token, the servers it can use, and its friends.
// Tokens are only held as SHA-256 hashes, as cache keys.
import { createHash, randomBytes } from 'node:crypto';
import { request as httpRequest, Agent as HttpAgent } from 'node:http';
import { request as httpsRequest, Agent as HttpsAgent } from 'node:https';
import { isIP } from 'node:net';
import { checkServerIdentity } from 'node:tls';
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
// (The same, for owners.js: what's kept of the owner's sign-ins.)
export const fingerprintOf = hash;

// plex.tv, as last heard (see PlexAuth.tvAnswered): while it isn't answering,
// it's asked again at most every retryMs (and pinged at most every pingMs),
// so nothing waits on it. (Shorter in tests.)
export const PLEX_TV_TIMING = { retryMs: 15000, pingMs: 20000 };

// What only a Plex server's owner may see: its settings, and who's playing
// what. Asked with a sign-in, a server that shows it either takes the
// sign-in for its owner's (see showsOwnersOnly).
const OWNERS_ONLY = ['/:/prefs', '/status/sessions?X-Plex-Container-Size=0'];

// ---------- the Plex server at PLEX_SERVER_URL ----------

// A Plex server's certificate is for its plex.direct name
// (*.<its id>.plex.direct), so at a network address such as
// https://10.10.10.100:32400 the name never matches. There, a certificate
// that's otherwise valid (from a trusted authority, in date: Node checks that
// before this is asked) is accepted when it's a plex.direct one, which only
// Plex servers have. Anything else is checked as usual.
export function isPlexDirectCert(cert) {
  const names = String(cert?.subjectaltname || '')
    .split(/,\s*/)
    .filter((n) => n.startsWith('DNS:'))
    .map((n) => n.slice(4).toLowerCase());
  return names.some((n) => /^\*\.[a-z0-9-]+\.plex\.direct$/.test(n));
}

export function plexServerIdentity(host, cert) {
  const err = checkServerIdentity(host, cert);
  if (err && isIP(host) && isPlexDirectCert(cert)) return undefined;
  return err;
}

// Certificate problems, in words (for the log).
const CERT_PROBLEMS = {
  ERR_TLS_CERT_ALTNAME_INVALID: 'its certificate is for another name',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'its certificate is self-signed',
  SELF_SIGNED_CERT_IN_CHAIN: 'its certificate is self-signed',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'its certificate isn’t from an authority this container trusts',
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: 'its certificate isn’t from an authority this container trusts',
  CERT_HAS_EXPIRED: 'its certificate has expired',
  CERT_NOT_YET_VALID: 'its certificate isn’t valid yet',
};
export const certProblem = (code) => CERT_PROBLEMS[code] || null;

const MAX_PMS_ANSWER = 2 * 1024 * 1024;
const MAX_PLEX_TV_ANSWER = 8 * 1024 * 1024; // a big account's friends, say
const PLEX_TV_AT_ONCE = 16; // questions for plex.tv under way at once (the rest wait)
const PLEX_TV_WAITING = 200; // waiting at most (any more are told plex.tv is busy)
const PLEX_TV_WAIT_MS = 15000; // and each for this long at most
// (Requests to /pms/ from anyone but the owner ask the server something
// first: see openNow and showsOwnersOnly.)
const pmsAgents = { 'http:': new HttpAgent({ keepAlive: true, maxSockets: 24 }), 'https:': new HttpsAgent({ keepAlive: true, maxSockets: 24 }) };

// GET from the Plex server, with its certificate checked as above.
function pmsGet(url, headers, timeout) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const send = u.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = send(u, { method: 'GET', headers, agent: pmsAgents[u.protocol], checkServerIdentity: plexServerIdentity }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_PMS_ANSWER) req.destroy(Object.assign(new Error('answer too long'), { code: 'TOO_LONG' }));
        else chunks.push(c);
      });
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.setTimeout(timeout, () => req.destroy(Object.assign(new Error('timed out'), { code: 'TimeoutError' })));
    req.on('error', reject);
    req.end();
  });
}

// An answer's body, up to `max` bytes (more is an error, not cut short).
export async function readCapped(res, max) {
  const reader = res.body?.getReader?.();
  if (!reader) return String((await res.text?.()) ?? '').slice(0, max);
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      reader.cancel().catch(() => {});
      throw Object.assign(new Error('answer too long'), { code: 'TOO_LONG' });
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

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
    this.identifying = new Map(); // token hash -> its check under way (asked once, however many requests wait)
    this.asking = 0; // questions for plex.tv under way
    this.queue = []; // and those waiting for one to finish
    // plex.tv: whether it's answering, since when, and when it was last
    // asked anything.
    this.tv = { down: false, since: Date.now(), tried: 0, pinged: 0 };
    this.tvListeners = [];
    this.askingOwnersOnly = new Map(); // token hash -> the server being asked (see showsOwnersOnly)
  }

  // ---------- plex.tv, as last heard ----------

  // Any answer from plex.tv but a server error says it's answering; no
  // answer at all (or a server error) says it isn't.
  tvAnswered(ok) {
    if (ok === !this.tv.down) return;
    this.tv = { ...this.tv, down: !ok, since: Date.now() };
    if (!ok) {
      log.warn('plex.tv isn’t answering this container: signing in with Plex, and what needs it, wait till it does');
    } else {
      log.info('plex.tv is answering this container again');
    }
    for (const fn of this.tvListeners) {
      try {
        fn(this.tv);
      } catch (err) {
        log.error(`plex.tv state: ${err.message}`);
      }
    }
  }

  onPlexTv(fn) {
    this.tvListeners.push(fn);
  }

  // Whether plex.tv isn't answering (`forMs`: and hasn't for that long),
  // asked afresh first where it was last heard from a while ago (`fresh`).
  async plexTvDown({ forMs = 0, fresh = false } = {}) {
    if (fresh && Date.now() - Math.max(this.tv.tried, this.tv.pinged) > PLEX_TV_TIMING.pingMs) await this.pingPlexTv();
    return this.tv.down && Date.now() - this.tv.since >= forMs;
  }

  // Whether plex.tv has been answering for at least `forMs`.
  plexTvUpFor(forMs) {
    return !this.tv.down && Date.now() - this.tv.since >= forMs;
  }

  // (Asked once however many wait for it.)
  async pingPlexTv() {
    this.tv.pinged = Date.now();
    this.pinging ||= this.fetchJSON(`${this.plexTv}/api/v2/ping`, null, { timeout: 8000, ping: true })
      .catch(() => {
        /* said by fetchJSON */
      })
      .finally(() => {
        this.pinging = null;
      });
    await this.pinging;
    return !this.tv.down;
  }

  // While plex.tv isn't answering: asked again in the background, every so
  // often, so it's heard as soon as it's back.
  nudgePlexTv() {
    if (this.tv.down && Date.now() - Math.max(this.tv.tried, this.tv.pinged) > PLEX_TV_TIMING.pingMs) this.pingPlexTv();
  }

  // Whether this token has been checked lately (or is being checked now):
  // asking again costs plex.tv nothing.
  knows(token) {
    if (!validToken(token)) return true;
    const key = hash(token);
    return this.users.get(key) !== undefined || this.denied.get(key) !== undefined || this.identifying.has(key);
  }

  // At most PLEX_TV_AT_ONCE questions for plex.tv at a time, and a limited
  // number waiting, each for a limited time.
  async plexTvTurn(fn) {
    if (this.asking >= PLEX_TV_AT_ONCE) {
      if (this.queue.length >= PLEX_TV_WAITING) throw Object.assign(new Error('too many questions for plex.tv at once'), { code: 'BUSY' });
      await new Promise((go, giveUp) => {
        const turn = {
          go,
          timer: setTimeout(() => {
            this.queue.splice(this.queue.indexOf(turn), 1);
            giveUp(Object.assign(new Error('waited too long to ask plex.tv'), { code: 'BUSY' }));
          }, PLEX_TV_WAIT_MS),
        };
        this.queue.push(turn);
      });
    } else this.asking += 1;
    try {
      return await fn();
    } finally {
      // (The turn passes straight to whoever waited longest.)
      const next = this.queue.shift();
      if (next) {
        clearTimeout(next.timer);
        next.go();
      } else this.asking -= 1;
    }
  }

  // From plex.tv, or (`pms`) the Plex server at PLEX_SERVER_URL. (`ping`:
  // plex.tv's ping, asked even while it isn't answering.)
  async fetchJSON(url, token, { timeout = 10000, accept = 'application/json', ping = false, pms = false } = {}) {
    const headers = {
      Accept: accept,
      'X-Plex-Product': 'plexamp-web',
      'X-Plex-Client-Identifier': CLIENT_ID,
    };
    if (token) headers['X-Plex-Token'] = token;
    const host = new URL(url).host;
    const toPms = pms;
    let status;
    let text;
    try {
      if (toPms) {
        ({ status, text } = await pmsGet(url, headers, timeout));
      } else {
        // While plex.tv isn't answering, nothing waits on it: asked again
        // every few seconds, and pinged.
        if (this.tv.down && !ping && Date.now() - this.tv.tried < PLEX_TV_TIMING.retryMs) throw Object.assign(new Error('not answering lately'), { code: 'PLEX_TV_DOWN' });
        // Never followed elsewhere: the token goes to plex.tv and nowhere else.
        ({ status, text } = await this.plexTvTurn(async () => {
          this.tv.tried = Date.now();
          const res = await fetch(url, { headers, redirect: 'error', signal: AbortSignal.timeout(timeout) });
          return { status: res.status, text: await readCapped(res, MAX_PLEX_TV_ANSWER) };
        }));
        this.tvAnswered(status < 500);
      }
    } catch (err) {
      const code = err.cause?.code || err.code || err.name || 'network error';
      // (Not when it was this container that was too busy to ask.)
      if (!toPms && code !== 'BUSY' && code !== 'PLEX_TV_DOWN') this.tvAnswered(false);
      const problem = certProblem(code);
      // `busy`: this container had too many questions for plex.tv to ask
      // another; `down`: plex.tv isn't answering it.
      throw Object.assign(new Error(`couldn't reach ${host}: ${problem ? `${problem} (${code})` : code}`), {
        network: true,
        cert: !!problem,
        busy: code === 'BUSY',
        down: !toPms && code !== 'BUSY',
      });
    }
    if (!toPms && status >= 500) throw Object.assign(new Error(`${host} answered ${status}`), { upstream: status, down: true });
    if (status === 401 || status === 403 || status === 422) throw new AuthError(401, 'Plex didn’t accept this sign-in.');
    if (status < 200 || status > 299) throw Object.assign(new Error(`${host} answered ${status}`), { upstream: status });
    if (accept !== 'application/json') return text;
    try {
      return JSON.parse(text);
    } catch {
      throw Object.assign(new Error(`${host} didn’t answer with JSON`), { upstream: status });
    }
  }

  // The Plex server this container fronts (PLEX_SERVER_URL), by machine ID.
  // Asked again at most every 15 seconds while the server doesn't answer.
  async loadServerId() {
    if (this.serverId || !this.pms) return this.serverId;
    if (Date.now() < (this.identityRetryAt || 0)) return null;
    this.identityProbe ||= (async () => {
      try {
        const data = await this.fetchJSON(`${this.pms}/identity`, null, { timeout: 5000, pms: true });
        this.serverId = data?.MediaContainer?.machineIdentifier || null;
        if (this.serverId) log.debug(`Plex server at PLEX_SERVER_URL is ${this.serverId}`);
      } catch (err) {
        if (err.cert && !this.certWarned) {
          // Not going to fix itself: said once, whether or not debug mode is on.
          this.certWarned = true;
          log.warn(
            `couldn't check the Plex server at PLEX_SERVER_URL: ${err.message}. Until it can be, nothing goes through /pms/, and Play Together, your devices, shared playlists, the shared AI model, MusicBrainz checks and Play on can't be used. ` +
              'Use the server\'s http:// address in PLEX_SERVER_URL, or an address its certificate is for.',
          );
        } else {
          log.debug(`couldn't read the Plex server's identity yet: ${err.message}`);
        }
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
    if (this.identifying.has(key)) return this.identifying.get(key);
    const job = (async () => {
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
    })().finally(() => this.identifying.delete(key));
    this.identifying.set(key, job);
    return job;
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

  // Whether plex.tv said lately that this sign-in is the owner's of the Plex
  // server at PLEX_SERVER_URL: from what's kept of its answers (nothing is
  // asked, and nothing waits).
  ownerLately(token) {
    if (!this.serverId || !validToken(token)) return false;
    const key = hash(token);
    return this.users.get(key) !== undefined && this.access.get(`${key}|${this.serverId}`)?.owned === true;
  }

  // Does the Plex server show what's at `path` to this sign-in (null: to a
  // request without one)? true (it answers), false (it refuses), or an
  // error (it said neither).
  async pmsShows(path, token) {
    try {
      await this.fetchJSON(`${this.pms}${path}`, token, { timeout: 8000, pms: true });
      return true;
    } catch (err) {
      if (err instanceof AuthError) return false;
      throw err;
    }
  }

  // A Plex server can be set to let some networks in without signing in
  // ("List of IP addresses and networks that are allowed without auth").
  // If this container is on such a network, the server takes its requests
  // without a sign-in for its owner's, and may take those with one it
  // doesn't know (or anyone's) for its owner's too. Does it, right now?
  // Asked without a sign-in, so there's nothing for the server to check with
  // plex.tv, for each request that needs to know (those that come while
  // it's being asked share the answer): never taken from before, as the
  // owner can add this container to that list at any moment. Throws when the
  // server didn't say.
  async openNow() {
    if (!this.pms) return false;
    this.openAsking ||= this.pmsShows('/library/sections?X-Plex-Container-Size=0', null).finally(() => {
      this.openAsking = null;
    });
    return this.openAsking;
  }

  async serverIsOpen() {
    return this.openNow();
  }

  // The same, as found in the last ten minutes (`fresh`: found again now),
  // with whether the server can be asked about a sign-in: { open, tells }.
  // tells: it shows a request it takes for its owner's what only its owner
  // may see (see OWNERS_ONLY), so a sign-in it refuses those is one it
  // doesn't take for theirs (see showsOwnersOnly); an open server that
  // doesn't (one of those isn't there, say) can't be asked, and only its
  // owner gets through /pms/. Throws, for 15 seconds, while it can't be
  // found (the server doesn't answer).
  async serverState({ fresh = false } = {}) {
    if (!this.pms) return { open: false, tells: false };
    const hit = fresh ? undefined : this.access.get('pms-state');
    if (hit === null) throw Object.assign(new Error('the Plex server didn’t answer lately'), { network: true });
    if (hit !== undefined) return hit;
    this.stateProbe ||= (async () => {
      let state;
      try {
        const open = await this.openNow();
        // (Not there, or any other answer but one: it doesn't tell.)
        const tells = open && (await Promise.all(OWNERS_ONLY.map((p) => this.pmsShows(p, null).catch((err) => (err.upstream ? false : Promise.reject(err)))))).every(Boolean);
        state = { open, tells };
      } catch (err) {
        this.access.set('pms-state', null, 15000);
        throw err;
      }
      if (state.open && this.access.get('pms-open-warned') === undefined) {
        this.access.set('pms-open-warned', true, 6 * 3600000);
        log.warn(
          'the Plex server at PLEX_SERVER_URL lets this container in without signing in (its "List of IP addresses and networks that are allowed without auth" includes this container\'s address), ' +
            'so it can take requests from here for yours, whoever sends them. ' +
            (state.tells
              ? 'Each request to /pms/ from anyone but you is checked with the server first, with their own sign-in: it goes through only if the server refuses them what only you may see (it knows them as themselves), and never otherwise. '
              : 'This server can\'t be asked whether it knows someone else\'s sign-in as theirs, so only your own Plex sign-in gets through /pms/, and everyone else is refused. ') +
            'See "Offline mode" in docs/configuration.md.',
        );
      }
      this.access.set('pms-state', state, 10 * 60000);
      return state;
    })().finally(() => {
      this.stateProbe = null;
    });
    return this.stateProbe;
  }

  // Whether the server's being asked about this sign-in now (see below).
  askingAbout(token) {
    return validToken(token) && this.askingOwnersOnly.has(hash(token));
  }

  // Where the server lets this container in without signing in: does it,
  // asked with this sign-in, show it what only its owner may see? true: it
  // takes the sign-in for its owner's (it is, or the server doesn't know the
  // sign-in from here, or doesn't tell sign-ins apart from here at all).
  // false: it refused both, so it knows the sign-in as someone else's, and
  // treats them as themselves. Asked afresh for each request to /pms/
  // (requests that come while it's being asked share its answer), never
  // taken on trust from before: a sign-in the server stops knowing (its share
  // taken away, or the server can't ask plex.tv any more) is refused from
  // then on. Throws when the server said neither.
  async showsOwnersOnly(token) {
    if (!this.pms || !validToken(token)) return true;
    const key = hash(token);
    const asking = this.askingOwnersOnly.get(key);
    if (asking) return asking;
    const job = Promise.allSettled(OWNERS_ONLY.map((p) => this.pmsShows(p, token)))
      .then((answers) => {
        if (answers.some((a) => a.status === 'fulfilled' && a.value === true)) return true;
        const failed = answers.find((a) => a.status === 'rejected');
        if (failed) throw failed.reason;
        return false;
      })
      .finally(() => this.askingOwnersOnly.delete(key));
    this.askingOwnersOnly.set(key, job);
    return job;
  }

  // Does the Plex server at PLEX_SERVER_URL accept this token? Used when
  // plex.tv can't vouch for it (a server token rather than an account token,
  // or plex.tv unreachable), and never when the server lets this container
  // in without signing in (it accepts anything then).
  async serverAccepts(token) {
    if (!this.pms || !validToken(token)) return false;
    if (await this.openNow()) return false;
    const key = `pms|${hash(token)}`;
    const hit = this.access.get(key);
    if (hit !== undefined) return hit;
    const yes = await this.pmsShows('/library/sections?X-Plex-Container-Size=0', token);
    this.access.set(key, yes, yes ? 2 * 60000 : 60000);
    return yes;
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
