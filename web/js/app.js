// Entry point: wires the router, shell, player bar and backdrop together.
import { app, setSource, on } from './state.js';
import { PlexServer, listServers, pickConnection } from './plex.js';
import { route, startRouter, navigate, goTab, parseHash, refresh } from './router.js';
import { h, icon } from './ui.js';
import { player } from './player.js';
import { initBackdrop } from './backdrop.js';
import { initPlayerBar } from './nowplaying.js';
import { syncCurrent } from './components.js';
import { homeView, recentView } from './views/home.js';
import { libraryView, browseView, playlistsView, tagsView, itemsView } from './views/library.js';
import { albumView, artistView, playlistView, collectionView } from './views/detail.js';
import { searchView, topView, sonicPathView } from './views/search.js';
import { settingsView, settingsPageView, sourceView } from './views/settings.js';
import { loginView } from './views/login.js';

const TABS = [
  { id: 'home', label: 'Home', icon: 'home' },
  { id: 'library', label: 'Library', icon: 'library' },
  { id: 'search', label: 'Search', icon: 'search' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
];

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
      ),
    ),
  );
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
    return;
  } catch (err) {
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

function keyboard() {
  document.addEventListener('keydown', (e) => {
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

function boot() {
  if (app.source && app.auth?.token) {
    app.server = new PlexServer({ uri: app.source.uri, token: app.source.token, name: app.source.serverName, id: app.source.serverId });
  }
  buildTabs(document.getElementById('tabs'));
  initPlayerBar(document.getElementById('player-bar'));
  initBackdrop(player);
  keyboard();
  on('signout', hideBanner);
  on('source', hideBanner);

  startRouter({ mainEl: document.getElementById('main'), changed: onRouteChange });

  if (app.server) {
    player.restore();
    ensureConnection();
  }

  window.addEventListener('online', () => app.server && ensureConnection());
  window.addEventListener('unhandledrejection', (e) => {
    if (e.reason?.aborted) e.preventDefault();
  });
}

boot();
