// Hash router with real history entries, a small view cache so "back" returns
// to the exact page and scroll position, and an overlay stack so the Android
// back button closes sheets and the Now Playing screen first.

const routes = [];
const cache = new Map(); // history key -> { el, hash }
const scrolls = new Map(); // history key -> scrollY
const overlays = []; // close callbacks, top of stack last
const tabRoots = { home: '/', library: '/library', search: '/search', together: '/together', settings: '/settings' };
const tabLast = {};
const CACHE_LIMIT = 16;

let main;
let currentKey = null;
let currentHash = null;
let activeTab = 'home';
let seq = 0;
let waiters = [];
let onChange = () => {};

const newKey = () => `${Date.now().toString(36)}.${seq++}`;

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

export function currentTab() {
  return activeTab;
}

export function startRouter({ mainEl, changed }) {
  main = mainEl;
  onChange = changed || onChange;
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

  window.addEventListener('popstate', (e) => {
    const st = e.state || {};
    const depth = st.ov || 0;
    if (st.t) activeTab = st.t;
    while (overlays.length > depth) overlays.pop()();
    if (!st.k) {
      // A hash typed into the address bar: give it a key of its own.
      history.replaceState({ k: newKey(), t: activeTab }, '');
      render(history.state.k, false);
    } else if (st.k !== currentKey || location.hash !== currentHash) {
      render(st.k, true);
    }
    const w = waiters;
    waiters = [];
    w.forEach((fn) => fn());
  });

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
  const k = st.k || newKey();
  if (st.t) activeTab = st.t;
  history.replaceState({ k, t: activeTab }, '');
  render(k, false);
}

export function navigate(path, { replace = false } = {}) {
  if (overlays.length) {
    // Close sheets/overlays first, then navigate from the page underneath.
    closeOverlays().then(() => navigate(path, { replace }));
    return;
  }
  if (currentKey) scrolls.set(currentKey, window.scrollY);
  const k = newKey();
  history[replace ? 'replaceState' : 'pushState']({ k, t: activeTab }, '', `#${path}`);
  render(k, false);
}

// Update the URL (e.g. a search query) without adding a history entry.
export function replaceQuery(path) {
  history.replaceState({ ...(history.state || {}), k: currentKey }, '', `#${path}`);
  currentHash = location.hash;
  const entry = cache.get(currentKey);
  if (entry) entry.hash = currentHash;
}

export function back(fallback = '/') {
  if (history.length > 1 && cache.size > 1) history.back();
  else navigate(fallback, { replace: true });
}

export function goTab(tab) {
  const root = tabRoots[tab];
  if (tab === activeTab) {
    if (parseHash().path === root) window.scrollTo({ top: 0, behavior: 'smooth' });
    else navigate(root);
  } else {
    activeTab = tab;
    navigate(tabLast[tab] || root);
  }
}

export function clearViewCache() {
  cache.clear();
  scrolls.clear();
  for (const k of Object.keys(tabLast)) delete tabLast[k];
}

export function refresh() {
  cache.delete(currentKey);
  render(currentKey, false);
}

// Forget cached pages (other than the one on screen) whose path matches, so
// going back to them loads fresh data.
export function dropCached(test) {
  for (const [k, entry] of cache) {
    if (k === currentKey) continue;
    if (test(parseHash(entry.hash).path)) cache.delete(k);
  }
}

// ---------- overlays ----------

export function pushOverlay(close) {
  overlays.push(close);
  history.pushState({ ...(history.state || {}), ov: overlays.length }, '');
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

async function render(k, isBack) {
  const { path, query } = parseHash();
  const m = match(path) || match('/404');
  currentKey = k;
  currentHash = location.hash;

  if (m.tab) activeTab = m.tab;
  if (!m.bare) tabLast[activeTab] = path + (location.hash.includes('?') ? `?${location.hash.split('?')[1]}` : '');
  onChange({ path, route: m, tab: activeTab });

  const cached = isBack ? cache.get(k) : null;
  if (cached && cached.hash === location.hash) {
    main.replaceChildren(cached.el);
    const y = scrolls.get(k) || 0;
    requestAnimationFrame(() => window.scrollTo(0, y));
    return;
  }

  const el = document.createElement('div');
  el.className = 'view';
  cache.set(k, { el, hash: location.hash });
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
  main.replaceChildren(el);
  window.scrollTo(0, 0);

  try {
    await m.view({ params: m.params, query, path, el, key: k });
  } catch (err) {
    console.error(err);
    if (!el.querySelector('.error-state')) {
      const box = document.createElement('div');
      box.className = 'error-state';
      box.textContent = describeError(err);
      el.append(box);
    }
  }
  if (isBack && scrolls.has(k)) requestAnimationFrame(() => window.scrollTo(0, scrolls.get(k)));
}

export function describeError(err) {
  if (err?.network) return "Can't reach your Plex server. Check that it's online and that this device can connect to it.";
  if (err?.status === 401) return 'Plex rejected this sign-in. Sign out and sign in again.';
  if (err?.status === 404) return 'This item no longer exists on your server.';
  if (err?.status) return `Your server returned an error (${err.status}).`;
  return err?.message || 'Something went wrong.';
}
