// Songs and artists that AI playlists suggested but the library doesn't
// have, and the tracks of playlists imported from Spotify it doesn't have
// (via: 'spotify'), in Settings › AI › Missing tracks, so whoever looks
// after the server can go and find them. Kept on this device (until it's cleared, or you sign
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
// Each server keeps the most recent of each: what AI playlists suggested, and
// what playlists from Spotify had (a whole account's can be thousands: an
// import's spreadsheet has all of its own). One doesn't push the other out,
// nor one server another's.
export const MISSING_LIMITS = { ai: 500, spotify: 1000 };
const sourceOf = (m) => (m.via === 'spotify' ? 'spotify' : 'ai');

const keyOf = (m) => `${m.kind}|${norm(m.artist)}|${norm(m.title)}`;
const sameServer = (m, src = app.source) => !!src && m.server === (src.serverId || src.uri);
const sameLibrary = (m, src = app.source) => sameServer(m, src) && String(m.section) === String(src.sectionKey);
const libraryName = (src = app.source) => (src ? `${src.sectionTitle} (${src.serverName})` : '');

// (0.12.0 kept what MusicBrainz didn't know, and albums, hidden: they go.)
function load() {
  const list = store.get(KEY, []);
  return Array.isArray(list) ? list.filter((m) => m && (m.kind === 'track' || m.kind === 'artist') && typeof m.artist === 'string' && m.mb !== 'unknown' && m.mb !== 'album') : [];
}

// Whether it was kept (the browser may be out of room).
function save(list) {
  const kept = store.set(KEY, list);
  emit('missing', missingCount());
  return kept;
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

// The most recent of each server's, of each kind (see MISSING_LIMITS): by
// when each was last noted, and of those noted the same second, the last
// noted (the list is in the order they were), kept in that order.
function trim(list) {
  const groups = new Map();
  for (const m of list) {
    const k = `${m.server}\n${sourceOf(m)}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(m);
  }
  const out = [];
  for (const g of groups.values()) {
    const cap = MISSING_LIMITS[sourceOf(g[0])];
    if (g.length <= cap) {
      out.push(...g);
      continue;
    }
    const kept = new Set(
      g
        .map((m, i) => [m, i])
        .sort(([a, i], [b, j]) => (b.last || 0) - (a.last || 0) || j - i)
        .slice(0, cap)
        .map(([m]) => m),
    );
    out.push(...g.filter((m) => kept.has(m)));
  }
  return out;
}

// A Spotify playlist, by its name, in a few characters: a track's `lists`
// count the playlists it was in (each once, however often it's imported,
// up to MISSING_LISTS) without keeping their names.
function listId(name) {
  let x = 0x811c9dc5;
  for (const ch of String(name || '').trim().toLowerCase()) x = Math.imul(x ^ ch.codePointAt(0), 0x01000193) >>> 0;
  return x.toString(36);
}
export const MISSING_LISTS = 20;

// What an AI playlist found missing (and found there), for the request
// `prompt`: new ones are added, ones seen before counted again (once a
// call: a song twice in a playlist is one), and ones now in the library let
// go, as are those in `drop` (what MusicBrainz says isn't real, kept from
// before it was asked). Those MusicBrainz knows come with mb: 'real'. `via`:
// where they came from instead ('spotify', with the playlist's name as
// `prompt`): real songs, never asked about on MusicBrainz, counted once for
// each playlist they're in. One from somewhere else now is counted afresh.
// Returns how many of them there are ({ of }), and how many are on the list
// now ({ kept }: all, unless there wasn't room), with their `keys`, to count
// again later (keptCounter: a later import can push them out); the keys of
// those found in the library (`found`), and whether the list was kept
// (`saved`: the browser may be out of room).
export function noteMissing(missing = [], seen = { songs: [], artists: [] }, prompt = '', { drop = [], via = '' } = {}) {
  const src = app.source;
  if (!src) return { kept: 0, of: 0, keys: [], found: [], saved: false };
  const now = Math.round(Date.now() / 1000);
  const here = (m) => sameLibrary(m, src);
  const inLibrary = new Set([
    ...(seen.songs || []).map((x) => keyOf({ kind: 'track', artist: x.artist || '', title: x.title || '' })),
    ...(seen.artists || []).map((a) => keyOf({ kind: 'artist', artist: a, title: '' })),
  ]);
  // (What MusicBrainz doesn't know stays where it came from a Spotify
  // playlist: Spotify has it, so it's real.)
  const notReal = new Set(drop.map((m) => keyOf({ kind: m.kind, artist: m.artist || '', title: m.kind === 'track' ? m.title || '' : '' })));
  const gone = (m) => here(m) && (inLibrary.has(keyOf(m)) || (notReal.has(keyOf(m)) && m.via !== 'spotify'));
  const list = load().filter((m) => !gone(m));
  const index = new Map();
  for (const m of list) if (here(m)) index.set(keyOf(m), m);
  const noted = new Set();
  // Those noted now, in the order they are: last in the list (see trim).
  const noting = [];
  for (const m of missing) {
    const entry = { kind: m.kind, artist: String(m.artist || '').slice(0, 120), title: m.kind === 'track' ? String(m.title || '').slice(0, 160) : '' };
    if (!entry.artist && !entry.title) continue;
    if (m.mb === 'real') entry.mb = 'real';
    const k = keyOf(entry);
    if (noted.has(k)) continue;
    noted.add(k);
    const have = index.get(k);
    if (have) {
      noting.push(have);
      if ((have.via || '') !== via) {
        have.times = 1;
        delete have.lists;
        // (One from Spotify that an AI suggests now is still a real song.)
        if (via === 'spotify') have.lists = [listId(prompt)];
        else have.mb = 'real';
      } else if (via === 'spotify') {
        // (Kept before 0.22.0: the playlist it was last in.)
        // At most MISSING_LISTS: past that, it's in "20+" playlists, and
        // counted no further (so imported again, it isn't counted again).
        const lists = Array.isArray(have.lists) ? have.lists : [listId(have.prompt)];
        if (!lists.includes(listId(prompt)) && lists.length < MISSING_LISTS) {
          lists.push(listId(prompt));
          have.times = (have.times || 1) + 1;
        }
        have.lists = lists;
      } else {
        have.times = (have.times || 1) + 1;
      }
      have.last = now;
      have.prompt = String(prompt).slice(0, 200);
      if (entry.mb) have.mb = entry.mb;
      if (via) have.via = via;
      else delete have.via;
    } else {
      noting.push({
        ...entry,
        ...(via ? { via } : {}),
        ...(via === 'spotify' ? { lists: [listId(prompt)] } : {}),
        times: 1,
        first: now,
        last: now,
        prompt: String(prompt).slice(0, 200),
        server: src.serverId || src.uri,
        section: String(src.sectionKey),
        library: libraryName(src),
      });
    }
  }
  const moved = new Set(noting);
  const saved = save(trim([...list.filter((m) => !moved.has(m)), ...noting]));
  // (What's kept, as read back: a browser out of room keeps nothing new.)
  const keys = [...noted];
  return { kept: keptCounter(src)(keys), of: keys.length, keys, found: [...inLibrary], saved };
}

// How many of noteMissing's `keys` are on this library's list now: read
// once, to count for each of many.
export function keptCounter(src = app.source) {
  const kept = new Set(src ? load().filter((m) => sameLibrary(m, src)).map(keyOf) : []);
  return (keys = []) => keys.filter((k) => kept.has(k)).length;
}

// Whether this server's list of those from `via` is as long as it's kept
// (MISSING_LIMITS): one that isn't on it was pushed off, rather than the
// device out of room for it.
export function missingFull(via = '', src = app.source) {
  const kind = sourceOf({ via });
  return !!src && load().filter((m) => sameServer(m, src) && sourceOf(m) === kind).length >= MISSING_LIMITS[kind];
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

// The server in use's that MusicBrainz could be asked about: not checked yet,
// and suggested by an AI (what came from Spotify is real).
export const askable = (m) => sameServer(m) && m.mb !== 'real' && m.via !== 'spotify';

// The ones listed without being checked on MusicBrainz (made before there
// was one to ask, or while it couldn't be asked), looked up there now: those
// it doesn't know (most likely made up) and albums taken for songs are let
// go, those it knows are marked so they're not asked about again. Resolves
// to { asked, real, dropped (the entries let go, with mb: 'unknown' or
// 'album'), unsure (couldn't be checked this time) }. If MusicBrainz can't
// be asked, what it said before that still counts, and it throws with
// err.result set.
export async function checkMissingOnMusicBrainz({ signal, onProgress } = {}) {
  const todo = load().filter(askable);
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
  save(trim(list));
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

// What's shared with whoever finds the music: what's missing, and where
// from (an AI playlist, or a playlist from Spotify), not what you asked the
// AI for (that's only shown here).
export function missingCsv(list = missingList()) {
  const head = ['Artist', 'Title', 'Missing', 'Times suggested', 'Last suggested', 'Library', 'From'];
  return toCsv(head, list.map((m) => [m.artist, m.title, m.kind === 'artist' ? 'Artist' : 'Track', m.times || 1, day(m.last), m.library, m.via === 'spotify' ? 'A Spotify playlist' : 'An AI playlist']));
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
