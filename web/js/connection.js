// Whether the app can reach its Plex server, as it last found out: lost
// once something it needed from the server couldn't get there (a track, a
// play to report, a rating: the browser's offline, or the server isn't
// answering it), and back once the server answers again. app.js shows it
// (the banner) and asks again every so often meanwhile; the player (a
// track waiting for the connection) and the outbox (plays and ratings kept
// meanwhile: see outbox.js) carry on once it's back.
import { app } from './state.js';

export const connection = Object.assign(new EventTarget(), { lost: false });

export function connectionLost() {
  if (connection.lost) return;
  connection.lost = true;
  connection.dispatchEvent(new Event('lost'));
}

export function connectionBack() {
  if (!connection.lost) return;
  connection.lost = false;
  connection.dispatchEvent(new Event('back'));
}

// Whether the server answers right now: any answer at all, even a refusal,
// says it's there. Not while the browser says it's offline (and never from
// the browser's cache).
export async function serverAnswers() {
  const s = app.server;
  if (navigator.onLine === false || !s) return false;
  try {
    await s.identity({ timeout: 5000, cache: 'no-store' });
    return true;
  } catch (err) {
    return !err?.network;
  }
}

// A request that failed for want of the connection (`err`, as plex.js
// throws them), rather than the server saying no: and the server isn't
// answering now either.
export async function offlineFor(err) {
  if (!err?.network) return false;
  if (await serverAnswers()) return false;
  connectionLost();
  return true;
}
