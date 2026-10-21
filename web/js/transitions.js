// What the player needs to move from one track to the next the way Plexamp
// does: where the music in a track really starts and ends (from the
// server's loudness analysis, so silence before and after can be skipped),
// whether two tracks follow each other on an album (those play gaplessly,
// without a fade), and whether this browser lets a page fade audio at all.
import { app } from './state.js';

// About two loudness samples a second, at least 160 (the waveform needs
// that many) and at most 1,000 (an hour-long mix). The waveform asks for the
// same number, so both share one request.
export function levelSamples(durationMs) {
  return Math.max(160, Math.min(1000, Math.round((durationMs || 0) / 500)));
}

// Loudness samples (dB) for a track, or null when the server hasn't
// analysed it.
export async function loudnessOf(track) {
  const s = app.server;
  if (!s || !track?.id) return null;
  const d = await s.trackDetail(track.id);
  const stream = (d?.Media?.[0]?.Part?.[0]?.Stream || []).find((x) => x.streamType === 2);
  if (!stream?.id) return null;
  const values = await s.levels(stream.id, levelSamples(track.duration));
  return values.length >= 8 ? values : null;
}

// Quiet endings: the last stretch of a track's music, at least
// QUIET_ENDING_MIN seconds of it, all well under the track's loud part (a
// beat ticking on under the fade, a hushed outro). "Smart" fades can start
// there rather than at the very end (see player.js); the "Quiet endings"
// setting picks how far under, in dB.
export const QUIET_ENDINGS = { soft: 15, quiet: 20, hushed: 25 };
const QUIET_ENDING_MIN = 2;

// The middle one of a sample and its neighbours: a lone louder sample (a
// drum hit) doesn't break up a quiet stretch.
function middleOf(v, i) {
  const a = v[Math.max(0, i - 1)];
  const b = v[i];
  const c = v[Math.min(v.length - 1, i + 1)];
  return Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));
}

// Where the music starts and ends, in seconds: { start, end, quietFrom }.
// Silence is anything well below the loud part of the track (35 dB under
// it, and never louder than -65 dB), so a quiet piece's quiet passages still
// count as music. Gaps under a second aren't worth skipping and are kept.
// quietFrom: where each kind of quiet ending (QUIET_ENDINGS) starts, null
// for the ones this track doesn't have.
export function audibleSpan(values, durationSec) {
  if (!Array.isArray(values) || values.length < 8 || !(durationSec > 0)) return null;
  const v = values.map((x) => (Number.isFinite(x) ? x : -200));
  const sorted = [...v].sort((a, b) => a - b);
  const loud = sorted[Math.floor(sorted.length * 0.75)];
  if (loud < -90) return null; // nothing but silence: leave it alone
  const quiet = Math.max(loud - 35, -65);
  const step = durationSec / v.length;
  const first = v.findIndex((x) => x > quiet);
  let last = v.length - 1;
  while (last > 0 && v[last] <= quiet) last -= 1;
  if (first < 0) return null;
  // One sample of margin either side: a sample covers `step` seconds.
  let start = Math.max(0, (first - 1) * step);
  let end = Math.min(durationSec, (last + 2) * step);
  if (start < 1) start = 0;
  if (durationSec - end < 1) end = durationSec;
  if (end - start < Math.min(10, durationSec / 2)) return null; // doesn't look like music: don't trust it
  // Each kind of quiet ending: back from the music's last sample while it
  // stays that far under the loud part.
  const quietFrom = {};
  for (const [kind, drop] of Object.entries(QUIET_ENDINGS)) {
    const under = loud - drop;
    let q = last;
    while (q > first && middleOf(v, q) <= under) q -= 1;
    quietFrom[kind] = q > first && (last - q) * step >= QUIET_ENDING_MIN ? Math.min(end, (q + 1) * step) : null;
  }
  return { start, end, quietFrom };
}

// The next track on the same album, in order (the first track of the next
// disc counts too): albums are played as they were made, without a fade.
export function followsOnAlbum(a, b) {
  if (!a?.albumId || a.albumId !== b?.albumId) return false;
  const da = a.disc ?? 1;
  const db = b.disc ?? 1;
  if (a.index == null || b.index == null) return false;
  return (db === da && b.index === a.index + 1) || (db === da + 1 && b.index === 1);
}

// Some browsers (Safari on iPhone and iPad) don't let a page change an audio
// element's volume, so there's no fading there.
export const canFade = (() => {
  try {
    const a = new Audio();
    a.volume = 0.5;
    return Math.abs(a.volume - 0.5) < 0.01;
  } catch {
    return false;
  }
})();
