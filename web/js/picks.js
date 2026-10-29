// What the app picks for you: radio and stations (Home's too, a random
// album among them), mixes, shuffling an artist or the library, Guest DJs,
// AI playlists, the way along a sonic path. Never a track you've rated
// down (a thumbs down, or one star or less: ratings.js isDisliked), with
// Skip tracks rated down on (Settings › Playback, on to begin with), and,
// with Skip live tracks and demos, no live tracks or demos (mb.js). What
// you play yourself (an album, a playlist, an artist, a track you chose)
// plays as it is.
import { app } from './state.js';
import { isDisliked } from './ratings.js';
import { withoutLiveOrDemos } from './mb.js';

export const skipDislikedOn = () => app.settings.skipDisliked !== false;

// Tracks (as the app has them, or as Plex lists them) without those rated
// down, with that on.
export const withoutDisliked = (tracks) => (skipDislikedOn() ? tracks.filter((t) => !isDisliked(t)) : tracks);

// ...and without live tracks and demos, with that on (`keep`: see
// withoutLiveOrDemos; those rated down are never kept for it).
export const pickable = (tracks, opts) => withoutLiveOrDemos(withoutDisliked(tracks), opts);
