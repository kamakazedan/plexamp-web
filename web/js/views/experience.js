// Settings › Experience and its pages: Appearance, Player, Home screen,
// Quick skip times and Desktop integration. Laid out like Plexamp's own.
import { app, saveSettings } from '../state.js';
import { defaultDeviceName } from '../plex.js';
import { popOverlay, dropCached } from '../router.js';
import { h, icon, backHeader, row, sheet, toast, toggleRow, choiceRow, enableDrag } from '../ui.js';
import { homeLayout, saveHomeLayout, resetHomeLayout, sectionById } from '../home-sections.js';

const set = (key) => (v) => saveSettings({ [key]: v });
// Home and lists read these settings when they're built, so cached pages
// are dropped to show the change straight away.
const setAndRefresh = (key) => (v) => {
  saveSettings({ [key]: v });
  dropCached(() => true);
};

const GRID = [
  ['small', 'Small'],
  ['normal', 'Normal'],
  ['large', 'Large'],
];
const FONT = [
  ['small', 'Small'],
  ['normal', 'Normal'],
  ['large', 'Large'],
  ['larger', 'Larger'],
];
const RATINGS = [
  ['stars', 'Five stars', 'Rate tracks from one to five stars.'],
  ['half', 'Half stars', 'Five stars in halves: tap the left half of a star for half.'],
  ['thumbs', 'Thumbs', 'Thumbs up or down.'],
  ['off', 'Off', 'Don’t show ratings.'],
];
const TOP_SIZES = [
  [10, '10'],
  [25, '25'],
  [50, '50'],
  [100, '100'],
];
const SEEKBARS = [
  ['smooth', 'Smooth', 'The shape of the track’s loudness, filled in as it plays.'],
  ['bars', 'Bars', 'The track’s loudness as bars.'],
  ['simple', 'Simple', 'A plain line.'],
];
const BACKGROUNDS = [
  ['gradient', 'Album colours', 'A soft blend of colours from the album playing.'],
  ['artwork', 'Blurred artwork', 'The album cover, blurred.'],
  ['plain', 'Plain', 'A plain dark background.'],
];

// ---------- Experience ----------

export function experienceView({ el }) {
  const s = app.settings;
  // Only with more than one music library on the server: whether Search and
  // the Playlists tab cover the others too. (Film and TV playlists never
  // show: only music ones.)
  const libraries = h('div.rows-group', { hidden: true });
  app.server
    .musicSections()
    .then((secs) => {
      if (secs.length < 2) return;
      const here = app.source.sectionTitle;
      const others = secs.filter((x) => String(x.key) !== String(app.source.sectionKey)).map((x) => x.title);
      const list = others.length === 1 ? others[0] : `${others.slice(0, -1).join(', ')} and ${others.at(-1)}`;
      libraries.replaceChildren(
        toggleRow({
          title: 'Search all music libraries',
          subtitle: `Search ${list} too, not just ${here}.`,
          checked: s.searchAllLibraries,
          onChange: setAndRefresh('searchAllLibraries'),
        }),
        toggleRow({
          title: 'Playlists from all music libraries',
          subtitle: `The Playlists tab shows playlists of music from ${list} too. Off: only those with music from ${here}.`,
          checked: s.playlistsAllLibraries,
          onChange: setAndRefresh('playlistsAllLibraries'),
        }),
      );
      libraries.hidden = false;
    })
    .catch(() => {});
  el.append(
    backHeader('Experience', { fallback: '/settings' }),
    h(
      'div.rows.settings-rows',
      null,
      row({ href: '/settings/appearance', title: 'Appearance', subtitle: 'Background, colours and artwork.' }),
      row({ href: '/settings/player', title: 'Player', subtitle: 'What the player shows, and its controls.' }),
      row({ href: '/settings/home', title: 'Home screen', subtitle: 'Choose and order the sections on Home.' }),
      choiceRow({ title: 'Grid size', subtitle: 'Size of albums and playlists in grids and shelves.', options: GRID, value: s.gridSize, onChange: set('gridSize') }),
      choiceRow({ title: 'Font size', subtitle: 'Size of text throughout the app.', options: FONT, value: s.fontSize, onChange: set('fontSize') }),
      choiceRow({ title: 'Rating system', subtitle: 'How you rate tracks, in the player and in track lists.', options: RATINGS, value: s.ratingSystem, onChange: set('ratingSystem') }),
      toggleRow({ title: 'Ratings in track lists', subtitle: 'Rate tracks right in album, playlist and other track lists.', checked: s.listRatings, onChange: set('listRatings') }),
      toggleRow({
        title: 'Keep ❤️ Tracks up to date',
        subtitle: 'Tracks you give five stars or a thumbs up go in your ❤️ Tracks playlist, and come out if they lose that rating.',
        checked: s.lovedPlaylist,
        onChange: set('lovedPlaylist'),
      }),
      toggleRow({ title: 'Show album codec badges', subtitle: 'Show the format and resolution on album pages, like FLAC 24/96.', checked: s.codecBadges, onChange: setAndRefresh('codecBadges') }),
      toggleRow({ title: 'Show popular tracks', subtitle: 'Mark an album’s best-known tracks.', checked: s.popularTracks, onChange: setAndRefresh('popularTracks') }),
      choiceRow({ title: 'Top plays list size', subtitle: 'How many items the Most played lists in Search show.', options: TOP_SIZES, value: Number(s.topListSize) || 25, onChange: setAndRefresh('topListSize') }),
      toggleRow({ title: 'Show preview buttons', subtitle: 'A button on tracks for a 15-second listen, without changing what’s queued.', checked: s.previewButtons, onChange: setAndRefresh('previewButtons') }),
      libraries,
      toggleRow({
        title: '1-tap playback',
        subtitle: 'Tapping a track always plays it. Off: while something’s playing, choose to play it now, next or later.',
        checked: s.oneTapPlayback,
        onChange: set('oneTapPlayback'),
      }),
      toggleRow({ title: 'Sync recent plays', subtitle: 'Tell Plex what you play, so play counts and recent plays match on all your devices.', checked: s.reportPlays, onChange: set('reportPlays') }),
      row({ href: '/settings/desktop', title: 'Desktop integration', subtitle: 'Media keys, the tab title and keyboard shortcuts.' }),
      playerNameRow(),
    ),
  );
}

function playerNameRow() {
  const value = h('span.row-value', null, app.settings.playerName || defaultDeviceName());
  return row({
    title: 'Player name',
    subtitle: 'The name Plex shows for this player, in its dashboard and activity.',
    right: value,
    chevron: true,
    onClick: () => {
      const input = h('input', { type: 'text', maxlength: 60, value: app.settings.playerName || '', placeholder: defaultDeviceName(), 'aria-label': 'Player name', autocomplete: 'off' });
      const save = () => {
        const name = input.value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 60);
        saveSettings({ playerName: name });
        value.textContent = name || defaultDeviceName();
        popOverlay();
        toast(name ? `This player is now “${name}” in Plex.` : 'Player name reset.');
      };
      sheet({
        title: 'Player name',
        content: h(
          'form.form.sheet-form',
          { onsubmit: (e) => (e.preventDefault(), save()) },
          h('label.field', null, h('span', null, 'Name'), input),
          h('p.hint', null, 'Leave empty for the default name.'),
          h('div.form-actions', null, h('button.btn.btn-primary', { type: 'submit' }, 'Save')),
        ),
      });
      setTimeout(() => input.focus(), 250);
    },
  });
}

// ---------- Appearance ----------

export function appearanceView({ el }) {
  const s = app.settings;
  el.append(
    backHeader('Appearance', { fallback: '/settings/experience' }),
    h(
      'div.rows',
      null,
      toggleRow({
        title: 'Colour from artwork',
        subtitle: 'Tint the background and player with colours from the album that’s playing.',
        checked: s.tintBackground,
        onChange: set('tintBackground'),
      }),
      choiceRow({ title: 'Background', subtitle: 'Behind everything, while music plays.', options: BACKGROUNDS, value: s.backgroundStyle, onChange: set('backgroundStyle') }),
    ),
  );
}

// ---------- Player ----------

export function playerSettingsView({ el }) {
  const s = app.settings;
  const quickSub = () => `Show buttons to skip back ${Number(app.settings.skipBack) || 10} and forward ${Number(app.settings.skipForward) || 30} seconds.`;
  const quick = toggleRow({ title: 'Music quick skip', subtitle: quickSub(), checked: s.quickSkip, onChange: set('quickSkip') });
  el.append(
    backHeader('Player', { fallback: '/settings/experience' }),
    h(
      'div.rows',
      null,
      toggleRow({ title: 'Show codec', subtitle: 'Show the track’s format and quality under its title, like FLAC 24/96.', checked: s.showCodec !== false, onChange: set('showCodec') }),
      toggleRow({ title: 'Show rating', subtitle: 'Show your rating of the track under its title, to change it there.', checked: s.showRating !== false, onChange: set('showRating') }),
      toggleRow({ title: 'Show volume control', subtitle: 'Show the volume slider in the player.', checked: s.showVolume, onChange: set('showVolume') }),
      choiceRow({ title: 'Seekbar style', subtitle: 'How the playback position is drawn.', options: SEEKBARS, value: s.seekbarStyle, onChange: set('seekbarStyle') }),
      toggleRow({ title: 'Side by side layout', subtitle: 'On wide screens, show Up next beside the player.', checked: s.sideBySide, onChange: set('sideBySide') }),
      toggleRow({ title: 'Show album year', subtitle: 'Show the year after the album’s name.', checked: s.showAlbumYear, onChange: set('showAlbumYear') }),
      toggleRow({ title: 'Show full player', subtitle: 'Open the player when you start playing something.', checked: s.showFullPlayer, onChange: set('showFullPlayer') }),
      toggleRow({ title: 'Music playback speed', subtitle: 'Add a speed button to the player, from 0.5× to 2×.', checked: s.playbackSpeed, onChange: set('playbackSpeed') }),
      toggleRow({
        title: 'Use long-form controls',
        subtitle: 'For tracks over 20 minutes, like DJ mixes and audiobooks: show skip buttons, and carry on where you stopped.',
        checked: s.longForm,
        onChange: set('longForm'),
      }),
      quick,
      row({ href: '/settings/skip', title: 'Quick skip times', subtitle: 'How far the skip buttons jump.' }),
    ),
  );
}

export function skipTimesView({ el }) {
  const s = app.settings;
  const opts = (values) => values.map((v) => [v, `${v} seconds`]);
  el.append(
    backHeader('Quick skip times', { fallback: '/settings/player' }),
    h(
      'div.rows',
      null,
      choiceRow({ title: 'Skip back', options: opts([5, 10, 15, 30]), value: Number(s.skipBack) || 10, onChange: set('skipBack') }),
      choiceRow({ title: 'Skip forward', options: opts([10, 15, 30, 45, 60]), value: Number(s.skipForward) || 30, onChange: set('skipForward') }),
    ),
  );
}

// ---------- Desktop integration ----------

export function desktopView({ el }) {
  const s = app.settings;
  el.append(
    backHeader('Desktop integration', { fallback: '/settings/experience' }),
    h(
      'div.rows',
      null,
      toggleRow({
        title: 'Media keys and lock screen',
        subtitle: 'Control playback with your keyboard’s media keys, headphone buttons and your phone’s lock screen.',
        checked: s.mediaSession,
        onChange: set('mediaSession'),
      }),
      toggleRow({ title: 'Show what’s playing in the tab', subtitle: 'Put the track’s name in the browser tab’s title.', checked: s.tabTitle, onChange: set('tabTitle') }),
      toggleRow({
        title: 'Keyboard shortcuts',
        subtitle: 'Space plays and pauses, Shift+→ and Shift+← skip, and / goes to Search.',
        checked: s.keyboardShortcuts,
        onChange: set('keyboardShortcuts'),
      }),
    ),
  );
}

// ---------- Home screen ----------

export function homeEditorView({ el }) {
  const src = app.source;
  let layout = homeLayout();
  const list = h('div.rows.home-editor', { role: 'list' });
  const save = () => {
    saveHomeLayout(layout);
    dropCached((p) => p === '/');
  };

  const titleOf = (sec) => (sec.id === 'recentlyAdded' ? `Recently added in ${src.sectionTitle}` : sec.title);
  const subOf = (sec) => {
    if (layout.hidden.has(sec.id)) return 'Hidden';
    if (sec.periods) return `Showing ${sec.periods[layout.options[sec.id]?.period]?.label || ''}`;
    return sec.description;
  };

  function render() {
    list.replaceChildren(
      ...layout.order.map((id, i) => {
        const sec = sectionById(id);
        const hidden = layout.hidden.has(id);
        return h(
          `div.row.home-row${hidden ? '.is-hidden' : ''}`,
          { role: 'listitem', dataset: { id } },
          h('span.drag-handle', { title: 'Drag to reorder', 'aria-hidden': 'true' }, icon('grip', 22)),
          h(
            'button.home-row-main',
            { type: 'button', onclick: () => openSection(id), 'aria-label': `${titleOf(sec)}: ${subOf(sec)}. Position ${i + 1} of ${layout.order.length}.` },
            h('div.row-main', null, h('div.row-title', null, titleOf(sec)), h('div.row-sub', null, subOf(sec))),
            icon('chevronRight', 24, 'chev'),
          ),
        );
      }),
    );
  }

  function move(id, by) {
    const i = layout.order.indexOf(id);
    const j = i + by;
    if (j < 0 || j >= layout.order.length) return;
    layout.order.splice(j, 0, layout.order.splice(i, 1)[0]);
    save();
    render();
  }

  function openSection(id) {
    const sec = sectionById(id);
    const hidden = layout.hidden.has(id);
    const i = layout.order.indexOf(id);
    sheet({
      title: titleOf(sec),
      subtitle: sec.description,
      actions: [
        {
          icon: hidden ? 'home' : 'close',
          label: hidden ? 'Show on Home' : 'Hide from Home',
          onSelect: () => {
            if (hidden) layout.hidden.delete(id);
            else layout.hidden.add(id);
            save();
            render();
          },
        },
        ...(sec.periods
          ? Object.entries(sec.periods).map(([key, p]) => ({
              label: `Over ${p.label}`,
              checked: layout.options[id]?.period === key,
              onSelect: () => {
                layout.options[id] = { ...(layout.options[id] || {}), period: key };
                layout.hidden.delete(id);
                save();
                render();
              },
            }))
          : []),
        i > 0 && { icon: 'arrowUp', label: 'Move up', onSelect: () => move(id, -1) },
        i < layout.order.length - 1 && { icon: 'arrowDown', label: 'Move down', onSelect: () => move(id, 1) },
      ],
    });
  }

  enableDrag(list, {
    item: '.home-row',
    onDrop: ({ order }) => {
      layout.order = order.map((r) => r.dataset.id);
      save();
      render();
    },
  });

  el.append(
    backHeader('Home screen', { fallback: '/settings/experience' }),
    h('div.home-editor-source', null, h('div.home-editor-title', null, `Editing ${src.sectionTitle} (on ${src.serverName})`), h('div.home-editor-sub', null, 'Changes here apply to this library only. Drag to reorder; tap a section to show, hide or change it.')),
    list,
    h(
      'div.pad.home-editor-reset',
      null,
      h(
        'button.btn.btn-danger',
        {
          type: 'button',
          onclick: () => {
            resetHomeLayout();
            layout = homeLayout();
            dropCached((p) => p === '/');
            render();
            toast('Home is back to how it started.');
          },
        },
        'Reset order',
      ),
    ),
  );
  render();
}
