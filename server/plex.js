// Who is this? Answers it for the service from a Plex token, using plex.tv:
// the account behind a token, the servers it can use, and its friends.
// Tokens are only held as SHA-256 hashes, as cache keys.
import { createHash, randomBytes } from 'node:crypto';
import { Resolver } from 'node:dns/promises';
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
// first: see openNow and askOwnersOnly.)
const pmsAgents = {
  'http:': new HttpAgent({ keepAlive: true, maxSockets: 24 }),
  'https:': new HttpsAgent({ keepAlive: true, maxSockets: 24 }),
  nginx: new HttpAgent({ keepAlive: true, maxSockets: 24 }),
};

// GET from the Plex server: at its address (`url`), with its certificate
// checked as above, or through nginx (`socketPath`, and the request's
// `path`): see PlexAuth.pmsAnswer.
function pmsGet({ url, socketPath, path }, headers, timeout) {
  return new Promise((resolve, reject) => {
    const answered = (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_PMS_ANSWER) req.destroy(Object.assign(new Error('answer too long'), { code: 'TOO_LONG' }));
        else chunks.push(c);
      });
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    };
    let req;
    if (socketPath) {
      req = httpRequest({ socketPath, path, method: 'GET', headers, agent: pmsAgents.nginx }, answered);
    } else {
      const u = new URL(url);
      const send = u.protocol === 'https:' ? httpsRequest : httpRequest;
      req = send(u, { method: 'GET', headers, agent: pmsAgents[u.protocol], checkServerIdentity: plexServerIdentity }, answered);
    }
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
  // pmsProbe: nginx's socket for the service's own requests to the Plex
  // server (see pmsAnswer); without it (in tests), they go straight there.
  // pmsResolver: the name server nginx asks for the server's name, where it
  // looks it up for each request (see oneAddress). (`resolve4`: in tests.)
  constructor({ plexTvUrl = 'https://plex.tv', plexServerUrl = '', pmsProbe = '', pmsResolver = '', resolve4 = null } = {}) {
    this.plexTv = plexTvUrl.replace(/\/+$/, '');
    this.pms = plexServerUrl.replace(/\/+$/, '');
    this.pmsProbe = pmsProbe;
    // At an https:// network address, nginx can't check the server's
    // certificate (it's for the server's plex.direct name), so this does
    // (see loadServerId).
    let at = null;
    try {
      at = this.pms ? new URL(this.pms) : null;
    } catch {
      /* not an address: nothing reaches it */
    }
    this.pmsHost = at?.host || 'the Plex server';
    this.certHere = at?.protocol === 'https:' && isIP(at.hostname.replace(/^\[|\]$/g, '')) !== 0;
    this.pmsName = pmsResolver && at && isIP(at.hostname.replace(/^\[|\]$/g, '')) === 0 ? at.hostname : '';
    if (this.pmsName) {
      const r = new Resolver({ timeout: 3000, tries: 2 });
      try {
        r.setServers([pmsResolver]);
      } catch {
        /* one Node can't ask (an address with a zone in it, say): the system's */
      }
      this.resolve4 = resolve4 || ((name) => r.resolve4(name));
    }
    this.addresses = { seen: '', at: 0, many: 0, error: null };
    // (Looked up every few seconds, so a time it had more than one address is
    // seen, whatever's asked meanwhile.)
    if (this.pmsName) setInterval(() => this.lookUpAddresses(), 5000).unref();
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
    this.askingOwnersOnly = new Map(); // token hash -> the server being asked (see showsOwnersOnly)
    this.accessAsking = new Map(); // `${token hash}|${server}` -> plex.tv being asked (see serverAccess)
    // The Plex server, as last found (see ownersOnlyShown), and said.
    this.cantTellUntil = 0;
    this.tellsTroubleUntil = 0;
    this.cantTellSaidUntil = 0;
    this.openSaidUntil = 0;
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

  // From plex.tv. (`ping`: its ping, asked even while it isn't answering.)
  async fetchJSON(url, token, { timeout = 10000, accept = 'application/json', ping = false } = {}) {
    const headers = {
      Accept: accept,
      'X-Plex-Product': 'plexamp-web',
      'X-Plex-Client-Identifier': CLIENT_ID,
    };
    if (token) headers['X-Plex-Token'] = token;
    const host = new URL(url).host;
    let status;
    let text;
    try {
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
    } catch (err) {
      const code = err.cause?.code || err.code || err.name || 'network error';
      // (Not when it was this container that was too busy to ask.)
      if (code !== 'BUSY' && code !== 'PLEX_TV_DOWN') this.tvAnswered(false);
      const problem = certProblem(code);
      // `busy`: this container had too many questions for plex.tv to ask
      // another; `down`: plex.tv isn't answering it.
      throw Object.assign(new Error(`couldn't reach ${host}: ${problem ? `${problem} (${code})` : code}`), {
        network: true,
        cert: !!problem,
        busy: code === 'BUSY',
        down: code !== 'BUSY',
      });
    }
    if (status >= 500) throw Object.assign(new Error(`${host} answered ${status}`), { upstream: status, down: true });
    if (status === 401 || status === 403 || status === 422) throw new AuthError(401, 'Plex didn’t accept this sign-in.');
    if (status < 200 || status > 299) throw Object.assign(new Error(`${host} answered ${status}`), { upstream: status });
    if (accept !== 'application/json') return text;
    try {
      return JSON.parse(text);
    } catch {
      throw Object.assign(new Error(`${host} didn’t answer with JSON`), { upstream: status });
    }
  }

  // The Plex server this container fronts (PLEX_SERVER_URL), by machine ID:
  // nothing goes through /pms/ till it's known (see pmsAuth in index.js).
  // At an https:// network address, where nginx can't check the server's
  // certificate (it's for the server's plex.direct name), it's asked straight
  // there too (the same address), with its certificate checked (see
  // isPlexDirectCert). Asked again every couple of seconds while it isn't
  // known (with each request while nginx isn't there yet: it starts after
  // this; every 15 while its certificate doesn't check out).
  async loadServerId() {
    if (this.serverId || !this.pms) return this.serverId;
    if (Date.now() < (this.identityRetryAt || 0)) return null;
    this.identityProbe ||= (async () => {
      let again = 15000;
      try {
        const id = await this.identity();
        if (this.certHere && this.pmsProbe) {
          const there = await this.identity({ direct: true });
          if (there !== id) throw new Error(`the server at its address (${there}) isn't the one nginx reaches (${id})`);
        }
        this.serverId = id;
        log.debug(`Plex server at PLEX_SERVER_URL is ${this.serverId}`);
      } catch (err) {
        // (nginx not started yet: asked again with the next request, which
        // comes through nginx; the server not answering yet, starting
        // alongside, say: in two seconds; its certificate, which won't fix
        // itself: in fifteen.)
        if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') again = 0;
        else if (!err.cert) again = 2000;
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
      if (!this.serverId) this.identityRetryAt = Date.now() + again;
      return this.serverId;
    })().finally(() => {
      this.identityProbe = null;
    });
    return this.identityProbe;
  }

  // The server's machine ID, from its /identity (answered without signing
  // in), through nginx or (`direct`) straight there.
  async identity({ direct = false } = {}) {
    const { status, text } = await this.pmsAnswer('/identity', null, { timeout: 5000, direct });
    if (status !== 200) throw Object.assign(new Error(`${this.pmsHost} answered ${status}`), { upstream: status });
    let id = null;
    try {
      id = JSON.parse(text)?.MediaContainer?.machineIdentifier;
    } catch {
      /* said below */
    }
    if (typeof id !== 'string' || !id) throw new Error(`${this.pmsHost} didn’t say which Plex server it is`);
    return id;
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
    // (Asked once, however many requests wait for it.)
    if (this.accessAsking.has(key)) return this.accessAsking.get(key);
    const job = (async () => {
      const list = await this.fetchJSON(`${this.plexTv}/api/v2/resources?includeHttps=1`, token);
      const r = (Array.isArray(list) ? list : []).find(
        (x) => x?.clientIdentifier === serverId && String(x.provides || '').split(',').includes('server'),
      );
      const access = { ok: !!r, owned: !!r?.owned };
      this.access.set(key, access, 10 * 60000);
      return access;
    })().finally(() => this.accessAsking.delete(key));
    this.accessAsking.set(key, job);
    return job;
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

  // ---------- the Plex server, as nginx reaches it ----------

  // GET from the Plex server at PLEX_SERVER_URL: { status, text }, or an
  // error where nothing answered. Through nginx (pmsProbe: a socket of its
  // own for this, see 40-plexamp-web.sh), so it goes there the way requests
  // to /pms/ do: to the same address, from the same one, with the same
  // headers. The server judges by where a request comes from whether it
  // lets it in without signing in, so a check that went another way (over
  // IPv6, say, where nginx goes over IPv4) could be answered for somewhere
  // else. (`direct`: straight there, for its certificate: see loadServerId.
  // Straight there too without nginx, in tests.)
  async pmsAnswer(path, token, { timeout = 8000, direct = false } = {}) {
    const headers = { Accept: 'application/json', 'X-Plex-Product': 'plexamp-web', 'X-Plex-Client-Identifier': CLIENT_ID };
    if (token) headers['X-Plex-Token'] = token;
    const via = this.pmsProbe && !direct ? { socketPath: this.pmsProbe, path } : { url: `${this.pms}${path}` };
    try {
      return await pmsGet(via, headers, timeout);
    } catch (err) {
      const code = err.cause?.code || err.code || err.name || 'network error';
      const problem = certProblem(code);
      throw Object.assign(new Error(`couldn't reach ${this.pmsHost}${via.socketPath ? ' through nginx' : ''}: ${problem ? `${problem} (${code})` : code}`), {
        network: true,
        cert: !!problem,
        code,
      });
    }
  }

  // The status the server answers `path` with, to this sign-in (null: to a
  // request without one). Throws where it didn't answer, or had trouble of
  // its own (5xx: as nginx says where it can't reach the server).
  async pmsStatus(path, token) {
    const { status } = await this.pmsAnswer(path, token);
    if (status >= 500) throw Object.assign(new Error(`${this.pmsHost} answered ${status}`), { upstream: status });
    return status;
  }

  // Does it show what's at `path` to this sign-in? true (it answers), false
  // (it refuses), or an error (it said neither).
  async pmsShows(path, token) {
    const status = await this.pmsStatus(path, token);
    if (status >= 200 && status < 300) return true;
    if (status === 401 || status === 403 || status === 422) return false;
    throw Object.assign(new Error(`${this.pmsHost} answered ${status}`), { upstream: status });
  }

  // A Plex server can be set to let some networks in without signing in
  // ("List of IP addresses and networks that are allowed without auth").
  // If this container is on such a network, the server takes its requests
  // without a sign-in for its owner's, and may take those with one it
  // doesn't know (or anyone's) for its owner's too. Does it, right now?
  // Asked without a sign-in, so there's nothing for the server to check with
  // plex.tv, for each request that needs to know (those that come while
  // it's being asked share the answer): never taken from before, as the
  // owner can add this container to that list at any moment. Only Plex's own
  // refusal of such a request (401) is a no: anything else (a 403 from
  // something in front of the server that turns those away, say) says
  // nothing of whether the server lets this container in, so it throws, as
  // where the server didn't answer.
  async openNow() {
    if (!this.pms) return false;
    this.openAsking ||= this.oneAddress()
      .then(() => this.pmsStatus('/library/sections?X-Plex-Container-Size=0', null))
      .then((status) => {
        if (status >= 200 && status < 300) {
          this.saidOpen();
          return true;
        }
        if (status === 401) return false;
        throw Object.assign(new Error(`${this.pmsHost} answered ${status} to a request without a sign-in`), { upstream: status });
      })
      .finally(() => {
        this.openAsking = null;
      });
    return this.openAsking;
  }

  // Where PLEX_SERVER_URL is a name nginx looks up for each request: that it
  // has one address, and the same one as a moment ago (IPv4: as nginx is told
  // them, by the same name server). nginx keeps what it's told for 30
  // seconds, and with more than one address takes turns between them for
  // each request, so a request could go another way than the server was
  // asked by (from another of this container's addresses, say, as the server
  // sees it), and so it can't be asked whether it lets this container in:
  // that throws, while it's so and for a minute after (longer than nginx
  // keeps what it was told), as where the name can't be looked up. It's
  // looked up every few seconds whatever's asked (see lookUpAddresses), and
  // again here if it hasn't been for a second.
  async oneAddress() {
    if (!this.pmsName) return;
    if (Date.now() - this.addresses.at >= 1000) await this.lookUpAddresses();
    if (this.addresses.error) throw this.addresses.error;
    if (Date.now() >= this.addresses.many) return;
    if (Date.now() >= (this.manySaidUntil || 0)) {
      this.manySaidUntil = Date.now() + 6 * 3600000;
      log.warn(
        `PLEX_SERVER_URL's name (${this.pmsName}) has more than one address, or has just changed address, so nginx can reach the server either way: your Plex server judges by where a request comes from whether to let it in without signing in, so it can't be told from one request how it would take the next. ` +
          'While that\'s so (and for a minute after), only your own Plex sign-in gets through /pms/, and everyone else is refused. Use one fixed address in PLEX_SERVER_URL (the server\'s own, as http://192.168.1.10:32400).',
      );
    }
    throw Object.assign(new Error(`${this.pmsName} has more than one address, or has just changed address`), { network: true });
  }

  // (Asked once, however many wait for it.)
  lookUpAddresses() {
    this.addressesAsking ||= this.resolve4(this.pmsName)
      .then(
        (list) => {
          const seen = [...new Set(list)].sort().join(' ');
          if (seen.includes(' ') || (this.addresses.seen && seen !== this.addresses.seen)) this.addresses.many = Date.now() + 60000;
          this.addresses = { ...this.addresses, seen, at: Date.now(), error: null };
        },
        (err) => {
          this.addresses = { ...this.addresses, at: Date.now(), error: Object.assign(new Error(`couldn't look up ${this.pmsName}: ${err.code || err.message}`), { network: true }) };
        },
      )
      .finally(() => {
        this.addressesAsking = null;
      });
    return this.addressesAsking;
  }

  // (Said now and then.)
  saidOpen() {
    if (Date.now() < this.openSaidUntil) return;
    this.openSaidUntil = Date.now() + 6 * 3600000;
    log.warn(
      'the Plex server at PLEX_SERVER_URL lets this container in without signing in (its "List of IP addresses and networks that are allowed without auth" includes this container\'s address), ' +
        'so it can take requests from here for yours, whoever sends them. ' +
        'Each request to /pms/ from anyone but you is checked with the server first, with their own sign-in: it goes through only if the server refuses them what only you may see (it knows them as themselves), and never otherwise. ' +
        'See "Offline mode" in docs/configuration.md.',
    );
  }

  // Where it does: does it show a request it takes for its owner's (one
  // without a sign-in, from here) what only its owner may see (OWNERS_ONLY)?
  // Asked along with each sign-in's own question (see askOwnersOnly), there
  // and then, and shared by those asked at once. A server that doesn't (one
  // of those isn't there, say) can't be asked about sign-ins: that's kept for
  // ten minutes, and only its owner gets through /pms/ meanwhile. Throws where
  // the server didn't answer (and for 15 seconds after: it isn't asked again
  // meanwhile).
  async ownersOnlyShown() {
    if (!this.pms) return false;
    if (Date.now() < this.cantTellUntil) return false;
    if (Date.now() < this.tellsTroubleUntil) throw Object.assign(new Error(`${this.pmsHost} didn’t answer lately`), { network: true });
    this.tellsAsking ||= Promise.all(OWNERS_ONLY.map((p) => this.pmsStatus(p, null)))
      .then(
        (answers) => {
          const tells = answers.every((s) => s >= 200 && s < 300);
          if (!tells) this.cantTell(answers);
          return tells;
        },
        (err) => {
          this.tellsTroubleUntil = Date.now() + 15000;
          throw err;
        },
      )
      .finally(() => {
        this.tellsAsking = null;
      });
    return this.tellsAsking;
  }

  cantTell(answers) {
    this.cantTellUntil = Date.now() + 10 * 60000;
    if (Date.now() < this.cantTellSaidUntil) return;
    this.cantTellSaidUntil = Date.now() + 6 * 3600000;
    log.warn(
      `the Plex server at PLEX_SERVER_URL lets this container in without signing in, but doesn't show a request it takes for yours what only you may see (its settings and who's playing: it answered ${answers.join(' and ')}), ` +
        'so it can\'t be asked whether it knows someone else\'s sign-in as theirs: only your own Plex sign-in gets through /pms/, and everyone else is refused.',
    );
  }

  // Whether the server's being asked about this sign-in now (see below).
  askingAbout(token) {
    return validToken(token) && this.askingOwnersOnly.has(hash(token));
  }

  // Where it lets this container in without signing in: does it, asked with
  // this sign-in, show it what only its owner may see? true: it takes the
  // sign-in for its owner's (it is, or the server doesn't know the sign-in
  // from here, or doesn't tell sign-ins apart from here at all). false: it
  // refused both, as Plex refuses (401 or 403). Asked afresh for each request
  // to /pms/ (requests that come while it's being asked share its answer),
  // never taken on trust from before: a sign-in the server stops knowing (its
  // share taken away, or the server can't ask plex.tv any more) is refused
  // from then on. Throws when the server said neither.
  async showsOwnersOnly(token) {
    if (!this.pms || !validToken(token)) return true;
    const key = hash(token);
    const asking = this.askingOwnersOnly.get(key);
    if (asking) return asking;
    const job = Promise.allSettled(OWNERS_ONLY.map((p) => this.pmsStatus(p, token)))
      .then((answers) => {
        if (answers.some((a) => a.status === 'fulfilled' && a.value >= 200 && a.value < 300)) return true;
        const failed = answers.find((a) => a.status === 'rejected');
        if (failed) throw failed.reason;
        const other = answers.find((a) => a.value !== 401 && a.value !== 403);
        if (other) throw Object.assign(new Error(`${this.pmsHost} answered ${other.value}`), { upstream: other.value });
        return false;
      })
      .finally(() => this.askingOwnersOnly.delete(key));
    this.askingOwnersOnly.set(key, job);
    return job;
  }

  // Both, there and then: 'refused' (the server refused this sign-in what
  // only its owner may see, while it showed that to a request it takes for
  // its owner's: so it knows the sign-in as someone else's, and treats them
  // as themselves), 'shown' (it showed it either: it takes the sign-in for
  // its owner's), or 'cant-tell' (it doesn't show its owner that either, so a
  // refusal would say nothing). Throws when it didn't say.
  async askOwnersOnly(token) {
    if (!this.pms || !validToken(token) || Date.now() < this.cantTellUntil) return 'cant-tell';
    const [tells, mine] = await Promise.allSettled([this.ownersOnlyShown(), this.showsOwnersOnly(token)]);
    if (tells.status === 'rejected') throw tells.reason;
    if (!tells.value) return 'cant-tell';
    if (mine.status === 'rejected') throw mine.reason;
    return mine.value ? 'shown' : 'refused';
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
