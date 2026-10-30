// Settings › MusicBrainz › Years and genres to fix, for the server's owner:
// the library's albums looked up on MusicBrainz (by the player, in the
// background: on musicbrainz.org, once a second, so a big library takes a
// while, and the player carries on with it if this page is left), then
// those whose year in Plex isn't the year they first came out (a remaster's
// or reissue's, say), and those without a genre that MusicBrainz has
// genres for. Each is fixed in Plex, one at a time or all at once, locked so
// Plex's next refresh leaves it (with Undo); Plex never writes to the files,
// so the list downloads too, with each album's MusicBrainz release group,
// for MusicBrainz Picard or beets to fix them.
import { app } from '../state.js';
import { describeError } from '../router.js';
import { h, icon, backHeader, row, sectionHeader, emptyState, toast, fmt, confirmAction, download, fileDate, spinner } from '../ui.js';
import { albumsOnMB, firstYear, mbFeatures } from '../mb.js';
import { mbWhere, toCsv } from '../missing.js';
import { isAdmin } from '../editing.js';
import { norm } from '../missinglist.js';

const PAGE = 500; // albums read from Plex at a time
const ASK = 200; // ...and asked about at a time
const AGAIN_MS = 5000; // how often what's still being looked up is asked about again
const AGAIN_AT_MOST = 400; // ...those first in line, at most, each time

const genresOf = (m) => (Array.isArray(m.Genre) ? m.Genre.map((t) => t?.tag).filter(Boolean) : []);
const plexYear = (m) => Number(m.year) || Number(String(m.originallyAvailableAt || '').slice(0, 4)) || null;
const mbLink = (g) => `https://musicbrainz.org/release-group/${g.id}`;

export async function mbReviewView({ el, onDispose }) {
  el.append(backHeader('Years and genres to fix', { fallback: '/settings/musicbrainz' }));
  if (!mbFeatures()) {
    el.append(emptyState('MusicBrainz features are turned off on this player.'));
    return;
  }
  if (!(await isAdmin().catch(() => false))) {
    el.append(emptyState('Only the server’s owner can change albums in Plex.'));
    return;
  }
  const s = app.server;
  const sec = app.source.sectionKey;
  let gone = false;
  let timer = null;
  onDispose?.(() => {
    gone = true;
    clearTimeout(timer);
  });

  const status = h('p.hint.pad.mb-review-status', { role: 'status' }, spinner('Reading'), h('span', null, ` Reading your albums from ${app.source.sectionTitle}…`));
  const actions = h('div.pad.button-row.mb-review-actions');
  const years = h('div.mb-review-years');
  const genres = h('div.mb-review-genres');
  el.append(
    h('p.lede', null, `Albums whose year in Plex isn’t when they first came out (often a reissue’s year), and albums with no genre, checked on ${mbWhere()}. A fix changes the album in Plex for everyone, and Plex keeps it.`),
    status,
    actions,
    years,
    genres,
    h('p.hint.pad', null, 'Plex never changes your files. To fix their tags too, download the list and use MusicBrainz Picard or beets: it has each album’s MusicBrainz ID.'),
  );

  // Every album in the library: what Plex has of it.
  const albums = [];
  try {
    for (let start = 0; !gone; start += PAGE) {
      const { items, total } = await s.list(sec, 9, { start, size: PAGE, sort: 'artist.titleSort' });
      albums.push(...items.filter((m) => m.type === 'album' && m.title && m.parentTitle));
      status.lastChild.textContent = ` Reading your albums from ${app.source.sectionTitle}… ${fmt.number(albums.length)} of ${fmt.number(total)}`;
      if (!items.length || start + PAGE >= total) break;
    }
  } catch (err) {
    status.replaceChildren(`Your albums couldn’t be read. ${describeError(err)}`);
    status.classList.add('warn');
    return;
  }
  if (gone) return;
  if (!albums.length) {
    status.replaceChildren('There are no albums in this library.');
    return;
  }

  // The library's genres, by name as norm has it: a genre MusicBrainz has
  // goes on as the library has it ("Hip-Hop", not a "Hip Hop" beside it).
  const libraryGenres = new Map(
    (await s.tags(sec, 'genre', 9).catch(() => []))
      .map((t) => t?.title)
      .filter(Boolean)
      .map((t) => [norm(t), t]),
  );
  const asLibrary = (genre) => libraryGenres.get(norm(genre)) || genre;

  // What MusicBrainz has of each (null: nothing, or which album it is can't
  // be told; 'pending': being looked up), by its artist, its title and the
  // year Plex has (which tells albums of one title apart), with its genres
  // for those without any.
  const found = albums.map(() => 'pending');
  const fixed = new Map(); // album id -> what was done: 'year' | 'genres' (and what it was before)
  async function ask(indexes) {
    for (const withGenres of [true, false]) {
      const these = indexes.filter((j) => !genresOf(albums[j]).length === withGenres);
      for (let i = 0; i < these.length && !gone; i += ASK) {
        const part = these.slice(i, i + ASK);
        const got = await albumsOnMB(part.map((j) => ({ artist: albums[j].parentTitle, title: albums[j].title, year: plexYear(albums[j]) })), { genres: withGenres, background: true });
        part.forEach((j, k) => (found[j] = got[k] ?? null));
      }
    }
  }

  // What differs, as far as it's known. (A first year later than Plex's is
  // shown, but not fixed with the rest: an album can't come out after it
  // did, so it's more likely another album of that title than Plex's year
  // that's wrong.)
  const yearRows = () =>
    albums
      .map((m, i) => ({ m, g: found[i] }))
      .filter(({ m, g }) => g && typeof g === 'object' && firstYear(g) && plexYear(m) && firstYear(g) !== plexYear(m) && fixed.get(String(m.ratingKey))?.kind !== 'year');
  const later = ({ m, g }) => firstYear(g) > plexYear(m);
  const genreRows = () =>
    albums
      .map((m, i) => ({ m, g: found[i] }))
      .filter(({ m, g }) => g && typeof g === 'object' && g.genres?.length && !genresOf(m).length && fixed.get(String(m.ratingKey))?.kind !== 'genres');

  async function fixYear({ m, g }, { quiet = false } = {}) {
    const year = firstYear(g);
    const date = /^\d{4}-\d{2}-\d{2}$/.test(g.date) ? g.date : `${year}-01-01`;
    const before = { year: plexYear(m), date: String(m.originallyAvailableAt || '').slice(0, 10) };
    await s.editAlbum(sec, m.ratingKey, { year, date });
    fixed.set(String(m.ratingKey), { kind: 'year', before });
    Object.assign(m, { year, originallyAvailableAt: date });
    if (!quiet) toast(`${m.title}: ${year} in Plex now`, { action: 'Undo', timeout: 8000, onAction: () => undoYear(m) });
  }

  // (As it was, unlocked again, so Plex's next refresh has it as Plex has
  // it; a day it hadn't, left out again.)
  async function undoYear(m, { quiet = false } = {}) {
    const was = fixed.get(String(m.ratingKey));
    if (was?.kind !== 'year') return;
    try {
      await s.editAlbum(sec, m.ratingKey, { year: was.before.year, date: was.before.date, unlock: true });
      Object.assign(m, { year: was.before.year, originallyAvailableAt: was.before.date });
      fixed.delete(String(m.ratingKey));
    } catch (err) {
      if (quiet) throw err;
      toast(`Couldn’t put it back. ${describeError(err)}`);
    }
    if (!quiet) render();
  }

  async function fixGenres({ m, g }, { quiet = false } = {}) {
    const adding = [...new Set(g.genres.map(asLibrary))];
    await s.editAlbum(sec, m.ratingKey, { genres: [...genresOf(m), ...adding] });
    fixed.set(String(m.ratingKey), { kind: 'genres', added: adding });
    m.Genre = [...(m.Genre || []), ...adding.map((tag) => ({ tag }))];
    if (!quiet) toast(`${m.title}: ${adding.join(', ')} in Plex now`, { action: 'Undo', timeout: 8000, onAction: () => undoGenres(m) });
  }

  async function undoGenres(m, { quiet = false } = {}) {
    const was = fixed.get(String(m.ratingKey));
    if (was?.kind !== 'genres') return;
    try {
      await s.editAlbum(sec, m.ratingKey, { removeGenres: was.added, unlock: true });
      m.Genre = (m.Genre || []).filter((t) => !was.added.includes(t.tag));
      fixed.delete(String(m.ratingKey));
    } catch (err) {
      if (quiet) throw err;
      toast(`Couldn’t put it back. ${describeError(err)}`);
    }
    if (!quiet) render();
  }

  // All of them, one after another (and Undo, all of those: in a toast, and
  // on the page until it's used). Carried on with if the page is left.
  let lastAll = null; // { list, undo }: the last Fix all or Add all's
  async function fixAll(list, fix, undo, what) {
    const sure = await confirmAction({
      title: `Fix ${fmt.count(list.length, 'album', 'albums')} in Plex?`,
      message: `Changes each album’s ${what} in Plex, for everyone. Undo, straight after, puts them back.`,
      confirm: 'Fix them',
      danger: false,
    });
    if (!sure) return;
    const done = [];
    lastAll = null;
    let failed = 0;
    for (const x of list) {
      try {
        await fix(x, { quiet: true });
        done.push(x.m);
      } catch {
        failed += 1;
      }
      status.replaceChildren(`Fixing in Plex… ${fmt.number(done.length + failed)} of ${fmt.number(list.length)}`);
      if ((done.length + failed) % 20 === 0) render();
    }
    lastAll = { list: done, undo };
    render();
    toast(`${fmt.count(done.length, 'album', 'albums')} fixed in Plex${failed ? `, ${fmt.number(failed)} couldn’t be` : ''}`, {
      action: done.length ? 'Undo' : null,
      timeout: 15000,
      onAction: () => undoAll(),
    });
  }

  async function undoAll() {
    const was = lastAll;
    lastAll = null;
    if (!was?.list.length) return;
    const { list, undo } = was;
    let back = 0;
    let failed = 0;
    for (const m of list) {
      try {
        await undo(m, { quiet: true });
        back += 1;
      } catch {
        failed += 1;
      }
      status.replaceChildren(`Putting them back in Plex… ${fmt.number(back + failed)} of ${fmt.number(list.length)}`);
    }
    toast(`${fmt.count(back, 'album', 'albums')} as they were in Plex${failed ? `, ${fmt.number(failed)} couldn’t be` : ''}`);
    render();
  }

  const yearLine = (x) => `${x.m.parentTitle} · ${plexYear(x.m)} in Plex, ${firstYear(x.g)} on MusicBrainz${later(x) ? ' (later: is it the same album?)' : ''}`;
  const genreLine = ({ m, g }) => `${m.parentTitle} · ${[...new Set(g.genres.map(asLibrary))].join(', ')}`;
  const fixButton = (label, onClick) =>
    h(
      'button.btn.btn-secondary.btn-small',
      {
        type: 'button',
        onclick: async (e) => {
          e.currentTarget.disabled = true;
          try {
            await onClick();
          } catch (err) {
            toast(`Couldn’t change it in Plex. ${describeError(err)}`);
          }
          render();
        },
      },
      label,
    );

  function render() {
    if (gone) return;
    const pending = found.filter((g) => g === 'pending').length;
    const ys = yearRows();
    const gs = genreRows();
    status.classList.remove('warn');
    status.replaceChildren(
      ...(pending
        ? [spinner('Looking'), h('span', null, ` Looked up ${fmt.number(albums.length - pending)} of ${fmt.number(albums.length)} albums on ${mbWhere()}…`)]
        : [`Looked up all ${fmt.count(albums.length, 'album', 'albums')}: ${fmt.count(found.filter((g) => g && typeof g === 'object').length, 'is', 'are')} on MusicBrainz.`]),
    );
    actions.replaceChildren(
      ...(lastAll?.list.length
        ? [
            h(
              'button.btn.btn-secondary.mb-undo-all',
              { type: 'button', onclick: () => undoAll() },
              icon('refresh', 20),
              h('span', null, `Undo the last ${fmt.count(lastAll.list.length, 'fix', 'fixes')}`),
            ),
          ]
        : []),
      ...(ys.length || gs.length
        ? [
            h(
              'button.btn.btn-secondary',
              {
                type: 'button',
                onclick: () => {
                  const head = ['Artist', 'Album', 'Year in Plex', 'First year on MusicBrainz', 'Genres in Plex', 'Genres on MusicBrainz', 'MusicBrainz release group', 'Link'];
                  const all = albums.map((m, i) => ({ m, g: found[i] })).filter(({ g }) => g && typeof g === 'object');
                  const rows = all
                    .filter(({ m, g }) => (firstYear(g) && plexYear(m) && firstYear(g) !== plexYear(m)) || (g.genres?.length && !genresOf(m).length))
                    .map(({ m, g }) => [m.parentTitle, m.title, plexYear(m) || '', firstYear(g) || '', genresOf(m).join('; '), (g.genres || []).join('; '), g.id, mbLink(g)]);
                  download(toCsv(head, rows), `musicbrainz-fixes-${fileDate()}.csv`, 'text/csv;charset=utf-8');
                  toast('Downloaded, to open in a spreadsheet');
                },
              },
              icon('arrowDown', 20),
              h('span', null, 'Download (CSV)'),
            ),
          ]
        : []),
    );
    years.replaceChildren(
      ...(ys.length
        ? [
            h(
              'section.block',
              null,
              sectionHeader(
                `Years (${fmt.number(ys.length)})`,
                null,
                ys.some((x) => !later(x)) ? h('button.link-btn.mb-fix-years', { type: 'button', onclick: () => fixAll(ys.filter((x) => !later(x)), fixYear, undoYear, 'year') }, 'Fix all') : null,
              ),
              h(
                'div.rows.mb-review-rows',
                null,
                ys.slice(0, 300).map((x) => row({ title: x.m.title, subtitle: yearLine(x), right: fixButton(`Use ${firstYear(x.g)}`, () => fixYear(x)), cls: `mb-year-row${later(x) ? '.mb-later' : ''}` })),
              ),
              ys.length > 300 ? h('p.hint.pad', null, `And ${fmt.number(ys.length - 300)} more. Fix all fixes them too (but not those with a later year), and the download has them all.`) : null,
            ),
          ]
        : []),
    );
    genres.replaceChildren(
      ...(gs.length
        ? [
            h(
              'section.block',
              null,
              sectionHeader(`Genres (${fmt.number(gs.length)})`, null, h('button.link-btn.mb-fix-genres', { type: 'button', onclick: () => fixAll(gs, fixGenres, undoGenres, 'genres') }, 'Add all')),
              h(
                'div.rows.mb-review-rows',
                null,
                gs.slice(0, 300).map((x) => row({ title: x.m.title, subtitle: genreLine(x), right: fixButton('Add', () => fixGenres(x)), cls: 'mb-genre-row' })),
              ),
              gs.length > 300 ? h('p.hint.pad', null, `And ${fmt.number(gs.length - 300)} more. Add all adds them too, and the download has them all.`) : null,
            ),
          ]
        : !pending && !ys.length
          ? [emptyState('Nothing to fix: years and genres match MusicBrainz.')]
          : []),
    );
  }

  // (Asked about again below where this couldn't: MusicBrainz not
  // answering for a while, or too many asked too quickly.)
  // (After MusicBrainz didn't answer, or was busy: asked again only after as
  // long as the player says, so it isn't asked again and again meanwhile.)
  const waitAfter = (err) => Math.max(AGAIN_MS, (Number(err?.retryAfter) || 0) * 1000, err ? 30000 : 0);
  let trouble = null;
  try {
    await ask(albums.map((_, i) => i));
  } catch (err) {
    trouble = err;
  }
  render();
  const inTime = (ms) => {
    const s = Math.round(ms / 1000);
    return s < 90 ? `in ${fmt.count(s, 'second', 'seconds')}` : `in ${fmt.count(Math.round(s / 60), 'minute', 'minutes')}`;
  };
  // (This page carries on by itself, so not "Try again…".)
  const say = (err) => {
    if (!err) return;
    const said = String(err.message || describeError(err));
    const what = said.replace(/\s*[^.]*\btry again\b[^.]*\.\s*$/i, '') || said;
    status.replaceChildren(`${what} Carrying on ${inTime(waitAfter(err))}.`);
    status.classList.add('warn');
  };
  say(trouble);
  // Those still being looked up, asked about again now and then (the first
  // in line first: the player looks them up in order).
  const again = async () => {
    timer = null;
    if (gone) return;
    const waiting = found.map((g, i) => (g === 'pending' ? i : -1)).filter((i) => i >= 0);
    if (!waiting.length) return;
    let err = null;
    try {
      await ask(waiting.slice(0, AGAIN_AT_MOST));
    } catch (e) {
      err = e;
    }
    render();
    say(err);
    if (!gone && found.includes('pending')) timer = setTimeout(again, waitAfter(err));
  };
  if (found.includes('pending')) timer = setTimeout(again, waitAfter(trouble));
}
