// Search › From Spotify: playlists made here from Spotify's (see
// spotify.js), each way where it's turned on, on the container. With
// SPOTIFY_FILE_IMPORT, the way that works for everyone: a guide to asking
// Spotify for a download of your data, and to choosing just its playlist
// files from it; then the playlists in them, to choose from; then the
// import (playlistfiles.js runImport), with the tracks that aren't in the
// library put on Missing tracks, unless that's turned off. And, with
// SPOTIFY_LINK_IMPORT (SPOTIFY_IMPORT before 0.22.0), a public playlist
// from its link: the link; then the playlist as Spotify has it, and a name
// for it here; then the import (straight there, without the other).
import { app } from '../state.js';
import { popOverlay } from '../router.js';
import { h, sheet, fmt, icon } from '../ui.js';
import { readSpotifyPlaylist, spotifyLinkKind, spotifyEntries, spotifyOffered, spotifyFilesOffered, sortSpotifyFiles, readSpotifyFiles, SPOTIFY_PRIVACY_URL, LIKED_SONGS } from '../spotify.js';
import { runImport } from './playlistfiles.js';
import { missingKeptNote } from '../missing.js';
import { FILE_LIMITS } from '../playlistio.js';

const where = () => app.source?.sectionTitle || 'this library';
// Playlists by name ("Late night" and "late night " are one name).
const nameKey = (t) => String(t || '').trim().toLowerCase();

const NOT_A_LINK = 'That isn’t a link to a Spotify playlist. In Spotify, choose Share › Copy link to playlist, and paste that.';

// ---------- from Spotify's download of your data ----------

// The files named, for what's said about them ("Userdata.json and
// Payments.json").
const names = (list) => (list.length > 1 ? `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}` : list[0] || '');
const notOpened = (refused) =>
  refused.length ? `${names(refused)} ${refused.length === 1 ? 'wasn’t opened, as it isn’t a playlist file' : 'weren’t opened, as they aren’t playlist files'}.` : '';
const notRead = (tooBig) => (tooBig.length ? `${names(tooBig)} ${tooBig.length === 1 ? 'is' : 'are'} too big to read (over ${FILE_LIMITS.bytes / 1024 / 1024} MB).` : '');
const sentences = (...list) => list.filter(Boolean).join(' ');

export function importFromSpotify() {
  if (!spotifyFilesOffered()) {
    if (spotifyOffered()) fromLink();
    return;
  }
  let found = null; // the playlists read, once the guide has closed
  let byLink = false;
  let closed = false;
  let reading = false;
  const status = h('p.ask-message.spotify-status', { role: 'status' });
  const choose = h('button.btn.btn-primary.spotify-choose', { type: 'button', onclick: () => pickFiles(gotFiles) }, 'Choose the playlist files…');
  const linkBtn = spotifyOffered()
    ? h(
        'button.btn.btn-secondary.spotify-by-link',
        {
          type: 'button',
          onclick: () => {
            byLink = true;
            popOverlay();
          },
        },
        'Use a link instead',
      )
    : null;
  const step = (title, ...text) => h('li', null, h('span.spotify-step-title', null, title), h('span.spotify-step-text', null, ...text));
  const guide = h(
    'div.ask-form.import-form.spotify-guide',
    null,
    h(
      'p.ask-message',
      null,
      'Spotify doesn’t let apps like this read your playlists, but you can download them from Spotify yourself, however long they are.',
    ),
    h(
      'ol.spotify-steps',
      null,
      step(
        'Ask Spotify for your data',
        'In your Spotify account’s Privacy settings, tick Account data under Download your data and request it. It usually takes a few days.',
        h('a.btn.btn-secondary.spotify-privacy', { href: SPOTIFY_PRIVACY_URL, target: '_blank', rel: 'noopener noreferrer' }, icon('external', 20), h('span', null, 'Spotify’s privacy settings')),
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
      step('Choose just those', 'Leave the other files out: they hold your personal details.'),
    ),
    h(
      'p.spotify-private',
      null,
      `Only those files are opened, on this device. Just playlist names and track titles, artists and albums are kept, to find them on ${app.source?.serverName || 'your Plex server'}.`,
    ),
    status,
    choose,
    // (SPOTIFY_LINK_IMPORT on the container.)
    linkBtn ? h('div.spotify-or', null, h('p.ask-message', null, 'Or bring over a public playlist from its link: its first 100 tracks only.'), linkBtn) : null,
  );
  const { panel } = sheet({
    title: 'From Spotify',
    content: guide,
    variant: 'dialog',
    closeLabel: 'Close',
    // (Once this dialog has gone: the next opens one of its own.)
    onClose: () => {
      closed = true;
      if (found) Promise.resolve().then(() => choosePlaylists(found));
      else if (byLink) Promise.resolve().then(() => fromLink());
    },
  });
  // Files dropped anywhere on it (the dialog, or the page around it) are
  // taken as chosen. (Elsewhere, a file dropped does nothing: app.js.)
  const scrim = panel.parentElement;
  scrim.addEventListener('dragover', (e) => e.preventDefault());
  scrim.addEventListener('drop', (e) => {
    e.preventDefault();
    const files = [...(e.dataTransfer?.files || [])];
    if (files.length && !reading && !closed) gotFiles(files);
  });

  function say(text, warn = false) {
    status.textContent = text;
    status.classList.toggle('warn', warn);
  }

  function busy(on) {
    reading = on;
    choose.disabled = on;
    if (linkBtn) linkBtn.disabled = on;
  }

  async function gotFiles(files) {
    const { wanted, refused, zip } = sortSpotifyFiles(files);
    if (!wanted.length) {
      say(
        zip && files.length === 1
          ? 'That’s the ZIP itself, so it wasn’t opened. Open it first, and choose the files inside it named Playlist1.json and YourLibrary.json.'
          : `${files.length === 1 ? 'That isn’t one of Spotify’s playlist files, so it wasn’t' : 'None of those are Spotify’s playlist files, so they weren’t'} opened. Choose the files named Playlist1.json (and Playlist2.json and so on) and YourLibrary.json${zip ? ', from inside the ZIP' : ''}.`,
        true,
      );
      return;
    }
    say('Reading your playlists…');
    busy(true);
    try {
      const read = await readSpotifyFiles(wanted);
      if (closed) return;
      if (!read.playlists.some((p) => p.of)) return say(sentences(`There are no tracks in ${names(read.files)}.`, notRead(read.tooBig), notOpened(refused)), true);
      // The names of the playlists you have, to choose by (null: they
      // couldn't be had).
      let have = null;
      try {
        have = new Set((await app.server.playlists()).map((p) => nameKey(p.title)));
      } catch {
        /* names aren't checked */
      }
      if (closed) return;
      found = { ...read, refused, have };
      popOverlay();
    } catch (err) {
      if (!closed) say(sentences(err.file ? err.message : `${wanted.length === 1 ? 'That file' : 'Those files'} couldn’t be read.`, notOpened(refused)), true);
    } finally {
      busy(false);
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
  const done = () => {
    input.remove();
    if (picker === input) picker = null;
  };
  input.addEventListener('change', () => {
    const files = [...(input.files || [])];
    done();
    if (files.length) then(files);
  });
  input.addEventListener('cancel', done);
  document.body.append(input);
  input.click();
}

// A name of its own here: the playlist's, unless you have one by it, then
// "Name (from Spotify)", "Name (from Spotify 2)" and so on.
function freeName(title, taken) {
  if (!taken.has(nameKey(title))) return title;
  for (let n = 1; ; n++) {
    const t = `${title} (from Spotify${n > 1 ? ` ${n}` : ''})`;
    if (!taken.has(nameKey(t))) return t;
  }
}

// How many tracks a playlist has, and how many come over, if not all: cut
// short at the most for one playlist, or at the most in all, when choosing
// its file on its own (`alone`) may bring the rest.
function sizeOf(p, files) {
  if (!p.of) return 'No tracks';
  if (p.tracks.length === p.of) return fmt.count(p.of, 'track', 'tracks');
  const most = Math.min(p.of, FILE_LIMITS.tracks);
  if (p.tracks.length === most) return `The first ${fmt.number(most)} of its ${fmt.count(p.of, 'track', 'tracks')}, the most one playlist can bring over`;
  const how = p.alone && files.length > 1 ? `with the rest. Choose ${p.file} on its own for ${most < p.of ? `its first ${fmt.number(most)}` : 'it'}` : 'at once';
  return p.tracks.length
    ? `The first ${fmt.number(p.tracks.length)} of its ${fmt.count(p.of, 'track', 'tracks')}, as many as can come over ${how}`
    : `${fmt.count(p.of, 'track', 'tracks')}: more than can come over ${how}`;
}

// Which playlists to make: those with tracks, and not the name of one you
// have already, to begin with. Each made gets a name of its own (freeName),
// shown as they're chosen.
function choosePlaylists({ playlists, tooBig, more, moreIn, moreAlone, files, refused, have }) {
  const taken = have || new Set();
  const counts = new Map();
  for (const p of playlists) counts.set(nameKey(p.title), (counts.get(nameKey(p.title)) || 0) + 1);
  const boxes = playlists.map((p) => {
    const mine = taken.has(nameKey(p.title));
    const input = h('input', { type: 'checkbox', checked: !mine && p.tracks.length > 0, disabled: !p.tracks.length });
    const sub = h('span.import-choice-sub');
    const why = [mine ? 'you have one by this name' : '', counts.get(nameKey(p.title)) > 1 ? 'another of these has the same name' : ''].filter(Boolean).join(', and ');
    const row = h('label.import-choice', null, input, h('span.import-choice-text', null, h('span.import-choice-title', null, p.title), sub));
    return { p, input, sub, why, name: p.title, row };
  });
  // The name each would have, chosen as they are now: what you have, and
  // what those before it that are chosen have, is taken (as the import
  // names them). One not chosen: what it would have, chosen.
  const nameEach = () => {
    const used = new Set(taken);
    for (const b of boxes) {
      b.name = freeName(b.p.title, used);
      if (b.input.checked) used.add(nameKey(b.name));
      const note = b.name !== b.p.title ? `${b.why || 'another of these would have this name'}: this would be “${b.name}”` : b.why;
      b.sub.textContent = [b.p.liked ? 'The songs you’ve liked' : '', sizeOf(b.p, files), note].filter(Boolean).join(' · ');
    }
  };
  const keep = h('input', { type: 'checkbox', checked: true });
  let chosen = null;
  const go = h('button.btn.btn-primary', {
    type: 'button',
    onclick: () => {
      nameEach();
      chosen = boxes.filter((b) => b.input.checked).map((b) => ({ p: b.p, title: b.name }));
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
    nameEach();
  };
  boxes.forEach((b) => b.input.addEventListener('change', paint));
  paint();
  const lists = playlists.filter((p) => !p.liked).length;
  // What wasn't read: files turned away, or too big, and playlists past
  // the most that can be read at once (and where to find them, when
  // choosing their files on their own would list them).
  const passed = sentences(
    notOpened(refused),
    notRead(tooBig),
    more ? `${fmt.count(more, 'more playlist isn’t', 'more playlists aren’t')} listed: there are more than can be read at once.` : '',
    more && moreAlone && moreIn.length ? `Choose ${moreIn.length === 1 ? moreIn[0] : `each of ${names(moreIn)}`} on its own for ${more === 1 ? 'it' : 'them'}.` : '',
  );
  sheet({
    title: 'Your playlists from Spotify',
    subtitle: [lists ? fmt.count(lists, 'playlist', 'playlists') : '', playlists.some((p) => p.liked) ? LIKED_SONGS : ''].filter(Boolean).join(' and '),
    content: h(
      'div.ask-form.import-form.spotify-choose-form',
      null,
      h(
        'p.ask-message',
        null,
        `Their tracks are looked for in ${where()} by title, artist and album, and those found make a playlist here, in the same order.${have ? ' Ones with the name of a playlist you have already aren’t chosen to begin with.' : ''}`,
      ),
      passed ? h('p.spotify-refused', null, passed) : null,
      usable.length > 1 ? all : null,
      h('div.import-choices', null, boxes.map((b) => b.row)),
      h(
        'label.import-choice.spotify-keep',
        null,
        keep,
        h('span.import-choice-text', null, h('span.import-choice-title', null, 'Put what isn’t here on Missing tracks'), h('span.import-choice-sub', null, `Listed in Settings › AI › Missing tracks, to go and find${missingKeptNote() ? `.${missingKeptNote()}` : ''}`)),
      ),
      go,
    ),
    variant: 'dialog',
    closeLabel: 'Cancel',
    onClose: () => {
      if (!chosen?.length) return;
      const jobs = chosen.map(({ p, title }) => ({ p: { title: p.title, tracks: p.tracks }, title, from: p.title }));
      Promise.resolve().then(() => runImport(jobs, { remember: keep.checked ? { via: 'spotify' } : null }));
    },
  });
}

// ---------- from a public playlist's link (SPOTIFY_LINK_IMPORT) ----------

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
        h('span.import-choice-text', null, h('span.import-choice-title', null, 'Put what isn’t here on Missing tracks'), h('span.import-choice-sub', null, `Listed in Settings › AI › Missing tracks, to go and find${missingKeptNote() ? `.${missingKeptNote()}` : ''}`)),
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
