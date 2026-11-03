// What the service's parts take in, checked the same way in each of them.

// A Plex account's id: a whole number above 0, or null.
export const userId = (v) => (Number.isSafeInteger(Number(v)) && Number(v) > 0 ? Number(v) : null);

// A Plex server's id (its machine identifier), as plex.tv and the app have it.
export const SERVER_ID = /^[A-Za-z0-9._:-]{1,100}$/;

// What isn't text, in names and titles: control characters (and the C1
// ones), and the line and paragraph separators. Each run of them is taken
// out, or made a space.
export const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;
