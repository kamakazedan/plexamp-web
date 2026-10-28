// Checking songs and artists against MusicBrainz, for AI playlists: models
// make up songs (and take albums for songs), and MusicBrainz knows which
// are real. Which MusicBrainz is the container's choice (MUSICBRAINZ_URL):
// musicbrainz.org, or a server of your own (a mirror, with its search
// indexes). Only names are sent: an artist, and a song's title. One request
// at a time for everyone using the player; musicbrainz.org at most once a
// second (its rule for each address), with a User-Agent saying what's
// asking, as it asks. What it says is kept for a week.
import { norm } from './missinglist.js';

export const MB_LIMITS = {
  gapMs: 1100, // between requests to musicbrainz.org (your own: none)
  keepMs: 7 * 24 * 3600 * 1000,
  kept: 5000, // answers kept
  perRequest: 10, // names checked in one request from the app
  checkMs: 40000, // how long one request from the app may take (nginx waits 60 s)
  perUser: 2, // requests from the app under way, for each person
  checks: 4, // and for everyone (each waits for the others' turns)
  timeoutMs: 15000,
};

// Whoever asked has gone: what's left isn't checked.
class Gone extends Error {}

export class MusicBrainzError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Names are compared as the app compares them (missinglist.js norm, a copy
// of the app's): case, accents, "the" and punctuation aside, and a name in
// another script by its letters (since 0.25.0: before, every one of those
// came out the same, as nothing, so any artist in that script would do).

// A phrase for MusicBrainz's search (Lucene): quoted, with what would end it
// taken out.
const phrase = (v) => `"${String(v).replace(/["\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)}"`;

// The names in an artist credit ("Underworld & Gabriel Yared").
const credited = (credit) => (Array.isArray(credit) ? credit : []).flatMap((c) => [c?.name, c?.artist?.name]).filter(Boolean).map(norm);

function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

// Close enough to be the same title: "Out of Space" and "Out Of Space
// (Remastered)", or a letter or two different (as the app judges it: not
// in Chinese, Japanese or Korean, where one character can be another word,
// nor a number).
const ONE_CHARACTER_WORDS = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const numbersOf = (s) => s.replace(/\P{Nd}+/gu, ' ').trim().replace(/(^| )0+(?=\p{Nd})/gu, '$1');
export function sameTitle(a, b) {
  if (!a || !b) return false;
  if (a === b || a.startsWith(`${b} `) || b.startsWith(`${a} `)) return true;
  if (ONE_CHARACTER_WORDS.test(a) || ONE_CHARACTER_WORDS.test(b)) return false;
  // (Nor are titles with other numbers, in any script's digits: Symphony
  // No. 5 isn't No. 6. No. 02 is No. 2.)
  if (numbersOf(a) !== numbersOf(b)) return false;
  return Math.min(a.length, b.length) >= 6 && editDistance(a, b) <= Math.max(1, Math.floor(Math.min(a.length, b.length) / 10));
}

// musicbrainz.org itself (or one of its own names), as opposed to a server
// of your own.
export const isPublic = (base) => {
  try {
    const host = new URL(base).hostname.toLowerCase();
    return host === 'musicbrainz.org' || host.endsWith('.musicbrainz.org');
  } catch {
    return false;
  }
};

export class MusicBrainz {
  constructor({ base = 'https://musicbrainz.org', version = '', fetchImpl = globalThis.fetch, gapMs, log } = {}) {
    this.base = String(base).replace(/\/+$/, '');
    this.fetch = fetchImpl;
    this.public = isPublic(this.base);
    this.gapMs = gapMs ?? (this.public ? MB_LIMITS.gapMs : 0);
    this.agent = `plexamp-web${/^[0-9][0-9.]*$/.test(version) ? `/${version}` : ''} ( https://github.com/kamakazedan/plexamp-web )`;
    this.log = log;
    this.kept = new Map(); // key -> { answer, at }
    this.queue = Promise.resolve();
    this.last = 0;
  }

  // One request to MusicBrainz, after the one before it by gapMs (skipped
  // if `signal` says whoever wanted it has gone).
  ask(path, params, signal) {
    const run = async () => {
      if (signal?.aborted) throw new Gone();
      const wait = this.last + this.gapMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      if (signal?.aborted) throw new Gone();
      this.last = Date.now();
      const url = `${this.base}${path}?${new URLSearchParams({ ...params, fmt: 'json' })}`;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), MB_LIMITS.timeoutMs);
      const stop = () => ctrl.abort();
      signal?.addEventListener('abort', stop, { once: true });
      try {
        const res = await this.fetch(url, {
          headers: { Accept: 'application/json', 'User-Agent': this.agent },
          signal: ctrl.signal,
        });
        if (this.public && res.status === 503) throw new MusicBrainzError(503, 'MusicBrainz is busy right now. Try again in a minute.');
        // (A server of your own needs its search indexes for these.)
        if (!res.ok) throw new MusicBrainzError(502, this.public ? `MusicBrainz answered ${res.status}.` : `The player’s MusicBrainz server answered ${res.status}. Searching it needs its search indexes.`);
        return await res.json();
      } catch (err) {
        if (err instanceof MusicBrainzError) throw err;
        if (signal?.aborted) throw new Gone();
        throw new MusicBrainzError(502, this.public ? 'MusicBrainz couldn’t be reached from this player.' : 'The player’s MusicBrainz server couldn’t be reached.');
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', stop);
      }
    };
    const job = this.queue.then(run, run);
    this.queue = job.catch(() => {});
    return job;
  }

  remembered(key) {
    const hit = this.kept.get(key);
    if (!hit || Date.now() - hit.at > MB_LIMITS.keepMs) return undefined;
    return hit.answer;
  }

  remember(key, answer) {
    this.kept.delete(key);
    this.kept.set(key, { answer, at: Date.now() });
    while (this.kept.size > MB_LIMITS.kept) this.kept.delete(this.kept.keys().next().value);
    return answer;
  }

  // An artist: 'real' if MusicBrainz has one of that name, 'unknown' if not.
  async artist(name, signal) {
    const want = norm(name);
    if (!want) return 'unknown';
    const key = `artist|${want}`;
    const kept = this.remembered(key);
    if (kept) return kept;
    const data = await this.ask('/ws/2/artist', { query: `artist:${phrase(name)}`, limit: '5' }, signal);
    const found = (data.artists || []).some(
      (a) => Number(a.score) >= 80 && (norm(a.name) === want || (a.aliases || []).some((x) => norm(x.name) === want)),
    );
    return this.remember(key, found ? 'real' : 'unknown');
  }

  // A song by an artist: 'real' if MusicBrainz has a recording of it,
  // 'album' if the title is one of their albums (or EPs) rather than a song,
  // 'unknown' if neither.
  async song(artist, title, signal) {
    const by = norm(artist);
    const want = norm(title);
    if (!want) return 'unknown';
    const key = `song|${by}|${want}`;
    const kept = this.remembered(key);
    if (kept) return kept;
    const theirs = (credit) => !by || credited(credit).some((n) => n === by || n.includes(by) || by.includes(n));
    const query = (field) => `${field}:${phrase(title)}${artist ? ` AND artist:${phrase(artist)}` : ''}`;
    const songs = await this.ask('/ws/2/recording', { query: query('recording'), limit: '10' }, signal);
    if ((songs.recordings || []).some((r) => Number(r.score) >= 70 && sameTitle(norm(r.title), want) && theirs(r['artist-credit']))) {
      return this.remember(key, 'real');
    }
    const albums = await this.ask('/ws/2/release-group', { query: query('releasegroup'), limit: '5' }, signal);
    if ((albums['release-groups'] || []).some((g) => Number(g.score) >= 80 && norm(g.title) === want && theirs(g['artist-credit']))) {
      return this.remember(key, 'album');
    }
    return this.remember(key, 'unknown');
  }

  // [{ kind: 'artist' | 'track', artist, title }] -> answers in the same
  // order, null for those not checked: once it's `until` (a time), or
  // whoever asked has gone (`signal`).
  async check(items, { signal, until = Infinity } = {}) {
    const out = items.map(() => null);
    for (const [i, it] of items.entries()) {
      if (signal?.aborted || Date.now() >= until) break;
      try {
        out[i] = it?.kind === 'artist' ? await this.artist(it.artist, signal) : await this.song(it?.artist, it?.title, signal);
      } catch (err) {
        if (err instanceof Gone) break;
        if (out.some(Boolean)) break; // what it found so far; the rest another time
        throw err;
      }
    }
    return out;
  }
}
