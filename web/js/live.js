// Live updates from the Plex server: new music, changed playlists and
// ratings, and library scans.
//
// The quickest route is a WebSocket. Some networks (corporate proxies in
// particular) block those, so the same notifications are also read from
// Plex's event stream, which is plain HTTP, and as a last resort the app
// checks for changes every minute. That's WEBSOCKETS=auto on the container
// (the default); WEBSOCKETS=on uses WebSockets only, and off never does
// (as DISABLE_WEBSOCKETS=true did before 0.25.0).
import { app, on } from './state.js';
import { store } from './plex.js';
import { debugLog } from './debug.js';

const WS_OPEN_TIMEOUT = 8000;
const FIRST_EVENT_TIMEOUT = 25000; // Plex pings the event stream every 10 s
const SILENCE_LIMIT = 45000; // no pings for this long: a proxy is holding events back
const SHORT_LIVED = 60000; // connections that drop sooner than this count as failures
const POLL_VISIBLE = 60000;
const POLL_HIDDEN = 5 * 60000;
const WS_BLOCKED_FOR = 6 * 3600 * 1000;
const MAX_FAILURES = 3;
const WS_ONLY_RETRY_MAX = 60000; // WebSockets only: the longest wait between tries

const asArray = (v) => (Array.isArray(v) ? v : v ? [v] : []);
const EVENT_TYPES = ['timeline', 'activity', 'playing', 'status', 'progress', 'reachability', 'update.statechange'];

export const LIVE_MODES = {
  connecting: 'Connecting…',
  websocket: 'Instant',
  eventsource: 'Instant (backup route)',
  polling: 'Checking for changes every minute',
  off: 'Off',
};

class LiveUpdates extends EventTarget {
  constructor() {
    super();
    this.mode = 'off';
    this.note = '';
    this.gen = 0;
    this.closeFn = null;
    this.wakeFn = null;
    this.snapshot = null;
    this.scanning = null;
    this.pending = { library: false, playlists: new Set(), items: new Set() };
    this.flushTimers = {};

    on('source', () => this.start());
    on('signout', () => this.stop());
    document.addEventListener('visibilitychange', () => !document.hidden && this.wakeFn?.());
    window.addEventListener('online', () => this.mode !== 'off' && this.start());
  }

  // The player's choice (WEBSOCKETS on the container): 'auto' (a WebSocket,
  // or whatever gets through where one doesn't), 'on' (WebSockets only) or
  // 'off' (never).
  wsMode() {
    if (app.config.websockets === false) return 'off';
    return app.config.websockets === 'on' ? 'on' : 'auto';
  }

  // Why the WebSocket is skipped, or null when it may be tried.
  websocketBlockReason() {
    const mode = this.wsMode();
    if (mode === 'off') return 'This player is set up not to use WebSockets.';
    if (typeof WebSocket === 'undefined') return 'This browser can’t use WebSockets.';
    if (mode === 'on') return null; // (tried however often it's failed)
    const failedAt = store.get(this.blockKey());
    if (failedAt && Date.now() - failedAt < WS_BLOCKED_FOR) return 'WebSockets didn’t work on this network recently, so a backup route is used.';
    return null;
  }

  blockKey() {
    try {
      return `wsBlocked.${new URL(app.server.uri).host}`;
    } catch {
      return 'wsBlocked';
    }
  }

  forgetWebSocketFailure() {
    if (app.server) store.set(this.blockKey(), null);
  }

  start() {
    this.stop();
    const only = this.wsMode() === 'on';
    if (!app.server || !app.source || (only && typeof WebSocket === 'undefined')) {
      this.note = app.server && app.source ? 'This browser can’t use WebSockets, and this player is set up to use WebSockets only.' : '';
      this.setMode('off');
      return;
    }
    const gen = this.gen;
    this.run(gen).catch((err) => console.warn('live updates stopped', err));
  }

  stop() {
    this.gen += 1;
    this.closeFn?.();
    this.closeFn = null;
    this.wakeFn?.();
    this.snapshot = null;
    this.setScanning(null);
  }

  // Ask for an immediate check (polling) or reconnect sooner (other modes).
  checkNow() {
    this.wakeFn?.();
  }

  // Work down the chain: a transport that won't open, or keeps dropping,
  // hands over to the next one. WebSockets only (WEBSOCKETS=on): the
  // WebSocket, tried again and again.
  async run(gen) {
    const only = this.wsMode() === 'on';
    const chain = [];
    const blocked = this.websocketBlockReason();
    if (!blocked) chain.push('websocket');
    if (!only) chain.push('eventsource', 'polling');
    let note = blocked || (only ? 'This player is set up to use WebSockets only.' : '');
    this.note = note;
    this.setMode('connecting');

    for (const kind of chain) {
      let failures = 0;
      while (gen === this.gen) {
        const startedAt = Date.now();
        let opened = false;
        let error = null;
        this.note = note;
        try {
          await this.connect(kind, gen);
          opened = true;
        } catch (err) {
          error = err;
        }
        if (gen !== this.gen) return;
        if (opened && Date.now() - startedAt >= SHORT_LIVED) {
          failures = 0;
          await this.sleep(2000 + Math.random() * 3000, gen);
          continue;
        }
        // If Plex itself isn't answering (a restart, or the network is
        // down), the transport isn't to blame: wait and try it again.
        this.setMode('connecting');
        if (!(await this.serverReachable())) {
          if (gen !== this.gen) return;
          failures = 0;
          await this.sleep(15000, gen);
          continue;
        }
        if (gen !== this.gen) return;
        failures += 1;
        // (Said while it waits, not once it's connected again.)
        if (only) {
          this.note = 'Couldn’t connect from this network, trying again. This player is set up to use WebSockets only.';
          this.emit('mode', { mode: this.mode, note: this.note });
          await this.sleep(Math.min(WS_ONLY_RETRY_MAX, 3000 * 2 ** Math.min(failures - 1, 5)), gen);
          continue;
        }
        if (kind === 'websocket' && (!opened || failures >= MAX_FAILURES)) {
          store.set(this.blockKey(), Date.now());
          note = 'WebSockets don’t work on this network, so live updates use a backup route.';
          break;
        }
        // A Plex event stream pings every 10 s, so one that stays silent is
        // being held back by a proxy: move on straight away.
        if (kind === 'eventsource' && (error?.silent || failures >= MAX_FAILURES)) {
          note = `The backup route didn’t work either (${error?.message || 'it kept dropping'}), so the app checks for changes every minute.`;
          break;
        }
        await this.sleep(3000 * failures, gen);
      }
    }
  }

  async serverReachable() {
    try {
      await app.server.identity({ timeout: 8000 });
      return true;
    } catch {
      return false;
    }
  }

  connect(kind, gen) {
    if (kind === 'websocket') return this.connectWebSocket();
    if (kind === 'eventsource') return this.connectEventSource();
    return this.connectPolling(gen);
  }

  url(path) {
    return app.server.url(path);
  }

  // Resolves when an established connection ends; rejects if it never opens.
  connectWebSocket() {
    return new Promise((resolve, reject) => {
      let ws;
      try {
        ws = new WebSocket(this.url('/:/websockets/notifications').replace(/^http/, 'ws'));
      } catch (err) {
        reject(err);
        return;
      }
      let opened = false;
      const timer = setTimeout(() => {
        if (opened) return;
        ws.onclose = null;
        ws.close();
        reject(new Error('The WebSocket didn’t open.'));
      }, WS_OPEN_TIMEOUT);
      ws.onopen = () => {
        opened = true;
        clearTimeout(timer);
        this.forgetWebSocketFailure();
        this.setMode('websocket');
      };
      ws.onmessage = (e) => this.handle(e.data);
      ws.onclose = () => {
        clearTimeout(timer);
        this.closeFn = null;
        if (opened) resolve();
        else reject(new Error('The WebSocket was refused.'));
      };
      this.closeFn = () => {
        clearTimeout(timer);
        ws.onclose = null;
        ws.onmessage = null;
        try {
          ws.close();
        } catch {
          /* already closed */
        }
        resolve();
      };
    });
  }

  // Healthy only once events actually arrive: some proxies accept the
  // request but hold the stream back, which looks like a quiet server.
  connectEventSource() {
    return new Promise((resolve, reject) => {
      let es;
      try {
        es = new EventSource(this.url('/:/eventsource/notifications'));
      } catch (err) {
        reject(err);
        return;
      }
      let healthy = false;
      let lastEvent = 0;
      let errors = 0;
      const finish = () => {
        clearTimeout(firstTimer);
        clearInterval(watchdog);
        es.close();
        this.closeFn = null;
      };
      const firstTimer = setTimeout(() => {
        if (healthy) return;
        finish();
        reject(Object.assign(new Error('no events arrived'), { silent: true }));
      }, FIRST_EVENT_TIMEOUT);
      const watchdog = setInterval(() => {
        if (healthy && Date.now() - lastEvent > SILENCE_LIMIT) {
          finish();
          resolve();
        }
      }, 5000);
      const seen = () => {
        lastEvent = Date.now();
        errors = 0;
        if (healthy) return;
        healthy = true;
        clearTimeout(firstTimer);
        this.setMode('eventsource');
      };
      es.addEventListener('ping', seen);
      for (const type of EVENT_TYPES) {
        es.addEventListener(type, (e) => {
          seen();
          this.handle(e.data, type);
        });
      }
      es.onmessage = (e) => {
        seen();
        this.handle(e.data);
      };
      es.onerror = () => {
        errors += 1;
        if (es.readyState === EventSource.CLOSED || errors >= 3) {
          finish();
          if (healthy) resolve();
          else reject(new Error('the server or a proxy refused it'));
        }
      };
      this.closeFn = () => {
        finish();
        resolve();
      };
    });
  }

  async connectPolling(gen) {
    this.setMode('polling');
    this.snapshot = null;
    while (gen === this.gen) {
      try {
        await this.poll();
      } catch {
        /* server unreachable for now: keep checking */
      }
      await this.sleep(document.hidden ? POLL_HIDDEN : POLL_VISIBLE, gen);
    }
  }

  async poll() {
    const s = app.server;
    const sec = String(app.source.sectionKey);
    const [sections, playlists] = await Promise.all([s.get('/library/sections'), s.get('/playlists', { playlistType: 'audio' })]);
    const dir = asArray(sections.Directory).find((d) => String(d.key) === sec);
    const sig = dir ? [dir.contentChangedAt, dir.updatedAt, dir.scannedAt].map((v) => v ?? '').join(':') : '';
    const lists = new Map(asArray(playlists.Metadata).map((p) => [String(p.ratingKey), String(p.updatedAt ?? p.addedAt ?? '')]));
    const refreshing = dir && [true, 1, '1', 'true'].includes(dir.refreshing);
    this.setScanning(refreshing ? { title: `Plex is scanning ${dir.title}` } : null);

    const prev = this.snapshot;
    this.snapshot = { sig, lists };
    if (!prev) return;
    if (sig !== prev.sig) this.queueLibrary();
    const changed = [...lists].filter(([id, v]) => prev.lists.get(id) !== v).map(([id]) => id);
    const removed = [...prev.lists.keys()].filter((id) => !lists.has(id));
    if (changed.length || removed.length) this.queuePlaylists([...changed, ...removed]);
  }

  sleep(ms, gen) {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        resolve();
      }
      this.wakeFn = () => {
        this.wakeFn = null;
        done();
      };
      if (gen !== this.gen) done();
    });
  }

  // ---------- notifications ----------

  // WebSocket messages wrap everything in a NotificationContainer; event
  // stream messages carry one notification each, named by the event.
  handle(raw, typeHint) {
    let data;
    try {
      data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
      return;
    }
    const nc = data?.NotificationContainer || data || {};
    for (const entry of asArray(nc.TimelineEntry)) this.onTimeline(entry);
    for (const n of asArray(nc.ActivityNotification)) this.onActivity(n);
    if (typeHint === 'timeline' && !nc.TimelineEntry && nc.itemID) this.onTimeline(nc);
  }

  // Timeline states: 0 created, 1–4 in progress, 5 processed, 9 deleted.
  // Created and deleted items change what's in the library; "processed"
  // is also sent for edits, ratings and play counts on a single item.
  onTimeline(e) {
    if (e.identifier && e.identifier !== 'com.plexapp.plugins.library') return;
    const state = Number(e.state);
    if (![0, 5, 9].includes(state)) return;
    const type = Number(e.type);
    const id = e.itemID != null ? String(e.itemID) : null;
    if (type === 15) {
      if (state !== 0) this.queuePlaylists(id ? [id] : []);
      return;
    }
    const sec = e.sectionID != null && e.sectionID !== '' ? String(e.sectionID) : null;
    if (sec && sec !== '-1' && sec !== String(app.source?.sectionKey)) return;
    if ((state === 0 || state === 9) && [8, 9, 10].includes(type)) this.queueLibrary();
    if (state === 5 && id) this.queueItem(id);
  }

  onActivity(n) {
    const act = n.Activity || {};
    if (!/^library\./.test(String(act.type || ''))) return;
    const sec = act.Context?.librarySectionID;
    if (sec != null && String(sec) !== String(app.source?.sectionKey)) return;
    if (n.event === 'ended') {
      this.setScanning(null);
      this.queueLibrary();
    } else {
      this.setScanning({ title: act.title || 'Plex is updating your library', progress: act.progress });
    }
  }

  // ---------- batching ----------

  queueLibrary() {
    this.pending.library = true;
    this.flushLater('library', 4000);
  }

  queuePlaylists(ids) {
    ids.forEach((id) => this.pending.playlists.add(id));
    this.flushLater('playlists', 1500);
  }

  queueItem(id) {
    this.pending.items.add(id);
    this.flushLater('items', 1500);
  }

  flushLater(kind, ms) {
    if (this.flushTimers[kind]) return;
    this.flushTimers[kind] = setTimeout(() => {
      this.flushTimers[kind] = null;
      if (kind === 'library') {
        this.pending.library = false;
        this.emit('library', {});
      } else if (kind === 'playlists') {
        const ids = [...this.pending.playlists];
        this.pending.playlists.clear();
        this.emit('playlists', { ids });
      } else {
        const ids = [...this.pending.items];
        this.pending.items.clear();
        this.emit('items', { ids });
      }
    }, ms);
  }

  setScanning(scan) {
    const was = this.scanning;
    this.scanning = scan;
    if (!!was !== !!scan || (scan && was && scan.title !== was.title)) this.emit('scan', scan);
  }

  setMode(mode) {
    if (mode === this.mode) return;
    this.mode = mode;
    if (mode !== 'connecting') debugLog('live', `live updates: ${LIVE_MODES[mode] || mode}${this.note ? ` (${this.note})` : ''}`);
    this.emit('mode', { mode, note: this.note });
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}

export const live = new LiveUpdates();
