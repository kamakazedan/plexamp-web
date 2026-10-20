// "Appears in": the playlists and collections a track is in, from a track's
// menu. Each row opens the playlist or collection.
import { app } from '../state.js';
import { normTrack } from '../plex.js';
import { describeError } from '../router.js';
import { h, art, icon, backHeader, row, sectionHeader, emptyState, spinner, fmt } from '../ui.js';
import { playlistArt } from '../components.js';
import { appearsIn } from '../membership.js';
import { addToPlaylist, addToCollection, isAdminNow } from '../editing.js';

const COLLECTION_KINDS = { track: 'Track collection', album: 'Album collection', artist: 'Artist collection' };
const byTitle = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

export async function appearsInView({ el, params, onDispose }) {
  const s = app.server;
  if (!/^\d+$/.test(String(params.id))) throw Object.assign(new Error('Not found'), { status: 404 });
  const meta = await s.trackDetail(params.id);
  if (!meta || meta.type !== 'track') throw Object.assign(new Error('Not found'), { status: 404 });
  const t = normTrack(meta);
  const ctrl = new AbortController();
  onDispose?.(() => ctrl.abort());

  const progress = h('span', null, 'Looking through your playlists and collections…');
  const status = h('div.appears-status', { role: 'status' }, spinner('Looking'), progress);
  const plRows = h('div.rows.appears-playlists');
  const colRows = h('div.rows.appears-collections');
  const plBlock = h('section.block', { hidden: true }, sectionHeader('Playlists'), plRows);
  const colBlock = h('section.block', { hidden: true }, sectionHeader('Collections'), colRows);
  const empty = h('div', { hidden: true });
  const note = h('p.hint.pad.appears-note', { hidden: true });
  const foot = h(
    'div.pad.button-row.appears-actions',
    null,
    h(
      'button.btn.btn-secondary',
      { type: 'button', onclick: () => addToPlaylist({ what: t.title, load: async () => [t] }) },
      icon('playlistAdd', 20),
      h('span', null, 'Add to a playlist…'),
    ),
    isAdminNow()
      ? h(
          'button.btn.btn-secondary',
          { type: 'button', onclick: () => addToCollection({ kind: 'track', what: t.title, load: async () => [t] }) },
          icon('collection', 20),
          h('span', null, 'Add to a collection…'),
        )
      : null,
  );

  el.append(
    backHeader('Appears in'),
    h(
      'div.appears-track',
      null,
      art(t.thumb, { size: 64, fallback: 'note' }),
      h('div.appears-track-text', null, h('div.appears-track-title', null, t.title), h('div.appears-track-sub', null, [t.artist, t.album].filter(Boolean).join(' — '))),
    ),
    status,
    plBlock,
    colBlock,
    empty,
    note,
    foot,
  );

  // Rows go in by name, as they're found.
  function insert(list, rowEl, title) {
    rowEl.dataset.sortTitle = title;
    const after = [...list.children].find((r) => byTitle.compare(r.dataset.sortTitle || '', title) > 0);
    list.insertBefore(rowEl, after || null);
  }

  function playlistRow({ list: pl, times }) {
    const what = [pl.smart ? 'Smart playlist' : 'Playlist', fmt.count(pl.leafCount || 0, 'track', 'tracks')];
    if (times > 1) what.push(`in it ${times} times`);
    return row({ href: `/playlist/${pl.ratingKey}`, image: playlistArt(pl), fallback: 'list', title: pl.title, subtitle: what.join(' · '), cls: 'appears-row' });
  }

  function collectionRow({ list: c, via }) {
    const kind = COLLECTION_KINDS[via] || 'Collection';
    const what = via === 'album' ? `${kind}, with “${t.album}”` : via === 'artist' ? `${kind}, with ${t.albumArtist || t.artist}` : kind;
    return row({ href: `/collection/${c.ratingKey}`, image: c.thumb || c.composite, fallback: 'list', title: c.title, subtitle: what, cls: 'appears-row' });
  }

  try {
    const res = await appearsIn(t, {
      signal: ctrl.signal,
      onProgress: (done, total) => {
        progress.textContent = total ? `Looking through your playlists and collections… ${done} of ${total}` : 'Looking through your playlists and collections…';
      },
      onFound: (kind, entry) => {
        if (kind === 'playlist') {
          insert(plRows, playlistRow(entry), entry.list.title);
          plBlock.hidden = false;
        } else {
          insert(colRows, collectionRow(entry), entry.list.title);
          colBlock.hidden = false;
        }
      },
    });
    const found = res.playlists.length + res.collections.length;
    status.replaceChildren(
      found
        ? `In ${[res.playlists.length && fmt.count(res.playlists.length, 'playlist', 'playlists'), res.collections.length && fmt.count(res.collections.length, 'collection', 'collections')].filter(Boolean).join(' and ')}.`
        : '',
    );
    status.hidden = !found;
    if (!found) {
      empty.replaceChildren(emptyState('It isn’t in any of your playlists, or in a collection.'));
      empty.hidden = false;
    }
    if (res.skipped.length) {
      const names = res.skipped.map((l) => `${l.title} (${fmt.count(Number(l.leafCount ?? l.childCount) || 0, 'track', 'tracks')})`);
      note.textContent = `Too long to look through: ${names.join(', ')}.`;
      note.hidden = false;
    }
  } catch (err) {
    if (ctrl.signal.aborted) return;
    status.replaceChildren(describeError(err));
    status.classList.add('warn');
  }
}
