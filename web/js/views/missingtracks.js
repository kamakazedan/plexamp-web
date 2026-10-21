// Settings › AI › Missing tracks: the songs and artists AI playlists
// suggested that the library doesn't have, to export and go looking for.
import { app, on } from '../state.js';
import { describeError } from '../router.js';
import { h, icon, backHeader, row, sectionHeader, emptyState, iconButton, toast, fmt, confirmAction, download, fileDate } from '../ui.js';
import {
  missingList,
  forgetMissing,
  clearMissing,
  checkMissingAgain,
  checkMissingOnMusicBrainz,
  restoreMissing,
  missingCsv,
  missingText,
  copyText,
  mbOn,
  mbWhere,
} from '../missing.js';
import { aiSettings } from '../ai.js';

export function missingTracksView({ el, onDispose }) {
  const server = app.source?.serverName || 'this server';
  el.append(
    backHeader('Missing tracks', { fallback: '/settings/ai' }),
    h(
      'p.lede',
      null,
      `Songs and artists that AI playlists suggested but ${server} doesn’t have, kept on this device so you can go and find them (each server has a list of its own). ` +
        (mbOn()
          ? 'AI playlists check what they suggest on MusicBrainz before it goes on this list, and leave out what MusicBrainz doesn’t know (most likely made up). Check on MusicBrainz does the same for those listed without being checked.'
          : 'AI models sometimes suggest songs that don’t exist, so check before you go looking.'),
    ),
  );
  const actions = h('div.pad.button-row.missing-actions');
  const status = h('p.hint.pad.missing-status', { role: 'status' });
  const body = h('div.missing-body');
  el.append(actions, status, body);

  let checking = null;
  let asking = null;

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
              const name = server.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'server';
              download(missingCsv(list), `missing-tracks-${name}-${fileDate()}.csv`, 'text/csv;charset=utf-8');
              toast('Downloaded, to open in a spreadsheet');
            }, '.missing-csv'),
            button('stack', 'Copy the list', async () => toast((await copyText(missingText(list))) ? 'Copied: artist — title, one to a line' : 'Couldn’t copy here. Download it instead.'), '.missing-copy'),
            navigator.share
              ? button('external', 'Share…', () => navigator.share({ title: 'Missing tracks', text: missingText(list) }).catch(() => {}), '.missing-share')
              : null,
            button('refresh', 'Check again', checkAgain, '.missing-check'),
            mbOn() && list.some((m) => m.mb !== 'real') ? button('check', 'Check on MusicBrainz', checkOnMusicBrainz, '.missing-mb') : null,
          ].filter(Boolean)
        : []),
    );
    if (asking) actions.querySelector('.missing-mb')?.setAttribute('disabled', '');
    if (checking) actions.querySelector('.missing-check')?.setAttribute('disabled', '');

    const remove = (m) =>
      iconButton('close', `Take ${m.title || m.artist} off the list`, () => {
        forgetMissing(m);
        render();
      });
    const lead = (name) => h('span.tile.tile-plain', null, icon(name, 22));
    // Checked on MusicBrainz and found: real, not made up.
    const found = (m) => (m.mb === 'real' ? h('span.mb-found', { title: `Found on ${mbWhere()}` }, 'On MusicBrainz') : null);
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
            artists.map((m) =>
              row({ lead: lead('mic'), title: m.artist, subtitle: [found(m), `None of their music · ${times(m)}${fmt.ago(m.last)}${where(m)}`], right: remove(m), cls: 'missing-row' }),
            ),
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
                subtitle: [found(m), `${m.artist || 'Unknown artist'} · ${times(m)}${fmt.ago(m.last)}${m.prompt ? ` for “${m.prompt}”` : ''}${where(m)}`],
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
                const sure = await confirmAction({ title: 'Clear the list?', message: `Everything on ${server}’s list is taken off (other servers’ lists stay). Nothing changes in your library.`, confirm: 'Clear the list' });
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
    actions.querySelector('.missing-check')?.setAttribute('disabled', '');
    status.classList.remove('warn');
    status.textContent = `Looking on ${server}…`;
    try {
      const found = await checkMissingAgain({
        signal: checking.signal,
        onProgress: (n, of) => (status.textContent = `Looking on ${server}… ${n} of ${of}`),
      });
      status.textContent = found ? `${fmt.count(found, 'is', 'are')} on ${server} now, so ${found === 1 ? 'it’s' : 'they’re'} off the list.` : `None of them are on ${server} yet.`;
      render();
    } catch (err) {
      status.textContent = describeError(err);
      status.classList.add('warn');
    } finally {
      checking = null;
      actions.querySelector('.missing-check')?.removeAttribute('disabled');
    }
  }

  // Those listed without being checked, looked up on MusicBrainz: what it
  // doesn't know comes off the list (with an undo, for a while).
  async function checkOnMusicBrainz() {
    if (asking) return;
    asking = new AbortController();
    const signal = asking.signal;
    actions.querySelector('.missing-mb')?.setAttribute('disabled', '');
    status.classList.remove('warn');
    status.textContent = `Checking them on ${mbWhere()}…`;
    let result = null;
    let error = null;
    try {
      result = await checkMissingOnMusicBrainz({
        signal,
        onProgress: (n, of) => !signal.aborted && (status.textContent = `Checking them on ${mbWhere()}… ${fmt.number(n)} of ${fmt.number(of)}`),
      });
    } catch (err) {
      error = err;
      result = err.result || null;
    } finally {
      asking = null;
    }
    if (signal.aborted) return; // left the page: what was checked still counts
    status.textContent = [result ? mbSummary(result) : '', error?.message || ''].filter(Boolean).join(' ');
    status.classList.toggle('warn', !!error);
    render();
    const dropped = result?.dropped || [];
    if (dropped.length) {
      toast(`${fmt.count(dropped.length, 'suggestion', 'suggestions')} taken off the list`, {
        action: 'Undo',
        timeout: 8000,
        onAction: () => {
          restoreMissing(dropped);
          status.textContent = `Put back: ${fmt.count(dropped.length, 'suggestion', 'suggestions')}.`;
          status.classList.remove('warn');
          render();
        },
      });
    }
  }

  render();
  // An AI playlist made meanwhile may add to it.
  onDispose?.(on('missing', render));
  onDispose?.(() => {
    checking?.abort();
    asking?.abort();
  });
}

// What checking on MusicBrainz did, in a sentence or two.
function mbSummary({ real, dropped, unsure }) {
  const unknown = dropped.filter((m) => m.mb === 'unknown').length;
  const albums = dropped.length - unknown;
  const why = [
    unknown ? `${fmt.number(unknown)} that MusicBrainz doesn’t know (most likely made up)` : '',
    albums ? `${fmt.number(albums)} ${albums === 1 ? 'album' : 'albums'} taken for ${albums === 1 ? 'a song' : 'songs'}` : '',
  ].filter(Boolean);
  const parts = [];
  if (dropped.length) parts.push(`Taken off the list: ${why.join(' and ')}.`);
  if (real) parts.push(`${fmt.count(real, 'is', 'are')} on MusicBrainz, so ${real === 1 ? 'it’s' : 'they’re'} real.`);
  if (unsure) parts.push(`${fmt.count(unsure, 'couldn’t', 'couldn’t')} be checked this time.`);
  return parts.join(' ') || 'Nothing to check: they’re all on MusicBrainz.';
}
