// Playlists to a file and back (see playlistio.js): exporting one from its
// menu, backing up all of yours, and importing from a file, with what was
// found and what wasn't.
import { app } from '../state.js';
import { navigate, describeError, popOverlay, refresh, parseHash } from '../router.js';
import { h, sheet, toast, askText, fmt, download, fileDate } from '../ui.js';
import { copyText, noteMissing } from '../missing.js';
import { refreshLists } from '../editing.js';
import { exportPlaylists, playlistJson, playlistFileName, readPlaylistFile, importPlaylist, entryLine, entryWhere, entryText, entriesCsv } from '../playlistio.js';

const where = () => app.source?.sectionTitle || 'this library';
// Playlists by name ("Late night" and "late night " are one name).
const nameKey = (t) => String(t || '').trim().toLowerCase();
const JSON_TYPE = 'application/json';

// One playlist, from its menu.
export async function exportPlaylistFile(pl) {
  toast(`Exporting “${pl.title}”…`, { timeout: 60000 });
  try {
    const data = await exportPlaylists([pl]);
    const p = data.playlists[0];
    download(playlistJson(data), playlistFileName(pl.title), JSON_TYPE);
    toast(
      p.more
        ? `Exported the first ${fmt.count(p.tracks.length, 'track', 'tracks')} of “${pl.title}” (a file holds no more)`
        : `Exported “${pl.title}”: ${fmt.count(p.tracks.length, 'track', 'tracks')}`,
    );
  } catch (err) {
    toast(describeError(err));
  }
}

// Every playlist of yours on this server (not smart ones: their rules are
// the server's), in one file.
export async function backUpPlaylists() {
  const ctrl = new AbortController();
  const status = h('p.ask-message.import-status', { role: 'status' }, 'Reading your playlists…');
  const box = sheet({
    title: 'Back up your playlists',
    content: h('div.ask-form.import-form', null, status),
    variant: 'dialog',
    closeLabel: 'Stop',
    onClose: () => ctrl.abort(),
  });
  const closeBtn = box.panel.querySelector('.dialog-close');
  try {
    app.server.forgetPlaylists();
    const mine = (await app.server.playlists()).filter((p) => !p.smart && (p.playlistType || 'audio') === 'audio');
    if (ctrl.signal.aborted) return;
    if (!mine.length) {
      status.textContent = 'You have no playlists of your own to back up. (Smart playlists aren’t included: their rules are kept by the server.)';
      closeBtn.textContent = 'Close';
      return;
    }
    const data = await exportPlaylists(mine, {
      signal: ctrl.signal,
      onProgress: (i, n, pl) => (status.textContent = `Reading “${pl.title}” (${fmt.number(i + 1)} of ${fmt.number(n)})…`),
    });
    download(playlistJson(data), `Playlists ${fileDate()}.playlist.json`, JSON_TYPE);
    const tracks = data.playlists.reduce((n, p) => n + p.tracks.length, 0);
    status.textContent = `Saved ${fmt.count(mine.length, 'playlist', 'playlists')} (${fmt.count(tracks, 'track', 'tracks')}) to a file. To bring them back, here or on another server, choose Import playlists… and pick the file. Smart playlists aren’t in it.`;
    closeBtn.textContent = 'Done';
  } catch (err) {
    if (ctrl.signal.aborted) return;
    status.textContent = describeError(err);
    status.classList.add('warn');
    closeBtn.textContent = 'Close';
  }
}

// ---------- import ----------

let picker = null;

// The file picker (it only opens from a tap: call it straight from one).
export function importPicker() {
  picker?.remove();
  picker = h('input.file-picker', { type: 'file', accept: '.json,application/json', hidden: true });
  const input = picker;
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    input.remove();
    if (file) importFile(file);
  });
  input.addEventListener('cancel', () => input.remove());
  document.body.append(input);
  input.click();
}

export async function importFile(file) {
  let data;
  try {
    data = await readPlaylistFile(file);
  } catch (err) {
    toast(err.file ? err.message : 'That file couldn’t be read.');
    return;
  }
  let have = new Set();
  try {
    have = new Set((await app.server.playlists()).map((p) => nameKey(p.title)));
  } catch {
    /* names aren't checked */
  }
  if (data.playlists.length === 1) {
    const p = data.playlists[0];
    const title = await askText({
      title: 'Import a playlist',
      label: 'Name',
      value: have.has(nameKey(p.title)) ? `${p.title} (imported)` : p.title,
      confirm: 'Import',
      maxLength: 200,
      message: `${fmt.count(p.tracks.length, 'track', 'tracks')}, looked for in ${where()}.${have.has(nameKey(p.title)) ? ` You have a playlist called “${p.title}” already.` : ''}`,
    });
    if (title) runImport([{ p, title }]);
    return;
  }
  const chosen = await choosePlaylists(data.playlists, have);
  if (chosen?.length) runImport(chosen.map((p) => ({ p, title: p.title })));
}

// Which of a backup's playlists to import: ones you don't have (by name)
// to begin with.
function choosePlaylists(list, have) {
  return new Promise((resolve) => {
    let chosen = null;
    const boxes = list.map((p) => {
      const mine = have.has(nameKey(p.title));
      const input = h('input', { type: 'checkbox', checked: !mine && p.tracks.length > 0 });
      const sub = [fmt.count(p.tracks.length, 'track', 'tracks'), mine ? 'you have one by this name' : '', p.smart ? 'a smart playlist, as it was' : ''].filter(Boolean).join(' · ');
      const row = h('label.import-choice', null, input, h('span.import-choice-text', null, h('span.import-choice-title', null, p.title), h('span.import-choice-sub', null, sub)));
      return { p, input, row };
    });
    const go = h('button.btn.btn-primary', {
      type: 'button',
      onclick: () => {
        chosen = boxes.filter((b) => b.input.checked).map((b) => b.p);
        popOverlay();
      },
    });
    const paint = () => {
      const n = boxes.filter((b) => b.input.checked).length;
      go.textContent = n ? `Import ${fmt.count(n, 'playlist', 'playlists')}` : 'Choose some to import';
      go.disabled = !n;
    };
    boxes.forEach((b) => b.input.addEventListener('change', paint));
    paint();
    sheet({
      title: 'Import playlists',
      subtitle: `${fmt.count(list.length, 'playlist', 'playlists')} in this file`,
      content: h(
        'div.ask-form.import-form',
        null,
        h('p.ask-message', null, `Their tracks are looked for in ${where()}. Ones with the name of a playlist you have already aren’t chosen to begin with.`),
        h('div.import-choices', null, boxes.map((b) => b.row)),
        go,
      ),
      variant: 'dialog',
      closeLabel: 'Cancel',
      onClose: () => resolve(chosen),
    });
  });
}

// Makes each, saying how it goes, and then what was found. `remember`:
// what isn't found goes on Missing tracks ({ via, from: what it was in }, or
// each job's own `from`, or its title), and what is comes off it.
export function runImport(jobs, { remember = null } = {}) {
  const ctrl = new AbortController();
  const status = h('p.ask-message.import-status', { role: 'status' }, 'Looking for the tracks…');
  const results = h('div.import-results');
  let made = 0;
  const box = sheet({
    title: jobs.length === 1 ? `Importing “${jobs[0].title}”` : `Importing ${fmt.count(jobs.length, 'playlist', 'playlists')}`,
    content: h('div.ask-form.import-form', null, status, results),
    variant: 'dialog',
    closeLabel: 'Stop',
    onClose: () => {
      ctrl.abort();
      if (!made) return;
      app.server.forgetPlaylists();
      refreshLists('playlist');
      if (parseHash().path === '/playlists') refresh();
    },
  });
  const closeBtn = box.panel.querySelector('.dialog-close');
  (async () => {
    const done = [];
    for (const [k, job] of jobs.entries()) {
      if (ctrl.signal.aborted) break;
      const lead = jobs.length > 1 ? `${fmt.number(k + 1)} of ${fmt.number(jobs.length)}, “${job.title}”: ` : '';
      status.textContent = `${lead}looking for the tracks…`;
      try {
        const r = await importPlaylist(job.p, {
          title: job.title,
          signal: ctrl.signal,
          onProgress: (n, of) => (status.textContent = `${lead}looking for the tracks… ${fmt.number(n)} of ${fmt.number(of)}`),
        });
        if (remember) {
          const gone = new Set(r.missing);
          const song = (e) => ({ kind: 'track', artist: e.artist || e.albumArtist || '', title: e.title });
          noteMissing(r.missing.map(song), { songs: job.p.tracks.filter((e) => !gone.has(e)).map(song), artists: [] }, remember.from || job.from || job.title, { via: remember.via });
          r.remembered = r.missing.length;
        }
        done.push({ job, ...r });
        if (r.playlist) made += 1;
      } catch (err) {
        if (ctrl.signal.aborted) break;
        done.push({ job, error: err });
      }
      results.replaceChildren(...done.map(resultRow));
    }
    if (ctrl.signal.aborted) {
      if (made) toast(`Stopped: ${fmt.count(made, 'playlist', 'playlists')} imported`);
      return;
    }
    const found = done.reduce((n, r) => n + (r.found || 0), 0);
    const missing = done.reduce((n, r) => n + (r.missing?.length || 0), 0);
    status.textContent = made
      ? `Imported ${fmt.count(made, 'playlist', 'playlists')}: ${fmt.count(found, 'track', 'tracks')} found in ${where()}${missing ? `, ${fmt.number(missing)} not` : ''}.`
      : 'Nothing was imported.';
    closeBtn.textContent = 'Done';
  })();
}

const SHOWN = 200;

// "They're on Missing tracks", where what wasn't found went there.
const rememberedNote = (r) =>
  r.remembered
    ? h(
        'p.import-remembered',
        null,
        `${r.remembered === 1 ? 'It’s' : 'They’re'} on Missing tracks now, to go and find. `,
        h('button.link-btn', { type: 'button', onclick: () => navigate('/settings/missing') }, 'See Missing tracks'),
      )
    : null;

function resultRow(r) {
  const title = r.job.title;
  if (r.error) return h('div.import-result.warn', null, h('div.import-result-title', null, title), h('div.import-result-sub', null, describeError(r.error)));
  if (!r.playlist) {
    return h(
      'div.import-result.warn',
      null,
      h('div.import-result-title', null, title),
      h('div.import-result-sub', null, r.missing.length ? `None of its ${fmt.count(r.missing.length, 'track is', 'tracks are')} in ${where()}, so it wasn’t made.` : 'It has no tracks, so it wasn’t made.'),
      rememberedNote(r),
    );
  }
  const of = r.found + r.missing.length;
  const id = r.playlist.ratingKey;
  return h(
    'div.import-result',
    null,
    h('button.link-btn.import-result-title', { type: 'button', onclick: () => navigate(`/playlist/${id}`) }, title),
    h('div.import-result-sub', null, r.missing.length ? `${fmt.number(r.found)} of ${fmt.count(of, 'track', 'tracks')} found; ${fmt.number(r.missing.length)} not in ${where()}` : `All ${fmt.count(of, 'track', 'tracks')} found`),
    r.missing.length
      ? h(
          'details.import-missing',
          null,
          h('summary', null, `Not found (${fmt.number(r.missing.length)})`),
          h(
            'ul',
            null,
            r.missing.slice(0, SHOWN).map((e) => h('li', null, h('span.import-missing-song', null, entryLine(e)), entryWhere(e) ? h('span.import-missing-where', null, entryWhere(e)) : null)),
          ),
          r.missing.length > SHOWN ? h('p.hint', null, `and ${fmt.number(r.missing.length - SHOWN)} more`) : null,
          h(
            'div.import-missing-actions',
            null,
            h(
              'button.link-btn',
              { type: 'button', onclick: async () => toast((await copyText(`${r.missing.map(entryText).join('\n')}\n`)) ? 'Copied: artist — title — album, one to a line' : 'Couldn’t copy here.') },
              'Copy the list',
            ),
            h(
              'button.link-btn',
              {
                type: 'button',
                onclick: () => {
                  download(entriesCsv(r.missing), `${playlistFileName(title).replace(/\.playlist\.json$/, '')} - not found.csv`, 'text/csv;charset=utf-8');
                  toast('Saved: artist, title, album, year, number and length of each');
                },
              },
              'Save as a spreadsheet (CSV)',
            ),
          ),
        )
      : null,
    rememberedNote(r),
  );
}
