// Rating tracks. Plex keeps ratings from 0 to 10 (10 is five stars), shown
// the way Settings › Experience says: a favourite tick (ticked is 10,
// unticked no rating), five stars, thumbs (up is 10, down is 2) or not at
// all. Every rating goes through rateTrack(), so every control showing a
// track agrees, and loved tracks (ticked, five stars or thumbs up: all 10)
// are kept in the ❤️ Tracks playlist, as in Plexamp: in when they get that
// rating, out when they lose it.
import { app, on } from './state.js';
import { describeError } from './router.js';
import { h, toast } from './ui.js';
import { refreshLists } from './editing.js';
import { live } from './live.js';
import { offlineFor, unreachable } from './connection.js';
import { keep, forget, restore, kept, keptOf, sendsWith } from './outbox.js';

export const LOVED = 10;
export const LOVED_TITLE = '❤️ Tracks';
export const RATING_MODES = ['tick', 'stars', 'thumbs', 'off'];
export const ratingMode = () => (RATING_MODES.includes(app.settings.ratingSystem) ? app.settings.ratingSystem : 'tick');

// 'rated' { id, rating }: a track's rating changed in this app.
export const ratingEvents = new EventTarget();

// The last rating saved from this app for each track, so a stale copy of a
// track (kept by a page from before it was rated) doesn't decide what
// ❤️ Tracks needs. And ratings being saved, shown straight away.
const known = new Map();
const pending = new Map();
// Ratings kept while the connection was gone (see rateTrack), as rated
// here till they're sent, the page loaded afresh meanwhile too.
const seedKept = () => keptOf('rated').forEach((x) => known.set(String(x.id), x.value ?? null));
seedKept();
// (Another server's tracks have other ids.)
on('source', ({ serverChanged } = {}) => {
  if (!serverChanged) return;
  known.clear();
  seedKept();
});
// A track rated here that Plex says has changed since (rated again in
// another Plex app, say): what Plex has for it now, so what's picked for
// you (picks.js) and what's shown go by that.
live.addEventListener('items', (e) => {
  // (Not one kept to send, as the connection was gone: that's how it's to be.)
  const ids = (e.detail?.ids || []).map(String).filter((id) => known.has(id) && !pending.has(id) && !kept(`rated|${id}`));
  for (const id of ids.slice(0, 50)) {
    app.server
      ?.metadata(id)
      .then((m) => {
        if (!m || !known.has(id) || pending.has(id)) return;
        const value = m.userRating ?? null;
        if (known.get(id) === value) return;
        known.set(id, value);
        ratingEvents.dispatchEvent(new CustomEvent('rated', { detail: { id, rating: value } }));
        paintRows(id, value);
      })
      .catch(() => {});
  }
});
const knownRating = (track) => (known.has(String(track.id)) ? known.get(String(track.id)) : (track.userRating ?? null));
const shownRating = (track) => (pending.has(String(track.id)) ? pending.get(String(track.id)) : knownRating(track));

// A track's rating, as this app knows it (one rated here since the track
// was listed goes by that), for a track as the app has them or as Plex
// lists them. Ratings are each Plex account's own.
export const ratingOf = (t) => {
  const id = String(t?.id ?? t?.ratingKey ?? '');
  return known.has(id) ? known.get(id) : (t?.userRating ?? null);
};
// Rated down: a thumbs down, or one star or less (Plex's 2 of 10, or 1).
// Thumbs show down for that, and no more (two stars is neither).
export const DISLIKED_AT_MOST = 2;
export const isDownRating = (v) => Number.isFinite(Number(v)) && Number(v) > 0 && Number(v) <= DISLIKED_AT_MOST;
export const isDisliked = (t) => isDownRating(ratingOf(t));

// { kept }: kept on this device, as the connection's gone, and sent once
// it's back (see outbox.js); shown as rated meanwhile, everywhere here.
export async function rateTrack(track, rating) {
  const id = String(track.id);
  const value = rating ? Math.max(1, Math.min(10, Math.round(rating))) : null;
  const before = knownRating(track);
  const lovedChanged = (before === LOVED) !== (value === LOVED) && app.settings.lovedPlaylist !== false;
  let held = false;
  // (One kept from before, while the connection was gone, is out of date
  // now, so it's taken out first, not to be sent after this one: ❤️ Tracks
  // as this one has it, if that one was to change it.)
  const earlier = forget(`rated|${id}`);
  try {
    await app.server.rate(id, value);
  } catch (err) {
    if (!(await offlineFor(err))) {
      restore(earlier);
      throw err;
    }
    // (❤️ Tracks to change once it's sent: whether it's to change from how
    // it was before the first one kept.)
    keep({ kind: 'rated', key: `rated|${id}`, id, value, title: String(track.title || '').slice(0, 200), loved: lovedChanged !== !!earlier?.loved });
    held = true;
  }
  track.userRating = value;
  known.set(id, value);
  if (known.size > 2000) known.delete(known.keys().next().value);
  ratingEvents.dispatchEvent(new CustomEvent('rated', { detail: { id, rating: value } }));
  paintRows(id, value);
  if (held) toast('Rated here. It goes to Plex once the connection’s back.');
  else if (lovedChanged || earlier?.loved) keepLoved(track);
  return { kept: held };
}

// A rating kept while the connection was gone (rateTrack), sent now:
// ❤️ Tracks then, as it changed it. Not one rated again since, in another
// Plex app or on another device (Plex's lastRatedAt for it is later, by
// more than this device's clock and the server's could be apart): that
// one stands, and shows here. One Plex refuses is let go, saying so.
const CLOCKS_APART_MS = 120000;
sendsWith(
  'rated',
  async (x) => {
    try {
      const now = await app.server.metadata(x.id);
      if (Number(now?.lastRatedAt) * 1000 > x.at + CLOCKS_APART_MS) {
        const value = now.userRating ?? null;
        known.set(String(x.id), value);
        ratingEvents.dispatchEvent(new CustomEvent('rated', { detail: { id: String(x.id), rating: value } }));
        paintRows(String(x.id), value);
        return false;
      }
      // (Not one rated again here meanwhile, in this tab or another: that
      // one's sent itself, or kept in its place.)
      if (kept(x.key)?.at !== x.at) return false;
      await app.server.rate(x.id, x.value);
    } catch (err) {
      if (unreachable(err)) throw err;
      toast(`Couldn’t save your rating of “${x.title || 'a track'}” from while the connection was gone. ${describeError(err)}`, { timeout: 6000 });
      return false;
    }
    if (x.loved && app.settings.lovedPlaylist !== false) keepLoved({ id: x.id, title: x.title, userRating: x.value });
    return true;
  },
  {
    letGo: (x) =>
      toast(`Couldn’t save your rating of “${x.title || 'a track'}” from while the connection was gone: ${app.source?.serverName || 'your server'} kept failing it.`, { timeout: 6000 }),
  },
);

// ---------- ❤️ Tracks ----------

// Plexamp's is called "❤️ Tracks"; written other ways too.
export const isLovedTitle = (title) => /^(?:❤️?|♥️?|<3)\s*tracks$/iu.test(String(title || '').trim());

// The playlist, from every library: Plexamp's own is a smart playlist, which
// Plex keeps up to date itself; otherwise a regular one this app looks after.
export async function lovedPlaylist() {
  app.server.forgetPlaylists();
  const all = (await app.server.playlists()).filter((p) => isLovedTitle(p.title) && (p.playlistType || 'audio') === 'audio');
  return all.find((p) => p.smart) || all[0] || null;
}

// The playlist's entries for a track (a track can be in it more than once).
async function entriesFor(pl, id) {
  const found = [];
  for (let start = 0; start < 20000; start += 500) {
    const { items, total } = await app.server.playlistItems(pl.ratingKey, { start, size: 500 });
    for (const m of items) if (String(m.ratingKey) === id && m.playlistItemID != null) found.push(m.playlistItemID);
    if (!items.length || start + items.length >= total) break;
  }
  return found;
}

// One change at a time, each for the rating the track has by then.
let loving = Promise.resolve();

function keepLoved(track) {
  loving = loving
    .then(() => updateLoved(track))
    .catch((err) => toast(`Couldn’t update ${LOVED_TITLE}. ${describeError(err)}`));
}

async function updateLoved(track) {
  const s = app.server;
  const id = String(track.id);
  const loved = knownRating(track) === LOVED;
  const pl = await lovedPlaylist();
  if (pl?.smart) {
    // Plex fills it from ratings itself; pages showing it load it again.
    refreshLists('playlist');
    return;
  }
  if (loved) {
    if (!pl) {
      await s.createPlaylist(LOVED_TITLE, [id]);
      const yours = { tick: 'favourites', thumbs: 'thumbs-up tracks' }[ratingMode()] || 'five-star tracks';
      toast(`Added “${track.title}” to ${LOVED_TITLE}, a new playlist for your ${yours}`);
    } else if (!(await entriesFor(pl, id)).length) {
      await s.addToPlaylist(pl.ratingKey, [id]);
      toast(`Added to ${pl.title}`);
    }
  } else if (pl) {
    const entries = await entriesFor(pl, id);
    for (const e of entries) await s.removeFromPlaylist(pl.ratingKey, e);
    if (entries.length) toast(`Removed from ${pl.title}`);
  }
  refreshLists('playlist');
}

// ---------- ratings in track lists ----------

// One small control per row: a tick, stars (one element, drawn by CSS from
// the value) or two thumbs. Rows can number in thousands, so it's kept to a
// few elements, its track is held here rather than in closures, and taps,
// keys and hovering are handled once for the whole page (below).
const rowTracks = new WeakMap(); // control -> track
let modeVersion = 0;

// Stars show whole stars (a half-star rating from another Plex app, to the
// nearest); the tick and thumbs keep Plex's own value.
function shown(mode, v) {
  return mode === 'stars' ? Math.round(v / 2) * 2 : v;
}

export function rowRating(track) {
  const el = h('div.row-rating', { dataset: { trackId: String(track.id) } });
  rowTracks.set(el, track);
  paintRow(el);
  return el;
}

function paintRow(el) {
  const track = rowTracks.get(el);
  if (!track) return;
  const mode = ratingMode();
  const v = shown(mode, shownRating(track) || 0);
  el.dataset.v = String(modeVersion);
  el.dataset.mode = mode;
  el.hidden = mode === 'off';
  if (mode === 'off') {
    el.replaceChildren();
    el.removeAttribute('role');
    el.removeAttribute('tabindex');
    return;
  }
  if (mode === 'tick') {
    el.removeAttribute('role');
    el.removeAttribute('tabindex');
    el.removeAttribute('aria-valuenow');
    let tick = el.querySelector('.rr-tick');
    if (!tick || el.children.length !== 1) {
      tick = h('button.rr-tick', { type: 'button', 'aria-label': `Favourite ${track.title}` });
      el.replaceChildren(tick);
    }
    tick.classList.toggle('on', v === LOVED);
    tick.setAttribute('aria-pressed', String(v === LOVED));
    return;
  }
  if (mode === 'thumbs') {
    el.removeAttribute('role');
    el.removeAttribute('tabindex');
    el.removeAttribute('aria-valuenow');
    let [down, up] = el.querySelectorAll('.rr-thumb');
    if (!up) {
      down = h('button.rr-thumb.rr-down', { type: 'button', 'aria-label': `Thumbs down for ${track.title}` });
      up = h('button.rr-thumb.rr-up', { type: 'button', 'aria-label': `Thumbs up for ${track.title}` });
      el.replaceChildren(down, up);
    }
    up.classList.toggle('on', v >= 6);
    up.setAttribute('aria-pressed', String(v >= 6));
    down.classList.toggle('on', isDownRating(v));
    down.setAttribute('aria-pressed', String(isDownRating(v)));
    return;
  }
  if (!el.querySelector('.rr-stars')) el.replaceChildren(h('span.rr-stars', { 'aria-hidden': 'true' }));
  el.setAttribute('role', 'slider');
  el.tabIndex = 0;
  el.setAttribute('aria-label', `Rating for ${track.title}`);
  el.setAttribute('aria-valuemin', '0');
  el.setAttribute('aria-valuemax', '5');
  el.setAttribute('aria-valuenow', String(v / 2));
  el.setAttribute('aria-valuetext', v ? `${v / 2} star${v === 2 ? '' : 's'}` : 'Not rated');
  el.style.setProperty('--v', String(v / 10));
}

// What a tap on the stars at clientX would set (2 to 10).
function starsAt(el, clientX) {
  const r = el.getBoundingClientRect();
  const frac = Math.min(1, Math.max(0, (clientX - r.left) / (r.width || 1)));
  return Math.max(1, Math.ceil(frac * 5)) * 2;
}

function onRowClick(el, e) {
  const track = rowTracks.get(el);
  if (!track) return;
  const mode = ratingMode();
  const v = shown(mode, shownRating(track) || 0);
  let next;
  if (mode === 'tick') {
    if (!e.target.closest('.rr-tick')) return;
    next = v === LOVED ? 0 : LOVED;
  } else if (mode === 'thumbs') {
    const btn = e.target.closest('.rr-thumb');
    if (!btn) return;
    next = btn.classList.contains('rr-up') ? (v >= 6 ? 0 : 10) : isDownRating(v) ? 0 : 2;
  } else {
    // Tapping the rating it has clears it.
    next = starsAt(el, e.clientX);
    if (next === v) next = 0;
  }
  setRating(track, next);
}

// (Stars only: the tick and thumbs are buttons.)
function onRowKey(el, e) {
  const track = rowTracks.get(el);
  if (!track || ratingMode() !== 'stars') return;
  const step = 2;
  const v = shown(ratingMode(), shownRating(track) || 0);
  const keys = { ArrowRight: v + step, ArrowUp: v + step, ArrowLeft: v - step, ArrowDown: v - step, Home: 0, End: 10, Delete: 0, Backspace: 0 };
  if (!(e.key in keys)) return;
  e.preventDefault();
  const next = Math.max(0, Math.min(10, keys[e.key]));
  if (next !== v) setRating(track, next);
}

// Hovering with a mouse previews the rating a click would set.
let hovered = null;
function onHover(e) {
  const el = e.pointerType === 'mouse' ? e.target.closest?.('.row-rating[role="slider"]') : null;
  if (hovered && hovered !== el) hovered.classList.remove('hovering');
  hovered = el;
  if (!el) return;
  el.classList.add('hovering');
  el.style.setProperty('--hv', String(starsAt(el, e.clientX) / 10));
}

const ratingIn = (e) => {
  const el = e.target.closest?.('.row-rating');
  return el && rowTracks.has(el) ? el : null;
};
document.addEventListener('click', (e) => {
  const el = ratingIn(e);
  if (el) onRowClick(el, e);
});
document.addEventListener('keydown', (e) => {
  const el = ratingIn(e);
  if (el) onRowKey(el, e);
});
document.addEventListener('pointermove', onHover, { passive: true });

async function setRating(track, next) {
  const id = String(track.id);
  // Shown at once; as it was if Plex says no.
  pending.set(id, next || null);
  paintRows(id);
  try {
    await rateTrack(track, next);
  } catch (err) {
    toast(`Couldn't save the rating. ${describeError(err)}`);
  } finally {
    pending.delete(id);
    paintRows(id);
  }
}

// Every row showing this track, on the page on screen (with the rating
// saved, when `rating` is given).
function paintRows(id, rating) {
  for (const el of document.querySelectorAll(`.row-rating[data-track-id="${CSS.escape(id)}"]`)) {
    const t = rowTracks.get(el);
    if (t && rating !== undefined) t.userRating = rating;
    paintRow(el);
  }
}

// A new rating system: rows on screen change now, rows on kept pages when
// they're shown again (refreshRows, from the router's page change).
export function refreshRows(root = document) {
  for (const el of root.querySelectorAll('.row-rating')) {
    if (el.dataset.v !== String(modeVersion)) paintRow(el);
  }
}

let lastMode = ratingMode();
on('settings', () => {
  document.body.classList.toggle('no-list-ratings', app.settings.listRatings === false);
  if (ratingMode() === lastMode) return;
  lastMode = ratingMode();
  modeVersion += 1;
  refreshRows();
});
document.body.classList.toggle('no-list-ratings', app.settings.listRatings === false);
