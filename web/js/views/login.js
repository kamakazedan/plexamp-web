import { setAuth, setSource, proxyUri } from '../state.js';
import { store, createPin, authUrl, checkPin, getUser, PlexServer } from '../plex.js';
import { navigate, describeError } from '../router.js';
import { h, icon, toast } from '../ui.js';
import { offlineAsked, offlineState, signInOffline } from '../offline.js';

const PIN_TTL = 15 * 60 * 1000;
// How often the page asks whether plex.tv is answering (more often while it
// isn't, till the offline key can be used).
const OFFLINE_EVERY = 10000;
const OFFLINE_SOON = 4000;
const TOKEN_HELP = 'https://support.plex.tv/articles/204059436-finding-an-authentication-token-x-plex-token/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function loginView({ el, query = {} }) {
  const status = h('p.login-status', { role: 'status' });
  const offline = offlinePanel(query);
  const signIn = h(
    'button.btn.btn-primary.btn-wide',
    { type: 'button', onclick: () => startSignIn(signIn, status) },
    h('span', null, 'Sign in with Plex'),
  );
  const tokenForm = manualForm();
  const toggle = h(
    'button.link-btn',
    {
      type: 'button',
      'aria-expanded': 'false',
      onclick: () => {
        const open = tokenForm.hidden;
        tokenForm.hidden = !open;
        toggle.setAttribute('aria-expanded', String(open));
        if (open) tokenForm.querySelector('input')?.focus();
      },
    },
    'Use a server address and token instead',
  );

  el.append(
    h(
      'div.login',
      null,
      h('img.login-mark', { src: 'icons/icon.svg', alt: '', width: 88, height: 88 }),
      h('h1.login-title', null, 'Play your Plex music'),
      h('p.login-text', null, 'Sign in with your Plex account. You’ll go to plex.tv to sign in, then come straight back here.'),
      offline?.el,
      signIn,
      status,
      toggle,
      tokenForm,
    ),
  );

  offline?.start();
  await resumeSignIn(signIn, status);
}

// While plex.tv isn't answering the player, nobody can sign in with Plex:
// this says so (asked every few seconds while the page is open), and where
// the player has an offline key (OFFLINE_KEY: see offline.js) that can be
// used now, takes it.
function offlinePanel(query) {
  if (!offlineAsked()) return null;
  const text = h('p.login-offline-text');
  const key = h('input', { type: 'password', autocomplete: 'off', placeholder: 'Offline key', 'aria-label': 'Offline key', required: true, maxlength: 200 });
  const submit = h('button.btn.btn-primary.btn-wide', { type: 'submit' }, icon('lock', 20), h('span', null, 'Use the offline key'));
  const said = h('p.login-status', { role: 'status' });
  const form = h(
    'form.login-offline-form',
    {
      hidden: true,
      onsubmit: async (e) => {
        e.preventDefault();
        submit.disabled = true;
        said.textContent = 'Signing in…';
        try {
          await signInOffline(key.value);
          // The app afresh, as it is with the key (no Together tab, say).
          history.replaceState(null, '', `${location.pathname}${location.search}#/`);
          location.reload();
        } catch (err) {
          said.textContent = err.status ? err.message : describeError(err);
          key.select();
        } finally {
          submit.disabled = false;
        }
      },
    },
    key,
    submit,
    said,
  );
  const el = h('div.login-offline', { hidden: true }, h('p.login-offline-title', null, icon('lock', 18), h('span', null, 'Offline mode')), text, form);
  const ended = query.offline === 'ended' || query.offline === 'gone';
  const show = (words, { withKey = false } = {}) => {
    text.textContent = words;
    form.hidden = !withKey;
    el.hidden = false;
  };
  if (query.offline === 'ended') show('plex.tv is answering again, so the offline key’s session has ended. Sign in with Plex.');
  if (query.offline === 'gone') show('The offline key’s session has ended (the player restarted, say). Use the key again.');
  const why = {
    off: '',
    'plex-tv': ' If it stays that way, this player’s offline key can be used here in a moment.',
    server: ' Nor can the offline key be used: your Plex server doesn’t let this player in without signing in.',
    'server-down': ' Your Plex server isn’t answering this player either.',
    network: ' Nor can the offline key be used from your network.',
  };
  // (Till the page goes: it's on screen, then not.)
  let timer = null;
  let shown = false;
  const gone = () => {
    shown ||= el.isConnected;
    return shown && !el.isConnected;
  };
  const again = (ms) => {
    clearTimeout(timer);
    if (!gone()) timer = setTimeout(check, ms);
  };
  const check = async () => {
    if (gone()) return;
    let state;
    try {
      state = await offlineState();
    } catch {
      return again(OFFLINE_EVERY);
    }
    if (state.plexTv !== 'down') {
      if (!ended) el.hidden = true;
      form.hidden = true;
      return again(OFFLINE_EVERY);
    }
    if (state.on) {
      const first = form.hidden;
      show('plex.tv isn’t answering this player, so you can’t sign in with Plex right now. This player is in offline mode: its offline key plays its library until plex.tv is back.', { withKey: true });
      if (first) key.focus();
      return again(OFFLINE_EVERY);
    }
    show(`plex.tv isn’t answering this player, so you can’t sign in with Plex right now.${why[state.why] ?? ''}`);
    again(state.why === 'plex-tv' ? OFFLINE_SOON : OFFLINE_EVERY);
  };
  return { el, start: check };
}

async function startSignIn(button, status) {
  button.disabled = true;
  status.textContent = 'Opening plex.tv…';
  try {
    const pin = await createPin();
    store.set('pendingPin', { id: pin.id, at: Date.now() });
    const back = `${location.href.split('#')[0]}#/login`;
    location.href = authUrl(pin, back);
  } catch (err) {
    button.disabled = false;
    status.textContent = `Couldn't start sign-in. ${describeError(err)}`;
  }
}

// After plex.tv sends the browser back, swap the PIN for a token.
async function resumeSignIn(button, status) {
  const pending = store.get('pendingPin');
  if (!pending) return;
  if (Date.now() - pending.at > PIN_TTL) {
    store.set('pendingPin', null);
    return;
  }
  button.disabled = true;
  status.textContent = 'Finishing sign-in…';
  try {
    let token = null;
    for (let i = 0; i < 10 && !token; i++) {
      token = await checkPin(pending.id);
      if (!token) await sleep(1500);
    }
    if (!token) {
      status.textContent = 'Sign-in wasn’t completed on plex.tv. Try again.';
      store.set('pendingPin', null);
      button.disabled = false;
      return;
    }
    store.set('pendingPin', null);
    let user = {};
    try {
      user = await getUser(token);
    } catch {
      /* the token still works without the profile */
    }
    setAuth({ token, username: user.username || user.title || user.email || 'Plex user', thumb: user.thumb || null, manual: false });
    navigate('/setup', { replace: true });
  } catch (err) {
    button.disabled = false;
    status.textContent = `Sign-in failed. ${describeError(err)}`;
  }
}

function manualForm() {
  const proxy = proxyUri();
  const url = h('input', { type: 'url', placeholder: 'http://192.168.1.10:32400', autocomplete: 'url', required: !proxy, value: '' });
  const token = h('input', { type: 'password', placeholder: 'Your X-Plex-Token', autocomplete: 'off', required: true });
  const submit = h('button.btn.btn-secondary.btn-wide', { type: 'submit' }, 'Connect');
  const form = h(
    'form.form.login-form',
    {
      hidden: true,
      onsubmit: async (e) => {
        e.preventDefault();
        const uri = (url.value.trim() || proxy || '').replace(/\/+$/, '');
        if (!/^https?:\/\//.test(uri)) return toast('Start the address with http:// or https://');
        submit.disabled = true;
        try {
          const ps = new PlexServer({ uri, token: token.value.trim() });
          const root = await ps.get('/', null, { timeout: 8000 });
          const sections = await ps.musicSections();
          if (!sections.length) throw new Error('That server has no music libraries.');
          setAuth({ token: token.value.trim(), username: root.friendlyName || 'Plex', thumb: null, manual: true });
          // Start with the first music library; the home screen's library
          // switcher lists the others.
          setSource({
            serverId: root.machineIdentifier || uri,
            serverName: root.friendlyName || new URL(uri).hostname,
            uri,
            kind: uri === proxy ? 'proxy' : 'manual',
            token: token.value.trim(),
            connections: [],
            sectionKey: String(sections[0].key),
            sectionTitle: sections[0].title,
          });
          navigate('/', { replace: true });
        } catch (err) {
          toast(err.status || err.network ? describeError(err) : err.message, { timeout: 6000 });
        } finally {
          submit.disabled = false;
        }
      },
    },
    h('label.field', null, h('span', null, proxy ? 'Server address (optional)' : 'Server address'), url),
    h('label.field', null, h('span', null, 'Token'), token),
    h('p.hint', null, h('a', { href: TOKEN_HELP, target: '_blank', rel: 'noopener' }, 'How to find your token'), icon('external', 14)),
    submit,
  );
  return form;
}
