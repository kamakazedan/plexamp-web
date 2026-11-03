// Settings › MusicBrainz › Artists to merge, for the server's owner: for
// their information only, the library's artists that Plex may have more than
// once, with what Plex itself says of each, and nothing changed (merging, if
// they're one, is theirs to do in Plex). Two kinds:
//   - artists of the very same name (Plex makes two of one from files
//     tagged otherwise): how many albums each has, and whether Plex links
//     them to the same artist on MusicBrainz, or hasn't linked them (Plex's
//     MusicBrainz ids for them: only Plex's own match, and nothing is
//     looked up); those it links to different artists, most likely
//     different artists of one name, last, apart;
//   - artists whose name is several in one ("Alphabeat;FORCE": the files'
//     album artist tag has several artists joined by ";", which Plex takes
//     for one name), where the library has an artist of one of those names.
// Each opens the artist's page in the app. Nothing here asks MusicBrainz.
import { app } from '../state.js';
import { describeError } from '../router.js';
import { h, backHeader, sectionHeader, emptyState, fmt, spinner } from '../ui.js';
import { mbFeatures, mbidOf } from '../mb.js';
import { isAdmin } from '../editing.js';
import { norm } from '../missinglist.js';
import { joinedParts } from '../releases.js';

const PAGE = 500; // artists read from Plex at a time
const COUNTS_AT_ONCE = 4; // artists' album counts asked of Plex at once
// (Names compilations and works by no one known go by: never one artist.)
const NOBODY = new Set(['various artists', 'various', 'unknown artist', 'unknown', 'anonymous', 'traditional']);

const listOf = (names) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

// Each of several, `n` at a time.
async function inTurn(items, n, fn) {
  let i = 0;
  const one = async () => {
    while (i < items.length) await fn(items[i++]);
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, one));
}

// What Plex's MusicBrainz ids for them say (Plex's own match, nothing
// looked up): order 0, two or more of them the same artist on
// MusicBrainz; 1, not linked, or not all of them; 2, all different
// artists.
export function linkOf(members) {
  const ids = members.map(mbidOf);
  const known = ids.filter(Boolean);
  const unlinked = ids.length - known.length;
  const counts = [...known.reduce((m, id) => m.set(id, (m.get(id) || 0) + 1), new Map()).values()];
  const many = counts.filter((n) => n > 1).sort((a, b) => b - a); // of one artist on MusicBrainz, more than one of them
  const ones = counts.filter((n) => n === 1).length;
  const notLinked = unlinked ? `; ${fmt.number(unlinked)} ${unlinked === 1 ? 'isn’t' : 'aren’t'} linked` : '';
  if (many.length) {
    const rest = ones ? `, ${fmt.number(ones)} to ${ones === 1 ? 'another' : 'others'}` : '';
    if (many.length === 1) {
      const which = many[0] === ids.length ? (ids.length === 2 ? 'both' : 'them') : `${fmt.number(many[0])} of them`;
      return { order: 0, text: `Plex links ${which} to the same artist on MusicBrainz${rest}${notLinked}.` };
    }
    const clusters = many.map((n, i) => (i ? `${fmt.number(n)} to another` : `${fmt.number(n)} of them to one artist on MusicBrainz`)).join(', ');
    return { order: 0, text: `Plex links ${clusters}${rest}${notLinked}.` };
  }
  if (known.length < 2) return { order: 1, text: known.length ? 'Plex links only one of them to MusicBrainz.' : 'Plex hasn’t linked them to MusicBrainz.' };
  if (unlinked) return { order: 1, text: `Plex links ${fmt.number(known.length)} of them to different artists on MusicBrainz${notLinked}.` };
  return { order: 2, text: 'Plex links them to different artists on MusicBrainz.' };
}

export async function mbMergeView({ el, onDispose }) {
  el.append(backHeader('Artists to merge', { fallback: '/settings/musicbrainz' }));
  if (!mbFeatures()) {
    el.append(emptyState('MusicBrainz features are turned off on this player.'));
    return;
  }
  if (!(await isAdmin().catch(() => false))) {
    el.append(emptyState('Only the server’s owner can see this.'));
    return;
  }
  const s = app.server;
  const sec = app.source.sectionKey;
  let gone = false;
  onDispose?.(() => {
    gone = true;
  });

  const status = h('p.hint.pad.mb-merge-status', { role: 'status' });
  const actions = h('div.pad.button-row.mb-merge-actions');
  const lists = h('div.mb-merge-lists');
  el.append(
    h('p.lede', null, 'Artists Plex may have more than once. Nothing’s changed here: if they’re the same, merge them in Plex.'),
    status,
    actions,
    lists,
    h('p.hint.pad', null, 'Fixing the files’ album artist tags keeps them from splitting again.'),
  );

  const busy = (text) => status.replaceChildren(spinner('Working'), h('span', null, ` ${text}`));
  const counts = new Map(); // artist id -> how many albums Plex has of theirs

  // Those Plex may have more than once: of one name (as norm has it), and
  // names of several in one with a name among them the library has.
  function groupsOf(artists) {
    const byName = new Map();
    for (const a of artists) {
      const n = norm(a.title);
      if (!n || NOBODY.has(n) || joinedParts(a.title)) continue;
      if (!byName.has(n)) byName.set(n, []);
      byName.get(n).push(a);
    }
    const twice = [];
    for (const list of byName.values()) if (list.length > 1) twice.push({ kind: 'twice', name: list[0].title, members: list, link: linkOf(list) });
    const joined = [];
    for (const a of artists) {
      const parts = joinedParts(a.title);
      const hit = parts?.find((p) => byName.has(norm(p)));
      if (hit) joined.push({ kind: 'joined', name: byName.get(norm(hit))[0].title, members: byName.get(norm(hit)), joined: a, with: parts.filter((p) => norm(p) !== norm(hit)) });
    }
    // (Those Plex links to one artist on MusicBrainz first, then those it
    // hasn't linked; those it links to different artists apart.)
    const byTitle = (a, b) => a.name.localeCompare(b.name) || String(a.joined?.title || '').localeCompare(String(b.joined?.title || ''));
    twice.sort((a, b) => a.link.order - b.link.order || byTitle(a, b));
    return { twice: twice.filter((g) => g.link.order < 2), apart: twice.filter((g) => g.link.order === 2), joined: joined.sort(byTitle) };
  }

  const albumsText = (a) => (counts.has(String(a.ratingKey)) ? fmt.count(counts.get(String(a.ratingKey)), 'album', 'albums') : 'albums');
  const openLink = (a, text) => h('a.link-btn.mb-merge-open', { href: `#/artist/${encodeURIComponent(a.ratingKey)}` }, text);

  function rowOf(g) {
    if (g.kind === 'joined') {
      return h(
        'div.row.mb-merge-row.mb-merge-joined',
        null,
        h(
          'div.row-main',
          null,
          h('div.row-title', null, g.joined.title),
          h('div.row-sub', null, `${albumsText(g.joined)}, with ${listOf(g.with)}. One tag with several names: fix it, or merge into ${g.name} in Plex.`),
          h('div.mb-merge-links', null, openLink(g.joined, 'Open'), ...g.members.map((a) => openLink(a, `${a.title} (${albumsText(a)})`))),
        ),
      );
    }
    return h(
      `div.row.mb-merge-row.${g.link.order === 2 ? 'mb-merge-apart' : 'mb-merge-twice'}`,
      null,
      h(
        'div.row-main',
        null,
        h('div.row-title', null, g.name),
        h('div.row-sub', null, `${fmt.number(g.members.length)} in Plex. ${g.link.text}`),
        h('div.mb-merge-links', null, g.members.map((a) => openLink(a, albumsText(a)))),
      ),
    );
  }

  let found = { twice: [], apart: [], joined: [] };
  const howMany = () => found.twice.length + found.apart.length + found.joined.length;
  function render() {
    if (gone) return;
    const block = (title, list) => (list.length ? h('section.block', null, sectionHeader(`${title} (${fmt.number(list.length)})`), h('div.rows.mb-merge-rows', null, list.map(rowOf))) : null);
    lists.replaceChildren(
      ...[
        !howMany() ? emptyState('No artist appears more than once here.') : null,
        block('Same name, more than once', found.twice),
        block('Several artists in one name', found.joined),
        block('Same name, different artists', found.apart),
      ].filter(Boolean),
    );
  }

  // The library's artists, read again, and what Plex has of each of those
  // listed: their albums, counted.
  async function scan() {
    again.disabled = true;
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
      again.disabled = false;
      status.replaceChildren(`Your artists couldn’t be read. ${describeError(err)}`);
      status.classList.add('warn');
      return;
    }
    if (gone) return;
    found = groupsOf(all);
    counts.clear();
    render();
    const listed = [...new Map([...found.twice, ...found.apart].flatMap((g) => g.members).concat(found.joined.flatMap((g) => [g.joined, ...g.members])).map((a) => [String(a.ratingKey), a])).values()];
    if (listed.length) busy('Counting their albums…');
    await inTurn(listed, COUNTS_AT_ONCE, async (a) => {
      if (gone) return;
      try {
        counts.set(String(a.ratingKey), await s.count(sec, 9, { 'artist.id': a.ratingKey }));
      } catch {
        /* said as "albums" */
      }
    });
    if (gone) return;
    again.disabled = false;
    const n = howMany();
    status.replaceChildren(`Checked ${fmt.count(all.length, 'artist', 'artists')}${n ? `: ${fmt.number(n)} to look at` : ''}.`);
    render();
  }

  const again = h('button.btn.btn-secondary.mb-merge-again', { type: 'button', onclick: () => scan() }, 'Look again');
  actions.replaceChildren(again);
  await scan();
}
