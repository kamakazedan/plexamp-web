// Formats as the badges show them: "FLAC 24/96" (gold for high resolution),
// "MP3 320", "Mixed formats". An album's comes from its tracks: their
// formats, and the first track's bit depth and sample rate (from its full
// details, which a listing of the album's tracks doesn't have).
//
// Album covers (cards) and album rows get theirs as they come into view: a
// few albums at a time, the first tracks' details asked for together, and
// kept while the app's open (see watchFormat).
import { app } from './state.js';
import { isLossless, normTrack } from './plex.js';
import { fmt } from './ui.js';

export const kHz = (hz) => (hz / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 });

// The audio stream in a track's full details (bit depth, sample rate).
export const audioStream = (d) => (d?.Media?.[0]?.Part?.[0]?.Stream || []).find((x) => x.streamType === 2) || null;

// DSD, however it's named ("dsd", "dsf", or as ffmpeg has it,
// "dsd_lsbf_planar").
const DSD = /^(dsd|dsf|dff)/;

// What a badge says for one format: { text, hires }, or null with none.
// `a`: the audio stream, if known; `kbps`: a lossy file's bitrate (shown
// when given).
export function formatOf(codec, a = null, kbps = null) {
  const c = String(codec || '').toLowerCase();
  // (DSD64 is 2.8224 MHz; a rate given as PCM's, 352.8 kHz say, isn't one.)
  if (DSD.test(c)) return a?.samplingRate >= 2822400 ? { text: `DSD${Math.round(a.samplingRate / 44100)}`, hires: true } : { text: 'DSD', hires: true };
  const name = fmt.codec(c);
  if (!name) return null;
  if (isLossless(c)) {
    const hires = !!a && (a.bitDepth > 16 || a.samplingRate > 48000);
    if (a?.bitDepth && a.samplingRate) return { text: `${name} ${a.bitDepth}/${kHz(a.samplingRate)}`, hires };
    if (a?.samplingRate) return { text: `${name} ${kHz(a.samplingRate)} kHz`, hires };
    return { text: name, hires: false };
  }
  return { text: kbps ? `${name} ${Math.round(kbps)}` : name, hires: false };
}

// The formats of an album's tracks (as normTrack makes them): one, several
// ("Mixed formats", short: "Mixed"), or none known.
export const codecsOf = (tracks) => [...new Set(tracks.map((t) => t.codec).filter(Boolean))];

export function albumFormatOf(codecs, a = null) {
  if (!codecs.length) return null;
  if (codecs.length > 1) return { text: 'Mixed formats', short: 'Mixed', hires: false, mixed: true };
  return formatOf(codecs[0], a);
}

// Whether the first track's details are needed to say more than the format
// (bit depth and sample rate are only worth showing for lossless files).
export const wantsDetail = (codecs) => codecs.length === 1 && (isLossless(codecs[0]) || DSD.test(codecs[0]));

// ---------- albums as they come into view ----------

// A few at a time, after a moment in view (what's scrolled past isn't
// asked about, and the covers themselves, from the server too, get a head
// start).
const RUNNING = 3; // albums looked up at once
const SETTLE = 250; // ms in view before an album's looked up
const KEEP = 5000; // albums' formats kept (each is a few words)
const FRESH = 60 * 60000; // ...for an hour (or until a scan of the library ends)
const BATCH_WAIT = 40; // ms to gather first tracks before asking for their details
const known = new WeakMap(); // server → Map(album id → { f: format, or null for none, at })
const asked = new WeakMap(); // server → Map(album id → promise of it)
const watched = new WeakMap(); // element → { id, put }
const wanted = new Set(); // watched elements in view, waiting their turn
let running = 0;
let observer = null;

const mapFor = (store, s) => {
  let m = store.get(s);
  if (!m) store.set(s, (m = new Map()));
  return m;
};

// Forget what's known (a scan of the library has ended: files may have
// been replaced).
export function forgetFormats() {
  const s = app.server;
  if (!s) return;
  known.delete(s);
  asked.delete(s);
}

// Look up album `id`'s format when `el` comes into view, and give it to
// `put(format)` (not if `el` has gone, or there's none to show).
export function watchFormat(el, id, put) {
  if (!app.server || !/^\d+$/.test(String(id ?? ''))) return;
  const have = knownFormat(app.server, String(id));
  if (have !== undefined) {
    if (have) put(have);
    return;
  }
  if (!('IntersectionObserver' in window)) return;
  watched.set(el, { id: String(id), put });
  observer ??= new IntersectionObserver(seen, { rootMargin: '200px 0px' });
  observer.observe(el);
}

let settle = 0;
function seen(entries) {
  for (const e of entries) {
    if (e.isIntersecting) wanted.add(e.target);
    else wanted.delete(e.target);
  }
  clearTimeout(settle);
  settle = setTimeout(pump, SETTLE);
}

function pump() {
  while (running < RUNNING && wanted.size) {
    const el = wanted.values().next().value;
    wanted.delete(el);
    const w = watched.get(el);
    const s = app.server;
    if (!w || !s) {
      observer?.unobserve(el);
      continue;
    }
    const have = knownFormat(s, w.id);
    if (have !== undefined) {
      done(el, w, have);
      continue;
    }
    if (!el.isConnected) continue; // (a page put aside: it's watched again when shown)
    running += 1;
    albumFormat(s, w.id)
      .then((f) => done(el, w, f))
      .catch(() => {
        /* left without a badge (it's looked up again when shown again) */
      })
      .finally(() => {
        running -= 1;
        pump();
      });
  }
}

// (A page put aside meanwhile: it's still watched, and gets its badge from
// what's known when it's shown again.)
function done(el, w, f) {
  if (!el.isConnected) return;
  observer?.unobserve(el);
  watched.delete(el);
  if (f && app.settings.coverBadges !== false) w.put(f);
}

// What's known of an album's format: undefined if nothing (or not lately).
function knownFormat(s, id) {
  const k = known.get(s)?.get(id);
  return k && Date.now() - k.at < FRESH ? k.f : undefined;
}

// An album's format (kept, and asked for once at a time). What's found
// after the library changed isn't kept for the library as it is now.
function albumFormat(s, id) {
  const pending = mapFor(asked, s);
  if (pending.has(id)) return pending.get(id);
  const kept = mapFor(known, s);
  const p = (async () => {
    const tracks = (await s.children(id)).filter((m) => m.type === 'track').map(normTrack);
    const codecs = codecsOf(tracks);
    const a = wantsDetail(codecs) ? audioStream(await detailOf(s, tracks[0].id)) : null;
    const f = albumFormatOf(codecs, a);
    if (known.get(s) === kept) {
      kept.delete(id);
      kept.set(id, { f, at: Date.now() });
      while (kept.size > KEEP) kept.delete(kept.keys().next().value);
    }
    return f;
  })().finally(() => pending.get(id) === p && pending.delete(id));
  pending.set(id, p);
  return p;
}

// A track's full details, asked for together with the others wanted about
// now (as many as are being looked up at once: a few; metadataMany takes
// up to 40 a request). Not kept: they only go to make a badge, and the
// server's own cache has room for what's looked at more closely.
let batch = null;
function detailOf(s, id) {
  if (!batch || batch.s !== s) {
    const b = { s, want: new Map() };
    batch = b;
    setTimeout(() => {
      if (batch === b) batch = null;
      const ids = [...b.want.keys()];
      s.metadataMany(ids).then(
        (found) => {
          const byId = new Map(found.map((m) => [String(m.ratingKey), m]));
          for (const [tid, waiting] of b.want) waiting.forEach(({ resolve }) => resolve(byId.get(tid) || null));
        },
        (err) => b.want.forEach((waiting) => waiting.forEach(({ reject }) => reject(err))),
      );
    }, BATCH_WAIT);
  }
  return new Promise((resolve, reject) => {
    const list = batch.want.get(String(id)) || [];
    list.push({ resolve, reject });
    batch.want.set(String(id), list);
  });
}
