// Album-colour backgrounds. Plex computes four corner colours for artwork
// ("UltraBlur"); we paint them as a soft gradient behind the whole app and
// derive the player-bar tint from them.
import { app, on } from './state.js';
import { ultraBlurOf, cleanColors } from './plex.js';

const DEFAULT = { topLeft: '1c2233', topRight: '2b3752', bottomRight: '1e2638', bottomLeft: '131722' };
const albumColors = new Map();
let layer = 0;
let lastKey = null;

// Colours are checked to be plain hex values before they reach CSS.
const hex = (c) => {
  const v = String(c || '').replace(/^#/, '');
  return /^[0-9a-f]{6}$/i.test(v) ? `#${v}` : '#000000';
};

// A URL for CSS url("..."), with anything that could end the string escaped.
const cssUrl = (u) => `url("${String(u).replace(/["\\\n\r]/g, (ch) => encodeURIComponent(ch))}")`;

function toRgb(c) {
  const v = hex(c).slice(1);
  const n = parseInt(v.length === 3 ? v.replace(/./g, '$&$&') : v, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHsl([r, g, b]) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let hue;
  if (max === r) hue = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) hue = (b - r) / d + 2;
  else hue = (r - g) / d + 4;
  return [hue * 60, s, l];
}

const hsl = (hh, s, l) => `hsl(${hh.toFixed(1)} ${(s * 100).toFixed(1)}% ${(l * 100).toFixed(1)}%)`;

// Pick the most colourful corner (weighted by how far it is from grey) and
// settle it at a lightness that keeps white text readable.
function tintFrom(colors) {
  const corners = [colors.topRight, colors.bottomRight, colors.topLeft, colors.bottomLeft].map((c) => rgbToHsl(toRgb(c)));
  const best = corners.reduce((a, b) => (b[1] * (1 - Math.abs(b[2] - 0.5)) > a[1] * (1 - Math.abs(a[2] - 0.5)) ? b : a));
  const [hh, s] = best;
  const sat = Math.min(0.55, Math.max(s, 0.06));
  return { base: hsl(hh, sat, 0.3), hi: hsl(hh, Math.min(0.65, sat + 0.12), 0.58), deep: hsl(hh, sat * 0.8, 0.12) };
}

function gradient(c) {
  return [
    `radial-gradient(130% 95% at 0% 0%, ${hex(c.topLeft)} 0%, transparent 72%)`,
    `radial-gradient(130% 95% at 100% 0%, ${hex(c.topRight)} 0%, transparent 72%)`,
    `radial-gradient(130% 95% at 100% 100%, ${hex(c.bottomRight)} 0%, transparent 72%)`,
    `radial-gradient(130% 95% at 0% 100%, ${hex(c.bottomLeft)} 0%, transparent 72%)`,
    `linear-gradient(${hex(c.topLeft)}, ${hex(c.bottomRight)})`,
  ].join(', ');
}

// Background styles: "gradient" paints the album's colours, "artwork" a
// blurred copy of the cover, "plain" nothing at all.
function apply(colors, artPath) {
  const c = app.settings.tintBackground && colors ? colors : DEFAULT;
  const style = app.settings.backgroundStyle || 'gradient';
  const art = style === 'artwork' && artPath && app.server ? app.server.art(artPath, 480) : '';
  const key = [style, art, c.topLeft, c.topRight, c.bottomRight, c.bottomLeft].join();
  if (key === lastKey) return;
  lastKey = key;
  const layers = document.querySelectorAll('#backdrop .ub');
  const next = layers[layer ^ 1];
  const bg = gradient(c);
  next.classList.toggle('ub-art', !!art);
  next.style.background = style === 'plain' ? 'var(--bg)' : art ? `center / cover no-repeat ${cssUrl(art)}, ${hex(c.bottomLeft)}` : bg;
  next.classList.add('on');
  layers[layer].classList.remove('on');
  layer ^= 1;

  const tint = tintFrom(c);
  const root = document.documentElement.style;
  root.setProperty('--ub-bg', bg);
  root.setProperty('--tint', tint.base);
  root.setProperty('--tint-hi', tint.hi);
  root.setProperty('--tint-deep', tint.deep);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', '#000000');
  document.dispatchEvent(new Event('tintchange'));
}

// Colours for a track: the album's own UltraBlur colours if the server has
// them, otherwise ask the server to compute them, otherwise a colour derived
// from the album name so every album still gets its own tint.
async function colorsFor(track) {
  const key = track.albumId || track.thumb || track.id;
  if (albumColors.has(key)) return albumColors.get(key);
  const s = app.server;
  let colors = null;
  let offline = false;
  try {
    if (track.albumId) colors = ultraBlurOf(await s.metadata(track.albumId));
  } catch (err) {
    offline = !!err.network;
  }
  if (!colors && track.thumb && !offline) {
    try {
      colors = await s.ultraBlur(track.thumb);
    } catch (err) {
      offline = !!err.network;
    }
  }
  colors = cleanColors(colors);
  if (!colors) colors = hashColors(track.album || track.title);
  if (!offline) albumColors.set(key, colors); // try the server again next time if it was unreachable
  return colors;
}

function hashColors(text) {
  let n = 0;
  for (const ch of text || '') n = (n * 31 + ch.charCodeAt(0)) >>> 0;
  const hue = n % 360;
  const mk = (dh, s, l) => {
    const c = `hsl(${(hue + dh) % 360} ${s}% ${l}%)`;
    const probe = document.createElement('i');
    probe.style.color = c;
    document.body.append(probe);
    const rgb = getComputedStyle(probe).color.match(/\d+/g).slice(0, 3).map(Number);
    probe.remove();
    return rgb.map((v) => v.toString(16).padStart(2, '0')).join('');
  };
  return { topLeft: mk(0, 30, 16), topRight: mk(18, 42, 32), bottomRight: mk(-12, 36, 22), bottomLeft: mk(8, 26, 12) };
}

export function initBackdrop(player) {
  apply(null);
  let token = 0;
  const update = async (track) => {
    const mine = ++token;
    if (!track || !app.server) return apply(null);
    const colors = await colorsFor(track);
    if (mine === token) apply(colors, track.thumb);
  };
  player.addEventListener('track', () => update(player.current));
  on('settings', () => {
    lastKey = null;
    update(player.current);
  });
  on('signout', () => {
    albumColors.clear();
    apply(null);
  });
  on('source', ({ serverChanged }) => {
    if (!serverChanged) return;
    albumColors.clear();
    apply(null);
  });
  update(player.current);
}
