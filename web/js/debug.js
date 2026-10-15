// Debug mode (DEBUG=true on the container). Problems in the browser (failed
// requests, playback errors, script errors, connection choices) are written
// to the browser console and sent to the container's log, so whoever runs
// the container can see what went wrong for someone else.
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

export function redact(text) {
  return String(text ?? '')
    .replace(/([?&;](?:X-Plex-Token|X-Plex-Server-Token|token|authToken|apiKey|api_key|key)=)[^&#\s"']*/gi, '$1[redacted]')
    .replace(/("(?:authToken|accessToken|token|apiKey|api_key|X-Plex-Token)"\s*:\s*")[^"]*/gi, '$1[redacted]')
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
  const text = redact(message).replace(/\s+/g, ' ').slice(0, 500);
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

if (enabled) {
  window.addEventListener('error', (e) => debugLog('page', `${e.message} (${safeUrl(e.filename || '')}:${e.lineno || 0})`, 'error'));
  window.addEventListener('unhandledrejection', (e) => {
    if (e.reason?.aborted) return;
    debugLog('page', `unhandled: ${e.reason?.message || e.reason}`, 'error');
  });
  window.addEventListener('pagehide', () => flush(true));
  debugLog('app', `opened in ${navigator.userAgent} (${window.innerWidth}x${window.innerHeight}, ${navigator.onLine ? 'online' : 'offline'})`);
}
