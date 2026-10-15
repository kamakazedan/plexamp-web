// plexamp-web service: the small server-side part of the app, reached by
// nginx at /api/. It checks Plex sign-ins for the shared AI model, runs
// Play Together sessions, and in debug mode writes browser-side problems to
// the container log. It listens on a Unix socket that only nginx can reach.
//
//   node server/index.js [config.json]
//
// Settings come from the JSON file the container's start-up script writes
// (see docker/40-plexamp-web.sh), or from PW_SERVICE_* environment variables
// for development.
import { createServer } from 'node:http';
import { readFileSync, existsSync, unlinkSync, chmodSync, chownSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { log, setDebug, isDebug } from './log.js';
import { PlexAuth, AuthError, validToken } from './plex.js';
import { Together, TogetherError } from './together.js';
import { listenForNginx } from './syslog.js';

// ---------- settings ----------

function loadConfig() {
  const file = process.argv[2] || process.env.PW_SERVICE_CONFIG || '/run/plexamp-web/service.json';
  let cfg = {};
  if (existsSync(file)) cfg = JSON.parse(readFileSync(file, 'utf8'));
  const env = process.env;
  return {
    socket: env.PW_SERVICE_SOCKET || cfg.socket || '/run/plexamp-web/service.sock',
    port: Number(env.PW_SERVICE_PORT || cfg.port || 0),
    debug: env.PW_SERVICE_DEBUG ? env.PW_SERVICE_DEBUG === 'true' : !!cfg.debug,
    together: env.PW_SERVICE_TOGETHER ? env.PW_SERVICE_TOGETHER === 'true' : cfg.together !== false,
    aiAuth: env.PW_SERVICE_AI_AUTH || cfg.aiAuth || 'plex',
    plexServerUrl: env.PW_SERVICE_PLEX_SERVER_URL ?? cfg.plexServerUrl ?? '',
    plexTvUrl: env.PW_SERVICE_PLEX_TV_URL || cfg.plexTvUrl || 'https://plex.tv',
    user: cfg.user || env.PW_SERVICE_USER || 'nginx',
    // Debug mode: nginx sends its error log here (syslog over UDP on
    // 127.0.0.1), and it is written out with tokens removed.
    nginxLogPort: Number(env.PW_SERVICE_NGINX_LOG_PORT || cfg.nginxLogPort || 0),
  };
}

const config = loadConfig();
setDebug(config.debug);
if (config.debug && config.nginxLogPort) listenForNginx(config.nginxLogPort);
const auth = new PlexAuth({ plexTvUrl: config.plexTvUrl, plexServerUrl: config.plexServerUrl });
const together = new Together({
  onChange: (s) => log.debug(`together ${s.id.slice(0, 6)}: v${s.version}, ${s.members.size} listening, track ${s.index + 1}/${s.queue.length}, ${s.playing ? 'playing' : 'paused'}${s.ended ? ', ended' : ''}`),
});
setInterval(() => together.sweep(), 60000).unref();

// ---------- rate limits ----------

const buckets = new Map();
const waiting = new Map(); // user id -> long-polls open
function allow(key, perMinute) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now - b.at > 60000) {
    b = { at: now, n: 0 };
    buckets.set(key, b);
  }
  b.n += 1;
  if (buckets.size > 20000) buckets.clear();
  return b.n <= perMinute;
}

// ---------- HTTP helpers ----------

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function send(res, status, body) {
  const data = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
  });
  res.end(data);
}

function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'That request is too large.'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (!size) return resolve({});
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(v && typeof v === 'object' ? v : {});
      } catch {
        reject(new HttpError(400, 'That request couldn’t be read.'));
      }
    });
    req.on('error', reject);
  });
}

// The account behind the request's Plex token (header only, never the URL).
async function signedIn(req) {
  const token = req.headers['x-plex-token'];
  if (!validToken(token)) throw new HttpError(401, 'Sign in to Plex first.');
  try {
    return { user: await auth.identify(token), token };
  } catch (err) {
    if (err instanceof AuthError) throw new HttpError(401, err.message);
    log.warn(`couldn't check a Plex sign-in: ${err.message}`);
    throw new HttpError(503, 'Plex sign-in couldn’t be checked right now (plex.tv didn’t answer). Try again in a minute.');
  }
}

// ---------- routes ----------

// Called by nginx (auth_request) before passing a request to the shared
// Ollama. 204 lets it through; 401/403 refuse it; 503 means it couldn't be
// checked (nginx then refuses it too).
async function aiAuth(req, res) {
  if (config.aiAuth === 'off') return send(res, 204);
  const pick = (v) => (validToken(v) ? v : null);
  const token = pick(req.headers['x-plex-token']);
  const serverToken = pick(req.headers['x-plex-server-token']);
  if (!token && !serverToken) return send(res, 401);
  try {
    const verdict = await aiVerdict(token, serverToken);
    if (verdict !== 204) log.debug(`shared AI: refused a request (${verdict === 403 ? 'no access to the Plex server' : 'not signed in'})`);
    return send(res, verdict);
  } catch (err) {
    log.warn(`couldn't check a sign-in for the shared AI model: ${err.message}`);
    return send(res, 503);
  }
}

// Without PLEX_SERVER_URL, anyone signed in to Plex may use the shared
// model. With it, only people who can use that Plex server.
async function aiVerdict(token, serverToken) {
  let user = null;
  let userToken = null;
  let plexTvError = null;
  for (const t of [token, serverToken]) {
    if (!t || user) continue;
    try {
      user = await auth.identify(t);
      userToken = t;
    } catch (err) {
      if (!(err instanceof AuthError)) plexTvError = err;
    }
  }
  if (!config.plexServerUrl) {
    if (user) return 204;
    if (plexTvError) throw plexTvError;
    return 401;
  }
  let serverId = null;
  if (user) {
    serverId = await auth.loadServerId();
    if (serverId) {
      try {
        if (await auth.canUseServer(userToken, serverId)) return 204;
      } catch (err) {
        if (!(err instanceof AuthError)) plexTvError = err;
      }
    }
  }
  // Ask the Plex server itself, for server tokens plex.tv doesn't know or
  // when plex.tv can't be reached. Skipped if the server lets anyone in.
  let pmsSays = null;
  let pmsError = null;
  try {
    if (!(await auth.serverIsOpen())) pmsSays = await auth.serverAccepts(serverToken || token);
  } catch (err) {
    pmsError = err;
  }
  if (pmsSays === true) return 204;
  if (pmsSays === false) return user ? 403 : 401;
  if (user && serverId && !plexTvError) return 403; // plex.tv says: no access
  if (plexTvError || pmsError) throw plexTvError || pmsError;
  return user ? 403 : 401;
}

// The token on a request nginx is about to pass to Plex at /pms/: from the
// X-Plex-Token header, or from the original request's query string.
function pmsToken(req) {
  const header = req.headers['x-plex-token'];
  if (validToken(header)) return header;
  try {
    const original = String(req.headers['x-original-uri'] || '');
    const q = new URLSearchParams(original.includes('?') ? original.slice(original.indexOf('?') + 1) : '');
    const t = q.get('X-Plex-Token');
    return validToken(t) ? t : null;
  } catch {
    return null;
  }
}

// Called by nginx (auth_request) for each request to /pms/. Plex checks
// tokens itself, so normally everything with a token goes through. But if
// the Plex server lets this container in without signing in, it would
// accept any token, so then the token must belong to a Plex account that
// can use the server.
async function pmsAuth(req, res) {
  const token = pmsToken(req);
  if (!token) return send(res, 401);
  // null: couldn't tell (the server didn't answer the check in time).
  const open = await auth.serverIsOpen().catch(() => null);
  if (open === false) return send(res, 204);
  try {
    await auth.identify(token);
    const serverId = await auth.loadServerId();
    // Server unreachable and so unknown: the request will fail there anyway.
    if (!serverId && open === null) return send(res, 204);
    if (serverId && (await auth.canUseServer(token, serverId))) return send(res, 204);
    return send(res, 403);
  } catch (err) {
    if (err instanceof AuthError) return send(res, 401);
    log.warn(`couldn't check a sign-in for /pms/ with plex.tv: ${err.message}`);
    return send(res, 503);
  }
}

async function browserLog(req, res) {
  if (!isDebug()) throw new HttpError(404, 'Not found.');
  const ip = String(req.headers['x-real-ip'] || 'local');
  if (!allow(`log|${ip}`, 120)) throw new HttpError(429, 'Slow down.');
  const body = await readBody(req, 32 * 1024);
  const client = String(body.client || '?');
  const entries = Array.isArray(body.entries) ? body.entries.slice(0, 40) : [];
  for (const e of entries) log.browser(client, e?.level || 'info', e?.area || 'app', e?.message || '');
  send(res, 204);
}

function serverAccessMessage(server) {
  return `You can’t play from ${server.name}. Ask its owner to share their music library with you.`;
}

async function togetherRoute(req, res, parts, url) {
  if (!config.together) throw new HttpError(404, 'Play Together is turned off on this player.');
  const { user, token } = await signedIn(req);
  const key = `u|${user.id}`;
  if (!allow(key, 240)) throw new HttpError(429, 'Too many requests. Wait a moment and try again.');
  const method = req.method;

  // GET /api/together/me — sessions and invitations for this person
  if (parts[0] === 'me' && method === 'GET') {
    return send(res, 200, { user, sessions: together.forUser(user.id) });
  }

  // GET /api/together/friends?server=ID — who can be invited
  if (parts[0] === 'friends' && method === 'GET') {
    if (!allow(`friends|${user.id}`, 10)) throw new HttpError(429, 'Too many requests. Wait a moment and try again.');
    const serverId = url.searchParams.get('server') || '';
    let list;
    let owned = false;
    try {
      [list, { owned }] = await Promise.all([auth.friends(token), auth.serverAccess(token, serverId)]);
    } catch (err) {
      if (err instanceof AuthError) throw new HttpError(401, err.message);
      throw new HttpError(503, 'Your Plex friends couldn’t be loaded (plex.tv didn’t answer).');
    }
    // plex.tv says which of your own servers each friend can use. For a
    // server someone else shared with you it can't say (null); that's
    // checked when they join.
    return send(res, 200, {
      friends: list
        .filter((f) => f.id !== user.id)
        .map((f) => ({ id: f.id, title: f.title, thumb: f.thumb, home: f.home, canPlay: owned ? f.servers.includes(serverId) : null })),
    });
  }

  // POST /api/together/sessions — start a session
  if (parts[0] === 'sessions' && parts.length === 1 && method === 'POST') {
    if (!allow(`create|${user.id}`, 6)) throw new HttpError(429, 'Too many new sessions. Wait a minute.');
    const body = await readBody(req);
    const serverId = String(body.server?.id || '');
    if (!(await auth.canUseServer(token, serverId).catch(() => false))) throw new HttpError(403, 'You can’t play from that Plex server.');
    // Only the host's own Plex friends can be invited.
    let friendIds = new Map();
    if (Array.isArray(body.invite) && body.invite.length) {
      const friends = await auth.friends(token).catch(() => []);
      friendIds = new Map(friends.map((f) => [f.id, f]));
    }
    const invite = (Array.isArray(body.invite) ? body.invite : []).map((id) => friendIds.get(Number(id))).filter(Boolean);
    const s = together.create(user, { server: body.server, invite, queue: body.queue, index: body.index, position: body.position, playing: body.playing });
    log.debug(`together ${s.id.slice(0, 6)} started by ${user.title}, ${invite.length} invited`);
    return send(res, 201, together.view(s, user.id));
  }

  if (parts[0] !== 'sessions' || !parts[1]) throw new HttpError(404, 'Not found.');
  const s = together.get(parts[1]);
  const action = parts[2] || '';

  if (!action && method === 'GET') {
    if (!together.roleOf(s, user.id)) throw new HttpError(403, 'You haven’t been invited to this session.');
    together.seen(s, user.id);
    const since = Number(url.searchParams.get('since') || 0);
    const wait = Math.max(0, Math.min(Number(url.searchParams.get('wait') || 0), 25)) * 1000;
    const unchanged = () => send(res, 200, { version: s.version, now: Date.now(), unchanged: true });
    if (together.settle(s)) together.bump(s);
    if (wait && (waiting.get(user.id) || 0) >= 4) {
      // Enough waiting requests from this person already (several tabs):
      // answer this one straight away.
      return since >= s.version ? unchanged() : send(res, 200, together.view(s, user.id));
    }
    if (wait) {
      let gone = false;
      res.on('close', () => !res.writableFinished && (gone = true));
      waiting.set(user.id, (waiting.get(user.id) || 0) + 1);
      let changed;
      try {
        changed = await together.wait(s, since, wait);
      } finally {
        const n = (waiting.get(user.id) || 1) - 1;
        if (n > 0) waiting.set(user.id, n);
        else waiting.delete(user.id);
      }
      if (gone) return undefined;
      together.seen(s, user.id);
      if (!changed) return unchanged();
    } else if (since >= s.version && together.roleOf(s, user.id) !== 'invited') {
      return unchanged(); // a quick check of the clock, or of whether anything changed
    }
    return send(res, 200, together.view(s, user.id));
  }
  if (!action && method === 'DELETE') {
    if (s.host.id !== user.id) throw new HttpError(403, 'Only the person who started the session can end it.');
    together.end(s, `${user.title} ended the session.`);
    return send(res, 200, { ended: true });
  }
  if (method !== 'POST') throw new HttpError(405, 'Not allowed.');

  if (action === 'join') {
    if (!together.roleOf(s, user.id)) throw new HttpError(403, 'You haven’t been invited to this session.');
    if (s.host.id !== user.id && !(await auth.canUseServer(token, s.server.id).catch(() => false))) {
      throw new HttpError(403, serverAccessMessage(s.server));
    }
    together.join(s, user);
    log.debug(`together ${s.id.slice(0, 6)}: ${user.title} joined`);
    return send(res, 200, together.view(s, user.id));
  }
  if (action === 'leave') {
    together.leave(s, user);
    return send(res, 200, { left: true });
  }
  if (action === 'invite') {
    const body = await readBody(req, 16 * 1024);
    if (s.host.id !== user.id) throw new HttpError(403, 'Only the host can invite people.');
    const friends = await auth.friends(token).catch(() => []);
    const byId = new Map(friends.map((f) => [f.id, f]));
    together.invite(s, user, (Array.isArray(body.invite) ? body.invite : []).map((id) => byId.get(Number(id))).filter(Boolean));
    return send(res, 200, together.view(s, user.id));
  }
  if (action === 'remove') {
    const body = await readBody(req, 4 * 1024);
    together.remove(s, user, Number(body.user));
    return send(res, 200, together.view(s, user.id));
  }
  if (action === 'command') {
    const body = await readBody(req);
    together.command(s, user, body);
    return send(res, 200, together.view(s, user.id));
  }
  throw new HttpError(404, 'Not found.');
}

async function handle(req, res) {
  const started = Date.now();
  const url = new URL(req.url, 'http://service.local');
  const parts = url.pathname.split('/').filter(Boolean);
  let status = 0;
  const done = res.end.bind(res);
  res.end = (...args) => {
    status = res.statusCode;
    return done(...args);
  };
  try {
    if (parts[0] !== 'api') throw new HttpError(404, 'Not found.');
    const [area, ...rest] = parts.slice(1);
    if (area === 'health') return send(res, 200, { ok: true, together: config.together, debug: config.debug });
    if (area === 'internal' && rest[0] === 'ai-auth') return await aiAuth(req, res);
    if (area === 'internal' && rest[0] === 'pms-auth') return await pmsAuth(req, res);
    if (area === 'debug' && rest[0] === 'log' && req.method === 'POST') return await browserLog(req, res);
    if (area === 'together') return await togetherRoute(req, res, rest, url);
    throw new HttpError(404, 'Not found.');
  } catch (err) {
    const known = err instanceof HttpError || err instanceof TogetherError;
    if (!known) log.error(`${req.method} ${url.pathname}: ${err.stack || err.message}`);
    if (!res.headersSent) send(res, known ? err.status : 500, { error: known ? err.message : 'Something went wrong in the service.' });
  } finally {
    // Paths only (no query strings), so nothing secret can be logged. The
    // checks nginx makes for each proxied request would only be noise.
    if (isDebug() && parts[1] !== 'debug' && (parts[1] !== 'internal' || (status || res.statusCode) >= 400)) {
      const path = url.pathname.replace(/(\/sessions\/[A-Za-z0-9_-]{6})[A-Za-z0-9_-]*/, '$1…');
      log.debug(`${req.method} ${path} ${status || res.statusCode} ${Date.now() - started} ms`);
    }
  }
}

// ---------- start ----------

function lookupUser(name) {
  try {
    const line = readFileSync('/etc/passwd', 'utf8')
      .split('\n')
      .find((l) => l.split(':')[0] === name);
    if (!line) return null;
    const [, , uid, gid] = line.split(':');
    return { uid: Number(uid), gid: Number(gid) };
  } catch {
    return null;
  }
}

const server = createServer((req, res) => {
  handle(req, res);
});
server.requestTimeout = 60000;
server.headersTimeout = 15000;

function started() {
  // Started as root by the container: hand the socket to nginx's user and
  // stop being root.
  const account = typeof process.getuid === 'function' && process.getuid() === 0 ? lookupUser(config.user) : null;
  try {
    if (account && !config.port) {
      chownSync(config.socket, account.uid, account.gid);
      chmodSync(config.socket, 0o660);
    }
    if (account) {
      process.setgid(account.gid);
      process.setuid(account.uid);
    }
  } catch (err) {
    log.error(`couldn't hand the socket to the ${config.user} user: ${err.message}`);
    process.exit(1);
  }
  log.info(`ready${config.together ? '' : ' (Play Together off)'}${config.debug ? ', debug mode on' : ''}`);
  auth.loadServerId();
}

server.on('error', (err) => {
  log.error(`couldn't start: ${err.message}`);
  process.exit(1);
});

if (config.port) {
  server.listen(config.port, '127.0.0.1', started);
} else {
  // Unix socket paths are limited to about 100 characters.
  if (Buffer.byteLength(config.socket) > 100) {
    log.error(`the socket path is too long: ${config.socket}`);
    process.exit(1);
  }
  mkdirSync(dirname(config.socket), { recursive: true });
  if (existsSync(config.socket)) unlinkSync(config.socket);
  server.listen(config.socket, started);
}

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    server.close();
    process.exit(0);
  });
}
