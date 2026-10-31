import { app, on, saveSettings, setSource, signOut, switchAccount, proxyUri } from '../state.js';
import { APP_INFO, PlexServer, listServers, pickConnection, probeConnections, routeRank, clientId, canPlayCodec, canPlayHlsNatively, homeUsers, switchHomeUser, getUser, store } from '../plex.js';
import { navigate, clearViewCache, describeError, dropCached, refresh } from '../router.js';
import { h, icon, pageHeader, backHeader, row, sheet, spinner, emptyState, errorState, toast, fmt, debounce, toggleRow, choiceRow, askText, avatar as personAvatar } from '../ui.js';
import { live, LIVE_MODES } from '../live.js';
import { aiSettings, sharedAI, sharedModelName, sharedRefused, aiTarget, listModels, aiVersion, sharedStatus, chat, parseReply, describeAIError, WAIT_CHOICES, aiWaitMinutes } from '../ai.js';
import { experienceView, appearanceView, playerSettingsView, skipTimesView, desktopView, homeEditorView } from './experience.js';
import { missingTracksView } from './missingtracks.js';
import { musicbrainzSettingsView } from './mbsettings.js';
import { mbReviewView } from './mbreview.js';
import { mbMergeView } from './mbmerge.js';
import { mbFeatures, skipLiveOn } from '../mb.js';
import { missingCount, mbOffered, mbWhere, missingKeptNote } from '../missing.js';
import { together } from '../together.js';
import { canFade } from '../transitions.js';
import { setAccountSync, accountSyncState } from '../sync.js';
import { LOAD_AHEAD_MAX, LOAD_AHEAD_BYTES, KEEP_PLAYED_MAX } from '../prefetch.js';
import { keptCount } from '../outbox.js';

const REPO_URL = 'https://github.com/kamakazedan/plexamp-web';

// ---------- Settings index ----------

function badge(text) {
  return h('span.badge-circle', { 'aria-hidden': 'true' }, (text || '?').trim().charAt(0).toUpperCase());
}

const avatar = (url, name) => personAvatar(url, name);
// Who's signed in: their Plex picture, or the offline password's lock.
const authAvatar = (auth, size = 24) => (auth.offline ? h('span.badge-circle', { 'aria-hidden': 'true' }, icon('lock', size)) : avatar(auth.thumb, auth.username));

export async function settingsView({ el }) {
  const src = app.source;
  const auth = app.auth || {};
  const lead = (name) => h('span.row-icon', null, icon(name, 26));
  el.append(
    pageHeader('Settings'),
    h(
      'div.rows.settings-rows',
      null,
      row({
        href: '/settings/account',
        lead: lead(auth.offline ? 'lock' : 'user'),
        title: 'Account',
        subtitle: auth.offline ? 'Signed in with the offline password' : auth.username || 'Signed in',
        right: authAvatar(auth),
      }),
      row({ href: '/settings/source', lead: lead('note'), title: 'Source', subtitle: src ? `${src.sectionTitle} (${src.serverName})` : 'Not chosen', right: badge(src?.serverName) }),
      row({ href: '/settings/experience', lead: lead('sliders'), title: 'Experience', subtitle: 'Appearance, player, Home screen and more' }),
      row({
        href: '/settings/playback',
        lead: lead('speaker'),
        title: 'Playback',
        subtitle: app.config.devices ? 'Streaming quality, crossfade and your devices' : 'Streaming quality, gapless playback and crossfade',
      }),
      row({ href: '/settings/ai', lead: lead('sparkle'), title: 'AI', subtitle: aiSummary() }),
      mbFeatures() ? row({ href: '/settings/musicbrainz', lead: lead('disc'), title: 'MusicBrainz', subtitle: 'Missing albums, original years' }) : null,
      row({ href: '/settings/debug', lead: lead('terminal'), title: 'Connection', subtitle: 'How this device reaches your server' }),
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
    musicbrainz: musicbrainzSettingsView,
    mbreview: mbReviewView,
    mbmerge: mbMergeView,
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
      h('div.account-avatar', null, authAvatar(auth, 44)),
      h('div.account-name', null, auth.username || 'Plex user'),
      h(
        'div.account-sub',
        null,
        auth.offline
          ? 'Plex’s sign-in isn’t answering, so you’re signed in with the offline password, as the server’s owner. Play Together, your devices and shared playlists need a Plex sign-in. You’ll be signed out once Plex is back.'
          : auth.manual
            ? 'Signed in with a server address and token'
            : 'Signed in with your Plex account',
      ),
      accountButtons(),
    ),
  );
  el.append(h('div.section-head', null, h('h2', null, 'Your settings')), accountSyncRows());
}

// Switch user, where you're in a Plex Home with someone else (see
// chooseHomeUser), and Sign out: in Settings › Account, and while choosing
// a server (someone in your Plex Home may have none of theirs to choose).
function accountButtons() {
  const auth = app.auth || {};
  const switchBtn = h('button.btn.btn-secondary.account-switch', { type: 'button', hidden: true }, icon('switchUser', 20), h('span', null, 'Switch user'));
  if (!auth.manual && auth.token) {
    Promise.all([homeUsers(auth.token), getUser(auth.token).catch(() => null)])
      .then(([users, me]) => {
        if (app.auth?.token !== auth.token || !me?.uuid) return;
        // (Which of them is you, by plex.tv's id for you: never offered
        // yourself, as switching to you would clear what's kept for you.)
        const mine = (u) => u.uuid === String(me.uuid);
        if (users.length < 2 || !users.some(mine)) return;
        switchBtn.onclick = () => chooseHomeUser(users, mine, String(me.uuid));
        switchBtn.hidden = false;
      })
      .catch(() => {});
  }
  const signOutBtn = h('button.btn.btn-secondary', { type: 'button', onclick: confirmSignOut }, icon('signOut', 20), h('span', null, 'Sign out'));
  return h('div.account-actions', null, switchBtn, signOutBtn);
}

function confirmSignOut() {
  sheet({
    title: 'Sign out?',
    subtitle: `Clears your queue, lists, AI settings, player name and Home layout from this device${store.keys('profile.').length ? ', and settings kept for anyone switched from' : ''}. How the app looks and plays stays.${
      keptCount() ? ` ${keptCount() === 1 ? 'A play or rating' : `${keptCount()} plays and ratings`} from while you were offline will be lost.` : ''
    }${
      app.auth?.offline
        ? ''
        : app.config.settingsSync && app.config.missingSync
        ? ' Your settings and missing tracks stay kept for your account.'
        : app.config.settingsSync
          ? ' Your settings stay kept for your account.'
          : app.config.missingSync
            ? ' Your missing tracks stay kept for your account.'
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
  });
}

// Whether settings follow the account (sync.js), with a switch for it.
function accountSyncRows() {
  const rows = h('div.rows');
  const mine = 'Some, like Streaming quality, stay on each device.';
  if (!app.config.settingsSync || app.auth?.offline) {
    rows.append(
      row({
        title: 'Kept on this device',
        subtitle: app.auth?.offline ? 'Not with the offline password.' : 'This player doesn’t keep settings for accounts.',
      }),
    );
    return rows;
  }
  const paint = (on) =>
    rows.replaceChildren(
      toggleRow({
        title: 'On all your devices',
        subtitle: `${on === null ? 'Couldn’t check just now. ' : ''}Your settings follow your Plex account. ${mine}`,
        checked: on !== false,
        onChange: async (v) => {
          try {
            await setAccountSync(v);
            toast(v ? 'Your settings follow your Plex account again.' : 'Each device keeps its own settings now.');
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

// ---------- Plex Home: switching to someone else in it ----------

// The people in your Plex Home (`mine`: which is you, `myId`: your Plex
// account's id), to switch to.
function chooseHomeUser(users, mine, myId) {
  const list = h('div.rows.home-users');
  let panel = null;
  for (const u of users) {
    const you = mine(u);
    const what = [you ? 'You' : null, u.admin ? 'Admin' : u.guest ? 'Guest' : u.restricted ? 'Managed user' : null, u.protected && !you ? 'Has a PIN' : null]
      .filter(Boolean)
      .join(' · ');
    list.append(
      row({
        onClick: you
          ? null
          : async () => {
              await panel?.close();
              switchToHomeUser(u, myId);
            },
        lead: avatar(u.thumb, u.title),
        title: u.title,
        subtitle: what,
        right: you ? icon('check', 22, 'home-user-you') : null,
        chevron: !you,
        cls: 'home-user',
      }),
    );
  }
  panel = sheet({
    title: 'Switch user',
    subtitle: 'Someone else in your Plex Home',
    content: h(
      'div',
      null,
      list,
      h(
        'p.home-users-note',
        null,
        'Everyone has their own settings, playlists and ratings. Your settings are kept on this device for when you switch back.',
      ),
    ),
  });
}

// To them: their PIN first, where they have one. Then plex.tv's token for
// them, the server and library this is on (where they can use those), and
// the page afresh as them (state.js switchAccount).
let switching = false;
async function switchToHomeUser(u, myId) {
  if (switching) return;
  let pin = null;
  if (u.protected) {
    pin = await askText({ title: `Switch to ${u.title}`, label: 'Their PIN', confirm: 'Switch', maxLength: 4, type: 'password', inputMode: 'numeric', secret: true, message: `${u.title} has a PIN on Plex.` });
    if (pin === null) return;
    if (!/^\d{4}$/.test(pin)) return toast('A PIN is four numbers.');
  }
  if (switching) return;
  switching = true;
  const cover = h('div.switching-cover', null, h('div.spinner', { 'aria-hidden': 'true' }, h('span')), h('p', { role: 'status' }, `Switching to ${u.title}…`));
  document.body.append(cover);
  try {
    const user = await switchHomeUser(app.auth.token, u.uuid, pin);
    pin = null;
    const token = user.authToken;
    const source = await sourceFor(token);
    // (By the name they were chosen by.)
    const thumb = typeof user.thumb === 'string' && /^https:\/\//.test(user.thumb) ? user.thumb : u.thumb;
    switchAccount({ auth: { token, username: u.title, thumb, manual: false }, source, from: myId, to: u.uuid });
  } catch (err) {
    switching = false;
    cover.remove();
    const refused = err?.status === 401 || err?.status === 403 || err?.status === 422;
    toast(refused ? (pin ? 'That PIN isn’t right.' : `Plex didn’t let you switch to ${u.title}.`) : `Couldn’t switch to ${u.title}. ${describeError(err)}`, { timeout: 6000 });
  }
}

// The server and library this is on, for whoever `token` is for, where
// they can use them: the same way to the server, with their own token for
// it, and the same library (or the server's first, where they can't see
// that one). Null where they can't use the server: then they choose one.
async function sourceFor(token) {
  const src = app.source;
  if (!src?.serverId) return null;
  const theirs = (await listServers(token).catch(() => [])).find((x) => x.id === src.serverId);
  if (!theirs) return null;
  const sections = await new PlexServer({ uri: src.uri, token: theirs.token }).musicSections({ timeout: 10000 }).catch(() => []);
  if (!sections.length) return null;
  const sec = sections.find((x) => String(x.key) === String(src.sectionKey)) || sections[0];
  return {
    serverId: src.serverId,
    serverName: theirs.name || src.serverName,
    uri: src.uri,
    kind: src.kind,
    token: theirs.token,
    connections: theirs.connections,
    sectionKey: String(sec.key),
    sectionTitle: sec.title,
  };
}

// ---------- Source (server + library) ----------

export async function sourceView({ el, firstRun = false }) {
  el.append(firstRun ? pageHeader('Choose your music') : backHeader('Source', { fallback: '/settings' }));
  if (firstRun) el.append(h('p.lede', null, 'Choose a Plex server and music library.'));
  const body = h('div.source-body');
  el.append(body);
  // Who's signed in, to switch user or sign out from here too (someone in
  // a Plex Home may have no server to choose).
  if (firstRun && app.auth?.token) el.append(h('div.setup-account', null, h('div.setup-account-who', null, `Signed in as ${app.auth.username || 'Plex user'}`), accountButtons()));
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
    const sub = h('span', null, s.kind === 'proxy' ? 'Connects through this app' : s.setUp ? `${whose(s)} · also set up for this app` : whose(s));
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
  else if (!entries.length) body.append(emptyState('No Plex servers on this account. You can enter a server address below.'));
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
    h('p.hint', null, 'For example http://192.168.1.10:32400'),
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
      toast(`Can’t reach ${entry.name}. Check it’s online and the address is right.`, { timeout: 6000 });
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
  ['original', 'Original', 'Your files as they are, best quality.'],
  ['320', 'High (320 kbps)', 'For slower connections.'],
  ['192', 'Normal (192 kbps)', 'Uses less data.'],
  ['128', 'Data saver (128 kbps)', 'Uses the least data.'],
];

const FADES = [
  [
    'smart',
    'Smart',
    'Fades where the music ends, with albums gapless. Without Plex’s loudness analysis, at the very end.',
  ],
  ['always', 'Always', 'Fades between every track.'],
  ['off', 'Off', 'No fades.'],
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
  const out = [[0, 'Off', 'Each track loads as it plays.']];
  for (let n = 1; n <= LOAD_AHEAD_MAX; n++) {
    const { takes, big } = memoryFor(n, quality);
    out.push([n, fmt.count(n, 'track', 'tracks'), `${takes}.${big > most ? ` Only as many as fit in ${fmt.number(most)} MB.` : ''}`]);
  }
  return out;
}

// Keep played tracks' choices, likewise.
export function keepPlayedChoices(quality = app.settings.quality) {
  const out = [[0, 'Off', 'Played tracks load again if you go back.']];
  for (let n = 1; n <= KEEP_PLAYED_MAX; n++) {
    const { takes } = memoryFor(n, quality);
    out.push([n, fmt.count(n, 'track', 'tracks'), `${takes}.`]);
  }
  return out;
}

// How far under the rest of a track its ending has to drop (transitions.js).
const QUIET_ENDINGS = [
  ['soft', 'When it softens', 'Earliest. Can cut a quiet last verse short.'],
  ['quiet', 'When it’s quiet', 'Like a fading outro.'],
  ['hushed', 'When it’s nearly silent', 'Latest.'],
  ['off', 'Never', 'Quiet endings play out in full.'],
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
    subtitle: 'How long each fade lasts.',
    options: FADE_LENGTHS,
    value: Number(s.fadeLength) || 5,
    onChange: (v) => saveSettings({ fadeLength: v }),
  });
  length.hidden = s.fades === 'off' || !canFade;
  const quiet = choiceRow({
    title: 'Quiet endings',
    subtitle: 'When to start the next track over a quiet ending.',
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
        subtitle: 'No pause between tracks.',
        checked: s.gapless,
        onChange: (v) => saveSettings({ gapless: v }),
      }),
      choiceRow({
        title: 'Crossfade',
        subtitle: canFade
          ? 'Fade from one track into the next.'
          : 'This browser can’t fade audio.',
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
        subtitle: 'Loads the next tracks in full, so a dropped connection doesn’t stop the music.',
        options: aheadChoices,
        value: Math.min(LOAD_AHEAD_MAX, Math.max(0, Math.round(Number(s.loadAhead) || 0))),
        onChange: (v) => saveSettings({ loadAhead: v }),
      }),
      choiceRow({
        title: 'Keep played tracks',
        subtitle: 'Keeps recent tracks, so going back plays them instantly.',
        options: keepChoices,
        value: Math.min(KEEP_PLAYED_MAX, Math.max(0, Math.round(Number(s.keepPlayed) || 0))),
        onChange: (v) => saveSettings({ keepPlayed: v }),
      }),
      toggleRow({
        title: 'Loudness levelling',
        subtitle: canFade
          ? 'Turns louder tracks down to match quieter ones, never up.'
          : 'This browser can’t change the volume (iPhone and iPad).',
        checked: !!s.loudness,
        disabled: !canFade,
        onChange: (v) => saveSettings({ loudness: v }),
      }),
      toggleRow({
        title: 'Skip tracks you’ve rated down',
        subtitle: 'Leaves thumbs-down and one-star tracks out of radio, mixes, shuffles, Guest DJs and AI playlists.',
        checked: app.settings.skipDisliked !== false,
        onChange: (v) => saveSettings({ skipDisliked: v }),
      }),
      // (With the MusicBrainz features, on to begin with, as it was with
      // those: turned off or on, it's that with them or without.)
      toggleRow({
        title: 'Skip live tracks and demos',
        subtitle: `Leaves them out of radio, shuffles and Guest DJs.${mbFeatures() ? ' Uses MusicBrainz too.' : ''}`,
        checked: skipLiveOn(),
        onChange: (v) => saveSettings({ skipLive: v, mbSkipLive: v }),
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
          subtitle: 'See and control what’s playing on your other devices.',
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

// The routes to a server (see plex.js ROUTE_RANKS), as Settings › Connection
// names them.
const ROUTE_NAMES = { local: 'On your network', proxy: 'Through this app', remote: 'Over the internet', relay: 'Plex relay (slow)' };
const ROUTE_CHOICES = [
  ['best', 'Best that works', 'Tries your network, this app, the internet, then Plex’s relay.'],
  ['container', 'Through this app', 'Always through this app.'],
  ['direct', 'Straight to the server', 'Through this app only if that fails.'],
];

// Why the app reaches the server the way it does.
function routeNote(src) {
  if (src.kind === 'proxy') {
    if (!src.connections?.length) return 'You chose the server this app is set up for, so it always goes through this app.';
    if (app.settings.route === 'container') return `Plexamp-web is set up to talk directly to ${src.serverName}, and you chose to always go through it.`;
    if (app.settings.route === 'direct') return `The server didn’t answer directly, so this goes through Plexamp-web, which is set up to talk to ${src.serverName}.`;
    return `Plexamp-web is set up to talk directly to ${src.serverName}. It’s the best route that answers right now (Test connection shows how fast each is).`;
  }
  if (src.kind === 'local') return 'Straight to the server, on your network.';
  if (src.kind === 'remote') return 'Straight to the server, over the internet.';
  if (src.kind === 'relay') return 'Through Plex’s relay, which is slow: the faster routes didn’t answer.';
  return '';
}

function routeResult(r) {
  if (r.ok) return `${fmt.number(r.ms)} ms`;
  return {
    http: 'Can’t be used from this secure (https) page',
    insecure: 'Not used: unencrypted over the internet',
    timeout: 'No answer within 6 seconds',
    network: 'No answer',
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
  if (src.kind !== 'proxy') return waited ? `No answer from ${src.serverName} within ${timeout / 1000} seconds.` : `${src.serverName} didn’t answer. Check it’s on and this device can reach it.`;
  const container = await fetch('config.js', { cache: 'no-store', credentials: 'omit' })
    .then((r) => r.ok)
    .catch(() => false);
  if (!container) return 'Plexamp-web didn’t answer either. Check this device’s connection.';
  if (proxyError) return `Plexamp-web can’t reach ${src.serverName} (error ${err.status}). Check the server is on, and the server address Plexamp-web was set up with.`;
  return `Plexamp-web answers, but ${src.serverName} didn’t answer through it${waited ? ` within ${timeout / 1000} seconds` : ''}. Check the server is on, and the server address Plexamp-web was set up with.`;
}

function debugView({ el, onDispose }) {
  const src = app.source || {};
  const kv = (k, v) => h('div.kv', null, h('div.kv-k', null, k), h('div.kv-v', null, v ?? '—'));
  const kinds = { local: 'On your network', remote: 'Over the internet', relay: 'Plex relay (slow)', manual: 'Address you entered', proxy: 'Through this app' };
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
        ? 'Its address on your network didn’t answer. Your browser or router may block it (Chrome asks first). The app uses the best route that works.'
        : '';
  };
  // Another route preference: the best route for it, now.
  const useRoute = async (prefer) => {
    saveSettings({ route: prefer });
    if (!pickable) return;
    try {
      const srv = (await listServers(app.auth.token)).find((x) => x.id === src.serverId);
      const conn = srv && (await pickConnection(srv, { proxy: proxyUri(), prefer }));
      const words = (kind) => (kind === 'proxy' ? 'through this app' : kind === 'local' ? 'on your network' : kind === 'remote' ? 'over the internet' : 'through Plex’s relay');
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
  routes.append(h('div.section-head', null, h('h2', null, 'Routes')), h('p.lede', null, `How this device can reach ${src.serverName}.`), routeList, routeHint);
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
      kv('Debug mode', app.config.debug ? 'On (problems go to Plexamp-web’s log, never sign-ins)' : 'Off'),
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
            // Live updates too, from the top: a WebSocket first, even one
            // that failed here lately (WEBSOCKETS=auto remembers that).
            live.forgetWebSocketFailure();
            live.start();
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
// while there's anything on it).
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
  function paint() {
    const n = missingCount();
    count.textContent = n ? fmt.number(n) : '';
    listRow.hidden = !aiSettings().missing && !n;
    showSub.textContent = `List songs and artists the AI suggests that you don’t have.${missingKeptNote()}`;
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
      // AI models make songs up: MusicBrainz knows which are real.
      mbOffered()
        ? toggleRow({
            title: 'Check suggestions on MusicBrainz',
            subtitle: `Drops made-up songs and artists, checked on ${mbWhere()} (only names are sent).`,
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
      subtitle: 'How long to wait for the AI to start answering.',
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
    ...(shared ? [['auto', 'This player’s model', 'The AI model this player provides.']] : []),
    ['custom', 'My own Ollama server', 'One you run. Its address and key stay on this device.'],
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
        ? 'For AI playlists and the AI DJ, on this device.'
        : 'For AI playlists and the AI DJ, on this device, with your own Ollama server.',
    ),
    h('div.section-head', null, h('h2', null, 'Where the model runs')),
    radioRows('Where the model runs', options, chosen(), (v) => {
      saveAI({ mode: v });
      render();
    }),
    ...(shared ? [] : [h('p.hint.pad', null, 'This player has no AI model of its own.')]),
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
    const name = h('span', null, sharedModelName() || '…');
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
        else if (st?.ready && st.loaded === false) status.textContent = 'Ready. The next request may take a few minutes while it loads.';
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
    const warn = h('p.hint.warn', { hidden: !insecure() }, 'Browsers block http addresses here, except localhost. Use https.');
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
      h('p.hint', null, 'Only if your Ollama server asks for one.'),
      warn,
      h('div.form-actions', null, h('button.btn.btn-primary', { type: 'submit' }, 'Connect')),
    );
    return [
      h('div.section-head', null, h('h2', null, 'Your Ollama server')),
      form,
      originsHelp(),
    ];
  }

  // Ollama answers only the sites in its OLLAMA_ORIGINS: how to add this
  // one, on each kind of computer (several go with commas between them).
  function originsHelp() {
    const site = location.origin;
    const step = (os, ...how) => h('li', null, h('strong', null, `${os}: `), ...how);
    return h(
      'details.pad.origins',
      null,
      h('summary', null, 'How to allow this site'),
      h('p.hint', null, 'Ollama only answers sites you allow. On the computer running it:'),
      h(
        'ul',
        null,
        step('Windows', 'in PowerShell, run ', h('code', null, `setx OLLAMA_ORIGINS "${site}"`), ', then quit Ollama (its icon by the clock) and open it again.'),
        step('Mac', 'in Terminal, run ', h('code', null, `launchctl setenv OLLAMA_ORIGINS "${site}"`), ', then quit Ollama and open it again (run it again after the Mac restarts).'),
        step('Linux', 'run ', h('code', null, 'sudo systemctl edit ollama'), ', add the lines ', h('code', null, '[Service]'), ' and ', h('code', null, `Environment="OLLAMA_ORIGINS=${site}"`), ', then ', h('code', null, 'sudo systemctl restart ollama'), '.'),
      ),
      h('p.hint', null, 'Already allowing other sites? Put them all in, with commas between.'),
    );
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
              onLoading: (on) => (out.textContent = on ? `Loading ${model || 'the AI model'}. The first time can take a few minutes…` : asking),
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
    h('label.field.pad', null, h('span', null, 'Your taste, for AI playlists and the AI DJ.'), area),
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
