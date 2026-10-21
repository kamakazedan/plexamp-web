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
import { readFileSync, existsSync, unlinkSync, chmodSync, chownSync, mkdirSync, accessSync, constants as fsConstants } from 'node:fs';
import { dirname } from 'node:path';
import { log, setDebug, isDebug } from './log.js';
import { PlexAuth, AuthError, validToken } from './plex.js';
import { Together, TogetherError } from './together.js';
import { Cast, CastError } from './cast.js';
import { Devices, DevicesError } from './devices.js';
import { SharedModel, AIRequestError, cleanChat, errorText, AI_LIMITS } from './ai.js';
import { MusicBrainz, MusicBrainzError, MB_LIMITS } from './musicbrainz.js';
import { Shares, ShareError } from './shares.js';
import { Spotify, SpotifyError, playlistId, NOT_A_LINK } from './spotify.js';
import { listenForNginx } from './syslog.js';
import { plainPath, clientIp } from './paths.js';

// ---------- settings ----------

function loadConfig() {
  const file = process.argv[2] || process.env.PW_SERVICE_CONFIG || '/run/plexamp-web/service.json';
  let cfg = {};
  if (existsSync(file)) cfg = JSON.parse(readFileSync(file, 'utf8'));
  const env = process.env;
  return {
    socket: env.PW_SERVICE_SOCKET || cfg.socket || '/run/plexamp-web/socket/service.sock',
    port: Number(env.PW_SERVICE_PORT || cfg.port || 0),
    debug: env.PW_SERVICE_DEBUG ? env.PW_SERVICE_DEBUG === 'true' : !!cfg.debug,
    together: env.PW_SERVICE_TOGETHER ? env.PW_SERVICE_TOGETHER === 'true' : cfg.together !== false,
    cast: env.PW_SERVICE_CAST ? env.PW_SERVICE_CAST === 'true' : cfg.cast !== false,
    // Checking AI playlists' suggestions on MusicBrainz (MUSICBRAINZ_URL):
    // where, if anywhere.
    musicbrainzUrl: env.PW_SERVICE_MUSICBRAINZ_URL ?? (cfg.musicbrainz === false ? '' : cfg.musicbrainzUrl) ?? '',
    version: cfg.version || env.PW_SERVICE_VERSION || '',
    devices: env.PW_SERVICE_DEVICES ? env.PW_SERVICE_DEVICES === 'true' : cfg.devices !== false,
    // Shared playlists (PLAYLIST_SHARING), kept in a file in dataDir (none:
    // in memory only, for development).
    sharing: env.PW_SERVICE_SHARING ? env.PW_SERVICE_SHARING === 'true' : cfg.sharing !== false,
    dataDir: env.PW_SERVICE_DATA_DIR ?? cfg.dataDir ?? '',
    // Search › From Spotify (SPOTIFY_IMPORT): off unless it's turned on. Its
    // address is for tests (the mock's).
    spotify: env.PW_SERVICE_SPOTIFY ? env.PW_SERVICE_SPOTIFY === 'true' : cfg.spotify === true,
    spotifyUrl: env.PW_SERVICE_SPOTIFY_URL ?? cfg.spotifyUrl ?? '',
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
const musicbrainz = config.musicbrainzUrl ? new MusicBrainz({ base: config.musicbrainzUrl, version: config.version, log }) : null;
const spotify = config.spotify ? new Spotify({ base: config.spotifyUrl || 'https://open.spotify.com', version: config.version, log }) : null;
// Read once the service has given up root (see started()), as the user
// that keeps the file.
let shares = null;

// ---------- rate limits ----------

const buckets = new Map(); // key -> { at, n }, oldest first
const MAX_BUCKETS = 20000;
const everyone = new Map(); // limits for everyone together: never dropped
const waiting = new Map(); // user id -> long-polls open
const deviceWaits = new Map(); // `${user id}|${device id}` -> long-polls open
// `n`: how many this counts for. Too many keys at once (many addresses or
// accounts) drops the oldest minutes first, never everyone's.
function allow(key, perMinute, n = 1, map = buckets) {
  const now = Date.now();
  let b = map.get(key);
  if (!b || now - b.at > 60000) {
    map.delete(key);
    b = { at: now, n: 0 };
    map.set(key, b);
  }
  b.n += n;
  if (map === buckets && buckets.size > MAX_BUCKETS) {
    // (In the order they started, so the minutes that are over come first.)
    for (const [k, old] of buckets) {
      if (now - old.at <= 60000 && buckets.size <= MAX_BUCKETS) break;
      buckets.delete(k);
    }
  }
  return b.n <= perMinute;
}

// A sign-in this service hasn't seen lately is checked with plex.tv. Made-up
// tokens would each be another question for plex.tv, so each address gets
// a few a minute: counted as each is checked (ones seen lately aren't).
const NEW_SIGN_INS_PER_MINUTE = 30;
function checkable(req, token) {
  return !token || auth.knows(token) || allow(`sign-ins|${clientIp(req)}`, NEW_SIGN_INS_PER_MINUTE);
}
const TOO_MANY_SIGN_INS = 'Too many sign-ins checked from your network in a short time. Wait a minute and try again.';
class TooManySignIns extends Error {}
// identify, counted: throws TooManySignIns past the limit.
function identifyFor(req, token) {
  if (!checkable(req, token)) throw new TooManySignIns(TOO_MANY_SIGN_INS);
  return auth.identify(token);
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

// An answer from another server (Ollama's), up to `limit` bytes.
function readAnswer(res, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    res.on('data', (c) => {
      size += c.length;
      if (size <= limit) chunks.push(c);
    });
    res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    res.on('error', reject);
  });
}

// The account behind the request's Plex token (header only, never the URL).
async function signedIn(req) {
  const token = req.headers['x-plex-token'];
  if (!validToken(token)) throw new HttpError(401, 'Sign in to Plex first.');
  try {
    return { user: await identifyFor(req, token), token };
  } catch (err) {
    if (err instanceof TooManySignIns) throw new HttpError(429, err.message);
    if (err instanceof AuthError) throw new HttpError(401, err.message);
    log.warn(`couldn't check a Plex sign-in: ${err.message}`);
    throw new HttpError(503, 'Plex sign-in couldn’t be checked right now (plex.tv didn’t answer). Try again in a minute.');
  }
}

// ---------- routes ----------

// ---------- the shared AI model ----------

// People signed in to Plex who can use the Plex server at PLEX_SERVER_URL
// (anyone signed in to Plex when it isn't set): who the shared model and
// MusicBrainz checks are for. Resolves with a key for limits; throws for
// anyone else, with a message that says why (`noAccess` for an account
// that can't use the server, `signIn` for no sign-in at all). `what` names
// it in the log, and refused(reason, user) hears why someone was turned away.
async function plexAllowed(req, { what, signIn, noAccess, refused = () => {} }) {
  const pick = (v) => (validToken(v) ? v : null);
  const token = pick(req.headers['x-plex-token']);
  const serverToken = pick(req.headers['x-plex-server-token']);
  if (!token && !serverToken) {
    refused('a request without a Plex sign-in');
    throw new HttpError(401, signIn);
  }
  let verdict;
  try {
    verdict = await aiVerdict(req, token, serverToken);
  } catch (err) {
    if (err instanceof TooManySignIns) throw new HttpError(429, err.message);
    log.warn(`couldn't check a sign-in for ${what}: ${err.message}`);
    throw new HttpError(503, 'Your Plex sign-in couldn’t be checked right now (plex.tv or the Plex server didn’t answer). Try again in a minute.');
  }
  if (verdict.status === 401) {
    refused('a Plex sign-in that plex.tv and the Plex server didn’t accept');
    throw new HttpError(401, 'Plex didn’t accept your sign-in. Sign out and in again.');
  }
  if (verdict.status === 403) {
    refused('a Plex account that can’t use the Plex server at PLEX_SERVER_URL', verdict.user);
    throw new HttpError(403, noAccess);
  }
  return { key: verdict.user ? `user|${verdict.user.id}` : `token|${createHash('sha256').update(String(token || serverToken)).digest('hex').slice(0, 16)}` };
}

// Who may use the shared model (OLLAMA_AUTH): as above, or, with
// OLLAMA_AUTH=off, anyone who can open the app.
async function aiAllowed(req) {
  if (config.aiAuth === 'off') return { key: `ip|${clientIp(req)}` };
  return plexAllowed(req, {
    what: 'the shared AI model',
    signIn: 'Sign in to Plex to use the AI model.',
    noAccess: 'The AI model on this player is for people who can use its Plex server, and your Plex account can’t.',
    refused: aiRefused,
  });
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
  // Someone who stops waiting (Stop, or the page closed) stops the model
  // answering, but not the model loading (see SharedModel.load).
  const ctrl = new AbortController();
  let beat = null;
  res.on('close', () => {
    clearInterval(beat);
    if (!res.writableFinished) ctrl.abort();
    finish();
  });
  // The answer starts at once, as lines of JSON (Ollama's own). Until the
  // model answers, a blank line every few seconds keeps proxies on the way
  // (this player's nginx, and any in front of it) from giving up on a quiet
  // connection, while a model loads; {"pw":"loading"} says one is loading.
  // Problems after this point come as a line: {"error", "status"}.
  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  // (Only whole lines are written, so a blank one can go at any time.)
  const line = (obj) => res.write(`${JSON.stringify(obj)}\n`);
  beat = setInterval(() => res.write('\n'), AI_LIMITS.heartbeatMs);
  const fail = (status, message) => {
    clearInterval(beat);
    line({ error: message, status });
    res.end();
  };

  // Loaded the way this chat asks for it (a moment if it is already).
  let said = false;
  const saying = setTimeout(() => {
    said = true;
    line({ pw: 'loading' });
  }, AI_LIMITS.sayLoadingMs);
  try {
    await sharedModel.load(chat.model, { numCtx: chat.options?.num_ctx, keepAlive: chat.keep_alive });
  } catch (err) {
    clearTimeout(saying);
    if (ctrl.signal.aborted) return undefined;
    log.warn(`shared AI: couldn't load the model: ${err.detail || err.message}`);
    return fail(err.status === 404 ? 404 : 502, err instanceof AIRequestError ? err.message : 'The AI server didn’t answer. Check that Ollama is running.');
  }
  clearTimeout(saying);
  if (ctrl.signal.aborted) return undefined; // (gone; the model is loaded for next time)
  if (said) line({ pw: 'loaded' });

  // What Ollama says when it turns a chat down stays here (in the log): it
  // can say things about the AI server. Asked again without "think", or with
  // plain JSON, when that's what it objected to.
  let upstream;
  for (let attempt = 0; ; attempt++) {
    const sent = sharedModel.adapt(chat);
    try {
      upstream = await sharedModel.request('/api/chat', { method: 'POST', body: sent, signal: ctrl.signal, idleMs: AI_LIMITS.idleMs });
    } catch (err) {
      if (ctrl.signal.aborted) return undefined;
      log.warn(`shared AI: couldn't reach the AI server: ${err.message}`);
      return fail(502, 'The AI server didn’t answer. Check that Ollama is running.');
    }
    if (upstream.statusCode === 200) break;
    const status = upstream.statusCode || 502;
    let message = '';
    try {
      message = errorText(await readAnswer(upstream, 65536));
    } catch {
      message = '';
    }
    if (ctrl.signal.aborted) return undefined;
    if (status === 400 && attempt < 2 && sharedModel.retryWithout(sent, message)) continue;
    log.warn(`shared AI: the AI server turned a chat down (${status}${message ? `: ${message}` : ''})`);
    if (status === 404) return fail(404, `The model "${chat.model}" isn’t installed on the AI server.`);
    return fail(502, 'The AI server couldn’t answer. Whoever runs this player can see why in its log.');
  }
  // The answer goes on a line at a time, as it comes. An error Ollama sends
  // partway (a model that crashed, say) is said in the service's own words,
  // and Ollama's go to the log, as above.
  let rest = '';
  let held = false; // waiting for the browser to take what's been written
  const pass = (text) => {
    if (text.includes('"error"')) {
      let said = null;
      try {
        const obj = JSON.parse(text);
        if (obj && typeof obj.error === 'string' && !obj.message) said = obj.error;
      } catch {
        said = null;
      }
      if (said !== null) {
        log.warn(`shared AI: the AI server stopped partway through a chat: ${said}`);
        text = JSON.stringify({ error: 'The AI server couldn’t finish the answer. Whoever runs this player can see why in its log.', status: 502 });
      }
    }
    if (!res.write(`${text}\n`) && !held) {
      held = true;
      upstream.pause();
      res.once('drain', () => {
        held = false;
        upstream.resume();
      });
    }
  };
  upstream.setEncoding('utf8');
  upstream.on('data', (chunk) => {
    rest += chunk;
    for (let i = rest.indexOf('\n'); i >= 0; i = rest.indexOf('\n')) {
      const text = rest.slice(0, i);
      rest = rest.slice(i + 1);
      if (text.trim()) pass(text);
    }
    if (rest.length > 4 * 1024 * 1024) upstream.destroy(new Error('a line too long'));
  });
  upstream.on('end', () => {
    clearInterval(beat);
    if (rest.trim()) pass(rest);
    res.end();
  });
  upstream.on('error', () => res.destroy());
  return undefined;
}

// ---------- MusicBrainz ----------

// POST /api/musicbrainz/check { items: [{ kind: 'artist' | 'track', artist,
// title }] } -> { results: ['real' | 'album' | 'unknown' | null, ...] }:
// which of an AI playlist's missing songs and artists are real (null: not
// checked this time). For people who can use the Plex server, as the shared
// model is; names only go to MusicBrainz (see musicbrainz.js). MusicBrainz
// is asked once a second for everyone, so a few checks run at a time, each
// for a limited time, and one stops when whoever asked has gone.
const mbBusy = new Map(); // limit key -> checks under way
let mbChecks = 0;

async function musicbrainzRoute(req, res, parts) {
  if (!musicbrainz) throw new HttpError(404, 'Checking on MusicBrainz is turned off on this player.');
  if (parts[0] !== 'check' || parts.length > 1) throw new HttpError(404, 'Not found.');
  if (req.method !== 'POST') throw new HttpError(405, 'Not allowed.');
  const { key } = await plexAllowed(req, {
    what: 'MusicBrainz checks',
    signIn: 'Sign in to Plex first.',
    noAccess: 'Checking on MusicBrainz is for people who can use this player’s Plex server, and your Plex account can’t.',
  });
  if (!allow(`mb|${key}`, 30)) throw new HttpError(429, 'Too many checks in a short time. Wait a minute and try again.');
  const body = await readBody(req, 64 * 1024);
  const items = (Array.isArray(body.items) ? body.items : []).slice(0, MB_LIMITS.perRequest).map((it) => ({
    kind: it?.kind === 'artist' ? 'artist' : 'track',
    artist: String(it?.artist || '').slice(0, 200),
    title: String(it?.title || '').slice(0, 200),
  }));
  const mine = mbBusy.get(key) || 0;
  if (mine >= MB_LIMITS.perUser || mbChecks >= MB_LIMITS.checks) {
    throw new HttpError(429, 'MusicBrainz is being asked about other tracks right now. Try again in a minute.');
  }
  mbBusy.set(key, mine + 1);
  mbChecks += 1;
  const ctrl = new AbortController();
  res.on('close', () => !res.writableFinished && ctrl.abort());
  try {
    return send(res, 200, { results: await musicbrainz.check(items, { signal: ctrl.signal, until: Date.now() + MB_LIMITS.checkMs }) });
  } finally {
    mbChecks -= 1;
    const n = (mbBusy.get(key) || 1) - 1;
    if (n > 0) mbBusy.set(key, n);
    else mbBusy.delete(key);
  }
}

// Search › From Spotify (SPOTIFY_IMPORT): a public playlist's name and
// tracks, read from Spotify's own page for it (see spotify.js), for the
// people the shared AI model is for (who can use this player's Plex server,
// or anyone signed in to Plex without PLEX_SERVER_URL). A few a minute for
// each, a few at once for everyone, and only the link is read from the
// request.
const SPOTIFY_PER_MINUTE = 10;
const SPOTIFY_AT_ONCE = 4;
let spotifyReads = 0;

async function spotifyRoute(req, res, parts) {
  if (!spotify) throw new HttpError(404, 'Importing from Spotify is turned off on this player.');
  if (parts[0] !== 'playlist' || parts.length > 1) throw new HttpError(404, 'Not found.');
  if (req.method !== 'POST') throw new HttpError(405, 'Not allowed.');
  const { key } = await plexAllowed(req, {
    what: 'Spotify imports',
    signIn: 'Sign in to Plex first.',
    noAccess: 'Importing from Spotify is for people who can use this player’s Plex server, and your Plex account can’t.',
  });
  if (!allow(`spotify|${key}`, SPOTIFY_PER_MINUTE) || !allow('spotify', 60, 1, everyone)) {
    throw new HttpError(429, 'Too many Spotify playlists read in a short time. Wait a minute and try again.');
  }
  const body = await readBody(req, 8 * 1024);
  const link = typeof body.link === 'string' ? body.link.slice(0, 500) : '';
  if (spotifyReads >= SPOTIFY_AT_ONCE) throw new HttpError(429, 'Other playlists are being read from Spotify right now. Try again in a moment.');
  spotifyReads += 1;
  const ctrl = new AbortController();
  res.on('close', () => !res.writableFinished && ctrl.abort());
  try {
    const id = playlistId(link) || (await spotify.resolveShort(link, { signal: ctrl.signal }));
    if (!id) throw new HttpError(400, NOT_A_LINK);
    const playlist = await spotify.playlist(id, { signal: ctrl.signal });
    log.debug(`spotify: read a playlist (${id.slice(0, 6)}…): ${playlist.tracks.length} tracks${playlist.capped ? ', as many as its page lists' : ''}`);
    return send(res, 200, { playlist });
  } catch (err) {
    if (err instanceof SpotifyError) throw new HttpError(err.status, err.message);
    throw err;
  } finally {
    spotifyReads -= 1;
  }
}

// Without PLEX_SERVER_URL, anyone signed in to Plex may use the shared
// model. With it, only people who can use that Plex server: { status: 204
// (yes), 401 (not signed in) or 403 (no access), user }.
async function aiVerdict(req, token, serverToken) {
  let user = null;
  let userToken = null;
  let plexTvError = null;
  for (const t of [token, serverToken]) {
    if (!t || user) continue;
    try {
      user = await identifyFor(req, t);
      userToken = t;
    } catch (err) {
      if (err instanceof TooManySignIns) throw err;
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
// sign-in gets through (checked with plex.tv). While it can't be told
// whether the server does (it isn't answering the check, or its certificate
// can't be checked), only the owner, if the server's id is known, and
// otherwise nobody: never everyone.
async function pmsAuth(req, res) {
  const token = pmsToken(req);
  if (!token) return send(res, 401);
  // null: couldn't tell.
  const open = await auth.serverIsOpen().catch(() => null);
  if (open === false) return send(res, 204);
  try {
    await identifyFor(req, token);
    const serverId = await auth.loadServerId();
    const access = serverId ? await auth.serverAccess(token, serverId) : null;
    if (access?.owned) return send(res, 204);
    return send(res, open === true && serverId ? 403 : 503);
  } catch (err) {
    if (err instanceof TooManySignIns) return send(res, 503);
    if (err instanceof AuthError) return send(res, 401);
    log.warn(`couldn't check a sign-in for /pms/ with plex.tv: ${err.message}`);
    return send(res, 503);
  }
}

// Debug mode only: lines from browsers, a limited number a minute from each
// address (and from all of them together), so the log can't be flooded.
async function browserLog(req, res) {
  if (!isDebug()) throw new HttpError(404, 'Not found.');
  const body = await readBody(req, 32 * 1024);
  const client = String(body.client || '?');
  const entries = Array.isArray(body.entries) ? body.entries.slice(0, 40) : [];
  if (!allow(`log|${clientIp(req)}`, 300, entries.length || 1) || !allow('log', 1200, entries.length || 1, everyone)) throw new HttpError(429, 'Slow down.');
  for (const e of entries) log.browser(client, e?.level || 'info', e?.area || 'app', e?.message || '');
  send(res, 204);
}

// Your Plex friends (and Plex Home users), for inviting to Play Together or
// sharing a playlist with. plex.tv says which of your own servers each can
// use; for a server someone else shared with you it can't say (canPlay:
// null), and that's checked when they join.
async function friendsOf(user, token, serverId) {
  if (!allow(`friends|${user.id}`, 10)) throw new HttpError(429, 'Too many requests. Wait a moment and try again.');
  if (!(await serverAllowed(token, serverId))) throw new HttpError(403, 'You can’t play from that Plex server.');
  let list;
  let owned = false;
  try {
    [list, { owned }] = await Promise.all([auth.friends(token), auth.serverAccess(token, serverId)]);
  } catch (err) {
    if (err instanceof AuthError) throw new HttpError(401, err.message);
    throw new HttpError(503, 'Your Plex friends couldn’t be loaded (plex.tv didn’t answer).');
  }
  return list
    .filter((f) => f.id !== user.id)
    .map((f) => ({ id: f.id, title: f.title, thumb: f.thumb, home: f.home, canPlay: owned ? f.servers.includes(serverId) : null }));
}

// Play Together, your devices and shared playlists, on a Plex server the
// account can use. With PLEX_SERVER_URL set, only for people who can use
// that server (on it, or another of theirs): this service is theirs, not
// anyone's with a Plex account.
async function serverAllowed(token, serverId) {
  if (config.plexServerUrl) {
    const id = await auth.loadServerId();
    if (!id) throw new HttpError(503, 'This player’s Plex server isn’t answering. Try again in a minute.');
    if (!(await auth.canUseServer(token, id).catch(() => false))) return false;
  }
  return auth.canUseServer(token, String(serverId || '')).catch(() => false);
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
    return send(res, 200, { friends: await friendsOf(user, token, url.searchParams.get('server') || '') });
  }

  // POST /api/together/sessions — start a session
  if (parts[0] === 'sessions' && parts.length === 1 && method === 'POST') {
    if (!allow(`create|${user.id}`, 6)) throw new HttpError(429, 'Too many new sessions. Wait a minute.');
    const body = await readBody(req);
    const serverId = String(body.server?.id || '');
    if (!(await serverAllowed(token, serverId))) throw new HttpError(403, 'You can’t play from that Plex server.');
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
    if (s.host.id !== user.id && !(await serverAllowed(token, s.server.id))) {
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
// Only for the owner of the server at PLEX_SERVER_URL (and so only with it
// set): the players this can reach are on the home network, where the
// owner's are. (Friends' players are on their own networks anyway.) Anyone
// else could have it send requests around the network it's on, to whatever
// addresses they gave "players" of their own on plex.tv.
async function castRoute(req, res, parts) {
  if (!config.cast) throw new HttpError(404, 'Playing on other devices is turned off on this player.');
  if (!config.plexServerUrl) throw new HttpError(404, 'Playing on Plex players needs PLEX_SERVER_URL set on this player.');
  const { user, token } = await signedIn(req);
  if (!allow(`cast|${user.id}`, 300)) throw new HttpError(429, 'Too many requests. Wait a moment and try again.');
  const serverId = await auth.loadServerId();
  if (!serverId) throw new HttpError(503, 'The Plex server isn’t answering. Try again in a minute.');
  const access = await auth.serverAccess(token, serverId).catch(() => null);
  if (!access) throw new HttpError(503, 'Plex couldn’t be asked about your players right now. Try again in a minute.');
  if (!access.owned) throw new HttpError(403, 'Only the server’s owner can play on Plex players from here.');
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
  if (!(await serverAllowed(token, serverId))) throw new HttpError(403, 'You can’t play from that Plex server.');
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

// Shared playlists (see shares.js): for people signed in to Plex, on a Plex
// server they can use, with their own Plex friends.
//   GET    /api/shares?server=ID          yours, those shared with you, and invitations
//   GET    /api/shares/friends?server=ID  who you can share with
//   POST   /api/shares                    { server, playlist, title, tracks, members: [{ id, role }] }
//   GET    /api/shares/ID                 one, with its tracks
//   PUT    /api/shares/ID/members         { members: [{ id, role }] }    its owner only
//   DELETE /api/shares/ID                 it stops being shared         its owner only
//   POST   /api/shares/ID/join            { playlist, version, tracks, title }   your copy, made
//   POST   /api/shares/ID/decline, /leave
//   POST   /api/shares/ID/sync            { tracks, title, since, lease, unseen } -> what your copy should hold
//   POST   /api/shares/ID/synced          { version, tracks, title, lease }    it holds that now
//   POST   /api/shares/ID/lease           { lease }    still bringing it up to date
async function sharesRoute(req, res, parts, url) {
  if (!shares) throw new HttpError(404, 'Shared playlists are turned off on this player.');
  const { user, token } = await signedIn(req);
  if (!allow(`s|${user.id}`, 300)) throw new HttpError(429, 'Too many requests. Wait a moment and try again.');
  const method = req.method;
  const body = method === 'POST' || method === 'PUT' ? await readBody(req, 512 * 1024) : null;
  // The people asked for, kept to the owner's own Plex friends (by id), with
  // their names as plex.tv has them, and (on a server of the owner's, where
  // plex.tv can say) to those who can use the server.
  const friendsAsked = async (asked, serverId) => {
    if (!Array.isArray(asked)) throw new HttpError(400, 'That request couldn’t be read.');
    if (!asked.length) return [];
    let friends;
    let owned = false;
    try {
      [friends, { owned }] = await Promise.all([auth.friends(token), auth.serverAccess(token, serverId)]);
    } catch (err) {
      if (err instanceof AuthError) throw new HttpError(401, err.message);
      throw new HttpError(503, 'Your Plex friends couldn’t be loaded (plex.tv didn’t answer).');
    }
    const byId = new Map(friends.map((f) => [f.id, f]));
    return asked
      .map((m) => ({ f: byId.get(Number(m?.id)), role: m?.role }))
      .filter(({ f }) => f && f.id !== user.id && (!owned || f.servers.includes(serverId)))
      .map(({ f, role }) => ({ id: f.id, title: f.title, role }));
  };
  const canUse = (serverId) => serverAllowed(token, serverId);
  try {
    if (!parts[0] && method === 'GET') {
      const server = String(url.searchParams.get('server') || '');
      // Only for a server they can use (nothing about one they can't).
      if (!(await canUse(server))) return send(res, 200, { shares: [] });
      return send(res, 200, { shares: shares.forUser(user.id, server).map((s) => shares.view(s, user.id)) });
    }
    if (parts[0] === 'friends' && parts.length === 1 && method === 'GET') {
      return send(res, 200, { friends: await friendsOf(user, token, url.searchParams.get('server') || '') });
    }
    if (!parts[0] && method === 'POST') {
      if (!allow(`s-new|${user.id}`, 20)) throw new HttpError(429, 'Too many in a short time. Wait a minute.');
      const server = String(body.server || '');
      if (!(await canUse(server))) throw new HttpError(403, 'You can’t play from that Plex server.');
      const s = shares.create(user, { server, playlist: body.playlist, title: body.title, tracks: body.tracks, members: await friendsAsked(body.members ?? [], server) });
      log.debug(`shares: ${user.title} shared a playlist with ${s.members.length}`);
      return send(res, 201, shares.view(s, user.id));
    }
    if (parts.length > 2) throw new HttpError(404, 'Not found.');
    const s = shares.get(parts[0]);
    const action = parts[1] || '';
    const role = shares.roleOf(s, user.id);
    // Not shared with them: as if it weren't there.
    if (!role) throw new HttpError(404, 'That shared playlist isn’t shared any more.');
    const access = (await canUse(s.server)) ? await auth.serverAccess(token, s.server).catch(() => null) : null;
    if (!access?.ok) throw new HttpError(403, 'You can’t play from that playlist’s Plex server.');
    const ownerOnly = () => {
      if (role !== 'owner') throw new HttpError(403, 'Only whoever shared the playlist can do that.');
    };
    if (!action && method === 'GET') return send(res, 200, { ...shares.view(s, user.id), tracks: s.tracks });
    if (!action && method === 'DELETE') {
      ownerOnly();
      shares.remove(s);
      return send(res, 200, { ok: true });
    }
    if (action === 'members' && method === 'PUT') {
      ownerOnly();
      shares.setMembers(s, await friendsAsked(body.members, s.server));
      return send(res, 200, shares.view(s, user.id));
    }
    if (method !== 'POST') throw new HttpError(405, 'Not allowed.');
    if (action === 'join') {
      if (role === 'owner') throw new HttpError(400, 'It’s your playlist.');
      shares.join(s, user, body);
      return send(res, 200, shares.view(s, user.id));
    }
    if (action === 'decline' || action === 'leave') {
      if (role === 'owner') throw new HttpError(400, 'It’s your playlist: stop sharing it instead.');
      shares.leave(s, user.id);
      return send(res, 200, { ok: true });
    }
    // On a Plex server of their own, nothing in a playlist of theirs is hidden
    // from them: what's gone from it they took out (or was deleted from the
    // library), so there's nothing to ask (see shares.sync's unseen).
    if (action === 'sync') return send(res, 200, shares.sync(s, user, role === 'owner' && access.owned ? { ...body, unseen: [] } : body));
    if (action === 'synced') return send(res, 200, { ok: true, ...shares.synced(s, user, body) });
    if (action === 'lease') return send(res, 200, shares.renew(s, user, body));
  } catch (err) {
    if (err instanceof ShareError) throw new HttpError(err.status, err.message);
    throw err;
  }
  throw new HttpError(404, 'Not found.');
}

// Which way nginx passed a request on (X-PW-Route, which it sets itself and
// clears from everyone else's): its sign-in checks for /pms/ ("internal"),
// the shared AI model at /ollama/ ("ai"), or neither.
const routeOf = (req) => String(req.headers['x-pw-route'] || '');

async function handle(req, res) {
  const started = Date.now();
  // (Only plain paths: see paths.js.)
  const raw = String(req.url || '').split('?')[0];
  const url = new URL(plainPath(raw) ? req.url : '/', 'http://service.local');
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
    if (area === 'health') return send(res, 200, { ok: true, together: config.together, cast: config.cast && !!config.plexServerUrl, devices: config.devices, sharing: !!shares, spotify: !!spotify, debug: config.debug });
    if (area === 'internal' && rest[0] === 'pms-auth' && routeOf(req) === 'internal') return await pmsAuth(req, res);
    if (area === 'debug' && rest[0] === 'log' && req.method === 'POST') return await browserLog(req, res);
    if (area === 'together') return await togetherRoute(req, res, rest, url);
    if (area === 'cast') return await castRoute(req, res, rest);
    if (area === 'devices') return await devicesRoute(req, res, rest, url);
    if (area === 'ai' && routeOf(req) === 'ai') return await aiRoute(req, res, rest);
    if (area === 'musicbrainz') return await musicbrainzRoute(req, res, rest);
    if (area === 'shares') return await sharesRoute(req, res, rest, url);
    if (area === 'spotify') return await spotifyRoute(req, res, rest);
    throw new HttpError(404, 'Not found.');
  } catch (err) {
    const known = err instanceof HttpError || err instanceof TogetherError || err instanceof AIRequestError || err instanceof MusicBrainzError;
    if (!known) log.error(`${req.method} ${url.pathname}: ${err.stack || err.message}`);
    if (!res.headersSent) send(res, known ? err.status : 500, { error: known ? err.message : 'Something went wrong in the service.' });
  } finally {
    // Paths only (no query strings), so nothing secret can be logged. The
    // checks nginx makes for each proxied request would only be noise.
    if (isDebug() && parts[1] !== 'debug' && (parts[1] !== 'internal' || (status || res.statusCode) >= 400)) {
      const path = url.pathname.replace(/(\/sessions\/[A-Za-z0-9_-]{6})[A-Za-z0-9_-]*/, '$1…').replace(/(\/shares\/[a-f0-9]{6})[a-f0-9]+/, '$1…');
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
  // stop being root. Never carries on as root.
  const root = typeof process.getuid === 'function' && process.getuid() === 0;
  const account = root ? lookupUser(config.user) : null;
  if (root && (!account || account.uid === 0)) {
    log.error(`won't run as root, and the ${config.user} user to run as instead isn't there`);
    process.exit(1);
  }
  try {
    if (account && !config.port) {
      chownSync(config.socket, account.uid, account.gid);
      chmodSync(config.socket, 0o660);
    }
    if (account) {
      // Root's other groups go too (a container gives root several).
      process.setgroups([account.gid]);
      process.setgid(account.gid);
      process.setuid(account.uid);
    }
  } catch (err) {
    log.error(`couldn't hand the socket to the ${config.user} user: ${err.message}`);
    process.exit(1);
  }
  startSharing();
  const off = [
    !config.together && 'Play Together',
    !config.cast && 'playing on other devices',
    !config.devices && 'sharing playback between devices',
    !shares && 'shared playlists',
  ].filter(Boolean);
  log.info(`ready${off.length ? ` (${off.join(' and ')} off)` : ''}${spotify ? ', importing from Spotify on' : ''}${config.debug ? ', debug mode on' : ''}`);
  auth.loadServerId();
}

// Shared playlists, kept in the data folder (it has to be this service's to
// write, or they're off).
function startSharing() {
  if (!config.sharing) return;
  if (config.dataDir) {
    try {
      accessSync(config.dataDir, fsConstants.W_OK);
    } catch {
      log.error(`shared playlists are off: ${config.dataDir} can't be written to by this service`);
      return;
    }
  }
  shares = new Shares({ dir: config.dataDir || null, log });
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
    shares?.flush();
    server.close();
    process.exit(0);
  });
}
