// Settings › AI › Missing tracks: the songs and artists AI playlists
// suggested, and the tracks of playlists imported from Spotify, that the
// library doesn't have, to export and go looking for. Where this player
// keeps them for each Plex account: on every device the account signs in
// on, and for the server's owner with everyone's, saying whose each is, so
// they can see everything that's missing from their server.
import { app, on } from '../state.js';
import { describeError } from '../router.js';
import { h, icon, backHeader, row, sectionHeader, emptyState, iconButton, toast, fmt, confirmAction, download, fileDate } from '../ui.js';
import {
  missingList,
  forgetMissing,
  clearMissing,
  checkMissingAgain,
  checkMissingOnMusicBrainz,
  askable,
  restoreMissing,
  missingCsv,
  missingText,
  copyText,
  everyoneShown,
  mbOn,
  mbWhere,
  tally,
  promptOf,
  missingKept,
} from '../missing.js';
import { pullMissing, missingPlayerFull } from '../missingsync.js';
import { aiSettings } from '../ai.js';

// Whose one of everyone's is (for the server's owner): you and their names,
// as your Plex friends have them, and how many others (who aren't any more).
export function whose(m) {
  if (!m.others) return '';
  const names = [...(m.mine ? ['you'] : []), ...(m.others.who || [])];
  const unknown = Math.max(0, (m.others.people || 0) - (m.others.who?.length || 0));
  if (unknown) names.push(`${fmt.number(unknown)} ${unknown === 1 ? 'other' : 'others'}`);
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0] || '';
}

export function missingTracksView({ el, onDispose }) {
  const server = app.source?.serverName || 'this server';
  const lede = h('p.lede.missing-lede');
  const paintLede = () => {
    const kept = missingKept();
    const what = `Songs and artists from AI playlists and Spotify imports that ${server} doesn’t have`;
    lede.textContent =
      (!kept
        ? `${what}. Kept on this device.`
        : kept.owner === true
          ? `${what}: yours and your friends’. Kept for your account; what anyone asked the AI stays on their device.`
          : `${what}. Kept for your account. ${kept.owner === false ? `Whoever runs ${server}` : `The owner of ${server}`} sees them too, so they can add them; what you asked the AI stays on your device.`) +
      (mbOn() ? '' : ' The AI sometimes makes songs up, so check before you go looking.');
  };
  paintLede();
  el.append(backHeader('Missing tracks', { fallback: '/settings/ai' }), lede);
  const actions = h('div.pad.button-row.missing-actions');
  const status = h('p.hint.pad.missing-status', { role: 'status' });
  const body = h('div.missing-body');
  const note = h('p.hint.pad.missing-sync-note');
  el.append(actions, status, body, note);

  let checking = null;
  let asking = null;

  function button(name, label, onClick, cls = '') {
    return h(`button.btn.btn-secondary${cls}`, { type: 'button', onclick: onClick }, icon(name, 20), h('span', null, label));
  }

  function render() {
    paintLede();
    const list = missingList();
    const everyone = everyoneShown();
    const artists = list.filter((m) => m.kind === 'artist');
    const tracks = list.filter((m) => m.kind === 'track');
    const libraries = new Set(list.map((m) => m.library));
    const where = (m) => (libraries.size > 1 && m.library ? ` · ${m.library}` : '');
    const who = (m) => (whose(m) ? ` · ${whose(m)}` : '');
    const times = (m) => {
      const { ai } = tally(m);
      return ai > 1 ? `suggested ${fmt.number(ai)} times, last ` : 'suggested ';
    };
    // Where a track came from: what it was suggested for, or the Spotify
    // playlist it was in (this device's own, while it noted it last), and
    // how often, everyone's for the server's owner.
    const told = (m) => {
      const { ai, spotify, more } = tally(m);
      const prompt = promptOf(m);
      const lists = `${fmt.number(spotify)}${more ? '+' : ''} playlists`;
      if (ai && spotify) return `suggested ${ai === 1 ? 'once' : `${fmt.number(ai)} times`} and in ${spotify === 1 && !more ? 'a playlist' : lists} from Spotify, last ${fmt.ago(m.last)}`;
      if (spotify) {
        if (spotify > 1 || more) return `in ${lists} from Spotify${prompt ? `, last “${prompt}”` : ''}, ${fmt.ago(m.last)}`;
        return `${prompt ? `in “${prompt}”` : 'in a playlist'} from Spotify, ${fmt.ago(m.last)}`;
      }
      return `${times(m)}${fmt.ago(m.last)}${prompt ? ` for “${prompt}”` : ''}`;
    };

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
            mbOn() && list.some(askable) ? button('check', 'Check on MusicBrainz', checkOnMusicBrainz, '.missing-mb') : null,
          ].filter(Boolean)
        : []),
    );
    if (asking) actions.querySelector('.missing-mb')?.setAttribute('disabled', '');
    if (checking) actions.querySelector('.missing-check')?.setAttribute('disabled', '');

    const remove = (m) =>
      iconButton('close', `Take ${m.title || m.artist} off ${everyone ? 'everyone’s list' : 'the list'}`, () => {
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
              row({ lead: lead('mic'), title: m.artist, subtitle: [found(m), `None of their music · ${times(m)}${fmt.ago(m.last)}${where(m)}${who(m)}`], right: remove(m), cls: 'missing-row' }),
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
                subtitle: [found(m), `${m.artist || 'Unknown artist'} · ${told(m)}${where(m)}${who(m)}`],
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
                const sure = await confirmAction({
                  title: 'Clear the list?',
                  message: everyone
                    ? `Clears ${server}’s whole list, your friends’ too. Other servers’ lists and your library aren’t changed.`
                    : `Clears ${server}’s whole list. Other servers’ lists and your library aren’t changed.`,
                  confirm: 'Clear the list',
                });
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
          everyone || aiSettings().missing ? 'Nothing missing so far.' : 'Turn on Show missing tracks in Settings › AI to list them here.',
        ),
      );
    }
    body.replaceChildren(...kids);
    note.textContent = missingPlayerFull() ? `This player is full right now, so your list for ${server} is kept on this device for now.` : '';
    note.hidden = !note.textContent;
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
  // An AI playlist made meanwhile may add to it, and another device (or for
  // the server's owner, a friend) may have: what's kept for the account,
  // read again.
  onDispose?.(on('missing', render));
  pullMissing();
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
