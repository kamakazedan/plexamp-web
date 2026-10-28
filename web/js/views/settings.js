import { app, on, saveSettings, setSource, signOut, proxyUri } from '../state.js';
import { APP_INFO, PlexServer, listServers, pickConnection, probeConnections, routeRank, clientId, canPlayCodec, canPlayHlsNatively } from '../plex.js';
import { navigate, clearViewCache, describeError, dropCached, refresh } from '../router.js';
import { h, icon, pageHeader, backHeader, row, sheet, spinner, emptyState, errorState, toast, fmt, debounce, toggleRow, choiceRow, avatar as personAvatar } from '../ui.js';
import { live, LIVE_MODES } from '../live.js';
import { aiSettings, sharedAI, sharedRefused, aiTarget, listModels, aiVersion, sharedStatus, chat, parseReply, describeAIError, WAIT_CHOICES, aiWaitMinutes } from '../ai.js';
import { experienceView, appearanceView, playerSettingsView, skipTimesView, desktopView, homeEditorView } from './experience.js';
import { missingTracksView, missingShareRow } from './missingtracks.js';
import { missingCount, mbOffered, mbWhere, missingKeptNote } from '../missing.js';
import { together } from '../together.js';
import { canFade } from '../transitions.js';
import { setAccountSync, accountSyncState } from '../sync.js';
import { player } from '../player.js';
import { LOAD_AHEAD_MAX, LOAD_AHEAD_BYTES, KEEP_PLAYED_MAX } from '../prefetch.js';

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
              subtitle: `Everything kept for you on this device is cleared: your queue and lists, your AI settings, this player’s name and Home layout. How the app looks and plays stays.${
                app.config.settingsSync && app.config.missingSync
                  ? ' Settings and missing tracks kept for your account stay with it, for when you sign in again.'
                  : app.config.settingsSync
                    ? ' Settings kept for your account stay with it, for when you sign in again.'
                    : app.config.missingSync
                      ? ' Missing tracks kept for your account stay with it, for when you sign in again.'
                      : ''
              }`,
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
  el.append(h('div.section-head', null, h('h2', null, 'Your settings')), accountSyncRows());
}

// Whether settings follow the account (sync.js), with a switch for it.
function accountSyncRows() {
  const rows = h('div.rows');
  const mine = 'Streaming quality, connection settings, this device’s name, sharing with your devices, playback speed, loading ahead and your own AI server stay this device’s own.';
  if (!app.config.settingsSync) {
    rows.append(row({ title: 'Kept on this device', subtitle: 'This player doesn’t keep settings for each Plex account, so they’re this browser’s own.' }));
    return rows;
  }
  const paint = (on) =>
    rows.replaceChildren(
      toggleRow({
        title: 'On all your devices',
        subtitle: `${on === null ? 'Couldn’t check with this player just now. ' : ''}Your settings follow your Plex account: any browser you sign in on with this player has them, the Home screen too. ${mine} Off: each device has its own.`,
        checked: on !== false,
        onChange: async (v) => {
          try {
            await setAccountSync(v);
            toast(v ? 'Your settings follow your Plex account again.' : 'Your settings aren’t kept for your account any more: each device has its own.');
          } catch (err) {
            toast(`Couldn’t change that. ${describeError(err)}`);
            paint(!v);
          }
        },
      }),
    );
  paint(true);
  accountSyncState().then((on) => rows.isConnected !== false && paint(on));
  return rows;
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
  let listError = null;
  // The server this container is set up for (PLEX_SERVER_URL) is usually one
  // of yours on plex.tv too: then it's listed once, as that one (which goes
  // through this container when that's the best route: Settings ›
  // Connection).
  const [servers, proxied] = await Promise.all([
    auth.manual
      ? []
      : listServers(auth.token).catch((err) => {
          listError = err;
          return [];
        }),
    proxy
      ? new PlexServer({ uri: proxy, token: auth.token })
          .identity({ timeout: 5000 })
          .then((mc) => mc?.machineIdentifier || null)
          .catch(() => null)
      : null,
  ]);
  const same = proxied ? servers.find((s) => s.id === proxied) : null;
  if (proxy && !same) entries.push({ kind: 'proxy', name: 'Server set up for this app', uri: proxy, token: auth.token, connections: [] });
  entries.push(...servers.map((s) => ({ ...s, kind: 'discovered', setUp: s === same })));

  const whose = (s) => (s.owned ? 'Your server' : s.sharedBy ? `Shared by ${s.sharedBy}` : 'Shared with you');
  const list = h('div.rows');
  for (const s of entries) {
    const sub = h('span', null, s.kind === 'proxy' ? 'Connects through this container' : s.setUp ? `${whose(s)} · also set up for this app` : whose(s));
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
      conn = await pickConnection(entry, { proxy: proxyUri(), prefer: app.settings.route });
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
    'Fades into the next track where the music ends, so silence at the end of a track (or before the next one starts) doesn’t leave a gap, and a quiet ending doesn’t hold the next track up. Tracks that follow each other on an album play gaplessly instead. Needs Plex’s loudness analysis; without it, fades happen at the very end.',
  ],
  ['always', 'Always', 'Fades between every track, albums too, at the very end of each one.'],
  ['off', 'Off', 'One track after another, as they are.'],
];
const FADE_LENGTHS = [2, 3, 4, 5, 6, 8, 10, 12].map((v) => [v, `${v} seconds`]);
// Load ahead's choices, each with about how much memory it takes: for
// four-minute tracks, as Streaming quality has them come in (as they are:
// MP3 at 320 kbps, or CD-quality FLAC at about 1,000 kbps; or converted).
const MB_A_TRACK = (kbps) => (kbps * 1000 * 240) / 8 / 1e6;
const mbText = (mb) => `${fmt.number(mb < 10 ? Math.round(mb * 10) / 10 : Math.round(mb))} MB`;
const aboutMb = (mb) => `about ${mbText(mb)}`;
// (n tracks' memory, as Streaming quality has them come in.)
function memoryFor(n, quality) {
  const kbps = quality === 'original' ? null : Number(quality) || 320;
  const big = n * MB_A_TRACK(kbps || 1000);
  const takes = kbps ? `${aboutMb(n * MB_A_TRACK(kbps))} at ${kbps} kbps` : `${aboutMb(n * MB_A_TRACK(320))} as MP3, ${mbText(big)} as FLAC`;
  return { takes, big };
}

export function loadAheadChoices(quality = app.settings.quality) {
  const most = LOAD_AHEAD_BYTES / 1024 / 1024;
  const out = [[0, 'Off', 'Tracks load as they play: the next one starts loading shortly before it’s due (for a gapless change or a crossfade), once this one has loaded.']];
  for (let n = 1; n <= LOAD_AHEAD_MAX; n++) {
    const { takes, big } = memoryFor(n, quality);
    out.push([n, fmt.count(n, 'track', 'tracks'), `${n === 1 ? 'The next track' : `The next ${n} tracks`}: ${takes}.${big > most ? ' More than this browser keeps: as many as fit.' : ''}`]);
  }
  return out;
}

// Keep played tracks' choices, likewise.
export function keepPlayedChoices(quality = app.settings.quality) {
  const out = [[0, 'Off', 'A track played again comes from your server again, as it did the first time.']];
  for (let n = 1; n <= KEEP_PLAYED_MAX; n++) {
    const { takes } = memoryFor(n, quality);
    out.push([n, fmt.count(n, 'track', 'tracks'), `${n === 1 ? 'The last track played' : `The last ${n} tracks played`}: ${takes}.`]);
  }
  return out;
}

// What's in memory now, for these settings: "2 tracks (61 MB)".
function loadedAhead() {
  const done = player.ahead.summary().filter((e) => e.state === 'done');
  if (!done.length) return '';
  const mb = done.reduce((n, e) => n + e.bytes, 0) / 1024 / 1024;
  return ` In memory now: ${fmt.count(done.length, 'track', 'tracks')} (${mbText(mb)}).`;
}
// How far under the rest of a track its ending has to drop (transitions.js).
const QUIET_ENDINGS = [
  ['soft', 'When it softens', 'Starts the next track as soon as the ending drops well down (15 dB under the rest of the track). Can cut a quiet last verse short.'],
  ['quiet', 'When it’s quiet', 'Starts the next track when the ending gets quiet, like a beat ticking on under a fade or a hushed outro (20 dB under the rest of the track).'],
  ['hushed', 'When it’s nearly silent', 'Waits until the ending is barely there (25 dB under the rest of the track).'],
  ['off', 'Never', 'Quiet endings play out: the fade starts just before the music stops.'],
];

function playbackView({ el }) {
  const s = app.settings;
  // (Load ahead's estimates, and Keep played tracks', follow Streaming quality.)
  const aheadChoices = loadAheadChoices(s.quality);
  const keepChoices = keepPlayedChoices(s.quality);
  const qualityList = radioRows('Streaming quality', QUALITIES, s.quality, (v) => {
    saveSettings({ quality: v });
    aheadChoices.splice(0, aheadChoices.length, ...loadAheadChoices(v));
    keepChoices.splice(0, keepChoices.length, ...keepPlayedChoices(v));
  });
  const length = choiceRow({
    title: 'Crossfade length',
    subtitle: 'How long one track takes to fade into the next.',
    options: FADE_LENGTHS,
    value: Number(s.fadeLength) || 5,
    onChange: (v) => saveSettings({ fadeLength: v }),
  });
  length.hidden = s.fades === 'off' || !canFade;
  const quiet = choiceRow({
    title: 'Quiet endings',
    subtitle: 'When a track ends quietly, Smart starts the next one there instead of waiting for the music to stop (at most 15 seconds early).',
    options: QUIET_ENDINGS,
    value: s.quietEndings || 'quiet',
    onChange: (v) => saveSettings({ quietEndings: v }),
  });
  quiet.hidden = s.fades !== 'smart' || !canFade;
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
          quiet.hidden = v !== 'smart' || !canFade;
        },
      }),
      length,
      quiet,
      choiceRow({
        title: 'Load ahead',
        subtitle: `On this device: how many tracks load in full ahead of time, so a dropped or slow connection doesn’t stop the music at the next one. While the track playing is still loading, they take half the connection at most (and wait whenever it needs more); once it’s all in, as much as the connection gives. This browser keeps them only while they’re wanted (${fmt.number(LOAD_AHEAD_BYTES / 1024 / 1024)} MB at most, with the tracks played it keeps; not saved, nor in its cache).${loadedAhead()}`,
        options: aheadChoices,
        value: Math.min(LOAD_AHEAD_MAX, Math.max(0, Math.round(Number(s.loadAhead) || 0))),
        onChange: (v) => saveSettings({ loadAhead: v }),
      }),
      choiceRow({
        title: 'Keep played tracks',
        subtitle:
          'On this device: how many tracks stay in memory once they’ve played, so going back to one plays it at once, even with a slow or dropped connection. One that came in as it played is kept as it came in if it was converted, or, with Load ahead on, read again into memory once the tracks ahead are in. The tracks ahead come first: these make room for them, and one still being read waits while they load.',
        options: keepChoices,
        value: Math.min(KEEP_PLAYED_MAX, Math.max(0, Math.round(Number(s.keepPlayed) || 0))),
        onChange: (v) => saveSettings({ keepPlayed: v }),
      }),
      toggleRow({
        title: 'Loudness levelling',
        subtitle: canFade
          ? 'Turns louder tracks down to match quieter ones, never up, so nothing distorts. Uses your server’s loudness analysis (albums played in order keep their own ups and downs). Tracks it hasn’t analysed play as they are.'
          : 'This browser doesn’t let pages set the volume (as on iPhone and iPad), so tracks can’t be levelled here.',
        checked: !!s.loudness,
        disabled: !canFade,
        onChange: (v) => saveSettings({ loudness: v }),
      }),
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

// The routes to a server (see plex.js ROUTE_RANKS), as Settings › Connection
// names them.
const ROUTE_NAMES = { local: 'On your network', proxy: 'Through this container', remote: 'Over the internet', relay: 'Plex relay (limited speed)' };
const ROUTE_CHOICES = [
  ['best', 'Best that answers', 'Straight to the server on your network when this browser can reach it there. Otherwise through this container, then over the internet, then Plex’s relay.'],
  ['container', 'Through this container', 'Always through this container (which reaches the server at its PLEX_SERVER_URL), while it answers.'],
  ['direct', 'Straight to the server', 'The server’s own addresses first, on your network or over the internet. Through this container only when they don’t answer.'],
];

// Why the app reaches the server the way it does.
function routeNote(src) {
  if (src.kind === 'proxy') {
    return src.connections?.length
      ? `This container is set up for ${src.serverName} too (its PLEX_SERVER_URL), and going through it was the best route from this browser (see Routes).`
      : 'You chose the server set up for this app, so the app always goes through this container to it.';
  }
  if (src.kind === 'local') return 'Straight to the server, on your network.';
  if (src.kind === 'remote') return 'Straight to the server, over the internet (its address outside your network).';
  if (src.kind === 'relay') return 'Through Plex’s relay, which is slow: the server’s other addresses didn’t answer from this browser.';
  return '';
}

function routeResult(r) {
  if (r.ok) return `${fmt.number(r.ms)} ms`;
  return {
    http: 'Can’t be used here: it’s a plain http address, and this page is https',
    insecure: 'Not used: a plain http address over the internet would carry your sign-in unencrypted',
    timeout: 'No answer within 6 seconds',
    network: 'Didn’t answer this browser',
    status: `Answered with an error (${r.status})`,
    other: 'Leads to another server',
  }[r.why];
}

const hostOf = (uri) => {
  try {
    const u = new URL(uri);
    return `${u.host}${u.pathname === '/' ? '' : u.pathname}`;
  } catch {
    return uri;
  }
};

// The Test connection answer, when there's no answer: through this
// container, whether it's the container or the server behind it.
async function noAnswer(err, took, src, timeout) {
  const proxyError = src.kind === 'proxy' && [502, 503, 504].includes(err?.status);
  if (!err?.network && !proxyError) return describeError(err);
  const waited = took >= timeout - 100;
  if (src.kind !== 'proxy') return waited ? `No answer from ${src.serverName} within ${timeout / 1000} seconds.` : `${src.serverName} didn’t answer this browser. Check it’s on, and that this device can reach it.`;
  const container = await fetch('config.js', { cache: 'no-store', credentials: 'omit' })
    .then((r) => r.ok)
    .catch(() => false);
  if (!container) return 'This container didn’t answer either: check this device’s connection to it.';
  if (proxyError) return `This container answers, but couldn’t reach ${src.serverName} (error ${err.status}). Check the server’s on, and the container’s PLEX_SERVER_URL.`;
  return `This container answers, but ${src.serverName} didn’t answer through it${waited ? ` within ${timeout / 1000} seconds` : ''}. Check the server’s on, and the container’s PLEX_SERVER_URL.`;
}

function debugView({ el, onDispose }) {
  const src = app.source || {};
  const kv = (k, v) => h('div.kv', null, h('div.kv-k', null, k), h('div.kv-v', null, v ?? '—'));
  const kinds = { local: 'Local network', remote: 'Remote', relay: 'Plex relay (limited speed)', manual: 'Address you entered', proxy: 'Through this container' };
  // Every route to the server, tried (a server of the account's only).
  // Every route to the server, tried when the connection is tested (not
  // each time the page opens).
  const routeList = h('div.rows.route-rows');
  const routeHint = h('p.hint.route-hint');
  const routes = h('div.routes', { hidden: true });
  const routeChoice = h('div.route-choice', { hidden: true });
  const pickable = !app.auth?.manual && !!src.serverId && src.kind !== 'manual' && !(src.kind === 'proxy' && !src.connections?.length);
  const checkRoutes = async () => {
    if (!pickable) return;
    let srv = null;
    try {
      srv = (await listServers(app.auth.token)).find((x) => x.id === src.serverId) || null;
    } catch {
      srv = null;
    }
    if (!srv || app.source !== src) return;
    routes.hidden = false;
    routeList.replaceChildren(spinner('Trying each route'));
    const prefer = app.settings.route;
    const tried = (await probeConnections(srv, { proxy: proxyUri(), timeout: 6000 })).sort((a, b) => routeRank(a.kind, prefer) - routeRank(b.kind, prefer));
    if (app.source !== src) return;
    routeList.replaceChildren(
      ...tried.map((r) =>
        h(
          `div.row.route-row${r.uri === src.uri ? '.in-use' : ''}`,
          { dataset: { kind: r.kind } },
          h('div.row-main', null, h('div.row-title', null, `${ROUTE_NAMES[r.kind] || r.kind}${r.uri === src.uri ? ' (in use)' : ''}`), h('div.row-sub', null, `${hostOf(r.uri)} · ${routeResult(r)}`)),
        ),
      ),
    );
    const local = tried.filter((r) => r.kind === 'local');
    routeHint.textContent =
      local.length && local.every((r) => !r.ok && r.why !== 'http') && tried.some((r) => r.ok && r.kind !== 'local')
        ? 'Its address on your network didn’t answer this browser. Browsers may keep a page on the internet from reaching your home network (Chrome asks you first), and some routers block the plex.direct addresses Plex uses there. The app takes the best route that answers.'
        : '';
  };
  // Another route preference: the best route for it, now.
  const useRoute = async (prefer) => {
    saveSettings({ route: prefer });
    if (!pickable) return;
    try {
      const srv = (await listServers(app.auth.token)).find((x) => x.id === src.serverId);
      const conn = srv && (await pickConnection(srv, { proxy: proxyUri(), prefer }));
      const words = (kind) => (kind === 'proxy' ? 'through this container' : kind === 'local' ? 'on your network' : kind === 'remote' ? 'over the internet' : 'through Plex’s relay');
      if (conn && conn.uri !== app.source?.uri && app.source === src) {
        setSource({ ...src, uri: conn.uri, kind: conn.kind, token: srv.token, connections: srv.connections });
        toast(`Now connected ${words(conn.kind)}`);
        refresh();
        return;
      }
      if (conn) toast(`Still connected ${words(conn.kind)}: that’s the route for this choice`);
    } catch {
      /* the route stays as it is */
    }
  };
  if (pickable && proxyUri()) {
    routeChoice.hidden = false;
    routeChoice.append(
      h('div.section-head', null, h('h2', null, 'Route to the server')),
      radioRows('Route to the server', ROUTE_CHOICES, app.settings.route || 'best', useRoute),
    );
  }
  routes.append(h('div.section-head', null, h('h2', null, 'Routes')), h('p.lede', null, `Each way this browser can reach ${src.serverName}, tried just now.`), routeList, routeHint);
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
      h('div.kv', null, h('div.kv-k', null, 'Connection'), h('div.kv-v', null, kinds[src.kind] || src.kind || '—'), h('div.kv-note.route-note', null, routeNote(src))),
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
              await app.server.identity({ timeout: 15000 });
              const ms = Math.round(performance.now() - t0);
              status.textContent = `${fmt.number(ms)} ms${ms > 3000 ? ' (slow)' : ''}`;
            } catch (err) {
              status.textContent = await noAnswer(err, performance.now() - t0, src, 15000);
            }
            checkRoutes();
          },
        },
        icon('refresh', 20),
        h('span', null, 'Test connection'),
      ),
      h('button.btn.btn-secondary', { type: 'button', onclick: () => navigate('/settings/source') }, icon('server', 20), h('span', null, 'Change server')),
    ),
    routes,
    routeChoice,
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
  if (t.kind === 'shared' && sharedRefused()) return 'Not for your account';
  if (t.kind === 'shared') return t.model ? `On: ${t.model}` : 'On';
  return t.model ? `Your Ollama: ${t.model}` : 'Your Ollama, no model chosen';
}

function saveAI(patch) {
  saveSettings({ ai: { ...aiSettings(), ...patch } });
  dropCached((p) => p === '/ai-playlist' || p === '/search' || p === '/settings' || p === '/settings/missing');
}

// Show missing tracks: on or off, and the list (shown while it's on, or
// while there's anything on it); for a friend, where the player keeps them
// for each account, whether theirs are kept for their account.
function missingSection(onDispose) {
  const count = h('span.row-value');
  const listRow = row({ href: '/settings/missing', title: 'Missing tracks', subtitle: 'See them, export them, or check again', right: count, chevron: true, cls: 'missing-link' });
  const show = toggleRow({
    title: 'Show missing tracks',
    subtitle: '',
    checked: aiSettings().missing === true,
    onChange: (v) => {
      saveAI({ missing: v });
      paint();
    },
  });
  const showSub = h('div.row-sub');
  show.querySelector('.row-main').append(showSub);
  const share = h('div.missing-share-slot');
  function paint() {
    const n = missingCount();
    count.textContent = n ? fmt.number(n) : '';
    listRow.hidden = !aiSettings().missing && !n;
    showSub.textContent = `List the songs and artists AI playlists suggest that aren’t in your library, so you can export the list and go looking.${missingKeptNote()}`;
    const r = missingShareRow({ after: paint });
    share.replaceChildren(...(r ? [r] : []));
  }
  paint();
  // An AI playlist made meanwhile can add to it (and the player says whose
  // the server is).
  onDispose?.(on('missing', paint));
  return h(
    'div.ai-missing-settings',
    null,
    h('div.section-head', null, h('h2', null, 'Missing tracks')),
    h(
      'div.rows',
      null,
      show,
      share,
      // AI models make songs up: MusicBrainz knows which are real.
      mbOffered()
        ? toggleRow({
            title: 'Check suggestions on MusicBrainz',
            subtitle: `Before an AI playlist lists what’s missing, each song and artist is looked up on ${mbWhere()}, and what it doesn’t know (mostly made up by the AI) is left out, as are albums taken for songs. Only their names go to it, from this player.`,
            checked: aiSettings().musicbrainz !== false,
            onChange: (v) => {
              saveAI({ musicbrainz: v });
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
  // Where the model runs: the one this player shares, if it has one (its
  // name, and whether it's ready, are all that's shown of that AI server,
  // and only to people it's for), an Ollama of this device's own (reached
  // from this browser, never through the player), or nowhere.
  const shared = sharedAI();
  const options = [
    ...(shared ? [['auto', 'This player’s model', 'Set up by whoever runs this player, on their own hardware, for people who can use its Plex server.']] : []),
    ['custom', 'My own Ollama server', 'An Ollama server this device can reach, such as one on this computer. Its address and key stay on this device.'],
    ['off', 'Off', 'Hide AI features on this device.'],
  ];
  const chosen = () => {
    const m = aiSettings().mode;
    if (m === 'custom') return 'custom';
    return m === 'off' || !shared ? 'off' : 'auto';
  };

  const sharedBox = h('div.ai-shared');
  const customBox = h('div.ai-custom');
  const modelBox = h('div.ai-models');
  const waitBox = waitRow();
  const notes = notesSection();
  const missing = missingSection(onDispose);
  // (Friends' too, for the server's owner, once the player has said: then
  // the list is shown with AI off on this device as well.)
  onDispose?.(on('missing', () => (missing.hidden = chosen() === 'off' && !missingCount())));

  el.append(
    h(
      'p.lede',
      null,
      shared
        ? 'AI playlists and the AI DJ use an AI model running through Ollama: the one this player shares, or one of your own. These settings apply to this device.'
        : 'AI playlists and the AI DJ use a model running on your own hardware through Ollama. These settings apply to this device.',
    ),
    h('div.section-head', null, h('h2', null, 'Where the model runs')),
    radioRows('Where the model runs', options, chosen(), (v) => {
      saveAI({ mode: v });
      render();
    }),
    ...(shared ? [] : [h('p.hint.pad', null, 'This player has no shared model. Whoever runs it can add one with the OLLAMA_URL setting.')]),
    sharedBox,
    customBox,
    modelBox,
    waitBox,
    notes,
    missing,
  );
  render();

  function render() {
    const mode = chosen();
    sharedBox.replaceChildren(...(mode === 'auto' ? sharedParts() : []));
    customBox.replaceChildren(...(mode === 'custom' ? customForm(aiSettings()) : []));
    modelBox.replaceChildren();
    waitBox.hidden = mode === 'off';
    notes.hidden = mode === 'off';
    missing.hidden = mode === 'off' && !missingCount();
    if (mode === 'custom' && aiSettings().url) loadModels();
  }

  // The shared model: its name, whether it's ready (or that it isn't for
  // this Plex account, and what to do instead), and a test. Which model it
  // is, and where it runs, is up to whoever runs this player.
  function sharedParts() {
    const name = h('span', null, shared.model || '…');
    const status = h('p.hint.pad', { role: 'status' }, 'Checking…');
    const test = h('p.hint.pad', { role: 'status' });
    const tester = testButton(test);
    check();
    return [
      h('div.section-head', null, h('h2', null, 'Model')),
      h('div.rows', null, row({ lead: h('span.tile.tile-plain', null, icon('sparkle', 24)), title: name, subtitle: 'Set up by whoever runs this player', chevron: false, cls: 'ai-model-row' })),
      status,
      tester,
      test,
    ];

    async function check() {
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
        const refused = [401, 403].includes(err?.status);
        status.textContent = refused
          ? `${describeAIError(err, aiTarget({ mode: 'auto' }))} You can use an Ollama server of your own instead: choose My own Ollama server above.`
          : describeAIError(err, aiTarget({ mode: 'auto' }));
        status.classList.add('warn', ...(refused ? ['ai-refused'] : []));
        tester.hidden = refused;
      }
    }
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
