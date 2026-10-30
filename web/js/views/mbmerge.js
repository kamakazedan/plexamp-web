// Settings › MusicBrainz › Artists to merge, for the server's owner: the
// library's artists that Plex has more than once, and are one artist on
// plain evidence (releases.js sameArtist), merged in Plex with the owner's
// OK, one at a time, by Plex's own merge (for everyone and every app: the
// player can't undo it). Two kinds:
//   - artists of the very same name (Plex makes two of one from files
//     tagged otherwise);
//   - artists whose name is several in one ("Alphabeat;FORCE": the files'
//     album artist tag has several artists joined by ";", which Plex takes
//     for one name), into the library's artist of the first of those names
//     it has (once: where it has that one more than once too, those first).
// What MusicBrainz has as different artists, or can't tell, is left as it
// is, saying why. Only the names Plex has more than once are looked up on
// MusicBrainz (as an artist's page does, and kept as long).
import { app } from '../state.js';
import { describeError, dropCached } from '../router.js';
import { h, backHeader, row, sectionHeader, emptyState, toast, fmt, confirmAction, spinner } from '../ui.js';
import { artistOnMB, mbFeatures } from '../mb.js';
import { mbWhere } from '../missing.js';
import { isAdmin } from '../editing.js';
import { norm } from '../missinglist.js';
import { joinedParts, sameArtist } from '../releases.js';

const PAGE = 500; // artists read from Plex at a time
// (Names compilations and works by no one known go by: never one artist.)
const NOBODY = new Set(['various artists', 'various', 'unknown artist', 'unknown', 'anonymous', 'traditional']);

// An artist's MusicBrainz id, where Plex has it (its Guid, asked for with
// includeGuids).
const mbidOf = (artist) =>
  (Array.isArray(artist?.Guid) ? artist.Guid : [])
    .map((g) => String(g?.id || ''))
    .find((g) => /^mbid:\/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(g))
    ?.slice(7) || null;

const listOf = (names) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

export async function mbMergeView({ el, onDispose }) {
  el.append(backHeader('Artists to merge', { fallback: '/settings/musicbrainz' }));
  if (!mbFeatures()) {
    el.append(emptyState('This player’s MusicBrainz features are off (MUSICBRAINZ_ADVANCED).'));
    return;
  }
  if (!(await isAdmin().catch(() => false))) {
    el.append(emptyState('This is for the server’s owner: merging artists in Plex is theirs to do.'));
    return;
  }
  const s = app.server;
  const sec = app.source.sectionKey;
  let gone = false;
  onDispose?.(() => {
    gone = true;
  });

  const status = h('p.hint.pad.mb-merge-status', { role: 'status' });
  const lists = h('div.mb-merge-lists');
  el.append(
    h(
      'p.lede',
      null,
      `Artists Plex has more than once in ${app.source.sectionTitle}: those of the very same name, and those whose name is several artists’ (“Alphabeat;FORCE”, as files can be tagged), looked up on ${mbWhere()}. Only those it plainly has as one artist are offered to merge, each with your OK: Plex’s own merge, for everyone and every app.`,
    ),
    status,
    lists,
    h(
      'p.hint.pad',
      null,
      'Plex makes artists from your files’ album artist tags, so new files tagged as these were come in apart again. MusicBrainz Picard or beets can tag them (one album artist, and each of several artists as a value of its own).',
    ),
  );

  const busy = (text) => status.replaceChildren(spinner('Looking'), h('span', null, ` ${text}`));

  async function scan() {
    // (What's listed from before can't be merged meanwhile: it may be out
    // of date by then.)
    for (const b of lists.querySelectorAll('button.mb-merge')) b.disabled = true;
    busy(`Reading your artists from ${app.source.sectionTitle}…`);
    status.classList.remove('warn');
    const all = [];
    try {
      for (let start = 0; !gone; start += PAGE) {
        const { items, total } = await s.list(sec, 8, { start, size: PAGE, sort: 'titleSort', filters: { includeGuids: 1 } });
        all.push(...items.filter((m) => m.type === 'artist' && m.title && m.ratingKey));
        if (!items.length || start + PAGE >= total) break;
      }
    } catch (err) {
      status.replaceChildren(`Your artists couldn’t be read. ${describeError(err)}`);
      status.classList.add('warn');
      return;
    }
    if (gone) return;

    // By name (as norm has it), but for names that are several in one.
    const byName = new Map();
    for (const a of all) {
      const n = norm(a.title);
      if (!n || NOBODY.has(n) || joinedParts(a.title)) continue;
      if (!byName.has(n)) byName.set(n, []);
      byName.get(n).push(a);
    }
    const groups = [];
    for (const list of byName.values()) if (list.length > 1) groups.push({ kind: 'twice', name: list[0].title, members: list });
    for (const a of all) {
      const parts = joinedParts(a.title);
      const hit = parts?.find((p) => byName.has(norm(p)));
      if (hit) groups.push({ kind: 'joined', name: byName.get(norm(hit))[0].title, members: byName.get(norm(hit)), joined: a, with: parts.filter((p) => norm(p) !== norm(hit)) });
    }
    if (!groups.length) {
      status.replaceChildren(`Looked through ${fmt.count(all.length, 'artist', 'artists')}: Plex has none more than once.`);
      lists.replaceChildren();
      return;
    }

    // Each: what Plex has of their albums, and what MusicBrainz has of the
    // name (by the MusicBrainz id Plex has for one of them, if it has one:
    // for a name of several in one, the artist of its plain name, as which
    // of the names Plex has an id for can't be told).
    const albums = new Map(); // artist id -> [{ title, year }]
    const albumsOf = async (a) => {
      if (!albums.has(a.ratingKey)) albums.set(a.ratingKey, (await s.artistAlbums(sec, a.ratingKey)).map((m) => ({ title: m.title, year: Number(m.year) || Number(String(m.originallyAvailableAt || '').slice(0, 4)) || null })));
      return albums.get(a.ratingKey);
    };
    let n = 0;
    for (const g of groups) {
      if (gone) return;
      n += 1;
      busy(`Looking up ${fmt.number(n)} of ${fmt.number(groups.length)} on ${mbWhere()}…`);
      if (g.kind === 'joined' && g.members.length > 1) {
        g.verdict = 'first';
        continue;
      }
      const entries = g.kind === 'joined' ? [g.members[0], g.joined] : g.members;
      try {
        const withAlbums = [];
        for (const a of entries) withAlbums.push({ artist: a, mbid: mbidOf(a), albums: await albumsOf(a) });
        const id = (g.kind === 'joined' ? withAlbums[0].mbid : withAlbums.map((e) => e.mbid).find(Boolean)) || null;
        const mb = await artistOnMB(g.name, { id, namesakes: true });
        g.mb = mb;
        g.entries = withAlbums;
        g.verdict = sameArtist(withAlbums, { name: g.name, ...mb, joined: g.kind === 'joined' });
        g.byId = withAlbums.every((e) => e.mbid && e.mbid === withAlbums[0].mbid);
        g.idsDiffer = new Set(withAlbums.map((e) => e.mbid).filter(Boolean)).size > 1;
        g.otherId = !!mb.artist?.id && withAlbums.some((e) => e.mbid && e.mbid !== mb.artist.id);
        // Merged into: the library's artist of the plain name, of those of
        // one name the one Plex has MusicBrainz's id for, or with the most
        // albums.
        g.target =
          g.kind === 'joined'
            ? g.members[0]
            : (withAlbums.find((e) => mb.artist?.id && e.mbid === mb.artist.id) || withAlbums.slice().sort((a, b) => b.albums.length - a.albums.length || Number(a.artist.ratingKey) - Number(b.artist.ratingKey))[0]).artist;
      } catch (err) {
        g.verdict = 'error';
        g.error = err?.message || describeError(err);
      }
    }
    if (gone) return;
    status.replaceChildren(`Looked through ${fmt.count(all.length, 'artist', 'artists')}.`);
    render(groups);
  }

  function render(groups) {
    const albumCount = (g, a) => fmt.count(g.entries?.find((e) => e.artist === a)?.albums.length ?? 0, 'album', 'albums');
    const twice = groups.filter((g) => g.kind === 'twice' && g.verdict === 'same');
    const joined = groups.filter((g) => g.kind === 'joined' && g.verdict === 'same');
    const left = groups.filter((g) => g.verdict !== 'same');
    const evidence = (g) => {
      if (g.kind === 'joined') {
        return g.mb?.namesakes?.length
          ? `MusicBrainz has its albums and your ${g.name}’s as ${g.name}’s, and none as another’s of the name.`
          : `MusicBrainz has your ${g.name}’s albums as theirs, and knows only one ${g.name}.`;
      }
      return `MusicBrainz has albums of each of them as ${g.name}’s, and none as another’s of the name${g.byId ? ' (and Plex has the same MusicBrainz id for them)' : ''}.`;
    };
    const why = (g) => {
      const one = g.kind === 'joined' ? 'it’s theirs' : 'they’re one artist';
      let unknown = `MusicBrainz can’t say whether ${one}: not by what it has of their albums.`;
      if (g.mb && !g.mb.artist) unknown = `MusicBrainz doesn’t know ${g.name}, so it can’t say whether ${one}.`;
      else if (g.idsDiffer || g.otherId) unknown = `Plex has another artist’s MusicBrainz id for ${g.kind === 'joined' ? 'it' : 'one of them'}, so MusicBrainz can’t say whether ${one}.`;
      else if (g.mb?.moreNamesakes) unknown = `MusicBrainz has more artists called ${g.name} than are looked through here, so it can’t say whether ${one}.`;
      return (
        {
          first: `Plex has ${fmt.number(g.members.length)} artists called ${g.name}: those first, if they’re one.`,
          different: g.idsDiffer
            ? 'Plex has different MusicBrainz ids for them: different artists of one name.'
            : g.kind === 'joined'
              ? `MusicBrainz has its albums as another ${g.name}’s.`
              : 'MusicBrainz has them as different artists of one name.',
          unknown,
          error: `Couldn’t be looked up just now (${g.error}). Open this page again to try again.`,
        }[g.verdict] || ''
      );
    };
    const mergeButton = (g, label) => h('button.btn.btn-secondary.btn-small.mb-merge', { type: 'button', onclick: (e) => merge(g, e.currentTarget) }, label);
    const block = (title, rows) => (rows.length ? h('section.block', null, sectionHeader(`${title} (${fmt.number(rows.length)})`), h('div.rows.mb-merge-rows', null, rows)) : null);
    lists.replaceChildren(
      ...[
        twice.length || joined.length ? null : emptyState('Nothing MusicBrainz plainly has as one artist, to merge.'),
        block(
          'The same name, more than once',
          twice.map((g) =>
            row({
              title: g.name,
              subtitle: `${fmt.number(g.members.length)} artists in Plex (${g.members.map((a) => albumCount(g, a)).join(', ')}). ${evidence(g)}`,
              right: mergeButton(g, 'Merge'),
              cls: 'mb-merge-twice',
            }),
          ),
        ),
        block(
          'Several artists in one name',
          joined.map((g) =>
            row({
              title: g.joined.title,
              subtitle: `${albumCount(g, g.joined)}: ${g.name}’s, with ${listOf(g.with)}. ${evidence(g)}`,
              right: mergeButton(g, `Merge into ${g.name}`),
              cls: 'mb-merge-joined',
            }),
          ),
        ),
        block(
          'Left as they are',
          left.map((g) => row({ title: g.kind === 'joined' ? g.joined.title : g.name, subtitle: why(g), cls: `mb-merge-left.mb-merge-${g.verdict}` })),
        ),
      ].filter(Boolean),
    );
  }

  async function merge(g, btn) {
    const others = g.kind === 'joined' ? [g.joined] : g.members.filter((a) => a !== g.target);
    const sure = await confirmAction({
      title: g.kind === 'joined' ? `Merge “${g.joined.title}” into ${g.name}?` : `Merge the ${fmt.number(g.members.length)} called ${g.name}?`,
      message: `In Plex itself, for everyone and every app: ${g.kind === 'joined' ? `“${g.joined.title}”’s` : others.length === 1 ? 'the other’s' : 'the others’'} albums and tracks go to ${g.name}${g.kind === 'joined' ? '' : ' (the one Plex has MusicBrainz’s id for, or more albums of)'}, and ${others.length === 1 ? 'it’s' : 'they’re'} gone. It’s Plex’s own merge, which this player can’t undo.`,
      confirm: 'Merge in Plex',
      danger: true,
    });
    if (!sure || gone) return;
    btn.disabled = true;
    try {
      await s.mergeInto(g.target.ratingKey, others.map((a) => a.ratingKey));
    } catch (err) {
      btn.disabled = false;
      toast(`Couldn’t merge them in Plex. ${describeError(err)}`, { timeout: 6000 });
      return;
    }
    toast(`Merged in Plex: ${g.name} has their albums now`);
    // (Pages showing them as they were go; and this one is looked through
    // again: what's left, and what can be merged now, those of several
    // names in one, say.)
    dropCached((p) => p !== '/settings/mbmerge');
    await scan();
  }

  await scan();
}
