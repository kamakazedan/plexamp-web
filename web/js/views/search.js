import { app, searchScope } from '../state.js';
import { normTrack, isLossless, audioQuality } from '../plex.js';
import { replaceQuery, keepState } from '../router.js';
import { h, art, icon, pageHeader, backHeader, sectionHeader, row, iconTile, iconButton, spinner, emptyState, debounce, fmt } from '../ui.js';
import { artistRow, albumRow, playlistRow, trackRow, numberedList } from '../components.js';
import { playList, shuffleLibrary, sonicPath } from '../actions.js';
import { aiReady, aiEvents, norm } from '../ai.js';
import { libraryTiles } from './library.js';

// Recent searches were kept until 0.9.1; what was stored goes.
try {
  Object.keys(localStorage)
    .filter((k) => k.startsWith('pw.recentSearches.'))
    .forEach((k) => localStorage.removeItem(k));
} catch {
  /* storage unavailable */
}

// Words kept as tags narrow a search: everything shown matches all of them
// (in its name, its artist, its album or its year).
const fold = (v) =>
  String(v ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
const FIELDS = {
  artist: (m) => [m.title],
  album: (m) => [m.title, m.parentTitle, m.year],
  track: (m) => [m.title, m.grandparentTitle, m.originalTitle, m.parentTitle, m.parentYear, m.year],
  playlist: (m) => [m.title],
};
const matchesAll = (kind, m, terms) => {
  const text = ` ${FIELDS[kind](m).map(fold).join(' ')} `;
  return terms.every((t) => text.includes(fold(t)));
};
const SEP = '|';

// What's searched for is kept with the page (for Back, and a reload), not
// in its address: searches stay out of the browser's history. (An address
// with ?q= in it, from before 0.16.0, still opens that search.)
export async function searchView({ el, query, saved, key, onDispose }) {
  const kept = saved?.search || query;
  const words = String(kept.words || '')
    .split(SEP)
    .map((w) => w.trim())
    .filter(Boolean)
    .slice(0, 6);
  const input = h('input', {
    type: 'search',
    placeholder: 'Artists, albums, tracks',
    'aria-label': 'Search your library',
    autocomplete: 'off',
    enterkeyhint: 'search',
    value: kept.q || '',
  });
  // Keeps what's typed as a tag, to add more words (Enter does too).
  const keep = iconButton('plus', 'Keep this word, and add more', () => keepWord(), { size: 22, cls: 'search-keep' });
  // Clears the search in one tap, back to browsing (Escape too).
  const clear = iconButton('close', 'Clear search', () => clearSearch(), { size: 22, cls: 'search-clear' });
  const tags = h('div.chips.filter-chips.search-tags', { role: 'list', 'aria-label': 'Search words' });
  const box = h('label.search-box.has-clear', null, icon('search', 22), input, keep, clear);
  const body = h('div.search-body');
  el.append(pageHeader('Search'), tags, box, body);

  // The AI playlist row, only while AI can be used here.
  let aiRow = null;
  const paintAI = () => aiRow && (aiRow.hidden = !aiReady());
  aiEvents.addEventListener('change', paintAI);
  onDispose?.(() => aiEvents.removeEventListener('change', paintAI));

  const paintBox = () => {
    keep.hidden = !input.value.trim() || words.length >= 6;
    clear.hidden = !input.value && !words.length;
    input.placeholder = words.length ? 'Add another word' : 'Artists, albums, tracks';
    tags.hidden = !words.length;
    tags.replaceChildren(
      ...words.map((w, i) =>
        h(
          'button.chip.filter-chip',
          { type: 'button', role: 'listitem', 'aria-label': `Remove “${w}”`, onclick: () => (words.splice(i, 1), update()) },
          h('span', null, w),
          icon('close', 16),
        ),
      ),
    );
  };
  const keepWord = () => {
    const w = input.value.trim();
    if (!w || words.length >= 6) return;
    if (!words.some((x) => fold(x) === fold(w))) words.push(w);
    input.value = '';
    update();
    input.focus();
  };
  const clearSearch = () => {
    words.length = 0;
    input.value = '';
    update();
    input.focus();
  };
  const update = () => {
    paintBox();
    run();
  };

  // A tag's search is kept while the tag is there; what's being typed is
  // looked up afresh (and given up when the next letter comes).
  const found = new Map();
  const lookup = (term, signal) => {
    if (signal) return app.server.search(term, searchScope(), { signal, limit: 40 });
    const key = fold(term);
    if (!found.has(key)) {
      found.set(
        key,
        app.server.search(term, searchScope(), { limit: 40 }).catch((err) => {
          found.delete(key);
          throw err;
        }),
      );
    }
    return found.get(key);
  };

  let controller = null;
  const run = async () => {
    controller?.abort();
    const text = input.value.trim();
    const terms = [...words, text].filter(Boolean);
    // (Only while this page is the one on screen: a search that ran late,
    // after a result was tapped, mustn't change the page it opened.)
    if (el.isConnected) {
      keepState(input.value || words.length ? { search: { q: input.value, words: words.join(SEP) } } : null, key);
      if (location.hash.startsWith('#/search?')) replaceQuery('/search');
    }
    if (!terms.length) {
      found.clear();
      body.replaceChildren(browseContent((r) => (aiRow = r)));
      paintAI();
      return;
    }
    controller = new AbortController();
    const mine = controller;
    body.replaceChildren(spinner('Searching'));
    try {
      let res;
      if (terms.length === 1) {
        res = await app.server.search(terms[0], searchScope(), { signal: mine.signal, limit: 12 });
      } else {
        // Each word looked up, and only what matches every word kept.
        const typed = fold(text);
        const lists = await Promise.all(
          [...new Set(terms.map(fold))].filter(Boolean).map((t) => lookup(terms.find((x) => fold(x) === t), t === typed && !words.some((w) => fold(w) === t) ? mine.signal : null)),
        );
        res = {};
        for (const kind of Object.keys(FIELDS)) {
          const seen = new Set();
          res[kind] = lists
            .flatMap((l) => l[kind] || [])
            .filter((m) => !seen.has(m.ratingKey) && seen.add(m.ratingKey) && matchesAll(kind, m, terms));
        }
      }
      if (mine.signal.aborted) return;
      // Looking for an artist: their popular tracks come first.
      const artist = artistSearched(res.artist, terms);
      let popular = [];
      if (artist) {
        const section = artist.librarySectionID ?? app.source.sectionKey;
        popular = await app.server.popularTracks(section, artist.ratingKey, 10).catch(() => []);
        if (mine.signal.aborted) return;
        popular = popular.filter((m) => matchesAll('track', m, terms.filter((t) => fold(t) !== fold(artist.title))));
      }
      const shown = await oneOfEach(res, popular);
      if (mine.signal.aborted) return;
      body.replaceChildren(results(shown, terms));
    } catch (err) {
      if (!err.aborted && !mine.signal.aborted) body.replaceChildren(emptyState("Search didn't work. Check your connection and try again."));
    }
  };
  input.addEventListener('input', () => paintBox());
  input.addEventListener('input', debounce(() => run(), 280));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (input.value.trim()) keepWord();
      else input.blur();
    }
    if (e.key === 'Backspace' && !input.value && words.length) {
      e.preventDefault();
      words.pop();
      update();
    }
    if (e.key === 'Escape' && (input.value || words.length)) {
      e.preventDefault();
      e.stopPropagation();
      clearSearch();
    }
  });
  paintBox();
  await run();
}

// The artist a search is for, if it's one: the top artist found, when the
// words name them ("groove armada", "prodigy" for The Prodigy), rather than
// just turning up in their name.
function artistSearched(artists, terms) {
  const top = artists?.[0];
  if (!top) return null;
  const name = norm(top.title);
  return terms.some((t) => {
    const asked = norm(t);
    return asked && (asked === name || (asked.length >= 4 && name.startsWith(asked) && asked.length >= name.length * 0.6));
  })
    ? top
    : null;
}

// ---------- one of each ----------

// Search turns up every copy: an album and its hi-res edition, a song on
// its album and on a best-of. Shown is one of each recording (the same
// title by the same artist, no more than a few seconds longer or shorter:
// a radio edit stays), and one of each album (the same title, artist and
// year), the best-sounding copy, where the first one was.
const SAME_LENGTH = 5000; // ms

function oneTrackEach(tracks, popular = new Set()) {
  const groups = [];
  const byName = new Map();
  for (const t of tracks) {
    const name = `${norm(t.artist)}|${fold(t.title)}`;
    const same = (byName.get(name) || []).find((g) => !g.length || !t.duration || Math.abs(g.length - t.duration) <= SAME_LENGTH);
    if (same) {
      same.popular ||= popular.has(t.id);
      if (audioQuality(t) > audioQuality(same.track)) same.track = t;
      continue;
    }
    const g = { track: t, length: t.duration || 0, popular: popular.has(t.id) };
    groups.push(g);
    byName.set(name, [...(byName.get(name) || []), g]);
  }
  return groups;
}

async function oneAlbumEach(albums, known) {
  const groups = new Map();
  for (const a of albums) {
    const name = `${norm(a.parentTitle)}|${fold(a.title)}|${a.year || ''}`;
    groups.set(name, [...(groups.get(name) || []), a]);
  }
  // How each copy sounds: from its tracks found, or else asked (only for
  // albums with another copy).
  const quality = new Map();
  await Promise.all(
    [...groups.values()]
      .filter((g) => g.length > 1)
      .flat()
      .map(async (a) => quality.set(String(a.ratingKey), known.get(String(a.ratingKey)) ?? (await app.server.albumQuality(a.ratingKey).catch(() => 0)))),
  );
  return [...groups.values()].map((g) => g.reduce((best, a) => ((quality.get(String(a.ratingKey)) || 0) > (quality.get(String(best.ratingKey)) || 0) ? a : best)));
}

// The search's results, one of each: tracks as [{ track, popular }]
// (an artist's popular ones first), albums as Plex gave them.
async function oneOfEach(res, popular = []) {
  const seen = new Set();
  const found = [...popular, ...res.track].filter((m) => !seen.has(String(m.ratingKey)) && seen.add(String(m.ratingKey))).map(normTrack);
  const top = new Set(popular.map((m) => String(m.ratingKey)));
  const known = new Map();
  for (const t of found) if (t.albumId) known.set(t.albumId, Math.max(known.get(t.albumId) || 0, audioQuality(t)));
  return { ...res, tracks: oneTrackEach(found, top).slice(0, 40), album: await oneAlbumEach(res.album, known) };
}

// A track's format, before its artist: "FLAC 24/96" (once its streams have
// been asked about: one request for them all), "MP3 320".
const kHz = (hz) => (hz / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 });
function formatBadge(t) {
  if (app.settings.searchCodecs === false || !t.codec) return null;
  return h('span.track-codec', null, !isLossless(t.codec) && t.bitrate ? `${fmt.codec(t.codec)} ${Math.round(t.bitrate)}` : fmt.codec(t.codec));
}

async function fillFormats(rows) {
  const lossless = rows.filter(({ t, badge }) => badge && isLossless(t.codec));
  if (!lossless.length) return;
  const details = await app.server.tracksDetail(lossless.map(({ t }) => t.id)).catch(() => []);
  lossless.forEach(({ t, badge }, i) => {
    const a = (details[i]?.Media?.[0]?.Part?.[0]?.Stream || []).find((x) => x.streamType === 2);
    if (!a?.bitDepth || !a.samplingRate) return;
    badge.textContent = `${fmt.codec(t.codec)} ${a.bitDepth}/${kHz(a.samplingRate)}`;
    if (a.bitDepth > 16 || a.samplingRate > 48000) {
      badge.classList.add('hires');
      badge.title = 'High resolution';
    }
  });
}

function results(res, terms) {
  const frag = h('div');
  const add = (title, items, render) => {
    if (!items.length) return;
    frag.append(h('section.block', null, sectionHeader(title), h('div.rows', null, items.map(render))));
  };
  const asked = terms.map((t) => `“${t}”`).join(' and ');
  add('Artists', res.artist.slice(0, 6), (m) => artistRow(m));
  // Tracks before albums: an artist's popular ones first (with the
  // "popular" badge, unless that's turned off), then the rest.
  if (res.tracks.length) {
    const tracks = res.tracks.map((g) => g.track);
    const list = h('div.tracks');
    const rows = res.tracks.map(({ track: t, popular }, i) => {
      const badge = formatBadge(t);
      list.append(
        trackRow(t, {
          showArt: true,
          subtitle: [t.artist, t.album].filter(Boolean).join(' — '),
          popular: popular && app.settings.popularTracks !== false,
          badge,
          onPlay: () => playList(tracks, i, { title: `Search: ${terms.join(' ')}`, href: null }),
        }),
      );
      return { t, badge };
    });
    fillFormats(rows);
    frag.append(h('section.block.search-tracks', null, sectionHeader('Tracks'), list));
  }
  add('Albums', res.album.slice(0, 8), (m) => albumRow(m));
  add('Playlists', res.playlist.slice(0, 6), (m) => playlistRow(m));
  if (!frag.children.length) frag.append(emptyState(`Nothing in ${searchScope() ? app.source.sectionTitle : 'your libraries'} matches ${asked}.`));
  return frag;
}

function browseContent(setAiRow) {
  const frag = h('div');
  const aiRow = row({
    href: '/ai-playlist',
    lead: h('span.tile.tile-plain', null, icon('sparkle', 26)),
    title: 'AI playlist',
    subtitle: 'Describe a playlist and your AI model builds it',
  });
  setAiRow(aiRow);
  frag.append(
    h('section.block.browse-block', null, sectionHeader('Library'), libraryTiles()),
    h(
      'section.block',
      null,
      sectionHeader('Most played'),
      h(
        'div.rows',
        null,
        row({ href: '/top/artists', lead: iconTile('mic'), title: 'Top artists' }),
        row({ href: '/top/albums', lead: iconTile('disc'), title: 'Top albums' }),
        row({ href: '/top/tracks', lead: iconTile('note'), title: 'Top tracks' }),
      ),
    ),
    h(
      'section.block',
      null,
      sectionHeader('Explore'),
      h(
        'div.rows',
        null,
        aiRow,
        row({ href: '/sonic-path', lead: h('span.tile.tile-plain', null, icon('path', 26)), title: 'Sonic path', subtitle: 'A smooth journey from one track to another' }),
        row({ onClick: () => shuffleLibrary(), lead: h('span.tile.tile-plain', null, icon('shuffle', 26)), title: 'Shuffle library', subtitle: `Random tracks from ${app.source.sectionTitle}`, chevron: true }),
      ),
    ),
  );
  return frag;
}

// ---------- Top artists / albums / tracks ----------

const TOP = {
  artists: { type: 8, title: 'Top artists' },
  albums: { type: 9, title: 'Top albums' },
  tracks: { type: 10, title: 'Top tracks' },
};

export async function topView({ el, params }) {
  const cfg = TOP[params.kind];
  if (!cfg) throw new Error('Unknown list.');
  el.append(backHeader(cfg.title, { fallback: '/search' }));
  const size = [10, 25, 50, 100].includes(Number(app.settings.topListSize)) ? Number(app.settings.topListSize) : 25;
  const { items } = await app.server.list(app.source.sectionKey, cfg.type, { sort: 'viewCount:desc', size });
  const played = items.filter((m) => m.viewCount);
  if (!played.length) {
    el.append(emptyState('Nothing played yet. Play counts build up as you listen.'));
    return;
  }
  if (cfg.type === 10) {
    const tracks = played.map(normTrack);
    const list = numberedList({ total: tracks.length, album: true });
    tracks.forEach((t, i) =>
      list.append(
        trackRow(t, {
          showArt: true,
          position: true,
          album: true,
          subtitle: t.artist,
          plays: played[i].viewCount,
          onPlay: () => playList(tracks, i, { title: 'Top tracks', href: '/top/tracks' }),
        }),
      ),
    );
    el.append(list);
    return;
  }
  const list = h('div.rows');
  played.forEach((m, i) =>
    list.append(
      row({
        href: cfg.type === 8 ? `/artist/${m.ratingKey}` : `/album/${m.ratingKey}`,
        lead: h('span.rank', null, String(i + 1)),
        image: undefined,
        title: m.title,
        subtitle: [cfg.type === 9 ? m.parentTitle : null, fmt.count(m.viewCount, 'play', 'plays')].filter(Boolean).join(', '),
        right: art(m.thumb, { size: 56, round: cfg.type === 8, fallback: cfg.type === 8 ? 'mic' : 'disc' }),
        chevron: false,
        cls: 'row-ranked',
      }),
    ),
  );
  el.append(list);
}

// ---------- Sonic path ----------

export async function sonicPathView({ el }) {
  el.append(
    backHeader('Sonic path', { fallback: '/search' }),
    h('p.lede', null, 'Pick a starting track and a destination. Plex fills the gap with tracks that move gradually from one sound to the other.'),
  );
  const chosen = { from: null, to: null };
  const go = h('button.btn.btn-primary', { type: 'button', disabled: true, onclick: () => sonicPath(chosen.from, chosen.to) }, icon('play', 20), h('span', null, 'Play path'));
  const update = () => (go.disabled = !(chosen.from && chosen.to));
  el.append(
    trackPicker('From', (t) => ((chosen.from = t), update())),
    trackPicker('To', (t) => ((chosen.to = t), update())),
    h('div.pad.path-go', null, go),
  );
}

function trackPicker(label, onChange) {
  const input = h('input', { type: 'search', placeholder: 'Search for a track', autocomplete: 'off', 'aria-label': `${label} track` });
  const results = h('div.picker-results');
  const selected = h('div.picker-selected');
  const wrap = h('section.picker', null, h('div.picker-label', null, label), selected, h('label.search-box', null, icon('search', 20), input), results);
  let controller;
  const choose = (t) => {
    onChange(t);
    results.replaceChildren();
    input.value = '';
    input.closest('.search-box').hidden = true;
    selected.replaceChildren(
      row({
        image: t.thumb,
        title: t.title,
        subtitle: t.artist,
        right: iconButton('close', `Change ${label.toLowerCase()} track`, () => {
          onChange(null);
          selected.replaceChildren();
          input.closest('.search-box').hidden = false;
          input.focus();
        }),
        chevron: false,
      }),
    );
  };
  input.addEventListener(
    'input',
    debounce(async () => {
      controller?.abort();
      const q = input.value.trim();
      if (!q) return results.replaceChildren();
      controller = new AbortController();
      const mine = controller;
      try {
        const res = await app.server.search(q, app.source.sectionKey, { signal: mine.signal, limit: 8 });
        if (mine.signal.aborted) return;
        const tracks = res.track.map(normTrack);
        results.replaceChildren(
          ...(tracks.length
            ? tracks.map((t) => row({ onClick: () => choose(t), image: t.thumb, title: t.title, subtitle: t.artist, chevron: false }))
            : [h('p.picker-empty', null, 'No tracks match.')]),
        );
      } catch (err) {
        if (!err.aborted) results.replaceChildren(h('p.picker-empty', null, "Search didn't work."));
      }
    }, 280),
  );
  return wrap;
}
