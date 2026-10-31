// AI features backed by an Ollama server: playlists from a description and
// the AI DJ.
//
// The model can be shared by the container (OLLAMA_URL, reached through the
// app's own /ollama/ path, so browsers need no CORS setup or direct access),
// for people who can use its Plex server. The container uses the model set
// with OLLAMA_MODEL and nothing else, and nothing else about its AI server
// is shown: only that model's name, and whether it's ready. Instead, any
// device can use an Ollama of its own (Settings > AI): for someone the
// shared model isn't for, or who'd rather use theirs. That's reached from
// the browser directly, never through the container, and its address and
// key stay on the device.
//
// Small local models are poor at recalling exact song titles, so playlists
// are built in two passes grounded in the library: the model first picks
// tags, artists and songs that fit, the app finds matching tracks on the
// Plex server, and the model then chooses and orders tracks from that list.
import { app, on } from './state.js';
import { normTrack } from './plex.js';
import { debugLog } from './debug.js';
import { norm, otherScript } from './missinglist.js';
import { withoutDisliked } from './picks.js';

// How long to wait for the model to start answering (loading it, and
// reading a long prompt, can take minutes) is a setting: Settings › AI ›
// Wait for the model. Once it's answering, it mustn't go quiet for longer
// than IDLE_TIMEOUT, nor take longer than the wait plus EXTRA_TIME in all.
const IDLE_TIMEOUT = 120000;
const EXTRA_TIME = 600000;
const SAY_LOADING = 1500; // loading for longer than this is shown

export class AIError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    Object.assign(this, extra);
  }
}

// ---------- configuration ----------

// missing: keep a list of the songs and artists AI playlists suggest that
// aren't in the library (Settings › AI › Show missing tracks); musicbrainz:
// check them on MusicBrainz first, where the player has one to ask (see
// missing.js). wait: minutes to wait for the model to start answering.
const DEFAULTS = { mode: 'auto', url: '', apiKey: '', model: '', notes: '', missing: false, musicbrainz: true, wait: 5 };

export const aiSettings = () => ({ ...DEFAULTS, ...(app.settings.ai || {}) });
export const WAIT_CHOICES = [2, 5, 10, 15, 30];
export const aiWaitMinutes = () => {
  const m = Number(aiSettings().wait);
  return Number.isFinite(m) && m > 0 ? Math.min(30, m) : DEFAULTS.wait;
};
export const sharedAI = () => (app.config.ai?.proxy ? app.config.ai : null);

// The shared model's name, once the container has said it (its status, or
// an answer: it's told only to those the model is for, so it isn't in the
// app's config).
let sharedName = '';
export const sharedModelName = () => sharedName;

// Which Ollama to use, or null when there's none (or AI is off here): this
// device's own, when that's chosen (Settings › AI), or else the shared
// model, if the player has one.
export function aiTarget(settings = aiSettings()) {
  if (settings.mode === 'off') return null;
  if (settings.mode === 'custom') {
    if (!settings.url.trim()) return null;
    const headers = settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {};
    return { kind: 'custom', base: settings.url.trim().replace(/\/+$/, ''), model: settings.model, headers };
  }
  const shared = sharedAI();
  if (!shared) return null;
  // The container checks these against Plex before passing a request on,
  // and uses its own model whatever a request names.
  const headers = {};
  if (app.auth?.token) headers['X-Plex-Token'] = app.auth.token;
  if (app.source?.token && app.source.token !== app.auth?.token && !skipServerToken) headers['X-Plex-Server-Token'] = app.source.token;
  const base = new URL(shared.proxy, location.href).toString().replace(/\/+$/, '');
  return { kind: 'shared', base, model: sharedName, headers };
}

// Whether the shared model is known not to be for this Plex account (the
// container said so): see checkAIAccess.
export const sharedRefused = () => allowed === false;

// Whether AI features can be used here: AI is on (Settings › AI), there's
// a model (the shared one, or this device's own Ollama with one chosen),
// and a shared model is for this Plex account (people who can use the
// player's Plex server). Features that can't be used are hidden.
export const aiReady = () => {
  const t = aiTarget();
  if (!t) return false;
  if (t.kind !== 'shared') return !!t.model;
  if (allowed === null) checkAIAccess();
  return allowed !== false;
};

// 'change': whether AI can be used here may have changed.
export const aiEvents = new EventTarget();
const changed = () => aiEvents.dispatchEvent(new Event('change'));

// Asked of the container once per sign-in and library.
let allowed = null;
let asking = null;
export function checkAIAccess() {
  if (asking || aiTarget()?.kind !== 'shared') return asking;
  asking = sharedStatus()
    .then(
      () => true,
      (err) => ([401, 403].includes(err?.status) ? false : null),
    )
    .then((v) => {
      asking = null;
      if (v === null || v === allowed) return;
      allowed = v;
      changed();
    });
  return asking;
}
on('source', () => {
  allowed = null;
  changed();
});
// (The shared model's name too: it's for whoever's signed in, if anyone.)
on('signout', () => {
  allowed = null;
  sharedName = '';
});
on('settings', changed);

// The shared model: { model, ready, problem } (nothing else about the AI
// server is shown here).
export async function sharedStatus() {
  const target = aiTarget();
  if (target?.kind !== 'shared') return null;
  const st = await simple(target, '/api/status');
  if (st?.model) sharedName = String(st.model);
  return { model: st?.model || null, ready: !!st?.ready, problem: st?.problem || null, loaded: typeof st?.loaded === 'boolean' ? st.loaded : null, loading: !!st?.loading };
}

// The container checks the token for the Plex server it fronts. If this app
// is using a different server, that token won't work there, so after one
// refusal only the account token is sent.
let skipServerToken = false;

async function send(target, path, init) {
  const where = target.kind === 'shared' ? 'the shared model' : 'your own Ollama';
  let res;
  try {
    res = await fetch(`${target.base}${path}`, init);
    if (res.status === 401 && target.kind === 'shared' && init.headers['X-Plex-Server-Token']) {
      skipServerToken = true;
      const headers = { ...init.headers };
      delete headers['X-Plex-Server-Token'];
      res = await fetch(`${target.base}${path}`, { ...init, headers });
    }
  } catch (err) {
    if (!init.signal?.aborted) debugLog('ai', `${init.method} ${path} on ${where} failed: ${err.message || 'network error'}`, 'warn');
    throw err;
  }
  if (!res.ok) debugLog('ai', `${init.method} ${path} on ${where} answered ${res.status}`, 'warn');
  return res;
}

// ---------- HTTP ----------

// A request to your own Ollama that got no answer the page could read: is
// it running, but not letting this site in? A request whose answer the page
// isn't let read (no-cors) gets an answer from it all the same, as Ollama
// gives a site its OLLAMA_ORIGINS doesn't list one (403). 'blocked' then,
// 'network' where nothing answers.
async function unreachable(target, err) {
  if (target?.kind === 'custom') {
    try {
      await fetch(`${target.base}/api/version`, { mode: 'no-cors', cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(5000) });
      return new AIError('blocked', 'Ollama answers, but doesn’t let this site in.');
    } catch {
      /* nothing answers */
    }
  }
  return new AIError('network', err?.message || 'network error');
}

async function readError(res) {
  let text = '';
  try {
    text = await res.text();
    text = JSON.parse(text).error || text;
  } catch {
    /* keep whatever text there was */
  }
  return new AIError('http', String(text || `HTTP ${res.status}`).slice(0, 300), { status: res.status });
}

function requestInit(target, method, body, signal) {
  const headers = { Accept: 'application/json', ...target.headers };
  if (body !== undefined) {
    // Ollama reads the body as JSON whatever the content type. Sending plain
    // text to a separate Ollama server avoids a CORS preflight; it still has
    // to allow this site in OLLAMA_ORIGINS for the reply to be readable.
    headers['Content-Type'] = target.kind === 'custom' && !target.headers.Authorization ? 'text/plain;charset=UTF-8' : 'application/json';
  }
  return { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal };
}

async function simple(target, path, timeout = 15000) {
  if (!target) throw new AIError('not-configured', 'No AI model is set up.');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await send(target, path, requestInit(target, 'GET', undefined, ctrl.signal));
    if (!res.ok) throw await readError(res);
    return await res.json();
  } catch (err) {
    if (err instanceof AIError) throw err;
    if (ctrl.signal.aborted) throw new AIError('timeout', 'The AI server didn’t answer in time.');
    throw await unreachable(target, err);
  } finally {
    clearTimeout(timer);
  }
}

export async function aiVersion(target = aiTarget()) {
  return (await simple(target, '/api/version')).version || '';
}

export async function listModels(target = aiTarget()) {
  const data = await simple(target, '/api/tags');
  return (data.models || [])
    .filter((m) => !/embed/i.test(m.name || '') && !(m.details?.families || []).some((f) => /bert/i.test(f)))
    .map((m) => ({
      name: m.name || m.model,
      size: m.size || 0,
      params: m.details?.parameter_size || '',
      quant: m.details?.quantization_level || '',
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

const noThink = new Set(); // Ollama servers that rejected the "think" option

// Loading a model on this device's own Ollama, in a request of its own: it
// carries on if the chat that wanted it is stopped or gives up (Ollama stops
// loading when the request for it goes away), so the next one finds the model
// ready. (The shared model's loads are the container's: see server/ai.js.)
const ownLoads = new Map();
function ownLoad(target, body) {
  const key = `${target.base}|${body.model}|${body.options?.num_ctx || ''}`;
  if (!ownLoads.has(key)) {
    const ask = { model: body.model, keep_alive: body.keep_alive, options: { num_ctx: body.options?.num_ctx } };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30 * 60000);
    const job = send(target, '/api/generate', requestInit(target, 'POST', ask, ctrl.signal))
      .then(async (res) => {
        if (res.ok) return true;
        // Not found: the chat says so. Anything else (an Ollama too old for
        // this, a proxy in the way): the chat loads it instead.
        if (res.status === 404) throw await readError(res);
        return false;
      })
      .finally(() => {
        clearTimeout(timer);
        ownLoads.delete(key);
      });
    ownLoads.set(key, job);
  }
  return ownLoads.get(key);
}

// Send a chat and read the streamed reply. Streaming keeps bytes flowing
// through proxies with idle timeouts; if a proxy buffers the stream instead,
// the whole reply simply arrives at the end and is read the same way.
// onLoading(true/false): the model is being loaded into memory.
export async function chat({ messages, schema, temperature = 0.6, signal, onProgress, onLoading, maxTokens }) {
  const target = aiTarget();
  if (!target) throw new AIError('not-configured', 'No AI model is set up.');
  if (!target.model && target.kind !== 'shared') throw new AIError('no-model', 'Choose an AI model in Settings › AI.');
  // One context size for every request (unless a prompt needs more), so
  // Ollama doesn't reload the model between steps.
  const chars = messages.reduce((n, m) => n + m.content.length, 0);
  const numCtx = Math.min(32768, Math.max(8192, 2 ** Math.ceil(Math.log2(chars / 3 + 1500))));
  const body = {
    model: target.model || 'shared', // the container uses its own model anyway
    messages,
    stream: true,
    format: schema || 'json',
    options: { temperature, num_ctx: numCtx, ...(maxTokens ? { num_predict: maxTokens } : {}) },
    keep_alive: '15m',
  };
  if (!noThink.has(target.base)) body.think = false;

  for (let attempt = 0; ; attempt++) {
    try {
      return await streamChat(target, body, signal, onProgress, onLoading);
    } catch (err) {
      if (attempt >= 2 || err.status !== 400) throw err;
      if ('think' in body && /think/i.test(err.message)) {
        noThink.add(target.base);
        delete body.think;
      } else if (typeof body.format === 'object' && /format|schema|unmarshal|json/i.test(err.message)) {
        body.format = 'json'; // Ollama older than 0.5 only knows plain JSON mode
      } else {
        throw err;
      }
    }
  }
}

async function streamChat(target, body, signal, onProgress, onLoading) {
  const ctrl = new AbortController();
  const waitMs = aiWaitMinutes() * 60000;
  let timedOut = false;
  let idle = null;
  let answering = false; // the model has started answering
  let loading = false;
  const setLoading = (on) => {
    if (loading === on) return;
    loading = on;
    onLoading?.(on);
  };
  const arm = (ms) => {
    clearTimeout(idle);
    idle = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, ms);
  };
  const total = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, waitMs + EXTRA_TIME);
  const relay = () => ctrl.abort();
  signal?.addEventListener('abort', relay);
  const started = performance.now();
  let content = '';
  let final = {};
  arm(waitMs); // until it starts answering (blank lines while it waits don't count)

  const handleLine = (line) => {
    if (!line.trim()) return;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      return;
    }
    // (From the container: a model loading, or a problem it ran into.)
    if (obj.pw === 'loading') setLoading(true);
    if (obj.pw === 'loaded') setLoading(false);
    if (obj.error) throw new AIError('http', String(obj.error), { status: Number(obj.status) || 500 });
    if (obj.message?.content) {
      if (!answering) {
        answering = true;
        setLoading(false);
      }
      content += obj.message.content;
      onProgress?.(content.length);
    }
    if (obj.done) final = obj;
    if (target.kind === 'shared' && obj.model) sharedName = String(obj.model);
  };

  try {
    // This device's own Ollama: the model loads first, in a request that
    // isn't stopped with this one.
    if (target.kind === 'custom') {
      const say = setTimeout(() => setLoading(true), SAY_LOADING);
      const gaveUp = new Promise((resolve) => ctrl.signal.addEventListener('abort', resolve, { once: true }));
      try {
        await Promise.race([ownLoad(target, body), gaveUp]);
      } finally {
        clearTimeout(say);
      }
      if (ctrl.signal.aborted) throw new Error('aborted');
      setLoading(false);
    }
    const res = await send(target, '/api/chat', requestInit(target, 'POST', body, ctrl.signal));
    if (!res.ok) throw await readError(res);
    if (res.body?.getReader) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          handleLine(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
        }
        if (answering) arm(IDLE_TIMEOUT);
      }
      handleLine(buf + decoder.decode());
    } else {
      (await res.text()).split('\n').forEach(handleLine);
    }
  } catch (err) {
    if (err instanceof AIError) throw err;
    if (signal?.aborted) throw new AIError('aborted', 'Stopped.');
    if (timedOut) {
      const mins = aiWaitMinutes();
      const waited = mins >= 1 ? `${Math.round(mins)} minute${Math.round(mins) === 1 ? '' : 's'}` : `${Math.round(mins * 60)} seconds`;
      if (loading) {
        throw new AIError('timeout', 'The AI model is still loading. Try again in a minute or two.', { loading: true });
      }
      throw new AIError('timeout', answering ? 'The AI model took too long to answer.' : `The AI model didn’t start answering within ${waited}. You can wait longer in Settings › AI.`);
    }
    throw await unreachable(target, err);
  } finally {
    clearTimeout(idle);
    clearTimeout(total);
    signal?.removeEventListener('abort', relay);
    setLoading(false);
  }
  return { content, model: final.model || target.model, seconds: (performance.now() - started) / 1000 };
}

// Models sometimes wrap JSON in code fences or reasoning text; dig it out.
export function parseReply(text) {
  let s = String(text || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end <= start) throw new AIError('bad-reply', 'The AI model’s answer couldn’t be read. Try again, or try another model.');
  const json = s.slice(start, end + 1);
  try {
    return JSON.parse(json);
  } catch {
    try {
      return JSON.parse(json.replace(/,\s*([}\]])/g, '$1'));
    } catch {
      throw new AIError('bad-reply', 'The AI model’s answer couldn’t be read. Try again, or try another model.');
    }
  }
}

export function describeAIError(err, target = aiTarget()) {
  const where = target?.kind === 'custom' ? target.base : 'the AI service';
  const shared = target?.kind === 'shared';
  switch (err?.code) {
    case 'not-configured':
      return 'No AI model is set up. Choose one in Settings › AI.';
    case 'no-model':
      return 'Choose an AI model in Settings › AI.';
    case 'aborted':
      return 'Stopped.';
    case 'timeout':
      return err.message;
    case 'bad-reply':
    case 'no-matches':
      return err.message;
    case 'blocked':
      return `Ollama is running, but doesn’t allow ${location.origin} yet: see How to allow this site.`;
    case 'network':
      return target?.kind === 'custom' ? `No answer from Ollama at ${where}. Check it’s running on that computer.` : 'Couldn’t reach the AI service. Check Plexamp-web and Ollama are running.';
    default:
      break;
  }
  const status = err?.status;
  // The container's own explanation (not an error page from a proxy).
  const said = err?.message && !/^\s*</.test(err.message) && !/^HTTP \d+$/.test(err.message) ? err.message : '';
  if (shared && said && [401, 403, 413, 429, 502, 503].includes(status)) return said;
  if (status === 401 || status === 403) {
    return shared ? 'The AI model couldn’t confirm your Plex sign-in. Sign out and in again.' : 'Ollama refused the request. Check the API key.';
  }
  if (status === 404 && /model/i.test(said)) {
    const name = /"([^"]+)"/.exec(said)?.[1] || target?.model || 'the model';
    return shared
      ? `The AI model “${name}” isn’t installed yet. Whoever runs this player can install it.`
      : `The model “${name}” isn’t installed there. Choose another in Settings › AI.`;
  }
  if (status === 404) return shared ? 'This player doesn’t have a shared AI model set up.' : `${where} doesn’t look like an Ollama server.`;
  if (status === 429) return 'Too many AI requests in a short time. Wait a minute and try again.';
  if (status === 502 || status === 503 || status === 504) return 'The AI model didn’t respond. Check that Ollama is running.';
  return `The AI model reported a problem: ${said || 'unknown error'}`;
}

// ---------- helpers ----------

const asList = (v) => (Array.isArray(v) ? v : v ? [v] : []);
const clean = (v, max = 120) =>
  String(v || '')
    .replace(/^["'“”\s]+|["'“”\s]+$/g, '')
    .replace(/\s+/g, ' ')
    .slice(0, max);

// (Names as they're compared: the same as Missing tracks' lists, see
// missinglist.js.)
export { norm };

export function describeTrack(t) {
  const extra = [t.album, t.year].filter(Boolean).join(', ');
  return `${t.artist || 'Unknown artist'} — ${t.title}${extra ? ` (${extra})` : ''}`;
}

export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function shuffled(list) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------- library lookups ----------

const vocabCache = new Map();

async function libraryVocabulary() {
  const s = app.server;
  const sec = app.source.sectionKey;
  const key = `${s.uri}|${sec}`;
  if (vocabCache.has(key)) return vocabCache.get(key);
  const shape = (list, cap) =>
    list
      .slice()
      .sort((a, b) => (Number(b.count) || 0) - (Number(a.count) || 0))
      .slice(0, cap)
      .map((t) => ({ id: String(t.key), title: String(t.title) }));
  const [genres, styles, moods, decades] = await Promise.all(['genre', 'style', 'mood', 'decade'].map((f) => s.tags(sec, f, 9).catch(() => [])));
  const vocab = { genres: shape(genres, 150), styles: shape(styles, 300), moods: shape(moods, 250), decades: shape(decades, 20) };
  vocabCache.set(key, vocab);
  return vocab;
}

function matchTags(names, list) {
  const out = [];
  for (const name of asList(names)) {
    const n = norm(name).replace(/s$/, '');
    const hit = list.find((t) => norm(t.title).replace(/s$/, '') === n) || list.find((t) => norm(t.title) === n || norm(t.id) === n);
    if (hit && !out.includes(hit)) out.push(hit);
  }
  return out;
}

async function trackTotal() {
  const s = app.server;
  const sec = app.source.sectionKey;
  return s.memo(`trackTotal:${sec}`, () => s.count(sec, 10), 10 * 60000);
}

// Random tracks matching album-level filters. If the server ignores the
// filters on track queries, fall back to sampling matching albums.
async function tracksMatching(filters, n, signal) {
  const s = app.server;
  const sec = app.source.sectionKey;
  if (Object.keys(filters).length) {
    try {
      const [{ items, total }, all] = await Promise.all([s.list(sec, 10, { sort: 'random', size: n, filters, signal }), trackTotal()]);
      if (total < all) return items;
    } catch (err) {
      if (signal?.aborted) throw err;
    }
  }
  const albumFilters = Object.fromEntries(Object.entries(filters).map(([k, v]) => [k.replace(/^album\./, ''), v]));
  const { items: albums } = await s.list(sec, 9, { sort: 'random', size: Math.max(4, Math.ceil(n / 5)), filters: albumFilters, signal });
  const lists = await mapLimit(albums, 4, (a) => s.children(a.ratingKey).catch(() => []));
  return shuffled(lists.flat().filter((m) => m.type === 'track')).slice(0, n);
}

export async function findArtist(name, signal, section = app.source.sectionKey) {
  const target = norm(name);
  if (!target) return null;
  const res = await app.server.search(name, section, { signal, limit: 6 }).catch(() => null);
  const artists = res?.artist || [];
  return artists.find((a) => norm(a.title) === target) || artists.find((a) => norm(a.title).startsWith(target) || target.startsWith(norm(a.title))) || null;
}

// A suggested song, looked for in the library: { track } if it's there, or
// { album } if what was suggested is really an album of theirs (models mix
// them up), or {}.
async function lookSong(song, signal, section = app.source.sectionKey) {
  const title = norm(song?.title);
  const artist = norm(song?.artist);
  if (!title) return {};
  const res = await app.server.search(song.title, section, { signal, limit: 12 }).catch(() => null);
  const named = (a) => !artist || (norm(a) && (norm(a) === artist || norm(a).includes(artist) || artist.includes(norm(a))));
  const byArtist = (m) => [m.grandparentTitle, m.originalTitle].some(named);
  const tracks = res?.track || [];
  const track = tracks.find((m) => norm(m.title) === title && byArtist(m)) || tracks.find((m) => norm(m.title).startsWith(title) && byArtist(m)) || null;
  if (track) return { track };
  const album = (res?.album || []).find((a) => norm(a.title) === title && named(a.parentTitle));
  return album ? { album } : {};
}

async function findSong(song, signal) {
  return (await lookSong(song, signal)).track || null;
}

// Titles (normalised, see norm) that are the same song, near enough: "Out
// of Space" and "Out Of Space (Remastered)", or a letter or two different
// (not in Chinese, Japanese or Korean, where one character can be another
// word, nor a number: Symphony No. 5 isn't No. 6).
const ONE_CHARACTER_WORDS = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const numbersOf = (s) => s.replace(/\P{Nd}+/gu, ' ').trim().replace(/(^| )0+(?=\p{Nd})/gu, '$1');
export function sameTitle(a, b) {
  if (!a || !b) return false;
  if (a === b || a.startsWith(`${b} `) || b.startsWith(`${a} `)) return true;
  if (ONE_CHARACTER_WORDS.test(a) || ONE_CHARACTER_WORDS.test(b)) return false;
  // (Nor are titles with other numbers, in any script's digits: Symphony
  // No. 5 isn't No. 6. No. 02 is No. 2.)
  if (numbersOf(a) !== numbersOf(b)) return false;
  return Math.min(a.length, b.length) >= 6 && editDistance(a, b) <= Math.max(1, Math.floor(Math.min(a.length, b.length) / 10));
}

// The word of a title it's looked for by among an artist's tracks (Plex's
// title filter): its first of three letters or more, as norm has it, or in
// another script with its capitals, as it's written (Plex may tell them
// apart there), where that's all that's different.
export function titleWord(title) {
  const want = norm(title);
  const word = want.split(' ').find((w) => w.length >= 3) || want;
  if (!otherScript(word)) return word;
  const raw = String(title || '').normalize('NFKC').split(/[^\p{L}\p{M}\p{N}]+/u);
  return raw.find((w) => w.toLowerCase() === word) || word;
}

// Whether a song ({ artist, title }) is in the library: looked for by its
// title and, if its artist is here, among that artist's own tracks, so a
// song with a common title isn't taken for missing. `searched`: looked for
// by title already.
export async function songInLibrary(song, signal, { searched = false, section = app.source.sectionKey } = {}) {
  if (!searched) {
    const { track, album } = await lookSong(song, signal, section);
    if (track || album) return true; // (an album of theirs isn't a missing song)
  }
  const want = norm(song?.title);
  if (!want) return true; // nothing to look for
  const artist = await findArtist(song.artist, signal, section);
  if (!artist) return false;
  const { items } = await app.server
    .list(section, 10, { size: 50, filters: { 'artist.id': artist.ratingKey, title: titleWord(song.title) }, signal })
    .catch(() => ({ items: [] }));
  return items.some((m) => sameTitle(norm(m.title), want));
}

export async function artistInLibrary(name, signal, section = app.source.sectionKey) {
  return !!(await findArtist(name, signal, section));
}

// ---------- playlists from a description ----------

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    summary: { type: 'string' },
    focus_artists: { type: 'array', items: { type: 'string' } },
    artist_scope: { type: 'string', enum: ['only', 'mostly', 'any'] },
    genres: { type: 'array', items: { type: 'string' } },
    styles: { type: 'array', items: { type: 'string' } },
    moods: { type: 'array', items: { type: 'string' } },
    decades: { type: 'array', items: { type: 'string' } },
    artists: { type: 'array', items: { type: 'string' } },
    tracks: {
      type: 'array',
      items: { type: 'object', properties: { artist: { type: 'string' }, title: { type: 'string' } }, required: ['artist', 'title'] },
    },
  },
  required: ['title', 'summary', 'focus_artists', 'artist_scope', 'genres', 'styles', 'moods', 'decades', 'artists', 'tracks'],
};

const ORDER_SCHEMA = {
  type: 'object',
  properties: { title: { type: 'string' }, tracks: { type: 'array', items: { type: 'integer' } } },
  required: ['title', 'tracks'],
};

const lines = (...parts) => parts.filter((p) => p !== null && p !== undefined).join('\n');

// Added to every request: keep to what was asked, and be creative within it.
const FOLLOW =
  'Follow the request closely. If it names artists, keep to those artists; if it names an era, a genre or a mood, keep to that. ' +
  'Only bring in other artists or styles when the request asks for similar music or leaves room for it. ' +
  'Within those limits, be creative: mix well-known songs with deeper cuts, and vary the energy so the playlist flows.';

function planMessages(prompt, notes, vocab, length) {
  const list = (items) => items.map((t) => t.title).join(', ') || '(none)';
  return [
    {
      role: 'system',
      content: `You plan playlists that will be built from the listener’s own music library. You know music well: genres, eras, artists and their songs. ${FOLLOW} Answer with JSON only.`,
    },
    {
      role: 'user',
      content: lines(
        `Playlist request: ${prompt}`,
        notes ? `About the listener: ${notes}` : null,
        `Planned length: about ${length} tracks.`,
        '',
        'Tags used in the library (choose only from these):',
        `Genres: ${list(vocab.genres)}`,
        `Styles: ${list(vocab.styles)}`,
        `Moods: ${list(vocab.moods)}`,
        `Decades: ${list(vocab.decades)}`,
        '',
        'Reply with:',
        '- "title": a short, catchy playlist title (2 to 6 words)',
        '- "summary": one sentence describing the playlist',
        '- "focus_artists": the artists the request is about, if it names any (for "best of Daft Punk": ["Daft Punk"]); otherwise an empty list',
        '- "artist_scope": "only" if the playlist should have nothing but the focus artists (a best-of, greatest hits, "only", "just", deep cuts by them), "mostly" if it should be mainly them with a few similar artists, or "any" if it isn’t about particular artists',
        '- "genres", "styles", "moods": up to 4 each that fit the request, copied exactly from the lists above',
        '- "decades": up to 3 from the list above, or an empty list if any era fits',
        '- "artists": up to 12 real artists whose music fits the request, the focus artists first',
        '- "tracks": up to 10 well-known songs that fit, each as {"artist": "...", "title": "..."}. Only songs you are certain exist, by that artist, with the title exactly as released: a song, never an album or EP title. Fewer songs, or none, is better than a guess.',
      ),
    },
  ];
}

function orderMessages(prompt, notes, pool, length, focus) {
  const list = pool.map((c, i) => `${i + 1}. ${describeTrack(c.track)}${c.why ? ` [${c.why}]` : ''}${c.track.viewCount ? `, played ${c.track.viewCount} times` : ''}`);
  const names = focus.artists.join(', ');
  return [
    {
      role: 'system',
      content: `You are a DJ building a playlist from tracks in the listener’s library. ${FOLLOW} Pick the tracks that best fit the request, leaving out any that don’t, and put them in an order that flows well. Use only numbers from the list. Answer with JSON only.`,
    },
    {
      role: 'user',
      content: lines(
        `Playlist request: ${prompt}`,
        notes ? `About the listener: ${notes}` : null,
        focus.scope === 'only' ? `Every track in the list is by ${names}, as the request asks. Tracks marked “popular” are their best known: a best-of should lean on them.` : null,
        focus.scope === 'mostly' ? `The request is mainly about ${names}: at least ${Math.ceil(length * 0.6)} of the tracks should be theirs.` : null,
        `Choose ${length} tracks, with no repeats, and no more than ${perAlbum(length)} from any one album (compilations aside).${focus.scope === 'only' ? '' : ' Spread artists out rather than grouping them, unless the request asks otherwise.'}`,
        '',
        'Tracks:',
        ...list,
        '',
        'Reply with "title" (a short playlist title, 2 to 6 words) and "tracks" (the chosen track numbers, in play order).',
      ),
    },
  ];
}

// One of each song (the same track on an album and a compilation, say).
function dedupe(list, cap) {
  const out = [];
  const seen = new Set();
  for (const c of list) {
    const key = `${norm(c.track.artist)}|${norm(c.track.title)}`;
    if (seen.has(c.track.id) || seen.has(key)) continue;
    seen.add(c.track.id);
    seen.add(key);
    out.push(c);
    if (out.length >= cap) break;
  }
  return out;
}

// An AI playlist isn't an album: at most this many tracks from any one
// (unless there aren't enough albums to go round). Compilations aside.
const perAlbum = (length) => Math.max(2, Math.ceil(length / 8));
const albumOf = (t) => t.albumId || `${norm(t.album)}|${norm(t.albumArtist)}`;
const compilation = (t) => /^various( artists)?$/i.test(String(t.albumArtist || '').trim());

export function spreadAlbums(chosen, pool, length) {
  const most = perAlbum(length);
  const count = new Map();
  const out = [];
  const over = [];
  const fits = (c) => compilation(c.track) || (count.get(albumOf(c.track)) || 0) < most;
  const take = (c) => {
    out.push(c);
    count.set(albumOf(c.track), (count.get(albumOf(c.track)) || 0) + 1);
  };
  for (const c of chosen) (fits(c) ? take(c) : over.push(c));
  const used = new Set([...out, ...over]);
  for (const c of pool) {
    if (out.length >= length) break;
    if (!used.has(c) && fits(c)) {
      used.add(c);
      take(c);
    }
  }
  // Too few albums for that: what was left out comes back.
  for (const c of over) {
    if (out.length >= length) break;
    out.push(c);
  }
  return out;
}

function topUp(chosen, pool, length) {
  const used = new Set(chosen);
  for (const c of pool) {
    if (chosen.length >= length) break;
    if (!used.has(c)) {
      used.add(c);
      chosen.push(c);
    }
  }
  return chosen;
}

// Which artists the request is about, and whether others may join them.
// Small models don't always say, or name artists the request never
// mentioned, so it's checked against the request itself: "best of The
// Prodigy" is about The Prodigy alone, "music like The Prodigy" mostly
// about them, and "90s rock" about no one in particular.
export function focusOf(plan, prompt) {
  const words = norm(prompt).split(' ').filter(Boolean);
  const asked = ` ${words.join(' ')} `;
  const named = (name) => norm(name).length > 1 && asked.includes(` ${norm(name)} `);
  // Spelt a little differently ("prodigey"): close enough.
  const near = (name) =>
    norm(name)
      .split(' ')
      .filter((w) => w.length >= 4)
      .some((w) => words.some((x) => Math.abs(x.length - w.length) <= 2 && editDistance(w, x) <= (w.length > 6 ? 2 : 1)));
  const tidy = (list) => asList(list).map((n) => clean(n, 100)).filter(Boolean);
  let artists = tidy(plan.focus_artists).filter((a) => named(a) || near(a));
  if (!artists.length) artists = tidy(plan.artists).filter(named);
  artists = [...new Map(artists.map((a) => [norm(a), a])).values()].slice(0, 6);
  if (!artists.length) return { artists: [], scope: 'any' };
  const like = /\b(like|similar|inspired|influenced|style of|sounds? like|fans? of|vibes?)\b/.test(asked);
  const just = /\b(best of|greatest|hits|essentials?|only|just|deep cuts?|discography|everything|all of|songs by|tracks by)\b/.test(asked);
  let scope = ['only', 'mostly', 'any'].includes(plan.artist_scope) ? plan.artist_scope : 'any';
  if (scope === 'only' && like) scope = 'mostly';
  if (scope === 'any') scope = just && !like ? 'only' : 'mostly';
  return { artists, scope };
}

function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

// Tracks by an artist, best known first (Plex's popularity, from Last.fm),
// or least known first for deep cuts; one of each song.
async function artistTracks(artist, size, signal, { deep = false } = {}) {
  const s = app.server;
  const sort = deep ? 'ratingCount' : 'ratingCount:desc';
  const { items } = await s.list(app.source.sectionKey, 10, { sort, size, filters: { 'artist.id': artist.ratingKey, group: 'title' }, signal });
  return items;
}

const DEEP_CUTS = /\b(deep cuts?|rarities|b-?sides|lesser[- ]known|hidden gems|obscure)\b/i;
const ONLY_POOL = 150; // tracks of the focus artists the model chooses from

// Decade tags ("1990") as ranges of years.
const inDecades = (decades) => {
  const ranges = decades.map((d) => Number(d.id)).filter((y) => y > 1000);
  return (t) => !ranges.length || !t.year || ranges.some((y) => t.year >= y && t.year <= y + 9);
};

async function findCandidates(plan, vocab, length, signal, focus, prompt, trackMissing = false) {
  const s = app.server;
  const sec = app.source.sectionKey;
  // Suggested songs and artists that aren't here (when asked to keep track),
  // and those that are (so earlier notes of them as missing can go).
  const missing = [];
  const seen = { songs: [], artists: [] };
  const lacking = (entry) => trackMissing && missing.push(entry);
  const genres = matchTags(plan.genres, vocab.genres).slice(0, 4);
  const styles = matchTags(plan.styles, vocab.styles).slice(0, 4);
  const moods = matchTags(plan.moods, vocab.moods).slice(0, 4);
  const decades = matchTags(plan.decades, vocab.decades).slice(0, 3);
  const ids = (tags) => tags.map((t) => t.id).join(',');
  const fitsEra = inDecades(decades);
  const era = decades.length ? { 'album.decade': ids(decades) } : {};
  const per = Math.max(30, Math.ceil(length * 1.6));

  const queries = [];
  if (genres.length) queries.push({ tags: genres, filters: { 'album.genre': ids(genres) } });
  if (styles.length) queries.push({ tags: styles, filters: { 'album.style': ids(styles) } });
  if (moods.length) queries.push({ tags: moods, filters: { 'album.mood': ids(moods) } });
  if (!queries.length && decades.length) queries.push({ tags: decades, filters: {} });

  const cand = (m, source, why = '') => ({ track: normTrack(m), source, why });
  const matchedArtists = [];

  // The artists the request is about: all their tracks are candidates.
  const focused = [];
  if (focus.artists.length) {
    const looked = await mapLimit(focus.artists, 3, (name) => findArtist(name, signal));
    focus.artists.forEach((name, i) => (looked[i] ? seen.artists.push(name) : lacking({ kind: 'artist', artist: name })));
    const found = looked.filter(Boolean);
    const done = new Set();
    for (const artist of found) {
      if (done.has(artist.ratingKey)) continue;
      done.add(artist.ratingKey);
      matchedArtists.push(artist.title);
      const deep = DEEP_CUTS.test(prompt);
      const items = await artistTracks(artist, focus.scope === 'only' ? ONLY_POOL : Math.max(40, length * 2), signal, { deep }).catch(() => []);
      const popular = Math.max(10, Math.ceil(items.length / 4));
      let list = items.map((m, i) => cand(m, 'focus', !deep && i < popular && m.ratingCount ? 'popular' : ''));
      const inEra = list.filter((c) => fitsEra(c.track));
      if (inEra.length >= 3) list = inEra;
      focused.push(list);
    }
    if (signal?.aborted) throw new AIError('aborted', 'Stopped.');
    if (focus.scope === 'only') {
      if (!focused.length) {
        throw new AIError('no-matches', `${focus.artists.join(' or ')} ${focus.artists.length > 1 ? 'aren’t' : 'isn’t'} in ${app.source.sectionTitle}.`, { missing });
      }
      // Songs of theirs the model named that aren't among their tracks here.
      if (trackMissing) {
        const theirs = focused.flat().map((c) => norm(c.track.title));
        const byFocus = (song) => !norm(song?.artist) || focus.artists.some((a) => norm(a) === norm(song.artist));
        await mapLimit(asList(plan.tracks).slice(0, 12).filter(byFocus), 4, async (song) => {
          const title = clean(song?.title, 120);
          if (!title) return;
          // (songInLibrary counts one of their albums as there: it isn't a
          // missing song.)
          const there = theirs.some((t) => sameTitle(t, norm(title))) || (await songInLibrary({ artist: song.artist || focus.artists[0], title }, signal));
          if (there) seen.songs.push({ artist: song.artist || focus.artists[0], title });
          else lacking({ kind: 'track', artist: clean(song.artist, 100) || focus.artists[0], title });
        });
        if (signal?.aborted) throw new AIError('aborted', 'Stopped.');
      }
      // Nothing but them: their tracks, taking turns between artists.
      const pool = [];
      const lanes = focused.map((l) => l.slice());
      for (let added = true; added && pool.length < ONLY_POOL; ) {
        added = false;
        for (const lane of lanes) {
          const c = lane.shift();
          if (c) {
            pool.push(c);
            added = true;
          }
        }
      }
      return { pool: dedupe(pool, ONLY_POOL), basedOn: { tags: [], artists: matchedArtists }, only: true, missing, seen };
    }
  }

  const [byTag, byArtist, bySong] = await Promise.all([
    mapLimit(queries, 3, async (q) => {
      let items = await tracksMatching({ ...q.filters, ...era }, per, signal).catch(() => []);
      if (!items.length && decades.length && Object.keys(q.filters).length) items = await tracksMatching(q.filters, per, signal).catch(() => []);
      return items.map((m) => cand(m, 'tag', q.tags.map((t) => t.title).join(', ')));
    }),
    mapLimit(asList(plan.artists).slice(0, 12), 4, async (name) => {
      if (focus.artists.some((f) => norm(f) === norm(name))) return [];
      const artist = await findArtist(name, signal);
      if (!artist) {
        if (clean(name, 100)) lacking({ kind: 'artist', artist: clean(name, 100) });
        return [];
      }
      seen.artists.push(name);
      if (matchedArtists.includes(artist.title)) return [];
      matchedArtists.push(artist.title);
      let items = await s.popularTracks(sec, artist.ratingKey, 8).catch(() => []);
      if (items.length < 4) {
        const more = await s.list(sec, 10, { sort: 'random', size: 8, filters: { 'artist.id': artist.ratingKey }, signal }).catch(() => ({ items: [] }));
        items = items.concat(more.items);
      }
      return items.map((m) => cand(m, 'artist'));
    }),
    mapLimit(asList(plan.tracks).slice(0, 12), 4, async (song) => {
      const { track: m, album } = await lookSong(song, signal);
      if (m) {
        seen.songs.push(song);
        return [cand(m, 'song', 'a close match for the request')];
      }
      // An album, named as if it were a song: not one to play, nor missing.
      if (album) return [];
      const title = clean(song?.title, 120);
      if (trackMissing && title) {
        if (await songInLibrary(song, signal, { searched: true })) seen.songs.push(song);
        else lacking({ kind: 'track', artist: clean(song?.artist, 100), title });
      }
      return [];
    }),
  ]);
  if (signal?.aborted) throw new AIError('aborted', 'Stopped.');

  const cap = Math.min(180, Math.max(length * 3, 60));
  const pool = [];
  const seenIds = new Set();
  const seenSongs = new Set();
  const add = (c) => {
    const key = `${norm(c.track.artist)}|${norm(c.track.title)}`;
    if (seenIds.has(c.track.id) || seenSongs.has(key) || pool.length >= cap) return;
    seenIds.add(c.track.id);
    seenSongs.add(key);
    pool.push(c);
  };
  // Mostly the focus artists: their best known tracks come first.
  focused.flat().slice(0, Math.ceil(cap * 0.5)).forEach(add);
  // Songs and artists the model suggested, within the era asked for.
  bySong.flat().filter((c) => fitsEra(c.track)).forEach(add);
  // Take turns between artists and tag searches so no single source dominates.
  const lanes = [...byArtist.map((l) => l.filter((c) => fitsEra(c.track))), ...byTag].filter((l) => l.length).map(shuffled);
  for (let added = true; added && pool.length < cap; ) {
    added = false;
    for (const lane of lanes) {
      const c = lane.shift();
      if (c) {
        add(c);
        added = true;
      }
    }
  }
  return { pool, basedOn: { tags: [...genres, ...styles, ...moods, ...decades].map((t) => t.title), artists: matchedArtists }, missing, seen };
}

// One of each missing song or artist.
function oneOfEach(list) {
  const out = new Map();
  for (const m of list) {
    const key = `${m.kind}|${norm(m.artist)}|${norm(m.title)}`;
    if (!out.has(key)) out.set(key, m);
  }
  return [...out.values()];
}

// steps reported through onStep: 'plan' → 'search' → 'order'.
// trackMissing: also say which suggested songs and artists aren't in the
// library (`missing`), and which are (`seen`).
// onLoading(true/false): the model is being loaded into memory meanwhile.
export async function generatePlaylist({ prompt, length = 25, signal, onStep, onLoading, trackMissing = aiSettings().missing === true }) {
  const started = performance.now();
  const notes = aiSettings().notes.trim();
  onStep?.('plan');
  const vocab = await libraryVocabulary();
  const planned = await chat({
    messages: planMessages(prompt, notes, vocab, length),
    schema: PLAN_SCHEMA,
    temperature: 0.5,
    signal,
    onProgress: (n) => onStep?.('plan', n),
    onLoading,
  });
  const plan = parseReply(planned.content);
  const focus = focusOf(plan, prompt);

  onStep?.('search');
  let found;
  try {
    found = await findCandidates(plan, vocab, length, signal, focus, prompt, trackMissing);
  } catch (err) {
    if (err?.missing) err.missing = oneOfEach(err.missing);
    throw err;
  }
  const { basedOn, only, seen } = found;
  // (Never a track you've rated down: see picks.js.)
  const fine = new Set(withoutDisliked(found.pool.map((c) => c.track)));
  const pool = found.pool.filter((c) => fine.has(c.track));
  const downs = found.pool.length - pool.length;
  const missing = oneOfEach(found.missing);
  if (!pool.length) {
    const why = downs
      ? `Everything in ${app.source.sectionTitle} that matched is a track you’ve rated down. Try describing the playlist another way, or turn off Skip tracks you’ve rated down in Settings › Playback.`
      : `Nothing in ${app.source.sectionTitle} matched. Try describing the playlist another way.`;
    throw new AIError('no-matches', why, { missing, seen });
  }

  let title = clean(plan.title, 60) || 'AI playlist';
  let chosen = [];
  if (pool.length > length) {
    onStep?.('order');
    try {
      const ordered = await chat({
        messages: orderMessages(prompt, notes, pool, length, focus),
        schema: ORDER_SCHEMA,
        temperature: 0.6,
        signal,
        onProgress: (n) => onStep?.('order', n),
        onLoading,
      });
      const reply = parseReply(ordered.content);
      const used = new Set();
      for (const n of asList(reply.tracks)) {
        const c = pool[Number(n) - 1];
        if (c && !used.has(c)) {
          used.add(c);
          chosen.push(c);
        }
        if (chosen.length >= length) break;
      }
      if (clean(reply.title, 60)) title = clean(reply.title, 60);
    } catch (err) {
      if (err.code === 'aborted') throw err;
      chosen = []; // keep going without the ordering pass
    }
  }
  if (!chosen.length) chosen = [...pool.filter((c) => c.source === 'song'), ...shuffled(pool.filter((c) => c.source !== 'song'))];
  chosen = spreadAlbums(topUp(chosen, pool, Math.min(length, pool.length)).slice(0, length), pool, Math.min(length, pool.length));

  return {
    title,
    summary: clean(plan.summary, 240),
    tracks: chosen.map((c) => c.track),
    basedOn,
    // Fewer tracks than asked for, because that's all there is.
    note: only && pool.length < length ? `That’s every track by ${basedOn.artists.join(' and ')} in ${app.source.sectionTitle}${downs ? ' you haven’t rated down' : ''}.` : '',
    model: planned.model,
    seconds: Math.round((performance.now() - started) / 1000),
    missing,
    seen,
  };
}

// ---------- the AI DJ ----------

const DJ_SCHEMA = {
  type: 'object',
  properties: { pick: { type: 'integer' }, intro: { type: 'string' } },
  required: ['pick', 'intro'],
};

// The AI DJ's next song, from `candidates` (by other artists than the one
// playing: dj.js sees to that); `popular`: the ids of those that are their
// artist's best known; `genre`: the station's.
export async function djPick({ current, recent, candidates, popular = new Set(), genre = '', signal }) {
  const notes = aiSettings().notes.trim();
  const messages = [
    {
      role: 'system',
      content:
        'You are the DJ of a personal radio station built from the listener’s own music library. Choose the next song so the music flows naturally from what is playing, with variety: a different artist each time, and well-known songs rather than obscure ones. Answer with JSON only.',
    },
    {
      role: 'user',
      content: lines(
        `Now playing: ${describeTrack(current)}`,
        recent.length ? `Played before that:\n${recent.map((t) => `- ${describeTrack(t)}`).join('\n')}` : null,
        genre ? `The station plays ${genre}: keep to it.` : null,
        notes ? `About the listener: ${notes}` : null,
        '',
        'Choose the next song from this list. Songs marked “popular” are their artist’s best known.',
        ...candidates.map((t, i) => `${i + 1}. ${describeTrack(t)}${popular.has(t.id) ? ' (popular)' : ''}`),
        '',
        'Reply with "pick" (the number of the song) and "intro" (one short, friendly sentence a radio DJ might say before playing it, under 25 words).',
      ),
    },
  ];
  const reply = parseReply((await chat({ messages, schema: DJ_SCHEMA, temperature: 0.8, signal, maxTokens: 300 })).content);
  const track = candidates[Number(reply.pick) - 1];
  if (!track) throw new AIError('bad-reply', 'The AI DJ picked a song that wasn’t on the list.');
  return { track, intro: clean(reply.intro, 200) };
}
