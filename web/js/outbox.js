// What couldn't reach the Plex server as the connection had gone (see
// connection.js), kept for when it's back: a track's last play report (so
// a track that played from what was loaded ahead counts, as it would have)
// and ratings. Kept with this device's other things for whoever's signed in
// (the store: gone as they sign out, or switch to someone else in their
// Plex Home, and never written for anyone else), each for its server, for
// two weeks at most. Sent once the server answers again, oldest first, one
// tab at a time; a rating rated again meanwhile is sent only as it is now,
// and one the server refuses is let go (ratings.js says so). One that
// can't get there while the server answers otherwise waits a while, longer
// each time, the others going meanwhile, and is let go only once the
// server's plainly failed it several times.
import { app, on } from './state.js';
import { store } from './plex.js';
import { connection, connectionLost, connectionBack, unreachable, serverAnswers } from './connection.js';
import { debugLog } from './debug.js';

const KEY = 'outbox';
const MAX = 500;
const MAX_AGE = 14 * 86400000;
// After one that couldn't be sent, the next try at any, at the soonest.
const AGAIN_MS = 20000;
// After one the server answers otherwise couldn't be sent (no answer to it,
// or the server failing it), how long it waits before it's tried again, by
// how many times it's failed so (then the last, again and again: it's kept
// as long as anything is, but for one the server plainly fails, see
// SERVER_FAILS). Others go meanwhile.
const BACKOFF_MS = [20000, 60000, 5 * 60000, 15 * 60000, 60 * 60000];
// ...and how many times the server may plainly fail one (an answer of 500
// or more, rather than none) before it's let go.
const SERVER_FAILS = 5;
// How long after a play report that may have got there (sent, but without
// an answer) Plex is asked whether it has it, and it's sent again only if
// not: time enough for Plex to have had it, however slow it was to.
const CHECK_AFTER_MS = 60000;
// How long a report may take (plex.js timeline).
const SEND_MS = 15000;
// How far apart this device's clock and the server's can be (and then
// some), for when the server says it had something (lastViewedAt,
// lastRatedAt).
export const CLOCKS_APART_MS = 60000;
// (One waiting longer than any of the above: the clock's gone back since.)
const MAX_WAIT_MS = BACKOFF_MS[BACKOFF_MS.length - 1] + CHECK_AFTER_MS;

// kind -> { send: async (item, server) => true (sent), or false (the server
// refused it, or it's not to be sent after all): throws as plex.js does
// for the connection gone again (see connection.js unreachable), and
// { switched } for another server chosen meanwhile (see stillOn); letGo(item):
// one the server kept failing, let go (see SERVER_FAILS) }. `server`: the
// one it's for (app.server, as it was when it was sent).
const senders = new Map();
export function sendsWith(kind, send, { letGo = null } = {}) {
  senders.set(kind, { send, letGo });
}

// For senders, after each wait: not on, if another server's been chosen.
export function stillOn(server) {
  if (app.server !== server) throw Object.assign(new Error('another server was chosen'), { switched: true });
}

const KINDS = new Set(['played', 'rated']);
const fresh = (x) =>
  x && typeof x === 'object' && KINDS.has(x.kind) && typeof x.key === 'string' && typeof x.server === 'string' && /^[0-9]{1,12}$/.test(String(x.id)) && Date.now() - x.at < MAX_AGE && x.at <= Date.now() + 60000;
const same = (a, b) => a.key === b.key && a.at === b.at && a.server === b.server;
// Due to be tried: not waiting (see BACKOFF_MS and CHECK_AFTER_MS).
const due = (x, now = Date.now()) => !(Number(x.notBefore) > now) || Number(x.notBefore) - now > MAX_WAIT_MS;

function load() {
  const v = store.get(KEY);
  return Array.isArray(v) ? v.filter(fresh) : [];
}

function save(items) {
  store.set(KEY, items.length ? items.slice(-MAX) : null);
}

// One as it's kept now, with these changed.
function update(item, changes) {
  save(load().map((x) => (same(x, item) ? { ...x, ...changes } : x)));
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

// (When one last couldn't be sent: performance.now(), which no change of
// the clock moves.)
let failedAt = 0;
const gate = () => (failedAt ? failedAt + AGAIN_MS - performance.now() : 0);

// The next go, as the first of this server's is due (but never sooner than
// AGAIN_MS after one couldn't be sent).
function schedule() {
  clearTimeout(timer);
  const items = load().filter((x) => x.server === app.source?.serverId && senders.has(x.kind));
  if (!items.length || !app.server) return;
  const now = Date.now();
  const at = Math.min(...items.map((x) => (due(x, now) ? now : Number(x.notBefore))));
  timer = setTimeout(flush, Math.min(MAX_WAIT_MS, Math.max(at - now, gate(), 1000)));
}

// Each due for this server, sent in turn, oldest first (but those that have
// failed after the others; another tab, sending them too, takes turns with
// this one: navigator.locks, where there is it). Stops at
// the first that can't be sent, to go on in a while: never sooner than
// AGAIN_MS after, whatever asks for it (the connection back, say), so
// nothing can have it ask again and again.
let flushing = null;
export function flush() {
  clearTimeout(timer);
  const wait = gate();
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
      schedule();
    }
  })();
  return flushing;
}

async function send() {
  const s = app.server;
  const server = app.source?.serverId;
  if (!s || !server) return;
  // (Each once in a go, even were taking it out not kept.)
  const done = new Set();
  const name = (x) => `${x.server}|${x.key}|${x.at}`;
  let sooner = false;
  for (let n = 0; n < MAX; n += 1) {
    if (app.server !== s) return;
    const now = Date.now();
    const ready = load().filter((x) => x.server === server && senders.has(x.kind) && due(x, now) && !done.has(name(x)));
    if (!ready.length) return;
    // (The oldest of those that have failed least: one that's failed goes
    // after the others.)
    const next = ready.reduce((a, b) => ((Number(b.fails) || 0) < (Number(a.fails) || 0) ? b : a));
    done.add(name(next));
    let sent = false;
    try {
      sent = await senders.get(next.kind).send(next, s);
    } catch (err) {
      if (err?.switched || app.server !== s) return;
      if (!unreachable(err)) {
        debugLog('offline', `a kept ${next.kind} couldn't be sent: ${err?.message || err}`, 'warn');
      } else {
        failedAt = performance.now();
        // The server not answering either: the connection's gone, and
        // what's kept goes once it's back.
        const answers = await serverAnswers();
        if (app.server !== s) return;
        if (!answers) {
          connectionLost();
          return;
        }
        // It answers, but not to this one: it's this one that can't get
        // there just now (the answer to it lost, or the server failing it).
        // Again in a while, the others meanwhile; let go only once the
        // server's plainly failed it, several times.
        const was = load().find((x) => same(x, next)) || next;
        const fails = (Number(was.fails) || 0) + 1;
        const serverFails = (Number(was.serverFails) || 0) + (err?.status >= 500 ? 1 : 0);
        if (serverFails < SERVER_FAILS) {
          const wait = BACKOFF_MS[Math.min(fails, BACKOFF_MS.length) - 1];
          // (Not a wait from before further off than any: the clock's gone
          // back since.)
          const stored = Number(was.notBefore) || 0;
          const prior = stored - Date.now() <= MAX_WAIT_MS ? stored : 0;
          update(was, { fails, serverFails, notBefore: Math.max(prior, Date.now() + wait) });
          debugLog('offline', `a kept ${next.kind} couldn't be sent (${err?.message || err}): again in ${Math.round(wait / 1000)} s`, 'warn');
          return;
        }
        debugLog('offline', `a kept ${next.kind} was failed by the server ${SERVER_FAILS} times, so it's let go: ${err?.message || err}`, 'warn');
        senders.get(next.kind).letGo?.(next);
      }
    }
    // (As they are now: another tab, or a rating rated again, may have
    // changed them meanwhile.)
    save(load().filter((x) => !same(x, next)));
    if (sent && app.server === s) {
      connectionBack();
      if (!sooner) {
        sooner = true;
        waitLess();
      }
    }
  }
}

// After a patchy stretch: those that only got no answer (never the server
// failing them) wait no longer, now one's got there (or the connection's
// back), rather than waiting out their time, up to an hour: but for what
// a send of theirs that may have got there still needs (CHECK_AFTER_MS).
function waitLess() {
  const now = Date.now();
  let changed = false;
  const items = load().map((x) => {
    if (!(Number(x.notBefore) > now) || Number(x.serverFails) > 0) return x;
    const sends = (Array.isArray(x.sends) ? x.sends : []).map(Number).filter(Number.isFinite);
    const floor = sends.length ? Math.max(...sends) + CHECK_AFTER_MS : 0;
    const notBefore = floor > now ? floor : 0;
    if (notBefore === Number(x.notBefore)) return x;
    changed = true;
    return { ...x, notBefore };
  });
  if (changed) save(items);
}

// A track's last report, played to its end, say ('stopped': see plex.js
// timeline). Not once Sync recent plays is off (here, or on another device:
// it follows the account), as it would have been then. Nor twice: `sends`,
// when it's been sent that may have got there (without an answer: lost on
// its way back, say), and Plex is asked first whether it has the track as
// played then (lastViewedAt), no sooner than CHECK_AFTER_MS after.
sendsWith('played', async (x, s) => {
  if (app.settings.reportPlays === false) return false;
  const sends = (Array.isArray(x.sends) ? x.sends : []).map(Number).filter(Number.isFinite);
  if (sends.length) {
    const now = await s.metadata(x.id);
    stillOn(s);
    const seen = Number(now?.lastViewedAt) * 1000 || 0;
    if (seen && sends.some((t) => seen >= t - CLOCKS_APART_MS && seen <= t + SEND_MS + CLOCKS_APART_MS)) return false;
  }
  // (Not while the browser's offline: it's not sent at all, then.)
  if (navigator.onLine !== false) update(x, { sends: [...sends, Date.now()].slice(-20), notBefore: Date.now() + CHECK_AFTER_MS });
  const status = await s.timeline({ id: x.id, duration: x.duration || undefined }, 'stopped', x.time, x.playback || undefined);
  if (status > 0 && status < 500) return true;
  throw Object.assign(new Error(status ? `HTTP ${status}` : 'no answer'), status ? { status } : { network: true });
});

// `sentAt`: when it was sent (Date.now()), if it may have got there (null:
// it wasn't, the browser offline).
export function keepPlayed(track, timeMs, playback, sentAt = null) {
  keep({
    kind: 'played',
    key: `played|${track.id}|${playback || ''}|${Math.round(timeMs)}`,
    id: track.id,
    duration: Number(track.duration) || 0,
    time: Math.max(0, Math.round(timeMs)),
    playback: playback || null,
    sends: sentAt ? [sentAt] : [],
    ...(sentAt ? { notBefore: sentAt + CHECK_AFTER_MS } : {}),
  });
}

// Tried again as the connection comes back, the browser says it's online,
// or a server's chosen; and a few seconds after the app starts, for any kept
// from before (the page closed while the connection was gone, say).
connection.addEventListener('back', () => {
  waitLess();
  flush();
});
window.addEventListener('online', () => {
  waitLess();
  flush();
});
on('source', () => app.server && flush());
if (load().length) timer = setTimeout(flush, 3000);
