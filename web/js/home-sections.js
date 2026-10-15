// Home screen sections and their layout. Each library has its own layout
// (order, which are shown, and options such as a time period), edited in
// Settings › Experience › Home screen.
import { app, saveSettings, homeKey } from './state.js';

export const PERIODS = {
  week: { label: 'the past week', filter: '-7d' },
  month: { label: 'the past month', filter: '-30d' },
  quarter: { label: 'the past three months', filter: '-90d' },
  year: { label: 'the past year', filter: '-365d' },
  all: { label: 'all time', filter: null },
};

export const GAPS = {
  quarter: { label: 'three months', filter: '-90d' },
  half: { label: 'six months', filter: '-180d' },
  year: { label: 'a year', filter: '-365d' },
  twoyears: { label: 'two years', filter: '-730d' },
};

const decade = (y) => ({
  id: `decade${y}`,
  title: `Best of the ${String(y).slice(2)}s`,
  description: `Your most played albums from the ${y}s.`,
  on: false,
  decade: y,
});

// on: shown unless the person hides it. periods: options for "… (period)".
export const SECTIONS = [
  { id: 'mixes', title: 'Mixes for you', description: 'Radio mixes built around artists you’ve played lately.', on: true },
  { id: 'recentPlays', title: 'Recent plays', description: 'Albums and playlists you played last.', on: true },
  { id: 'recentPlaylists', title: 'Recent playlists', description: 'Playlists you played or changed lately.', on: true },
  { id: 'collections', title: 'Collections', description: 'Music collections from your Plex server.', on: true },
  { id: 'moreInGenre', title: 'More in … (genre)', description: 'Albums in the genre of something you played lately.', on: false },
  decade(1970),
  decade(1980),
  decade(1990),
  decade(2000),
  decade(2010),
  decade(2020),
  { id: 'recentlyAdded', title: 'Recently added', description: 'The newest albums in this library.', on: true },
  { id: 'topAlbums', title: 'Top albums from … (period)', description: 'Your most played albums over a period.', on: false, periods: PERIODS, period: 'month' },
  { id: 'stations', title: 'Stations', description: 'Radio from the whole library: library radio, deep cuts, time travel and a random album.', on: true },
  { id: 'mostPlayed', title: 'Most played in … (period)', description: 'Your most played tracks over a period.', on: false, periods: PERIODS, period: 'month' },
  { id: 'moreFromLabel', title: 'More from … (record label)', description: 'Albums from the label of something you played lately.', on: false },
  { id: 'history', title: 'History', description: 'Tracks you played last.', on: false },
  { id: 'notPlayed', title: 'Haven’t played in … (period)', description: 'Albums you used to play but haven’t for a while.', on: false, periods: GAPS, period: 'half' },
];

export const sectionById = (id) => SECTIONS.find((s) => s.id === id);

// { order: [ids], hidden: Set, options: { id: { period } } }
export function homeLayout(key = homeKey()) {
  const saved = app.settings.home?.[key] || {};
  const known = new Set(SECTIONS.map((s) => s.id));
  const order = (Array.isArray(saved.order) ? saved.order : []).filter((id) => known.has(id));
  for (const s of SECTIONS) if (!order.includes(s.id)) order.push(s.id);
  // Sections added in later versions (not in `seen`) start as their default.
  const seen = new Set(Array.isArray(saved.seen) ? saved.seen : []);
  const hidden = new Set((Array.isArray(saved.hidden) ? saved.hidden : []).filter((id) => known.has(id)));
  for (const s of SECTIONS) if (!seen.has(s.id) && !s.on) hidden.add(s.id);
  const options = {};
  for (const s of SECTIONS) {
    const o = saved.options?.[s.id] || {};
    if (s.periods) options[s.id] = { period: s.periods[o.period] ? o.period : s.period };
  }
  return { order, hidden, options };
}

export function saveHomeLayout(layout, key = homeKey()) {
  const home = { ...(app.settings.home || {}) };
  home[key] = { order: layout.order, hidden: [...layout.hidden], options: layout.options, seen: SECTIONS.map((s) => s.id) };
  saveSettings({ home });
}

export function resetHomeLayout(key = homeKey()) {
  const home = { ...(app.settings.home || {}) };
  delete home[key];
  saveSettings({ home });
}
