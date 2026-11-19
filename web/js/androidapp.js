// The Android app itself (plexamp-web for Android), where this page is in it:
// its version, which it puts in the user agent it gives the page (every
// version has), and, from 0.2.4, checking for updates, which its page bridge
// gives this page as plexampAndroid.app (see docs/android-app.md). In a
// browser there's none of it: androidAppVersion() is null.

const bridge = () => window.plexampAndroid?.app || null;

// Where the app's releases are: a newer one's only ever offered from there.
const RELEASES = 'https://github.com/kamakazedan/plexamp-web-android/releases/';

// "0.2.4", or null outside the app.
export function androidAppVersion() {
  const m = /\bplexamp-web-android\/(\d[\w.-]*)/.exec(navigator.userAgent || '');
  return m ? m[1] : null;
}

// Whether the app can check for updates (one from before 0.2.4 can't).
export const canCheckForUpdates = () => typeof bridge()?.check === 'function';

// A newer version of the app it's found: { version, url }, or null.
const updateOf = (answer) => {
  const u = answer?.update;
  return u && typeof u.version === 'string' && typeof u.url === 'string' && u.url.startsWith(RELEASES) && !/[\s\\]|\.\./.test(u.url) ? { version: u.version, url: u.url } : null;
};

// What the app knows: { update } (a newer version it's found, or null).
export async function appUpdates() {
  const b = bridge();
  if (typeof b?.state !== 'function') return { update: null };
  return { update: updateOf(await b.state()) };
}

// Checks for updates now: the app on GitHub, and this player on its server
// (the app opens a new version it finds, or offers Reload while music's
// playing). { update, app, player }: app is 'newer', 'same' or 'failed';
// player 'reloading', 'offered', 'same' or 'failed'.
export async function checkForUpdates() {
  const answer = await bridge().check();
  return { update: updateOf(answer), app: String(answer?.app || 'failed'), player: String(answer?.player || 'failed') };
}
