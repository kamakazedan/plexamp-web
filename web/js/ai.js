// AI features backed by an Ollama server: playlists from a description and
// the AI DJ.
//
// The model can be shared by the container (OLLAMA_URL, reached through the
// app's own /ollama/ path, so browsers need no CORS setup or direct access)
// or set per device in Settings > AI (any Ollama the browser can reach).
//
// Small local models are poor at recalling exact song titles, so playlists
// are built in two passes grounded in the library: the model first picks
// tags, artists and songs that fit, the app finds matching tracks on the
// Plex server, and the model then chooses and orders tracks from that list.
import { app } from './state.js';
import { normTrack } from './plex.js';

const FIRST_TOKEN_TIMEOUT = 240000; // loading a model and reading a long prompt can take a while
const IDLE_TIMEOUT = 120000;
const TOTAL_TIMEOUT = 600000;

export class AIError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    Object.assign(this, extra);
  }
}

// ---------- configuration ----------

const DEFAULTS = { mode: 'auto', url: '', apiKey: '', model: '', sharedModel: '', notes: '' };

export const aiSettings = () => ({ ...DEFAULTS, ...(app.settings.ai || {}) });
export const sharedAI = () => (app.config.ai?.proxy ? app.config.ai : null);

// Which Ollama to use, or null when none is set up on this device.
export function aiTarget(settings = aiSettings()) {
  const shared = sharedAI();
  const mode = settings.mode === 'auto' ? (shared ? 'shared' : 'none') : settings.mode;
  if (mode === 'custom' && settings.url.trim()) {
    const headers = settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {};
    return { kind: 'custom', base: settings.url.trim().replace(/\/+$/, ''), model: settings.model, headers };
  }
  if (mode === 'shared' && shared) {
    // The container checks these against Plex before passing a request on.
    const headers = {};
    if (app.auth?.token) headers['X-Plex-Token'] = app.auth.token;
    if (app.source?.token && app.source.token !== app.auth?.token && !skipServerToken) headers['X-Plex-Server-Token'] = app.source.token;
    const base = new URL(shared.proxy, location.href).toString().replace(/\/+$/, '');
    return { kind: 'shared', base, model: settings.sharedModel || shared.model || '', headers };
  }
  return null;
}

export const aiReady = () => !!aiTarget()?.model;

// The container checks the token for the Plex server it fronts. If this app
// is using a different server, that token won't work there, so after one
// refusal only the account token is sent.
let skipServerToken = false;

async function send(target, path, init) {
  let res = await fetch(`${target.base}${path}`, init);
  if (res.status === 401 && target.kind === 'shared' && init.headers['X-Plex-Server-Token']) {
    skipServerToken = true;
    const headers = { ...init.headers };
    delete headers['X-Plex-Server-Token'];
    res = await fetch(`${target.base}${path}`, { ...init, headers });
  }
  return res;
}

// ---------- HTTP ----------

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
    throw new AIError('network', err.message || 'network error');
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

// Send a chat and read the streamed reply. Streaming keeps bytes flowing
// through proxies with idle timeouts; if a proxy buffers the stream instead,
// the whole reply simply arrives at the end and is read the same way.
export async function chat({ messages, schema, temperature = 0.6, signal, onProgress, maxTokens }) {
  const target = aiTarget();
  if (!target) throw new AIError('not-configured', 'No AI model is set up.');
  if (!target.model) throw new AIError('no-model', 'Choose an AI model in Settings › AI.');
  // One context size for every request (unless a prompt needs more), so
  // Ollama doesn't reload the model between steps.
  const chars = messages.reduce((n, m) => n + m.content.length, 0);
  const numCtx = Math.min(32768, Math.max(8192, 2 ** Math.ceil(Math.log2(chars / 3 + 1500))));
  const body = {
    model: target.model,
    messages,
    stream: true,
    format: schema || 'json',
    options: { temperature, num_ctx: numCtx, ...(maxTokens ? { num_predict: maxTokens } : {}) },
    keep_alive: '15m',
  };
  if (!noThink.has(target.base)) body.think = false;

  for (let attempt = 0; ; attempt++) {
    try {
      return await streamChat(target, body, signal, onProgress);
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

async function streamChat(target, body, signal, onProgress) {
  const ctrl = new AbortController();
  let timedOut = false;
  let idle = null;
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
  }, TOTAL_TIMEOUT);
  const relay = () => ctrl.abort();
  signal?.addEventListener('abort', relay);
  const started = performance.now();
  let content = '';
  let final = {};
  arm(FIRST_TOKEN_TIMEOUT);

  const handleLine = (line) => {
    if (!line.trim()) return;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      return;
    }
    if (obj.error) throw new AIError('http', String(obj.error), { status: 500 });
    if (obj.message?.content) {
      content += obj.message.content;
      onProgress?.(content.length);
    }
    if (obj.done) final = obj;
  };

  try {
    const res = await send(target, '/api/chat', requestInit(target, 'POST', body, ctrl.signal));
    if (!res.ok) throw await readError(res);
    if (res.body?.getReader) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        arm(IDLE_TIMEOUT);
        buf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          handleLine(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
        }
      }
      handleLine(buf + decoder.decode());
    } else {
      (await res.text()).split('\n').forEach(handleLine);
    }
  } catch (err) {
    if (err instanceof AIError) throw err;
    if (signal?.aborted) throw new AIError('aborted', 'Stopped.');
    if (timedOut) throw new AIError('timeout', 'The AI model took too long to answer.');
    throw new AIError('network', err.message || 'network error');
  } finally {
    clearTimeout(idle);
    clearTimeout(total);
    signal?.removeEventListener('abort', relay);
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
    case 'network':
      return target?.kind === 'custom'
        ? `Couldn’t reach Ollama at ${where}. Check it’s running and reachable from this device, and that OLLAMA_ORIGINS on that server allows ${location.origin}.`
        : 'Couldn’t reach the AI service. Check the container and Ollama are running.';
    default:
      break;
  }
  const status = err?.status;
  if (status === 401 || status === 403) {
    return target?.kind === 'shared' ? 'The AI service couldn’t confirm your Plex sign-in. Sign out and in again.' : 'Ollama refused the request. Check the API key.';
  }
  if (status === 404 && /model/i.test(err.message)) return `The model “${target?.model}” isn’t installed there. Choose another in Settings › AI.`;
  if (status === 404) return target?.kind === 'shared' ? 'This app doesn’t have a shared AI model set up.' : `${where} doesn’t look like an Ollama server.`;
  if (status === 429) return 'Too many AI requests in a short time. Wait a minute and try again.';
  if (status === 502 || status === 503 || status === 504) return 'The AI service didn’t respond. Check that Ollama is running.';
  return `The AI model reported a problem: ${err?.message || 'unknown error'}`;
}

// ---------- helpers ----------

const asList = (v) => (Array.isArray(v) ? v : v ? [v] : []);
const clean = (v, max = 120) =>
  String(v || '')
    .replace(/^["'“”\s]+|["'“”\s]+$/g, '')
    .replace(/\s+/g, ' ')
    .slice(0, max);

export const norm = (v) =>
  String(v || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .replace(/^the\s+/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

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

async function findArtist(name, signal) {
  const target = norm(name);
  if (!target) return null;
  const res = await app.server.search(name, app.source.sectionKey, { signal, limit: 6 }).catch(() => null);
  const artists = res?.artist || [];
  return artists.find((a) => norm(a.title) === target) || artists.find((a) => norm(a.title).startsWith(target) || target.startsWith(norm(a.title))) || null;
}

async function findSong(song, signal) {
  const title = norm(song?.title);
  const artist = norm(song?.artist);
  if (!title) return null;
  const res = await app.server.search(song.title, app.source.sectionKey, { signal, limit: 12 }).catch(() => null);
  const byArtist = (m) => !artist || [m.grandparentTitle, m.originalTitle].some((a) => norm(a) === artist || (norm(a) && (norm(a).includes(artist) || artist.includes(norm(a)))));
  const tracks = res?.track || [];
  return tracks.find((m) => norm(m.title) === title && byArtist(m)) || tracks.find((m) => norm(m.title).startsWith(title) && byArtist(m)) || null;
}

// ---------- playlists from a description ----------

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    summary: { type: 'string' },
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
  required: ['title', 'summary', 'genres', 'styles', 'moods', 'decades', 'artists', 'tracks'],
};

const ORDER_SCHEMA = {
  type: 'object',
  properties: { title: { type: 'string' }, tracks: { type: 'array', items: { type: 'integer' } } },
  required: ['title', 'tracks'],
};

const lines = (...parts) => parts.filter((p) => p !== null && p !== undefined).join('\n');

function planMessages(prompt, notes, vocab, length) {
  const list = (items) => items.map((t) => t.title).join(', ') || '(none)';
  return [
    {
      role: 'system',
      content:
        'You plan playlists that will be built from the listener’s own music library. You know music well: genres, eras, artists and their songs. Answer with JSON only.',
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
        '- "genres", "styles", "moods": up to 4 each that fit the request, copied exactly from the lists above',
        '- "decades": up to 3 from the list above, or an empty list if any era fits',
        '- "artists": up to 12 artists whose music fits the request',
        '- "tracks": up to 15 specific songs that fit, each as {"artist": "...", "title": "..."}',
      ),
    },
  ];
}

function orderMessages(prompt, notes, pool, length) {
  const list = pool.map((c, i) => `${i + 1}. ${describeTrack(c.track)}${c.why ? ` [${c.why}]` : ''}${c.track.viewCount ? `, played ${c.track.viewCount} times` : ''}`);
  return [
    {
      role: 'system',
      content:
        'You are a DJ building a playlist from tracks in the listener’s library. Pick the tracks that best fit the request and put them in an order that flows well. Use only numbers from the list. Answer with JSON only.',
    },
    {
      role: 'user',
      content: lines(
        `Playlist request: ${prompt}`,
        notes ? `About the listener: ${notes}` : null,
        `Choose ${length} tracks, with no repeats. Spread artists out rather than grouping them, unless the request asks otherwise.`,
        '',
        'Tracks:',
        ...list,
        '',
        'Reply with "title" (a short playlist title, 2 to 6 words) and "tracks" (the chosen track numbers, in play order).',
      ),
    },
  ];
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

async function findCandidates(plan, vocab, length, signal) {
  const s = app.server;
  const sec = app.source.sectionKey;
  const genres = matchTags(plan.genres, vocab.genres).slice(0, 4);
  const styles = matchTags(plan.styles, vocab.styles).slice(0, 4);
  const moods = matchTags(plan.moods, vocab.moods).slice(0, 4);
  const decades = matchTags(plan.decades, vocab.decades).slice(0, 3);
  const ids = (tags) => tags.map((t) => t.id).join(',');
  const era = decades.length ? { 'album.decade': ids(decades) } : {};
  const per = Math.max(30, Math.ceil(length * 1.6));

  const queries = [];
  if (genres.length) queries.push({ tags: genres, filters: { 'album.genre': ids(genres) } });
  if (styles.length) queries.push({ tags: styles, filters: { 'album.style': ids(styles) } });
  if (moods.length) queries.push({ tags: moods, filters: { 'album.mood': ids(moods) } });
  if (!queries.length && decades.length) queries.push({ tags: decades, filters: {} });

  const cand = (m, source, why = '') => ({ track: normTrack(m), source, why });
  const matchedArtists = [];
  const [byTag, byArtist, bySong] = await Promise.all([
    mapLimit(queries, 3, async (q) => {
      let items = await tracksMatching({ ...q.filters, ...era }, per, signal).catch(() => []);
      if (!items.length && decades.length && Object.keys(q.filters).length) items = await tracksMatching(q.filters, per, signal).catch(() => []);
      return items.map((m) => cand(m, 'tag', q.tags.map((t) => t.title).join(', ')));
    }),
    mapLimit(asList(plan.artists).slice(0, 12), 4, async (name) => {
      const artist = await findArtist(name, signal);
      if (!artist) return [];
      matchedArtists.push(artist.title);
      let items = await s.popularTracks(sec, artist.ratingKey, 8).catch(() => []);
      if (items.length < 4) {
        const more = await s.list(sec, 10, { sort: 'random', size: 8, filters: { 'artist.id': artist.ratingKey }, signal }).catch(() => ({ items: [] }));
        items = items.concat(more.items);
      }
      return items.map((m) => cand(m, 'artist'));
    }),
    mapLimit(asList(plan.tracks).slice(0, 15), 4, async (song) => {
      const m = await findSong(song, signal);
      return m ? [cand(m, 'song', 'a close match for the request')] : [];
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
  bySong.flat().forEach(add);
  // Take turns between artists and tag searches so no single source dominates.
  const lanes = [...byArtist, ...byTag].filter((l) => l.length).map(shuffled);
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
  return { pool, basedOn: { tags: [...genres, ...styles, ...moods, ...decades].map((t) => t.title), artists: matchedArtists } };
}

// steps reported through onStep: 'plan' → 'search' → 'order'
export async function generatePlaylist({ prompt, length = 25, signal, onStep }) {
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
  });
  const plan = parseReply(planned.content);

  onStep?.('search');
  const { pool, basedOn } = await findCandidates(plan, vocab, length, signal);
  if (!pool.length) {
    throw new AIError('no-matches', `Nothing in ${app.source.sectionTitle} matched. Try describing the playlist another way.`);
  }

  let title = clean(plan.title, 60) || 'AI playlist';
  let chosen = [];
  if (pool.length > length) {
    onStep?.('order');
    try {
      const ordered = await chat({
        messages: orderMessages(prompt, notes, pool, length),
        schema: ORDER_SCHEMA,
        temperature: 0.6,
        signal,
        onProgress: (n) => onStep?.('order', n),
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
  chosen = topUp(chosen, pool, Math.min(length, pool.length)).slice(0, length);

  return {
    title,
    summary: clean(plan.summary, 240),
    tracks: chosen.map((c) => c.track),
    basedOn,
    model: planned.model,
    seconds: Math.round((performance.now() - started) / 1000),
  };
}

// ---------- the AI DJ ----------

const DJ_SCHEMA = {
  type: 'object',
  properties: { pick: { type: 'integer' }, intro: { type: 'string' } },
  required: ['pick', 'intro'],
};

export async function djPick({ current, recent, candidates, signal }) {
  const notes = aiSettings().notes.trim();
  const messages = [
    {
      role: 'system',
      content:
        'You are the DJ of a personal radio station built from the listener’s own music library. Choose the next song so the music flows naturally from what is playing, with some variety. Answer with JSON only.',
    },
    {
      role: 'user',
      content: lines(
        `Now playing: ${describeTrack(current)}`,
        recent.length ? `Played before that:\n${recent.map((t) => `- ${describeTrack(t)}`).join('\n')}` : null,
        notes ? `About the listener: ${notes}` : null,
        '',
        'Choose the next song from this list:',
        ...candidates.map((t, i) => `${i + 1}. ${describeTrack(t)}`),
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
