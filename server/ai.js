// The shared AI model (OLLAMA_URL). The app's requests to it come through
// this service rather than straight from nginx to Ollama, so each one can be
// checked: who's asking (see aiAllowed in index.js) and what's asked. Only
// chats are passed on, with just the fields the app uses, each checked, and
// always on the one model set with OLLAMA_MODEL. The other models on the
// Ollama server, and its settings, stay out of reach.
import http from 'node:http';
import https from 'node:https';

export const AI_LIMITS = {
  body: 4 * 1024 * 1024, // a chat request
  messages: 64,
  chars: 1500000, // all of a request's messages together
  perUser: 2, // chats at once
  total: 6,
  idleMs: 900000, // Ollama silent this long during a chat (a long prompt on a slow machine)
  loadMs: 1800000, // or while loading the model (Ollama has its own limit too, 5 minutes by default)
  heartbeatMs: 10000, // a blank line this often while waiting, so proxies keep the answer open
  sayLoadingMs: 1500, // loading for longer than this is said to the app
};

export class AIRequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const ROLES = new Set(['system', 'user', 'assistant']);

// Model options the app sets, each kept within sensible bounds.
const OPTIONS = {
  temperature: [0, 2, false],
  top_p: [0, 1, false],
  top_k: [1, 200, true],
  num_predict: [1, 8192, true],
  repeat_penalty: [0, 3, false],
  seed: [0, 2147483647, true],
};

// What decides how much memory the model takes on the AI server is set here,
// not by whoever asks: the context is as big as the messages need (worked
// out as the app does), and the model stays loaded for 15 minutes after.
export const contextFor = (chars) => Math.min(32768, Math.max(8192, 2 ** Math.ceil(Math.log2(chars / 3 + 1500))));
const KEEP_ALIVE = '15m';
const RETRY_FOR_MS = 3600000; // what Ollama turned down isn't asked for again for this long

// An answer format (a JSON schema) is kept small and shallow: the app's own
// are a few hundred bytes.
const MAX_FORMAT = 8192;
const depthOf = (v, d = 0) => (d > 10 || !v || typeof v !== 'object' ? d : Math.max(d + 1, ...Object.values(v).map((x) => depthOf(x, d + 1))));

// A chat request as it's passed on to Ollama.
export function cleanChat(body, model) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AIRequestError(400, 'That request couldn’t be read.');
  const list = Array.isArray(body.messages) ? body.messages : [];
  if (!list.length || list.length > AI_LIMITS.messages) throw new AIRequestError(400, 'That request needs between 1 and 64 messages.');
  let chars = 0;
  const messages = list.map((m) => {
    if (!m || !ROLES.has(m.role) || typeof m.content !== 'string') throw new AIRequestError(400, 'A message in that request isn’t right.');
    chars += m.content.length;
    return { role: m.role, content: m.content };
  });
  if (chars > AI_LIMITS.chars) throw new AIRequestError(413, 'That request is too long.');
  const out = { model, messages, stream: body.stream !== false };
  if (body.format === 'json') out.format = 'json';
  else if (body.format && typeof body.format === 'object' && !Array.isArray(body.format)) {
    if (JSON.stringify(body.format).length > MAX_FORMAT || depthOf(body.format) > 8) throw new AIRequestError(400, 'That request’s answer format is too big.');
    out.format = body.format;
  }
  const options = {};
  if (body.options && typeof body.options === 'object') {
    for (const [key, [min, max, whole]] of Object.entries(OPTIONS)) {
      const n = Number(body.options[key]);
      if (body.options[key] === undefined || body.options[key] === null || !Number.isFinite(n)) continue;
      const v = Math.max(min, Math.min(max, n));
      options[key] = whole ? Math.round(v) : v;
    }
  }
  options.num_ctx = contextFor(chars);
  out.options = options;
  if (typeof body.think === 'boolean') out.think = body.think;
  out.keep_alive = KEEP_ALIVE;
  return out;
}

// Ollama lists embedding models too; they can't chat.
const chatModel = (m) => !/embed/i.test(m?.name || '') && !(m?.details?.families || []).some((f) => /bert/i.test(f));

// "llama3.1" is "llama3.1:latest" to Ollama.
const sameModel = (a, b) => a === b || `${a}:latest` === b || a === `${b}:latest`;

function readAll(res, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    res.on('data', (c) => {
      size += c.length;
      if (size > limit) res.destroy(new Error('answer too large'));
      else chunks.push(c);
    });
    res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    res.on('error', reject);
  });
}

// Ollama's error message, from an error answer (for the log, and for
// deciding what to try again without: never passed on as it is, as it can
// say things about the AI server).
export function errorText(text) {
  try {
    return String(JSON.parse(text).error || '').slice(0, 300);
  } catch {
    return '';
  }
}

export class SharedModel {
  constructor({ url, key = '', model = '', log }) {
    this.base = new URL(`${String(url).replace(/\/+$/, '')}/`);
    this.key = key;
    this.configured = model;
    this.log = log;
    this.list = null; // { names, at }
    this.listing = null;
    this.pickedSaid = null;
    this.loads = new Map(); // `${model}|${num_ctx}` -> the load under way
    this.ps = null; // { names, at }: the models in memory
    // What this Ollama turned down lately, and so isn't asked for for an
    // hour (in case it's updated meanwhile): "think" (models or versions
    // without it), answer formats as schemas (Ollama before 0.5 only knows
    // plain JSON).
    this.noThinkAt = 0;
    this.plainJsonAt = 0;
  }

  // A chat as this Ollama takes it.
  adapt(chat) {
    const out = { ...chat };
    const now = Date.now();
    if (now - this.noThinkAt < RETRY_FOR_MS) delete out.think;
    if (now - this.plainJsonAt < RETRY_FOR_MS && out.format && typeof out.format === 'object') out.format = 'json';
    return out;
  }

  // Whether a chat Ollama turned down (400) can go again without what it
  // objected to: `sent` is the chat as it went. Remembered for the next ones.
  retryWithout(sent, message) {
    if ('think' in sent && /think/i.test(message)) {
      this.noThinkAt = Date.now();
      return true;
    }
    if (sent.format && typeof sent.format === 'object' && /format|schema|unmarshal|json/i.test(message)) {
      this.plainJsonAt = Date.now();
      return true;
    }
    return false;
  }

  // A request to Ollama; resolves with the response once its headers are in.
  request(path, { method = 'GET', body = null, signal, idleMs = 15000 } = {}) {
    return new Promise((resolve, reject) => {
      const url = new URL(path.replace(/^\/+/, ''), this.base);
      const lib = url.protocol === 'https:' ? https : http;
      const headers = { Accept: 'application/json' };
      if (this.key) headers.Authorization = `Bearer ${this.key}`;
      let data = null;
      if (body) {
        data = Buffer.from(JSON.stringify(body));
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = String(data.length);
      }
      const req = lib.request(url, { method, headers, signal, timeout: idleMs }, resolve);
      req.on('timeout', () => req.destroy(Object.assign(new Error('the AI server stopped answering'), { code: 'ETIMEDOUT' })));
      req.on('error', reject);
      req.end(data);
    });
  }

  // The chat models installed, asked at most once a minute.
  async installed() {
    if (this.list && Date.now() - this.list.at < 60000) return this.list.names;
    this.listing ||= (async () => {
      try {
        const res = await this.request('/api/tags', { idleMs: 10000 });
        const text = await readAll(res, 4 * 1024 * 1024);
        if (res.statusCode !== 200) throw new Error(`the AI server answered ${res.statusCode}`);
        const names = (JSON.parse(text).models || [])
          .filter(chatModel)
          .map((m) => String(m.name || m.model || ''))
          .filter(Boolean)
          .sort((a, b) => a.localeCompare(b));
        this.list = { names, at: Date.now() };
        return names;
      } finally {
        this.listing = null;
      }
    })();
    return this.listing;
  }

  // The model in use: OLLAMA_MODEL, or else the first chat model installed.
  async model() {
    if (this.configured) return this.configured;
    let names;
    try {
      names = await this.installed();
    } catch (err) {
      // (Why goes to the log: it names the AI server's address.)
      this.log?.warn(`shared AI: couldn't list the AI server's models: ${err.message}`);
      throw new AIRequestError(502, 'The AI server didn’t answer. Check that Ollama is running.');
    }
    if (!names.length) throw new AIRequestError(503, 'The AI server has no models installed.');
    if (this.pickedSaid !== names[0]) {
      this.pickedSaid = names[0];
      this.log?.info(`shared AI: OLLAMA_MODEL isn't set, so the first model installed on the AI server is used: ${names[0]}`);
    }
    return names[0];
  }

  // Whether the model is in memory now (Ollama's /api/ps, asked at most every
  // five seconds); null if that couldn't be told.
  async loaded(model) {
    try {
      if (!this.ps || Date.now() - this.ps.at > 5000) {
        const res = await this.request('/api/ps', { idleMs: 10000 });
        const text = await readAll(res, 1024 * 1024);
        if (res.statusCode !== 200) return null;
        this.ps = { names: (JSON.parse(text).models || []).map((m) => String(m.name || m.model || '')), at: Date.now() };
      }
      return this.ps.names.some((n) => sameModel(n, model));
    } catch {
      return null;
    }
  }

  // Loads the model (a moment if it's in memory already), the way a chat
  // asks for it, in a request this service makes for itself: Ollama stops
  // loading a model when the request that asked for it goes, and someone who
  // gives up waiting (or a proxy along the way) mustn't stop it, so the next
  // request finds it ready. One load at a time of each.
  load(model, { numCtx, keepAlive } = {}) {
    const key = `${model}|${numCtx || ''}`;
    if (this.loads.has(key)) return this.loads.get(key);
    const started = Date.now();
    const body = { model, keep_alive: keepAlive || '15m' };
    if (numCtx) body.options = { num_ctx: numCtx };
    const job = (async () => {
      let res;
      try {
        res = await this.request('/api/generate', { method: 'POST', body, idleMs: AI_LIMITS.loadMs });
      } catch (err) {
        throw Object.assign(new AIRequestError(502, 'The AI server didn’t answer. Check that Ollama is running.'), { detail: err.message });
      }
      const text = await readAll(res, 1024 * 1024);
      if (res.statusCode !== 200) {
        // "model 'x' not found" is a 404; what else Ollama said is for the log.
        const detail = errorText(text) || `the AI server answered ${res.statusCode}`;
        if (res.statusCode === 404) throw Object.assign(new AIRequestError(404, `The model "${model}" isn’t installed on the AI server.`), { detail });
        throw Object.assign(new AIRequestError(502, 'The AI server couldn’t load the model. Whoever runs this player can see why in its log.'), { detail });
      }
      const seconds = (Date.now() - started) / 1000;
      if (seconds > 2) this.log?.info(`shared AI: loaded ${model} in ${Math.round(seconds)} s`);
      this.ps = null;
    })().finally(() => this.loads.delete(key));
    this.loads.set(key, job);
    return job;
  }

  // For the app: the model's name, whether it's ready to use, and whether
  // it's in memory. Nothing else about the AI server.
  async status() {
    let names;
    try {
      names = await this.installed();
    } catch {
      return { model: this.configured || null, ready: false, problem: 'unreachable' };
    }
    const model = this.configured || names[0] || null;
    if (!model) return { model: null, ready: false, problem: 'no-model' };
    const ready = names.some((n) => sameModel(n, model));
    const loading = [...this.loads.keys()].some((k) => k.startsWith(`${model}|`));
    return { model, ready, problem: ready ? null : 'not-installed', loaded: ready ? (loading ? false : await this.loaded(model)) : false, loading };
  }
}
