// Downloads, in the Android app (see downloads.js): Settings › Downloads
// (the phone's space, what's downloading, the settings for downloads, and
// the playlists kept, each with the space it takes, another server's apart);
// downloading a playlist from its page; offline, the playlists on the phone,
// to play; and another server's, here or offline.
import { app, playlistScope } from '../state.js';
import { navigate, refresh, dropCached } from '../router.js';
import { connection } from '../connection.js';
import { normTrack } from '../plex.js';
import { playList, playPlaylist } from '../actions.js';
import { trackRow, numberedList, playlistArt, downloadedMark } from '../components.js';
import { h, icon, iconButton, art, card, grid, row, sheet, toast, hideToast, fmt, backHeader, pageHeader, sectionHeader, choiceRow, confirmAction, errorState, emptyState, pagedList } from '../ui.js';
import {
  downloads,
  downloadsHere,
  downloadState,
  refreshDownloads,
  canCheckDownloads,
  checkDownloads,
  addDownload,
  removeDownload,
  setDownloads,
  downloadedPlaylist,
  playableHere,
  bytesText,
  complete,
  otherDownloads,
  otherServer,
  phoneTracks,
  phonePicture,
} from '../downloads.js';

// (As the app has them: see DownloadSettings.kt.)
const QUALITIES = [
  ['original', 'Original', 'Your files as they are. The biggest.'],
  ['320', 'High (320 kbps)', 'About 140 MB an hour of music.'],
  ['192', 'Normal (192 kbps)', 'About 85 MB an hour.'],
  ['128', 'Data saver (128 kbps)', 'About 60 MB an hour.'],
];
const NETWORKS = [
  ['wifi', 'Wi-Fi only', 'Saves your mobile data.'],
  ['any', 'Wi-Fi and mobile data', 'Downloads and updates anywhere.'],
];
const PREFER = [
  ['always', 'Always', 'From this phone, even on Wi-Fi.'],
  ['mobile', 'On mobile data', 'Streams on Wi-Fi.'],
  ['offline', 'Only offline', 'Streams whenever your server can be reached.'],
];

// Why a playlist wasn't added (the app's codes: see DownloadBridge.kt).
const REFUSALS = {
  unreachable: 'Couldn’t reach your server. Try again when you’re connected.',
  server: 'Your server couldn’t list that playlist. Try again.',
  missing: 'That playlist isn’t on your server any more.',
  empty: 'That playlist has no tracks to download.',
  signin: 'Your server didn’t accept the sign-in. Sign in again, then try.',
  account: 'This phone can’t reach your server securely, so it can’t download from it.',
  timeout: 'Your server took too long to answer. Try again.',
};

const playlistOf = (id) => downloadState()?.playlists?.find((p) => p.id === String(id)) || null;

// What a playlist still to come waits for, where nothing's being done for
// it now: as the app's status says.
const WAITS = {
  wifi: 'Waiting for Wi-Fi',
  offline: 'Waiting for a connection',
  unreachable: 'Can’t reach your server',
  signin: 'Sign in again to download',
};
function waitingLine(p, st = downloadState()) {
  const s = st?.status?.state;
  const left = `${fmt.number(p.saved)} of ${fmt.number(p.tracks)}`;
  return s === 'downloading' ? `Downloading… ${left}` : `${WAITS[s] || 'Waiting'} · ${left}`;
}

// Another server's name, as you'd say where its downloads are from.
const fromName = (o) => (o?.name ? `From ${o.name}` : 'From another server');

// What's happening to a playlist now, as the app says (its status names the
// playlist it's on): { doing: 'checking' } for changes; { doing:
// 'downloading', done, total }, its own tracks; { doing: 'waiting' }, still
// to come; or null. (An app before 0.2.4 counts every playlist's tracks
// together: then it's the playlist's count as the app last gave it.)
function nowOf(p, st = downloadState()) {
  const s = st?.status || {};
  if (s.state !== 'downloading' || !s.playlist) return null;
  if (s.playlist === p.id) {
    if (s.checking) return { doing: 'checking' };
    const own = s.total === p.tracks && s.done >= 0 && s.done <= s.total;
    return { doing: 'downloading', done: own ? s.done : p.saved, total: p.tracks };
  }
  if (complete(p)) return null;
  // (Each is checked first, then downloaded in turn, in the app's order.)
  const order = (st.playlists || []).map((x) => x.id);
  return s.checking || order.indexOf(p.id) > order.indexOf(s.playlist) ? { doing: 'waiting' } : null;
}

// "40 tracks · 1.2 GB", "12 of 40 tracks · 340 MB", "3 tracks didn't fit · 1.1 GB".
function playlistLine(p) {
  const size = bytesText(p.bytes);
  const missing = Math.max(0, p.tracks - p.saved);
  if (!missing) return `${fmt.count(p.tracks, 'track', 'tracks')} · ${size}`;
  if (p.problem === 'space') return `${fmt.count(missing, 'track', 'tracks')} didn’t fit · ${size}`;
  if (p.problem === 'failed') return `${fmt.count(missing, 'track', 'tracks')} couldn’t download · ${size}`;
  return `${fmt.number(p.saved)} of ${fmt.count(p.tracks, 'track', 'tracks')} · ${size}`;
}

// A playlist's line in Settings › Downloads: what's happening to it, or its
// size.
function rowLine(p, now) {
  if (now?.doing === 'checking') return 'Checking for changes…';
  if (now?.doing === 'downloading') return `Downloading… ${fmt.number(now.done)} of ${fmt.count(now.total, 'track', 'tracks')}`;
  if (now?.doing === 'waiting') return `Waiting · ${fmt.number(p.saved)} of ${fmt.count(p.tracks, 'track', 'tracks')}`;
  return playlistLine(p);
}

const share = (done, total) => `${Math.max(0, Math.min(100, (done / total) * 100)).toFixed(1)}%`;

// ---------- downloading a playlist ----------

// Keeps a playlist on the phone: says it's started (and where to follow it,
// `here` being Settings › Downloads itself), or why it can't. Resolves to
// whether it started.
export async function downloadPlaylist(pl, { here = false } = {}) {
  const title = pl.title || 'Playlist';
  // (The app asks the server about it first: said if that takes a moment.)
  const slow = setTimeout(() => toast(`Getting “${title}” ready…`, { timeout: 60000 }), 600);
  try {
    await addDownload(pl.ratingKey);
  } catch (err) {
    hideToast();
    if (err?.code === 'space') notEnoughSpace(title, err);
    else toast(REFUSALS[err?.code] || 'Couldn’t start the download. Try again.');
    return false;
  } finally {
    clearTimeout(slow);
  }
  // (On mobile data, with Wi-Fi only: it waits.)
  const st = downloadState();
  const wifi = st?.status?.state === 'wifi';
  const said = wifi ? `“${title}” downloads on Wi-Fi` : `Downloading “${title}”`;
  toast(said, here ? {} : { action: 'See progress', onAction: () => navigate('/settings/downloads'), timeout: 6000 });
  return true;
}

function notEnoughSpace(title, { needed, free }) {
  const lower = (downloadState()?.settings?.quality || 'original') !== '128';
  sheet({
    title: 'Not enough space',
    variant: 'dialog',
    closeLabel: 'OK',
    content: h(
      'div.ask-form',
      null,
      h('p.ask-message', null, `“${title}” needs about ${bytesText(needed)}, and this phone has ${bytesText(free)} free for downloads.`),
      lower ? h('p.ask-message.ask-after', null, 'A lower download quality takes less space.') : null,
    ),
  });
}

// (`server`: another server's.) Resolves to whether it's gone.
function remove(p, server) {
  return removeDownload(p.id, server || undefined)
    .then(() => {
      toast(`Removed “${p.title}” from this phone`);
      return true;
    })
    .catch(() => {
      toast('Couldn’t remove it. Try again.');
      return false;
    });
}

// Under a playlist's title (Android app only): Download, or how its
// download's going; once it's downloaded, a tap offers to remove it.
export function downloadLine(pl, onDispose) {
  if (!downloadsHere() || (pl.playlistType || 'audio') !== 'audio') return null;
  const id = String(pl.ratingKey);
  let busy = false;
  const label = h('span');
  const btn = h('button.hero-meta.dl-line.link-btn', { type: 'button', onclick: () => tapped() }, icon('download', 18), label);
  const paint = () => {
    const p = playlistOf(id);
    const done = !!p && complete(p);
    const now = p ? nowOf(p) : null;
    btn.firstChild.replaceWith(icon(done ? 'downloaded' : 'download', 18));
    btn.classList.toggle('on', !!p);
    btn.setAttribute('aria-busy', String(busy));
    label.textContent = busy
      ? 'Getting ready…'
      : !p
        ? 'Download'
        : now?.doing === 'downloading'
          ? `Downloading… ${fmt.number(now.done)} of ${fmt.number(now.total)}`
          : done
            ? 'Downloaded'
            : now?.doing === 'checking'
              ? 'Checking for changes…'
              : now?.doing === 'waiting'
                ? `Waiting · ${fmt.number(p.saved)} of ${fmt.number(p.tracks)}`
                : p.problem
                  ? `Downloaded ${fmt.number(p.saved)} of ${fmt.number(p.tracks)}`
                  : waitingLine(p);
  };
  async function tapped() {
    if (busy) return;
    const p = playlistOf(id);
    if (p) {
      sheet({
        title: pl.title,
        subtitle: playlistLine(p),
        actions: [
          { icon: 'download', label: 'See downloads', onSelect: () => navigate('/settings/downloads') },
          { icon: 'trash', label: 'Remove download', description: 'From this phone, not your server', danger: true, onSelect: () => remove(p) },
        ],
      });
      return;
    }
    busy = true;
    paint();
    await downloadPlaylist(pl);
    busy = false;
    paint();
  }
  paint();
  downloads.addEventListener('change', paint);
  onDispose(() => downloads.removeEventListener('change', paint));
  return btn;
}

// ---------- Settings › Downloads ----------

export async function downloadsView({ el, onDispose }) {
  el.append(backHeader('Downloads', { fallback: '/settings' }));
  if (!downloadsHere()) {
    el.append(emptyState('Download playlists in the Android app, to play them without a connection.'));
    return;
  }
  // (Asked afresh each time, for the phone's free space, say: shown as it
  // was till then, if it's known.)
  const fresh = refreshDownloads();
  let st = downloadState();
  if (st) fresh.catch(() => {});
  else st = await fresh.catch(() => null);
  if (!st) {
    el.append(errorState('Couldn’t see what’s downloaded. Try again.', () => refresh()));
    return;
  }

  const space = h('div.dl-space');
  const status = h('div.dl-status');
  const list = h('div.rows.dl-playlists');
  const none = h('p.lede.dl-none', null, 'Downloaded playlists play without a connection.');
  // Another server's, each apart (redrawn only as they change).
  const elsewhere = h('div.dl-elsewhere');
  let elsewhereKey = '';

  const s = st.settings || {};
  let quality = s.quality || 'original';
  const save = (patch) => setDownloads(patch).catch(() => toast('Couldn’t save that. Try again.'));
  el.append(
    space,
    status,
    h('div.section-head', null, h('h2', null, 'Settings')),
    h(
      'div.rows',
      null,
      choiceRow({
        title: 'Download quality',
        options: QUALITIES,
        value: quality,
        onChange: (v) => {
          if (v === quality) return;
          quality = v;
          save({ quality: v }).then(() => downloadState()?.playlists?.length && toast('Downloading your playlists again, at the new quality'));
        },
      }),
      choiceRow({ title: 'Download on', options: NETWORKS, value: s.network || 'wifi', onChange: (v) => save({ network: v }) }),
      choiceRow({ title: 'Play downloads', options: PREFER, value: s.prefer || 'always', onChange: (v) => save({ prefer: v }) }),
    ),
    h('div.section-head', null, h('h2', null, 'Playlists')),
    h('div.rows', null, row({ lead: h('span.row-icon', null, icon('plus', 26)), title: 'Add playlists', onClick: () => addPlaylists(), cls: 'dl-add' })),
    list,
    none,
    elsewhere,
  );

  // Each playlist's row, kept as it changes (rebuilt only for a new title
  // or picture), so a download going on doesn't redraw the list.
  const rows = new Map();
  const playlistRow = (p) => {
    const sub = h('div.row-sub');
    // (How far the one downloading has got.)
    const bar = h('div.dl-progress', { 'aria-hidden': 'true', hidden: true }, h('span'));
    const el = h(
      'div.row.dl-row',
      null,
      h('a.row-link', { href: `#/playlist/${p.id}` }, art(p.cover, { size: 52, fallback: 'list' }), h('div.row-main', null, h('div.row-title', null, p.title), sub, bar)),
      iconButton('trash', `Remove ${p.title} from this phone`, () => askRemove(p), { cls: 'dl-remove' }),
    );
    return { el, sub, bar, key: `${p.title}\n${p.cover || ''}` };
  };
  // (`server`: another server's.)
  const askRemove = async (p, server = null) => {
    const now = (server ? otherServer(server)?.playlists.find((x) => x.id === p.id) : playlistOf(p.id)) || p;
    const yes = await confirmAction({ title: `Remove “${now.title}”?`, message: `It comes off this phone (${bytesText(now.bytes)}), not your server.`, confirm: 'Remove' });
    if (yes) remove(now, server);
  };
  const otherRow = (o, p) =>
    h(
      'div.row.dl-row',
      null,
      h(
        'a.row-link',
        { href: `#${phonePlaylistPath(o.server, p.id)}` },
        art(phonePicture(p.cover, o.server), { size: 52, fallback: 'list' }),
        h('div.row-main', null, h('div.row-title', null, p.title), h('div.row-sub', null, playlistLine(p))),
      ),
      iconButton('trash', `Remove ${p.title} from this phone`, () => askRemove(p, o.server), { cls: 'dl-remove' }),
    );
  const paintElsewhere = () => {
    const all = otherDownloads();
    const key = JSON.stringify(all.map((o) => [o.server, o.name, o.playlists.map((p) => [p.id, p.title, p.cover, p.saved, p.tracks, p.bytes])]));
    if (key === elsewhereKey) return;
    elsewhereKey = key;
    elsewhere.replaceChildren(
      ...all.map((o) =>
        h(
          'section.dl-server',
          null,
          h('div.section-head', null, h('h2', null, fromName(o))),
          h('p.dl-server-note', null, 'Updated when you’re back on that server.'),
          h('div.rows', null, o.playlists.map((p) => otherRow(o, p))),
        ),
      ),
    );
  };

  let checking = false;
  const check = async () => {
    if (checking) return;
    checking = true;
    try {
      await checkDownloads();
    } catch {
      toast('Couldn’t check for changes. Try again.');
    } finally {
      checking = false;
    }
  };

  function paint() {
    const now = downloadState() || st;
    paintSpace(space, now);
    paintStatus(status, now, canCheckDownloads() ? check : null);
    const playlists = now.playlists || [];
    const order = [];
    for (const p of playlists) {
      let r = rows.get(p.id);
      const key = `${p.title}\n${p.cover || ''}`;
      if (!r || r.key !== key) {
        const fresh = playlistRow(p);
        r?.el.replaceWith(fresh.el);
        r = fresh;
        rows.set(p.id, r);
      }
      const doing = nowOf(p, now);
      const going = doing?.doing === 'downloading' && doing.total > 0;
      r.el.classList.toggle('busy', !!doing && doing.doing !== 'waiting');
      r.sub.textContent = rowLine(p, doing);
      r.bar.hidden = !going;
      if (going) r.bar.firstChild.style.width = share(doing.done, doing.total);
      order.push(r.el);
    }
    for (const [id, r] of rows) {
      if (!playlists.some((p) => p.id === id)) {
        r.el.remove();
        rows.delete(id);
      }
    }
    // (In the app's order: as they were added.)
    order.forEach((r, i) => list.children[i] !== r && list.insertBefore(r, list.children[i] || null));
    none.hidden = playlists.length > 0;
    paintElsewhere();
  }
  paint();
  downloads.addEventListener('change', paint);
  onDispose(() => downloads.removeEventListener('change', paint));
}

// The phone's space: "10 GB of 128 GB available", what downloads use, and
// a bar of the two.
function paintSpace(box, st) {
  const { free = 0, total = 0, used = 0 } = st.storage || {};
  const share = (n) => `${Math.max(0, Math.min(100, (n / total) * 100)).toFixed(2)}%`;
  box.replaceChildren(
    total > 0 ? h('div.dl-free', null, `${bytesText(free)} of ${bytesText(total)} available`) : null,
    total > 0
      ? h(
          'div.dl-bar',
          { 'aria-hidden': 'true' },
          h('span.dl-bar-mine', { style: { width: share(used) } }),
          h('span.dl-bar-other', { style: { width: share(Math.max(0, total - free - used)) } }),
        )
      : null,
    h('div.dl-used', null, h('span.dl-key'), `Downloads use ${bytesText(used)}`),
  );
}

// What the downloads are doing now: the playlist it's checking or
// downloading, by name (each playlist's row says how far it's got). Up to
// date, or with the server out of reach, a tap checks for changes now
// (`onCheck`, where the app can).
function paintStatus(box, st, onCheck) {
  const s = st.status || {};
  const any = !!st.playlists?.length;
  box.hidden = !any;
  if (!any) return;
  let text;
  let mark = 'info';
  if (s.state === 'downloading') {
    const on = s.playlist ? st.playlists.find((p) => p.id === s.playlist) : null;
    text = !on ? 'Checking for changes…' : s.checking ? `Checking “${on.title}” for changes…` : `Downloading “${on.title}”…`;
    mark = on && !s.checking ? 'download' : 'refresh';
  } else if (s.state === 'idle') {
    text = st.syncedAt ? `Up to date, checked ${fmt.ago(st.syncedAt / 1000)}` : 'Up to date';
    mark = 'check';
  } else {
    text =
      {
        waiting: 'Starting soon',
        wifi: 'Waiting for Wi-Fi',
        offline: 'Waiting for a connection',
        signin: 'Your server didn’t accept the sign-in. Sign in again to keep these up to date.',
        unreachable: 'Couldn’t reach your server. Trying again soon.',
      }[s.state] || 'Waiting';
  }
  const checkable = !!onCheck && (s.state === 'idle' || s.state === 'unreachable');
  const content = [icon(mark, 20), h('div.dl-status-text', null, text)];
  box.classList.toggle('busy', s.state === 'downloading');
  box.classList.toggle('can-check', checkable);
  box.replaceChildren(
    ...(checkable ? [h('button.dl-check', { type: 'button', title: 'Check for changes now', onclick: onCheck }, ...content, icon('refresh', 20))] : content),
  );
}

// The playlists not downloaded yet (as Library › Playlists has them), to
// choose one.
async function addPlaylists() {
  let all;
  try {
    all = await app.server.playlists(playlistScope());
  } catch (err) {
    toast(err?.network ? 'Your server can’t be reached, so its playlists can’t be listed.' : 'Couldn’t list your playlists. Try again.');
    return;
  }
  const have = new Set((downloadState()?.playlists || []).map((p) => p.id));
  const left = all.filter((p) => (p.playlistType || 'audio') === 'audio' && (p.leafCount || 0) > 0 && !have.has(String(p.ratingKey)));
  if (!left.length) {
    toast(all.length ? 'All your playlists are downloaded.' : 'There are no playlists to download yet.');
    return;
  }
  sheet({
    title: 'Download a playlist',
    actions: left.map((p) => ({
      image: playlistArt(p),
      icon: 'list',
      label: p.title,
      description: fmt.count(p.leafCount, 'track', 'tracks'),
      onSelect: () => downloadPlaylist(p, { here: true }),
    })),
  });
}

// ---------- offline ----------

// A playlist on the phone, as the rest of the app has one (for playPlaylist,
// which plays it as it was downloaded while offline: see actions.js).
const asPlaylist = (p) => ({ ratingKey: p.id, title: p.title, leafCount: p.tracks, thumb: p.cover, playlistType: 'audio' });

// Back online, a page shown offline is the server's again: at once if it's
// on screen, or else the next time it's opened.
function againOnline(el, path, onDispose) {
  const again = () => (el.isConnected ? refresh() : dropCached((p) => p === path));
  connection.addEventListener('back', again);
  window.addEventListener('online', again);
  onDispose(() => {
    connection.removeEventListener('back', again);
    window.removeEventListener('online', again);
  });
}

// A playlist's cards: this server's (`server` null), or another's, which
// open and play as that server's, from the phone.
function playlistCards(playlists, server = null) {
  return grid(
    playlists.map((p) => {
      const c = card({
        href: server ? phonePlaylistPath(server, p.id) : `/playlist/${p.id}`,
        image: server ? phonePicture(p.cover, server) : p.cover,
        title: p.title,
        subtitle: fmt.count(p.saved, 'track', 'tracks'),
        fallback: 'list',
        onPlay: () => (server ? playFromPhone(server, p) : playPlaylist(asPlaylist(p))),
        onShuffle: () => (server ? playFromPhone(server, p, { shuffle: true }) : playPlaylist(asPlaylist(p), { shuffle: true })),
      });
      c.querySelector('.card-art')?.append(downloadedMark(p.id, server));
      return c;
    }),
    { centered: true, cls: 'grid-playlists' },
  );
}

// Another server's downloaded playlists, each server's under its name: for
// Library › Playlists, online or not. Kept as they change; nothing where
// there are none.
export function elsewhereSections(onDispose) {
  const box = h('div.dl-elsewhere-cards');
  let key = '';
  const paint = () => {
    const all = otherDownloads()
      .map((o) => ({ ...o, playlists: o.playlists.filter((p) => p.saved > 0) }))
      .filter((o) => o.playlists.length);
    const now = JSON.stringify(all.map((o) => [o.server, o.name, o.playlists.map((p) => [p.id, p.title, p.cover, p.saved])]));
    if (now === key) return;
    key = now;
    box.replaceChildren(...all.map((o) => h('section.block', null, sectionHeader(fromName(o)), playlistCards(o.playlists, o.server))));
  };
  paint();
  downloads.addEventListener('change', paint);
  onDispose(() => downloads.removeEventListener('change', paint));
  return box;
}

// Library › Playlists, offline: the playlists on the phone (the rest need
// the server), and another server's, apart.
export function offlinePlaylistsView({ el, onDispose }) {
  againOnline(el, '/playlists', onDispose);
  const list = (downloadState()?.playlists || []).filter((p) => p.saved > 0);
  el.append(pageHeader('Playlists', { subtitle: 'On this phone' }));
  if (list.length) el.append(playlistCards(list));
  el.append(elsewhereSections(onDispose));
}

// Where another server's downloaded playlist is shown.
export const phonePlaylistPath = (server, id) => `/downloads/${encodeURIComponent(server)}/${encodeURIComponent(id)}`;

// Another server's downloaded playlist, played: its tracks on the phone.
async function playFromPhone(server, p, { shuffle = false } = {}) {
  const kept = await downloadedPlaylist(p.id, server);
  const tracks = phoneTracks(kept, server).filter(playableHere);
  playList(tracks, 0, { title: kept?.playlist?.title || p.title, href: phonePlaylistPath(server, p.id) }, { shuffle });
}

// A playlist's page, offline: its tracks on the phone, as it was downloaded.
export async function offlinePlaylistView({ el, id, onDispose }) {
  againOnline(el, `/playlist/${id}`, onDispose);
  const p = playlistOf(id);
  const kept = p ? await downloadedPlaylist(id) : null;
  // (Not here after all: as any page that needs the server is offline.)
  if (!kept) throw Object.assign(new Error('Offline'), { network: true });
  const tracks = (kept.items || [])
    .filter((m) => m.type === 'track')
    .map(normTrack)
    .filter(playableHere);
  const pl = asPlaylist(p);
  keptPlaylistPage(el, onDispose, {
    title: kept.playlist?.title || p.title,
    href: `/playlist/${id}`,
    picture: p.cover,
    tracks,
    line: h('div.hero-meta.dl-line.on', null, icon('downloaded', 18), h('span', null, 'Downloaded')),
    shuffle: () => playPlaylist(pl, { shuffle: true }),
  });
}

// Another server's downloaded playlist (#/downloads/<server>/<id>): its
// tracks on the phone, played from there, wherever you are. A tap on where
// it's from offers to remove it.
export async function phonePlaylistView({ el, params, onDispose }) {
  const { server, id } = params;
  // (The player's on that server again: its own page.)
  if (server === app.source?.serverId) return navigate(`/playlist/${id}`, { replace: true });
  const o = otherServer(server);
  const p = o?.playlists.find((x) => x.id === String(id));
  const kept = p ? await downloadedPlaylist(id, server) : null;
  if (!kept) {
    el.append(backHeader('Playlist', { fallback: '/playlists' }), emptyState('That playlist isn’t on this phone any more.'));
    return;
  }
  const tracks = phoneTracks(kept, server).filter(playableHere);
  const title = kept.playlist?.title || p.title;
  const ask = () =>
    sheet({
      title,
      subtitle: playlistLine(p),
      actions: [
        {
          icon: 'trash',
          label: 'Remove download',
          description: 'From this phone, not your server',
          danger: true,
          onSelect: () => remove(p, server).then((gone) => gone && el.isConnected && navigate('/playlists', { replace: true })),
        },
      ],
    });
  keptPlaylistPage(el, onDispose, {
    title,
    href: phonePlaylistPath(server, id),
    picture: phonePicture(p.cover, server),
    tracks,
    line: h('button.hero-meta.dl-line.on.link-btn', { type: 'button', onclick: ask }, icon('downloaded', 18), h('span', null, fromName(o))),
    shuffle: () => playList(tracks, 0, { title, href: phonePlaylistPath(server, id) }, { shuffle: true }),
  });
}

// A downloaded playlist's page: its picture, title and length, a line of
// what it is (`line`), Play and Shuffle, and its tracks.
function keptPlaylistPage(el, onDispose, { title, href, picture, tracks, line, shuffle }) {
  const context = { title, href };
  const duration = tracks.reduce((n, t) => n + (t.duration || 0), 0);
  el.append(
    backHeader(title, { fallback: '/playlists' }),
    h(
      'section.hero.hero-album',
      null,
      h('div.hero-art-box', null, art(picture, { size: 480, cls: 'hero-art', fallback: 'list' })),
      h(
        'div.hero-info',
        null,
        h('h1.hero-title', null, title),
        h('div.hero-meta', null, fmt.count(tracks.length, 'track', 'tracks'), duration ? `, ${fmt.long(duration)}` : ''),
        line,
        h(
          'div.hero-actions',
          null,
          h('button.btn.btn-primary', { type: 'button', onclick: () => playList(tracks, 0, context) }, icon('play', 20), h('span', null, 'Play')),
          h('button.btn.btn-secondary', { type: 'button', onclick: shuffle }, icon('shuffle', 20), h('span', null, 'Shuffle')),
        ),
      ),
    ),
  );
  const list = numberedList({ total: tracks.length, album: true });
  el.append(list);
  if (!tracks.length) {
    el.append(emptyState('None of its tracks are on this phone yet.'));
    return;
  }
  pagedList(list, {
    fetchPage: async (start, size) => ({ items: tracks.slice(start, start + size), total: tracks.length }),
    render: (t, i) => trackRow(t, { position: true, album: true, subAlbum: true, onPlay: () => playList(tracks, i, context) }),
    onDispose,
  });
}
