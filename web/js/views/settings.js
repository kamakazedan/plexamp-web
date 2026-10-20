import { app, on, saveSettings, setSource, signOut, proxyUri } from '../state.js';
import { APP_INFO, PlexServer, listServers, pickConnection, clientId, canPlayCodec, canPlayHlsNatively } from '../plex.js';
import { navigate, clearViewCache, describeError, dropCached } from '../router.js';
import { h, icon, pageHeader, backHeader, row, sheet, spinner, emptyState, errorState, toast, fmt, debounce, toggleRow, choiceRow, avatar as personAvatar } from '../ui.js';
import { live, LIVE_MODES } from '../live.js';
import { aiSettings, sharedAI, aiTarget, listModels, aiVersion, sharedStatus, chat, parseReply, describeAIError, WAIT_CHOICES, aiWaitMinutes } from '../ai.js';
import { experienceView, appearanceView, playerSettingsView, skipTimesView, desktopView, homeEditorView } from './experience.js';
import { missingTracksView } from './missingtracks.js';
import { missingCount, mbOffered, checkOnMusicBrainz } from '../missing.js';
import { together } from '../together.js';
import { canFade } from '../transitions.js';

const REPO_URL = 'https://github.com/kamakazedan/plexamp-web';

// ---------- Settings index ----------

function badge(text) {
  return h('span.badge-circle', { 'aria-hidden': 'true' }, (text || '?').trim().charAt(0).toUpperCase());
}

const avatar = (url, name) => personAvatar(url, name);

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
      row({ href: '/settings/experience', lead: lead('sliders'), title: 'Experience', subtitle: 'Appearance, player, Home screen and more' }),
      row({
        href: '/settings/playback',
        lead: lead('speaker'),
        title: 'Playback',
        subtitle: app.config.devices ? 'Streaming quality, crossfade and your devices' : 'Streaming quality, gapless playback and crossfade',
      }),
      row({ href: '/settings/ai', lead: lead('sparkle'), title: 'AI', subtitle: aiSummary() }),
      row({ href: '/settings/debug', lead: lead('terminal'), title: 'Connection', subtitle: 'Server address and diagnostics' }),
      row({ href: '/settings/about', lead: lead('info'), title: 'About', subtitle: `Version ${APP_INFO.version}` }),
    ),
  );
}

export async function settingsPageView(ctx) {
  const pages = {
    account: accountView,
    source: sourceView,
    experience: experienceView,
    appearance: appearanceView,
    player: playerSettingsView,
    skip: skipTimesView,
    desktop: desktopView,
    home: homeEditorView,
    playback: playbackView,
    ai: aiView,
    missing: missingTracksView,
    debug: debugView,
    about: aboutView,
  };
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
      conn = await pickConnection(entry, { proxy: proxyUri() });
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

// ---------- Playback ----------

const QUALITIES = [
  ['original', 'Original', 'Plays your files as they are. Formats your browser can’t play are converted by your server.'],
  ['320', 'High (320 kbps)', 'Converted by your server. Good for slower connections.'],
  ['192', 'Normal (192 kbps)', 'Converted by your server. Uses less data.'],
  ['128', 'Data saver (128 kbps)', 'Converted by your server. Uses the least data.'],
];

const FADES = [
  [
    'smart',
    'Smart',
    'Fades into the next track where the music ends, so silence at the end of a track (or before the next one starts) doesn’t leave a gap. Tracks that follow each other on an album play gaplessly instead. Needs Plex’s loudness analysis; without it, fades happen at the very end.',
  ],
  ['always', 'Always', 'Fades between every track, albums too, at the very end of each one.'],
  ['off', 'Off', 'One track after another, as they are.'],
];
const FADE_LENGTHS = [2, 3, 4, 5, 6, 8, 10, 12].map((v) => [v, `${v} seconds`]);

function playbackView({ el }) {
  const s = app.settings;
  const qualityList = radioRows('Streaming quality', QUALITIES, s.quality, (v) => saveSettings({ quality: v }));
  const length = choiceRow({
    title: 'Crossfade length',
    subtitle: 'How long one track takes to fade into the next.',
    options: FADE_LENGTHS,
    value: Number(s.fadeLength) || 5,
    onChange: (v) => saveSettings({ fadeLength: v }),
  });
  length.hidden = s.fades === 'off' || !canFade;
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
        subtitle: 'Starts the next track the moment this one ends, so albums flow without a pause.',
        checked: s.gapless,
        onChange: (v) => saveSettings({ gapless: v }),
      }),
      choiceRow({
        title: 'Crossfade',
        subtitle: canFade
          ? 'Fade from one track into the next. The next track takes over once the fade is done, so its time starts part-way in.'
          : 'This browser doesn’t let pages fade audio, so with this on, tracks change where the music ends, without a fade.',
        options: FADES,
        value: s.fades || 'off',
        onChange: (v) => {
          saveSettings({ fades: v });
          length.hidden = v === 'off' || !canFade;
        },
      }),
      length,
    ),
  );
  if (app.config.devices) {
    el.append(
      h('div.section-head', null, h('h2', null, 'Your devices')),
      h(
        'div.rows',
        null,
        toggleRow({
          title: 'Share playback with your devices',
          subtitle:
            'Your devices signed in to this Plex account show what’s playing on any of them, and control it. One plays at a time: tap the muted speaker (Listen here) on another device to move the music there, from the same spot. Off: this device plays on its own.',
          checked: s.shareDevices !== false,
          onChange: (v) => saveSettings({ shareDevices: v }),
        }),
      ),
    );
  }
}

// options: [[value, title, subtitle]]
function radioRows(label, options, current, onChange) {
  const list = h('div.rows', { role: 'radiogroup', 'aria-label': label });
  let value = current;
  const render = () =>
    list.replaceChildren(
      ...options.map(([v, title, sub]) =>
        h(
          'button.row.radio-row',
          {
            type: 'button',
            role: 'radio',
            'aria-checked': String(v === value),
            onclick: () => {
              value = v;
              render();
              onChange(v);
            },
          },
          h('div.row-main', null, h('div.row-title', null, title), sub ? h('div.row-sub', null, sub) : null),
          v === value ? icon('check', 24, 'radio-check') : h('span.radio-empty'),
        ),
      ),
    );
  render();
  return list;
}

// ---------- Connection / diagnostics ----------

function liveOptions() {
  const forced = app.config.websockets === false;
  return [
    [
      'auto',
      'Automatic',
      forced
        ? 'WebSockets are turned off for this app, so this uses an event stream, or checks every minute.'
        : 'Uses a WebSocket when the network allows it, otherwise an event stream, or checks every minute.',
    ],
    ['nows', 'Without WebSockets', 'For networks that block WebSockets, like many work proxies. Uses an event stream, or checks every minute.'],
    ['off', 'Off', 'Don’t watch for changes. Pages show what’s new when you open them.'],
  ];
}

function debugView({ el, onDispose }) {
  const src = app.source || {};
  const kv = (k, v) => h('div.kv', null, h('div.kv-k', null, k), h('div.kv-v', null, v ?? '—'));
  const kinds = { local: 'Local network', remote: 'Remote', relay: 'Plex relay (limited speed)', manual: 'Address you entered', proxy: 'Through this container' };
  const support = ['flac', 'alac', 'mp3', 'aac', 'opus']
    .map((c) => `${fmt.codec(c)} ${canPlayCodec(c) ? 'yes' : 'no'}`)
    .concat(`HLS ${canPlayHlsNatively() ? 'built in' : 'via hls.js'}`)
    .join(', ');
  const status = h('div.kv-v', null, 'Not tested');
  const liveStatus = h('div.kv-v', null, LIVE_MODES[live.mode] || live.mode);
  const liveNote = h('div.kv-note', null, live.note || '');
  const onMode = () => {
    liveStatus.textContent = LIVE_MODES[live.mode] || live.mode;
    liveNote.textContent = live.note || '';
  };
  live.addEventListener('mode', onMode);
  onDispose(() => live.removeEventListener('mode', onMode));
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
      h('div.kv', null, h('div.kv-k', null, 'Live updates'), liveStatus, liveNote),
      kv('Browser formats', support),
      kv('Play Together', !app.config.together ? 'Off on this player' : together.active ? `In a session (${together.status === 'live' ? 'connected' : 'reconnecting'})` : 'On'),
      kv('Debug mode', app.config.debug ? 'On: problems are written to the container’s log (without tokens)' : 'Off'),
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
    h('div.section-head', null, h('h2', null, 'Live updates')),
    h('p.lede', null, 'New music, playlist changes and ratings from other Plex apps show up here without reloading.'),
    radioRows('Live updates', liveOptions(), app.settings.liveUpdates, (v) => saveSettings({ liveUpdates: v })),
    h(
      'div.pad.button-row',
      null,
      h(
        'button.btn.btn-secondary',
        {
          type: 'button',
          onclick: () => {
            live.forgetWebSocketFailure();
            live.start();
          },
        },
        icon('live', 20),
        h('span', null, 'Reconnect live updates'),
      ),
    ),
  );
}

// ---------- AI ----------

function aiSummary() {
  const s = aiSettings();
  const t = aiTarget(s);
  if (s.mode === 'off') return 'Off';
  if (!t) return 'Not set up';
  if (t.kind === 'shared') return t.model ? `On: ${t.model}` : 'On';
  return t.model ? `Your Ollama: ${t.model}` : 'Your Ollama, no model chosen';
}

function saveAI(patch) {
  saveSettings({ ai: { ...aiSettings(), ...patch } });
  dropCached((p) => p === '/ai-playlist' || p === '/search' || p === '/settings' || p === '/settings/missing');
}

// Show missing tracks: on or off, and the list (shown while it's on, or
// while there's anything on it).
function missingSection(onDispose) {
  const count = h('span.row-value');
  const listRow = row({ href: '/settings/missing', title: 'Missing tracks', subtitle: 'See them, export them, or check again', right: count, chevron: true, cls: 'missing-link' });
  const paint = () => {
    const n = missingCount();
    count.textContent = n ? fmt.number(n) : '';
    listRow.hidden = !aiSettings().missing && !n;
  };
  paint();
  // An AI playlist made meanwhile can add to it.
  onDispose?.(on('missing', paint));
  return h(
    'div.ai-missing-settings',
    null,
    h('div.section-head', null, h('h2', null, 'Missing tracks')),
    h(
      'div.rows',
      null,
      toggleRow({
        title: 'Show missing tracks',
        subtitle: 'List the songs and artists AI playlists suggest that aren’t in your library, so you can export the list and go looking.',
        checked: aiSettings().missing === true,
        onChange: (v) => {
          saveAI({ missing: v });
          paint();
        },
      }),
      // AI models make songs up: MusicBrainz knows which are real.
      mbOffered()
        ? toggleRow({
            title: 'Check them on MusicBrainz',
            subtitle: 'Leaves out songs and artists MusicBrainz doesn’t know (mostly ones the AI made up), and albums taken for songs. Their names go to musicbrainz.org, from this player.',
            checked: aiSettings().musicbrainz === true,
            onChange: (v) => {
              saveAI({ musicbrainz: v });
              if (v) checkOnMusicBrainz().catch(() => {});
              paint();
            },
          })
        : null,
      listRow,
    ),
  );
}

// How long to wait for the model to start answering.
function waitRow() {
  return h(
    'div.rows.ai-wait',
    null,
    choiceRow({
      title: 'Wait for the model',
      subtitle: 'How long to wait for it to start answering, loading it into memory included (after Ollama starts, that can take minutes). If that runs out, it carries on loading for next time.',
      options: WAIT_CHOICES.map((m) => [m, `${m} minutes`]),
      value: WAIT_CHOICES.includes(aiWaitMinutes()) ? aiWaitMinutes() : 5,
      onChange: (v) => saveAI({ wait: v }),
    }),
  );
}

const gb = (bytes) => (bytes ? `${(bytes / 1e9).toFixed(1)} GB` : '');

function aiView({ el, onDispose }) {
  el.append(backHeader('AI', { fallback: '/settings' }));
  // A model shared by this player is the only one used: its name and whether
  // it's ready are all that's shown of the AI server.
  if (sharedAI()) return sharedAIView(el, onDispose);
  const settings = aiSettings();
  const effective = settings.mode === 'custom' ? 'custom' : 'off';
  const options = [
    ['custom', 'My own Ollama server', 'An Ollama server this device can reach, such as one on this computer.'],
    ['off', 'Off', 'Hide AI features on this device.'],
  ];

  const customBox = h('div.ai-custom');
  const modelBox = h('div.ai-models');
  const waitBox = waitRow();

  el.append(
    h('p.lede', null, 'AI playlists and the AI DJ use a model running on your own hardware through Ollama. These settings apply to this device.'),
    h('div.section-head', null, h('h2', null, 'Where the model runs')),
    radioRows('Where the model runs', options, effective, (v) => {
      saveAI({ mode: v });
      render();
    }),
    h('p.hint.pad', null, 'This player has no shared model. Whoever runs it can add one with the OLLAMA_URL setting.'),
    customBox,
    modelBox,
    waitBox,
    notesSection(),
    missingSection(onDispose),
  );
  render();

  function render() {
    const s = aiSettings();
    const mode = s.mode === 'custom' ? 'custom' : '';
    customBox.replaceChildren(...(mode === 'custom' ? customForm(s) : []));
    modelBox.replaceChildren();
    waitBox.hidden = mode !== 'custom';
    if (mode === 'custom' && s.url) loadModels();
  }

  function customForm(s) {
    const url = h('input', { type: 'url', placeholder: 'http://localhost:11434', autocomplete: 'url', value: s.url, required: true });
    const key = h('input', { type: 'password', placeholder: 'Optional', autocomplete: 'off', value: s.apiKey });
    const insecure = () => location.protocol === 'https:' && /^http:\/\//i.test(url.value) && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(url.value);
    const warn = h('p.hint.warn', { hidden: !insecure() }, 'This page is served over https, so the browser will block an http address unless it’s on this device (localhost). Use an https address.');
    url.addEventListener('input', () => (warn.hidden = !insecure()));
    const form = h(
      'form.form',
      {
        onsubmit: (e) => {
          e.preventDefault();
          const value = url.value.trim().replace(/\/+$/, '');
          if (!/^https?:\/\//i.test(value)) return toast('Start the address with http:// or https://');
          saveAI({ mode: 'custom', url: value, apiKey: key.value.trim() });
          render();
        },
      },
      h('label.field', null, h('span', null, 'Ollama address'), url),
      h('label.field', null, h('span', null, 'API key'), key),
      h('p.hint', null, 'Only needed if your Ollama sits behind a proxy that asks for one.'),
      warn,
      h('div.form-actions', null, h('button.btn.btn-primary', { type: 'submit' }, 'Connect')),
    );
    return [
      h('div.section-head', null, h('h2', null, 'Your Ollama server')),
      form,
      h(
        'p.hint.pad.origins',
        null,
        'Ollama only answers websites it trusts. On the computer running Ollama, set ',
        h('code', null, `OLLAMA_ORIGINS=${location.origin}`),
        ' and restart Ollama.',
      ),
    ];
  }

  async function loadModels() {
    const s = aiSettings();
    const target = aiTarget(s);
    if (!target) return;
    const status = h('p.hint.pad', { role: 'status' }, 'Connecting…');
    modelBox.replaceChildren(h('div.section-head', null, h('h2', null, 'Model')), status);
    let models;
    try {
      const [version, list] = await Promise.all([aiVersion(target).catch(() => ''), listModels(target)]);
      models = list;
      status.textContent = `Connected${version ? ` to Ollama ${version}` : ''}. ${fmt.count(models.length, 'model', 'models')} installed.`;
    } catch (err) {
      status.textContent = describeAIError(err, target);
      status.classList.add('warn');
      return;
    }
    if (!el.isConnected) return;
    if (!models.length) {
      status.textContent += ' Install one with “ollama pull”, for example ollama pull llama3.1:8b.';
      return;
    }
    let current = target.model;
    if (current && !models.some((m) => m.name === current)) {
      status.textContent += ` The model “${current}” isn’t installed, so choose another.`;
    }
    const opts = models.map((m) => [m.name, m.name, [m.params, m.quant, gb(m.size)].filter(Boolean).join(' · ')]);
    const test = h('p.hint.pad', { role: 'status' });
    modelBox.append(
      radioRows('Model', opts, current, (v) => {
        current = v;
        saveAI({ model: v });
        test.textContent = '';
      }),
      testButton(test),
      test,
    );
  }
}

// The shared model: its name, whether it's ready, a test, and AI on or off
// on this device. Which model is used is up to whoever runs this player.
function sharedAIView(el, onDispose) {
  const on = aiSettings().mode !== 'off';
  const name = h('span', null, sharedAI().model || '…');
  const status = h('p.hint.pad', { role: 'status' });
  const test = h('p.hint.pad', { role: 'status' });
  const box = h(
    'div.ai-shared',
    { hidden: !on },
    h('div.section-head', null, h('h2', null, 'Model')),
    h('div.rows', null, row({ lead: h('span.tile.tile-plain', null, icon('sparkle', 24)), title: name, subtitle: 'Set up by whoever runs this player', chevron: false, cls: 'ai-model-row' })),
    status,
    testButton(test),
    test,
    waitRow(),
  );
  const notes = notesSection();
  notes.hidden = !on;
  const missing = missingSection(onDispose);
  missing.hidden = !on && !missingCount();
  el.append(
    h('p.lede', null, 'AI playlists and the AI DJ use an AI model this player shares, running on its owner’s hardware through Ollama.'),
    h(
      'div.rows',
      null,
      toggleRow({
        title: 'AI features',
        subtitle: 'AI playlists and the AI DJ on this device.',
        checked: on,
        onChange: (v) => {
          saveAI({ mode: v ? 'auto' : 'off' });
          box.hidden = !v;
          notes.hidden = !v;
          missing.hidden = !v && !missingCount();
          if (v) check();
        },
      }),
    ),
    box,
    notes,
    missing,
  );
  if (on) check();

  async function check() {
    status.classList.remove('warn');
    status.textContent = 'Checking…';
    try {
      const st = await sharedStatus();
      if (st?.model) name.textContent = st.model;
      if (st?.ready && st.loading) status.textContent = 'Ready, and loading into memory now.';
      else if (st?.ready && st.loaded === false) status.textContent = 'Ready. It isn’t in memory right now, so the next request loads it first, which can take a few minutes.';
      else if (st?.ready) status.textContent = 'Ready.';
      else if (st?.problem === 'not-installed') status.textContent = `“${st.model}” isn’t installed on the AI server yet.`;
      else if (st?.problem === 'no-model') status.textContent = 'The AI server has no models installed yet.';
      else status.textContent = 'The AI server isn’t answering right now.';
      status.classList.toggle('warn', !st?.ready);
    } catch (err) {
      status.textContent = describeAIError(err);
      status.classList.add('warn');
    }
  }
}

function testButton(out) {
  return h(
    'div.pad.button-row',
    null,
    h(
      'button.btn.btn-secondary',
      {
        type: 'button',
        onclick: async (e) => {
          const btn = e.currentTarget;
          btn.disabled = true;
          out.classList.remove('warn');
          const model = aiTarget()?.model;
          const asking = `Asking ${model || 'the model'}…`;
          out.textContent = asking;
          try {
            const r = await chat({
              messages: [{ role: 'user', content: 'Reply with {"ok": true} and nothing else.' }],
              schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
              temperature: 0,
              maxTokens: 20,
              onLoading: (on) => (out.textContent = on ? `Loading ${model || 'the model'} into memory. After Ollama starts, this can take a few minutes…` : asking),
            });
            parseReply(r.content);
            out.textContent = `It works. ${r.model} answered in ${r.seconds.toFixed(1)} s.`;
          } catch (err) {
            out.textContent = describeAIError(err);
            out.classList.add('warn');
          } finally {
            btn.disabled = false;
          }
        },
      },
      icon('sparkle', 20),
      h('span', null, 'Test the model'),
    ),
  );
}

function notesSection() {
  const area = h('textarea.notes', {
    rows: 3,
    maxlength: 500,
    placeholder: 'For example: I love 90s trip-hop and dub; skip live recordings and Christmas music.',
  });
  area.value = aiSettings().notes;
  area.addEventListener('input', debounce(() => saveAI({ notes: area.value }), 400));
  return h(
    'div',
    null,
    h('div.section-head', null, h('h2', null, 'Notes for the AI')),
    h('label.field.pad', null, h('span', null, 'Anything the AI should know about your taste. Used for AI playlists and the AI DJ.'), area),
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
      h(
        'div.about-links',
        null,
        h('a.btn.btn-secondary', { href: `${REPO_URL}/blob/main/CHANGELOG.md`, target: '_blank', rel: 'noopener' }, icon('external', 20), h('span', null, 'What’s new')),
        h('a.btn.btn-secondary', { href: REPO_URL, target: '_blank', rel: 'noopener' }, icon('external', 20), h('span', null, 'Project on GitHub')),
      ),
    ),
  );
}
