// Checking songs and artists against MusicBrainz, for AI playlists: models
// make up songs (and take albums for songs), and MusicBrainz knows which
// are real. Which MusicBrainz is the container's choice (MUSICBRAINZ_URL):
// musicbrainz.org, or a server of your own (a mirror, with its search
// indexes). Only names are sent: an artist, and a song's title. One request
// at a time for everyone using the player; musicbrainz.org at most once a
// second (its rule for each address), with a User-Agent saying what's
// asking, as it asks. What it says is kept for a week.
//
// With MUSICBRAINZ_ADVANCED, the app's MusicBrainz features too (see the
// end of this file): what MusicBrainz says of the library's artists and
// albums, by artist, kept on disk for a month.
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { norm } from './missinglist.js';
import { albumKey, matchGroup, exactAlbum, exactKey, sameTitle, titlesAgree, trackKey, tracksInCommon, releaseSizes, PLACEHOLDER_ARTISTS } from './releases.js';
import { ServiceError } from './errors.js';
import { CONTROL_CHARACTERS } from './clean.js';
import { readCapped } from './plex.js';
import { readDataFile, writeDataFile } from './datafile.js';

export const MB_LIMITS = {
  gapMs: 1100, // between requests to musicbrainz.org (one at a time)
  // A MusicBrainz of your own: twenty requests a second at most, ownAtOnce
  // of them under way at once to begin with, and then more (ownAtOnceMost
  // at most: a mirror answers ten at once, as it's set up, so some are left
  // for whatever else asks it), one more after each ownWindow answers while
  // they were as many as it was asked at once and half of them came back
  // within ownQuickMs; one fewer after each ownWindow while half of them took
  // longer than ownSlowMs; half as many after one it didn't answer (see
  // paced).
  ownGapMs: 50,
  ownAtOnce: 4,
  ownAtOnceMost: 8,
  ownWindow: 20,
  ownQuickMs: 1000,
  ownSlowMs: 2000,
  // musicbrainz.org's answer took longer than slowMs: the next request waits
  // as long again (slowWaitMaxMs at most), so it gets its breath back. Any
  // MusicBrainz that says it has too much to do ("too many requests", 429,
  // or "busy", 503): nothing asked of it for as long as it says
  // (Retry-After), or busyMs, busyMaxMs at most.
  slowMs: 2000,
  slowWaitMaxMs: 10000,
  busyMs: 60000,
  busyMaxMs: 300000,
  // A search that found no one at all: whether searching it finds anyone
  // is checked (see searchCheck), and that's taken as it is for so long.
  searchOkMs: 10 * 60000,
  searchBadMs: 10 * 60000,
  keepMs: 7 * 24 * 3600 * 1000,
  kept: 5000, // answers kept
  perRequest: 10, // names checked in one request from the app
  checkMs: 40000, // how long one request from the app may take (nginx waits 60 s)
  perUser: 2, // requests from the app under way, for each person
  checks: 4, // and for everyone (each waits for the others' turns)
  timeoutMs: 15000,
  // ...on a MusicBrainz of your own, for what's looked up in the background,
  // where no one's waiting on it (an album with hundreds of releases, or a
  // box set's tracks, can take a busy mirror longer than timeoutMs).
  ownTimeoutMs: 60000,
  answerBytes: 8 * 1024 * 1024, // an answer read, at most (a box set's tracks are a few hundred KB)
};

// Whoever asked has gone: what's left isn't checked.
class Gone extends Error {}

// How long a server that said it has too much to do (429, 503) asked to be
// left (its Retry-After: seconds, or a date), within MB_LIMITS' busyMs and
// busyMaxMs.
export function retryAfterMs(header, now = Date.now()) {
  const v = String(header || '').trim();
  let ms = /^\d+$/.test(v) ? Number(v) * 1000 : v ? Date.parse(v) - now : NaN;
  if (!Number.isFinite(ms) || ms <= 0) ms = MB_LIMITS.busyMs;
  return Math.min(MB_LIMITS.busyMaxMs, Math.max(5000, ms));
}

export class MusicBrainzError extends ServiceError {}

// Names are compared as the app compares them (missinglist.js norm, a copy
// of the app's): case, accents, "the" and punctuation aside, and a name in
// another script by its letters (since 0.25.0: before, every one of those
// came out the same, as nothing, so any artist in that script would do).

// A phrase for MusicBrainz's search (Lucene): quoted, with what would end it
// taken out.
const phrase = (v) => `"${String(v).replace(/["\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)}"`;

// The names in an artist credit ("Underworld & Gabriel Yared").
const credited = (credit) => (Array.isArray(credit) ? credit : []).flatMap((c) => [c?.name, c?.artist?.name]).filter(Boolean).map(norm);

// Songs' titles are close enough to be the same as releases.js sameTitle
// has it ("Out of Space" and "Out Of Space (Remastered)", or a letter or two
// different, but not in Chinese, Japanese or Korean, nor another number), as
// the app judges them.

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

// A search that finds something in any MusicBrainz, for each kind it's
// searched for, to see whether searching it finds anything at all (see
// searchCheck): artists who are people, and recordings and release groups
// of albums. These are kinds MusicBrainz sorts everything into, not anyone's
// music.
const SEARCH_CHECK = { artist: 'type:person', recording: 'primarytype:album', 'release-group': 'primarytype:album' };

export class MusicBrainz {
  // `checkSearch`: a server of your own whose search finds no one at all is
  // told apart from an artist or song it doesn't have (see searchCheck).
  constructor({ base = 'https://musicbrainz.org', version = '', fetchImpl = globalThis.fetch, gapMs, log, now = () => Date.now(), checkSearch = false } = {}) {
    this.base = String(base).replace(/\/+$/, '');
    this.fetch = fetchImpl;
    this.public = isPublic(this.base);
    this.checkSearch = !!checkSearch && !this.public;
    this.search = {}; // index ('artist', 'recording', 'release-group') -> { works, at }: whether searching it found anyone, as last checked
    this.gapMs = gapMs ?? (this.public ? MB_LIMITS.gapMs : MB_LIMITS.ownGapMs);
    this.agent = `plexamp-web${/^[0-9][0-9.]*$/.test(version) ? `/${version}` : ''} ( https://github.com/kamakazedan/plexamp-web )`;
    this.log = log;
    this.now = now;
    this.kept = new Map(); // key -> { answer, at }
    this.atOnce = this.public ? 1 : MB_LIMITS.ownAtOnce; // requests under way at once, at most (a server of your own: as it keeps up, see paced)
    this.running = 0; // ...under way now
    this.recentAnswers = []; // a server of your own: how its latest answers went, { ms, full } (see paced)
    this.lastMinute = { since: Date.now(), times: [], missed: 0 }; // how long its answers took, this last minute, for the log (debug mode)
    this.turns = []; // ...and those waiting for one to end, first in line first (see inTurn)
    this.nextAt = 0; // when the next request may go (see asked)
    this.lastStart = 0; // ...and when the last one went
    this.lastAnswerAt = 0; // ...and when it last answered anything
    this.waiting = 0; // requests someone's waiting on (the background waits for them)
    // The advanced features (see advanced()): what's kept of them, and
    // what's waiting to be looked up in the background.
    this.adv = null;
    this.todo = new Map(); // key -> { artist, title, genres, year, id, albumId, strict, tracks, check, trackList, who, tries }
    this.todoFirst = new Map(); // ...those checked by their tracks, looked up first (see later)
    // On a MusicBrainz of your own (see checkedAlbum): what's been read of
    // release groups' releases and releases' tracks, a while, in memory.
    this.releasesOf = new Map(); // release group id -> [{ id, date, tracks }]
    this.tracksOf = new Map(); // release id -> [{ title, ms }]
    this.albumIdsAre = null; // what Plex's ids for albums were last found as: 'release' or 'release-group' (see albumGroup)
    this.queuedBy = new Map(); // who -> how many of theirs are waiting
    this.workers = 0; // looking up what's waiting (see work)
    this.inHand = new Set(); // ...the keys of those they're looking up now
    this.artistsInHand = new Set(); // ...and whose albums (one worker to an artist: see nextTodo)
    this.downUntil = 0; // MusicBrainz didn't answer: the features don't ask it again until then
    this.quietUntil = 0; // MusicBrainz said it's busy: nothing at all is asked of it until then
    this.unanswered = new Map(); // key -> when: albums it didn't answer for, each time it was asked (see worker)
    this.wakeTimer = null; // ...and when one waiting to be tried again is due (see wake)
    this.wakeDue = 0;
  }

  // One request to MusicBrainz, atOnce under way at most (one at a time to
  // musicbrainz.org), in the order asked, started gapMs after the one before
  // it at least (and after a slow answer, as long again: see MB_LIMITS),
  // skipped if `signal` says whoever wanted it has gone. In the background
  // (`background`): once no one's waiting on one.
  ask(path, params, signal, { background = false } = {}) {
    if (background) {
      return (async () => {
        while (this.waiting > 0) {
          if (signal?.aborted) throw new Gone();
          await new Promise((r) => setTimeout(r, 200));
        }
        return this.asked(path, params, signal, { background: true });
      })();
    }
    this.waiting += 1;
    return this.asked(path, params, signal).finally(() => {
      this.waiting -= 1;
    });
  }

  // (`background`: no one's waiting on it, so a server of your own has
  // longer to answer: see MB_LIMITS ownTimeoutMs.)
  asked(path, params, signal, { background = false } = {}) {
    const run = async () => {
      if (signal?.aborted) throw new Gone();
      // (Busy: whatever's asking, and whatever was waiting its turn, is
      // turned away until it said to come back.)
      if (Date.now() < this.quietUntil) throw this.busy(this.quietUntil - Date.now());
      // (Its start is set as it's next in line, so those under way at once
      // still start gapMs apart; and never sooner than that after the last
      // one went, however late it woke: the service busy a moment, writing
      // what's kept, say, doesn't bunch them up.)
      const at = Math.max(Date.now(), this.nextAt);
      this.nextAt = at + this.gapMs;
      if (at > Date.now()) await new Promise((r) => setTimeout(r, at - Date.now()));
      while (Date.now() < this.lastStart + this.gapMs) await new Promise((r) => setTimeout(r, this.lastStart + this.gapMs - Date.now()));
      if (signal?.aborted) throw new Gone();
      if (Date.now() < this.quietUntil) throw this.busy(this.quietUntil - Date.now());
      const started = Date.now();
      this.lastStart = started;
      this.nextAt = Math.max(this.nextAt, started + this.gapMs);
      const url = `${this.base}${path}?${new URLSearchParams({ ...params, fmt: 'json' })}`;
      const ctrl = new AbortController();
      const waitMs = background && !this.public ? MB_LIMITS.ownTimeoutMs : MB_LIMITS.timeoutMs;
      let late = false;
      const timer = setTimeout(() => {
        late = true;
        ctrl.abort();
      }, waitMs);
      const stop = () => ctrl.abort();
      signal?.addEventListener('abort', stop, { once: true });
      try {
        // (Never followed elsewhere: what's asked goes to this MusicBrainz,
        // and the answer is its own.)
        const res = await this.fetch(url, {
          headers: { Accept: 'application/json', 'User-Agent': this.agent },
          redirect: 'error',
          signal: ctrl.signal,
        });
        this.lastAnswerAt = Date.now();
        const took = Date.now() - started;
        if (this.public && took > MB_LIMITS.slowMs) this.nextAt = Math.max(this.nextAt, Date.now() + Math.min(MB_LIMITS.slowWaitMaxMs, took));
        // (musicbrainz.org says it's busy with a 503; a server of your own,
        // with a 429, or a 503 that says when to come back, or one to
        // anything but a search, as a rate limit in front of it does. A
        // search's 503 without: its search indexes not there.)
        const retry = res.headers?.get?.('retry-after');
        const search = Object.hasOwn(params || {}, 'query');
        if (res.status === 429 || (res.status === 503 && (this.public || retry || !search))) {
          const ms = retryAfterMs(retry);
          this.unwell(ms);
          this.quietUntil = Math.max(this.quietUntil, Date.now() + ms);
          this.paced(took, { missed: true });
          throw this.busy(ms);
        }
        if (res.status >= 500) this.unwell();
        this.paced(took, { missed: res.status >= 500 });
        // (A server of your own needs its search indexes for these.)
        if (!res.ok) throw Object.assign(new MusicBrainzError(502, this.public ? `MusicBrainz answered ${res.status}.` : `The player’s MusicBrainz server answered ${res.status}. Searching it needs its search indexes.`), { answered: res.status });
        return JSON.parse(await readCapped(res, MB_LIMITS.answerBytes));
      } catch (err) {
        if (err instanceof MusicBrainzError) throw err;
        if (signal?.aborted) throw new Gone();
        // (No answer in time from a server of your own that answered others
        // meanwhile: it's up, and this one's a big one for it. Only this one
        // fails, and it's tried again in its turn: see worker. Otherwise it
        // isn't answering: a rest for its breath back, and for a minute,
        // nothing new asked of it.)
        const alone = this.public || !late || this.lastAnswerAt <= started;
        if (alone) {
          this.unwell();
          this.nextAt = Math.max(this.nextAt, Date.now() + MB_LIMITS.slowWaitMaxMs);
        }
        this.paced(Date.now() - started, { missed: alone });
        if (late) this.log?.debug(`musicbrainz: no answer within ${Math.round(waitMs / 1000)} s to ${path}${alone ? '' : ' (it answered others meanwhile)'}`);
        if (late) throw new MusicBrainzError(502, this.public ? 'MusicBrainz didn’t answer in time.' : 'The player’s MusicBrainz server didn’t answer in time.');
        throw new MusicBrainzError(502, this.public ? 'MusicBrainz couldn’t be reached from this player.' : 'The player’s MusicBrainz server couldn’t be reached.');
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', stop);
      }
    };
    return this.inTurn(run);
  }

  // `fn` once fewer than atOnce are under way, after those that were
  // waiting first.
  async inTurn(fn) {
    if (this.running < this.atOnce) this.running += 1;
    else await new Promise((r) => this.turns.push(r));
    try {
      return await fn();
    } finally {
      // (Its turn handed on as it is, where as many may be under way as
      // are: what's under way stays the same. Where fewer may be now, it
      // isn't.)
      const next = this.running <= this.atOnce ? this.turns.shift() : null;
      if (next) next();
      else this.running -= 1;
    }
  }

  // More may be under way at once now: those waiting their turn go.
  moreTurns() {
    while (this.running < this.atOnce && this.turns.length) {
      this.running += 1;
      this.turns.shift()();
    }
  }

  // How an answer went (`ms`: how long it took; `missed`: it wasn't one, as
  // the server didn't answer, or answered with an error or that it's busy).
  // A server of your own is asked more at once while it keeps up, and fewer
  // while it doesn't, as MB_LIMITS says: never more than ownAtOnceMost, and
  // one at a time at least. (Asked more only while it was asked as many as
  // it may be at once: a quick answer while there's little to ask says
  // nothing of how it'd do with more.) In debug mode, once a minute, the log
  // says how its answers went.
  paced(ms, { missed = false } = {}) {
    this.noteAnswer(ms, missed);
    if (this.public) return;
    if (missed) {
      this.recentAnswers = [];
      this.setAtOnce(Math.floor(this.atOnce / 2));
      return;
    }
    this.recentAnswers.push({ ms, full: this.running >= this.atOnce });
    if (this.recentAnswers.length < MB_LIMITS.ownWindow) return;
    const times = this.recentAnswers.map((w) => w.ms).sort((a, b) => a - b);
    const half = times[Math.floor(times.length / 2)];
    const full = this.recentAnswers.filter((w) => w.full).length * 2 >= this.recentAnswers.length;
    this.recentAnswers = [];
    if (half <= MB_LIMITS.ownQuickMs && full) this.setAtOnce(this.atOnce + 1);
    else if (half > MB_LIMITS.ownSlowMs) this.setAtOnce(this.atOnce - 1);
  }

  setAtOnce(n) {
    const to = Math.max(1, Math.min(MB_LIMITS.ownAtOnceMost, n));
    if (to === this.atOnce) return;
    this.atOnce = to;
    this.moreTurns();
    // (The background's workers too, where there's more to look up.)
    if (this.adv) this.work();
  }

  noteAnswer(ms, missed) {
    const m = this.lastMinute;
    if (missed) m.missed += 1;
    else if (m.times.length < 5000) m.times.push(ms);
    if (Date.now() - m.since < 60000) return;
    if (m.times.length || m.missed) {
      const times = m.times.sort((a, b) => a - b);
      const s = (v) => `${(v / 1000).toFixed(v < 10000 ? 1 : 0)} s`;
      const minutes = Math.round((Date.now() - m.since) / 60000);
      this.log?.debug(
        `musicbrainz: ${times.length} answer${times.length === 1 ? '' : 's'} in the last ${minutes > 1 ? `${minutes} minutes` : 'minute'}` +
          `${times.length ? `, half within ${s(times[Math.floor(times.length / 2)])}, the slowest ${s(times[times.length - 1])}` : ''}` +
          `${m.missed ? `, and ${m.missed} not answered (or busy)` : ''}; ${this.atOnce} asked at once at most now`,
      );
    }
    this.lastMinute = { since: Date.now(), times: [], missed: 0 };
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
    if (!found && !(data.artists || []).length) await this.searchCheck(signal, { index: 'artist' });
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
    if (!(songs.recordings || []).length) await this.searchCheck(signal, { index: 'recording' });
    const albums = await this.ask('/ws/2/release-group', { query: query('releasegroup'), limit: '5' }, signal);
    if ((albums['release-groups'] || []).some((g) => Number(g.score) >= 80 && norm(g.title) === want && theirs(g['artist-credit']))) {
      return this.remember(key, 'album');
    }
    if (!(albums['release-groups'] || []).length) await this.searchCheck(signal, { index: 'release-group' });
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

  // ---------- the app's MusicBrainz features (MUSICBRAINZ_ADVANCED) ----------
  // What they need of an artist: their MusicBrainz id, their other names
  // (aliases: other spellings and scripts), genres, and release groups
  // (albums, singles, EPs..., each with its kinds and when it first came
  // out); and of a release group, its genres. Asked about by artist, so an
  // album needs no request of its own but for its genres. `kept`: where
  // the answers are kept (an MBKept).
  advanced(kept) {
    this.adv = kept;
    return this;
  }

  // What's kept, or undefined for what isn't (null: MusicBrainz has none).
  had(key) {
    return this.adv ? this.adv.get(key) : undefined;
  }

  // MusicBrainz didn't answer (no answer in time, out of reach, busy): for
  // a minute, the features answer with what's kept only, and ask it
  // nothing new, so no one waits on it again and again (AI playlists'
  // checks still try, as they're asked).
  // (`ms`: as long as it said, where it said: see retryAfterMs.)
  unwell(ms = MB_ADVANCED_LIMITS.downMs) {
    this.downUntil = Math.max(this.downUntil, Date.now() + ms);
  }

  down() {
    return Date.now() < this.downUntil;
  }

  // MusicBrainz said it's busy, to come back in `ms`: what's said, and the
  // Retry-After for it.
  busy(ms) {
    const mins = Math.max(1, Math.round(ms / 60000));
    const when = mins === 1 ? 'in a minute' : `in ${mins} minutes`;
    // (`resting`: it's MusicBrainz, not whatever was asked of it: see worker.)
    return Object.assign(new MusicBrainzError(503, this.public ? `MusicBrainz is busy right now. Try again ${when}.` : `The player’s MusicBrainz server is busy. Try again ${when}.`), {
      retryAfter: Math.max(1, Math.ceil(ms / 1000)),
      resting: true,
    });
  }

  // A search found no one at all: whether searching this MusicBrainz finds
  // anyone. A server of your own whose search indexes haven't been built
  // (or are being built again) finds no one, without saying anything's
  // wrong, so every artist and song would seem not to be on MusicBrainz.
  // Checked in each index searched (artists, recordings, release groups),
  // with a search that finds something in any MusicBrainz (SEARCH_CHECK), at
  // most every few minutes; while it finds nothing, nothing a search
  // couldn't find is taken as not on MusicBrainz (it's an error,
  // `searchBroken`, said to the app), and what's found by a MusicBrainz id
  // is found as ever.
  async searchCheck(signal, { index = 'artist', background = false } = {}) {
    if (!this.checkSearch || !SEARCH_CHECK[index]) return;
    const s = this.search[index];
    if (!s || Date.now() - s.at > (s.works ? MB_LIMITS.searchOkMs : MB_LIMITS.searchBadMs)) {
      const found = await this.ask(`/ws/2/${index}`, { query: SEARCH_CHECK[index], limit: '1' }, signal, { background });
      const list = found?.[index === 'artist' ? 'artists' : index === 'recording' ? 'recordings' : 'release-groups'];
      const works = Array.isArray(list) && list.length > 0;
      if (!works && s?.works !== false) this.log?.warn(`musicbrainz: searching the MusicBrainz server's ${index}s finds no one, so its search indexes may not be built: until it does, only what's found by a MusicBrainz id is found`);
      if (works && s?.works === false) this.log?.info(`musicbrainz: searching the MusicBrainz server's ${index}s finds them again`);
      this.search[index] = { works, at: Date.now() };
    }
    if (!this.search[index].works) throw this.cantSearch();
  }

  // ...artists, as it was last checked, still: no one found.
  searchBroken() {
    const s = this.search.artist;
    return this.checkSearch && s?.works === false && Date.now() - s.at <= MB_LIMITS.searchBadMs;
  }

  cantSearch() {
    return Object.assign(new MusicBrainzError(502, 'The player’s MusicBrainz server finds no one when it’s searched: its search indexes may not be built.'), { searchBroken: true });
  }

  resting() {
    if (Date.now() < this.quietUntil) throw this.busy(this.quietUntil - Date.now());
    if (this.down()) throw Object.assign(new MusicBrainzError(503, 'MusicBrainz isn’t answering this player just now. Try again in a minute.'), { retryAfter: Math.max(1, Math.ceil((this.downUntil - Date.now()) / 1000)), resting: true });
  }

  // An artist, by name (or one of their other names), or by their
  // MusicBrainz id where Plex has it (`id`): { id, name, aliases, genres },
  // or null where MusicBrainz has no such artist (or it's one of
  // MusicBrainz's special-purpose ones: Various Artists, [unknown]...).
  // (`withNote`: as kept, but asked again where what's kept is from before
  // MusicBrainz's word for telling them apart was kept: see cleanArtist.)
  async artistInfo(name, { id = null, signal, background = false, withNote = false } = {}) {
    const want = norm(name);
    if (!this.adv || (!want && !MBID.test(String(id)))) return null;
    const byId = MBID.test(String(id));
    const key = byId ? `artistid|${id}` : `artist|${want}`;
    let kept = this.had(key);
    if (withNote && kept && kept.note === undefined) kept = undefined;
    // (An id MusicBrainz doesn't know, out of date in Plex: by name, then.
    // Not a special-purpose artist's, whose name a real artist may have.)
    if (kept === null && byId && want && !SPECIAL_ARTISTS.has(id)) return this.artistInfo(name, { signal, background });
    if (kept !== undefined) return kept;
    // (Not Various Artists, by any name: on MusicBrainz, theirs are
    // everyone's compilations, far too many to look through for one.)
    if (byId ? SPECIAL_ARTISTS.has(id) : PLACEHOLDER_ARTISTS.has(want)) return this.adv.set(key, null);
    this.resting();
    const opts = { background };
    let hit = byId ? { id } : null;
    if (!byId) {
      const found = await this.ask('/ws/2/artist', { query: `artist:${phrase(name)} OR alias:${phrase(name)}`, limit: '10' }, signal, opts);
      hit = pickArtist(found.artists, want);
      if (!hit) {
        if (!(Array.isArray(found?.artists) && found.artists.length)) await this.searchCheck(signal, { ...opts, index: 'artist' });
        return this.adv.set(key, null);
      }
    }
    let full;
    try {
      full = await this.ask(`/ws/2/artist/${hit.id}`, { inc: 'aliases genres' }, signal, opts);
    } catch (err) {
      if (!byId || err?.answered !== 404) throw err;
      this.adv.set(key, null);
      return want ? this.artistInfo(name, { signal, background }) : null;
    }
    const names = [full.name, full['sort-name'], ...(Array.isArray(full.aliases) ? full.aliases : []).flatMap((a) => [a?.name, a?.['sort-name']])];
    return this.adv.set(key, cleanArtist({ id: hit.id, name: full.name || hit.name, aliases: names, genres: topGenres(full.genres), note: typeof full.disambiguation === 'string' ? full.disambiguation : '' }));
  }

  // An artist's release groups, by their MusicBrainz id: [{ id, title,
  // primary, secondary, date, genres }] (those they're credited with, up to
  // 500: the list's `capped` where they have more, so it can't be told from
  // it that they haven't one), each with its genres, so none of their
  // albums needs a request of its own for those. (Kept before 0.38.0:
  // without, and asked for an album's where they're wanted.)
  async releaseGroups(artistId, { signal, background = false } = {}) {
    if (!this.adv || !MBID.test(String(artistId))) return [];
    const key = `groups|${artistId}`;
    const kept = this.had(key);
    if (kept !== undefined) return groupList(kept);
    this.resting();
    const out = [];
    let capped = false;
    for (let page = 0; page < MB_ADVANCED_LIMITS.groupPages; page += 1) {
      const data = await this.ask('/ws/2/release-group', { artist: artistId, inc: 'genres', limit: '100', offset: String(page * 100) }, signal, { background });
      const list = Array.isArray(data['release-groups']) ? data['release-groups'] : [];
      for (const g of list) {
        const clean = cleanGroup(g);
        if (clean) out.push(clean);
      }
      if (list.length < 100 || (page + 1) * 100 >= (Number(data['release-group-count']) || 0)) break;
      capped = page + 1 === MB_ADVANCED_LIMITS.groupPages;
    }
    return groupList(this.adv.set(key, capped ? { capped: true, groups: out } : out));
  }

  // Other artists MusicBrainz has of this very name (`but`: not this one,
  // by id): [{ id, name, note, groups }], MB_ADVANCED_LIMITS.namesakes at
  // most, the likeliest first, each with their release groups (`note`:
  // MusicBrainz's word for telling them apart, "Dutch drum & bass producer",
  // say), and `more` (true) where it has more of the name than those. For
  // telling an artist's albums from those of another of the same name,
  // which Plex can have as one artist (see the app's mb.js).
  async namesakes(name, { but = null, signal, background = false } = {}) {
    const want = norm(name);
    if (!this.adv || !want || PLACEHOLDER_ARTISTS.has(want)) return [];
    const key = `namesakes|${want}`;
    let list = this.had(key);
    if (list === undefined) {
      this.resting();
      const found = await this.ask('/ws/2/artist', { query: `artist:${phrase(name)} OR sortname:${phrase(name)}`, limit: '25' }, signal, { background });
      if (!(Array.isArray(found?.artists) && found.artists.length)) await this.searchCheck(signal, { index: 'artist', background });
      list = this.adv.set(key, sameNamed(found.artists, want));
    }
    const rest = (list || []).filter((x) => x.id !== but);
    const out = [];
    for (const a of rest.slice(0, MB_ADVANCED_LIMITS.namesakes)) {
      const groups = await this.releaseGroups(a.id, { signal, background });
      out.push({ ...a, groups, capped: !!groups.capped });
    }
    if (rest.length > out.length) out.more = true;
    return out;
  }

  // A release group's genres (MusicBrainz's, the most voted first).
  async groupGenres(id, { signal, background = false } = {}) {
    if (!this.adv || !MBID.test(String(id))) return [];
    const key = `genres|${id}`;
    const kept = this.had(key);
    if (kept !== undefined) return kept;
    this.resting();
    const data = await this.ask(`/ws/2/release-group/${id}`, { inc: 'genres' }, signal, { background });
    return this.adv.set(key, topGenres(data.genres));
  }

  // One of an artist's albums, among their release groups: by its title
  // (and the year Plex has for it, to tell albums of one title apart: see
  // releases.js matchGroup), or with `strict`, for its year and genres to be
  // fixed, the very album or nothing: the one Plex has it as (`albumId`,
  // Plex's MusicBrainz id for it, where the titles agree), or else, for an
  // album of more tracks than a single's (`tracks`, Plex's count of them),
  // the studio album of its exact title (releases.js exactAlbum). Its
  // release group (with `genres`, and its genres), or null where MusicBrainz
  // has no such artist, or no such album of theirs (or which it is can't be
  // told). Plex's id for the album is looked for among the artist's: only
  // the artist's name, or their id, goes to MusicBrainz to find it.
  // (`id`: the artist's MusicBrainz id, where Plex has it: then no search.)
  async album(artist, title, { genres = false, year = null, id = null, albumId = null, strict = false, tracks = 0, check = false, trackList = null, signal, background = false } = {}) {
    if (check && !this.public) return this.checkedAlbum(artist, title, { genres, id, albumId, trackList, signal, background });
    const info = await this.artistInfo(artist, { id, signal, background });
    if (!info) return null;
    const g = pickAlbum(await this.releaseGroups(info.id, { signal, background }), title, { year, albumId, strict, tracks });
    if (!g) return null;
    return this.withGenres(g, genres, { signal, background });
  }

  // A release group as an answer: with its genres where they're wanted
  // (`genres`): those it came with, in its artist's release groups (see
  // releaseGroups), else asked for (see groupGenres); without them where
  // they aren't.
  async withGenres(g, genres, { signal, background = false } = {}) {
    if (!genres) return plainGroup(g);
    return Array.isArray(g.genres) ? g : { ...g, genres: await this.groupGenres(g.id, { signal, background }) };
  }

  // ...as far as it's known now (undefined: its genres aren't).
  knownWithGenres(g, genres) {
    if (!genres) return plainGroup(g);
    if (Array.isArray(g.genres)) return g;
    const got = this.had(`genres|${g.id}`);
    return got === undefined ? undefined : { ...g, genres: got };
  }

  // ...as far as it's known now, without asking: undefined where it isn't.
  knownAlbum(artist, title, { genres = false, year = null, id = null, albumId = null, strict = false, tracks = 0, check = false, trackList = null } = {}) {
    const groups = this.knownGroups(artist, id);
    if (!groups) return groups;
    if (check && !this.public) return this.knownChecked(groups, title, { genres, albumId, trackList });
    const g = pickAlbum(groups, title, { year, albumId, strict, tracks });
    return g ? this.knownWithGenres(g, genres) : g;
  }

  // An artist's release groups as far as they're known now (see knownAlbum):
  // undefined where they aren't, null where there's no such artist.
  knownGroups(artist, id) {
    const who = norm(artist);
    const byId = MBID.test(String(id));
    if (!this.adv || (!who && !byId)) return null;
    if (byId ? SPECIAL_ARTISTS.has(id) : PLACEHOLDER_ARTISTS.has(who)) return null;
    // (An id MusicBrainz doesn't know: by name, as artistInfo goes.)
    let info = byId ? this.had(`artistid|${id}`) : this.had(`artist|${who}`);
    if (info === null && byId && who) info = this.had(`artist|${who}`);
    if (!info) return info;
    const groups = this.had(`groups|${info.id}`);
    return groups === undefined ? undefined : groupList(groups);
  }

  // ---------- on a MusicBrainz of your own: an album, by its very tracks ----------
  // For its year and genres to be fixed: the release group of an artist's
  // that's this album (Plex's MusicBrainz id for it, a release group's or a
  // release's, looked up where it isn't one of the artist's; or else those
  // of its exact title, of any kind), by its tracks (`trackList`: [{ title,
  // ms }], as Plex has them): the first of its releases with those very
  // tracks (see firstOfTracks), whose date is when this album first came
  // out: { ...group, date, release, checked: true }, or null where none of
  // its releases has them (a re-recording, a remix package, another album
  // of the title). Of several of its title with them, the closest (see
  // closestFirst). Without its tracks: what's to be checked, the earliest of
  // those of its title ({ ...group, toCheck: true }), for the app to ask
  // again with its tracks where it would fix anything. Only of a MusicBrainz
  // of your own: musicbrainz.org is asked about artists alone, by name or
  // id (see album, `strict`).
  async checkedAlbum(artist, title, { genres = false, id = null, albumId = null, trackList = null, signal, background = false } = {}) {
    const info = await this.artistInfo(artist, { id, signal, background });
    if (!info) return null;
    const groups = await this.releaseGroups(info.id, { signal, background });
    let candidates = [];
    if (MBID.test(String(albumId))) {
      const g = groups.find((x) => x.id === albumId) || (await this.albumGroup(albumId, { signal, background }));
      candidates = g && titlesAgree(g, title) ? [g] : [];
    } else candidates = sameTitled(groups, title);
    if (!candidates.length) return null;
    const withGenres = (g) => this.withGenres(g, genres, { signal, background });
    if (!Array.isArray(trackList) || !trackList.length) return withGenres({ ...candidates[0], toCheck: true });
    const found = [];
    for (const g of candidates) found.push({ g, first: await this.firstOfTracks(g.id, trackList, { signal, background }) });
    const best = closestFirst(found);
    return best ? withGenres({ ...best.g, date: best.first.date, release: best.first.release, checked: true }) : null;
  }

  // ...as far as it's known now (see knownAlbum).
  knownChecked(groups, title, { genres = false, albumId = null, trackList = null } = {}) {
    let candidates = [];
    if (MBID.test(String(albumId))) {
      const g = groups.find((x) => x.id === albumId) || this.had(`album|${albumId}`);
      if (g === undefined) return undefined;
      candidates = g && titlesAgree(g, title) ? [g] : [];
    } else candidates = sameTitled(groups, title);
    if (!candidates.length) return null;
    const withGenres = (g) => this.knownWithGenres(g, genres);
    if (!Array.isArray(trackList) || !trackList.length) return withGenres({ ...candidates[0], toCheck: true });
    const sig = tracksSig(trackList);
    const found = [];
    for (const g of candidates) {
      const first = this.had(`checked|${g.id}|${sig}`);
      if (first === undefined) return undefined;
      found.push({ g, first });
    }
    const best = closestFirst(found);
    return best ? withGenres({ ...best.g, date: best.first.date, release: best.first.release, checked: true }) : null;
  }

  // Plex's MusicBrainz id for an album, looked up: the release group it's
  // the id of, or that of the release it's the id of (Plex can have
  // either), asked as the last one found was first. Null where MusicBrainz
  // knows neither. Kept for a month.
  async albumGroup(albumId, { signal, background = false } = {}) {
    if (!this.adv || this.public || !MBID.test(String(albumId))) return null;
    const key = `album|${albumId}`;
    const kept = this.had(key);
    if (kept !== undefined) return kept;
    this.resting();
    const kinds = this.albumIdsAre === 'release-group' ? ['release-group', 'release'] : ['release', 'release-group'];
    for (const kind of kinds) {
      let data;
      try {
        data = await this.ask(`/ws/2/${kind}/${albumId}`, kind === 'release' ? { inc: 'release-groups' } : {}, signal, { background });
      } catch (err) {
        if (err?.answered === 404 || err?.answered === 400) continue;
        throw err;
      }
      const g = cleanGroup(kind === 'release' ? data?.['release-group'] : data);
      if (!g) continue;
      this.albumIdsAre = kind;
      return this.adv.set(key, g);
    }
    return this.adv.set(key, null);
  }

  // A release group's releases: [{ id, date, tracks }] (`tracks`: how many,
  // on all its media), RELEASE_PAGES pages at most (of 100, or fewer where
  // those would have more than 500 tracks: MusicBrainz sends no more, so
  // the next page is from as many as came). Kept a while in memory only
  // (what's kept on disk is each album's answer: see firstOfTracks).
  async groupReleases(gid, { signal, background = false } = {}) {
    const had = this.releasesOf.get(gid);
    if (had) return had;
    const out = [];
    let offset = 0;
    for (let page = 0; page < MB_ADVANCED_LIMITS.releasePages; page += 1) {
      const data = await this.ask('/ws/2/release', { 'release-group': gid, inc: 'media', limit: '100', offset: String(offset) }, signal, { background });
      const list = Array.isArray(data?.releases) ? data.releases : [];
      for (const r of list) {
        if (!MBID.test(String(r?.id))) continue;
        const date = text(r.date, 10);
        const tracks = (Array.isArray(r.media) ? r.media : []).reduce((n, m) => n + (Number(m?.['track-count']) || 0), 0);
        out.push({ id: r.id, date: DATE.test(date) ? date : '', tracks });
      }
      offset += list.length;
      if (!list.length || offset >= (Number(data?.['release-count']) || 0)) break;
    }
    return remembered(this.releasesOf, gid, out, MB_ADVANCED_LIMITS.releasesKept);
  }

  // A release's tracks: [{ title, ms }], kept a while in memory.
  async releaseTracks(rid, { signal, background = false } = {}) {
    const had = this.tracksOf.get(rid);
    if (had) return had;
    const data = await this.ask(`/ws/2/release/${rid}`, { inc: 'recordings' }, signal, { background });
    const out = (Array.isArray(data?.media) ? data.media : [])
      .flatMap((m) => (Array.isArray(m?.tracks) ? m.tracks : []))
      .map((t) => ({ title: text(t?.title || t?.recording?.title, 300), ms: Number(t?.length ?? t?.recording?.length) || 0 }))
      .filter((t) => t.title)
      .slice(0, 500);
    return remembered(this.tracksOf, rid, out, MB_ADVANCED_LIMITS.tracksKept);
  }

  // The first release of a release group with an album's very tracks (see
  // releases.js tracksInCommon): of its releases of about as many tracks
  // (see releaseSizes), with a date, the earliest first, CHECKED_RELEASES of
  // them at most: { date, release, same } (`same`: how many of the album's
  // tracks it has), or null where none of those has them. Kept for a month,
  // by the release group and the album's tracks.
  async firstOfTracks(gid, trackList, { signal, background = false } = {}) {
    const key = `checked|${gid}|${tracksSig(trackList)}`;
    const kept = this.had(key);
    if (kept !== undefined) return kept;
    this.resting();
    const [fewest, most] = releaseSizes(trackList.length);
    const releases = (await this.groupReleases(gid, { signal, background }))
      .filter((r) => r.date && r.tracks >= fewest && r.tracks <= most)
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(0, MB_ADVANCED_LIMITS.checkedReleases);
    for (const r of releases) {
      const same = tracksInCommon(trackList, await this.releaseTracks(r.id, { signal, background }));
      if (same) return this.adv.set(key, { date: r.date, release: r.id, same });
    }
    return this.adv.set(key, null);
  }

  // Albums to look up in the background (an owner looking through their
  // library, say): several at once on a MusicBrainz of your own (one on
  // musicbrainz.org: see work), once no one's waiting on MusicBrainz for
  // anything else; those checked by their tracks first (each the end of one
  // whose lookup is under way: see checkedAlbum), then the rest in the
  // order asked. At most MB_ADVANCED_LIMITS.queued waiting, and queuedEach
  // of any one account's (`who`): false if there's no room for this one now
  // (nor while MusicBrainz isn't answering).
  later(artist, title, { genres = false, year = null, who = '', id = null, albumId = null, strict = false, tracks = 0, check = false, trackList = null } = {}) {
    if (!this.adv || !norm(artist) || !albumKey(title) || this.down()) return false;
    const it = this.wanted(artist, title, { genres, year, id, albumId, strict, tracks, check, trackList });
    if (this.todo.has(it.key) || this.todoFirst.has(it.key)) return true;
    if (this.todo.size + this.todoFirst.size >= MB_ADVANCED_LIMITS.queued || (this.queuedBy.get(who) || 0) >= MB_ADVANCED_LIMITS.queuedEach) return false;
    (it.trackList ? this.todoFirst : this.todo).set(it.key, { ...it, who, tries: 0 });
    this.queuedBy.set(who, (this.queuedBy.get(who) || 0) + 1);
    this.work();
    return true;
  }

  // An album as it's looked up, and the key it's waited on by, and its
  // answer kept by (see albums): what tells it apart from others, and how
  // it's looked up (by its tracks, with them). Nothing of who asked.
  wanted(artist, title, { genres = false, year = null, id = null, albumId = null, strict = false, tracks = 0, check = false, trackList = null } = {}) {
    const byId = MBID.test(String(id)) ? id : null;
    const byAlbum = MBID.test(String(albumId)) ? albumId : null;
    const count = Math.max(0, Math.min(10000, Math.floor(Number(tracks) || 0)));
    const checking = !!check && !this.public;
    const list = checking && Array.isArray(trackList) && trackList.length ? trackList : null;
    const how = checking ? `c|${list ? tracksSig(list) : ''}` : strict ? `1|${count}` : 0;
    const key = `${norm(artist)}|${strict || checking ? exactKey(title) : albumKey(title)}|${Number(year) || ''}|${genres ? 1 : 0}|${byId || ''}|${byAlbum || ''}|${how}`;
    return { key, artist: String(artist), title: String(title), genres: !!genres, year: Number(year) || null, id: byId, albumId: byAlbum, strict: !!strict, tracks: count, check: checking, trackList: list };
  }

  done(key) {
    const it = this.todoFirst.get(key) || this.todo.get(key);
    if (!it) return;
    this.todoFirst.delete(key);
    this.todo.delete(key);
    const left = (this.queuedBy.get(it.who) || 1) - 1;
    if (left > 0) this.queuedBy.set(it.who, left);
    else this.queuedBy.delete(it.who);
  }

  // What's to be looked up next, by a worker: [key, it], or null where
  // nothing waiting is free to be. Those checked by their tracks first; of
  // the rest, none of an artist another worker has in hand (their release
  // groups are asked about once: see releaseGroups). Not one waiting to be
  // tried again (see worker) before it's due: the workers are woken for it.
  nextTodo() {
    const now = Date.now();
    let soonest = 0;
    const due = (it) => {
      if (!(it.notBefore > now)) return true;
      if (!soonest || it.notBefore < soonest) soonest = it.notBefore;
      return false;
    };
    for (const entry of this.todoFirst) if (!this.inHand.has(entry[0]) && due(entry[1])) return entry;
    for (const entry of this.todo) if (!this.inHand.has(entry[0]) && !this.artistsInHand.has(artistOf(entry[1])) && due(entry[1])) return entry;
    if (soonest) this.wake(soonest);
    return null;
  }

  // The workers set going again at `at`, when one waiting to be tried again
  // is due.
  wake(at) {
    if (this.wakeTimer && this.wakeDue <= at) return;
    clearTimeout(this.wakeTimer);
    this.wakeDue = at;
    this.wakeTimer = setTimeout(
      () => {
        this.wakeTimer = null;
        this.wakeDue = 0;
        this.work();
      },
      Math.max(0, at - Date.now()) + 10,
    );
    this.wakeTimer.unref?.();
  }

  // An album MusicBrainz didn't answer for, each time it was asked (see
  // worker), as yet (it's 'unanswered' to the app: see albums).
  gaveUp(key) {
    const at = this.unanswered.get(key);
    if (!at) return false;
    if (Date.now() - at <= MB_ADVANCED_LIMITS.unansweredMs) return true;
    this.unanswered.delete(key);
    return false;
  }

  // Workers for what's waiting: atOnce of them at most (musicbrainz.org:
  // one), each looking up one album at a time, while there's one free to
  // be looked up.
  work() {
    while (this.workers < this.atOnce && this.nextTodo()) {
      this.workers += 1;
      this.worker()
        .catch((err) => this.log?.error(`musicbrainz: looking up albums stopped: ${err?.message || err}`))
        .finally(() => {
          this.workers -= 1;
        });
    }
  }

  async worker() {
    for (;;) {
      // (MusicBrainz not answering: a rest until it's tried again.)
      while (this.down()) await new Promise((r) => setTimeout(r, Math.min(1000, this.downUntil - Date.now() + 10)));
      const next = this.nextTodo();
      if (!next) return;
      const [key, it] = next;
      // (Only a search could find it, and searching finds no one just
      // now: let go without asking. The app's told it's unchecked.)
      if (!it.id && this.searchBroken()) {
        this.done(key);
        continue;
      }
      const artist = artistOf(it);
      const holds = !it.trackList && !this.artistsInHand.has(artist);
      this.inHand.add(key);
      if (holds) this.artistsInHand.add(artist);
      // (Others, for what's waiting of other artists, where there's room.)
      this.work();
      try {
        const answer = await this.album(it.artist, it.title, { genres: it.genres, year: it.year, id: it.id, albumId: it.albumId, strict: it.strict, tracks: it.tracks, check: it.check, trackList: it.trackList, background: true });
        this.adv.setAnswer(key, answer);
        this.done(key);
      } catch (err) {
        // Only a search could find it, and searching finds no one: let go
        // straight away (the app's told it's unchecked; asked about again,
        // it's queued again, and searching's checked again by then).
        if (err?.searchBroken) this.done(key);
        else if (err?.resting) {
          // MusicBrainz busy, or not answering anything: again once it's
          // been left as long as it said (or a minute), as many times as
          // that takes (it's MusicBrainz, not this album).
          it.notBefore = Math.max(this.downUntil, this.quietUntil, Date.now() + 1000);
          const queue = this.todoFirst.has(key) ? this.todoFirst : this.todo;
          queue.delete(key);
          queue.set(key, it);
          this.wake(it.notBefore);
        } else {
          // No answer for it (too big for MusicBrainz to answer in time,
          // say, or MusicBrainz out of reach): tried again after a rest,
          // at the back of the queue, while the rest are looked up
          // (MusicBrainz not answering anything: nothing is meanwhile; see
          // down); `tries` times at most, and after that, the app's told
          // MusicBrainz didn't answer for it (see albums), rather than its
          // being asked again and again, holding the rest up.
          it.tries += 1;
          const queue = this.todoFirst.has(key) ? this.todoFirst : this.todo;
          if (it.tries < MB_ADVANCED_LIMITS.tries) {
            it.notBefore = Date.now() + MB_ADVANCED_LIMITS.restMs;
            queue.delete(key);
            queue.set(key, it);
            this.wake(it.notBefore);
          } else {
            this.done(key);
            this.unanswered.delete(key);
            this.unanswered.set(key, Date.now());
            while (this.unanswered.size > MB_ADVANCED_LIMITS.unansweredKept) this.unanswered.delete(this.unanswered.keys().next().value);
            this.log?.debug(`musicbrainz: gave up on "${it.title}" by ${it.artist}, asked ${it.tries} times: ${err?.message || err}`);
          }
        }
      } finally {
        this.inHand.delete(key);
        if (holds) this.artistsInHand.delete(artist);
      }
    }
  }

  // For the app: each album's release group as far as it's known ('pending'
  // where it isn't yet: looked up in the background, for `who`), waiting
  // up to `waitMs` for those, 'unchecked' where only a search could find it
  // while searching finds no one (see searchCheck), and 'unanswered' where
  // MusicBrainz didn't answer for it, each time it was asked (see worker:
  // for MB_ADVANCED_LIMITS.unansweredMs, unless it's asked for again with
  // `retry`, a new look through the library). (Items: { artist, title,
  // year, artistId, albumId, tracks, trackList, retry }: the artist's and
  // the album's MusicBrainz ids, where Plex has them, so no search is
  // needed, how many tracks Plex has of it, and with `check`, those
  // tracks.) `strict` and `check`: as album has them.
  // While it waits, only those still pending are looked at again.
  async albums(items, { genres = false, waitMs = 0, signal, who = '', strict = false, check = false } = {}) {
    const bySearch = (it) => !MBID.test(String(it.artistId)) || this.had(`artistid|${it.artistId}`) === null;
    const how = (it) => ({ genres, year: it.year, id: it.artistId, albumId: it.albumId, strict, tracks: it.tracks, check, trackList: it.trackList || null });
    const keyOf = (it) => (this.adv && norm(it.artist) && albumKey(it.title) ? this.wanted(it.artist, it.title, how(it)).key : null);
    for (const it of items) if (it.retry) this.unanswered.delete(keyOf(it));
    // (What was answered before is kept by itself, so a library looked
    // through again is answered at once: see MBKept.answer.)
    const answer = (it) => {
      const key = keyOf(it);
      const kept = key ? this.adv.answer(key) : undefined;
      if (kept !== undefined) return kept;
      const v = this.knownAlbum(it.artist, it.title, how(it));
      // (Kept where it's an album: none, for a title or a year anyone can
      // make up, is kept only once looked up, in its turn: see worker.)
      if (v !== undefined) return key && v ? this.adv.setAnswer(key, v) : v;
      if (key && this.gaveUp(key)) return 'unanswered';
      return this.searchBroken() && bySearch(it) ? 'unchecked' : 'pending';
    };
    let out = items.map(answer);
    out.forEach((v, i) => v === 'pending' && this.later(items[i].artist, items[i].title, { ...how(items[i]), who }));
    const until = Date.now() + Math.max(0, Math.min(Number(waitMs) || 0, MB_ADVANCED_LIMITS.waitMs));
    while (out.includes('pending') && Date.now() < until && !signal?.aborted) {
      await new Promise((r) => setTimeout(r, MB_ADVANCED_LIMITS.pendingMs));
      out = out.map((v, i) => (v === 'pending' ? answer(items[i]) : v));
    }
    return out;
  }
}

// ---------- the advanced features' answers, and how they're kept ----------

export const MB_ADVANCED_LIMITS = {
  keepMs: 30 * 86400000, // what's kept: a month
  kept: 20000, // answers kept
  bytes: 30 * 1024 * 1024, // ...in all, as JSON
  answers: 100000, // ...and albums' answers, as the app was given them (see MBKept.answer)
  answerBytes: 40 * 1024 * 1024, // ...in all, as JSON
  writeMs: 5 * 60000, // written at most this often (and as the service stops)
  firstWriteMs: 10000, // ...the first time since it started, this soon after the first answer
  queued: 5000, // albums waiting to be looked up in the background
  queuedEach: 2000, // ...of any one account's
  downMs: 60000, // after MusicBrainz doesn't answer, nothing new asked of it for this long
  perRequest: 1000, // albums asked about in one request from the app...
  perMinute: 30000, // ...and in a minute, by each account
  waitMs: 10000, // how long a request from the app may wait for answers
  groupPages: 5, // of an artist's release groups, 100 to a page
  // On a MusicBrainz of your own (see checkedAlbum):
  trackList: 200, // tracks of an album, asked about with them
  releasePages: 3, // of a release group's releases, 100 to a page
  checkedReleases: 6, // ...whose tracks are read, to find the first of an album's, at most
  releasesKept: 500, // release groups' releases kept in memory
  tracksKept: 3000, // ...and releases' tracks
  namesakes: 3, // other artists of an artist's name, looked at for their page
  artistMs: 30000, // how long one artist's lookups may take for the app
  restMs: 30000, // an album MusicBrainz didn't answer for, in the background, is tried again after this long
  tries: 3, // ...this many times at most
  unansweredMs: 6 * 3600000, // ...and after that, it's said to the app that it didn't answer for it, for this long (or until a new look)
  unansweredKept: 5000, // ...of so many albums at most
  pendingMs: 200, // how often what a request from the app waits for is looked at again
};

const MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// MusicBrainz's special-purpose artists, never anyone's discography: Various
// Artists, [unknown], [anonymous], [traditional], [no artist], [data],
// [dialogue], [Disney], [theatre], [church chimes] and [language
// instruction]. And names compilations go by (as norm has them), and those
// of works by no one known (Anonymous, Traditional), never looked up: a real
// artist of that name would be the wrong one.
const SPECIAL_ARTISTS = new Set([
  '89ad4ac3-39f7-470e-963a-56509c546377',
  '125ec42a-7229-4250-afc5-e057484327fe',
  'f731ccc4-e22a-43af-a747-64213329e088',
  '9be7f096-97ec-4615-8957-8d40b5dcbc41',
  'eec63d3c-3b81-4ad4-b1e4-7c147d4d2b61',
  '33cf029c-63b0-41a0-9855-be2a3665fb3b',
  '314e1c25-dde7-4e4d-b2f4-0a7b9f7c56dc',
  '66ea0139-149f-4a0c-8fbf-5ea9ec4a6e49',
  'a0ef7e1d-44ff-4039-9435-7d5fefdeecc9',
  '90068d37-bae7-4292-be4a-704c145bd616',
  '80a8851f-444c-4539-892b-ad2a49292aa9',
]);
const DATE = /^\d{4}(-\d{2}(-\d{2})?)?$/;
const text = (v, n) => (typeof v === 'string' ? v.replace(CONTROL_CHARACTERS, ' ').trim().slice(0, n) : '');

// The artist among MusicBrainz's search results: one of that name, or else
// one with it among their other names, and a good match either way (never
// a special-purpose one).
function pickArtist(list, want) {
  const ok = (Array.isArray(list) ? list : []).filter((a) => a && MBID.test(String(a.id)) && !SPECIAL_ARTISTS.has(String(a.id)) && Number(a.score) >= 80);
  const aliased = (a) => norm(a['sort-name']) === want || (Array.isArray(a.aliases) ? a.aliases : []).some((x) => norm(x?.name) === want || norm(x?.['sort-name']) === want);
  return ok.find((a) => norm(a.name) === want) || ok.find(aliased) || null;
}

// The artists among MusicBrainz's search results with this very name (as
// norm has it: not those with it among their other names), the likeliest
// first: { id, name, note }, ten at most (never a special-purpose one).
function sameNamed(list, want) {
  return (Array.isArray(list) ? list : [])
    .filter((a) => a && MBID.test(String(a.id)) && !SPECIAL_ARTISTS.has(String(a.id)) && norm(a.name) === want)
    .map(cleanNamesake)
    .filter(Boolean)
    .slice(0, 10);
}

function cleanNamesake(a) {
  if (!a || !MBID.test(String(a.id))) return null;
  return { id: a.id, name: text(a.name, 200), note: text(a.disambiguation ?? a.note, 120) };
}

// Of an artist's release groups, those of an album's exact title (as
// releases.js exactKey has it), of any kind, the earliest first: three at
// most (see checkedAlbum, which goes by their tracks).
function sameTitled(groups, title) {
  const want = exactKey(title);
  if (!want || !Array.isArray(groups)) return [];
  const keys = titleKeys(groups, 'exact');
  return groups
    .filter((g, i) => g && keys[i] === want)
    .sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999'))
    .slice(0, 3);
}

// Of an album's title's release groups, each with the first of its
// releases with the album's tracks (firstOfTracks: [{ g, first }], `first`
// null where none), the one most like it: with the most of its tracks (an
// album of 18 is the compilation of those 18, not an earlier one of 14 of
// them), then the earliest. Null where none has them.
function closestFirst(found) {
  let best = null;
  for (const x of found) {
    if (!x.first) continue;
    const same = x.first.same || 0;
    const had = best ? best.first.same || 0 : -1;
    if (same > had || (same === had && x.first.date < best.first.date)) best = x;
  }
  return best;
}

// An album's tracks, as a short hash, by what's compared of them (see
// releases.js tracksInCommon: their titles and lengths, in any order).
// Whose album it is, for one worker at a time to an artist (see nextTodo):
// their MusicBrainz id where Plex has it, else their name.
const artistOf = (it) => it.id || norm(it.artist);

function tracksSig(trackList) {
  const keys = (Array.isArray(trackList) ? trackList : []).map((t) => `${trackKey(t?.title)}~${Math.round((Number(t?.ms) || 0) / 1000)}`).sort();
  return createHash('sha256').update(keys.join('\n')).digest('hex').slice(0, 20);
}

// A map kept to `most` entries, the oldest going first: `v`, set.
function remembered(map, key, v, most) {
  map.delete(key);
  map.set(key, v);
  while (map.size > most) map.delete(map.keys().next().value);
  return v;
}

// A list of release groups' titles as they're matched (`kind`: 'album',
// as releases.js albumKey has them, or 'exact', as exactKey does), in
// order: worked out once for each list as it's kept, not again for each
// album looked for among them, each time it's looked for.
const keysOf = new WeakMap(); // a list of release groups -> { album, exact }
function titleKeys(groups, kind) {
  let keys = keysOf.get(groups);
  if (!keys) keysOf.set(groups, (keys = {}));
  keys[kind] ||= groups.map((g) => (kind === 'album' ? albumKey(g?.title) : exactKey(g?.title)));
  return keys[kind];
}

// An album's release group among its artist's (see MusicBrainz album): by
// the rules in releases.js, given those of the artist's that could be it (by
// their keys, worked out once: see titleKeys), which come out the same.
function pickAlbum(groups, title, { year = null, albumId = null, strict = false, tracks = 0 } = {}) {
  const id = MBID.test(String(albumId)) ? albumId : null;
  if (strict) {
    // (Plex's id for it, or its exact title.)
    const want = exactKey(title);
    const keys = titleKeys(groups, 'exact');
    return exactAlbum(groups.filter((g, i) => (id && g?.id === id) || (want && keys[i] === want)), title, { id, year, tracks });
  }
  const byId = id && groups.find((g) => g?.id === id);
  if (byId) return byId;
  // (Its title, or else a title near it.)
  const want = albumKey(title);
  if (!want) return null;
  const keys = titleKeys(groups, 'album');
  const same = groups.filter((g, i) => keys[i] === want);
  return matchGroup(same.length ? same : groups.filter((g, i) => sameTitle(keys[i], want)), title, null, year);
}

// A release group as it's kept, or null: with its genres where it came with
// them (see releaseGroups).
function cleanGroup(g) {
  if (!g || !MBID.test(String(g.id))) return null;
  const title = text(g.title, 300);
  if (!title) return null;
  const secondary = (Array.isArray(g['secondary-types'] ?? g.secondary) ? g['secondary-types'] ?? g.secondary : []).map((x) => text(x, 40)).filter(Boolean).slice(0, 8);
  const date = text(g['first-release-date'] ?? g.date, 10);
  const genres = groupGenreList(g.genres);
  return { id: g.id, title, primary: text(g['primary-type'] ?? g.primary, 40), secondary, date: DATE.test(date) ? date : '', ...(genres ? { genres } : {}) };
}

// ...and without its genres (an answer they weren't asked for with).
function plainGroup(g) {
  if (!g || g.genres === undefined) return g;
  const rest = { ...g };
  delete rest.genres;
  return rest;
}

// A release group's genres, as MusicBrainz gives them ([{ name, count }])
// or as they're kept (their names): null where it has none listed.
function groupGenreList(list) {
  if (!Array.isArray(list)) return null;
  return list.every((x) => typeof x === 'string') ? list.map((x) => text(x, 60)).filter(Boolean).slice(0, 5) : topGenres(list);
}

function cleanArtist(a) {
  if (!a || !MBID.test(String(a.id))) return null;
  const list = (v, n, each) => [...new Set((Array.isArray(v) ? v : []).map((x) => text(x, each)).filter(Boolean))].slice(0, n);
  // (`note`: MusicBrainz's word for telling them apart from others of the
  // name, "American grunge band", say; not there in what was kept before
  // 0.36.0.)
  const note = typeof (a.note ?? a.disambiguation) === 'string' ? { note: text(a.note ?? a.disambiguation, 120) } : {};
  return { id: a.id, name: text(a.name, 200), aliases: list(a.aliases, 40, 200), genres: list(a.genres, 5, 60), ...note };
}

// MusicBrainz's genres, as Plex names them ("alternative rock": Alternative
// Rock), the most voted first: five at most.
const UPPER = new Set(['r&b', 'edm', 'idm', 'ebm', 'uk', 'us', 'dnb', 'ost']);
const genreName = (s) =>
  String(s)
    .trim()
    .split(/(\s+|-)/)
    .map((w) => (UPPER.has(w.toLowerCase()) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join('');
function topGenres(list) {
  return (Array.isArray(list) ? list : [])
    .filter((g) => typeof g?.name === 'string' && g.name.trim() && (Number(g.count) || 0) > 0)
    .sort((a, b) => (Number(b.count) || 0) - (Number(a.count) || 0))
    .slice(0, 5)
    .map((g) => text(genreName(g.name), 60));
}

// A list of release groups as it's kept: as it is, or (more than were
// asked for) { capped: true, groups }. As releaseGroups gives it: the list,
// `capped` where it is (the same list each time, for what's kept: see
// titleKeys).
const listed = new WeakMap(); // { capped, groups } as kept -> the list
function groupList(v) {
  if (Array.isArray(v)) return v;
  if (!v || typeof v !== 'object') return [];
  let list = listed.get(v);
  if (!list) {
    list = Array.isArray(v.groups) ? v.groups.slice() : [];
    if (v.capped === true) list.capped = true;
    listed.set(v, list);
  }
  return list;
}

// A kept answer, checked as it's read back (undefined: it doesn't check out).
function cleanKept(key, v) {
  if (key.startsWith('artist|') || key.startsWith('artistid|')) return v === null ? null : cleanArtist(v) || undefined;
  if (key.startsWith('groups|')) {
    if (Array.isArray(v)) return v.map(cleanGroup).filter(Boolean);
    return v?.capped === true && Array.isArray(v.groups) ? { capped: true, groups: v.groups.map(cleanGroup).filter(Boolean) } : undefined;
  }
  if (key.startsWith('album|')) return v === null ? null : cleanGroup(v) || undefined;
  if (key.startsWith('checked|')) {
    if (v === null) return null;
    const same = Number(v?.same);
    return MBID.test(String(v?.release)) && DATE.test(String(v?.date)) && Number.isSafeInteger(same) && same > 0 && same <= 500 ? { date: v.date, release: v.release, same } : undefined;
  }
  if (key.startsWith('genres|')) return Array.isArray(v) ? v.map((x) => text(x, 60)).filter(Boolean).slice(0, 5) : undefined;
  if (key.startsWith('namesakes|')) return Array.isArray(v) ? v.map(cleanNamesake).filter(Boolean).slice(0, 10) : undefined;
  return undefined;
}

// An album's answer as it's kept (see MBKept.answer): its release group as
// the app was given it, or null; undefined where it doesn't check out.
function cleanAnswer(v) {
  if (v === null) return null;
  const g = cleanGroup(v);
  if (!g) return undefined;
  return {
    ...g,
    ...(v.toCheck === true ? { toCheck: true } : {}),
    ...(v.checked === true ? { checked: true } : {}),
    ...(MBID.test(String(v.release)) ? { release: v.release } : {}),
  };
}

// How albums' answers are found (the rules in releases.js, and how
// MusicBrainz.album goes): those kept by another are let go as they're read
// back, to be looked up again.
const ANSWERS_VERSION = 1;

// The advanced features' answers, kept for a month: in a file
// (musicbrainz.json in the data folder, readable by the service only) when
// there's one to keep them in, so a restart doesn't ask MusicBrainz again.
// What MusicBrainz says of artists and release groups, and each album's
// answer as the app was given it, by its artist and title; nothing of who
// asked.
export class MBKept {
  constructor({ dir = null, log = null, now = () => Date.now(), writeDelayMs = MB_ADVANCED_LIMITS.writeMs, firstWriteMs = MB_ADVANCED_LIMITS.firstWriteMs } = {}) {
    this.file = dir ? join(dir, 'musicbrainz.json') : null;
    this.log = log;
    this.now = now;
    this.writeDelayMs = writeDelayMs;
    this.firstWriteMs = Math.min(firstWriteMs, writeDelayMs);
    this.wrote = 0; // when it was last written (Date.now()), 0 before the first time
    this.map = new Map(); // key -> { v, at, size }, oldest first
    this.bytes = 0;
    this.answers = new Map(); // ...and albums' answers (see answer)
    this.answerBytes = 0;
    this.timer = null;
    this.load();
  }

  // Each album's answer, as MusicBrainz.albums gave it to the app (by the
  // key it's waited on by: see MusicBrainz.wanted), kept apart from what
  // MusicBrainz said of artists and release groups, so a library of tens of
  // thousands looked through again is answered at once, from where it got
  // to, however much else was looked up since.
  // (The least lately read go first, where there are more than are kept.)
  answer(key) {
    const hit = this.answers.get(key);
    if (!hit) return undefined;
    if (this.now() - hit.at > MB_ADVANCED_LIMITS.keepMs) {
      this.dropAnswer(key);
      return undefined;
    }
    this.answers.delete(key);
    this.answers.set(key, hit);
    return hit.v;
  }

  setAnswer(key, v, at = this.now()) {
    if (v === undefined) return v;
    this.dropAnswer(key);
    const size = key.length + JSON.stringify(v ?? null).length;
    this.answers.set(key, { v, at, size });
    this.answerBytes += size;
    while (this.answers.size > MB_ADVANCED_LIMITS.answers || this.answerBytes > MB_ADVANCED_LIMITS.answerBytes) this.dropAnswer(this.answers.keys().next().value);
    this.changed();
    return v;
  }

  dropAnswer(key) {
    const hit = this.answers.get(key);
    if (!hit) return;
    this.answerBytes -= hit.size;
    this.answers.delete(key);
  }

  get(key) {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (this.now() - hit.at > MB_ADVANCED_LIMITS.keepMs) {
      this.drop(key);
      return undefined;
    }
    return hit.v;
  }

  set(key, v, at = this.now()) {
    this.drop(key);
    const size = key.length + JSON.stringify(v ?? null).length;
    this.map.set(key, { v, at, size });
    this.bytes += size;
    while (this.map.size > MB_ADVANCED_LIMITS.kept || this.bytes > MB_ADVANCED_LIMITS.bytes) this.drop(this.map.keys().next().value);
    this.changed();
    return v;
  }

  drop(key) {
    const hit = this.map.get(key);
    if (!hit) return;
    this.bytes -= hit.size;
    this.map.delete(key);
  }

  // (One that can't be read is kept aside, never written over: see
  // datafile.js.)
  load() {
    const read = (data) => {
      const rows = Array.isArray(data.kept) ? data.kept : [];
      const now = this.now();
      // (Kept before 0.34.0, when a search that found no one at all was
      // taken at its word: those artists found by a search that weren't,
      // and the namesakes of those that had none, are asked again.)
      const before = !(Number(data.version) >= 2);
      for (const row of rows) {
        if (!Array.isArray(row) || typeof row[0] !== 'string' || row[0].length > 500 || !Number.isFinite(row[2])) continue;
        if (row[2] > now || now - row[2] > MB_ADVANCED_LIMITS.keepMs) continue;
        if (before && ((row[0].startsWith('artist|') && row[1] === null) || (row[0].startsWith('namesakes|') && Array.isArray(row[1]) && !row[1].length))) continue;
        const v = cleanKept(row[0], row[1]);
        if (v !== undefined) this.set(row[0], v, row[2]);
      }
      // (Albums' answers, from 0.38.0: as they're found now only.)
      if (Number(data.answersVersion) === ANSWERS_VERSION && Array.isArray(data.answers)) {
        for (const row of data.answers) {
          if (!Array.isArray(row) || typeof row[0] !== 'string' || row[0].length > 1000 || !Number.isFinite(row[2])) continue;
          if (row[2] > now || now - row[2] > MB_ADVANCED_LIMITS.keepMs) continue;
          const v = cleanAnswer(row[1]);
          if (v !== undefined) this.setAnswer(row[0], v, row[2]);
        }
      }
      clearTimeout(this.timer);
      this.timer = null;
    };
    if (!readDataFile(this.file, read, { log: this.log, what: 'musicbrainz' })) this.file = null;
  }

  // Written soon after the first change since the service started, then at
  // most every writeDelayMs (a burst of changes, once), and as the service
  // is asked to stop (see index.js).
  changed() {
    if (!this.file || this.timer) return;
    // (Never longer than writeDelayMs, should the clock be put back.)
    const wait = this.wrote ? Math.min(this.writeDelayMs, Math.max(this.firstWriteMs, this.wrote + this.writeDelayMs - Date.now())) : this.firstWriteMs;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.write();
    }, wait);
    this.timer.unref?.();
  }

  write() {
    if (!this.file) return;
    // (Tried again no sooner than the next time it would be written.)
    this.wrote = Date.now();
    try {
      const rows = (map) => [...map].map(([k, { v, at }]) => [k, v, at]);
      writeDataFile(this.file, { version: 2, kept: rows(this.map), answersVersion: ANSWERS_VERSION, answers: rows(this.answers) }, { durable: false });
    } catch (err) {
      this.log?.error(`musicbrainz: couldn't save what was looked up to ${this.file}: ${err.message}`);
    }
  }

  flush() {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
    this.write();
  }
}
