// Settings › MusicBrainz › Years and genres to fix, for the server's owner:
// the library's albums looked up on MusicBrainz (by the player, in the
// background: on musicbrainz.org, once a second, so a big library takes a
// while; on a MusicBrainz of the player's own, several at a time), each the
// very album or none at all, then those whose year in Plex is after the
// year they first came out (a remaster's or reissue's, say), and those
// without a genre that MusicBrainz has genres for. Each is fixed in Plex,
// one at a time or all at once, locked so Plex's next refresh leaves it
// (with Undo); Plex never writes to the files, so the list downloads too,
// with each album's MusicBrainz release group, for MusicBrainz Picard or
// beets to fix them.
// The look through the library carries on while the app's open, whatever
// page is on screen (an album or artist from the list looked at, say), and
// the player keeps each album's answer for a month, so a look through it
// another time picks up where this one got to.
import { app, on } from '../state.js';
import { describeError } from '../router.js';
import { h, icon, backHeader, row, emptyState, toast, fmt, confirmAction, download, fileDate, spinner } from '../ui.js';
import { albumsOnMB, albumTracks, firstYear, mbFeatures, mbOwnServer, mbidOf, notThatRecording, kindsAgree, plexKind } from '../mb.js';
import { mbWhere, toCsv } from '../missing.js';
import { isAdmin } from '../editing.js';
import { norm } from '../missinglist.js';

const PAGE = 1000; // albums (and artists) read from Plex at a time
const ASK = 1000; // ...and asked about at a time
const AGAIN_MS = 5000; // how often what's still being looked up is asked about again
const AGAIN_SOON_MS = 3000; // ...or, where most were answered at once (a library looked through before), this soon
const AGAIN_AT_MOST = 1000; // ...those first in line, at most, each time
const SHOWN = 300; // of each list, on the page (Fix all, Add all and the download take in the rest)

const genresOf = (m) => (Array.isArray(m.Genre) ? m.Genre.map((t) => t?.tag).filter(Boolean) : []);
const plexYear = (m) => Number(m.year) || Number(String(m.originallyAvailableAt || '').slice(0, 4)) || null;
const mbLink = (g) => `https://musicbrainz.org/release-group/${g.id}`;

// The library being looked through: one at a time, kept while the app's
// open (see the header); let go when another server or library is chosen
// (signing out, or switching user, loads the app afresh).
let scan = null;
const pages = new Set(); // the copies of the page open (kept in a tab's history too): each told of a new look
const scanKey = () => (app.server && app.source ? `${app.source.serverId || app.source.uri}|${app.source.sectionKey}|${app.server.token}` : null);
on('source', (change) => {
  if (!scan) return;
  const src = change?.source;
  if (src && src.serverId === scan.serverId && src.sectionKey === scan.sec && app.server) scan.s = app.server;
  else stopScan();
});
on('signout', () => stopScan());
function stopScan() {
  scan?.stop();
  scan = null;
}
// A new look, for `key`: every copy of the page goes with it.
function newScan(key) {
  stopScan();
  scan = startScan(key);
  for (const page of pages) page(scan);
  return scan;
}

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
  const key = scanKey();
  if (!key) return;
  // (One whose albums couldn't be read is started again.)
  let sc = scan?.key !== key || scan.phase === 'failed' ? newScan(key) : scan;

  const status = h('p.hint.pad.mb-review-status', { role: 'status' });
  // (While it's looking: what that means for the lists, and for leaving.)
  const growing = h('p.hint.pad.mb-review-growing', null, 'The lists below grow as albums are checked. Fix all and Add all appear once it’s done.');
  const leave = h('p.hint.pad.mb-review-leave', null, 'It keeps going while the app’s open. Close it, and it picks up from here next time.');
  const actions = h('div.pad.button-row.mb-review-actions');
  const years = h('div.mb-review-years');
  const genres = h('div.mb-review-genres');
  el.append(
    h('p.lede', null, 'Find albums with the wrong year or no genre, and fix them in Plex for everyone.'),
    status,
    growing,
    leave,
    actions,
    years,
    genres,
    h('p.hint.pad', null, 'Your files aren’t changed. To fix their tags too, download the list for MusicBrainz Picard or beets.'),
  );

  // What's shown, as it was last painted: each part is painted again only
  // when what it shows has changed (it's asked again every few seconds
  // while albums are looked up, for hours on musicbrainz.org), so what has
  // focus keeps it, and the page stays where it's scrolled to. (Fix all and
  // Add all take the lists as they are when they're used.)
  const painted = { status: '', actions: '', years: '', genres: '' };
  const changedPart = (part, shape) => {
    const now = JSON.stringify(shape);
    if (painted[part] === now) return false;
    painted[part] = now;
    return true;
  };

  // An album's title, and its artist's name, to open their pages from.
  const albumLink = (m) => h('a.mb-review-link', { href: `#/album/${encodeURIComponent(m.ratingKey)}` }, m.title);
  const artistLink = (m) => (m.parentRatingKey ? h('a.mb-review-link', { href: `#/artist/${encodeURIComponent(m.parentRatingKey)}` }, m.parentTitle) : m.parentTitle);
  const yearLine = (x) => `${plexYear(x.m)} in Plex, ${firstYear(x.g)} on MusicBrainz`;
  const genreLine = ({ g }) => [...new Set(g.genres.map(sc.asLibrary))].join(', ');
  const fixButton = (label, onClick) =>
    h(
      'button.btn.btn-secondary.btn-small',
      {
        type: 'button',
        disabled: !!sc.fixing,
        onclick: async (e) => {
          const button = e.currentTarget;
          if (sc.fixing) return;
          button.disabled = true;
          try {
            await onClick();
          } catch (err) {
            toast(`Couldn’t change it in Plex. ${describeError(err)}`);
            button.disabled = false;
          }
          sc.changed();
        },
      },
      label,
    );

  function renderStatus() {
    const st = sc.statusNow();
    if (!changedPart('status', st)) return;
    status.classList.toggle('warn', !!st.warn);
    status.replaceChildren(...(st.busy ? [spinner(st.busy), h('span', null, ` ${st.text}`)] : [st.text]));
    growing.hidden = sc.phase !== 'checking' || !st.going;
    leave.hidden = !st.going;
  }

  // A list's heading: how many there are to fix, with a spinner while that
  // can change (still looking, or a Fix all, Add all or Undo being made of
  // it), and what's to be done to all of them.
  const listHeader = (name, count, { changing, action }) =>
    h(
      'div.section-head.mb-review-head',
      null,
      h('h2', null, `${name} (`, h('span.mb-review-count', null, fmt.number(count)), ')', changing ? spinner(changing) : null),
      action || null,
    );

  // (`part`: 'counts', where only those change, as a Fix all, Add all or
  // Undo goes: each list's is painted at once, the rest every so often.)
  function render(part) {
    renderStatus();
    const { pending, ys, gs, nothing } = sc.lists();
    if (part === 'counts') {
      years.querySelector('.mb-review-count')?.replaceChildren(fmt.number(ys.length));
      genres.querySelector('.mb-review-count')?.replaceChildren(fmt.number(gs.length));
      return;
    }
    const yearsShown = ys.slice(0, SHOWN).map((x) => [x.m.ratingKey, x.m.title, x.m.parentTitle, yearLine(x)]);
    const genresShown = gs.slice(0, SHOWN).map((x) => [x.m.ratingKey, x.m.title, x.m.parentTitle, genreLine(x)]);
    const over = sc.finished();
    const making = sc.fixing; // { kind: 'year' | 'genres', back }: a Fix all, Add all or (back) Undo being made
    const undoing = !!making?.back;
    if (changedPart('actions', [sc.lastAll?.list.length || 0, !!(ys.length || gs.length), over, !!making, undoing])) {
      actions.replaceChildren(
        ...(over ? [h('button.btn.btn-secondary.mb-review-again', { type: 'button', onclick: () => lookAgain() }, icon('refresh', 20), h('span', null, 'Look again'))] : []),
        ...(sc.lastAll?.list.length || undoing
          ? [
              h(
                'button.btn.btn-secondary.mb-undo-all',
                { type: 'button', disabled: !!making, onclick: () => sc.undoAll() },
                icon('refresh', 20),
                h('span', null, undoing ? 'Putting them back…' : `Undo the last ${fmt.count(sc.lastAll.list.length, 'fix', 'fixes')}`),
              ),
            ]
          : []),
        ...(ys.length || gs.length
          ? [h('button.btn.btn-secondary', { type: 'button', onclick: () => sc.downloadList() }, icon('arrowDown', 20), h('span', null, 'Download (CSV)'))]
          : []),
      );
    }
    // (Fix all and Add all once it's done looking: till then, the lists
    // grow, and there'd be more to come after.)
    const looking = sc.phase === 'checking' && pending > 0;
    const allButton = (kind, cls, label, doing) =>
      looking ? null : h(`button.link-btn.${cls}`, { type: 'button', disabled: !!making, onclick: () => sc.fixAll(kind) }, making?.kind === kind && !making.back ? doing : label);
    const changing = (kind) => (making?.kind === kind ? (making.back ? 'Putting them back' : 'Fixing') : looking ? 'Still looking' : null);
    if (changedPart('years', [ys.length, yearsShown, !!making, making?.kind, undoing, looking])) {
      years.replaceChildren(
        ...(ys.length || making?.kind === 'year'
          ? [
              h(
                'section.block',
                null,
                listHeader('Years', ys.length, { changing: changing('year'), action: allButton('year', 'mb-fix-years', 'Fix all', 'Fixing…') }),
                h(
                  'div.rows.mb-review-rows',
                  null,
                  ys.slice(0, SHOWN).map((x) => row({ title: albumLink(x.m), subtitle: [artistLink(x.m), ` · ${yearLine(x)}`], right: fixButton(`Use ${firstYear(x.g)}`, () => sc.fixYear(x)), cls: 'mb-year-row' })),
                ),
                ys.length > SHOWN ? h('p.hint.pad', null, `And ${fmt.number(ys.length - SHOWN)} more: ${looking ? 'the download includes them' : 'Fix all and the download include them'}.`) : null,
              ),
            ]
          : []),
      );
    }
    if (changedPart('genres', [gs.length, genresShown, nothing, !!making, making?.kind, undoing, looking])) {
      genres.replaceChildren(
        ...(gs.length || making?.kind === 'genres'
          ? [
              h(
                'section.block',
                null,
                listHeader('Genres', gs.length, { changing: changing('genres'), action: allButton('genres', 'mb-fix-genres', 'Add all', 'Adding…') }),
                h(
                  'div.rows.mb-review-rows',
                  null,
                  gs.slice(0, SHOWN).map((x) => row({ title: albumLink(x.m), subtitle: [artistLink(x.m), ` · ${genreLine(x)}`], right: fixButton('Add', () => sc.fixGenres(x)), cls: 'mb-genre-row' })),
                ),
                gs.length > SHOWN ? h('p.hint.pad', null, `And ${fmt.number(gs.length - SHOWN)} more: ${looking ? 'the download includes them' : 'Add all and the download include them'}.`) : null,
              ),
            ]
          : nothing
            ? [emptyState('Nothing to fix.')]
            : []),
      );
    }
  }

  // Looked through again from the start (the library as it is now: albums
  // added since, say), the answers the player kept coming back at once.
  // (Not while a Fix all, Add all or Undo is being made.)
  let unlisten = null;
  function lookAgain() {
    if (!sc.fixing) newScan(key);
  }
  function attach(next) {
    if (next.key !== key) return;
    unlisten?.();
    sc = next;
    for (const part of Object.keys(painted)) painted[part] = '';
    unlisten = sc.listen(render);
    render();
  }
  attach(sc);
  pages.add(attach);
  onDispose(() => {
    pages.delete(attach);
    unlisten?.();
  });
}

// A look through the library (see the header): reading its albums and
// their artists from Plex, then looking each up, as long as there are any
// still being looked up (asked about again every few seconds: the player
// looks them up in the background), and the fixes made from it, with
// their Undo. `changed()` tells the page (whichever is open) to paint it.
function startScan(key) {
  const sc = {
    key,
    s: app.server,
    serverId: app.source.serverId,
    sec: app.source.sectionKey,
    sectionTitle: app.source.sectionTitle,
    check: mbOwnServer(), // (by their very tracks too: see mb.js albumsOnMB, `check`)
    phase: 'albums', // 'albums' | 'artists' | 'checking' | 'failed' (their albums couldn't be read)
    read: 0, // ...of the albums or the artists, so far
    total: 0,
    albums: [],
    artistIds: new Map(),
    libraryGenres: new Map(),
    found: [], // for each album: what MusicBrainz has of it (see ask)
    fixed: new Map(), // album id -> what was done: { kind: 'year' | 'genres', before | added }
    lastAll: null, // { list, undo }: the last Fix all or Add all's
    fixing: null, // { kind: 'year' | 'genres', back }: a Fix all, Add all or (back) Undo being made
    catchingUp: false, // most of those asked about for the first time were answered at once (looked through before: see again)
    asked: null, // for each album: asked about yet (see again)
    trouble: null, // what went wrong asking last (see say)
    failed: null, // why the albums couldn't be read
    stopped: false,
    timer: null,
    listeners: new Set(),
  };
  sc.listen = (fn) => {
    sc.listeners.add(fn);
    return () => sc.listeners.delete(fn);
  };
  sc.changed = (part) => {
    if (!sc.stopped) for (const fn of sc.listeners) fn(part);
  };
  sc.stop = () => {
    sc.stopped = true;
    clearTimeout(sc.timer);
    sc.listeners.clear();
  };
  // A genre MusicBrainz has goes on as the library has it ("Hip-Hop", not
  // a "Hip Hop" beside it).
  sc.asLibrary = (genre) => sc.libraryGenres.get(norm(genre)) || genre;

  // What would be fixed: a first year before the one Plex has (never after:
  // an album can't come out after it did, so that's another album of that
  // title), or genres for an album without any.
  const earlier = (m, g) => !!(firstYear(g) && plexYear(m) && firstYear(g) < plexYear(m));
  const differs = (m, g) => earlier(m, g) || !!(g.genres?.length && !genresOf(m).length);
  const known = (g) => g && typeof g === 'object';

  // What differs, as far as it's known.
  const yearRows = () => sc.albums.map((m, i) => ({ m, g: sc.found[i] })).filter(({ m, g }) => known(g) && earlier(m, g) && sc.fixed.get(String(m.ratingKey))?.kind !== 'year');
  const genreRows = () =>
    sc.albums.map((m, i) => ({ m, g: sc.found[i] })).filter(({ m, g }) => known(g) && g.genres?.length && !genresOf(m).length && sc.fixed.get(String(m.ratingKey))?.kind !== 'genres');
  // Done: looked through to the end (or their albums couldn't be read).
  sc.finished = () => sc.phase === 'failed' || (sc.phase === 'checking' && !sc.fixing && !sc.found.includes('pending'));
  sc.lists = () => {
    const pending = sc.phase === 'checking' ? sc.found.filter((g) => g === 'pending').length : sc.albums.length || 1;
    const ys = yearRows();
    return { pending, ys, gs: genreRows(), nothing: !pending && !ys.length && sc.found.some(known) };
  };

  // What the status line says: { text, busy (a spinner's label), warn,
  // going (still looking, so the page can be left) }.
  // (A Fix all, Add all or Undo says how it's going in its list's heading:
  // this is the look through the library's.)
  sc.statusNow = () => {
    if (sc.phase === 'failed') return { text: `Your albums couldn’t be read. ${sc.failed}`, warn: true };
    if (sc.phase === 'albums') return { busy: 'Reading', text: `Reading your albums from ${sc.sectionTitle}…${sc.total ? ` ${fmt.number(sc.read)} of ${fmt.number(sc.total)}` : ''}`, going: true };
    if (sc.phase === 'artists') return { busy: 'Reading', text: `Reading their artists…${sc.total ? ` ${fmt.number(sc.read)} of ${fmt.number(sc.total)}` : ''}`, going: true };
    if (!sc.albums.length) return { text: 'There are no albums in this library.' };
    const pending = sc.found.filter((g) => g === 'pending').length;
    if (pending && sc.trouble) return { text: sc.trouble, warn: true, going: true };
    const sofar = `${fmt.number(sc.albums.length - pending)} of ${fmt.number(sc.albums.length)} albums`;
    if (pending && sc.catchingUp) return { busy: 'Looking', text: `Catching up with what it already knows… ${sofar}`, going: true };
    if (pending) return { busy: 'Looking', text: `Checking years and genres on ${mbWhere()}… ${sofar}`, going: true };
    // (On a MusicBrainz of your own, those with nothing to fix aren't
    // checked by their tracks: found, not matched exactly.)
    const found = sc.found.filter(known).length;
    const matched = sc.check ? 'found on MusicBrainz' : 'matched exactly on MusicBrainz';
    const unchecked = sc.found.filter((g) => g === 'unchecked').length;
    const cantSearch = unchecked ? ` ${fmt.count(unchecked, 'album', 'albums')} couldn’t be checked: searching your MusicBrainz server finds no one (its search indexes may not be built).` : '';
    // (Each time they were asked about: tried again with Look again.)
    const unanswered = sc.found.filter((g) => g === 'unanswered').length;
    const them = unanswered === 1 ? 'it' : 'them';
    const noAnswer = unanswered ? ` ${fmt.count(unanswered, 'album', 'albums')} couldn’t be checked: ${sc.check ? 'your MusicBrainz server' : 'MusicBrainz'} didn’t answer for ${them}. Look again to try ${them} again.` : '';
    if (found) return { text: `Checked ${fmt.count(sc.albums.length, 'album', 'albums')}: ${found === sc.albums.length ? 'all' : fmt.number(found)} ${matched}.${cantSearch}${noAnswer}`, warn: !!(unchecked || unanswered) };
    if (unchecked || unanswered) return { text: `${cantSearch}${noAnswer}`.trim(), warn: true };
    return { text: `None of your ${fmt.count(sc.albums.length, 'album', 'albums')} ${sc.check ? 'were found' : 'matched exactly'} on MusicBrainz, so there’s nothing to compare.`, warn: true };
  };

  // What MusicBrainz has of each, the very album or nothing (null: nothing,
  // or which album it is can't be told; 'pending': being looked up): by
  // Plex's MusicBrainz id for it, where its title agrees, or else, for a
  // studio album, by its artist and its exact title (see releases.js
  // exactAlbum), and the year Plex has (which tells albums of one title
  // apart), with its genres for those without any.
  // ('unchecked': only a search could find it, and searching the player's
  // MusicBrainz finds no one. 'unanswered': MusicBrainz didn't answer for
  // it, each time the player asked: asked again in the next look.)
  const itemOf = (j) => ({
    artist: sc.albums[j].parentTitle,
    title: sc.albums[j].title,
    year: plexYear(sc.albums[j]),
    artistId: sc.artistIds.get(String(sc.albums[j].parentRatingKey)),
    albumId: mbidOf(sc.albums[j]),
    tracks: Number(sc.albums[j].leafCount) || 0,
  });
  // (`fresh`: those asked about for the first time in this look, where
  // one MusicBrainz didn't answer for before is asked again. Says whether
  // MusicBrainz isn't answering anything just now: `quiet`.)
  async function ask(indexes, fresh = new Set()) {
    const { albums, found, check } = sc;
    const item = (j, more = {}) => ({ ...itemOf(j), ...more, ...(fresh.has(j) ? { retry: true } : {}) });
    let quiet = false;
    for (const withGenres of [true, false]) {
      const these = indexes.filter((j) => !genresOf(albums[j]).length === withGenres);
      for (let i = 0; i < these.length && !sc.stopped; i += ASK) {
        const part = these.slice(i, i + ASK);
        const got = await albumsOnMB(part.map((j) => item(j)), { genres: withGenres, background: true, strict: true, check });
        if (got.notAnswering) quiet = true;
        // ...by their tracks, as Plex has them (those that can't be read
        // aren't fixed).
        const toCheck = check ? part.map((j, k) => ({ j, k, g: got[k] })).filter(({ j, g }) => known(g) && g.toCheck && differs(albums[j], g)) : [];
        if (toCheck.length && !sc.stopped) {
          const lists = await Promise.all(toCheck.map(({ j }) => albumTracks(albums[j], { server: sc.s }).catch(() => null)));
          const asking = toCheck.map((x, n) => ({ ...x, list: lists[n] })).filter((x) => x.list?.length);
          const byTracks = asking.length ? await albumsOnMB(asking.map(({ j, list }) => item(j, { trackList: list })), { genres: withGenres, background: true, strict: true, check }) : [];
          if (byTracks.notAnswering) quiet = true;
          for (const { k } of toCheck) got[k] = null;
          asking.forEach(({ k }, n) => (got[k] = byTracks[n] ?? null));
        }
        // Of those that would be fixed: not one found by its title whose
        // kind Plex has as another (a live album as a studio one, a single
        // as an album: Plex's release types, read for those), nor a short
        // one whose tracks say it's another recording (a remix single's:
        // see mb.js notThatRecording).
        const would = part.map((j, k) => ({ j, g: got[k] ?? null })).filter(({ j, g }) => known(g) && differs(albums[j], g));
        const byTitle = would.filter(({ j, g }) => g.id !== mbidOf(albums[j]));
        const types = byTitle.length ? await sc.s.albumTypes(byTitle.map(({ j }) => albums[j].ratingKey)).catch(() => null) : [];
        const otherKind = new Set(byTitle.filter(({ g }, n) => !types || !kindsAgree(types[n] ? plexKind(types[n]) : null, g)).map(({ j }) => j));
        const otherRecording = new Set(
          (await Promise.all(would.map(({ j, g }) => (otherKind.has(j) ? true : notThatRecording(albums[j], g, { server: sc.s }))))).flatMap((no, n) => (no ? [would[n].j] : [])),
        );
        part.forEach((j, k) => (found[j] = otherKind.has(j) || otherRecording.has(j) ? null : (got[k] ?? null)));
        // (Catching up: most of those asked about for the first time
        // answered at once, the player having them from a look before, say.)
        const firstHere = part.filter((j) => fresh.has(j));
        if (firstHere.length) sc.catchingUp = firstHere.filter((j) => found[j] !== 'pending').length * 2 >= firstHere.length;
        sc.changed();
      }
    }
    return { quiet };
  }

  // (After MusicBrainz didn't answer, or was busy: asked again only after as
  // long as the player says, so it isn't asked again and again meanwhile.)
  const waitAfter = (err) => Math.max(AGAIN_MS, (Number(err?.retryAfter) || 0) * 1000, err ? 30000 : 0);
  const inTime = (ms) => {
    const secs = Math.round(ms / 1000);
    return secs < 90 ? `in ${fmt.count(secs, 'second', 'seconds')}` : `in ${fmt.count(Math.round(secs / 60), 'minute', 'minutes')}`;
  };
  // (This carries on by itself, so not "Try again…".)
  const say = (err) => {
    if (!err) return null;
    const said = String(err.message || describeError(err));
    const what = said.replace(/\s*[^.]*\btry again\b[^.]*\.\s*$/i, '') || said;
    return `${what} Carrying on ${inTime(waitAfter(err))}.`;
  };

  // Those still being looked up, asked about, the first in line first (the
  // player looks them up in order): soon again where most of them were
  // known (a library looked through before: see the header), or else in a
  // few seconds, as the player gets through them. (Never straight away: the
  // player takes 30,000 albums a minute from each account.)
  async function again() {
    sc.timer = null;
    if (sc.stopped) return;
    const waiting = sc.found.flatMap((g, i) => (g === 'pending' ? [i] : [])).slice(0, AGAIN_AT_MOST);
    if (!waiting.length) return;
    const fresh = new Set(waiting.filter((j) => !sc.asked[j]));
    for (const j of fresh) sc.asked[j] = 1;
    // (All of them asked about already: it's looking those left up.)
    if (!fresh.size) sc.catchingUp = false;
    let err = null;
    let quiet = false;
    try {
      ({ quiet } = await ask(waiting, fresh));
    } catch (e) {
      err = e;
    }
    if (sc.stopped) return;
    sc.trouble = err ? say(err) : quiet ? `${sc.check ? 'Your MusicBrainz server' : 'MusicBrainz'} isn’t answering just now. Carrying on when it does.` : null;
    sc.changed();
    if (!sc.found.includes('pending')) return;
    const answered = waiting.filter((j) => sc.found[j] !== 'pending').length;
    sc.timer = setTimeout(again, err ? waitAfter(err) : answered * 2 >= waiting.length ? AGAIN_SOON_MS : AGAIN_MS);
  }

  // Every album in the library: what Plex has of it (with Plex's
  // MusicBrainz id for it, where it has one: the very album, found without
  // a search), and their artists' MusicBrainz ids, where Plex has them (an
  // album's found by its artist's id, without a search, which a MusicBrainz
  // server of your own may not have working, and never by another artist's
  // name).
  (async () => {
    try {
      for (let start = 0; !sc.stopped; start += PAGE) {
        const { items, total } = await sc.s.list(sc.sec, 9, { start, size: PAGE, sort: 'artist.titleSort', filters: { includeGuids: 1 } });
        sc.albums.push(...items.filter((m) => m.type === 'album' && m.title && m.parentTitle));
        Object.assign(sc, { read: Math.min(start + items.length, total), total });
        sc.changed();
        if (!items.length || start + PAGE >= total) break;
      }
    } catch (err) {
      Object.assign(sc, { phase: 'failed', failed: describeError(err) });
      sc.changed();
      return;
    }
    if (sc.stopped) return;
    Object.assign(sc, { phase: 'artists', read: 0, total: 0 });
    sc.changed();
    try {
      for (let start = 0; !sc.stopped; start += PAGE) {
        const { items, total } = await sc.s.list(sc.sec, 8, { start, size: PAGE, sort: 'titleSort', filters: { includeGuids: 1 } });
        for (const a of items) if (a?.ratingKey && mbidOf(a)) sc.artistIds.set(String(a.ratingKey), mbidOf(a));
        Object.assign(sc, { read: Math.min(start + items.length, total), total });
        sc.changed();
        if (!items.length || start + PAGE >= total) break;
      }
    } catch {
      /* by their names, then */
    }
    if (sc.stopped) return;
    sc.libraryGenres = new Map(
      (await sc.s.tags(sc.sec, 'genre', 9).catch(() => []))
        .map((t) => t?.title)
        .filter(Boolean)
        .map((t) => [norm(t), t]),
    );
    if (sc.stopped) return;
    sc.found = sc.albums.map(() => 'pending');
    sc.asked = new Uint8Array(sc.albums.length);
    sc.phase = 'checking';
    sc.changed();
    again();
  })();

  async function fixYear({ m, g }, { quiet = false } = {}) {
    const year = firstYear(g);
    const date = /^\d{4}-\d{2}-\d{2}$/.test(g.date) ? g.date : `${year}-01-01`;
    const before = { year: plexYear(m), date: String(m.originallyAvailableAt || '').slice(0, 10) };
    await sc.s.editAlbum(sc.sec, m.ratingKey, { year, date });
    sc.fixed.set(String(m.ratingKey), { kind: 'year', before });
    Object.assign(m, { year, originallyAvailableAt: date });
    if (!quiet) toast(`${m.title}: ${year} in Plex now`, { action: 'Undo', timeout: 8000, onAction: () => undoYear(m) });
  }

  // (As it was, unlocked again, so Plex's next refresh has it as Plex has
  // it; a day it hadn't, left out again.)
  async function undoYear(m, { quiet = false } = {}) {
    const was = sc.fixed.get(String(m.ratingKey));
    if (was?.kind !== 'year') return;
    try {
      await sc.s.editAlbum(sc.sec, m.ratingKey, { year: was.before.year, date: was.before.date, unlock: true });
      Object.assign(m, { year: was.before.year, originallyAvailableAt: was.before.date });
      sc.fixed.delete(String(m.ratingKey));
    } catch (err) {
      if (quiet) throw err;
      toast(`Couldn’t put it back. ${describeError(err)}`);
    }
    if (!quiet) sc.changed();
  }

  async function fixGenres({ m, g }, { quiet = false } = {}) {
    const adding = [...new Set(g.genres.map(sc.asLibrary))];
    await sc.s.editAlbum(sc.sec, m.ratingKey, { genres: [...genresOf(m), ...adding] });
    sc.fixed.set(String(m.ratingKey), { kind: 'genres', added: adding });
    m.Genre = [...(m.Genre || []), ...adding.map((tag) => ({ tag }))];
    if (!quiet) toast(`${m.title}: ${adding.join(', ')} in Plex now`, { action: 'Undo', timeout: 8000, onAction: () => undoGenres(m) });
  }

  async function undoGenres(m, { quiet = false } = {}) {
    const was = sc.fixed.get(String(m.ratingKey));
    if (was?.kind !== 'genres') return;
    try {
      await sc.s.editAlbum(sc.sec, m.ratingKey, { removeGenres: was.added, unlock: true });
      m.Genre = (m.Genre || []).filter((t) => !was.added.includes(t.tag));
      sc.fixed.delete(String(m.ratingKey));
    } catch (err) {
      if (quiet) throw err;
      toast(`Couldn’t put it back. ${describeError(err)}`);
    }
    if (!quiet) sc.changed();
  }
  sc.fixYear = fixYear;
  sc.fixGenres = fixGenres;

  // All of them, one after another (and Undo, all of those: in a toast, and
  // on the page until it's used). Carried on with if the page is left.
  // (One at a time: another, or an Undo, waits till it's done.)
  sc.fixAll = async (what) => {
    if (sc.fixing) return;
    const [list, fix, undo, thing] = what === 'year' ? [yearRows(), fixYear, undoYear, 'year'] : [genreRows(), fixGenres, undoGenres, 'genres'];
    const sure = await confirmAction({
      title: `Fix ${fmt.count(list.length, 'album', 'albums')} in Plex?`,
      message: `Changes each album’s ${thing} in Plex, for everyone. You can undo it straight after.`,
      confirm: 'Fix them',
      danger: false,
    });
    if (!sure || sc.fixing) return;
    const done = [];
    sc.lastAll = null;
    let failed = 0;
    sc.fixing = { kind: what };
    sc.changed();
    for (const x of list) {
      try {
        await fix(x, { quiet: true });
        done.push(x.m);
      } catch {
        failed += 1;
      }
      sc.changed((done.length + failed) % 20 ? 'counts' : undefined);
    }
    sc.fixing = null;
    sc.lastAll = { list: done, undo, kind: what };
    sc.changed();
    toast(`${fmt.count(done.length, 'album', 'albums')} fixed in Plex${failed ? `, ${fmt.number(failed)} couldn’t be` : ''}`, {
      action: done.length ? 'Undo' : null,
      timeout: 15000,
      onAction: () => sc.undoAll(),
    });
  };

  sc.undoAll = async () => {
    if (sc.fixing) return;
    const was = sc.lastAll;
    sc.lastAll = null;
    if (!was?.list.length) return;
    const { list, undo } = was;
    let back = 0;
    let failed = 0;
    sc.fixing = { kind: was.kind, back: true };
    sc.changed();
    for (const m of list) {
      try {
        await undo(m, { quiet: true });
        back += 1;
      } catch {
        failed += 1;
      }
      sc.changed((back + failed) % 20 ? 'counts' : undefined);
    }
    sc.fixing = null;
    toast(`${fmt.count(back, 'album', 'albums')} as they were in Plex${failed ? `, ${fmt.number(failed)} couldn’t be` : ''}`);
    sc.changed();
  };

  sc.downloadList = () => {
    const head = ['Artist', 'Album', 'Year in Plex', 'First year on MusicBrainz', 'Genres in Plex', 'Genres on MusicBrainz', 'MusicBrainz release group', 'Link'];
    const rows = sc.albums
      .map((m, i) => ({ m, g: sc.found[i] }))
      .filter(({ m, g }) => known(g) && differs(m, g))
      .map(({ m, g }) => [m.parentTitle, m.title, plexYear(m) || '', firstYear(g) || '', genresOf(m).join('; '), (g.genres || []).join('; '), g.id, mbLink(g)]);
    download(toCsv(head, rows), `musicbrainz-fixes-${fileDate()}.csv`, 'text/csv;charset=utf-8');
    toast('Downloaded, to open in a spreadsheet');
  };

  return sc;
}
