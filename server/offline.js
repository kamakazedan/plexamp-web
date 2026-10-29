// Offline mode (OFFLINE_KEY): while plex.tv isn't answering this container,
// nobody can sign in with Plex. Then, and only then, this player can be
// signed in to with its offline key, set by whoever runs it. What that gives
// is the Plex server at PLEX_SERVER_URL as it lets this container in without
// signing in, which is as its owner (their playlists, ratings and history):
// the key is the owner's, for them and whoever they'd let use their Plex
// account. Sessions are kept in memory only, and all of them end once
// plex.tv has been answering again for two minutes (or after 14 days).
//
// A session's sign-in goes where a Plex sign-in would (X-Plex-Token), so
// the app needs nothing else; it's refused anywhere a Plex account is
// needed, and never sent to plex.tv.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { BlockList, isIP } from 'node:net';

export const OFFLINE_LIMITS = {
  downForMs: 20000, // plex.tv hasn't answered for this long: the key can be used
  endsUpForMs: 120000, // plex.tv has answered again for this long: every session ends
  sessionMs: 14 * 24 * 3600 * 1000,
  sessions: 50, // at most (the oldest go first)
  triesPerMinute: 5, // from one address
  wrongPerHour: 30, // wrong keys from everywhere together: then none is tried for the rest of the hour
};

const TOKEN = /^pwoff-[0-9a-f]{48}$/;
export const isOfflineToken = (t) => typeof t === 'string' && TOKEN.test(t);
const digest = (s) => createHash('sha256').update(String(s), 'utf8').digest();
const hash = (t) => digest(t).toString('hex');

export class OfflineError extends Error {
  constructor(status, message, reason = '') {
    super(message);
    this.status = status;
    this.reason = reason;
  }
}

// Private networks: where OFFLINE_FROM=private (the default) lets the key be
// used from. (An address as this container sees it: behind another proxy,
// that proxy's.)
const PRIVATE = [
  ['10.0.0.0', 8, 'ipv4'],
  ['172.16.0.0', 12, 'ipv4'],
  ['192.168.0.0', 16, 'ipv4'],
  ['127.0.0.0', 8, 'ipv4'],
  ['169.254.0.0', 16, 'ipv4'],
  ['100.64.0.0', 10, 'ipv4'], // carrier-grade NAT, and VPNs such as Tailscale
  ['::1', 128, 'ipv6'],
  ['fc00::', 7, 'ipv6'],
  ['fe80::', 10, 'ipv6'],
];

// OFFLINE_FROM: "private", "any", or addresses and networks (a.b.c.d/n, an
// IPv6 one), separated by commas. null: anywhere. Throws for anything else.
export function parseFrom(spec) {
  const text = String(spec ?? '').trim().toLowerCase() || 'private';
  if (text === 'any') return null;
  const list = new BlockList();
  if (text === 'private') {
    for (const [net, bits, type] of PRIVATE) list.addSubnet(net, bits, type);
    return list;
  }
  for (const part of text.split(',').map((p) => p.trim()).filter(Boolean)) {
    const [addr, bits, more] = part.split('/');
    const type = isIP(addr) === 4 ? 'ipv4' : isIP(addr) === 6 ? 'ipv6' : null;
    const max = type === 'ipv4' ? 32 : 128;
    const n = bits === undefined ? max : /^\d{1,3}$/.test(bits) ? Number(bits) : NaN;
    if (!type || more !== undefined || !(n >= 0 && n <= max)) throw new Error(`OFFLINE_FROM: ${part} isn't an address or a network`);
    list.addSubnet(addr, n, type);
  }
  return list;
}

export class Offline {
  constructor({ key = '', from = 'private', auth, log = null, now = () => Date.now() } = {}) {
    this.key = key ? digest(key) : null;
    // (Without a key there's nothing for it to say: not even read.)
    this.from = key ? parseFrom(from) : null;
    this.auth = auth;
    this.log = log;
    this.now = now;
    this.sessions = new Map(); // token hash -> { at, until }, oldest first
    this.wrong = []; // when wrong keys were tried, this last hour
    this.tries = new Map(); // address -> { at, n }
    this.lockedSaid = false;
  }

  get configured() {
    return !!this.key;
  }

  // Whether the key may be tried from this address (see OFFLINE_FROM).
  allowedFrom(ip) {
    if (!this.from) return true;
    let addr = String(ip || '');
    const v4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(addr);
    if (v4) addr = v4[1];
    const type = isIP(addr) === 4 ? 'ipv4' : isIP(addr) === 6 ? 'ipv6' : null;
    return !!type && this.from.check(addr, type);
  }

  // Can the key be used now, from this address? { on, plexTv, why }: why
  // not, where it can't ('plex-tv': plex.tv is answering, so sign in with
  // Plex; 'server': the Plex server doesn't let this container in without
  // signing in, so nothing could be played; 'server-down': it isn't
  // answering; 'network': not from here; 'off': there's no key).
  async state(addr) {
    const down = await this.auth.plexTvDown({ forMs: OFFLINE_LIMITS.downForMs, fresh: true });
    const plexTv = this.auth.tv.down ? 'down' : 'up';
    if (!this.configured) return { on: false, plexTv, why: 'off' };
    if (!down) return { on: false, plexTv, why: 'plex-tv' };
    let open = null;
    try {
      open = (await this.auth.serverState()).open;
    } catch {
      /* the server isn't answering either */
    }
    if (open !== true) return { on: false, plexTv, why: open === false ? 'server' : 'server-down' };
    if (!this.allowedFrom(addr)) return { on: false, plexTv, why: 'network' };
    return { on: true, plexTv, why: '' };
  }

  // The key, from this address (`limitKey`: what it's counted as, for the
  // limit on tries): a session's sign-in, or an OfflineError.
  async signIn(key, addr, limitKey = addr) {
    if (!this.configured) throw new OfflineError(404, 'This player has no offline mode.');
    if (!this.allowedFrom(addr)) throw new OfflineError(403, 'The offline key can’t be used from your network.', 'network');
    const now = this.now();
    let t = this.tries.get(limitKey);
    if (!t || now - t.at > 60000) {
      this.tries.delete(limitKey);
      t = { at: now, n: 0 };
      this.tries.set(limitKey, t);
      if (this.tries.size > 5000) this.tries.delete(this.tries.keys().next().value);
    }
    t.n += 1;
    if (t.n > OFFLINE_LIMITS.triesPerMinute) throw new OfflineError(429, 'Too many tries. Wait a minute and try again.');
    this.wrong = this.wrong.filter((at) => now - at < 3600000);
    if (this.wrong.length >= OFFLINE_LIMITS.wrongPerHour) {
      if (!this.lockedSaid) {
        this.lockedSaid = true;
        this.log?.warn(`offline mode: ${this.wrong.length} wrong offline keys tried in the last hour, so no more are tried until it's over`);
      }
      throw new OfflineError(429, 'Too many wrong keys have been tried here. Try again in an hour.');
    }
    this.lockedSaid = false;
    const state = await this.state(addr);
    if (!state.on) {
      const said = {
        'plex-tv': 'plex.tv is answering, so sign in with Plex.',
        server: 'Your Plex server doesn’t let this player in without signing in, so nothing could be played offline.',
        'server-down': 'Your Plex server isn’t answering this player.',
        network: 'The offline key can’t be used from your network.',
      };
      throw new OfflineError(409, said[state.why] || 'Offline mode isn’t on.', state.why);
    }
    const given = typeof key === 'string' && key.length <= 1000 ? digest(key) : null;
    if (!given || !timingSafeEqual(given, this.key)) {
      this.wrong.push(now);
      this.log?.warn(`offline mode: a wrong offline key was tried from ${addr || 'an unknown address'}`);
      throw new OfflineError(401, 'That isn’t this player’s offline key.');
    }
    const token = `pwoff-${randomBytes(24).toString('hex')}`;
    this.sessions.set(hash(token), { at: now, until: now + OFFLINE_LIMITS.sessionMs });
    while (this.sessions.size > OFFLINE_LIMITS.sessions) this.sessions.delete(this.sessions.keys().next().value);
    this.log?.info(`offline mode: signed in with the offline key from ${addr || 'an unknown address'} (${this.sessions.size} signed in with it now)`);
    return { token, until: now + OFFLINE_LIMITS.sessionMs };
  }

  // Is this a session that's on? (Every session ends once plex.tv has
  // been answering again for a while, as heard: it's asked again now and
  // then while sessions are in use.)
  valid(token) {
    if (!isOfflineToken(token) || !this.sessions.size) return false;
    this.auth.nudgePlexTv();
    if (this.auth.plexTvUpFor(OFFLINE_LIMITS.endsUpForMs)) {
      this.log?.info(`offline mode: plex.tv is answering again, so the ${this.sessions.size} signed in with the offline key are signed out`);
      this.sessions.clear();
      return false;
    }
    const key = hash(token);
    const s = this.sessions.get(key);
    if (!s) return false;
    if (this.now() > s.until) {
      this.sessions.delete(key);
      return false;
    }
    return true;
  }

  end(token) {
    if (isOfflineToken(token)) this.sessions.delete(hash(token));
  }
}
