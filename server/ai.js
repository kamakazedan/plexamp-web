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
  idleMs: 300000, // Ollama silent this long (loading a model can take a while)
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
  num_ctx: [512, 32768, true],
  num_predict: [1, 8192, true],
  repeat_penalty: [0, 3, false],
  seed: [0, 2147483647, true],
};

// How long Ollama keeps the model loaded after a request: at most an hour.
function keepAlive(v) {
  const m = /^(\d{1,5})([smh]?)$/.exec(String(v ?? ''));
  if (!m) return undefined;
  const seconds = Number(m[1]) * { '': 1, s: 1, m: 60, h: 3600 }[m[2]];
  return `${Math.min(seconds, 3600)}s`;
}

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
  else if (body.format && typeof body.format === 'object' && !Array.isArray(body.format)) out.format = body.format;
  if (body.options && typeof body.options === 'object') {
    const options = {};
    for (const [key, [min, max, whole]] of Object.entries(OPTIONS)) {
      const n = Number(body.options[key]);
      if (body.options[key] === undefined || body.options[key] === null || !Number.isFinite(n)) continue;
      const v = Math.max(min, Math.min(max, n));
      options[key] = whole ? Math.round(v) : v;
    }
    if (Object.keys(options).length) out.options = options;
  }
  if (typeof body.think === 'boolean') out.think = body.think;
  const keep = keepAlive(body.keep_alive);
  if (keep) out.keep_alive = keep;
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

export class SharedModel {
  constructor({ url, key = '', model = '', log }) {
    this.base = new URL(`${String(url).replace(/\/+$/, '')}/`);
    this.key = key;
    this.configured = model;
    this.log = log;
    this.list = null; // { names, at }
    this.listing = null;
    this.pickedSaid = null;
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
      throw new AIRequestError(502, `The AI server didn’t answer (${err.message}). Check that Ollama is running.`);
    }
    if (!names.length) throw new AIRequestError(503, 'The AI server has no models installed.');
    if (this.pickedSaid !== names[0]) {
      this.pickedSaid = names[0];
      this.log?.info(`shared AI: OLLAMA_MODEL isn't set, so the first model installed on the AI server is used: ${names[0]}`);
    }
    return names[0];
  }

  // For the app: the model's name, and whether it's ready to use. Nothing
  // else about the AI server.
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
    return { model, ready, problem: ready ? null : 'not-installed' };
  }
}
