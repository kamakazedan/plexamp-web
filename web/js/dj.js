// Guest DJ: modes that add tracks to the queue as you listen.
//
// "Insert" DJs add one pick after each of your own tracks, then carry on
// with your queue. "Continue" DJs keep lining up the next track themselves;
// your queue waits behind their picks and resumes when the DJ is turned off.
import { app, on } from './state.js';
import { player } from './player.js';
import { normTrack, store } from './plex.js';
import { aiReady, djPick, describeAIError } from './ai.js';
import { describeError } from './router.js';
import { toast } from './ui.js';

const server = () => app.server;
const section = () => app.source?.sectionKey;
const pickOne = (list, top = list.length) => list[Math.floor(Math.random() * Math.min(top, list.length))];

function fresh(items, avoid, cur) {
  const seen = new Set();
  return items
    .filter((m) => m && (m.type === 'track' || m.partKey !== undefined))
    .map((m) => (m.partKey !== undefined ? m : normTrack(m)))
    .filter((t) => {
      const key = `${t.artist}|${t.title}`.toLowerCase();
      if (avoid.has(t.id) || seen.has(key) || (cur && t.title.toLowerCase() === cur.title.toLowerCase() && t.artist === cur.artist)) return false;
      seen.add(key);
      return true;
    });
}

async function nearest(cur, limit = 30) {
  return (await server().nearest(cur.id, { limit, maxDistance: 0.3 }).catch(() => [])).filter((m) => m.type === 'track');
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

// Each pick function returns a list of { track, note } (usually one).
const PICKERS = {
  async echo({ cur, avoid, dj }) {
    let list = fresh(await nearest(cur, 20), avoid, cur);
    if (!list.length) {
      dj.noSonic();
      list = fresh(await sameGenre(cur), avoid, cur);
    }
    return list.length ? [{ track: list[0] }] : [];
  },

  async steady({ cur, avoid, dj }) {
    let list = fresh(await nearest(cur, 30), avoid, cur);
    if (!list.length) {
      dj.noSonic();
      list = fresh(await sameGenre(cur), avoid, cur);
    }
    const t = pickOne(list, 6);
    return t ? [{ track: t }] : [];
  },

  async bridge({ cur, next, avoid, dj }) {
    if (next && !next.dj) {
      const path = await server().computePath(section(), cur.id, next.id).catch(() => []);
      const middle = fresh(path.slice(1, -1), avoid, cur);
      if (middle.length) {
        const mid = Math.floor(middle.length / 2);
        return middle.slice(Math.max(0, mid - 1), mid + 1).map((track) => ({ track }));
      }
    }
    return PICKERS.echo({ cur, avoid, dj });
  },

  async double({ cur, avoid }) {
    if (!cur.artistId) return [];
    let list = fresh(await server().popularTracks(section(), cur.artistId, 25).catch(() => []), avoid, cur);
    if (list.length < 3) list = list.concat(fresh(await server().allLeaves(cur.artistId).catch(() => []), avoid, cur));
    const t = pickOne(list, 10);
    return t ? [{ track: t }] : [];
  },

  async era({ cur, avoid, dj }) {
    const year = Number(cur.year) || 0;
    if (year) {
      const near = fresh(await nearest(cur, 50), avoid, cur).filter((t) => t.year && Math.abs(Number(t.year) - year) <= 5);
      if (near.length) return [{ track: pickOne(near, 5) }];
    }
    const decade = decadeOf(year);
    if (!decade) return PICKERS.steady({ cur, avoid, dj });
    const genre = await albumTag(cur);
    let list = genre ? fresh(await randomTracks({ 'album.decade': decade, 'album.genre': genre }, 20), avoid, cur) : [];
    if (!list.length) list = fresh(await randomTracks({ 'album.decade': decade }, 20), avoid, cur);
    return list.length ? [{ track: list[0] }] : [];
  },

  async superfan({ cur, avoid }) {
    if (!cur.artistId) return [];
    const t = pickOne(fresh(await server().allLeaves(cur.artistId).catch(() => []), avoid, cur));
    return t ? [{ track: t }] : [];
  },

  async ai({ cur, avoid, dj, signal }) {
    const decade = decadeOf(cur.year);
    const [near, genre, artist, era] = await Promise.all([
      nearest(cur, 15),
      sameGenre(cur, 12),
      cur.artistId ? server().popularTracks(section(), cur.artistId, 6).catch(() => []) : [],
      decade ? randomTracks({ 'album.decade': decade }, 8) : [],
    ]);
    const candidates = fresh([...near, ...genre, ...artist.slice(0, 3), ...era], avoid, cur).slice(0, 30);
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

export const DJS = [
  { id: 'bridge', kind: 'insert', name: 'DJ Bridge', description: 'Plays a short sonic journey between each pair of tracks.' },
  { id: 'echo', kind: 'insert', name: 'DJ Echo', description: 'Follows each track with the one that sounds most like it.' },
  { id: 'steady', kind: 'continue', name: 'DJ Steady', description: 'Keeps the mood going with tracks that sound like the one playing.' },
  { id: 'double', kind: 'insert', name: 'DJ Double', description: 'Follows each track with another by the same artist.' },
  { id: 'era', kind: 'continue', name: 'DJ Era', description: 'Keeps the mood going with tracks from the same era.' },
  { id: 'superfan', kind: 'continue', name: 'DJ Superfan', description: 'Keeps queueing tracks by the same artist.' },
  { id: 'ai', kind: 'continue', name: 'AI DJ', description: 'Your AI model picks each next track from your library and says why.', needsAI: true },
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
    this.warned = new Set();
    this.ctrl = null;

    player.addEventListener('track', () => {
      const t = player.current;
      if (t && this.recent[this.recent.length - 1]?.id !== t.id) {
        this.recent.push(t);
        if (this.recent.length > 12) this.recent.shift();
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
    // A pick lined up by a different DJ makes way for the new one.
    const next = player.queue[player.index + 1];
    if (next?.dj && next.dj !== this.id && !player.remote) player.remove(player.index + 1);
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

  async check() {
    const dj = this.active;
    const cur = player.current;
    // No DJ in a Play Together session: the queue is everyone's.
    if (!dj || !cur || !app.server || player.remote || player.state === 'idle' || player.repeat === 'one') return;
    const next = player.queue[player.index + 1];
    if (next?.dj) return; // a pick is already lined up
    if (dj.kind === 'insert' && cur.dj) return; // insert DJs only follow your own tracks
    if (dj.needsAI && !aiReady()) {
      this.warnOnce('ai-missing', 'AI DJ needs an AI model. Set one up in Settings › AI.');
      return;
    }

    const token = ++this.token;
    this.ctrl = new AbortController();
    this.busy = true;
    this.emit('busy');
    try {
      const avoid = new Set([...player.history.slice(-150), ...player.queue.map((t) => t.id)]);
      const picks = await PICKERS[dj.id]({ cur, next, avoid, dj: this, signal: this.ctrl.signal });
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

  noSonic() {
    this.warnOnce('no-sonic', 'No sonically similar tracks were found, so the DJ is matching on genre. Turn on sonic analysis for this library in Plex for better picks.');
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
