// Guest DJ: modes that add tracks to the queue as you listen, or (the
// "your queue" ones) put what's already queued in a better order.
//
// "Insert" DJs add a pick after each of your own tracks, then carry on with
// your queue. "Continue" DJs keep lining up the next track themselves; your
// queue waits behind their picks and resumes when the DJ is turned off.
// "Reorder" DJs never add anything: after each track starts, they may move
// a track from later in your queue up to play next. Turning a DJ off (or
// choosing another) takes its picks out of what's to come, and puts what it
// moved back where it was.
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

// A genre tag's filter value, e.g. "7" from "genre=7".
const tagFilter = (tag) => (!tag ? null : tag.id != null ? String(tag.id) : tag.filter ? String(tag.filter).split('=').pop() : null);

// Filter value for the current track's album genre.
async function albumTag(cur, field = 'Genre') {
  if (!cur.albumId) return null;
  const album = await server().albumMeta(cur.albumId).catch(() => null);
  return tagFilter(album?.[field]?.[0]);
}

async function randomTracks(filters, size = 30) {
  return (await server().list(section(), 10, { sort: 'random', size, filters }).catch(() => ({ items: [] }))).items;
}

async function sameGenre(cur, size = 30) {
  const genre = await albumTag(cur);
  return genre ? randomTracks({ 'album.genre': genre }, size) : [];
}

const decadeOf = (year) => (year ? String(Math.floor(Number(year) / 10) * 10) : null);

// An artist's best-known tracks (Plex's popular tracks), kept a while.
const popularOf = (artistId, n = 6) =>
  server()
    .memo(`popular:${section()}:${artistId}:${n}`, () => server().popularTracks(section(), artistId, n), 10 * 60000)
    .catch(() => []);

// ---------- how alike two tracks are ----------
// Plex says how far apart two tracks sound only for a track's nearest
// neighbours: in a big library, a hundred or so of many thousands, so for
// most pairs in a queue it says nothing. Then it's what Plex knows about
// their albums and artists: genres and styles, moods, years, and who's
// similar to whom. 0: nothing alike; 1: the same.

const tagSet = (m, fields) => new Set(fields.flatMap((f) => (Array.isArray(m?.[f]) ? m[f] : []).map((x) => norm(x?.tag)).filter(Boolean)));

// What Plex knows about the tracks' albums and artists, by id.
async function aboutTracks(tracks) {
  const albumIds = [...new Set(tracks.map((t) => t?.albumId).filter(Boolean))];
  const artistIds = [...new Set(tracks.map((t) => t?.artistId).filter(Boolean))];
  const [albums, artists] = await Promise.all([server().albumsMeta(albumIds).catch(() => []), server().artistsMeta(artistIds).catch(() => [])]);
  const info = { albums: new Map(), artists: new Map() };
  albums.forEach((m, i) => m && info.albums.set(albumIds[i], { tags: tagSet(m, ['Genre', 'Style']), moods: tagSet(m, ['Mood']) }));
  artists.forEach((m, i) => m && info.artists.set(artistIds[i], { tags: tagSet(m, ['Genre', 'Style']), similar: tagSet(m, ['Similar']) }));
  return info;
}

const overlap = (a, b) => {
  if (!a?.size || !b?.size) return null;
  let n = 0;
  for (const v of a) if (b.has(v)) n++;
  return n / (a.size + b.size - n);
};

// `near`: Plex's sonic distances from `a` (see distancesFrom). Where Plex
// gives one, that's the likeness. Where it doesn't, the track is further
// than the furthest it gave, so its likeness from what's known about it is
// no more than that one's.
export function likeness(a, b, info, near) {
  const d = near?.map.get(String(b.id));
  if (d != null) return Math.max(0, 1 - d);
  const A = info.albums.get(a.albumId);
  const B = info.albums.get(b.albumId);
  const P = info.artists.get(a.artistId);
  const Q = info.artists.get(b.artistId);
  const tags = (album, artist) => (album?.tags?.size ? album.tags : artist?.tags);
  const who = norm(a.artist);
  const same = !!who && who === norm(b.artist);
  const related = same ? 1 : (P?.similar.has(norm(b.artist)) || Q?.similar.has(who)) ? 0.7 : 0;
  const years = a.year && b.year ? Math.max(0, 1 - Math.abs(Number(a.year) - Number(b.year)) / 20) : null;
  const parts = [
    [overlap(tags(A, P), tags(B, Q)), 0.5],
    [overlap(A?.moods, B?.moods), 0.15],
    [years, 0.2],
    [related, 0.15],
  ].filter(([v]) => v != null);
  const weight = parts.reduce((n, [, w]) => n + w, 0);
  const known = weight ? parts.reduce((n, [v, w]) => n + v * w, 0) / weight : 0;
  return Math.min(known, near?.ceiling ?? 1);
}

// Plex's sonic distances from a track to its nearest neighbours: { map
// (track id -> distance), ceiling (the likeness of the furthest; 1 when
// there are none: no sonic analysis) }.
async function distancesFrom(t) {
  const list = await server().nearest(t.id, { limit: 100, maxDistance: 1 }).catch(() => []);
  const map = new Map(list.filter((m) => m.type === 'track' && m.distance != null).map((m) => [String(m.ratingKey), Number(m.distance)]));
  return { map, ceiling: map.size ? Math.max(0, 1 - Math.max(...map.values())) : 1 };
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

  // One track between this one and your next, that sits between them in
  // sound: the middle of the path Plex finds from one to the other (or the
  // nearest to the middle not played yet).
  async bridge({ cur, next, ctx, dj }) {
    if (next && !next.dj) {
      const path = (await server().computePath(section(), cur.id, next.id).catch(() => [])).filter(
        (m) => String(m.ratingKey) !== String(cur.id) && String(m.ratingKey) !== String(next.id),
      );
      const ok = new Set(fresh(path, ctx).map((t) => t.id));
      const mid = (path.length - 1) / 2;
      const best = path
        .map((m, i) => ({ m, off: Math.abs(i - mid) }))
        .filter(({ m }) => ok.has(String(m.ratingKey)))
        .sort((a, b) => a.off - b.off)[0];
      if (best) return [{ track: normTrack(best.m) }];
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

  // The AI DJ: songs by other artists than the last few, their best-known
  // ones (Plex's popular tracks) where it has them, in the genre of the
  // track that was playing when it started. Your model picks one, and
  // introduces it.
  async ai({ cur, ctx, dj, signal }) {
    const anchor = await dj.anchorFor(cur);
    const { candidates, popular } = await aiCandidates(cur, ctx, anchor);
    if (!candidates.length) return [];
    try {
      const { track, intro } = await djPick({ current: cur, recent: dj.recent.slice(-7, -1).reverse(), candidates, popular, genre: anchor.label, signal });
      return [{ track, note: intro }];
    } catch (err) {
      if (err.code === 'aborted') throw err;
      dj.warnOnce('ai-failed', `AI DJ couldn’t use your model, so it picked a track itself. ${describeAIError(err)}`);
      return [{ track: candidates[0] }];
    }
  },
};

// The AI DJ's choice: artists who sound like what's playing, who Plex says
// are like this artist, and others in the station's genre, but not those
// just played; a few of each one's popular tracks.
async function aiCandidates(cur, ctx, anchor) {
  const avoid = new Set([norm(cur.artist), norm(cur.albumArtist), ...ctx.lastArtists].filter(Boolean));
  const [near, similar, inGenre] = await Promise.all([
    nearest(cur, 40, 0.5),
    cur.artistId ? server().nearest(cur.artistId, { limit: 12, maxDistance: 0.6 }).catch(() => []) : [],
    anchor.filter ? server().list(section(), 8, { sort: 'random', size: 12, filters: { genre: anchor.filter } }).then((r) => r.items).catch(() => []) : [],
  ]);
  const listed = new Set();
  const artistsOf = (items) =>
    items
      .map((m) => ({ id: String(m.ratingKey && m.type === 'artist' ? m.ratingKey : m.grandparentRatingKey || ''), name: m.type === 'artist' ? m.title : m.grandparentTitle }))
      .filter((a) => a.id && a.name && !avoid.has(norm(a.name)) && norm(a.name) !== 'various artists' && !listed.has(a.id) && listed.add(a.id));
  const lists = [artistsOf(near), artistsOf(similar.filter((m) => m.type === 'artist')), artistsOf(inGenre)];
  // Taken in turn, so each kind has its say.
  let artists = [];
  for (let i = 0; artists.length < 10 && lists.some((l) => l.length > i); i++) for (const l of lists) if (l[i] && artists.length < 10) artists.push(l[i]);
  // Those in the genre first, and only those where there are enough.
  if (anchor.tags.size && artists.length) {
    const meta = await server().artistsMeta(artists.map((a) => a.id)).catch(() => []);
    const fit = (a, i) => !meta[i] || overlap(anchor.tags, tagSet(meta[i], ['Genre', 'Style'])) > 0;
    const fits = artists.filter(fit);
    artists = fits.length >= 3 ? fits : [...fits, ...artists.filter((a, i) => !fit(a, i))];
  }
  const tops = await Promise.all(artists.slice(0, 8).map((a) => popularOf(a.id)));
  const per = tops.map((items) => fresh(items, ctx).slice(0, 3));
  const candidates = [];
  for (let i = 0; i < 3; i++) for (const l of per) if (l[i] && candidates.length < 24) candidates.push(l[i]);
  const popular = new Set(candidates.map((t) => t.id));
  // Hardly any popular tracks known: other tracks by artists not just
  // played, so there's still a choice.
  if (candidates.length < 6) {
    const more = fresh([...near, ...(await sameGenre(cur, 12))], ctx).filter((t) => !avoid.has(norm(t.artist)) && !popular.has(t.id));
    candidates.push(...more.slice(0, 12 - candidates.length));
  }
  return { candidates, popular };
}

// ---------- the "your queue" DJs ----------

const WINDOW = 40; // how far ahead in the queue they look
const FLOW = 0.6; // likeness at which one track already flows into the next
const BETTER = 0.1; // how much smoother a bridge must make it

// What's coming up, as [{ t, at }] (its place in the queue), and which of
// them may be moved up: not another version of the playing song or of one
// just played (it would sound the same), nor a DJ's pick.
function upcoming(cur, ctx) {
  const ahead = player.queue.slice(player.index + 1, player.index + 1 + WINDOW).map((t, i) => ({ t, at: player.index + 1 + i }));
  const here = songKey(cur);
  const movable = ahead.filter(({ t }) => t && !t.dj && songKey(t) !== here && !ctx.recentSongs.has(songKey(t)));
  return { ahead, movable };
}

// Each returns { from, note } to move the track at `from` up to play next,
// or { none } saying why nothing moves.
const ARRANGERS = {
  // The queued track that sounds most like this one plays next.
  async 'queue-echo'({ cur, ctx, dj }) {
    const { ahead, movable } = upcoming(cur, ctx);
    if (!movable.length) return { none: 'there’s nothing else in your queue to choose from' };
    const [near, info] = await Promise.all([distancesFrom(cur), aboutTracks([cur, ...ahead.map((x) => x.t)])]);
    if (!near.map.size) dj.noSonic(true);
    const alike = (x) => likeness(cur, x.t, info, near);
    const best = movable.reduce((a, b) => (alike(b) > alike(a) ? b : a));
    const next = ahead[0];
    if (best.at === next.at || alike(best) < alike(next) + 0.05) return { none: `“${next.t.title}”, next, sounds as much like this one as anything in your queue` };
    return { from: best.at, note: 'it sounds most like the last track' };
  },

  // If the next track sounds far from this one, a queued track that sits
  // between them plays first.
  async 'queue-bridge'({ cur, ctx, dj }) {
    const { ahead, movable } = upcoming(cur, ctx);
    const next = ahead[0]?.t;
    if (!next) return { none: 'there’s nothing queued after this track' };
    const [near, fromNext, info] = await Promise.all([distancesFrom(cur), distancesFrom(next), aboutTracks([cur, ...ahead.map((x) => x.t)])]);
    if (!near.map.size) dj.noSonic(true);
    const gap = likeness(cur, next, info, near);
    if (gap >= FLOW) return { none: `“${next.title}” flows on from this one` };
    const between = movable.filter((x) => x.t !== next);
    const step = (x) => Math.min(likeness(cur, x.t, info, near), likeness(next, x.t, info, fromNext));
    const best = between.length ? between.reduce((a, b) => (step(b) > step(a) ? b : a)) : null;
    if (!best || step(best) < gap + BETTER) return { none: `nothing in your queue sits between this one and “${next.title}”` };
    return { from: best.at, note: `it bridges the gap to “${next.title}”` };
  },
};

export const DJS = [
  { id: 'bridge', kind: 'insert', name: 'DJ Bridge', description: 'Between each of your tracks and the next, plays one that sits between them in sound.' },
  { id: 'echo', kind: 'insert', name: 'DJ Echo', description: 'Follows each track with the one that sounds most like it.' },
  { id: 'steady', kind: 'continue', name: 'DJ Steady', description: 'Keeps the mood going with tracks that sound like the one playing.' },
  { id: 'double', kind: 'insert', name: 'DJ Double', description: 'Follows each track with another by the same artist.' },
  { id: 'era', kind: 'continue', name: 'DJ Era', description: 'Keeps the mood going with tracks from the same era.' },
  { id: 'superfan', kind: 'continue', name: 'DJ Superfan', description: 'Keeps queueing tracks by the same artist.' },
  {
    id: 'ai',
    kind: 'continue',
    name: 'AI DJ',
    description: 'Your AI model picks each next track and says why: other artists’ best-known songs, in the genre you started with.',
    needsAI: true,
  },
  // Only what's queued:
  { id: 'queue-echo', kind: 'reorder', name: 'Queue Echo', description: 'Plays next whichever track in your queue sounds most like the one playing.' },
  { id: 'queue-bridge', kind: 'reorder', name: 'Queue Bridge', description: 'When your next track sounds far from this one, first plays one from later in your queue that sits between them.' },
];

export const djName = (id) => DJS.find((d) => d.id === id)?.name || 'Guest DJ';

const sentence = (s) => s.charAt(0).toUpperCase() + s.slice(1);

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
    this.moved = []; // what the "your queue" DJs moved up: [{ t, after }], to put back (the last 200)
    this.anchor = null; // the AI DJ's genre (see anchorFor)
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

  // Returns what was undone of the DJ before: how many of its picks came
  // out of the queue, and how many tracks it moved went back ({ removed,
  // back }; see restore).
  set(id, { quiet = false } = {}) {
    const was = this.id;
    this.id = id || null;
    store.set('guestDj', this.id);
    this.cancel();
    this.arranged = null;
    this.anchor = null;
    const undone = was !== this.id ? this.restore() : { removed: 0, back: 0 };
    this.emit('change');
    if (!quiet && this.id) this.schedule(0);
    return undone;
  }

  // What's to come as it was before the DJ: its picks (any but the DJ now
  // on's) taken out, and what it moved up put back after the track it
  // followed, if both are still to come. Not in a Play Together session,
  // nor while another of your devices plays: that queue isn't this one's.
  restore() {
    const moved = this.moved.splice(0);
    const undone = { removed: 0, back: 0 };
    if (player.remote || followingDevice()) return undone;
    const picks = [];
    player.queue.forEach((t, i) => i > player.index && t.dj && t.dj !== this.id && picks.push(i));
    for (const i of picks.reverse()) player.remove(i);
    undone.removed = picks.length;
    for (const { t, after } of moved.reverse()) {
      if (player.queue.indexOf(t) <= player.index) continue; // played, or gone
      delete t.djMoved;
      delete t.djNote;
      if (player.putAfter(t, after)) undone.back += 1;
    }
    return undone;
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
      lastArtists: new Set(this.recent.slice(-3).map((t) => norm(t.artist))),
    };
  }

  // The AI DJ's genre: that of the track playing when it started (its
  // album's, and its artist's), until it's turned off.
  async anchorFor(cur) {
    if (this.anchor) return this.anchor;
    const [album, artist] = await Promise.all([
      cur.albumId ? server().albumMeta(cur.albumId).catch(() => null) : null,
      cur.artistId ? server().artistsMeta([cur.artistId]).then(([m]) => m).catch(() => null) : null,
    ]);
    const genres = [...(album?.Genre || []), ...(artist?.Genre || [])];
    this.anchor = {
      tags: tagSet({ Genre: genres }, ['Genre']),
      label: [...new Set(genres.map((g) => g?.tag).filter(Boolean))].slice(0, 3).join(', '),
      filter: tagFilter(album?.Genre?.[0] || artist?.Genre?.[0]),
    };
    return this.anchor;
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

  // The "your queue" DJs: once for each track, maybe move one up. The first
  // time after one's turned on, it says what it did (or why it didn't).
  async arrange(dj, cur) {
    if (this.arranged === cur.qid) return;
    const first = this.arranged === null;
    this.arranged = cur.qid;
    const token = ++this.token;
    this.busy = true;
    this.emit('busy');
    try {
      const move = await ARRANGERS[dj.id]({ cur, ctx: this.context(), dj: this });
      if (token !== this.token || player.current !== cur || !move) return;
      if (move.none) {
        if (first) toast(`${dj.name}: ${sentence(move.none)}, so nothing moved.`, { timeout: 5000 });
        return;
      }
      const t = player.queue[move.from];
      if (!t) return;
      this.moved.push({ t, after: player.queue[move.from - 1] });
      if (this.moved.length > 200) this.moved.shift();
      t.djMoved = dj.id;
      t.djNote = move.note;
      player.moveToTop(move.from);
      if (first) toast(`${dj.name} moved “${t.title}” up: ${move.note}.`, { timeout: 5000 });
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
      this.warnOnce('no-sonic-queue', 'Plex has no sonic analysis for these tracks, so the DJ goes by their genres, styles, moods and years. Turn on sonic analysis for this library in Plex for better transitions.');
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
