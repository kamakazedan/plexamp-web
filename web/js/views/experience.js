// Settings › Experience and its pages: Appearance, Player, Home screen,
// Quick skip times and Desktop integration. Laid out like Plexamp's own.
import { app, saveSettings } from '../state.js';
import { defaultDeviceName } from '../plex.js';
import { popOverlay, dropCached } from '../router.js';
import { h, icon, backHeader, row, sheet, toast, toggleRow, choiceRow, enableDrag } from '../ui.js';
import { homeLayout, saveHomeLayout, resetHomeLayout, sectionById } from '../home-sections.js';
import { ratingMode } from '../ratings.js';

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
  ['tick', 'Favourite', 'Tick the tracks you love (five stars in Plex).'],
  ['stars', 'Five stars', 'One to five stars.'],
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
  ['smooth', 'Smooth', 'The track’s shape, filled in as it plays.'],
  ['bars', 'Bars', 'The track’s loudness as bars.'],
  ['simple', 'Simple', 'A plain line.'],
];
const BACKGROUNDS = [
  ['gradient', 'Album colours', 'Colours from the album playing.'],
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
          subtitle: `Also search ${list}.`,
          checked: s.searchAllLibraries,
          onChange: setAndRefresh('searchAllLibraries'),
        }),
        toggleRow({
          title: 'Playlists from all music libraries',
          subtitle: `Also show playlists from ${list}.`,
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
      choiceRow({ title: 'Grid size', subtitle: 'How big album and playlist covers are.', options: GRID, value: s.gridSize, onChange: set('gridSize') }),
      choiceRow({ title: 'Font size', options: FONT, value: s.fontSize, onChange: set('fontSize') }),
      choiceRow({ title: 'Rating system', subtitle: 'Choose how you rate tracks.', options: RATINGS, value: ratingMode(), onChange: set('ratingSystem') }),
      toggleRow({ title: 'Ratings in track lists', subtitle: 'Show the rating system in albums, playlists, etc.', checked: s.listRatings, onChange: set('listRatings') }),
      toggleRow({
        title: 'Keep ❤️ Tracks up to date',
        subtitle: 'Tracks your favourites, updates the ❤️ Tracks playlist automatically.',
        checked: s.lovedPlaylist,
        onChange: set('lovedPlaylist'),
      }),
      toggleRow({
        title: 'Show codec information',
        subtitle: 'Show quality badges e.g. FLAC 24/96 across the app.',
        checked: s.codecInfo !== false,
        onChange: setAndRefresh('codecInfo'),
      }),
      toggleRow({ title: 'Show popular tracks', subtitle: 'Mark an album’s best-known tracks.', checked: s.popularTracks, onChange: setAndRefresh('popularTracks') }),
      choiceRow({ title: 'Top plays list size', subtitle: 'Length of the Most played lists in Search.', options: TOP_SIZES, value: Number(s.topListSize) || 25, onChange: setAndRefresh('topListSize') }),
      toggleRow({ title: 'Show preview buttons', subtitle: 'Hear 15 seconds of a track without queueing it.', checked: s.previewButtons, onChange: setAndRefresh('previewButtons') }),
      libraries,
      toggleRow({
        title: '1-tap playback',
        subtitle: 'Tap a track to play it. Off: choose now, next or later.',
        checked: s.oneTapPlayback,
        onChange: set('oneTapPlayback'),
      }),
      toggleRow({ title: 'Sync recent plays', subtitle: 'Tell Plex what you play, so play counts match everywhere.', checked: s.reportPlays, onChange: set('reportPlays') }),
      row({ href: '/settings/desktop', title: 'Desktop integration', subtitle: 'Media keys, the tab title and keyboard shortcuts.' }),
      playerNameRow(),
    ),
  );
}

function playerNameRow() {
  const value = h('span.row-value', null, app.settings.playerName || defaultDeviceName());
  return row({
    title: 'Player name',
    subtitle: 'How this player shows up in Plex.',
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
        subtitle: 'Tint the app with the playing album’s colours.',
        checked: s.tintBackground,
        onChange: set('tintBackground'),
      }),
      choiceRow({ title: 'Background', subtitle: 'Shown while music plays.', options: BACKGROUNDS, value: s.backgroundStyle, onChange: set('backgroundStyle') }),
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
      toggleRow({ title: 'Show rating', subtitle: 'Rate the playing track from the player.', checked: s.showRating !== false, onChange: set('showRating') }),
      toggleRow({ title: 'Show volume control', checked: s.showVolume, onChange: set('showVolume') }),
      choiceRow({ title: 'Seekbar style', options: SEEKBARS, value: s.seekbarStyle, onChange: set('seekbarStyle') }),
      toggleRow({ title: 'Side by side layout', subtitle: 'On wide screens, show Up next beside the player.', checked: s.sideBySide, onChange: set('sideBySide') }),
      toggleRow({ title: 'Show album year', checked: s.showAlbumYear, onChange: set('showAlbumYear') }),
      toggleRow({ title: 'Show full player', subtitle: 'Open the player when music starts.', checked: s.showFullPlayer, onChange: set('showFullPlayer') }),
      toggleRow({ title: 'Music playback speed', subtitle: 'A speed button, from 0.5× to 2×.', checked: s.playbackSpeed, onChange: set('playbackSpeed') }),
      toggleRow({ title: 'Sleep timer', subtitle: 'Stop playing after a while, or at the end of a track.', checked: s.sleepTimer, onChange: set('sleepTimer') }),
      toggleRow({
        title: 'Use long-form controls',
        subtitle: 'For tracks over 20 minutes: skip buttons, and resume where you stopped.',
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
        subtitle: 'Control music from media keys, headphones and the lock screen.',
        checked: s.mediaSession,
        onChange: set('mediaSession'),
      }),
      toggleRow({ title: 'Show what’s playing in the tab', checked: s.tabTitle, onChange: set('tabTitle') }),
      toggleRow({
        title: 'Keyboard shortcuts',
        subtitle: 'Space to play or pause, Shift+← and Shift+→ to skip, / to search.',
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
    h(
      'div.home-editor-source',
      null,
      h('div.home-editor-title', null, 'Your Home screen'),
      h('div.home-editor-sub', null, 'Drag to reorder. Tap a section to show, hide or change it.'),
    ),
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
