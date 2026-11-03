// Requests to this player's own service (its api/ paths: server/index.js),
// and which Plex sign-ins go with them, decided here in one place: the
// account's (X-Plex-Token), and, for what the service checks against the
// Plex server it's set up for (`server`: the shared AI model, MusicBrainz,
// Spotify), the sign-in for the server in use too, where that's another
// (X-Plex-Server-Token). Once the service has turned that one away (it's
// another server's), it isn't sent again till another server or library is
// chosen. Never with cookies (the service sets none), and never waited on
// for ever.
import { app, on } from './state.js';

const SERVICE_TIMEOUT = 30000; // (the service may ask plex.tv first, which can take a while)

let serverTokenRefused = false;
on('source', () => (serverTokenRefused = false));
on('signout', () => (serverTokenRefused = false));

// The sign-ins for a request, as headers (`token`: whose it is, the account
// signed in now unless given; `server`: see above).
export function serviceTokens({ token = app.auth?.token, server = false } = {}) {
  const headers = token ? { 'X-Plex-Token': token } : {};
  const own = app.source?.token;
  if (server && own && own !== app.auth?.token && !serverTokenRefused) headers['X-Plex-Server-Token'] = own;
  return headers;
}

// The service said no (401) to a request with the server's sign-in: it's
// left out from now on (see above).
export function refuseServerToken() {
  serverTokenRefused = true;
}

// A request to the service (`path`: 'api/…'), with `body` as JSON. Resolves
// to { ok, status, data (its JSON answer, or null), headers }; throws where
// nothing answers (`network`), once `signal` says stop (`aborted`), or when
// it takes longer than `timeout` (`timedOut`). A refusal of the server's
// sign-in is asked again without it.
export async function serviceFetch(path, { method = 'GET', body, signal, timeout = SERVICE_TIMEOUT, token, server = false, keepalive = false } = {}) {
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, timeout);
  const stop = () => ctrl.abort();
  if (signal?.aborted) ctrl.abort();
  else signal?.addEventListener('abort', stop, { once: true });
  const ask = (tokens) =>
    fetch(path, {
      method,
      cache: 'no-store',
      credentials: 'omit',
      keepalive,
      headers: { Accept: 'application/json', ...tokens, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
  try {
    const tokens = serviceTokens({ token, server });
    let res = await ask(tokens);
    if (res.status === 401 && tokens['X-Plex-Server-Token']) {
      refuseServerToken();
      delete tokens['X-Plex-Server-Token'];
      res = await ask(tokens);
    }
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      /* not JSON */
    }
    return { ok: res.ok, status: res.status, data, headers: res.headers };
  } catch (cause) {
    const aborted = !!signal?.aborted && !timedOut;
    throw Object.assign(new Error(aborted ? 'aborted' : timedOut ? 'no answer in time' : 'no answer'), { network: !aborted, aborted, timedOut, cause });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', stop);
  }
}
