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
    subtitle: 'Of an artist’s albums that MusicBrainz has and your library hasn’t, on their page',
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
      `This player looks your artists and albums up on ${mbWhere()} for these, and keeps what it says for a month. Only names go to it: artists’ (an album’s title is matched here, with what MusicBrainz says of its artist).`,
    ),
    h(
      'div.rows',
      null,
      toggleRow({
        title: 'Missing albums on artist pages',
        subtitle: 'An artist’s albums, EPs and singles that MusicBrainz has and your library hasn’t, under Not in your library on their page, to download or copy.',
        checked: s.mbMissingAlbums !== false,
        onChange: set('mbMissingAlbums'),
      }),
      kinds,
      toggleRow({
        title: 'Original release years',
        subtitle: 'An artist’s albums in the order they first came out, with that year (a remaster’s or reissue’s is often the year it was reissued in Plex), and an album’s first year on its page.',
        checked: s.mbOriginalYears !== false,
        onChange: set('mbOriginalYears'),
      }),
      toggleRow({
        title: 'Artists of the same name',
        subtitle: 'Where Plex has two artists of one name as one, the other’s albums kept apart on the artist’s page, under Another artist called…, and out of its Play, Shuffle and Popular tracks. Only where MusicBrainz plainly has each album as the other’s, by its title and year.',
        checked: s.mbNamesakes !== false,
        onChange: set('mbNamesakes'),
      }),
    ),
    h('p.hint.pad', null, 'An artist who isn’t found by their name (importing a playlist, checking Missing tracks again) is looked for by the other names MusicBrainz has for them too: other spellings and scripts, what they were called before.'),
    h('p.hint.pad', null, 'Skip live tracks and demos (in Settings › Playback) goes by MusicBrainz too, for an album Plex hasn’t said the kind of. What’s in your library is shown as Plex has it: MusicBrainz never changes which kind an album is.'),
    admin
      ? h(
          'div',
          null,
          h('div.section-head', null, h('h2', null, 'Your library')),
          h(
            'div.rows',
            null,
            row({
              href: '/settings/mbreview',
              title: 'Years and genres to fix',
              subtitle: 'Your albums whose year in Plex isn’t the year they first came out, and those without a genre that MusicBrainz has genres for: fixed in Plex for everyone, or downloaded for MusicBrainz Picard or beets to fix the files.',
            }),
            row({
              href: '/settings/mbmerge',
              title: 'Artists to merge',
              subtitle: 'Artists Plex has more than once (the same name twice, or in a name of several artists’, as “Alphabeat;FORCE”), merged in Plex with your OK where MusicBrainz plainly has them as one.',
            }),
          ),
        )
      : null,
  );
}
