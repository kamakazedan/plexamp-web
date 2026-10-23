// Search › From Spotify: playlists made here from Spotify's (see
// spotify.js). The way that works for everyone: a guide to asking Spotify for
// a download of your data, and to choosing just its playlist files from it;
// then the playlists in them, to choose from; then the import
// (playlistfiles.js runImport), with the tracks that aren't in the library
// put on Missing tracks, unless that's turned off. And, with SPOTIFY_IMPORT
// on the container, a public playlist from its link: the link; then the
// playlist as Spotify has it, and a name for it here; then the import.
import { app } from '../state.js';
import { popOverlay } from '../router.js';
import { h, sheet, fmt, icon } from '../ui.js';
import { readSpotifyPlaylist, spotifyLinkKind, spotifyEntries, spotifyOffered, sortSpotifyFiles, readSpotifyFiles, SPOTIFY_PRIVACY_URL, LIKED_SONGS } from '../spotify.js';
import { runImport } from './playlistfiles.js';

const where = () => app.source?.sectionTitle || 'this library';
// Playlists by name ("Late night" and "late night " are one name).
const nameKey = (t) => String(t || '').trim().toLowerCase();

const NOT_A_LINK = 'That isn’t a link to a Spotify playlist. In Spotify, choose Share › Copy link to playlist, and paste that.';

// ---------- from Spotify's download of your data ----------

export function importFromSpotify() {
  let found = null; // the playlists read, once the guide has closed
  let byLink = false;
  const status = h('p.ask-message.spotify-status', { role: 'status' });
  const choose = h('button.btn.btn-primary.spotify-choose', { type: 'button', onclick: () => pickFiles(gotFiles) }, 'Choose the playlist files…');
  const step = (title, ...text) => h('li', null, h('span.spotify-step-title', null, title), h('span.spotify-step-text', null, ...text));
  sheet({
    title: 'From Spotify',
    content: h(
      'div.ask-form.import-form.spotify-guide',
      null,
      h(
        'p.ask-message',
        null,
        'Spotify only lets other apps read your playlists through its developer programme, which needs a Premium account and allows five people. But anyone can download their own data from Spotify, with every playlist they’ve made, however long, and that’s what’s used here.',
      ),
      h(
        'ol.spotify-steps',
        null,
        step(
          'Ask Spotify for your data',
          'On spotify.com, open your account’s Privacy settings, tick Account data under Download your data, and request it. Spotify emails you to confirm, then again when it’s ready, usually within a few days.',
          h(
            'a.btn.btn-secondary.spotify-privacy',
            { href: SPOTIFY_PRIVACY_URL, target: '_blank', rel: 'noopener noreferrer' },
            icon('external', 20),
            h('span', null, 'Spotify’s privacy settings'),
          ),
        ),
        step(
          'Open the ZIP it sends',
          'Inside is a file for each kind of data. Only two kinds are needed: ',
          h('code', null, 'Playlist1.json'),
          ' (with ',
          h('code', null, 'Playlist2.json'),
          ' and so on, if you have a lot of playlists), and ',
          h('code', null, 'YourLibrary.json'),
          ', with your Liked Songs.',
        ),
        step('Choose just those', 'The other files hold your personal details: your email, date of birth, address and phone number, your payment card, and what you’ve searched for and listened to. Leave them out.'),
      ),
      h(
        'p.spotify-private',
        null,
        `Only files with those names are opened, here on this device: any other is turned away unread. Of them, only each playlist’s name and each track’s title, artist and album are kept, and those go no further than ${app.source?.serverName || 'your Plex server'}, to find the tracks there and make the playlists you choose.`,
      ),
      status,
      choose,
      // (SPOTIFY_IMPORT on the container.)
      spotifyOffered()
        ? h(
            'div.spotify-or',
            null,
            h('p.ask-message', null, 'Or bring over a public playlist from its link, straight away: only its first 100 tracks, though.'),
            h(
              'button.btn.btn-secondary.spotify-by-link',
              {
                type: 'button',
                onclick: () => {
                  byLink = true;
                  popOverlay();
                },
              },
              'Use a link instead',
            ),
          )
        : null,
    ),
    variant: 'dialog',
    closeLabel: 'Close',
    // (Once this dialog has gone: the next opens one of its own.)
    onClose: () => {
      if (found) Promise.resolve().then(() => choosePlaylists(found));
      else if (byLink) Promise.resolve().then(() => fromLink());
    },
  });

  function say(text, warn = false) {
    status.textContent = text;
    status.classList.toggle('warn', warn);
  }

  async function gotFiles(files) {
    const { wanted, refused, zip } = sortSpotifyFiles(files);
    if (!wanted.length) {
      say(
        zip
          ? 'That’s the ZIP itself, so it wasn’t opened. Open it first, and choose the files inside it named Playlist1.json and YourLibrary.json.'
          : `${files.length === 1 ? 'That isn’t one of Spotify’s playlist files, so it wasn’t' : 'None of those are Spotify’s playlist files, so they weren’t'} opened. Choose the files named Playlist1.json (and Playlist2.json and so on) and YourLibrary.json.`,
        true,
      );
      return;
    }
    say('Reading your playlists…');
    choose.disabled = true;
    try {
      const list = await readSpotifyFiles(wanted);
      if (!list.some((p) => p.tracks.length)) return say('There are no tracks in those files.', true);
      found = { list, refused };
      popOverlay();
    } catch (err) {
      say(err.file ? err.message : 'Those files couldn’t be read.', true);
    } finally {
      choose.disabled = false;
    }
  }
}

// The file picker, for several at once (it only opens from a tap: call it
// straight from one).
let picker = null;
function pickFiles(then) {
  picker?.remove();
  picker = h('input.file-picker', { type: 'file', multiple: true, accept: '.json,application/json', hidden: true });
  const input = picker;
  input.addEventListener('change', () => {
    const files = [...(input.files || [])];
    input.remove();
    if (files.length) then(files);
  });
  input.addEventListener('cancel', () => input.remove());
  document.body.append(input);
  input.click();
}

// Which playlists to make: those with tracks, and not the name of one you
// have already, to begin with (chosen, one of those comes over as "Name
// (from Spotify)").
async function choosePlaylists({ list, refused }) {
  let have = new Set();
  try {
    have = new Set((await app.server.playlists()).map((p) => nameKey(p.title)));
  } catch {
    /* names aren't checked */
  }
  const named = (p) => (have.has(nameKey(p.title)) ? `${p.title} (from Spotify)` : p.title);
  const boxes = list.map((p) => {
    const taken = have.has(nameKey(p.title));
    const input = h('input', { type: 'checkbox', checked: !taken && p.tracks.length > 0, disabled: !p.tracks.length });
    const sub = [p.liked ? 'The songs you’ve liked' : '', p.tracks.length ? fmt.count(p.tracks.length, 'track', 'tracks') : 'No tracks', taken ? `you have one by this name: this would be “${named(p)}”` : '']
      .filter(Boolean)
      .join(' · ');
    const row = h('label.import-choice', null, input, h('span.import-choice-text', null, h('span.import-choice-title', null, p.title), h('span.import-choice-sub', null, sub)));
    return { p, input, row };
  });
  const keep = h('input', { type: 'checkbox', checked: true });
  let chosen = null;
  const go = h('button.btn.btn-primary', {
    type: 'button',
    onclick: () => {
      chosen = boxes.filter((b) => b.input.checked).map((b) => b.p);
      popOverlay();
    },
  });
  const usable = boxes.filter((b) => !b.input.disabled);
  const all = h('button.link-btn.spotify-all', {
    type: 'button',
    onclick: () => {
      const on = !usable.every((b) => b.input.checked);
      usable.forEach((b) => (b.input.checked = on));
      paint();
    },
  });
  const paint = () => {
    const n = boxes.filter((b) => b.input.checked).length;
    go.textContent = n ? `Import ${fmt.count(n, 'playlist', 'playlists')}` : 'Choose some to import';
    go.disabled = !n;
    all.textContent = usable.every((b) => b.input.checked) ? 'Choose none' : 'Choose all';
  };
  boxes.forEach((b) => b.input.addEventListener('change', paint));
  paint();
  const lists = list.filter((p) => !p.liked).length;
  sheet({
    title: 'Your playlists from Spotify',
    subtitle: [lists ? fmt.count(lists, 'playlist', 'playlists') : '', list.some((p) => p.liked) ? LIKED_SONGS : ''].filter(Boolean).join(' and '),
    content: h(
      'div.ask-form.import-form.spotify-choose-form',
      null,
      h(
        'p.ask-message',
        null,
        `Their tracks are looked for in ${where()} by title, artist and album, and those found make a playlist here, in the same order. Ones with the name of a playlist you have already aren’t chosen to begin with.`,
      ),
      refused.length ? h('p.spotify-refused', null, `Not opened, as they aren’t playlist files: ${refused.join(', ')}.`) : null,
      usable.length > 1 ? all : null,
      h('div.import-choices', null, boxes.map((b) => b.row)),
      h(
        'label.import-choice.spotify-keep',
        null,
        keep,
        h('span.import-choice-text', null, h('span.import-choice-title', null, 'Put what isn’t here on Missing tracks'), h('span.import-choice-sub', null, 'Listed in Settings › AI › Missing tracks, to go and find')),
      ),
      go,
    ),
    variant: 'dialog',
    closeLabel: 'Cancel',
    onClose: () => {
      if (!chosen?.length) return;
      const jobs = chosen.map((p) => ({ p: { title: p.title, tracks: p.tracks }, title: named(p), from: p.title }));
      Promise.resolve().then(() => runImport(jobs, { remember: keep.checked ? { via: 'spotify' } : null }));
    },
  });
}

// ---------- from a public playlist's link (SPOTIFY_IMPORT) ----------

function fromLink() {
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
