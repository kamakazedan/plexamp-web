// Track previews (Settings › Experience › Show preview buttons): a short
// listen from part-way into a track, without touching the queue. Whatever
// was playing pauses for it and carries on afterwards; in a Play Together
// session it's turned down on this device instead, so nobody else notices.
import { player, Deck } from './player.js';
import { toast } from './ui.js';

const LENGTH = 15; // seconds
let deck = null;
let current = null; // { track, button }
let stopTimer = null;
let resumeAfter = false;
let ducked = false;

function setButton(button, on) {
  if (!button) return;
  button.classList.toggle('on', on);
  button.setAttribute('aria-pressed', String(on));
}

export function isPreviewing(track) {
  return !!current && current.track.id === track.id;
}

export function stopPreview() {
  clearTimeout(stopTimer);
  if (!current) return;
  setButton(current.button, false);
  current = null;
  if (deck) {
    deck.el.pause();
    deck.reset();
  }
  if (ducked) {
    ducked = false;
    player.applyVolume();
  }
  if (resumeAfter) {
    resumeAfter = false;
    player._play();
  }
}

export async function togglePreview(track, button) {
  if (isPreviewing(track)) return stopPreview();
  stopPreview();
  deck ||= new Deck();
  current = { track, button };
  setButton(button, true);
  if (player.remote) {
    ducked = true;
    for (const d of player.decks) d.el.volume = 0;
  } else if (player.isPlaying) {
    resumeAfter = true;
    player.noteWhy('a track preview');
    player._pause();
  }
  try {
    const src = player.sourceFor(track, false);
    await deck.load(src.url, src.hls);
    if (current?.track !== track) return;
    const start = () => {
      const d = deck.el.duration || (track.duration || 0) / 1000;
      try {
        if (d > LENGTH * 2) deck.el.currentTime = d * 0.3;
      } catch {
        /* not seekable: start from the top */
      }
    };
    if (deck.el.readyState >= 1) start();
    else deck.el.addEventListener('loadedmetadata', start, { once: true });
    deck.el.volume = player.volume;
    await deck.el.play();
    stopTimer = setTimeout(stopPreview, LENGTH * 1000);
    deck.el.addEventListener('ended', stopPreview, { once: true });
  } catch (err) {
    if (current?.track === track) {
      stopPreview();
      if (err?.name !== 'AbortError') toast(`Can’t preview “${track.title}”.`);
    }
  }
}
