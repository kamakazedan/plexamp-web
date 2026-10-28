// Play helpers ("play this album", "radio from this artist") and the
// long-press style menus for tracks, albums, artists, playlists and
// collections.
import { app } from './state.js';
import { player } from './player.js';
import { normTrack } from './plex.js';
import { navigate, describeError } from './router.js';
import { sheet, toast, shuffleArray, fmt } from './ui.js';
import { addToPlaylist, addToCollection, isAdminNow, tracksOf } from './editing.js';
import { exportPlaylistFile } from './views/playlistfiles.js';
import { lovedPlaylist, LOVED_TITLE } from './ratings.js';
import { pickable, withoutDisliked } from './picks.js';

const PLAYLIST_PLAY_LIMIT = 1000;
const REMOTE_LIMIT = 500; // tracks sent to a Play Together session at once (player.js)

export async function guard(fn) {
  try {
    return await fn();
  } catch (err) {
    console.error(err);
    toast(describeError(err));
    return undefined;
  }
}

const ctx = (title, href) => ({ title, href });

// How many tracks go into the queue at once: 1,000, or 500 to a Play
// Together session (as many as the player sends it).
export const queueLimit = () => (player.remote ? REMOTE_LIMIT : PLAYLIST_PLAY_LIMIT);

// A whole list into the queue: next, or at the end (at most queueLimit()
// tracks). `after`: more for the message, once it's done; `done(true)`:
// once they're in.
export const queueTracks = (load, where, { after, done } = {}) =>
  guard(async () => {
    const tracks = (await load()).slice(0, queueLimit());
    if (!tracks.length) return toast('There’s nothing to add.');
    const playing = !!player.current;
    if (where === 'next') player.playNext(tracks);
    else player.addToQueue(tracks);
    const n = fmt.count(tracks.length, 'track', 'tracks');
    toast(`${!playing ? 'Playing' : where === 'next' ? `${n} playing next` : `Added ${n} to the queue`}${after?.() || ''}`);
    done?.(true);
  });
const queueActions = (load) => [
  { icon: 'playNext', label: 'Play next', onSelect: () => queueTracks(load, 'next') },
  { icon: 'addQueue', label: 'Add to queue', onSelect: () => queueTracks(load, 'end') },
];

export function playList(tracks, start, context, opts = {}) {
  if (!tracks.length) return toast('There are no tracks to play.');
  player.playTracks(tracks, start, { context, ...opts });
}

export const playAlbum = (album, { shuffle = false, start = 0, tracks } = {}) =>
  guard(async () => {
    const list = tracks || (await app.server.children(album.ratingKey)).map(normTrack);
    playList(list, start, ctx(album.title, `/album/${album.ratingKey}`), { shuffle });
  });

// (Shuffled, it's picked for you: without tracks rated down, or live
// tracks and demos, where those are skipped: see picks.js.)
export const playArtist = (artist, { shuffle = false } = {}) =>
  guard(async () => {
    let list = (await app.server.allLeaves(artist.ratingKey)).map(normTrack);
    if (shuffle) list = await pickable(list);
    playList(list, 0, ctx(artist.title, `/artist/${artist.ratingKey}`), { shuffle });
  });

// A playlist's items: from `start`, at most `limit` of them, or (`sample`)
// that many from all over a bigger one.
async function playlistItems(pl, { start = 0, limit = PLAYLIST_PLAY_LIMIT, sample = false } = {}) {
  const s = app.server;
  const total = pl.leafCount || 0;
  if (sample && total > limit) {
    const pages = 5;
    const size = Math.ceil(limit / pages);
    const starts = Array.from({ length: pages }, () => Math.floor(Math.random() * Math.max(1, total - size)));
    const chunks = await Promise.all(starts.map((st) => s.playlistItems(pl.ratingKey, { start: st, size })));
    const seen = new Set();
    return chunks.flatMap((c) => c.items).filter((m) => !seen.has(m.ratingKey) && seen.add(m.ratingKey));
  }
  const items = [];
  for (let off = start; off < start + limit; off += 250) {
    const { items: page, total: t } = await s.playlistItems(pl.ratingKey, { start: off, size: Math.min(250, start + limit - off) });
    items.push(...page);
    if (!page.length || off + page.length >= (t || total)) break;
  }
  return items;
}

// Large playlists are sampled rather than loaded whole.
export const playPlaylist = (pl, { shuffle = false, start = 0 } = {}) =>
  guard(async () => {
    const items = await playlistItems(pl, { start: shuffle ? 0 : start, sample: shuffle });
    const tracks = items.filter((m) => m.type === 'track').map(normTrack);
    playList(tracks, 0, ctx(pl.title, `/playlist/${pl.ratingKey}`), { shuffle });
  });

// A collection's music: its own tracks, or the tracks of its albums or
// artists (artist collections play shuffled, so it isn't one artist at a time).
export const playCollection = (c, { shuffle = false } = {}) =>
  guard(async () => {
    const s = app.server;
    const { items } = await s.collection(c.ratingKey);
    const albums = items.filter((m) => m.type === 'album').slice(0, 40);
    const artists = items.filter((m) => m.type === 'artist').slice(0, 15);
    const [fromAlbums, fromArtists] = await Promise.all([
      Promise.all(albums.map((a) => s.children(a.ratingKey).catch(() => []))),
      Promise.all(artists.map((a) => s.allLeaves(a.ratingKey).catch(() => []))),
    ]);
    const list = [...items, ...fromAlbums.flat(), ...fromArtists.flat()].filter((m) => m.type === 'track').map(normTrack);
    playList(list, 0, ctx(c.title, `/collection/${c.ratingKey}`), { shuffle: shuffle || artists.length > 0 });
  });

// Artist radio: the artist's popular tracks mixed with popular tracks from
// sonically similar artists (falls back to the artist's own catalogue).
export const artistRadio = (artist) =>
  guard(async () => {
    const s = app.server;
    const section = app.source.sectionKey;
    const [own, similar] = await Promise.all([
      s.popularTracks(section, artist.ratingKey, 15).catch(() => []),
      s.nearest(artist.ratingKey, { limit: 8 }).catch(() => []),
    ]);
    const others = await Promise.all(
      similar.filter((a) => a.type === 'artist').slice(0, 8).map((a) => s.popularTracks(section, a.ratingKey, 6).catch(() => [])),
    );
    let tracks = [...own, ...others.flat()];
    if (tracks.length < 10) tracks = tracks.concat(await s.allLeaves(artist.ratingKey));
    const seen = new Set();
    const list = await pickable(shuffleArray(tracks.filter((m) => !seen.has(m.ratingKey) && seen.add(m.ratingKey))).map(normTrack), { keep: 10 });
    playList(list, 0, ctx(`${artist.title} radio`, `/artist/${artist.ratingKey}`));
  });

// Sonically similar tracks. If the track is already playing, the similar
// tracks replace what's up next; otherwise playback starts from it.
export const similarRadio = (track) =>
  guard(async () => {
    const similar = await pickable((await app.server.nearest(track.id, { limit: 60 })).filter((m) => m.type === 'track').map(normTrack));
    if (!similar.length) {
      toast('No similar tracks found. Sonic analysis needs to be turned on for this library in Plex.');
      return;
    }
    const context = ctx(`Similar to ${track.title}`, track.albumId ? `/album/${track.albumId}` : null);
    if (player.current?.id === track.id) {
      player.replaceUpcoming(similar, context);
      toast(`Up next: ${fmt.count(similar.length, 'similar track', 'similar tracks')}`);
    } else {
      playList([track, ...similar], 0, context);
    }
  });

// ---------- radio from your music ----------

const pick = (list, n) => shuffleArray(list.slice()).slice(0, n);
const once = (list) => {
  const seen = new Set();
  return list.filter((m) => m?.type === 'track' && !seen.has(String(m.ratingKey)) && seen.add(String(m.ratingKey)));
};

// The artists of these tracks, the most frequent first.
function artistsOf(tracks, n) {
  const count = new Map();
  for (const m of tracks) {
    const id = m.grandparentRatingKey && String(m.grandparentRatingKey);
    if (id) count.set(id, (count.get(id) || 0) + 1);
  }
  return [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([id]) => id);
}

// Tracks from these artists: their best-known (or, where Plex doesn't know
// which those are, any of theirs).
async function tracksFrom(artists, each) {
  const s = app.server;
  const section = app.source.sectionKey;
  return (
    await Promise.all(
      artists.map(async (a) => {
        const popular = await s.popularTracks(section, a, each).catch(() => []);
        return popular.length >= Math.min(3, each) ? popular : pick(await s.allLeaves(a).catch(() => []), each);
      }),
    )
  ).flat();
}

// Playlist radio: some of the playlist, mixed with tracks that sound like
// it (with sonic analysis), or else with more from its artists.
export const playlistRadio = (pl) =>
  guard(async () => {
    const s = app.server;
    const own = (await playlistItems(pl, { limit: 400, sample: true })).filter((m) => m.type === 'track');
    if (!own.length) return toast('That playlist has no tracks to start a radio from.');
    let more = (await Promise.all(pick(own, 8).map((t) => s.nearest(t.ratingKey, { limit: 12 }).catch(() => [])))).flat();
    if (once(more).length < 20) more = more.concat(await tracksFrom(artistsOf(own, 8), 6));
    // (The playlist's own, as they are, but those rated down; what's
    // added, picked for you.)
    more = await pickable(once(more));
    const list = shuffleArray(once([...pick(withoutDisliked(own), 40), ...more])).slice(0, 100).map(normTrack);
    playList(list, 0, ctx(`${pl.title} radio`, `/playlist/${pl.ratingKey}`));
  });

// Favourites radio: the artists in ❤️ Tracks (those loved most, first),
// some of their best-known tracks, and artists like them.
export const favouritesRadio = () =>
  guard(async () => {
    const s = app.server;
    const pl = await lovedPlaylist();
    const loved = pl ? (await playlistItems(pl, { limit: 500, sample: true })).filter((m) => m.type === 'track') : [];
    if (!loved.length) return toast(`Favourite a few tracks first: this radio plays their artists, from ${LOVED_TITLE}.`);
    const artists = artistsOf(loved, 12);
    const near = (await Promise.all(artists.slice(0, 4).map((a) => s.nearest(a, { limit: 4 }).catch(() => [])))).flat();
    const alike = [...new Set(near.filter((m) => m.type === 'artist').map((m) => String(m.ratingKey)))].filter((id) => !artists.includes(id)).slice(0, 8);
    const [theirs, others] = await Promise.all([tracksFrom(artists, 6), tracksFrom(alike, 4)]);
    // (Your favourites, as they are; the rest, picked for you.)
    const picked = await pickable(once([...theirs, ...others]));
    const list = shuffleArray(once([...pick(loved, 20), ...picked])).slice(0, 100).map(normTrack);
    playList(list, 0, ctx('Favourites radio', `/playlist/${pl.ratingKey}`));
  });

export const shuffleLibrary = () =>
  guard(async () => {
    const list = await pickable((await app.server.randomTracks(app.source.sectionKey, 150)).map(normTrack), { keep: 20 });
    playList(list, 0, ctx(app.source.sectionTitle, '/search'));
  });

// ---------- stations (Home › Stations) ----------

// Tracks you've played least: what you haven't heard yet comes first.
export const deepCutsRadio = () =>
  guard(async () => {
    const { items } = await app.server.list(app.source.sectionKey, 10, { sort: 'viewCount:asc', size: 400 });
    const unplayed = items.filter((m) => !m.viewCount);
    const pool = await pickable(shuffleArray(unplayed.length >= 20 ? unplayed : items).slice(0, 150).map(normTrack), { keep: 20 });
    playList(pool.slice(0, 100), 0, ctx('Deep cuts radio', null));
  });

// A random decade from this library, and tracks from its albums.
export const timeTravelRadio = () =>
  guard(async () => {
    const s = app.server;
    const sec = app.source.sectionKey;
    const decades = (await s.tags(sec, 'decade', 9).catch(() => [])).filter((d) => /^\d{4}$/.test(String(d.key)));
    if (!decades.length) return shuffleLibrary();
    const d = decades[Math.floor(Math.random() * decades.length)];
    const { items } = await s.list(sec, 10, { sort: 'random', size: 100, filters: { 'album.decade': d.key } });
    playList(await pickable(items.map(normTrack), { keep: 10 }), 0, ctx(`Time travel: the ${String(d.key).slice(2)}s`, `/browse/albums?${new URLSearchParams({ decade: d.key, title: `The ${d.title || `${d.key}s`}` })}`));
  });

// (A station: without the album's tracks you've rated down, and another
// album where those are all of them.)
export const randomAlbum = () =>
  guard(async () => {
    const { items } = await app.server.list(app.source.sectionKey, 9, { sort: 'random', size: 5 });
    if (!items.length) return toast('This library has no albums.');
    for (const album of items) {
      const tracks = withoutDisliked((await app.server.children(album.ratingKey)).filter((m) => m.type === 'track').map(normTrack));
      if (tracks.length) return playAlbum(album, { tracks });
    }
    toast('Every track on the albums picked is one you’ve rated down. Try again for others.');
  });

export const sonicPath = (from, to) =>
  guard(async () => {
    let list = (await app.server.computePath(app.source.sectionKey, from.id, to.id)).filter((m) => m.type === 'track').map(normTrack);
    if (list.length < 2) {
      toast('Plex could not build a path between those tracks. Sonic analysis needs to be turned on for this library.');
      return;
    }
    // (The two you chose, as they are; the way between, picked for you.)
    if (list.length > 2) list = [list[0], ...(await pickable(list.slice(1, -1))), list[list.length - 1]];
    playList(list, 0, ctx(`${from.title} to ${to.title}`, null));
  });

// ---------- menus ----------

// `extra`: actions for where the menu was opened (an unlocked playlist's
// "Remove from playlist", say), shown first. `select`: to start choosing
// more with it (selection.js), where it can be.
const selectAction = (select, what) => select && { icon: 'select', label: 'Select', description: `Choose more ${what} to go with it`, onSelect: select };

export function trackMenu(track, { queueIndex, extra = [], select = null } = {}) {
  const inQueue = queueIndex !== undefined;
  sheet({
    title: track.title,
    subtitle: [track.artist, track.album].filter(Boolean).join(' — '),
    image: track.thumb,
    actions: [
      ...extra,
      !inQueue && { icon: 'playNext', label: 'Play next', onSelect: () => { player.playNext([track]); toast('Playing next'); } },
      !inQueue && { icon: 'addQueue', label: 'Add to queue', onSelect: () => { player.addToQueue([track]); toast('Added to queue'); } },
      inQueue && queueIndex > player.index + 1 && {
        icon: 'moveTop',
        label: 'Move to top',
        onSelect: () => {
          player.moveToTop(queueIndex);
          toast('Playing next');
        },
      },
      { icon: 'radio', label: 'Play similar tracks', onSelect: () => similarRadio(track) },
      inQueue && queueIndex !== player.index && { icon: 'close', label: 'Remove from queue', onSelect: () => player.remove(queueIndex) },
      { icon: 'playlistAdd', label: 'Add to playlist…', onSelect: () => addToPlaylist({ what: track.title, load: async () => [track] }) },
      isAdminNow() && {
        icon: 'collection',
        label: 'Add to collection…',
        onSelect: () => addToCollection({ kind: 'track', what: track.title, load: async () => [track] }),
      },
      selectAction(select, 'tracks'),
      /^\d+$/.test(String(track.id)) && { icon: 'appears', label: 'Appears in…', onSelect: () => navigate(`/appears/${track.id}`) },
      track.albumId && { icon: 'disc', label: 'Go to album', onSelect: () => navigate(`/album/${track.albumId}`) },
      track.artistId && { icon: 'mic', label: 'Go to artist', onSelect: () => navigate(`/artist/${track.artistId}`) },
    ],
  });
}

// From its page, or its cover anywhere (`select`, as for trackMenu; there
// "Go to album" too).
export function albumMenu(album, { select = null, open = false } = {}) {
  sheet({
    title: album.title,
    subtitle: album.parentTitle,
    image: album.thumb,
    actions: [
      { icon: 'play', label: 'Play', onSelect: () => playAlbum(album) },
      { icon: 'shuffle', label: 'Shuffle', onSelect: () => playAlbum(album, { shuffle: true }) },
      ...queueActions(() => tracksOf([album])),
      { icon: 'playlistAdd', label: 'Add to playlist…', onSelect: () => addToPlaylist({ what: album.title, load: () => tracksOf([album]), suggest: album.title }) },
      isAdminNow() && {
        icon: 'collection',
        label: 'Add to collection…',
        onSelect: () => addToCollection({ kind: 'album', what: album.title, load: async () => [album] }),
      },
      selectAction(select, 'albums'),
      open && { icon: 'disc', label: 'Go to album', onSelect: () => navigate(`/album/${album.ratingKey}`) },
      album.parentRatingKey && { icon: 'mic', label: 'Go to artist', onSelect: () => navigate(`/artist/${album.parentRatingKey}`) },
    ],
  });
}

export function artistMenu(artist) {
  sheet({
    title: artist.title,
    image: artist.thumb,
    round: true,
    actions: [
      { icon: 'play', label: 'Play', onSelect: () => playArtist(artist) },
      { icon: 'shuffle', label: 'Shuffle', onSelect: () => playArtist(artist, { shuffle: true }) },
      { icon: 'radio', label: 'Artist radio', onSelect: () => artistRadio(artist) },
      ...queueActions(() => tracksOf([artist], { limit: PLAYLIST_PLAY_LIMIT })),
      { icon: 'playlistAdd', label: 'Add to playlist…', onSelect: () => addToPlaylist({ what: artist.title, load: () => tracksOf([artist]), suggest: artist.title }) },
      isAdminNow() && {
        icon: 'collection',
        label: 'Add to collection…',
        onSelect: () => addToCollection({ kind: 'artist', what: artist.title, load: async () => [artist] }),
      },
    ],
  });
}

// `edit`: { onRename, onDelete } when the playlist is unlocked for editing.
// `edit`: rename and delete, while it's unlocked; `picture`: change its
// picture (then too, or any time for a smart playlist).
// `extra`: more actions, after the rest (sharing it, from its page).
export function playlistMenu(pl, { edit = null, picture = null, extra = [] } = {}) {
  const tracks = () => tracksOf([pl]);
  sheet({
    title: pl.title,
    subtitle: fmt.count(pl.leafCount || 0, 'track', 'tracks'),
    image: pl.thumb || pl.composite,
    actions: [
      { icon: 'play', label: 'Play', onSelect: () => playPlaylist(pl) },
      { icon: 'shuffle', label: 'Shuffle', onSelect: () => playPlaylist(pl, { shuffle: true }) },
      { icon: 'radio', label: 'Playlist radio', onSelect: () => playlistRadio(pl) },
      ...queueActions(() => tracksOf([pl], { limit: PLAYLIST_PLAY_LIMIT })),
      { icon: 'playlistAdd', label: 'Add to playlist…', onSelect: () => addToPlaylist({ what: pl.title, load: tracks }) },
      isAdminNow() && {
        icon: 'collection',
        label: 'Add to collection…',
        onSelect: () => addToCollection({ kind: 'track', what: pl.title, load: tracks, suggest: pl.title }),
      },
      ...extra,
      {
        icon: 'arrowDown',
        label: 'Export to a file',
        description: 'To import again later, or for someone else to import',
        onSelect: () => exportPlaylistFile(pl),
      },
      edit && { icon: 'edit', label: 'Rename…', onSelect: edit.onRename },
      picture && { icon: 'image', label: 'Change picture…', onSelect: picture },
      edit && { icon: 'trash', label: 'Delete playlist…', danger: true, onSelect: edit.onDelete },
    ],
  });
}

// `edit`: as for playlists, for the server's admin.
export function collectionMenu(c, { edit = null, picture = null } = {}) {
  sheet({
    title: c.title,
    subtitle: c.childCount ? fmt.count(c.childCount, 'item', 'items') : null,
    image: c.thumb || c.composite,
    actions: [
      { icon: 'play', label: 'Play', onSelect: () => playCollection(c) },
      { icon: 'shuffle', label: 'Shuffle', onSelect: () => playCollection(c, { shuffle: true }) },
      ...queueActions(() => tracksOf([c], { limit: PLAYLIST_PLAY_LIMIT })),
      { icon: 'playlistAdd', label: 'Add to playlist…', onSelect: () => addToPlaylist({ what: c.title, load: () => tracksOf([c]), suggest: c.title }) },
      edit && { icon: 'edit', label: 'Rename…', onSelect: edit.onRename },
      picture && { icon: 'image', label: 'Change picture…', onSelect: picture },
      edit && { icon: 'trash', label: 'Delete collection…', danger: true, onSelect: edit.onDelete },
    ],
  });
}

// Up next: the queue (from the current track on) to a playlist or a
// collection.
export function queueMenu() {
  const upcoming = () => Promise.resolve(player.queue.slice(Math.max(0, player.index)));
  const n = Math.max(0, player.queue.length - Math.max(0, player.index));
  sheet({
    title: 'Up next',
    subtitle: fmt.count(n, 'track', 'tracks'),
    actions: [
      { icon: 'playlistAdd', label: 'Save as a playlist…', onSelect: () => addToPlaylist({ what: fmt.count(n, 'track', 'tracks'), load: upcoming }) },
      isAdminNow() && {
        icon: 'collection',
        label: 'Add to a collection…',
        onSelect: () => addToCollection({ kind: 'track', what: fmt.count(n, 'track', 'tracks'), load: upcoming }),
      },
      player.upcoming.length > 0 && { icon: 'close', label: 'Clear Up next', onSelect: () => player.clearUpcoming() },
    ],
  });
}
