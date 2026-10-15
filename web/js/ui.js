// DOM helpers, icons, formatting and the shared building blocks every view
// uses (headers, shelves, cards, rows, sheets, toasts, infinite lists).
import { app } from './state.js';
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
  palette: S('<path d="M12 3.5a8.5 8.5 0 1 0 0 17c1.2 0 1.8-.9 1.4-2l-.3-.8c-.4-1.1.4-2.2 1.6-2.2h1.8a4 4 0 0 0 4-4c0-4.4-3.8-8-8.5-8z"/><circle cx="7.8" cy="11.5" r="1" fill="currentColor"/><circle cx="10.5" cy="7.6" r="1" fill="currentColor"/><circle cx="15" cy="8" r="1" fill="currentColor"/>'),
  speaker: S('<path d="M4 9.5h3.2L12 5.5v13l-4.8-4H4z"/><path d="M15.5 9a4.2 4.2 0 0 1 0 6M18 6.5a7.8 7.8 0 0 1 0 11"/>'),
  speakerOff: S('<path d="M4 9.5h3.2L12 5.5v13l-4.8-4H4z"/><path d="m16 9.5 5 5M21 9.5l-5 5"/>'),
  terminal: S('<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="m7 9.5 3 2.5-3 2.5M12.5 15H17"/>'),
  info: S('<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.6v.2"/>'),
  signOut: S('<path d="M14.5 4.5h3a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-3M10 16.5 5.5 12 10 7.5M5.5 12H15"/>'),
  check: S('<path d="M5 12.5 9.5 17 19 7.5"/>'),
  playNext: S('<path d="M4 6.5h11M4 11.5h11M4 16.5h6"/><path d="M14.5 14.2v6l4.8-3z" fill="currentColor"/>'),
  addQueue: S('<path d="M4 6.5h12M4 11.5h12M4 16.5h7M17.5 14v6M14.5 17h6"/>'),
  sort: S('<path d="M4 7h16M7 12h10M10 17h4"/>'),
  expand: S('<path d="M14 4h6v6M10 20H4v-6M20 4l-6.5 6.5M4 20l6.5-6.5"/>'),
  server: S('<rect x="4" y="4" width="16" height="7" rx="1.8"/><rect x="4" y="13" width="16" height="7" rx="1.8"/><path d="M8 7.5h.01M8 16.5h.01"/>'),
  external: S('<path d="M14 5h5v5M19 5l-8 8M17 14v4a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h4"/>'),
  refresh: S('<path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6"/>'),
  trend: S('<path d="M4 17l5-5 3.5 3.5L20 8M15 8h5v5"/>'),
  star: S('<path d="M12 3.8l2.45 5.05 5.55.75-4.05 3.85 1 5.5L12 16.3l-4.95 2.65 1-5.5L4 9.6l5.55-.75z"/>'),
  moon: S('<path d="M19.5 14.3A7.8 7.8 0 0 1 9.7 4.5a7.8 7.8 0 1 0 9.8 9.8z"/>'),
  dj: S('<rect x="3" y="5" width="18" height="14" rx="3"/><circle cx="10" cy="12" r="4"/><circle cx="10" cy="12" r="0.9" fill="currentColor"/><path d="M17 8.2v5.3l-2.2 2.1"/>'),
  sparkle: S('<path d="M12 3.5l1.7 4.9 4.8 1.7-4.8 1.7L12 16.7l-1.7-4.9L5.5 10.1l4.8-1.7zM18.5 15l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/>'),
  live: S('<path d="M8.5 8.5a5 5 0 0 0 0 7M15.5 8.5a5 5 0 0 1 0 7M5.6 5.6a9 9 0 0 0 0 12.8M18.4 5.6a9 9 0 0 1 0 12.8"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/>'),
  together: S('<circle cx="9" cy="8.6" r="3.2"/><path d="M3.4 19.2a5.6 5.6 0 0 1 11.2 0"/><circle cx="16.9" cy="9.4" r="2.6"/><path d="M15.4 14.3a4.6 4.6 0 0 1 5.2 4.9"/>'),
  thumbUp: S('<path d="M7.5 10.6v9h-3v-9zM7.5 10.6l3.7-6.3c1-.4 2.1.3 2 1.4l-.6 3.9h5.3a2 2 0 0 1 2 2.4l-1.3 6.1a2 2 0 0 1-2 1.5H7.5"/>'),
  thumbDown: `<g transform="rotate(180 12 12)">${S('<path d="M7.5 10.6v9h-3v-9zM7.5 10.6l3.7-6.3c1-.4 2.1.3 2 1.4l-.6 3.9h5.3a2 2 0 0 1 2 2.4l-1.3 6.1a2 2 0 0 1-2 1.5H7.5"/>')}</g>`,
  starHalf: `${F('<path d="M12 3.8 9.55 8.85 4 9.6l4.05 3.85-1 5.5L12 16.3z"/>')}${S('<path d="M12 3.8l2.45 5.05 5.55.75-4.05 3.85 1 5.5L12 16.3l-4.95 2.65 1-5.5L4 9.6l5.55-.75z"/>')}`,
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

function artPixels(css) {
  const n = css * Math.min(window.devicePixelRatio || 1, 2);
  return [100, 160, 240, 320, 480, 640, 960].find((s) => s >= n) || 960;
}

export function artUrl(path, css = 160) {
  return path && app.server ? app.server.art(path, artPixels(css)) : '';
}

export function art(path, { size = 160, round = false, cls = '', fallback = 'note', alt = '' } = {}) {
  const wrap = h(`div.art${round ? '.round' : ''}${cls ? `.${cls}` : ''}`);
  const missing = () => {
    wrap.classList.add('missing');
    wrap.replaceChildren(icon(fallback, Math.max(18, Math.min(44, Math.round(size / 3.4)))));
  };
  const src = artUrl(path, size);
  if (!src) {
    missing();
    return wrap;
  }
  const img = h('img', { alt, loading: 'lazy', decoding: 'async', draggable: 'false', src });
  img.addEventListener('error', missing, { once: true });
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

export function sectionHeader(title, href, extra) {
  // Non-breaking hyphens keep names like "Hi-Res" together when a heading wraps.
  const kids = [h('h2', null, String(title).replace(/-/g, '‑')), extra || null, href ? icon('chevronRight', 26, 'chev') : null];
  return href ? h('a.section-head', { href: `#${href}` }, kids) : h('div.section-head', null, kids);
}

// ---------- cards, shelves, grids ----------

export function card({ href, image, title, subtitle, round = false, fallback = 'disc', onPlay, size = 200 }) {
  const a = h(
    `a.card${round ? '.card-round' : ''}`,
    { href: `#${href}` },
    h('div.card-art', null, art(image, { size, round, fallback, alt: '' }), onPlay ? playOverlay(onPlay, title) : null),
    h('div.card-title', null, title),
    subtitle ? h('div.card-sub', null, subtitle) : null,
  );
  return a;
}

function playOverlay(onPlay, title) {
  return h(
    'button.card-play',
    {
      type: 'button',
      'aria-label': `Play ${title}`,
      onclick: (e) => {
        e.preventDefault();
        e.stopPropagation();
        onPlay();
      },
    },
    icon('play', 22),
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
export function toggleRow({ title, subtitle, checked, onChange }) {
  const input = h('input.switch', { type: 'checkbox', role: 'switch', checked, onchange: (e) => onChange(e.target.checked) });
  return h('label.row.toggle-row', null, h('div.row-main', null, h('div.row-title', null, title), subtitle ? h('div.row-sub', null, subtitle) : null), input);
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
            h(
              `button.sheet-action${a.danger ? '.danger' : ''}${a.description ? '.has-desc' : ''}${a.muted ? '.muted' : ''}`,
              {
                type: 'button',
                'aria-pressed': a.checked === undefined ? null : String(!!a.checked),
                onclick: async () => {
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

// ---------- infinite lists ----------

// Fills `container` page by page as the user scrolls. fetchPage(start, size)
// must resolve to { items, total }.
export function pagedList(container, { fetchPage, render, pageSize = 60, empty = 'Nothing here.', onTotal, onItems }) {
  let start = 0;
  let total = Infinity;
  let loading = false;
  let done = false;
  const all = [];
  const sentinel = h('div.sentinel', null, spinner());
  container.after(sentinel);

  async function load() {
    if (loading || done) return;
    loading = true;
    try {
      const { items, total: t } = await fetchPage(start, pageSize);
      total = t || start + items.length;
      onTotal?.(total);
      items.forEach((item, i) => {
        all.push(item);
        container.append(render(item, start + i, all));
      });
      onItems?.(all);
      start += items.length;
      if (!items.length || start >= total) finish();
    } catch (err) {
      finish();
      container.after(
        errorState(err?.network ? "Can't reach your server." : 'This list could not be loaded.', () => location.reload()),
      );
      throw err;
    } finally {
      loading = false;
    }
    // Keep going if the sentinel is still on screen.
    if (!done && sentinel.getBoundingClientRect().top < window.innerHeight + 600) load();
  }

  function finish() {
    done = true;
    io?.disconnect();
    sentinel.remove();
    if (!all.length) container.after(emptyState(empty));
  }

  const io = 'IntersectionObserver' in window ? new IntersectionObserver((es) => es[0].isIntersecting && load(), { rootMargin: '800px 0px' }) : null;
  io?.observe(sentinel);
  load().catch(() => {});
  return { items: all, load };
}

// ---------- small utils ----------

export function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
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
