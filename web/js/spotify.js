// Search › From Spotify (SPOTIFY_IMPORT on the container): a Spotify
// playlist's link goes to this player's service, which reads the playlist
// from the page Spotify shows anyone for it (server/spotify.js), at most its
// first 100 tracks. Its tracks are then looked for in the library like a
// playlist file's (playlistio.js matchEntries), and what isn't found goes on
// Missing tracks. Nothing goes from the browser to Spotify.
import { app } from './state.js';

export const spotifyOffered = () => !!app.config?.spotify;

// What a pasted link is, before it's sent: 'playlist' (its link or URI),
// 'short' (a spotify.link short link, which the service follows), 'other'
// (an album, song, artist or podcast on Spotify), or null. The service
// checks it properly.
export function spotifyLinkKind(text) {
  const s = String(text || '').trim();
  if (/^spotify:(?:user:[^:\s]+:)?playlist:[A-Za-z0-9]{22}$/.test(s) || /^[A-Za-z0-9]{22}$/.test(s)) return 'playlist';
  if (/^spotify:(album|track|artist|show|episode):/.test(s)) return 'other';
  let url;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (host === 'spotify.link') return 'short';
  if (host !== 'open.spotify.com' && host !== 'play.spotify.com') return null;
  if (/\/playlist\/[A-Za-z0-9]{22}\/?$/.test(url.pathname)) return 'playlist';
  if (/\/(album|track|artist|show|episode)\//.test(url.pathname)) return 'other';
  return null;
}

// The playlist, as the service read it: { id, name, owner, tracks: [{
// title, artist, artists?, album?, duration? }], capped }. Throws with the
// service's own words for what went wrong.
export async function readSpotifyPlaylist(link, { signal } = {}) {
  // Who's asking, checked by the player as for its shared AI model.
  const headers = { 'Content-Type': 'application/json', 'X-Plex-Token': app.auth?.token || '' };
  if (app.source?.token && app.source.token !== app.auth?.token) headers['X-Plex-Server-Token'] = app.source.token;
  let res;
  try {
    res = await fetch('api/spotify/playlist', { method: 'POST', headers, body: JSON.stringify({ link: String(link).trim() }), credentials: 'omit', signal });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new Error('This player didn’t answer. Check it’s still running, and try again.');
  }
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* no explanation */
  }
  if (!res.ok) throw Object.assign(new Error(data.error || `The player couldn’t read it (HTTP ${res.status}).`), { status: res.status });
  const pl = data.playlist;
  if (!pl || !Array.isArray(pl.tracks)) throw new Error('The player’s answer wasn’t a playlist.');
  return pl;
}

// Versions Spotify adds to a title after " - " that the library's copy
// doesn't say ("Song - Remastered 2011", "Song - 2011 Remaster", "Song -
// Radio Edit", "Song - Mono"). Mixes and live versions stay: they're other
// recordings.
const VERSION = /\s+-\s+(?:(?:\d{4}\s+)?(?:digital(?:ly)?\s+)?remaster(?:ed)?(?:\s+\d{4})?(?:\s+version)?|\d{4}\s+version|(?:single|album|original|stereo|mono)\s+(?:version|mix|edit)|radio\s+edit|mono|stereo|bonus\s+track|explicit|clean)\s*$/i;
export const plainTitle = (title) => String(title || '').replace(VERSION, '').trim() || String(title || '');

// A playlist from Spotify as playlistio.js imports one: each track's title
// (without the version Spotify adds), its first artist (others in
// albumArtist, so either can match), its album when the page says, and its
// length.
export function spotifyEntries(pl) {
  return pl.tracks.map((t) => {
    const first = t.artists?.[0] || String(t.artist || '').split(', ')[0];
    const e = { title: plainTitle(t.title), artist: first || '', albumArtist: t.artist && t.artist !== first ? t.artist : '', album: t.album || '' };
    if (Number.isFinite(t.duration)) e.duration = t.duration;
    return e;
  });
}
