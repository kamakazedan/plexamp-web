// Songs and artists that AI playlists suggested but the library doesn't
// have, and the tracks of playlists imported from Spotify it doesn't have
// (via: 'spotify'), in Settings › AI › Missing tracks, so whoever looks
// after the server can go and find them. Each with the Plex server and
// library it's missing from: the list shows the server in use's (different
// servers have different music). Kept on this device (until it's cleared,
// or you sign out), and where this player keeps them for each Plex account
// (missingsync.js), for yours: then every browser you sign in on has them,
// and the server's owner sees everyone's, one list (`others`: whose, and how
// often for them), so they can add what's missing. It's exported as a
// spreadsheet (CSV) or plain text.
//
// How each change goes is the same here and in the player's service
// (missinglist.js): it's made here, and sent as that change.
//
// AI models make songs up, and take albums for songs. Where the player has
// a MusicBrainz to ask (MUSICBRAINZ_URL) and Settings › AI › Check
// suggestions on MusicBrainz is on, an AI playlist's suggestions are looked
// up there before they're listed (see checkSuggestions): those it doesn't
// know, and albums, never come here, and those it knows are marked (mb:
// 'real'). Ones listed without being checked (before there was a
// MusicBrainz to ask) can be checked from the list (checkMissingOnMusicBrainz).
import { app } from './state.js';
import { songInLibrary, artistInLibrary, aiSettings } from './ai.js';
import { MISSING_LIMITS, MISSING_LISTS, keyOf, idOf, listId, sourceOf, applyNote, applyForget, applyClear, applyVerdicts, applyRestore } from './missinglist.js';
import { loadMissing as load, saveMissing as save, queueMissing, missingOthers, editMissingOthers, ownsServer, syncs } from './missingsync.js';
import { aliasesOf } from './mb.js';

export { MISSING_LIMITS, MISSING_LISTS };

const serverOf = (src = app.source) => (src ? src.serverId || src.uri : '');
const sameServer = (m, src = app.source) => !!src && m.server === serverOf(src);
const sameLibrary = (m, src = app.source) => sameServer(m, src) && String(m.section) === String(src.sectionKey);
const libraryName = (src = app.source) => (src ? `${src.sectionTitle} (${src.serverName})` : '');
// In one change, to go in one request: ids (the player takes up to 2,000),
// what an import didn't find, and entries put back.
const KEYS = 1000;
const ITEMS = 250;
const ENTRIES = 200;
const chunks = (list, n) => Array.from({ length: Math.ceil(list.length / n) }, (_, i) => list.slice(i * n, (i + 1) * n));

// Whether what's listed for the server in use is everyone's: the player
// keeps them for each account, and says this one owns the server. Then
// taking some off the list, or clearing it, is for everyone's.
export const everyoneShown = (src = app.source) => !!src && syncs(serverOf(src)) && ownsServer(serverOf(src)) === true;

// How they're kept, for saying so where they're turned on: on this device
// only (null), or for your account, where the server's owner sees them too
// ({ owner: false }: a friend's; true: as that owner; undefined: until the
// player has said whose the server is, as it hasn't yet when the app's just
// opened).
export function missingKept() {
  const server = serverOf();
  if (!syncs(server)) return null;
  return { owner: ownsServer(server) };
}

// ...said where they're turned on (Show missing tracks, an import's "Put
// what isn't here on Missing tracks"): a sentence (true whoever's the
// server's, while that isn't known), or nothing.
export function missingKeptNote() {
  const kept = missingKept();
  if (!kept) return '';
  const server = app.source?.serverName || 'the server';
  if (kept.owner === true) return ' Saved to your Plex account, on every device. You see your friends’ too.';
  if (kept.owner === false) return ` Saved to your Plex account, on every device. The owner of ${server} sees them too, so they can add them.`;
  return ` Saved to your Plex account, on every device. The owner of ${server} sees them too.`;
}

// What's kept for the server in use, artists first, then by artist and
// title, one for each: this account's own (`mine`: its entry), and for the
// server's owner everyone else's too (`others`: how often for them, and
// whose). `last` is the latest of everyone's.
export function missingList() {
  const by = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
  const server = serverOf();
  const rows = new Map();
  for (const m of load()) if (sameServer(m)) rows.set(idOf(m), { ...m, mine: m, others: null });
  for (const o of missingOthers(server)) {
    const id = idOf(o);
    const r = rows.get(id);
    if (r) {
      r.others = o;
      r.first = Math.min(r.first || o.first, o.first || r.first);
      r.last = Math.max(r.last || 0, o.last || 0);
      if (o.mb === 'real') r.mb = 'real';
    } else {
      rows.set(id, { kind: o.kind, artist: o.artist, title: o.title, section: o.section, library: o.library, server, first: o.first, last: o.last, ...(o.mb === 'real' ? { mb: 'real' } : {}), mine: null, others: o });
    }
  }
  return [...rows.values()].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'artist' ? -1 : 1) || by.compare(a.artist, b.artist) || by.compare(a.title || '', b.title || ''));
}

export const missingCount = () => missingList().length;
// This account's own, on the server in use.
export const myMissingCount = () => load().filter((m) => sameServer(m)).length;

// How often AI playlists suggested one, and how many Spotify playlists had
// it (everyone's, for the server's owner), and whether that's past what's
// counted ("20+").
export function tally(m) {
  const own = m.mine || null;
  const ai = (own && sourceOf(own) === 'ai' ? own.times || 1 : 0) + (m.others?.ai || 0);
  const spotify = (own && sourceOf(own) === 'spotify' ? own.times || 1 : 0) + (m.others?.spotify || 0);
  const more = (!!own && sourceOf(own) === 'spotify' && (own.lists?.length || 0) >= MISSING_LISTS) || !!m.others?.more;
  return { ai, spotify, more };
}

// What it was last suggested for, or the Spotify playlist it was last in:
// this device's own, while it noted it last.
export const promptOf = (m) => (m.mine?.prompt && (m.mine.last || 0) >= (m.last || 0) ? m.mine.prompt : '');

// What an AI playlist found missing (and found there), for the request
// `prompt`: new ones are added, ones seen before counted again (once a
// call: a song twice in a playlist is one), and ones now in the library let
// go, as are those in `drop` (what MusicBrainz says isn't real, kept from
// before it was asked). Those MusicBrainz knows come with mb: 'real'. `via`:
// where they came from instead ('spotify', with the playlist's name as
// `prompt`): real songs, never asked about on MusicBrainz, counted once for
// each playlist they're in. One from somewhere else now is counted afresh
// (see applyNote). Returns how many of them there are ({ of }), and how many
// are on the list now ({ kept }: all, unless there wasn't room), with their
// `keys`, to count again later (keptCounter: a later import can push them
// out); the keys of those found in the library (`found`), and whether the
// list was kept (`saved`: the browser may be out of room).
export function noteMissing(missing = [], seen = { songs: [], artists: [] }, prompt = '', { drop = [], via = '' } = {}) {
  const src = app.source;
  if (!src) return { kept: 0, of: 0, keys: [], found: [], saved: false };
  const server = serverOf(src);
  const inLibrary = new Set([
    ...(seen.songs || []).map((x) => keyOf({ kind: 'track', artist: x.artist || '', title: x.title || '' })),
    ...(seen.artists || []).map((a) => keyOf({ kind: 'artist', artist: a, title: '' })),
  ]);
  const before = load();
  const here = new Set(before.filter((m) => sameLibrary(m, src)).map(keyOf));
  const items = [];
  const noted = new Set();
  for (const m of missing) {
    if (m?.kind !== 'track' && m?.kind !== 'artist') continue;
    const entry = { kind: m.kind, artist: String(m.artist || '').slice(0, 120), title: m.kind === 'track' ? String(m.title || '').slice(0, 160) : '' };
    if (!entry.artist && !entry.title) continue;
    const k = keyOf(entry);
    // (Found as well, in the same call, it's found: a lookup that failed once.)
    if (noted.has(k) || inLibrary.has(k)) continue;
    noted.add(k);
    items.push(m.mb === 'real' ? { ...entry, mb: 'real' } : entry);
  }
  const spotify = via === 'spotify';
  const op = {
    type: 'note',
    // (Of more, only these would be kept: see trimMissing.)
    items: items.slice(-MISSING_LIMITS[spotify ? 'spotify' : 'ai']),
    // Those on the list (here) now in the library, and those MusicBrainz
    // doesn't know.
    found: [...here].filter((k) => inLibrary.has(k)).slice(0, KEYS),
    // (Of those, only the ones on the list here go.)
    unreal: [...new Set(drop.map((m) => keyOf({ kind: m.kind, artist: m.artist || '', title: m.kind === 'track' ? m.title || '' : '' })))]
      .filter((k) => here.has(k))
      .slice(0, KEYS),
    via: spotify ? 'spotify' : '',
    ...(spotify ? { list: listId(prompt) } : {}),
    section: String(src.sectionKey),
    library: libraryName(src),
    at: Math.round(Date.now() / 1000),
  };
  const { list, keys } = applyNote(before, { ...op, items }, { server, prompt: String(prompt) });
  const saved = save(list);
  // (Sent a few at a time: each is in one of them, so it's counted once.)
  const parts = chunks(op.items, ITEMS);
  if (!parts.length && (op.found.length || op.unreal.length)) parts.push([]);
  parts.forEach((part, i) => queueMissing(server, { ...op, items: part, ...(i ? { found: [], unreal: [] } : {}) }, { prompt: String(prompt) }));
  // (What's kept, as read back: a browser out of room keeps nothing new.)
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

// Those with these ids taken off the server in use's list: this account's,
// and for its owner everyone's.
function forget(ids) {
  const server = serverOf();
  if (!server || !ids.length) return;
  save(applyForget(load(), ids, { server }));
  const everyone = everyoneShown();
  if (everyone) {
    const gone = new Set(ids);
    editMissingOthers(server, (rows) => rows.filter((r) => !gone.has(idOf(r))));
  }
  for (const part of chunks(ids, KEYS)) queueMissing(server, { type: 'forget', ids: part, ...(everyone ? { everyone: true } : {}) });
}

export function forgetMissing(entry) {
  forget([idOf(entry)]);
}

// The server in use's list, cleared (other servers' stay): for its owner,
// everyone's.
export function clearMissing() {
  const server = serverOf();
  if (!server) return;
  save(applyClear(load(), { server }));
  const everyone = everyoneShown();
  if (everyone) editMissingOthers(server, () => []);
  queueMissing(server, { type: 'clear', ...(everyone ? { everyone: true } : {}) });
}

// Looks for each of the server in use's again, in the library it was
// missing from (after adding music), and lets go of what's there now: by
// its artist's name, and (with the player's MusicBrainz features: see
// mb.js) the other names MusicBrainz has for them. Resolves to how many
// were found.
export async function checkMissingAgain({ signal, onProgress } = {}) {
  const todo = missingList();
  const found = [];
  let n = 0;
  const here = (m, artist, section) => (m.kind === 'artist' ? artistInLibrary(artist, signal, section) : songInLibrary({ artist, title: m.title }, signal, { section }));
  for (const m of todo) {
    if (signal?.aborted) break;
    const section = m.section || app.source.sectionKey;
    let there = await here(m, m.artist, section);
    for (const alias of there || !m.artist ? [] : (await aliasesOf(m.artist)).slice(0, 3)) {
      if (signal?.aborted || (there = await here(m, alias, section))) break;
    }
    if (there) found.push(idOf(m));
    onProgress?.(++n, todo.length);
  }
  forget(found);
  return found.length;
}

// The server in use's that MusicBrainz could be asked about: this
// account's own (a friend's are checked as they choose, on their devices),
// not checked yet, and suggested by an AI (what came from Spotify is real).
export const askable = (m) => sameServer(m) && !!m.mine && m.mb !== 'real' && tally(m).spotify === 0;

// The ones listed without being checked on MusicBrainz (made before there
// was one to ask, or while it couldn't be asked), looked up there now: those
// it doesn't know (most likely made up) and albums taken for songs are let
// go, those it knows are marked so they're not asked about again. Resolves
// to { asked, real, dropped (the entries let go, with mb: 'unknown' or
// 'album'), unsure (couldn't be checked this time) }. If MusicBrainz can't
// be asked, what it said before that still counts, and it throws with
// err.result set.
export async function checkMissingOnMusicBrainz({ signal, onProgress } = {}) {
  const server = serverOf();
  const todo = missingList().filter(askable);
  let verdicts;
  let failed = null;
  try {
    verdicts = await checkSuggestions(todo, { signal, onProgress });
  } catch (err) {
    verdicts = err.verdicts || [];
    failed = err;
  }
  const real = [];
  const dropped = [];
  todo.forEach((m, i) => {
    const v = verdicts[i];
    if (v === 'unknown' || v === 'album') dropped.push({ ...m, mb: v });
    else if (v === 'real') real.push(idOf(m));
  });
  if (dropped.length || real.length) {
    const gone = dropped.map(idOf);
    save(applyVerdicts(load(), { real, dropped: gone }, { server }).list);
    const parts = Math.max(1, Math.ceil(real.length / KEYS), Math.ceil(gone.length / KEYS));
    for (let i = 0; i < parts; i += 1) {
      const slice = (list) => list.slice(i * KEYS, (i + 1) * KEYS);
      queueMissing(server, { type: 'mb', real: slice(real), dropped: slice(gone) });
    }
  }
  const answered = verdicts.filter(Boolean).length;
  const result = { asked: todo.length, real: real.length, dropped, unsure: todo.length - answered };
  if (failed) throw Object.assign(failed, { result });
  return result;
}

// Puts entries let go back on the list (an undo, of checking on
// MusicBrainz), unchecked again.
export function restoreMissing(entries = []) {
  const server = serverOf();
  if (!server) return;
  const mine = entries.filter((m) => m.mine).map((m) => m.mine);
  save(applyRestore(load(), mine, { server }));
  for (const part of chunks(mine, ENTRIES)) queueMissing(server, { type: 'restore', entries: part });
}

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
export const toCsv = (head, rows) => `﻿${[head, ...rows].map((r) => r.map(cell).join(',')).join('\r\n')}\r\n`;

// What's shared with whoever finds the music: what's missing, and where
// from (an AI playlist, or a playlist from Spotify), not what anyone asked
// the AI for, nor whose it is.
export function missingCsv(list = missingList()) {
  const head = ['Artist', 'Title', 'Missing', 'Times suggested', 'Last suggested', 'Library', 'From'];
  const times = (m) => {
    const t = tally(m);
    return `${t.ai + t.spotify || 1}${t.more ? '+' : ''}`;
  };
  const from = (m) => {
    const t = tally(m);
    return t.ai && t.spotify ? 'AI playlists and Spotify playlists' : t.spotify ? 'A Spotify playlist' : 'An AI playlist';
  };
  return toCsv(head, list.map((m) => [m.artist, m.title, m.kind === 'artist' ? 'Artist' : 'Track', times(m), day(m.last), m.library, from(m)]));
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
