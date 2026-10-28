#!/usr/bin/env python3
"""Browser tests for plexamp-web, run in headless Chromium with Playwright
against the mock Plex and Ollama servers in dev/.

CI runs them against the real container (see tests/run-browser-tests.sh).
They can also run against any server that serves web/ with a matching
config.js. Settings come from the environment:

    APP_URL          app with a shared AI model and WebSockets allowed
    APP_URL_NOWS     app with DISABLE_WEBSOCKETS=true (from before 0.25.0:
                     WEBSOCKETS=off) and no shared model
    APP_URL_DEBUG    app with DEBUG=true and WEBSOCKETS=on (the debug and
                     wsonly sections are skipped without it)
    APP_URL_BIG      app on a mock Plex server started with --big 3000, and
    MOCK_PLEX_BIG    that server (the memory section is skipped without them)
    APP_URL_MB       app with MUSICBRAINZ_ADVANCED=true, on the mock's
                     MusicBrainz, SYNC_SETTINGS=false and
                     SYNC_MISSING_TRACKS=false (the mb section is skipped
                     without it)
    MOCK_PLEX        mock Plex server, e.g. http://127.0.0.1:32400
    PLEX_LOGIN_URL   server address to sign in with; empty to use the
                     container's /pms proxy
    OLLAMA_DIRECT    mock Ollama the browser can reach directly
    OLLAMA_NOTHINK   mock Ollama started with --reject-think

The apps' services must use the mock for plex.tv (PLEX_TV_URL), whose
accounts are t (Dan, who owns the server), t2 (Sam, a friend with access)
and t3 (Alex, a friend without access).

    python3 tests/browser_test.py [screenshot-dir] [section ...]

Sections: core ws ai dj djs nows blocked poll wsonly custom desktop nav library edit
lists pictures missing files sharing routes privacy np stream cast ratings
devices fades together settings home formats select spotify debug sync
missingsync mb memory (default: all).
"""

import json
import os
import random
import re
import struct
import sys
import time
import zlib
import urllib.error
import urllib.parse
import urllib.request

from playwright.sync_api import sync_playwright

APP = os.environ.get('APP_URL', 'http://127.0.0.1:8081/')
APP_NOWS = os.environ.get('APP_URL_NOWS', 'http://127.0.0.1:8082/')
APP_DEBUG = os.environ.get('APP_URL_DEBUG', '')
APP_BIG = os.environ.get('APP_URL_BIG', '')
APP_MB = os.environ.get('APP_URL_MB', '')
MOCK_BIG = os.environ.get('MOCK_PLEX_BIG', '').rstrip('/')
MOCK = os.environ.get('MOCK_PLEX', 'http://127.0.0.1:32400').rstrip('/')
LOGIN_URL = os.environ.get('PLEX_LOGIN_URL', '')
OLLAMA = os.environ.get('OLLAMA_DIRECT', 'http://127.0.0.1:11434').rstrip('/')
OLLAMA_NOTHINK = os.environ.get('OLLAMA_NOTHINK', 'http://127.0.0.1:11435').rstrip('/')
APP_DEFAULTS = os.environ.get('APP_DEFAULTS') == '1'  # every test with the app's own settings to start with (see login)
OUT = sys.argv[1] if len(sys.argv) > 1 else 'screenshots'
ONLY = set(sys.argv[2:]) or None
os.makedirs(OUT, exist_ok=True)

MOBILE = dict(viewport={'width': 412, 'height': 915}, device_scale_factor=2, is_mobile=True, has_touch=True)
# Failed connections are part of what's being tested (blocked WebSockets,
# unreachable servers), so the browser's own reports of them are expected.
EXPECTED_NOISE = ('WebSocket connection to', 'Failed to load resource', 'EventSource', 'net::ERR', 'CORS policy')

results = []
errors = []


def mock(path):
    with urllib.request.urlopen(MOCK + path, timeout=20) as r:
        return json.loads(r.read() or b'{}')


def annotate(title, message):
    """In GitHub Actions, a failure also becomes an annotation, shown on the
    run's summary page (and readable through the API)."""
    if os.environ.get('GITHUB_ACTIONS'):
        text = str(message).replace('%', '%25').replace('\r', ' ').replace('\n', ' ')[:900]
        print(f'::error title={title}::{text}', flush=True)


def crashed(kind, value, tb):
    """A test that stops with an error says where, as an annotation too."""
    import traceback
    annotate('Browser tests stopped', ''.join(traceback.format_exception(kind, value, tb))[-900:])
    sys.__excepthook__(kind, value, tb)


sys.excepthook = crashed


def check(name, ok, detail=''):
    results.append((name, bool(ok)))
    print(('PASS ' if ok else 'FAIL ') + name + (f' — {detail}' if detail and not ok else ''), flush=True)
    if not ok:
        annotate('Browser test', name + (f' — {detail}' if detail else ''))


def attach(page, tag, expected=()):
    def on_console(m):
        if m.type in ('error', 'warning') and not any(n in m.text for n in EXPECTED_NOISE + tuple(expected)):
            errors.append(f'[{tag}] console.{m.type}: {m.text}')

    page.on('console', on_console)
    page.on('pageerror', lambda e: errors.append(f'[{tag}] page error: {e}'))


# Words that only show up when code puts a value where text should be: a
# left-out part handed to the page as null ("null"), "undefined", "NaN",
# "[object Object]". Every screenshot's page is checked, and what's found
# is one check at the end.
STRAY_TEXT = r"""() => {
    const out = [];
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
        const text = n.nodeValue.trim();
        const el = n.parentElement;
        if (!text || !el || el.closest('script, style, template')) continue;
        if (/^(null|undefined|NaN)$/.test(text) || /\bundefined\b|\bNaN\b|\[object Object\]/.test(text)) {
            const cls = typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).join('.') : '';
            out.push(JSON.stringify(text.slice(0, 40)) + ' in ' + el.tagName.toLowerCase() + cls);
        }
    }
    return out;
}"""
stray = []
screens = [0]


def shot(page, name):
    page.wait_for_timeout(400)
    page.screenshot(path=os.path.join(OUT, f'{name}.png'))
    try:
        found = page.evaluate(STRAY_TEXT)
    except Exception:  # noqa: BLE001 - a page that's going away
        found = []
    screens[0] += 1
    stray.extend(f'{name}: {f}' for f in found)


def login(page, app, token='t', app_defaults=False):
    page.goto(app + '#/login')
    page.click('text=Use a server address and token instead')
    if LOGIN_URL:
        page.fill('input[type=url]', LOGIN_URL)
    page.fill('input[type=password]', token)
    page.click('button:has-text("Connect")')
    page.wait_for_selector('.wide-card:not(.skeleton)', timeout=20000)
    # (Most tests were written for loudness levelling, Load ahead and Keep
    # played tracks off, as they were before 0.20.0 and 0.21.0: those that
    # test them, or the app's defaults, keep the app's own, and
    # APP_DEFAULTS=1 runs them all that way.)
    if not (app_defaults or APP_DEFAULTS):
        settings(page, {'loudness': False, 'loadAhead': 0, 'keepPlayed': 0})


def js(page, expr):
    return page.evaluate(expr)


def player(page, expr):
    return js(page, f"() => import('./js/player.js').then(m => {{ const p = m.player; return {expr}; }})")


def tg(page, expr):
    return js(page, f"() => import('./js/together.js').then(m => {{ const t = m.together; return {expr}; }})")


def drift(page):
    """How far this device is from where the session says it should be (s)."""
    return js(page, "() => Promise.all([import('./js/player.js'), import('./js/together.js')])"
                    ".then(([p, t]) => p.player.time - t.together.expectedMs() / 1000)")


def settings(page, patch):
    js(page, f"() => import('./js/state.js').then(m => m.saveSettings({json.dumps(patch)}))")


def toggle(page, title, on):
    box = page.locator('label.toggle-row', has_text=title).locator('input')
    if box.is_checked() != on:
        box.click()


def sheet_action(page, opener, action):
    """Open a sheet, pick an action, and wait until the sheet has gone."""
    page.click(opener)
    page.wait_for_selector('.sheet.open')
    page.locator('.sheet.open .sheet-action', has_text=action).first.click()
    page.wait_for_selector('.sheet', state='detached')


def choose(page, title, option):
    sheet_action(page, f'.choice-row:has-text("{title}")', option)


def sections_on_home(page):
    page.goto(page.url.split('#')[0] + '#/')
    page.wait_for_selector('section.block[data-section]')
    page.wait_for_timeout(1200)  # sections with nothing to show remove themselves
    return page.locator('section.block[data-section]').evaluate_all('els => els.map(e => e.dataset.section)')


def live_mode(page):
    return js(page, "() => import('./js/live.js').then(m => m.live.mode)")


def wait_for(fn, timeout=20, step=0.5):
    end = time.time() + timeout
    value = fn()
    while not value and time.time() < end:
        time.sleep(step)
        value = fn()
    return value


def wait_mode(page, want, timeout=40):
    wait_for(lambda: live_mode(page) == want, timeout)
    return live_mode(page)


def has_card(page, title):
    return title in page.locator('.card-title').all_text_contents()


def live_status(page):
    page.wait_for_selector('.kv')
    return page.locator('.kv', has_text='Live updates').inner_text().replace('\n', ' | ')


def png(width, height, rgb):
    """A picture of one colour, as a PNG (no Pillow needed)."""
    row = b'\x00' + bytes(rgb) * width
    chunk = lambda kind, data: struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(row * height, 9)) + chunk(b'IEND', b''))


def play_first_album_track(page, app, album=0, track=0):
    page.goto(app + '#/browse/albums')
    page.wait_for_selector('.grid .card')
    page.locator('.grid .card').nth(album).click()
    page.wait_for_selector('.hero-album')
    page.locator('.track .track-main').nth(track).click()
    wait_for(lambda: player(page, "p.state === 'playing'"), 10)


def run(section):
    return ONLY is None or section in ONLY


with sync_playwright() as pw:
    browser = pw.chromium.launch(args=['--autoplay-policy=no-user-gesture-required'])
    # Every context here is the same Plex account, so sharing playback
    # between devices is off unless a section turns it on (devices does).
    _new_context = browser.new_context

    def new_context(**kw):
        c = _new_context(**kw)
        c.add_init_script("""(() => { try {
            const s = JSON.parse(localStorage.getItem('pw.settings') || '{}');
            if (!('shareDevices' in s)) { s.shareDevices = false; localStorage.setItem('pw.settings', JSON.stringify(s)); }
        } catch (e) {} })();""")
        return c
    browser.new_context = new_context
    mock('/__mock/config?ws=1&sse=on&ping=10')

    ctx = browser.new_context(**MOBILE)
    page = ctx.new_page()
    attach(page, 'main')
    sockets = []
    page.on('websocket', lambda ws: sockets.append(ws.url))
    login(page, APP)

    # ---------- core: browse and play ----------
    if run('core'):
        shot(page, 'core-01-home')
        page.wait_for_selector('section[data-section=recentlyAdded] .card')
        check('core: on a touch screen shelves are swiped, and the whole heading opens the list',
              page.locator('section[data-section=recentlyAdded] a.section-head .chev').count() == 1 and page.locator('.shelf-nav, .section-link').count() == 0)
        play_first_album_track(page, APP, album=0, track=1)
        check('core: plays a track', player(page, "p.state") == 'playing')
        page.click('.pb-main')
        page.wait_for_selector('.np.open')
        shot(page, 'core-02-now-playing')
        page.click('.np-tool[data-tool=queue]')
        page.wait_for_timeout(500)
        check('core: Up next lists the album', page.locator('.np-queue-list .track').count() >= 2)
        page.keyboard.press('Escape')
        page.wait_for_timeout(400)
        check('core: Escape closes Now Playing', not js(page, "document.querySelector('.np').classList.contains('open')"))
        # Routes to a server: each is asked who it is, and only counts if
        # it's that very server. When its local address doesn't answer, this
        # container's proxy comes next (if it leads there); a plain http
        # address over the internet isn't used. The question carries the
        # sign-in: like a real Plex server, the mock only lets a page on
        # another address read who it is when the request has one.
        asked = []
        page.on('request', lambda r: asked.append(r.url) if r.url.startswith(MOCK + '/identity') else None)
        routes = js(page, """() => Promise.all([import('./js/plex.js'), import('./js/state.js')]).then(async ([p, s]) => {
            const srv = { id: s.app.source.serverId, token: s.app.source.token, connections: [
                { uri: 'http://127.0.0.1:9', local: true, relay: false, protocol: 'http' },
                { uri: '%s', local: false, relay: false, protocol: 'http' }] };
            const home = { ...srv, connections: [{ uri: '%s', local: true, relay: false, protocol: 'http' }] };
            const pick = async (x) => (await p.pickConnection(x, { proxy: s.proxyUri() }))?.kind || null;
            const internet = (await p.probeConnections(srv)).find((c) => c.kind === 'remote')?.why;
            return [await pick(srv), await pick({ ...srv, id: 'another-server' }), await pick(home), await pick({ ...home, id: 'another-server' }), internet]; })""" % (MOCK, MOCK))
        check('core: routes to a server: its local address first, then the container\'s proxy; never another server, nor plain http over the internet',
              routes == ['proxy', None, 'local', None, 'insecure'] and asked and all('X-Plex-Token=' in u for u in asked), f'{routes} {asked}')
        unsigned = js(page, """() => import('./js/state.js').then(({ app }) => Promise.all(['', '?X-Plex-Token=' + encodeURIComponent(app.source.token)]
            .map((q) => fetch('%s/identity' + q, { headers: { Accept: 'application/json' }, credentials: 'omit' })
                .then((r) => r.json()).then((j) => j.MediaContainer.machineIdentifier, () => 'refused'))))""" % MOCK)
        check('core: ...which is why the question carries it (asked without, the mock answers as a real server would)',
              unsigned == ['refused', 'mock-server-1'], str(unsigned))

    # ---------- ws: live updates over a WebSocket ----------
    if run('ws'):
        page.goto(APP + '#/')
        page.wait_for_selector('.wide-card:not(.skeleton)')
        check('ws: live updates use a WebSocket', wait_mode(page, 'websocket', 20) == 'websocket', live_mode(page))
        check('ws: WebSocket opened to Plex notifications', any('/:/websockets/notifications' in u for u in sockets), str(sockets[:1]))
        mock('/__mock/add-album?title=Fresh%20Arrival')
        check('ws: new album appears on Home without reloading', wait_for(lambda: has_card(page, 'Fresh Arrival'), 20))
        page.goto(APP + '#/settings/debug')
        check('ws: Connection page names the WebSocket', 'WebSocket' in live_status(page), live_status(page))
        shot(page, 'ws-01-connection')
        play_first_album_track(page, APP, album=1)
        page.click('.pb-main')
        page.wait_for_selector('.np.open')
        page.wait_for_timeout(800)
        cur = player(page, 'p.current.id')
        settings(page, {'ratingSystem': 'stars'})
        mock(f'/:/rate?key={cur}&rating=6&identifier=com.plexapp.plugins.library&X-Plex-Token=t')
        check('ws: rating made in another app appears', wait_for(lambda: page.locator('.star.on').count() == 3, 10),
              f"{page.locator('.star.on').count()} stars")
        settings(page, {'ratingSystem': 'tick'})
        page.keyboard.press('Escape')
        page.wait_for_timeout(400)

    # ---------- ai: playlist from a description, shared model ----------
    if run('ai'):
        page.goto(APP + '#/search')
        page.wait_for_selector('.row-title')
        check('ai: Search lists AI playlist', page.locator('.row-title', has_text='AI playlist').count() == 1)
        page.goto(APP + '#/ai-playlist')
        page.wait_for_selector('.ai-suggestion')
        shot(page, 'ai-01-start')
        before = len(mock('/playlists?X-Plex-Token=t')['MediaContainer']['Metadata'])
        page.click('.ai-suggestion')
        page.wait_for_selector('.ai-result', timeout=60000)
        shot(page, 'ai-02-result')
        title = page.locator('.ai-title').inner_text()
        rows = page.locator('.ai-body .tracks .track').count()
        check('ai: playlist generated', title and rows == 25, f'{title!r}, {rows} tracks')
        # Not an album: a few tracks from each at most (compilations aside),
        # unless there aren't enough albums to go round.
        spread = js(page, """() => import('./js/ai.js').then(async (m) => {
            const r = await m.generatePlaylist({ prompt: 'Late night drive', length: 15 });
            const n = {};
            r.tracks.filter((t) => !/^various/i.test(t.albumArtist || '')).forEach((t) => (n[t.albumId] = (n[t.albumId] || 0) + 1));
            const c = (album, i, albumArtist = 'X') => ({ track: { id: album + i, albumId: album, albumArtist } });
            const few = m.spreadAlbums([0, 1, 2, 3, 4].map((i) => c('a', i)), [c('b', 0), c('b', 1), c('b', 2), c('c', 0)], 6).map((x) => x.track.id);
            const one = m.spreadAlbums([0, 1, 2, 3, 4, 5].map((i) => c('a', i)), [], 6).length;
            const va = m.spreadAlbums([0, 1, 2, 3, 4, 5].map((i) => c('v', i, 'Various Artists')), [c('b', 0)], 6).map((x) => x.track.id);
            return { most: Math.max(...Object.values(n)), tracks: r.tracks.length, few, one, va }; })""")
        check('ai: no more than a few tracks from any one album (15 tracks: 2), compilations aside',
              spread['most'] <= 2 and spread['tracks'] == 15 and spread['few'] == ['a0', 'a1', 'b0', 'b1', 'c0', 'a2'] and spread['one'] == 6
              and spread['va'] == ['v0', 'v1', 'v2', 'v3', 'v4', 'v5'], str(spread))
        based = page.locator('.ai-based').inner_text()
        check('ai: built from library tags and real artists', 'Glass Harbour' in based and 'Not A Real Band' not in based, based)
        # Saving: which playlist (or a new one) is asked.
        page.click('.ai-actions button:has-text("Save to Plex")')
        page.wait_for_selector('.sheet.open .sheet-title:has-text("Save to Plex")')
        offered = page.locator('.sheet.open .sheet-action').all_inner_texts()
        page.locator('.sheet.open .sheet-action', has_text='New playlist').click()
        page.wait_for_selector('.sheet.open .ask-form input')
        page.wait_for_timeout(250)
        suggested = page.locator('.sheet.open .ask-form input').input_value()
        page.click('.sheet.open .ask-form button[type=submit]')
        page.wait_for_selector('.toast:has-text("Made")')
        after = mock('/playlists?X-Plex-Token=t')['MediaContainer']['Metadata']
        check('ai: Save to Plex asks where: a new playlist (named after it) or one of yours', len(after) == before + 1 and after[-1]['title'] == title
              and suggested == title and any('Favourite tracks' in o for o in offered) and any('Add to a collection' in o for o in offered), f'{len(after)} playlists, {offered}')
        page.wait_for_selector('.sheet', state='detached')
        page.click('.ai-actions button:has-text("Play")')
        check('ai: plays the generated playlist', wait_for(lambda: player(page, 'p.context && p.context.title') == title, 10))
        n = player(page, 'p.queue.length')
        page.click('.ai-actions button:has-text("Add to queue")')
        check('ai: ...or adds it to the queue', wait_for(lambda: player(page, 'p.queue.length') == n + rows, 5), player(page, 'p.queue.length'))
        player(page, 'p.pause()')

        # The × clears the description in one tap (Escape too), to type
        # another; the playlist made stays below.
        box_clear = page.locator('.ai-box .search-clear')
        had = page.locator('.ai-box input').input_value()
        shown = box_clear.is_visible()
        box_clear.click()
        cleared = page.locator('.ai-box input').input_value() == '' and box_clear.is_hidden()
        focused = js(page, "() => document.activeElement?.matches('.ai-box input')")
        kept = page.locator('.ai-result').count() == 1
        page.fill('.ai-box input', 'Something else')
        back = box_clear.is_visible()
        page.press('.ai-box input', 'Escape')
        esc = page.locator('.ai-box input').input_value() == '' and js(page, "() => location.hash") == '#/ai-playlist'
        check('ai: the × clears the description (Escape too), and the playlist stays', had and shown and cleared and focused and kept and back and esc,
              f'{had!r} {shown} {cleared} {focused} {kept} {back} {esc}')

        # A best-of stays on its artist, even when the model brings in others.
        page.click('button:has-text("Make another playlist")')
        page.fill('.ai-box input', 'Best of Glass Harbour')
        page.press('.ai-box input', 'Enter')
        page.wait_for_selector('.ai-result', timeout=60000)
        by = set(page.locator('.ai-body .tracks .track .track-sub').all_inner_texts())
        has = mock('/library/sections/1/all?type=10&artist.id=101&group=title&X-Plex-Token=t&X-Plex-Container-Size=0')['MediaContainer']['totalSize']
        got = page.locator('.ai-body .tracks .track').count()
        check('ai: "best of" an artist is only that artist', by == {'Glass Harbour'} and 0 < got <= has, f'{by}, {got} of {has}')
        check('ai: ...and says when that\'s all there is', got >= 25 or 'every track by Glass Harbour' in page.locator('.ai-note').inner_text())
        shot(page, 'ai-03-best-of')

        # Settings: the model in use, and nothing else about the AI server.
        page.goto(APP + '#/settings/ai')
        page.wait_for_selector('.ai-model-row')
        check('ai: settings show the model in use and that it\'s ready', 'llama3.1:8b' in page.locator('.ai-model-row').inner_text()
              and page.wait_for_selector('.ai-shared p.hint:has-text("Ready")', timeout=15000) is not None)
        # (Nothing of the AI server's: not its other models, nor where it is.)
        shown = page.locator('.view').inner_text()
        check('ai: nothing else about the AI server: no choosing its models, nor where it is',
              page.locator('.ai-models .radio-row').count() == 0 and 'qwen2.5' not in shown and '11434' not in shown and 'ollama/' not in shown.lower()
              and js(page, "() => import('./js/ai.js').then((m) => m.aiTarget().kind)") == 'shared', shown[-300:])
        page.click('button:has-text("Test the model")')
        check('ai: model test through the container', page.wait_for_selector('text=It works', timeout=20000) is not None)
        shot(page, 'ai-04-settings')
        # Someone can use an Ollama of their own instead (from this browser,
        # not through the player), and go back to the player's.
        page.click('.radio-row:has-text("My own Ollama server")')
        page.fill('.ai-custom input[type=url]', OLLAMA)
        page.click('.ai-custom button:has-text("Connect")')
        page.wait_for_selector('.ai-models:has-text("Connected")', timeout=15000)
        page.click('.ai-models .radio-row:has-text("llama3.1:8b")')
        own_ai = js(page, "() => import('./js/ai.js').then((m) => { const t = m.aiTarget(); return { kind: t.kind, base: t.base, model: t.model, ready: m.aiReady() }; })")
        asked_player = []
        to_player = lambda r: asked_player.append(r.url) if '/ollama/' in r.url else None
        page.on('request', to_player)
        page.click('.ai-models button:has-text("Test the model")')
        own_works = page.wait_for_selector('.ai-models >> text=It works', timeout=20000) is not None
        page.remove_listener('request', to_player)
        shot(page, 'ai-04b-own-ollama')
        page.click('.radio-row:has-text("This player’s model")')
        page.wait_for_selector('.ai-shared p.hint:has-text("Ready")', timeout=15000)
        back_shared = js(page, "() => import('./js/ai.js').then((m) => m.aiTarget().kind)")
        check('ai: with a shared model, someone can use an Ollama of their own instead (straight from the browser), and go back to the player\'s',
              own_ai == {'kind': 'custom', 'base': OLLAMA, 'model': 'llama3.1:8b', 'ready': True} and own_works and not asked_player and back_shared == 'shared',
              f'{own_ai} {own_works} {asked_player[:3]} {back_shared}')

        # A playlist being made carries on while you're elsewhere, and shows
        # when you come back.
        mock_ai = lambda q: urllib.request.urlopen(f'{OLLAMA}/__mock/config?{q}', timeout=10).read()
        mock_ai('think=1.5')
        page.goto(APP + '#/search')
        page.wait_for_selector('a.row:has-text("AI playlist")')
        page.click('a.row:has-text("AI playlist")')
        page.wait_for_selector('.ai-box input')
        page.click('button:has-text("Make another playlist")')
        page.fill('.ai-box input', 'Rainy afternoon jazz')
        page.press('.ai-box input', 'Enter')
        page.wait_for_selector('.ai-progress')
        page.click('#tabs .tab[data-tab=home]')
        told = page.wait_for_selector('.toast:has-text("is ready")', timeout=30000) is not None
        page.click('#tabs .tab[data-tab=search]')
        page.wait_for_timeout(800)
        check('ai: a playlist made while you\'re elsewhere says so, and is there when you come back', told
              and js(page, '() => location.hash') == '#/ai-playlist' and page.locator('.ai-result').count() == 1 and page.locator('.ai-progress').count() == 0)
        mock_ai('think=0')

        # Loading the model (as after Ollama starts): the app says so, and
        # waits as long as Settings › AI says. Giving up doesn't stop the
        # load (the container loads it itself), so the next try is quick.
        ai_state = lambda: json.loads(mock_ai(''))
        mock_ai('load=5&unload=1&reset=1')
        page.goto(APP + '#/settings/ai')
        page.wait_for_selector('.ai-wait .row-value')
        wait_value = page.locator('.ai-wait .row-value').inner_text()
        unloaded = page.wait_for_selector('.ai-shared p.hint:has-text("isn’t in memory")', timeout=15000) is not None
        check('ai: Settings › AI says how long to wait for the model, and when it isn\'t in memory', wait_value == '5 minutes' and unloaded, wait_value)
        settings(page, {'ai': {'mode': 'auto', 'wait': 0.05}})  # 3 seconds
        page.goto(APP + '#/ai-playlist')
        page.wait_for_selector('.ai-box input')
        if page.locator('button:has-text("Make another playlist")').count():
            page.click('button:has-text("Make another playlist")')
        page.fill('.ai-box input', 'Late night drive')
        page.press('.ai-box input', 'Enter')
        loading = page.wait_for_selector('.ai-loading:not([hidden])', timeout=10000) is not None
        shot(page, 'ai-05-loading')
        page.wait_for_selector('.ai-error', timeout=20000)
        said = page.locator('.ai-error p').first.inner_text()
        check('ai: while the model loads, the page says so; and the wait runs out as set', loading and 'still loading after 3 seconds' in said
              and page.locator('.ai-error a:has-text("AI settings")').count() == 1, said)
        state = wait_for(lambda: (lambda st: st if st['loads'] else None)(ai_state()), 15) or ai_state()
        check('ai: ...but the model carries on loading', state['loads'] == 1 and state['cancelled'] == 0, str(state))
        settings(page, {'ai': {'mode': 'auto'}})
        page.click('.ai-error button:has-text("Try again")')
        page.wait_for_selector('.ai-result', timeout=30000)
        check('ai: ...so the next try finds it ready', ai_state()['loads'] == 1 and page.locator('.ai-loading:not([hidden])').count() == 0)
        mock_ai('load=0')

        # AI turned off: nothing about it shows.
        settings(page, {'ai': {'mode': 'off'}})
        page.goto(APP + '#/search')
        page.wait_for_selector('a.browse-tile')
        off_row = page.locator('a.row:has-text("AI playlist")').is_visible()
        page.goto(APP + '#/ai-playlist')
        page.wait_for_timeout(800)
        off_page = js(page, '() => location.hash')
        if not player(page, '!!p.current'):
            play_first_album_track(page, APP)
        page.click('.pb-main')
        page.wait_for_selector('.np.open')
        page.click('.np-tool[data-tool=dj]')
        page.wait_for_selector('.sheet.dialog.open')
        djs = page.locator('.sheet.open .sheet-action').all_inner_texts()
        page.keyboard.press('Escape')
        page.wait_for_timeout(300)
        page.keyboard.press('Escape')
        check('ai: with AI off, it isn\'t offered anywhere', not off_row and off_page == '#/search' and djs and not any('AI DJ' in d for d in djs), f'{off_row} {off_page} {djs}')
        settings(page, {'ai': {'mode': 'auto'}})
        page.goto(APP + '#/search')
        page.wait_for_selector('a.browse-tile')
        check('ai: ...and with it on again, it is', page.locator('a.row:has-text("AI playlist")').is_visible())
        player(page, 'p.pause()')

        # Someone whose Plex account can't use the server (the container
        # refuses them: see docker/test-container.sh) is told so up front.
        other_ctx = browser.new_context(**MOBILE)
        other = other_ctx.new_page()
        attach(other, 'ai-refused')
        login(other, APP)
        refusal = 'The AI model on this player is for people who can use its Plex server, and your Plex account can’t.'
        other.route('**/ollama/api/status', lambda route: route.fulfill(status=403, content_type='application/json', body=json.dumps({'error': refusal})))
        other.goto(APP + '#/ai-playlist')
        check('ai: someone without access to the server is told why, before asking', other.wait_for_selector('.ai-no-access', timeout=10000) is not None
              and refusal in other.locator('.ai-no-access').inner_text() and other.locator('.ai-box input').is_disabled())
        # ...and that they can use an Ollama of their own instead, which then
        # works for them.
        card = other.locator('.ai-no-access').inner_text()
        other.click('.ai-no-access a:has-text("AI settings")')
        other.wait_for_selector('.ai-shared .ai-refused', timeout=10000)
        said = other.locator('.ai-shared').inner_text()
        no_test = other.locator('.ai-shared button:has-text("Test the model")').is_hidden()
        other.click('.radio-row:has-text("My own Ollama server")')
        other.fill('.ai-custom input[type=url]', OLLAMA)
        other.click('.ai-custom button:has-text("Connect")')
        other.wait_for_selector('.ai-models:has-text("Connected")', timeout=15000)
        other.click('.ai-models .radio-row:has-text("llama3.1:8b")')
        theirs = js(other, "() => import('./js/ai.js').then((m) => ({ kind: m.aiTarget().kind, ready: m.aiReady() }))")
        other.goto(APP + '#/ai-playlist')
        other.wait_for_selector('.ai-box input:not([disabled])', timeout=10000)
        check('ai: ...and that an Ollama of their own can be used instead, which then works for them',
              'an Ollama server of your own instead' in card and refusal in said and 'My own Ollama server' in said and no_test
              and theirs == {'kind': 'custom', 'ready': True} and other.locator('.ai-no-access').count() == 0, f'{card!r} {said!r} {no_test} {theirs}')
        other_ctx.close()

    # ---------- dj: Guest DJ and the AI DJ ----------
    if run('dj'):
        if not player(page, '!!p.current'):
            play_first_album_track(page, APP)
        page.click('.pb-main')
        page.wait_for_selector('.np.open')
        page.click('.np-tool[data-tool=dj]')
        page.wait_for_selector('.sheet.dialog.open')
        shot(page, 'dj-01-dialog')
        page.click('.sheet-action:has-text("DJ Echo")')
        nxt = lambda: player(page, 'p.queue[p.index + 1] && p.queue[p.index + 1].dj')
        check('dj: DJ Echo lines up a pick', wait_for(lambda: nxt() == 'echo', 10), str(nxt()))
        page.click('.np-tool[data-tool=dj]')
        page.wait_for_selector('.sheet.dialog.open')
        page.click('.sheet-action:has-text("AI DJ")')
        check('dj: AI DJ replaces the pick', wait_for(lambda: nxt() == 'ai', 20), str(nxt()))
        player(page, 'p.next()')
        check('dj: Now Playing shows the AI DJ note',
              wait_for(lambda: page.locator('.np-dj:not([hidden])').count() == 1, 10) and page.locator('.np-dj').inner_text().startswith('AI DJ:'))
        shot(page, 'dj-02-note')
        check('dj: AI DJ keeps going', wait_for(lambda: nxt() == 'ai', 20), str(nxt()))
        # Another artist each time: other artists' best-known songs, in the
        # genre of the track it started with.
        with urllib.request.urlopen(f'{OLLAMA}/__mock/config', timeout=20) as r:
            asked = json.loads(r.read()).get('dj_prompt', '')
        playing = (re.search(r'^Now playing: (.*?) — ', asked, re.M) or [None, None])[1]
        offered = [x.split('. ', 1)[1] for x in asked.splitlines() if re.match(r'^\d+\. ', x)]
        q = player(page, '({ cur: p.current.artist, next: p.queue[p.index + 1] && p.queue[p.index + 1].artist })')
        check('dj: ...never the artist playing', q['next'] and q['next'] != q['cur'], str(q))
        check('dj: ...choosing from other artists\' popular songs, in the station\'s genre',
              playing and offered and not any(o.startswith(f'{playing} — ') for o in offered) and '(popular)' in asked and 'The station plays ' in asked, asked[-700:])
        undone = js(page, "() => import('./js/dj.js').then(m => m.guestDJ.set(null))")
        check('dj: turned off, its pick comes out of the queue', not nxt() and undone['removed'] == 1, f'{nxt()} {undone}')
        page.keyboard.press('Escape')
    ctx.close()

    # ---------- djs: what the Guest DJs pick, and the "your queue" ones ----------
    if run('djs'):
        ctx = browser.new_context(**MOBILE)
        page = ctx.new_page()
        attach(page, 'djs')
        login(page, APP)
        settings(page, {'shareDevices': False})

        def mc(path):
            sep = '&' if '?' in path else '?'
            with urllib.request.urlopen(f'{MOCK}{path}{sep}X-Plex-Token=t', timeout=20) as r:
                return json.loads(r.read() or b'{}').get('MediaContainer', {})

        library = mc('/library/sections/1/all?type=10&X-Plex-Container-Size=5000')['Metadata']
        who = lambda t: t.get('originalTitle') or t['grandparentTitle']
        song = lambda artist, title: f"{artist.lower()}|{re.sub(r'\s*[([][^)\]]*[)\]]|\s+-\s+.*$', '', title).strip().lower()}"
        by_artist = lambda name: [t for t in library if who(t) == name and not t['title'].startswith('Signal Fires')]

        def apart_from(t):
            near = mc(f"/library/metadata/{t['ratingKey']}/nearest?limit=5000&maxDistance=5")['Metadata']
            return {m['ratingKey']: m['distance'] for m in near}

        def start(ids, dj):
            page.evaluate("""async ({ ids, dj }) => {
                const [{ app }, { normTrack }, { player }, { guestDJ }] = await Promise.all([
                    import('./js/state.js'), import('./js/plex.js'), import('./js/player.js'), import('./js/dj.js')]);
                guestDJ.set(null);
                const metas = await Promise.all(ids.map((id) => app.server.trackDetail(id)));
                player.playTracks(metas.map(normTrack), 0);
                await new Promise((r) => setTimeout(r, 500));
                if (dj) guestDJ.set(dj);
            }""", {'ids': ids, 'dj': dj})

        queue = lambda: player(page, "({ index: p.index, queue: p.queue.map((t) => ({ id: t.id, title: t.title, artist: t.artist, dj: t.dj || null, moved: t.djMoved || null })) })")
        picked = lambda: (lambda q: q['queue'][q['index'] + 1] if len(q['queue']) > q['index'] + 1 and q['queue'][q['index'] + 1]['dj'] else None)(queue())

        # DJ Steady never plays a song twice, nor another version of one
        # (Signal Fires is on three albums, and the versions sound the same).
        sig = next(t for t in library if t['title'] == 'Signal Fires' and t['parentTitle'] == 'Tidal Lines')
        start([sig['ratingKey']], 'steady')
        played = [song('Glass Harbour', 'Signal Fires')]
        for _ in range(8):
            nxt = wait_for(picked, 15)
            if not nxt:
                break
            played.append(song(nxt['artist'], nxt['title']))
            player(page, 'p.next()')
            page.wait_for_timeout(400)
        check('djs: DJ Steady never repeats a song, or plays another version of one', len(played) == 9 and len(set(played)) == 9, str(played))

        start([sig['ratingKey']], 'echo')
        nxt = wait_for(picked, 15)
        check('djs: DJ Echo doesn\'t follow a song with another version of it', nxt and song(nxt['artist'], nxt['title']) != song('Glass Harbour', 'Signal Fires'), str(nxt))

        # DJ Bridge: one track between two, the middle of the path Plex finds
        # from one to the other, however far apart they sound.
        gh, ns = by_artist('Glass Harbour'), by_artist('Northbound Static')
        page.reload()
        page.wait_for_selector('.wide-card:not(.skeleton)', timeout=20000)
        start([gh[0]['ratingKey'], ns[0]['ratingKey'], gh[3]['ratingKey']], 'bridge')
        wait_for(picked, 15)
        page.wait_for_timeout(300)
        q = queue()
        steps = [t['id'] for t in q['queue'] if t['dj'] == 'bridge']
        path = [m['ratingKey'] for m in mc(f"/library/sections/1/computePath?startID={gh[0]['ratingKey']}&endID={ns[0]['ratingKey']}")['Metadata']][1:-1]
        check('djs: DJ Bridge plays one track between two that sound far apart', len(steps) == 1 and [t['id'] for t in q['queue']][2] == ns[0]['ratingKey'], str(q['queue']))
        check('djs: ...from the middle of the path between them', steps and steps[0] in path and abs(path.index(steps[0]) - (len(path) - 1) / 2) <= 1, f'{steps} in {path}')
        # Turned off, its picks come out of what's to come.
        undone = js(page, "() => import('./js/dj.js').then((m) => m.guestDJ.set(null))")
        check('djs: turning a DJ off takes its picks out of the queue, leaving it as it was',
              [t['id'] for t in queue()['queue']] == [gh[0]['ratingKey'], ns[0]['ratingKey'], gh[3]['ratingKey']] and undone == {'removed': 1, 'back': 0}, f'{queue()} {undone}')
        start([gh[0]['ratingKey'], gh[2]['ratingKey']], 'bridge')
        wait_for(picked, 15)
        page.wait_for_timeout(300)
        steps = [t for t in queue()['queue'] if t['dj'] == 'bridge']
        check('djs: ...and one between tracks that sound alike', len(steps) == 1, str(steps))

        # Queue Echo: the queued track that sounds most like the one playing
        # plays next; nothing is added.
        page.reload()
        page.wait_for_selector('.wide-card:not(.skeleton)', timeout=20000)
        mixed = random.Random(3).sample([t for t in library if who(t) != 'Various Artists' and not t['title'].startswith('Signal Fires')], 14)
        start([t['ratingKey'] for t in mixed], 'queue-echo')
        right = []
        # (Once the DJ has looked at the queue for the track playing: it asks
        # Plex a few things first, slower on some machines than others.)
        arranged = lambda: js(page, "() => Promise.all([import('./js/dj.js'), import('./js/player.js')]).then(([d, p]) => !d.guestDJ.busy && d.guestDJ.arranged === p.player.current?.qid)")
        for _ in range(5):
            wait_for(arranged, 15)
            page.wait_for_timeout(300)
            q = queue()
            cur = q['queue'][q['index']]
            ahead = [t for t in q['queue'][q['index'] + 1:q['index'] + 41] if not t['dj']]
            d = apart_from(next(t for t in library if t['ratingKey'] == cur['id']))
            best = min(ahead, key=lambda t: d.get(t['id'], 9))
            # (Left where it is if the next one is as good, near enough.)
            right.append(q['queue'][q['index'] + 1]['id'] == best['id'] or d.get(q['queue'][q['index'] + 1]['id'], 9) <= d.get(best['id'], 9) + 0.05)
            player(page, 'p.next()')
        q = queue()
        check('djs: Queue Echo plays next the queued track that sounds most like the one playing', all(right), str(right))
        check('djs: ...adding nothing', sorted(t['id'] for t in q['queue']) == sorted(t['ratingKey'] for t in mixed) and not any(t['dj'] for t in q['queue']),
              str(len(q['queue'])))

        # Queue Bridge: Hip-Hop, from later in the queue, between Electronic
        # and Rock.
        page.reload()
        page.wait_for_selector('.wide-card:not(.skeleton)', timeout=20000)
        km, jf = by_artist('Kilo Meridian'), by_artist('Juniper & Ash')
        start([gh[0]['ratingKey'], ns[0]['ratingKey'], jf[0]['ratingKey'], km[0]['ratingKey'], jf[1]['ratingKey']], 'queue-bridge')
        wait_for(lambda: queue()['queue'][1]['moved'], 15)
        order = [t['id'] for t in queue()['queue']]
        check('djs: Queue Bridge plays a queued track that sits between two that sound far apart',
              order == [gh[0]['ratingKey'], km[0]['ratingKey'], ns[0]['ratingKey'], jf[0]['ratingKey'], jf[1]['ratingKey']], str(order))
        page.click('.pb-main')
        page.wait_for_selector('.np.open')
        page.click('.np-tool[data-tool=queue]')
        page.wait_for_timeout(500)
        subs = page.locator('.np-queue .track .track-sub').all_inner_texts()
        check('djs: ...and Up next says so', any('moved up by Queue Bridge' in x for x in subs), str(subs))
        page.keyboard.press('Escape')  # (closes Now Playing)
        page.wait_for_timeout(400)
        player(page, 'p.next()')
        page.click('.pb-main')
        page.wait_for_selector('.np.open')
        check('djs: ...as does Now Playing, when it plays', wait_for(lambda: 'Queue Bridge moved this up: it bridges the gap to' in (page.locator('.np-dj').inner_text() if page.locator('.np-dj:not([hidden])').count() else ''), 10))
        page.keyboard.press('Escape')
        page.wait_for_timeout(400)

        # A big library: Plex gives a track's nearest few hundred, a sliver
        # of it, so for most of a queue it says nothing about how far apart
        # they sound. Then the queue DJs go by what it knows of their albums
        # (genres, styles, moods, years) and artists.
        mc('/__mock/config?nearest=3')
        by_album = lambda name: [t for t in library if t['parentTitle'] == name and not t['title'].startswith('Signal Fires')]
        tl, buoy, inter, hearth = by_album('Tidal Lines'), by_album('Buoy'), by_album('Interference'), by_album('Hearthstone')
        try:
            page.reload()
            page.wait_for_selector('.wide-card:not(.skeleton)', timeout=20000)
            mine = [tl[0]['ratingKey'], inter[0]['ratingKey'], hearth[0]['ratingKey'], buoy[0]['ratingKey'], tl[2]['ratingKey']]
            start(mine, 'queue-bridge')
            wait_for(lambda: queue()['queue'][1]['moved'], 15)
            order = [t['id'] for t in queue()['queue']]
            told = page.locator('.toast').all_inner_texts()
            check('djs: in a big library, Queue Bridge goes by genres, styles, moods and years: an Electronic EP with a Downtempo album\'s style, between Electronic and Rock',
                  order == [tl[0]['ratingKey'], buoy[0]['ratingKey'], inter[0]['ratingKey'], hearth[0]['ratingKey'], tl[2]['ratingKey']], str(order))
            check('djs: ...saying what it did, when it\'s first turned on', any(t.startswith('Queue Bridge moved') and 'bridges the gap' in t for t in told), str(told))
            undone = js(page, "() => import('./js/dj.js').then((m) => m.guestDJ.set(null))")
            check('djs: turning a queue DJ off puts what it moved back where it was', [t['id'] for t in queue()['queue']] == mine and undone == {'removed': 0, 'back': 1},
                  f"{[t['id'] for t in queue()['queue']]} {undone}")
            page.reload()
            page.wait_for_selector('.wide-card:not(.skeleton)', timeout=20000)
            start(mine, 'queue-echo')
            wait_for(lambda: queue()['queue'][1]['moved'], 15)
            moved_up = queue()['queue'][1]
            check('djs: ...and Queue Echo, the queued track most like this one (the same album here)', moved_up['id'] == tl[2]['ratingKey'], str(moved_up))
            js(page, "() => import('./js/dj.js').then((m) => m.guestDJ.set(null))")
        finally:
            mc('/__mock/config?nearest=0')

        # The sheet: the "your queue" DJs under their own heading, and no row
        # running into the next.
        if not page.locator('.np.open').count():
            page.click('.pb-main')
            page.wait_for_selector('.np.open')
        page.click('.np-tool[data-tool=dj]')
        page.wait_for_selector('.sheet.dialog.open')
        page.wait_for_timeout(500)
        shot(page, 'djs-01-sheet')
        boxes = page.locator('.sheet.dialog .sheet-actions > *').evaluate_all('els => els.map((e) => { const r = e.getBoundingClientRect(); return [r.top, r.bottom, e.textContent.slice(0, 20)]; })')
        overlaps = [b[2] for a, b in zip(boxes, boxes[1:]) if b[0] < a[1] - 0.5]
        heading = page.locator('.sheet-heading').inner_text() if page.locator('.sheet-heading').count() else ''
        check('djs: the sheet lists the "your queue" DJs under their own heading, rows apart', 'Only what’s in your queue' in heading and not overlaps, f'{heading} {overlaps}')
        page.keyboard.press('Escape')
        js(page, "() => import('./js/dj.js').then(m => m.guestDJ.set(null))")
        player(page, 'p.pause()')
        ctx.close()

    # ---------- nows: DISABLE_WEBSOCKETS=true (WEBSOCKETS=off) ----------
    if run('nows'):
        ctx = browser.new_context(**MOBILE)
        page = ctx.new_page()
        attach(page, 'nows')
        sockets = []
        page.on('websocket', lambda ws: sockets.append(ws.url))
        login(page, APP_NOWS)
        check('nows: live updates use the event stream', wait_mode(page, 'eventsource', 30) == 'eventsource', live_mode(page))
        mock('/__mock/add-album?title=Second%20Arrival')
        check('nows: new album appears on Home', wait_for(lambda: has_card(page, 'Second Arrival'), 20))
        page.goto(APP_NOWS + '#/settings/debug')
        status = live_status(page)
        check('nows: Connection page explains WebSockets are off', 'WEBSOCKETS=off' in status, status)
        shot(page, 'nows-01-connection')
        check('nows: ...with no setting of this device\'s for them', page.locator('.radio-row', has_text='Without WebSockets').count() == 0
              and page.locator('button', has_text='Reconnect live updates').count() == 0)
        page.click('button:has-text("Test connection")')
        check('nows: testing the connection starts live updates again, still without WebSockets', wait_mode(page, 'eventsource', 30) == 'eventsource')
        page.wait_for_timeout(1000)
        check('nows: no WebSocket was ever opened', not sockets, str(sockets))
        ctx.close()

    # ---------- blocked: WebSockets refused by the network ----------
    if run('blocked'):
        mock('/__mock/config?ws=0&sse=on')
        ctx = browser.new_context(**MOBILE)
        page = ctx.new_page()
        attach(page, 'blocked')
        login(page, APP)
        check('blocked: falls back to the event stream', wait_mode(page, 'eventsource', 40) == 'eventsource', live_mode(page))
        mock('/__mock/add-album?title=Third%20Arrival')
        check('blocked: updates still arrive', wait_for(lambda: has_card(page, 'Third Arrival'), 20))
        page.goto(APP + '#/settings/debug')
        status = live_status(page)
        check('blocked: Connection page says why', 'couldn’t' in status, status)
        ctx.close()

    # ---------- poll: event stream held back too ----------
    if run('poll'):
        mock('/__mock/config?ws=0&sse=silent')
        ctx = browser.new_context(**MOBILE)
        page = ctx.new_page()
        attach(page, 'poll')
        login(page, APP)
        check('poll: falls back to checking for changes', wait_mode(page, 'polling', 60) == 'polling', live_mode(page))
        page.wait_for_timeout(1500)
        mock('/__mock/add-album?title=Fourth%20Arrival')
        js(page, "() => import('./js/live.js').then(m => m.live.checkNow())")
        check('poll: new album found by checking', wait_for(lambda: has_card(page, 'Fourth Arrival'), 20))
        ctx.close()
        mock('/__mock/config?ws=1&sse=on')

    # ---------- wsonly: WEBSOCKETS=on ----------
    if run('wsonly') and APP_DEBUG:
        mock('/__mock/config?ws=0&sse=on')
        try:
            ctx = browser.new_context(**MOBILE)
            page = ctx.new_page()
            attach(page, 'wsonly')
            streams = []
            page.on('request', lambda r: '/:/eventsource/' in r.url and streams.append(r.url))
            login(page, APP_DEBUG)
            page.wait_for_timeout(12000)
            modes = live_mode(page)
            page.goto(APP_DEBUG + '#/settings/debug')
            status = live_status(page)
            shot(page, 'wsonly-01-connection')
            check('wsonly: with WEBSOCKETS=on and WebSockets refused, live updates never fall back to anything else',
                  modes == 'connecting' and not streams and 'WEBSOCKETS=on' in status, f'{modes} {status} {streams[:1]}')
            mock('/__mock/config?ws=1&sse=on')
            js(page, "() => import('./js/live.js').then(m => m.live.checkNow())")
            got = wait_mode(page, 'websocket', 30) == 'websocket' and not streams
            page.goto(APP_DEBUG + '#/settings')
            page.goto(APP_DEBUG + '#/settings/debug')
            after = live_status(page)
            check('wsonly: ...and keep trying a WebSocket, which works once it gets through (and isn\'t said not to then)',
                  got and 'WEBSOCKETS=on' in after and 'couldn’t connect' not in after, f'{live_mode(page)} {after}')
            ctx.close()
        finally:
            mock('/__mock/config?ws=1&sse=on')

    # ---------- custom: this device's own Ollama ----------
    if run('custom'):
        ctx = browser.new_context(**MOBILE)
        page = ctx.new_page()
        attach(page, 'custom')
        login(page, APP_NOWS)
        page.goto(APP_NOWS + '#/ai-playlist')
        page.wait_for_timeout(800)
        redirected = js(page, '() => location.hash')
        page.wait_for_selector('a.browse-tile')
        check('custom: with no AI model set up, AI isn\'t offered', redirected == '#/search'
              and not page.locator('a.row:has-text("AI playlist")').is_visible(), redirected)
        page.goto(APP_NOWS + '#/settings/ai')
        page.click('.radio-row:has-text("My own Ollama server")')
        page.fill('.ai-custom input[type=url]', OLLAMA)
        page.click('.ai-custom button:has-text("Connect")')
        page.wait_for_selector('text=Connected', timeout=15000)
        page.click('.ai-models .radio-row:has-text("llama3.1:8b")')
        page.click('button:has-text("Test the model")')
        check('custom: own Ollama answers', page.wait_for_selector('text=It works', timeout=20000) is not None)
        page.goto(APP_NOWS + '#/search')
        page.wait_for_selector('a.browse-tile')
        check('custom: once it is, AI playlists are offered', page.locator('a.row:has-text("AI playlist")').is_visible())
        page.goto(APP_NOWS + '#/ai-playlist')
        page.wait_for_selector('.ai-box input:not([disabled])')
        page.fill('.ai-box input', 'Moody electronic for a rainy evening')
        page.click('.chip:has-text("15 tracks")')
        page.press('.ai-box input', 'Enter')
        page.wait_for_selector('.ai-result', timeout=60000)
        check('custom: playlist from a typed description', page.locator('.ai-body .tracks .track').count() == 15)
        # This device's own Ollama loads the model in a request of its own too.
        own = lambda q='': json.loads(urllib.request.urlopen(f'{OLLAMA}/__mock/config?{q}', timeout=10).read())
        own('load=4&unload=1&reset=1')
        settings(page, {'ai': {**js(page, "() => import('./js/ai.js').then((m) => m.aiSettings())"), 'wait': 0.04}})
        page.click('button:has-text("Make another playlist")')
        page.fill('.ai-box input', 'Moody electronic for a rainy evening')
        page.press('.ai-box input', 'Enter')
        page.wait_for_selector('.ai-error', timeout=20000)
        said = page.locator('.ai-error p').first.inner_text()
        state = wait_for(lambda: (lambda st: st if st['loads'] else None)(own()), 15) or own()
        check('custom: giving up waiting for your own Ollama doesn\'t stop it loading the model', 'still loading' in said and state['loads'] == 1 and state['cancelled'] == 0, f'{said} {state}')
        own('load=0')
        settings(page, {'ai': {**js(page, "() => import('./js/ai.js').then((m) => m.aiSettings())"), 'wait': 5}})
        page.goto(APP_NOWS + '#/settings/ai')
        page.fill('.ai-custom input[type=url]', OLLAMA_NOTHINK)
        page.click('.ai-custom button:has-text("Connect")')
        page.wait_for_selector('text=Connected', timeout=15000)
        page.click('button:has-text("Test the model")')
        check('custom: works with an Ollama that rejects "think"', page.wait_for_selector('text=It works', timeout=20000) is not None)
        page.fill('.ai-custom input[type=url]', 'http://127.0.0.1:11999')
        page.click('.ai-custom button:has-text("Connect")')
        page.wait_for_selector('.ai-models .warn', timeout=25000)
        msg = page.locator('.ai-models .warn').inner_text()
        check('custom: explains an unreachable Ollama', 'Couldn’t reach Ollama' in msg and 'OLLAMA_ORIGINS' in msg, msg)
        ctx.close()

    # ---------- desktop layout ----------
    if run('desktop'):
        ctx = browser.new_context(viewport={'width': 1440, 'height': 900})
        page = ctx.new_page()
        attach(page, 'desktop')
        login(page, APP)
        shot(page, 'desktop-01-home')
        # Card buttons: play and shuffle, centred on the artwork, on hover.
        page.wait_for_selector('section[data-section=recentlyAdded] .card .card-shuffle', state='attached')
        card = page.locator('section[data-section=recentlyAdded] .card').first
        card.scroll_into_view_if_needed()
        opacity = lambda: card.locator('.card-actions').evaluate('e => getComputedStyle(e).opacity')
        hidden = opacity()
        card.hover()
        page.wait_for_timeout(400)
        check('cards: play and shuffle appear on hover', hidden == '0' and opacity() == '1', f'{hidden} -> {opacity()}')
        art = card.locator('.card-art').bounding_box()
        play = card.locator('.card-play').bounding_box()
        shuf = card.locator('.card-shuffle').bounding_box()
        across = (play['x'] + shuf['x'] + shuf['width']) / 2 - (art['x'] + art['width'] / 2)
        down = play['y'] + play['height'] / 2 - (art['y'] + art['height'] / 2)
        check('cards: the buttons sit in the middle of the artwork',
              abs(across) < 2 and abs(down) < 2 and shuf['x'] > play['x'] + play['width'], f'{across:.1f}, {down:.1f}')
        shot(page, 'desktop-02-card-hover')
        card.locator('.card-shuffle').click()
        check('cards: Shuffle plays the album shuffled',
              wait_for(lambda: player(page, "p.state === 'playing' && p.shuffle && p.context.href.startsWith('/album/')"), 10))
        check('cards: … without opening it', page.evaluate('location.hash') in ('', '#/'), page.evaluate('location.hash'))
        pl = page.locator('section[data-section=recentPlaylists] .card').first
        pl.hover()
        pl.locator('.card-play').click()
        check('cards: Play plays the playlist in order',
              wait_for(lambda: player(page, "p.state === 'playing' && !p.shuffle && p.context.href.startsWith('/playlist/')"), 10))
        page.mouse.move(5, 5)

        # Shelves, with a mouse: ‹ › by the heading scroll them a screenful
        # (‹ once one has moved, › until its end, neither when it all fits),
        # and the title opens the whole list.
        sec = page.locator('section[data-section=recentlyAdded]')
        sec.locator('.shelf-head').scroll_into_view_if_needed()
        page.wait_for_timeout(300)
        shelf_state = lambda s: s.evaluate("""(s) => {
            const shelf = s.querySelector('.shelf'), box = shelf.getBoundingClientRect(), pad = parseFloat(getComputedStyle(shelf).paddingLeft);
            const cards = [...shelf.querySelectorAll('.card')];
            const on = (label) => { const b = s.querySelector(`.shelf-nav button[aria-label="${label}"]`); return !!b && b.checkVisibility({ visibilityProperty: true }); };
            return { x: Math.round(shelf.scrollLeft), first: cards.findIndex((c) => c.getBoundingClientRect().left >= box.left + pad - 2),
                     cut: cards.findIndex((c) => c.getBoundingClientRect().right > box.right - pad + 1), back: on('Scroll left'), on: on('Scroll right') };
        }""")
        before = shelf_state(sec)
        sec.locator('button[aria-label="Scroll right"]').click()
        page.wait_for_timeout(900)
        paged = shelf_state(sec)
        for _ in range(8):
            if not shelf_state(sec)['on']:
                break
            sec.locator('button[aria-label="Scroll right"]').click()
            page.wait_for_timeout(900)
        end = shelf_state(sec)
        for _ in range(8):
            if not shelf_state(sec)['back']:
                break
            sec.locator('button[aria-label="Scroll left"]').click()
            page.wait_for_timeout(900)
        start = shelf_state(sec)
        check('shelves: › scrolls a shelf on, the card that was cut off coming first, and ‹ appears',
              before['x'] == 0 and before['on'] and not before['back'] and before['cut'] > 0 and paged['x'] > 0 and paged['first'] == before['cut'] and paged['back'],
              f'{before} {paged}')
        check('shelves: › goes at the end, and ‹ brings the shelf back to the start',
              not end['on'] and end['back'] and start['x'] == 0 and not start['back'] and start['on'], f'{end} {start}')
        fits = page.locator('section[data-section=collections]')
        fits.locator('.shelf-head').scroll_into_view_if_needed()
        page.wait_for_timeout(300)
        check('shelves: a shelf that fits has neither', not shelf_state(fits)['on'] and not shelf_state(fits)['back'], str(shelf_state(fits)))
        heading = sec.locator('.shelf-head')
        check('shelves: the title is the link to the whole list, with nothing else beside the arrows',
              heading.evaluate('e => e.tagName') == 'DIV' and 'browse/albums' in (sec.locator('.section-link').get_attribute('href') or '')
              and heading.evaluate('e => [...e.children].map((c) => c.className).join(" ")') == 'section-link shelf-nav', heading.evaluate('e => e.outerHTML.slice(0, 300)'))
        sec.locator('.section-link').click()
        page.wait_for_selector('.grid .card')
        check('shelves: the title opens it', page.evaluate('location.hash').startswith('#/browse/albums'), page.evaluate('location.hash'))

        # Big screens: pages to browse use the whole width (no gap on the
        # right); settings and the like keep to a column in the middle.
        page.set_viewport_size({'width': 2560, 'height': 1440})
        page.goto(APP + '#/')
        page.wait_for_selector('section[data-section=recentlyAdded] .card')
        span = "() => { const v = document.querySelector('#main > .view').getBoundingClientRect(), m = document.querySelector('#main').getBoundingClientRect(); return [Math.round(v.width), Math.round(v.left - m.left), Math.round(m.right - v.right)]; }"
        browse = js(page, span)
        page.goto(APP + '#/settings')
        page.wait_for_selector('.view .row')
        column = js(page, span)
        check('desktop: on a big screen pages to browse use the whole width, and settings keep to a column in the middle',
              browse[1:] == [0, 0] and column[0] == 1080 and abs(column[1] - column[2]) <= 1, f'{browse} {column}')
        page.goto(APP + '#/settings/experience')
        page.wait_for_selector('.view .back-head')
        bar = js(page, """() => {
            const r = (s) => document.querySelector(s).getBoundingClientRect();
            const head = r('.back-head'), main = r('#main'), view = r('#main > .view'), back = r('.back-head .icon-btn');
            return [Math.round(head.left - main.left), Math.round(main.right - head.right), Math.round(back.left - view.left), document.documentElement.scrollWidth - document.documentElement.clientWidth];
        }""")
        check('desktop: ...with the bar at the top of a settings page right across, its back button over the column (and nothing wider than the window)',
              bar[0] <= 0 and bar[1] <= 0 and bar[2] == 18 and bar[3] == 0, str(bar))
        page.set_viewport_size({'width': 1440, 'height': 900})
        page.goto(APP + '#/')
        page.wait_for_selector('section[data-section=recentlyAdded] .card')
        page.mouse.move(5, 5)

        # Volume: marks at 25/50/75%, settling on a mark when dragged near
        # it, the level shown while it changes, and a speaker with fewer
        # waves as it goes down.
        vol = page.locator('.pb .vol-slider input')
        box = vol.bounding_box()
        at = lambda frac: (box['x'] + 7 + (box['width'] - 14) * frac, box['y'] + box['height'] / 2)
        level = lambda: page.locator('.pb .volume .icon-btn').get_attribute('data-level')
        page.mouse.move(*at(0.9))
        page.mouse.down()
        page.mouse.move(*at(0.52), steps=6)
        page.wait_for_timeout(250)
        tip = page.locator('.pb .vol-tip')
        dragging = dict(v=player(page, 'p.volume'), tip=tip.inner_text(), shown=tip.evaluate('e => getComputedStyle(e).opacity'), level=level())
        page.mouse.move(*at(0.62), steps=4)
        free = player(page, 'p.volume')
        page.mouse.up()
        check('volume: settles on 50% when dragged near it, and shows the level',
              dragging['v'] == 0.5 and dragging['tip'] == '50%' and float(dragging['shown']) > 0.9, json.dumps(dragging))
        check('volume: ...but anywhere else is fine too', abs(free - 0.62) < 0.015, free)
        check('volume: marks at 25, 50 and 75%', page.locator('.pb .vol-marks i').count() == 3)
        levels = []
        for v in (0.8, 0.6, 0.3, 0.1, 0):
            player(page, f'p.setVolume({v})')
            levels.append(level())
        check('volume: the speaker loses a wave under 75, 50 and 25%, and is crossed out at 0',
              levels == ['speaker3', 'speaker2', 'speaker1', 'speaker0', 'speakerOff'], str(levels))
        player(page, 'p.setVolume(0.5)')
        vol.focus()
        page.keyboard.press('ArrowLeft')
        check('volume: the arrow keys move 1% at a time (no settling)', abs(player(page, 'p.volume') - 0.49) < 0.001, player(page, 'p.volume'))
        player(page, 'p.setVolume(1)')
        page.mouse.move(5, 5)
        page.goto(APP + '#/ai-playlist')
        page.wait_for_selector('.ai-suggestion')
        page.click('.ai-suggestion')
        page.wait_for_selector('.ai-result', timeout=60000)
        page.click('.ai-actions button:has-text("Play")')
        page.wait_for_timeout(1200)
        page.click('.pb-right button[aria-label="Open now playing"]')
        page.wait_for_selector('.np.open')
        shot(page, 'desktop-03-now-playing')
        page.click('.np-tool[data-tool=dj]')
        page.wait_for_selector('.sheet.dialog.open')
        shot(page, 'desktop-04-guest-dj')
        check('desktop: Guest DJ dialog opens', True)
        ctx.close()

    # ---------- nav: Back stays within the tab you're in ----------
    if run('nav'):
        ctx = browser.new_context(**MOBILE)
        page = ctx.new_page()
        attach(page, 'nav')
        login(page, APP)
        where = lambda: js(page, '() => location.hash')
        tab = lambda: page.locator('#tabs .tab.active').get_attribute('data-tab')

        def settle(selector):
            page.wait_for_selector(selector)
            page.wait_for_timeout(250)

        def header_back():
            page.click('.back-head button[aria-label="Back"]')
            page.wait_for_timeout(500)

        def tap_tab(name):
            page.click(f'#tabs .tab[data-tab={name}]')
            page.wait_for_timeout(700)

        # (Clicked again if Home was drawn again just as it was clicked.)
        for _ in range(3):
            page.locator('section[data-section=recentlyAdded] .card').first.click()
            try:
                page.wait_for_selector('.hero-album', timeout=10000)
                break
            except Exception:
                pass
        settle('.hero-album')
        home_album = where()
        tap_tab('search')
        settle('.search-box')
        page.click('a.row:has-text("Top albums")')
        settle('.row-ranked')
        page.locator('.row-ranked').first.click()
        settle('.hero-album')
        header_back()
        check('nav: back goes to the previous page in the tab', where() == '#/top/albums', where())
        tap_tab('settings')
        settle('.settings-rows')
        tap_tab('search')
        check('nav: a tab comes back where you left it', where() == '#/top/albums' and tab() == 'search', where())
        header_back()
        check('nav: back stays in the tab (not the last tab visited)', where() == '#/search' and tab() == 'search', f'{where()} in {tab()}')
        page.go_back()
        page.wait_for_timeout(600)
        check('nav: the browser\'s back from a tab\'s first page goes to Home, where you left it', where() == home_album and tab() == 'home', f'{where()} in {tab()}')
        page.go_back()
        page.wait_for_timeout(600)
        check('nav: ...and then back within Home', where() == '#/' and tab() == 'home', where())

        # The library is browsed from Search; playlists have a tab of their own.
        check('nav: the tabs are Home, Playlists, Search, Together and Settings',
              page.locator('#tabs .tab').evaluate_all('ts => ts.map((t) => t.dataset.tab)') == ['home', 'playlists', 'search', 'together', 'settings'])
        tap_tab('playlists')
        settle('.grid-playlists .card')
        check('nav: the Playlists tab', where() == '#/playlists' and tab() == 'playlists' and page.locator('.view .page-title').inner_text() == 'Playlists')
        # A picture set for a playlist in Plex shows, rather than Plex's mosaic.
        pics = {t: urllib.parse.unquote(page.locator('.grid-playlists .card', has_text=t).first.locator('img').get_attribute('src') or '')
                for t in ('Late night', 'Favourite tracks')}
        check('nav: a playlist\'s own picture shows (and the mosaic for one without)', '/thumb/1700000000' in pics['Late night']
              and '/composite/' in pics['Favourite tracks'], str(pics))
        tap_tab('search')
        settle('a.browse-tile:has-text("Albums")')
        page.wait_for_timeout(600)
        tiles = [t.split('\n')[0] for t in page.locator('.view a.browse-tile:not([hidden])').all_inner_texts()]
        n_albums = mock('/library/sections/1/all?type=9&X-Plex-Token=t&X-Plex-Container-Size=0')['MediaContainer']['totalSize']
        albums_tile = page.locator('.view a.browse-tile', has_text='Albums').inner_text()
        check('nav: Search browses the library', tiles[:3] == ['Artists', 'Albums', 'Tracks'] and 'Genres' in tiles and 'Moods' in tiles
              and f'{n_albums} albums' in albums_tile, f'{tiles} {albums_tile}')
        page.click('.view a.browse-tile:has-text("Albums")')
        settle('.grid .card')
        page.locator('.grid .card').nth(1).click()
        settle('.hero-album')
        tap_tab('search')
        check('nav: tapping the tab you\'re in goes to its first page', where() == '#/search', where())
        page.click('.view a.browse-tile:has-text("Albums")')
        settle('.grid .card')
        page.locator('.grid .card').nth(2).click()
        settle('.hero-album')
        deep = where()
        page.reload()
        settle('.hero-album')
        header_back()
        check('nav: after a reload, back still stays in the tab', where().startswith('#/browse/albums') and tab() == 'search', where())
        page.go_forward()
        page.wait_for_timeout(600)
        check('nav: forward works too', where() == deep, where())
        page.click('.back-head button[aria-label="More options"]')
        page.wait_for_selector('.sheet.open')
        page.go_back()
        page.wait_for_timeout(500)
        check('nav: back closes a sheet first', page.locator('.sheet.open').count() == 0 and where() == deep, where())

        # Links from before (bookmarks, other pages) still work.
        page.goto(APP + '#/library/playlists')
        page.wait_for_timeout(800)
        check('nav: old links to the library\'s playlists open the Playlists tab', where() == '#/playlists' and tab() == 'playlists', f'{where()} in {tab()}')
        page.goto(APP + '#/library')
        page.wait_for_timeout(800)
        check('nav: ...and old links to the library open Search', where() == '#/search' and tab() == 'search', f'{where()} in {tab()}')

        page.goto(APP + '#/')
        settle('.page-sub')
        page.click('.page-sub')  # "on <server>": the library switcher
        page.click('.sheet.open .sheet-action:has-text("Change server")')
        settle('.source-body')
        check('nav: a link into another tab opens there', tab() == 'settings' and where() == '#/settings/source', f'{where()} in {tab()}')
        header_back()
        check('nav: ...and back goes to that tab\'s first page', where() == '#/settings', where())
        ctx.close()

    # ---------- library: search, narrowing lists, and adding lists to the queue ----------
    if run('library'):
        ctx = browser.new_context(**MOBILE)
        page = ctx.new_page()
        attach(page, 'library')
        login(page, APP)
        where = lambda: js(page, '() => location.hash')
        heads = lambda: page.locator('.search-body .section-head h2').all_inner_texts()

        # The library's lists, each with its count: in their places from the
        # start (nothing moves as the counts come in), and the counts kept
        # for next time, shown at once then.
        tiles_now = lambda: page.evaluate("""() => [...document.querySelectorAll('.browse-tile')].map((t) => ({
            title: t.querySelector('.browse-title').textContent, count: t.querySelector('.browse-count').textContent.trim(),
            top: Math.round(t.getBoundingClientRect().top), none: t.classList.contains('browse-none') }))""")
        js(page, "() => localStorage.removeItem('pw.libraryCounts')")
        mock('/__mock/config?delay=400')
        try:
            page.goto(APP + '#/search')
            page.wait_for_selector('.browse-tiles .browse-tile')
            early = tiles_now()
            settled = wait_for(lambda: (lambda ts: ts if all(t['count'] for t in ts) else None)(tiles_now()), 15, 0.3)
        finally:
            mock('/__mock/config?delay=0')
        below = lambda: page.locator('.search-body .section-head', has_text='Most played').evaluate('e => Math.round(e.getBoundingClientRect().top)')
        check('library: the library\'s lists are in their places from the start, and stay there as their counts come in',
              early and settled and [t['title'] for t in early] == [t['title'] for t in settled] and [t['top'] for t in early] == [t['top'] for t in settled]
              and any(not t['count'] for t in early) and all(t['count'] for t in settled), f'{early} {settled}')
        kept = js(page, "() => JSON.parse(localStorage.getItem('pw.libraryCounts') || 'null')")
        n_tracks = mock('/library/sections/1/all?type=10&X-Plex-Token=t&X-Plex-Container-Size=0')['MediaContainer']['totalSize']
        place = below()
        mock('/__mock/config?delay=1500')
        try:
            page.reload()
            page.wait_for_selector('.browse-tiles .browse-tile')
            at_once = tiles_now()
            place_again = below()
        finally:
            mock('/__mock/config?delay=0')
        check('library: ...their counts are kept for next time (just the numbers), and shown at once then',
              kept and kept.get('mock-server-1:1', {}).get('counts', {}).get('tracks') == n_tracks
              and all(t['count'] and t['count'] != '\u00a0' for t in at_once) and place_again == place, f'{kept} {at_once} {place} {place_again}')
        # One the library doesn't have, when they were last counted, isn't
        # shown (it is the next time, once it's been counted again).
        js(page, """() => { const k = JSON.parse(localStorage.getItem('pw.libraryCounts'));
            k['mock-server-1:1'].counts.soundtracks = 0; localStorage.setItem('pw.libraryCounts', JSON.stringify(k)); }""")
        page.reload()
        page.wait_for_selector('.browse-tiles .browse-tile')
        gone = 'Soundtracks' not in [t['title'] for t in tiles_now()]
        page.wait_for_timeout(1500)
        stays_gone = 'Soundtracks' not in [t['title'] for t in tiles_now()]
        page.reload()
        page.wait_for_selector('.browse-tiles .browse-tile')
        back = 'Soundtracks' in [t['title'] for t in tiles_now()]
        check('library: a list the library didn\'t have last time isn\'t shown (not even once it\'s counted), and is the time after', gone and stays_gone and back,
              f'{gone} {stays_gone} {back}')
        # A count that can't be had says so, and isn't taken for none: the
        # list stays, and so does its count for next time.
        kept_moods = lambda: js(page, "() => JSON.parse(localStorage.getItem('pw.libraryCounts'))['mock-server-1:1'].counts.moods")
        moods_before = kept_moods()
        no_moods = re.compile(r'/library/sections/1/mood\?')
        page.route(no_moods, lambda route: route.fulfill(status=500, body=''))
        try:
            page.reload()
            page.wait_for_selector('.browse-tiles .browse-tile')
            wait_for(lambda: page.locator('.browse-count.loading').count() == 0, 10, 0.3)
            page.wait_for_timeout(500)
            moods_tile = next((t for t in tiles_now() if t['title'] == 'Moods'), None)
            moods_href = page.locator('.browse-tile', has_text='Moods').get_attribute('href')
            moods_after = kept_moods()
        finally:
            page.unroute(no_moods)
        check('library: a count that can\'t be had says so, and isn\'t taken for none (the list stays, with what was kept)',
              moods_before and moods_tile and moods_tile['count'] == 'Unavailable' and not moods_tile['none'] and moods_href and moods_after == moods_before,
              f'{moods_before} {moods_tile} {moods_href} {moods_after}')

        # Search: one tap clears it, back to browsing.
        page.goto(APP + '#/search')
        page.wait_for_selector('.search-box input')
        check('library: no clear button before typing', not page.locator('.search-clear').is_visible())
        page.fill('.search-box input', 'harbour')
        searched = wait_for(lambda: any('ARTISTS' in t.upper() for t in heads()), 8)
        check('library: a clear button once there\'s a search', searched and page.locator('.search-clear').is_visible(), str(heads()))
        shot(page, 'library-01-search')
        page.click('.search-clear')
        page.wait_for_timeout(400)
        check('library: ...which clears it, back to browsing the library', page.locator('.search-box input').input_value() == ''
              and page.locator('a.browse-tile').count() > 0 and where() == '#/search' and not page.locator('.search-clear').is_visible()
              and js(page, "() => document.activeElement === document.querySelector('.search-box input')"), where())
        page.fill('.search-box input', 'harbour')
        page.wait_for_timeout(500)
        page.press('.search-box input', 'Escape')
        page.wait_for_timeout(400)
        check('library: Escape clears it too', page.locator('.search-box input').input_value() == '' and page.locator('a.browse-tile').count() > 0)

        # Searching for an artist: their popular tracks first, and tracks
        # before albums.
        gh_id = next(a['ratingKey'] for a in mock('/library/sections/1/all?type=8&X-Plex-Token=t')['MediaContainer']['Metadata'] if a['title'] == 'Glass Harbour')
        popular = [m['title'] for m in mock(f'/library/sections/1/all?type=10&artist.id={gh_id}&sort=ratingCount:desc&ratingCount%3E%3E=0&X-Plex-Container-Size=10&X-Plex-Token=t')['MediaContainer']['Metadata']]
        page.fill('.search-box input', 'glass harbour')
        wait_for(lambda: page.locator('.search-tracks .track').count() > 0, 8)
        shown = page.locator('.search-tracks .track .track-title').all_inner_texts()
        badges = page.locator('.search-tracks .track .popular-badge').count()
        shot(page, 'library-01a-artist-search')
        check('library: searching for an artist lists their popular tracks first', shown[:len(popular)] == popular and badges == len(popular), f'{shown} vs {popular}')
        check('library: ...with tracks before albums', heads()[:2] == ['ARTISTS', 'TRACKS'], str(heads()))
        page.fill('.search-box input', 'signal')
        wait_for(lambda: 'TRACKS' in heads() and 'ALBUMS' in heads(), 8)
        order = heads()
        check('library: tracks come before albums in any search, with no popular badges when it isn\'t an artist\'s',
              order.index('TRACKS') < order.index('ALBUMS') and page.locator('.search-tracks .popular-badge').count() == 0, str(order))
        page.press('.search-box input', 'Escape')
        page.wait_for_timeout(300)

        # Two editions of an album (Crate Digger, and a hi-res copy): one of
        # each song and album shows, the best-sounding, with its format.
        mock('/__mock/config?copy=1')
        try:
            crate = [a for a in mock('/library/sections/1/all?type=9&X-Plex-Container-Size=500&X-Plex-Token=t')['MediaContainer']['Metadata'] if a['title'] == 'Crate Digger']
            hires_album = max(crate, key=lambda a: int(a['ratingKey']))['ratingKey']
            hires = {t['ratingKey'] for t in mock(f'/library/metadata/{hires_album}/children?X-Plex-Token=t')['MediaContainer']['Metadata']}
            either = {t['ratingKey'] for a in crate for t in mock(f"/library/metadata/{a['ratingKey']}/children?X-Plex-Token=t")['MediaContainer']['Metadata']}
            page.fill('.search-box input', 'kilo meridian')
            wait_for(lambda: page.locator('.search-tracks .track-codec').count() > 0, 8)
            page.wait_for_timeout(800)
            # (Crate Digger's songs: not their tracks on others' albums, which
            # the search finds by who they're by.)
            rows = [r for r in page.locator('.search-tracks .track').evaluate_all('rs => rs.map((r) => [r.dataset.trackId, r.querySelector(".track-title").textContent, r.querySelector(".track-codec")?.textContent || "", !!r.querySelector(".track-codec.hires")])')
                    if r[0] in either]
            shot(page, 'library-01c-editions')
            check('library: search shows one of each song, not each copy', len(rows) == len({r[1] for r in rows}) and len(rows) >= 3, str(rows))
            check('library: ...the best-sounding copy, with its format (FLAC 24/96, marked hi-res)', all(r[0] in hires and r[2] == 'FLAC 24/96' and r[3] for r in rows), str(rows))
            page.fill('.search-box input', 'crate digger')
            wait_for(lambda: 'ALBUMS' in heads(), 8)
            page.wait_for_timeout(500)
            albums = page.locator('.block .rows .album-row').evaluate_all('rs => rs.map((r) => [r.querySelector("a").getAttribute("href"), r.querySelector(".row-title").textContent])')
            crates = [a for a in albums if a[1] == 'Crate Digger']
            check('library: ...and one of each album, the best-sounding edition', len(crates) == 1 and crates[0][0].endswith(f'/album/{hires_album}'), str(albums))
            settings(page, {'codecInfo': False})
            page.fill('.search-box input', 'kilo meridian')
            wait_for(lambda: page.locator('.search-tracks .track').count() > 0, 8)
            page.wait_for_timeout(500)
            check('library: with Show codec information off (Settings › Experience), no formats in search', page.locator('.search-tracks .track-codec').count() == 0)
            settings(page, {'codecInfo': True})
            page.press('.search-box input', 'Escape')
            page.wait_for_timeout(300)
        finally:
            mock('/__mock/config?copy=0')

        # Words kept as tags narrow a search: everything shown matches them all.
        page.fill('.search-box input', 'glass')
        page.press('.search-box input', 'Enter')
        page.wait_for_selector('.search-tags .filter-chip')
        page.fill('.search-box input', 'engine')
        narrowed = wait_for(lambda: page.locator('.search-body .track').count() > 0 and page.locator('.search-body .section-head h2').all_inner_texts() == ['TRACKS'], 8)
        titles = page.locator('.search-body .track .track-title').all_inner_texts()
        # (The subtitle without the track's format before it.)
        subs = page.locator('.search-body .track .track-sub').evaluate_all('ss => ss.map((s) => [...s.childNodes].filter((n) => !n.classList?.contains("track-codec")).map((n) => n.textContent).join(""))')
        check('library: Enter keeps a word as a tag, and the next words narrow the search', narrowed
              and page.locator('.search-tags .filter-chip').all_inner_texts() == ['glass'] and titles and all('engine' in t.lower() for t in titles)
              and all(x.startswith('Glass Harbour') for x in subs), f'{titles} {subs}')
        shot(page, 'library-01b-tags')
        page.fill('.search-box input', '')
        page.press('.search-box input', 'Backspace')
        page.wait_for_timeout(500)
        check('library: Backspace in an empty search takes the last tag off', page.locator('.search-tags .filter-chip').count() == 0
              and page.locator('a.browse-tile').count() > 0)
        page.fill('.search-box input', 'glass')
        page.click('.search-keep')
        page.fill('.search-box input', 'lights')
        page.wait_for_timeout(800)
        page.click('.search-clear')
        page.wait_for_timeout(400)
        check('library: + keeps a word too, and × clears the tags with the rest', page.locator('.search-tags .filter-chip').count() == 0
              and page.locator('.search-box input').input_value() == '' and page.locator('a.browse-tile').count() > 0)
        page.fill('.search-box input', 'harbour')
        page.wait_for_selector('.search-body a.row[href^="#/artist/"]', timeout=8000)
        page.locator('.search-body a.row[href^="#/artist/"]').first.click()
        page.wait_for_timeout(600)
        page.goto(APP + '#/search')
        page.wait_for_selector('a.browse-tile')
        check('library: no recent searches kept', page.locator('.section-head', has_text='Recent searches').count() == 0
              and not js(page, "() => Object.keys(localStorage).some((k) => k.startsWith('pw.recentSearches'))"))

        # Genres: each with how many albums have it; ones nothing has are left out.
        def total(q):
            return mock(f'/library/sections/1/all?type=9&{q}&X-Plex-Token=t&X-Plex-Container-Size=0')['MediaContainer']['totalSize']

        page.goto(APP + '#/tags/genre/9?title=Genres')
        page.wait_for_selector('.view .rows .row')
        counted = wait_for(lambda: all(page.locator('.view .rows .row .row-sub').all_inner_texts()), 8)
        names = page.locator('.view .rows .row .row-title').all_inner_texts()
        subs = page.locator('.view .rows .row .row-sub').all_inner_texts()
        electronic = total('genre=electronic')
        check('library: genres nothing has are left out, and each says how many albums have it', counted and 'Polka' not in names
              and 'Electronic' in names and subs[names.index('Electronic')] == f'{electronic} albums', f'{names} {subs}')
        page.locator('.view .rows .row', has_text='Electronic').click()
        page.wait_for_selector('.grid .card')
        check('library: a genre lists its albums', page.locator('.back-title').inner_text() == 'Electronic'
              and wait_for(lambda: page.locator('.list-count').inner_text() == f'{electronic} albums', 5), page.locator('.list-count').inner_text())

        # Searching within it: a decade, then a mood, each with how many albums.
        page.fill('.within input', '2020')
        page.wait_for_selector('.within-option', timeout=8000)
        both = total('genre=electronic&decade=2020')
        option = page.locator('.within-option').first.inner_text().replace('\n', ' ')
        check('library: searching within a genre offers a decade, with how many albums', '2020s' in option and f'Decade · {both} albums' in option, option)
        shot(page, 'library-02-within')
        page.locator('.within-option').first.click()
        page.wait_for_selector('.filter-chip')
        page.wait_for_timeout(500)
        check('library: ...and narrows the list to both', page.locator('.back-title').inner_text() == 'Electronic · 2020s'
              and page.locator('.filter-chip').all_inner_texts() == ['Electronic', '2020s']
              and wait_for(lambda: page.locator('.list-count').inner_text() == f'{both} albums', 5), page.locator('.back-title').inner_text())
        page.fill('.within input', 'calm')
        page.wait_for_selector('.within-option:has-text("Mood")', timeout=8000)
        page.locator('.within-option', has_text='Mood').first.click()
        page.wait_for_selector('.filter-chip >> nth=2')
        three = total('genre=electronic&decade=2020&mood=calm')
        check('library: ...and narrows again with a mood', page.locator('.back-title').inner_text() == 'Electronic · 2020s · Calm'
              and wait_for(lambda: page.locator('.list-count').inner_text() == f'{three} album{"" if three == 1 else "s"}', 5), page.locator('.list-count').inner_text())
        shot(page, 'library-03-narrowed')
        page.locator('.filter-chip', has_text='Electronic').click()
        page.wait_for_timeout(800)
        two = total('decade=2020&mood=calm')
        check('library: a filter can be taken off', page.locator('.back-title').inner_text() == '2020s · Calm'
              and wait_for(lambda: page.locator('.list-count').inner_text() == f'{two} album{"" if two == 1 else "s"}', 5), page.locator('.list-count').inner_text())
        page.fill('.within input', 'zzzz')
        page.wait_for_selector('.list-box:not([hidden]) + .list-box, .list-box:not([hidden]) .empty-state, .view .empty-state', timeout=8000)
        none = wait_for(lambda: page.locator('.view .empty-state', has_text='matches “zzzz”').count() == 1, 8)
        check('library: nothing offered when nothing would be left (and the list says nothing matches)', none and page.locator('.within-option').count() == 0)
        # What's typed stays when a filter is taken off.
        page.locator('.filter-chip', has_text='Calm').click()
        stays = wait_for(lambda: page.locator('.back-title').inner_text() == '2020s' and page.locator('.within input').input_value() == 'zzzz'
                         and page.locator('.view .empty-state', has_text='matches “zzzz”').count() == 1, 8)
        check('library: ...and what\'s typed stays when a filter is taken off', stays, f'{page.locator(".back-title").inner_text()} {page.locator(".within input").input_value()!r}')

        # What's typed narrows the list as it's typed: no choosing it first.
        page.goto(APP + '#/browse/albums')
        page.wait_for_selector('.grid .card')
        every = page.locator('.list-count').inner_text()
        page.fill('.within input', 'tidal')
        cards = lambda: page.locator('.list-box:not([hidden]) .grid .card .card-title').all_inner_texts()
        narrowed = wait_for(lambda: cards() == ['Tidal Lines'], 8)
        check('library: words in the title narrow a list as they\'re typed, with how many', narrowed and page.locator('.within-option', has_text='In the').count() == 0
              and wait_for(lambda: page.locator('.list-count').inner_text() == '1 album', 5), f'{cards()} {page.locator(".list-count").inner_text()}')
        shot(page, 'library-04-typed')
        # ...and come back with Back, and go with ×.
        page.locator('.list-box:not([hidden]) .grid .card').first.click()
        page.wait_for_selector('.hero-album')
        page.go_back()
        page.wait_for_selector('.within input')
        back_typed = wait_for(lambda: page.locator('.within input').input_value() == 'tidal' and cards() == ['Tidal Lines'], 8)
        page.click('.within .search-clear')
        cleared = wait_for(lambda: len(cards()) > 1 and page.locator('.list-count').inner_text() == every, 8)
        check('library: ...what was typed is still there after Back, and × shows the whole list again', back_typed and cleared, f'{page.locator(".within input").input_value()} {cards()}')
        page.goto(APP + '#/browse/artists')
        page.wait_for_selector('.view .rows .row')
        page.fill('.within input', 'glass')
        artists = wait_for(lambda: page.locator('.list-box:not([hidden]) .row-title').all_inner_texts() == ['Glass Harbour'], 8)
        check('library: an artist shows as their name is typed', artists, str(page.locator('.list-box:not([hidden]) .row-title').all_inner_texts()))
        sheet_action(page, '.back-head button[aria-label="Sort"]', 'Recently added')
        resorted = wait_for(lambda: 'sort=addedAt' in where() and page.locator('.within input').input_value() == 'glass'
                            and page.locator('.list-box:not([hidden]) .row-title').all_inner_texts() == ['Glass Harbour'], 8)
        check('library: ...and stays as it is when the list is sorted another way', resorted, f'{where()} {page.locator(".within input").input_value()!r}')

        # A playlist, a collection or a mix (an artist's page) into the queue.
        play_first_album_track(page, APP, album=0, track=0)
        fav = next(p for p in mock('/playlists?X-Plex-Token=t')['MediaContainer']['Metadata'] if p['title'] == 'Favourite tracks')
        page.goto(APP + f'#/playlist/{fav["ratingKey"]}')
        page.wait_for_selector('.hero-album')
        before = player(page, 'p.queue.length')
        sheet_action(page, '.back-head button[aria-label="More options"]', 'Add to queue')
        check('library: a playlist\'s menu adds it to the queue', wait_for(lambda: player(page, 'p.queue.length') == before + fav['leafCount'], 5)
              and page.locator('.toast', has_text=f'Added {fav["leafCount"]} tracks to the queue').count() > 0, player(page, 'p.queue.length'))
        sheet_action(page, '.back-head button[aria-label="More options"]', 'Play next')
        first = mock(f'/playlists/{fav["ratingKey"]}/items?X-Plex-Token=t&X-Plex-Container-Size=1')['MediaContainer']['Metadata'][0]['ratingKey']
        check('library: ...or plays it next', wait_for(lambda: player(page, 'p.queue[p.index + 1] && p.queue[p.index + 1].id') == str(first), 5))
        page.goto(APP + '#/artist/101')
        page.wait_for_selector('.back-head button[aria-label="More options"]')
        page.click('.back-head button[aria-label="More options"]')
        page.wait_for_selector('.sheet.open')
        artist_menu = page.locator('.sheet.open .sheet-action').all_inner_texts()
        page.keyboard.press('Escape')
        page.wait_for_timeout(400)
        cols = mock('/library/sections/1/collections?X-Plex-Token=t')['MediaContainer']['Metadata']
        page.goto(APP + f'#/collection/{cols[0]["ratingKey"]}')
        page.wait_for_selector('.back-head button[aria-label="More options"]')
        page.click('.back-head button[aria-label="More options"]')
        page.wait_for_selector('.sheet.open')
        col_menu = page.locator('.sheet.open .sheet-action').all_inner_texts()
        page.keyboard.press('Escape')
        check('library: mixes (artists) and collections can be added to the queue too',
              all(any(a in x for x in m) for m in (artist_menu, col_menu) for a in ('Play next', 'Add to queue')), f'{artist_menu} {col_menu}')
        player(page, 'p.pause()')

        # An artist's page: their releases by kind, as Plexamp has them,
        # Singles & EPs below Albums (Plex's listing of an artist's albums
        # doesn't say which kind each is: the app asks for their details),
        # then the artists Plex says are like them that the library has, and
        # those that sound like them, each with a page of more, and their
        # styles.
        named = {a['title']: a for a in mock('/library/sections/1/all?type=8&X-Plex-Container-Size=100&X-Plex-Token=t')['MediaContainer']['Metadata']}
        untyped = not any('Format' in a or 'Subformat' in a for a in mock(f"/library/metadata/{named['Glass Harbour']['ratingKey']}/children?X-Plex-Token=t")['MediaContainer']['Metadata'])
        group = lambda g: page.locator(f'.view section[data-group="{g}"] .card-title').all_inner_texts()
        # What Glass Harbour appear on, as Plex's row for it has it: the
        # compilation and the soundtrack with tracks of theirs.
        rows = mock(f"/hubs/metadata/{named['Glass Harbour']['ratingKey']}?count=100&X-Plex-Token=t")['MediaContainer']['Hub']
        want_on = [m['title'] for m in sorted(next(r for r in rows if r['hubIdentifier'] == 'artist.appearsOn')['Metadata'], key=lambda m: -m['year'])]
        page.goto(APP + f"#/artist/{named['Glass Harbour']['ratingKey']}")
        page.wait_for_selector('.view section[data-similar=sonic]', timeout=10000)
        page.wait_for_selector('.view section[data-group="Singles & EPs"]', timeout=10000)
        page.wait_for_selector('.view section[data-group="Appears on"]', timeout=10000)
        heads = [t.upper() for t in page.locator('.view .block h2').all_inner_texts()]
        order = [x for x in heads if x in ('ALBUMS', 'SINGLES & EPS', 'APPEARS ON', 'SIMILAR ARTISTS', 'SONICALLY SIMILAR ARTISTS', 'STYLES', 'ABOUT')]
        shot(page, 'library-02-artist')
        # (Other sections add albums to this artist: those are albums too.)
        check('library: an artist\'s page: Albums, then Singles & EPs, though Plex\'s listing of their albums doesn\'t say which is which',
              untyped and order[:2] == ['ALBUMS', 'SINGLES & EPS'] and {'Low Light Signals', 'Tidal Lines'} <= set(group('Albums')) and 'Buoy' not in group('Albums')
              and group('Singles & EPs') == ['Buoy'], f'{untyped} {heads} {group("Albums")} {group("Singles & EPs")}')
        on_subs = page.locator('.view section[data-group="Appears on"] .card-sub').all_inner_texts()
        check('library: ...then Appears on: others\' albums with their tracks on, newest first, by whom and when',
              len(want_on) == 2 and group('Appears on') == want_on and all(s.startswith('Various Artists · 20') for s in on_subs)
              and not set(want_on) & set(group('Albums')), f'{group("Appears on")} vs {want_on} {on_subs}')
        similar = page.locator('.view section[data-similar=similar] .card-title').all_inner_texts()
        check('library: ...then the artists Plex says are like them that the library has (in Plex\'s order), those that sound like them, their styles and About',
              order == ['ALBUMS', 'SINGLES & EPS', 'APPEARS ON', 'SIMILAR ARTISTS', 'SONICALLY SIMILAR ARTISTS', 'STYLES', 'ABOUT'] and similar == ['Kilo Meridian', 'Marisol Vega'], f'{order} {similar}')
        styles = page.locator('.view .artist-style-chips a.chip').all_inner_texts()
        page.locator('.view .artist-style-chips a.chip', has_text='Ambient').click()
        page.wait_for_selector('.view a.row[href^="#/artist/"]', timeout=10000)
        of_style = page.locator('.view a.row[href^="#/artist/"] .row-title').all_inner_texts()
        check('library: ...each style opening the library\'s artists of that style', styles == ['Ambient', 'Downtempo'] and of_style == ['Glass Harbour'] and 'style=' in page.url, f'{styles} {of_style} {page.url}')
        page.goto(APP + f"#/artist/{named['Glass Harbour']['ratingKey']}")
        page.wait_for_selector('.view section[data-similar=sonic]', timeout=10000)
        page.locator('.view section[data-similar=sonic] a.section-head, .view section[data-similar=sonic] a.section-link').first.click()
        page.wait_for_selector('.view .grid .card, .view .empty-state', timeout=10000)
        sonic = page.locator('.view .grid .card-title').all_inner_texts()
        check('library: ...Sonically similar artists with a page of more', page.url.endswith('/sonic') and sonic and 'Glass Harbour' not in sonic, f'{page.url} {sonic}')
        page.goto(APP + f"#/artist/{named['Glass Harbour']['ratingKey']}/similar")
        page.wait_for_selector('.view .grid .card, .view .empty-state', timeout=10000)
        check('library: ...as Similar artists has', page.locator('.view .grid .card-title').all_inner_texts() == ['Kilo Meridian', 'Marisol Vega'])
        page.goto(APP + f"#/artist/{named['Marisol Vega']['ratingKey']}")
        page.wait_for_selector('.view section[data-group="Live albums"]', timeout=10000)
        live_albums = group('Live albums')
        page.goto(APP + f"#/artist/{named['Various Artists']['ratingKey']}")
        page.wait_for_selector('.view section[data-group="Compilations"]', timeout=10000)
        check('library: ...and live albums, Compilations and Soundtracks, each of their own', live_albums == ['Live at the Lantern'] and group('Compilations') == ['Night Drive Vol. 1']
              and group('Soundtracks') == ['The Lighthouse (Original Score)'] and not group('Albums'), f'{live_albums} {group("Compilations")} {group("Soundtracks")} {group("Albums")}')
        page.wait_for_timeout(800)
        check('library: ...and Various Artists appear on nothing (all theirs are their own)', page.locator('.view section[data-group="Appears on"]').count() == 0)

        # Plex's rows for an artist's page: which kind each row holds, by
        # its identifier, else its title; whose each album is; tracks in a
        # row of what they appear on stand for their albums.
        hub_kinds = js(page, """() => import('./js/hubs.js').then(({ hubKind }) => [
            { hubIdentifier: 'artist.albums.ep' }, { hubIdentifier: 'hub.7', title: 'Singles & EPs' }, { hubIdentifier: 'artist.appearsOn', title: 'Appears On' },
            { hubIdentifier: 'artist.liveAlbums' }, { hubIdentifier: 'artist.albums.djMix' }, { hubIdentifier: 'artist.albums', title: 'Albums' },
            { hubIdentifier: 'artist.popular.tracks', title: 'Popular Tracks' }, { title: 'Live-Alben' }, { hubIdentifier: 'hub.3', context: 'hub.artist.compilations' }, {},
        ].map(hubKind))""")
        check('library: Plex\'s rows for an artist\'s page are told apart by their identifiers, or else their titles',
              hub_kinds == ['singles', 'singles', 'appears', 'live', 'djmixes', 'albums', None, 'live', 'compilations', None], str(hub_kinds))
        from_rows = js(page, """() => import('./js/hubs.js').then(({ releasesFromHubs }) => {
            const own = (id, more = {}) => ({ type: 'album', ratingKey: String(id), parentRatingKey: '7', title: 'A' + id, ...more });
            const got = releasesFromHubs([
                { hubIdentifier: 'artist.albums', type: 'album', Metadata: [own(1), own(2, { Format: [{ tag: 'EP' }] }), own(3)] },
                { hubIdentifier: 'artist.albums.single', type: 'album', Metadata: [own(3)] },
                { hubIdentifier: 'artist.albums.live', type: 'album', Metadata: [own(4), { type: 'album', ratingKey: '9', parentRatingKey: '8', title: 'Theirs' }] },
                { hubIdentifier: 'artist.appearsOn', type: 'track', Metadata: [
                    { type: 'track', ratingKey: '50', parentRatingKey: '10', parentTitle: 'Mix', grandparentRatingKey: '8', grandparentTitle: 'Various Artists', parentYear: 1999 },
                    { type: 'track', ratingKey: '51', parentRatingKey: '5', grandparentRatingKey: '7' }] },
                { hubIdentifier: 'artist.similar', type: 'artist', Metadata: [{ type: 'artist', ratingKey: '11' }] },
                { hubIdentifier: 'artist.appearsOn', type: 'album', Metadata: { type: 'album', ratingKey: '9', parentRatingKey: '8', title: 'Theirs' } },
                { hubIdentifier: 'hub.9', title: 'Appears On', type: 'album', Metadata: [{ type: 'album', ratingKey: '12', title: 'Untold' }, own(13, { title: 'Mine' }),
                    { type: 'album', ratingKey: '9', parentRatingKey: '8', title: 'Theirs' }] },
                { hubIdentifier: 'artist.appearances', type: 'album', Metadata: [{ ratingKey: '14', parentRatingKey: '8', title: 'No type said' }] },
                null, { Metadata: 'nonsense' },
            ], 7);
            return { kinds: Object.fromEntries(got.kinds), appears: got.appears.map((m) => [m.ratingKey, m.title, m.parentTitle || '', m.year || null]) };
        })""")
        check('library: ...an album\'s own kind first, the row that says more than albums, and others\' albums (once each) where a row says they appear on them',
              from_rows == {'kinds': {'1': 'albums', '2': 'singles', '3': 'singles', '4': 'live'},
                            'appears': [['10', 'Mix', 'Various Artists', 1999], ['9', 'Theirs', '', None], ['12', 'Untold', '', None], ['14', 'No type said', '', None]]}, str(from_rows))

        # Who a track's credited to: its whole credit, or a name either side
        # of a featured one, never part of a name with "&" in it. So someone
        # whose name is part of a duo's (Ash, and Juniper & Ash on the
        # soundtrack) appears on nothing of the duo's, by Plex's rows or its
        # search.
        credits = js(page, """() => import('./js/hubs.js').then(({ creditedTo }) => [
            ['Sam & Dave', 'dave'], ['Dave feat. Sam', 'dave'], ['Earth, Wind & Fire', 'earth'], ['Love and Rockets', 'love'],
            ['Underworld vs. Blondie', 'blondie'], ['Iggy Pop; Blondie', 'blondie'], ['Blondie / Iggy Pop', 'blondie'], ['Glass Harbour', 'glass harbour'],
            ['David Guetta, Sia', 'sia', []], ['Sam & Dave', 'dave', ['dave']], ['Earth, Wind & Fire', 'earth', []], ['Tyler, The Creator', 'tyler', ['tyler the creator']],
        ].map(([originalTitle, want, known]) => creditedTo({ originalTitle }, want, known ? new Set(known) : null)))""")
        check('library: a track\'s credited to an artist by its whole credit, either side of a featured one, or in a list with commas that isn\'t a library artist\'s name, never by part of a name with & in it',
              credits == [False, True, False, False, True, True, True, True, True, False, False, False], str(credits))
        ash = mock('/__mock/add-artist?name=Ash')['MediaContainer']['Metadata'][0]
        try:
            seen = {}
            for config in ('hubs=on', 'hubs=off'):
                mock(f'/__mock/config?{config}')
                page.goto('about:blank')
                page.goto(APP + f"#/artist/{ash['ratingKey']}")
                page.wait_for_selector('.view section[data-group]', timeout=15000)
                page.wait_for_timeout(1500)
                seen[config] = (group('Albums'), group('Appears on'))
            check('library: ...so Ash appear on nothing of Juniper & Ash\'s, by Plex\'s rows or its search',
                  all(albums == ['Ash Alone'] and not on for albums, on in seen.values()), str(seen))
        finally:
            mock('/__mock/config?hubs=on')
            mock(f"/__mock/add-artist?remove={ash['ratingKey']}")

        # Where an album's details don't say what kind it is (as on some
        # servers), Plex's rows do; where they say only by their titles,
        # those do; with no rows (an older server), its details do, and
        # what they appear on is found by Plex's search (which finds tracks
        # by who they're by). Each from the start, as nothing's kept.
        def kinds_with(config):
            mock(f'/__mock/config?{config}')
            out = {}
            for name in ('Glass Harbour', 'Marisol Vega', 'Various Artists'):
                # (Opened afresh, so nothing's kept from before.)
                page.goto('about:blank')
                page.goto(APP + f"#/artist/{named[name]['ratingKey']}")
                page.wait_for_selector('.view section[data-group]', timeout=15000)
                page.wait_for_timeout(1500)
                out[name] = {g: group(g) for g in ('Albums', 'Singles & EPs', 'Live albums', 'Compilations', 'Soundtracks', 'Appears on') if group(g)}
            return out
        def appears_on(name):  # as the mock's row for it has them
            rows = mock(f"/hubs/metadata/{named[name]['ratingKey']}?count=100&X-Plex-Token=t")['MediaContainer']['Hub']
            return [m['title'] for r in rows if r['hubIdentifier'] == 'artist.appearsOn' for m in r['Metadata']]
        try:
            want_kinds = {'Glass Harbour': {'Albums': ['Tidal Lines', 'Low Light Signals'], 'Singles & EPs': ['Buoy']},
                          'Marisol Vega': {'Albums': ['Noches de Cobre'], 'Live albums': ['Live at the Lantern']},
                          'Various Artists': {'Compilations': ['Night Drive Vol. 1'], 'Soundtracks': ['The Lighthouse (Original Score)']}}
            for name, kinds in want_kinds.items():
                if appears_on(name):
                    kinds['Appears on'] = appears_on(name)
            for config, says in (('types=off&hubs=on', 'by Plex\'s rows for the page, though its details don\'t say'),
                                 ('types=off&hubs=titles', '...and by their titles, where only those say'),
                                 ('types=on&hubs=off', 'by its details, with no rows for the page, and Appears on by Plex\'s search')):
                got = kinds_with(config)
                # (Albums other sections added to an artist aren't counted.)
                for name, kinds in got.items():
                    known = sum(want_kinds[name].values(), [])
                    got[name] = {g: sorted(t for t in v if g != 'Albums' or t in known) for g, v in kinds.items()}
                    got[name] = {g: v for g, v in got[name].items() if v}
                ok = all(got[n] == {g: sorted(v) for g, v in want_kinds[n].items()} for n in want_kinds)
                check(f'library: an artist\'s releases by kind {says}', ok, str(got))
            got = kinds_with('types=off&hubs=off')
            gh = got['Glass Harbour']
            check('library: ...and with neither, all of them albums, and still what they appear on',
                  {'Tidal Lines', 'Low Light Signals', 'Buoy'} <= set(gh.get('Albums', [])) and 'Singles & EPs' not in gh and sorted(gh.get('Appears on', [])) == sorted(want_on),
                  str(got))
        finally:
            mock('/__mock/config?types=on&hubs=on')
        ctx.close()

    # ---------- edit: the queue, playlists and collections ----------
    # Everything here makes its own playlists and collections ("Edit test
    # …"), so the mock's own ones stay as other sections expect them.
    if run('edit'):
        ctx = browser.new_context(**MOBILE)
        page = ctx.new_page()
        attach(page, 'edit')
        login(page, APP)
        check('edit: the server\'s owner is its admin', js(page, "() => import('./js/editing.js').then((m) => m.isAdmin())") is True)

        def playlist(title):
            pls = mock('/playlists?X-Plex-Token=t&X-Plex-Container-Size=500')['MediaContainer'].get('Metadata', [])
            return next((p for p in pls if p['title'] == title), None)

        def entries(pid):
            return [m['title'] for m in mock(f'/playlists/{pid}/items?X-Plex-Token=t&X-Plex-Container-Size=500')['MediaContainer'].get('Metadata', [])]

        def collection(title):
            cs = mock('/library/sections/1/collections?X-Plex-Token=t&X-Plex-Container-Size=200')['MediaContainer'].get('Metadata', [])
            return next((c for c in cs if c['title'] == title), None)

        def members(cid):
            return [m['title'] for m in mock(f'/library/collections/{cid}/children?X-Plex-Token=t')['MediaContainer'].get('Metadata', [])]

        def menu(opener, label):
            page.click(opener)
            page.wait_for_selector('.sheet.open')
            page.locator('.sheet.open .sheet-action', has_text=label).first.click()
            page.wait_for_timeout(350)  # this sheet closes (and the next one may open)

        def pick(title, label, exact=False):
            page.wait_for_selector(f'.sheet.open .sheet-title:has-text("{title}")')
            if exact:
                page.locator(f'.sheet.open .sheet-action:has(.sheet-action-label:text-is("{label}"))').click()
            else:
                page.locator('.sheet.open .sheet-action', has_text=label).first.click()
            page.wait_for_timeout(350)

        def answer(text):
            page.wait_for_selector('.sheet.open .ask-form input')
            page.wait_for_timeout(250)
            page.fill('.sheet.open .ask-form input', text)
            page.click('.sheet.open .ask-form button[type=submit]')

        def drag(handles, src, dst):
            page.evaluate(f"window.scrollTo(0, document.querySelector({json.dumps(handles)}).getBoundingClientRect().top + window.scrollY - 220)")
            page.wait_for_timeout(250)
            a, z = page.locator(handles).nth(src).bounding_box(), page.locator(handles).nth(dst).bounding_box()
            page.mouse.move(a['x'] + a['width'] / 2, a['y'] + a['height'] / 2)
            page.mouse.down()
            for i in range(1, 15):
                page.mouse.move(a['x'] + a['width'] / 2, a['y'] + (z['y'] - 20 - a['y']) * i / 14)
                page.wait_for_timeout(30)
            page.mouse.up()
            page.wait_for_timeout(700)

        # The queue: Move to top, and saving it as a playlist.
        play_first_album_track(page, APP, album=0, track=0)
        page.click('.pb-main')
        page.wait_for_selector('.np.open')
        page.click('.np-tool[data-tool=queue]')
        page.wait_for_selector('.np-queue-list .track')
        before = player(page, 'p.queue.map((t) => t.id)')
        i = player(page, 'p.index')
        page.locator('.np-queue-list .track .track-more').nth(3).click()
        page.wait_for_selector('.sheet.open')
        labels = page.locator('.sheet.open .sheet-action-label').all_text_contents()
        page.locator('.sheet.open .sheet-action', has_text='Move to top').click()
        page.wait_for_timeout(400)
        after = player(page, 'p.queue.map((t) => t.id)')
        check('edit: Move to top makes an upcoming track play next', 'Move to top' in labels and after[i + 1] == before[i + 3]
              and sorted(after) == sorted(before), f'{labels} {before} -> {after}')
        page.locator('.np-queue-list .track .track-more').nth(1).click()
        page.wait_for_selector('.sheet.open')
        check('edit: ...and isn\'t offered for the track that\'s already next', 'Move to top' not in page.locator('.sheet.open .sheet-action-label').all_text_contents())
        page.keyboard.press('Escape')
        page.wait_for_selector('.sheet', state='detached')
        menu('.np-queue-more', 'Save as a playlist')
        pick('Add to playlist', 'New playlist')
        answer('Edit test queue')
        page.wait_for_selector('.toast:has-text("Made")')
        q = playlist('Edit test queue')
        check('edit: the queue can be saved as a playlist', q and q['leafCount'] == len(after) - i, json.dumps(q and q['leafCount']))
        page.wait_for_selector('.sheet', state='detached')
        page.keyboard.press('Escape')
        page.wait_for_selector('.np.open', state='detached')

        # Adding to playlists: a new one from a track, then a whole album.
        page.locator('.track .track-more').first.click()
        page.wait_for_selector('.sheet.open')
        page.locator('.sheet.open .sheet-action', has_text='Add to playlist').click()
        page.wait_for_timeout(350)
        pick('Add to playlist', 'New playlist')
        answer('Edit test')
        page.wait_for_selector('.toast:has-text("Made")')
        made = playlist('Edit test')
        check('edit: a new playlist from a track', made and made['leafCount'] == 1, json.dumps(made and made['leafCount']))
        album_tracks = page.locator('.view .track').count()
        menu('.back-head button[aria-label="More options"]', 'Add to playlist')
        pick('Add to playlist', 'Edit test', exact=True)
        page.wait_for_selector('.toast:has-text("Added")')
        told = page.locator('.toast').inner_text()
        made = playlist('Edit test')
        check('edit: adding an album skips what\'s there already', made['leafCount'] == album_tracks and 'there already' in told, f'{made["leafCount"]} {told}')

        # A playlist is locked until it's unlocked; then rows can be dragged
        # and removed (with undo), and it can be renamed and deleted.
        page.goto(APP + f'#/playlist/{made["ratingKey"]}')
        page.wait_for_selector('.view .tracks .track')
        hinted = page.wait_for_selector('.hint-bubble.shown', timeout=5000)
        check('edit: a locked playlist points out its lock', hinted is not None and 'Tap the lock' in page.locator('.hint-bubble').inner_text())
        shot(page, 'edit-00-lock-hint')
        page.locator('.view .tracks .track .track-more').first.click()
        page.wait_for_selector('.sheet.open')
        labels = page.locator('.sheet.open .sheet-action-label').all_text_contents()
        # (The hint fades out over a quarter of a second, so it's checked as no longer shown.)
        check('edit: ...and a track\'s menu there offers to unlock it', 'Edit playlist' in labels and 'Remove from playlist' not in labels and page.locator('.hint-bubble.shown').count() == 0, str(labels))
        page.keyboard.press('Escape')
        page.wait_for_selector('.sheet', state='detached')
        locked = page.locator('.view .tracks .track .drag-handle, .tracks .track .row-remove').count()
        page.click('.lock-btn')
        page.wait_for_selector('.edit-bar:not([hidden])')
        shot(page, 'edit-01-playlist-unlocked')
        check('edit: a playlist is locked until unlocked', locked == 0 and page.locator('.view .tracks .track .drag-handle').count() == made['leafCount'])
        # Once the lock has been used, it isn't pointed out again.
        page.goto(APP + f'#/playlist/{q["ratingKey"]}')
        page.wait_for_selector('.view .tracks .track')
        page.wait_for_timeout(1600)
        check('edit: ...and once the lock has been used, it isn\'t pointed out again', page.locator('.hint-bubble').count() == 0)
        page.go_back()
        page.wait_for_selector('.view .tracks .track')
        if page.locator('.edit-bar:not([hidden])').count() == 0:
            page.click('.lock-btn')
            page.wait_for_selector('.edit-bar:not([hidden])')
        start = entries(made['ratingKey'])
        drag('.view .tracks .track .drag-handle', 2, 0)
        moved = entries(made['ratingKey'])
        shown = page.locator('.view .tracks .track').evaluate_all('rs => rs.map((r) => r.dataset.title)')
        check('edit: dragging a track moves it in the playlist', moved == [start[2], start[0], start[1], *start[3:]] and shown == moved, f'{start} -> {moved}')
        removed = page.locator('.view .tracks .track').nth(1).get_attribute('data-track-id')
        page.locator('.view .tracks .track .row-remove').nth(1).click()
        page.wait_for_selector('.toast:has-text("Removed")')
        gone = entries(made['ratingKey'])
        check('edit: removing takes it out of the playlist', gone == [moved[0], *moved[2:]], str(gone))
        check('edit: ...and leaves the track in the library', mock(f'/library/metadata/{removed}?X-Plex-Token=t')['MediaContainer']['size'] == 1)
        page.click('.toast-action')
        page.wait_for_timeout(1200)
        check('edit: ...and Undo puts it back where it was', entries(made['ratingKey']) == moved, str(entries(made['ratingKey'])))
        menu('.back-head button[aria-label="More options"]', 'Rename')
        answer('Edit test (renamed)')
        page.wait_for_timeout(600)
        check('edit: a playlist can be renamed', playlist('Edit test (renamed)') is not None and page.locator('.hero-title').inner_text() == 'Edit test (renamed)')
        page.click('.edit-done')
        page.wait_for_timeout(300)
        check('edit: Done locks it again', page.locator('.edit-bar').is_hidden() and page.locator('.row-remove').count() == 0)
        page.click('.lock-btn')
        menu('.back-head button[aria-label="More options"]', 'Delete playlist')
        page.wait_for_selector('.sheet.open .ask-form .btn-danger')
        page.click('.sheet.open .ask-form .btn-danger')
        page.wait_for_selector('.toast:has-text("Deleted")')
        page.wait_for_timeout(500)
        check('edit: a playlist can be deleted (after asking)', playlist('Edit test (renamed)') is None and not page.url.endswith(f'/playlist/{made["ratingKey"]}'), page.url)
        smart = playlist('Everything')
        page.goto(APP + f'#/playlist/{smart["ratingKey"]}')
        page.wait_for_selector('.view .tracks .track')
        check('edit: smart playlists can\'t be edited', page.locator('.lock-btn').count() == 0)

        # Collections (the server's admin): new ones of each kind, adding a
        # playlist's tracks, then editing one like a playlist.
        page.goto(APP + '#/browse/albums')
        page.wait_for_selector('.grid .card')
        page.locator('.grid .card').first.click()
        page.wait_for_selector('.hero-album')
        album = page.locator('.hero-title').inner_text()
        menu('.back-head button[aria-label="More options"]', 'Add to collection')
        pick('Add to album collection', 'New collection')
        answer('Edit test albums')
        page.wait_for_selector('.toast:has-text("Made")')
        ca = collection('Edit test albums')
        check('edit: a new album collection from an album', ca and ca['subtype'] == 'album' and members(ca['ratingKey']) == [album], json.dumps(ca))
        page.locator('.track .track-more').nth(1).click()
        page.wait_for_selector('.sheet.open')
        page.locator('.sheet.open .sheet-action', has_text='Add to collection').click()
        page.wait_for_timeout(350)
        pick('Add to track collection', 'New collection')
        answer('Edit test tracks')
        page.wait_for_selector('.toast:has-text("Made")')
        ct = collection('Edit test tracks')
        check('edit: a new track collection from a track', ct and ct['subtype'] == 'track' and len(members(ct['ratingKey'])) == 1, json.dumps(ct))
        page.goto(APP + f'#/playlist/{q["ratingKey"]}')
        page.wait_for_selector('.view .tracks .track')
        menu('.back-head button[aria-label="More options"]', 'Add to collection')
        pick('Add to track collection', 'Edit test tracks', exact=True)
        page.wait_for_selector('.toast:has-text("Added")')
        check('edit: a playlist\'s tracks go into a collection', len(members(ct['ratingKey'])) >= 4, str(members(ct['ratingKey'])))

        page.goto(APP + f'#/collection/{ct["ratingKey"]}')
        page.wait_for_selector('.hero-album')
        page.click('.lock-btn')
        page.wait_for_selector('.edit-rows .edit-row')
        shot(page, 'edit-02-collection-unlocked')
        start = members(ct['ratingKey'])
        drag('.edit-rows .drag-handle', 2, 0)
        moved = members(ct['ratingKey'])
        check('edit: dragging changes a collection\'s order (it switches to custom order)',
              moved == [start[2], start[0], start[1], *start[3:]] and collection('Edit test tracks')['collectionSort'] == 2, f'{start} -> {moved}')
        page.locator('.edit-rows .row-remove').first.click()
        page.wait_for_selector('.toast:has-text("Removed")')
        gone = members(ct['ratingKey'])
        page.click('.toast-action')
        page.wait_for_timeout(1200)
        check('edit: removing from a collection, and Undo', gone == moved[1:] and members(ct['ratingKey']) == moved, f'{gone} / {members(ct["ratingKey"])}')
        menu('.back-head button[aria-label="More options"]', 'Rename')
        answer('Edit test tracks (renamed)')
        page.wait_for_timeout(600)
        check('edit: a collection can be renamed', collection('Edit test tracks (renamed)') is not None)
        menu('.back-head button[aria-label="More options"]', 'Add to playlist')
        pick('Add to playlist', 'Edit test queue', exact=True)
        page.wait_for_selector('.toast')
        page.wait_for_timeout(300)
        check('edit: a collection\'s tracks go into a playlist', page.locator('.toast').inner_text().startswith(('Added', 'They’re all')), page.locator('.toast').inner_text())
        menu('.back-head button[aria-label="More options"]', 'Delete collection')
        page.wait_for_selector('.sheet.open .ask-form .btn-danger')
        page.click('.sheet.open .ask-form .btn-danger')
        page.wait_for_selector('.toast:has-text("Deleted")')
        check('edit: a collection can be deleted (after asking)', collection('Edit test tracks (renamed)') is None)
        ctx.close()

        # A friend with access to the server: playlists yes, collections no.
        ctx = browser.new_context(**MOBILE)
        page = ctx.new_page()
        attach(page, 'edit-friend')
        login(page, APP, token='t2')
        check('edit: a friend isn\'t the server\'s admin', js(page, "() => import('./js/editing.js').then((m) => m.isAdmin())") is False)
        page.goto(APP + '#/browse/albums')
        page.wait_for_selector('.grid .card')
        page.locator('.grid .card').first.click()
        page.wait_for_selector('.hero-album')
        page.locator('.track .track-more').first.click()
        page.wait_for_selector('.sheet.open')
        labels = page.locator('.sheet.open .sheet-action-label').all_text_contents()
        page.keyboard.press('Escape')
        page.goto(APP + f'#/collection/{collection("Edit test albums")["ratingKey"]}')
        page.wait_for_selector('.hero-album')
        page.wait_for_timeout(400)
        check('edit: collections can\'t be changed by a friend', 'Add to playlist…' in labels and 'Add to collection…' not in labels
              and page.locator('.lock-btn').count() == 0, str(labels))
        ctx.close()

    # ---------- lists: Appears in, and sorting playlists and collections ----------
    if run('lists'):
        # (With a smart collection too, which says nothing on its items: on
        # before signing in, as Home lists the collections, kept a minute.)
        mock('/__mock/config?smartcollection=1')
        ctx = browser.new_context(**MOBILE)
        page = ctx.new_page()
        attach(page, 'lists', expected=('Error: Not found',))  # an album's id, below
        login(page, APP)

        def mc(path, base=MOCK):
            sep = '&' if '?' in path else '?'
            with urllib.request.urlopen(f'{base}{path}{sep}X-Plex-Token=t', timeout=20) as r:
                return json.loads(r.read() or b'{}').get('MediaContainer', {})

        def done_looking():
            page.wait_for_selector('.appears-track')
            page.wait_for_function("() => !document.querySelector('.appears-status .spinner')", timeout=30000)

        # What Plex says a track is in, worked out the long way.
        pls = mc('/playlists?X-Plex-Container-Size=500').get('Metadata', [])
        fav = next(p for p in pls if p['title'] == 'Favourite tracks')
        t = mc(f"/playlists/{fav['ratingKey']}/items?X-Plex-Container-Size=500")['Metadata'][0]
        want_pl = {}
        for p in pls:
            ids = [m['ratingKey'] for m in mc(f"/playlists/{p['ratingKey']}/items?X-Plex-Container-Size=5000").get('Metadata', [])]
            if t['ratingKey'] in ids:
                want_pl[p['title']] = ids.count(t['ratingKey'])
        cols = mc('/library/sections/1/collections?X-Plex-Container-Size=200').get('Metadata', [])
        key_for = {'track': t['ratingKey'], 'album': t['parentRatingKey'], 'artist': t['grandparentRatingKey']}
        want_col = {c['title'] for c in cols
                    if key_for.get(c['subtype']) in [m['ratingKey'] for m in mc(f"/library/collections/{c['ratingKey']}/children").get('Metadata', [])]}

        page.goto(APP + f"#/playlist/{fav['ratingKey']}")
        page.wait_for_selector('.view .tracks .track')
        page.locator('.view .tracks .track .track-more').first.click()
        page.wait_for_selector('.sheet.open')
        asked = []
        page.on('request', lambda r: asked.append(r.url) if re.search(r'/(items|children)\?', r.url) else None)
        page.locator('.sheet.open .sheet-action', has_text='Appears in').click()
        done_looking()
        shot(page, 'lists-01-appears-in')
        got_pl = page.locator('.appears-playlists .row-title').all_inner_texts()
        got_col = page.locator('.appears-collections .row-title').all_inner_texts()
        subs = dict(zip(got_pl, page.locator('.appears-playlists .row-sub').all_inner_texts()))
        check('lists: Appears in lists the playlists a track is in', set(got_pl) == set(want_pl), f'{got_pl} vs {want_pl}')
        twice = [k for k, v in want_pl.items() if v > 1]
        check('lists: ...saying when it\'s in one more than once', twice and all(f'in it {want_pl[k]} times' in subs[k] for k in twice), str(subs))
        check('lists: ...and the collections it\'s in (its own, its album\'s or its artist\'s)', set(got_col) == want_col, f'{got_col} vs {want_col}')
        # Collections as Plex says (what each of them is in), none of them
        # read but smart ones (whose rules decide what's in them); playlists
        # read as their entries' ids, no more, in pages Plex takes.
        smart = {c['ratingKey'] for c in cols if c.get('smart')}
        read = [u for u in asked if '/library/collections/' in u]
        read_ids = {re.search(r'/library/collections/(\d+)/', u).group(1) for u in read}
        light = [u for u in asked if re.search(r'/playlists/\d+/items\?', u)]
        check('lists: ...collections as Plex says what\'s in them: none read but smart ones, a page Plex takes at a time',
              smart and read_ids <= smart and all(int(re.search(r'X-Plex-Container-Size=(\d+)', u).group(1)) <= 120 for u in read), str(read))
        check('lists: ...and playlists read as their entries\' ids', light and all('includeFields=ratingKey' in urllib.parse.unquote(u) and 'Media' in urllib.parse.unquote(u) for u in light), str(light[:2]))
        check('lists: ...in order of name', got_pl == sorted(got_pl, key=str.casefold), str(got_pl))
        page.locator('.appears-playlists a.row', has_text='Favourite tracks').click()
        page.wait_for_timeout(500)
        check('lists: a row opens its playlist', js(page, '() => location.hash') == f"#/playlist/{fav['ratingKey']}")

        # Looking again reads nothing again, until a list changes.
        reads = []
        page.on('request', lambda r: reads.append(r.url) if re.search(r'/(items|children)\?', r.url) else None)
        page.goto(APP + '#/')
        page.wait_for_selector('.wide-card')
        page.goto(APP + f"#/appears/{t['ratingKey']}")
        done_looking()
        check('lists: looking again is quick (what was read is kept)', not reads and set(page.locator('.appears-playlists .row-title').all_inner_texts()) == set(want_pl), str(reads))
        page.click('.appears-actions button:has-text("Add to a playlist")')
        page.wait_for_selector('.sheet.open')
        page.locator('.sheet.open .sheet-action', has_text='New playlist').first.click()
        page.wait_for_selector('.sheet.open .ask-form input')
        page.wait_for_timeout(250)
        page.fill('.sheet.open .ask-form input', 'Appears test')
        page.click('.sheet.open .ask-form button[type=submit]')
        page.wait_for_selector('.toast:has-text("Made")')
        page.goto(APP + '#/')
        page.wait_for_selector('.wide-card')
        page.goto(APP + f"#/appears/{t['ratingKey']}")
        done_looking()
        check('lists: ...and a new playlist with the track shows up', 'Appears test' in page.locator('.appears-playlists .row-title').all_inner_texts())
        page.goto(APP + '#/appears/not-a-track')
        page.wait_for_timeout(600)
        nowhere = page.locator('.empty-state:has-text("doesn’t exist")').count() == 1
        page.goto(APP + f"#/appears/{t['parentRatingKey']}")
        page.wait_for_timeout(800)
        check('lists: an address that isn\'t a track\'s goes nowhere', nowhere and page.locator('.error-state').count() == 1 and page.locator('.appears-track').count() == 0)

        # The albums a song is on: its own first, then the others, oldest
        # first; not another artist's song of the same name.
        library = mc('/library/sections/1/all?type=10&X-Plex-Container-Size=5000')['Metadata']
        signal = {m['parentTitle']: m for m in library if m['title'].startswith('Signal Fires')}
        page.goto(APP + f"#/appears/{signal['Tidal Lines']['ratingKey']}")
        done_looking()
        shot(page, 'lists-01b-albums')
        on_albums = page.locator('.appears-albums .row-title').all_inner_texts()
        album_subs = dict(zip(on_albums, page.locator('.appears-albums .row-sub').all_inner_texts()))
        check('lists: Appears in lists the albums the song is on: its own first, then oldest first', on_albums == ['Tidal Lines', 'Night Drive Vol. 1', 'Buoy'], str(on_albums))
        check('lists: ...not another artist\'s song of the same name', 'Interference' not in on_albums)
        check('lists: ...saying which one this track is, and what other versions are called',
              'this track' in album_subs.get('Tidal Lines', '') and '“Signal Fires (Extended Mix)”' in album_subs.get('Buoy', '')
              and '“Signal Fires - Radio Edit”' in album_subs.get('Night Drive Vol. 1', '') and 'Various Artists' in album_subs.get('Night Drive Vol. 1', ''),
              str(album_subs))
        said = page.locator('.appears-status').inner_text()
        check('lists: ...and how many there are', said.startswith('On 3 albums'), said)
        page.locator('.appears-albums a.row', has_text='Buoy').click()
        page.wait_for_timeout(500)
        check('lists: an album opens', js(page, '() => location.hash') == f"#/album/{signal['Buoy']['parentRatingKey']}")
        page.goto(APP + f"#/appears/{signal['Night Drive Vol. 1']['ratingKey']}")
        done_looking()
        from_compilation = page.locator('.appears-albums .row-title').all_inner_texts()
        check('lists: from a compilation, the artist\'s own albums are found', from_compilation == ['Night Drive Vol. 1', 'Tidal Lines', 'Buoy'], str(from_compilation))

        # A track of a track collection, whose album's in an album
        # collection and a smart one: each found.
        buoy = next(m for m in library if m['parentTitle'] == 'Buoy')
        key_for = {'track': buoy['ratingKey'], 'album': buoy['parentRatingKey'], 'artist': buoy['grandparentRatingKey']}
        want_buoy = {c['title'] for c in cols
                     if key_for.get(c['subtype']) in [m['ratingKey'] for m in mc(f"/library/collections/{c['ratingKey']}/children").get('Metadata', [])]}
        page.goto(APP + f"#/appears/{buoy['ratingKey']}")
        done_looking()
        got_buoy = set(page.locator('.appears-collections .row-title').all_inner_texts())
        check('lists: ...a track\'s own collection, its album\'s and a smart one, each found', {'Best of 2022', 'Rainy day albums', 'Electronic picks'} <= want_buoy
              and got_buoy == want_buoy, f'{got_buoy} vs {want_buoy}')

        # The fewest moves: checked against every order of a few lists, made
        # move by move as Plex makes them.
        planned = js(page, """() => import('./js/sorting.js').then(({ planMoves }) => {
            const lis = (seq) => { const best = seq.map(() => 1); let top = 0;
                seq.forEach((v, i) => { for (let j = 0; j < i; j++) if (seq[j] < v) best[i] = Math.max(best[i], best[j] + 1); top = Math.max(top, best[i]); });
                return top; };
            let rnd = 7; const random = () => ((rnd = (rnd * 16807) % 2147483647) / 2147483647);
            for (let n = 0; n < 30; n++) for (let k = 0; k < 25; k++) {
                const cur = Array.from({ length: n }, (_, i) => 'e' + i);
                const tgt = cur.slice();
                for (let i = n - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [tgt[i], tgt[j]] = [tgt[j], tgt[i]]; }
                if (k === 0) tgt.sort();
                const moves = planMoves(cur, tgt);
                const list = cur.slice();
                for (const { id, after } of moves) { list.splice(list.indexOf(id), 1); list.splice(after === null ? 0 : list.indexOf(after) + 1, 0, id); }
                if (list.join() !== tgt.join()) return 'wrong order: ' + cur + ' -> ' + tgt + ' gave ' + list;
                const pos = new Map(cur.map((id, i) => [id, i]));
                if (moves.length !== n - lis(tgt.map((id) => pos.get(id)))) return 'more moves than needed';
            }
            return 'ok'; })""")
        check('lists: sorting makes the fewest moves, and they give the order wanted', planned == 'ok', planned)

        # Sorting a playlist: a new one, with tracks from all over, out of order.
        tracks = mc('/library/sections/1/all?type=10&X-Plex-Container-Size=1000')['Metadata']
        picked = random.Random(5).sample(tracks, 14)
        uri = 'server://mock-server-1/com.plexapp.plugins.library/library/metadata/' + ','.join(m['ratingKey'] for m in picked)
        q = urllib.parse.urlencode({'type': 'audio', 'title': 'Sort test', 'smart': 0, 'uri': uri, 'X-Plex-Token': 't'})
        with urllib.request.urlopen(urllib.request.Request(f'{MOCK}/playlists?{q}', method='POST'), timeout=20) as r:
            sort_pl = json.loads(r.read())['MediaContainer']['Metadata'][0]
        rk = sort_pl['ratingKey']

        def entries():
            return mc(f'/playlists/{rk}/items?X-Plex-Container-Size=500')['Metadata']

        def bare(v):
            return re.sub(r'^(the|a|an)\s+', '', (v or '').strip(), flags=re.I).casefold()

        def by_artist(m):
            return (bare(m.get('originalTitle') or m.get('grandparentTitle')), m.get('parentYear') or 9999, bare(m.get('parentTitle')),
                    m.get('parentIndex') or 0, m.get('index') or 0, bare(m.get('title')))

        def by_title(m):
            return (bare(m.get('title')), bare(m.get('originalTitle') or m.get('grandparentTitle')), bare(m.get('parentTitle')))

        def fewest(before, after):
            pos = {pid: i for i, pid in enumerate(before)}
            seq = [pos[pid] for pid in after]
            best = [1] * len(seq)
            for i in range(len(seq)):
                for j in range(i):
                    if seq[j] < seq[i]:
                        best[i] = max(best[i], best[j] + 1)
            return len(seq) - (max(best) if best else 0)

        moves = []
        page.on('request', lambda r: moves.append(r.url) if '/move' in r.url and r.method == 'PUT' else None)

        def sort_by(label, wait='Sorted'):
            del moves[:]
            page.click('.edit-bar .edit-sort')
            page.wait_for_selector('.sheet.open .sheet-title:has-text("Sort by")')
            page.locator(f'.sheet.open .sheet-action:has(.sheet-action-label:text-is("{label}"))').click()
            page.wait_for_selector(f'.toast:has-text("{wait}")', timeout=30000)
            page.wait_for_timeout(500)

        page.goto(APP + f'#/playlist/{rk}')
        page.wait_for_selector('.view .tracks .track')
        page.click('.lock-btn')
        page.wait_for_selector('.edit-bar:not([hidden]) .edit-sort')
        shot(page, 'lists-02-sort-button')
        start = [m['playlistItemID'] for m in entries()]
        page.click('.edit-bar .edit-sort')
        page.wait_for_selector('.sheet.open .sheet-title:has-text("Sort by")')
        offered = page.locator('.sheet.open .sheet-action-label').all_inner_texts()
        shot(page, 'lists-03-sort-by')
        page.keyboard.press('Escape')
        page.wait_for_selector('.sheet', state='detached')
        check('lists: an unlocked playlist can be sorted by artist, track name, album or year, or reversed',
              offered == ['Artist', 'Track name', 'Album', 'Year', 'Reverse the order'], str(offered))
        sort_by('Artist')
        now = entries()
        want = sorted(now, key=by_artist)
        shown = page.locator('.view .tracks .track').evaluate_all('rs => rs.map((r) => r.dataset.trackId)')
        check('lists: sorting by artist saves the new order in Plex (albums in order, by year)',
              [m['ratingKey'] for m in now] == [m['ratingKey'] for m in want], str([(m.get('originalTitle') or m['grandparentTitle'], m['title']) for m in now]))
        check('lists: ...shows it', shown == [m['ratingKey'] for m in now], str(shown))
        check('lists: ...in the fewest moves', len(moves) == fewest(start, [m['playlistItemID'] for m in now]) and len(moves) > 0, f'{len(moves)} moves')
        check('lists: ...and stays unlocked', page.locator('.edit-bar:not([hidden])').count() == 1 and page.locator('.view .tracks .track .drag-handle').count() == len(now))
        sort_by('Artist', wait='in that order already')
        check('lists: sorting what\'s sorted already changes nothing', not moves, str(moves))
        by_artist_pids = [m['playlistItemID'] for m in entries()]
        sort_by('Track name')
        now = entries()
        check('lists: sorting by track name', [m['ratingKey'] for m in now] == [m['ratingKey'] for m in sorted(now, key=by_title)],
              str([m['title'] for m in now]))
        page.click('.toast-action:has-text("Undo")')
        page.wait_for_selector('.toast:has-text("Put back")', timeout=30000)
        check('lists: Undo puts the order back', [m['playlistItemID'] for m in entries()] == by_artist_pids)
        sort_by('Reverse the order', wait='Reversed')
        check('lists: reversing the order', [m['playlistItemID'] for m in entries()] == by_artist_pids[::-1])
        check('lists: sorting leaves every track in the playlist', sorted(m['playlistItemID'] for m in entries()) == sorted(start))

        # Stop, part way: what's moved stays moved, and Undo puts it back.
        # (Reversed, sorting by artist again moves all but one.)
        def slowly(route):
            time.sleep(0.5)
            route.continue_()
        page.route('**/move**', slowly)
        reversed_pids = [m['playlistItemID'] for m in entries()]
        page.click('.edit-bar .edit-sort')
        page.wait_for_selector('.sheet.open .sheet-title:has-text("Sort by")')
        page.locator('.sheet.open .sheet-action:has(.sheet-action-label:text-is("Artist"))').click()
        page.wait_for_function("() => /\\d+ of \\d+ moved/.test(document.querySelector('.edit-bar-text').textContent)", timeout=10000)
        progress = page.locator('.edit-bar-text').inner_text()
        page.click('.edit-bar .edit-stop')
        page.wait_for_selector('.toast:has-text("Stopped")', timeout=20000)
        part = [m['playlistItemID'] for m in entries()]
        check('lists: a sort can be stopped part way, saying how far it got', part not in (reversed_pids, by_artist_pids)
              and page.locator('.edit-bar:not(.busy) .edit-sort').count() == 1, f'{progress} {part}')
        check('lists: ...counting moves, and saying how many are in place already (moves aren\'t tracks)',
              re.search(r'\d+ of 13 moved \(1 already in place\)', progress), progress)
        page.unroute('**/move**')
        page.click('.toast-action:has-text("Undo")')
        page.wait_for_selector('.toast:has-text("Put back")', timeout=30000)
        check('lists: ...and Undo puts it back', [m['playlistItemID'] for m in entries()] == reversed_pids)

        # Numbered, as Spotify numbers a playlist, with the album in a column
        # of its own where there's room.
        page.goto(APP + f'#/playlist/{rk}')
        page.wait_for_selector('.view .tracks.numbered > .track .track-pos')
        want_n = len(entries())
        counts = lambda: (page.locator('.view .tracks.numbered > .track').count(), page.locator('.view .tracks.numbered > .track .track-pos').count())
        # (Waiting out a reload of the list, after the Undo above.)
        all_numbered = wait_for(lambda: counts() == (want_n, want_n), 10)
        # (Read again if the list was being drawn again just then: an element
        # it's let go of has no style.)
        def album_col():
            try:
                return page.locator('.view .tracks .track-album').first.evaluate('e => e.isConnected ? [getComputedStyle(e).display, e.textContent] : null')
            except Exception:
                return None
        narrow = (wait_for(album_col, 5, 0.2) or [''])[0]
        page.set_viewport_size({'width': 1280, 'height': 860})
        page.wait_for_timeout(500)
        wide = wait_for(album_col, 5, 0.2)
        shot(page, 'lists-04-numbered-wide')
        page.set_viewport_size(MOBILE['viewport'])
        page.wait_for_timeout(300)
        check('lists: a playlist\'s tracks are numbered', all_numbered, f'{counts()} of {want_n}')
        check('lists: ...with each one\'s album in a column of its own on a wide screen, not on a phone',
              narrow == 'none' and wide == ['block', entries()[0]['parentTitle']], f'{narrow} {wide}')

        # Collections (the server's owner): they switch to a custom order.
        def collection(title):
            return next(c for c in mc('/library/sections/1/collections?X-Plex-Container-Size=200')['Metadata'] if c['title'] == title)

        def children(cid):
            return mc(f'/library/collections/{cid}/children')['Metadata']

        c22 = collection('Best of 2022')
        page.goto(APP + f"#/collection/{c22['ratingKey']}")
        page.wait_for_selector('.hero-album')
        page.click('.lock-btn')
        page.wait_for_selector('.edit-rows .edit-row')
        sort_by('Track name')
        kids = children(c22['ratingKey'])
        shown = page.locator('.edit-rows .edit-row .row-title').all_inner_texts()
        check('lists: sorting a collection by track name (it switches to custom order)',
              [m['ratingKey'] for m in kids] == [m['ratingKey'] for m in sorted(kids, key=by_title)] and collection('Best of 2022')['collectionSort'] == 2
              and shown == [m['title'] for m in kids], str([m['title'] for m in kids]))
        for title, want_opts in (('Road trip', ['Artist', 'Album name', 'Year', 'Reverse the order']), ('Piano and strings', ['Name', 'Reverse the order'])):
            c = collection(title)
            page.goto(APP + f"#/collection/{c['ratingKey']}")
            page.wait_for_selector('.hero-album')
            page.click('.lock-btn')
            page.click('.edit-bar .edit-sort')
            page.wait_for_selector('.sheet.open .sheet-title:has-text("Sort by")')
            opts = page.locator('.sheet.open .sheet-action-label').all_inner_texts()
            page.keyboard.press('Escape')
            page.wait_for_selector('.sheet', state='detached')
            check(f'lists: a {c["subtype"]} collection\'s sorts', opts == want_opts, str(opts))
        road = collection('Road trip')
        page.goto(APP + f"#/collection/{road['ratingKey']}")
        page.wait_for_selector('.hero-album')
        page.click('.lock-btn')
        sort_by('Album name')
        names = [m['title'] for m in children(road['ratingKey'])]
        check('lists: sorting an album collection by album name', names == sorted(names, key=bare), str(names))

        # A smart playlist's rules, as Plex keeps them (its content).
        rules = js(page, """() => import('./js/membership.js').then(({ smartRules }) => {
            const enc = (q) => 'library://9f1c/directory/' + encodeURIComponent('/library/sections/1/all?' + q);
            return [
                smartRules(enc('type=10')),
                smartRules(enc('type=10&sort=titleSort&includeGuids=1')),
                smartRules(enc('type=10&push=1&userRating' + encodeURIComponent('>>') + '=8&pop=1')),
                smartRules(enc('type=10&title==Intro')),
                smartRules(enc('type=10&limit=100')),
                smartRules(enc('type=9')),
                smartRules('library://9f1c/directory//library/sections/3/all?type=10'),
                smartRules(''),
                smartRules('%E0%A4%A'),
            ]; })""")
        check('lists: a smart playlist\'s rules are read: its library, and whether anything narrows it',
              [r and (r['section'], r['type'], r['narrowed']) for r in rules] ==
              [('1', '10', False), ('1', '10', False), ('1', '10', True), ('1', '10', True), ('1', '10', True), ('1', '9', False), ('3', '10', False), None, None], str(rules))
        terms = js(page, """() => import('./js/membership.js').then(({ searchTerm }) =>
            ['Don’t Stop Me Now', 'Born Slippy .NUXX', 'Signal Fires - Radio Edit', 'Your Woman (Remastered 2011)', 'Song [Live] – 2015 Remaster', 'I Will Survive'].map(searchTerm))""")
        check('lists: a song is looked for by its name, without what marks a version of it',
              terms == ['Stop Me Now', 'Born Slippy', 'Signal Fires', 'Your Woman', 'Song', 'Will Survive'], str(terms))
        mock('/__mock/config?smartcollection=0')
        ctx.close()

        # Very long smart playlists aren't read: one of the whole library (by
        # its rules) has every track; any other is left out, and it says so.
        if APP_BIG and MOCK_BIG:
            ctx = browser.new_context(**MOBILE)
            page = ctx.new_page()
            attach(page, 'lists-big')
            login(page, APP_BIG)
            big_lists = {p['title']: p for p in mc('/playlists?X-Plex-Container-Size=500', base=MOCK_BIG)['Metadata']}
            long_reads = []
            page.on('request', lambda r: long_reads.append(r.url) if any(f"/playlists/{big_lists[n]['ratingKey']}/items" in r.url for n in ('Everything', 'Long smart mix')) else None)
            first = mc('/library/sections/1/all?type=10&X-Plex-Container-Size=1', base=MOCK_BIG)['Metadata'][0]
            page.goto(APP_BIG + f"#/appears/{first['ratingKey']}")
            done_looking()
            shot(page, 'lists-01c-long-smart')
            note = page.locator('.appears-note').inner_text() if page.locator('.appears-note:not([hidden])').count() else ''
            got = page.locator('.appears-playlists .row-title').all_inner_texts()
            subs = dict(zip(got, page.locator('.appears-playlists .row-sub').all_inner_texts()))
            check('lists: a very long smart playlist of the whole library has every track, by its rules',
                  'every track in Music [Hi-Res]' in subs.get('Everything', ''), str(subs))
            check('lists: ...any other is left out, and it says so', note.startswith('Long smart mix, a smart playlist of 2,500 tracks, is too long to look through'), note)
            check('lists: ...and neither is read', not long_reads, str(long_reads[:3]))
            ctx.close()

    # ---------- pictures: changing a playlist's or collection's picture ----------
    if run('pictures'):
        ctx = browser.new_context(**MOBILE)
        page = ctx.new_page()
        attach(page, 'pictures')
        login(page, APP)

        def mc(path):
            sep = '&' if '?' in path else '?'
            with urllib.request.urlopen(f'{MOCK}{path}{sep}X-Plex-Token=t', timeout=20) as r:
                return json.loads(r.read() or b'{}').get('MediaContainer', {})

        def item(kind, title):
            path = '/playlists?X-Plex-Container-Size=500' if kind == 'playlist' else '/library/sections/1/collections?X-Plex-Container-Size=200'
            return next(x for x in mc(path)['Metadata'] if x['title'] == title)

        uploaded = lambda rk: mock(f'/__mock/picture?id={rk}')['MediaContainer']['picture']
        centre = lambda: js(page, """() => new Promise((resolve) => {
            const img = document.querySelector('.hero-art-box img');
            if (!img) return resolve(null);
            const go = () => { const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
                const x = c.getContext('2d'); x.drawImage(img, 0, 0); resolve([...x.getImageData(c.width >> 1, c.height >> 1, 1, 1).data].slice(0, 3)); };
            img.complete && img.naturalWidth ? go() : img.addEventListener('load', go, { once: true });
            setTimeout(() => resolve(null), 5000); })""")
        near = lambda got, want: got is not None and all(abs(a - b) <= 24 for a, b in zip(got, want))
        hero_src = lambda: page.locator('.hero-art-box img').get_attribute('src') or ''

        def upload(name, data, done='Picture changed'):
            page.click('.hero-art-edit')
            page.wait_for_selector('.sheet.open .sheet-title:has-text("Picture")')
            with page.expect_file_chooser() as fc:
                page.click('.sheet.open .sheet-action:has-text("Upload a picture")')
            fc.value.set_files({'name': name, 'mimeType': 'image/png', 'buffer': data})
            page.wait_for_selector(f'.toast:has-text("{done}")', timeout=30000)
            page.wait_for_timeout(500)

        workout = item('playlist', 'Workout')
        page.goto(APP + f"#/playlist/{workout['ratingKey']}")
        page.wait_for_selector('.hero-art-box')
        locked = page.locator('.hero-art-edit').is_visible()
        page.click('.lock-btn')
        page.wait_for_timeout(300)
        check('pictures: the pencil on a playlist\'s picture shows once it\'s unlocked', not locked and page.locator('.hero-art-edit').is_visible())
        shot(page, 'pictures-01-unlocked')

        upload('red.png', png(2400, 1600, (220, 30, 40)))
        got = uploaded(workout['ratingKey'])
        check('pictures: an uploaded picture goes to Plex as a JPEG, made smaller', got and got['format'] == 'JPEG' and (got['width'], got['height']) == (1200, 800), str(got))
        check('pictures: ...and shows', near(centre(), (220, 30, 40)) and f"/library/metadata/{workout['ratingKey']}/thumb/" in urllib.parse.unquote(hero_src()), f'{centre()} {hero_src()[:160]}')
        shot(page, 'pictures-02-changed')
        page.goto(APP + '#/playlists')
        page.wait_for_selector('.card, .row')
        srcs = [urllib.parse.unquote(x or '') for x in page.locator('img').evaluate_all('els => els.map((e) => e.getAttribute("src"))')]
        check('pictures: ...in the Playlists tab too', any(f"/library/metadata/{workout['ratingKey']}/thumb/" in x for x in srcs))

        page.goto(APP + f"#/playlist/{workout['ratingKey']}")
        page.wait_for_selector('.hero-art-box')
        page.click('.lock-btn')
        upload('green.png', png(600, 600, (30, 160, 60)))
        page.click('.hero-art-edit')
        page.wait_for_selector('.sheet.open .picture-choice')
        choices = page.locator('.sheet.open .picture-choice').count()
        shot(page, 'pictures-03-choices')
        page.locator('.sheet.open .picture-choice').first.click()
        page.wait_for_selector('.toast:has-text("Picture changed")', timeout=20000)
        page.wait_for_timeout(500)
        check('pictures: one it had before can be chosen again', choices == 1 and near(centre(), (220, 30, 40)) and uploaded(workout['ratingKey'])['width'] == 1200, str(choices))

        page.click('.hero-art-edit')
        page.wait_for_selector('.sheet.open .sheet-title:has-text("Picture")')
        page.click('.sheet.open .sheet-action:has-text("Use its tracks’ covers")')
        page.wait_for_selector('.toast:has-text("Back to its tracks’ covers")', timeout=20000)
        page.wait_for_timeout(500)
        check('pictures: ...or the covers Plex puts together', not item('playlist', 'Workout').get('thumb') and '/composite/' in urllib.parse.unquote(hero_src()), hero_src()[:160])

        upload('not-a-picture.png', b'hello, I am not a picture', done='couldn’t be read')
        check('pictures: something that isn\'t a picture is turned down', uploaded(workout['ratingKey']) is None)
        page.click('.edit-bar .edit-done')

        # A smart playlist can't be unlocked, but its picture can change.
        smart = item('playlist', 'Everything')
        page.goto(APP + f"#/playlist/{smart['ratingKey']}")
        page.wait_for_selector('.hero-art-box')
        page.click('.back-head button[aria-label="More options"]')
        page.wait_for_selector('.sheet.open')
        labels = page.locator('.sheet.open .sheet-action-label').all_inner_texts()
        page.keyboard.press('Escape')
        page.goto(APP + f"#/playlist/{workout['ratingKey']}")
        page.wait_for_selector('.hero-art-box')
        page.click('.back-head button[aria-label="More options"]')
        page.wait_for_selector('.sheet.open')
        locked_labels = page.locator('.sheet.open .sheet-action-label').all_inner_texts()
        page.keyboard.press('Escape')
        check('pictures: a smart playlist\'s menu offers to change its picture (a locked one\'s doesn\'t)', 'Change picture…' in labels and 'Change picture…' not in locked_labels, f'{labels} {locked_labels}')

        # Collections: the server's owner's.
        best = item('collection', 'Best of 2022')
        page.goto(APP + f"#/collection/{best['ratingKey']}")
        page.wait_for_selector('.hero-art-box')
        page.click('.lock-btn')
        upload('blue.png', png(900, 1400, (40, 70, 200)))
        got = uploaded(best['ratingKey'])
        check('pictures: the server\'s owner can change a collection\'s picture', got and (got['width'], got['height']) == (771, 1200) and near(centre(), (40, 70, 200)), str(got))
        page.click('.edit-bar .edit-done')
        ctx.close()

        ctx = browser.new_context(**MOBILE)
        page = ctx.new_page()
        attach(page, 'pictures-friend')
        login(page, APP, token='t2')
        page.goto(APP + f"#/collection/{best['ratingKey']}")
        page.wait_for_selector('.hero-art-box')
        page.wait_for_timeout(500)
        check('pictures: ...a friend can\'t', page.locator('.lock-btn').count() == 0 and not page.locator('.hero-art-edit').is_visible())
        ctx.close()

    # ---------- missing: songs and artists AI playlists suggest that aren't here ----------
    if run('missing'):
        ctx = browser.new_context(accept_downloads=True, **MOBILE)
        ctx.grant_permissions(['clipboard-read', 'clipboard-write'], origin=APP.rstrip('/'))
        page = ctx.new_page()
        attach(page, 'missing')
        login(page, APP)

        def make(prompt):
            page.goto(APP + '#/ai-playlist')
            page.wait_for_selector('.ai-box input')
            if page.locator('button:has-text("Make another playlist")').count():
                page.click('button:has-text("Make another playlist")')
            page.fill('.ai-box input', prompt)
            page.press('.ai-box input', 'Enter')
            page.wait_for_selector('.ai-result, .ai-error', timeout=60000)

        def stored():
            return js(page, "() => JSON.parse(localStorage.getItem('pw.aiMissing') || '[]')")

        # Off (the default): nothing shown or kept, and no stray word where
        # it would go (0.10.0 showed "null" there).
        make('Late night drive')
        shot(page, 'missing-00-off')
        check('missing: off by default, so nothing is shown or kept', page.locator('.ai-missing, .ai-missing-none').count() == 0 and stored() == [])
        check('missing: ...and nothing is left in its place', 'null' not in page.locator('.ai-body').inner_text().split('\n'))

        page.goto(APP + '#/settings/ai')
        page.wait_for_selector('label.toggle-row:has-text("Show missing tracks")')
        check('missing: Settings › AI has Show missing tracks (and no list yet)', page.locator('a.missing-link').is_hidden())
        mb_row = page.locator('label.toggle-row', has_text='Check suggestions on MusicBrainz')
        check('missing: ...and, the player having a MusicBrainz to ask (its own), checking suggestions there, on to begin with',
              mb_row.count() == 1 and mb_row.locator('input').is_checked() and 'the player’s own MusicBrainz server' in mb_row.inner_text(), mb_row.inner_text() if mb_row.count() else '')
        toggle(page, 'Show missing tracks', True)
        # First without MusicBrainz: everything suggested and missing is listed.
        toggle(page, 'Check suggestions on MusicBrainz', False)
        page.wait_for_timeout(200)
        check('missing: ...and once it\'s on, the list', page.locator('a.missing-link').is_visible())
        shot(page, 'missing-01-settings')

        make('Late night drive')
        lines = []
        if page.locator('.ai-missing').count():
            page.click('.ai-missing summary')
            lines = page.locator('.ai-missing-list li').all_inner_texts()
        shot(page, 'missing-02-result')
        check('missing: an AI playlist lists the songs and artists it suggested that aren\'t in the library',
              'Not A Real Band (no music by them)' in lines and 'Imaginary Act — Made Up Song' in lines, str(lines))
        check('missing: ...not ones that are there', not any(a in ' '.join(lines) for a in ('Juniper & Ash', 'Glass Harbour (no music')), str(lines))
        check('missing: ...nor one of the library\'s albums, suggested as if it were a song', not any('Tidal Lines' in x for x in lines), str(lines))
        make('Calm songs I already have')
        none = page.locator('.ai-missing-none').inner_text() if page.locator('.ai-missing-none').count() else ''
        shot(page, 'missing-02b-nothing-missing')
        check('missing: when everything suggested is there, it says so', none == 'Nothing missing: the 2 artists and 1 song it suggested are all in your library.'
              and page.locator('.ai-missing').count() == 0, none)
        make('Best of Glass Harbour')
        make('Best of Glass Harbour')
        kept = {(m['kind'], m['artist'], m['title']): m for m in stored()}
        never = kept.get(('track', 'Glass Harbour', 'A Song They Never Made'))
        check('missing: a best-of notes the artist\'s own songs that aren\'t here, counting repeats', never and never['times'] == 2 and never['prompt'] == 'Best of Glass Harbour', json.dumps(never))

        # The list: shown, exported, copied, trimmed and checked again.
        page.goto(APP + '#/settings/missing')
        page.wait_for_selector('.missing-row')
        titles = page.locator('.missing-row .row-title').all_inner_texts()
        shot(page, 'missing-03-list')
        check('missing: the list, artists first', titles == ['Not A Real Band', 'Real Missing Band', 'A Song They Never Made', 'Lantern Song', 'Sea Glass', 'Made Up Song'], str(titles))
        with page.expect_download() as dl:
            page.click('.missing-csv')
        csv_text = open(dl.value.path(), encoding='utf-8-sig').read()
        check('missing: downloads as a spreadsheet (CSV)', dl.value.suggested_filename.startswith('missing-tracks-') and dl.value.suggested_filename.endswith('.csv')
              and csv_text.startswith('"Artist","Title","Missing","Times suggested"') and '"Glass Harbour","A Song They Never Made","Track","2"' in csv_text, csv_text[:300])
        check('missing: ...without what was asked for (that stays on this device)', 'Best of Glass Harbour' not in csv_text and 'Asked for' not in csv_text, csv_text[:300])
        page.click('.missing-copy')
        page.wait_for_selector('.toast:has-text("Copied")')
        copied = js(page, '() => navigator.clipboard.readText()')
        check('missing: copies as plain text, one to a line', copied.splitlines() == ['Not A Real Band (no music by them)', 'Real Missing Band (no music by them)', 'Glass Harbour — A Song They Never Made',
                                                                                 'Glass Harbour — Lantern Song', 'Glass Harbour — Sea Glass', 'Imaginary Act — Made Up Song'], copied)
        js(page, """() => { const l = JSON.parse(localStorage.getItem('pw.aiMissing'));
            l.push(Object.assign({}, l[0], { kind: 'track', artist: '=HYPERLINK("http://example.com")', title: '+1' }));
            localStorage.setItem('pw.aiMissing', JSON.stringify(l)); }""")
        csv_text = js(page, "() => import('./js/missing.js').then((m) => m.missingCsv())")
        check('missing: nothing in the CSV can be read as a formula', '"\'=HYPERLINK(""http://example.com"")","\'+1"' in csv_text, csv_text[-200:])
        page.goto(APP + '#/settings/ai')
        page.goto(APP + '#/settings/missing')
        page.wait_for_selector('.missing-row')
        page.locator('.missing-row', has_text='+1').locator('button').click()
        page.wait_for_timeout(300)
        check('missing: one can be taken off the list', '+1' not in page.locator('.missing-row .row-title').all_inner_texts() and len(stored()) == 6)
        # A song that's in the library now (as if it had been added since).
        real = mock('/library/sections/1/all?type=10&X-Plex-Container-Size=1&X-Plex-Token=t')['MediaContainer']['Metadata'][0]
        js(page, f"""() => {{ const l = JSON.parse(localStorage.getItem('pw.aiMissing'));
            l.push(Object.assign({{}}, l[0], {{ kind: 'track', artist: {json.dumps(real.get('originalTitle') or real['grandparentTitle'])}, title: {json.dumps(real['title'])} }}));
            localStorage.setItem('pw.aiMissing', JSON.stringify(l)); }}""")
        page.goto(APP + '#/settings/ai')
        page.goto(APP + '#/settings/missing')
        page.wait_for_selector('.missing-row')
        page.click('.missing-check')
        page.wait_for_selector('.missing-status:has-text("off the list"), .missing-status:has-text("yet")', timeout=30000)
        left = page.locator('.missing-row .row-title').all_inner_texts()
        check('missing: Check again lets go of what\'s in the library now', real['title'] not in left and len(left) == 6
              and re.match(r'1 is on .+ now, so it’s off the list\.', page.locator('.missing-status').inner_text()), f"{page.locator('.missing-status').inner_text()} {left}")
        # Another server's list is its own (different servers, different music).
        js(page, """() => { const l = JSON.parse(localStorage.getItem('pw.aiMissing'));
            l.push(Object.assign({}, l[0], { server: 'another-server', kind: 'track', artist: 'Elsewhere Artist', title: 'Elsewhere Song' }));
            localStorage.setItem('pw.aiMissing', JSON.stringify(l)); }""")
        page.goto(APP + '#/settings/ai')
        page.goto(APP + '#/settings/missing')
        page.wait_for_selector('.missing-row')
        here = page.locator('.missing-row .row-title').all_inner_texts()
        counted = js(page, "() => import('./js/missing.js').then((m) => m.missingCount())")
        check('missing: another server\'s missing tracks aren\'t on this one\'s list', 'Elsewhere Song' not in here and len(here) == 6 and counted == 6, f'{here} {counted}')
        check('missing: with MusicBrainz checks off, the list has nothing about MusicBrainz',
              page.locator('.missing-mb, .mb-found, .missing-show-unknown, .missing-mb-check, .missing-row.unknown').count() == 0)

        # With MusicBrainz: an AI playlist checks its suggestions before it
        # lists them, and says what it left out, and why.
        mb_before = mock('/__mock/musicbrainz')['MediaContainer']['requests']
        page.goto(APP + '#/settings/ai')
        page.wait_for_selector('label.toggle-row:has-text("Check suggestions on MusicBrainz")')
        toggle(page, 'Check suggestions on MusicBrainz', True)
        make('Late night drive')
        page.wait_for_selector('.ai-missing')
        page.click('.ai-missing summary')
        settled = wait_for(lambda: page.locator('.ai-missing:not(.checking)').count() == 1, 45)
        lines = page.locator('.ai-missing > .ai-missing-list li').all_inner_texts()
        out = page.locator('.ai-missing-group').evaluate_all('gs => gs.map((g) => [g.querySelector(".ai-missing-why").textContent, [...g.querySelectorAll("li")].map((li) => li.textContent)])')
        label = page.locator('.ai-missing summary').inner_text()
        note = page.locator('.ai-missing-mb').inner_text()
        shot(page, 'missing-04-musicbrainz')
        check('missing: checked on MusicBrainz, an AI playlist lists only what it knows',
              settled and lines == ['Real Missing Band (no music by them)', 'Glass Harbour — Lantern Song'] and label.endswith('3 suggestions left out'), f'{lines} {label}')
        check('missing: ...and says what it left out, and why: made up, or an album',
              len(out) == 2 and 'doesn’t know them' in out[0][0] and out[0][1] == ['Not A Real Band (no music by them)', 'Imaginary Act — Made Up Song']
              and 'album, not a song' in out[1][0] and out[1][1] == ['Glass Harbour — Sea Glass'], json.dumps(out))
        check('missing: ...and where it asked', note.startswith('Checked on the player’s own MusicBrainz server.'), note)
        kept = sorted((m['kind'], m['title'] or m['artist']) for m in stored() if m['server'] != 'another-server')
        check('missing: ...and only those it knows go on the list (what it doesn\'t know comes off it, from before)',
              kept == [('artist', 'Real Missing Band'), ('track', 'A Song They Never Made'), ('track', 'Lantern Song')], str(kept))
        marked = sorted((m['title'] or m['artist']) for m in stored() if m.get('mb') == 'real')
        check('missing: ...marked as found there (the one from before isn\'t: it wasn\'t asked about)', marked == ['Lantern Song', 'Real Missing Band'], str(marked))
        seen_mb = mock('/__mock/musicbrainz')['MediaContainer']
        # (The player keeps answers for a week: run again against the same
        # one, and these are known already, so nothing new is asked.)
        check('missing: ...asked through the player, saying what it is', (seen_mb['requests'] > mb_before or mb_before > 0)
              and any(re.match(r'^plexamp-web/[0-9.]+ \( https://github\.com/', a) for a in seen_mb['agents']), f"{seen_mb['requests']} {seen_mb['agents']}")
        before = mock('/__mock/musicbrainz')['MediaContainer']['requests']
        make('Late night drive')
        page.wait_for_selector('.ai-missing:not(.checking)', timeout=20000)
        check('missing: ...once for each (it keeps the answers)', mock('/__mock/musicbrainz')['MediaContainer']['requests'] == before)
        csv_text = js(page, "() => import('./js/missing.js').then((m) => m.missingCsv())")
        check('missing: ...and what was left out isn\'t exported', 'Lantern Song' in csv_text and 'Made Up Song' not in csv_text and 'Sea Glass' not in csv_text, csv_text[-300:])
        # What 0.12.0 kept hidden (unknown to MusicBrainz, or an album) goes.
        js(page, """() => { const l = JSON.parse(localStorage.getItem('pw.aiMissing'));
            l.push(Object.assign({}, l[0], { kind: 'track', artist: 'Old', title: 'Hidden One', mb: 'unknown' }));
            localStorage.setItem('pw.aiMissing', JSON.stringify(l)); }""")
        page.reload()
        page.wait_for_selector('.view')
        page.goto(APP + '#/settings/missing')
        page.wait_for_selector('.missing-row')
        check('missing: what 0.12.0 kept hidden is let go', 'Hidden One' not in page.locator('.missing-row .row-title').all_inner_texts()
              and not any(m.get('mb') == 'unknown' for m in stored()), str(stored()))

        # Listed without being checked (MusicBrainz checks off, or before the
        # player had one to ask): checked from the list, and what it doesn't
        # know comes off it. Those it found already aren't asked about again.
        js(page, """() => { const l = JSON.parse(localStorage.getItem('pw.aiMissing'));
            const like = l[0];
            for (const [artist, title] of [['Imaginary Act', 'Made Up Song'], ['Glass Harbour', 'Sea Glass'], ['Real Missing Band', 'Somewhere Real']])
              l.push(Object.assign({}, like, { kind: 'track', artist, title, mb: undefined }));
            localStorage.setItem('pw.aiMissing', JSON.stringify(l)); }""")
        sent = []
        page.on('request', lambda r: sent.append(json.loads(r.post_data or '{}')) if r.url.endswith('/api/musicbrainz/check') else None)
        page.goto(APP + '#/settings/ai')
        page.goto(APP + '#/settings/missing')
        page.wait_for_selector('.missing-row')
        badges = page.locator('.missing-row:has(.mb-found) .row-title').all_inner_texts()
        page.click('.missing-mb')
        page.wait_for_selector('.missing-status:has-text("Taken off the list")', timeout=30000)
        left = page.locator('.missing-row .row-title').all_inner_texts()
        said = page.locator('.missing-status').inner_text()
        asked = sorted(i.get('title') or i.get('artist') for b in sent for i in b.get('items', []))
        shot(page, 'missing-05-checked')
        check('missing: Check on MusicBrainz takes what it doesn\'t know (and albums) off the list',
              left == ['Real Missing Band', 'Lantern Song', 'Somewhere Real']
              and 'Taken off the list: 2 that MusicBrainz doesn’t know (most likely made up) and 1 album taken for a song.' in said
              and '1 is on MusicBrainz, so it’s real.' in said, f'{left} {said}')
        check('missing: ...asking only about those not checked before', asked == ['A Song They Never Made', 'Made Up Song', 'Sea Glass', 'Somewhere Real'], str(asked))
        check('missing: ...and marks those it found', badges == ['Real Missing Band', 'Lantern Song'] and page.locator('.missing-row:has(.mb-found)').count() == 3
              and page.locator('.missing-mb').count() == 0 and all(m.get('mb') == 'real' for m in stored() if m['server'] != 'another-server'), f'{badges} {stored()}')
        page.click('.toast-action:has-text("Undo")')
        page.wait_for_timeout(300)
        back = page.locator('.missing-row .row-title').all_inner_texts()
        check('missing: ...with an undo', len(back) == 6 and 'Made Up Song' in back and page.locator('.missing-mb').count() == 1, str(back))
        page.goto(APP + '#/settings/missing')
        page.wait_for_selector('.missing-row')
        page.click('button:has-text("Clear the list")')
        page.wait_for_selector('.sheet.open .ask-form .btn-danger')
        page.click('.sheet.open .ask-form .btn-danger')
        page.wait_for_timeout(400)
        check('missing: the list can be cleared (another server\'s stays)', [m['title'] for m in stored()] == ['Elsewhere Song'] and page.locator('.missing-row').count() == 0
              and page.locator('.empty-state').count() == 1, str(stored()))
        settings(page, {'ai': {'mode': 'auto'}})
        ctx.close()

    # ---------- files: playlists exported to a file, backed up, imported ----------
    if run('files'):
        ctx = browser.new_context(accept_downloads=True, **MOBILE)
        ctx.grant_permissions(['clipboard-read', 'clipboard-write'], origin=APP.rstrip('/'))
        page = ctx.new_page()
        attach(page, 'files')
        login(page, APP)
        made = []  # (token, playlist id), taken away at the end

        def pls(token='t'):
            return mock(f'/playlists?playlistType=audio&X-Plex-Token={token}')['MediaContainer'].get('Metadata', [])

        def entries(pid, token='t'):
            return [m['ratingKey'] for m in mock(f'/playlists/{pid}/items?X-Plex-Token={token}&X-Plex-Container-Size=500')['MediaContainer'].get('Metadata', [])]

        def new_ones(before, token='t'):
            had = {p['ratingKey'] for p in before}
            fresh = [p for p in pls(token) if p['ratingKey'] not in had]
            made.extend((token, p['ratingKey']) for p in fresh)
            return fresh

        def write(name, data):
            path = os.path.join(OUT, name)
            with open(path, 'w', encoding='utf-8') as f:
                f.write(data if isinstance(data, str) else json.dumps(data))
            return path

        def import_file(page, path, *, name=None, choose=None):
            """Import a file from the Playlists page: its name for one, or which (by title) for several."""
            page.goto(APP + '#/playlists')
            page.wait_for_selector('.page-head')
            page.wait_for_timeout(300)
            if page.locator('.empty-state button:has-text("Import playlists")').count():
                with page.expect_file_chooser() as fc:
                    page.click('.empty-state button:has-text("Import playlists")')
            else:
                page.click('.playlists-menu')
                page.wait_for_selector('.sheet.open')
                with page.expect_file_chooser() as fc:
                    page.locator('.sheet.open .sheet-action', has_text='Import playlists').click()
            fc.value.set_files(path)
            if choose is not None:
                page.wait_for_selector('.sheet.open .import-choice')
                for row in page.locator('.sheet.open .import-choice').all():
                    want = row.locator('.import-choice-title').inner_text() in choose
                    if row.locator('input').is_checked() != want:
                        row.locator('input').click()
                page.locator('.sheet.open .import-form > .btn-primary').click()
            elif name is not False:
                page.wait_for_selector('.sheet.open .ask-form input')
                if name:
                    page.fill('.sheet.open .ask-form input', name)
                page.click('.sheet.open .ask-form button[type=submit]')
            if name is False:
                return None
            page.wait_for_selector('.sheet.open .dialog-close:has-text("Done")', timeout=60000)
            out = page.locator('.sheet.open .import-form').inner_text()
            return out

        def close_dialog(page):
            page.click('.sheet.open .dialog-close')
            page.wait_for_selector('.sheet.open', state='detached')

        # Export: from a playlist's menu, a file with each track's title,
        # artist, album and Plex's ids for it, and nothing about the server.
        late = next(p for p in pls() if p['title'] == 'Late night')
        want = entries(late['ratingKey'])
        page.goto(APP + f"#/playlist/{late['ratingKey']}")
        page.wait_for_selector('.hero-album')
        page.click('.back-actions button[aria-label="More options"]')
        page.wait_for_selector('.sheet.open')
        with page.expect_download() as dl:
            page.locator('.sheet.open .sheet-action', has_text='Export to a file').click()
        text = open(dl.value.path(), encoding='utf-8').read()
        data = json.loads(text)
        tracks = data['playlists'][0]['tracks'] if data.get('playlists') else []
        first = mock(f"/library/metadata/{want[0]}?X-Plex-Token=t")['MediaContainer']['Metadata'][0]
        check('files: a playlist exports to a file, from its menu', dl.value.suggested_filename == 'Late night.playlist.json' and data.get('format') == 'plexamp-web-playlists'
              and data['playlists'][0]['title'] == 'Late night' and [t['id'] for t in tracks] == want, f'{dl.value.suggested_filename} {text[:200]}')
        check('files: ...each track with its title, artist, album, number, length and Plex\'s ids',
              tracks[0] == {'title': first['title'], 'artist': first.get('originalTitle') or first['grandparentTitle'], 'albumArtist': first['grandparentTitle'],
                            'album': first['parentTitle'], 'year': first['parentYear'], 'disc': first['parentIndex'], 'index': first['index'],
                            'duration': first['duration'], 'guid': first['guid'], 'id': first['ratingKey']}, json.dumps(tracks[:1]))
        check('files: ...and nothing about the server (no addresses, file paths or tokens)',
              not re.search(r'https?:|/library/|token|127\.0\.0\.1|\.flac', text, re.I) and len(text.splitlines()) >= len(tracks) + 6, text[:300])
        late_file = write('late-night.playlist.json', text)

        # Someone else with access to the server imports it: the same tracks.
        sam_ctx = browser.new_context(accept_downloads=True, **MOBILE)
        sam = sam_ctx.new_page()
        attach(sam, 'files-sam')
        login(sam, APP, 't2')
        before = pls('t2')
        said = import_file(sam, late_file)
        shot(sam, 'files-01-imported')
        got = new_ones(before, 't2')
        check('files: a friend imports it, with the same tracks in the same order',
              len(got) == 1 and got[0]['title'] == 'Late night' and entries(got[0]['ratingKey'], 't2') == want and f'All {len(want)} tracks found' in said, f'{said} {got}')
        close_dialog(sam)

        # A server set up again (the same music, new ids): found by Plex's id
        # for each recording. Its name is asked, as Dan has one by that name.
        moved = json.loads(text)
        for t in moved['playlists'][0]['tracks']:
            t['id'] = str(900000 + int(t['id']))
        before = pls()
        page.goto(APP + '#/playlists')
        said = import_file(page, write('moved.playlist.json', moved))
        got = new_ones(before)
        check('files: on a server set up again, tracks are found by Plex\'s id for them (and a name in use is offered with "(imported)")',
              len(got) == 1 and got[0]['title'] == 'Late night (imported)' and entries(got[0]['ratingKey']) == want and f'All {len(want)} tracks found' in said, f'{said} {got}')
        close_dialog(page)

        # On another server: by title and artist (and the album and length,
        # between copies). One that isn't here is listed, to copy.
        other = json.loads(text)
        for t in other['playlists'][0]['tracks']:
            del t['id'], t['guid']
        other['playlists'][0]['tracks'].insert(2, {'title': 'A Song Nobody Has', 'artist': 'Nobody'})
        # One named differently there, and by an artist named differently:
        # found on its album, by its number and length.
        spare = next(m for m in mock('/library/sections/1/all?type=10&X-Plex-Token=t&X-Plex-Container-Size=300')['MediaContainer']['Metadata'] if m['ratingKey'] not in want)
        other['playlists'][0]['tracks'].append({'title': 'Called Something Else Here', 'artist': 'Somebody Else', 'albumArtist': spare['grandparentTitle'],
                                                'album': spare['parentTitle'], 'year': spare.get('parentYear'), 'disc': spare.get('parentIndex', 1),
                                                'index': spare['index'], 'duration': spare['duration'] + 1500})
        # One that isn't here, with its album, to look for.
        other['playlists'][0]['tracks'].append({'title': 'Lost B-Side', 'artist': 'Nobody', 'album': 'Unreleased Things', 'year': 1999, 'disc': 1, 'index': 7, 'duration': 245000})
        before = pls()
        said = import_file(page, write('other.playlist.json', other), name='From elsewhere')
        got = new_ones(before)
        shot(page, 'files-02-not-found')
        page.click('.sheet.open .import-missing summary')
        songs = page.locator('.sheet.open .import-missing .import-missing-song').all_inner_texts()
        wheres = page.locator('.sheet.open .import-missing .import-missing-where').all_inner_texts()
        check('files: on another server, by title and artist, or on its album by its number; what isn\'t there is listed, with its album',
              len(got) == 1 and got[0]['title'] == 'From elsewhere' and entries(got[0]['ratingKey']) == want + [spare['ratingKey']]
              and f'{len(want) + 1} of {len(want) + 3} tracks found; 2 not in ' in said
              and songs == ['Nobody — A Song Nobody Has', 'Nobody — Lost B-Side'] and wheres == ['Unreleased Things, 1999 · track 7 · 4:05'],
              f'{said!r} {songs} {wheres} {entries(got[0]["ratingKey"]) if got else None} {want} {spare["ratingKey"]}')
        page.locator('.sheet.open .import-missing button', has_text='Copy the list').click()
        page.wait_for_selector('.toast:has-text("Copied")')
        copied = js(page, '() => navigator.clipboard.readText()')
        with page.expect_download() as dl:
            page.locator('.sheet.open .import-missing button', has_text='Save as a spreadsheet').click()
        sheet_text = open(dl.value.path(), encoding='utf-8-sig').read()
        check('files: ...to copy, or save as a spreadsheet, with each one\'s album',
              copied == 'Nobody — A Song Nobody Has\nNobody — Lost B-Side — Unreleased Things (1999)\n'
              and dl.value.suggested_filename == 'From elsewhere - not found.csv'
              and sheet_text.splitlines()[0] == '"Artist","Title","Album","Album artist","Year","Disc","Track","Length"'
              and '"Nobody","Lost B-Side","Unreleased Things","","1999","1","7","4:05"' in sheet_text.splitlines(),
              f'{copied!r} {dl.value.suggested_filename} {sheet_text!r}')
        close_dialog(page)

        # A backup: every playlist of yours (not smart ones), in one file.
        page.goto(APP + '#/playlists')
        page.wait_for_selector('.playlists-menu')
        page.click('.playlists-menu')
        page.wait_for_selector('.sheet.open')
        with page.expect_download() as dl:
            page.locator('.sheet.open .sheet-action', has_text='Back up your playlists').click()
        page.wait_for_selector('.sheet.open .dialog-close:has-text("Done")', timeout=30000)
        backup = json.loads(open(dl.value.path(), encoding='utf-8').read())
        titles = sorted(p['title'] for p in backup['playlists'])
        theirs = sorted(p['title'] for p in pls() if not p['smart'])
        said = page.locator('.sheet.open .import-status').inner_text()
        shot(page, 'files-03-backup')
        check('files: a backup has all your playlists in one file, but not smart ones',
              re.fullmatch(r'Playlists \d{4}-\d\d-\d\d\.playlist\.json', dl.value.suggested_filename) and titles == theirs and 'Everything' not in titles
              and said.startswith(f'Saved {len(theirs)} playlists'), f'{dl.value.suggested_filename} {titles} {theirs} {said}')
        close_dialog(page)

        # ...imported (as after a server is set up again): which ones is
        # asked, those you have (by name) not chosen to begin with.
        before = pls('t2')
        path = write('backup.playlist.json', open(dl.value.path(), encoding='utf-8').read())
        sam.goto(APP + '#/playlists')
        sam.wait_for_selector('.playlists-menu')
        sam.click('.playlists-menu')
        sam.wait_for_selector('.sheet.open')
        with sam.expect_file_chooser() as fc:
            sam.locator('.sheet.open .sheet-action', has_text='Import playlists').click()
        fc.value.set_files(path)
        sam.wait_for_selector('.sheet.open .import-choice')
        offered = {r.locator('.import-choice-title').inner_text(): r.locator('input').is_checked() for r in sam.locator('.sheet.open .import-choice').all()}
        shot(sam, 'files-04-choose')
        check('files: importing a backup asks which, leaving out those you have', len(offered) == len(theirs) and offered.get('Late night') is False
              and offered.get('Workout') is True, str(offered))
        for r in sam.locator('.sheet.open .import-choice').all():
            if r.locator('.import-choice-title').inner_text() not in ('Workout', 'Sunday morning') and r.locator('input').is_checked():
                r.locator('input').click()
        sam.locator('.sheet.open .import-form > .btn-primary').click()
        sam.wait_for_selector('.sheet.open .dialog-close:has-text("Done")', timeout=60000)
        got = new_ones(before, 't2')
        said = sam.locator('.sheet.open .import-status').inner_text()
        check('files: ...and makes the ones chosen', sorted(p['title'] for p in got) == ['Sunday morning', 'Workout'] and said.startswith('Imported 2 playlists'), f'{said} {got}')
        close_dialog(sam)
        sam.wait_for_timeout(600)
        cards = sam.locator('.grid-playlists .card').count()
        check('files: ...and the Playlists page shows them', cards == len(pls('t2')), f'{cards} cards')

        # Something that isn't a playlist file says so.
        import_file(page, write('not-a-playlist.json', '{"hello": 1}'), name=False)
        check('files: a file that isn\'t a playlist file says so', page.wait_for_selector('.toast:has-text("isn’t a playlist file")', timeout=5000) is not None)

        for token, pid in made:
            urllib.request.urlopen(urllib.request.Request(f'{MOCK}/playlists/{pid}?X-Plex-Token={token}', method='DELETE'), timeout=10).read()
        sam_ctx.close()
        ctx.close()

    # ---------- sharing: a playlist shared with a Plex friend, kept the same ----------
    if run('sharing'):
        def pl_items(pid, token):
            return [m['ratingKey'] for m in mock(f'/playlists/{pid}/items?X-Plex-Token={token}&X-Plex-Container-Size=500')['MediaContainer'].get('Metadata', [])]

        def pl_entries(pid, token):
            return mock(f'/playlists/{pid}/items?X-Plex-Token={token}&X-Plex-Container-Size=500')['MediaContainer'].get('Metadata', [])

        def plex(method, path, token):
            sep = '&' if '?' in path else '?'
            return urllib.request.urlopen(urllib.request.Request(f'{MOCK}{path}{sep}X-Plex-Token={token}', method=method), timeout=10).read()

        def uri(ids):
            return urllib.parse.quote(f'server://mock-server-1/com.plexapp.plugins.library/library/metadata/{",".join(ids)}', safe='')

        def sync(pg):
            js(pg, "() => import('./js/sharing.js').then((m) => m.syncAll())")

        def full_sync(pg):
            """Even where nothing seems to have changed (as every few minutes)."""
            js(pg, "() => import('./js/sharing.js').then(async (m) => { await m.loadShares();"
                   " for (const s of m.sharesNow()) if (s.joined && s.copy) await m.syncShare(s, { force: true }); })")

        def mine(token):
            return mock(f'/playlists?playlistType=audio&X-Plex-Token={token}')['MediaContainer'].get('Metadata', [])

        dan_ctx = browser.new_context(**MOBILE)
        dan = dan_ctx.new_page()
        attach(dan, 'sharing-dan')
        login(dan, APP, 't')
        sam_ctx = browser.new_context(**MOBILE)
        sam = sam_ctx.new_page()
        attach(sam, 'sharing-sam')
        login(sam, APP, 't2')

        workout = next(p for p in mine('t') if p['title'] == 'Workout')
        wid = workout['ratingKey']
        original = pl_items(wid, 't')

        # Dan shares Workout with Sam, who can edit it (Alex can't use the
        # server, so can't have it).
        dan.goto(APP + f'#/playlist/{wid}')
        dan.wait_for_selector('.hero-album')
        dan.click('.back-actions button[aria-label="More options"]')
        dan.wait_for_selector('.sheet.open')
        dan.locator('.sheet.open .sheet-action', has_text='Share with friends').click()
        dan.wait_for_selector('.sheet.open .share-friend')
        rows = {r.locator('.friend-name').inner_text(): r for r in dan.locator('.sheet.open .share-friend').all()}
        alex_off = rows['Alex'].locator('select').is_disabled() and 'Can’t play from' in rows['Alex'].inner_text()
        rows['Sam'].locator('select').select_option('edit')
        shot(dan, 'sharing-01-share')
        go = dan.locator('.sheet.open .friend-actions .btn-primary')
        label = go.inner_text()
        go.click()
        dan.wait_for_selector('.toast:has-text("Shared “Workout”")')
        dan.wait_for_selector('.share-line', timeout=10000)
        line = dan.locator('.share-line').inner_text()
        check('sharing: a playlist is shared from its menu, with friends who can use the server', alex_off and label == 'Share with 1 friend'
              and line == 'Shared with Sam (invited)' and dan.locator('.hero-art-box .shared-mark:not([hidden])').count() == 1, f'{alex_off} {label!r} {line!r}')
        dan.goto(APP + '#/playlists')
        dan.wait_for_selector('.grid-playlists .card')
        marked = dan.locator('.grid-playlists .card:has(.shared-mark:not([hidden])) .card-title').all_inner_texts()
        check('sharing: ...and shows it, at the top left of its picture', marked == ['Workout'], str(marked))

        # Sam: the Playlists tab says so; he adds it, and has the same tracks.
        sync(sam)
        dotted = wait_for(lambda: sam.locator('#tabs .tab[data-tab=playlists] .tab-dot:not([hidden])').count() == 1, 10)
        sam.goto(APP + '#/playlists')
        sam.wait_for_selector('.invites .invite-row')
        invite = sam.locator('.invites .invite-row').inner_text()
        shot(sam, 'sharing-02-invited')
        check('sharing: a friend is told (a dot on Playlists), and offered it there', dotted and 'Workout' in invite and 'From Dan · 11 tracks · you can edit it' in invite, invite)
        sam.locator('.invite-row button:has-text("Add")').click()
        sam.wait_for_selector('.toast:has-text("Added “Workout”")')
        copy = wait_for(lambda: next((p for p in mine('t2') if p['title'] == 'Workout'), None), 10)
        cid = copy['ratingKey'] if copy else None
        sam.wait_for_selector('.grid-playlists .card')
        sam_marked = sam.locator('.grid-playlists .card:has(.shared-mark:not([hidden])) .card-title').all_inner_texts()
        check('sharing: ...and once added, it\'s a playlist of his own with the same tracks, marked as shared',
              cid and pl_items(cid, 't2') == original and sam_marked == ['Workout'] and sam.locator('.invites .invite-row').count() == 0
              and sam.locator('#tabs .tab[data-tab=playlists] .tab-dot:not([hidden])').count() == 0, f'{sam_marked}')

        # Sam takes a track out in plexamp-web: Dan's has it too.
        sam.goto(APP + f'#/playlist/{cid}')
        sam.wait_for_selector('.view .tracks .track')
        sam_line = sam.locator('.share-line').inner_text()
        sam.click('.lock-btn')
        sam.wait_for_selector('.edit-bar:not([hidden])')
        gone = sam.locator('.view .tracks .track').first.get_attribute('data-track-id')
        sam.locator('.view .tracks .track .row-remove').first.click()
        # (Dan's copy is his browser's to change: when he opens plexamp-web,
        # or within a minute while it's open.)
        got = wait_for(lambda: (sync(dan), gone not in pl_items(wid, 't') and pl_items(wid, 't') == pl_items(cid, 't2'))[1], 15)
        check('sharing: a change made in plexamp-web by someone who can edit it reaches everyone', got and sam_line == 'Shared by Dan · you can edit it',
              f'{sam_line} {pl_items(wid, "t")} {pl_items(cid, "t2")}')
        sam.click('.edit-bar .edit-done')

        # Dan adds one in another app (Plexamp, say): the next time either
        # opens plexamp-web, everyone has it.
        extra = next(t for t in mock('/library/sections/1/all?type=10&X-Plex-Token=t&X-Plex-Container-Size=200')['MediaContainer']['Metadata']
                     if t['ratingKey'] not in original)['ratingKey']
        plex('PUT', f'/playlists/{wid}/items?uri={uri([extra])}', 't')
        sync(dan)
        sync(sam)
        check('sharing: a change made in another app reaches everyone when plexamp-web is opened', pl_items(cid, 't2')[-1:] == [extra]
              and pl_items(cid, 't2') == pl_items(wid, 't'), f'{pl_items(wid, "t")} {pl_items(cid, "t2")}')

        # Both change theirs before either opens plexamp-web again: both
        # changes are kept.
        sam_extra = next(t for t in mock('/library/sections/1/all?type=10&X-Plex-Token=t&X-Plex-Container-Size=200')['MediaContainer']['Metadata']
                         if t['ratingKey'] not in original and t['ratingKey'] != extra)['ratingKey']
        plex('PUT', f'/playlists/{cid}/items?uri={uri([sam_extra])}', 't2')
        drop = pl_entries(wid, 't')[0]
        plex('DELETE', f'/playlists/{wid}/items/{drop["playlistItemID"]}', 't')
        sync(sam)
        sync(dan)
        sync(sam)
        a, b = pl_items(wid, 't'), pl_items(cid, 't2')
        check('sharing: changes made by two people meanwhile are both kept (one\'s added track, the other\'s removal)',
              a == b and sam_extra in a and drop['ratingKey'] not in a and extra in a, f'{a} {b}')

        # A track Sam can't have (from a library that isn't shared with him,
        # say) isn't in his copy, and isn't taken out of anyone else's.
        hidden = next(t for t in mock('/library/sections/1/all?type=10&X-Plex-Token=t&X-Plex-Container-Size=200')['MediaContainer']['Metadata']
                      if t['ratingKey'] not in a)['ratingKey']
        mock(f'/__mock/config?hidden={hidden}')
        plex('PUT', f'/playlists/{wid}/items?uri={uri([hidden])}', 't')
        sync(dan)
        sync(sam)
        full_sync(sam)
        full_sync(dan)
        check('sharing: a track a friend can\'t have stays in everyone else\'s', hidden in pl_items(wid, 't') and hidden not in pl_items(cid, 't2'),
              f'{pl_items(wid, "t")} {pl_items(cid, "t2")}')
        mock('/__mock/config?hidden=')
        plex('DELETE', f'/playlists/{wid}/items/{next(e for e in pl_entries(wid, "t") if e["ratingKey"] == hidden)["playlistItemID"]}', 't')
        sync(dan)
        sync(sam)

        # One Sam can't see any more (its library stopped being shared with
        # him, say): gone from his copy as Plex lists it, but not taken out
        # for everyone; seen again, it's there once.
        lost = pl_items(cid, 't2')[1]
        mock(f'/__mock/config?hidden={lost}')
        full_sync(sam)
        full_sync(dan)
        kept_for_dan = lost in pl_items(wid, 't') and lost not in pl_items(cid, 't2')
        mock('/__mock/config?hidden=')
        full_sync(sam)
        full_sync(dan)
        a, b = pl_items(wid, 't'), pl_items(cid, 't2')
        check('sharing: a track a friend can no longer see isn\'t taken out for everyone, and is there once when they can again',
              kept_for_dan and a == b and a.count(lost) == 1, f'{kept_for_dan} {a} {b}')

        # View only: Sam's own changes are undone, and his copy can't be
        # unlocked here.
        dan.goto(APP + f'#/playlist/{wid}')
        dan.wait_for_selector('.share-line')
        dan.click('.share-line')
        dan.wait_for_selector('.sheet.open .share-friend')
        dan.locator('.sheet.open .share-friend', has_text='Sam').locator('select').select_option('view')
        dan.locator('.sheet.open .friend-actions .btn-primary').click()
        dan.wait_for_selector('.toast:has-text("Saved")')
        before = pl_items(cid, 't2')
        plex('DELETE', f'/playlists/{cid}/items/{pl_entries(cid, "t2")[0]["playlistItemID"]}', 't2')
        sam.goto(APP + '#/playlists')
        sam.wait_for_selector('.grid-playlists .card')
        sync(sam)
        told = sam.wait_for_selector('.toast:has-text("were undone")', timeout=10000) is not None
        sam.goto(APP + f'#/playlist/{cid}')
        sam.wait_for_selector('.view .tracks .track')
        view_line = sam.locator('.share-line').inner_text()
        check('sharing: someone who can only view it has their own changes undone (and told), and can\'t unlock it here',
              told and pl_items(cid, 't2') == before == pl_items(wid, 't') and sam.locator('.lock-btn').count() == 0
              and view_line == 'Shared by Dan · you can view it, not edit it', f'{view_line} {before} {pl_items(cid, "t2")}')

        # Dan renames it: Sam's is renamed too.
        plex('PUT', f'/playlists/{wid}?title=Workout+mix', 't')
        sync(dan)
        sync(sam)
        check('sharing: renamed by whoever shared it, everyone\'s is', next((p['title'] for p in mine('t2') if p['ratingKey'] == cid), None) == 'Workout mix')

        # Dan stops sharing it: both keep theirs, no longer marked shared.
        dan.goto(APP + f'#/playlist/{wid}')
        dan.wait_for_selector('.share-line')
        dan.click('.share-line')
        dan.wait_for_selector('.sheet.open .share-stop')
        dan.click('.sheet.open .share-stop')
        dan.wait_for_selector('.sheet.open .ask-form .btn-danger')
        dan.click('.sheet.open .ask-form .btn-danger')
        dan.wait_for_selector('.toast:has-text("isn’t shared any more")')
        sync(sam)
        sam.goto(APP + '#/playlists')
        sam.wait_for_selector('.grid-playlists .card')
        sam.wait_for_timeout(400)
        kept = any(p['ratingKey'] == cid for p in mine('t2'))
        check('sharing: when it stops being shared, everyone keeps theirs, without the mark', kept and sam.locator('.grid-playlists .shared-mark:not([hidden])').count() == 0
              and dan.locator('.share-line').count() == 0, f'{kept}')

        # Turned down: it's not offered again. Added, then deleted (in another
        # app, say): it stops being shared with him.
        share_again = ("() => import('./js/sharing.js').then(async (m) => { const { app } = await import('./js/state.js');"
                       f" await m.sharePlaylist(await app.server.playlist({wid}), [{{ id: 1002, role: 'edit' }}]); }})")
        js(dan, share_again)
        sync(sam)
        sam.goto(APP + '#/playlists')
        sam.wait_for_selector('.invites .invite-row')
        sam.locator('.invite-row button:has-text("No thanks")').click()
        sam.wait_for_timeout(800)
        sync(sam)
        declined = sam.locator('.invites .invite-row').count() == 0
        members = js(dan, "() => import('./js/sharing.js').then(async (m) => (await m.loadShares()).map((s) => (s.members || []).length))")
        check('sharing: an invitation turned down goes, for both', declined and members == [0], f'{declined} {members}')
        js(dan, "() => import('./js/sharing.js').then(async (m) => { for (const s of await m.loadShares()) await m.setMembers(s, [{ id: 1002, role: 'edit' }]); })")
        js(sam, "() => import('./js/sharing.js').then(async (m) => { await m.loadShares(); await m.addShared(m.invitations()[0]); })")
        second = next(p for p in mine('t2') if p['ratingKey'] != cid and p['title'].startswith('Workout'))['ratingKey']
        plex('DELETE', f'/playlists/{second}', 't2')
        full_sync(sam)
        members = js(dan, "() => import('./js/sharing.js').then(async (m) => (await m.loadShares()).map((s) => (s.members || []).map((x) => x.title)))")
        check('sharing: a friend who deletes their copy stops getting it', members == [[]], str(members))
        js(dan, "() => import('./js/sharing.js').then(async (m) => { for (const s of await m.loadShares()) await m.stopSharing(s); })")

        # A copy is brought up to date by making only the difference: a track
        # added to it meanwhile (in another app, say) stays, after those
        # wanted, to go to everyone the next time.
        every = [t['ratingKey'] for t in mock('/library/sections/1/all?type=10&X-Plex-Token=t&X-Plex-Container-Size=200')['MediaContainer']['Metadata']]
        read = pl_items(wid, 't')
        late = next(t for t in every if t not in read)
        plex('PUT', f'/playlists/{wid}/items?uri={uri([late])}', 't')
        wanted = read[1:] + [next(t for t in every if t not in read and t != late)]
        r = js(dan, f"() => import('./js/playlistio.js').then((m) => m.changePlaylist({json.dumps(wid)}, {json.dumps(read)}, {json.dumps(wanted)}))")
        after = pl_items(wid, 't')
        check('sharing: only the difference is made to a copy (a track added to it meanwhile stays)', after == wanted + [late] and r == {'changed': True, 'base': wanted},
              f'{after} {wanted} {r}')
        # Only on its own server: not finding a copy on another server isn't
        # taken for it having been deleted.
        elsewhere = js(dan, "() => import('./js/sharing.js').then((m) => m.syncShare({ id: 'ab'.repeat(12), server: 'another-server', copy: '999999',"
                            " role: 'owner', version: 1, owner: { id: 1001, title: 'Dan' } }))")
        check('sharing: a copy is only looked for on its own server', elsewhere == {'changed': False}, str(elsewhere))

        # Put things back for the sections after this.
        plex('DELETE', f'/playlists/{cid}', 't2')
        for e in pl_entries(wid, 't'):
            plex('DELETE', f'/playlists/{wid}/items/{e["playlistItemID"]}', 't')
        plex('PUT', f'/playlists/{wid}/items?uri={uri(original)}', 't')
        plex('PUT', f'/playlists/{wid}?title=Workout', 't')
        check('sharing: (the playlist is as it was)', pl_items(wid, 't') == original)
        dan_ctx.close()
        sam_ctx.close()

    # ---------- routes: how the app reaches the server, and why ----------
    if run('routes'):
        ctx = browser.new_context(**MOBILE)
        page = ctx.new_page()
        attach(page, 'routes')
        # plex.tv, as this browser sees it: Dan's server (the one this
        # container proxies), with an address on his network this browser
        # can't reach, and one over the internet that it can.
        resources = [{'name': 'Mock Plex', 'clientIdentifier': 'mock-server-1', 'provides': 'server', 'owned': True, 'accessToken': 't',
                      'connections': [{'uri': 'http://127.0.0.1:9', 'local': True, 'relay': False, 'protocol': 'http'},
                                      {'uri': 'https://remote.test:32400', 'local': False, 'relay': False, 'protocol': 'https'}]}]
        page.route(re.compile(r'https://(clients\.)?plex\.tv/api/v2/resources.*'),
                   lambda route: route.fulfill(status=200, content_type='application/json', body=json.dumps(resources), headers={'Access-Control-Allow-Origin': '*'}))
        # Its address over the internet (https, as Plex gives them) is the
        # mock, but for live updates' event stream, which never ends (live
        # updates check every minute instead). The mock is told where the
        # request came from, as a real server would be, and as an answer
        # handed over here isn't held to CORS, one the browser would refuse
        # is refused here.
        def via_mock(route):
            url = route.request.url
            if '/:/eventsource/' in url:
                return route.abort()
            origin = route.request.header_value('origin')
            res = route.fetch(url=url.replace('https://remote.test:32400', MOCK), headers={**route.request.headers, **({'origin': origin} if origin else {})})
            if origin and 'access-control-allow-origin' not in res.headers:
                return route.abort()
            return route.fulfill(response=res)
        page.route(re.compile(r'https://remote\.test:32400/.*'), via_mock)
        login(page, APP)
        js(page, "() => import('./js/state.js').then((m) => m.setAuth({ ...m.app.auth, manual: false }))")
        page.goto(APP + '#/settings/source')
        page.wait_for_selector('.source-body .row .row-sub:has-text("set up for this app")', timeout=15000)
        rows = [(r.locator('.row-title').inner_text(), r.locator('.row-sub').inner_text()) for r in page.locator('.source-body .rows > .row').all()]
        shot(page, 'routes-01-source')
        check('routes: the server this container is set up for is listed once, as one of yours',
              rows[:1] == [('Mock Plex', 'Your server · also set up for this app')] and not any(t == 'Server set up for this app' for t, _ in rows), str(rows))
        page.locator('.source-body .row', has_text='Mock Plex').click()
        page.wait_for_selector('.section-head h2:has-text("Libraries on")')
        page.locator('.source-body .row').first.click()
        page.wait_for_selector('.wide-card:not(.skeleton)')
        # The Connection page: the routes aren't tried just by opening it,
        # only when the connection is tested.
        page.wait_for_timeout(2000)  # (the app's own look for a better route, as it started, is done)
        tried = []
        page.on('request', lambda r: tried.append(r.url) if '/identity' in r.url else None)
        js(page, "() => import('./js/router.js').then((m) => m.navigate('/settings/debug'))")
        page.wait_for_selector('.route-choice .radio-row')
        page.wait_for_timeout(1500)
        quiet = (list(tried), page.locator('.route-row').count())
        page.click('button:has-text("Test connection")')
        page.wait_for_selector('.route-row', timeout=15000)
        conn = page.locator('.kv', has_text='Connection').first.inner_text()
        routes = [(r.get_attribute('data-kind'), r.inner_text()) for r in page.locator('.route-row').all()]
        hint = page.locator('.route-hint').inner_text()
        shot(page, 'routes-02-connection')
        page.locator('.routes').scroll_into_view_if_needed()
        shot(page, 'routes-03-routes')
        check('routes: opening the Connection page tries no routes; testing the connection does', quiet == ([], 0) and len(routes) == 3, f'{quiet} {routes}')
        check('routes: through this container when its address on the network doesn\'t answer, saying why',
              'Through this container' in conn and 'set up for Mock Plex too' in conn and [k for k, _ in routes] == ['local', 'proxy', 'remote']
              and '(in use)' in routes[1][1] and 'Didn’t answer this browser' in routes[0][1] and ' ms' in routes[2][1] and 'Chrome asks you first' in hint,
              f'{conn!r} {routes} {hint!r}')
        page.click('.radio-row:has(.row-title:text-is("Straight to the server"))')
        page.wait_for_selector('.toast:has-text("Now connected over the internet")')
        page.wait_for_selector('.kv:has-text("Connection") .kv-v:text-is("Remote")', timeout=15000)
        direct = (js(page, "() => import('./js/state.js').then((m) => [m.app.source.kind, m.app.settings.route])"), page.locator('.kv', has_text='Connection').first.inner_text())
        check('routes: "Straight to the server" goes there, over the internet here', direct[0] == ['remote', 'direct'] and 'Remote' in direct[1] and page.locator('.route-row').count() == 0, str(direct))
        page.click('.radio-row:has(.row-title:text-is("Best that answers"))')
        page.wait_for_selector('.toast:has-text("Now connected through this container")')
        page.wait_for_selector('.kv:has-text("Connection") .kv-v:text-is("Through this container")', timeout=15000)
        # The test of the connection: through this container, which part
        # doesn't answer.
        no_plex = re.compile(r'/pms/identity')
        page.route(no_plex, lambda route: route.abort())
        page.click('button:has-text("Test connection")')
        page.wait_for_selector('.kv:has-text("Response time") .kv-v:not(:has-text("Testing"))')
        said = page.locator('.kv', has_text='Response time').inner_text()
        page.unroute(no_plex)
        check('routes: a test that gets no answer through this container says this container answered', 'This container answers, but Mock Plex didn’t answer through it' in said, said)
        page.click('button:has-text("Test connection")')
        page.wait_for_selector('.kv:has-text("Response time") .kv-v:has-text(" ms")')
        check('routes: ...and the time it takes when it answers', re.search(r'\d ms', page.locator('.kv', has_text='Response time').inner_text()) is not None)
        page.unroute_all(behavior='ignoreErrors')
        ctx.close()

    # ---------- privacy: searches, signing out, other tabs ----------
    if run('privacy'):
        ctx = browser.new_context(**MOBILE)
        page = ctx.new_page()
        attach(page, 'privacy')
        login(page, APP)
        heads = lambda: page.locator('.search-body .section-head h2').all_inner_texts()
        # What's searched for stays out of the page's address (and so the
        # browser's history), and still comes back with Back and a reload.
        page.goto(APP + '#/search')
        page.wait_for_selector('.search-box input')
        page.fill('.search-box input', 'harbour')
        wait_for(lambda: any('ARTISTS' in t.upper() for t in heads()), 8)
        address = js(page, '() => location.href')
        page.locator('.search-body a.row').first.click()
        page.wait_for_function("() => location.hash !== '#/search'")
        page.go_back()
        page.wait_for_selector('.search-box input')
        back = page.input_value('.search-box input')
        page.reload()
        page.wait_for_selector('.search-box input')
        page.wait_for_timeout(600)
        reloaded = page.input_value('.search-box input')
        check('privacy: a search isn\'t in the page\'s address, and comes back with Back and a reload',
              address.endswith('#/search') and 'harbour' not in address and back == 'harbour' and reloaded == 'harbour', f'{address} {back!r} {reloaded!r}')
        page.goto(APP + '#/search?q=lantern')
        page.wait_for_selector('.search-box input')
        check('privacy: ...and an address from before with a search in it still opens it', page.input_value('.search-box input') == 'lantern')

        # Debug mode's redaction finds tokens inside other addresses, in
        # headers, and by their other names.
        red = js(page, """() => import('./js/debug.js').then((m) => m.redact(
            '/photo/:/transcode?url=%2Fx%3FX-Plex-Token%3Dsecret1%26w%3D2&X-Plex-Token=secret2 {"accessToken":"secret3"} X-Plex-Token: secret4'))""")
        check('privacy: debug mode\'s redaction finds tokens wherever they are', not any(f'secret{i}' in red for i in range(1, 5)), red)

        # AirPlay and Cast are given the server's temporary token, and never
        # one for another server or account, nor the account's own.
        urls = js(page, """() => import('./js/player.js').then(({ player }) => {
            const t = { id: '120', qid: 1, partKey: '/library/parts/120/0/file.flac', codec: 'flac' };
            player.setMediaToken('temporary-token-1');
            player.useMediaToken = true;
            const mine = player.sourceFor(t).url;
            player.mediaToken = { value: 'other-servers-token', key: 'another-server|x' };
            const other = player.sourceFor(t).url;
            player.useMediaToken = false;
            player.mediaToken = null;
            return [mine, other, player.sourceFor(t).url];
        })""")
        check('privacy: AirPlay and Cast only ever get the server\'s temporary token for this server',
              'X-Plex-Token=temporary-token-1' in urls[0] and 'other-servers-token' not in urls[1] and 'X-Plex-Token=' not in urls[1] and 'X-Plex-Token=t' in urls[2], str(urls))

        # Signing out: what's yours goes (with the page itself), what's the
        # device's stays, and another tab signed in follows.
        settings(page, {'playerName': 'Dan’s phone', 'gridSize': 'large', 'home': {'mock-server-1:1': {'order': ['recent']}},
                        'ai': {'mode': 'custom', 'url': OLLAMA, 'apiKey': 'key-123', 'model': 'llama3.1:8b', 'notes': 'Loves trip-hop'}})
        # (Search's counts for the library kept, to see them go too.)
        page.goto(APP + '#/search')
        page.wait_for_selector('.browse-tile')
        wait_for(lambda: js(page, "() => !!localStorage.getItem('pw.libraryCounts')"), 10, 0.3)
        other = ctx.new_page()
        attach(other, 'privacy-other')
        play_first_album_track(other, APP)
        art = APP + 'pms/photo/:/transcode?url=%2Flibrary%2Fmetadata%2F120%2Fthumb%2F1&width=100&height=100&X-Plex-Token=t'
        kept_art = """(u) => fetch(u, { cache: 'only-if-cached', mode: 'same-origin' }).then((r) => r.status, () => 'not kept')"""
        page.evaluate('(u) => fetch(u).then((r) => r.blob())', art)
        art_before = page.evaluate(kept_art, art)
        page.goto(APP + '#/settings/account')
        page.click('.account-card button:has-text("Sign out")')
        page.wait_for_selector('.sheet.open')
        said = page.locator('.sheet.open').inner_text()
        shot(page, 'privacy-01-sign-out')
        # (The page loads afresh a moment after the login page shows: waited
        # for, so what's read below is the new page's.)
        with page.expect_request(re.compile(r'/signed-out$')) as forgot:
            with page.expect_event('load', timeout=15000):
                page.locator('.sheet.open .sheet-action', has_text='Sign out').click()
        page.wait_for_selector('text=Use a server address and token instead')
        kept = js(page, "() => JSON.parse(localStorage.getItem('pw.settings'))")
        keys = js(page, "() => Object.keys(localStorage).filter((k) => k.startsWith('pw.')).sort()")
        check('privacy: signing out says what goes and what stays', 'AI settings' in said and 'Home layout' in said and 'How the app looks and plays stays' in said, said)
        check('privacy: ...clears what\'s yours, and keeps the device\'s',
              kept.get('playerName') == '' and kept.get('home') == {} and kept.get('ai') == {'mode': 'auto', 'url': '', 'apiKey': '', 'model': '', 'notes': ''}
              and kept.get('gridSize') == 'large' and not any(k in keys for k in ('pw.auth', 'pw.source', 'pw.aiMissing', 'pw.libraryCounts', 'pw.syncPending', 'pw.syncRev')) and 'pw.clientId' in keys, f'{kept} {keys}')
        art_after = page.evaluate(kept_art, art)
        check('privacy: ...and the browser forgets artwork it kept from this player (its address has the token)',
              forgot.value.url.endswith('/signed-out') and art_before == 200 and art_after == 'not kept', f'{art_before} {art_after}')
        other.wait_for_selector('text=Use a server address and token instead', timeout=10000)
        page.wait_for_timeout(500)
        left = js(page, "() => Object.keys(localStorage).filter((k) => k.startsWith('pw.')).sort()")
        check('privacy: ...and another tab signed in signs out too, keeping nothing of what it was playing',
              other.url.endswith('#/login') and not any(k.startswith('pw.player') or k in ('pw.auth', 'pw.source') for k in left), f'{other.url} {left}')
        ctx.close()

        # What's typed in a search, or in a list's search box, is kept with
        # the tab's own record of its pages, which signing out clears: not
        # with the browser's history of the tab, so whoever signs in next
        # there can't go Back to it.
        ctx = browser.new_context(**MOBILE)
        page = ctx.new_page()
        attach(page, 'privacy-back')
        login(page, APP)
        # (A tab from before 0.20.0 kept it in the browser's record of its
        # pages too: it goes from those the tab comes back to.)
        js(page, "() => history.replaceState({ ...history.state, saved: { within: 'from-before' } }, '', location.hash)")
        page.click('#tabs .tab[data-tab=search]')
        page.wait_for_selector('.search-box input')
        page.go_back()
        page.wait_for_function("() => location.hash === '#/'")
        page.wait_for_timeout(300)
        older = js(page, '() => JSON.stringify(history.state)')
        check('privacy: (what a page from before 0.20.0 kept in the browser\'s record of it goes when the tab comes back to it)',
              'from-before' not in older and '"k"' in older, older)
        page.click('#tabs .tab[data-tab=search]')
        page.wait_for_selector('.search-box input')
        page.fill('.search-box input', 'harbour')
        wait_for(lambda: any('ARTISTS' in t.upper() for t in page.locator('.search-body .section-head h2').all_inner_texts()), 8)
        page.goto(APP + '#/browse/artists')
        page.wait_for_selector('.within input')
        page.fill('.within input', 'glass')
        wait_for(lambda: page.locator('.list-box:not([hidden]) .row-title').all_inner_texts() == ['Glass Harbour'], 8)
        recorded = js(page, '() => JSON.stringify(history.state)')
        in_tab = js(page, "() => sessionStorage.getItem('pw.nav') || ''")
        check('privacy: what\'s typed in a search is kept with the tab\'s own record of its pages, not with the browser\'s history of it',
              'glass' not in recorded and 'glass' in in_tab and 'harbour' in in_tab, f'{recorded} {in_tab[:300]}')
        page.goto(APP + '#/settings/account')
        page.click('.account-card button:has-text("Sign out")')
        page.wait_for_selector('.sheet.open')
        with page.expect_event('load', timeout=15000):
            page.locator('.sheet.open .sheet-action', has_text='Sign out').click()
        page.wait_for_selector('text=Use a server address and token instead')
        tab_after = js(page, '() => JSON.stringify(Object.entries(sessionStorage))')
        # Someone else signs in on the tab, and goes Back through it.
        login(page, APP, token='t2')
        # (Back to the page the tab started on, before the app.)
        trail = []
        for _ in range(8):
            try:
                page.go_back(timeout=5000)
            except Exception:  # noqa: BLE001 - nothing to go back to
                break
            page.wait_for_timeout(900)
            if not page.url.startswith(APP):
                break
            trail.append((js(page, '() => location.hash'), js(page, "() => document.querySelector('.view .search-box input')?.value ?? null"),
                          js(page, '() => JSON.stringify(history.state)')))
        reached = {t[0].split('?')[0] for t in trail}
        check('privacy: ...so after signing out, someone signing in next on the tab finds none of it going Back (nor does the page)',
              'glass' not in tab_after and 'harbour' not in tab_after and {'#/browse/artists', '#/search'} <= reached
              and not any(t[1] for t in trail) and not any('glass' in t[2] or 'harbour' in t[2] for t in trail), f'{tab_after} {trail}')
        ctx.close()

    # ---------- np: the player's sleep timer and converted tracks ----------
    if run('np'):
        ctx = browser.new_context(**MOBILE)
        page = ctx.new_page()
        attach(page, 'np')
        login(page, APP)
        play_first_album_track(page, APP, album=1, track=0)
        page.click('.pb-main')
        page.wait_for_selector('.np.open')
        sleep_btn = page.locator('.np-tool[data-tool=sleep]')
        hidden = sleep_btn.is_hidden()
        settings(page, {'sleepTimer': True})
        page.wait_for_timeout(200)
        shown = sleep_btn.is_visible()
        player(page, 'p.setSleep(30)')
        settings(page, {'sleepTimer': False})
        page.wait_for_timeout(200)
        check('np: the sleep timer is off to begin with, shown once turned on, and turned off with it',
              hidden and shown and sleep_btn.is_hidden() and not player(page, 'p.sleepActive'), f'{hidden} {shown}')
        # Converted by the server (Streaming quality, which applies to the
        # track playing at once): a mark says so, and why. (Converted streams
        # themselves are the stream section's.)
        settings(page, {'quality': '320'})
        page.wait_for_selector('.np.open .np-converted', timeout=10000)
        label = page.locator('.np-converted').get_attribute('aria-label')
        quality = page.locator('.np-quality').inner_text()
        page.click('.np-converted')
        page.wait_for_selector('.toast:has-text("Converted to 320 kbps")')
        told = page.locator('.toast').inner_text()
        shot(page, 'np-01-converted')
        check('np: a converted track is marked, saying why (as its tooltip and when tapped)',
              quality.strip() == '320 kbps' and 'Streaming quality is set to High (320 kbps)' in label and 'The file is FLAC' in label
              and 'Streaming quality' in told and 'Settings' in told, f'{label!r} {quality!r} {told!r}')
        # Back to Original, it plays the file itself; told it's converting
        # anyway (as when the file doesn't play as it is), it says that.
        settings(page, {'quality': 'original'})
        wait_for(lambda: player(page, '!p.deck.isHls && !p.transcoding'), 10, 0.2)
        player(page, "(p.transcoding = true, p.emit('track'), true)")
        page.wait_for_selector('.np.open .np-converted', timeout=10000)
        label = page.locator('.np-converted').get_attribute('aria-label') or ''
        check('np: ...or, converted as the file didn\'t play as it is, says that', 'the file didn’t play as it is here' in label and 'Streaming quality' not in label, label)
        kinds = js(page, """() => Promise.all([import('./js/player.js'), import('./js/state.js')]).then(([{ player: p }, s]) => {
            s.saveSettings({ quality: '320' });
            const out = [p.sourceFor({ id: '1', codec: 'mp3', bitrate: 128, partKey: '/library/parts/1/file.mp3' }).hls,
                         p.sourceFor({ id: '1', codec: 'flac', bitrate: 1411, partKey: '/library/parts/1/file.flac' }).hls];
            s.saveSettings({ quality: 'original' });
            return out; })""")
        check('np: ...and a track already at the quality asked for, or lower, plays as it is', kinds == [False, True], str(kinds))
        player(page, "(p.transcoding = false, p.emit('track'), true)")
        page.wait_for_timeout(300)
        check('np: ...and the original file isn\'t marked', page.locator('.np-converted').count() == 0)
        ctx.close()

    # ---------- stream: tracks the server converts, and streams that fail ----------
    # The mock's converted streams are real HLS (silent MP3 in 4-second
    # parts, played with hls.js as from a real server); /__mock/hls stops
    # them part-way or cuts their ends off, and says what was asked for.
    if run('stream'):
        ctx = browser.new_context(**MOBILE)
        page = ctx.new_page()
        attach(page, 'stream')
        login(page, APP)
        settings(page, {'quality': '320', 'gapless': True, 'fades': 'off', 'reportPlays': True})
        js(page, "() => import('./js/player.js').then(({ player }) => player.addEventListener('playerror', (e) => (window.__playErrors ||= []).push(e.detail.track.title)))")

        def hls(q=''):
            return mock('/__mock/hls' + q)['MediaContainer']

        def play_track(album, track=0, rules='', wait=25):
            """Play an album's track, with new rules for converted streams
            (see /__mock/hls) from here: a stream stopped part-way is that
            track's. (The player is paused first, so nothing it preloads
            meanwhile is started under the new rules.)"""
            player(page, 'p.pause()')
            page.goto(APP + '#/browse/albums')
            page.wait_for_selector('.grid .card')
            page.locator('.grid .card').nth(album).click()
            page.wait_for_selector('.hero-album')
            row = page.locator('.track').nth(track)
            hls(f'?reset=1{rules}&track={row.get_attribute("data-track-id")}')
            row.locator('.track-main').click()
            return wait_for(lambda: player(page, "p.state === 'playing'"), wait, 0.2)

        def now():
            return player(page, "({ id: p.current?.id, title: p.current?.title, t: p.time, state: p.state, hls: !!p.deck.hls,"
                                " playback: p.deck.playback, rescue: p.rescue && { tries: p.rescue.tries, soft: p.rescue.soft, from: p.rescue.from } })")

        def play_errors():
            return js(page, '() => window.__playErrors || []')

        def sessions_of(track_id):
            return [s for s in hls()['sessions'] if s['track'] == track_id]

        # As it should be: through hls.js, each track its own playback (the
        # one preloaded to follow it too), its play reports saying which.
        playing = play_track(0)
        first = now()
        wait_for(lambda: now()['t'] > 3, 10, 0.2)
        h = hls()
        mine = [s for s in h['sessions'] if s['track'] == first['id']]
        others = [s for s in h['sessions'] if s['track'] != first['id']]
        reports = [x for x in h['timelines'] if x['ratingKey'] == first['id']]
        config = player(page, "p.deck.hls && [p.deck.hls.config.maxBufferLength, p.deck.hls.config.fragLoadPolicy.default.errorRetry.maxNumRetry,"
                              " !!p.deck.hls.config.manifestLoadPolicy.default.errorRetry.shouldRetry?.(null, 0, false, { code: 0 })]")
        check('stream: a converted track plays, through hls.js, with the stream settings here',
              playing and first['hls'] and now()['t'] > 3 and config == [30, 5, True], f'{first} {config}')
        check('stream: ...its stream and its play reports carry its own playback; the next track\'s stream, preloaded, another',
              len(mine) == 1 and mine[0]['playback'] == first['playback'] and reports and all(x['playback'] == first['playback'] for x in reports)
              and others and all(s['playback'] and s['playback'] != first['playback'] for s in others), f'{first["playback"]} {h["sessions"]} {reports}')
        policy = js(page, """() => import('./js/player.js').then(({ retryable: r }) => r && [r(401, 0, 3), r(403, 0, 3), r(404, 0, 3), r(404, 1, 3),
            r(0, 2, 3), r(0, 3, 3), r(503, 2, 3), r(undefined, 2, 3), r(429, 2, 3)])""")
        check('stream: a request that fails is tried again (more for no answer or a server error than a client error), never when refused',
              policy == [False, False, True, False, True, False, True, True, True], str(policy))

        # The server stops the stream part-way (as Plex can): it's started
        # again where it got to, as the same playback, and plays on.
        play_track(1, rules='&kill=2&sessions=1')
        tr = now()
        # (Another album in its place: Plex hears that what was playing
        # stopped, as its own playback.)
        stops = [(x['ratingKey'], x['playback']) for x in hls()['timelines'] if x['state'] == 'stopped']
        check('stream: another album played in its place, Plex hears that what was playing stopped (as its own playback)',
              stops == [(first['id'], first['playback'])], f'{first} {stops}')
        wait_for(lambda: now()['t'] > 10 or now()['id'] != tr['id'], 30, 0.25)
        after = now()
        mine = sessions_of(tr['id'])
        stopped = [r for r in hls()['requests'] if mine and r['session'] == mine[0]['id'] and r['status'] == 404]
        check('stream: a stream the server stops part-way starts again where it got to, as the same playback, and plays on',
              after['id'] == tr['id'] and after['t'] > 10 and after['state'] == 'playing' and len(mine) == 2
              and mine[0]['playback'] == mine[1]['playback'] == tr['playback'] and stopped and not play_errors(),
              f'{after} {mine} {len(stopped)} {play_errors()}')

        # ...and when the stream started again stops too, before it's played
        # anything (at its first part), the next one still starts where the
        # track got to (the end of its first part, 4 seconds in), not at the
        # top.
        play_track(1, 1, rules='&kill=1,0')
        tr = now()
        seen = []
        wait_for(lambda: seen.append(now()) or (len(sessions_of(tr['id'])) >= 3 and seen[-1]['t'] > 6) or seen[-1]['id'] != tr['id'], 45, 0.25)
        after = seen[-1]
        mine = sessions_of(tr['id'])
        lowest = min((x['t'] for x in seen if x['id'] == tr['id'] and (x['rescue'] or {}).get('tries')), default=0)
        check('stream: ...and when that one stops too, before it plays, the next still starts where the track got to',
              after['id'] == tr['id'] and after['t'] > 6 and len(mine) == 3 and after['rescue'] and after['rescue']['from'] > 3.5 and lowest > 3.5
              and len({s['playback'] for s in mine}) == 1 and not play_errors(), f'{after} {lowest} {mine} {play_errors()}')

        # A problem decoding the stream (as the browser or hls.js reports it,
        # with the stream's end not yet buffered: its parts come slowly): a
        # new stream at once, from there, and it plays on.
        play_track(1, 2, rules='&slow=2.5')
        tr = now()
        wait_for(lambda: now()['t'] > 1, 10, 0.1)
        player(page, "(p.onStreamError(p.deck, { type: 'mediaError', details: 'bufferAppendError', fatal: true }), true)")
        wait_for(lambda: now()['t'] > 13 or now()['id'] != tr['id'], 30, 0.25)
        after = now()
        mine = sessions_of(tr['id'])
        check('stream: a decoding problem: the stream starts again at once from there, and plays on',
              after['id'] == tr['id'] and after['t'] > 13 and after['state'] == 'playing' and len(mine) == 2
              and mine[0]['playback'] == mine[1]['playback'] and not play_errors(), f'{after} {mine} {play_errors()}')

        # On a slow connection (its parts come slowly here), the next
        # track's stream waits until this one's has loaded to its end, and
        # loads only its first seconds until it plays.
        play_track(3, 1, rules='&slow=1.5')
        tr = now()
        wait_for(lambda: now()['t'] > 17 or now()['id'] != tr['id'], 30, 0.25)
        h = hls()
        cur = [x for x in h['sessions'] if x['track'] == tr['id']]
        nxt = [x for x in h['sessions'] if x['track'] != tr['id']]
        files = [(r['session'], r['file']) for r in h['requests']]
        last_part = max((i for i, (sid, f) in enumerate(files) if cur and sid == cur[0]['id'] and f == '00004.ts'), default=None)
        next_first = min((i for i, (sid, f) in enumerate(files) if nxt and sid == nxt[0]['id']), default=None)
        next_parts = [f for sid, f in files if nxt and sid == nxt[0]['id'] and f.endswith('.ts')]
        check('stream: on a slow connection the next track waits until this one has loaded to its end, then loads only its first seconds',
              now()['id'] == tr['id'] and last_part is not None and next_first is not None and next_first > last_part and 1 <= len(next_parts) <= 3,
              f'{now()} {last_part} {next_first} {next_parts}')

        # Loaded to start near its end, and its stream fails before anything
        # loads (nothing to play on from): the track ends there, and the
        # next one plays.
        play_track(2, 1, rules='&kill=4,4')
        tr = now()
        player(page, '(p.load(p.index, { startAt: 17 }), true)')
        wait_for(lambda: now()['id'] != tr['id'] and now()['state'] == 'playing', 30, 0.25)
        after = now()
        check('stream: a track started near its end whose stream fails before it plays ends there, and the next one plays',
              after['id'] != tr['id'] and after['state'] == 'playing' and len(sessions_of(tr['id'])) == 2 and not play_errors(),
              f'{after} {sessions_of(tr["id"])} {play_errors()}')

        # Dropped connections (no answer at all, as through a proxy that
        # drops them): its playlist and parts are tried again, on the same
        # stream.
        dropped = {'start': 0, 'part': 0}

        def drop_start(route):
            if dropped['start'] < 1:
                dropped['start'] += 1
                return route.abort('connectionreset')
            return route.continue_()

        def drop_part(route):
            if dropped['part'] < 2:
                dropped['part'] += 1
                return route.abort('connectionreset')
            return route.continue_()

        def is_start(url):
            return '/transcode/universal/start.m3u8?' in url

        def is_part(n):
            return lambda url: '/transcode/universal/session/' in url and url.endswith(f'/base/{n:05d}.ts')
        part1 = is_part(1)
        page.route(is_start, drop_start)
        page.route(part1, drop_part)
        # (Nothing preloaded, nor loaded ahead: only this track's requests are dropped.)
        ahead_was = js(page, "() => import('./js/state.js').then(({ app }) => app.settings.loadAhead)")
        settings(page, {'gapless': False, 'loadAhead': 0})
        play_track(2)
        tr = now()
        wait_for(lambda: now()['t'] > 6, 20, 0.25)
        after = now()
        page.unroute(is_start)
        page.unroute(part1)
        check('stream: a dropped connection is tried again, on the same stream (its playlist, and its parts)',
              dropped == {'start': 1, 'part': 2} and after['id'] == tr['id'] and after['t'] > 6 and len(sessions_of(tr['id'])) == 1
              and not after['rescue'] and not play_errors(), f'{dropped} {after} {sessions_of(tr["id"])}')

        # Its connection keeps dropping while plenty is still buffered (its
        # fourth part, 12 seconds in): the same stream again, from where it
        # stopped loading (nothing is heard of it).
        dropped['part'] = 0

        def drop_last(route):
            dropped['part'] += 1
            return route.abort('connectionreset') if dropped['part'] <= 6 else route.continue_()
        part3 = is_part(3)
        page.route(part3, drop_last)
        play_track(3)
        tr = now()
        player(page, 'p.pause()')
        wait_for(lambda: (now()['rescue'] or {}).get('soft') and dropped['part'] >= 7, 20, 0.25)
        soft = now()
        page.unroute(part3)
        player(page, 'p.play()')
        wait_for(lambda: now()['id'] != tr['id'], 30, 0.25)
        settings(page, {'gapless': True, 'loadAhead': ahead_was})
        check('stream: ...and when that keeps happening, with plenty left to play, the same stream carries on from where it stopped loading',
              soft['id'] == tr['id'] and (soft['rescue'] or {}).get('soft') and soft['rescue']['tries'] == 0 and len(sessions_of(tr['id'])) == 1
              and dropped['part'] == 7 and now()['id'] != tr['id'] and not play_errors(), f'{soft} {dropped} {sessions_of(tr["id"])} {play_errors()}')

        # The stream's end is missing (the server stopped it a little short):
        # the track ends where its sound does, and the next one plays.
        play_track(0, 1, rules='&short=3')
        tr = now()
        player(page, 'p.seek(11)')
        samples = []
        end = time.time() + 25
        while time.time() < end:
            samples.append(now())
            if samples[-1]['id'] != tr['id'] and samples[-1]['state'] == 'playing':
                break
            time.sleep(0.25)
        last = max((x['t'] for x in samples if x['id'] == tr['id']), default=0)
        check('stream: a stream whose last seconds are missing ends where its sound does, and the next track plays',
              15 <= last <= 16.5 and samples[-1]['id'] != tr['id'] and samples[-1]['state'] == 'playing' and not play_errors(),
              f'{last} {samples[-1]} {play_errors()}')

        # Streaming quality changed while a converted track plays: it carries
        # on from where it was, as the file itself, and so does the next one.
        play_track(4, 1)
        tr = now()
        wait_for(lambda: now()['t'] > 2, 10, 0.2)
        settings(page, {'quality': 'original'})
        state = lambda: player(page, "({ id: p.current?.id, t: p.time, isHls: p.deck.isHls, transcoding: p.transcoding, state: p.state,"
                                     " spare: p.spare.qid != null ? p.spare.isHls : null })")
        seen = []
        wait_for(lambda: seen.append(state()) or (not seen[-1]['isHls'] and seen[-1]['state'] == 'playing' and seen[-1]['t'] > 3), 15, 0.2)
        after = seen[-1]
        check('stream: back to Original while a converted track plays, it carries on from where it was, as the file itself (and so does the next)',
              after['id'] == tr['id'] and not after['isHls'] and not after['transcoding'] and after['state'] == 'playing'
              and min(x['t'] for x in seen) > 1.5 and after['spare'] in (None, False), f'{after} {min(x["t"] for x in seen)}')
        settings(page, {'quality': '320'})

        # ...and from one converted quality to another (Data saver, say):
        # the new bitrate, from where it was, and the next track's too.
        rate = lambda: player(page, "({ id: p.current?.id, t: p.time, kbps: p.deck.kbps, forced: p.deck.forced, isHls: p.deck.isHls,"
                                    " state: p.state, spare: p.spare.qid != null ? p.spare.kbps : null })")
        play_track(4, 2)
        tr = now()
        wait_for(lambda: now()['t'] > 2 and player(page, 'p.spare.qid != null'), 10, 0.2)
        settings(page, {'quality': '128'})
        seen = []
        wait_for(lambda: seen.append(rate()) or (seen[-1]['kbps'] == 128 and seen[-1]['state'] == 'playing' and seen[-1]['t'] > 3
                                                 and seen[-1]['spare'] == 128), 15, 0.2)
        after = seen[-1]
        mine = sessions_of(tr['id'])
        nxt = [s for s in hls()['sessions'] if s['track'] != tr['id']]
        check('stream: ...and from one converted quality to another, the new bitrate, from where it was (and the next track\'s too)',
              after['id'] == tr['id'] and after['kbps'] == 128 and [s['bitrate'] for s in mine] == ['320', '128']
              and min(x['t'] for x in seen) > 1.5 and [s['bitrate'] for s in nxt] == ['320', '128'], f'{after} {min(x["t"] for x in seen)} {mine} {nxt}')

        # Paused, a change waits until it's played again (nothing loads
        # meanwhile, or says it's playing): then the new way, from where it
        # was, as the same playback.
        player(page, 'p.pause()')
        wait_for(lambda: player(page, "p.state === 'paused'"), 5, 0.1)
        held = player(page, 'p.time')
        old = player(page, 'p.deck.playback')
        started = len(hls()['sessions'])
        settings(page, {'quality': '320'})
        page.wait_for_timeout(1000)
        paused = player(page, "({ t: p.time, src: p.deck.hasSource(), state: p.state, playing: p.isPlaying, transcoding: p.transcoding })")
        quiet = len(hls()['sessions']) == started
        ended = [x for x in hls()['timelines'] if x['playback'] == old and x['state'] == 'stopped']
        player(page, 'p.play()')
        wait_for(lambda: rate()['kbps'] == 320 and rate()['state'] == 'playing', 10, 0.2)
        resumed = rate()
        same = player(page, 'p.deck.playback') == old
        mine = sessions_of(tr['id'])
        check('stream: paused, a change of quality waits until it plays again (nothing loads or says it plays meanwhile), then applies from where it was',
              not paused['src'] and paused['state'] == 'paused' and not paused['playing'] and paused['transcoding'] and abs(paused['t'] - held) < 0.3
              and quiet and not ended and resumed['id'] == tr['id'] and resumed['t'] >= held - 0.5 and same
              and [s['bitrate'] for s in mine] == ['320', '128', '320'] and mine[-1]['playback'] == old, f'{held} {paused} {quiet} {ended} {resumed} {same} {mine}')

        # ...and left for another track while it waits so, its playback ends
        # there, as a paused track's does.
        player(page, 'p.pause()')
        wait_for(lambda: player(page, "p.state === 'paused'"), 5, 0.1)
        old = player(page, 'p.deck.playback')
        settings(page, {'quality': '128'})
        wait_for(lambda: player(page, '!p.deck.hasSource()'), 5, 0.1)
        player(page, 'p.next()')
        wait_for(lambda: now()['id'] != tr['id'] and now()['state'] == 'playing', 10, 0.2)
        ended = [x for x in hls()['timelines'] if x['playback'] == old and x['state'] == 'stopped']
        check('stream: ...and left for another track while it waits so, its playback ends there', len(ended) == 1 and now()['id'] != tr['id'], f'{ended} {now()}')
        settings(page, {'quality': '320'})

        # A file whose connection drops, and drops again once loaded again,
        # is converted (at 320 kbps, as for Original) only until Streaming
        # quality changes.
        settings(page, {'quality': 'original'})
        play_track(4, 3)
        tr = now()
        wait_for(lambda: now()['t'] > 1, 10, 0.2)
        player(page, "(Object.defineProperty(p.audio, 'error', { configurable: true, get: () => ({ code: MediaError.MEDIA_ERR_NETWORK }) }), p.onError(), true)")
        wait_for(lambda: player(page, "p.directRetry === p.current?.qid && p.state === 'playing' && p.deck.hasSource() && !p.deck.isHls"), 10, 0.2)
        again = rate()
        player(page, '(p.onError(), true)')
        wait_for(lambda: rate()['isHls'] and rate()['state'] == 'playing', 10, 0.2)
        fell = rate()
        player(page, '(p.decks.forEach((d) => delete d.el.error), true)')
        settings(page, {'quality': '128'})
        wait_for(lambda: rate()['kbps'] == 128 and rate()['state'] == 'playing', 10, 0.2)
        lower = rate()
        settings(page, {'quality': 'original'})
        wait_for(lambda: not rate()['isHls'] and rate()['state'] == 'playing', 10, 0.2)
        back = rate()
        check('stream: a file whose connection keeps dropping is converted, until Streaming quality changes',
              not again['isHls'] and fell['isHls'] and fell['forced'] == 'network' and fell['kbps'] == 320 and lower['kbps'] == 128
              and lower['forced'] is False and not back['isHls'] and back['id'] == tr['id'] and not play_errors(), f'{again} {fell} {lower} {back}')

        # ...whereas one that doesn't play as it is here stays converted, at
        # the bitrate asked for (paused when it's changed, too).
        play_track(4, 4)
        wait_for(lambda: now()['t'] > 1, 10, 0.2)
        player(page, '(p.load(p.index, { startAt: p.time, transcode: true, reportPrev: false, resume: true }), true)')
        wait_for(lambda: rate()['isHls'] and rate()['state'] == 'playing', 10, 0.2)
        settings(page, {'quality': '128'})
        wait_for(lambda: rate()['kbps'] == 128 and rate()['state'] == 'playing', 10, 0.2)
        lower = rate()
        player(page, 'p.pause()')
        wait_for(lambda: player(page, "p.state === 'paused'"), 5, 0.1)
        settings(page, {'quality': 'original'})
        player(page, 'p.play()')
        wait_for(lambda: rate()['kbps'] == 320 and rate()['state'] == 'playing', 10, 0.2)
        back = rate()
        check('stream: ...and one that doesn\'t play as it is stays converted, at the bitrate asked for (paused when it\'s changed, too)',
              lower['forced'] is True and lower['kbps'] == 128 and back['forced'] is True and back['kbps'] == 320 and back['isHls'] and not play_errors(),
              f'{lower} {back} {play_errors()}')
        settings(page, {'quality': '320'})

        # Smart crossfade into a converted track whose music starts part-way
        # in: it's preloaded from the top to some way past there, and fades
        # in from there.
        settings(page, {'fades': 'smart'})
        listed = mock('/__mock/tracks')['MediaContainer']['Metadata']
        x = listed[10]
        y = next(t for t in listed if t['album'] != x['album'])

        def smart_pair():
            player(page, 'p.pause()')
            hls('?reset=1')
            js(page, "() => Promise.all([import('./js/state.js'), import('./js/plex.js'), import('./js/player.js')]).then(async ([{ app }, { normTrack }, { player: p }]) => {"
                     f" const list = await Promise.all({json.dumps([x['ratingKey'], y['ratingKey']])}.map(async (id) => normTrack(await app.server.metadata(id))));"
                     " p.spans.set(list[0].id, { start: 0, end: list[0].duration / 1000, quietFrom: {} });"
                     " p.spans.set(list[1].id, { start: 9, end: list[1].duration / 1000, quietFrom: {} });"
                     " p.playTracks(list, 0, { context: { title: 'Smart', href: null } }); })")
            return wait_for(lambda: player(page, "p.state === 'playing' && p.spare.qid != null && p.spare.el.readyState >= 1"), 15, 0.2)
        smart_pair()
        # (Loaded ahead, it's all in memory, and hls.js takes it all at once.)
        pre = player(page, "({ ahead: p.spare.hls?.config.maxBufferLength, at: p.spare.el.currentTime, plan: p.nextPlan()?.startAt, memory: !!p.spare.prefetched })")
        h = hls()
        nxt = [s for s in h['sessions'] if s['track'] == y['ratingKey']]
        parts = [r['file'] for r in h['requests'] if nxt and r['session'] == nxt[0]['id'] and r['file'].endswith('.ts')]
        player(page, 'p.seek(13)')
        wait_for(lambda: player(page, f"p.current?.id === '{y['ratingKey']}' && p.state === 'playing'"), 15, 0.2)
        took = player(page, 'p.time')
        check('stream: with smart crossfade, a converted next track is preloaded to past where its music starts, and fades in from there',
              pre['ahead'] == (30 if pre['memory'] else 19) and pre['at'] < 0.5 and pre['plan'] == 9 and parts and parts[0] == '00000.ts' and 9 <= took <= 16 and not play_errors(),
              f'{pre} {parts} {took} {play_errors()}')

        # ...whereas Next starts it from the top (even after a fade called
        # off, which leaves it waiting where the fade would have started it).
        smart_pair()
        player(page, 'p.seek(14.5)')
        wait_for(lambda: player(page, "p.transition?.plan.kind === 'fade'"), 8, 0.1)
        player(page, 'p.seek(5)')
        waiting = player(page, 'p.spare.el.currentTime')
        player(page, 'p.next()')
        wait_for(lambda: player(page, f"p.current?.id === '{y['ratingKey']}' && p.state === 'playing'"), 10, 0.1)
        top = player(page, 'p.time')
        check('stream: ...whereas Next starts it from the top (after a fade called off too)', 8.5 <= waiting <= 9.5 and top < 1.5, f'{waiting} {top}')
        settings(page, {'fades': 'off'})

        # Loading ahead (Settings › Playback): the next tracks' streams are
        # loaded in full, into memory, once this one's has loaded, and the
        # next plays from memory, even with the connection to the server
        # gone. What's played is let go.
        # (Gapless off to start with: the tracks here are short enough for the
        # next one's own preload to be due at once.)
        # (Played tracks aren't kept here: see Keep played tracks, below.)
        settings(page, {'loadAhead': 2, 'gapless': False, 'keepPlayed': 0})
        play_track(5, 0)
        tr = now()
        ahead = lambda: player(page, 'p.ahead.summary()')
        loaded = wait_for(lambda: len([e for e in ahead() if e['state'] == 'done']) == 2, 30, 0.3)
        got = ahead()
        h = hls()
        parts = {s['track']: sorted({r['file'] for r in h['requests'] if r['session'] == s['id'] and r['file'].endswith('.ts')}) for s in h['sessions']}
        # (The next two in the queue, in its order: what's loaded ahead is
        # listed in the order it was loaded.)
        nexts = player(page, 'p.queue.slice(p.index + 1, p.index + 3).map((t) => t.id)')
        check('stream: loading ahead, the next tracks\' streams are loaded in full, into memory, after this one\'s',
              loaded and len(got) == 2 and sorted(e['id'] for e in got) == sorted(nexts) and all(e['hls'] and e['bytes'] > 0 for e in got)
              and all(len(parts.get(i, [])) == 5 for i in nexts) and tr['id'] not in nexts and now()['id'] == tr['id'],
              f'{got} {nexts} {parts}')
        # The next track's preload, for a gapless change, takes it from memory.
        settings(page, {'gapless': True})
        spare = wait_for(lambda: player(page, 'p.spare.prefetched ? p.spare.prefetched.track.id : null') == nexts[0], 10, 0.25)
        check('stream: ...and the next one, preloaded for a gapless change, comes from memory', spare, str(player(page, '({ qid: p.spare.qid, pre: !!p.spare.prefetched })')))
        # The same server at another address (the connection changed: on the
        # move, or at work) keeps what's loaded.
        js(page, "() => import('./js/state.js').then((m) => m.setSource({ ...m.app.source }))")
        page.wait_for_timeout(400)
        kept = ahead()
        check('stream: ...and kept when the connection to the same server changes', sorted(e['id'] for e in kept if e['state'] == 'done') == sorted(nexts), str(kept))
        # A track still loading ahead is waited for only if it'll be there in
        # time (going as it has), after a moment to get going.
        # (How fast it's gone not counting time waiting for the connection;
        # just started, on time if it can go on now.)
        timing = player(page, """(() => { const t = performance.now(); const e = (o) => ({ waited: 0, waitingSince: 0, rested: 0, restingSince: 0, ...o }); const out = [
            p.ahead.onTime(e({ started: t - 10000, bytes: 1e6, expected: 2e6 }), 15),
            p.ahead.onTime(e({ started: t - 10000, bytes: 1e4, expected: 2e6 }), 15),
            p.ahead.onTime(e({ started: t - 20000, waited: 15000, bytes: 1e6, expected: 2.5e6 }), 15)];
            p.roomToFetch = () => true; out.push(p.ahead.onTime(e({ started: t - 1000, bytes: 0, expected: 2e6 }), 15));
            p.roomToFetch = () => false; out.push(p.ahead.onTime(e({ started: t - 1000, bytes: 0, expected: 2e6 }), 15));
            delete p.roomToFetch; return out; })()""")
        check('stream: ...a track still loading ahead is waited for only if it\'ll be there in time', timing == [True, False, True, True, False], str(timing))
        # Its rests count while it's held back (they go on: a slow connection's
        # 30-second rests aren't "just started"), and not once it isn't.
        rested = player(page, """(() => { const t = performance.now(); const e = (o) => ({ waited: 0, waitingSince: 0, rested: 0, restingSince: 0, ...o }); const out = [];
            p.roomToFetch = () => true; p.aheadUnlimited = () => false;
            out.push(p.ahead.onTime(e({ started: t - 150000, rested: 147500, bytes: 655360, expected: 22e6 }), 15));
            out.push(p.ahead.onTime(e({ started: t - 60000, rested: 50000, bytes: 5e6, expected: 6e6 }), 10));
            out.push(p.ahead.onTime(e({ started: t - 60000, rested: 40000, restingSince: t - 10000, bytes: 5e6, expected: 6e6 }), 10));
            p.aheadUnlimited = () => true;
            out.push(p.ahead.onTime(e({ started: t - 60000, rested: 50000, bytes: 5e6, expected: 6e6 }), 10));
            out.push(p.ahead.onTime(e({ started: t - 60000, rested: 40000, restingSince: t - 10000, bytes: 5e6, expected: 6e6 }), 10));
            delete p.roomToFetch; delete p.aheadUnlimited; return out; })()""")
        check('stream: ...counting its rests while it\'s held back, and not once it isn\'t', rested == [False, False, False, True, True], str(rested))
        # The next track's own stream, as it was loaded: its playback, and the
        # session its parts are under. Only its requests count as played from
        # the network (once it's on, the one after it starts loading ahead,
        # and that's cut too).
        own = player(page, f"(() => {{ const e = [...p.ahead.entries.values()].find((e) => e.track.id === {json.dumps(nexts[0])});"
                           " return e && { playback: e.playback, urls: [...(e.data ? e.data.keys() : [])] }; })()") or {'playback': '?', 'urls': []}
        sids = {u.split('/session/')[1].split('/')[0] for u in own['urls'] if '/session/' in u}
        cut = {'urls': []}

        def no_server(route):
            cut['urls'].append(route.request.url)
            return route.abort('connectionreset')

        def its(url):
            return own['playback'] in url or url in own['urls'] or any(f'/session/{s}/' in url for s in sids)

        def converted(url):
            return '/transcode/universal/' in url
        page.route(converted, no_server)
        player(page, 'p.next()')
        seen = []

        def on_air_now():
            n = now()
            n['memory'] = player(page, 'p.deck.prefetched ? p.deck.prefetched.track.id : null')
            if not seen or (seen[-1]['id'], seen[-1]['state']) != (n['id'], n['state']):
                seen.append({k: n[k] for k in ('id', 'state', 't', 'memory')})
            return n
        played = wait_for(lambda: (lambda n: n['id'] == nexts[0] and n['state'] == 'playing' and n['t'] > 3)(on_air_now()), 15, 0.25)
        on_air = on_air_now()
        page.unroute(converted, no_server)
        theirs = [u.split('?')[0].rsplit('/', 1)[-1] for u in cut['urls'] if its(u)]
        player(page, 'p.next()')
        wait_for(lambda: now()['id'] == nexts[1] and now()['state'] == 'playing', 15, 0.25)
        gone = wait_for(lambda: nexts[0] not in [e['id'] for e in ahead()], 10, 0.3)
        check('stream: ...the next plays from memory, with the server out of reach, and what\'s played is let go',
              played and own['urls'] and on_air['memory'] == nexts[0] and not theirs and on_air['hls'] and gone and not play_errors(),
              f'{played} {on_air} {seen} {theirs} {len(cut["urls"])} {ahead()} {play_errors()}')

        # A file played as it is, loaded ahead too: a part at a time, waiting
        # part-way while the track playing needs the connection (here, told
        # it does once a part is in), and carrying on once it doesn't.
        # (Gapless off: with the connection taken, the next track's own
        # preload, due at once on tracks this short, would stream it instead.)
        # (Held back, as while the track playing is still loading: parts of
        # 128 KB.)
        settings(page, {'quality': 'original', 'loadAhead': 1, 'gapless': False, 'keepPlayed': 0})
        part = 128 * 1024
        player(page, f"(p.aheadUnlimited = () => false, p.roomToFetch = () => !p.ahead.busy || p.ahead.busy.bytes < {part}, true)")
        play_track(5, 2)
        tr = now()
        held_at = wait_for(lambda: [(e['state'], e['bytes']) for e in ahead()] == [('loading', part)], 20, 0.3)
        page.wait_for_timeout(2000)
        still = ahead()
        player(page, '(delete p.roomToFetch, true)')
        # Held back, it rests after each part (here, as if the connection were
        # too slow to share: the longest rest), until the track playing has
        # all it needs, when it goes on at once, as fast as it can.
        player(page, '(p.playingBitrate = () => 1e9, true)')
        page.wait_for_timeout(2500)
        resting = ahead()
        player(page, '(delete p.aheadUnlimited, delete p.playingBitrate, true)')
        loaded = wait_for(lambda: [e['state'] for e in ahead()] == ['done'], 8, 0.3)
        got = ahead()
        check('stream: loading a file ahead waits part-way while the track playing needs the connection, and carries on after',
              held_at and [(e['state'], e['bytes']) for e in still] == [('loading', part)] and loaded and got[0]['bytes'] > part, f'{still} {got}')
        check('stream: ...held back while the track playing is loading, resting after each part, and at full speed once it has it all',
              len(resting) == 1 and resting[0]['state'] == 'loading' and resting[0]['bytes'] <= 2 * part and loaded, f'{resting} {got}')
        # How long a rest is: half the connection at most, leaving the track
        # playing twice its bitrate at least (and a connection too slow for
        # that tried again after half a minute).
        rests = js(page, "() => import('./js/prefetch.js').then(({ restAfter }) => [restAfter(131072, 100, 320), restAfter(131072, 100, 4000), restAfter(131072, 1000, 1411)])")
        check('stream: ...a rest halves what loading ahead takes, and leaves the track playing twice its bitrate', abs(rests[0] - 100) < 1 and 100 < rests[1] < 30000
              and rests[2] == 30000, str(rests))
        settings(page, {'gapless': True})
        page.route('**/library/parts/**', no_server)
        player(page, 'p.next()')
        played = wait_for(lambda: now()['id'] == got[0]['id'] and now()['state'] == 'playing' and now()['t'] > 2, 15, 0.25)
        blob = player(page, "p.audio.getAttribute('src') || ''").startswith('blob:')
        page.unroute('**/library/parts/**')
        check('stream: ...a file played as it is too (it plays from memory, with the server out of reach)',
              loaded and not got[0]['hls'] and got[0]['bytes'] > 100000 and played and blob and not play_errors(), f'{got} {now()} {blob}')
        # ...and with Next before the next track's own preload (here there's
        # none: gapless off), it still plays from memory, as it is: never
        # converted instead.
        settings(page, {'gapless': False})
        after_next = player(page, 'p.queue[p.index + 1]?.id')
        ready_next = wait_for(lambda: any(e['id'] == after_next and e['state'] == 'done' for e in ahead()), 15, 0.3)
        page.route('**/library/parts/**', no_server)
        player(page, 'p.next()')
        played_next = wait_for(lambda: now()['id'] == after_next and now()['state'] == 'playing' and now()['t'] > 1, 15, 0.25)
        how = player(page, "({ src: (p.audio.getAttribute('src') || '').slice(0, 5), isHls: p.deck.isHls, transcoding: p.transcoding })")
        page.unroute('**/library/parts/**')
        check('stream: ...and with Next before the next track\'s own preload, still from memory, as it is (never converted instead)',
              ready_next and played_next and how == {'src': 'blob:', 'isHls': False, 'transcoding': False} and not play_errors(), f'{ready_next} {now()} {how} {ahead()}')
        settings(page, {'quality': '320', 'loadAhead': 0})
        page.wait_for_timeout(500)
        check('stream: ...and none is kept once it\'s turned off', wait_for(lambda: ahead() == [] or all(e['id'] == now()['id'] for e in ahead()), 8, 0.3), str(ahead()))

        # Keep played tracks (Settings › Playback): the last ones played stay
        # in memory, so going back to one plays it at once, with the server
        # out of reach, as another playback. A converted stream is kept as it
        # came in (no second stream of it)...
        settings(page, {'quality': '320', 'loadAhead': 0, 'keepPlayed': 1, 'gapless': True})
        play_track(7, 0)
        tr = now()
        recorded = wait_for(lambda: any(e['id'] == tr['id'] and e['state'] == 'done' and e['hls'] for e in ahead()), 20, 0.3)
        player(page, 'p.seek(p.duration - 2)')
        moved = wait_for(lambda: now()['id'] != tr['id'] and now()['state'] == 'playing', 15, 0.25)
        cut['urls'] = []
        page.route(converted, no_server)
        player(page, 'p.prev()')
        back = wait_for(lambda: now()['id'] == tr['id'] and now()['state'] == 'playing' and now()['t'] > 1, 15, 0.25)
        again = player(page, '({ memory: !!p.deck.prefetched, playback: p.deck.playback })')
        page.unroute(converted, no_server)
        reports = {x['playback'] for x in hls()['timelines'] if x['ratingKey'] == tr['id']}
        # (Its stream's addresses have the track's id in its session's.)
        asked = [u for u in cut['urls'] if f'-{tr["id"]}-' in u]
        check('stream: a converted track played, kept as it came in, plays again from memory when gone back to (as another playback)',
              recorded and moved and back and again['memory'] and again['playback'] != tr['playback'] and again['playback'] in reports
              and len(sessions_of(tr['id'])) == 1 and not asked and not play_errors(), f'{recorded} {moved} {back} {again} {tr} {reports} {asked[:3]} {ahead()}')
        # ...and the one gone back from is kept too, once it's all come in:
        # forward again, from memory. (Gone back to by choosing it in the
        # queue, as Previous does in a track's first seconds.)
        gone_from = player(page, 'p.queue[p.index + 1]?.id')
        player(page, 'p.next()')
        wait_for(lambda: now()['id'] == gone_from and now()['state'] == 'playing', 15, 0.25)
        wait_for(lambda: any(e['id'] == gone_from and e['state'] == 'done' for e in ahead()), 15, 0.3)
        player(page, 'p.load(p.index - 1)')
        wait_for(lambda: now()['id'] == tr['id'] and now()['state'] == 'playing', 15, 0.25)
        page.route(converted, no_server)
        player(page, 'p.next()')
        forward = wait_for(lambda: now()['id'] == gone_from and now()['state'] == 'playing' and now()['t'] > 1, 15, 0.25)
        fwd = player(page, '!!p.deck.prefetched')
        page.unroute(converted, no_server)
        check('stream: ...and so is the one gone back from (forward again, from memory)', forward and fwd and not play_errors(), f'{forward} {fwd} {now()} {ahead()}')
        # A file is read again into memory, once the tracks ahead are in
        # (with Load ahead on).
        settings(page, {'quality': 'original', 'loadAhead': 1})
        play_track(7, 2)
        tr = now()
        read = wait_for(lambda: any(e['id'] == tr['id'] and e['state'] == 'done' and not e['hls'] for e in ahead()), 20, 0.3)
        player(page, 'p.seek(p.duration - 2)')
        moved = wait_for(lambda: now()['id'] != tr['id'] and now()['state'] == 'playing', 15, 0.25)
        page.route('**/library/parts/**', no_server)
        player(page, 'p.prev()')
        back = wait_for(lambda: now()['id'] == tr['id'] and now()['state'] == 'playing' and now()['t'] > 1, 15, 0.25)
        src = player(page, "(p.audio.getAttribute('src') || '').slice(0, 5)")
        page.unroute('**/library/parts/**')
        check('stream: ...and a file, read again into memory as it played, from memory too', read and moved and back and src == 'blob:' and not play_errors(),
              f'{read} {moved} {back} {src} {ahead()}')
        # Kept tracks make room for the tracks ahead, the furthest back
        # first; one to keep only takes what's free.
        settings(page, {'keepPlayed': 3})
        for _ in range(3):
            cur = now()['id']
            wait_for(lambda: any(e['id'] == cur and e['state'] == 'done' for e in ahead()), 20, 0.3)
            player(page, 'p.seek(p.duration - 2)')
            wait_for(lambda: now()['id'] != cur and now()['state'] == 'playing', 15, 0.25)
        cur = now()['id']
        wait_for(lambda: any(e['id'] == cur and e['state'] == 'done' for e in ahead()), 20, 0.3)
        room = js(page, """() => Promise.all([import('./js/player.js'), import('./js/prefetch.js')]).then(([{ player: p }, { LOAD_AHEAD_BYTES: most }]) => {
            const a = p.ahead;
            const kept = a.keptTracks().map((t) => t.id);
            const es = a.keptTracks().map((t) => a.entries.get(t.qid)).filter(Boolean);
            // (What else there is, a track ahead loading, say, counts for nothing here.)
            const others = [...a.entries.values()].filter((e) => !es.includes(e));
            const real = new Map([...es, ...others].map((e) => [e, e.bytes]));
            es.forEach((e) => (e.bytes = most / 3));
            others.forEach((e) => (e.bytes = 0));
            const keeping = a.makeRoom(most / 3, { keeping: true });
            const left0 = a.summary().map((x) => x.id).filter((id) => kept.includes(id));
            const ahead = a.makeRoom(most / 3);
            const left = a.summary().map((x) => x.id).filter((id) => kept.includes(id));
            for (const [e, b] of real) if (a.entries.get(e.qid) === e) e.bytes = b;
            return { kept, keeping, left0, ahead, left }; })""")
        check('stream: kept tracks make room for the tracks ahead, the furthest back first (a track to keep only takes what\'s free)',
              len(room['kept']) == 4 and room['keeping'] is False and sorted(room['left0']) == sorted(room['kept'])
              and room['ahead'] is True and sorted(room['left']) == sorted(room['kept'][:2]), str(room))
        # A file that was loading ahead, played (Next) before it was all in:
        # what's in is kept, and the rest comes once the next track ahead is
        # in (it gives way to it, as a file read again to keep would: it's
        # played, so it'd only be kept).
        settings(page, {'keepPlayed': 1, 'loadAhead': 1, 'gapless': False})
        player(page, f"(p.aheadUnlimited = () => false, p.roomToFetch = () => !p.ahead.busy || p.ahead.busy.bytes < {part}, true)")
        play_track(7, 0)
        nxt = player(page, 'p.queue[p.index + 1].id')
        partway = wait_for(lambda: any(e['id'] == nxt and e['state'] == 'loading' and e['bytes'] == part for e in ahead()), 20, 0.3)
        player(page, 'p.next()')
        wait_for(lambda: now()['id'] == nxt and now()['state'] == 'playing', 15, 0.25)
        after = player(page, 'p.queue[p.index + 1].id')
        moved_on = wait_for(lambda: any(e['id'] == after for e in ahead()), 15, 0.3)
        left = ahead()
        player(page, '(delete p.roomToFetch, delete p.aheadUnlimited, true)')
        check('stream: a file loading ahead and played before it was all in gives way to the next track ahead, which loads',
              partway and moved_on and [e for e in left if e['id'] == nxt] == [{'id': nxt, 'state': 'paused', 'bytes': part, 'hls': False, 'used': True, 'keep': True}],
              f'{partway} {moved_on} {left}')
        finished = wait_for(lambda: any(e['id'] == nxt and e['state'] == 'done' and e['bytes'] > part for e in ahead())
                            and any(e['id'] == after and e['state'] == 'done' for e in ahead()), 40, 0.3)
        check('stream: ...and what was in is kept: the rest comes after it, and it\'s kept once played', finished, str(ahead()))
        # A file being read again to keep gives way to a track ahead that's
        # due (here, with Next during it): set aside part-read, while the
        # track ahead loads, then it goes on from where it got to, and plays
        # from memory once gone back to. (Held back, it's read 128 KB at a
        # time: held here after its first part. Rests as short as can be:
        # the track playing needing nothing.)
        settings(page, {'quality': 'original', 'loadAhead': 1, 'keepPlayed': 1, 'gapless': False})
        player(page, "(p.aheadUnlimited = () => false, p.playingBitrate = () => 0, p.roomToFetch = () => !(p.ahead.busy?.keep && p.ahead.busy.bytes > 0), true)")
        play_track(7, 0)
        tr = now()
        nxt = player(page, 'p.queue[p.index + 1].id')
        rereading = wait_for(lambda: any(e['id'] == nxt and e['state'] == 'done' for e in ahead())
                             and any(e['id'] == tr['id'] and e['keep'] and e['state'] == 'loading' and e['bytes'] == part for e in ahead()), 25, 0.3)
        # (What there was as each load started.)
        player(page, "(p.ahead.loads = [], p.ahead.load = function (t, o) { this.loads.push({ id: t.id, keeping: !!o?.keeping, was: this.summary() });"
                     " return Object.getPrototypeOf(this).load.call(this, t, o); }, true)")
        player(page, 'p.next()')
        wait_for(lambda: now()['id'] == nxt and now()['state'] == 'playing', 15, 0.25)
        after = player(page, 'p.queue[p.index + 1].id')
        ahead_in = wait_for(lambda: any(e['id'] == after and e['state'] == 'done' for e in ahead()), 20, 0.3)
        loads = player(page, 'p.ahead.loads')
        first = next((x for x in loads if x['id'] == after), None)
        aside = first and next((e for e in first['was'] if e['id'] == tr['id']), None)
        part_key = player(page, f"p.queue.find((t) => t.id === '{tr['id']}').partKey")
        ranges = []
        def on_request(r):
            if r.resource_type == 'fetch' and part_key in r.url:
                ranges.append(r.headers.get('range'))
        page.on('request', on_request)
        player(page, '(delete p.roomToFetch, delete p.aheadUnlimited, delete p.playingBitrate, true)')
        finished = wait_for(lambda: any(e['id'] == tr['id'] and e['state'] == 'done' and e['bytes'] > part for e in ahead()), 20, 0.3)
        page.remove_listener('request', on_request)
        loads = player(page, '(() => { const l = p.ahead.loads; delete p.ahead.load; delete p.ahead.loads; return l; })()')
        page.route('**/library/parts/**', no_server)
        player(page, 'p.load(p.index - 1)')
        back = wait_for(lambda: now()['id'] == tr['id'] and now()['state'] == 'playing' and now()['t'] > 1, 15, 0.25)
        src = player(page, "(p.audio.getAttribute('src') || '').slice(0, 5)")
        page.unroute('**/library/parts/**')
        check('stream: a file read again to keep gives way to a track ahead that\'s due: set aside part-read, it goes on from there after',
              rereading and ahead_in and aside == {'id': tr['id'], 'state': 'paused', 'bytes': part, 'hls': False, 'used': True, 'keep': True}
              and finished and ranges[:1] and (ranges[0] or '').startswith(f'bytes={part}-'), f'{rereading} {ahead_in} {aside} {finished} {ranges} {loads} {ahead()}')
        check('stream: ...and the track gone back to plays from memory', back and src == 'blob:' and not play_errors(), f'{back} {src} {now()} {ahead()}')
        # ...and from a server that won't send parts (here, files are sent
        # whole to what the app asks for itself): it gives way too, but
        # can't go on part-way, so what was in goes, and it's read from the
        # top once the track ahead is in.
        def whole(route):
            if route.request.resource_type != 'fetch':
                return route.continue_()
            res = route.fetch(headers={k: v for k, v in route.request.headers.items() if k.lower() != 'range'})
            route.fulfill(status=200, body=res.body(),
                          headers={k: v for k, v in res.headers.items() if k.lower() not in ('content-range', 'accept-ranges', 'content-length')})
        page.route('**/library/parts/**', whole)
        player(page, "(p.playingBitrate = () => 0, p.roomToFetch = () => !(p.ahead.busy?.keep && p.ahead.busy.bytes > 0), true)")
        play_track(7, 0)
        tr = now()
        nxt = player(page, 'p.queue[p.index + 1].id')
        rereading = wait_for(lambda: any(e['id'] == nxt and e['state'] == 'done' for e in ahead())
                             and any(e['id'] == tr['id'] and e['keep'] and e['state'] == 'loading' and e['bytes'] > 0 for e in ahead()), 25, 0.3)
        player(page, "(p.ahead.loads = [], p.ahead.load = function (t, o) { this.loads.push({ id: t.id, keeping: !!o?.keeping, was: this.summary() });"
                     " return Object.getPrototypeOf(this).load.call(this, t, o); }, true)")
        player(page, 'p.next()')
        wait_for(lambda: now()['id'] == nxt and now()['state'] == 'playing', 15, 0.25)
        after = player(page, 'p.queue[p.index + 1].id')
        ahead_in = wait_for(lambda: any(e['id'] == after and e['state'] == 'done' for e in ahead()), 20, 0.3)
        player(page, '(delete p.roomToFetch, delete p.playingBitrate, true)')
        finished = wait_for(lambda: any(e['id'] == tr['id'] and e['state'] == 'done' and e['bytes'] > part for e in ahead()), 20, 0.3)
        loads = player(page, '(() => { const l = p.ahead.loads; delete p.ahead.load; delete p.ahead.loads; return l; })()')
        page.unroute('**/library/parts/**', whole)
        first = next((x for x in loads if x['id'] == after), None)
        aside = first and next((e for e in first['was'] if e['id'] == tr['id']), None)
        check('stream: ...and from a server that sends files whole, it gives way too, read from the top after',
              rereading and ahead_in and aside == {'id': tr['id'], 'state': 'paused', 'bytes': 0, 'hls': False, 'used': True, 'keep': True} and finished and not play_errors(),
              f'{rereading} {ahead_in} {aside} {finished} {loads} {ahead()}')
        # A converted track coming in replaces what didn't finish for it (a
        # load ahead that failed, say), so it's kept as it comes.
        settings(page, {'quality': '320'})
        replaced = player(page, """(() => { const a = p.ahead; const t = p.queue[p.index + 1]; const src = p.sourceFor(t, false);
            const was = a.entries.get(t.qid); if (was) a.drop(was);
            const failed = a.entry(t, src, 'pb-1', 'failed'); a.entries.set(t.qid, failed);
            const rec = a.record(t, src, 'pb-2');
            const got = { hls: src.hls, rec: !!rec, other: rec !== failed, kept: !!rec && a.entries.get(t.qid) === rec, state: rec?.state };
            if (rec) a.drop(rec); a.plan(); return got; })()""")
        check('stream: ...and a converted track coming in is kept as it comes, whatever didn\'t finish for it before',
              replaced == {'hls': True, 'rec': True, 'other': True, 'kept': True, 'state': 'recording'}, str(replaced))
        # With Load ahead off, a file isn't read again to keep (only what
        # comes in once is kept: a converted track, as it came in).
        settings(page, {'quality': 'original', 'loadAhead': 0, 'gapless': True})
        play_track(7, 3)
        tr = now()
        page.wait_for_timeout(4000)
        twice = [e for e in ahead() if e['id'] == tr['id']]
        check('stream: ...with Load ahead off, a file isn\'t read twice to keep it', not twice, str(ahead()))
        settings(page, {'keepPlayed': 0, 'quality': '320', 'gapless': False})
        check('stream: ...and none is kept once Keep played tracks is off', wait_for(lambda: all(e['id'] == now()['id'] for e in ahead()), 8, 0.3), str(ahead()))

        # A stream that never plays, started again and failing again: the
        # track is skipped, as before, saying so.
        play_track(4, 0, rules='&kill=0&sessions=2', wait=1)
        tr = now()
        wait_for(play_errors, 40, 0.25)
        told = page.locator('.toast').all_text_contents()
        wait_for(lambda: now()['id'] != tr['id'] and now()['state'] == 'playing', 20, 0.25)
        check('stream: a track whose stream never plays, even started again, is skipped, saying so',
              play_errors() == [tr['title']] and len(sessions_of(tr['id'])) == 2 and now()['id'] != tr['id'] and now()['state'] == 'playing'
              and any(f'Can\'t play “{tr["title"]}”. Skipping.' in x for x in told), f'{play_errors()} {sessions_of(tr["id"])} {now()} {told}')

        # An original file that stops coming part-way (its connection held
        # open, nothing more arriving, as through a proxy that's stopped
        # passing it on): loaded again from where it got to once nothing has
        # come in for a while (here 3 s), and it plays on.
        # (A browser of its own: not one that has the file kept already.)
        player(page, 'p.pause()')
        sctx = browser.new_context(**MOBILE)
        spg = sctx.new_page()
        attach(spg, 'stream-stall')
        login(spg, APP)
        settings(spg, {'quality': 'original', 'loadAhead': 0, 'keepPlayed': 0, 'gapless': False})
        spg.goto(APP + '#/browse/albums')
        spg.wait_for_selector('.grid .card')
        spg.locator('.grid .card').nth(5).click()
        spg.wait_for_selector('.hero-album')
        row = spg.locator('.track').nth(1)
        tid = row.get_attribute('data-track-id')
        # (500,000 bytes: about 11 of its 20 seconds. Chromium waits for ever
        # on its own, part-way through a track.)
        mock(f'/__mock/config?stall={tid}&bytes=500000')
        player(spg, 'Object.assign(p.stallLimits, { say: 1000, reload: 3000 })')
        row.locator('.track-main').click()
        snow = lambda: player(spg, '({ id: String(p.current?.id), t: p.time, state: p.state, again: p.stallRetry != null && p.stallRetry === p.current?.qid })')
        stuck = wait_for(lambda: player(spg, "p.state === 'loading' && p.time > 5"), 25, 0.2)
        stuck_at = snow()['t']
        resumed = wait_for(lambda: snow()['state'] == 'playing' and snow()['t'] > stuck_at + 2, 20, 0.25)
        check('stream: an original file that stops coming part-way is loaded again from where it got to, and plays on',
              stuck and resumed and snow()['id'] == str(tid) and snow()['again'] and 8 < stuck_at < 13, f'{stuck} {stuck_at} {snow()}')
        mock('/__mock/config?stall=')
        player(spg, 'p.pause()')
        sctx.close()
        hls('?reset=1')
        player(page, 'p.pause()')
        ctx.close()

    # ---------- cast: playing on another Plex player, and AirPlay/Cast ----------
    # The mock runs a Plex player ("Living Room", like Plexamp on a Pi) that
    # Dan has on his account; /__mock/player shows what it's doing.
    if run('cast'):
        ctx = browser.new_context(**MOBILE)
        page = ctx.new_page()
        attach(page, 'cast')
        mock('/__mock/player?reset=1')
        login(page, APP)
        remote_player = lambda: mock('/__mock/player')['MediaContainer']

        def until_player(test, timeout=8):
            return wait_for(lambda: test(remote_player()), timeout, 0.3)

        play_first_album_track(page, APP, album=1, track=0)
        page.wait_for_timeout(1500)
        page.click('.pb-main')
        page.wait_for_selector('.np.open')
        page.click('.np-tool[data-tool=cast]')
        page.wait_for_selector('.sheet.open .sheet-action:has-text("Living Room")')
        labels = page.locator('.sheet.open .sheet-action-label').all_text_contents()
        check('cast: "Play on" lists this device and the Plex players on the account', labels[:2] == ['This device', 'Living Room']
              and 'Plexamp · Raspberry Pi' in page.locator('.sheet.open').inner_text(), str(labels))
        check('cast: ...and says why Alexa speakers aren\'t there', 'Bluetooth' in page.locator('.sheet.open .cast-note').inner_text())
        shot(page, 'cast-01-sheet')
        here = player(page, '({ id: p.current.id, t: p.time })')
        page.locator('.sheet.open .sheet-action', has_text='Living Room').click()
        started = until_player(lambda s: s['state'] == 'playing' and s['ratingKey'] == here['id'])
        log = remote_player()['log']
        first = log[0]['params'] if log else {}
        check('cast: the player plays the queue from the same track and spot', started and log[0]['command'] == 'playback/playMedia'
              and abs(int(first.get('offset', 0)) / 1000 - here['t']) < 4, json.dumps(first))
        check('cast: ...with a temporary token from the server, not the account\'s', first.get('token', '').startswith('transient-')
              and first.get('token') != 't', first.get('token'))
        page.wait_for_timeout(1500)
        status = player(page, '({ casting: !!p.cast, playing: p.decks.filter((d) => !d.el.paused).length, state: p.state })')
        check('cast: this device stops playing and shows where it plays', status['casting'] and status['playing'] == 0 and status['state'] == 'playing'
              and page.locator('.np-where').inner_text() == 'Playing on Living Room' and 'on' in page.locator('.np-tool[data-tool=cast]').get_attribute('class'), json.dumps(status))
        shot(page, 'cast-02-playing-there')

        page.click('.np-play')
        check('cast: pause pauses the player', until_player(lambda s: s['state'] == 'paused'))
        page.click('.np-play')
        check('cast: ...and play plays it', until_player(lambda s: s['state'] == 'playing'))
        nxt = player(page, 'p.queue[p.index + 1].id')
        page.click('.np-skip[aria-label="Next track"]')
        check('cast: next goes to the next track there, and here', until_player(lambda s: s['ratingKey'] == nxt)
              and wait_for(lambda: player(page, 'p.current.id') == nxt, 5))
        player(page, 'p.seek(9)')
        check('cast: seeking moves the player', until_player(lambda s: 8 <= s['time'] / 1000 <= 12), remote_player()['time'])
        player(page, 'p.setVolume(0.4)')
        check('cast: the volume slider sets the player\'s volume', until_player(lambda s: s['volume'] == 40))
        before = player(page, 'p.queue.map((t) => t.id)')
        i = player(page, 'p.index')
        player(page, 'p.moveToTop(p.queue.length - 1)')
        moved = until_player(lambda s: s['queue'][i + 1] == before[-1])
        told = until_player(lambda s: any(l['command'] == 'playback/refreshPlayQueue' for l in s['log']))
        check('cast: Move to top changes the queue there (and the player is told)', moved and told
              and wait_for(lambda: player(page, 'p.queue[p.index + 1].id') == before[-1], 5), str(remote_player()['queue']))
        extra = mock('/library/sections/1/all?type=10&X-Plex-Token=t&X-Plex-Container-Size=1&sort=titleSort')['MediaContainer']['Metadata'][0]['ratingKey']
        n = len(remote_player()['queue'])
        js(page, f"() => Promise.all([import('./js/state.js'), import('./js/plex.js'), import('./js/player.js')]).then(async ([{{ app }}, {{ normTrack }}, {{ player }}]) => player.addToQueue([normTrack(await app.server.metadata('{extra}'))]))")
        check('cast: Add to queue adds it there', until_player(lambda s: len(s['queue']) == n + 1 and s['queue'][-1] == extra))
        # The player moves on by itself at the end of a track (they're 20 s).
        player(page, 'p.seek(18.5)')
        cur = player(page, 'p.current.id')
        check('cast: this device follows the player when it moves on by itself',
              wait_for(lambda: player(page, 'p.current.id') != cur, 8) and player(page, 'p.current.id') == remote_player()['ratingKey'])
        player(page, "p.setSleep('track')")
        player(page, 'p.seek(18.5)')
        cur = player(page, 'p.current.id')
        slept = until_player(lambda s: s['state'] == 'paused' and s['ratingKey'] != cur and s['time'] < 2000, 10)
        check('cast: the sleep timer\'s "end of this track" stops the player at the next one', slept and not player(page, 'p.sleepActive'),
              json.dumps({k: remote_player()[k] for k in ('state', 'time', 'ratingKey')}))
        page.click('.np-play')
        until_player(lambda s: s['state'] == 'playing')

        page.reload()
        page.wait_for_selector('.wide-card:not(.skeleton), .view')
        check('cast: after a reload it still controls the player', wait_for(lambda: player(page, '!!p.cast && p.state === "playing"'), 8))

        page.click('.pb-main')
        page.wait_for_selector('.np.open')
        page.click('.np-tool[data-tool=cast]')
        page.wait_for_selector('.sheet.open .sheet-action:has-text("This device")')
        there = player(page, 'p.time')
        page.locator('.sheet.open .sheet-action', has_text='This device').click()
        back = wait_for(lambda: player(page, '!p.cast && p.state === "playing"'), 8)
        check('cast: back to this device, from the same spot (and the player stops)', back and until_player(lambda s: s['state'] == 'paused')
              and abs(player(page, 'p.time') - there) < 4, f'{there} -> {player(page, "p.time")}')
        js(page, "() => import('./js/player.js').then(({ player }) => player.pause())")
        ctx.close()

        # Sam (a friend): players on the home network are the owner's.
        ctx = browser.new_context(**MOBILE)
        page = ctx.new_page()
        attach(page, 'cast-friend')
        login(page, APP, token='t2')
        play_first_album_track(page, APP)
        page.click('.pb-main')
        page.wait_for_selector('.np.open')
        page.click('.np-tool[data-tool=cast]')
        page.wait_for_selector('.sheet.open .sheet-action:has-text("Only the server’s owner")')
        text = page.locator('.sheet.open').inner_text()
        check('cast: only the server\'s owner can play on its Plex players', 'Living Room' not in text, text[:200])
        ctx.close()

        # AirPlay or Google Cast through the browser's own picker (a stand-in
        # for the browser's Remote Playback here: headless Chromium has no
        # devices to show).
        ctx = browser.new_context(**MOBILE)
        ctx.add_init_script("""(() => {
          const fakes = new WeakMap();
          class FakeRemote extends EventTarget {
            constructor(el) { super(); this.el = el; this.state = 'disconnected'; }
            watchAvailability(cb) { setTimeout(() => cb(true), 30); return Promise.resolve(1); }
            cancelWatchAvailability() { return Promise.resolve(); }
            prompt() {
              window.__remoteSrc = this.el.getAttribute('src');
              this.state = 'connecting';
              this.dispatchEvent(new Event('connecting'));
              setTimeout(() => { this.state = 'connected'; this.dispatchEvent(new Event('connect')); }, 100);
              return Promise.resolve();
            }
            leave() { this.state = 'disconnected'; this.dispatchEvent(new Event('disconnect')); }
          }
          Object.defineProperty(HTMLMediaElement.prototype, 'remote', { configurable: true, get() {
            let f = fakes.get(this); if (!f) { f = new FakeRemote(this); fakes.set(this, f); } return f; } });
        })();""")
        page = ctx.new_page()
        attach(page, 'cast-remote')
        login(page, APP)
        play_first_album_track(page, APP)
        page.click('.pb-main')
        page.wait_for_selector('.np.open')
        page.click('.np-tool[data-tool=cast]')
        page.wait_for_selector('.sheet.open .sheet-action:has-text("AirPlay or Cast")')
        page.wait_for_timeout(600)  # the temporary token arrives
        page.locator('.sheet.open .sheet-action', has_text='AirPlay or Cast').click()
        routed = wait_for(lambda: player(page, 'p.routed'), 5)
        src = js(page, '() => window.__remoteSrc') or ''
        check('cast: AirPlay or Cast opens the browser\'s picker, and the device gets a temporary token',
              routed and 'X-Plex-Token=transient-' in src and 'X-Plex-Token=t&' not in src, src[-80:])
        check('cast: ...and playback stays on one element (no crossfades while it\'s connected)',
              player(page, '!p.spare.hasSource() && p.nextPlan() === null') and page.locator('.np-where').inner_text() == 'Playing on an AirPlay or Cast device')
        js(page, "() => import('./js/player.js').then(({ player }) => player.audio.remote.leave())")
        check('cast: when the device lets go, it plays here as before', wait_for(lambda: player(page, '!p.routed && p.nextPlan() !== null'), 5)
              and page.locator('.np-where').is_hidden())
        js(page, "() => import('./js/player.js').then(({ player }) => player.pause())")
        ctx.close()

    # ---------- ratings: in track lists, and ❤️ Tracks ----------
    # Tracks rated here are put back unrated at the end, and ❤️ Tracks goes.
    if run('ratings'):
        ctx = browser.new_context(**MOBILE)
        page = ctx.new_page()
        attach(page, 'ratings')
        login(page, APP)
        mock('/__mock/config?loved=none')
        touched = set()

        def rating_of(tid):
            return mock(f'/library/metadata/{tid}?X-Plex-Token=t')['MediaContainer']['Metadata'][0].get('userRating')

        def loved():
            pls = mock('/playlists?X-Plex-Token=t&X-Plex-Container-Size=500')['MediaContainer'].get('Metadata', [])
            return next((p for p in pls if p['title'] == '❤️ Tracks'), None)

        def loved_ids():
            p = loved()
            return [m['ratingKey'] for m in mock(f'/playlists/{p["ratingKey"]}/items?X-Plex-Token=t&X-Plex-Container-Size=500')['MediaContainer'].get('Metadata', [])] if p else None

        def tap_star(row, n):
            touched.add(row.get_attribute('data-track-id'))
            row.evaluate("(e) => e.scrollIntoView({ block: 'center' })")
            page.wait_for_timeout(150)
            box = row.locator('.row-rating').bounding_box()
            page.mouse.click(box['x'] + box['width'] * (n - 0.5) / 5, box['y'] + box['height'] / 2)

        # An album with a few tracks, whatever other sections added.
        albums = mock('/library/sections/1/all?type=9&sort=titleSort&X-Plex-Token=t')['MediaContainer']['Metadata']
        album = next(a for a in albums if a.get('leafCount', 0) >= 6)
        page.goto(APP + f'#/album/{album["ratingKey"]}')
        page.wait_for_selector('.hero-album')
        page.wait_for_selector('.view .tracks .track .row-rating')
        rows = page.locator('.view .tracks .track')
        n = rows.count()
        ticks = page.locator('.view .tracks .track .rr-tick[aria-pressed]').count()
        check('ratings: the favourite tick is the rating system to start with', ticks == n and n > 4
              and js(page, "() => import('./js/state.js').then(({ app }) => app.settings.ratingSystem)") == 'tick', f'{ticks} of {n}')
        settings(page, {'ratingSystem': 'stars'})
        page.wait_for_timeout(300)
        check('ratings: every track in an album can be rated in the list', n > 4 and page.locator('.view .tracks .track .row-rating[role=slider]').count() == n, n)
        check('ratings: the rating is to the left of the track\'s length', rows.first.evaluate("""(r) => {
            const a = r.querySelector('.row-rating').getBoundingClientRect(), b = r.querySelector('.track-dur').getBoundingClientRect();
            return a.width > 0 && b.width > 0 && a.right <= b.left + 1; }"""))
        shot(page, 'ratings-01-album')
        first, second, third, fourth = (rows.nth(i) for i in range(4))
        tid, tid2, tid3, tid4 = (r.get_attribute('data-track-id') for r in (first, second, third, fourth))
        tap_star(first, 3)
        check('ratings: tapping the third star gives three stars', wait_for(lambda: rating_of(tid) == 6, 5)
              and first.locator('.row-rating').get_attribute('aria-valuenow') == '3', rating_of(tid))
        tap_star(first, 3)
        check('ratings: ...and tapping it again clears it', wait_for(lambda: rating_of(tid) is None, 5), rating_of(tid))
        first.locator('.row-rating').focus()
        page.keyboard.press('ArrowRight')
        page.keyboard.press('ArrowRight')
        check('ratings: the arrow keys rate too', wait_for(lambda: rating_of(tid) == 4, 5), rating_of(tid))

        # ❤️ Tracks: there isn't one yet, so the first five-star track makes it.
        tap_star(first, 5)
        check('ratings: five stars puts a track in ❤️ Tracks (made when there isn\'t one)', wait_for(lambda: loved_ids() == [tid], 6)
              and not loved()['smart'] and page.locator('.toast', has_text='❤️ Tracks').count() > 0, str(loved_ids()))
        tap_star(second, 5)
        check('ratings: ...the next five-star track joins it', wait_for(lambda: loved_ids() == [tid, tid2], 6), str(loved_ids()))
        tap_star(first, 4)
        check('ratings: ...and a track that loses its five stars leaves it', wait_for(lambda: loved_ids() == [tid2], 6) and rating_of(tid) == 8, str(loved_ids()))

        # The same rating in Now Playing, both ways.
        second.locator('.track-main').click()
        wait_for(lambda: player(page, "p.state === 'playing'"), 10)
        page.click('.pb-main')
        page.wait_for_selector('.np.open')
        on = page.locator('.np-stars .star.on').count()
        check('ratings: Now Playing shows the rating from the list', on == 5, on)
        page.locator('.np-stars .star').nth(1).click()
        page.wait_for_timeout(800)
        page.keyboard.press('Escape')
        page.wait_for_selector('.np.open', state='detached')
        check('ratings: ...and rating there changes the list (and ❤️ Tracks)', second.locator('.row-rating').get_attribute('aria-valuenow') == '2'
              and wait_for(lambda: loved_ids() == [], 6) and rating_of(tid2) == 4, str(loved_ids()))
        js(page, "() => import('./js/player.js').then(({ player }) => player.pause())")

        # Thumbs: up is five stars (and loved), down is one star.
        settings(page, {'ratingSystem': 'thumbs'})
        page.wait_for_timeout(300)
        check('ratings: with thumbs, every track has thumbs up and down', page.locator('.view .tracks .track .rr-thumb.rr-up').count() == n)
        touched.add(tid3)
        third.evaluate("(e) => e.scrollIntoView({ block: 'center' })")
        third.locator('.rr-up').click()
        check('ratings: thumbs up is five stars, and goes in ❤️ Tracks', wait_for(lambda: rating_of(tid3) == 10, 5) and wait_for(lambda: tid3 in (loved_ids() or []), 6), rating_of(tid3))
        shot(page, 'ratings-02-thumbs')
        third.locator('.rr-down').click()
        check('ratings: thumbs down is one star, and leaves it', wait_for(lambda: rating_of(tid3) == 2, 5) and wait_for(lambda: tid3 not in (loved_ids() or []), 6), rating_of(tid3))
        settings(page, {'ratingSystem': 'off'})
        page.wait_for_timeout(300)
        check('ratings: with ratings off, lists have none', page.locator('.view .tracks .track .row-rating:visible').count() == 0)
        settings(page, {'ratingSystem': 'stars', 'listRatings': False})
        page.wait_for_timeout(300)
        check('ratings: ...and they can be left out of lists', page.locator('.view .tracks .track .row-rating:visible').count() == 0)
        settings(page, {'listRatings': True})
        page.wait_for_timeout(300)

        # Plexamp's own ❤️ Tracks is a smart playlist: Plex fills it from ratings.
        mock('/__mock/config?loved=smart')
        tap_star(fourth, 5)
        wait_for(lambda: rating_of(tid4) == 10, 5)
        page.wait_for_timeout(1000)
        hearts = [p for p in mock('/playlists?X-Plex-Token=t&X-Plex-Container-Size=500')['MediaContainer']['Metadata'] if p['title'] == '❤️ Tracks']
        check('ratings: a smart ❤️ Tracks (Plexamp\'s) is left to fill itself', len(hearts) == 1 and hearts[0]['smart'] and loved_ids() == [tid4], json.dumps(hearts))

        # Not wanted: ratings don't touch playlists.
        settings(page, {'lovedPlaylist': False})
        mock('/__mock/config?loved=none')
        tap_star(rows.nth(4), 5)
        page.wait_for_timeout(1200)
        check('ratings: with ❤️ Tracks turned off in settings, no playlist changes', loved() is None and rating_of(rows.nth(4).get_attribute('data-track-id')) == 10)

        # The favourite tick: ticked is five stars, and in ❤️ Tracks;
        # unticked, no rating, and out of it.
        settings(page, {'lovedPlaylist': True, 'ratingSystem': 'tick'})
        page.wait_for_timeout(300)
        fifth = rows.nth(5)
        tid5 = fifth.get_attribute('data-track-id')
        touched.add(tid5)
        fifth.evaluate("(e) => e.scrollIntoView({ block: 'center' })")
        fifth.locator('.rr-tick').click()
        ticked = wait_for(lambda: rating_of(tid5) == 10, 5) and wait_for(lambda: loved_ids() == [tid5], 6)
        shown_on = fifth.locator('.rr-tick.on[aria-pressed=true]').count() == 1
        shot(page, 'ratings-03-ticks')
        fifth.locator('.rr-tick').click()
        unticked = wait_for(lambda: rating_of(tid5) is None, 5) and wait_for(lambda: loved_ids() == [], 6)
        check('ratings: ticking a track favourites it (five stars, into ❤️ Tracks), and unticking takes that off (and out)',
              ticked and shown_on and unticked and fifth.locator('.rr-tick[aria-pressed=false]').count() == 1, f'{rating_of(tid5)} {loved_ids()}')
        fifth.locator('.track-main').click()
        wait_for(lambda: player(page, "p.state === 'playing'"), 10)
        page.click('.pb-main')
        page.wait_for_selector('.np.open .np-fav')
        page.click('.np-fav')
        np_ticked = wait_for(lambda: rating_of(tid5) == 10, 5) and wait_for(lambda: page.locator('.np-fav.on[aria-pressed=true]').count() == 1, 3)
        follows = wait_for(lambda: fifth.locator('.rr-tick.on').count() == 1, 3)
        shot(page, 'ratings-04-np-tick')
        page.click('.np-fav')
        np_unticked = wait_for(lambda: rating_of(tid5) is None, 5) and wait_for(lambda: loved_ids() == [], 6)
        page.keyboard.press('Escape')
        page.wait_for_selector('.np.open', state='detached')
        js(page, "() => import('./js/player.js').then(({ player }) => player.pause())")
        check('ratings: ...in Now Playing too, and the list follows', np_ticked and follows and np_unticked, f'{np_ticked} {follows} {np_unticked}')
        for t in touched:
            mock(f'/:/rate?key={t}&rating=-1&identifier=com.plexapp.plugins.library&X-Plex-Token=t')
        mock('/__mock/config?loved=none')
        ctx.close()

    # ---------- devices: your devices share what's playing; one plays ----------
    # Two "devices" signed in to the same account (Desk and Phone), with the
    # setting on (other sections turn it off: they're all one account).
    if run('devices'):
        def device(name, **kw):
            c = browser.new_context(**kw)
            pg = c.new_page()
            attach(pg, name.lower())
            login(pg, APP)
            settings(pg, {'shareDevices': True, 'playerName': name})
            return c, pg

        def D(pg, expr):
            return js(pg, f"() => Promise.all([import('./js/player.js'), import('./js/devices.js')]).then(([{{ player: p }}, {{ devices: d }}]) => ({expr}))")

        desk_ctx, desk = device('Desk', viewport={'width': 1280, 'height': 860})
        play_first_album_track(desk, APP, album=1, track=0)
        check('devices: the device that starts playing is the one that plays', wait_for(lambda: D(desk, 'd.role') == 'active', 6), D(desk, 'd.role'))
        phone_ctx, phone = device('Phone', **MOBILE)
        followed = wait_for(lambda: D(phone, "d.role === 'remote' && p.state === 'playing'"), 8)
        check('devices: on another device, what\'s playing shows, without its sound', followed and D(phone, 'p.current.id') == D(desk, 'p.current.id')
              and D(phone, 'p.decks.every((x) => x.el.paused)') and abs(D(phone, 'p.time') - D(desk, 'p.time')) < 2, D(phone, 'd.role'))
        check('devices: ...and where it plays, with a way to listen here', 'Playing on Desk' in phone.locator('.pb-where').inner_text() and phone.locator('.pb-here').is_visible())
        shot(phone, 'devices-01-phone-follows')

        phone.click('.pb-play')
        check('devices: pause on one pauses the one playing, which says where it was paused from', wait_for(lambda: D(desk, 'p.state') == 'paused', 5) and wait_for(lambda: D(phone, 'p.state') == 'paused', 5)
              and wait_for(lambda: desk.locator('.toast', has_text='Paused from Phone').count() > 0, 3))
        phone.click('.pb-play')
        check('devices: ...and play plays it', wait_for(lambda: D(desk, 'p.state') == 'playing', 5))
        D(desk, "(() => { const was = d.lastCmd; d.runCommands([{ id: was + 1, type: 'pause', from: 'nobody', at: d.serverNow() - 60000 }]); d.lastCmd = was; })()")
        desk.wait_for_timeout(600)
        check('devices: ...but a pause that took too long to get there (that device out of touch meanwhile) is let go', D(desk, 'p.state') == 'playing', D(desk, 'p.state'))
        before = D(desk, 'p.current.id')
        phone.click('.pb-next')
        check('devices: next, too', wait_for(lambda: D(desk, 'p.current.id') != before, 5) and wait_for(lambda: D(phone, 'p.current.id') == D(desk, 'p.current.id'), 5))
        D(phone, 'p.seek(9)')
        check('devices: and seeking', wait_for(lambda: 8 < D(desk, 'p.time') < 12, 5), D(desk, 'p.time'))
        n = D(desk, 'p.queue.length')
        extra = mock('/library/sections/1/all?type=10&X-Plex-Token=t&X-Plex-Container-Size=1&sort=titleSort')['MediaContainer']['Metadata'][0]['ratingKey']
        js(phone, f"() => Promise.all([import('./js/state.js'), import('./js/plex.js'), import('./js/player.js')]).then(async ([{{ app }}, {{ normTrack }}, {{ player }}]) => player.addToQueue([normTrack(await app.server.metadata('{extra}'))]))")
        check('devices: queue changes go to the one playing (and show on both)', wait_for(lambda: D(desk, 'p.queue.length') == n + 1, 5)
              and str(D(desk, 'p.queue.at(-1).id')) == str(extra) and wait_for(lambda: D(phone, 'p.queue.length') == n + 1, 5))
        albums = mock('/library/sections/1/all?type=9&sort=titleSort&X-Plex-Token=t')['MediaContainer']['Metadata']
        album = next(a for a in albums if a.get('leafCount', 0) >= 5 and a['ratingKey'] != D(desk, 'p.current.albumId'))
        phone.goto(APP + f'#/album/{album["ratingKey"]}')
        phone.wait_for_selector('.hero-album')
        phone.click('.hero-actions .btn-primary')
        check('devices: playing an album on the phone plays it on the device that plays', wait_for(lambda: D(desk, 'p.current.albumId') == str(album['ratingKey']), 6)
              and D(phone, "d.role === 'remote' && p.decks.every((x) => x.el.paused)"))

        # Listen here: the music moves to the phone, and the desk goes quiet.
        wait_for(lambda: D(phone, 'p.current.albumId') == str(album['ratingKey']), 5)
        D(desk, 'p.seek(4)')  # the mock's tracks are 20 s long
        wait_for(lambda: 3 < D(phone, 'p.time') < 7, 5)
        t0 = time.time()
        desk_at = D(desk, 'p.time')
        phone.click('.pb-here')
        moved = wait_for(lambda: D(phone, "d.role === 'active' && p.state === 'playing' && p.decks.some((x) => !x.el.paused)"), 8)
        phone_at = D(phone, 'p.time')
        check('devices: Listen here moves the music to this device, from the same spot', moved and D(phone, 'p.current.albumId') == str(album['ratingKey'])
              and desk_at - 1 < phone_at < desk_at + (time.time() - t0) + 1, f'{desk_at} -> {phone_at}')
        check('devices: ...and the one that played goes quiet, and follows', wait_for(lambda: D(desk, "d.role === 'remote' && p.decks.every((x) => x.el.paused)"), 8)
              and wait_for(lambda: desk.locator('.toast', has_text='Now playing on Phone').count() > 0, 3))
        shot(desk, 'devices-02-desk-quiet')
        desk.click('.pb-right .volume .listen-here')
        check('devices: on the quiet one, its muted speaker brings the music back', wait_for(lambda: D(desk, "d.role === 'active' && p.decks.some((x) => !x.el.paused)"), 8)
              and wait_for(lambda: D(phone, "d.role === 'remote' && p.decks.every((x) => x.el.paused)"), 8))

        # Closed while playing: the phone can carry on from where it was.
        D(desk, 'p.seek(2)')
        wait_for(lambda: D(phone, 'p.time') < 6, 5)
        playing_id = D(desk, 'p.current.id')
        D(desk, 'd.stop()')
        carried = wait_for(lambda: D(phone, "d.role === 'idle' && !p.cast && p.state === 'paused'"), 8)
        check('devices: when the one playing stops, another carries on from where it was', carried and D(phone, 'p.current.id') == playing_id, D(phone, 'd.role'))
        D(phone, 'p.play()')
        check('devices: ...and playing there makes it the one that plays', wait_for(lambda: D(phone, "d.role === 'active' && p.state === 'playing'"), 6))

        # Off in settings: a device plays on its own.
        settings(desk, {'shareDevices': True})
        D(desk, 'd.update()')
        wait_for(lambda: D(desk, "d.role === 'remote'"), 8)
        desk.goto(APP + '#/settings/playback')
        desk.wait_for_selector('label.toggle-row:has-text("Share playback with your devices")')
        was_on = desk.locator('label.toggle-row', has_text='Share playback with your devices').locator('input').is_checked()
        default = js(desk, "() => import('./js/state.js').then(({ DEFAULT_SETTINGS }) => DEFAULT_SETTINGS.shareDevices)")
        toggle(desk, 'Share playback with your devices', False)
        check('devices: on unless turned off in Settings › Playback; off, a device plays on its own', was_on and default is True
              and wait_for(lambda: D(desk, "d.role === 'off' && !p.cast"), 5), f'{was_on} {default}')
        D(desk, 'p.play()')
        check('devices: ...so two can play at once', wait_for(lambda: D(desk, "p.state === 'playing'"), 6) and D(phone, "p.state === 'playing' && d.role === 'active'"))
        D(desk, 'p.pause()')

        # Someone else's account sees none of it.
        sam_ctx = browser.new_context(**MOBILE)
        sam = sam_ctx.new_page()
        attach(sam, 'sam-devices')
        login(sam, APP, 't2')
        settings(sam, {'shareDevices': True})
        sam.wait_for_timeout(1500)
        check('devices: other accounts don\'t see your devices', D(sam, "d.role === 'idle' && !d.active && !p.cast"))
        for pg in (phone, sam):
            D(pg, 'd.stop(), p.pause()')  # nothing left playing for the sections after this
        for c in (desk_ctx, phone_ctx, sam_ctx):
            c.close()

    # ---------- fades: crossfades and gapless changes of track ----------
    # Mock tracks are 20 seconds long; some end with 6 seconds of silence,
    # some start with 3 (see dev/mock-plex.py).
    if run('fades'):
        ctx = browser.new_context(**MOBILE)
        page = ctx.new_page()
        attach(page, 'fades')
        login(page, APP)
        tracks = mock('/__mock/tracks')['MediaContainer']['Metadata']
        a = next(t for t in tracks if t['silentEnd'])
        b = next(t for t in tracks if t['silentStart'] and t['album'] != a['album'])
        c, d = next((x, y) for x, y in zip(tracks, tracks[1:])
                    if x['album'] == y['album'] and y['index'] == x['index'] + 1 and not x['silentEnd'] and not y['silentStart'])
        # One with a quiet ending (and loudness analysis: not every third),
        # and one to follow it, from another album.
        qe = next(t for t in tracks if int(t['ratingKey']) % 3 and not t['silentEnd'] and not t['silentStart']
                  and t['ratingKey'] not in (c['ratingKey'], d['ratingKey']))
        qn = next(t for t in tracks if not t['silentStart'] and t['album'] != qe['album'] and t['ratingKey'] != a['ratingKey'])
        mock(f'/__mock/config?quiet={qe["ratingKey"]}')

        def queue(ids, at):
            """Play these tracks (by id), starting `at` seconds into the first."""
            js(page, "() => Promise.all([import('./js/state.js'), import('./js/plex.js'), import('./js/player.js')])"
                     ".then(async ([{ app }, { normTrack }, { player }]) => {"
                     f" const list = await Promise.all({json.dumps(ids)}.map(async (id) => normTrack(await app.server.metadata(id))));"
                     " player.playTracks(list, 0, { context: { title: 'Fades', href: null } });"
                     " for (let i = 0; i < 100 && player.state !== 'playing'; i++) await new Promise((r) => setTimeout(r, 100));"
                     f" player.seek({at}); }})")

        def watch(seconds, until_id=None):
            """The player every 0.2 s, for `seconds` or until `until_id` has
            been playing a moment. (Each player's volume as the fade has it:
            with loudness levelling on, what it plays at is that times the
            track's level.)"""
            out = []
            end = time.time() + seconds
            while time.time() < end:
                out.append(player(page, "({ cur: p.current?.id, t: p.time, kind: p.transition?.plan.kind || null, fade: p.transition?.plan.fade ?? null, state: p.state,"
                                        " vols: p.decks.map((d) => d.el.volume / Math.max(1e-9, p.volume * d.level)), levels: p.decks.map((d) => d.level),"
                                        " times: p.decks.map((d) => d.el.currentTime),"
                                        " playing: p.decks.filter((d) => !d.el.paused).length, active: p.active })"))
                if until_id and sum(1 for x in out if x['cur'] == until_id) > 3:
                    break
                page.wait_for_timeout(200)
            return out

        def switch_point(samples, from_id, to_id):
            """(the old track's last time, the new one's first) when the new one took over."""
            for x, y in zip(samples, samples[1:]):
                if x['cur'] == from_id and y['cur'] == to_id:
                    return x['t'], y['t']
            return None, None

        # Smart (the default): the next track fades in where this one's music
        # ends, skipping the silence after it and before the next one's.
        queue([a['ratingKey'], b['ratingKey']], 7)
        got = watch(14, b['ratingKey'])
        fading = [x for x in got if x['kind'] == 'fade']
        mid = [x for x in fading if 0.15 < min(x['vols']) and max(x['vols']) < 0.97]
        check('fades: the next track fades in as this one fades out', fading and mid and all(x['playing'] == 2 for x in mid),
              json.dumps(fading[:2]))
        last, first = switch_point(got, a['ratingKey'], b['ratingKey'])
        check('fades: the silence at the end of a track is skipped', last is not None and last < 15.5, f'{last}')
        check('fades: the next track takes over part-way in (its clock shows the fade)', first is not None and 5 <= first <= 10, f'{first}')
        start = fading[0]['times'][fading[0]['active'] ^ 1] if fading else 0
        check('fades: the silence before the next track\'s music is skipped', start >= 2.4, f'{start:.2f}')
        after = got[-1]
        check('fades: ...and then it plays on its own at full volume', after['playing'] == 1 and after['vols'][after['active']] == 1, json.dumps(after))

        # Tracks that follow each other on an album: gapless, no fade.
        queue([c['ratingKey'], d['ratingKey']], 15.5)
        got = watch(9, d['ratingKey'])
        last, first = switch_point(got, c['ratingKey'], d['ratingKey'])
        check('fades: the next track on the same album follows gaplessly, without a fade',
              not any(x['kind'] == 'fade' for x in got) and all(min(x['vols']) == 1 for x in got)
              and last is not None and last > 19 and first < 1.5, f'{last} -> {first}')

        # Pausing in the middle of a fade pauses both tracks; Next goes straight on.
        queue([a['ratingKey'], b['ratingKey']], 10.5)
        wait_for(lambda: player(page, "p.transition?.plan.kind === 'fade'"), 5)
        js(page, "() => import('./js/player.js').then(({ player }) => player.pause())")
        page.wait_for_timeout(600)
        paused = watch(1)
        check('fades: pausing during a fade pauses both tracks',
              all(x['playing'] == 0 and x['state'] == 'paused' for x in paused) and paused[0]['vols'] == paused[-1]['vols'], json.dumps(paused[-1]))
        js(page, "() => import('./js/player.js').then(({ player }) => player.play())")
        page.wait_for_timeout(500)
        both = watch(0.3)[-1]
        check('fades: ...and playing carries the fade on', both['playing'] == 2 and both['kind'] == 'fade' and both['state'] == 'playing', json.dumps(both))
        js(page, "() => import('./js/player.js').then(({ player }) => player.next())")
        page.wait_for_timeout(400)
        now = watch(0.3)[-1]
        check('fades: Next during a fade goes straight to the next track',
              now['cur'] == b['ratingKey'] and now['playing'] == 1 and now['vols'][now['active']] == 1 and not now['kind'], json.dumps(now))

        # Seeking back calls the fade off.
        queue([a['ratingKey'], b['ratingKey']], 10.5)
        wait_for(lambda: player(page, "p.transition?.plan.kind === 'fade'"), 5)
        js(page, "() => import('./js/player.js').then(({ player }) => player.seek(3))")
        page.wait_for_timeout(500)
        now = watch(0.3)[-1]
        check('fades: seeking back calls the fade off', now['cur'] == a['ratingKey'] and now['playing'] == 1 and not now['kind']
              and now['vols'][now['active']] == 1 and now['t'] < 6, json.dumps(now))

        # The next track's data is late (as on a slow connection): this one
        # plays on at full volume until the next one sounds, and the fade
        # fits into what's left of this one's music. (Here the next track
        # says it has nothing to play from until told otherwise.)
        queue([a['ratingKey'], b['ratingKey']], 6)
        wait_for(lambda: player(page, 'p.spare.qid != null && p.spare.qid === p.queue[1]?.qid'), 6, 0.1)
        player(page, "(Object.defineProperty(p.spare.el, 'readyState', { configurable: true, get: () => 1 }), true)")
        wait_for(lambda: player(page, "p.transition?.plan.kind === 'fade'"), 8, 0.1)
        page.wait_for_timeout(1200)
        held = watch(0.8)
        player(page, '(p.decks.forEach((d) => delete d.el.readyState), true)')
        got = watch(10, b['ratingKey'])
        mid = [x for x in got if x['kind'] == 'fade' and 0.15 < min(x['vols']) and max(x['vols']) < 0.97]
        last, first = switch_point(got, a['ratingKey'], b['ratingKey'])
        check('fades: a next track whose data is late: this one plays on at full volume until it sounds, then the fade fits into what\'s left',
              held and all(x['kind'] == 'fade' and x['cur'] == a['ratingKey'] and x['vols'][x['active']] == 1 and x['vols'][x['active'] ^ 1] == 0 for x in held)
              and mid and last is not None and last < 15.5 and got[-1]['vols'][got[-1]['active']] == 1, f'{held} {len(mid)} {last} -> {first}')

        # ...and one that waits for data part-way through the fade: the fade
        # holds where it's got to until it sounds again.
        queue([a['ratingKey'], b['ratingKey']], 7)
        wait_for(lambda: player(page, "p.transition?.plan.kind === 'fade' && p.transition.p > 0.2"), 8, 0.05)
        player(page, "(Object.defineProperty(p.transition.inn.el, 'readyState', { configurable: true, get: () => 2 }), true)")
        page.wait_for_timeout(400)
        held = watch(0.8)
        player(page, '(p.decks.forEach((d) => delete d.el.readyState), true)')
        got = watch(10, b['ratingKey'])
        last, first = switch_point(got, a['ratingKey'], b['ratingKey'])
        check('fades: ...and one that waits for data part-way through the fade: the fade holds where it\'s got to until it sounds again',
              len(held) >= 3 and all(x['kind'] == 'fade' and x['vols'] == held[0]['vols'] for x in held) and 0.05 < held[0]['vols'][held[0]['active']] < 0.97
              and last is not None and got[-1]['cur'] == b['ratingKey'] and got[-1]['vols'][got[-1]['active']] == 1, f'{held} {last} -> {first}')

        # Streaming quality changed during a fade: the fade carries on, and
        # the next track changes to the new way once it's done.
        queue([a['ratingKey'], b['ratingKey']], 7)
        wait_for(lambda: player(page, "p.transition?.plan.kind === 'fade'"), 8, 0.1)
        settings(page, {'quality': '320'})
        got = watch(10, b['ratingKey'])
        last, first = switch_point(got, a['ratingKey'], b['ratingKey'])
        before = [x for x in got if x['cur'] == a['ratingKey']]
        converted = wait_for(lambda: player(page, f"p.current?.id === '{b['ratingKey']}' && p.deck.isHls && p.deck.kbps === 320 && p.state === 'playing'"), 15, 0.2)
        check('fades: Streaming quality changed during a fade: the fade carries on, and the next track then plays the new way',
              before and all(x['kind'] == 'fade' for x in before) and last is not None and last < 15.5 and first is not None and 5 <= first <= 10.5
              and converted, f'{len(before)} {[x["kind"] for x in before]} {last} -> {first} {converted}')
        settings(page, {'quality': 'original'})
        wait_for(lambda: player(page, '!p.deck.isHls && p.state === "playing"'), 10, 0.2)
        js(page, "() => import('./js/player.js').then(({ player }) => player.pause())")

        # A quiet ending (its last 8 seconds about 23 dB down, a beat still
        # ticking): Smart starts the fade where it begins, not 5 seconds
        # before the end, and it lasts as long as the ending (this one never
        # gets nearly silent before its music ends), not Crossfade length.
        queue([qe['ratingKey'], qn['ratingKey']], 9)
        got = watch(13, qn['ratingKey'])
        fading = [x for x in got if x['kind'] == 'fade']
        last, first = switch_point(got, qe['ratingKey'], qn['ratingKey'])
        check('fades: the next track starts over a quiet ending, where it begins, and fades in until the ending\'s done',
              fading and 11.6 <= fading[0]['t'] <= 13.2 and 6 <= (fading[0]['fade'] or 0) <= 8.5 and last is not None and last >= 18.6,
              f'{fading[0]["t"] if fading else None} {fading[0]["fade"] if fading else None}, {last} -> {first}')
        # Smart crossfade length, from what the loudness analysis says of an
        # ending (here put in place for the track playing): over a quiet
        # ending, the fade lasts until the track is nearly silent (2 seconds
        # at least, quick where it's nearly silent already), until its music
        # ends where it never gets that quiet, and for Crossfade length where
        # it ends cold; where it only goes quiet at the very last, starting
        # early enough for 2 seconds of it. (No longer than a third of the
        # next track, here 20 seconds long.)
        queue([qe['ratingKey'], qn['ratingKey']], 1)
        js(page, "() => import('./js/player.js').then(({ player }) => player.pause())")
        plans = js(page, """() => Promise.all([import('./js/player.js'), import('./js/state.js')]).then(([{ player: p }, { app }]) => {
            const spans = {
                fadeout: { start: 0, end: 19.4, quietFrom: { soft: 14, quiet: 15.4, hushed: 16.8 } },
                long: { start: 0, end: 19.5, quietFrom: { soft: 8, quiet: 11, hushed: 16 } },
                nohush: { start: 0, end: 19.5, quietFrom: { soft: 12, quiet: 13, hushed: null } },
                cold: { start: 0, end: 19.5, quietFrom: { soft: null, quiet: null, hushed: null } },
                late: { start: 0, end: 19.4, quietFrom: { soft: 18.9, quiet: 19.1, hushed: 19.3 } },
            };
            const cur = p.current, next = p.queue[p.index + 1], was = app.settings.quietEndings;
            const out = {};
            for (const [name, span] of Object.entries(spans)) {
                for (const kind of ['soft', 'quiet', 'hushed']) {
                    app.settings.quietEndings = kind;
                    p.spans.set(cur.id, span);
                    p.spans.set(next.id, { start: 0, end: next.duration / 1000, quietFrom: {} });
                    const plan = p.nextPlan();
                    out[`${name}.${kind}`] = plan && [Math.round(plan.at * 100) / 100, Math.round(plan.fade * 100) / 100];
                }
            }
            app.settings.quietEndings = was;
            p.spans.delete(cur.id);
            p.spans.delete(next.id);
            return out;
        })""")
        want = {'fadeout.soft': [14, 2.8], 'fadeout.quiet': [15.4, 2], 'fadeout.hushed': [16.8, 2],
                'long.soft': [9.75, 6.25], 'long.quiet': [11, 5], 'long.hushed': [16, 2],
                'nohush.soft': [12, 6.67], 'nohush.quiet': [13, 6.5], 'nohush.hushed': [14.5, 5],
                'cold.soft': [14.5, 5], 'cold.quiet': [14.5, 5], 'cold.hushed': [14.5, 5],
                'late.soft': [17.4, 2], 'late.quiet': [17.4, 2], 'late.hushed': [17.4, 2]}
        off = {k: (plans.get(k), v) for k, v in want.items() if not plans.get(k) or any(abs(a - b) > 0.02 for a, b in zip(plans[k], v))}
        check('fades: smart crossfade length: over a quiet ending, until the track is nearly silent (or its music ends); Crossfade length where it ends cold', not off, str(off))
        # How quiet it has to be is a setting: "nearly silent" lets this one
        # play out, and the fade comes at the end.
        settings(page, {'quietEndings': 'hushed'})
        queue([qe['ratingKey'], qn['ratingKey']], 11)
        got = watch(13, qn['ratingKey'])
        fading = [x for x in got if x['kind'] == 'fade']
        check('fades: ...as quiet as Settings asks (nearly silent: this one plays out)', fading and fading[0]['t'] >= 14.5,
              f'{fading[0]["t"] if fading else None}')
        settings(page, {'quietEndings': 'quiet'})

        # Always: at the very end of each track, album or not.
        settings(page, {'fades': 'always'})
        queue([c['ratingKey'], d['ratingKey']], 12)
        got = watch(12, d['ratingKey'])
        fading = [x for x in got if x['kind'] == 'fade']
        last, first = switch_point(got, c['ratingKey'], d['ratingKey'])
        check('fades: "Always" fades between album tracks too, at the very end',
              fading and fading[0]['t'] >= 14.5 and last is not None and last > 19 and 3.5 <= first <= 6.5,
              f'{fading[0]["t"] if fading else None}, {last} -> {first}')
        # A track that stops coming as it fades out (here made to wait for
        # data, part-way through the fade): after a moment (here 1 s) the
        # change is done with, and the next track plays on, rather than the
        # fade, timed by the one fading out, waiting with it.
        used = {t['ratingKey'] for t in (a, b, c, d, qe, qn)}
        e, f = [t for t in tracks if t['ratingKey'] not in used and not t['silentEnd'] and not t['silentStart']][-2:]
        js(page, "() => import('./js/player.js').then(({ player }) => Object.assign(player.stallLimits, { fade: 1000 }))")
        queue([e['ratingKey'], f['ratingKey']], 12)
        state = lambda: js(page, "() => import('./js/player.js').then(({ player: p }) => ({ id: String(p.current?.id), t: p.time, state: p.state, fading: !!p.transition && !p.transition.inn.el.paused }))")
        fading = wait_for(lambda: state()['fading'], 10, 0.2)
        js(page, "() => import('./js/player.js').then(({ player: p }) => { const o = p.transition.out.el; o.playbackRate = 0; o.dispatchEvent(new Event('waiting')); })")
        stuck = state()
        on = wait_for(lambda: (lambda s: s['id'] == str(f['ratingKey']) and s['state'] == 'playing' and not s['fading'])(state()), 6, 0.2)
        check('fades: a track that stops coming as it fades out gives way to the next one, which plays on',
              fading and stuck['state'] == 'loading' and stuck['id'] == str(e['ratingKey']) and on, f'{fading} {stuck} {state()}')
        js(page, "() => import('./js/player.js').then(({ player }) => Object.assign(player.stallLimits, { fade: 3000 }))")

        # Off: one after another, silence and all.
        settings(page, {'fades': 'off'})
        queue([a['ratingKey'], b['ratingKey']], 12)
        got = watch(12, b['ratingKey'])
        last, first = switch_point(got, a['ratingKey'], b['ratingKey'])
        check('fades: with Crossfade off, tracks play as they are', not any(x['kind'] == 'fade' for x in got)
              and last is not None and last > 19 and first < 1.5, f'{last} -> {first}')
        js(page, "() => import('./js/player.js').then(({ player }) => player.pause())")

        # The settings.
        settings(page, {'fades': 'smart'})
        page.goto(APP + '#/settings/playback')
        page.wait_for_selector('.choice-row:has-text("Crossfade length")')
        choose(page, 'Crossfade', 'Off')
        hidden = page.locator('.choice-row:has-text("Crossfade length")').is_hidden()
        saved = js(page, "() => import('./js/state.js').then(({ app }) => app.settings.fades)")
        choose(page, 'Crossfade', 'Smart')
        choose(page, 'Crossfade length', '8 seconds')
        length = js(page, "() => import('./js/state.js').then(({ app }) => app.settings.fadeLength)")
        shot(page, 'fades-01-settings')
        check('fades: Crossfade and its length are set in Settings › Playback', hidden and saved == 'off' and length == 8, f'{hidden} {saved} {length}')
        quiet_row = page.locator('.choice-row:has-text("Quiet endings")')
        shown = quiet_row.is_visible() and 'When it’s quiet' in quiet_row.inner_text()
        choose(page, 'Crossfade', 'Always')
        gone = quiet_row.is_hidden()
        choose(page, 'Crossfade', 'Smart')
        choose(page, 'Quiet endings', 'nearly silent')
        saved = js(page, "() => import('./js/state.js').then(({ app }) => app.settings.quietEndings)")
        check('fades: Quiet endings is set there too, for Smart only', shown and gone and saved == 'hushed', f'{shown} {gone} {saved}')
        settings(page, {'quietEndings': 'quiet', 'fadeLength': 5})
        mock('/__mock/config?quiet=')
        ctx.close()

    # ---------- loudness: levelling, from the server's loudness analysis ----------
    # Mock tracks with an even id are loud (-8 LUFS, a gain of -10 dB), the
    # others quiet (-16 LUFS, -2 dB); every album's gain is -7 dB.
    if run('loudness'):
        ctx = browser.new_context(**MOBILE)
        page = ctx.new_page()
        attach(page, 'loudness')
        login(page, APP)
        tracks = mock('/__mock/tracks')['MediaContainer']['Metadata']
        loud = next(t for t in tracks if int(t['ratingKey']) % 2 == 0)
        quiet = next(t for t in tracks if int(t['ratingKey']) % 2 == 1 and t['album'] != loud['album'])
        c, d = next((x, y) for x, y in zip(tracks, tracks[1:]) if x['album'] == y['album'] and y['index'] == x['index'] + 1)

        def play(ids):
            js(page, "() => Promise.all([import('./js/state.js'), import('./js/plex.js'), import('./js/player.js')])"
                     ".then(async ([{ app }, { normTrack }, { player }]) => {"
                     f" const list = await Promise.all({json.dumps(ids)}.map(async (id) => normTrack(await app.server.metadata(id))));"
                     " player.playTracks(list, 0, { context: { title: 'Loudness', href: null } }); })")
            return wait_for(lambda: player(page, "p.state === 'playing'"), 10, 0.1)

        level = lambda: player(page, '({ level: p.deck.level, volume: p.audio.volume, spare: p.spare.qid != null ? p.spare.level : null })')
        # On to start with (a new browser's settings).
        fresh_ctx = browser.new_context(**MOBILE)
        fresh = fresh_ctx.new_page()
        attach(fresh, 'loudness-fresh')
        login(fresh, APP, app_defaults=True)
        starts = js(fresh, "() => import('./js/state.js').then(({ app }) => ({ loudness: app.settings.loudness, loadAhead: app.settings.loadAhead }))")
        fresh_ctx.close()
        # (0.19.0 had it off: settings from then are moved on to it.)
        settings(page, {'loudness': False, 'fades': 'off', 'gapless': True})
        play([loud['ratingKey']])
        off = level()
        settings(page, {'loudness': True})
        page.wait_for_timeout(400)
        on = level()
        check('loudness: on to start with (and loading the next track ahead); on, a loud track is turned down to -14 LUFS (by 6 dB here), at once',
              starts == {'loudness': True, 'loadAhead': 1} and off['level'] == 1 and abs(on['level'] - 10 ** (-6 / 20)) < 0.01 and abs(on['volume'] - on['level']) < 0.01,
              f'{starts} {off} {on}')
        play([quiet['ratingKey']])
        q = level()
        check('loudness: ...a quiet one isn\'t turned up', q['level'] == 1 and q['volume'] == 1, str(q))
        play([c['ratingKey'], d['ratingKey']])
        first = level()
        wait_for(lambda: player(page, 'p.spare.qid != null && p.spare.level < 1'), 10, 0.2)
        album = level()
        check('loudness: an album played in order uses its album\'s gain (3 dB down here), for the next track too, before it plays',
              abs(first['level'] - 10 ** (-3 / 20)) < 0.01 and album['spare'] is not None and abs(album['spare'] - 10 ** (-3 / 20)) < 0.01, f'{first} {album}')
        # Through a crossfade each track keeps its own level (the fade's
        # volume times it), ending at the next one's.
        settings(page, {'fades': 'always'})
        play([quiet['ratingKey'], loud['ratingKey']])
        wait_for(lambda: player(page, 'p.spare.qid != null && p.spare.level < 1'), 10, 0.2)
        player(page, 'p.seek(p.duration - 6)')
        fading = wait_for(lambda: player(page, "p.transition?.plan.kind === 'fade' && p.transition.p > 0.3"), 10, 0.1)
        mix = player(page, "p.decks.map((d) => ({ volume: d.el.volume, gain: d.gain, level: d.level }))")
        wait_for(lambda: player(page, f"p.current?.id === '{loud['ratingKey']}' && !p.transition"), 12, 0.2)
        end = level()
        settings(page, {'fades': 'off'})
        check('loudness: through a crossfade each track keeps its own level (the fade\'s volume times it), ending at the next one\'s',
              fading and all(abs(x['volume'] - x['gain'] * x['level']) < 0.01 for x in mix) and all(0.02 < x['gain'] < 0.98 for x in mix)
              and sorted(round(x['level'], 2) for x in mix) == [round(10 ** (-6 / 20), 2), 1.0]
              and abs(end['level'] - 10 ** (-6 / 20)) < 0.01 and abs(end['volume'] - end['level']) < 0.01, f'{mix} {end}')
        settings(page, {'loudness': False})
        page.wait_for_timeout(300)
        back = level()
        check('loudness: ...and off again, everything plays as it is', back['level'] == 1 and back['spare'] in (None, 1), str(back))
        page.goto(APP + '#/settings/playback')
        page.wait_for_selector('label.toggle-row:has-text("Loudness levelling")')
        row_text = page.locator('label.toggle-row', has_text='Loudness levelling').inner_text()
        check('loudness: it\'s in Settings › Playback, saying it only ever turns tracks down', 'never up' in row_text, row_text)
        # Load ahead is there too: off, or 1 to 10 tracks, each with about how
        # much memory it takes, as Streaming quality has the tracks come in.
        settings(page, {'quality': 'original'})
        page.goto(APP + '#/settings')
        page.goto(APP + '#/settings/playback')
        page.wait_for_selector('.choice-row:has-text("Load ahead")')
        page.click('.choice-row:has-text("Load ahead")')
        page.wait_for_selector('.sheet.open')
        labels = page.locator('.sheet.open .sheet-action .sheet-label, .sheet.open .sheet-action > span:first-child').all_inner_texts()
        sheet_text = page.locator('.sheet.open').inner_text()
        shot(page, 'loudness-02-load-ahead')
        page.keyboard.press('Escape')
        page.wait_for_timeout(300)
        page.locator('label.radio-row, .radio-row', has_text='320').first.click()
        page.wait_for_timeout(300)
        page.click('.choice-row:has-text("Load ahead")')
        page.wait_for_selector('.sheet.open')
        converted = page.locator('.sheet.open').inner_text()
        page.keyboard.press('Escape')
        check('loudness: Load ahead goes from off to 10 tracks, each saying about how much memory it takes (as MP3 and FLAC, or at the bitrate it\'s converted to)',
              'Off' in sheet_text and '10 tracks' in sheet_text and 'The next 10 tracks: about 96 MB as MP3, 300 MB as FLAC.' in sheet_text
              and 'The next 2 tracks: about 19 MB at 320 kbps.' in converted, f'{labels} {sheet_text[-200:]} {converted[-200:]}')
        # ...and Keep played tracks: off, or 1 to 5, likewise (1 to start with).
        page.wait_for_timeout(300)
        page.click('.choice-row:has-text("Keep played tracks")')
        page.wait_for_selector('.sheet.open')
        kept_text = page.locator('.sheet.open').inner_text()
        page.keyboard.press('Escape')
        page.wait_for_timeout(300)
        fresh_ctx = browser.new_context(**MOBILE)
        fresh = fresh_ctx.new_page()
        attach(fresh, 'loudness-fresh-keep')
        login(fresh, APP, app_defaults=True)
        keep_start = js(fresh, "() => import('./js/state.js').then(({ app }) => app.settings.keepPlayed)")
        fresh_ctx.close()
        check('loudness: Keep played tracks goes from off to 5, each saying about how much memory it takes (1 to start with)',
              keep_start == 1 and 'Off' in kept_text and '5 tracks' in kept_text and '6 tracks' not in kept_text
              and 'The last track played: about 9.6 MB at 320 kbps.' in kept_text and 'The last 5 tracks played: about 48 MB at 320 kbps.' in kept_text, f'{keep_start} {kept_text[-300:]}')
        settings(page, {'quality': 'original'})
        js(page, "() => import('./js/player.js').then(({ player }) => player.pause())")
        ctx.close()

    # ---------- radio: playlist radio and favourites radio ----------
    if run('radio'):
        ctx = browser.new_context(**MOBILE)
        page = ctx.new_page()
        attach(page, 'radio')
        login(page, APP)
        queue_now = lambda: player(page, '({ context: p.context?.title, ids: p.queue.map((t) => t.id), artists: p.queue.map((t) => t.artistId), state: p.state })')

        # A playlist's radio: some of it, and more like it.
        pls = mock('/playlists?X-Plex-Token=t&X-Plex-Container-Size=500')['MediaContainer'].get('Metadata', [])
        pl = next(p for p in pls if not p.get('smart') and p.get('leafCount', 0) >= 5)
        own = [m['ratingKey'] for m in mock(f'/playlists/{pl["ratingKey"]}/items?X-Plex-Token=t&X-Plex-Container-Size=500')['MediaContainer'].get('Metadata', [])]
        page.goto(APP + f'#/playlist/{pl["ratingKey"]}')
        page.wait_for_selector('.hero button:has-text("Radio")')
        page.locator('.hero button:has-text("Radio")').first.click()
        wait_for(lambda: queue_now()['context'] == f'{pl["title"]} radio' and queue_now()['state'] == 'playing', 10, 0.2)
        q = queue_now()
        mine = [i for i in q['ids'] if i in own]
        check('radio: a playlist\'s radio plays some of it, mixed with more like it',
              q['context'] == f'{pl["title"]} radio' and len(q['ids']) >= 10 and mine and len(mine) < len(q['ids']) and len(set(q['ids'])) == len(q['ids']),
              f'{q["context"]} {len(q["ids"])} {len(mine)} of the playlist\'s {len(own)}')
        page.click('.view button[aria-label="More options"]')
        page.wait_for_selector('.sheet.open')
        listed = page.locator('.sheet.open .sheet-action', has_text='Playlist radio').count()
        page.keyboard.press('Escape')
        check('radio: ...from its menu too', listed == 1, listed)

        # Favourites radio: nothing loved yet says so; then the artists of
        # ❤️ Tracks (Plexamp's smart one here, which Plex fills from ratings).
        mock('/__mock/config?loved=none')
        page.goto(APP + '#/')
        page.wait_for_selector('button.station[aria-label="Play Favourites radio"]')
        page.locator('button.station[aria-label="Play Favourites radio"]').scroll_into_view_if_needed()
        shot(page, 'radio-01-stations')
        page.click('button.station[aria-label="Play Favourites radio"]')
        told = wait_for(lambda: page.locator('.toast', has_text='Favourite a few tracks first').count() > 0, 6)
        tracks = mock('/__mock/tracks')['MediaContainer']['Metadata']
        loved = [t['ratingKey'] for t in tracks[:40:13]]
        for t in loved:
            mock(f'/:/rate?key={t}&rating=10&identifier=com.plexapp.plugins.library&X-Plex-Token=t')
        mock('/__mock/config?loved=smart')
        loved_artists = {mock(f'/library/metadata/{t}?X-Plex-Token=t')['MediaContainer']['Metadata'][0]['grandparentRatingKey'] for t in loved}
        page.click('button.station[aria-label="Play Favourites radio"]')
        wait_for(lambda: queue_now()['context'] == 'Favourites radio' and queue_now()['state'] == 'playing', 10, 0.2)
        q = queue_now()
        theirs = [a for a in q['artists'] if a in loved_artists]
        check('radio: favourites radio, with nothing loved yet, says so; then it plays the artists you love, and more like them',
              told and q['context'] == 'Favourites radio' and len(q['ids']) >= 10 and theirs and len(theirs) < len(q['artists']),
              f'{told} {q["context"]} {len(q["ids"])} {len(theirs)}')
        for t in loved:
            mock(f'/:/rate?key={t}&rating=-1&identifier=com.plexapp.plugins.library&X-Plex-Token=t')
        mock('/__mock/config?loved=none')
        js(page, "() => import('./js/player.js').then(({ player }) => player.pause())")
        ctx.close()

    # ---------- together: Play Together, Dan (host) and Sam (friend) ----------
    if run('together'):
        dan_ctx = browser.new_context(**MOBILE)
        dan = dan_ctx.new_page()
        attach(dan, 'dan')
        login(dan, APP, 't')
        play_first_album_track(dan, APP, album=0, track=0)
        dan.goto(APP + '#/together')
        dan.wait_for_selector('button:has-text("Start a session")')
        check('together: tab is there', dan.locator('#tabs .tab[data-tab=together]').count() == 1)
        note = dan.locator('.together-note').last.inner_text()
        check('together: it says friends need access to the library', 'needs access to Music [Hi-Res]' in note and 'shared with them in Plex' in note, note)
        shot(dan, 'together-01-lobby')
        dan.click('button:has-text("Start a session")')
        dan.wait_for_selector('label.friend')
        names = sorted(dan.locator('label.friend .friend-name').all_text_contents())
        check('together: friends come from plex.tv', names == ['Alex', 'Sam'], str(names))
        check('together: friends without access can\'t be invited',
              dan.locator('label.friend.disabled', has_text='Alex').locator('input').is_disabled())
        shot(dan, 'together-02-invite')
        dan.locator('label.friend', has_text='Sam').locator('input').check()
        dan.click('button.friend-go')
        dan.wait_for_selector('.together-session')
        check('together: session starts with what was playing',
              wait_for(lambda: tg(dan, 't.active && t.session.queue.length >= 5 && t.session.playing') and player(dan, 'p.state') == 'playing', 6),
              player(dan, 'p.state'))
        status = dan.locator('.together-status').inner_text()
        check('together: status line', status.strip().startswith('Live') and 'null' not in status and 'host' in status, status)
        buttons = dan.locator('.together-people .together-actions button').all_inner_texts()
        check('together: the session\'s buttons are together, by Invite friends',
              buttons == ['Invite friends', 'Copy link', 'Leave', 'End for everyone'] and dan.locator('.together-session > .together-actions').count() == 0, str(buttons))

        sam_ctx = browser.new_context(**MOBILE)
        sam = sam_ctx.new_page()
        attach(sam, 'sam')
        login(sam, APP, 't2')
        check('together: invitation shows on the tab',
              wait_for(lambda: sam.locator('#tabs .tab[data-tab=together] .tab-dot:not([hidden])').count() == 1, 15))
        # Sam was listening to something of their own (paused now).
        play_first_album_track(sam, APP, album=3, track=0)
        wait_for(lambda: player(sam, 'p.time > 1'), 8, 0.2)
        player(sam, 'p.pause()')
        own = player(sam, '({ id: p.current.id, playback: p.deck.playback })')
        mock('/__mock/hls?reset=1')
        sam.goto(APP + '#/together')
        sam.wait_for_selector('.together-card:has-text("Dan invited you")')
        shot(sam, 'together-03-invitation')
        sam.click('.together-card button:has-text("Join")')
        sam.wait_for_selector('.together-session')
        same = lambda: player(sam, 'p.current && p.current.sid') == player(dan, 'p.current && p.current.sid')
        check('together: joining plays the same track', wait_for(lambda: same() and player(sam, 'p.state') == 'playing', 10))
        stops = [x for x in mock('/__mock/hls')['MediaContainer']['timelines'] if x['state'] == 'stopped']
        mine = [x for x in stops if x['ratingKey'] == own['id']]
        check('together: ...and Plex hears that what was playing here stopped, as its own playback (and nothing else as no playback)',
              own['playback'] and [x['playback'] for x in mine] == [own['playback']] and not [x for x in stops if not x['playback']], f'{own} {stops}')
        in_sync = lambda: abs(drift(dan)) < 0.5 and abs(drift(sam)) < 0.5
        check('together: both players on the session clock', wait_for(in_sync, 10), f'{drift(dan):.2f}s, {drift(sam):.2f}s')
        gap = abs(player(dan, 'p.time') - player(sam, 'p.time'))
        check('together: both hear the same moment', gap < 0.8, f'{gap:.2f}s apart')
        check('together: Dan sees Sam listening', wait_for(lambda: dan.locator('.together-people .row-title', has_text='Sam').count() == 1, 8))

        sam.click('.together-play')  # pause for everyone
        check('together: pause reaches everyone', wait_for(lambda: not player(dan, 'p.isPlaying'), 8))
        dan.wait_for_timeout(300)
        gap = abs(player(dan, 'p.time') - player(sam, 'p.time'))
        check('together: paused at the same place', gap < 0.6, f'{gap:.2f}s apart')
        player(dan, 'p.seek(8)')
        check('together: seek reaches everyone', wait_for(lambda: abs(player(sam, 'p.time') - 8) < 0.6, 8), str(player(sam, 'p.time')))
        player(dan, 'p.toggle()')
        check('together: play reaches everyone', wait_for(lambda: player(sam, 'p.isPlaying'), 8))
        check('together: in sync after playing again', wait_for(in_sync, 10), f'{drift(dan):.2f}s, {drift(sam):.2f}s')
        before = player(dan, 'p.current.sid')
        player(sam, 'p.next()')
        check('together: a skip reaches everyone',
              wait_for(lambda: player(dan, 'p.current && p.current.sid') != before and same(), 8))

        # Sam adds a track from another album; it shows who added it.
        sam.goto(APP + '#/browse/albums')
        sam.wait_for_selector('.grid .card')
        sam.locator('.grid .card').nth(4).click()
        sam.wait_for_selector('.hero-album')
        sam.locator('.album-tracks .track .track-more').first.click()
        sam.click('.sheet.open .sheet-action:has-text("Add to queue")')
        added = lambda: tg(dan, "(t.session.queue.find(q => q.addedBy && q.addedBy.title === 'Sam') || {}).sid || null")
        check('together: a friend can add to the queue', wait_for(added, 8))
        sid = added()
        dan.goto(APP + '#/together')
        dan.wait_for_selector('.together-queue .track')
        check('together: Up next says who added it', dan.locator('.together-queue .track-sub', has_text='added by Sam').count() == 1)
        shot(dan, 'together-04-session')
        qi = tg(dan, f"t.session.queue.findIndex(q => q.sid === {json.dumps(sid)})")
        dan.click(f'.together-queue .track[data-qid="{qi}"] .together-remove')
        check('together: removing reaches everyone',
              wait_for(lambda: not tg(sam, f"t.session.queue.some(q => q.sid === {json.dumps(sid)})"), 8))

        sam.click('.pb-main')
        sam.wait_for_selector('.np.open')
        check('together: Now Playing shows who\'s listening', 'Listening with Dan' in sam.locator('.np-listeners').inner_text())
        check('together: repeat and Guest DJ are off in a session',
              sam.locator('.np-tool[data-tool=repeat].unavailable').count() == 1 and sam.locator('.np-tool[data-tool=dj].unavailable').count() == 1)
        shot(sam, 'together-05-now-playing')
        sam.keyboard.press('Escape')
        sam.wait_for_timeout(400)

        # A track change by the clock alone (the mock's tracks are 20 s long).
        cur = player(dan, 'p.current.sid')
        check('together: the next track starts for everyone on time',
              wait_for(lambda: player(dan, 'p.current.sid') != cur and same() and in_sync(), 30), f'{drift(dan):.2f}s, {drift(sam):.2f}s')

        sam.reload()
        check('together: a reload picks the session up again', wait_for(lambda: tg(sam, 't.active') and same(), 15))

        # The host leaves: Sam takes over, and the music carries on.
        dan.goto(APP + '#/together')
        dan.wait_for_selector('.together-actions')
        dan.click('.together-actions button:has-text("Leave")')
        dan.click('.sheet.open .sheet-action:has-text("Leave")')
        check('together: when the host leaves, hosting passes on', wait_for(lambda: tg(sam, 't.isHost'), 8))
        check('together: Dan keeps the queue to carry on with', player(dan, '!p.remote && p.queue.length > 0'))
        sam.goto(APP + '#/together')
        sam.wait_for_selector('.together-actions')
        check('together: the new host can end it', sam.locator('button:has-text("End for everyone")').count() == 1)
        sam.click('button:has-text("End for everyone")')
        sam.click('.sheet.open .sheet-action:has-text("End session")')
        check('together: ending the session', wait_for(lambda: not tg(sam, 't.active'), 8))
        sam.wait_for_selector('button:has-text("Start a session")')
        shot(sam, 'together-06-ended')
        sam_ctx.close()
        dan_ctx.close()

    # ---------- settings: Settings › Experience ----------
    if run('settings'):
        ctx = browser.new_context(**MOBILE)
        page = ctx.new_page()
        attach(page, 'settings')
        requests = []
        page.on('request', lambda r: requests.append(r.url))
        login(page, APP)
        page.goto(APP + '#/settings')
        page.click('a.row:has-text("Experience")')
        page.wait_for_selector('.back-title:has-text("Experience")')
        shot(page, 'settings-01-experience')
        choose(page, 'Font size', 'Larger')
        check('settings: font size', js(page, "() => getComputedStyle(document.documentElement).getPropertyValue('--fs').trim()") == '1.25')
        choose(page, 'Grid size', 'Large')
        check('settings: grid size', js(page, '() => document.body.dataset.grid') == 'large')
        choose(page, 'Rating system', 'Thumbs')
        choose(page, 'Top plays list size', '10')
        page.click('.row:has-text("Player name")')
        page.fill('.sheet.open input', 'Kitchen speaker')
        page.click('.sheet.open button:has-text("Save")')
        page.wait_for_timeout(400)
        settings(page, {'fontSize': 'normal', 'gridSize': 'normal'})

        page.goto(APP + '#/settings/player')
        page.wait_for_selector('.back-title:has-text("Player")')
        toggle(page, 'Show volume control', False)
        toggle(page, 'Show album year', False)
        toggle(page, 'Music quick skip', True)
        toggle(page, 'Music playback speed', True)
        shot(page, 'settings-02-player')
        page.goto(APP + '#/settings/skip')
        choose(page, 'Skip back', '15 seconds')

        requests.clear()
        play_first_album_track(page, APP, album=2, track=0)
        page.wait_for_timeout(500)
        check('settings: player name sent to Plex', any('X-Plex-Device-Name=Kitchen+speaker' in u or 'X-Plex-Device-Name=Kitchen%20speaker' in u for u in requests))
        check('settings: what\'s playing in the tab title', player(page, 'p.current.title') in js(page, '() => document.title'))
        page.click('.pb-main')
        page.wait_for_selector('.np.open')
        page.wait_for_timeout(500)
        check('settings: thumbs rating', page.locator('.np-stars[data-mode=thumbs] .thumb').count() == 2)
        check('settings: volume control hidden', page.locator('.np .volume').first.is_hidden())
        check('settings: album year hidden', '(' not in page.locator('.np-album').inner_text(), page.locator('.np-album').inner_text())
        back = page.locator('.np-jump[aria-label="Back 15 seconds"]')
        check('settings: quick skip buttons', back.is_visible() and page.locator('.np-jump[aria-label="Forward 30 seconds"]').is_visible())
        check('settings: speed button', page.locator('.np-tool[data-tool=speed]').is_visible())
        player(page, 'p.seek(17)')
        page.wait_for_timeout(300)
        back.click()
        page.wait_for_timeout(300)
        t = player(page, 'p.time')
        check('settings: skip back jumps 15 seconds', 1 <= t <= 4, f'{t:.1f}s')
        shot(page, 'settings-03-now-playing')
        page.click('.np-tool[data-tool=speed]')
        page.click('.sheet.open .sheet-action:has-text("1.25×")')
        check('settings: playback speed', abs(player(page, 'p.audio.playbackRate') - 1.25) < 0.01)
        page.keyboard.press('Escape')
        page.wait_for_timeout(400)

        # Album pages: codec badge and popular tracks.
        page.goto(APP + '#/browse/albums')
        page.wait_for_selector('.grid .card')
        page.locator('.grid .card').nth(2).click()
        page.wait_for_selector('.hero-album')
        check('settings: album codec badge', wait_for(lambda: page.locator('.codec-badge').count() == 1 and page.locator('.codec-badge').inner_text().startswith('FLAC'), 5))
        check('settings: popular tracks marked', page.locator('.album-tracks .popular-badge').count() >= 1)
        # 1-tap playback off: tapping a track while one plays asks what to do.
        settings(page, {'oneTapPlayback': False})
        page.locator('.album-tracks .track-main').nth(1).click()
        check('settings: 1-tap playback off asks first', page.wait_for_selector('.sheet.open .sheet-action:has-text("Play next")', timeout=3000) is not None)
        page.keyboard.press('Escape')
        page.wait_for_timeout(300)
        settings(page, {'codecInfo': False, 'previewButtons': True, 'oneTapPlayback': True})
        page.reload()
        page.wait_for_selector('.hero-album')
        check('settings: with Show codec information off, no codec badge on the album page', page.locator('.codec-badge').count() == 0)
        album_url = page.url
        settings(page, {'codecInfo': True})
        # 0.24.0's four codec settings are one: off where they all were. And
        # live updates are no setting of a device's now.
        mig = js(page, "() => import('./js/state.js').then(({ migrateSettings }) => [migrateSettings({ version: 3, codecBadges: false, coverBadges: false, searchCodecs: false, showCodec: false, liveUpdates: 'nows' }),"
                       " migrateSettings({ version: 3, codecBadges: true, coverBadges: false, searchCodecs: false, showCodec: false }), migrateSettings({ version: 4, codecInfo: true }),"
                       " migrateSettings({ version: 3, codecBadges: false, searchCodecs: false, showCodec: false })])")
        check('settings: 0.24.0\'s four codec settings become Show codec information, off only where all four were (and Live updates goes)',
              mig[0].get('codecInfo') is False and not any(k in mig[0] for k in ('codecBadges', 'coverBadges', 'searchCodecs', 'showCodec', 'liveUpdates'))
              and 'codecInfo' not in mig[1] and mig[2].get('codecInfo') is True and 'codecInfo' not in mig[3], str(mig))
        page.goto(APP + '#/settings/experience')
        page.wait_for_selector('label.toggle-row:has-text("Show codec information")')
        old_rows = [t for t in page.locator('.toggle-row').all_inner_texts() if any(w in t for w in ('codec badges', 'formats in search'))]
        check('settings: one switch for codec information (Settings › Experience), none of the four there were', not old_rows, str(old_rows))
        page.goto(album_url)
        page.wait_for_selector('.hero-album')
        page.locator('.album-tracks .track-main').first.click()  # the reload stopped playback
        playing = wait_for(lambda: player(page, "p.state === 'playing' && p.time > 0.3"), 20)
        how = lambda: player(page, '({ state: p.state, t: p.time, index: p.index, id: p.current?.id })')
        before = how()
        page.locator('.album-tracks .track-preview').nth(2).click()
        check('settings: preview plays without touching the queue',
              playing and wait_for(lambda: not player(page, 'p.isPlaying'), 5) and page.locator('.track-preview.on').count() == 1, f'{before} {how()}')
        page.locator('.album-tracks .track-preview.on').click()
        check('settings: playback carries on after a preview', wait_for(lambda: player(page, 'p.isPlaying'), 5), f'{before} {how()}')

        settings(page, {'backgroundStyle': 'artwork'})
        check('settings: blurred artwork background', wait_for(lambda: js(page, "() => !!document.querySelector('#backdrop .ub.on.ub-art')"), 5))
        settings(page, {'backgroundStyle': 'plain'})
        check('settings: plain background', wait_for(lambda: js(page, "() => document.querySelector('#backdrop .ub.on').style.background.includes('var(--bg)')"), 5))
        settings(page, {'showFullPlayer': True})
        page.locator('.album-tracks .track-main').nth(3).click()
        check('settings: show full player when playback starts', page.wait_for_selector('.np.open', timeout=5000) is not None)
        page.keyboard.press('Escape')
        page.wait_for_timeout(400)

        page.goto(APP + '#/top/tracks')
        page.wait_for_selector('.tracks .track')
        n = page.locator('.tracks .track').count()
        check('settings: top plays list size', n == 10, f'{n} rows')
        page.goto(APP + '#/playlists')
        page.wait_for_selector('.grid .card')
        before = page.locator('.card-title').all_text_contents()
        settings(page, {'playlistsAllLibraries': False})
        page.reload()
        page.wait_for_selector('.grid .card')
        after = page.locator('.card-title').all_text_contents()
        check('settings: playlists from this library only', 'Bedtime stories' in before and 'Bedtime stories' not in after, f'{before} / {after}')
        settings(page, {'playlistsAllLibraries': True})
        page.goto(APP + '#/settings/experience')
        page.wait_for_selector('.rows-group:not([hidden]) .toggle-row', timeout=10000)
        libs = page.locator('.rows-group .toggle-row').all_inner_texts()
        check('settings: with two music libraries, the library settings say which', len(libs) == 2 and all('Audiobooks' in t for t in libs), str(libs))

        # The codec (Show codec information, for the whole app) and the
        # rating are separate settings.
        if not player(page, '!!p.current'):
            play_first_album_track(page, APP)
        page.goto(APP + '#/settings/experience')
        page.wait_for_selector('label.toggle-row:has-text("Show codec information")')
        toggle(page, 'Show codec information', False)
        page.click('.pb-main')
        page.wait_for_selector('.np.open')
        page.wait_for_timeout(400)
        check('settings: the codec can be hidden in the player too, keeping the rating', not page.locator('.np-codec').is_visible() and page.locator('.np-stars').is_visible())
        page.keyboard.press('Escape')
        page.wait_for_selector('.np.open', state='detached')
        toggle(page, 'Show codec information', True)
        page.goto(APP + '#/settings/player')
        page.wait_for_selector('label.toggle-row:has-text("Show rating")')
        check('settings: ...with no switch of its own for the codec in Settings › Player', page.locator('label.toggle-row', has_text='Show codec').count() == 0)
        toggle(page, 'Show rating', False)
        page.click('.pb-main')
        page.wait_for_selector('.np.open')
        page.wait_for_timeout(400)
        check('settings: ...and the rating, keeping the codec', page.locator('.np-codec').is_visible() and not page.locator('.np-stars').is_visible())
        page.keyboard.press('Escape')
        page.wait_for_selector('.np.open', state='detached')
        toggle(page, 'Show rating', True)
        player(page, 'p.pause()')
        # About: the version is the newest one in the changelog, with a link to it.
        with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'CHANGELOG.md')) as f:
            newest = next(line.split()[1] for line in f if line.startswith('## '))
        page.goto(APP + '#/settings/about')
        page.wait_for_selector('.about-version')
        shown = page.locator('.about-version').inner_text()
        link = page.locator('.about-links a', has_text='What’s new').get_attribute('href')
        check('settings: About shows the version, with what\'s new', shown == f'Version {newest}' and link.endswith('/CHANGELOG.md'), f'{shown} {link}')
        ctx.close()

    # ---------- home: Home screen sections and Collections ----------
    if run('home'):
        ctx = browser.new_context(**MOBILE)
        page = ctx.new_page()
        attach(page, 'home')
        login(page, APP)
        order = sections_on_home(page)
        check('home: Collections on Home', 'collections' in order, str(order))
        cards = page.locator('section[data-section=collections] .card')
        check('home: collections shown like playlists',
              cards.count() >= 4 and page.locator('section[data-section=collections] .shelf .card-art .card-play').count() == cards.count()
              and page.locator('section[data-section=recentPlaylists] .shelf .card').count() > 0)
        subs = page.locator('section[data-section=collections] .card-sub').all_text_contents()
        check('home: collection cards say what they hold', subs and all(s.split()[-1].rstrip('s') in ('album', 'artist', 'track') for s in subs), str(subs))
        shot(page, 'home-01-home')
        mix = page.locator('section[data-section=mixes] .mix-card').first
        check('cards: a mix keeps its buttons on touch screens',
              mix.locator('.card-actions').evaluate('e => getComputedStyle(e).opacity') == '1' and mix.locator('.card-shuffle').count() == 1)
        album = page.locator('section[data-section=recentlyAdded] .card').first
        album.scroll_into_view_if_needed()
        album.locator('.card-art').tap()
        page.wait_for_selector('.hero-album')
        check('cards: tapping a card opens it (the hidden buttons don\'t catch the tap)',
              page.evaluate('location.hash').startswith('#/album/') and player(page, 'p.state') != 'playing', page.evaluate('location.hash'))
        page.go_back()
        page.wait_for_selector('section[data-section=collections] .card')
        page.locator('section[data-section=collections] .card').first.click()
        page.wait_for_selector('.hero-album')
        page.click('.hero-actions button:has-text("Play")')
        check('home: a collection plays', wait_for(lambda: player(page, "p.state === 'playing' && p.context.href.startsWith('/collection/')"), 10))
        page.goto(APP + '#/')
        page.wait_for_selector('section[data-section=stations] .station')
        check('home: Stations', page.locator('section[data-section=stations] .station').count() == 5)
        page.click('section[data-section=stations] .station:has-text("Time travel radio")')
        check('home: a station plays', wait_for(lambda: player(page, "p.state === 'playing' && p.context.title.startsWith('Time travel')"), 10))

        # Two albums nobody has played for a while, for "Haven't played in".
        albums = mock('/library/sections/1/all?type=9&sort=titleSort&X-Plex-Token=t')['MediaContainer']['Metadata']
        for al in albums[-2:]:
            mock(f"/__mock/age?id={al['ratingKey']}&days=200")
        page.goto(APP + '#/settings/home')
        page.wait_for_selector('.home-row')
        shot(page, 'home-02-editor')
        sheet_action(page, '.home-row[data-id=recentPlays] .home-row-main', 'Hide from Home')
        sheet_action(page, '.home-row[data-id=decade2020] .home-row-main', 'Show on Home')
        sheet_action(page, '.home-row[data-id=topAlbums] .home-row-main', 'Over all time')
        sheet_action(page, '.home-row[data-id=notPlayed] .home-row-main', 'Show on Home')
        # Drag Collections to the top by its handle.
        page.evaluate('window.scrollTo(0, 0)')
        page.wait_for_timeout(200)
        handle = page.locator('.home-row[data-id=collections] .drag-handle')
        top = page.locator('.home-row').first.bounding_box()
        box = handle.bounding_box()
        page.mouse.move(box['x'] + box['width'] / 2, box['y'] + box['height'] / 2)
        page.mouse.down()
        for step in range(1, 13):
            page.mouse.move(box['x'] + box['width'] / 2, box['y'] + (top['y'] - 12 - box['y']) * step / 12)
            page.wait_for_timeout(30)
        page.mouse.up()
        page.wait_for_timeout(300)
        first = page.locator('.home-row').first.get_attribute('data-id')
        check('home: sections can be dragged into order', first == 'collections', first)
        shot(page, 'home-03-editor-changed')
        order = sections_on_home(page)
        heads = page.locator('section.block[data-section] .section-head h2').all_text_contents()
        check('home: hidden sections are gone', 'recentPlays' not in order, str(order))
        check('home: order follows the editor', order[:1] == ['collections'], str(order))
        check('home: Best of the 20s', 'decade2020' in order, str(order))
        check('home: a section\'s period changes its title', any('Top albums from all time' in t for t in heads), str(heads))
        check('home: Haven\'t played in …', 'notPlayed' in order, str(order))
        shot(page, 'home-04-custom')
        page.goto(APP + '#/settings/home')
        page.wait_for_selector('.home-row')
        page.click('button:has-text("Reset order")')
        order = sections_on_home(page)
        check('home: reset brings the defaults back', order[:3] == ['mixes', 'recentPlays', 'recentPlaylists'] and 'decade2020' not in order, str(order))
        ctx.close()

    # ---------- formats: albums' formats over their covers, and the player's ----------
    # The mock's tracks are FLAC: 24/96 those with an odd id, 16/44.1 the
    # rest (an album's badge is its first track's); /__mock/config?codec=
    # makes some MP3 here, for an album that's all MP3 and one of each.
    if run('formats'):
        ctx = browser.new_context(viewport={'width': 1280, 'height': 900})
        page = ctx.new_page()
        attach(page, 'formats')
        asked = []
        page.on('request', lambda r: asked.append(r.url))
        login(page, APP)
        all_albums = {a['title']: a for a in mock('/library/sections/1/all?type=9&X-Plex-Container-Size=500&X-Plex-Token=t')['MediaContainer']['Metadata']}

        def khz(hz):
            return f'{hz / 1000:.1f}'.rstrip('0').rstrip('.')

        def kids(album_id):
            return [m for m in mock(f'/library/metadata/{album_id}/children?X-Plex-Token=t')['MediaContainer']['Metadata'] if m['type'] == 'track']

        def stream(track_id):
            d = mock(f'/library/metadata/{track_id}?X-Plex-Token=t')['MediaContainer']['Metadata'][0]
            return next(x for x in d['Media'][0]['Part'][0]['Stream'] if x['streamType'] == 2)

        def expected(album_id):
            ts = kids(album_id)
            codecs = {m['Media'][0]['audioCodec'] for m in ts}
            if len(codecs) > 1:
                return ['Mixed', False]
            if codecs == {'mp3'}:
                return ['MP3', False]
            a = stream(ts[0]['ratingKey'])
            return [f"FLAC {a['bitDepth']}/{khz(a['samplingRate'])}", a['bitDepth'] > 16 or a['samplingRate'] > 48000]

        def covers():
            return page.locator('.grid .card').evaluate_all('cs => cs.map((c) => [c.getAttribute("href").split("/").pop(), c.querySelector(".cover-badge")?.textContent ?? null, !!c.querySelector(".cover-badge.hires")])')

        looked_up = lambda ids: [u for u in asked if re.search(r'/library/metadata/(\d+)/children', u) and re.search(r'/library/metadata/(\d+)/children', u).group(1) in ids]
        details = lambda: [u for u in asked if re.search(r'/library/metadata/[\d,]+(\?|$)', u)]
        try:
            mock('/__mock/config?codec=' + ','.join(f"{t['ratingKey']}:mp3" for t in kids(all_albums['Interference']['ratingKey']))
                 + f",{kids(all_albums['Paper Boats']['ratingKey'])[-1]['ratingKey']}:mp3")
            # Only what's in view (and a little beyond) is looked up, each
            # album once.
            page.set_viewport_size({'width': 1280, 'height': 300})
            page.goto(APP + '#/browse/albums')
            page.wait_for_selector('.grid .card')
            del asked[:]
            ids = page.locator('.grid .card').evaluate_all('cs => cs.map((c) => c.getAttribute("href").split("/").pop())')
            check('formats: (the mock\'s albums are one page of the list)', 6 < len(ids) < 60, len(ids))
            wait_for(lambda: page.locator('.cover-badge').count() >= 6, 10)
            page.wait_for_timeout(1500)
            first = covers()
            seen = looked_up(ids)
            check('formats: covers get their format as they come into view, not all at once',
                  6 <= len([c for c in first if c[1]]) < len(ids) and first[-1][1] is None and len(seen) == len(set(seen)) < len(ids),
                  f'{len([c for c in first if c[1]])} of {len(ids)} badges, {len(seen)} looked up')
            page.set_viewport_size({'width': 1280, 'height': 900})
            page.mouse.move(700, 450)
            for _ in range(20):  # down a screenful at a time, giving each a moment in view
                if page.locator('.cover-badge').count() >= len(ids):
                    break
                page.mouse.wheel(0, 600)
                page.wait_for_timeout(700)
            wait_for(lambda: page.locator('.cover-badge').count() == len(ids), 10)
            got = covers()
            want = [[i, *expected(i)] for i in ids]
            check('formats: every album cover says its format, as its tracks are (high resolution in gold)', got == want, f'{got} != {want}')
            seen = looked_up(ids)
            check('formats: ...asking about each album once, and its first track\'s details at most once',
                  len(seen) == len(set(seen)) == len(ids) and len(details()) <= len(ids), f'{len(seen)} lookups, {len(details())} detail requests for {len(ids)} albums')
            mixed = page.locator(f'.grid .card[href="#/album/{all_albums["Paper Boats"]["ratingKey"]}"] .cover-badge').get_attribute('title')
            check('formats: a cover with several formats says so', mixed == 'Mixed formats', mixed)
            shot(page, 'formats-01-covers')
            # Shown again, the page has them at once (they're kept).
            del asked[:]
            page.goto(APP + '#/')
            page.wait_for_selector('section.block[data-section]')
            page.goto(APP + '#/browse/albums')
            page.wait_for_selector('.grid .card')
            page.wait_for_timeout(300)
            check('formats: ...and kept: shown again, there\'s no asking again',
                  page.locator('.cover-badge').count() == len(ids) and not looked_up(ids), len(looked_up(ids)))
            # An album page: its badge as before, and the covers of the rest.
            page.locator(f'.grid .card[href="#/album/{all_albums["Interference"]["ratingKey"]}"]').click()
            page.wait_for_selector('.hero-album .codec-badge')
            check('formats: an album page says the same as its cover', page.locator('.hero-album .codec-badge').inner_text() == 'MP3',
                  page.locator('.hero-album .codec-badge').inner_text())
            page.goto(APP + f'#/album/{all_albums["Paper Boats"]["ratingKey"]}')
            page.wait_for_selector('.hero-album .codec-badge')
            check('formats: ...“Mixed formats” there', page.locator('.hero-album .codec-badge').inner_text() == 'Mixed formats')
            # Search: albums' formats before their artist, as tracks' are.
            page.goto(APP + '#/search')
            page.fill('.search-box input', 'Lantern')
            page.wait_for_selector('.search-body .album-row')
            wait_for(lambda: page.locator('.search-body .album-row .track-codec').count() > 0, 8)
            rows = page.locator('.search-body .album-row').evaluate_all('rs => rs.map((r) => [r.querySelector("a").getAttribute("href").split("/").pop(), r.querySelector(".track-codec")?.textContent ?? null, !!r.querySelector(".track-codec.hires")])')
            check('formats: albums in search say their format too', rows and all(r == [r[0], *expected(r[0])] for r in rows), str(rows))
            # The player: the file's badge ("FLAC 24/96", "MP3 320"), and the
            # rating to its right.
            page.goto(APP + f'#/album/{all_albums["Low Light Signals"]["ratingKey"]}')
            page.wait_for_selector('.hero-album')
            for i in range(2):
                if i:
                    page.keyboard.press('Escape')
                    page.wait_for_selector('.np.open', state='detached')
                page.locator('.album-tracks .track-main').nth(i).click()
                wait_for(lambda: player(page, "p.state === 'playing'"), 10)
                a = stream(player(page, 'p.current.id'))
                page.click('.pb-main')
                page.wait_for_selector('.np.open')
                want = f"FLAC {a['bitDepth']}/{khz(a['samplingRate'])}"
                wait_for(lambda: page.locator('.np-codec').inner_text() == want, 8)
                hires = 'hires' in (page.locator('.np-codec').get_attribute('class') or '')
                check(f"formats: the player shows the file's badge ({want})", page.locator('.np-codec').inner_text() == want and hires == (a['bitDepth'] > 16),
                      f"{page.locator('.np-codec').inner_text()!r} hires={hires}")
            # (Measured together: the player may still be sliding into place.)
            badge, stars = page.evaluate("() => ['.np-codec', '.np-stars'].map((s) => { const r = document.querySelector(s).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })")
            check('formats: ...with the rating to its right, on one line',
                  badge['x'] + badge['width'] <= stars['x'] and abs((badge['y'] + badge['height'] / 2) - (stars['y'] + stars['height'] / 2)) < 4, f'{badge} {stars}')
            shot(page, 'formats-02-player')
            settings(page, {'quality': '320'})
            page.wait_for_selector('.np.open .np-codec.converted', timeout=10000)
            chip, stars = page.evaluate("() => ['.np-quality', '.np-stars'].map((s) => { const r = document.querySelector(s).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })")
            check('formats: converted as it plays, the badge steps back for what it plays at (before the rating)',
                  page.locator('.np-quality').inner_text().strip() == '320 kbps' and chip['x'] + chip['width'] <= stars['x'],
                  page.locator('.np-quality').inner_text())
            settings(page, {'quality': 'original'})
            page.keyboard.press('Escape')
            page.wait_for_selector('.np.open', state='detached')
            page.goto(APP + f'#/album/{all_albums["Interference"]["ratingKey"]}')
            page.wait_for_selector('.hero-album')
            page.locator('.album-tracks .track-main').first.click()
            wait_for(lambda: player(page, "p.state === 'playing'"), 10)
            page.click('.pb-main')
            page.wait_for_selector('.np.open')
            check('formats: a lossy file\'s badge has its bitrate', wait_for(lambda: page.locator('.np-codec').inner_text() == 'MP3 320', 8), page.locator('.np-codec').inner_text())
            page.keyboard.press('Escape')
            page.wait_for_selector('.np.open', state='detached')
            player(page, 'p.pause()')
            # Turned off (Settings › Experience › Show codec information):
            # none, and nothing's asked.
            settings(page, {'codecInfo': False})
            page.goto(APP + '#/browse/albums')
            page.reload()
            page.wait_for_selector('.grid .card')
            del asked[:]
            page.wait_for_timeout(1500)
            check('formats: covers\' badges go with Show codec information', page.locator('.cover-badge').count() == 0 and not looked_up(ids), len(looked_up(ids)))
        finally:
            mock('/__mock/config?codec=reset')
            settings(page, {'codecInfo': True})
        ctx.close()

    # ---------- select: albums' menus, and choosing several ----------
    if run('select'):
        ctx = browser.new_context(viewport={'width': 1280, 'height': 900})
        page = ctx.new_page()
        attach(page, 'select')
        login(page, APP)
        album_tracks = lambda aid: [m['ratingKey'] for m in mock(f'/library/metadata/{aid}/children?X-Plex-Token=t')['MediaContainer']['Metadata'] if m['type'] == 'track']
        card_ids = lambda sel: page.locator(sel).evaluate_all('cs => cs.map((c) => c.getAttribute("href").split("/").pop())')
        chosen = lambda: page.locator('.chosen').count()
        count_text = lambda: page.locator('.select-count').inner_text() if page.locator('.select-bar').count() else None

        def sheet_labels():
            page.wait_for_selector('.sheet.open')
            return page.locator('.sheet.open .sheet-action-label').all_text_contents()

        def pick(label):
            page.locator('.sheet.open .sheet-action', has_text=label).first.click()
            page.wait_for_selector('.sheet', state='detached')

        play_first_album_track(page, APP)
        player(page, 'p.pause()')
        # An album cover's menu, from the corner of its artwork.
        page.goto(APP + '#/browse/albums')
        page.wait_for_selector('.grid .card')
        card = page.locator('.grid .card').nth(1)
        card.hover()
        page.wait_for_timeout(300)
        art = card.locator('.card-art').bounding_box()
        more = card.locator('.card-more').bounding_box()
        check('select: an album cover has a menu button in its corner (on hover)',
              card.locator('.card-more').is_visible() and more['x'] > art['x'] + art['width'] / 2 and more['y'] < art['y'] + art['height'] / 3, f'{more} in {art}')
        card.locator('.card-more').click()
        labels = sheet_labels()
        check('select: ...with Play next, Add to queue, Add to playlist and Select',
              all(x in labels for x in ('Play next', 'Add to queue', 'Add to playlist…', 'Select', 'Go to album')), str(labels))
        before = player(page, 'p.queue.length')
        aid = card_ids('.grid .card')[1]
        pick('Add to queue')
        check('select: ...and Add to queue adds the album', wait_for(lambda: player(page, 'p.queue.length') == before + len(album_tracks(aid)), 5)
              and player(page, 'p.queue.slice(-1)[0].id') == album_tracks(aid)[-1] and page.evaluate('location.hash') == '#/browse/albums',
              f"{before} -> {player(page, 'p.queue.length')}")
        page.mouse.move(5, 5)

        # Ctrl-click starts choosing, without opening the album; Shift-click
        # chooses everything from the last one.
        ids = card_ids('.grid .card')
        page.locator('.grid .card').nth(0).click(modifiers=['ControlOrMeta'])
        page.wait_for_selector('.select-bar')
        check('select: Ctrl-click chooses an album, and doesn\'t open it',
              count_text() == '1 album' and page.locator('.select-hint').is_visible() and page.evaluate('location.hash') == '#/browse/albums', count_text())
        page.locator('.grid .card').nth(3).click(modifiers=['Shift'])
        check('select: Shift-click chooses the ones in between', count_text() == '4 albums' and chosen() == 4 and not page.locator('.select-hint').is_visible(), count_text())
        page.locator('.grid .card').nth(2).click()
        page.locator('.grid .card').nth(5).click()
        check('select: while choosing, a click chooses or lets go', count_text() == '4 albums' and page.evaluate('location.hash') == '#/browse/albums'
              and page.locator('.grid .card.chosen').evaluate_all('cs => cs.map((c) => c.getAttribute("href").split("/").pop())') == [ids[0], ids[1], ids[3], ids[5]], count_text())
        shot(page, 'select-01-albums')
        # Sorted another way, it's the same list: what's chosen stays chosen.
        page.click('button[aria-label="Sort"]')
        pick('Artist')
        page.wait_for_selector('.grid .card')
        wait_for(lambda: page.locator('.grid .card.chosen').count() == 4, 5)
        check('select: sorting the list another way keeps what\'s chosen', count_text() == '4 albums' and page.locator('.grid .card.chosen').count() == 4, count_text())
        page.click('button[aria-label="Sort"]')
        pick('Name')
        page.wait_for_selector('.grid .card')
        wait_for(lambda: page.locator('.grid .card.chosen').count() == 4, 5)
        before = player(page, 'p.queue.length')
        # (Tapped twice: the second, while it gets the tracks, does nothing.)
        page.evaluate("() => { const b = document.querySelector('.select-btn[aria-label=\"Add to queue\"]'); b.click(); b.click(); }")
        want = [t for i in (0, 1, 3, 5) for t in album_tracks(ids[i])]
        check('select: Add to queue adds them all, in the order they\'re on the page (once, tapped twice)',
              wait_for(lambda: player(page, 'p.queue.length') == before + len(want), 8) and player(page, f'p.queue.slice(-{len(want)}).map((t) => t.id)') == want
              and page.locator('.toast', has_text=f'Added {len(want)} tracks to the queue').count() > 0
              and (page.wait_for_timeout(800) or player(page, 'p.queue.length') == before + len(want)), player(page, 'p.queue.length'))
        check('select: ...and then stops choosing', page.locator('.select-bar').count() == 0 and chosen() == 0 and not js(page, "() => document.body.classList.contains('selecting')"))

        # Tracks: chosen the same way; Select all; into a new playlist.
        page.goto(APP + f'#/album/{ids[2]}')
        page.wait_for_selector('.album-tracks .track')
        rows = album_tracks(ids[2])
        page.locator('.album-tracks .track').nth(1).click(modifiers=['ControlOrMeta'])
        page.locator('.album-tracks .track').nth(3).click(modifiers=['Shift'])
        check('select: tracks are chosen the same way', count_text() == '3 tracks' and player(page, "p.state") != 'playing', count_text())
        shot(page, 'select-02-tracks')
        page.click('.select-btn[aria-label="More"]')
        labels = sheet_labels()
        check('select: More has Play, Select all and (for the server\'s admin) Add to collection',
              all(x in labels for x in ('Play', 'Shuffle', 'Add to playlist…', 'Add to collection…', 'Select all', 'Stop choosing')), str(labels))
        pick('Select all')
        check('select: Select all chooses the whole list', count_text() == f'{len(rows)} tracks' and chosen() == len(rows), count_text())
        labels = page.locator('.album-tracks .track .track-main').evaluate_all('bs => bs.map((b) => [b.getAttribute("aria-label"), b.getAttribute("aria-pressed")])')
        check('select: ...and a screen reader hears "Choose …", pressed', all(l.startswith('Choose ') and p == 'true' for l, p in labels), str(labels[:2]))
        page.click('.select-btn[aria-label="Add to playlist"]')
        page.wait_for_selector('.sheet.open .sheet-action:has-text("New playlist")')
        page.locator('.sheet.open .sheet-action', has_text='New playlist').click()
        page.wait_for_selector('.sheet.open .ask-form input')
        page.wait_for_timeout(250)
        page.fill('.sheet.open .ask-form input', 'Select test')
        page.click('.sheet.open .ask-form button[type=submit]')
        made = wait_for(lambda: next((p for p in mock('/playlists?X-Plex-Token=t&X-Plex-Container-Size=500')['MediaContainer'].get('Metadata', []) if p['title'] == 'Select test'), None), 8)
        items = [m['ratingKey'] for m in mock(f"/playlists/{made['ratingKey']}/items?X-Plex-Token=t")['MediaContainer'].get('Metadata', [])] if made else []
        check('select: ...and into a new playlist, in order', items == rows, f'{items} != {rows}')
        check('select: ...and stops choosing once it\'s made', page.locator('.select-bar').count() == 0)

        # Select, in a track's menu; Esc stops; so does another page.
        page.locator('.album-tracks .track-more').nth(0).click()
        pick('Select')
        check('select: a track\'s menu has Select', count_text() == '1 track' and page.locator('.album-tracks .track').nth(0).evaluate('r => r.classList.contains("chosen")'))
        page.keyboard.press('Escape')
        check('select: Esc stops choosing', page.locator('.select-bar').count() == 0 and chosen() == 0)
        page.locator('.album-tracks .track').nth(0).click(modifiers=['ControlOrMeta'])
        page.wait_for_selector('.select-bar')
        page.locator('.hero-link').click()
        page.wait_for_selector('.hero-artist')
        check('select: another page stops choosing', page.locator('.select-bar').count() == 0 and not js(page, "() => document.body.classList.contains('selecting')"))
        # Search: an album's menu (⋯); tracks and albums together (but a
        # collection holds one kind); and what's chosen stays chosen as the
        # search changes, so songs from several searches go in together.
        page.goto(APP + '#/search')
        page.fill('.search-box input', 'Lantern')
        page.wait_for_selector('.search-body .album-row')
        page.locator('.search-body .album-row .row-more').first.click()
        labels = sheet_labels()
        check('select: albums in search have a menu', all(x in labels for x in ('Play next', 'Add to queue', 'Add to playlist…', 'Select')), str(labels))
        page.keyboard.press('Escape')
        page.wait_for_selector('.sheet', state='detached')
        first_track = page.locator('.search-body .track').first.get_attribute('data-track-id')
        page.locator('.search-body .track').first.click(modifiers=['ControlOrMeta'])
        page.locator('.search-body .album-row').first.click(modifiers=['ControlOrMeta'])
        check('select: tracks and albums can be chosen together', count_text() == '1 album and 1 track', count_text())
        page.click('.select-btn[aria-label="More"]')
        labels = sheet_labels()
        check('select: ...though not into a collection then', 'Add to collection…' not in labels and 'Add to playlist…' in labels, str(labels))
        page.keyboard.press('Escape')
        page.wait_for_selector('.sheet', state='detached')
        page.fill('.search-box input', 'Signal')
        wait_for(lambda: page.locator('.search-body .track').count() > 0 and page.locator(f'.search-body .track[data-track-id="{first_track}"]').count() == 0, 8)
        page.locator('.search-body .track').first.click()
        check('select: a new search keeps what\'s chosen, and adds to it', count_text() == '1 album and 2 tracks', count_text())
        page.fill('.search-box input', 'Lantern')
        wait_for(lambda: page.locator(f'.search-body .track[data-track-id="{first_track}"]').count() > 0, 8)
        check('select: ...showing it chosen again where it turns up',
              page.locator(f'.search-body .track[data-track-id="{first_track}"]').first.evaluate('r => r.classList.contains("chosen")'))
        page.locator('.search-box input').focus()
        page.keyboard.press('Escape')  # (empties the search box, first)
        page.keyboard.press('Escape')
        check('select: Esc stops choosing from the search box too', page.locator('.select-bar').count() == 0, count_text())

        # Not the queue's own rows, nor an unlocked playlist's (unlocking it
        # stops choosing).
        page.goto(APP + f"#/playlist/{made['ratingKey']}")
        page.wait_for_selector('.tracks .track')
        page.locator('.tracks .track').nth(0).click(modifiers=['ControlOrMeta'])
        page.wait_for_selector('.select-bar')
        page.click('.lock-btn')
        page.wait_for_selector('.view.is-editing')
        check('select: unlocking a playlist stops choosing in it', page.locator('.select-bar').count() == 0 and chosen() == 0)
        page.locator('.tracks .track').nth(1).click(modifiers=['ControlOrMeta'])
        page.wait_for_timeout(300)
        no_menu = 'Select' not in (page.locator('.tracks .track-more').nth(1).click() or sheet_labels())
        page.keyboard.press('Escape')
        page.wait_for_selector('.sheet', state='detached')
        check('select: an unlocked playlist\'s tracks aren\'t chosen (they\'re being moved or removed)', page.locator('.select-bar').count() == 0 and no_menu)
        page.click('.lock-btn')
        page.click('.pb-main')
        page.wait_for_selector('.np.open .np-queue-list .track', state='attached')
        check('select: nor are Up next\'s', page.locator('.np-queue-list .track').count() > 0 and page.locator('.np-queue-list .track[data-sel]').count() == 0
              and page.locator('#main .track[data-sel]').count() > 0)
        page.keyboard.press('Escape')
        page.wait_for_selector('.np.open', state='detached')

        # Play, from the bar's ⋯, with a dozen albums: it says it's getting
        # their tracks, then that it's playing.
        page.goto(APP + '#/browse/albums')
        page.wait_for_selector('.grid .card')
        page.locator('.grid .card').nth(0).click(modifiers=['ControlOrMeta'])
        page.locator('.grid .card').nth(11).click(modifiers=['Shift'])
        check('select: (a dozen albums chosen)', count_text() == '12 albums', count_text())
        page.click('.select-btn[aria-label="More"]')
        pick('Play')
        check('select: Play plays them, and says so (after getting their tracks)',
              wait_for(lambda: page.locator('.toast').count() and page.locator('.toast').last.inner_text() == 'Playing', 8)
              and wait_for(lambda: player(page, "p.context?.title === '12 albums'"), 5) and page.locator('.select-bar').count() == 0,
              page.locator('.toast').all_inner_texts())
        ctx.close()

        # A friend (not the server's admin): no collections.
        ctx = browser.new_context(viewport={'width': 1280, 'height': 900})
        page = ctx.new_page()
        attach(page, 'select-friend')
        login(page, APP, token='t2')
        friend_is_admin = js(page, "() => import('./js/editing.js').then((m) => m.isAdmin())")
        page.goto(APP + '#/browse/albums')
        page.wait_for_selector('.grid .card')
        page.locator('.grid .card').first.click(modifiers=['ControlOrMeta'])
        page.click('.select-btn[aria-label="More"]')
        labels = sheet_labels()
        check('select: collections are only for the server\'s admin', friend_is_admin is False and 'Add to collection…' not in labels and 'Add to playlist…' in labels, str(labels))
        ctx.close()

        # A phone: a long press on a cover opens its menu (not the album);
        # the bar names its buttons.
        ctx = browser.new_context(**MOBILE)
        page = ctx.new_page()
        attach(page, 'select-touch')
        login(page, APP)
        play_first_album_track(page, APP)
        player(page, 'p.pause()')
        cdp = ctx.new_cdp_session(page)
        page.goto(APP + '#/browse/albums')
        page.wait_for_selector('.grid .card')
        page.wait_for_timeout(500)
        box = page.locator('.grid .card').nth(1).bounding_box()
        x, y = box['x'] + box['width'] / 2, box['y'] + box['width'] / 2
        # A finger that moves (scrolling) isn't a long press.
        cdp.send('Input.dispatchTouchEvent', {'type': 'touchStart', 'touchPoints': [{'x': x, 'y': y}]})
        for step in range(1, 6):
            page.wait_for_timeout(60)
            cdp.send('Input.dispatchTouchEvent', {'type': 'touchMove', 'touchPoints': [{'x': x, 'y': y - step * 12}]})
        page.wait_for_timeout(700)
        cdp.send('Input.dispatchTouchEvent', {'type': 'touchEnd', 'touchPoints': []})
        page.wait_for_timeout(400)
        check('select: a finger that moves over a cover (scrolling) doesn\'t open its menu', page.locator('.sheet').count() == 0 and page.evaluate('location.hash') == '#/browse/albums')
        page.evaluate('window.scrollTo(0, 0)')
        page.wait_for_timeout(300)
        box = page.locator('.grid .card').nth(1).bounding_box()
        x, y = box['x'] + box['width'] / 2, box['y'] + box['width'] / 2
        cdp.send('Input.dispatchTouchEvent', {'type': 'touchStart', 'touchPoints': [{'x': x, 'y': y}]})
        page.wait_for_timeout(800)
        cdp.send('Input.dispatchTouchEvent', {'type': 'touchEnd', 'touchPoints': []})
        page.wait_for_timeout(600)
        check('select: a long press on a cover opens its menu, and lifting the finger doesn\'t close it',
              page.locator('.sheet.open').count() == 1 and page.evaluate('location.hash') == '#/browse/albums', page.evaluate('location.hash'))
        shot(page, 'select-03-long-press')
        page.locator('.sheet.open .sheet-action', has_text='Select').tap()
        page.wait_for_selector('.select-bar')
        page.locator('.grid .card').nth(2).tap()
        page.wait_for_timeout(300)
        bar = page.locator('.select-bar').bounding_box()
        mini = page.locator('#player-bar').bounding_box()
        names = page.locator('.select-bar .select-label.short').evaluate_all('ls => ls.filter((l) => l.offsetParent).map((l) => l.textContent)')
        check('select: on a phone, taps choose, and the bar (over the player) names its buttons',
              count_text() == '2 albums' and names == ['Next', 'Queue', 'Playlist', 'More'] and bar['y'] + bar['height'] <= mini['y'] + 1, f'{count_text()} {names} {bar} {mini}')
        shot(page, 'select-04-phone')
        page.locator('.select-close').tap()
        check('select: ✕ stops choosing', page.locator('.select-bar').count() == 0)
        page.locator('.grid .card').nth(0).tap()
        page.wait_for_selector('.hero-album')
        check('select: ...and a tap opens an album again', page.evaluate('location.hash').startswith('#/album/'))
        js(page, f"() => import('./js/state.js').then(({{ app }}) => app.server.deletePlaylist('{made['ratingKey']}'))")
        ctx.close()

    # ---------- spotify: a playlist from a Spotify playlist's link ----------
    if run('spotify'):
        ctx = browser.new_context(**MOBILE)
        page = ctx.new_page()
        attach(page, 'spotify', expected=('status of 404',))  # the private playlist, on purpose
        login(page, APP)
        page.goto(APP + '#/search')
        page.wait_for_selector('.spotify-row')
        form = '.spotify-form'
        said = lambda: page.locator('.spotify-status').inner_text()

        # From Spotify's download of your data: a guide to asking for it, and
        # to choosing just its playlist files, which are read in the browser.
        def guide():
            page.locator('.spotify-row').scroll_into_view_if_needed()
            page.click('.spotify-row')
            page.wait_for_selector('.spotify-guide')

        def choose_files(files):
            with page.expect_file_chooser() as fc:
                page.click('.spotify-choose')
            fc.value.set_files([{'name': n, 'mimeType': 'application/zip' if n.endswith('.zip') else 'application/json', 'buffer': b} for n, b in files])

        def item(title, artist, album):
            return {'track': {'trackName': title, 'artistName': artist, 'albumName': album, 'trackUri': 'spotify:track:4uLU6hMCjMI75M1A2tKUQC'},
                    'episode': None, 'localTrack': None, 'audiobook': None, 'addedDate': '2019-05-01'}
        playlist1 = json.dumps({'playlists': [
            {'name': 'Old favourites', 'lastModifiedDate': '2021-03-02', 'description': 'Kept private', 'numberOfFollowers': 3, 'items': [
                item('Atlas - Remastered 2011', 'Marisol Vega', 'Noches de Cobre'),
                item('Cinder', 'Kilo Meridian', 'Crate Digger'),
                {'track': None, 'episode': {'episodeName': 'A podcast', 'showName': 'A show', 'episodeUri': 'spotify:episode:1'}, 'localTrack': None, 'audiobook': None, 'addedDate': '2019-05-01'},
                item('Drift', 'Juniper & Ash', 'Hearthstone'),
                item('A Song Nobody Has', 'Nobody Known', 'Nowhere'),
                {'track': None, 'episode': None, 'localTrack': {'uri': 'spotify:local:Glass+Harbour:Buoy:Echo+Static:201'}, 'audiobook': None, 'addedDate': '2019-05-01'},
            ]},
            {'name': 'Empty one', 'lastModifiedDate': '2021-03-02', 'description': None, 'numberOfFollowers': 0, 'items': []},
        ]}).encode()
        playlist2 = json.dumps({'playlists': [{'name': 'Road songs', 'lastModifiedDate': '2022-01-01', 'description': None, 'numberOfFollowers': 0, 'items': [
            item('Echo Velvet', 'Kilo Meridian', 'Crate Digger'), item('Copper Salt', 'The Wren Collective', 'Paper Boats'), item('Drift Neon', 'Northbound Static', 'Long Way North')]}]}).encode()
        library = json.dumps({'tracks': [
            {'artist': 'Marisol Vega', 'album': 'Noches de Cobre', 'track': 'Copper Ember', 'uri': 'spotify:track:1'},
            {'artist': 'The Wren Collective', 'album': 'Kitchen Table Hymns', 'track': 'Cinder Orchard', 'uri': 'spotify:track:2'},
            {'artist': 'Ghost Band', 'album': 'Never Was', 'track': 'Liked But Missing', 'uri': 'spotify:track:3'},
        ], 'albums': [{'artist': 'Kilo Meridian', 'album': 'Crate Digger', 'uri': 'spotify:album:1'}], 'shows': [], 'episodes': [],
            'bannedTracks': [{'artist': 'Banned', 'album': 'Banned', 'track': 'Never Wanted', 'uri': 'spotify:track:9'}], 'artists': [], 'bannedArtists': [], 'other': []}).encode()
        userdata = json.dumps({'username': 'dan', 'email': 'dan.private@example.com', 'birthdate': '1980-01-01', 'postalCode': 'AB1 2CD', 'mobileNumber': '+447700900123'}).encode()
        # (Which files the page reads, and what it sends where.)
        js(page, """() => {
            window.__read = [];
            for (const name of ['text', 'arrayBuffer', 'stream', 'bytes', 'slice']) {
                const f = Blob.prototype[name];
                if (f) Blob.prototype[name] = function (...a) {
                    if (this.name) window.__read.push(this.name);
                    const r = f.apply(this, a);
                    return window.__slowRead && r instanceof Promise ? new Promise((ok) => setTimeout(() => ok(r), window.__slowRead)) : r;
                };
            }
            for (const name of ['readAsText', 'readAsArrayBuffer', 'readAsDataURL', 'readAsBinaryString']) {
                const f = FileReader.prototype[name];
                FileReader.prototype[name] = function (b, ...a) { if (b?.name) window.__read.push(b.name); return f.call(this, b, ...a); };
            }
        }""")
        sent = []
        on_request = lambda r: sent.append({'url': r.url, 'method': r.method, 'body': r.post_data or ''})
        page.on('request', on_request)
        guide()
        text_ = page.locator('.spotify-guide').inner_text()
        link = page.locator('.spotify-privacy')
        check('spotify: From Spotify says why it\'s Spotify\'s download of your data, how to ask for it, and to choose just its playlist files',
              'developer programme' in text_ and 'Download your data' in text_ and 'Account data' in text_ and 'Playlist1.json' in text_ and 'YourLibrary.json' in text_
              and 'date of birth' in text_ and 'Leave them out' in text_ and 'turned away unread' in text_
              and link.get_attribute('href') == 'https://www.spotify.com/account/privacy/' and link.get_attribute('target') == '_blank' and 'noopener' in (link.get_attribute('rel') or ''), text_[:600])
        shot(page, 'spotify-00-guide')
        choose_files([('my_spotify_data.zip', b'PK\x03\x04 not really a zip')])
        page.wait_for_selector('.spotify-status.warn')
        zip_said = said()
        choose_files([('Userdata.json', userdata)])
        page.wait_for_function("() => document.querySelector('.spotify-status')?.textContent.includes('isn’t one of')")
        user_said = said()
        read_so_far = js(page, '() => window.__read.slice()')
        check('spotify: ...the ZIP itself, or a file that isn\'t a playlist file, is turned away without being opened, saying so',
              'That’s the ZIP itself, so it wasn’t opened' in zip_said and 'That isn’t one of Spotify’s playlist files, so it wasn’t opened' in user_said and read_so_far == [],
              f'{zip_said!r} {user_said!r} {read_so_far}')
        choose_files([('Playlist1.json', b'{"something": "else"}')])
        page.wait_for_function("() => document.querySelector('.spotify-status')?.textContent.includes('Playlist1.json isn’t')")
        check('spotify: ...and one with a playlist file\'s name that isn\'t one says so', 'Playlist1.json isn’t one of Spotify’s playlist files' in said(), said())
        choose_files([('Playlist2.json', playlist2), ('Userdata.json', userdata), ('YourLibrary.json', library), ('Playlist1.json', playlist1)])
        page.wait_for_selector('.spotify-choose-form')
        chooser = page.locator('.spotify-choose-form').inner_text()
        titles = page.locator('.spotify-choose-form .import-choices .import-choice-title').all_text_contents()
        ticked = page.locator('.spotify-choose-form .import-choices input').evaluate_all('els => els.map((e) => [e.checked, e.disabled])')
        read = js(page, '() => window.__read.slice()')
        shot(page, 'spotify-00b-chooser')
        check('spotify: the playlists in them to choose from, Liked Songs first, the empty one not choosable, and the other file not opened (and said so)',
              titles == ['Liked Songs', 'Old favourites', 'Empty one', 'Road songs'] and ticked == [[True, False], [True, False], [False, True], [True, False]]
              and '3 tracks' in chooser and '5 tracks' in chooser and 'Userdata.json wasn’t opened, as it isn’t a playlist file' in chooser
              and sorted(set(read)) == ['Playlist1.json', 'Playlist2.json', 'YourLibrary.json'], f'{titles} {ticked} {read} {chooser[:500]!r}')
        page.click('.spotify-choose-form .btn-primary')
        page.wait_for_selector('.dialog-close:has-text("Done")', timeout=60000)
        # (Not the list of them, which may still be going, if the import was quick.)
        done = page.locator('.import-form:not(.spotify-choose-form)').inner_text()
        made = js(page, """() => import('./js/state.js').then(async ({ app }) => {
            app.server.forgetPlaylists();
            const out = {};
            for (const p of await app.server.playlists()) if (['Liked Songs', 'Old favourites', 'Road songs', 'Empty one'].includes(p.title)) {
                const { items } = await app.server.playlistItems(p.ratingKey, { start: 0, size: 50 });
                out[p.title] = items.map((m) => [m.title, m.parentTitle]);
            }
            return out;
        })""")
        check('spotify: those chosen are made from the tracks found, in order, choosing between copies by album and artist (a file of your own too; episodes left out)',
              made == {'Liked Songs': [['Copper Ember', 'Noches de Cobre'], ['Cinder Orchard', 'Kitchen Table Hymns']],
                       'Old favourites': [['Atlas', 'Noches de Cobre'], ['Cinder', 'Crate Digger'], ['Drift', 'Hearthstone'], ['Echo Static', 'Buoy']],
                       'Road songs': [['Echo Velvet', 'Crate Digger'], ['Copper Salt', 'Paper Boats'], ['Drift Neon', 'Long Way North']]}
              and 'Imported 3 playlists: 9 tracks found' in done and '2 not' in done, f'{made} {done!r}')
        page.remove_listener('request', on_request)
        # (The service is asked about shared playlists, as playlists change:
        # nothing from the files goes with that, and nothing goes to it.)
        words = ('Old favourites', 'Old+favourites', 'Old%20favourites', 'Road songs', 'Road+songs', 'Liked Songs', 'Liked+Songs', 'Atlas', 'Cinder', 'Copper', 'Drift', 'Echo')
        to_service = [x for x in sent if '/api/' in x['url'] and (x['method'] != 'GET' or any(w in x['url'] + x['body'] for w in words))]
        private = [x for x in sent if any(w in x['url'] + x['body'] for w in ('dan.private', '447700900123', 'AB1', 'Kept private', '4uLU6hMCjMI75M1A2tKUQC'))]
        check('spotify: ...with nothing from the files sent to the container\'s service, nor anything of the other file, a description or Spotify\'s ids sent anywhere',
              not to_service and not private, f'{to_service[:3]} {private[:3]}')
        page.goto(APP + '#/settings/missing')
        page.wait_for_selector('.missing-row')
        missing_rows = [r.inner_text() for r in page.locator('.missing-row').all()]
        check('spotify: what isn\'t found is on Missing tracks, with the Spotify playlist it was in',
              any('A Song Nobody Has' in r and 'in “Old favourites” from Spotify' in r for r in missing_rows) and any('Liked But Missing' in r and 'in “Liked Songs” from Spotify' in r for r in missing_rows),
              str(missing_rows))
        # Again: the names you have now aren't chosen to begin with, and one
        # chosen comes over as "Name (from Spotify)".
        page.goto(APP + '#/search')
        page.wait_for_selector('.spotify-row')
        guide()
        choose_files([('Playlist2.json', playlist2)])
        page.wait_for_selector('.spotify-choose-form')
        again = page.locator('.spotify-choose-form').inner_text()
        again_ticked = page.locator('.spotify-choose-form .import-choices input').evaluate_all('els => els.map((e) => e.checked)')
        page.check('.spotify-choose-form .import-choices input')
        page.uncheck('.spotify-choose-form .spotify-keep input')
        page.click('.spotify-choose-form .btn-primary')
        page.wait_for_selector('.dialog-close:has-text("Done")', timeout=60000)
        names = js(page, """() => import('./js/state.js').then(async ({ app }) => { app.server.forgetPlaylists(); return (await app.server.playlists()).map((p) => p.title).filter((t) => t.startsWith('Road songs')).sort(); })""")
        check('spotify: ...and a playlist you have already isn\'t chosen to begin with, and chosen, comes over as "Name (from Spotify)"',
              again_ticked == [False] and 'you have one by this name: this would be “Road songs (from Spotify)”' in again and names == ['Road songs', 'Road songs (from Spotify)'], f'{again_ticked} {names} {again[:300]!r}')
        # A third time, and two of the same name in the files: each made
        # gets a name of its own.
        twice = json.dumps({'playlists': [
            {'name': 'Road songs', 'items': [item('Echo Velvet', 'Kilo Meridian', 'Crate Digger')]},
            {'name': 'Twice', 'items': [item('Cinder', 'Kilo Meridian', 'Crate Digger')]},
            {'name': 'Twice', 'items': [item('Drift', 'Juniper & Ash', 'Hearthstone')]},
        ]}).encode()
        page.click('.dialog-close')
        page.wait_for_timeout(400)
        guide()
        choose_files([('Playlist3.json', twice)])
        page.wait_for_selector('.spotify-choose-form')
        third = page.locator('.spotify-choose-form').inner_text()
        subs = lambda: page.locator('.spotify-choose-form .import-choices .import-choice-sub').all_inner_texts()
        page.uncheck('.spotify-choose-form .import-choices input >> nth=1')
        first_off = subs()
        page.check('.spotify-choose-form .import-choices input >> nth=1')
        page.check('.spotify-choose-form .import-choices input >> nth=0')
        page.uncheck('.spotify-choose-form .spotify-keep input')
        page.click('.spotify-choose-form .btn-primary')
        page.wait_for_selector('.dialog-close:has-text("Done")', timeout=60000)
        page.click('.dialog-close')
        page.wait_for_timeout(400)
        names = js(page, """() => import('./js/state.js').then(async ({ app }) => { app.server.forgetPlaylists(); return (await app.server.playlists()).map((p) => p.title).filter((t) => t.startsWith('Road songs') || t.startsWith('Twice')).sort(); })""")
        check('spotify: ...a name taken twice over comes over as "Name (from Spotify 2)", and two of the same name in the files each get one of their own, as the list shows (as they\'re chosen)',
              'this would be “Road songs (from Spotify 2)”' in third and third.count('another of these has the same name') == 2
              and 'another of these has the same name: this would be “Twice (from Spotify)”' in third
              and first_off[2].endswith('another of these has the same name') and 'this would be' not in first_off[2]
              and sorted(names) == sorted(['Road songs', 'Road songs (from Spotify)', 'Road songs (from Spotify 2)', 'Twice', 'Twice (from Spotify)']), f'{names} {first_off} {third[:500]!r}')
        js(page, """() => import('./js/state.js').then(async ({ app }) => {
            app.server.forgetPlaylists();
            for (const p of await app.server.playlists()) if (['Liked Songs', 'Old favourites', 'Road songs', 'Twice'].includes(p.title.replace(/ \\(from Spotify( \\d+)?\\)$/, ''))) await app.server.deletePlaylist(p.ratingKey);
        })""")
        # What's read at once is bounded, and the list says what was cut
        # short (here, with the bounds lowered): a file too big is passed
        # over, a playlist past the most tracks has its first ones, and one
        # past the most in all, and playlists past the most, are said to be.
        js(page, "() => import('./js/playlistio.js').then(({ FILE_LIMITS: l }) => { window.__limits = { ...l }; Object.assign(l, { bytes: 1500, tracks: 2, total: 3, playlists: 3 }); })")
        first = json.dumps({'playlists': [
            {'name': 'Long one', 'items': [item('Cinder', 'Kilo Meridian', 'Crate Digger'), item('Drift', 'Juniper & Ash', 'Hearthstone'), item('Echo Velvet', 'Kilo Meridian', 'Crate Digger')]},
            {'name': 'Cut', 'items': [item('Copper Salt', 'The Wren Collective', 'Paper Boats'), item('Atlas', 'Marisol Vega', 'Noches de Cobre')]},
        ]}).encode()
        second = json.dumps({'playlists': [
            {'name': 'Second', 'items': [item('Copper Salt', 'The Wren Collective', 'Paper Boats')]},
            {'name': 'Past the rest', 'items': [item('Drift Neon', 'Northbound Static', 'Long Way North')]},
            {'name': 'Fourth', 'items': [item('Atlas', 'Marisol Vega', 'Noches de Cobre')]},
        ]}).encode()
        sizes = (len(first), len(second))
        too_big = b'{"playlists": []}' + b' ' * 2000
        guide()
        choose_files([('Playlist1.json', json.dumps({'playlists': [{'name': 'Nothing in it', 'items': []}]}).encode()), ('Playlist9.json', too_big)])
        page.wait_for_selector('.spotify-status.warn')
        none_said = said()
        choose_files([('Playlist1.json', first), ('Playlist2.json', second), ('Playlist9.json', too_big)])
        page.wait_for_selector('.spotify-choose-form')
        bounded = page.locator('.spotify-choose-form').inner_text()
        bounded_ticked = page.locator('.spotify-choose-form .import-choices input').evaluate_all('els => els.map((e) => e.disabled)')
        js(page, "() => import('./js/playlistio.js').then(({ FILE_LIMITS: l }) => Object.assign(l, window.__limits))")
        page.click('.dialog-close')
        page.wait_for_timeout(400)
        check('spotify: ...with no tracks in the files read, it says which were read, and which were too big',
              none_said.startswith('There are no tracks in Playlist1.json. Playlist9.json is too big to read'), none_said)
        check('spotify: ...what\'s cut short is said, and when choosing its file on its own would bring the rest: a file too big, a playlist past the most tracks for one, '
              'one past the most in all (in a file that would bring it on its own, and in one that wouldn\'t), and playlists past the most',
              'Playlist9.json is too big to read' in bounded
              and 'The first 2 of its 3 tracks, the most one playlist can bring over' in bounded
              and 'The first 1 of its 2 tracks, as many as can come over at once' in bounded
              and '1 track: more than can come over with the rest. Choose Playlist2.json on its own for it' in bounded
              and '2 more playlists aren’t listed: there are more than can be read at once. Choose Playlist2.json on its own for them.' in bounded
              and bounded_ticked == [False, False, True] and max(sizes) < 1500, f'{sizes} {bounded_ticked} {bounded!r}')
        # Closed while it's still reading, the guide opens nothing after, and
        # the link can't be chosen meanwhile.
        js(page, '() => (window.__slowRead = 1500)')
        guide()
        choose_files([('Playlist2.json', playlist2)])
        page.wait_for_function("() => document.querySelector('.spotify-status')?.textContent.includes('Reading')")
        link_off = page.locator('.spotify-by-link').is_disabled()
        page.keyboard.press('Escape')
        page.wait_for_timeout(2500)
        js(page, '() => (window.__slowRead = 0)')
        check('spotify: ...closed while reading, nothing opens after (and the link can\'t be chosen meanwhile)',
              link_off and page.locator('.spotify-choose-form').count() == 0 and page.locator('.sheet.open').count() == 0, f'{link_off} {page.locator(".sheet.open").count()}')
        # Files dropped on the guide are taken as chosen, by their names too,
        # wherever on it (or around it) they're dropped; elsewhere, a file
        # dropped does nothing (the browser doesn't open it instead).
        drop = """([a, b, where]) => {
            const dt = new DataTransfer();
            dt.items.add(new File([a], 'Playlist2.json', { type: 'application/json' }));
            if (b) dt.items.add(new File([b], 'Userdata.json', { type: 'application/json' }));
            const over = new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true });
            const ev = new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true });
            const el = document.querySelector(where);
            el.dispatchEvent(over);
            el.dispatchEvent(ev);
            return [over.defaultPrevented, ev.defaultPrevented];
        }"""
        dropped = []
        for where in ('.spotify-guide', '.sheet.dialog .sheet-title', '.sheet.dialog'):
            guide()
            page.evaluate(drop, [playlist2.decode(), userdata.decode(), where])
            page.wait_for_selector('.spotify-choose-form')
            dropped.append(page.locator('.spotify-choose-form').inner_text())
            page.click('.dialog-close')
            page.wait_for_timeout(400)
        check('spotify: ...files dropped on it are taken as chosen (on the guide, its title or around it), and turned away by their names too',
              all('Road songs' in d and 'Userdata.json wasn’t opened' in d for d in dropped), str([d[:120] for d in dropped]))
        elsewhere = page.evaluate(drop, [playlist2.decode(), '', '#main'])
        check('spotify: ...elsewhere, a file dropped isn\'t opened in the page\'s place', elsewhere == [True, True] and page.locator('.sheet.open').count() == 0, str(elsewhere))
        # Missing tracks keeps the latest 1,000 from Spotify for each server,
        # apart from what AI playlists suggested, and says how many it kept.
        caps = js(page, """() => Promise.all([import('./js/missing.js'), import('./js/state.js')]).then(([m, { app }]) => {
            m.clearMissing();
            m.noteMissing([{ kind: 'track', artist: 'Some Artist', title: 'Suggested Song' }], { songs: [], artists: [] }, 'an AI playlist');
            const many = Array.from({ length: 1200 }, (_, i) => ({ kind: 'track', artist: 'Band ' + i, title: 'Song ' + i }));
            const { kept, of, keys, saved } = m.noteMissing([...many, many[0]], { songs: [], artists: [] }, 'Big', { via: 'spotify' });
            const list = m.missingList();
            const out = { r: { kept, of, saved }, keys: keys.length, spotify: list.filter((x) => x.via === 'spotify').length, ai: list.filter((x) => !x.via).length };
            m.clearMissing();
            return out;
        })""")
        check('spotify: Missing tracks keeps the latest 1,000 from Spotify, apart from what AI playlists suggested, saying how many it kept',
              caps == {'r': {'kept': 1000, 'of': 1200, 'saved': True}, 'keys': 1200, 'spotify': 1000, 'ai': 1}, str(caps))
        # In one import, a later playlist's can push an earlier one's off
        # (here with room for 3): each playlist's row says how many of its
        # are on Missing tracks as it is now. And one with none of its tracks
        # found isn't made, but lists them, to copy or save, all the same.
        lost = """([jobs, via]) => Promise.all([import('./js/missing.js'), import('./js/views/playlistfiles.js')]).then(([m, pf]) => {
            const song = (title) => ({ title, artist: 'Nobody Known', albumArtist: '', album: 'Nowhere' });
            pf.runImport(jobs.map(([title, songs]) => ({ p: { title, tracks: songs.map(song) }, title, from: title })), { remember: { via } });
        })"""
        js(page, "() => import('./js/missing.js').then((m) => { m.clearMissing(); window.__caps = { ...m.MISSING_LIMITS }; m.MISSING_LIMITS.spotify = 3; })")
        # (The second playlist's search waits, while the first's list of what
        # wasn't found is opened: it stays open as its row changes.)
        held = []
        hold = lambda url: '/hubs/search' in url and ('query=Lost+Four' in url or 'query=Lost%20Four' in url)
        page.route(hold, lambda route: held.append(route))
        page.evaluate(lost, [[['First lost', ['Lost One', 'Lost Two', 'Lost Three']], ['Second lost', ['Lost Four', 'Lost Five']]], 'spotify'])
        page.wait_for_selector('.import-result')
        page.click('.import-result >> nth=0 >> summary')
        for _ in range(100):
            if held:
                break
            page.wait_for_timeout(100)
        for route in held:
            route.continue_()
        page.unroute(hold)
        page.wait_for_selector('.dialog-close:has-text("Done")', timeout=60000)
        rows = [r.inner_text() for r in page.locator('.import-result').all()]
        lost_actions = page.locator('.import-result >> nth=0').locator('.import-missing-actions button').count()
        still_open = page.locator('.import-result >> nth=0').locator('details').evaluate('(d) => d.open')
        on_list = js(page, """() => import('./js/missing.js').then((m) => { const out = m.missingList().map((x) => x.title).sort(); Object.assign(m.MISSING_LIMITS, window.__caps); m.clearMissing(); return out; })""")
        page.click('.dialog-close')
        page.wait_for_timeout(400)
        check('spotify: ...in one import, each playlist\'s row says how many of its are on Missing tracks once a later one has pushed some off (a list opened staying open)',
              len(rows) == 2 and '1 of them is on Missing tracks now' in rows[0] and 'it keeps the latest 3 from Spotify for each server' in rows[0]
              and 'They’re on Missing tracks now' in rows[1] and on_list == ['Lost Five', 'Lost Four', 'Lost Three'] and held and still_open, f'{rows} {on_list} {len(held)} {still_open}')
        check('spotify: ...and a playlist with none of its tracks found lists them all the same, to copy or save (the spreadsheet it speaks of)',
              'so it wasn’t made' in rows[0] and 'Not found (3)' in rows[0] and lost_actions == 2, f'{rows[0]!r} {lost_actions}')
        # A browser that can't keep them says so, not that the list is full.
        js(page, """() => { window.__setItem = Storage.prototype.setItem; Storage.prototype.setItem = function (k, v) { if (k === 'pw.aiMissing') throw new DOMException('full', 'QuotaExceededError'); return window.__setItem.call(this, k, v); }; }""")
        page.evaluate(lost, [[['Third lost', ['Lost Six']]], 'spotify'])
        page.wait_for_selector('.dialog-close:has-text("Done")', timeout=60000)
        no_room = page.locator('.import-result').inner_text()
        js(page, '() => { Storage.prototype.setItem = window.__setItem; }')
        page.click('.dialog-close')
        page.wait_for_timeout(400)
        check('spotify: ...and where the browser can\'t keep them, it says that, not that Missing tracks is full',
              'There isn’t room for them on Missing tracks (this browser couldn’t keep more)' in no_room, no_room)
        # A song a later playlist finds (its lookup failed the first time)
        # isn't missing after all: the first playlist's row doesn't count it.
        tries = []
        def flaky(route):
            tries.append(route.request.url)
            if len(tries) == 1:
                route.fulfill(status=500, body='')
            else:
                route.continue_()
        cinder = lambda url: '/hubs/search' in url and re.search(r'[?&]query=Cinder(&|$)', url) is not None
        page.route(cinder, flaky)
        js(page, """() => Promise.all([import('./js/missing.js'), import('./js/views/playlistfiles.js')]).then(([m, pf]) => {
            m.clearMissing();
            const cinder = { title: 'Cinder', artist: 'Kilo Meridian', albumArtist: '', album: 'Crate Digger' };
            pf.runImport([['Not found first', [cinder]], ['Found later', [cinder]]].map(([title, tracks]) => ({ p: { title, tracks }, title, from: title })), { remember: { via: 'spotify' } });
        })""")
        page.wait_for_selector('.dialog-close:has-text("Done")', timeout=60000)
        page.unroute(cinder)
        later = [r.inner_text() for r in page.locator('.import-result').all()]
        later_list = js(page, """() => import('./js/missing.js').then(async (m) => {
            const out = m.missingList().map((x) => x.title);
            m.clearMissing();
            const { app } = await import('./js/state.js');
            app.server.forgetPlaylists();
            for (const p of await app.server.playlists()) if (p.title === 'Found later') await app.server.deletePlaylist(p.ratingKey);
            return out;
        })""")
        page.click('.dialog-close')
        page.wait_for_timeout(400)
        check('spotify: ...a song a later playlist finds isn\'t counted as missing from an earlier one\'s (nor its absence put down to room)',
              len(tries) >= 2 and len(later) == 2 and 'Not found (1)' in later[0] and 'Missing tracks' not in later[0] and 'All 1 track found' in later[1] and later_list == [],
              f'{len(tries)} {later} {later_list}')
        # Songs from Spotify are real: an AI's suggestion MusicBrainz doesn't
        # know doesn't take one off, and one an AI suggests stays real.
        real = js(page, """() => import('./js/missing.js').then((m) => {
            m.clearMissing();
            const s = { kind: 'track', artist: 'Tiny Band', title: 'Basement Tape' };
            m.noteMissing([s], { songs: [], artists: [] }, 'Road songs', { via: 'spotify' });
            m.noteMissing([], { songs: [], artists: [] }, 'an AI playlist', { drop: [{ ...s, mb: 'unknown' }] });
            const after = m.missingList().map((x) => [x.title, x.via || '']);
            m.noteMissing([s], { songs: [], artists: [] }, 'an AI playlist');
            const taken = m.missingList()[0];
            // Found as well as missing in one playlist (a lookup that failed
            // once), it's found.
            m.clearMissing();
            const both = m.noteMissing([s], { songs: [s], artists: [] }, 'Twice in it', { via: 'spotify' });
            const out = { after, taken: [taken.via || '', taken.mb || '', m.askable(taken)], both: [both.of, m.missingList().length] };
            m.clearMissing();
            return out;
        })""")
        check('spotify: ...a song from Spotify isn\'t taken off by an AI\'s suggestion MusicBrainz doesn\'t know, and suggested by an AI, it stays a real song (and one found as well as missing is found)',
              real == {'after': [['Basement Tape', 'spotify']], 'taken': ['', 'real', False], 'both': [0, 0]}, str(real))
        # A song in a playlist from Spotify is counted once for each playlist
        # it's in, however often it's imported; suggested by an AI after, it's
        # counted afresh as a suggestion.
        counts = js(page, """() => import('./js/missing.js').then((m) => {
            m.clearMissing();
            const s = [{ kind: 'track', artist: 'Ghost Band', title: 'Counted Once' }];
            const times = () => m.missingList()[0].times;
            const out = [];
            for (const p of ['Road songs', 'Road songs', 'Old favourites', 'Road songs']) { m.noteMissing(s, { songs: [], artists: [] }, p, { via: 'spotify' }); out.push(times()); }
            m.noteMissing(s, { songs: [], artists: [] }, 'an AI playlist');
            out.push(times(), m.missingList()[0].via || '');
            // In more playlists than are counted: "20+", and no more each
            // time they're imported again.
            m.clearMissing();
            const many = Array.from({ length: 25 }, (_, i) => 'Playlist ' + i);
            for (const round of [1, 2]) {
                for (const p of many) m.noteMissing(s, { songs: [], artists: [] }, p, { via: 'spotify' });
                out.push(times());
            }
            out.push(m.missingCsv().includes('"20+"'));
            return out;
        })""")
        page.goto(APP + '#/settings/missing')
        page.wait_for_selector('.missing-row')
        twenty = page.locator('.missing-row').first.inner_text()
        js(page, "() => import('./js/missing.js').then((m) => m.clearMissing())")
        check('spotify: ...a song from Spotify counts once for each playlist it\'s in, however often imported, up to "20+" (suggested by an AI after, it\'s a suggestion)',
              counts == [1, 1, 2, 2, 1, '', 20, 20, True] and 'in 20+ playlists from Spotify' in twenty, f'{counts} {twenty!r}')
        js(page, "() => import('./js/missing.js').then((m) => m.clearMissing?.())")
        page.goto(APP + '#/search')
        page.wait_for_selector('.spotify-row')

        def look(link, until):
            page.fill(f'{form} input[type=url]', link)
            page.click(f'{form} button[type=submit]')
            page.wait_for_selector(until, timeout=15000)

        def open_dialog():
            guide()
            page.click('.spotify-by-link')
            page.wait_for_selector(f'{form} input[type=url]')

        open_dialog()
        look('https://example.com/playlist/mockRoadTrip0000000001', '.spotify-status.warn')
        not_link = said()
        look('https://open.spotify.com/album/mockRoadTrip0000000001', '.spotify-status.warn:has-text("Only playlists")')
        album = said()
        look('https://open.spotify.com/playlist/mockPrivate00000000004', '.spotify-status.warn:has-text("public")')
        private = said()
        check('spotify: a link that isn\'t to a public playlist says so', 'isn’t a link to a Spotify playlist' in not_link and 'Only playlists' in album and 'no public playlist' in private,
              f'{not_link!r} {album!r} {private!r}')
        look('https://open.spotify.com/playlist/mockRoadTrip0000000001?si=abc', '.spotify-found')
        card = page.locator('.spotify-found').inner_text()
        check('spotify: the playlist as Spotify has it: its name, who made it and its tracks (not the podcast episode in it)',
              'Road trip classics' in card and 'By Dan' in card and '11 tracks' in card, card)
        shot(page, 'spotify-01-found')
        page.click(f'{form} button:has-text("Make the playlist")')
        page.wait_for_selector('.dialog-close:has-text("Done")', timeout=60000)
        result = page.locator('.import-form').inner_text()
        shot(page, 'spotify-02-result')
        sp = js(page, "() => import('./js/spotify.js').then((m) => m.readSpotifyPlaylist('spotify:playlist:mockRoadTrip0000000001'))")
        plain = lambda t: re.sub(r' - Remastered 2011$| \(feat\. [^)]*\)$', '', t)
        made = js(page, """() => import('./js/state.js').then(async ({ app }) => {
            app.server.forgetPlaylists();
            const pl = (await app.server.playlists()).find((p) => p.title === 'Road trip classics');
            const { items } = await app.server.playlistItems(pl.ratingKey, { start: 0, size: 50 });
            return items.map((m) => m.title);
        })""")
        check('spotify: its tracks are found in the library, in its order ("Song - Remastered 2011", "(feat. …)" and "Artist, Guest" too), and what isn\'t is said',
              '8 of 11 tracks found' in result and 'on Missing tracks' in result and made == [plain(t['title']) for t in sp['tracks'][:8]], f'{result!r} {made} {[t["title"] for t in sp["tracks"]]}')
        page.click('.import-remembered .link-btn')
        page.wait_for_selector('.missing-row')
        rows = [r.inner_text() for r in page.locator('.missing-row').all()]
        shot(page, 'spotify-03-missing')
        check('spotify: what isn\'t found is on Missing tracks, with the Spotify playlist it was in (and isn\'t asked about on MusicBrainz)',
              sorted(r.split('\n')[0] for r in rows) == ['Another Missing One', 'Imaginary Song', 'Not On Any Album'] and all('in “Road trip classics” from Spotify' in r for r in rows)
              and page.locator('.missing-mb').count() == 0 and page.locator('.missing-check').count() == 1, str(rows))
        csv_text = js(page, "() => import('./js/missing.js').then((m) => m.missingCsv())")
        check('spotify: ...and in its spreadsheet, saying where it came from', '"Ghost Band","Another Missing One","Track","1"' in csv_text and '"A Spotify playlist"' in csv_text, csv_text[:300])
        # Another, all of it found; one as long as Spotify's page lists; and
        # one again, without putting what's missing on the list.
        page.goto(APP + '#/search')
        page.wait_for_selector('.spotify-row')
        open_dialog()
        look('spotify:playlist:mockLateNight000000002', '.spotify-found')
        page.click(f'{form} button:has-text("Make the playlist")')
        page.wait_for_selector('.dialog-close:has-text("Done")', timeout=60000)
        late = page.locator('.import-form').inner_text()
        check('spotify: a playlist all in the library is all found (read from another shape of Spotify\'s page)', 'All 4 tracks found' in late and 'Missing tracks' not in late, late)
        page.click('.dialog-close')
        page.wait_for_timeout(400)
        open_dialog()
        look('https://open.spotify.com/playlist/mockHundred00000000003', '.spotify-found')
        hundred = page.locator(f'{form}').inner_text()
        check('spotify: a playlist as long as Spotify\'s page lists says the rest aren\'t in it', '100 tracks' in hundred and 'first 100 tracks, so any after those aren’t in it' in hundred, hundred[:400])
        page.click('.dialog-close')
        page.wait_for_timeout(400)
        open_dialog()
        look('https://open.spotify.com/playlist/mockRoadTrip0000000001', '.spotify-found')
        again = (page.input_value(f'{form} input[type=text]'), page.locator(f'{form}').inner_text())
        page.uncheck(f'{form} .spotify-keep input')
        page.click(f'{form} button:has-text("Make the playlist")')
        page.wait_for_selector('.dialog-close:has-text("Done")', timeout=60000)
        page.goto(APP + '#/settings/missing')
        page.wait_for_selector('.missing-row')
        rows2 = [r.inner_text() for r in page.locator('.missing-row').all()]
        check('spotify: a name you have already is offered with "(from Spotify)", and with Missing tracks off for it, nothing more goes there',
              again[0] == 'Road trip classics (from Spotify)' and 'You have a playlist called “Road trip classics” already' in again[1] and len(rows2) == 3 and not any('in 2 playlists' in r for r in rows2),
              f'{again[0]!r} {rows2}')
        js(page, """() => import('./js/state.js').then(async ({ app }) => {
            app.server.forgetPlaylists();
            for (const p of await app.server.playlists()) if (['Road trip classics', 'Road trip classics (from Spotify)', 'Night drive mix'].includes(p.title)) await app.server.deletePlaylist(p.ratingKey);
        })""")
        # Each way is off unless the container turns it on: on a player with
        # neither (SPOTIFY_FILE_IMPORT, SPOTIFY_LINK_IMPORT), there's no From
        # Spotify; with the link alone (by its new name), it's the link.
        login(page, APP_NOWS)
        page.goto(APP_NOWS + '#/search')
        page.wait_for_selector('a.row[href="#/sonic-path"]')  # (in the same block as From Spotify)
        check('spotify: on a player with neither way turned on, there\'s no From Spotify', page.locator('.spotify-row').count() == 0
              and js(page, "() => !window.PW_CONFIG.spotify && !window.PW_CONFIG.spotifyFiles"))
        if APP_DEBUG:
            login(page, APP_DEBUG)
            page.goto(APP_DEBUG + '#/search')
            page.wait_for_selector('.spotify-row')
            sub = page.locator('.spotify-row .row-sub').inner_text()
            page.locator('.spotify-row').scroll_into_view_if_needed()
            page.click('.spotify-row')
            page.wait_for_selector(form)
            check('spotify: with the link alone (SPOTIFY_LINK_IMPORT), From Spotify opens it straight away',
                  'link' in sub and page.locator('.spotify-guide').count() == 0 and page.locator(f'{form} input[type=url]').count() == 1, sub)
            page.keyboard.press('Escape')
        ctx.close()

    # ---------- debug: DEBUG=true ----------
    if run('debug') and APP_DEBUG:
        ctx = browser.new_context(**MOBILE)
        # (The handlers the player gives the browser's media controls: media
        # keys, headsets, the system's.)
        ctx.add_init_script("""(() => {
            const ms = navigator.mediaSession;
            if (!ms) return;
            window.__ms = {};
            const set = ms.setActionHandler.bind(ms);
            ms.setActionHandler = (action, fn) => { window.__ms[action] = fn; return set(action, fn); };
        })();""")
        page = ctx.new_page()
        attach(page, 'debug', expected=('HTTP 404',))  # the missing album, on purpose
        sent = []
        page.on('response', lambda r: 'api/debug/log' in r.url and sent.append((r.status, r.request.post_data or '')))
        login(page, APP_DEBUG)
        page.goto(APP_DEBUG + '#/album/999999')  # not on the server: a 404 from Plex
        page.wait_for_selector('.error-state')

        def relayed():
            page.wait_for_timeout(250)  # lets Playwright deliver the response events
            return any(s == 204 and '/pms/library/metadata/999999' in body for s, body in sent)

        check('debug: browser problems reach the container', wait_for(relayed, 10), str(sent[-1:]))
        bodies = ' '.join(b for _, b in sent)
        check('debug: no tokens in what\'s sent', 'X-Plex-Token=t' not in bodies and '"t"' not in bodies)
        page.goto(APP_DEBUG + '#/settings/debug')
        page.wait_for_selector('.kv')
        check('debug: Connection page says debug mode is on', 'On' in page.locator('.kv', has_text='Debug mode').inner_text())
        # Every pause is logged, with what caused it: the play button, media
        # keys (or a headset, or the system's controls), the space bar, and
        # the browser pausing it itself.
        play_first_album_track(page, APP_DEBUG)
        lines = lambda: [e for _, b in sent if b for e in json.loads(b).get('entries', [])]

        def logged(text, level=None):
            def seen():
                page.wait_for_timeout(250)
                return [e for e in lines() if text in e['message'] and (level is None or e['level'] == level)]
            return wait_for(seen, 10)

        def paused_by(how):
            how()
            wait_for(lambda: player(page, 'p.state') == 'paused', 5)

        def again(how):
            how()
            wait_for(lambda: player(page, 'p.state') == 'playing', 5)

        title = player(page, 'p.current.title')
        paused_by(lambda: page.click('.pb-play'))
        by_button = logged(f'paused “{title}” at ')
        again(lambda: page.click('.pb-play'))
        played = logged('play: the play/pause button')
        paused_by(lambda: js(page, '() => window.__ms.pause()'))
        by_keys = logged('media keys, a headset or the system’s media controls')
        again(lambda: js(page, '() => window.__ms.play()'))
        js(page, '() => document.activeElement?.blur()')
        paused_by(lambda: page.keyboard.press('Space'))
        by_space = logged(': the space bar')
        again(lambda: page.keyboard.press('Space'))
        paused_by(lambda: player(page, 'HTMLMediaElement.prototype.pause.call(p.audio)'))
        by_browser = logged(': the browser or the system, not this app (', 'warn')
        check('debug: each pause is logged with what caused it (the play button, media keys, the space bar, the browser itself), and each play asked for',
              by_button and by_button[0]['message'].endswith(': the play/pause button') and played and by_keys and by_space and by_browser
              and 'the page in view' in by_browser[0]['message'], str([e['message'] for e in lines() if e['area'] == 'player'][-8:]))
        # ...still, a change of track or two later (the audio paused here for
        # the change, and loaded again, forgets that it was).
        again(lambda: page.click('.pb-play'))
        for _ in range(2):
            was = player(page, 'String(p.current.qid)')
            player(page, 'p.next()')
            wait_for(lambda: player(page, f"p.state === 'playing' && String(p.current.qid) !== {json.dumps(was)}"), 10, 0.2)
        later = player(page, 'p.current.title')
        paused_by(lambda: player(page, 'HTMLMediaElement.prototype.pause.call(p.audio)'))
        after_skips = logged(f'paused “{later}” at ', 'warn')
        check('debug: ...and the browser\'s own pause is still told apart after changes of track',
              after_skips and ': the browser or the system, not this app (' in after_skips[-1]['message'], str([e['message'] for e in lines() if e['area'] == 'player'][-4:]))
        player(page, 'p.pause()')
        # The shared model here won't take "think": the container passes on
        # what it said (as a line of the answer, which has started by then),
        # and the app asks again without it.
        page.goto(APP_DEBUG + '#/settings/ai')
        page.wait_for_selector('button:has-text("Test the model")')
        page.click('button:has-text("Test the model")')
        check('debug: a shared model that won\'t take "think" still answers', page.wait_for_selector('text=It works', timeout=20000) is not None)
        ctx.close()

    # ---------- sync: settings that follow your Plex account ----------
    # On the DEBUG=true app, the only one here that keeps them (every test
    # signs in as the same few accounts: see tests/run-browser-tests.sh).
    if run('sync') and APP_DEBUG:
        def account(token, method='GET', body=None):
            req = urllib.request.Request(APP_DEBUG + 'api/settings?server=mock-server-1', method=method, data=json.dumps(body).encode() if body is not None else None,
                                         headers={'X-Plex-Token': token, 'Content-Type': 'application/json', 'Accept': 'application/json'})
            with urllib.request.urlopen(req, timeout=20) as r:
                return json.loads(r.read() or b'{}')

        def device(name, token='t', before=None, signed_in=None):
            c = browser.new_context(**MOBILE)
            if before is not None:
                # A browser that's had the app before, with these settings (as
                # an earlier version kept them), and (`signed_in`: { auth,
                # source }) still signed in.
                kept = {'pw.settings': before, **({f'pw.{k}': v for k, v in signed_in.items()} if signed_in else {})}
                c.add_init_script("if (!sessionStorage.getItem('pw-test-seeded')) { sessionStorage.setItem('pw-test-seeded', '1');"
                                  f" for (const [k, v] of Object.entries({json.dumps(kept)})) localStorage.setItem(k, JSON.stringify(v)); }}")
            pg = c.new_page()
            attach(pg, name)
            if signed_in:
                pg.goto(APP_DEBUG)
                pg.wait_for_selector('.wide-card:not(.skeleton)', timeout=20000)
            else:
                login(pg, APP_DEBUG, token, app_defaults=True)
            return c, pg

        def mine(pg):
            return js(pg, """() => import('./js/state.js').then(({ app }) => ({ grid: app.settings.gridSize, rating: app.settings.ratingSystem,
                font: app.settings.fontSize, quality: app.settings.quality, name: app.settings.playerName, hidden: app.settings.home?.['*']?.hidden || [],
                side: app.settings.sideBySide, seek: app.settings.seekbarStyle, tint: app.settings.tintBackground }))""")

        def pull(pg):
            js(pg, "() => import('./js/sync.js').then(({ pullSettings }) => pullSettings())")

        account('t', 'DELETE')
        account('t2', 'DELETE')
        desk_ctx, desk = device('desk')
        lists = js(desk, """() => Promise.all([import('./js/state.js'), import('./js/sync.js')]).then(([s, y]) => {
            const keys = Object.keys(s.DEFAULT_SETTINGS), synced = new Set(y.SYNCED_SETTINGS), own = new Set(y.DEVICE_SETTINGS);
            return { neither: keys.filter((k) => !synced.has(k) && !own.has(k)), both: keys.filter((k) => synced.has(k) && own.has(k)),
                     unknown: [...synced].filter((k) => !keys.includes(k)) }; })""")
        check('sync: every setting either follows the account or is each device\'s own, never both', lists == {'neither': [], 'both': [], 'unknown': []}, str(lists))
        defaults = js(desk, """() => Promise.all([import('./js/state.js'), import('./js/sync.js')]).then(([s, y]) =>
            Object.fromEntries(y.SYNCED_SETTINGS.map((k) => [k, s.DEFAULT_SETTINGS[k]])))""")
        try:
            kinds = account('t2', 'PUT', {'set': defaults})['settings']
        except urllib.error.HTTPError as err:
            kinds = f'HTTP {err.code}'
        account('t2', 'DELETE')
        check('sync: ...and the player keeps each as the kind of value it is in the app', kinds == defaults, str(kinds)[:300])
        desk.wait_for_timeout(1500)
        check('sync: a new browser, as it starts, sends nothing (so it can\'t undo another device\'s settings)', account('t')['rev'] == 0, json.dumps(account('t')))
        settings(desk, {'gridSize': 'large', 'ratingSystem': 'thumbs', 'quality': '128', 'playerName': 'Desk', 'loadAhead': 2})
        js(desk, """() => import('./js/home-sections.js').then(({ homeLayout, saveHomeLayout }) => {
            const l = homeLayout(); l.hidden.add('recentPlays'); saveHomeLayout(l); })""")
        kept = wait_for(lambda: account('t')['settings'].get('gridSize') == 'large' and 'recentPlays' in account('t')['settings'].get('home', {}).get('*', {}).get('hidden', []), 10, 0.3)
        stored = account('t')['settings']
        check('sync: a device\'s settings are kept for its account, never its own ones (Streaming quality, its name)',
              kept and stored.get('ratingSystem') == 'thumbs' and 'quality' not in stored and 'playerName' not in stored and 'ai' not in stored
              and 'loadAhead' not in stored,
              json.dumps({k: stored.get(k) for k in ('gridSize', 'ratingSystem', 'quality', 'playerName')}))
        phone_ctx, phone = device('phone')
        got = {}
        wait_for(lambda: got.update(mine(phone)) or (got['grid'] == 'large' and 'recentPlays' in got['hidden']), 10, 0.3)
        order = sections_on_home(phone)
        check('sync: ...so another device signed in to it has them, the Home screen too, but keeps its own Streaming quality and name',
              got['grid'] == 'large' and got['rating'] == 'thumbs' and got['quality'] == 'original' and got['name'] == '' and 'recentPlays' in got['hidden']
              and 'recentPlays' not in order, f'{got} {order}')
        settings(desk, {'fontSize': 'large'})
        wait_for(lambda: account('t')['settings'].get('fontSize') == 'large', 10, 0.3)
        pull(phone)
        check('sync: ...and a change made later on one turns up on the other', wait_for(lambda: mine(phone)['font'] == 'large', 8, 0.3), str(mine(phone)))

        # A change on its way to the account isn't undone by what another
        # device changed meanwhile, read back before it's there.
        held = []

        def hold(route):
            if route.request.method == 'PUT':
                held.append(route)
            else:
                route.continue_()
        phone.route('**/api/settings?*', hold)
        settings(phone, {'gridSize': 'small'})
        wait_for(lambda: phone.wait_for_timeout(50) or held, 5, 0.1)
        settings(desk, {'sideBySide': False})
        wait_for(lambda: account('t')['settings'].get('sideBySide') is False, 10, 0.3)
        pull(phone)
        during = mine(phone)
        for r in held:
            r.continue_()
        phone.unroute('**/api/settings?*', hold)
        there = wait_for(lambda: account('t')['settings'].get('gridSize') == 'small', 10, 0.3)
        check('sync: a change on its way isn\'t undone by another device\'s, read back meanwhile', held and during['grid'] == 'small' and during['side'] is False
              and there and mine(phone)['grid'] == 'small', f'{during} {mine(phone)} {account("t")["settings"].get("gridSize")}')

        # A browser that had settings of its own already (before 0.19.0, say):
        # its choices are kept, for the account too, and it takes the
        # account's for the rest.
        was = js(desk, "() => import('./js/state.js').then(({ app }) => ({ auth: app.auth, source: app.source }))")
        laptop_ctx, laptop = device('laptop', before={'gridSize': 'normal', 'ratingSystem': 'stars', 'seekbarStyle': 'bars', 'tintBackground': False}, signed_in=was)
        merged = wait_for(lambda: account('t')['settings'].get('seekbarStyle') == 'bars' and account('t')['settings'].get('tintBackground') is False, 10, 0.3)
        lap = mine(laptop)
        acc = account('t')['settings']
        check('sync: a browser with settings of its own keeps its choices (kept for the account too), and takes the account\'s for the rest',
              merged and lap['seek'] == 'bars' and lap['tint'] is False and lap['grid'] == 'small' and lap['rating'] == 'thumbs' and acc.get('gridSize') == 'small'
              and acc.get('ratingSystem') == 'thumbs', f'{lap} {json.dumps({k: acc.get(k) for k in ("gridSize", "ratingSystem", "seekbarStyle", "tintBackground")})}')
        laptop_ctx.close()
        # Settings left in a browser by someone who signed out of an earlier
        # version: theirs, never sent to the next account signed in there.
        account('t2', 'DELETE')
        left_ctx, left = device('left', 't2', before={'version': 2, 'fontSize': 'larger', 'seekbarStyle': 'simple', 'tintBackground': False})
        left.wait_for_timeout(2000)
        check('sync: settings left by someone who signed out of an earlier version aren\'t sent to the next account', account('t2')['rev'] == 0, json.dumps(account('t2')))
        left_ctx.close()

        # A change that couldn't be sent (offline, or the tab closed first) is
        # sent next time, and not undone meanwhile; one the account has had
        # changed since, elsewhere, gives way to that.
        def unsent(patch):
            cut = lambda r: r.abort() if r.request.method == 'PUT' else r.continue_()
            phone.route('**/api/settings?*', cut)
            settings(phone, patch)
            phone.wait_for_timeout(1800)
            js(phone, "() => import('./js/sync.js').then((m) => m.stop())")  # (as if the tab closed)
            phone.unroute('**/api/settings?*', cut)
            return js(phone, "() => JSON.parse(localStorage.getItem('pw.syncPending') || 'null')")

        def reopen():
            phone.reload()
            phone.wait_for_selector('.wide-card:not(.skeleton)', timeout=20000)
        kept_back = unsent({'showAlbumYear': False})
        reopen()
        sent_later = wait_for(lambda: account('t')['settings'].get('showAlbumYear') is False, 10, 0.3)
        stays = js(phone, "() => import('./js/state.js').then(({ app }) => app.settings.showAlbumYear)")
        check('sync: a change that couldn\'t be sent is kept, sent next time, and not undone', bool(kept_back) and 'showAlbumYear' in kept_back and sent_later and stays is False
              and js(phone, "() => localStorage.getItem('pw.syncPending')") is None, f'{kept_back} {stays} {account("t")["settings"].get("showAlbumYear")}')
        unsent({'skipBack': 15})
        settings(desk, {'skipBack': 20})
        wait_for(lambda: account('t')['settings'].get('skipBack') == 20, 10, 0.3)
        reopen()
        mine_now = wait_for(lambda: (lambda v: v if v == 20 else None)(js(phone, "() => import('./js/state.js').then(({ app }) => app.settings.skipBack)")), 10, 0.3)
        phone.wait_for_timeout(1500)
        check('sync: ...but one changed for the account since, elsewhere, takes that', mine_now == 20 and account('t')['settings'].get('skipBack') == 20,
              f'{mine_now} {account("t")["settings"].get("skipBack")}')
        # The same with the tab left open: offline, then back, and the next
        # thing sent (another change here) doesn't take the overtaken one
        # with it.
        cut = lambda r: r.abort() if r.request.method == 'PUT' else r.continue_()
        phone.route('**/api/settings?*', cut)
        settings(phone, {'skipForward': 45})
        phone.wait_for_timeout(1800)
        settings(desk, {'skipForward': 60})
        wait_for(lambda: account('t')['settings'].get('skipForward') == 60, 10, 0.3)
        phone.unroute('**/api/settings?*', cut)
        settings(phone, {'quickSkip': True})
        back = wait_for(lambda: (lambda v: v if v == 60 else None)(js(phone, "() => import('./js/state.js').then(({ app }) => app.settings.skipForward)")), 10, 0.3)
        sent_too = wait_for(lambda: account('t')['settings'].get('quickSkip') is True, 10, 0.3)
        phone.wait_for_timeout(1500)
        check('sync: ...and with the tab left open, offline and back', back == 60 and sent_too and account('t')['settings'].get('skipForward') == 60,
              f'{back} {account("t")["settings"].get("skipForward")} {account("t")["settings"].get("quickSkip")}')
        sam_ctx, sam = device('sam-sync', 't2')
        sam.wait_for_timeout(1500)
        check('sync: someone else\'s account has its own settings', mine(sam)['grid'] == 'normal' and account('t2')['settings'].get('gridSize') is None, str(mine(sam)))

        # Off for the account (Settings › Account): nothing kept, and each
        # device has its own; on again, this device's are kept again.
        phone.goto(APP_DEBUG + '#/settings/account')
        phone.wait_for_selector('label.toggle-row:has-text("On all your devices") input:checked')
        shot(phone, 'sync-01-account')
        toggle(phone, 'On all your devices', False)
        off = wait_for(lambda: account('t').get('off') is True and account('t')['settings'] == {}, 8, 0.3)
        settings(phone, {'gridSize': 'large'})
        phone.wait_for_timeout(1500)
        stayed = account('t')['settings'] == {} and account('t')['off'] is True
        toggle(phone, 'On all your devices', True)
        back_on = wait_for(lambda: account('t').get('off') is False and account('t')['settings'].get('gridSize') == 'large', 8, 0.3)
        check('sync: it can be turned off for the account (nothing kept, nothing sent), and on again (this device\'s kept)', off and stayed and back_on,
              json.dumps(account('t')))

        # Signing out on one device leaves what's kept for the account...
        before = account('t')['settings'].get('home')
        desk.goto(APP_DEBUG + '#/settings/account')
        desk.click('.account-card button:has-text("Sign out")')
        desk.click('.sheet.open .sheet-action:has-text("Sign out")')
        desk.wait_for_url('**#/login')
        desk.wait_for_timeout(1500)
        check('sync: signing out leaves the account\'s settings (its Home screen too) as they were', account('t')['settings'].get('home') == before and before, str(account('t')['settings'].get('home')))
        # ...and what that browser still has isn't the next account's to keep.
        account('t2', 'DELETE')
        login(desk, APP_DEBUG, 't2', app_defaults=True)
        desk.wait_for_timeout(2000)
        check('sync: signed in as someone else after that, nothing that browser had goes to their account', account('t2')['rev'] == 0, json.dumps(account('t2')))
        for c in (desk_ctx, phone_ctx, sam_ctx):
            c.close()
        account('t', 'DELETE')
        account('t2', 'DELETE')

    # ---------- missingsync: Missing tracks that follow each account, and everyone's for the server's owner ----------
    if run('missingsync') and APP_DEBUG:
        SRV = 'mock-server-1'

        def lists(token, method='GET', body=None):
            req = urllib.request.Request(APP_DEBUG + f'api/missing?server={SRV}', method=method, data=json.dumps(body).encode() if body is not None else None,
                                         headers={'X-Plex-Token': token, 'Content-Type': 'application/json', 'Accept': 'application/json'})
            with urllib.request.urlopen(req, timeout=20) as r:
                return json.loads(r.read() or b'{}')

        def status_of(token):
            try:
                lists(token)
                return 200
            except urllib.error.HTTPError as err:
                return err.code

        def op_id():
            return f'{random.getrandbits(48):012x}'

        def titles(token):
            return sorted(m['title'] or m['artist'] for m in lists(token)['entries'])

        def note(pg, items, prompt, via=''):
            return js(pg, f"() => import('./js/missing.js').then((m) => m.noteMissing({json.dumps(items)}, {{ songs: [], artists: [] }}, {json.dumps(prompt)}, {{ via: {json.dumps(via)} }}).of)")

        def queued(pg):
            return js(pg, "() => Object.keys(localStorage).filter((k) => k.startsWith('pw.aiMissingOp.')).length")

        def sent(pg, timeout=10):
            return wait_for(lambda: queued(pg) == 0, timeout, 0.3)

        def here(pg):
            return js(pg, "() => JSON.parse(localStorage.getItem('pw.aiMissing') || '[]').map((m) => m.title || m.artist).sort()")

        # A Spotify playlist's listId: twelve bits of a hash of its name
        # (before 0.25.0, the whole hash: `whole`).
        def list_hash(name):
            x = 0x811c9dc5
            for ch in name.strip().lower():
                x = ((x ^ ord(ch)) * 0x01000193) & 0xffffffff
            return x

        def base36(n):
            digits = '0123456789abcdefghijklmnopqrstuvwxyz'
            out = ''
            while True:
                n, r = divmod(n, 36)
                out = digits[r] + out
                if not n:
                    return out

        def list_id(name, whole=False):
            return base36(list_hash(name) if whole else list_hash(name) >> 20)

        def rows(pg, until=None, timeout=10):
            pg.goto(APP_DEBUG + '#/settings/ai')
            pg.goto(APP_DEBUG + '#/settings/missing')
            pg.wait_for_selector('.missing-row, .missing-body .empty-state', timeout=10000)
            got = lambda: pg.locator('.missing-row').all_inner_texts()
            # (Read again as it opens: until it says what's expected, if anything is.)
            if until:
                wait_for(lambda: until(got()), timeout, 0.3)
            else:
                pg.wait_for_timeout(1200)
            return got()

        def device(name, token='t', seed=None):
            c = browser.new_context(**MOBILE)
            if seed is not None:
                # A browser that had the app before, with a list of its own
                # (as 0.23.0 kept it, or 0.24.0 for a friend): signed in
                # already, or not (then it signs in now).
                c.add_init_script("if (!sessionStorage.getItem('pw-test-seeded')) { sessionStorage.setItem('pw-test-seeded', '1');"
                                  f" for (const [k, v] of Object.entries({json.dumps(seed)})) localStorage.setItem(k, JSON.stringify(v)); }}")
            pg = c.new_page()
            attach(pg, name)
            bodies = []
            pg.on('request', lambda r: 'api/missing' in r.url and bodies.append(r.post_data or ''))
            if seed is not None and 'pw.auth' in seed:
                pg.goto(APP_DEBUG)
                pg.wait_for_selector('.wide-card:not(.skeleton)', timeout=20000)
            else:
                login(pg, APP_DEBUG, token, app_defaults=True)
            return c, pg, bodies

        # (Everyone's on the server, cleared by its owner: as if new.)
        lists('t', 'POST', {'ops': [{'type': 'clear', 'id': op_id(), 'everyone': True}]})

        # The server's owner's browser with a list from before (0.23.0): it
        # goes to the account, put together, without what was asked for or
        # the playlist's name.
        desk_ctx, desk, desk_sent = device('missing-desk')
        was = js(desk, "() => import('./js/state.js').then(({ app }) => ({ auth: app.auth, source: app.source }))")
        sec = was['source']['sectionKey']
        lib = f"{was['source']['sectionTitle']} ({was['source']['serverName']})"
        now = int(time.time())
        legacy = [
            {'kind': 'artist', 'artist': 'Legacy Band', 'title': '', 'times': 2, 'first': now - 1000, 'last': now - 500, 'prompt': 'dan old secret', 'server': SRV, 'section': sec, 'library': lib},
            {'kind': 'track', 'artist': 'Old Spotify', 'title': 'Old Tune', 'via': 'spotify', 'lists': [list_id('Dans Old List', True), list_id('Dans Other List', True)],
             'times': 1, 'first': now - 900, 'last': now - 400, 'prompt': 'Dans Old List', 'server': SRV, 'section': sec, 'library': lib},
            {'kind': 'track', 'artist': 'Elsewhere', 'title': 'Other Server Song', 'times': 1, 'first': now - 100, 'last': now - 100, 'prompt': 'x', 'server': 'another-server', 'section': '1', 'library': 'X'},
        ]
        old_ctx, old, old_sent = device('missing-old', seed={'pw.auth': was['auth'], 'pw.source': was['source'], 'pw.aiMissing': legacy})
        up = wait_for(lambda: titles('t') == ['Legacy Band', 'Old Tune'], 10, 0.3)
        kept = lists('t')
        tune = next((m for m in kept['entries'] if m['title'] == 'Old Tune'), {})
        check('missingsync: the owner\'s list from before goes to their account, as it is (that server\'s, put together)', up and next(m for m in kept['entries'] if m['artist'] == 'Legacy Band')['times'] == 2
              and len(tune.get('lists', [])) == 2, json.dumps(kept)[:300])
        check('missingsync: ...without what was asked for, or the Spotify playlist\'s name (they stay on that device)',
              not any(w in json.dumps(kept) + ' '.join(old_sent) for w in ('secret', 'Dans Old List')), ' '.join(old_sent)[:300])
        short = [list_id('Dans Old List'), list_id('Dans Other List')]
        whole = [list_id('Dans Old List', True), list_id('Dans Other List', True)]
        here_lists = js(old, "() => JSON.parse(localStorage.getItem('pw.aiMissing') || '[]').filter((m) => m.lists).map((m) => m.lists)")
        check('missingsync: ...its playlists counted by twelve bits of a hash of each name, the whole hash from before cut down, in the browser and on the player (never sent)',
              here_lists == [short] and tune.get('lists') == short and not any(w in json.dumps(kept) + ' '.join(old_sent) for w in whole), f'{here_lists} {tune.get("lists")} {short}')
        old_rows = rows(old, lambda r: any('Dans Old List' in x for x in r))
        check('missingsync: ...where they\'re still shown', any('Dans Old List' in r for r in old_rows), str(old_rows))

        # Another browser of the same account has them: what was asked for
        # isn't there. The server's owner is told the list is everyone's.
        desk_rows = rows(desk, lambda r: len(r) == 2)
        lede = desk.locator('.missing-lede').inner_text()
        shot(desk, 'missingsync-01-another-device')
        check('missingsync: another browser of the account has the same list', sorted(r.split('\n')[0] for r in desk_rows) == ['Legacy Band', 'Old Tune'], str(desk_rows))
        check('missingsync: ...without what was asked for or the playlist\'s name', not any(w in ' '.join(desk_rows) for w in ('secret', 'Dans Old List')), str(desk_rows))
        check('missingsync: ...and, for the server\'s owner, it says it\'s everyone\'s (with no switch of any kind)',
              'yours and your friends' in lede and 'Kept for your Plex account' in lede and desk.locator('.missing-lede ~ .rows label').count() == 0, lede)

        # Noted on one device, on the other once it's read again; counted again.
        note(desk, [{'kind': 'track', 'artist': 'Shared Artist', 'title': 'Shared Song'}], 'dan request')
        sent(desk)
        note(old, [{'kind': 'track', 'artist': 'Shared Artist', 'title': 'Shared Song'}], 'dan again')
        sent(old)
        again = rows(desk, lambda r: any(x.startswith('Shared Song') and 'suggested 2 times' in x for x in r))
        check('missingsync: noted on one device, counted on the other', any(r.startswith('Shared Song') and 'suggested 2 times' in r for r in again), str(again))

        # A friend: theirs is kept for their account as they use it, with
        # the list their browser had from before (put together with it the
        # first time), so the server's owner sees what's missing; they're
        # told so, and there's no switch.
        before = {'kind': 'track', 'artist': 'Friend Artist', 'title': 'Friend Before', 'times': 1, 'first': now - 50, 'last': now - 50, 'prompt': 'friend old secret', 'server': SRV, 'section': sec, 'library': lib}
        sam_ctx, sam, sam_sent = device('missing-sam', 't2', seed={'pw.aiMissing': [before]})
        went = wait_for(lambda: titles('t2') == ['Friend Before'], 10, 0.3)
        check('missingsync: a friend\'s list from before goes to their account the first time, without what was asked for', went and 'friend old secret' not in ' '.join(sam_sent),
              f'{titles("t2")} {" ".join(sam_sent)[:300]}')
        note(sam, [{'kind': 'track', 'artist': 'Shared Artist', 'title': 'Shared Song'}, {'kind': 'track', 'artist': 'Friend Artist', 'title': 'Friend Only'}], 'friend secret request')
        note(sam, [{'kind': 'track', 'artist': 'Friend Artist', 'title': 'Friend Spotify'}], 'Friends Gym', via='spotify')
        went = sent(sam) and wait_for(lambda: titles('t2') == ['Friend Before', 'Friend Only', 'Friend Spotify', 'Shared Song'], 10, 0.3)
        theirs = lists('t2')
        check('missingsync: what a friend notes goes to their account as they use it', went and 'shared' not in theirs and 'others' not in theirs and set(theirs['rev']) == {'mine'},
              json.dumps(theirs)[:300])
        check('missingsync: ...never with what they asked for, or their playlist\'s name (in what\'s sent, or kept)',
              not any(w in json.dumps(theirs) + ' '.join(sam_sent) for w in ('friend secret', 'friend old secret', 'Friends Gym')), ' '.join(sam_sent)[:300])
        sam_rows = rows(sam, lambda r: len(r) == 4)
        sam_lede = sam.locator('.missing-lede').inner_text()
        shot(sam, 'missingsync-02-friend')
        check('missingsync: ...their page has theirs only, says whoever runs the server sees them, and has no switch',
              sorted(r.split('\n')[0] for r in sam_rows) == ['Friend Before', 'Friend Only', 'Friend Spotify', 'Shared Song'] and 'Whoever runs ' in sam_lede and 'sees them too' in sam_lede
              and sam.locator('.missing-lede ~ .rows label').count() == 0, f'{sam_rows} {sam_lede}')
        sam.goto(APP_DEBUG + '#/settings/ai')
        sam.wait_for_selector('label.toggle-row:has-text("Show missing tracks")')
        told = sam.locator('label.toggle-row', has_text='Show missing tracks').inner_text()
        check('missingsync: ...as Settings › AI › Show missing tracks does, with no switch to keep them on the device',
              'sees them too' in told and sam.locator('.ai-missing-settings label.toggle-row', has_text='Keep them for your Plex account').count() == 0, told)
        check('missingsync: someone who can\'t use the server can\'t have a list for it', status_of('t3') == 403)
        refused = lists('t2', 'POST', {'ops': [{'type': 'clear', 'id': op_id(), 'everyone': True}]})
        check('missingsync: ...and a friend can\'t change everyone\'s', refused.get('skipped') == 1 and len(titles('t2')) == 4, json.dumps(refused))
        stale = lists('t2', 'POST', {'ops': [{'type': 'unshare', 'id': op_id()}]})
        check('missingsync: ...nor take theirs off the player as 0.24.0 could (a page of it still open)', stale.get('skipped') == 1 and len(titles('t2')) == 4, json.dumps(stale))

        # The server's owner sees everyone's: whose, and how often in all.
        owner_rows = rows(desk, lambda r: any(x.startswith('Friend Only') for x in r))
        shot(desk, 'missingsync-03-owner')
        shared = next((r for r in owner_rows if r.startswith('Shared Song')), '')
        friend = next((r for r in owner_rows if r.startswith('Friend Only')), '')
        spot = next((r for r in owner_rows if r.startswith('Friend Spotify')), '')
        check('missingsync: the server\'s owner sees friends\', whose, and how often in all',
              'suggested 3 times' in shared and 'you and Sam' in shared and friend.endswith('· Sam') and 'in a playlist from Spotify' in spot, str(owner_rows))
        check('missingsync: ...never what they asked for, or their playlist\'s name', not any(w in ' '.join(owner_rows) for w in ('friend secret', 'Friends Gym')), str(owner_rows))
        with desk.expect_download() as dl:
            desk.click('.missing-csv')
        csv_text = open(dl.value.path(), encoding='utf-8-sig').read()
        check('missingsync: ...and the spreadsheet has them all, without whose', 'Friend Only' in csv_text and 'Sam' not in csv_text and 'you and' not in csv_text, csv_text[:300])

        # The owner takes one off: off the friend's list too.
        desk.locator('.missing-row', has_text='Friend Only').locator('button').click()
        sent(desk)
        check('missingsync: one the owner takes off is off the friend\'s list too', 'Friend Only' not in titles('t2')
              and not any(r.startswith('Friend Only') for r in rows(sam, lambda r: not any(x.startswith('Friend Only') for x in r))), str(titles('t2')))

        # Changed offline: kept here, and sent once it's back.
        desk_ctx.set_offline(True)
        rows(desk)
        desk.locator('.missing-row', has_text='Shared Song').locator('button').click()
        desk.wait_for_timeout(1500)
        waiting = queued(desk)
        desk_ctx.set_offline(False)
        desk.evaluate("() => window.dispatchEvent(new Event('online'))")
        went = sent(desk, 15)
        check('missingsync: a change made offline is kept, and sent once it\'s back', waiting == 1 and went and 'Shared Song' not in titles('t') and 'Shared Song' not in titles('t2'),
              f'{waiting} {titles("t")} {titles("t2")}')

        # Check again, for the owner: found in the library now, it's off
        # everyone's.
        real = mock('/library/sections/1/all?type=10&X-Plex-Container-Size=1&X-Plex-Token=t')['MediaContainer']['Metadata'][0]
        note(sam, [{'kind': 'track', 'artist': real.get('originalTitle') or real['grandparentTitle'], 'title': real['title']}], 'friend secret 2')
        sent(sam)
        rows(desk, lambda r: any(x.startswith(real['title']) for x in r))
        desk.click('.missing-check')
        desk.wait_for_selector('.missing-status:has-text("off the list"), .missing-status:has-text("yet")', timeout=30000)
        sent(desk)
        check('missingsync: Check again, for the owner, takes what\'s in the library now off the friend\'s list too', real['title'] not in titles('t2'), str(titles('t2')))

        # Signing out leaves the account's; the next account on that browser
        # gets none of it.
        before = titles('t')
        desk.goto(APP_DEBUG + '#/settings/account')
        desk.click('.account-card button:has-text("Sign out")')
        desk.click('.sheet.open .sheet-action:has-text("Sign out")')
        desk.wait_for_url('**#/login')
        sam_before = titles('t2')
        login(desk, APP_DEBUG, 't2', app_defaults=True)
        desk.wait_for_timeout(2000)
        check('missingsync: signing out leaves the account\'s list, and the next account on that browser gets none of it', titles('t') == before and titles('t2') == sam_before
              and not any(t in here(desk) for t in before), f'{titles("t")} {titles("t2")} {here(desk)}')
        # Signed in over someone (without signing out): theirs isn't the new
        # account's.
        js(old, "() => import('./js/state.js').then(({ setAuth, app }) => setAuth({ ...app.auth, token: 't2', username: 'sam' }))")
        old.evaluate("() => { location.hash = '#/'; }")
        old.reload()
        old.wait_for_selector('.wide-card:not(.skeleton)', timeout=20000)
        old.wait_for_timeout(2000)
        check('missingsync: signed in over someone, what that browser had isn\'t the new account\'s', titles('t2') == sam_before and 'Legacy Band' not in here(old), f'{titles("t2")} {here(old)}')

        # Clear the list, for the owner: everyone's.
        lists('t2', 'POST', {'ops': [{'type': 'note', 'id': op_id(), 'items': [{'kind': 'artist', 'artist': 'Sams Band'}], 'section': sec, 'library': lib}]})
        own_ctx, own, _ = device('missing-owner')
        rows(own, lambda r: any(x.startswith('Sams Band') for x in r))
        own.click('.missing-clear button')
        own.click('.ask-form .btn-danger')
        sent(own)
        check('missingsync: the owner\'s Clear the list clears friends\' too', lists('t')['entries'] == [] and lists('t2')['entries'] == [], f'{titles("t")} {titles("t2")}')
        for c in (desk_ctx, old_ctx, sam_ctx, own_ctx):
            c.close()

        # A change made before 0.25.0 and still to go (made offline, say, or
        # as a page closed): sent with its playlist's id cut down too.
        dan_id = lists('t')['account']
        qop = {'type': 'note', 'id': op_id(), 'items': [{'kind': 'track', 'artist': 'Queued Artist', 'title': 'Queued Song'}], 'found': [], 'unreal': [],
               'via': 'spotify', 'list': list_id('Dans Queued List', True), 'section': sec, 'library': lib, 'at': now}
        q_ctx, q_pg, q_sent = device('missing-queued', seed={'pw.auth': was['auth'], 'pw.source': was['source'], 'pw.aiMissingSynced': {'account': dan_id, 'servers': {SRV: ''}},
                                                            'pw.aiMissingOp.00000000000000001qqq': {'account': dan_id, 'server': SRV, 'op': qop}})
        went = wait_for(lambda: 'Queued Song' in titles('t'), 10, 0.3)
        q = next((m for m in lists('t')['entries'] if m['title'] == 'Queued Song'), {})
        check('missingsync: a change from before 0.25.0, still to go, is sent with its playlist\'s id cut down',
              went and q.get('lists') == [list_id('Dans Queued List')] and list_id('Dans Queued List', True) not in ' '.join(q_sent), f'{q} {" ".join(q_sent)[:300]}')
        q_ctx.close()
        lists('t', 'POST', {'ops': [{'type': 'clear', 'id': op_id(), 'everyone': True}]})

        # Where the player doesn't keep them for each account, nothing goes
        # to it: each device has its own, as before.
        local_ctx = browser.new_context()
        local = local_ctx.new_page()
        attach(local, 'missing-local')
        asked = []
        local.on('request', lambda r: 'api/missing' in r.url and asked.append(r.url))
        login(local, APP)
        note(local, [{'kind': 'track', 'artist': 'Local Artist', 'title': 'Local Song'}], 'here only')
        local.goto(APP + '#/settings/missing')
        local.wait_for_selector('.missing-row')
        local_lede = local.locator('.missing-lede').inner_text()
        check('missingsync: with SYNC_MISSING_TRACKS=false, nothing goes to the player, and the list says it\'s this device\'s',
              not asked and 'kept on this device' in local_lede and local.locator('.missing-lede ~ .rows label').count() == 0, f'{asked} {local_lede}')
        local_ctx.close()

    # ---------- mb: the MusicBrainz features (MUSICBRAINZ_ADVANCED) ----------
    if run('mb') and APP_MB:
        mock('/__mock/musicbrainz?reset=1')
        mock('/__mock/edits?reset=1')
        edits = lambda: mock('/__mock/edits')['MediaContainer']['edits']
        named = {a['title']: a for a in mock('/library/sections/1/all?type=8&X-Plex-Container-Size=100&X-Plex-Token=t')['MediaContainer']['Metadata']}
        albums_of = lambda: {a['title']: a for a in mock('/library/sections/1/all?type=9&X-Plex-Container-Size=500&X-Plex-Token=t')['MediaContainer']['Metadata']}
        ctx = browser.new_context(**MOBILE)
        page = ctx.new_page()
        attach(page, 'mb')
        login(page, APP_MB)
        group = lambda g: page.locator(f'.view section[data-group="{g}"] .card-title').all_inner_texts()
        missing = lambda kind: page.locator(f'.view .mb-missing-kind[data-kind="{kind}"] .row-title').all_inner_texts()

        def artist_page(name, until='.view .mb-missing'):
            page.goto(APP_MB + '#/')
            page.goto(APP_MB + f"#/artist/{named[name]['ratingKey']}")
            page.wait_for_selector(until, timeout=20000)

        # Settings › MusicBrainz, where the player has them: each on to begin
        # with, and for the server's owner, the years and genres to fix.
        page.goto(APP_MB + '#/settings')
        page.locator('a.row[href="#/settings/musicbrainz"]').click()
        page.wait_for_selector('label.toggle-row:has-text("Skip live tracks and demos")')
        shot(page, 'mb-01-settings')
        on = [page.locator('label.toggle-row', has_text=t).locator('input').is_checked() for t in ('Skip live tracks and demos', 'Missing albums on artist pages', 'Original release years')]
        kinds_now = page.locator('.mb-kinds-row .row-sub').inner_text()
        check('mb: Settings › MusicBrainz, each on to begin with, the missing albums\' kinds, and for the owner, the years and genres to fix',
              on == [True, True, True] and kinds_now == 'Albums, Singles & EPs, Compilations, Soundtracks, Remixes'
              and page.locator('a.row[href="#/settings/mbreview"]').count() == 1, f'{on} {kinds_now}')

        # An artist's page: their albums the library hasn't (of the kinds
        # chosen), each linked to MusicBrainz.
        artist_page('Glass Harbour')
        shot(page, 'mb-02-artist')
        links = page.locator('.view .mb-missing-row').evaluate_all('rs => rs.map((r) => [r.getAttribute("href"), r.getAttribute("rel"), r.getAttribute("target")])')
        heads = [t.upper() for t in page.locator('.view .block h2').all_inner_texts()]
        check('mb: an artist\'s page lists their albums MusicBrainz has and the library hasn\'t, by kind, after their own (none of theirs, nor live albums or demos)',
              missing('Albums') == ['Sea Glass'] and missing('Singles & EPs') == ['Undertow'] and page.locator('.view .mb-missing-kind').count() == 2
              and 'NOT IN YOUR LIBRARY' in heads and heads.index('NOT IN YOUR LIBRARY') > heads.index('SINGLES & EPS') and heads.index('NOT IN YOUR LIBRARY') < heads.index('SIMILAR ARTISTS'),
              f'{missing("Albums")} {missing("Singles & EPs")} {heads}')
        check('mb: ...each opening MusicBrainz in a tab of its own, without saying where from',
              links and all(h.startswith('https://musicbrainz.org/release-group/') and 'noreferrer' in (r or '') and t == '_blank' for h, r, t in links), str(links))
        page.click('.view .mb-kinds-btn')
        page.wait_for_selector('.sheet.open label.toggle-row:has-text("Demos")')
        page.locator('.sheet.open label.toggle-row', has_text='Demos').locator('input').click()
        page.keyboard.press('Escape')
        page.wait_for_selector('.sheet', state='detached')
        page.wait_for_selector('.view .mb-missing-kind[data-kind="Demos"]', timeout=5000)
        demos = missing('Demos')
        saved = js(page, "() => import('./js/state.js').then(({ app }) => app.settings.mbMissingKinds)")
        check('mb: ...of the kinds chosen there (Kinds…), straight away', demos == ['Early Tapes'] and 'demos' in saved, f'{demos} {saved}')
        with page.expect_download() as dl:
            page.click('.view .mb-missing-csv')
        csv_text = open(dl.value.path(), encoding='utf-8-sig').read()
        check('mb: ...and downloaded, all of them, with their MusicBrainz release groups', dl.value.suggested_filename.startswith('missing-albums-Glass-Harbour-')
              and all(t in csv_text for t in ('Sea Glass', 'Undertow', 'Early Tapes', 'musicbrainz.org/release-group/')) and 'Tidal Lines' not in csv_text, csv_text[:300])
        settings(page, {'mbMissingKinds': ['albums', 'singles', 'compilations', 'soundtracks', 'remixes']})

        # An album Plex hasn't typed: grouped by MusicBrainz's kind for it,
        # and, live, left out of a shuffle of the artist.
        mock('/__mock/add-album?title=Harbour%20Lights%20Live&untyped=1')
        artist_page('Glass Harbour', '.view section[data-group="Live albums"]')
        live_group = group('Live albums')
        page.locator('.view .hero-actions button[aria-label="Shuffle"]').click()
        wait_for(lambda: player(page, "p.state === 'playing'"), 10)
        shuffled = player(page, 'p.queue.map((t) => t.album)')
        player(page, 'p.pause()')
        check('mb: an album Plex hasn\'t typed is grouped by MusicBrainz\'s kind, and as a live album, left out of a shuffle of the artist',
              live_group == ['Harbour Lights Live'] and 'Harbour Lights Live' not in group('Albums') and shuffled and 'Harbour Lights Live' not in shuffled and 'Tidal Lines' in shuffled,
              f'{live_group} {group("Albums")} {sorted(set(shuffled or []))}')

        # Live tracks and demos left out of what the app picks for you, by
        # their album's kind (Plex's) or their title; not with it off.
        def shuffle_artist(name):
            artist_page(name, '.view section[data-group="Live albums"]')
            page.locator('.view .hero-actions button[aria-label="Shuffle"]').click()
            wait_for(lambda: player(page, "p.state === 'playing'"), 10)
            got = player(page, 'p.queue.map((t) => t.album)')
            player(page, 'p.pause()')
            return set(got or [])
        skipped = shuffle_artist('Marisol Vega')
        settings(page, {'mbSkipLive': False})
        kept = shuffle_artist('Marisol Vega')
        settings(page, {'mbSkipLive': True})
        titles = js(page, """() => import('./js/mb.js').then((m) => ['Song (Live)', 'Song - Live at the Fillmore', '[Live] Song', 'Live at Budokan', 'Song (Demo)', 'Song - Early Demo',
            'Song (Rough Mix)', 'Live in the Moment', 'Live Wire', 'Alive', 'Demolition'].map(m.liveOrDemoTitle))""")
        check('mb: Skip live tracks and demos: a shuffle of the artist leaves their live album out (not with it off)',
              skipped == {'Noches de Cobre'} and kept == {'Noches de Cobre', 'Live at the Lantern'}, f'{skipped} {kept}')
        check('mb: ...as it does tracks whose titles say they\'re live or demos', titles == [True] * 7 + [False] * 4, str(titles))

        # Original release years: when an album first came out, where that's
        # earlier than the year Plex has (a reissue's).
        def hearthstone_year():
            c = page.locator('.view section[data-group="Albums"] .card', has_text='Hearthstone')
            return c.locator('.card-sub').inner_text() if c.count() else ''
        artist_page('Juniper & Ash', '.view section[data-group="Albums"] .card')
        wait_for(lambda: hearthstone_year() == '1998', 10, 0.3)
        first_year = hearthstone_year()
        page.locator('.view section[data-group="Albums"] .card', has_text='Hearthstone').locator('.card-title').click()
        page.wait_for_selector('.hero-album')
        page.wait_for_selector('.hero-first:not([hidden])', timeout=10000)
        first_line = page.locator('.hero-first').inner_text()
        shot(page, 'mb-03-album')
        settings(page, {'mbOriginalYears': False})
        artist_page('Juniper & Ash', '.view section[data-group="Albums"] .card')
        page.wait_for_timeout(1500)
        plex_year = hearthstone_year()
        page.goto(APP_MB + f"#/album/{albums_of()['Hearthstone']['ratingKey']}")
        page.wait_for_selector('.hero-album')
        page.wait_for_timeout(1500)
        no_line = page.locator('.hero-first:not([hidden])').count() == 0
        settings(page, {'mbOriginalYears': True})
        check('mb: Original release years: an artist\'s album with the year it first came out, and its page says so (not with it off)',
              first_year == '1998' and first_line == 'First released in 1998' and plex_year == '2015' and no_line, f'{first_year} {first_line!r} {plex_year} {no_line}')
        artist_page('Northbound Static', '.view section[data-group="Albums"] .card')
        page.wait_for_timeout(1500)
        interference = page.locator('.view section[data-group="Albums"] .card', has_text='Interference').locator('.card-sub').inner_text()
        check('mb: ...an album of a title the artist has another of keeps the year Plex has (2016, not the other\'s 2009)', interference == '2016', interference)

        # Other names: an artist not found by their name is looked for by
        # the others MusicBrainz has for them (not without the features).
        match = """() => import('./js/playlistio.js').then((m) => m.matchEntries([{ artist: 'Нортбаунд Статик', title: 'Signal Fires' }]).then((r) => r.map((x) => x && x.grandparentTitle)))"""
        by_alias = js(page, match)
        plain = browser.new_context(**MOBILE)
        plain_page = plain.new_page()
        attach(plain_page, 'mb-plain')
        login(plain_page, APP)
        without = js(plain_page, match)
        check('mb: other names: an import finds an artist by the name MusicBrainz has for them in another script (not without the features)',
              by_alias == ['Northbound Static'] and without == [None], f'{by_alias} {without}')
        plain_page.goto(APP + f"#/artist/{named['Glass Harbour']['ratingKey']}")
        plain_page.wait_for_selector('.view section[data-similar=sonic]', timeout=10000)
        plain_page.goto(APP + '#/settings')
        plain_page.wait_for_selector('a.row[href="#/settings/ai"]')
        check('mb: ...and without them, no MusicBrainz in Settings, nor missing albums on artist pages',
              plain_page.locator('a.row[href="#/settings/musicbrainz"]').count() == 0, plain_page.url)
        plain.close()

        # For the server's owner: the years and genres to fix, in Plex,
        # locked, with Undo.
        tidal = albums_of()['Tidal Lines']['ratingKey']
        mock(f'/__mock/config?nogenre={tidal}')
        try:
            page.goto(APP_MB + '#/settings/mbreview')
            page.wait_for_selector('.mb-year-row:has-text("Hearthstone")', timeout=30000)
            page.wait_for_selector('.mb-genre-row:has-text("Tidal Lines")', timeout=30000)
            shot(page, 'mb-04-review')
            year_line = page.locator('.mb-year-row', has_text='Hearthstone').inner_text()
            page.locator('.mb-year-row', has_text='Hearthstone').locator('button').click()
            wait_for(lambda: edits(), 10, 0.3)
            fixed = edits()[-1]['q']
            page.locator('.toast-action', has_text='Undo').last.click()
            wait_for(lambda: len(edits()) >= 2, 10, 0.3)
            undone = edits()[-1]['q']
            check('mb: years to fix: Use 1998 changes the album\'s year in Plex, locked, and Undo puts it back, unlocked',
                  '2015 in Plex, 1998 on MusicBrainz' in year_line and fixed.get('year.value') == '1998' and fixed.get('year.locked') == '1'
                  and fixed.get('originallyAvailableAt.value') == '1998-03-01' and undone.get('year.value') == '2015' and undone.get('year.locked') == '0', f'{year_line!r} {fixed} {undone}')
            years_listed = page.locator('.mb-year-row .row-title').all_inner_texts()
            check('mb: ...an album of a title the artist has another of is matched by the year Plex has (Interference, 2016, isn\'t the 2009 one)',
                  'Interference' not in years_listed and 'Hearthstone' in years_listed, str(years_listed))
            page.locator('.mb-genre-row', has_text='Tidal Lines').locator('button').click()
            wait_for(lambda: len(edits()) >= 3, 10, 0.3)
            added = edits()[-1]['q']
            page.locator('.toast-action', has_text='Undo').last.click()
            wait_for(lambda: len(edits()) >= 4, 10, 0.3)
            taken = edits()[-1]['q']
            check('mb: genres to fix: Add gives an album without any MusicBrainz\'s, locked, and Undo takes them off again',
                  added.get('genre[0].tag.tag') == 'Ambient' and added.get('genre[1].tag.tag') == 'Downtempo' and added.get('genre.locked') == '1'
                  and urllib.parse.unquote(taken.get('genre[].tag.tag-', '')) == 'Ambient,Downtempo', f'{added} {taken}')
            # Fix all, and Undo for all of them.
            before = len(edits())
            fixing = len(years_listed)
            page.click('.mb-fix-years')
            page.locator('.sheet.open button', has_text='Fix them').click()
            wait_for(lambda: len(edits()) >= before + fixing, 15, 0.3)
            all_fixed = edits()[before:]
            page.wait_for_selector('.mb-undo-all', timeout=5000)
            undo_button = page.locator('.mb-undo-all').inner_text()
            page.locator('.toast-action', has_text='Undo').last.click()
            wait_for(lambda: len(edits()) >= before + 2 * fixing, 15, 0.3)
            all_back = edits()[before + fixing:]
            page.wait_for_selector('.mb-undo-all', state='detached', timeout=5000)
            check('mb: Fix all changes each in Plex, and its Undo (in a toast, and on the page till it\'s used) puts them all back',
                  f'Undo the last {fixing} fixes' in undo_button and len(all_fixed) == fixing and all(e['q'].get('year.locked') == '1' for e in all_fixed)
                  and len(all_back) == fixing and all(e['q'].get('year.locked') == '0' for e in all_back) and {e['id'] for e in all_back} == {e['id'] for e in all_fixed},
                  f'{fixing} {all_fixed} {all_back}')
            with page.expect_download() as dl:
                page.locator('.mb-review-actions button', has_text='Download').click()
            review_csv = open(dl.value.path(), encoding='utf-8-sig').read()
            check('mb: ...and the list downloads, with each album\'s MusicBrainz release group (for Picard or beets)',
                  'Hearthstone' in review_csv and 'Tidal Lines' in review_csv and 'musicbrainz.org/release-group/' in review_csv, review_csv[:300])
        finally:
            mock('/__mock/config?nogenre=')

        # A friend: the features, but not the years and genres to fix.
        friend = browser.new_context(**MOBILE)
        fpage = friend.new_page()
        attach(fpage, 'mb-friend')
        login(fpage, APP_MB, 't2')
        fpage.goto(APP_MB + '#/settings/musicbrainz')
        fpage.wait_for_selector('label.toggle-row:has-text("Skip live tracks and demos")')
        no_row = fpage.locator('a.row[href="#/settings/mbreview"]').count() == 0
        fpage.goto(APP_MB + '#/settings/mbreview')
        fpage.wait_for_selector('.view .empty-state', timeout=10000)
        told = fpage.locator('.view .empty-state').inner_text()
        check('mb: a friend has the features but not the years and genres to fix (that\'s for the server\'s owner)', no_row and 'owner' in told, told)
        friend.close()

        # What went to MusicBrainz: artists' names, never an album's title.
        asked = [urllib.parse.unquote_plus(a) for a in mock('/__mock/musicbrainz')['MediaContainer']['asked']]
        check('mb: only artists\' names went to MusicBrainz, never an album\'s title',
              asked and any('Glass Harbour' in a for a in asked) and not any(t in a for a in asked for t in ('Sea Glass', 'Tidal Lines', 'Hearthstone', 'Harbour Lights Live')),
              str(asked[:6]))
        ctx.close()

    # ---------- memory: a big library ----------
    # Waits here poll with evaluate() rather than using locators or
    # wait_for_selector: element handles Playwright keeps would themselves
    # hold pages in memory.
    if run('memory') and APP_BIG and MOCK_BIG:
        ctx = browser.new_context(**MOBILE)
        page = ctx.new_page()
        attach(page, 'memory')
        login(page, APP_BIG)
        cdp = ctx.new_cdp_session(page)
        cdp.send('Performance.enable')

        def until(expr, timeout=20):
            return wait_for(lambda: page.evaluate(expr), timeout, 0.2)

        def count(sel):
            return page.evaluate('(s) => document.querySelectorAll(s).length', sel)

        def nodes():
            for _ in range(2):
                cdp.send('HeapProfiler.collectGarbage')
            return int(next(m['value'] for m in cdp.send('Performance.getMetrics')['metrics'] if m['name'] == 'Nodes'))

        def scroll_until(sel, n, limit=400):
            for _ in range(limit):
                if count(sel) >= n:
                    break
                page.evaluate('window.scrollBy(0, 2500)')
                page.wait_for_timeout(120)
            return count(sel)

        # Leaving a long list while the next part of it is on its way: it
        # stops there rather than loading the rest of the library unseen.
        page.click('#tabs .tab[data-tab=search]')
        until("() => !!document.querySelector('a[href=\"#/browse/tracks\"]')")
        mock_big = lambda path: urllib.request.urlopen(MOCK_BIG + path, timeout=20).read()
        mock_big('/__mock/config?delay=600')
        page.click('a[href="#/browse/tracks"]')
        until("() => !!document.querySelector('.view .sentinel')")
        page.click('#tabs .tab[data-tab=home]')
        page.wait_for_timeout(5000)
        mock_big('/__mock/config?delay=0')
        page.click('#tabs .tab[data-tab=search]')
        until("() => location.hash.startsWith('#/browse/tracks') && document.querySelectorAll('.tracks .track').length > 0")
        rows = count('.tracks .track')
        check('memory: a list you leave stops loading', 0 < rows <= 200, rows)

        # ...and so does one hidden while what's typed in its search box
        # shows what matches in its place.
        page.click('#tabs .tab[data-tab=search]')
        until("() => location.hash === '#/search'")
        mock_big('/__mock/config?delay=600')
        try:
            page.click('a[href="#/browse/tracks"]')
            until("() => !!document.querySelector('.within input')")
            page.fill('.within input', 'zzzz')
            page.wait_for_timeout(6000)
            unseen = page.evaluate("() => [...document.querySelectorAll('.view .list-box')].filter((b) => b.hidden).map((b) => b.querySelectorAll('.track').length)")
        finally:
            mock_big('/__mock/config?delay=0')
        check('memory: ...and so does one hidden while its search box shows what matches', len(unseen) == 1 and unseen[0] <= 100, unseen)
        page.fill('.within input', '')
        page.wait_for_timeout(600)
        page.evaluate('window.scrollTo(0, document.body.scrollHeight)')
        more = until("() => [...document.querySelectorAll('.view .list-box')].filter((b) => !b.hidden).some((b) => b.querySelectorAll('.track').length > 100)", 10)
        check('memory: ...carrying on once it\'s shown again', more, page.evaluate("() => document.querySelectorAll('.view .list-box .track').length"))
        page.evaluate('window.scrollTo(0, 0)')

        # Far from the screen, artwork lets go of its picture, and gets it back.
        page.click('#tabs .tab[data-tab=search]')
        until("() => location.hash === '#/search'")
        page.click('a[href="#/browse/albums"]')
        until("() => document.querySelectorAll('.grid .card').length > 0")
        cards = scroll_until('.grid .card', 700)
        page.wait_for_timeout(600)
        live_imgs = count('.grid img[src]')
        on_screen = page.evaluate("""() => [...document.querySelectorAll('.grid .card')].filter((c) => {
            const r = c.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight; })
            .every((c) => !c.querySelector('.art img') || c.querySelector('.art img[src]'))""")
        check('memory: far-away artwork is let go', cards >= 700 and live_imgs < 150 and on_screen, f'{cards} cards, {live_imgs} pictures')
        page.evaluate('window.scrollTo(0, 0)')
        back = until("() => !!document.querySelector('.grid .card .art img[src]')", 5)
        check('memory: ...and comes back when you scroll back', back)

        # A huge page (thousands of rows) isn't kept once a few others have
        # been opened after it.
        page.click('#tabs .tab[data-tab=search]')
        until("() => location.hash === '#/search'")
        page.click('a[href="#/browse/tracks"]')
        until("() => document.querySelectorAll('.tracks .track').length > 0")
        scroll_until('.tracks .track', 4000)
        big = nodes()
        page.evaluate('window.scrollTo(0, 0)')
        ids = page.evaluate("() => import('./js/state.js').then(({ app }) => app.server.list(app.source.sectionKey, 9, { size: 5 }).then((r) => r.items.map((m) => m.ratingKey)))")
        for album_id in ids:
            page.evaluate('(id) => { location.hash = "#/album/" + id; }', album_id)
            until(f"() => location.hash === '#/album/{album_id}' && !!document.querySelector('.hero-album')")
        after = nodes()
        check('memory: huge pages aren\'t kept for long', after < big / 2, f'{big} -> {after} nodes')

        # Details looked up for many tracks are kept only up to a limit.
        size = page.evaluate("""() => import('./js/state.js').then(async ({ app }) => {
            const s = app.server;
            const { items } = await s.list(app.source.sectionKey, 10, { size: 400 });
            await Promise.all(items.map((m) => s.trackDetail(m.ratingKey).catch(() => null)));
            return s.cache.size; })""")
        check('memory: looked-up details are kept within a limit', 0 < size <= 300, size)

        # While playing, only the position is saved every few seconds; the
        # queue (here 1,000 tracks) only when it changes.
        page.evaluate("""() => import('./js/state.js').then(async ({ app }) => {
            const pls = await app.server.playlists(app.source.sectionKey);
            const { playPlaylist } = await import('./js/actions.js');
            await playPlaylist(pls.find((p) => p.title === 'Everything')); })""")
        until("() => import('./js/player.js').then(({ player }) => player.state === 'playing')", 15)
        page.wait_for_timeout(1500)
        page.evaluate("""() => { window.__writes = []; const set = Storage.prototype.setItem;
            Storage.prototype.setItem = function (k, v) { window.__writes.push([k, String(v).length]); return set.call(this, k, v); }; }""")
        page.wait_for_timeout(11000)
        writes = page.evaluate('() => window.__writes')
        queue_writes = [w for w in writes if w[0].startswith('pw.player.') and not w[0].endswith('.at')]
        at_writes = [w for w in writes if w[0].startswith('pw.player.') and w[0].endswith('.at')]
        queue_len = player(page, 'p.queue.length')
        check('memory: playing saves the position, not the whole queue', queue_len >= 1000 and not queue_writes and len(at_writes) >= 1,
              f'{queue_len} queued, {len(queue_writes)} queue writes, {len(at_writes)} position writes')
        ctx.close()

    browser.close()

check(f'pages: no stray "null", "undefined" or "NaN" on any page ({screens[0]} looked at)', not stray, '; '.join(stray[:8]))
failed = [name for name, ok in results if not ok]
print(f'\n{len(results) - len(failed)}/{len(results)} checks passed')
if errors:
    print('Unexpected browser errors:\n' + '\n'.join(errors))
    for e in errors[:5]:
        annotate('Browser error', e)
sys.exit(1 if failed or errors else 0)
