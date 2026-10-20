// Songs and artists that AI playlists suggested but the library doesn't
// have (Settings › AI › Missing tracks), so whoever looks after the server
// can go and find them. Kept on this device (until it's cleared, or you sign
// out), and exported as a spreadsheet (CSV) or plain text.
import { store } from './plex.js';
import { app, emit } from './state.js';
import { norm, songInLibrary, artistInLibrary } from './ai.js';

const KEY = 'aiMissing';
const LIMIT = 500;

const keyOf = (m) => `${m.kind}|${norm(m.artist)}|${norm(m.title)}`;
const sameLibrary = (m, src = app.source) => !!src && m.server === (src.serverId || src.uri) && String(m.section) === String(src.sectionKey);
const libraryName = (src = app.source) => (src ? `${src.sectionTitle} (${src.serverName})` : '');

function load() {
  const list = store.get(KEY, []);
  return Array.isArray(list) ? list.filter((m) => m && (m.kind === 'track' || m.kind === 'artist') && typeof m.artist === 'string') : [];
}

function save(list) {
  store.set(KEY, list);
  emit('missing', list.length);
}

// Everything kept, artists first, then by artist and title.
export function missingList() {
  const by = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
  return load().sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'artist' ? -1 : 1) || by.compare(a.artist, b.artist) || by.compare(a.title || '', b.title || ''));
}

export const missingCount = () => load().length;

// What an AI playlist found missing (and found there), for the request
// `prompt`: new ones are added, ones seen before counted again, and ones
// now in the library let go.
export function noteMissing(missing = [], seen = { songs: [], artists: [] }, prompt = '') {
  const src = app.source;
  if (!src) return;
  const now = Math.round(Date.now() / 1000);
  const here = (m) => sameLibrary(m, src);
  const foundKeys = new Set([
    ...(seen.songs || []).map((x) => keyOf({ kind: 'track', artist: x.artist || '', title: x.title || '' })),
    ...(seen.artists || []).map((a) => keyOf({ kind: 'artist', artist: a, title: '' })),
  ]);
  let list = load().filter((m) => !(here(m) && foundKeys.has(keyOf(m))));
  for (const m of missing) {
    const entry = { kind: m.kind, artist: String(m.artist || '').slice(0, 120), title: m.kind === 'track' ? String(m.title || '').slice(0, 160) : '' };
    if (!entry.artist && !entry.title) continue;
    const k = keyOf(entry);
    const have = list.find((x) => here(x) && keyOf(x) === k);
    if (have) {
      have.times = (have.times || 1) + 1;
      have.last = now;
      have.prompt = String(prompt).slice(0, 200);
    } else {
      list.push({ ...entry, times: 1, first: now, last: now, prompt: String(prompt).slice(0, 200), server: src.serverId || src.uri, section: String(src.sectionKey), library: libraryName(src) });
    }
  }
  // The most recently suggested are kept.
  if (list.length > LIMIT) list = list.sort((a, b) => (b.last || 0) - (a.last || 0)).slice(0, LIMIT);
  save(list);
}

export function forgetMissing(entry) {
  const k = keyOf(entry);
  save(load().filter((m) => !(keyOf(m) === k && m.server === entry.server && m.section === entry.section)));
}

export function clearMissing() {
  save([]);
}

// Looks for each one in this library again (after adding music), and lets
// go of what's there now. Resolves to how many were found.
export async function checkMissingAgain({ signal, onProgress } = {}) {
  const todo = load().filter((m) => sameLibrary(m));
  const found = new Set();
  let n = 0;
  for (const m of todo) {
    if (signal?.aborted) break;
    const there = m.kind === 'artist' ? await artistInLibrary(m.artist, signal) : await songInLibrary({ artist: m.artist, title: m.title }, signal);
    if (there) found.add(`${keyOf(m)}|${m.server}|${m.section}`);
    onProgress?.(++n, todo.length);
  }
  if (found.size) save(load().filter((m) => !found.has(`${keyOf(m)}|${m.server}|${m.section}`)));
  return found.size;
}

// ---------- export ----------

const day = (sec) => (sec ? new Date(sec * 1000).toISOString().slice(0, 10) : '');

// A cell for a spreadsheet: quoted, and never read as a formula.
function cell(v) {
  let text = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

// With a byte-order mark, so spreadsheet apps read it as UTF-8 ("—", "é").
export function missingCsv(list = missingList()) {
  const head = ['Artist', 'Title', 'Missing', 'Times suggested', 'Last suggested', 'Library', 'Asked for'];
  const rows = list.map((m) => [m.artist, m.title, m.kind === 'artist' ? 'Artist' : 'Track', m.times || 1, day(m.last), m.library, m.prompt]);
  return `\ufeff${[head, ...rows].map((r) => r.map(cell).join(',')).join('\r\n')}\r\n`;
}

export function missingText(list = missingList()) {
  const lines = list.map((m) => (m.kind === 'artist' ? `${m.artist} (no music by them)` : `${m.artist ? `${m.artist} — ` : ''}${m.title}`));
  return `${lines.join('\n')}\n`;
}

// Hands the browser a file to save.
export function download(text, name, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// Copies text, with a fallback for pages served over plain http (where the
// clipboard API isn't available).
export async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.append(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}

export const fileDate = () => new Date().toISOString().slice(0, 10);
