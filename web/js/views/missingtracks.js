// Settings › AI › Missing tracks: the songs and artists AI playlists
// suggested that the library doesn't have, to export and go looking for.
import { app, on } from '../state.js';
import { describeError } from '../router.js';
import { h, icon, backHeader, row, sectionHeader, emptyState, iconButton, toast, fmt, confirmAction } from '../ui.js';
import { missingList, forgetMissing, clearMissing, checkMissingAgain, missingCsv, missingText, download, copyText, fileDate, mbOn } from '../missing.js';
import { aiSettings } from '../ai.js';

export function missingTracksView({ el, onDispose }) {
  el.append(
    backHeader('Missing tracks', { fallback: '/settings/ai' }),
    h(
      'p.lede',
      null,
      mbOn()
        ? 'Songs and artists that AI playlists suggested but your library doesn’t have, kept on this device so you can go and find them. AI playlists check what they suggest on MusicBrainz before it goes on this list, and leave out what MusicBrainz doesn’t know (most likely made up).'
        : 'Songs and artists that AI playlists suggested but your library doesn’t have, kept on this device so you can go and find them. AI models sometimes suggest songs that don’t exist, so check before you go looking.',
    ),
  );
  const actions = h('div.pad.button-row.missing-actions');
  const status = h('p.hint.pad.missing-status', { role: 'status' });
  const body = h('div.missing-body');
  el.append(actions, status, body);

  let checking = null;

  function button(name, label, onClick, cls = '') {
    return h(`button.btn.btn-secondary${cls}`, { type: 'button', onclick: onClick }, icon(name, 20), h('span', null, label));
  }

  function render() {
    const list = missingList();
    const artists = list.filter((m) => m.kind === 'artist');
    const tracks = list.filter((m) => m.kind === 'track');
    const libraries = new Set(list.map((m) => m.library));
    const where = (m) => (libraries.size > 1 && m.library ? ` · ${m.library}` : '');
    const times = (m) => (m.times > 1 ? `suggested ${m.times} times, last ` : 'suggested ');

    actions.replaceChildren(
      ...(list.length
        ? [
            button('arrowDown', 'Download (CSV)', () => {
              download(missingCsv(list), `missing-tracks-${fileDate()}.csv`, 'text/csv;charset=utf-8');
              toast('Downloaded, to open in a spreadsheet');
            }, '.missing-csv'),
            button('stack', 'Copy the list', async () => toast((await copyText(missingText(list))) ? 'Copied: artist — title, one to a line' : 'Couldn’t copy here. Download it instead.'), '.missing-copy'),
            navigator.share
              ? button('external', 'Share…', () => navigator.share({ title: 'Missing tracks', text: missingText(list) }).catch(() => {}), '.missing-share')
              : null,
            button('refresh', 'Check again', checkAgain, '.missing-check'),
          ].filter(Boolean)
        : []),
    );

    const remove = (m) =>
      iconButton('close', `Take ${m.title || m.artist} off the list`, () => {
        forgetMissing(m);
        render();
      });
    const lead = (name) => h('span.tile.tile-plain', null, icon(name, 22));
    const kids = [];
    if (artists.length) {
      kids.push(
        h(
          'section.block',
          null,
          sectionHeader(`Artists (${fmt.number(artists.length)})`),
          h(
            'div.rows.missing-rows',
            null,
            artists.map((m) => row({ lead: lead('mic'), title: m.artist, subtitle: `None of their music · ${times(m)}${fmt.ago(m.last)}${where(m)}`, right: remove(m), cls: 'missing-row' })),
          ),
        ),
      );
    }
    if (tracks.length) {
      kids.push(
        h(
          'section.block',
          null,
          sectionHeader(`Tracks (${fmt.number(tracks.length)})`),
          h(
            'div.rows.missing-rows',
            null,
            tracks.map((m) =>
              row({
                lead: lead('note'),
                title: m.title,
                subtitle: `${m.artist || 'Unknown artist'} · ${times(m)}${fmt.ago(m.last)}${m.prompt ? ` for “${m.prompt}”` : ''}${where(m)}`,
                right: remove(m),
                cls: 'missing-row',
              }),
            ),
          ),
        ),
      );
    }
    if (list.length) {
      kids.push(
        h(
          'div.pad.missing-clear',
          null,
          h(
            'button.link-btn.danger',
            {
              type: 'button',
              onclick: async () => {
                const sure = await confirmAction({ title: 'Clear the list?', message: 'Everything on it is taken off. Nothing changes in your library.', confirm: 'Clear the list' });
                if (!sure) return;
                clearMissing();
                render();
              },
            },
            'Clear the list',
          ),
        ),
      );
    } else {
      kids.push(
        emptyState(
          aiSettings().missing
            ? 'Nothing missing so far. When an AI playlist suggests songs or artists your library doesn’t have, they’re listed here.'
            : 'Nothing here. Turn on Show missing tracks in Settings › AI, and the songs and artists AI playlists suggest that your library doesn’t have are listed here.',
        ),
      );
    }
    body.replaceChildren(...kids);
  }

  async function checkAgain() {
    if (checking) return;
    checking = new AbortController();
    const btn = actions.querySelector('.missing-check');
    if (btn) btn.disabled = true;
    status.classList.remove('warn');
    status.textContent = `Looking in ${app.source?.sectionTitle || 'your library'}…`;
    try {
      const found = await checkMissingAgain({
        signal: checking.signal,
        onProgress: (n, of) => (status.textContent = `Looking in ${app.source?.sectionTitle || 'your library'}… ${n} of ${of}`),
      });
      status.textContent = found ? `${fmt.count(found, 'is', 'are')} in your library now, so ${found === 1 ? 'it’s' : 'they’re'} off the list.` : 'None of them are in your library yet.';
      render();
    } catch (err) {
      status.textContent = describeError(err);
      status.classList.add('warn');
    } finally {
      checking = null;
      if (btn) btn.disabled = false;
    }
  }

  render();
  // An AI playlist made meanwhile may add to it.
  onDispose?.(on('missing', render));
  onDispose?.(() => checking?.abort());
}
