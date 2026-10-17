// "AI playlist": describe what you want to hear and an Ollama model builds a
// playlist from your library.
import { aiReady, aiTarget, sharedAI, sharedStatus, generatePlaylist, describeAIError } from '../ai.js';
import { playList } from '../actions.js';
import { player } from '../player.js';
import { h, icon, backHeader, iconButton, toast, fmt } from '../ui.js';
import { trackRow } from '../components.js';
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
let running = null; // { ctrl } while generating

export async function aiPlaylistView({ el }) {
  const input = h('input', {
    type: 'search',
    placeholder: 'Describe your playlist…',
    'aria-label': 'Describe your playlist',
    autocomplete: 'off',
    enterkeyhint: 'go',
    maxlength: 400,
  });
  const form = h(
    'form.search-box.ai-box',
    {
      onsubmit: (e) => {
        e.preventDefault();
        start(input.value);
      },
    },
    icon('sparkle', 22),
    input,
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

  if (!aiReady()) {
    body.append(setupCard());
    input.disabled = true;
    lengthRow.hidden = true;
    return;
  }

  // A shared model is only for people who can use this player's Plex
  // server: anyone else is told so here, rather than after a wait.
  if (aiTarget()?.kind === 'shared') {
    sharedStatus().catch((err) => {
      if (!el.isConnected || running || ![401, 403].includes(err?.status)) return;
      input.disabled = true;
      lengthRow.hidden = true;
      body.replaceChildren(noAccessCard(describeAIError(err)));
    });
  }

  if (last) {
    input.value = last.prompt;
    showResult(last.result);
  } else {
    showSuggestions();
  }

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

  async function start(raw) {
    const prompt = raw.trim();
    if (!prompt || running) return;
    input.blur();
    const ctrl = new AbortController();
    running = { ctrl };
    const steps = STEPS.map(([id, label]) => ({ id, el: h('li.ai-step', null, h('span.ai-step-mark'), h('span', null, label)) }));
    const elapsed = h('span', null, '0 s');
    const started = Date.now();
    const tick = setInterval(() => (elapsed.textContent = `${Math.round((Date.now() - started) / 1000)} s`), 1000);
    body.replaceChildren(
      h(
        'div.ai-progress',
        { role: 'status' },
        h('ol.ai-steps', null, steps.map((s) => s.el)),
        h(
          'div.ai-progress-foot',
          null,
          h('span.ai-elapsed', null, aiTarget()?.model || '', ' · ', elapsed),
          h('button.btn.btn-secondary', { type: 'button', onclick: () => ctrl.abort() }, 'Stop'),
        ),
      ),
    );
    const mark = (id) => {
      const at = steps.findIndex((s) => s.id === id);
      steps.forEach((s, i) => {
        s.el.classList.toggle('done', i < at);
        s.el.classList.toggle('active', i === at);
      });
    };
    try {
      const result = await generatePlaylist({ prompt, length, signal: ctrl.signal, onStep: (id) => mark(id) });
      last = { prompt, result };
      if (el.isConnected) showResult(result);
    } catch (err) {
      if (!el.isConnected) return;
      if (err.code === 'aborted') {
        showSuggestions();
        return;
      }
      body.replaceChildren(
        h(
          'div.ai-error',
          { role: 'alert' },
          h('p', null, describeAIError(err)),
          h(
            'div.button-row',
            null,
            h('button.btn.btn-secondary', { type: 'button', onclick: () => start(prompt) }, 'Try again'),
            err.code === 'not-configured' || err.code === 'no-model' || err.status === 404
              ? h('a.btn.btn-secondary', { href: '#/settings/ai' }, 'AI settings')
              : null,
          ),
        ),
      );
    } finally {
      clearInterval(tick);
      running = null;
    }
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
    const list = h('div.tracks');
    tracks.forEach((t, i) => list.append(trackRow(t, { showArt: true, subtitle: t.artist, onPlay: () => playList(tracks, i, context) })));
    const based = [...result.basedOn.tags, ...result.basedOn.artists];
    body.replaceChildren(
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
              showSuggestions();
              input.focus();
            },
          },
          icon('sparkle', 18),
          h('span', null, 'Make another playlist'),
        ),
      ),
    );
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

function setupCard() {
  // This player shares a model, and AI is turned off on this device.
  if (sharedAI()) {
    return h(
      'div.ai-setup',
      null,
      h('div.ai-setup-icon', null, icon('sparkle', 34)),
      h('h2', null, 'AI features are off'),
      h('p', null, 'They’re turned off on this device. Turn them on in Settings › AI.'),
      h('a.btn.btn-primary', { href: '#/settings/ai' }, 'AI settings'),
    );
  }
  return h(
    'div.ai-setup',
    null,
    h('div.ai-setup-icon', null, icon('sparkle', 34)),
    h('h2', null, 'Connect an AI model'),
    h(
      'p',
      null,
      'Playlists are made by an AI model running on your own hardware through Ollama. Point this app at an Ollama server, or ask whoever runs this app to set up a shared one.',
    ),
    h('a.btn.btn-primary', { href: '#/settings/ai' }, 'Set up AI'),
  );
}
