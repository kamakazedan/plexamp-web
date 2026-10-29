// DOM helpers, icons, formatting and the shared building blocks every view
// uses (headers, shelves, cards, rows, sheets, toasts, infinite lists).
import { app } from './state.js';
import { store } from './plex.js';
import { pushOverlay, popOverlay, back as goBack } from './router.js';

// ---------- element builder ----------

const PROP_KEYS = new Set(['value', 'checked', 'disabled', 'hidden', 'selected', 'indeterminate']);

export function h(tag, props, ...kids) {
  const [name, ...classes] = tag.split('.');
  const el = document.createElement(name || 'div');
  if (classes.length) el.className = classes.join(' ');
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = [el.className, v].filter(Boolean).join(' ');
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (PROP_KEYS.has(k)) el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  append(el, kids);
  return el;
}

export function append(el, kids) {
  for (const k of [kids].flat(Infinity)) {
    if (k === null || k === undefined || k === false) continue;
    el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
  return el;
}

// ---------- icons (drawn for this project, 24px grid) ----------

function gearPath() {
  const pts = [];
  const teeth = 8;
  for (let i = 0; i < teeth; i++) {
    const a = (i / teeth) * Math.PI * 2;
    const outer = (Math.PI / teeth) * 0.5;
    const inner = (Math.PI / teeth) * 0.82;
    pts.push([a - inner, 7.3], [a - outer, 9.8], [a + outer, 9.8], [a + inner, 7.3]);
  }
  const d = pts.map(([a, r]) => `${(12 + r * Math.cos(a)).toFixed(2)} ${(12 + r * Math.sin(a)).toFixed(2)}`).join('L');
  return `M${d}Z`;
}

const S = (d) => `<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</g>`;
const F = (d) => `<g fill="currentColor">${d}</g>`;

const ICONS = {
  home: S('<path d="M4 10.2 12 4l8 6.2V19a1 1 0 0 1-1 1h-4.5v-5.5h-5V20H5a1 1 0 0 1-1-1z"/>'),
  library: S('<rect x="3.5" y="3.5" width="17" height="17" rx="3.5"/><path d="M11 15.6V8.3l4.6-1.3"/><circle cx="9.2" cy="15.6" r="1.8"/>'),
  search: S('<circle cx="10.8" cy="10.8" r="6.3"/><path d="m15.6 15.6 4.9 4.9"/>'),
  settings: S(`<path d="${gearPath()}"/><circle cx="12" cy="12" r="3"/>`),
  chevronRight: S('<path d="M9.5 5.5 16 12l-6.5 6.5"/>'),
  chevronLeft: S('<path d="M14.5 5.5 8 12l6.5 6.5"/>'),
  chevronDown: S('<path d="M5.5 9 12 15.5 18.5 9"/>'),
  back: S('<path d="M20 12H4.5M10.5 5.5 4 12l6.5 6.5"/>'),
  more: F('<circle cx="5.5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="18.5" cy="12" r="1.8"/>'),
  close: S('<path d="M6 6l12 12M18 6 6 18"/>'),
  play: F('<path d="M7.5 4.9v14.2c0 .8.9 1.3 1.6.9l11.3-7.1a1 1 0 0 0 0-1.8L9.1 4c-.7-.4-1.6.1-1.6.9z"/>'),
  pause: F('<rect x="6" y="4.5" width="4.2" height="15" rx="1.2"/><rect x="13.8" y="4.5" width="4.2" height="15" rx="1.2"/>'),
  next: F('<path d="M5 5.6v12.8c0 .8.9 1.2 1.5.8l9-6.4a1 1 0 0 0 0-1.6l-9-6.4c-.6-.4-1.5 0-1.5.8z"/><rect x="16.8" y="4.5" width="2.6" height="15" rx="1.1"/>'),
  prev: F('<path d="M19 5.6v12.8c0 .8-.9 1.2-1.5.8l-9-6.4a1 1 0 0 1 0-1.6l9-6.4c.6-.4 1.5 0 1.5.8z"/><rect x="4.6" y="4.5" width="2.6" height="15" rx="1.1"/>'),
  shuffle: S('<path d="M3.5 7h3.2c1.9 0 3 .8 4 2.4l2.6 5.2c1 1.6 2.1 2.4 4 2.4h3.2M17.5 14l3 3-3 3M3.5 17h3.2c1.2 0 2-.3 2.8-1M20.5 7h-3.2c-1.2 0-2 .3-2.8 1M17.5 4l3 3-3 3"/>'),
  repeat: S('<path d="M4 12V9.5A3.5 3.5 0 0 1 7.5 6H20M17 3l3 3-3 3M20 12v2.5a3.5 3.5 0 0 1-3.5 3.5H4M7 21l-3-3 3-3"/>'),
  repeatOne: S('<path d="M4 12V9.5A3.5 3.5 0 0 1 7.5 6H20M17 3l3 3-3 3M20 12v2.5a3.5 3.5 0 0 1-3.5 3.5H4M7 21l-3-3 3-3M11.2 10.4l1.4-.9v5"/>'),
  queue: S('<path d="M4 6.5h16M4 11.5h16M4 16.5h9"/><path d="M16.5 14.6v4.8l3.8-2.4z" fill="currentColor" stroke="none"/>'),
  radio: S('<circle cx="12" cy="12" r="1.7" fill="currentColor" stroke="none"/><path d="M8.6 15.4a4.8 4.8 0 0 1 0-6.8M15.4 8.6a4.8 4.8 0 0 1 0 6.8M5.8 18.2a8.8 8.8 0 0 1 0-12.4M18.2 5.8a8.8 8.8 0 0 1 0 12.4"/>'),
  path: S('<circle cx="6" cy="18" r="2.2"/><circle cx="18" cy="6" r="2.2"/><path d="M8.2 18h7.3a3 3 0 0 0 0-6h-7a3 3 0 0 1 0-6h7.3"/>'),
  mic: S('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7"/>'),
  disc: S('<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="2.4"/>'),
  note: S('<path d="M9.5 17.5V6l9-2v11.5"/><circle cx="7.2" cy="17.6" r="2.3"/><circle cx="16.2" cy="15.6" r="2.3"/>'),
  list: S('<path d="M4 6.5h11M4 11.5h11M4 16.5h7"/><circle cx="17.3" cy="16.6" r="2.3"/><path d="M19.6 16.6V7.4l1.4-.4"/>'),
  user: S('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="10" r="3"/><path d="M6.6 18.2a6.3 6.3 0 0 1 10.8 0"/>'),
  // Switching to someone else in your Plex Home: a person, and arrows each way.
  switchUser: S('<circle cx="9.5" cy="8" r="3.3"/><path d="M3.5 19.5a6 6 0 0 1 10.6-3.9"/><path d="M15.5 12.5h5.5l-2-2M21 17h-5.5l2 2"/>'),
  palette: S('<path d="M12 3.5a8.5 8.5 0 1 0 0 17c1.2 0 1.8-.9 1.4-2l-.3-.8c-.4-1.1.4-2.2 1.6-2.2h1.8a4 4 0 0 0 4-4c0-4.4-3.8-8-8.5-8z"/><circle cx="7.8" cy="11.5" r="1" fill="currentColor"/><circle cx="10.5" cy="7.6" r="1" fill="currentColor"/><circle cx="15" cy="8" r="1" fill="currentColor"/>'),
  speaker: S('<path d="M4 9.5h3.2L12 5.5v13l-4.8-4H4z"/><path d="M15.5 9a4.2 4.2 0 0 1 0 6M18 6.5a7.8 7.8 0 0 1 0 11"/>'),
  speakerOff: S('<path d="M4 9.5h3.2L12 5.5v13l-4.8-4H4z"/><path d="m16 9.5 5 5M21 9.5l-5 5"/>'),
  // Volume levels: fewer sound waves as it goes down (under 75, 50, 25%).
  speaker0: S('<path d="M3.5 9.5h3.2l4.8-4v13l-4.8-4H3.5z"/>'),
  speaker1: S('<path d="M3.5 9.5h3.2l4.8-4v13l-4.8-4H3.5z"/><path d="M14.6 10a2.9 2.9 0 0 1 0 4"/>'),
  speaker2: S('<path d="M3.5 9.5h3.2l4.8-4v13l-4.8-4H3.5z"/><path d="M14.6 10a2.9 2.9 0 0 1 0 4M17 7.8a6 6 0 0 1 0 8.4"/>'),
  speaker3: S('<path d="M3.5 9.5h3.2l4.8-4v13l-4.8-4H3.5z"/><path d="M14.6 10a2.9 2.9 0 0 1 0 4M17 7.8a6 6 0 0 1 0 8.4M19.4 5.6a9.2 9.2 0 0 1 0 12.8"/>'),
  cast: S('<path d="M3.5 8V6.5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H14"/><path d="M3.5 11.5a8 8 0 0 1 8 8M3.5 15a4.5 4.5 0 0 1 4.5 4.5"/><circle cx="3.9" cy="19.1" r=".9" fill="currentColor"/>'),
  casting: S('<path d="M3.5 8V6.5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H14"/><path d="M3.5 11.5a8 8 0 0 1 8 8M3.5 15a4.5 4.5 0 0 1 4.5 4.5"/><circle cx="3.9" cy="19.1" r=".9" fill="currentColor"/><path d="M7 8h10.5v8.5h-2.8" fill="currentColor" stroke="none" opacity=".45"/>'),
  airplay: S('<path d="M6.5 17H4.5a2 2 0 0 1-2-2V6.5a2 2 0 0 1 2-2h15a2 2 0 0 1 2 2V15a2 2 0 0 1-2 2h-2"/><path d="M12 14l5 6H7z"/>'),
  lock: S('<rect x="5" y="10.5" width="14" height="10" rx="2.2"/><path d="M8.2 10.5V7.8a3.8 3.8 0 0 1 7.6 0v2.7M12 14.6v2"/>'),
  unlock: S('<rect x="5" y="10.5" width="14" height="10" rx="2.2"/><path d="M8.2 10.5V7.8a3.8 3.8 0 0 1 7.3-1.5M12 14.6v2"/>'),
  // Browsing the library (Search).
  tag: S('<path d="M3.5 12.2V4.8a1.3 1.3 0 0 1 1.3-1.3h7.4l8.3 8.3a1.3 1.3 0 0 1 0 1.8l-6.5 6.5a1.3 1.3 0 0 1-1.8 0z"/><circle cx="8" cy="8" r="1.4"/>'),
  film: S('<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M7.5 4.5v15M16.5 4.5v15M3.5 9h4M3.5 15h4M16.5 9h4M16.5 15h4"/>'),
  calendar: S('<rect x="3.5" y="5" width="17" height="15.5" rx="2.2"/><path d="M3.5 9.8h17M8 3v4M16 3v4"/>'),
  smile: S('<circle cx="12" cy="12" r="8.5"/><path d="M8.6 14.2a4.2 4.2 0 0 0 6.8 0"/><circle cx="9" cy="10" r=".9" fill="currentColor"/><circle cx="15" cy="10" r=".9" fill="currentColor"/>'),
  stack: S('<rect x="6.5" y="6.5" width="13" height="13" rx="2"/><path d="M4 16.5V5.8A1.8 1.8 0 0 1 5.8 4h10.7"/>'),
  edit: S('<path d="M4.5 19.5l1-4.1L15.8 5.1a2 2 0 0 1 2.9 0l.2.2a2 2 0 0 1 0 2.9L8.6 18.5z"/><path d="M13.8 7.1l3.1 3.1"/>'),
  image: S('<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><circle cx="9" cy="9.5" r="1.6"/><path d="m4.5 17.5 5-5 3.5 3.5 2.5-2.5 4 4"/>'),
  trash: S('<path d="M4.5 6.5h15M9.5 6.5V4.8a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1.7M6.5 6.5l.9 12.2a1.5 1.5 0 0 0 1.5 1.3h6.2a1.5 1.5 0 0 0 1.5-1.3l.9-12.2M10.2 10.5v6M13.8 10.5v6"/>'),
  remove: S('<circle cx="12" cy="12" r="8.5"/><path d="M8 12h8"/>'),
  playlistAdd: S('<path d="M4 6.5h11M4 11.5h11M4 16.5h7M17.5 13v7M14 16.5h7"/>'),
  // Which lists a track is in: a list, and a magnifying glass.
  appears: S('<path d="M4 6.5h12M4 11.5h6M4 16.5h4"/><circle cx="15.2" cy="14.8" r="3.6"/><path d="m17.9 17.5 2.6 2.6"/>'),
  collection: S('<rect x="3.5" y="8" width="13" height="12" rx="2"/><path d="M7 5h11.5a2 2 0 0 1 2 2v9.5"/><path d="M8.5 13.5h3M10 12v3"/>'),
  moveTop: S('<path d="M5 4.5h14M12 20V9.5M7 14l5-5 5 5"/>'),
  terminal: S('<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="m7 9.5 3 2.5-3 2.5M12.5 15H17"/>'),
  info: S('<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.6v.2"/>'),
  signOut: S('<path d="M14.5 4.5h3a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-3M10 16.5 5.5 12 10 7.5M5.5 12H15"/>'),
  check: S('<path d="M5 12.5 9.5 17 19 7.5"/>'),
  // Choosing several (selection.js): a ticked circle.
  select: S('<circle cx="12" cy="12" r="8.5"/><path d="m8.3 12.3 2.6 2.6 4.9-5.2"/>'),
  playNext: S('<path d="M4 6.5h11M4 11.5h11M4 16.5h6"/><path d="M14.5 14.2v6l4.8-3z" fill="currentColor"/>'),
  addQueue: S('<path d="M4 6.5h12M4 11.5h12M4 16.5h7M17.5 14v6M14.5 17h6"/>'),
  sort: S('<path d="M4 7h16M7 12h10M10 17h4"/>'),
  expand: S('<path d="M14 4h6v6M10 20H4v-6M20 4l-6.5 6.5M4 20l6.5-6.5"/>'),
  server: S('<rect x="4" y="4" width="16" height="7" rx="1.8"/><rect x="4" y="13" width="16" height="7" rx="1.8"/><path d="M8 7.5h.01M8 16.5h.01"/>'),
  external: S('<path d="M14 5h5v5M19 5l-8 8M17 14v4a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h4"/>'),
  refresh: S('<path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6"/>'),
  convert: S('<path d="M4 8h14M14.5 4.5 18 8l-3.5 3.5M20 16H6M9.5 12.5 6 16l3.5 3.5"/>'),
  trend: S('<path d="M4 17l5-5 3.5 3.5L20 8M15 8h5v5"/>'),
  star: S('<path d="M12 3.8l2.45 5.05 5.55.75-4.05 3.85 1 5.5L12 16.3l-4.95 2.65 1-5.5L4 9.6l5.55-.75z"/>'),
  moon: S('<path d="M19.5 14.3A7.8 7.8 0 0 1 9.7 4.5a7.8 7.8 0 1 0 9.8 9.8z"/>'),
  dj: S('<rect x="3" y="5" width="18" height="14" rx="3"/><circle cx="10" cy="12" r="4"/><circle cx="10" cy="12" r="0.9" fill="currentColor"/><path d="M17 8.2v5.3l-2.2 2.1"/>'),
  sparkle: S('<path d="M12 3.5l1.7 4.9 4.8 1.7-4.8 1.7L12 16.7l-1.7-4.9L5.5 10.1l4.8-1.7zM18.5 15l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/>'),
  live: S('<path d="M8.5 8.5a5 5 0 0 0 0 7M15.5 8.5a5 5 0 0 1 0 7M5.6 5.6a9 9 0 0 0 0 12.8M18.4 5.6a9 9 0 0 1 0 12.8"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/>'),
  together: S('<circle cx="9" cy="8.6" r="3.2"/><path d="M3.4 19.2a5.6 5.6 0 0 1 11.2 0"/><circle cx="16.9" cy="9.4" r="2.6"/><path d="M15.4 14.3a4.6 4.6 0 0 1 5.2 4.9"/>'),
  thumbUp: S('<path d="M7.5 10.6v9h-3v-9zM7.5 10.6l3.7-6.3c1-.4 2.1.3 2 1.4l-.6 3.9h5.3a2 2 0 0 1 2 2.4l-1.3 6.1a2 2 0 0 1-2 1.5H7.5"/>'),
  thumbDown: `<g transform="rotate(180 12 12)">${S('<path d="M7.5 10.6v9h-3v-9zM7.5 10.6l3.7-6.3c1-.4 2.1.3 2 1.4l-.6 3.9h5.3a2 2 0 0 1 2 2.4l-1.3 6.1a2 2 0 0 1-2 1.5H7.5"/>')}</g>`,
  // Favourite (the rating system's tick): a circle, and a filled circle with
  // a tick once it's a favourite (coloured by the button: see .np-fav.on).
  favourite: S('<circle cx="12" cy="12" r="8.6"/>'),
  heart: S('<path d="M12 19.6s-7.3-4.5-7.3-10A4.1 4.1 0 0 1 12 7.2a4.1 4.1 0 0 1 7.3 2.4c0 5.5-7.3 10-7.3 10z"/>'),
  favourited: `${F('<circle cx="12" cy="12" r="9.5"/>')}<path d="m7.9 12.3 2.8 2.8 5.4-5.7" fill="none" stroke="#fff" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/>`,
  flame: S('<path d="M12 21.2a6.2 6.2 0 0 0 6.2-6.2c0-3.6-2.6-5.7-3.7-8.7-.3 2.3-1.6 3.4-2.7 3.9.2-3-1-5.6-3.4-7 .2 3.3-2.6 5.8-2.6 9.8a6.2 6.2 0 0 0 6.2 8.2z"/>'),
  headphones: S('<path d="M4.5 15.5v-3a7.5 7.5 0 0 1 15 0v3"/><rect x="3.5" y="14" width="4.2" height="6.2" rx="1.6"/><rect x="16.3" y="14" width="4.2" height="6.2" rx="1.6"/>'),
  grip: F('<circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/>'),
  speed: S('<path d="M4.6 17.6a8.6 8.6 0 1 1 14.8 0"/><path d="m12 13.4 4.2-4.6"/><circle cx="12" cy="13.4" r="1.4" fill="currentColor"/>'),
  link: S('<path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1"/><path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1"/>'),
  sliders: S('<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2.1"/><circle cx="9" cy="17" r="2.1"/>'),
  monitor: S('<rect x="3" y="4.5" width="18" height="12" rx="2"/><path d="M9 20h6M12 16.5V20"/>'),
  plus: S('<path d="M12 5v14M5 12h14"/>'),
  arrowUp: S('<path d="M12 19V5M6 11l6-6 6 6"/>'),
  arrowDown: S('<path d="M12 5v14M6 13l6 6 6-6"/>'),
  home2: S('<path d="M4 10.2 12 4l8 6.2V19a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z"/><path d="M9 14h6"/>'),
  player: S('<rect x="4.5" y="3.5" width="15" height="17" rx="2.5"/><rect x="7.5" y="6.5" width="9" height="7" rx="1"/><path d="M8 17.2h8"/>'),
};

// Skip back / forward by a number of seconds, drawn with the number inside.
export function skipIcon(direction, seconds, size = 26) {
  const n = Math.max(1, Math.min(999, Math.round(Number(seconds) || 0)));
  const arc = direction < 0 ? '<path d="M5.2 9A7.8 7.8 0 1 1 4.2 12.6"/><path d="M4.6 4.6V9h4.4"/>' : '<path d="M18.8 9A7.8 7.8 0 1 0 19.8 12.6"/><path d="M19.4 4.6V9H15"/>';
  const t = document.createElement('template');
  t.innerHTML = `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${S(arc)}<text x="12" y="15.2" text-anchor="middle" font-size="${n > 99 ? 6 : 7.4}" font-weight="700" fill="currentColor">${n}</text></svg>`;
  return t.content.firstChild;
}

export function icon(name, size = 24, cls = '') {
  const t = document.createElement('template');
  t.innerHTML = `<svg class="ic ${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICONS[name] || ''}</svg>`;
  return t.content.firstChild;
}

export function iconButton(name, label, onClick, { size = 24, cls = '' } = {}) {
  return h(`button.icon-btn${cls ? `.${cls}` : ''}`, { type: 'button', 'aria-label': label, title: label, onclick: onClick }, icon(name, size));
}

// ---------- formatting ----------

const nf = new Intl.NumberFormat();
const plural = (n, one, many) => `${nf.format(n)} ${n === 1 ? one : many}`;

export const fmt = {
  number: (n) => nf.format(n),
  count: plural,
  clock(sec) {
    const s = Math.max(0, Math.floor(sec || 0));
    const hh = Math.floor(s / 3600);
    const mm = Math.floor((s % 3600) / 60);
    const ss = String(s % 60).padStart(2, '0');
    return hh ? `${hh}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
  },
  // Total running time: "5 minutes", "6 hr, 25 min", "1 day, 13 hours"
  long(ms) {
    const totalMin = Math.round((ms || 0) / 60000);
    if (totalMin < 1) return ms ? 'Under a minute' : '';
    const days = Math.floor(totalMin / 1440);
    const hours = Math.floor((totalMin % 1440) / 60);
    const mins = totalMin % 60;
    if (days >= 365) {
      const y = Math.floor(days / 365);
      const mo = Math.floor((days % 365) / 30);
      return mo ? `${plural(y, 'year', 'years')}, ${plural(mo, 'month', 'months')}` : plural(y, 'year', 'years');
    }
    if (days >= 30) {
      const mo = Math.floor(days / 30);
      const d = days % 30;
      return d ? `${plural(mo, 'month', 'months')}, ${plural(d, 'day', 'days')}` : plural(mo, 'month', 'months');
    }
    if (days) return hours ? `${plural(days, 'day', 'days')}, ${plural(hours, 'hour', 'hours')}` : plural(days, 'day', 'days');
    if (hours) return mins ? `${hours} hr, ${mins} min` : plural(hours, 'hour', 'hours');
    return plural(mins, 'minute', 'minutes');
  },
  ago(epochSec) {
    if (!epochSec) return '';
    const s = Math.max(0, Date.now() / 1000 - epochSec);
    const steps = [
      [45, () => 'just now'],
      [90, () => 'a minute ago'],
      [2700, (v) => `${Math.round(v / 60)} minutes ago`],
      [5400, () => 'an hour ago'],
      [79200, (v) => `${Math.round(v / 3600)} hours ago`],
      [129600, () => 'a day ago'],
      [2160000, (v) => `${Math.round(v / 86400)} days ago`],
      [3888000, () => 'a month ago'],
      [29808000, (v) => `${Math.round(v / 2592000)} months ago`],
      [47304000, () => 'a year ago'],
    ];
    for (const [limit, f] of steps) if (s < limit) return f(s);
    return `${Math.round(s / 31536000)} years ago`;
  },
  codec(c) {
    const names = { flac: 'FLAC', alac: 'ALAC', mp3: 'MP3', aac: 'AAC', opus: 'Opus', vorbis: 'Vorbis', wav: 'WAV', pcm: 'PCM', dsd: 'DSD', wma: 'WMA', ape: 'APE' };
    return names[c] || (c || '').toUpperCase();
  },
};

// ---------- artwork ----------

// The size to ask Plex for: what it's shown at on this screen, in a few
// steps (so pictures are reused), up to `most` pixels.
function artPixels(css, most = 960) {
  const n = css * Math.min(window.devicePixelRatio || 1, 2);
  return [100, 160, 240, 320, 480, 640, 960, 1280, 1920].find((s) => s >= n && s <= most) || most;
}

export function artUrl(path, css = 160, most) {
  return path && app.server ? app.server.art(path, artPixels(css, most)) : '';
}

export function art(path, { size = 160, most, round = false, cls = '', fallback = 'note', alt = '' } = {}) {
  const wrap = h(`div.art${round ? '.round' : ''}${cls ? `.${cls}` : ''}`);
  const missing = () => {
    wrap.classList.add('missing');
    wrap.replaceChildren(icon(fallback, Math.max(18, Math.min(44, Math.round(size / 3.4)))));
  };
  const src = artUrl(path, size, most);
  if (!src) {
    missing();
    return wrap;
  }
  const img = h('img', { alt, loading: 'lazy', decoding: 'async', draggable: 'false', src });
  const failed = () => {
    // A picture let go on purpose (off screen, see pagedList and the router)
    // isn't a broken one.
    if (!img.getAttribute('src')) return;
    img.removeEventListener('error', failed);
    missing();
  };
  img.addEventListener('error', failed);
  img.addEventListener('load', () => wrap.classList.add('loaded'), { once: true });
  wrap.append(img);
  return wrap;
}

// ---------- page chrome ----------

export function pageHeader(title, { subtitle, onSubtitle, actions } = {}) {
  return h(
    'header.page-head',
    null,
    h(
      'div.page-head-text',
      null,
      h('h1.page-title', null, title),
      subtitle
        ? onSubtitle
          ? h('button.page-sub', { type: 'button', onclick: onSubtitle }, subtitle, icon('chevronDown', 18))
          : h('div.page-sub', null, subtitle)
        : null,
    ),
    actions ? h('div.page-actions', null, actions) : null,
  );
}

export function backHeader(title, { actions, fallback = '/', collapse = false } = {}) {
  const t = h('h1.back-title', null, title);
  const head = h(
    `header.back-head${collapse ? '.collapsible' : ''}`,
    null,
    iconButton('back', 'Back', () => goBack(fallback)),
    t,
    actions ? h('div.back-actions', null, actions) : null,
  );
  return head;
}

// Show a sticky header's title only once the page's own big title scrolls away.
export function collapseWhenHidden(head, target) {
  if (!('IntersectionObserver' in window)) {
    head.classList.add('solid');
    return;
  }
  const io = new IntersectionObserver(([e]) => head.classList.toggle('solid', !e.isIntersecting), {
    rootMargin: '-64px 0px 0px 0px',
  });
  io.observe(target);
}

// A section's heading. `href`: the page with all of it. `shelf`: the row
// under it that scrolls sideways. On a touch screen the shelf is swiped and
// the whole heading opens the page. With a mouse, ‹ › by the heading scroll
// the shelf (‹ once it's moved, › until its end), and the title opens the
// page.
export function sectionHeader(title, href, extra, shelf) {
  // Non-breaking hyphens keep names like "Hi-Res" together when a heading wraps.
  const text = h('h2', null, String(title).replace(/-/g, '‑'));
  if (shelf && matchMedia('(hover: hover) and (pointer: fine)').matches) {
    const back = iconButton('chevronLeft', 'Scroll left', () => scrollShelf(shelf, -1), { size: 22 });
    const on = iconButton('chevronRight', 'Scroll right', () => scrollShelf(shelf, 1), { size: 22 });
    const head = h(
      'div.section-head.shelf-head',
      null,
      href ? h('a.section-link', { href: `#${href}` }, text) : text,
      extra || null,
      h('div.shelf-nav', null, back, on),
    );
    watchShelf(head, shelf, back, on);
    return head;
  }
  const kids = [text, extra || null, href ? icon('chevronRight', 26, 'chev') : null];
  return href ? h('a.section-head', { href: `#${href}` }, kids) : h('div.section-head', null, kids);
}

// A shelf scrolled a screenful: on, so the first card that wasn't all in
// sight comes first; back, a screenful (the shelf lines up on a card).
function scrollShelf(shelf, dir) {
  const box = shelf.getBoundingClientRect();
  const style = getComputedStyle(shelf);
  const start = box.left + (parseFloat(style.paddingLeft) || 0);
  const end = box.right - (parseFloat(style.paddingRight) || 0);
  const behavior = matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
  if (dir > 0) {
    const next = [...(shelf.firstElementChild?.children || [])].find((c) => c.getBoundingClientRect().right > end + 1);
    if (next) shelf.scrollBy({ left: next.getBoundingClientRect().left - start, behavior });
  } else {
    shelf.scrollBy({ left: -(end - start), behavior });
  }
}

// Which of a shelf's buttons are any use: checked when it comes into view
// (also when its page is shown again), as it scrolls, as the pointer comes
// to it, and when the window changes size (one listener for every shelf on
// the page, so nothing is left behind with a page).
const shelfChecks = new WeakMap();
let shelvesWatched = false;
function watchShelf(head, shelf, back, on) {
  let frame = 0;
  const check = () => {
    frame = 0;
    if (!shelf.isConnected) return;
    const most = shelf.scrollWidth - shelf.clientWidth;
    back.classList.toggle('off', shelf.scrollLeft <= 2);
    on.classList.toggle('off', shelf.scrollLeft >= most - 2);
  };
  const soon = () => {
    if (!frame) frame = requestAnimationFrame(check);
  };
  back.classList.add('off');
  on.classList.add('off');
  shelf.addEventListener('scroll', soon, { passive: true });
  head.addEventListener('pointerenter', soon);
  shelf.addEventListener('pointerenter', soon);
  shelfChecks.set(head, soon);
  if ('IntersectionObserver' in window) new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && soon()).observe(shelf);
  else requestAnimationFrame(soon);
  if (!shelvesWatched) {
    shelvesWatched = true;
    window.addEventListener('resize', () => document.querySelectorAll('.shelf-head').forEach((el) => shelfChecks.get(el)?.()), { passive: true });
  }
}

// ---------- cards, shelves, grids ----------

// Cards grow with the window on big screens (app.css), and so does the
// artwork asked for them.
const cardArt = () => (window.innerWidth >= 1900 ? Math.min(280, Math.round(window.innerWidth * 0.096)) : 200);

// `onMenu`: its menu, from a button in the corner of its artwork (with the
// play buttons) or, on a touch screen, a long press.
export function card({ href, image, title, subtitle, round = false, fallback = 'disc', onPlay, onShuffle, onMenu, size = cardArt() }) {
  const a = h(
    `a.card${round ? '.card-round' : ''}${onMenu ? '.has-menu' : ''}`,
    { href: `#${href}` },
    h('div.card-art', null, art(image, { size, round, fallback, alt: '' }), onPlay ? cardActions(title, onPlay, onShuffle, onMenu) : null),
    h('div.card-title', null, title),
    subtitle ? h('div.card-sub', null, subtitle) : null,
  );
  if (onMenu) longPress(a, onMenu);
  return a;
}

// A long press with a finger: `fn`, instead of what a tap would do (and
// instead of the browser's own menu for a link). Not while choosing several
// (selection.js), where a tap chooses. One set of listeners for the page,
// however many covers it has.
const LONG_PRESS = 500; // ms
const pressable = new WeakMap(); // element → what a long press on it does
let press = null; // { el, id, x, y, timer }: a finger down, until it's a long press
let held = null; // the element pressed long, until the finger's lifted

export function longPress(el, fn) {
  pressable.set(el, fn);
  if (longPress.listening) return;
  longPress.listening = true;
  document.addEventListener('pointerdown', pressStart);
  document.addEventListener('pointermove', (e) => press?.id === e.pointerId && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 10 && pressEnd(), { passive: true });
  document.addEventListener('pointerup', (e) => press?.id === e.pointerId && pressEnd());
  document.addEventListener('pointercancel', (e) => press?.id === e.pointerId && pressEnd());
  document.addEventListener('contextmenu', (e) => {
    const on = press?.el || held;
    if (on && on.contains(e.target)) e.preventDefault();
  });
}

function pressStart(e) {
  pressEnd();
  if (e.pointerType !== 'touch' || document.body.classList.contains('selecting')) return;
  let el = e.target;
  while (el && !pressable.has(el)) el = el.parentElement;
  if (!el) return;
  const p = { el, id: e.pointerId, x: e.clientX, y: e.clientY };
  p.timer = setTimeout(() => {
    if (press !== p) return;
    press = null;
    if (!el.isConnected) return;
    held = el;
    ignoreRelease(p.id, () => held === el && (held = null));
    navigator.vibrate?.(8);
    pressable.get(el)?.();
  }, LONG_PRESS);
  press = p;
}

function pressEnd() {
  if (!press) return;
  clearTimeout(press.timer);
  press = null;
}

// The tap that lifting the finger after a long press can make isn't one,
// wherever it lands (on the menu that opened under it, say): a click where
// the finger came up, straight after. (Browsers that make none leave the
// next real tap alone: it's somewhere else, or later.)
function ignoreRelease(pointerId, then) {
  let until = Infinity;
  let at = null;
  let quit = 0;
  const done = () => {
    window.removeEventListener('click', swallow, true);
    window.removeEventListener('pointerup', up, true);
    window.removeEventListener('pointercancel', up, true);
    clearTimeout(quit);
    then();
  };
  const swallow = (e) => {
    const here = !at || Math.hypot(e.clientX - at.x, e.clientY - at.y) < 24;
    if (performance.now() <= until && here) {
      e.preventDefault();
      e.stopPropagation();
    }
    done();
  };
  const up = (e) => {
    if (e.pointerId !== pointerId) return;
    until = performance.now() + 400;
    at = { x: e.clientX, y: e.clientY };
    clearTimeout(quit);
    quit = setTimeout(done, 450);
  };
  window.addEventListener('click', swallow, true);
  window.addEventListener('pointerup', up, true);
  window.addEventListener('pointercancel', up, true);
  quit = setTimeout(done, 20000); // (a finger that's never lifted, as far as we hear)
}

// Play (and shuffle) buttons in the middle of a card's artwork, and its
// menu in the corner, shown on hover or keyboard focus.
function cardActions(title, onPlay, onShuffle, onMenu) {
  const button = (cls, label, name, size, fn) =>
    h(
      `button.${cls}`,
      {
        type: 'button',
        'aria-label': label,
        title: label,
        onclick: (e) => {
          e.preventDefault();
          e.stopPropagation();
          fn();
        },
      },
      icon(name, size),
    );
  return h(
    'div.card-actions',
    null,
    button('card-play', `Play ${title}`, 'play', 24, onPlay),
    onShuffle ? button('card-shuffle', `Shuffle ${title}`, 'shuffle', 20, onShuffle) : null,
    onMenu ? button('card-more', `More options for ${title}`, 'more', 20, onMenu) : null,
  );
}

export function wideCard({ href, image, title, subtitle, fallback = 'disc' }) {
  return h(
    'a.wide-card',
    { href: `#${href}` },
    art(image, { size: 80, fallback }),
    h('div.wide-text', null, h('div.wide-title', null, title), subtitle ? h('div.wide-sub', null, subtitle) : null),
  );
}

export function shelf(children) {
  return h('div.shelf', null, h('div.shelf-track', null, children));
}

export function grid(children, { centered = false, cls = '' } = {}) {
  return h(`div.grid${centered ? '.centered' : ''}${cls ? `.${cls}` : ''}`, null, children);
}

// ---------- rows ----------

export function row({ href, onClick, image, round, fallback, lead, title, subtitle, right, chevron = !!href, cls = '' }) {
  const kids = [
    lead || (image !== undefined ? art(image, { size: 56, round, fallback: fallback || (round ? 'mic' : 'disc') }) : null),
    h('div.row-main', null, h('div.row-title', null, title), subtitle ? h('div.row-sub', null, subtitle) : null),
    right || null,
    chevron ? icon('chevronRight', 24, 'chev') : null,
  ];
  if (href) return h(`a.row${cls ? `.${cls}` : ''}`, { href: `#${href}` }, kids);
  if (onClick) return h(`button.row${cls ? `.${cls}` : ''}`, { type: 'button', onclick: onClick }, kids);
  return h(`div.row${cls ? `.${cls}` : ''}`, null, kids);
}

// A person's picture, or the first letter of their name if there isn't one
// (or it doesn't load).
export function avatar(url, name, cls = '') {
  const badge = () => h(`span.badge-circle${cls ? `.${cls}` : ''}`, { 'aria-hidden': 'true' }, (String(name || '?').trim().charAt(0) || '?').toUpperCase());
  if (!url || !/^https:\/\//.test(url)) return badge();
  const img = h(`img.avatar${cls ? `.${cls}` : ''}`, { src: url, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
  img.addEventListener('error', () => img.replaceWith(badge()), { once: true });
  return img;
}

// ---------- settings rows ----------

// An on/off setting.
export function toggleRow({ title, subtitle, checked, onChange, disabled = false }) {
  const input = h('input.switch', { type: 'checkbox', role: 'switch', checked: checked && !disabled, disabled, onchange: (e) => onChange(e.target.checked) });
  return h(`label.row.toggle-row${disabled ? '.disabled' : ''}`, null, h('div.row-main', null, h('div.row-title', null, title), subtitle ? h('div.row-sub', null, subtitle) : null), input);
}

// A setting with a few choices: shows the current one, and a sheet to pick.
// options: [[value, label, description?]]
export function choiceRow({ title, subtitle, options, value, onChange }) {
  let current = value;
  const valueEl = h('span.row-value');
  const paint = () => (valueEl.textContent = (options.find(([v]) => v === current) || [null, ''])[1]);
  paint();
  const el = row({
    title,
    subtitle,
    right: valueEl,
    chevron: true,
    onClick: () =>
      sheet({
        title,
        actions: options.map(([v, label, description]) => ({
          label,
          description,
          checked: v === current,
          onSelect: () => {
            current = v;
            paint();
            onChange(v);
          },
        })),
      }),
  });
  el.classList.add('choice-row');
  return el;
}

export function iconTile(name) {
  return h('span.tile', null, icon(name, 20));
}

export function nowBars() {
  return h('span.bars', { 'aria-hidden': 'true' }, h('i'), h('i'), h('i'));
}

// ---------- states ----------

export function spinner(label = 'Loading') {
  return h('div.spinner', { role: 'status', 'aria-label': label }, h('span'));
}

export function emptyState(text, action) {
  return h('div.empty-state', null, h('p', null, text), action || null);
}

export function errorState(text, retry) {
  return h(
    'div.error-state',
    null,
    h('p', null, text),
    retry ? h('button.btn.btn-secondary', { type: 'button', onclick: retry }, 'Try again') : null,
  );
}

export function skeletonShelf(n = 4, wide = false) {
  return shelf(Array.from({ length: n }, () => h(wide ? 'div.wide-card.skeleton' : 'div.card.skeleton', null, h('div.card-art'))));
}

// ---------- files ----------

// Hands the browser a file to save.
export function download(text, name, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export const fileDate = () => new Date().toISOString().slice(0, 10);

// ---------- toasts ----------

let toastTimer;
export function toast(message, { action, onAction, timeout = 3500 } = {}) {
  const root = document.getElementById('toasts');
  const el = h(
    'div.toast',
    { role: 'status' },
    h('span', null, message),
    action ? h('button.toast-action', { type: 'button', onclick: () => { onAction?.(); el.remove(); } }, action) : null,
  );
  root.replaceChildren(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('out'), timeout);
  setTimeout(() => el.isConnected && el.classList.contains('out') && el.remove(), timeout + 400);
}

// ---------- bottom sheets ----------

// actions: [{ icon, label, description, onSelect, checked, danger, muted }]
// (falsy entries are skipped). variant 'dialog' shows a centred card with a
// Close button instead of a bottom sheet.
export function sheet({ title, subtitle, image, round, actions = [], content, variant = 'sheet', closeLabel = 'Close', onClose }) {
  const root = document.getElementById('overlay-root');
  let closed = false;
  const dialog = variant === 'dialog';
  const list = actions.filter(Boolean);
  const panel = h(
    `div.sheet-panel${dialog ? '.dialog-panel' : ''}`,
    { role: 'dialog', 'aria-modal': 'true', 'aria-label': title || 'Options' },
    dialog ? null : h('div.sheet-grip', { 'aria-hidden': 'true' }),
    title
      ? h(
          'div.sheet-head',
          null,
          image !== undefined ? art(image, { size: 56, round }) : null,
          h('div.sheet-head-text', null, h('div.sheet-title', null, title), subtitle ? h('div.sheet-sub', null, subtitle) : null),
        )
      : null,
    content || null,
    list.length
      ? h(
          'div.sheet-actions',
          null,
          list.map((a) =>
            // { heading }: a heading over the actions after it.
            a.heading ? h('div.sheet-heading', { role: 'presentation' }, a.heading) : h(
              `button.sheet-action${a.danger ? '.danger' : ''}${a.description ? '.has-desc' : ''}${a.muted ? '.muted' : ''}`,
              {
                type: 'button',
                'aria-pressed': a.checked === undefined ? null : String(!!a.checked),
                // `now`: run straight from the tap, before the sheet goes
                // (a file picker only opens from a tap).
                onclick: async () => {
                  if (a.now) {
                    a.onSelect?.();
                    popOverlay();
                    return;
                  }
                  await popOverlay();
                  a.onSelect?.();
                },
              },
              a.icon ? icon(a.icon, 24) : h('span.sheet-spacer'),
              h('span.sheet-action-text', null, h('span.sheet-action-label', null, a.label), a.description ? h('span.sheet-action-desc', null, a.description) : null),
              a.checked ? icon('check', 22, 'sheet-check') : null,
            ),
          ),
        )
      : null,
    dialog ? h('button.dialog-close', { type: 'button', onclick: () => popOverlay() }, closeLabel) : null,
  );
  const scrim = h(`div.sheet${dialog ? '.dialog' : ''}`, { onclick: (e) => e.target === scrim && popOverlay() }, panel);
  const close = () => {
    if (closed) return;
    closed = true;
    scrim.classList.remove('open');
    setTimeout(() => scrim.remove(), 250);
    document.removeEventListener('keydown', onKey);
    onClose?.();
  };
  const onKey = (e) => e.key === 'Escape' && popOverlay();
  document.addEventListener('keydown', onKey);
  root.append(scrim);
  requestAnimationFrame(() => {
    scrim.classList.add('open');
    panel.querySelector('button')?.focus({ preventScroll: true });
  });
  pushOverlay(close);
  return { close: () => popOverlay(), panel };
}

// A question with a text answer, in a dialog: resolves to the trimmed text,
// or null if it was cancelled.
// (`type`: 'password' for a PIN, say, and `inputMode` 'numeric'; `secret`:
// one that's never offered to the browser's, or a password manager's, keeping:
// the browser's own is told it's a code.)
export function askText({ title, label, value = '', confirm = 'Save', maxLength = 120, message = '', type = 'text', inputMode, secret = false }) {
  return new Promise((resolve) => {
    let answer = null;
    const input = h('input', {
      type,
      value,
      maxLength,
      autocomplete: secret ? 'one-time-code' : 'off',
      spellcheck: 'false',
      inputmode: inputMode || null,
      ...(secret ? { 'data-1p-ignore': true, 'data-lpignore': 'true', 'data-bwignore': true, 'data-form-type': 'other' } : {}),
    });
    const ok = h('button.btn.btn-primary', { type: 'submit' }, confirm);
    const form = h(
      'form.ask-form',
      {
        onsubmit: (e) => {
          e.preventDefault();
          const text = input.value.trim();
          if (!text) return input.focus();
          answer = text;
          popOverlay();
        },
      },
      message ? h('p.ask-message', null, message) : null,
      h('label.field', null, h('span', null, label), input),
      ok,
    );
    sheet({ title, content: form, variant: 'dialog', closeLabel: 'Cancel', onClose: () => resolve(answer) });
    setTimeout(() => {
      input.focus();
      input.select();
    }, 60);
  });
}

// "Are you sure?": resolves to true only if the confirm button was pressed.
export function confirmAction({ title, message, confirm, danger = true }) {
  return new Promise((resolve) => {
    let yes = false;
    const content = h(
      'div.ask-form',
      null,
      message ? h('p.ask-message', null, message) : null,
      h(
        `button.btn.${danger ? 'btn-danger' : 'btn-primary'}`,
        {
          type: 'button',
          onclick: () => {
            yes = true;
            popOverlay();
          },
        },
        confirm,
      ),
    );
    sheet({ title, content, variant: 'dialog', closeLabel: 'Cancel', onClose: () => resolve(yes) });
  });
}

// ---------- drag to reorder ----------

// Drag items of a list by their handle (.drag-handle) to reorder them, with
// mouse, touch or pen. Near the top or bottom of the screen the page
// scrolls, so an item can travel the whole list. Positions are page
// positions, so scrolling doesn't throw the item off the pointer.
// onDrop({ item, order }) runs when an item has moved: `order` is the
// items, in their new order.
export function enableDrag(list, { item: selector = '.drag-item', onDrop }) {
  const EDGE = 90; // px from the screen's edge where scrolling starts
  let drag = null;
  const items = () => [...list.children].filter((el) => el.matches(selector));

  function place() {
    const { item } = drag;
    const pageY = drag.clientY + window.scrollY;
    const rows = items();
    const i = rows.indexOf(item);
    const prev = rows[i - 1];
    const next = rows[i + 1];
    const dy = pageY - drag.y;
    if (prev && dy < -prev.offsetHeight / 2) {
      list.insertBefore(item, prev);
      drag.y -= prev.offsetHeight;
      drag.moved = true;
    } else if (next && dy > next.offsetHeight / 2) {
      list.insertBefore(next, item);
      drag.y += next.offsetHeight;
      drag.moved = true;
    }
    item.style.transform = `translateY(${pageY - drag.y}px)`;
  }

  function autoScroll() {
    if (!drag) return;
    const bottomEdge = window.innerHeight - (document.getElementById('tabs')?.offsetHeight || 0) - (document.getElementById('player-bar')?.offsetHeight || 0);
    const y = drag.clientY;
    const speed = y < EDGE ? -Math.ceil((EDGE - y) / 6) : y > bottomEdge - EDGE ? Math.ceil((y - (bottomEdge - EDGE)) / 6) : 0;
    if (speed) {
      const before = window.scrollY;
      window.scrollBy(0, Math.max(-24, Math.min(24, speed)));
      if (window.scrollY !== before) place();
    }
    drag.frame = requestAnimationFrame(autoScroll);
  }

  list.addEventListener('pointerdown', (e) => {
    const handle = e.target.closest('.drag-handle');
    if (!handle || e.button > 0 || !list.contains(handle)) return;
    const item = handle.closest(selector);
    if (!item || item.parentElement !== list) return;
    e.preventDefault();
    handle.setPointerCapture?.(e.pointerId);
    drag = { item, y: e.clientY + window.scrollY, clientY: e.clientY, moved: false, frame: 0 };
    item.classList.add('dragging');
    drag.frame = requestAnimationFrame(autoScroll);
  });
  list.addEventListener('pointermove', (e) => {
    if (!drag) return;
    drag.clientY = e.clientY;
    place();
  });
  const end = () => {
    if (!drag) return;
    const { item, moved, frame } = drag;
    cancelAnimationFrame(frame);
    drag = null;
    item.style.transform = '';
    item.classList.remove('dragging');
    if (moved) onDrop({ item, order: items() });
  };
  list.addEventListener('pointerup', end);
  list.addEventListener('pointercancel', end);
}

// ---------- infinite lists ----------

// Long lists keep artwork only near the screen: a picture further away gives
// up its image (its address is kept) and gets it back as it comes near, so
// scrolling through thousands of albums doesn't keep thousands of pictures
// in memory. Pages kept by the router give up theirs too (see router.js).
const NEAR = '1500px 0px';

function farAway(entries) {
  for (const e of entries) {
    const el = e.target;
    if (!el.isConnected) continue; // a page put aside: the router has its pictures
    if (e.isIntersecting) {
      for (const img of el.querySelectorAll('img[data-far-src]')) {
        img.setAttribute('src', img.dataset.farSrc);
        delete img.dataset.farSrc;
      }
    } else {
      for (const img of el.querySelectorAll('img[src]')) {
        img.dataset.farSrc = img.getAttribute('src');
        img.removeAttribute('src');
      }
    }
  }
}

// Fills `container` page by page as the user scrolls. fetchPage(start, size)
// must resolve to { items, total }. Pass the view's onDispose so the list
// stops watching the page once it's gone.
export function pagedList(container, { fetchPage, render, pageSize = 60, empty = 'Nothing here.', onTotal, onItems, onDispose }) {
  let start = 0;
  let total = Infinity;
  let loading = false;
  let done = false;
  const all = [];
  const sentinel = h('div.sentinel', null, spinner());
  const added = []; // what's put after the list besides the sentinel: an empty or error state
  container.after(sentinel);
  const hasIO = 'IntersectionObserver' in window;
  const near = hasIO ? new IntersectionObserver(farAway, { rootMargin: NEAR }) : null;

  async function load() {
    if (loading || done) return;
    loading = true;
    try {
      const { items, total: t } = await fetchPage(start, pageSize);
      if (destroyed) return;
      total = t || start + items.length;
      onTotal?.(total);
      items.forEach((item, i) => {
        all.push(item);
        const el = render(item, start + i, all);
        container.append(el);
        near?.observe(el);
      });
      onItems?.(all);
      start += items.length;
      if (!items.length || start >= total) finish();
    } catch (err) {
      finish();
      if (destroyed) throw err;
      const state = errorState(err?.network ? "Can't reach your server." : 'This list could not be loaded.', () => location.reload());
      added.push(state);
      container.after(state);
      throw err;
    } finally {
      loading = false;
    }
    // Keep going while the end of the list is on screen. Not on a page that
    // has been put aside, or for a list that's hidden (one a search box is
    // showing what matches in place of): everything not shown measures as on
    // screen, and the whole library would load into a list nobody can see.
    // (Shown again, it carries on as it comes into view.)
    if (!done && sentinel.getClientRects().length && sentinel.getBoundingClientRect().top < window.innerHeight + 600) load();
  }

  function finish() {
    done = true;
    more?.disconnect();
    sentinel.remove();
    if (!all.length && !destroyed) {
      const state = emptyState(empty);
      added.push(state);
      container.after(state);
    }
  }

  let destroyed = false;
  const more = hasIO ? new IntersectionObserver((es) => es[0].isIntersecting && load(), { rootMargin: '800px 0px' }) : null;
  more?.observe(sentinel);
  load().catch(() => {});
  const dispose = () => {
    done = true;
    more?.disconnect();
    near?.disconnect();
  };
  onDispose?.(dispose);
  return {
    items: all,
    load,
    dispose,
    // Stops, and takes away what it put after the list (to start it again).
    destroy() {
      destroyed = true;
      dispose();
      sentinel.remove();
      added.splice(0).forEach((el) => el.remove());
    },
    get done() {
      return done;
    },
  };
}

// ---------- small utils ----------

export function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// ---------- hints ----------

// A small bubble pointing at a control that's easy to miss (the lock on
// playlists). It shows a few times at most, and not again once the control
// has been used (learned(key)). A tap anywhere, scrolling, or the returned
// close() puts it away.
export function pointOut(anchor, text, { key, times = 4, delay = 700, duration = 7000 } = {}) {
  const seen = store.get('hints', {}) || {};
  if (seen[key] === 'done' || (Number(seen[key]) || 0) >= times) return () => {};
  let bubble = null;
  let timer = setTimeout(show, delay);
  function show() {
    const r = anchor.getBoundingClientRect();
    // Gone already (another page), or off screen.
    if (!anchor.isConnected || !r.width || r.bottom < 0 || r.top > innerHeight) return;
    const counts = store.get('hints', {}) || {};
    if (counts[key] === 'done') return;
    counts[key] = (Number(counts[key]) || 0) + 1;
    store.set('hints', counts);
    bubble = h('div.hint-bubble', { role: 'status' }, text);
    document.body.append(bubble);
    // Under the control, with its arrow pointing at it, and on screen.
    const w = bubble.offsetWidth;
    const mid = r.left + r.width / 2;
    const left = Math.max(12, Math.min(innerWidth - w - 12, mid - w + 30));
    bubble.style.left = `${left}px`;
    bubble.style.top = `${r.bottom + 10}px`;
    bubble.style.setProperty('--arrow', `${Math.max(14, Math.min(w - 14, mid - left))}px`);
    anchor.classList.add('hinted');
    requestAnimationFrame(() => bubble?.classList.add('shown'));
    timer = setTimeout(close, duration);
    addEventListener('pointerdown', close, { capture: true });
    addEventListener('scroll', close, { passive: true });
    addEventListener('keydown', close, { capture: true });
  }
  function close() {
    clearTimeout(timer);
    removeEventListener('pointerdown', close, { capture: true });
    removeEventListener('scroll', close);
    removeEventListener('keydown', close, { capture: true });
    anchor.classList.remove('hinted');
    const b = bubble;
    bubble = null;
    if (!b) return;
    b.classList.remove('shown');
    setTimeout(() => b.remove(), 250);
  }
  return close;
}

// The control a hint points at has been used: no more hints for it.
export function learned(key) {
  const counts = store.get('hints', {}) || {};
  if (counts[key] === 'done') return;
  counts[key] = 'done';
  store.set('hints', counts);
}

export function shuffleArray(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function clampText(text, lines = 4) {
  const p = h('p.clamp', { style: { WebkitLineClamp: String(lines) } }, text);
  const btn = h(
    'button.link-btn',
    {
      type: 'button',
      hidden: true,
      onclick: () => {
        p.classList.toggle('open');
        btn.textContent = p.classList.contains('open') ? 'Show less' : 'Show more';
      },
    },
    'Show more',
  );
  // Only offer "Show more" when the text is actually cut off.
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver(([e]) => {
      if (!e.isIntersecting) return;
      io.disconnect();
      btn.hidden = p.scrollHeight <= p.clientHeight + 2;
    });
    io.observe(p);
  } else {
    btn.hidden = false;
  }
  return h('div.clamp-wrap', null, p, btn);
}
