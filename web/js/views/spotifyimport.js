// Search › From Spotify: a Spotify playlist made here, from its link (see
// spotify.js). The link; then the playlist as Spotify has it, and a name for
// it here; then the import (playlistfiles.js runImport), with the tracks
// that aren't in the library put on Missing tracks, unless that's turned
// off for this one.
import { app } from '../state.js';
import { popOverlay } from '../router.js';
import { h, sheet, fmt } from '../ui.js';
import { readSpotifyPlaylist, spotifyLinkKind, spotifyEntries } from '../spotify.js';
import { runImport } from './playlistfiles.js';

const where = () => app.source?.sectionTitle || 'this library';
// Playlists by name ("Late night" and "late night " are one name).
const nameKey = (t) => String(t || '').trim().toLowerCase();

const NOT_A_LINK = 'That isn’t a link to a Spotify playlist. In Spotify, choose Share › Copy link to playlist, and paste that.';

export function importFromSpotify() {
  let ctrl = null;
  let found = null; // the playlist, once it's read
  let chosen = null; // what to import, once the dialog has closed
  let name = null;
  let keep = null;
  const input = h('input', { type: 'url', inputmode: 'url', autocomplete: 'off', spellcheck: 'false', maxLength: 500, placeholder: 'https://open.spotify.com/playlist/…' });
  const status = h('p.ask-message.spotify-status', { role: 'status' });
  const next = h('button.btn.btn-primary', { type: 'submit' }, 'Next');
  const form = h(
    'form.ask-form.spotify-form',
    {
      onsubmit: (e) => {
        e.preventDefault();
        if (found) make();
        else look();
      },
    },
    h('p.ask-message', null, 'In Spotify, open a public playlist and choose Share › Copy link to playlist, then paste it here. Spotify’s public page lists a playlist’s first 100 tracks at most.'),
    h('label.field', null, h('span', null, 'Link to a Spotify playlist'), input),
    status,
    next,
  );
  sheet({
    title: 'From Spotify',
    content: form,
    variant: 'dialog',
    closeLabel: 'Cancel',
    onClose: () => {
      ctrl?.abort();
      // (Once this dialog has gone: the import opens one of its own.)
      if (chosen) Promise.resolve().then(() => runImport([{ p: chosen.p, title: chosen.title }], { remember: chosen.remember }));
    },
  });
  setTimeout(() => input.focus(), 60);

  function say(text, warn = false) {
    status.textContent = text;
    status.classList.toggle('warn', warn);
  }

  async function look() {
    const text = input.value.trim();
    if (!text) return input.focus();
    const kind = spotifyLinkKind(text);
    if (!kind) return say(NOT_A_LINK, true);
    if (kind === 'other') return say('That’s a link to something else on Spotify (an album, a song, an artist or a podcast). Only playlists can be brought over.', true);
    ctrl?.abort();
    const mine = (ctrl = new AbortController());
    say('Reading it on Spotify…');
    next.disabled = true;
    try {
      const pl = await readSpotifyPlaylist(text, { signal: mine.signal });
      if (mine.signal.aborted) return;
      if (!pl.tracks.length) return say('Spotify’s page for that playlist has no tracks in it.', true);
      found = pl;
      await showPlaylist(pl);
    } catch (err) {
      if (!mine.signal.aborted) say(err.message || 'It couldn’t be read.', true);
    } finally {
      next.disabled = false;
    }
  }

  async function showPlaylist(pl) {
    let have = new Set();
    try {
      have = new Set((await app.server.playlists()).map((p) => nameKey(p.title)));
    } catch {
      /* names aren't checked */
    }
    const taken = have.has(nameKey(pl.name));
    name = h('input', { type: 'text', value: taken ? `${pl.name} (from Spotify)` : pl.name, maxLength: 200, autocomplete: 'off', spellcheck: 'false' });
    keep = h('input', { type: 'checkbox', checked: true });
    const length = pl.tracks.reduce((ms, t) => ms + (t.duration || 0), 0);
    form.replaceChildren(
      h(
        'div.spotify-found',
        null,
        h('div.spotify-found-title', null, pl.name),
        h('div.spotify-found-sub', null, [pl.owner ? `By ${pl.owner}` : '', fmt.count(pl.tracks.length, 'track', 'tracks'), fmt.long(length)].filter(Boolean).join(' · ')),
      ),
      h(
        'p.ask-message',
        null,
        `Each is looked for in ${where()} by its title, artist and length, and those found make a playlist here, in the same order.` +
          (pl.capped ? ' Spotify’s public page lists a playlist’s first 100 tracks, so any after those aren’t in it.' : '') +
          (taken ? ` You have a playlist called “${pl.name}” already.` : ''),
      ),
      h('label.field', null, h('span', null, 'Name'), name),
      h(
        'label.import-choice.spotify-keep',
        null,
        keep,
        h('span.import-choice-text', null, h('span.import-choice-title', null, 'Put what isn’t here on Missing tracks'), h('span.import-choice-sub', null, 'Listed in Settings › AI › Missing tracks, to go and find')),
      ),
      h('button.btn.btn-primary', { type: 'submit' }, 'Make the playlist'),
    );
    setTimeout(() => {
      name.focus();
      name.select();
    }, 30);
  }

  function make() {
    const title = name.value.trim();
    if (!title) return name.focus();
    chosen = { p: { title, tracks: spotifyEntries(found) }, title, remember: keep.checked ? { via: 'spotify', from: found.name } : null };
    popOverlay();
  }
}
