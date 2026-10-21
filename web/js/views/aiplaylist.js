// "AI playlist": describe what you want to hear and an Ollama model builds a
// playlist from your library.
import { aiReady, aiTarget, aiSettings, sharedStatus, generatePlaylist, describeAIError, norm } from '../ai.js';
import { noteMissing, missingCount, mbOn, mbWhere, checkSuggestions } from '../missing.js';
import { on, emit } from '../state.js';
import { playList } from '../actions.js';
import { player } from '../player.js';
import { navigate } from '../router.js';
import { h, icon, backHeader, iconButton, toast, fmt } from '../ui.js';
import { trackRow, numberedList } from '../components.js';
import { addToPlaylist, addToCollection, isAdminNow } from '../editing.js';

const SUGGESTIONS = [
  'Late-night drive: moody electronic and trip-hop that slowly builds.',
  'Upbeat indie and pop for a Saturday morning clean-up.',
  'Rainy Sunday afternoon: soft acoustic folk and mellow jazz.',
  'A 90s throwback party with big singalong choruses.',
  'Instrumental focus music with a steady tempo and no vocals.',
  'Start mellow and finish with high-energy dance tracks.',
  'Deep cuts I rarely play, from artists I already love.',
  'Summer barbecue: feel-good soul, funk and reggae.',
  'Cinematic and atmospheric, like a film score at sunset.',
  'Guitar-heavy rock with a bit of electronic edge.',
];
const LENGTHS = [15, 25, 50];
const STEPS = [
  ['plan', 'Reading your request'],
  ['search', 'Finding tracks in your library'],
  ['order', 'Choosing and ordering tracks'],
];

// Kept for the session so leaving and coming back shows the last playlist.
let last = null;
let length = 25;
let suggestion = Math.floor(Math.random() * SUGGESTIONS.length);

// The playlist being made. It carries on while you're elsewhere in the app;
// any AI playlist page shows it, and then what came of it.
let job = null; // { prompt, ctrl, started, step, done, result, error, listeners }

function startJob(prompt) {
  const j = { prompt, ctrl: new AbortController(), started: Date.now(), step: 'plan', done: false, listeners: new Set() };
  const emit = () => j.listeners.forEach((fn) => fn(j));
  job = j;
  generatePlaylist({
    prompt,
    length,
    signal: j.ctrl.signal,
    onStep: (id) => {
      if (j.step === id) return;
      j.step = id;
      emit();
    },
    onLoading: (on) => {
      j.loading = on;
      emit();
    },
  })
    .then((result) => {
      j.result = result;
      last = { prompt, result };
      keepMissing(result, prompt);
      // Made while you were somewhere else: say so.
      if (!location.hash.startsWith('#/ai-playlist')) {
        toast(`Your AI playlist “${result.title}” is ready`, { action: 'Open', onAction: () => navigate('/ai-playlist'), timeout: 8000 });
      }
    })
    .catch((err) => {
      j.error = err;
      keepMissing(err, prompt);
      if (err?.code !== 'aborted' && !location.hash.startsWith('#/ai-playlist')) {
        toast('Your AI playlist couldn’t be made.', { action: 'See why', onAction: () => navigate('/ai-playlist'), timeout: 8000 });
      }
    })
    .finally(() => {
      j.done = true;
      if (job === j) job = null;
      emit();
    });
  return j;
}

// Settings › AI › Show missing tracks: what wasn't found goes on the list
// (and what was found comes off it). With a MusicBrainz to ask, the
// suggestions are looked up there first: those it doesn't know (mostly
// made up) and albums taken for songs are left out, and the playlist's
// page says so. found.mb follows the check: { state: 'checking', 'done' or
// 'failed', done, of, verdicts (see checkSuggestions), error }.
function keepMissing(found, prompt) {
  if (!found?.missing && !found?.seen) return;
  if (!aiSettings().missing && !missingCount()) return;
  const missing = aiSettings().missing ? found.missing || [] : [];
  if (!missing.length || !mbOn()) {
    noteMissing(missing, found.seen || {}, prompt);
    return;
  }
  const mb = (found.mb = { state: 'checking', done: 0, of: missing.length, verdicts: [] });
  const told = () => emit('ai-mb', found);
  told();
  checkSuggestions(missing, {
    onProgress: (n, of) => {
      mb.done = n;
      mb.of = of;
      told();
    },
  })
    .then((verdicts) => {
      mb.verdicts = verdicts;
      mb.state = 'done';
    })
    .catch((err) => {
      mb.verdicts = err.verdicts || [];
      mb.state = 'failed';
      mb.error = err.message;
    })
    .finally(() => {
      noteMissing(
        missing.map((m, i) => (mb.verdicts[i] === 'real' ? { ...m, mb: 'real' } : m)).filter((_, i) => !leftOut(mb.verdicts[i])),
        found.seen || {},
        prompt,
        { drop: missing.filter((_, i) => leftOut(mb.verdicts[i])) },
      );
      told();
    });
}

const leftOut = (verdict) => verdict === 'unknown' || verdict === 'album';
const missingLine = (m) => (m.kind === 'artist' ? `${m.artist} (no music by them)` : `${m.artist ? `${m.artist} — ` : ''}${m.title}`);

// Under a playlist, with Show missing tracks on: the songs and artists it
// suggested that aren't in the library, or that they all are.
function missingNote(found, onDispose) {
  if (!aiSettings().missing) return null;
  if (found?.missing?.length) return missingBlock(found, onDispose);
  const one = (list, key) => new Set((list || []).map(key).filter(Boolean)).size;
  const artists = one(found?.seen?.artists, (a) => norm(a));
  const songs = one(found?.seen?.songs, (t) => `${norm(t?.artist)}|${norm(t?.title)}`);
  if (!artists && !songs) return null;
  const what = [artists && fmt.count(artists, 'artist', 'artists'), songs && fmt.count(songs, 'song', 'songs')].filter(Boolean).join(' and ');
  return h(
    'p.ai-missing-none',
    null,
    icon('check', 18),
    h('span', null, `Nothing missing: the ${what} it suggested ${artists + songs === 1 ? 'is' : 'are'} all in your library.`),
  );
}

// What's missing, and (checked on MusicBrainz) what was left out and why,
// changing as the answers come.
function missingBlock(found, onDispose) {
  const missing = found.missing;
  const label = h('span');
  const list = h('ul.ai-missing-list');
  const left = h('div.ai-missing-left');
  const note = h('p.ai-missing-mb');
  const el = h(
    'details.ai-missing',
    null,
    h('summary', null, icon('appears', 20), label),
    list,
    left,
    note,
    h('a.link-btn.ai-missing-all', { href: '#/settings/missing' }, 'All missing tracks, to export'),
  );
  const group = (why, items) => h('div.ai-missing-group', null, h('p.ai-missing-why', null, why), h('ul.ai-missing-list.out', null, items.map((m) => h('li', null, missingLine(m)))));
  const paint = () => {
    const mb = found.mb;
    const verdict = (i) => mb?.verdicts?.[i] ?? null;
    const shown = missing.filter((_, i) => !leftOut(verdict(i)));
    const madeUp = missing.filter((_, i) => verdict(i) === 'unknown');
    const albums = missing.filter((_, i) => verdict(i) === 'album');
    const out = madeUp.length + albums.length;
    const checking = mb?.state === 'checking';
    const tracks = shown.filter((m) => m.kind === 'track').length;
    const artists = shown.length - tracks;
    const what = [tracks && fmt.count(tracks, 'track', 'tracks'), artists && fmt.count(artists, 'artist', 'artists')].filter(Boolean).join(' and ');
    const after = checking ? ' · checking them on MusicBrainz…' : out ? ` · ${fmt.count(out, 'suggestion', 'suggestions')} left out` : '';
    label.textContent = shown.length ? `Not in your library: ${what}${after}` : `Nothing missing that MusicBrainz knows of: ${fmt.count(out, 'suggestion', 'suggestions')} left out`;
    list.replaceChildren(...shown.map((m) => h('li', null, missingLine(m))));
    list.hidden = !shown.length;
    const it = (n) => (n === 1 ? 'it' : 'them');
    left.replaceChildren(
      ...[
        madeUp.length ? group(`Left out, as MusicBrainz doesn’t know ${it(madeUp.length)}: the AI most likely made ${it(madeUp.length)} up.`, madeUp) : null,
        albums.length ? group(`Left out, as ${albums.length === 1 ? 'it’s an album' : 'they’re albums'}, not ${albums.length === 1 ? 'a song' : 'songs'}.`, albums) : null,
      ].filter(Boolean),
    );
    left.hidden = !out;
    note.textContent = !mb
      ? ''
      : checking
        ? `Checking them on ${mbWhere()}… ${fmt.number(mb.done)} of ${fmt.number(mb.of)}`
        : mb.state === 'failed'
          ? `Not all could be checked on ${mbWhere()}: ${mb.error} Those that weren’t are listed as they are.`
          : `Checked on ${mbWhere()}. Only those it knows go on your list of missing tracks.`;
    note.hidden = !note.textContent;
    note.classList.toggle('warn', mb?.state === 'failed');
    el.classList.toggle('checking', checking);
  };
  paint();
  onDispose?.(on('ai-mb', (f) => f === found && paint()));
  return el;
}

export async function aiPlaylistView({ el, onDispose }) {
  // Turned off, or not set up: not shown anywhere, so not here either.
  if (!aiReady() && !job) {
    navigate('/search', { replace: true });
    return;
  }
  const input = h('input', {
    type: 'search',
    placeholder: 'Describe your playlist…',
    'aria-label': 'Describe your playlist',
    autocomplete: 'off',
    enterkeyhint: 'go',
    maxlength: 400,
  });
  // Clears what's typed in one tap, to describe another (Escape too). The
  // playlist made last stays below until another is made.
  const clear = iconButton('close', 'Clear', () => clearPrompt(), { size: 22, cls: 'search-clear' });
  const paintClear = () => (clear.hidden = !input.value);
  const clearPrompt = () => {
    input.value = '';
    paintClear();
    input.focus();
  };
  input.addEventListener('input', paintClear);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && input.value) {
      e.preventDefault();
      e.stopPropagation();
      clearPrompt();
    }
  });
  const form = h(
    'form.search-box.has-clear.ai-box',
    {
      onsubmit: (e) => {
        e.preventDefault();
        start(input.value);
      },
    },
    icon('sparkle', 22),
    input,
    clear,
  );
  const lengthRow = h(
    'div.chips',
    { role: 'radiogroup', 'aria-label': 'Playlist length' },
    LENGTHS.map((n) =>
      h(
        'button.chip',
        {
          type: 'button',
          role: 'radio',
          'aria-checked': String(n === length),
          onclick: (e) => {
            length = n;
            lengthRow.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-checked', String(c === e.currentTarget)));
          },
        },
        `${n} tracks`,
      ),
    ),
  );
  const body = h('div.ai-body');
  el.append(backHeader('AI playlist', { fallback: '/search' }), form, lengthRow, body);

  // Pages put aside are kept, and still brought up to date.
  let disposed = false;
  onDispose?.(() => (disposed = true));

  // A shared model is only for people who can use this player's Plex
  // server: anyone else is told so here, rather than after a wait.
  if (aiTarget()?.kind === 'shared') {
    sharedStatus().catch((err) => {
      if (disposed || job || ![401, 403].includes(err?.status)) return;
      input.disabled = true;
      clear.hidden = true;
      lengthRow.hidden = true;
      body.replaceChildren(noAccessCard(describeAIError(err)));
    });
  }

  if (job) {
    input.value = job.prompt;
    follow(job);
  } else if (last) {
    input.value = last.prompt;
    showResult(last.result);
  } else {
    showSuggestions();
  }
  paintClear();

  function showSuggestions() {
    const text = h('span.ai-suggestion-text', null, SUGGESTIONS[suggestion]);
    const count = h('span.ai-pager-count', null, `${suggestion + 1} / ${SUGGESTIONS.length}`);
    const move = (d) => {
      suggestion = (suggestion + d + SUGGESTIONS.length) % SUGGESTIONS.length;
      text.textContent = SUGGESTIONS[suggestion];
      count.textContent = `${suggestion + 1} / ${SUGGESTIONS.length}`;
    };
    body.replaceChildren(
      h(
        'div.ai-suggest',
        null,
        h('p.ai-try', null, 'Try one of these…'),
        h(
          'button.ai-suggestion',
          {
            type: 'button',
            onclick: () => {
              input.value = SUGGESTIONS[suggestion];
              paintClear();
              start(input.value);
            },
          },
          text,
        ),
        h(
          'div.ai-pager',
          null,
          iconButton('chevronLeft', 'Previous suggestion', () => move(-1), { size: 26 }),
          count,
          iconButton('chevronRight', 'Next suggestion', () => move(1), { size: 26 }),
        ),
      ),
    );
  }

  function start(raw) {
    const prompt = raw.trim();
    if (!prompt || job) return;
    input.blur();
    follow(startJob(prompt));
  }

  // Shows a playlist being made, step by step, and then the playlist (or
  // what went wrong).
  function follow(j) {
    const steps = STEPS.map(([id, label]) => ({ id, el: h('li.ai-step', null, h('span.ai-step-mark'), h('span', null, label)) }));
    const elapsed = h('span');
    const time = () => (elapsed.textContent = `${Math.round((Date.now() - j.started) / 1000)} s`);
    time();
    const tick = setInterval(time, 1000);
    const loadingNote = h('p.ai-loading', { hidden: true }, 'Loading the AI model into memory. After Ollama starts, this can take a few minutes.');
    body.replaceChildren(
      h(
        'div.ai-progress',
        { role: 'status' },
        h('ol.ai-steps', null, steps.map((s) => s.el)),
        loadingNote,
        h(
          'div.ai-progress-foot',
          null,
          h('span.ai-elapsed', null, aiTarget()?.model || '', ' · ', elapsed),
          h('button.btn.btn-secondary', { type: 'button', onclick: () => j.ctrl.abort() }, 'Stop'),
        ),
      ),
    );
    const update = () => {
      if (disposed) return stop();
      if (!j.done) {
        loadingNote.hidden = !j.loading;
        const at = steps.findIndex((s) => s.id === j.step);
        steps.forEach((s, i) => {
          s.el.classList.toggle('done', i < at);
          s.el.classList.toggle('active', i === at);
        });
        return undefined;
      }
      stop();
      if (j.result) return showResult(j.result);
      if (j.error?.code === 'aborted') return showSuggestions();
      return showError(j.error, j.prompt);
    };
    function stop() {
      clearInterval(tick);
      j.listeners.delete(update);
    }
    j.listeners.add(update);
    onDispose?.(stop);
    update();
  }

  function showError(err, prompt) {
    body.replaceChildren(
      h(
        'div.ai-error',
        { role: 'alert' },
        h('p', null, describeAIError(err)),
        err?.missing?.length ? missingNote(err, onDispose) : null,
        h(
          'div.button-row',
          null,
          h('button.btn.btn-secondary', { type: 'button', onclick: () => start(prompt) }, 'Try again'),
          err?.code === 'not-configured' || err?.code === 'no-model' || err?.code === 'timeout' || err?.status === 404 ? h('a.btn.btn-secondary', { href: '#/settings/ai' }, 'AI settings') : null,
        ),
      ),
    );
  }

  function showResult(result) {
    const tracks = result.tracks;
    const totalMs = tracks.reduce((n, t) => n + (t.duration || 0), 0);
    const context = { title: result.title, href: '/ai-playlist' };
    const what = `${result.title} (${fmt.count(tracks.length, 'track', 'tracks')})`;
    const load = async () => tracks;
    // Into a new playlist, one of yours, or (for the server's owner) a
    // collection.
    const save = h(
      'button.btn.btn-secondary.ai-save',
      {
        type: 'button',
        onclick: () =>
          addToPlaylist({
            title: 'Save to Plex',
            what,
            load,
            suggest: result.title,
            extra: isAdminNow()
              ? [{ icon: 'collection', label: 'Add to a collection…', onSelect: () => addToCollection({ kind: 'track', what, load, suggest: result.title }) }]
              : [],
          }),
      },
      icon('playlistAdd', 20),
      h('span', null, 'Save to Plex'),
    );
    const queue = h(
      'button.btn.btn-secondary.ai-queue',
      {
        type: 'button',
        onclick: () => {
          const playing = !!player.current;
          player.addToQueue(tracks);
          toast(playing ? `Added ${fmt.count(tracks.length, 'track', 'tracks')} to the queue` : 'Playing');
        },
      },
      icon('addQueue', 20),
      h('span', null, 'Add to queue'),
    );
    const list = numberedList({ total: tracks.length, album: true });
    tracks.forEach((t, i) => list.append(trackRow(t, { showArt: true, position: true, album: true, subtitle: t.artist, onPlay: () => playList(tracks, i, context) })));
    const based = [...result.basedOn.tags, ...result.basedOn.artists];
    // (Children that may be left out are filtered: replaceChildren would
    // show null as the word "null".)
    const parts = [
      h(
        'section.ai-result',
        null,
        h('h2.ai-title', null, result.title),
        result.summary ? h('p.ai-summary', null, result.summary) : null,
        h(
          'p.ai-meta',
          null,
          [fmt.count(tracks.length, 'track', 'tracks'), fmt.long(totalMs), `made by ${result.model} in ${result.seconds} s`].filter(Boolean).join(', '),
        ),
        result.note ? h('p.ai-note', null, result.note) : null,
        h(
          'div.hero-actions.ai-actions',
          null,
          h('button.btn.btn-primary', { type: 'button', onclick: () => playList(tracks, 0, context) }, icon('play', 20), h('span', null, 'Play')),
          h('button.btn.btn-secondary', { type: 'button', onclick: () => playList(tracks, 0, context, { shuffle: true }) }, icon('shuffle', 20), h('span', null, 'Shuffle')),
          queue,
          save,
        ),
      ),
      list,
      missingNote(result, onDispose),
      h('p.ai-based', { hidden: !based.length }, `Based on ${based.slice(0, 12).join(', ')}`),
      h(
        'div.pad',
        null,
        h(
          'button.link-btn',
          {
            type: 'button',
            onclick: () => {
              last = null;
              input.value = '';
              paintClear();
              showSuggestions();
              input.focus();
            },
          },
          icon('sparkle', 18),
          h('span', null, 'Make another playlist'),
        ),
      ),
    ];
    body.replaceChildren(...parts.filter(Boolean));
  }
}

function noAccessCard(message) {
  return h(
    'div.ai-setup.ai-no-access',
    null,
    h('div.ai-setup-icon', null, icon('sparkle', 34)),
    h('h2', null, 'AI playlists aren’t available to you here'),
    h('p', null, message),
  );
}
