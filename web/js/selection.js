// Choosing several tracks or albums at once, to play, queue or add to a
// playlist together.
//
// Select, in a track's or album's menu, starts it; on a computer so does
// Ctrl-click (⌘-click on a Mac) or Shift-click. While choosing, a tap on a
// track or album chooses it or lets it go again (Shift-click: everything in
// the list from the one chosen last to it), and a bar at the bottom says
// how many there are and what can be done with them.
//
// What's chosen is kept by what it is, not by where it's shown: a search
// typed again, the page brought up to date, or a list sorted or filtered
// another way keeps it (and shows it chosen wherever it turns up), so songs
// from several searches can go into one playlist. ✕, Esc, or another page
// stops; so does letting go of the last one. What the bar does lets go of
// what it's done it with, once that's in (what's chosen meanwhile stays).
//
// Only tracks and albums on the page itself: not Up next (the queue's own
// rows), nor a list that's unlocked for editing.
import { app } from './state.js';
import { normTrack } from './plex.js';
import { h, icon, sheet, toast, fmt } from './ui.js';
import { queueTracks, queueLimit, playList } from './actions.js';
import { addToPlaylist, addToCollection, isAdminNow } from './editing.js';

const ITEMS = new WeakMap(); // element → { kind: 'track' | 'album', item, key }
const chosen = new Map(); // key ('track:123', 'album:45') → { kind, item }, in the order chosen
const changed = new Set(); // keys chosen or let go since the page was last painted
let anchor = null; // the key chosen (or let go) last: Shift-click goes from it
let bar = null;
let busy = 0; // how many things the bar's doing (getting albums' tracks, say)
let painted = false; // whether the page was last painted as choosing
let page = null; // the page (the router's entry) it's all on

const PLAYLIST_LIMIT = 5000; // tracks added to a playlist at once (as editing.js's)
const BIG = 8; // albums: more than this many, and it says it's getting their tracks

const keyOf = (kind, item) => `${kind}:${kind === 'album' ? item.ratingKey : item.id}`;

// `el` stands for a track (as normTrack makes them) or an album (as Plex
// lists them) that can be chosen.
export function selectable(el, kind, item) {
  const key = keyOf(kind, item);
  ITEMS.set(el, { kind, item, key });
  el.dataset.sel = kind;
  el.dataset.selKey = key;
  if (chosen.size) paint(el, chosen.has(key), true);
}

export const isSelecting = () => chosen.size > 0;

const eligible = (el) => !!el?.isConnected && ITEMS.has(el) && !!el.closest('#main') && !el.closest('.editing, .is-editing, .is-sorting');

// Start choosing, with `el`.
export function startSelect(el) {
  if (!eligible(el)) return;
  const it = ITEMS.get(el);
  choose(it, true);
  anchor = it.key;
  update();
}

export function clearSelection() {
  if (!chosen.size && !bar) return;
  for (const key of chosen.keys()) changed.add(key);
  chosen.clear();
  anchor = null;
  update();
}

// A page's been shown: another one (not the same one brought up to date,
// or sorted or filtered another way: `same`) stops the choosing. `key`: the
// router's entry for it.
export function pageShown(key, same = false) {
  const was = page;
  page = key;
  if (key !== was && !same) clearSelection();
}

function choose(it, on) {
  if (on) chosen.set(it.key, { kind: it.kind, item: it.item });
  else chosen.delete(it.key);
  changed.add(it.key);
}

// What the bar did something with, done: let go (what was chosen since
// stays chosen).
function release(list) {
  for (const x of list) {
    const key = keyOf(x.kind, x.item);
    chosen.delete(key);
    changed.add(key);
  }
  update();
}

// The others like `el` in its list (the tracks of a track list, the albums
// of a grid or shelf), as far as it's loaded.
const siblings = (el) => [...(el.parentElement?.children || [])].filter((c) => ITEMS.get(c)?.kind === ITEMS.get(el)?.kind && eligible(c));

function chooseRange(from, to) {
  const list = siblings(to);
  const a = list.indexOf(from);
  const b = list.indexOf(to);
  list.slice(Math.min(a, b), Math.max(a, b) + 1).forEach((el) => chosen.has(ITEMS.get(el).key) || choose(ITEMS.get(el), true));
}

function chooseAll(like) {
  siblings(like).forEach((el) => chosen.has(ITEMS.get(el).key) || choose(ITEMS.get(el), true));
  update();
}

// One shown on the page now for what was chosen (or let go) last, or else
// for anything chosen: where Shift-click and Ctrl+A go from.
const shownFor = (key) => {
  const els = [...document.querySelectorAll('#main [data-sel]')].filter((el) => eligible(el));
  return els.find((el) => ITEMS.get(el).key === key) || els.find((el) => chosen.has(ITEMS.get(el).key)) || null;
};

// Taps while choosing (and Ctrl- or Shift-clicks to start) choose, instead
// of playing or opening what was tapped.
document.addEventListener(
  'click',
  (e) => {
    if (e.button !== 0) return;
    const el = e.target.closest?.('[data-sel]');
    if (!el || !eligible(el)) return;
    const add = e.ctrlKey || e.metaKey;
    if (!chosen.size && !add && !e.shiftKey) return;
    e.preventDefault();
    e.stopPropagation();
    const it = ITEMS.get(el);
    const from = e.shiftKey && anchor && anchor !== it.key ? siblings(el).find((x) => ITEMS.get(x).key === anchor) : null;
    if (from) chooseRange(from, el);
    else choose(it, !chosen.has(it.key));
    anchor = it.key;
    update();
  },
  true,
);

// (Shift-clicking doesn't select the page's text on the way.)
document.addEventListener('mousedown', (e) => {
  if (e.button === 0 && e.shiftKey && eligible(e.target.closest?.('[data-sel]'))) e.preventDefault();
});

document.addEventListener('keydown', (e) => {
  if (!chosen.size || document.querySelector('.sheet') || document.body.classList.contains('np-open')) return;
  // Esc stops, from anywhere (a search box that's emptied by it first keeps
  // it to itself); Ctrl+A chooses the rest of the list, except in a box.
  if (e.key === 'Escape' && !e.defaultPrevented) {
    e.preventDefault();
    clearSelection();
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a' && !e.target.closest?.('input, textarea, select, [contenteditable="true"]')) {
    e.preventDefault();
    const like = shownFor(anchor);
    if (like) chooseAll(like);
  }
});

// What's chosen: in the order it was chosen, but those on the page now in
// the order they're shown there (a list's order, not the order they were
// tapped in), in the places they took.
function inOrder() {
  const shown = new Map(); // key → shown, in the page's order
  for (const el of document.querySelectorAll('#main [data-sel]')) {
    const key = ITEMS.get(el)?.key;
    if (key && chosen.has(key) && !shown.has(key)) shown.set(key, true);
  }
  const onPage = [...shown.keys()];
  let next = 0;
  return [...chosen].map(([key, v]) => (shown.has(key) ? chosen.get(onPage[next++]) : v));
}

// "3 albums", "12 tracks", "2 albums and 5 tracks".
function describe(list) {
  const albums = list.filter((x) => x.kind === 'album').length;
  const tracks = list.length - albums;
  return [albums && fmt.count(albums, 'album', 'albums'), tracks && fmt.count(tracks, 'track', 'tracks')].filter(Boolean).join(' and ');
}

// Their tracks, in order, up to `limit`: albums by their tracks, a few
// asked for at once, and no more albums than it takes. One that can't be
// had (gone since it was shown, say) is left out, and counted; if none
// could be, that's an error.
async function loadTracks(list, limit) {
  const s = app.server;
  const albums = list.filter((x) => x.kind === 'album').length;
  if (albums > BIG) toast(`Getting the tracks of ${fmt.count(albums, 'album', 'albums')}…`, { timeout: 30000 });
  const out = [];
  let failed = 0;
  let error = null;
  for (let i = 0; i < list.length && out.length < limit; i += 4) {
    const parts = await Promise.all(
      list.slice(i, i + 4).map(async ({ kind, item }) => {
        if (kind !== 'album') return [item];
        if (!/^\d+$/.test(String(item.ratingKey))) return [];
        try {
          return (await s.children(item.ratingKey)).filter((m) => m.type === 'track').map(normTrack);
        } catch (err) {
          failed += 1;
          error = err;
          return [];
        }
      }),
    );
    for (const p of parts) out.push(...p);
  }
  if (!out.length && error) throw error;
  return { tracks: out.slice(0, limit), failed };
}

const failedNote = (n) => (n ? ` (${fmt.count(n, 'album', 'albums')} couldn’t be loaded)` : '');

// ---------- the bar ----------

// What's choosable on the page, as what's chosen says: ticked, and (to a
// screen reader) a track's button "Choose …", pressed or not, and a cover
// or album row "Chosen". All of it as choosing starts or stops, and else
// just what changed.
function repaint() {
  const on = chosen.size > 0;
  if (on !== painted || changed.size > 50) {
    for (const el of document.querySelectorAll('#main [data-sel]')) {
      const it = ITEMS.get(el);
      if (it) paint(el, on && chosen.has(it.key), on);
    }
  } else if (changed.size) {
    const which = [...changed].map((key) => `#main [data-sel-key="${CSS.escape(key)}"]`).join(',');
    for (const el of document.querySelectorAll(which)) paint(el, chosen.has(el.dataset.selKey), on);
  }
  painted = on;
  changed.clear();
}

function paint(el, isChosen, selecting) {
  el.classList.toggle('chosen', isChosen);
  const it = ITEMS.get(el);
  const button = el.classList.contains('track') ? el.querySelector(':scope > .track-main') : null;
  if (button) {
    const title = it?.item?.title || '';
    if (selecting) {
      button.setAttribute('aria-pressed', String(isChosen));
      button.setAttribute('aria-label', `Choose ${title}`);
    } else {
      button.removeAttribute('aria-pressed');
      button.setAttribute('aria-label', `Play ${title}`);
    }
    return;
  }
  // A cover is a link; an album row has one.
  const link = el.matches('a') ? el : el.querySelector(':scope > a') || el;
  if (isChosen) link.setAttribute('aria-description', 'Chosen');
  else link.removeAttribute('aria-description');
}

function update() {
  const n = chosen.size;
  document.body.classList.toggle('selecting', n > 0);
  repaint();
  if (!n) {
    anchor = null;
    bar?.remove();
    bar = null;
    return;
  }
  if (!bar) bar = buildBar();
  bar.querySelector('.select-count').textContent = describe([...chosen.values()]);
  bar.querySelector('.select-hint').hidden = n > 1;
}

function buildBar() {
  const button = (name, label, short, fn, cls = '') =>
    h(
      `button.select-btn${cls}`,
      { type: 'button', 'aria-label': label, title: label, onclick: fn },
      icon(name, 22),
      h('span.select-label.short', { 'aria-hidden': 'true' }, short),
      h('span.select-label.wide', { 'aria-hidden': 'true' }, label),
    );
  const el = h(
    'div.select-bar',
    { role: 'region', 'aria-label': 'Chosen tracks and albums' },
    h('button.select-close', { type: 'button', 'aria-label': 'Stop choosing', title: 'Stop choosing (Esc)', onclick: clearSelection }, icon('close', 22)),
    h(
      'div.select-text',
      { role: 'status' },
      h('div.select-count'),
      h('div.select-hint', null, matchMedia('(hover: hover)').matches ? 'Click more to add them' : 'Tap more to add them'),
    ),
    button('playNext', 'Play next', 'Next', () => queue('next')),
    button('addQueue', 'Add to queue', 'Queue', () => queue('end')),
    button('playlistAdd', 'Add to playlist', 'Playlist', toPlaylist),
    button('more', 'More', 'More', more, '.select-more'),
  );
  document.body.append(el);
  paintBusy(el);
  return el;
}

// While the bar's doing something, it doesn't start anything else (a
// second tap would do it twice); ✕ still stops choosing. (Its buttons stay
// where the keyboard is, marked as not available for now.)
function setBusy(on) {
  busy = Math.max(0, busy + (on ? 1 : -1));
  paintBusy(bar);
  if (!busy) update();
}

function paintBusy(el) {
  if (!el) return;
  el.classList.toggle('busy', busy > 0);
  el.querySelectorAll('.select-btn').forEach((b) => (busy ? b.setAttribute('aria-disabled', 'true') : b.removeAttribute('aria-disabled')));
}

// What's chosen, to do something with: nothing while something's being
// done already.
function take() {
  if (busy > 0) return null;
  const list = inOrder();
  return list.length ? list : null;
}

function queue(where) {
  const list = take();
  if (!list) return;
  let failed = 0;
  setBusy(true);
  queueTracks(
    async () => {
      const r = await loadTracks(list, queueLimit());
      failed = r.failed;
      return r.tracks;
    },
    where,
    { after: () => failedNote(failed), done: (ok) => ok && release(list) },
  ).finally(() => setBusy(false));
}

function play({ shuffle = false } = {}) {
  const list = take();
  if (!list) return;
  const what = describe(list);
  setBusy(true);
  loadTracks(list, queueLimit())
    .then(
      ({ tracks, failed }) => {
        if (!tracks.length) return toast('There are no tracks to play.');
        release(list);
        playList(tracks, 0, { title: what, href: null }, { shuffle });
        toast(`Playing${failedNote(failed)}`);
      },
      () => toast('Those couldn’t be loaded.'),
    )
    .finally(() => setBusy(false));
}

// Playlists and collections: once one's picked (and it's in). Busy while
// the playlists are got for the sheet, too.
function toPlaylist() {
  const list = take();
  if (!list) return;
  let failed = 0;
  setBusy(true);
  addToPlaylist({
    what: describe(list),
    load: async () => {
      setBusy(true);
      const r = await loadTracks(list, PLAYLIST_LIMIT);
      failed = r.failed;
      return r.tracks;
    },
    after: () => failedNote(failed),
    done: (ok) => {
      setBusy(false);
      if (ok) release(list);
    },
  }).finally(() => setBusy(false));
}

function toCollection(kind) {
  const list = take();
  if (!list) return;
  setBusy(true);
  addToCollection({
    kind,
    what: describe(list),
    load: async () => {
      setBusy(true);
      return list.map((x) => x.item);
    },
    done: (ok) => {
      setBusy(false);
      if (ok) release(list);
    },
  }).finally(() => setBusy(false));
}

function more() {
  if (busy > 0) return;
  const list = inOrder();
  const kinds = new Set(list.map((x) => x.kind));
  const kind = kinds.size === 1 ? [...kinds][0] : null;
  const like = shownFor(anchor);
  const all = like ? siblings(like) : [];
  const allKind = all.length ? ITEMS.get(all[0]).kind : '';
  // (A long list loads as it's scrolled: what's loaded of it so far.)
  const partly = !!like?.parentElement?.nextElementSibling?.classList.contains('sentinel');
  const these = fmt.count(all.length, allKind, `${allKind}s`);
  sheet({
    title: describe(list),
    actions: [
      { icon: 'play', label: 'Play', onSelect: () => play() },
      { icon: 'shuffle', label: 'Shuffle', onSelect: () => play({ shuffle: true }) },
      { icon: 'playNext', label: 'Play next', onSelect: () => queue('next') },
      { icon: 'addQueue', label: 'Add to queue', onSelect: () => queue('end') },
      { icon: 'playlistAdd', label: 'Add to playlist…', onSelect: toPlaylist },
      // Collections are the server admin's (and hold one kind of thing).
      isAdminNow() && kind && { icon: 'collection', label: 'Add to collection…', onSelect: () => toCollection(kind) },
      all.some((el) => !chosen.has(ITEMS.get(el).key)) && {
        icon: 'select',
        label: 'Select all',
        description: partly ? `The ${these} loaded so far in this list` : `All ${these} in this list`,
        onSelect: () => chooseAll(all[0]),
      },
      { icon: 'close', label: 'Stop choosing', onSelect: clearSelection },
    ],
  });
}
