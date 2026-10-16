// Hash router that works like a phone app's tabs. Each tab keeps its own
// stack of pages, and Back (the page's back arrow, the browser's, or
// Android's) goes back within the tab you're in. Switching tabs returns to
// where you left that tab, and Back from a tab's first page goes to Home.
//
// To make the browser's own Back do the same, the browser history is kept
// equal to Home's stack, then the current tab's stack (when it isn't Home),
// then any open overlays (sheets, Now Playing). Switching tabs steps back
// over the old tab's pages and puts the new tab's pages in their place.
//
// Recent pages are kept (with their scroll position), so going back or
// returning to a tab shows the exact page again. Kept pages give up their
// pictures while they're off screen, pages nothing can go back to are let
// go, and beyond the last few, kept pages are limited by size, so a long
// session doesn't pile up memory.

const routes = [];
const cache = new Map(); // history key -> { el, hash, disposers }, least recently shown first
const scrolls = new Map(); // history key -> scrollY
const overlays = []; // close callbacks, top of stack last
export const TAB_ROOTS = { home: '/', library: '/library', search: '/search', together: '/together', settings: '/settings' };
const CACHE_LIMIT = 16;
const KEEP_RECENT = 4; // the page on screen and the three before it, whatever their size
const KEPT_ELEMENTS = 60000; // the others, together, up to about this many elements
const MAX_REPUSH = 10; // pages put back in the history when returning to a tab
const NAV_KEY = 'pw.nav';

let stacks = {}; // tab -> { entries: [{ k, hash }], top }
let main;
let currentKey = null;
let currentHash = null;
let currentEntry = null;
let activeTab = 'home';
let fresh = false; // stacks were reset (new library, signed out): the next page starts them again
let seq = 0;
let waiters = [];
let popHook = null; // a tab switch waiting for history.go() to land
let onChange = () => {};

const newKey = () => `${Date.now().toString(36)}.${seq++}`;
const hashOf = (path) => `#${path}`;

// Route parameters come from the address bar, so they're held to what they
// can legitimately be: ids are numbers, everything else plain words.
const PARAM = { id: '(\\d+)', type: '(\\d+)' };

export function route(pattern, view, opts = {}) {
  const keys = [];
  const rx = new RegExp(
    `^${pattern.replace(/\//g, '\\/').replace(/:(\w+)/g, (_, k) => {
      keys.push(k);
      return PARAM[k] || '([A-Za-z0-9_-]+)';
    })}$`,
  );
  routes.push({ rx, keys, view, ...opts });
}

export function parseHash(hash = location.hash) {
  const raw = hash.replace(/^#/, '') || '/';
  const [path, qs = ''] = raw.split('?');
  return { path: path || '/', query: Object.fromEntries(new URLSearchParams(qs)) };
}

function match(path) {
  for (const r of routes) {
    const m = path.match(r.rx);
    if (m) {
      const params = {};
      r.keys.forEach((k, i) => (params[k] = m[i + 1]));
      return { ...r, params };
    }
  }
  return null;
}

// The tab a page belongs to: its route's own, 'bare' for sign-in pages, or
// null for pages that open in whichever tab you're in (albums, artists...).
function tabFor(hash) {
  const m = match(parseHash(hash).path);
  if (m?.bare) return 'bare';
  return m?.tab || null;
}

export function currentTab() {
  return activeTab;
}

// ---------- the stacks ----------

const stackOf = (tab) => (stacks[tab] ||= { entries: [], top: -1 });
const topOf = (tab) => {
  const s = stacks[tab];
  return s && s.top >= 0 ? s.entries[s.top] : null;
};

function save() {
  try {
    sessionStorage.setItem(NAV_KEY, JSON.stringify({ stacks, activeTab }));
  } catch {
    /* storage unavailable: Back still works until a reload */
  }
}

function loadSaved() {
  try {
    const v = JSON.parse(sessionStorage.getItem(NAV_KEY));
    return v && typeof v.stacks === 'object' && v.stacks ? v : null;
  } catch {
    return null;
  }
}

// Browsers limit how often history can be changed (Safari: 100 times in 30
// seconds), so a refusal is caught rather than breaking navigation.
function setHistory(method, state, hash) {
  try {
    history[method](state, '', hash);
    return true;
  } catch {
    return false;
  }
}

function pushEntry(tab, hash) {
  const s = stackOf(tab);
  const k = newKey();
  s.entries.length = s.top + 1; // a new page drops what was "forward"
  s.entries.push({ k, hash });
  s.top += 1;
  if (!setHistory('pushState', { k, t: tab, d: s.top }, hash)) setHistory('replaceState', { k, t: tab, d: s.top }, hash);
  save();
  return k;
}

function replaceEntry(tab, hash) {
  const s = stackOf(tab);
  const k = newKey();
  if (s.top < 0) s.top = 0;
  s.entries[s.top] = { k, hash };
  setHistory('replaceState', { k, t: tab, d: s.top }, hash);
  save();
  return k;
}

// Start the stacks again from the page on screen (with Home below it when
// it's in another tab), so Back behaves from the very first page.
function startStacks(tab, hash, { replace = true } = {}) {
  stacks = {};
  fresh = false;
  activeTab = tab;
  const plan = [];
  if (tab !== 'home') plan.push(['home', hashOf(TAB_ROOTS.home)]);
  if (parseHash(hash).path !== TAB_ROOTS[tab]) plan.push([tab, hashOf(TAB_ROOTS[tab])]);
  plan.push([tab, hash]);
  plan.forEach(([t, h], i) => {
    const s = stackOf(t);
    const k = newKey();
    s.entries.push({ k, hash: h });
    s.top = s.entries.length - 1;
    setHistory(i === 0 && replace ? 'replaceState' : 'pushState', { k, t, d: s.top }, h);
  });
  save();
  return topOf(tab).k;
}

// ---------- start ----------

export function startRouter({ mainEl, changed }) {
  main = mainEl;
  onChange = changed || onChange;
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  window.addEventListener('popstate', onPop);

  // Same-page links (<a href="#/album/1">) go through navigate() so every
  // entry carries a key.
  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest('a[href^="#/"]');
    if (!a || a.target === '_blank') return;
    e.preventDefault();
    navigate(a.getAttribute('href').slice(1));
  });

  const st = history.state || {};
  const saved = loadSaved();
  // A reload: the history and the stacks are as they were.
  if (saved && st.k && st.t && st.t !== 'bare' && saved.stacks[st.t]?.entries?.[st.d]?.k === st.k) {
    stacks = saved.stacks;
    activeTab = st.t;
    stacks[st.t].top = st.d;
    save();
    render(st.k, false);
    return;
  }
  const hash = location.hash || hashOf('/');
  const tab = tabFor(hash);
  if (tab === 'bare') {
    stacks = {};
    fresh = true;
    const k = newKey();
    setHistory('replaceState', { k, t: 'bare', d: 0 }, hash);
    render(k, false);
    return;
  }
  render(startStacks(tab || 'home', hash), false);
}

// ---------- moving around ----------

export function navigate(path, { replace = false } = {}) {
  if (overlays.length) {
    // Close sheets/overlays first, then navigate from the page underneath.
    closeOverlays().then(() => navigate(path, { replace }));
    return;
  }
  if (currentKey) scrolls.set(currentKey, window.scrollY);
  const hash = hashOf(path);
  const own = tabFor(hash);
  if (own === 'bare') {
    stacks = {};
    fresh = true;
    save();
    const k = newKey();
    setHistory(replace ? 'replaceState' : 'pushState', { k, t: 'bare', d: 0 }, hash);
    render(k, false);
    return;
  }
  const tab = own || (activeTab === 'bare' ? 'home' : activeTab);
  if (fresh || !stacks[activeTab]) {
    // Starting over: after signing in, or after switching library.
    render(startStacks(tab, hash, { replace }), false);
    return;
  }
  if (tab !== activeTab) {
    switchTab(tab, { push: hash });
    return;
  }
  render(replace ? replaceEntry(tab, hash) : pushEntry(tab, hash), false);
}

// Update the URL (e.g. a search query) without adding a history entry.
export function replaceQuery(path) {
  setHistory('replaceState', { ...(history.state || {}) }, hashOf(path));
  currentHash = location.hash;
  const top = topOf(activeTab);
  if (top && top.k === currentKey) {
    top.hash = currentHash;
    save();
  }
  const entry = cache.get(currentKey);
  if (entry) entry.hash = currentHash;
}

// The page's own back arrow: back within this tab, or to `fallback` if this
// is the first page here.
export function back(fallback = '/') {
  if (overlays.length) {
    popOverlay();
    return;
  }
  if ((stacks[activeTab]?.top ?? 0) > 0) history.back();
  else navigate(fallback, { replace: true });
}

// A tab in the tab bar: switch to it, or, if it's the one you're in, go
// back to its first page (or scroll to the top there).
export function goTab(tab) {
  if (overlays.length) {
    closeOverlays().then(() => goTab(tab));
    return;
  }
  if (tab === activeTab && stacks[tab]) {
    const top = stacks[tab].top;
    if (top <= 0) window.scrollTo({ top: 0, behavior: 'smooth' });
    else history.go(-top);
    return;
  }
  if (currentKey) scrolls.set(currentKey, window.scrollY);
  switchTab(tab);
}

// history.go() is asynchronous: carry on when it lands (or after a moment,
// if the browser had nothing to go back to).
function goBy(delta, then) {
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    popHook = null;
    then();
  };
  const timer = setTimeout(finish, 1000);
  popHook = finish;
  history.go(delta);
}

function switchTab(tab, { push = null } = {}) {
  const from = activeTab;
  // The old tab's pages sit on top of Home's in the history: step back over them.
  const drop = from !== 'home' && stacks[from] ? stacks[from].top + 1 : 0;
  const land = () => {
    activeTab = tab;
    const s = stackOf(tab);
    if (s.top < 0) {
      s.entries = [{ k: newKey(), hash: hashOf(TAB_ROOTS[tab]) }];
      s.top = 0;
      if (tab === 'home') setHistory('pushState', { k: s.entries[0].k, t: tab, d: 0 }, s.entries[0].hash);
    }
    if (tab !== 'home') {
      if (s.top >= MAX_REPUSH) {
        // A very deep stack comes back as its first page plus the most recent ones.
        const keep = [s.entries[0], ...s.entries.slice(s.top - (MAX_REPUSH - 2), s.top + 1)];
        for (const e of s.entries.slice(1, s.top - (MAX_REPUSH - 2))) dropEntry(e.k);
        s.entries = keep;
        s.top = keep.length - 1;
      }
      for (let i = 0; i <= s.top; i++) {
        if (!setHistory('pushState', { k: s.entries[i].k, t: tab, d: i }, s.entries[i].hash)) {
          s.entries.length = i;
          s.top = i - 1;
          break;
        }
      }
    }
    if (push && topOf(tab)?.hash !== push) pushEntry(tab, push);
    save();
    const top = topOf(tab);
    if (top) render(top.k, true);
  };
  if (drop) goBy(-drop, land);
  else land();
}

function onPop(e) {
  const st = e.state || {};
  if (popHook) {
    popHook();
    return;
  }
  const depth = st.ov || 0;
  while (overlays.length > depth) overlays.pop()();
  if (!st.k) {
    // A hash typed into the address bar: a new page, in the tab it belongs to.
    const hash = location.hash || hashOf('/');
    const own = tabFor(hash);
    if (own === 'bare') {
      fresh = true;
      setHistory('replaceState', { k: newKey(), t: 'bare', d: 0 }, hash);
    } else {
      const tab = own || activeTab;
      const s = stackOf(tab);
      const k = newKey();
      if (tab === activeTab) {
        s.entries.length = s.top + 1;
        s.entries.push({ k, hash });
        s.top += 1;
      } else {
        stacks[tab] = { entries: [{ k, hash }], top: 0 };
        activeTab = tab;
      }
      setHistory('replaceState', { k, t: tab, d: stacks[tab].top }, hash);
      save();
    }
    render(history.state.k, false);
  } else {
    if (st.t && st.t !== 'bare') {
      const s = stacks[st.t];
      if (s && s.entries[st.d]?.k === st.k) s.top = st.d;
      else stacks[st.t] = { entries: [{ k: st.k, hash: location.hash }], top: 0 }; // an old entry: carry on from it
      activeTab = st.t;
      save();
    }
    if (st.k !== currentKey || location.hash !== currentHash) render(st.k, true);
  }
  const w = waiters;
  waiters = [];
  w.forEach((fn) => fn());
}

// ---------- the page cache ----------

function dropEntry(k) {
  const entry = cache.get(k);
  if (!entry) return;
  cache.delete(k);
  scrolls.delete(k);
  for (const fn of entry.disposers) {
    try {
      fn();
    } catch {
      /* a view's own clean-up failing shouldn't stop the others */
    }
  }
}

export function clearViewCache() {
  for (const k of [...cache.keys()]) if (k !== currentKey) dropEntry(k);
  scrolls.clear();
  stacks = {};
  fresh = true;
  save();
}

export function refresh() {
  dropEntry(currentKey);
  render(currentKey, false);
}

// Forget kept pages (other than the one on screen) whose path matches, so
// going back to them loads fresh data.
export function dropCached(test) {
  for (const [k, entry] of [...cache]) {
    if (k === currentKey) continue;
    if (test(parseHash(entry.hash).path)) dropEntry(k);
  }
}

// Pages that no tab can go back to (replaced, or dropped from a tab's
// history) are let go.
function prune() {
  const reachable = new Set([currentKey]);
  for (const s of Object.values(stacks)) for (const e of s.entries) reachable.add(e.k);
  for (const k of [...cache.keys()]) if (!reachable.has(k)) dropEntry(k);
}

// Beyond the most recent few, kept pages are let go once together they're
// bigger than the budget (a list scrolled a long way can be huge). Least
// recently shown go first.
function trim() {
  const keys = [...cache.keys()];
  let total = 0;
  for (let i = keys.length - 1 - KEEP_RECENT; i >= 0; i--) {
    const entry = cache.get(keys[i]);
    if (keys[i] === currentKey) continue;
    total += entry.size || 0;
    if (total > KEPT_ELEMENTS) {
      total -= entry.size || 0;
      dropEntry(keys[i]);
    }
  }
}

// Pictures of a page that's kept but not shown are let go (their address is
// kept), and come back from the browser's cache when it's shown again.
function releaseImages(root) {
  for (const img of root.querySelectorAll('img[src]')) {
    img.dataset.keptSrc = img.getAttribute('src');
    img.removeAttribute('src');
  }
}

function restoreImages(root) {
  for (const img of root.querySelectorAll('img[data-kept-src]')) {
    img.setAttribute('src', img.dataset.keptSrc);
    delete img.dataset.keptSrc;
  }
}

function show(entry) {
  const prev = currentEntry;
  if (prev && prev !== entry && prev.el.isConnected) {
    for (const fn of prev.hiders) {
      try {
        fn();
      } catch {
        /* a view's own hook failing shouldn't stop the page changing */
      }
    }
    releaseImages(prev.el);
    prev.size = prev.el.getElementsByTagName('*').length;
  }
  restoreImages(entry.el);
  main.replaceChildren(entry.el);
  currentEntry = entry;
  prune();
  trim();
}

// ---------- overlays ----------

export function pushOverlay(close) {
  overlays.push(close);
  setHistory('pushState', { ...(history.state || {}), ov: overlays.length }, location.hash);
}

// Called by an overlay's own close button: step back through history so the
// entry it pushed is consumed.
export function popOverlay() {
  if (!overlays.length) return Promise.resolve();
  return new Promise((resolve) => {
    waiters.push(resolve);
    history.back();
  });
}

export function closeOverlays() {
  if (!overlays.length) return Promise.resolve();
  return new Promise((resolve) => {
    waiters.push(resolve);
    history.go(-overlays.length);
  });
}

export function overlayDepth() {
  return overlays.length;
}

// ---------- rendering ----------

async function render(k, useCache) {
  const { path, query } = parseHash();
  const m = match(path) || match('/404');
  currentKey = k;
  currentHash = location.hash;
  onChange({ path, route: m, tab: activeTab });

  const cached = useCache ? cache.get(k) : null;
  if (cached && cached.hash === location.hash) {
    // Most recently shown last, so the least recently shown is dropped first.
    cache.delete(k);
    cache.set(k, cached);
    show(cached);
    const y = scrolls.get(k) || 0;
    requestAnimationFrame(() => window.scrollTo(0, y));
    return;
  }
  dropEntry(k);

  const el = document.createElement('div');
  el.className = 'view';
  const entry = { el, hash: location.hash, disposers: [], hiders: [], size: 0 };
  cache.set(k, entry);
  while (cache.size > CACHE_LIMIT) dropEntry(cache.keys().next().value);
  show(entry);
  window.scrollTo(0, 0);

  try {
    // onDispose: for a view's own listeners and timers, run when the page
    // is no longer kept. onHide: run each time the page is put aside (a
    // playlist unlocked for editing locks again, say).
    await m.view({
      params: m.params,
      query,
      path,
      el,
      key: k,
      onDispose: (fn) => entry.disposers.push(fn),
      onHide: (fn) => entry.hiders.push(fn),
    });
  } catch (err) {
    console.error(err);
    if (!el.querySelector('.error-state')) {
      const box = document.createElement('div');
      box.className = 'error-state';
      box.textContent = describeError(err);
      el.append(box);
    }
  }
}

export function describeError(err) {
  if (err?.network) return "Can't reach your Plex server. Check that it's online and that this device can connect to it.";
  if (err?.status === 401) return 'Plex rejected this sign-in. Sign out and sign in again.';
  if (err?.status === 404) return 'This item no longer exists on your server.';
  if (err?.status) return `Your server returned an error (${err.status}).`;
  return err?.message || 'Something went wrong.';
}
