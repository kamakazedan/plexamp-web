// Settings › Server owner, for the owner of the Plex server in use alone (as
// the player says, which also turns down changes from anyone else: see
// features.js): what's on for everyone who plays from it here. Missing
// tracks (what AI playlists and Spotify imports don't find, everyone's, to
// go and find), and whether an AI's suggestions are checked on MusicBrainz
// first; and where the player has them (MUSICBRAINZ_ADVANCED), the
// MusicBrainz features (mb.js): each on or off, which kinds of an artist's
// missing albums are shown, and a look through the library for the years
// and genres to fix in Plex (mbreview.js), and the artists Plex may have
// more than once, to know of (mbmerge.js). (Skip live tracks and demos,
// which these add to, is in Settings › Playback, for each person.)
import { app, on } from '../state.js';
import { h, backHeader, row, toggleRow, sheet, toast, fmt, emptyState, spinner } from '../ui.js';
import { RELEASE_KINDS, mbFeatures } from '../mb.js';
import { missingCount, mbOffered, mbWhere } from '../missing.js';
import { features, setFeatures, canSetFeatures, readFeatures, ownerHere } from '../features.js';

// The kinds of an artist's missing albums shown (mb.js RELEASE_KINDS ids).
export const missingKinds = () => features().mbMissingKinds;

const kindsText = () => {
  const k = missingKinds();
  if (k.length === RELEASE_KINDS.length) return 'All';
  return RELEASE_KINDS.filter(([id]) => k.includes(id)).map(([, name]) => name).join(', ') || 'None';
};

// A change, for everyone (the artist and album pages kept to go back to
// are built again: see app.js). Said if the player doesn't take it, and
// put back as it was; `after` either way.
const change = (patch, after) =>
  setFeatures(patch)
    .catch((err) => toast(`Couldn’t change that: ${err.message}`))
    .finally(() => after?.());

// The kinds shown, chosen in a sheet by the server's owner (`after`: once
// one changes).
export function chooseMissingKinds(after) {
  const set = (id, on) => {
    const now = new Set(missingKinds());
    if (on) now.add(id);
    else now.delete(id);
    change({ mbMissingKinds: RELEASE_KINDS.map(([k]) => k).filter((k) => now.has(k)) }, after);
  };
  sheet({
    title: 'Missing albums shown',
    subtitle: 'Which kinds to show, for everyone',
    variant: 'dialog',
    content: h('div.rows.mb-kinds', null, RELEASE_KINDS.map(([id, name]) => toggleRow({ title: name, checked: missingKinds().includes(id), onChange: (v) => set(id, v) }))),
  });
}

export async function serverOwnerView({ el, onDispose }) {
  el.append(backHeader('Server owner', { fallback: '/settings' }));
  // (Not said yet, the first time the app's opened: asked now, and waited
  // for. Otherwise asked again, in case another device changed them.)
  if (ownerHere() === null) {
    const wait = h('div.pad', null, spinner());
    el.append(wait);
    await readFeatures({ force: true });
    wait.remove();
  } else {
    readFeatures({ force: true });
  }
  const server = app.source?.serverName || 'this server';
  if (!canSetFeatures()) {
    el.append(emptyState(`Only the owner of ${server} can change these.`));
    return;
  }
  // Each switch, by the feature it's for (set again as they are after a
  // change the player didn't take, or one from another of the owner's
  // devices).
  const switches = new Map();
  const toggle = (key, title, subtitle, cls) => {
    const t = toggleRow({ title, subtitle, checked: features()[key] === true, onChange: (v) => change({ [key]: v }, paint) });
    t.classList.add(cls);
    switches.set(key, t);
    return t;
  };

  // Missing tracks: on or off for everyone, and the list (shown while it's
  // on, or while there's anything on it). AI models make songs up:
  // MusicBrainz knows which are real.
  const count = h('span.row-value');
  const listRow = row({ href: '/settings/missing', title: 'Missing tracks', subtitle: 'See them, export them, or check again', right: count, chevron: true, cls: 'missing-link' });
  const missing = toggle('missing', 'List what’s missing', 'From everyone’s AI playlists and Spotify imports.', 'owner-missing-on');
  const check = mbOffered() ? toggle('mbCheck', 'Check AI suggestions on MusicBrainz', `Leaves out songs the AI made up, checked on ${mbWhere()}.`, 'owner-mb-check') : null;

  // The MusicBrainz features, where the player has them.
  const kinds = row({ title: 'Missing albums shown', subtitle: kindsText(), chevron: true, onClick: () => chooseMissingKinds(paint), cls: 'mb-kinds-row' });
  const mb = mbFeatures()
    ? [
        h('div.section-head', null, h('h2', null, 'MusicBrainz')),
        h(
          'div.rows.owner-mb',
          null,
          toggle('mbMissingAlbums', 'Missing albums on artist pages', 'Albums, EPs and singles the library doesn’t have.', 'owner-mb-missing'),
          kinds,
          toggle('mbOriginalYears', 'Original release years', 'Sort and date albums by when they first came out.', 'owner-mb-years'),
          toggle('mbNamesakes', 'Artists of the same name', 'Separates albums by a different artist with the same name.', 'owner-mb-namesakes'),
          row({ href: '/settings/mbreview', title: 'Years and genres to fix', subtitle: 'Find albums with the wrong year or no genre, and fix them in Plex.' }),
          row({ href: '/settings/mbmerge', title: 'Artists to merge', subtitle: 'See artists Plex may have more than once.' }),
        ),
        h('p.hint.pad', null, `From ${mbWhere()}. Only artist names are sent.`),
      ]
    : [];

  function paint() {
    const now = features();
    for (const [key, t] of switches) t.querySelector('input').checked = now[key] === true;
    const n = missingCount();
    count.textContent = n ? fmt.number(n) : '';
    listRow.hidden = !now.missing && !n;
    if (check) check.hidden = !now.missing;
    kinds.querySelector('.row-sub').textContent = kindsText();
    kinds.hidden = !now.mbMissingAlbums;
  }
  el.append(
    h('p.lede', null, `On or off for everyone who plays from ${server} here.`),
    h('div.section-head', null, h('h2', null, 'Missing tracks')),
    h('div.rows.owner-missing', null, missing, check, listRow),
    ...mb,
  );
  paint();
  onDispose(on('features', paint));
  // (An AI playlist made meanwhile can add to the list.)
  onDispose(on('missing', paint));
}
