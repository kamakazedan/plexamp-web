// Songs and artists that AI playlists suggested but the library doesn't
// have (Settings › AI › Missing tracks), so whoever looks after the server
// can go and find them. Kept on this device (until it's cleared, or you sign
// out), each with the Plex server and library it's missing from: the list
// shows the server in use's (different servers have different music). It's
// exported as a spreadsheet (CSV) or plain text.
//
// AI models make songs up, and take albums for songs. Where the player has
// a MusicBrainz to ask (MUSICBRAINZ_URL) and Settings › AI › Check
// suggestions on MusicBrainz is on, an AI playlist's suggestions are looked
// up there before they're listed (see checkSuggestions): those it doesn't
// know, and albums, never come here, and those it knows are marked (mb:
// 'real'). Ones listed without being checked (before there was a
// MusicBrainz to ask) can be checked from the list (checkMissingOnMusicBrainz).
import { store } from './plex.js';
import { app, emit } from './state.js';
import { norm, songInLibrary, artistInLibrary, aiSettings } from './ai.js';

const KEY = 'aiMissing';
const LIMIT = 500;

const keyOf = (m) => `${m.kind}|${norm(m.artist)}|${norm(m.title)}`;
const sameServer = (m, src = app.source) => !!src && m.server === (src.serverId || src.uri);
const sameLibrary = (m, src = app.source) => sameServer(m, src) && String(m.section) === String(src.sectionKey);
const libraryName = (src = app.source) => (src ? `${src.sectionTitle} (${src.serverName})` : '');

// (0.12.0 kept what MusicBrainz didn't know, and albums, hidden: they go.)
function load() {
  const list = store.get(KEY, []);
  return Array.isArray(list) ? list.filter((m) => m && (m.kind === 'track' || m.kind === 'artist') && typeof m.artist === 'string' && m.mb !== 'unknown' && m.mb !== 'album') : [];
}

function save(list) {
  store.set(KEY, list);
  emit('missing', missingCount());
}

{
  const kept = store.get(KEY, []);
  if (Array.isArray(kept) && kept.some((m) => m?.mb === 'unknown' || m?.mb === 'album')) store.set(KEY, load());
}

// What's kept for the server in use, artists first, then by artist and
// title.
export function missingList() {
  const by = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
  return load()
    .filter((m) => sameServer(m))
    .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'artist' ? -1 : 1) || by.compare(a.artist, b.artist) || by.compare(a.title || '', b.title || ''));
}

export const missingCount = () => load().filter((m) => sameServer(m)).length;

// ---------- MusicBrainz ----------

// The player has a MusicBrainz to ask, and this device asks it (on unless
// turned off). Where: musicbrainz.org, or the player's own.
export const mbOffered = () => !!app.config.musicbrainz;
export const mbOn = () => mbOffered() && aiSettings().musicbrainz !== false;
export const mbWhere = () => (app.config.musicbrainz === 'own' ? 'the player’s own MusicBrainz server' : 'musicbrainz.org');

const BATCH = 5;

// Which of an AI playlist's suggestions MusicBrainz knows, a few at a time
// (through the player's service): in the same order, 'real', 'album' (an
// album taken for a song), 'unknown', or null where it couldn't say. Throws
// if MusicBrainz can't be asked at all (err.verdicts: what it said before
// that). Called off (`signal`), it resolves to what it said so far.
// onProgress(done, of).
export async function checkSuggestions(list, { signal, onProgress } = {}) {
  const verdicts = list.map(() => null);
  // Who's asking, checked by the player as for its shared AI model (people
  // who can use its Plex server).
  const headers = { 'Content-Type': 'application/json', 'X-Plex-Token': app.auth?.token || '' };
  if (app.source?.token && app.source.token !== app.auth?.token) headers['X-Plex-Server-Token'] = app.source.token;
  for (let i = 0; i < list.length; i += BATCH) {
    if (signal?.aborted) break;
    const batch = list.slice(i, i + BATCH);
    let res;
    let data = null;
    try {
      res = await fetch('api/musicbrainz/check', {
        method: 'POST',
        headers,
        body: JSON.stringify({ items: batch.map((m) => ({ kind: m.kind, artist: m.artist, title: m.title })) }),
        credentials: 'omit',
        signal,
      });
      if (res.ok) data = await res.json();
    } catch {
      if (signal?.aborted) break;
      throw Object.assign(new Error('MusicBrainz couldn’t be asked: the player didn’t answer.'), { status: 0, verdicts });
    }
    if (!res.ok) {
      let message = '';
      try {
        message = (await res.json()).error || '';
      } catch {
        /* no explanation */
      }
      throw Object.assign(new Error(message || `MusicBrainz couldn’t be asked (HTTP ${res.status}).`), { status: res.status, verdicts });
    }
    const results = Array.isArray(data?.results) ? data.results : [];
    batch.forEach((_, j) => {
      const v = results[j];
      verdicts[i + j] = ['real', 'album', 'unknown'].includes(v) ? v : null;
    });
    onProgress?.(Math.min(i + BATCH, list.length), list.length);
  }
  return verdicts;
}

// What an AI playlist found missing (and found there), for the request
// `prompt`: new ones are added, ones seen before counted again, and ones
// now in the library let go, as are those in `drop` (what MusicBrainz says
// isn't real, kept from before it was asked). Those MusicBrainz knows come
// with mb: 'real'.
export function noteMissing(missing = [], seen = { songs: [], artists: [] }, prompt = '', { drop = [] } = {}) {
  const src = app.source;
  if (!src) return;
  const now = Math.round(Date.now() / 1000);
  const here = (m) => sameLibrary(m, src);
  const foundKeys = new Set([
    ...(seen.songs || []).map((x) => keyOf({ kind: 'track', artist: x.artist || '', title: x.title || '' })),
    ...(seen.artists || []).map((a) => keyOf({ kind: 'artist', artist: a, title: '' })),
    ...drop.map((m) => keyOf({ kind: m.kind, artist: m.artist || '', title: m.kind === 'track' ? m.title || '' : '' })),
  ]);
  let list = load().filter((m) => !(here(m) && foundKeys.has(keyOf(m))));
  for (const m of missing) {
    const entry = { kind: m.kind, artist: String(m.artist || '').slice(0, 120), title: m.kind === 'track' ? String(m.title || '').slice(0, 160) : '' };
    if (!entry.artist && !entry.title) continue;
    if (m.mb === 'real') entry.mb = 'real';
    const k = keyOf(entry);
    const have = list.find((x) => here(x) && keyOf(x) === k);
    if (have) {
      have.times = (have.times || 1) + 1;
      have.last = now;
      have.prompt = String(prompt).slice(0, 200);
      if (entry.mb) have.mb = entry.mb;
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

// The server in use's list, cleared (other servers' stay).
export function clearMissing() {
  save(load().filter((m) => !sameServer(m)));
}

// Looks for each of the server in use's again, in the library it was
// missing from (after adding music), and lets go of what's there now.
// Resolves to how many were found.
export async function checkMissingAgain({ signal, onProgress } = {}) {
  const todo = load().filter((m) => sameServer(m));
  const found = new Set();
  let n = 0;
  for (const m of todo) {
    if (signal?.aborted) break;
    const section = m.section || app.source.sectionKey;
    const there = m.kind === 'artist' ? await artistInLibrary(m.artist, signal, section) : await songInLibrary({ artist: m.artist, title: m.title }, signal, { section });
    if (there) found.add(`${keyOf(m)}|${m.server}|${m.section}`);
    onProgress?.(++n, todo.length);
  }
  if (found.size) save(load().filter((m) => !found.has(`${keyOf(m)}|${m.server}|${m.section}`)));
  return found.size;
}

const idOf = (m) => `${keyOf(m)}|${m.server}|${m.section}`;

// The ones listed without being checked on MusicBrainz (made before there
// was one to ask, or while it couldn't be asked), looked up there now: those
// it doesn't know (most likely made up) and albums taken for songs are let
// go, those it knows are marked so they're not asked about again. Resolves
// to { asked, real, dropped (the entries let go, with mb: 'unknown' or
// 'album'), unsure (couldn't be checked this time) }. If MusicBrainz can't
// be asked, what it said before that still counts, and it throws with
// err.result set.
export async function checkMissingOnMusicBrainz({ signal, onProgress } = {}) {
  const todo = load().filter((m) => sameServer(m) && m.mb !== 'real');
  let verdicts;
  let failed = null;
  try {
    verdicts = await checkSuggestions(todo, { signal, onProgress });
  } catch (err) {
    verdicts = err.verdicts || [];
    failed = err;
  }
  const said = new Map(todo.map((m, i) => [idOf(m), verdicts[i] || null]));
  const dropped = [];
  let real = 0;
  const kept = [];
  for (const m of load()) {
    const v = said.get(idOf(m));
    if (v === 'unknown' || v === 'album') {
      dropped.push({ ...m, mb: v });
      continue;
    }
    if (v === 'real') {
      m.mb = 'real';
      real += 1;
    }
    kept.push(m);
  }
  if (dropped.length || real) save(kept);
  const answered = verdicts.filter(Boolean).length;
  const result = { asked: todo.length, real, dropped, unsure: todo.length - answered };
  if (failed) throw Object.assign(failed, { result });
  return result;
}

// Puts entries let go back on the list (an undo), unchecked again.
export function restoreMissing(entries = []) {
  const list = load();
  const have = new Set(list.map(idOf));
  for (const m of entries) {
    if (!m || have.has(idOf(m))) continue;
    const entry = { ...m };
    delete entry.mb;
    list.push(entry);
    have.add(idOf(m));
  }
  save(list.length > LIMIT ? list.sort((a, b) => (b.last || 0) - (a.last || 0)).slice(0, LIMIT) : list);
}

// ---------- export ----------

const day = (sec) => (sec ? new Date(sec * 1000).toISOString().slice(0, 10) : '');

// A cell for a spreadsheet: quoted, and never read as a formula.
function cell(v) {
  let text = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

// A spreadsheet (CSV), with a byte-order mark, so spreadsheet apps read it
// as UTF-8 ("—", "é").
export const toCsv = (head, rows) => `\ufeff${[head, ...rows].map((r) => r.map(cell).join(',')).join('\r\n')}\r\n`;

// What's shared with whoever finds the music: what's missing, not what you
// asked the AI for (that's only shown here).
export function missingCsv(list = missingList()) {
  const head = ['Artist', 'Title', 'Missing', 'Times suggested', 'Last suggested', 'Library'];
  return toCsv(head, list.map((m) => [m.artist, m.title, m.kind === 'artist' ? 'Artist' : 'Track', m.times || 1, day(m.last), m.library]));
}

export function missingText(list = missingList()) {
  const lines = list.map((m) => (m.kind === 'artist' ? `${m.artist} (no music by them)` : `${m.artist ? `${m.artist} — ` : ''}${m.title}`));
  return `${lines.join('\n')}\n`;
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
