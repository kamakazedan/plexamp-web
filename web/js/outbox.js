// What couldn't reach the Plex server as the connection had gone (see
// connection.js), kept for when it's back: a track's last play report (so
// a track that played from what was loaded ahead counts, as it would have)
// and ratings. Kept with this device's other things for whoever's signed in
// (the store: gone as they sign out, or switch to someone else in their
// Plex Home, and never written for anyone else), each for its server, for
// two weeks at most. Sent once the server answers again, oldest first, one
// tab at a time; a rating rated again meanwhile is sent only as it is now,
// and one the server refuses is let go (ratings.js says so).
import { app, on } from './state.js';
import { store } from './plex.js';
import { connection, connectionLost, connectionBack, unreachable, serverAnswers } from './connection.js';
import { debugLog } from './debug.js';

const KEY = 'outbox';
const MAX = 500;
const MAX_AGE = 14 * 86400000;
const AGAIN_MS = 20000;
// Tries at one the server answers otherwise, but fails (a 500, say), or
// doesn't answer in time, before it's let go.
const TRIES = 3;

// kind -> { send: async (item) => true (sent), or false (the server refused
// it): throws { network } for the connection gone again; letGo(item): one
// that couldn't be sent, let go (see TRIES) }.
const senders = new Map();
export function sendsWith(kind, send, { letGo = null } = {}) {
  senders.set(kind, { send, letGo });
}

const KINDS = new Set(['played', 'rated']);
const fresh = (x) =>
  x && typeof x === 'object' && KINDS.has(x.kind) && typeof x.key === 'string' && typeof x.server === 'string' && /^[0-9]{1,12}$/.test(String(x.id)) && Date.now() - x.at < MAX_AGE && x.at <= Date.now() + 60000;

function load() {
  const v = store.get(KEY);
  return Array.isArray(v) ? v.filter(fresh) : [];
}

function save(items) {
  store.set(KEY, items.length ? items.slice(-MAX) : null);
}

// Kept, in place of one of its `key` from before. (Not where it's for no
// server, or for none in particular.)
export function keep(item) {
  if (!app.source?.serverId || !KINDS.has(item.kind)) return;
  const x = { ...item, id: String(item.id), server: app.source.serverId, at: Date.now() };
  save([...load().filter((y) => y.key !== x.key || y.server !== x.server), x]);
  debugLog('offline', `kept for when the connection's back: ${x.kind} (${load().length} kept)`);
  later();
}

// One taken out (forget), put back as it was.
export function restore(item) {
  if (!item || !fresh(item)) return;
  save([...load().filter((y) => y.key !== item.key || y.server !== item.server), item]);
  later();
}

// One kept from before, for this server, of this `key` (taken out: what it
// was for has been done since).
export function forget(key) {
  const items = load();
  const was = items.find((x) => x.key === key && x.server === app.source?.serverId);
  if (was) save(items.filter((x) => x !== was));
  return was || null;
}

export function kept(key) {
  return load().find((x) => x.key === key && x.server === app.source?.serverId) || null;
}

export function keptOf(kind) {
  return load().filter((x) => x.kind === kind && x.server === app.source?.serverId);
}

// How many are kept, for every server (all go as the account signs out).
export const keptCount = () => load().length;

let timer = 0;
function later() {
  clearTimeout(timer);
  timer = setTimeout(flush, AGAIN_MS);
}

// Each kept for this server, sent in turn (another tab, sending them too,
// takes turns with this one: navigator.locks, where there is it). Stops at
// the first that can't get there yet, to try again in a while: never
// sooner than AGAIN_MS after, whatever asks for it (the connection back,
// say), so nothing can have it ask again and again.
let flushing = null;
let failedAt = 0;
export function flush() {
  clearTimeout(timer);
  const wait = failedAt + AGAIN_MS - Date.now();
  if (wait > 0) {
    timer = setTimeout(flush, wait);
    return Promise.resolve();
  }
  if (flushing) return flushing;
  flushing = (async () => {
    try {
      if (navigator.locks?.request) await navigator.locks.request('pw-outbox', send);
      else await send();
    } catch (err) {
      debugLog('offline', `couldn't send what was kept: ${err?.message || err}`, 'warn');
    } finally {
      flushing = null;
    }
  })();
  return flushing;
}

async function send() {
  for (let n = 0; n < MAX; n += 1) {
    const s = app.server;
    const next = load().find((x) => x.server === app.source?.serverId);
    // (Its sender not here yet, as the app starts: kept, for next time.)
    if (!next || !s || !senders.has(next.kind)) return;
    let sent = false;
    try {
      sent = await senders.get(next.kind).send(next);
    } catch (err) {
      if (unreachable(err)) {
        failedAt = Date.now();
        // The server not answering either: the connection's gone, and
        // what's kept goes once it's back.
        if (!(await serverAnswers())) {
          connectionLost();
          later();
          return;
        }
        // It answers, but not to this: it's this one that can't get
        // there (the server failing it, or too slow to answer it). Again
        // in a while, a few times, then let go.
        const tries = (Number(next.tries) || 0) + 1;
        if (tries < TRIES) {
          save(load().map((x) => (x.key === next.key && x.at === next.at ? { ...x, tries } : x)));
          later();
          return;
        }
        debugLog('offline', `a kept ${next.kind} couldn't be sent, ${TRIES} times, so it's let go: ${err?.message || err}`, 'warn');
        senders.get(next.kind).letGo?.(next);
      } else {
        debugLog('offline', `a kept ${next.kind} couldn't be sent: ${err?.message || err}`, 'warn');
      }
    }
    // (As they are now: another tab, or a rating rated again, may have
    // changed them meanwhile.)
    save(load().filter((x) => !(x.key === next.key && x.at === next.at)));
    if (sent) connectionBack();
    if (app.server !== s) return;
  }
}

// A track's last report, played to its end, say ('stopped': see plex.js
// timeline). Not once Sync recent plays is off (here, or on another device:
// it follows the account), as it would have been then. Nor where Plex has
// the track as played about when it was first sent (`sentAt`): it got
// there then, if not its answer (it timed out on its way back, say), and
// a play sent again could count twice.
const SENT_SLACK_MS = 30000; // (how far apart this device's clock and the server's can be, and then some)
sendsWith('played', async (x) => {
  if (app.settings.reportPlays === false) return false;
  const now = await app.server.metadata(x.id);
  const seen = Number(now?.lastViewedAt) * 1000 || 0;
  if (seen && seen >= (Number(x.sentAt) || x.at) - SENT_SLACK_MS && seen <= x.at + SENT_SLACK_MS) return false;
  const ok = await app.server.timeline({ id: x.id, duration: x.duration || undefined }, 'stopped', x.time, x.playback || undefined);
  if (!ok) throw Object.assign(new Error('network'), { network: true });
  return true;
});

// `sentAt`: when it was sent the first time (Date.now()).
export function keepPlayed(track, timeMs, playback, sentAt = Date.now()) {
  keep({
    kind: 'played',
    key: `played|${track.id}|${playback || ''}|${Math.round(timeMs)}`,
    id: track.id,
    duration: Number(track.duration) || 0,
    time: Math.max(0, Math.round(timeMs)),
    playback: playback || null,
    sentAt,
  });
}

// Tried again as the connection comes back, the browser says it's online,
// or a server's chosen; and a few seconds after the app starts, for any kept
// from before (the page closed while the connection was gone, say).
connection.addEventListener('back', () => flush());
window.addEventListener('online', () => flush());
on('source', () => app.server && flush());
if (load().length) timer = setTimeout(flush, 3000);
