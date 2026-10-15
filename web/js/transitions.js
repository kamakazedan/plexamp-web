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

// Where the music starts and ends, in seconds: { start, end }. Silence is
// anything well below the loud part of the track (35 dB under it, and never
// louder than -65 dB), so a quiet piece's quiet passages still count as
// music. Gaps under a second aren't worth skipping and are kept.
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
  return { start, end };
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
