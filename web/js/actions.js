// Play helpers ("play this album", "radio from this artist") and the
// long-press style menus for tracks, albums and playlists.
import { app } from './state.js';
import { player } from './player.js';
import { normTrack } from './plex.js';
import { navigate, describeError } from './router.js';
import { sheet, toast, shuffleArray, fmt } from './ui.js';

const PLAYLIST_PLAY_LIMIT = 1000;

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

export function playList(tracks, start, context, opts = {}) {
  if (!tracks.length) return toast('There are no tracks to play.');
  player.playTracks(tracks, start, { context, ...opts });
}

export const playAlbum = (album, { shuffle = false, start = 0, tracks } = {}) =>
  guard(async () => {
    const list = tracks || (await app.server.children(album.ratingKey)).map(normTrack);
    playList(list, start, ctx(album.title, `/album/${album.ratingKey}`), { shuffle });
  });

export const playArtist = (artist, { shuffle = false } = {}) =>
  guard(async () => {
    const list = (await app.server.allLeaves(artist.ratingKey)).map(normTrack);
    playList(list, 0, ctx(artist.title, `/artist/${artist.ratingKey}`), { shuffle });
  });

// Large playlists are sampled rather than loaded whole.
export const playPlaylist = (pl, { shuffle = false, start = 0 } = {}) =>
  guard(async () => {
    const s = app.server;
    const total = pl.leafCount || 0;
    let items = [];
    if (shuffle && total > PLAYLIST_PLAY_LIMIT) {
      const pages = 5;
      const size = Math.ceil(PLAYLIST_PLAY_LIMIT / pages);
      const starts = Array.from({ length: pages }, () => Math.floor(Math.random() * Math.max(1, total - size)));
      const chunks = await Promise.all(starts.map((st) => s.playlistItems(pl.ratingKey, { start: st, size })));
      const seen = new Set();
      items = chunks.flatMap((c) => c.items).filter((m) => !seen.has(m.ratingKey) && seen.add(m.ratingKey));
    } else {
      const from = shuffle ? 0 : start;
      for (let off = from; off < from + PLAYLIST_PLAY_LIMIT; off += 250) {
        const { items: page, total: t } = await s.playlistItems(pl.ratingKey, { start: off, size: 250 });
        items.push(...page);
        if (!page.length || off + page.length >= (t || total)) break;
      }
    }
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
    const list = shuffleArray(tracks.filter((m) => !seen.has(m.ratingKey) && seen.add(m.ratingKey))).map(normTrack);
    playList(list, 0, ctx(`${artist.title} radio`, `/artist/${artist.ratingKey}`));
  });

// Sonically similar tracks. If the track is already playing, the similar
// tracks replace what's up next; otherwise playback starts from it.
export const similarRadio = (track) =>
  guard(async () => {
    const similar = (await app.server.nearest(track.id, { limit: 60 })).filter((m) => m.type === 'track').map(normTrack);
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

export const shuffleLibrary = () =>
  guard(async () => {
    const list = (await app.server.randomTracks(app.source.sectionKey, 150)).map(normTrack);
    playList(list, 0, ctx(app.source.sectionTitle, '/library'));
  });

// ---------- stations (Home › Stations) ----------

// Tracks you've played least: what you haven't heard yet comes first.
export const deepCutsRadio = () =>
  guard(async () => {
    const { items } = await app.server.list(app.source.sectionKey, 10, { sort: 'viewCount:asc', size: 400 });
    const unplayed = items.filter((m) => !m.viewCount);
    const pool = unplayed.length >= 20 ? unplayed : items;
    playList(shuffleArray(pool).slice(0, 100).map(normTrack), 0, ctx('Deep cuts radio', null));
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
    playList(items.map(normTrack), 0, ctx(`Time travel: the ${String(d.key).slice(2)}s`, `/browse/albums?${new URLSearchParams({ decade: d.key, title: `The ${d.title || `${d.key}s`}` })}`));
  });

export const randomAlbum = () =>
  guard(async () => {
    const { items } = await app.server.list(app.source.sectionKey, 9, { sort: 'random', size: 1 });
    if (!items.length) return toast('This library has no albums.');
    await playAlbum(items[0]);
  });

export const sonicPath = (from, to) =>
  guard(async () => {
    const list = (await app.server.computePath(app.source.sectionKey, from.id, to.id)).filter((m) => m.type === 'track').map(normTrack);
    if (list.length < 2) {
      toast('Plex could not build a path between those tracks. Sonic analysis needs to be turned on for this library.');
      return;
    }
    playList(list, 0, ctx(`${from.title} to ${to.title}`, null));
  });

// ---------- menus ----------

export function trackMenu(track, { queueIndex } = {}) {
  const inQueue = queueIndex !== undefined;
  sheet({
    title: track.title,
    subtitle: [track.artist, track.album].filter(Boolean).join(' — '),
    image: track.thumb,
    actions: [
      !inQueue && { icon: 'playNext', label: 'Play next', onSelect: () => { player.playNext([track]); toast('Playing next'); } },
      !inQueue && { icon: 'addQueue', label: 'Add to queue', onSelect: () => { player.addToQueue([track]); toast('Added to queue'); } },
      { icon: 'radio', label: 'Play similar tracks', onSelect: () => similarRadio(track) },
      inQueue && queueIndex !== player.index && { icon: 'close', label: 'Remove from queue', onSelect: () => player.remove(queueIndex) },
      track.albumId && { icon: 'disc', label: 'Go to album', onSelect: () => navigate(`/album/${track.albumId}`) },
      track.artistId && { icon: 'mic', label: 'Go to artist', onSelect: () => navigate(`/artist/${track.artistId}`) },
    ],
  });
}

export function albumMenu(album) {
  sheet({
    title: album.title,
    subtitle: album.parentTitle,
    image: album.thumb,
    actions: [
      { icon: 'play', label: 'Play', onSelect: () => playAlbum(album) },
      { icon: 'shuffle', label: 'Shuffle', onSelect: () => playAlbum(album, { shuffle: true }) },
      { icon: 'playNext', label: 'Play next', onSelect: () => queueAlbum(album, 'next') },
      { icon: 'addQueue', label: 'Add to queue', onSelect: () => queueAlbum(album, 'end') },
      album.parentRatingKey && { icon: 'mic', label: 'Go to artist', onSelect: () => navigate(`/artist/${album.parentRatingKey}`) },
    ],
  });
}

export function playlistMenu(pl) {
  sheet({
    title: pl.title,
    subtitle: fmt.count(pl.leafCount || 0, 'track', 'tracks'),
    image: pl.composite || pl.thumb,
    actions: [
      { icon: 'play', label: 'Play', onSelect: () => playPlaylist(pl) },
      { icon: 'shuffle', label: 'Shuffle', onSelect: () => playPlaylist(pl, { shuffle: true }) },
    ],
  });
}

const queueAlbum = (album, where) =>
  guard(async () => {
    const tracks = (await app.server.children(album.ratingKey)).map(normTrack);
    if (where === 'next') player.playNext(tracks);
    else player.addToQueue(tracks);
    toast(where === 'next' ? 'Playing next' : 'Added to queue');
  });
