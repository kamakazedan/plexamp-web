import { app, saveSettings, setSource, signOut, proxyUri } from '../state.js';
import { APP_INFO, PlexServer, listServers, pickConnection, clientId, canPlayCodec, canPlayHlsNatively } from '../plex.js';
import { navigate, clearViewCache, describeError } from '../router.js';
import { h, icon, pageHeader, backHeader, row, sheet, spinner, emptyState, errorState, toast, fmt } from '../ui.js';

const REPO_URL = 'https://github.com/kamakazedan/plexamp-web';

// ---------- Settings index ----------

function badge(text) {
  return h('span.badge-circle', { 'aria-hidden': 'true' }, (text || '?').trim().charAt(0).toUpperCase());
}

function avatar(url, name) {
  if (!url) return badge(name);
  const img = h('img.avatar', { src: url, alt: '', loading: 'lazy' });
  img.addEventListener('error', () => img.replaceWith(badge(name)), { once: true });
  return img;
}

export async function settingsView({ el }) {
  const src = app.source;
  const auth = app.auth || {};
  const lead = (name) => h('span.row-icon', null, icon(name, 26));
  el.append(
    pageHeader('Settings'),
    h(
      'div.rows.settings-rows',
      null,
      row({ href: '/settings/account', lead: lead('user'), title: 'Account', subtitle: auth.username || 'Signed in', right: avatar(auth.thumb, auth.username) }),
      row({ href: '/settings/source', lead: lead('note'), title: 'Source', subtitle: src ? `${src.sectionTitle} (${src.serverName})` : 'Not chosen', right: badge(src?.serverName) }),
      row({ href: '/settings/appearance', lead: lead('palette'), title: 'Appearance', subtitle: 'Colours and backgrounds' }),
      row({ href: '/settings/playback', lead: lead('speaker'), title: 'Playback', subtitle: 'Quality, gapless and play history' }),
      row({ href: '/settings/debug', lead: lead('terminal'), title: 'Connection', subtitle: 'Server address and diagnostics' }),
      row({ href: '/settings/about', lead: lead('info'), title: 'About', subtitle: `Version ${APP_INFO.version}` }),
    ),
  );
}

export async function settingsPageView(ctx) {
  const pages = { account: accountView, source: sourceView, appearance: appearanceView, playback: playbackView, debug: debugView, about: aboutView };
  const view = pages[ctx.params.page];
  if (!view) throw Object.assign(new Error('Not found'), { status: 404 });
  return view(ctx);
}

// ---------- Account ----------

function accountView({ el }) {
  const auth = app.auth || {};
  el.append(
    backHeader('Account', { fallback: '/settings' }),
    h(
      'div.account-card',
      null,
      h('div.account-avatar', null, avatar(auth.thumb, auth.username)),
      h('div.account-name', null, auth.username || 'Plex user'),
      h('div.account-sub', null, auth.manual ? 'Connected with a server token' : 'Signed in with your Plex account'),
      h(
        'button.btn.btn-secondary',
        {
          type: 'button',
          onclick: () =>
            sheet({
              title: 'Sign out?',
              subtitle: 'Your queue and settings on this device are cleared.',
              actions: [
                {
                  icon: 'signOut',
                  label: 'Sign out',
                  danger: true,
                  onSelect: () => {
                    signOut();
                    clearViewCache();
                    navigate('/login', { replace: true });
                  },
                },
              ],
            }),
        },
        icon('signOut', 20),
        h('span', null, 'Sign out'),
      ),
    ),
  );
}

// ---------- Source (server + library) ----------

export async function sourceView({ el, firstRun = false }) {
  el.append(firstRun ? pageHeader('Choose your music') : backHeader('Source', { fallback: '/settings' }));
  if (firstRun) el.append(h('p.lede', null, 'Pick the Plex server and music library to play from. You can change this later in Settings.'));
  const body = h('div.source-body');
  el.append(body);
  await showServers(body);
}

async function showServers(body) {
  body.replaceChildren(spinner('Finding your servers'));
  const auth = app.auth;
  const entries = [];
  const proxy = proxyUri();
  if (proxy) entries.push({ kind: 'proxy', name: 'Server set up for this app', uri: proxy, token: auth.token, connections: [] });

  let servers = [];
  let listError = null;
  if (!auth.manual) {
    try {
      servers = await listServers(auth.token);
    } catch (err) {
      listError = err;
    }
  }
  entries.push(...servers.map((s) => ({ ...s, kind: 'discovered' })));

  const list = h('div.rows');
  for (const s of entries) {
    const sub = h('span', null, s.kind === 'proxy' ? 'Connects through this container' : s.owned ? 'Your server' : s.sharedBy ? `Shared by ${s.sharedBy}` : 'Shared with you');
    const r = row({ onClick: () => connect(s, r, sub, body, servers), lead: h('span.row-icon', null, icon('server', 26)), title: s.name, subtitle: sub, chevron: true });
    if (app.source?.serverId && app.source.serverId === s.id) r.classList.add('is-selected');
    list.append(r);
  }
  list.append(
    row({
      onClick: () => manualForm(body, servers),
      lead: h('span.row-icon', null, icon('external', 26)),
      title: 'Enter a server address',
      subtitle: 'For servers on your network that Plex can’t find',
      chevron: true,
    }),
  );

  body.replaceChildren();
  if (listError) body.append(errorState(`Couldn't load your servers from plex.tv. ${describeError(listError)}`, () => showServers(body)));
  else if (!entries.length) body.append(emptyState('No Plex servers are linked to this account. You can still enter a server address below.'));
  body.append(list);
}

function manualForm(body, servers) {
  const url = h('input', { type: 'url', placeholder: 'http://192.168.1.10:32400', required: true, autocomplete: 'url', 'aria-label': 'Server address' });
  const go = h('button.btn.btn-primary', { type: 'submit' }, 'Connect');
  const form = h(
    'form.form',
    {
      onsubmit: (e) => {
        e.preventDefault();
        const uri = url.value.trim().replace(/\/+$/, '');
        if (!/^https?:\/\//.test(uri)) return toast('Start the address with http:// or https://');
        connect({ kind: 'manual', name: new URL(uri).hostname, uri, token: app.auth.token, connections: [] }, null, null, body, servers);
      },
    },
    h('label.field', null, h('span', null, 'Server address'), url),
    h('p.hint', null, 'Use the address you’d type to reach Plex on this network, including the port (usually 32400).'),
    h('div.form-actions', null, h('button.btn.btn-secondary', { type: 'button', onclick: () => showServers(body) }, 'Back'), go),
  );
  body.replaceChildren(form);
  url.focus();
}

async function connect(entry, rowEl, subEl, body, servers) {
  const prevText = subEl?.textContent;
  if (subEl) subEl.textContent = 'Connecting…';
  rowEl?.setAttribute('aria-busy', 'true');
  try {
    let conn;
    let token = entry.token;
    let serverId = entry.id;
    let name = entry.name;
    if (entry.kind === 'discovered') {
      conn = await pickConnection(entry);
      if (!conn) throw Object.assign(new Error('unreachable'), { unreachable: true });
    } else {
      conn = { uri: entry.uri, kind: entry.kind };
    }
    let ps = new PlexServer({ uri: conn.uri, token });
    const root = await ps.get('/', null, { timeout: 8000 });
    if (entry.kind !== 'discovered') {
      serverId = root.machineIdentifier || entry.uri;
      name = root.friendlyName || name;
      // A shared server needs its own access token rather than the account token.
      const match = servers.find((s) => s.id === serverId);
      if (match && match.token !== token) {
        token = match.token;
        ps = new PlexServer({ uri: conn.uri, token });
      }
    }
    const sections = await ps.musicSections();
    showLibraries(body, { conn, token, serverId, name, connections: entry.connections || [] }, sections, servers);
  } catch (err) {
    if (subEl) subEl.textContent = prevText;
    rowEl?.removeAttribute('aria-busy');
    if (err.unreachable || err.network) {
      toast(`Can't reach ${entry.name} from this browser. Check it's online, and that remote access is on or the address is right.`, { timeout: 6000 });
    } else {
      toast(describeError(err));
    }
  }
}

function showLibraries(body, srv, sections, servers) {
  const list = h('div.rows');
  if (!sections.length) {
    body.replaceChildren(
      emptyState(`${srv.name} has no music libraries.`, h('button.btn.btn-secondary', { type: 'button', onclick: () => showServers(body) }, 'Choose another server')),
    );
    return;
  }
  for (const sec of sections) {
    list.append(
      row({
        onClick: () => {
          setSource({
            serverId: srv.serverId,
            serverName: srv.name,
            uri: srv.conn.uri,
            kind: srv.conn.kind,
            token: srv.token,
            connections: srv.connections,
            sectionKey: String(sec.key),
            sectionTitle: sec.title,
          });
          clearViewCache();
          navigate('/', { replace: true });
        },
        lead: h('span.row-icon', null, icon('library', 26)),
        title: sec.title,
        subtitle: srv.name,
        chevron: true,
      }),
    );
  }
  body.replaceChildren(
    h('div.source-step', null, h('button.link-btn', { type: 'button', onclick: () => showServers(body) }, icon('back', 18), h('span', null, 'All servers'))),
    h('div.section-head', null, h('h2', null, `Libraries on ${srv.name}`)),
    list,
  );
}

// Quick library switcher behind "on <server>" on the home screen.
export async function openSourceSheet() {
  let sections = [];
  try {
    sections = await app.server.musicSections();
  } catch {
    /* still offer "change server" */
  }
  sheet({
    title: app.source.serverName,
    subtitle: 'Music libraries',
    actions: [
      ...sections.map((sec) => ({
        icon: 'library',
        label: sec.title,
        checked: String(sec.key) === String(app.source.sectionKey),
        onSelect: () => {
          if (String(sec.key) === String(app.source.sectionKey)) return;
          setSource({ ...app.source, sectionKey: String(sec.key), sectionTitle: sec.title });
          clearViewCache();
          navigate('/', { replace: true });
        },
      })),
      { icon: 'server', label: 'Change server…', onSelect: () => navigate('/settings/source') },
    ],
  });
}

// ---------- Appearance ----------

function toggleRow({ title, subtitle, checked, onChange }) {
  const input = h('input.switch', { type: 'checkbox', role: 'switch', checked, onchange: (e) => onChange(e.target.checked) });
  return h('label.row.toggle-row', null, h('div.row-main', null, h('div.row-title', null, title), subtitle ? h('div.row-sub', null, subtitle) : null), input);
}

function appearanceView({ el }) {
  el.append(
    backHeader('Appearance', { fallback: '/settings' }),
    h(
      'div.rows',
      null,
      toggleRow({
        title: 'Colour from artwork',
        subtitle: 'Tint the background and player with colours from the album that’s playing.',
        checked: app.settings.tintBackground,
        onChange: (v) => saveSettings({ tintBackground: v }),
      }),
    ),
  );
}

// ---------- Playback ----------

const QUALITIES = [
  ['original', 'Original', 'Plays your files as they are. Formats your browser can’t play are converted by your server.'],
  ['320', 'High (320 kbps)', 'Converted by your server. Good for slower connections.'],
  ['192', 'Normal (192 kbps)', 'Converted by your server. Uses less data.'],
  ['128', 'Data saver (128 kbps)', 'Converted by your server. Uses the least data.'],
];

function playbackView({ el }) {
  const qualityList = h('div.rows', { role: 'radiogroup', 'aria-label': 'Streaming quality' });
  const renderQuality = () =>
    qualityList.replaceChildren(
      ...QUALITIES.map(([value, label, hint]) =>
        h(
          'button.row.radio-row',
          { type: 'button', role: 'radio', 'aria-checked': String(app.settings.quality === value), onclick: () => { saveSettings({ quality: value }); renderQuality(); } },
          h('div.row-main', null, h('div.row-title', null, label), h('div.row-sub', null, hint)),
          app.settings.quality === value ? icon('check', 24, 'radio-check') : h('span.radio-empty'),
        ),
      ),
    );
  renderQuality();
  el.append(
    backHeader('Playback', { fallback: '/settings' }),
    h('div.section-head', null, h('h2', null, 'Streaming quality')),
    qualityList,
    h('div.section-head', null, h('h2', null, 'Playback')),
    h(
      'div.rows',
      null,
      toggleRow({
        title: 'Gapless playback',
        subtitle: 'Loads the next track early so albums flow without a pause.',
        checked: app.settings.gapless,
        onChange: (v) => saveSettings({ gapless: v }),
      }),
      toggleRow({
        title: 'Report plays to Plex',
        subtitle: 'Updates play counts, recent plays and what’s playing on your Plex dashboard.',
        checked: app.settings.reportPlays,
        onChange: (v) => saveSettings({ reportPlays: v }),
      }),
    ),
  );
}

// ---------- Connection / diagnostics ----------

function debugView({ el }) {
  const src = app.source || {};
  const kv = (k, v) => h('div.kv', null, h('div.kv-k', null, k), h('div.kv-v', null, v ?? '—'));
  const kinds = { local: 'Local network', remote: 'Remote', relay: 'Plex relay (limited speed)', manual: 'Address you entered', proxy: 'Through this container' };
  const support = ['flac', 'alac', 'mp3', 'aac', 'opus']
    .map((c) => `${fmt.codec(c)} ${canPlayCodec(c) ? 'yes' : 'no'}`)
    .concat(`HLS ${canPlayHlsNatively() ? 'built in' : 'via hls.js'}`)
    .join(', ');
  const status = h('div.kv-v', null, 'Not tested');
  el.append(
    backHeader('Connection', { fallback: '/settings' }),
    h(
      'div.kv-list',
      null,
      kv('Server', src.serverName),
      kv('Library', src.sectionTitle),
      kv('Address', src.uri),
      kv('Connection', kinds[src.kind] || src.kind),
      h('div.kv', null, h('div.kv-k', null, 'Response time'), status),
      kv('Browser formats', support),
      kv('Client ID', clientId()),
      kv('App version', APP_INFO.version),
    ),
    h(
      'div.pad.button-row',
      null,
      h(
        'button.btn.btn-secondary',
        {
          type: 'button',
          onclick: async () => {
            status.textContent = 'Testing…';
            const t0 = performance.now();
            try {
              await app.server.identity({ timeout: 8000 });
              status.textContent = `${Math.round(performance.now() - t0)} ms`;
            } catch (err) {
              status.textContent = describeError(err);
            }
          },
        },
        icon('refresh', 20),
        h('span', null, 'Test connection'),
      ),
      h('button.btn.btn-secondary', { type: 'button', onclick: () => navigate('/settings/source') }, icon('server', 20), h('span', null, 'Change server')),
    ),
  );
}

// ---------- About ----------

function aboutView({ el }) {
  el.append(
    backHeader('About', { fallback: '/settings' }),
    h(
      'div.about',
      null,
      h('img.about-mark', { src: 'icons/icon.svg', alt: '', width: 72, height: 72 }),
      h('div.about-name', null, APP_INFO.product),
      h('div.about-version', null, `Version ${APP_INFO.version}`),
      h('p', null, 'An unofficial web player for Plex music libraries. It is not made, endorsed or supported by Plex.'),
      h('a.btn.btn-secondary', { href: REPO_URL, target: '_blank', rel: 'noopener' }, icon('external', 20), h('span', null, 'Project on GitHub')),
    ),
  );
}
