// Logging for the service. Every line goes through redact(), so tokens and
// keys never reach the container log, even when a message quotes a URL.

let debugOn = false;

export function setDebug(on) {
  debugOn = !!on;
}

export const isDebug = () => debugOn;

const SECRET_PARAMS = /([?&;](?:X-Plex-Token|X-Plex-Server-Token|token|authToken|apiKey|api_key|key)=)[^&#\s"']*/gi;
const SECRET_JSON = /("(?:authToken|accessToken|token|apiKey|api_key|X-Plex-Token)"\s*:\s*")[^"]*/gi;
const BEARER = /(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi;
const PLEX_TOKEN_LIKE = /\b(?=[A-Za-z0-9_-]{20}\b)(?=[A-Za-z0-9_-]*[0-9])(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{20}\b/g;

// Remove credentials from free text. Plex tokens are 20-character strings,
// so anything of that exact shape is masked too, in case one turns up bare.
export function redact(text) {
  return String(text ?? '')
    .replace(SECRET_PARAMS, '$1[redacted]')
    .replace(SECRET_JSON, '$1[redacted]')
    .replace(BEARER, '$1[redacted]')
    .replace(PLEX_TOKEN_LIKE, '[redacted]');
}

// One line, printable characters only, bounded length: text from browsers
// can't forge extra log lines or flood the log.
export function oneLine(text, max = 500) {
  const s = redact(text)
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
    .trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function write(stream, level, msg) {
  stream.write(`plexamp-web service: ${level === 'info' ? '' : `${level}: `}${oneLine(msg, 2000)}\n`);
}

export const log = {
  info: (msg) => write(process.stdout, 'info', msg),
  warn: (msg) => write(process.stderr, 'warning', msg),
  error: (msg) => write(process.stderr, 'error', msg),
  debug: (msg) => debugOn && write(process.stdout, 'debug', msg),
  // Lines relayed from browsers in debug mode.
  browser: (client, level, area, msg) =>
    process.stdout.write(`plexamp-web browser ${oneLine(client, 12)}: ${oneLine(level, 8)} ${oneLine(area, 24)}: ${oneLine(msg)}\n`),
  // nginx's error log in debug mode (see syslog.js).
  nginx: (msg) => process.stderr.write(`plexamp-web nginx: ${oneLine(msg, 2000)}\n`),
};
