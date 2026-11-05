// Debug mode (DEBUG=true on the container). Problems in the browser (failed
// requests, playback errors and stutters, script errors, connection
// choices, the page held up) are written to the browser console and sent to
// the container's log, so whoever runs the container can see what went
// wrong for someone else.
//
// Tokens and keys are removed before anything is logged or sent, and URLs
// lose their query strings. With debug mode off this does nothing.
//
// No imports here: plex.js and player.js use this, and it must not pull
// the rest of the app in with it.

const enabled = !!(window.PW_CONFIG && window.PW_CONFIG.debug);
const queue = [];
let timer = null;

// The start of this browser's client ID, so lines from one browser can be
// told apart (read when sending: it's created on first sign-in).
const client = () => {
  try {
    return String(JSON.parse(localStorage.getItem('pw.clientId')) || '').slice(0, 8) || 'new';
  } catch {
    return 'unknown';
  }
};

export const debugOn = () => enabled;

// For lines here: `ms` as seconds, to a hundredth under one (a stutter can
// be a tenth of a second).
export function seconds(ms) {
  const s = Math.max(0, Number(ms) || 0) / 1000;
  return s < 1 ? s.toFixed(2) : s.toFixed(1);
}

// ...and `bytes` as megabytes, to a tenth under ten.
export function megabytes(bytes) {
  const mb = Math.max(0, Number(bytes) || 0) / 1048576;
  return mb < 10 ? mb.toFixed(1) : String(Math.round(mb));
}

// As the service does (server/log.js): in query strings (also inside another
// address, URL-encoded), headers and JSON.
const SECRET_NAMES = 'X-Plex-Token|X-Plex-Server-Token|token|authToken|accessToken|apiKey|api_key|key|pin';
const SECRET_PARAMS = new RegExp(`((?:^|[?&;]|%3F|%26|%3B)(?:${SECRET_NAMES})(?:=|%3D))(?:(?!%26|%23)[^&#\\s"'])*`, 'gi');

export function redact(text) {
  return String(text ?? '')
    .replace(SECRET_PARAMS, '$1[redacted]')
    .replace(/(X-Plex-(?:Server-)?Token\s*:\s*)[A-Za-z0-9._~+/=-]+/gi, '$1[redacted]')
    .replace(/("(?:authToken|accessToken|token|apiKey|api_key|X-Plex-Token|X-Plex-Server-Token|pin)"\s*:\s*")[^"]*/gi, '$1[redacted]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[redacted]');
}

// A URL without its query string, where Plex tokens travel.
export function safeUrl(url) {
  try {
    const u = new URL(url, location.href);
    return `${u.origin === location.origin ? '' : u.origin}${u.pathname}`;
  } catch {
    return '[address]';
  }
}

export function debugLog(area, message, level = 'info') {
  if (!enabled) return;
  const text = redact(String(message ?? '').slice(0, 1500)).replace(/\s+/g, ' ').slice(0, 500);
  console.info(`[plexamp-web] ${level} ${area}: ${text}`);
  queue.push({ level, area, message: text });
  if (queue.length > 200) queue.splice(0, queue.length - 200);
  timer ||= setTimeout(flush, 2000);
}

// keepalive only as the page goes away: it's what lets that last batch out,
// and it's limited in size.
function flush(unloading = false) {
  timer = null;
  if (!queue.length) return;
  const entries = queue.splice(0, 40);
  fetch('api/debug/log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client: client(), entries }),
    keepalive: unloading === true,
    credentials: 'same-origin',
  })
    .catch(() => {})
    .finally(() => {
      if (queue.length) timer ||= setTimeout(flush, 2000);
    });
}

// The page held up for HELD_UP_MS or more (a busy computer, or the app
// itself), where the browser says so (Chrome and Edge do): a line at most
// every HELD_UP_EVERY_MS, saying how many more there were since the last.
const HELD_UP_MS = 500;
const HELD_UP_EVERY_MS = 30000;
function watchHoldUps() {
  if (!globalThis.PerformanceObserver?.supportedEntryTypes?.includes('longtask')) return;
  let last = -Infinity;
  let more = 0;
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (e.duration < HELD_UP_MS) continue;
        if (e.startTime - last < HELD_UP_EVERY_MS) {
          more += 1;
          continue;
        }
        debugLog('page', `held up for ${seconds(e.duration)} s${more ? ` (and ${more} more times since the last line like this)` : ''}`);
        last = e.startTime;
        more = 0;
      }
    }).observe({ type: 'longtask', buffered: true });
  } catch {
    /* not here after all */
  }
}

if (enabled) {
  window.addEventListener('error', (e) => debugLog('page', `${e.message} (${safeUrl(e.filename || '')}:${e.lineno || 0})`, 'error'));
  window.addEventListener('unhandledrejection', (e) => {
    if (e.reason?.aborted) return;
    debugLog('page', `unhandled: ${e.reason?.message || e.reason}`, 'error');
  });
  window.addEventListener('pagehide', () => flush(true));
  debugLog('app', `opened in ${navigator.userAgent} (${window.innerWidth}x${window.innerHeight}, ${navigator.onLine ? 'online' : 'offline'})`);
  watchHoldUps();
}
