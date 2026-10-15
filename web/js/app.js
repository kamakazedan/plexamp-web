// Entry point: wires the router, shell, player bar and backdrop together.
import './debug.js';
import { app, setSource, on } from './state.js';
import { PlexServer, listServers, pickConnection } from './plex.js';
import { route, startRouter, navigate, goTab, parseHash, refresh, dropCached, overlayDepth } from './router.js';
import { h, icon } from './ui.js';
import { player } from './player.js';
import { initBackdrop } from './backdrop.js';
import { initPlayerBar } from './nowplaying.js';
import { syncCurrent } from './components.js';
import { homeView, recentView } from './views/home.js';
import { libraryView, browseView, playlistsView, tagsView, itemsView } from './views/library.js';
import { albumView, artistView, playlistView, collectionView } from './views/detail.js';
import { searchView, topView, sonicPathView } from './views/search.js';
import { aiPlaylistView } from './views/aiplaylist.js';
import { live } from './live.js';
import './dj.js';
import { settingsView, settingsPageView, sourceView } from './views/settings.js';
import { loginView } from './views/login.js';
import { togetherView } from './views/together.js';
import { together } from './together.js';
import { debugLog } from './debug.js';

const TABS = [
  { id: 'home', label: 'Home', icon: 'home' },
  { id: 'library', label: 'Library', icon: 'library' },
  { id: 'search', label: 'Search', icon: 'search' },
  app.config.together && { id: 'together', label: 'Together', icon: 'together' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
].filter(Boolean);

// Views that need a signed-in user and a chosen library.
const needsSource = (view) => async (ctx) => {
  if (!app.auth?.token) return navigate('/login', { replace: true });
  if (!app.source || !app.server) return navigate('/setup', { replace: true });
  return view(ctx);
};

route('/', needsSource(homeView), { tab: 'home' });
route('/recent', needsSource(recentView), { tab: 'home' });
route('/library', needsSource(libraryView), { tab: 'library' });
route('/library/playlists', needsSource(playlistsView), { tab: 'library' });
route('/browse/:kind', needsSource(browseView), { tab: 'library' });
route('/tags/:field/:type', needsSource(tagsView), { tab: 'library' });
route('/items', needsSource(itemsView), { tab: 'library' });
route('/album/:id', needsSource(albumView));
route('/artist/:id', needsSource(artistView));
route('/playlist/:id', needsSource(playlistView));
route('/collection/:id', needsSource(collectionView));
route('/search', needsSource(searchView), { tab: 'search' });
route('/top/:kind', needsSource(topView), { tab: 'search' });
route('/sonic-path', needsSource(sonicPathView), { tab: 'search' });
route('/ai-playlist', needsSource(aiPlaylistView), { tab: 'search' });
route('/together', needsSource(togetherView), { tab: 'together' });
route('/together/:session', needsSource(togetherView), { tab: 'together' });
route('/settings', needsSource(settingsView), { tab: 'settings' });
route('/settings/:page', needsSource(settingsPageView), { tab: 'settings' });
route('/login', (ctx) => (app.auth?.token && app.source ? navigate('/', { replace: true }) : loginView(ctx)), { bare: true });
route(
  '/setup',
  (ctx) => (app.auth?.token ? sourceView({ ...ctx, firstRun: true }) : navigate('/login', { replace: true })),
  { bare: true },
);
route('/404', ({ el }) => el.append(h('div.empty-state', null, h('p', null, 'This page doesn’t exist.'), h('a.btn.btn-secondary', { href: '#/' }, 'Go home'))));

function buildTabs(nav) {
  nav.replaceChildren(
    ...TABS.map((t) =>
      h(
        'a.tab',
        {
          href: `#${t.id === 'home' ? '/' : `/${t.id}`}`,
          dataset: { tab: t.id },
          'aria-label': t.label,
          onclick: (e) => {
            e.preventDefault();
            e.stopPropagation();
            goTab(t.id);
          },
        },
        icon(t.icon, 28),
        h('span.tab-label', null, t.label),
        t.id === 'together' ? h('span.tab-dot', { hidden: true, 'aria-hidden': 'true' }) : null,
      ),
    ),
  );
}

// The Together tab shows a dot for invitations, and a live dot in a session.
function togetherBadge() {
  const dot = document.querySelector('#tabs .tab[data-tab=together] .tab-dot');
  const tab = dot?.parentElement;
  document.body.classList.toggle('in-together', together.active);
  if (!dot) return;
  const invited = together.invites.length > 0;
  dot.hidden = !invited && !together.active;
  dot.classList.toggle('live', together.active && !invited);
  tab.setAttribute('aria-label', invited ? `Together, ${together.invites.length} invitation${together.invites.length > 1 ? 's' : ''}` : together.active ? 'Together, in a session' : 'Together');
}

function onRouteChange({ route: r, tab }) {
  document.body.classList.toggle('bare', !!r.bare);
  document.querySelectorAll('#tabs .tab').forEach((a) => {
    const active = a.dataset.tab === tab;
    a.classList.toggle('active', active);
    if (active) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  requestAnimationFrame(() => syncCurrent());
}

// Check the saved server still answers; if not, look for another route to
// it (e.g. we left the house and the local address stopped working).
async function ensureConnection() {
  const src = app.source;
  if (!src || !app.server) return;
  try {
    await app.server.identity({ timeout: 5000 });
    debugLog('connection', `${src.serverName} answers at ${src.kind === 'proxy' ? 'this container’s /pms/ proxy' : `a ${src.kind} address`}`);
    return;
  } catch (err) {
    debugLog('connection', `${src.serverName} didn’t answer (${err.status || 'network error'}); looking for another address`, 'warn');
    if (err.status === 401) {
      showBanner('Plex rejected the saved sign-in.', 'Sign in again', () => navigate('/settings/account'));
      return;
    }
  }
  if (!app.auth?.manual && ['local', 'remote', 'relay'].includes(src.kind)) {
    try {
      const servers = await listServers(app.auth.token);
      const srv = servers.find((s) => s.id === src.serverId);
      const conn = srv && (await pickConnection(srv));
      if (conn) {
        debugLog('connection', `switched ${src.serverName} to a ${conn.kind} address`);
        setSource({ ...src, uri: conn.uri, kind: conn.kind, token: srv.token, connections: srv.connections });
        refresh(); // re-render the current page against the new address
        return;
      }
    } catch {
      /* fall through to the banner */
    }
  }
  showBanner(`Can't reach ${src.serverName}.`, 'Try again', async () => {
    hideBanner();
    await ensureConnection();
  });
}

function showBanner(text, action, onAction) {
  const b = document.getElementById('banner');
  b.replaceChildren(h('span', null, text), h('button.banner-action', { type: 'button', onclick: onAction }, action));
  b.hidden = false;
}

function hideBanner() {
  document.getElementById('banner').hidden = true;
}

// ---------- live updates ----------

// Re-render the page on screen only when that won't pull it from under the
// user: they're near the top and nothing is open over it.
function refreshIfIdle(test) {
  const { path } = parseHash();
  if (!test(path) || window.scrollY > 150 || overlayDepth() || document.querySelector('.ai-progress')) return;
  refresh();
}

function wireLiveUpdates() {
  // Long lists keep their cached copy (and scroll position) for the back
  // button; they load fresh the next time they're opened.
  const summaryPages = (p) => p === '/' || p === '/recent' || p === '/library';
  live.addEventListener('library', () => {
    app.server?.cache.clear();
    dropCached(summaryPages);
    refreshIfIdle((p) => p === '/' || p === '/library');
  });
  live.addEventListener('playlists', (e) => {
    app.server?.forgetPlaylists();
    const ids = e.detail.ids.map(String);
    const affected = (p) => p === '/' || p === '/library/playlists' || (p.startsWith('/playlist/') && (!ids.length || ids.includes(p.split('/')[2])));
    dropCached(affected);
    refreshIfIdle(affected);
  });
  live.addEventListener('scan', (e) => {
    document.body.classList.toggle('scanning', !!e.detail);
    document.querySelectorAll('.scan-text').forEach((n) => (n.textContent = e.detail?.title || ''));
  });
}

function keyboard() {
  document.addEventListener('keydown', (e) => {
    if (app.settings.keyboardShortcuts === false) return;
    const t = e.target;
    const typing = t.closest?.('input, textarea, select, [contenteditable="true"]');
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.code === 'Space' && !t.closest?.('button, a')) {
      e.preventDefault();
      player.toggle();
    } else if (e.key === 'ArrowRight' && e.shiftKey) {
      player.next();
    } else if (e.key === 'ArrowLeft' && e.shiftKey) {
      player.prev();
    } else if (e.key === '/' && parseHash().path !== '/search') {
      e.preventDefault();
      navigate('/search');
    }
  });
}

// Text and grid sizes from Settings › Experience.
const FONT_SCALE = { small: 0.9, normal: 1, large: 1.12, larger: 1.25 };
const GRID_SCALE = { small: 0.78, normal: 1, large: 1.3 };
function applyLook() {
  const root = document.documentElement.style;
  root.setProperty('--fs', String(FONT_SCALE[app.settings.fontSize] || 1));
  root.setProperty('--grid', String(GRID_SCALE[app.settings.gridSize] || 1));
  document.body.dataset.grid = app.settings.gridSize || 'normal';
  document.body.classList.toggle('np-side-off', app.settings.sideBySide === false);
  updateTitle();
}

// What's playing in the browser tab's title.
function updateTitle() {
  const t = player.current;
  document.title = app.settings.tabTitle !== false && t ? `${player.isPlaying ? '▶ ' : ''}${t.title} · ${t.artist}` : 'plexamp-web';
}

function boot() {
  if (app.source && app.auth?.token) {
    app.server = new PlexServer({ uri: app.source.uri, token: app.source.token, name: app.source.serverName, id: app.source.serverId });
  }
  applyLook();
  on('settings', applyLook);
  player.addEventListener('track', updateTitle);
  player.addEventListener('state', updateTitle);
  buildTabs(document.getElementById('tabs'));
  together.addEventListener('invites', togetherBadge);
  together.addEventListener('change', togetherBadge);
  initPlayerBar(document.getElementById('player-bar'));
  initBackdrop(player);
  keyboard();
  wireLiveUpdates();
  on('signout', hideBanner);
  on('source', hideBanner);

  startRouter({ mainEl: document.getElementById('main'), changed: onRouteChange });

  if (app.server) {
    player.restore();
    ensureConnection();
    live.start();
    if (app.config.together) {
      together.resume().finally(() => together.watch());
    }
  }
  on('source', () => app.config.together && !together.inviteTimer && together.watch());

  window.addEventListener('online', () => app.server && ensureConnection());
  window.addEventListener('unhandledrejection', (e) => {
    if (e.reason?.aborted) e.preventDefault();
  });
}

boot();
