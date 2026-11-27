// What the Android app (github.com/kamakazedan/plexamp-web-android) relies on
// here, so a change that would break it fails CI rather than phones: see
// docs/android-app.md. Each check says what in the app depends on it.
//
//   node --test tests/android-app.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const scripts = () => ['web/js', 'web/js/views'].flatMap((dir) => readdirSync(new URL(`../${dir}`, import.meta.url)).filter((f) => f.endsWith('.js')).map((f) => `${dir}/${f}`));
const why = (what, where) => `${what}: the Android app relies on it (${where}). See docs/android-app.md.`;

test('the page loads config.js and js/app.js, which the app tells a player by', () => {
  const page = read('web/index.html');
  assert.match(page, /<script[^>]*\ssrc="config\.js"/, why('index.html loads config.js', 'GuiRefs.looksLikePlexampWeb'));
  assert.match(page, /<script[^>]*\ssrc="js\/app\.js"/, why('index.html loads js/app.js', 'GuiRefs.looksLikePlexampWeb'));
});

test('the version reads as the app reads it', () => {
  // The app's own pattern (GuiRefs' APP_VERSION), in js/plex.js.
  const found = read('web/js/plex.js').match(/APP_INFO\s*=\s*\{[^}]*?version:\s*['"]([^'"]+)['"]/);
  assert.ok(found, why("APP_INFO = { …, version: '1.2.3' } in js/plex.js", 'GuiRefs.appVersion, for its Settings'));
  assert.match(found[1], /^\d+\.\d+\.\d+$/);
});

test('a sign-in handed over as the app hands it over is the one the player keeps', async () => {
  // What Handoff.kt writes in the player's page: JSON, under "pw." and the key's name.
  const auth = { token: 'a-plex-token', username: 'Dan', thumb: null, manual: false };
  const kept = new Map([
    ['pw.auth', JSON.stringify(auth)],
    ['pw.clientId', JSON.stringify('this-phones-id')],
  ]);
  const storage = {
    getItem: (key) => (kept.has(key) ? kept.get(key) : null),
    setItem: (key, value) => kept.set(key, String(value)),
    removeItem: (key) => kept.delete(key),
    key: (i) => [...kept.keys()][i] ?? null,
    get length() {
      return kept.size;
    },
  };
  // (What js/plex.js and what it imports need of a browser as they load.)
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true });
  globalThis.window ??= globalThis;
  const { store, clientId } = await import('../web/js/plex.js');
  assert.deepEqual(store.get('auth'), auth, why('the sign-in, kept as pw.auth', 'Handoff.kt'));
  assert.equal(clientId(), 'this-phones-id', why("this device's id with Plex, kept as pw.clientId", 'Handoff.kt'));
});

test("the player's own sign-in keeps what the app hands over, in the same shape", () => {
  const login = read('web/js/views/login.js');
  assert.match(
    login,
    /setAuth\(\{\s*token,\s*username:[^\n]*\bthumb:[^\n]*\bmanual:\s*false\s*\}\)/,
    why('Sign in with Plex keeps { token, username, thumb, manual: false }', 'Handoff.kt, which writes the same'),
  );
  assert.match(read('web/js/state.js'), /store\.get\(\s*['"]auth['"]\s*\)/, why('the sign-in, read from pw.auth', 'Handoff.kt'));
  assert.match(login, /store\.get\(\s*['"]pendingPin['"]\s*\)/, why('a sign-in under way, kept as pw.pendingPin', 'Handoff.kt, which removes it'));
});

test('the pages the app opens, and watches, are there', () => {
  const routes = read('web/js/app.js');
  for (const [path, where] of [
    ['/', 'Handoff.kt, after signing in where someone already was'],
    ['/setup', 'Handoff.kt, after signing in, to choose a server'],
    ['/login', "MainActivity.onRoute, which takes it for signed out, and the app's Other ways to sign in"],
  ]) {
    assert.match(routes, new RegExp(`\\broute\\(\\s*['"]${path.replaceAll('/', '\\/')}['"]`), why(`the page #${path}`, where));
  }
  assert.match(read('web/js/offline.js'), /#\/login\?offline=/, why("#/login?offline=… as offline mode's session ends", 'MainActivity.onRoute, which leaves that page to say why'));
});

test("the player's own Sign in with Plex goes to app.plex.tv/auth", () => {
  assert.match(
    read('web/js/plex.js'),
    /['"`]https:\/\/app\.plex\.tv\/auth/,
    why('Sign in with Plex opening https://app.plex.tv/auth…', "PlayerClient.kt, which signs in the app's way instead"),
  );
});

test('the paths the container answers (never files) are the ones the app knows', () => {
  const nginx = read('docker/nginx.conf');
  // The one rule that names them all: dot files are refused outside them.
  const named = nginx.match(/location ~ "\^\/\(\?!([^)]*)\)/);
  assert.ok(named, why('the paths the container answers, named in nginx.conf', 'GuiRefs.isServicePath'));
  assert.deepEqual(named[1].split('|').sort(), ['api/', 'ollama/', 'pms/'], why('the paths the container answers: api/, ollama/ and pms/', 'GuiRefs.isServicePath'));
  assert.match(nginx, /location = \/signed-out\s*\{/, why('signed-out, answered by the container', 'GuiRefs.isServicePath'));
  assert.match(read('web/js/state.js'), /fetch\(\s*['"]signed-out['"]/, why('signing out asks for signed-out', 'GuiRefs.isServicePath'));
});

test('files are saved one way: a Blob link, clicked', () => {
  const download = read('web/js/ui.js').match(/export function download\([^)]*\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(download, why('download() in js/ui.js', 'page-bridge.js'));
  assert.match(download[1], /URL\.createObjectURL\(\s*new Blob\(/, why('a file to save made with URL.createObjectURL(new Blob(…))', 'page-bridge.js'));
  assert.match(download[1], /\.download\s*=/, why("…as an <a download>'s link", 'page-bridge.js'));
  assert.match(download[1], /\.click\(\)/, why('…which is clicked with .click()', 'page-bridge.js'));
  for (const file of scripts().filter((f) => f !== 'web/js/ui.js')) {
    assert.doesNotMatch(read(file), /\.download\s*=|showSaveFilePicker|msSaveBlob/, why(`${file} saves a file without ui.js's download()`, 'page-bridge.js'));
  }
});

test('what the player shares is text, as the app can share', () => {
  for (const file of scripts()) {
    assert.doesNotMatch(read(file), /navigator\.share\(\s*\{[^}]*\bfiles\s*:/, why(`${file} shares files`, 'page-bridge.js, which shares text and links'));
  }
});

test('hls.js is named in a plain string, so the app finds it to save', () => {
  assert.match(read('web/js/player.js'), /['"]vendor\/hls\.min\.js['"]/, why("'vendor/hls.min.js', as a plain string", 'GuiRefs.find, which saves the files scripts name'));
});

test("Settings › Downloads is the page the app's downloads notification opens", () => {
  assert.match(read('web/js/app.js'), /\broute\(\s*['"]\/settings\/:page['"]/, why('the pages #/settings/…', 'MainActivity, whose downloads notification opens #/settings/downloads'));
  assert.match(read('web/js/views/settings.js'), /\bconst pages = \{[^}]*\bdownloads:/, why('the page #/settings/downloads', 'MainActivity, whose downloads notification opens it'));
});

test('the page gives the app what it keeps downloads up to date with, and has it forget them on signing out', () => {
  const downloads = read('web/js/downloads.js');
  assert.match(
    downloads,
    /\.account\(\{[^}]*\bserverId:[^}]*\btoken:[^}]*\buser:[^}]*\buris\b[^}]*\bdevice:/,
    why('the server, the sign-in and its addresses, given as downloads.account({ serverId, token, user, uris, device })', 'DownloadBridge.kt'),
  );
  assert.match(downloads, /on\(\s*['"]source['"]/, why('…again as the server changes', 'DownloadBridge.kt'));
  assert.match(downloads, /on\(\s*['"]signing-out['"][\s\S]*?\.forget\(\)/, why('downloads.forget() as someone signs out or switches', 'DownloadBridge.kt, which removes the files and the sign-in'));
  assert.match(read('web/js/state.js'), /function leave\([^)]*\)\s*\{[^}]*?emit\(\s*['"]signing-out['"]\s*\)/, why("'signing-out', as someone signs out or switches", 'DownloadBridge.kt, by way of js/downloads.js'));
});

test("each server's downloads are asked for as that server's", () => {
  const downloads = read('web/js/downloads.js');
  assert.match(downloads, /\.account\(\{[^}]*\bserverName:/, why("the server's name, given with downloads.account({ serverName })", 'DownloadBridge.kt, which names its downloads after it'));
  for (const op of ['add', 'remove']) {
    assert.match(downloads, new RegExp(`ask\\(\\s*['"]${op}['"],[^\\n]*,\\s*(server|app\\.source\\?\\.serverId)\\)`), why(`downloads.${op}(playlist, server)`, 'DownloadBridge.kt, which takes it from that server'));
  }
  assert.match(downloads, /\.bad\([^)]*\bserverId\b/, why('downloads.bad(track, server)', 'DownloadBridge.kt'));
  assert.match(downloads, /\.trackUrl\([^\n]*,\s*track\.server\)/, why("another server's track asked for with its server", 'DownloadServer.kt'));
  assert.match(
    downloads,
    /__plexamp-web-android\/downloads\/track\/[\s\S]{0,120}searchParams\.set\(\s*['"]server['"]/,
    why("another server's track, at …/downloads/track/<id>?server=<its id>", 'DownloadServer.kt'),
  );
});
