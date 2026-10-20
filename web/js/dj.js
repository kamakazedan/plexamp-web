// Guest DJ: modes that add tracks to the queue as you listen, or (the
// "your queue" ones) put what's already queued in a better order.
//
// "Insert" DJs add one pick (or a few) after each of your own tracks, then
// carry on with your queue. "Continue" DJs keep lining up the next track
// themselves; your queue waits behind their picks and resumes when the DJ
// is turned off. "Reorder" DJs never add anything: after each track starts,
// they may move a track from later in your queue up to play next.
//
// No DJ picks a song played this session (or already queued), counting
// another version of it on another album as the same song: duplicates
// sound the same, so they're the "most similar" tracks there are.
import { app, on } from './state.js';
import { player } from './player.js';
import { normTrack, store } from './plex.js';
import { aiReady, djPick, describeAIError, norm } from './ai.js';
import { coreTitle } from './membership.js';
import { describeError } from './router.js';
import { toast } from './ui.js';

// Another of your devices plays, and this one follows it (devices.js).
const followingDevice = () => player.cast?.kind === 'device';

const server = () => app.server;
const section = () => app.source?.sectionKey;
const pickOne = (list, top = list.length) => list[Math.floor(Math.random() * Math.min(top, list.length))];

// A song, whatever album it's on: "Signal Fires (Extended Mix)" by Glass
// Harbour is Signal Fires by Glass Harbour.
export const songKey = (t) => `${norm(t.artist)}|${norm(coreTitle(t.title)) || norm(t.title)}`;

// Tracks a DJ may pick: not played this session or queued (by id, or as
// the same song), and one of each song.
function fresh(items, { avoid, songs }) {
  const seen = new Set();
  return items
    .filter((m) => m && (m.type === 'track' || m.partKey !== undefined))
    .map((m) => (m.partKey !== undefined ? m : normTrack(m)))
    .filter((t) => {
      const key = songKey(t);
      if (avoid.has(t.id) || songs.has(key) || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

// One of the first few (the closest), not by the artists just played if
// any of those few aren't: some variety, without straying from the sound.
function varied(list, artists, top) {
  const few = list.slice(0, top);
  const others = few.filter((t) => !artists.has(norm(t.artist)));
  return pickOne(others.length ? others : few);
}

async function nearest(cur, limit = 30, maxDistance = 0.3) {
  return (await server().nearest(cur.id, { limit, maxDistance }).catch(() => [])).filter((m) => m.type === 'track');
}

// Filter value for the current track's album genre, e.g. "7" from "genre=7".
async function albumTag(cur, field = 'Genre') {
  if (!cur.albumId) return null;
  const album = await server().albumMeta(cur.albumId).catch(() => null);
  const tag = album?.[field]?.[0];
  if (!tag) return null;
  return tag.id != null ? String(tag.id) : tag.filter ? String(tag.filter).split('=').pop() : null;
}

async function randomTracks(filters, size = 30) {
  return (await server().list(section(), 10, { sort: 'random', size, filters }).catch(() => ({ items: [] }))).items;
}

async function sameGenre(cur, size = 30) {
  const genre = await albumTag(cur);
  return genre ? randomTracks({ 'album.genre': genre }, size) : [];
}

const decadeOf = (year) => (year ? String(Math.floor(Number(year) / 10) * 10) : null);

// How many tracks DJ Bridge plays between two: as far apart as they sound
// (Plex's sonic distance: about 0.1 for close, 0.6 and more for far).
export function bridgeLength(distance) {
  if (!(distance >= 0)) return 4; // not near at all
  if (distance <= 0.2) return 1;
  if (distance <= 0.35) return 2;
  if (distance <= 0.5) return 3;
  return 4;
}

// `count` tracks from a path (its ends left out), spread evenly along it.
export function spread(middle, count) {
  if (count >= middle.length) return middle.slice();
  const out = [];
  for (let i = 1; i <= count; i++) out.push(middle[Math.round((i * (middle.length + 1)) / (count + 1)) - 1]);
  return [...new Set(out)];
}

// Each pick function returns a list of { track, note } (usually one).
const PICKERS = {
  async echo({ cur, ctx, dj }) {
    let list = fresh(await nearest(cur, 30), ctx);
    if (!list.length) {
      dj.noSonic();
      list = fresh(await sameGenre(cur), ctx);
    }
    return list.length ? [{ track: list[0] }] : [];
  },

  async steady({ cur, ctx, dj }) {
    let list = fresh(await nearest(cur, 40), ctx);
    if (!list.length) {
      dj.noSonic();
      list = fresh(await sameGenre(cur), ctx);
    }
    const t = varied(list, ctx.recentArtists, 8);
    return t ? [{ track: t }] : [];
  },

  // A short sonic journey from this track to your next one: the further
  // apart they sound, the more steps (one to four), spread along the path
  // Plex finds between them so each step is a small one.
  async bridge({ cur, next, ctx, dj }) {
    if (next && !next.dj) {
      const [path, near] = await Promise.all([
        server().computePath(section(), cur.id, next.id).catch(() => []),
        server().nearest(cur.id, { limit: 300, maxDistance: 0.6 }).catch(() => []),
      ]);
      const middle = fresh(path.slice(1, -1), ctx).filter((t) => t.id !== next.id);
      if (middle.length) {
        const apart = near.find((m) => String(m.ratingKey) === String(next.id))?.distance;
        return spread(middle, bridgeLength(apart == null ? NaN : Number(apart))).map((track) => ({ track }));
      }
    }
    return PICKERS.echo({ cur, ctx, dj });
  },

  async double({ cur, ctx }) {
    if (!cur.artistId) return [];
    let list = fresh(await server().popularTracks(section(), cur.artistId, 25).catch(() => []), ctx);
    if (list.length < 3) list = list.concat(fresh(await server().allLeaves(cur.artistId).catch(() => []), ctx));
    const t = pickOne(list, 10);
    return t ? [{ track: t }] : [];
  },

  async era({ cur, ctx, dj }) {
    const year = Number(cur.year) || 0;
    if (year) {
      const near = fresh(await nearest(cur, 50), ctx).filter((t) => t.year && Math.abs(Number(t.year) - year) <= 5);
      if (near.length) return [{ track: varied(near, ctx.recentArtists, 5) }];
    }
    const decade = decadeOf(year);
    if (!decade) return PICKERS.steady({ cur, ctx, dj });
    const genre = await albumTag(cur);
    let list = genre ? fresh(await randomTracks({ 'album.decade': decade, 'album.genre': genre }, 20), ctx) : [];
    if (!list.length) list = fresh(await randomTracks({ 'album.decade': decade }, 20), ctx);
    return list.length ? [{ track: list[0] }] : [];
  },

  async superfan({ cur, ctx }) {
    if (!cur.artistId) return [];
    const t = pickOne(fresh(await server().allLeaves(cur.artistId).catch(() => []), ctx));
    return t ? [{ track: t }] : [];
  },

  async ai({ cur, ctx, dj, signal }) {
    const decade = decadeOf(cur.year);
    const [near, genre, artist, era] = await Promise.all([
      nearest(cur, 15),
      sameGenre(cur, 12),
      cur.artistId ? server().popularTracks(section(), cur.artistId, 6).catch(() => []) : [],
      decade ? randomTracks({ 'album.decade': decade }, 8) : [],
    ]);
    const candidates = fresh([...near, ...genre, ...artist.slice(0, 3), ...era], ctx).slice(0, 30);
    if (!candidates.length) return [];
    try {
      const { track, intro } = await djPick({ current: cur, recent: dj.recent.slice(-7, -1).reverse(), candidates, signal });
      return [{ track, note: intro }];
    } catch (err) {
      if (err.code === 'aborted') throw err;
      dj.warnOnce('ai-failed', `AI DJ couldn’t use your model, so it picked a similar track. ${describeAIError(err)}`);
      return [{ track: candidates[0] }];
    }
  },
};

// ---------- the "your queue" DJs ----------

const WINDOW = 40; // how far ahead in the queue they look
const FLOW = 0.2; // sonic distance at which one track already flows into another

// How far apart two tracks sound, from what Plex said about the first
// (`near`: track id -> distance); a guess from who and when if it didn't
// (not close enough to be listed, or no sonic analysis).
function apart(near, a, b) {
  const d = near.get(String(b.id));
  if (d != null) return d;
  if (a.artistId && a.artistId === b.artistId) return 0.4;
  const ya = Number(a.year);
  const yb = Number(b.year);
  return ya && yb ? 0.65 + Math.min(Math.abs(ya - yb), 30) / 100 : 0.8;
}

async function distancesFrom(t) {
  const list = await server().nearest(t.id, { limit: 300, maxDistance: 0.6 }).catch(() => []);
  return new Map(list.filter((m) => m.type === 'track' && m.distance != null).map((m) => [String(m.ratingKey), Number(m.distance)]));
}

// What's coming up, as [{ t, at }] (its place in the queue), and which of
// them may be moved up: not another version of the playing song or of one
// just played (it would sound the same), nor a DJ's pick.
function upcoming(cur, ctx) {
  const ahead = player.queue.slice(player.index + 1, player.index + 1 + WINDOW).map((t, i) => ({ t, at: player.index + 1 + i }));
  const here = songKey(cur);
  const movable = ahead.filter(({ t }) => t && !t.dj && songKey(t) !== here && !ctx.recentSongs.has(songKey(t)));
  return { ahead, movable };
}

const ARRANGERS = {
  // The queued track that sounds most like this one plays next.
  async 'queue-echo'({ cur, ctx, dj }) {
    const { movable } = upcoming(cur, ctx);
    if (!movable.length) return null;
    const near = await distancesFrom(cur);
    if (!near.size) dj.noSonic(true);
    const best = movable.reduce((a, b) => (apart(near, cur, b.t) < apart(near, cur, a.t) ? b : a));
    return best.at === player.index + 1 ? null : { from: best.at, note: 'it sounds most like the last track' };
  },

  // If the next track sounds far from this one, a queued track that sits
  // between them plays first.
  async 'queue-bridge'({ cur, ctx, dj }) {
    const { ahead, movable } = upcoming(cur, ctx);
    const next = ahead[0]?.t;
    const between = movable.filter((x) => x.t !== next);
    if (!next || !between.length) return null;
    const near = await distancesFrom(cur);
    if (!near.size) dj.noSonic(true);
    const gap = apart(near, cur, next);
    if (gap <= FLOW) return null;
    const fromNext = await distancesFrom(next);
    const step = (x) => Math.max(apart(near, cur, x.t), apart(fromNext, next, x.t));
    const best = between.reduce((a, b) => (step(b) < step(a) ? b : a));
    return step(best) < gap - 0.05 ? { from: best.at, note: `it bridges the gap to “${next.title}”` } : null;
  },
};

export const DJS = [
  { id: 'bridge', kind: 'insert', name: 'DJ Bridge', description: 'Plays a short sonic journey between each pair of tracks: one track when they sound alike, up to four when they’re far apart.' },
  { id: 'echo', kind: 'insert', name: 'DJ Echo', description: 'Follows each track with the one that sounds most like it.' },
  { id: 'steady', kind: 'continue', name: 'DJ Steady', description: 'Keeps the mood going with tracks that sound like the one playing.' },
  { id: 'double', kind: 'insert', name: 'DJ Double', description: 'Follows each track with another by the same artist.' },
  { id: 'era', kind: 'continue', name: 'DJ Era', description: 'Keeps the mood going with tracks from the same era.' },
  { id: 'superfan', kind: 'continue', name: 'DJ Superfan', description: 'Keeps queueing tracks by the same artist.' },
  { id: 'ai', kind: 'continue', name: 'AI DJ', description: 'Your AI model picks each next track from your library and says why.', needsAI: true },
  // Only what's queued:
  { id: 'queue-echo', kind: 'reorder', name: 'Queue Echo', description: 'Plays next whichever track in your queue sounds most like the one playing.' },
  { id: 'queue-bridge', kind: 'reorder', name: 'Queue Bridge', description: 'When your next track sounds far from this one, first plays one from later in your queue that sits between them.' },
];

export const djName = (id) => DJS.find((d) => d.id === id)?.name || 'Guest DJ';

class GuestDJ extends EventTarget {
  constructor() {
    super();
    this.id = store.get('guestDj') || null;
    if (!DJS.some((d) => d.id === this.id)) this.id = null;
    this.token = 0;
    this.busy = false;
    this.recent = []; // recently played tracks, for the AI DJ's context
    this.songs = []; // the songs played this session (see songKey), oldest first
    this.arranged = null; // the queue entry a "your queue" DJ last arranged after
    this.warned = new Set();
    this.ctrl = null;

    player.addEventListener('track', () => {
      const t = player.current;
      if (t && this.recent[this.recent.length - 1]?.id !== t.id) {
        this.recent.push(t);
        if (this.recent.length > 12) this.recent.shift();
        this.songs.push(songKey(t));
        if (this.songs.length > 300) this.songs.shift();
      }
      this.schedule();
    });
    player.addEventListener('state', () => player.state === 'playing' && this.schedule());
    on('signout', () => this.set(null, { quiet: true }));
  }

  get active() {
    return DJS.find((d) => d.id === this.id) || null;
  }

  set(id, { quiet = false } = {}) {
    this.id = id || null;
    store.set('guestDj', this.id);
    this.cancel();
    this.arranged = null;
    // A pick lined up by a different DJ makes way for the new one.
    const next = player.queue[player.index + 1];
    if (next?.dj && next.dj !== this.id && !player.remote && !followingDevice()) player.remove(player.index + 1);
    this.emit('change');
    if (!quiet && this.id) this.schedule(0);
  }

  cancel() {
    this.token += 1;
    this.ctrl?.abort();
    this.ctrl = null;
    clearTimeout(this.timer);
    if (this.busy) {
      this.busy = false;
      this.emit('busy');
    }
  }

  schedule(delay = 800) {
    clearTimeout(this.timer);
    if (this.active) this.timer = setTimeout(() => this.check(), delay);
  }

  // What DJs leave alone: played this session or queued, by id and by song.
  context() {
    const queued = player.queue;
    const recentSongs = new Set(this.songs.slice(-10));
    return {
      avoid: new Set([...player.history.slice(-300), ...queued.map((t) => t.id)]),
      songs: new Set([...this.songs, ...queued.map(songKey)]),
      recentSongs,
      recentArtists: new Set(this.recent.slice(-2).map((t) => norm(t.artist))),
    };
  }

  async check() {
    const dj = this.active;
    const cur = player.current;
    // No DJ in a Play Together session: the queue is everyone's. Nor while
    // another of your devices plays: the queue is that one's, and so is its DJ.
    if (!dj || !cur || !app.server || player.remote || followingDevice() || player.state === 'idle' || player.repeat === 'one') return;
    if (dj.kind === 'reorder') return this.arrange(dj, cur);
    const next = player.queue[player.index + 1];
    if (next?.dj) return; // a pick is already lined up
    if (dj.kind === 'insert' && cur.dj) return; // insert DJs only follow your own tracks
    if (dj.needsAI && !aiReady()) {
      // AI turned off (or not available here): so is the AI DJ.
      this.set(null, { quiet: true });
      toast('The AI DJ is off, as AI features are.');
      return;
    }

    const token = ++this.token;
    this.ctrl = new AbortController();
    this.busy = true;
    this.emit('busy');
    try {
      const picks = await PICKERS[dj.id]({ cur, next, ctx: this.context(), dj: this, signal: this.ctrl.signal });
      if (token !== this.token || player.current !== cur) return;
      const items = picks.filter((p) => p?.track).map((p) => ({ ...p.track, dj: dj.id, djNote: p.note || '' }));
      if (items.length) player.playNext(items);
      else this.warnOnce(`empty-${dj.id}`, `${dj.name} couldn’t find anything new to add after this track.`);
    } catch (err) {
      if (token === this.token && err?.code !== 'aborted') this.warnOnce(`error-${dj.id}`, `${dj.name} ran into a problem. ${describeError(err)}`);
    } finally {
      if (token === this.token) {
        this.busy = false;
        this.ctrl = null;
        this.emit('busy');
      }
    }
  }

  // The "your queue" DJs: once for each track, maybe move one up.
  async arrange(dj, cur) {
    if (this.arranged === cur.qid) return;
    this.arranged = cur.qid;
    const token = ++this.token;
    this.busy = true;
    this.emit('busy');
    try {
      const move = await ARRANGERS[dj.id]({ cur, ctx: this.context(), dj: this });
      if (token !== this.token || player.current !== cur || !move) return;
      const t = player.queue[move.from];
      if (!t) return;
      t.djMoved = dj.id;
      t.djNote = move.note;
      player.moveToTop(move.from);
    } catch (err) {
      if (token === this.token) this.warnOnce(`error-${dj.id}`, `${dj.name} ran into a problem. ${describeError(err)}`);
    } finally {
      if (token === this.token) {
        this.busy = false;
        this.emit('busy');
      }
    }
  }

  noSonic(queue = false) {
    if (queue) {
      this.warnOnce('no-sonic-queue', 'Plex has no sonic analysis for these tracks, so the DJ is going by artist and year. Turn on sonic analysis for this library in Plex for better transitions.');
    } else {
      this.warnOnce('no-sonic', 'No sonically similar tracks were found, so the DJ is matching on genre. Turn on sonic analysis for this library in Plex for better picks.');
    }
  }

  warnOnce(key, message) {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    toast(message, { timeout: 6000 });
  }

  emit(type) {
    this.dispatchEvent(new Event(type));
  }
}

export const guestDJ = new GuestDJ();
