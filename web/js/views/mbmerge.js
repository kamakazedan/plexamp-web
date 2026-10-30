// Settings › MusicBrainz › Artists to merge, for the server's owner: the
// library's artists that Plex has more than once, merged in Plex, as many
// at once as are chosen, with one OK, by Plex's own merge (for everyone and
// every app: the player can't undo it). Two kinds:
//   - artists of the very same name (Plex makes two of one from files
//     tagged otherwise);
//   - artists whose name is several in one ("Alphabeat;FORCE": the files'
//     album artist tag has several artists joined by ";", which Plex takes
//     for one name), into the library's artist of the first of those names
//     it has (once: where it has that one more than once too, those first).
// Those MusicBrainz plainly has as one artist (releases.js sameArtist) are
// chosen to begin with; the rest are left as they are, saying why, album by
// album, for the owner to choose too, knowing that. After merging, the page
// shows what's left as it is then, without reading the library again (but
// for Look again): names of several in one whose artist's just been merged
// are looked up then. Only the names Plex has more than once are looked up
// on MusicBrainz (as an artist's page does, and kept as long).
import { app } from '../state.js';
import { describeError, dropCached } from '../router.js';
import { h, backHeader, sectionHeader, emptyState, toast, fmt, confirmAction, spinner } from '../ui.js';
import { artistOnMB, mbFeatures } from '../mb.js';
import { mbWhere } from '../missing.js';
import { isAdmin } from '../editing.js';
import { norm } from '../missinglist.js';
import { joinedParts, sameArtist, evidenceOf } from '../releases.js';

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
// A sentence's end, after a name that may have one of its own ("goddard.").
const end = (text) => (/[.!?…]$/.test(text) ? text : `${text}.`);
const quoted = (titles) => listOf(titles.slice(0, 3).map((t) => `“${t}”`)) + (titles.length > 3 ? ` and ${fmt.number(titles.length - 3)} more` : '');

// Each of several, `n` at a time.
async function inTurn(items, n, fn) {
  let i = 0;
  const one = async () => {
    while (i < items.length) await fn(items[i++]);
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, one));
}

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
  const top = h('div.pad.button-row.mb-merge-actions');
  const bottom = h('div.pad.button-row.mb-merge-actions');
  const lists = h('div.mb-merge-lists');
  el.append(
    h(
      'p.lede',
      null,
      `Artists Plex has more than once in ${app.source.sectionTitle}: those of the very same name, and those whose name is several artists’ (“Alphabeat;FORCE”, as files can be tagged), looked up on ${mbWhere()}. Those it plainly has as one artist are chosen to merge; the rest are yours to choose, saying why they’re left. One OK merges all you’ve chosen, by Plex’s own merge, for everyone and every app.`,
    ),
    status,
    top,
    lists,
    bottom,
    h(
      'p.hint.pad',
      null,
      'Plex makes artists from your files’ album artist tags, so new files tagged as these were come in apart again. MusicBrainz Picard or beets can tag them (one album artist, and each of several artists as a value of its own).',
    ),
  );

  // What's known: the library's artists (ratingKey -> artist), each one's
  // albums once read (ratingKey -> [{ title, year }]), the groups to merge
  // (as looked up, by key), and what's been chosen otherwise than to begin
  // with (key -> true or false).
  let artists = new Map();
  const albums = new Map();
  let groups = [];
  const choice = new Map();
  let busyNow = false;

  const busy = (text) => status.replaceChildren(spinner('Working'), h('span', null, ` ${text}`));
  const chosen = (g) => (choice.has(g.key) ? choice.get(g.key) : g.verdict === 'same');
  const canChoose = (g) => g.verdict === 'same' || g.verdict === 'unknown' || g.verdict === 'different';

  // Those Plex has more than once, from the artists as they are now: of one
  // name (as norm has it), and names of several in one with a name among
  // them the library has.
  function groupsNow() {
    const byName = new Map();
    for (const a of artists.values()) {
      const n = norm(a.title);
      if (!n || NOBODY.has(n) || joinedParts(a.title)) continue;
      if (!byName.has(n)) byName.set(n, []);
      byName.get(n).push(a);
    }
    const out = [];
    for (const [n, list] of byName) if (list.length > 1) out.push({ key: `twice|${n}`, kind: 'twice', name: list[0].title, members: list });
    for (const a of artists.values()) {
      const parts = joinedParts(a.title);
      const hit = parts?.find((p) => byName.has(norm(p)));
      if (hit) out.push({ key: `joined|${a.ratingKey}`, kind: 'joined', name: byName.get(norm(hit))[0].title, members: byName.get(norm(hit)), joined: a, with: parts.filter((p) => norm(p) !== norm(hit)) });
    }
    return out;
  }

  const albumsOf = async (a) => {
    if (!albums.has(a.ratingKey)) {
      const list = (await s.artistAlbums(sec, a.ratingKey)).map((m) => ({ title: m.title, year: Number(m.year) || Number(String(m.originallyAvailableAt || '').slice(0, 4)) || null }));
      albums.set(a.ratingKey, list);
    }
    return albums.get(a.ratingKey);
  };

  // What Plex has of each one's albums, and what MusicBrainz has of the
  // name (by the MusicBrainz id Plex has for one of them, if it has one:
  // for a name of several in one, the artist of its plain name's, as which
  // of the names Plex has an id for can't be told).
  async function lookUp(g) {
    if (g.kind === 'joined' && g.members.length > 1) {
      g.verdict = 'first';
      g.sig = sig(g);
      return;
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
      g.evidence = evidenceOf(withAlbums, { name: g.name, groups: mb.groups, namesakes: mb.namesakes });
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
      g.sig = sig(g);
    } catch (err) {
      g.verdict = 'error';
      g.error = err?.message || describeError(err);
    }
  }

  // The groups as they are now, each looked up but where it's as it was
  // when it was looked up (the same artists, with the same albums: `sig`):
  // `again`, all looked up whatever.
  const sig = (g) => `${g.key}|${(g.kind === 'joined' ? [g.joined, ...g.members] : g.members).map((a) => `${a.ratingKey}:${albums.get(a.ratingKey)?.length ?? '?'}`).join(',')}`;
  async function lookUpAll(fresh, again = false) {
    const was = new Map(groups.filter((g) => g.sig).map((g) => [g.sig, g]));
    const todo = [];
    const next = fresh.map((g) => {
      const old = !again && was.get(sig(g));
      if (old && old.verdict !== 'error') return old;
      todo.push(g);
      return g;
    });
    let n = 0;
    if (todo.length) busy(`Looking up ${fmt.count(todo.length, 'name', 'names')} on ${mbWhere()}…`);
    // (Several at once on a MusicBrainz of the player's own; one at a time on musicbrainz.org, its rule.)
    await inTurn(todo, app.config.musicbrainz === 'own' ? 4 : 1, async (g) => {
      if (gone) return;
      await lookUp(g);
      n += 1;
      if (!gone && todo.length > 1) busy(`Looking up ${fmt.number(n)} of ${fmt.number(todo.length)} on ${mbWhere()}…`);
    });
    groups = next;
  }

  // The library's artists, read again, and everything looked up again.
  async function scan() {
    busyNow = true;
    paintButtons();
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
      busyNow = false;
      status.replaceChildren(`Your artists couldn’t be read. ${describeError(err)}`);
      status.classList.add('warn');
      paintButtons();
      return;
    }
    if (gone) return;
    artists = new Map(all.map((a) => [String(a.ratingKey), a]));
    albums.clear();
    choice.clear();
    await lookUpAll(groupsNow(), true);
    if (gone) return;
    busyNow = false;
    status.replaceChildren(`Looked through ${fmt.count(artists.size, 'artist', 'artists')}.`);
    render();
  }

  const evidence = (g) => {
    if (g.kind === 'joined') {
      return g.mb?.namesakes?.length
        ? `MusicBrainz has its albums and your ${g.name}’s as ${g.name}’s, and none as another’s of the name.`
        : end(`MusicBrainz has your ${g.name}’s albums as theirs, and knows only one ${g.name}`);
    }
    return `MusicBrainz has albums of each of them as ${g.name}’s, and none as another’s of the name${g.byId ? ' (and Plex has the same MusicBrainz id for them)' : ''}.`;
  };
  // What MusicBrainz has of one's albums, said.
  const albumsSaid = (x, name) => {
    const n = fmt.count(x.albums, 'album', 'albums');
    if (x.plain.length) return `${n}, ${x.plain.length === x.albums ? (x.albums === 1 ? 'which' : 'all of which') : fmt.number(x.plain.length)} MusicBrainz has as ${name}’s`;
    if (x.weak.length) return `${n}, only ${quoted(x.weak)} as ${name}’s on MusicBrainz, a title plenty of artists have`;
    return `${n}, none MusicBrainz has as theirs (by title and year)`;
  };
  const why = (g) => {
    const one = g.kind === 'joined' ? 'it’s theirs' : 'they’re one artist';
    if (g.verdict === 'first') return `Plex has ${fmt.number(g.members.length)} artists called ${g.name}: merge those first, and this is looked at then.`;
    if (g.verdict === 'error') return `Couldn’t be looked up just now (${g.error}). Look again to try again.`;
    if (g.verdict === 'different') {
      if (g.idsDiffer) return 'Plex has different MusicBrainz ids for them: different artists of one name.';
      const apart = g.evidence?.flatMap((x) => x.apart) || [];
      return `MusicBrainz has ${apart.length ? quoted(apart) : g.kind === 'joined' ? 'its albums' : 'their albums'} as another ${g.name}’s: different artists of one name.`;
    }
    if (g.mb && !g.mb.artist) return end(`MusicBrainz doesn’t know ${g.name}, so it can’t say whether ${one}`);
    if (g.idsDiffer || g.otherId) return `Plex has another artist’s MusicBrainz id for ${g.kind === 'joined' ? 'it' : 'one of them'}, so MusicBrainz can’t say whether ${one}.`;
    if (g.mb?.moreNamesakes) return `MusicBrainz has more artists called ${g.name} than are looked through here, so it can’t say whether ${one}.`;
    if (g.mb?.capped || g.mb?.namesakes?.some((n) => n?.capped)) return `MusicBrainz has more of ${g.name}’s releases than are looked through here, so it can’t say whether ${one}.`;
    const ev = g.evidence || [];
    const weakApart = ev.flatMap((x) => x.apartWeak);
    if (weakApart.length) return `MusicBrainz has ${quoted(weakApart)} as another ${g.name}’s, a title plenty of artists have, so it can’t say whether ${one}.`;
    const said = g.kind === 'joined' ? `Your ${g.name}: ${albumsSaid(ev[0], g.name)}; this one: ${albumsSaid(ev[1], g.name)}` : `Plex’s ${fmt.number(ev.length)}: ${ev.map((x) => `one with ${albumsSaid(x, g.name)}`).join('; ')}`;
    return `${said}. Not enough to say whether ${one}.`;
  };

  const rowsFor = (list, cls) =>
    list.map((g) => {
      const box = canChoose(g)
        ? h('input.mb-merge-check', {
            type: 'checkbox',
            checked: chosen(g),
            disabled: busyNow,
            'aria-label': `Merge ${g.kind === 'joined' ? `“${g.joined.title}” into ${g.name}` : `the ${fmt.number(g.members.length)} called ${g.name}`}`,
            onchange: (e) => {
              choice.set(g.key, e.target.checked);
              paintButtons();
            },
          })
        : h('span.mb-merge-check-none');
      const title = g.kind === 'joined' ? g.joined.title : g.name;
      const albumCount = (a) => fmt.count(g.entries?.find((e) => e.artist === a)?.albums.length ?? 0, 'album', 'albums');
      const sub =
        g.verdict !== 'same'
          ? why(g) + (canChoose(g) ? ' Choose it to merge it anyway.' : '')
          : g.kind === 'joined'
            ? `${end(`${albumCount(g.joined)} of ${g.name}’s with ${listOf(g.with)}, into your ${g.name}`)} ${evidence(g)}`
            : `${fmt.number(g.members.length)} artists in Plex (${g.members.map((a) => albumCount(a)).join(', ')}). ${evidence(g)}`;
      return h(
        `${canChoose(g) ? 'label' : 'div'}.row.mb-merge-row.${cls}${g.verdict !== 'same' ? `.mb-merge-${g.verdict}` : ''}`,
        null,
        box,
        h('div.row-main', null, h('div.row-title', null, title), h('div.row-sub', null, sub)),
      );
    });

  // "All" and "None" for a section's rows.
  const allOrNone = (list) => {
    const choosable = list.filter(canChoose);
    if (!choosable.length) return null;
    const every = choosable.every(chosen);
    return h(
      'button.link-btn.mb-merge-all',
      {
        type: 'button',
        disabled: busyNow,
        onclick: () => {
          for (const g of choosable) choice.set(g.key, !every);
          render();
        },
      },
      every ? 'Choose none' : 'Choose all',
    );
  };

  function paintButtons() {
    const n = groups.filter((g) => canChoose(g) && chosen(g)).length;
    for (const bar of [top, bottom]) {
      bar.replaceChildren(
        h(
          'button.btn.btn-primary.mb-merge-go',
          { type: 'button', disabled: busyNow || !n, onclick: () => mergeChosen() },
          n ? `Merge ${fmt.number(n)} in Plex` : 'Choose some to merge',
        ),
        h('button.btn.btn-secondary.mb-merge-again', { type: 'button', disabled: busyNow, onclick: () => scan() }, 'Look again'),
      );
    }
    bottom.hidden = groups.length < 8;
    for (const box of lists.querySelectorAll('input.mb-merge-check')) box.disabled = busyNow;
    for (const b of lists.querySelectorAll('button.mb-merge-all')) b.disabled = busyNow;
  }

  function render() {
    if (gone) return;
    const twice = groups.filter((g) => g.kind === 'twice' && g.verdict === 'same');
    const joined = groups.filter((g) => g.kind === 'joined' && g.verdict === 'same');
    const left = groups.filter((g) => g.verdict !== 'same');
    const block = (title, list, cls) =>
      list.length ? h('section.block', null, sectionHeader(`${title} (${fmt.number(list.length)})`, null, allOrNone(list)), h('div.rows.mb-merge-rows', null, rowsFor(list, cls))) : null;
    lists.replaceChildren(
      ...[
        groups.length ? null : emptyState('Plex has no artist more than once here.'),
        groups.length && !twice.length && !joined.length ? emptyState('Nothing MusicBrainz plainly has as one artist, to merge: those left as they are are yours to choose.') : null,
        block('The same name, more than once', twice, 'mb-merge-twice'),
        block('Several artists in one name', joined, 'mb-merge-joined'),
        block('Left as they are', left, 'mb-merge-left'),
      ].filter(Boolean),
    );
    paintButtons();
  }

  // All that's chosen, with one OK, one after another (those of one name
  // first: a name of several in one waits for those of its first name);
  // then what's known is as Plex has it now, and what's changed is looked
  // up again.
  async function mergeChosen() {
    const list = groups.filter((g) => canChoose(g) && chosen(g)).sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'twice' ? -1 : 1));
    if (!list.length) return;
    const unsure = list.filter((g) => g.verdict === 'unknown').length;
    const apart = list.filter((g) => g.verdict === 'different').length;
    const caution = [unsure ? `${fmt.number(unsure)} MusicBrainz can’t say are one artist` : '', apart ? `${fmt.number(apart)} it has as different artists` : ''].filter(Boolean);
    const sure = await confirmAction({
      title: list.length === 1 ? `Merge ${list[0].kind === 'joined' ? `“${list[0].joined.title}” into ${list[0].name}` : `the ${fmt.number(list[0].members.length)} called ${list[0].name}`}?` : `Merge ${fmt.number(list.length)} in Plex?`,
      message: `In Plex itself, for everyone and every app: each one’s albums and tracks go to one artist (of those of one name, the one Plex has MusicBrainz’s id for, or more albums of; for a name of several, the artist of its first name), and the others are gone. It’s Plex’s own merge, which this player can’t undo.${caution.length ? ` Of these, ${listOf(caution)}: merged as you’ve chosen.` : ''}`,
      confirm: 'Merge in Plex',
      danger: true,
    });
    if (!sure || gone) return;
    busyNow = true;
    paintButtons();
    let done = 0;
    const failed = [];
    for (const g of list) {
      if (gone) return;
      busy(`Merging in Plex… ${fmt.number(done + failed.length + 1)} of ${fmt.number(list.length)}`);
      // (A name of several in one whose first name's artists were merged
      // just now: into the one left of them.)
      const target = g.kind === 'joined' ? artists.get(String(g.members.find((a) => artists.has(String(a.ratingKey)))?.ratingKey)) : g.target;
      const others = g.kind === 'joined' ? [g.joined] : g.members.filter((a) => a !== g.target);
      if (!target || !others.length || others.some((a) => !artists.has(String(a.ratingKey)))) continue;
      try {
        await s.mergeInto(target.ratingKey, others.map((a) => a.ratingKey));
      } catch (err) {
        failed.push(`${g.kind === 'joined' ? g.joined.title : g.name} (${describeError(err)})`);
        continue;
      }
      done += 1;
      // As Plex has it now: the others gone, their albums the target's.
      const into = [...(albums.get(target.ratingKey) || [])];
      for (const a of others) {
        into.push(...(albums.get(a.ratingKey) || []));
        artists.delete(String(a.ratingKey));
        albums.delete(a.ratingKey);
        choice.delete(g.key);
      }
      albums.set(target.ratingKey, into);
    }
    if (gone) return;
    toast(
      `Merged ${fmt.number(done)} in Plex${failed.length ? `; ${fmt.number(failed.length)} couldn’t be: ${failed.slice(0, 2).join(', ')}${failed.length > 2 ? '…' : ''}` : ''}`,
      { timeout: failed.length ? 9000 : 4000 },
    );
    // (Pages showing them as they were go.)
    if (done) dropCached((p) => p !== '/settings/mbmerge');
    await lookUpAll(groupsNow());
    if (gone) return;
    busyNow = false;
    status.replaceChildren(`Merged ${fmt.number(done)}. ${fmt.count(artists.size, 'artist', 'artists')} here now.`);
    render();
  }

  await scan();
}
