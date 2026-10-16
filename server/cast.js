// "Play on": playing on another Plex player (Plexamp on a Raspberry Pi, say)
// with this app as the remote. Plex players take commands over HTTP on the
// local network (Plex's remote-control protocol), which a browser can't
// reach reliably, so the service passes a fixed set of commands on.
//
// It's careful about where it connects: only to players the signed-in
// account itself has on plex.tv, only at their private network addresses,
// only on the ports Plex players use, and only with /player/ commands it
// builds itself. Answers are read for the player's state and nothing else
// is passed back.
import { isIP } from 'node:net';
import { randomBytes } from 'node:crypto';
import { attrs } from './plex.js';

// Plex players listen on 32500 (Plexamp, the mobile apps) and older ones on
// 3005 or 32433.
export const PLAYER_PORTS = new Set([3005, 32433, ...Array.from({ length: 11 }, (_, i) => 32500 + i)]);
const TIMEOUT = 5000;
const ID = /^[A-Za-z0-9_.-]{1,100}$/;
const TOKEN = /^[A-Za-z0-9_.~-]{8,200}$/;

export class CastError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Home-network addresses: 10/8, 172.16/12, 192.168/16, 100.64/10 (Tailscale
// and other carrier-grade NAT) and IPv6 unique-local (fc00::/7). Not
// link-local (169.254/16 is where cloud servers keep their metadata), and
// loopback only for development (the container itself is never a player).
export function privateAddress(host, { loopback = false } = {}) {
  const v = isIP(String(host || ''));
  if (v === 4) {
    const [a, b] = host.split('.').map(Number);
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (loopback && a === 127);
  }
  if (v === 6) {
    const h = host.toLowerCase();
    return /^f[cd][0-9a-f]{0,2}:/.test(h) || (loopback && h === '::1');
  }
  return false;
}

const cleanName = (s, max = 80) => String(s || '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max);
const int = (v, min, max) => {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n < min || n > max) throw new CastError(400, 'That command isn’t right.');
  return n;
};

// The music timeline from a player's answer to timeline/poll (XML, or JSON
// from some players): what it's playing and where.
export function parseTimeline(body) {
  let t = null;
  const text = String(body || '');
  if (text.trim().startsWith('{')) {
    try {
      const mc = JSON.parse(text).MediaContainer || {};
      const list = Array.isArray(mc.Timeline) ? mc.Timeline : mc.Timeline ? [mc.Timeline] : [];
      t = list.find((x) => x?.type === 'music') || null;
    } catch {
      t = null;
    }
  } else {
    for (const m of text.matchAll(/<Timeline\b([^>]*?)\/?>/g)) {
      const a = attrs(m[1]);
      if (a.type === 'music') {
        t = a;
        break;
      }
    }
  }
  if (!t) return { state: 'stopped' };
  const num = (v, max = 1e12) => {
    const n = Number(v);
    return v === undefined || v === null || v === '' || !Number.isFinite(n) || n < 0 || n > max ? null : n;
  };
  const digits = (v) => (/^\d{1,12}$/.test(String(v ?? '')) ? String(v) : null);
  const state = String(t.state || 'stopped');
  return {
    state: ['playing', 'paused', 'stopped', 'buffering', 'error'].includes(state) ? state : 'stopped',
    time: num(t.time),
    duration: num(t.duration),
    ratingKey: digits(t.ratingKey),
    playQueueID: digits(t.playQueueID),
    playQueueItemID: digits(t.playQueueItemID),
    playQueueVersion: num(t.playQueueVersion, 1e9),
    volume: num(t.volume, 100),
    shuffle: t.shuffle === undefined ? null : String(t.shuffle) === '1',
    repeat: num(t.repeat, 2),
  };
}

export class Cast {
  // auth: the service's PlexAuth (for plex.tv); loopback: allow 127.0.0.1
  // players (development only).
  constructor({ auth, loopback = false, fetchImpl = (...a) => fetch(...a) } = {}) {
    this.auth = auth;
    this.loopback = loopback;
    this.fetch = fetchImpl;
    this.commandIds = new Map(); // `${user}|${player}` -> last commandID
    this.instance = randomBytes(4).toString('hex');
  }

  // Players on the account (its own devices that say they're players), each
  // with an address the service may use.
  async players(token) {
    const list = await this.auth.resources(token);
    const out = [];
    for (const r of list) {
      if (!r || !r.owned || !String(r.provides || '').split(',').includes('player')) continue;
      if (!ID.test(String(r.clientIdentifier || ''))) continue;
      const conn = (Array.isArray(r.connections) ? r.connections : []).find(
        (c) => c && c.protocol === 'http' && privateAddress(c.address, { loopback: this.loopback }) && PLAYER_PORTS.has(Number(c.port)),
      );
      if (!conn) continue;
      out.push({
        id: r.clientIdentifier,
        name: cleanName(r.name || r.product || 'Plex player'),
        product: cleanName(r.product, 60),
        device: cleanName(r.device || r.platform, 60),
        online: r.presence !== false,
        url: `http://${conn.address.includes(':') ? `[${conn.address}]` : conn.address}:${Number(conn.port)}`,
      });
    }
    return out;
  }

  async player(token, id) {
    if (!ID.test(String(id || ''))) throw new CastError(404, 'That player isn’t on your account.');
    const p = (await this.players(token)).find((x) => x.id === id);
    if (!p) throw new CastError(404, 'That player isn’t on your account, or isn’t on this network.');
    return p;
  }

  // Sends /player/<path> to a player: the commands below build `path` and
  // `params` themselves.
  async send(user, token, p, path, params = {}) {
    const key = `${user.id}|${p.id}`;
    const commandID = (this.commandIds.get(key) || 0) + 1;
    this.commandIds.set(key, commandID);
    if (this.commandIds.size > 5000) this.commandIds.clear();
    const q = new URLSearchParams({ ...params, commandID: String(commandID) });
    let res;
    try {
      res = await this.fetch(`${p.url}/player/${path}?${q}`, {
        headers: {
          Accept: 'application/xml',
          'X-Plex-Client-Identifier': `plexamp-web-${this.instance}-${user.id}`,
          'X-Plex-Target-Client-Identifier': p.id,
          'X-Plex-Device-Name': 'plexamp-web',
          'X-Plex-Product': 'plexamp-web',
          'X-Plex-Token': token,
        },
        redirect: 'error',
        signal: AbortSignal.timeout(TIMEOUT),
      });
    } catch {
      throw new CastError(502, `Couldn’t reach ${p.name}. Check it’s on, and on the same network as this player’s server.`);
    }
    const text = await res.text().catch(() => '');
    if (!res.ok) throw new CastError(502, `${p.name} didn’t take the command (it answered ${res.status}).`);
    return text.slice(0, 64 * 1024);
  }

  // Start playing a play queue the browser made on the Plex server. The
  // player fetches it from the server itself, with a temporary token the
  // server gave out for this (never the account's own token).
  async play(user, token, id, body = {}) {
    const p = await this.player(token, id);
    const key = String(body.key || '');
    if (!/^\/library\/metadata\/\d{1,12}$/.test(key)) throw new CastError(400, 'That command isn’t right.');
    const playQueueID = int(body.playQueueID, 1, 1e12);
    const offset = int(body.offset || 0, 0, 24 * 3600 * 1000);
    const serverId = String(body.serverId || '');
    if (!/^[A-Za-z0-9-]{8,64}$/.test(serverId)) throw new CastError(400, 'That command isn’t right.');
    const temp = String(body.token || '');
    if (!TOKEN.test(temp)) throw new CastError(400, 'That command isn’t right.');
    const server = await this.serverConnection(token, serverId);
    await this.send(user, token, p, 'playback/playMedia', {
      providerIdentifier: 'com.plexapp.plugins.library',
      machineIdentifier: serverId,
      protocol: server.protocol,
      address: server.address,
      port: String(server.port),
      key,
      offset: String(offset),
      type: 'music',
      containerKey: `/playQueues/${playQueueID}?own=1&window=200`,
      token: temp,
    });
    return { ok: true };
  }

  // How a player on the home network reaches the Plex server: the server's
  // own local address from plex.tv.
  async serverConnection(token, serverId) {
    const list = await this.auth.resources(token);
    const r = list.find((x) => x?.clientIdentifier === serverId && String(x.provides || '').split(',').includes('server'));
    if (!r) throw new CastError(403, 'You can’t play from that server.');
    const conns = (Array.isArray(r.connections) ? r.connections : []).filter(
      (c) => c && /^https?$/.test(c.protocol) && typeof c.address === 'string' && isIP(c.address) && Number(c.port) > 0 && Number(c.port) < 65536,
    );
    const best = conns.find((c) => c.local && c.protocol === 'http') || conns.find((c) => c.local) || conns.find((c) => !c.relay) || conns[0];
    if (!best) throw new CastError(502, 'Plex doesn’t know an address for that server.');
    return { protocol: best.protocol, address: best.address, port: Number(best.port) };
  }

  async command(user, token, id, body = {}) {
    const p = await this.player(token, id);
    const cmd = String(body.command || '');
    switch (cmd) {
      case 'play':
      case 'pause':
      case 'stop':
      case 'skipNext':
      case 'skipPrevious':
        await this.send(user, token, p, `playback/${cmd}`, { type: 'music' });
        break;
      case 'seekTo':
        await this.send(user, token, p, 'playback/seekTo', { type: 'music', offset: String(int(body.offset, 0, 24 * 3600 * 1000)) });
        break;
      case 'skipTo': {
        const key = String(body.key || '');
        if (!/^\/library\/metadata\/\d{1,12}$/.test(key)) throw new CastError(400, 'That command isn’t right.');
        const params = { type: 'music', key };
        if (body.playQueueItemID != null) params.playQueueItemID = String(int(body.playQueueItemID, 1, 1e12));
        await this.send(user, token, p, 'playback/skipTo', params);
        break;
      }
      case 'setParameters': {
        const params = { type: 'music' };
        if (body.volume != null) params.volume = String(int(body.volume, 0, 100));
        if (body.shuffle != null) params.shuffle = body.shuffle ? '1' : '0';
        if (body.repeat != null) params.repeat = String(int(body.repeat, 0, 2));
        await this.send(user, token, p, 'playback/setParameters', params);
        break;
      }
      case 'refreshPlayQueue':
        await this.send(user, token, p, 'playback/refreshPlayQueue', { type: 'music', playQueueID: String(int(body.playQueueID, 1, 1e12)) });
        break;
      default:
        throw new CastError(400, 'That command isn’t right.');
    }
    return { ok: true };
  }

  async timeline(user, token, id) {
    const p = await this.player(token, id);
    return parseTimeline(await this.send(user, token, p, 'timeline/poll', { wait: '0' }));
  }
}
