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
    el.append(emptyState('This player’s MusicBrainz features are off (MUSICBRAINZ_ADVANCED).'));
    return;
  }
  if (!(await isAdmin().catch(() => false))) {
    el.append(emptyState('This is for the server’s owner: changing albums in Plex is theirs to do.'));
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
    h('p.lede', null, `Your albums, looked up on ${mbWhere()}: those whose year in Plex isn’t the year they first came out (a remaster’s or reissue’s is often the reissue’s), and those without a genre that MusicBrainz has genres for. A fix changes the album in Plex, for everyone, locked so Plex’s next refresh leaves it.`),
    status,
    actions,
    years,
    genres,
    h('p.hint.pad', null, 'Plex never changes your files. To fix their tags too, download the list: it has each album’s MusicBrainz release group, to look up in MusicBrainz Picard, or for beets (beet import with --search-id, or beet mbsync for albums it has matched).'),
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

  // What MusicBrainz has of each (null: nothing; 'pending': being looked up).
  const found = albums.map(() => 'pending');
  const fixed = new Map(); // album id -> what was done: 'year' | 'genres' (and what it was before)
  async function ask(indexes) {
    for (let i = 0; i < indexes.length && !gone; i += ASK) {
      const part = indexes.slice(i, i + ASK);
      const got = await albumsOnMB(part.map((j) => ({ artist: albums[j].parentTitle, title: albums[j].title })), { genres: true });
      part.forEach((j, k) => (found[j] = got[k] ?? null));
    }
  }

  // What differs, as far as it's known.
  const yearRows = () =>
    albums
      .map((m, i) => ({ m, g: found[i] }))
      .filter(({ m, g }) => g && typeof g === 'object' && firstYear(g) && plexYear(m) && firstYear(g) !== plexYear(m) && fixed.get(String(m.ratingKey))?.kind !== 'year');
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

  async function undoYear(m) {
    const was = fixed.get(String(m.ratingKey));
    if (was?.kind !== 'year') return;
    try {
      await s.editAlbum(sec, m.ratingKey, { year: was.before.year, date: was.before.date || `${was.before.year}-01-01` });
      Object.assign(m, { year: was.before.year, originallyAvailableAt: was.before.date });
      fixed.delete(String(m.ratingKey));
    } catch (err) {
      toast(`Couldn’t put it back. ${describeError(err)}`);
    }
    render();
  }

  async function fixGenres({ m, g }, { quiet = false } = {}) {
    await s.editAlbum(sec, m.ratingKey, { genres: [...genresOf(m), ...g.genres] });
    fixed.set(String(m.ratingKey), { kind: 'genres', added: g.genres });
    m.Genre = [...(m.Genre || []), ...g.genres.map((tag) => ({ tag }))];
    if (!quiet) toast(`${m.title}: ${g.genres.join(', ')} in Plex now`, { action: 'Undo', timeout: 8000, onAction: () => undoGenres(m) });
  }

  async function undoGenres(m) {
    const was = fixed.get(String(m.ratingKey));
    if (was?.kind !== 'genres') return;
    try {
      await s.editAlbum(sec, m.ratingKey, { removeGenres: was.added });
      m.Genre = (m.Genre || []).filter((t) => !was.added.includes(t.tag));
      fixed.delete(String(m.ratingKey));
    } catch (err) {
      toast(`Couldn’t put it back. ${describeError(err)}`);
    }
    render();
  }

  // All of them, one after another.
  async function fixAll(list, fix, what) {
    const sure = await confirmAction({
      title: `Fix ${fmt.count(list.length, 'album', 'albums')} in Plex?`,
      message: `Each album’s ${what} is changed in Plex, for everyone, and locked so Plex’s next refresh leaves it (Plex’s Unlock and Refresh Metadata on an album puts back what Plex had).`,
      confirm: 'Fix them',
      danger: false,
    });
    if (!sure) return;
    let done = 0;
    let failed = 0;
    for (const x of list) {
      if (gone) return;
      try {
        await fix(x, { quiet: true });
        done += 1;
      } catch {
        failed += 1;
      }
      status.replaceChildren(`Fixing in Plex… ${fmt.number(done + failed)} of ${fmt.number(list.length)}`);
      if ((done + failed) % 20 === 0) render();
    }
    toast(`${fmt.count(done, 'album', 'albums')} fixed in Plex${failed ? `, ${fmt.number(failed)} couldn’t be` : ''}`);
    render();
  }

  const yearLine = ({ m, g }) => `${m.parentTitle} · ${plexYear(m)} in Plex, ${firstYear(g)} on MusicBrainz`;
  const genreLine = ({ m, g }) => `${m.parentTitle} · ${g.genres.join(', ')}`;
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
              sectionHeader(`Years (${fmt.number(ys.length)})`, null, h('button.link-btn.mb-fix-years', { type: 'button', onclick: () => fixAll(ys, fixYear, 'year') }, 'Fix all')),
              h(
                'div.rows.mb-review-rows',
                null,
                ys.slice(0, 300).map((x) => row({ title: x.m.title, subtitle: yearLine(x), right: fixButton(`Use ${firstYear(x.g)}`, () => fixYear(x)), cls: 'mb-year-row' })),
              ),
              ys.length > 300 ? h('p.hint.pad', null, `and ${fmt.number(ys.length - 300)} more (Fix all fixes them all; the download has them all)`) : null,
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
              sectionHeader(`Genres (${fmt.number(gs.length)})`, null, h('button.link-btn.mb-fix-genres', { type: 'button', onclick: () => fixAll(gs, fixGenres, 'genres') }, 'Add all')),
              h(
                'div.rows.mb-review-rows',
                null,
                gs.slice(0, 300).map((x) => row({ title: x.m.title, subtitle: genreLine(x), right: fixButton('Add', () => fixGenres(x)), cls: 'mb-genre-row' })),
              ),
              gs.length > 300 ? h('p.hint.pad', null, `and ${fmt.number(gs.length - 300)} more (Add all adds them all; the download has them all)`) : null,
            ),
          ]
        : !pending && !ys.length
          ? [emptyState('Nothing to fix: your albums’ years and genres are as MusicBrainz has them (or MusicBrainz hasn’t any).')]
          : []),
    );
  }

  try {
    await ask(albums.map((_, i) => i));
  } catch (err) {
    status.replaceChildren(`MusicBrainz couldn’t be asked. ${describeError(err)}`);
    status.classList.add('warn');
    return;
  }
  render();
  // Those still being looked up, asked about again now and then (the first
  // in line first: the player looks them up in order).
  const again = async () => {
    timer = null;
    if (gone) return;
    const waiting = found.map((g, i) => (g === 'pending' ? i : -1)).filter((i) => i >= 0);
    if (!waiting.length) return;
    try {
      await ask(waiting.slice(0, AGAIN_AT_MOST));
    } catch {
      /* tried again next time */
    }
    render();
    if (!gone && found.includes('pending')) timer = setTimeout(again, AGAIN_MS);
  };
  if (found.includes('pending')) timer = setTimeout(again, AGAIN_MS);
}
