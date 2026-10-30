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
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { norm } from './missinglist.js';
import { albumKey, matchGroup } from './releases.js';

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
  constructor({ base = 'https://musicbrainz.org', version = '', fetchImpl = globalThis.fetch, gapMs, log, now = () => Date.now() } = {}) {
    this.base = String(base).replace(/\/+$/, '');
    this.fetch = fetchImpl;
    this.public = isPublic(this.base);
    this.gapMs = gapMs ?? (this.public ? MB_LIMITS.gapMs : 0);
    this.agent = `plexamp-web${/^[0-9][0-9.]*$/.test(version) ? `/${version}` : ''} ( https://github.com/kamakazedan/plexamp-web )`;
    this.log = log;
    this.now = now;
    this.kept = new Map(); // key -> { answer, at }
    this.queue = Promise.resolve();
    this.last = 0;
    this.waiting = 0; // requests someone's waiting on (the background waits for them)
    // The advanced features (see advanced()): what's kept of them, and
    // what's waiting to be looked up in the background.
    this.adv = null;
    this.todo = new Map(); // key -> { artist, title, genres, year, who, tries }
    this.queuedBy = new Map(); // who -> how many of theirs are waiting
    this.working = false;
    this.downUntil = 0; // MusicBrainz didn't answer: the features don't ask it again until then
  }

  // One request to MusicBrainz, after the one before it by gapMs (skipped
  // if `signal` says whoever wanted it has gone). In the background
  // (`background`): once no one's waiting on one.
  ask(path, params, signal, { background = false } = {}) {
    if (background) {
      return (async () => {
        while (this.waiting > 0) {
          if (signal?.aborted) throw new Gone();
          await new Promise((r) => setTimeout(r, 200));
        }
        return this.asked(path, params, signal);
      })();
    }
    this.waiting += 1;
    return this.asked(path, params, signal).finally(() => {
      this.waiting -= 1;
    });
  }

  asked(path, params, signal) {
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
        if (res.status >= 500) this.unwell();
        if (this.public && res.status === 503) throw new MusicBrainzError(503, 'MusicBrainz is busy right now. Try again in a minute.');
        // (A server of your own needs its search indexes for these.)
        if (!res.ok) throw Object.assign(new MusicBrainzError(502, this.public ? `MusicBrainz answered ${res.status}.` : `The player’s MusicBrainz server answered ${res.status}. Searching it needs its search indexes.`), { answered: res.status });
        return await res.json();
      } catch (err) {
        if (err instanceof MusicBrainzError) throw err;
        if (signal?.aborted) throw new Gone();
        this.unwell();
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
  unwell() {
    this.downUntil = Date.now() + MB_ADVANCED_LIMITS.downMs;
  }

  down() {
    return Date.now() < this.downUntil;
  }

  resting() {
    if (this.down()) throw new MusicBrainzError(503, 'MusicBrainz isn’t answering this player just now. Try again in a minute.');
  }

  // An artist, by name (or one of their other names), or by their
  // MusicBrainz id where Plex has it (`id`): { id, name, aliases, genres },
  // or null where MusicBrainz has no such artist (or it's one of
  // MusicBrainz's special-purpose ones: Various Artists, [unknown]...).
  async artistInfo(name, { id = null, signal, background = false } = {}) {
    const want = norm(name);
    if (!this.adv || (!want && !MBID.test(String(id)))) return null;
    const byId = MBID.test(String(id));
    const key = byId ? `artistid|${id}` : `artist|${want}`;
    const kept = this.had(key);
    // (An id MusicBrainz doesn't know, out of date in Plex: by name, then.
    // Not a special-purpose artist's, whose name a real artist may have.)
    if (kept === null && byId && want && !SPECIAL_ARTISTS.has(id)) return this.artistInfo(name, { signal, background });
    if (kept !== undefined) return kept;
    // (Not Various Artists, by any name: on MusicBrainz, theirs are
    // everyone's compilations, far too many to look through for one.)
    if (byId ? SPECIAL_ARTISTS.has(id) : VARIOUS.has(want)) return this.adv.set(key, null);
    this.resting();
    const opts = { background };
    let hit = byId ? { id } : null;
    if (!byId) {
      const found = await this.ask('/ws/2/artist', { query: `artist:${phrase(name)} OR alias:${phrase(name)}`, limit: '10' }, signal, opts);
      hit = pickArtist(found.artists, want);
      if (!hit) return this.adv.set(key, null);
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
    return this.adv.set(key, cleanArtist({ id: hit.id, name: full.name || hit.name, aliases: names, genres: topGenres(full.genres) }));
  }

  // An artist's release groups, by their MusicBrainz id: [{ id, title,
  // primary, secondary, date }] (those they're credited with, up to 500:
  // the list's `capped` where they have more, so it can't be told from it
  // that they haven't one).
  async releaseGroups(artistId, { signal, background = false } = {}) {
    if (!this.adv || !MBID.test(String(artistId))) return [];
    const key = `groups|${artistId}`;
    const kept = this.had(key);
    if (kept !== undefined) return groupList(kept);
    this.resting();
    const out = [];
    let capped = false;
    for (let page = 0; page < MB_ADVANCED_LIMITS.groupPages; page += 1) {
      const data = await this.ask('/ws/2/release-group', { artist: artistId, limit: '100', offset: String(page * 100) }, signal, { background });
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
  // say). For telling an artist's albums from those of another of the same
  // name, which Plex can have as one artist (see the app's mb.js).
  async namesakes(name, { but = null, signal, background = false } = {}) {
    const want = norm(name);
    if (!this.adv || !want || VARIOUS.has(want)) return [];
    const key = `namesakes|${want}`;
    let list = this.had(key);
    if (list === undefined) {
      this.resting();
      const found = await this.ask('/ws/2/artist', { query: `artist:${phrase(name)} OR sortname:${phrase(name)}`, limit: '25' }, signal, { background });
      list = this.adv.set(key, sameNamed(found.artists, want));
    }
    const out = [];
    for (const a of (list || []).filter((x) => x.id !== but).slice(0, MB_ADVANCED_LIMITS.namesakes)) {
      const groups = await this.releaseGroups(a.id, { signal, background });
      out.push({ ...a, groups, capped: !!groups.capped });
    }
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

  // One of an artist's albums, by its title (and the year Plex has for it,
  // to tell albums of one title apart: see releases.js matchGroup): its
  // release group (with `genres`, and its genres), or null where
  // MusicBrainz has no such artist, or no such album of theirs (or which
  // it is can't be told).
  async album(artist, title, { genres = false, year = null, signal, background = false } = {}) {
    const info = await this.artistInfo(artist, { signal, background });
    if (!info) return null;
    const g = matchGroup(await this.releaseGroups(info.id, { signal, background }), title, null, year);
    if (!g) return null;
    return genres ? { ...g, genres: await this.groupGenres(g.id, { signal, background }) } : g;
  }

  // ...as far as it's known now, without asking: undefined where it isn't.
  knownAlbum(artist, title, { genres = false, year = null } = {}) {
    const who = norm(artist);
    if (!this.adv || !who || !albumKey(title)) return null;
    if (VARIOUS.has(who)) return null;
    const info = this.had(`artist|${who}`);
    if (!info) return info;
    const groups = this.had(`groups|${info.id}`);
    if (groups === undefined) return undefined;
    const g = matchGroup(groups, title, null, year);
    if (!g || !genres) return g;
    const got = this.had(`genres|${g.id}`);
    return got === undefined ? undefined : { ...g, genres: got };
  }

  // Albums to look up in the background (an owner looking through their
  // library, say): one at a time, once no one's waiting on MusicBrainz for
  // anything else. At most MB_ADVANCED_LIMITS.queued waiting, and
  // queuedEach of any one account's (`who`): false if there's no room for
  // this one now (nor while MusicBrainz isn't answering).
  later(artist, title, { genres = false, year = null, who = '' } = {}) {
    if (!this.adv || !norm(artist) || !albumKey(title) || this.down()) return false;
    const key = `${norm(artist)}|${albumKey(title)}|${Number(year) || ''}|${genres ? 1 : 0}`;
    if (this.todo.has(key)) return true;
    if (this.todo.size >= MB_ADVANCED_LIMITS.queued || (this.queuedBy.get(who) || 0) >= MB_ADVANCED_LIMITS.queuedEach) return false;
    this.todo.set(key, { artist: String(artist), title: String(title), genres: !!genres, year: Number(year) || null, who, tries: 0 });
    this.queuedBy.set(who, (this.queuedBy.get(who) || 0) + 1);
    this.work();
    return true;
  }

  done(key) {
    const it = this.todo.get(key);
    if (!it) return;
    this.todo.delete(key);
    const left = (this.queuedBy.get(it.who) || 1) - 1;
    if (left > 0) this.queuedBy.set(it.who, left);
    else this.queuedBy.delete(it.who);
  }

  async work() {
    if (this.working) return;
    this.working = true;
    try {
      while (this.todo.size) {
        // (MusicBrainz not answering: a rest until it's tried again.)
        while (this.down()) await new Promise((r) => setTimeout(r, Math.min(1000, this.downUntil - Date.now() + 10)));
        const [key, it] = this.todo.entries().next().value;
        try {
          await this.album(it.artist, it.title, { genres: it.genres, year: it.year, background: true });
          this.done(key);
        } catch (err) {
          // MusicBrainz busy or out of reach: a rest, and again (three
          // times at most, each to the back of the queue).
          this.todo.delete(key);
          it.tries += 1;
          if (it.tries < 3) this.todo.set(key, it);
          else {
            this.todo.set(key, it);
            this.done(key);
            this.log?.debug(`musicbrainz: gave up on "${it.title}" by ${it.artist}: ${err.message}`);
          }
          await new Promise((r) => setTimeout(r, MB_ADVANCED_LIMITS.restMs));
        }
      }
    } finally {
      this.working = false;
    }
  }

  // For the app: each album's release group as far as it's known ('pending'
  // where it isn't yet: looked up in the background, for `who`), waiting
  // up to `waitMs` for those. (Items: { artist, title, year }.)
  async albums(items, { genres = false, waitMs = 0, signal, who = '' } = {}) {
    const answer = () =>
      items.map((it) => {
        const v = this.knownAlbum(it.artist, it.title, { genres, year: it.year });
        return v === undefined ? 'pending' : v;
      });
    let out = answer();
    out.forEach((v, i) => v === 'pending' && this.later(items[i].artist, items[i].title, { genres, year: items[i].year, who }));
    const until = Date.now() + Math.max(0, Math.min(Number(waitMs) || 0, MB_ADVANCED_LIMITS.waitMs));
    while (out.includes('pending') && Date.now() < until && !signal?.aborted) {
      await new Promise((r) => setTimeout(r, 200));
      out = answer();
    }
    return out;
  }
}

// ---------- the advanced features' answers, and how they're kept ----------

export const MB_ADVANCED_LIMITS = {
  keepMs: 30 * 86400000, // what's kept: a month
  kept: 20000, // answers kept
  bytes: 30 * 1024 * 1024, // ...in all, as JSON
  writeMs: 5 * 60000, // written at most this often (and as the service stops)
  firstWriteMs: 10000, // ...the first time since it started, this soon after the first answer
  queued: 5000, // albums waiting to be looked up in the background
  queuedEach: 2000, // ...of any one account's
  downMs: 60000, // after MusicBrainz doesn't answer, nothing new asked of it for this long
  perRequest: 200, // albums asked about in one request from the app
  waitMs: 10000, // how long a request from the app may wait for answers
  groupPages: 5, // of an artist's release groups, 100 to a page
  namesakes: 3, // other artists of an artist's name, looked at for their page
  artistMs: 30000, // how long one artist's lookups may take for the app
  restMs: 30000, // after MusicBrainz doesn't answer, in the background
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
const VARIOUS = new Set([
  'various artists',
  'various',
  'va',
  'v a',
  'various artist',
  'verschiedene interpreten',
  'artistes divers',
  'artistes varies',
  'varios artistas',
  'artisti vari',
  'diverse artiesten',
  'diversos artistas',
  'unknown artist',
  'unknown',
  'anonymous',
  'traditional',
  'trad',
  'オムニバス',
  '群星',
  'різні виконавці',
  'разные исполнители',
]);
const DATE = /^\d{4}(-\d{2}(-\d{2})?)?$/;
const text = (v, n) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, n) : '');

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

// A release group as it's kept, or null.
function cleanGroup(g) {
  if (!g || !MBID.test(String(g.id))) return null;
  const title = text(g.title, 300);
  if (!title) return null;
  const secondary = (Array.isArray(g['secondary-types'] ?? g.secondary) ? g['secondary-types'] ?? g.secondary : []).map((x) => text(x, 40)).filter(Boolean).slice(0, 8);
  const date = text(g['first-release-date'] ?? g.date, 10);
  return { id: g.id, title, primary: text(g['primary-type'] ?? g.primary, 40), secondary, date: DATE.test(date) ? date : '' };
}

function cleanArtist(a) {
  if (!a || !MBID.test(String(a.id))) return null;
  const list = (v, n, each) => [...new Set((Array.isArray(v) ? v : []).map((x) => text(x, each)).filter(Boolean))].slice(0, n);
  return { id: a.id, name: text(a.name, 200), aliases: list(a.aliases, 40, 200), genres: list(a.genres, 5, 60) };
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

// A kept answer, checked as it's read back (undefined: it doesn't check out).
// A list of release groups as it's kept: as it is, or (more than were
// asked for) { capped: true, groups }. As releaseGroups gives it: the list,
// `capped` where it is.
function groupList(v) {
  if (Array.isArray(v)) return v;
  const list = Array.isArray(v?.groups) ? v.groups.slice() : [];
  if (v?.capped === true) list.capped = true;
  return list;
}

function cleanKept(key, v) {
  if (key.startsWith('artist|') || key.startsWith('artistid|')) return v === null ? null : cleanArtist(v) || undefined;
  if (key.startsWith('groups|')) {
    if (Array.isArray(v)) return v.map(cleanGroup).filter(Boolean);
    return v?.capped === true && Array.isArray(v.groups) ? { capped: true, groups: v.groups.map(cleanGroup).filter(Boolean) } : undefined;
  }
  if (key.startsWith('genres|')) return Array.isArray(v) ? v.map((x) => text(x, 60)).filter(Boolean).slice(0, 5) : undefined;
  if (key.startsWith('namesakes|')) return Array.isArray(v) ? v.map(cleanNamesake).filter(Boolean).slice(0, 10) : undefined;
  return undefined;
}

// The advanced features' answers, kept for a month: in a file
// (musicbrainz.json in the data folder, readable by the service only) when
// there's one to keep them in, so a restart doesn't ask MusicBrainz again.
// What MusicBrainz says of artists and release groups, nothing of who asked.
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
    this.timer = null;
    this.load();
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

  load() {
    if (!this.file || !existsSync(this.file)) return;
    try {
      const data = JSON.parse(readFileSync(this.file, 'utf8'));
      const rows = Array.isArray(data?.kept) ? data.kept : [];
      const now = this.now();
      for (const row of rows) {
        if (!Array.isArray(row) || typeof row[0] !== 'string' || row[0].length > 500 || !Number.isFinite(row[2])) continue;
        if (row[2] > now || now - row[2] > MB_ADVANCED_LIMITS.keepMs) continue;
        const v = cleanKept(row[0], row[1]);
        if (v !== undefined) this.set(row[0], v, row[2]);
      }
      clearTimeout(this.timer);
      this.timer = null;
    } catch (err) {
      this.log?.warn(`musicbrainz: couldn't read ${this.file} (${err.message}); starting without what was kept`);
    }
  }

  // Written soon after the first change since the service started, then at
  // most every writeDelayMs (a burst of changes, once). In a container the
  // service stops without being told (nginx is PID 1), so what's waiting to
  // be written then is lost; a stop systemd asks for is written first.
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
    const tmp = `${this.file}.tmp`;
    // (Tried again no sooner than the next time it would be written.)
    this.wrote = Date.now();
    try {
      writeFileSync(tmp, JSON.stringify({ version: 1, kept: [...this.map].map(([k, { v, at }]) => [k, v, at]) }), { mode: 0o600 });
      renameSync(tmp, this.file);
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
