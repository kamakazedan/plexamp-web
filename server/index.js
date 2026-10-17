// plexamp-web service: the small server-side part of the app, reached by
// nginx at /api/ (and /ollama/). It passes the app's requests to the shared
// AI model on, after checking them, runs Play Together sessions, Play on and
// sharing playback between your devices, and in debug mode writes
// browser-side problems to the container log. It listens on a Unix socket
// that only nginx can reach.
//
//   node server/index.js [config.json]
//
// Settings come from the JSON file the container's start-up script writes
// (see docker/40-plexamp-web.sh), or from PW_SERVICE_* environment variables
// for development.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, unlinkSync, chmodSync, chownSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { log, setDebug, isDebug } from './log.js';
import { PlexAuth, AuthError, validToken } from './plex.js';
import { Together, TogetherError } from './together.js';
import { Cast, CastError } from './cast.js';
import { Devices, DevicesError } from './devices.js';
import { SharedModel, AIRequestError, cleanChat, AI_LIMITS } from './ai.js';
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
    cast: env.PW_SERVICE_CAST ? env.PW_SERVICE_CAST === 'true' : cfg.cast !== false,
    devices: env.PW_SERVICE_DEVICES ? env.PW_SERVICE_DEVICES === 'true' : cfg.devices !== false,
    // Development only: players at 127.0.0.1 (the mock player).
    castLoopback: env.PW_SERVICE_CAST_LOOPBACK === 'true',
    aiAuth: env.PW_SERVICE_AI_AUTH || cfg.aiAuth || 'plex',
    // The shared AI model: an Ollama server, and the one model it's used for.
    ollamaUrl: env.PW_SERVICE_OLLAMA_URL ?? cfg.ollamaUrl ?? '',
    ollamaModel: env.PW_SERVICE_OLLAMA_MODEL ?? cfg.ollamaModel ?? '',
    ollamaKey: env.PW_SERVICE_OLLAMA_KEY ?? cfg.ollamaKey ?? '',
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
const cast = new Cast({ auth, loopback: config.castLoopback });
const devices = new Devices();
setInterval(() => devices.sweep(), 15000).unref();
const sharedModel = config.ollamaUrl ? new SharedModel({ url: config.ollamaUrl, key: config.ollamaKey, model: config.ollamaModel, log }) : null;

// ---------- rate limits ----------

const buckets = new Map();
const waiting = new Map(); // user id -> long-polls open
const deviceWaits = new Map(); // `${user id}|${device id}` -> long-polls open
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

// ---------- the shared AI model ----------

// Who may use the shared model (OLLAMA_AUTH): people signed in to Plex who
// can use the Plex server at PLEX_SERVER_URL (anyone signed in to Plex when
// it isn't set), or, with OLLAMA_AUTH=off, anyone who can open the app.
// Resolves with a key for limits; throws for anyone else, with a message
// that says why.
async function aiAllowed(req) {
  if (config.aiAuth === 'off') return { key: `ip|${req.headers['x-real-ip'] || 'local'}` };
  const pick = (v) => (validToken(v) ? v : null);
  const token = pick(req.headers['x-plex-token']);
  const serverToken = pick(req.headers['x-plex-server-token']);
  if (!token && !serverToken) {
    aiRefused('a request without a Plex sign-in');
    throw new HttpError(401, 'Sign in to Plex to use the AI model.');
  }
  let verdict;
  try {
    verdict = await aiVerdict(token, serverToken);
  } catch (err) {
    log.warn(`couldn't check a sign-in for the shared AI model: ${err.message}`);
    throw new HttpError(503, 'Your Plex sign-in couldn’t be checked right now (plex.tv or the Plex server didn’t answer). Try again in a minute.');
  }
  if (verdict.status === 401) {
    aiRefused('a Plex sign-in that plex.tv and the Plex server didn’t accept');
    throw new HttpError(401, 'Plex didn’t accept your sign-in. Sign out and in again.');
  }
  if (verdict.status === 403) {
    aiRefused('a Plex account that can’t use the Plex server at PLEX_SERVER_URL', verdict.user);
    throw new HttpError(403, 'The AI model on this player is for people who can use its Plex server, and your Plex account can’t.');
  }
  return { key: verdict.user ? `user|${verdict.user.id}` : `token|${createHash('sha256').update(String(token || serverToken)).digest('hex').slice(0, 16)}` };
}

// Refusals are logged (at most once a minute for each reason), so whoever
// runs the container can see why someone couldn't use the model. Names
// only in debug mode.
const refusalsSaid = new Map();
function aiRefused(reason, user = null) {
  log.debug(`shared AI: refused ${user ? `${user.title}: ` : ''}${reason}`);
  if (isDebug()) return;
  const last = refusalsSaid.get(reason) || 0;
  if (Date.now() - last < 60000) return;
  refusalsSaid.set(reason, Date.now());
  log.info(`shared AI: refused ${reason}`);
}

const aiBusy = new Map(); // limit key -> chats under way
let aiChats = 0;

async function aiRoute(req, res, parts) {
  if (!sharedModel) throw new HttpError(404, 'This player has no shared AI model.');
  const what = parts[0] || '';
  const method = req.method;
  if (!['status', 'tags', 'chat'].includes(what) || parts.length > 1) throw new HttpError(404, 'Not found.');
  if ((what === 'chat') !== (method === 'POST') || (method !== 'GET' && method !== 'POST')) throw new HttpError(405, 'Not allowed.');
  const who = await aiAllowed(req);
  // Only the model in use, never the others on the AI server or its settings.
  if (what === 'status') return send(res, 200, await sharedModel.status());
  if (what === 'tags') {
    const model = await sharedModel.model();
    return send(res, 200, { models: [{ name: model, model }] });
  }
  return aiChat(req, res, who);
}

async function aiChat(req, res, who) {
  const body = await readBody(req, AI_LIMITS.body);
  const chat = cleanChat(body, await sharedModel.model());
  const mine = aiBusy.get(who.key) || 0;
  if (mine >= AI_LIMITS.perUser || aiChats >= AI_LIMITS.total) {
    throw new HttpError(429, 'The AI model is busy with other requests. Try again in a moment.');
  }
  aiBusy.set(who.key, mine + 1);
  aiChats += 1;
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    aiChats -= 1;
    const n = (aiBusy.get(who.key) || 1) - 1;
    if (n > 0) aiBusy.set(who.key, n);
    else aiBusy.delete(who.key);
  };
  // Someone who stops waiting (Stop, or the page closed) stops the model too.
  const ctrl = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) ctrl.abort();
    finish();
  });
  let upstream;
  try {
    upstream = await sharedModel.request('/api/chat', { method: 'POST', body: chat, signal: ctrl.signal, idleMs: AI_LIMITS.idleMs });
  } catch (err) {
    finish();
    if (ctrl.signal.aborted) return undefined;
    log.warn(`shared AI: couldn't reach the AI server: ${err.message}`);
    throw new HttpError(502, 'The AI server didn’t answer. Check that Ollama is running.');
  }
  res.writeHead(upstream.statusCode || 502, {
    'Content-Type': String(upstream.headers['content-type'] || 'application/json'),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Accel-Buffering': 'no',
  });
  upstream.on('error', () => res.destroy());
  upstream.pipe(res);
  return undefined;
}

// Without PLEX_SERVER_URL, anyone signed in to Plex may use the shared
// model. With it, only people who can use that Plex server: { status: 204
// (yes), 401 (not signed in) or 403 (no access), user }.
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
  const says = (status) => ({ status, user });
  if (!config.plexServerUrl) {
    if (user) return says(204);
    if (plexTvError) throw plexTvError;
    return says(401);
  }
  let serverId = null;
  if (user) {
    serverId = await auth.loadServerId();
    if (serverId) {
      try {
        if (await auth.canUseServer(userToken, serverId)) return says(204);
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
  if (pmsSays === true) return says(204);
  if (pmsSays === false) return says(user ? 403 : 401);
  if (user && serverId && !plexTvError) return says(403); // plex.tv says: no access
  if (plexTvError || pmsError) throw plexTvError || pmsError;
  return says(user ? 403 : 401);
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
// the Plex server lets this container in without signing in, it accepts
// any token from here and can treat every request as its owner's: a friend
// could see and change things as the owner. Then only the owner's own
// sign-in gets through (checked with plex.tv).
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
    if (!serverId) return send(res, 403);
    const access = await auth.serverAccess(token, serverId);
    return send(res, access.owned ? 204 : 403);
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

// "Play on": the account's Plex players, and commands for one of them.
//   GET  /api/cast/players
//   POST /api/cast/players/{id}/play       { key, offset, playQueueID, serverId, token }
//   POST /api/cast/players/{id}/command    { command, ... }
//   GET  /api/cast/players/{id}/timeline
// With PLEX_SERVER_URL set, only for the server's owner: the players this
// can reach are on the home network, where the owner's are. (Friends'
// players are on their own networks anyway.)
async function castRoute(req, res, parts) {
  if (!config.cast) throw new HttpError(404, 'Playing on other devices is turned off on this player.');
  const { user, token } = await signedIn(req);
  if (!allow(`cast|${user.id}`, 300)) throw new HttpError(429, 'Too many requests. Wait a moment and try again.');
  if (config.plexServerUrl) {
    const serverId = await auth.loadServerId();
    if (!serverId) throw new HttpError(503, 'The Plex server isn’t answering. Try again in a minute.');
    const access = await auth.serverAccess(token, serverId).catch(() => null);
    if (!access) throw new HttpError(503, 'Plex couldn’t be asked about your players right now. Try again in a minute.');
    if (!access.owned) throw new HttpError(403, 'Only the server’s owner can play on Plex players from here.');
  }
  const [what, id, action] = parts;
  if (what !== 'players') throw new HttpError(404, 'Not found.');
  try {
    if (!id && req.method === 'GET') {
      const players = await cast.players(token);
      return send(res, 200, { players: players.map(({ url, ...p }) => p) });
    }
    if (action === 'timeline' && req.method === 'GET') return send(res, 200, await cast.timeline(user, token, id));
    if (action === 'play' && req.method === 'POST') return send(res, 200, await cast.play(user, token, id, await readBody(req, 8 * 1024)));
    if (action === 'command' && req.method === 'POST') return send(res, 200, await cast.command(user, token, id, await readBody(req, 8 * 1024)));
  } catch (err) {
    if (err instanceof CastError) throw new HttpError(err.status, err.message);
    if (err instanceof AuthError) throw new HttpError(401, err.message);
    if (err.network || err.upstream) throw new HttpError(503, 'Plex couldn’t be asked about your players right now. Try again in a minute.');
    throw err;
  }
  throw new HttpError(404, 'Not found.');
}

// Your devices: the devices signed in to one account, playing from one
// server, share what's playing; one plays, the others follow and control it.
//   GET  /api/devices?server=ID&device=ID&name=NAME&since=V&queue=QV&after=C&wait=25
//   POST /api/devices/activate   { server, device: { id, name } }   this one plays now
//   POST /api/devices/release    { server, device }                  this one stops being it
//   POST /api/devices/report     { server, device, queue?, qid, playing, position, ... }
//   POST /api/devices/command    { server, device, command: { type, ... } }
async function devicesRoute(req, res, parts, url) {
  if (!config.devices) throw new HttpError(404, 'Sharing playback between devices is turned off on this player.');
  const { user, token } = await signedIn(req);
  if (!allow(`d|${user.id}`, 900)) throw new HttpError(429, 'Too many requests. Wait a moment and try again.');
  const method = req.method;
  const body = method === 'POST' ? await readBody(req, 512 * 1024) : null;
  const q = url.searchParams;
  const serverId = String((body ? body.server : q.get('server')) || '');
  if (!(await auth.canUseServer(token, serverId).catch(() => false))) throw new HttpError(403, 'You can’t play from that Plex server.');
  const device = body ? body.device : { id: q.get('device'), name: q.get('name') };
  const deviceId = String(device?.id || '');
  try {
    const h = devices.home(user.id, serverId);
    const view = () => devices.view(h, deviceId, { queueVersion: Number(q.get('queue') ?? -1), after: Number(q.get('after') || 0) });
    if (!parts[0] && method === 'GET') {
      devices.seen(h, device);
      const since = Number(q.get('since') || 0);
      const wait = Math.max(0, Math.min(Number(q.get('wait') || 0), 25)) * 1000;
      const key = `${user.id}|${deviceId}`;
      const mine = deviceWaits.get(key) || 0;
      if (wait && since >= h.version && mine < 2 && (waiting.get(user.id) || 0) < 24) {
        let gone = false;
        res.on('close', () => !res.writableFinished && (gone = true));
        deviceWaits.set(key, mine + 1);
        waiting.set(user.id, (waiting.get(user.id) || 0) + 1);
        try {
          await devices.wait(h, since, wait);
        } finally {
          const n = (deviceWaits.get(key) || 1) - 1;
          if (n > 0) deviceWaits.set(key, n);
          else deviceWaits.delete(key);
          const u = (waiting.get(user.id) || 1) - 1;
          if (u > 0) waiting.set(user.id, u);
          else waiting.delete(user.id);
        }
        if (gone) return undefined;
        devices.seen(h, device);
      }
      return send(res, 200, view());
    }
    if (method !== 'POST') throw new HttpError(405, 'Not allowed.');
    if (parts[0] === 'activate') {
      devices.activate(h, device);
      log.debug(`devices: ${user.title}'s "${h.devices.get(deviceId)?.name}" plays now`);
      return send(res, 200, view());
    }
    if (parts[0] === 'release') {
      devices.seen(h, device);
      devices.release(h, deviceId);
      return send(res, 200, { ok: true });
    }
    if (parts[0] === 'report') {
      devices.report(h, device, body);
      return send(res, 200, { version: h.version, queueVersion: h.queueVersion });
    }
    if (parts[0] === 'command') {
      return send(res, 200, { id: devices.command(h, device, body.command) });
    }
  } catch (err) {
    if (err instanceof DevicesError) throw new HttpError(err.status, err.message);
    throw err;
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
    if (area === 'health') return send(res, 200, { ok: true, together: config.together, cast: config.cast, devices: config.devices, debug: config.debug });
    if (area === 'internal' && rest[0] === 'pms-auth') return await pmsAuth(req, res);
    if (area === 'debug' && rest[0] === 'log' && req.method === 'POST') return await browserLog(req, res);
    if (area === 'together') return await togetherRoute(req, res, rest, url);
    if (area === 'cast') return await castRoute(req, res, rest);
    if (area === 'devices') return await devicesRoute(req, res, rest, url);
    if (area === 'ai') return await aiRoute(req, res, rest);
    throw new HttpError(404, 'Not found.');
  } catch (err) {
    const known = err instanceof HttpError || err instanceof TogetherError || err instanceof AIRequestError;
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
  const off = [!config.together && 'Play Together', !config.cast && 'playing on other devices', !config.devices && 'sharing playback between devices'].filter(Boolean);
  log.info(`ready${off.length ? ` (${off.join(' and ')} off)` : ''}${config.debug ? ', debug mode on' : ''}`);
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
