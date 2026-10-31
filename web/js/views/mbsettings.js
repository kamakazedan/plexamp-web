// Settings › MusicBrainz, where the player has its MusicBrainz features
// (mb.js): each on or off (for you, on all your devices where settings
// follow your account), which kinds of an artist's missing albums are
// shown, and for the server's owner, a look through the library for the
// years and genres to fix in Plex (mbreview.js), and the artists Plex has
// more than once, to merge there (mbmerge.js). (Skip live tracks and
// demos, which these add to, is in Settings › Playback, for everyone.)
import { app, saveSettings } from '../state.js';
import { dropCached } from '../router.js';
import { h, backHeader, row, toggleRow, sheet } from '../ui.js';
import { RELEASE_KINDS, MISSING_KINDS } from '../mb.js';
import { mbWhere } from '../missing.js';
import { isAdmin } from '../editing.js';

// The kinds of an artist's missing albums shown (mb.js RELEASE_KINDS ids).
export const missingKinds = () => (Array.isArray(app.settings.mbMissingKinds) ? app.settings.mbMissingKinds : MISSING_KINDS);

const kindsText = () => {
  const k = missingKinds();
  if (k.length === RELEASE_KINDS.length) return 'All';
  return RELEASE_KINDS.filter(([id]) => k.includes(id)).map(([, name]) => name).join(', ') || 'None';
};

// Artist and album pages read these as they're built: those kept to go
// back to are built again.
const rebuild = () => dropCached((p) => p.startsWith('/artist/') || p.startsWith('/album/'));

// The kinds shown, chosen in a sheet (`after`: once one changes).
export function chooseMissingKinds(after) {
  const set = (id, on) => {
    const now = new Set(missingKinds());
    if (on) now.add(id);
    else now.delete(id);
    saveSettings({ mbMissingKinds: RELEASE_KINDS.map(([k]) => k).filter((k) => now.has(k)) });
    rebuild();
    after?.();
  };
  sheet({
    title: 'Missing albums shown',
    subtitle: 'Which kinds to show',
    variant: 'dialog',
    content: h('div.rows.mb-kinds', null, RELEASE_KINDS.map(([id, name]) => toggleRow({ title: name, checked: missingKinds().includes(id), onChange: (v) => set(id, v) }))),
  });
}

export async function musicbrainzSettingsView({ el }) {
  const s = app.settings;
  const admin = await isAdmin().catch(() => false);
  // (The kinds chosen as its subtitle: too many to fit beside its name.)
  const kinds = row({ title: 'Missing albums shown', subtitle: kindsText(), chevron: true, onClick: () => chooseMissingKinds(paint), cls: 'mb-kinds-row' });
  function paint() {
    kinds.querySelector('.row-sub').textContent = kindsText();
    kinds.hidden = app.settings.mbMissingAlbums === false;
  }
  paint();
  const set = (key) => (v) => {
    saveSettings({ [key]: v });
    rebuild();
    paint();
  };
  el.append(
    backHeader('MusicBrainz', { fallback: '/settings' }),
    h(
      'p.lede',
      null,
      `Extras from ${mbWhere()}. Only artist names are sent.`,
    ),
    h(
      'div.rows',
      null,
      toggleRow({
        title: 'Missing albums on artist pages',
        subtitle: 'Albums, EPs and singles you don’t have yet.',
        checked: s.mbMissingAlbums !== false,
        onChange: set('mbMissingAlbums'),
      }),
      kinds,
      toggleRow({
        title: 'Original release years',
        subtitle: 'Sort and date albums by when they first came out.',
        checked: s.mbOriginalYears !== false,
        onChange: set('mbOriginalYears'),
      }),
      toggleRow({
        title: 'Artists of the same name',
        subtitle: 'Separates albums by a different artist with the same name.',
        checked: s.mbNamesakes !== false,
        onChange: set('mbNamesakes'),
      }),
    ),
    h('p.hint.pad', null, 'Imports and missing tracks also find artists by their other names.'),
    admin
      ? h(
          'div',
          null,
          h('div.section-head', null, h('h2', null, 'Your library')),
          h('p.hint.pad', null, 'These change Plex for everyone, when you say so.'),
          h(
            'div.rows',
            null,
            row({
              href: '/settings/mbreview',
              title: 'Years and genres to fix',
              subtitle: 'Find albums with the wrong year or no genre, and fix them in Plex.',
            }),
            row({
              href: '/settings/mbmerge',
              title: 'Artists to merge',
              subtitle: 'Find artists Plex has more than once, and merge them.',
            }),
          ),
        )
      : null,
  );
}
