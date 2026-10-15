// Play Together: listen in sync with Plex friends who use this same app.
//
// The container's service holds each session (queue, current track, and
// where in it everyone should be at a given moment). This module joins one,
// waits for changes with long-polling (plain HTTP, so it works where
// WebSockets are blocked), sends commands from the player's controls, and
// keeps local playback on the session's clock.
import { app, on, setSource, proxyUri } from './state.js';
import { store, listServers, pickConnection, PlexServer } from './plex.js';
import { player } from './player.js';
import { guestDJ } from './dj.js';
import { toast } from './ui.js';
import { navigate, clearViewCache } from './router.js';
import { debugLog } from './debug.js';

const API = 'api/together';
const WAIT_SECONDS = 25;
const INVITES_VISIBLE = 30000;
const INVITES_HIDDEN = 120000;
const clientNow = () => performance.timeOrigin + performance.now();

// The service checks tracks other people add; this checks them again before
// this device plays or shows them (Plex's own shapes for file and artwork).
const PART_KEY = /^\/library\/parts\/\d{1,12}(\/\d{1,14})?\/file\.[A-Za-z0-9]{1,8}$/;
const THUMB = /^\/library\/metadata\/\d{1,12}\/(thumb|art)(\/\d{1,14})?$/;
function cleanView(view) {
  if (!Array.isArray(view?.queue)) return view;
  view.queue = view.queue.map((t) => ({
    ...t,
    id: /^\d{1,12}$/.test(String(t.id)) ? String(t.id) : '0',
    partKey: PART_KEY.test(String(t.partKey || '')) ? t.partKey : null,
    thumb: THUMB.test(String(t.thumb || '')) ? t.thumb : null,
  }));
  return view;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class TogetherError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

// The fields a session needs from a track (the service checks them again).
export function slimTrack(t) {
  return {
    id: t.id,
    title: t.title,
    artist: t.artist,
    albumArtist: t.albumArtist,
    album: t.album,
    artistId: t.artistId,
    albumId: t.albumId,
    thumb: t.thumb,
    duration: t.duration,
    year: t.year,
    codec: t.codec,
    bitrate: t.bitrate,
    partKey: t.partKey,
  };
}

class Together extends EventTarget {
  constructor() {
    super();
    this.session = null; // the latest full view of the session this device is in
    this.me = null; // { id, title, thumb } as plex.tv knows this account
    this.invites = []; // sessions this person is invited to
    this.elsewhere = []; // sessions this person is in but this device isn't following
    this.status = 'off'; // off | live | reconnecting
    this.blocked = false; // the browser wants a tap before playing sound
    this.listening = true;
    this.offset = 0; // server clock minus this device's clock (ms)
    this.samples = [];
    this.gen = 0;
    this.ctrl = null;
    this.seenInvites = new Set();
    this.inviteTimer = null;
    this.prevSource = null;
    this.remote = {
      play: () => this.play(),
      pause: () => this.pause(),
      toggle: () => this.toggle(),
      seek: (sec) => this.seek(sec),
      command: (cmd) => this.command(cmd),
      ended: (track) => this.command({ type: 'ended', sid: track.sid }, { quiet: true }),
      expectedTime: (sid) => this.expectedTime(sid),
      sleep: () => this.leave({ why: 'sleep' }),
      blocked: () => this.setBlocked(true),
    };

    on('signout', () => {
      this.detach();
      this.invites = [];
      this.elsewhere = [];
      this.me = null;
      this.emit('invites');
    });
    // Switching to another server while in a session leaves it: its tracks
    // only exist on its own server.
    on('source', ({ source }) => {
      if (this.session && source && source.serverId !== this.session.server.id) {
        this.leave({ why: 'source' });
      }
    });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && this.enabled) this.refresh().catch(() => {});
    });
  }

  get enabled() {
    return !!app.config.together && !!app.auth?.token;
  }

  get active() {
    return !!this.session && !this.session.ended;
  }

  get isHost() {
    return this.active && this.session.host.id === this.session.you;
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  // ---------- requests ----------

  async api(path, { method = 'GET', body, timeout = 15000, signal } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    const abort = () => ctrl.abort();
    signal?.addEventListener('abort', abort);
    const t0 = clientNow();
    let res;
    try {
      res = await fetch(`${API}/${path}`, {
        method,
        cache: 'no-store',
        credentials: 'same-origin',
        headers: {
          Accept: 'application/json',
          'X-Plex-Token': app.auth?.token || '',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
    } catch (err) {
      const e = new TogetherError(signal?.aborted ? 'aborted' : 'Can’t reach this player’s server.', 0);
      e.aborted = !!signal?.aborted;
      e.network = !e.aborted;
      e.cause = err;
      throw e;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
    const t1 = clientNow();
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* empty or not JSON */
    }
    if (!res.ok) {
      const fallback = res.status === 404 && !data ? 'Play Together isn’t available on this player.' : `Something went wrong (${res.status}).`;
      throw new TogetherError(data?.error || fallback, res.status);
    }
    return { data: data || {}, t0, t1 };
  }

  // Clock: the server stamps each answer with its time. Answers that came
  // back fastest pin it down best, so the offset comes from the quickest of
  // the recent ones.
  sample(serverNow, t0, t1) {
    if (!Number.isFinite(serverNow)) return;
    this.samples.push({ rtt: t1 - t0, offset: serverNow - (t0 + t1) / 2 });
    if (this.samples.length > 12) this.samples.shift();
    const best = this.samples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
    this.offset = best.offset;
  }

  serverNow() {
    return clientNow() + this.offset;
  }

  async clockCheck(n = 3) {
    for (let i = 0; i < n && this.active; i++) {
      try {
        const { data, t0, t1 } = await this.api(`sessions/${this.session.id}?since=${Number.MAX_SAFE_INTEGER}`);
        this.sample(data.now, t0, t1);
      } catch {
        return;
      }
    }
  }

  // ---------- invitations ----------

  // Sessions this person hosts, joined or is invited to.
  async refresh() {
    if (!this.enabled) return [];
    const { data } = await this.api('me');
    this.me = data.user || null;
    const sessions = Array.isArray(data.sessions) ? data.sessions : [];
    const mine = this.session?.id;
    this.invites = sessions.filter((s) => s.role === 'invited');
    this.elsewhere = sessions.filter((s) => s.role !== 'invited' && s.id !== mine);
    for (const s of this.invites) {
      if (this.seenInvites.has(s.id)) continue;
      this.seenInvites.add(s.id);
      if (location.hash.startsWith('#/together')) continue;
      toast(`${s.host.title} invited you to listen together.`, { action: 'Open', onAction: () => navigate('/together'), timeout: 10000 });
    }
    this.emit('invites');
    return sessions;
  }

  // Check for invitations now and then while the app is open. Stops if Play
  // Together can't work for this sign-in (plex.tv doesn't know the token,
  // or the player has it turned off); signing in again starts it afresh.
  watch() {
    clearTimeout(this.inviteTimer);
    this.inviteTimer = null;
    if (!this.enabled) return;
    const tick = async () => {
      try {
        await this.refresh();
      } catch (err) {
        if (err.status === 401 || err.status === 404) {
          debugLog('together', `not checking for invitations: ${err.message}`);
          this.inviteTimer = null;
          return;
        }
      }
      this.inviteTimer = setTimeout(tick, document.hidden ? INVITES_HIDDEN : INVITES_VISIBLE);
    };
    this.inviteTimer = setTimeout(tick, 0);
  }

  // After a reload: pick up the session this device was following.
  async resume() {
    if (!this.enabled) return;
    const saved = store.get('together');
    let sessions = [];
    try {
      sessions = await this.refresh();
    } catch {
      return;
    }
    const s = saved && sessions.find((x) => x.id === saved.id && x.role !== 'invited');
    if (!s) {
      if (saved) store.set('together', null);
      return;
    }
    try {
      const { data } = await this.api(`sessions/${s.id}`);
      await this.useServer(data.server);
      this.attach(data);
    } catch (err) {
      debugLog('together', `couldn't resume a session: ${err.message}`);
      store.set('together', null);
    }
  }

  // ---------- starting, joining, leaving ----------

  async friends() {
    const { data } = await this.api(`friends?server=${encodeURIComponent(app.source?.serverId || '')}`);
    return data.friends || [];
  }

  async start({ invite = [], withQueue = true } = {}) {
    const src = app.source;
    if (!src) throw new TogetherError('Choose a music library first.', 400);
    const from = Math.max(0, player.index);
    const queue = withQueue && player.current ? player.queue.slice(from, from + 500).map(slimTrack) : [];
    const { data, t0, t1 } = await this.api('sessions', {
      method: 'POST',
      body: {
        server: { id: src.serverId, name: src.serverName, section: src.sectionKey, sectionTitle: src.sectionTitle },
        invite,
        queue,
        index: 0,
        position: queue.length ? Math.round(player.time * 1000) : 0,
        playing: queue.length > 0 && player.isPlaying,
      },
    });
    this.sample(data.now, t0, t1);
    this.prevSource = null;
    this.attach(data);
    return data;
  }

  async join(id) {
    // Joining is a tap: warm up the audio now, while the browser still
    // counts it as one (the requests below take a moment).
    player.unlock({ all: true });
    const sessions = await this.refresh();
    const s = sessions.find((x) => x.id === id);
    if (!s) throw new TogetherError('This invitation has ended, or isn’t for you.', 404);
    // Joining another session leaves this one (the service does the same).
    if (this.active && this.session.id !== id) this.detach();
    await this.useServer(s.server);
    const { data, t0, t1 } = await this.api(`sessions/${id}/join`, { method: 'POST' });
    this.sample(data.now, t0, t1);
    this.invites = this.invites.filter((x) => x.id !== id);
    this.emit('invites');
    this.setBlocked(false);
    this.attach(data);
    return data;
  }

  async decline(id) {
    await this.api(`sessions/${id}/leave`, { method: 'POST' });
    this.invites = this.invites.filter((x) => x.id !== id);
    this.emit('invites');
  }

  // Tracks in a session are the session server's, so this device switches
  // to that server and library first if it's on another one.
  async useServer(server) {
    const src = app.source;
    if (src?.serverId === server.id) {
      if (String(src.sectionKey) !== String(server.section)) {
        setSource({ ...src, sectionKey: String(server.section), sectionTitle: server.sectionTitle });
        clearViewCache();
      }
      return;
    }
    if (app.auth?.manual) {
      throw new TogetherError(`This session plays from ${server.name}. Switch to it in Settings › Source first.`, 400);
    }
    const servers = await listServers(app.auth.token);
    const srv = servers.find((x) => x.id === server.id);
    if (!srv) throw new TogetherError(`You can’t play from ${server.name}. Ask its owner to share their music library with you.`, 403);
    let conn = null;
    const proxy = proxyUri();
    if (proxy) {
      try {
        const root = await new PlexServer({ uri: proxy, token: srv.token }).get('/', null, { timeout: 6000 });
        if (root.machineIdentifier === server.id) conn = { uri: proxy, kind: 'proxy' };
      } catch {
        /* not the server this app proxies */
      }
    }
    conn ||= await pickConnection(srv);
    if (!conn) throw new TogetherError(`Can’t reach ${server.name} from this browser.`, 0);
    this.prevSource = src;
    setSource({
      serverId: srv.id,
      serverName: srv.name,
      uri: conn.uri,
      kind: conn.kind,
      token: srv.token,
      connections: srv.connections,
      sectionKey: String(server.section),
      sectionTitle: server.sectionTitle,
    });
    clearViewCache();
  }

  attach(view) {
    this.detach({ keepSaved: true });
    this.session = cleanView(view);
    store.set('together', { id: view.id });
    if (guestDJ.active) guestDJ.set(null, { quiet: true });
    player.setRemote(this.remote);
    this.status = 'live';
    this.syncPlayer();
    this.emit('change');
    const gen = ++this.gen;
    this.ctrl = new AbortController();
    this.loop(gen);
    this.clockCheck();
    this.clockTimer = setInterval(() => this.clockCheck(1), 120000);
    debugLog('together', `following session ${view.id.slice(0, 6)} (${view.role})`);
  }

  // Stop following the session on this device (without telling anyone).
  detach({ keepSaved = false } = {}) {
    this.gen += 1;
    this.ctrl?.abort();
    clearInterval(this.clockTimer);
    const was = this.session;
    this.session = null;
    this.status = 'off';
    this.blocked = false;
    this.samples = [];
    if (!keepSaved) store.set('together', null);
    if (player.remote === this.remote) player.setRemote(null);
    if (was) this.emit('change');
  }

  async leave({ why } = {}) {
    const s = this.session;
    if (!s) return;
    this.detach();
    player._pause();
    try {
      await this.api(`sessions/${s.id}/leave`, { method: 'POST' });
    } catch {
      /* it ends on its own once nobody is there */
    }
    const back = this.prevSource;
    this.prevSource = null;
    const text =
      why === 'sleep'
        ? 'Sleep timer: you left the session.'
        : why === 'source'
          ? 'You left the session because you switched to another library.'
          : 'You left the session.';
    if (back && why !== 'source') {
      toast(text, { action: `Back to ${back.serverName}`, onAction: () => (setSource(back), clearViewCache(), navigate('/')), timeout: 8000 });
    } else {
      toast(text);
    }
    this.refresh().catch(() => {});
  }

  async end() {
    const s = this.session;
    if (!s) return;
    await this.api(`sessions/${s.id}`, { method: 'DELETE' });
    this.detach();
    player._pause();
    toast('Session ended for everyone.');
  }

  async invite(ids) {
    const { data } = await this.api(`sessions/${this.session.id}/invite`, { method: 'POST', body: { invite: ids } });
    this.apply(data);
  }

  async removePerson(userId) {
    const { data } = await this.api(`sessions/${this.session.id}/remove`, { method: 'POST', body: { user: userId } });
    this.apply(data);
  }

  ended(why) {
    const s = this.session;
    this.detach();
    player._pause();
    toast(why || 'The session has ended.', { timeout: 6000 });
    debugLog('together', `session ${s?.id.slice(0, 6)} ended: ${why}`);
    this.refresh().catch(() => {});
  }

  // ---------- following the session ----------

  async loop(gen) {
    let backoff = 1000;
    while (gen === this.gen && this.active) {
      try {
        const { data } = await this.api(`sessions/${this.session.id}?since=${this.session.version}&wait=${WAIT_SECONDS}`, {
          timeout: (WAIT_SECONDS + 15) * 1000,
          signal: this.ctrl.signal,
        });
        if (gen !== this.gen) return;
        if (this.status !== 'live') {
          this.status = 'live';
          this.emit('status');
        }
        backoff = 1000;
        if (!data.unchanged) this.apply(data);
      } catch (err) {
        if (gen !== this.gen || err.aborted) return;
        if (err.status === 404 || err.status === 410) return this.ended('The session has ended.');
        if (err.status === 403) return this.ended('You’re no longer in this session.');
        if (err.status === 401) return this.ended('Plex didn’t accept your sign-in, so you left the session.');
        if (this.status !== 'reconnecting') {
          this.status = 'reconnecting';
          this.emit('status');
          debugLog('together', `lost the session (${err.message}); retrying`);
        }
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 15000);
      }
    }
  }

  apply(view) {
    const s = this.session;
    if (!s || !view || view.id !== s.id || view.unchanged) return;
    if (view.version < s.version) return; // an older answer arriving late
    this.session = cleanView(view);
    if (view.ended) return this.ended(view.ended);
    if (!this.isMember(view)) return this.ended('You’re no longer in this session.');
    this.syncPlayer();
    this.emit('change');
  }

  isMember(view) {
    return view.role === 'host' || view.role === 'member';
  }

  // Where the session's current track should be right now, in ms.
  expectedMs() {
    const s = this.session;
    if (!s) return 0;
    const cur = s.queue[s.index];
    let p = s.position + (s.playing ? this.serverNow() - s.at : 0);
    if (cur?.duration) p = Math.min(p, cur.duration);
    return Math.max(0, p);
  }

  // For the player: the expected position in seconds, if `sid` is the
  // session's current track and it's playing.
  expectedTime(sid) {
    const s = this.session;
    if (!s || !s.playing || this.blocked || !this.listening) return null;
    const cur = s.queue[s.index];
    if (!cur || (sid && cur.sid !== sid)) return null;
    return this.expectedMs() / 1000;
  }

  syncPlayer({ force = false } = {}) {
    const s = this.session;
    if (!s) return;
    const host = s.host.id === s.you ? 'you' : s.host.title;
    player.syncRemote({
      items: s.queue,
      index: s.index,
      playing: s.playing && !this.blocked && this.listening,
      position: () => this.expectedMs(),
      context: { title: host === 'you' ? 'Your Play Together session' : `Listening with ${host}`, href: '/together' },
      force,
    });
  }

  setBlocked(on) {
    if (this.blocked === on) return;
    this.blocked = on;
    this.emit('blocked');
    if (on && this.active) {
      toast('Tap to start listening with everyone.', { action: 'Listen', onAction: () => this.listen(), timeout: 60000 });
    }
  }

  // A tap to (re)start sound on this device, after the browser held it back
  // or a track failed to play here.
  listen() {
    this.setBlocked(false);
    player.unlock({ all: true });
    if (!this.active) return;
    this.syncPlayer({ force: true });
    if (this.session.playing) player._play();
  }

  // ---------- commands ----------

  async command(cmd, { quiet = false } = {}) {
    if (!this.active) return;
    try {
      const { data, t0, t1 } = await this.api(`sessions/${this.session.id}/command`, { method: 'POST', body: cmd });
      this.sample(data.now, t0, t1);
      this.apply(data);
    } catch (err) {
      if (err.status === 404 || err.status === 410) return this.ended('The session has ended.');
      if (!quiet) toast(err.message);
      // Put this device back in line with the session.
      this.syncPlayer();
    }
  }

  play() {
    if (!this.active) return;
    // A tap: start straight away so the browser lets sound play, then tell
    // the others. (If the session is already playing, just catch up.)
    this.listen();
    if (!this.session.playing) {
      player._play();
      this.command({ type: 'play' });
    }
  }

  pause() {
    if (!this.active) return;
    player._pause();
    this.command({ type: 'pause' });
  }

  toggle() {
    if (!this.active) return;
    if (this.session.playing && !player.isPlaying) return this.listen(); // sound held back on this device
    if (this.session.playing) this.pause();
    else this.play();
  }

  seek(sec) {
    if (!this.active) return;
    player._seek(sec);
    this.command({ type: 'seek', position: Math.round(sec * 1000) });
  }
}

export const together = new Together();
