#!/usr/bin/env python3
"""Browser tests for plexamp-web, run in headless Chromium with Playwright
against the mock Plex and Ollama servers in dev/.

CI runs them against the real container (see tests/run-browser-tests.sh).
They can also run against any server that serves web/ with a matching
config.js. Settings come from the environment:

    APP_URL          app with a shared AI model and WebSockets allowed
    APP_URL_NOWS     app with DISABLE_WEBSOCKETS=true and no shared model
    MOCK_PLEX        mock Plex server, e.g. http://127.0.0.1:32400
    PLEX_LOGIN_URL   server address to sign in with; empty to use the
                     container's /pms proxy
    OLLAMA_DIRECT    mock Ollama the browser can reach directly
    OLLAMA_NOTHINK   mock Ollama started with --reject-think

    python3 tests/browser_test.py [screenshot-dir] [section ...]

Sections: core ws ai dj nows blocked poll custom desktop (default: all).
"""

import json
import os
import sys
import time
import urllib.request

from playwright.sync_api import sync_playwright

APP = os.environ.get('APP_URL', 'http://127.0.0.1:8081/')
APP_NOWS = os.environ.get('APP_URL_NOWS', 'http://127.0.0.1:8082/')
MOCK = os.environ.get('MOCK_PLEX', 'http://127.0.0.1:32400').rstrip('/')
LOGIN_URL = os.environ.get('PLEX_LOGIN_URL', '')
OLLAMA = os.environ.get('OLLAMA_DIRECT', 'http://127.0.0.1:11434').rstrip('/')
OLLAMA_NOTHINK = os.environ.get('OLLAMA_NOTHINK', 'http://127.0.0.1:11435').rstrip('/')
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


def check(name, ok, detail=''):
    results.append((name, bool(ok)))
    print(('PASS ' if ok else 'FAIL ') + name + (f' — {detail}' if detail and not ok else ''), flush=True)


def attach(page, tag):
    def on_console(m):
        if m.type in ('error', 'warning') and not any(n in m.text for n in EXPECTED_NOISE):
            errors.append(f'[{tag}] console.{m.type}: {m.text}')

    page.on('console', on_console)
    page.on('pageerror', lambda e: errors.append(f'[{tag}] page error: {e}'))


def shot(page, name):
    page.wait_for_timeout(400)
    page.screenshot(path=os.path.join(OUT, f'{name}.png'))


def login(page, app):
    page.goto(app + '#/login')
    page.click('text=Use a server address and token instead')
    if LOGIN_URL:
        page.fill('input[type=url]', LOGIN_URL)
    page.fill('input[type=password]', 't')
    page.click('button:has-text("Connect")')
    page.wait_for_selector('.wide-card:not(.skeleton)', timeout=20000)


def js(page, expr):
    return page.evaluate(expr)


def player(page, expr):
    return js(page, f"() => import('./js/player.js').then(m => {{ const p = m.player; return {expr}; }})")


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
        mock(f'/:/rate?key={cur}&rating=6&identifier=com.plexapp.plugins.library&X-Plex-Token=t')
        check('ws: rating made in another app appears', wait_for(lambda: page.locator('.star.on').count() == 3, 10),
              f"{page.locator('.star.on').count()} stars")
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
        based = page.locator('.ai-based').inner_text()
        check('ai: built from library tags and real artists', 'Glass Harbour' in based and 'Not A Real Band' not in based, based)
        page.click('button:has-text("Save to Plex")')
        page.wait_for_selector('.toast')
        after = mock('/playlists?X-Plex-Token=t')['MediaContainer']['Metadata']
        check('ai: saved to Plex', len(after) == before + 1 and after[-1]['title'] == title, f'{len(after)} playlists')
        page.click('.ai-actions button:has-text("Play")')
        check('ai: plays the generated playlist', wait_for(lambda: player(page, 'p.context && p.context.title') == title, 10))
        page.goto(APP + '#/settings/ai')
        page.wait_for_selector('text=Connected', timeout=15000)
        models = page.locator('.ai-models .radio-row .row-title').all_text_contents()
        check('ai: lists chat models only', models == ['llama3.1:8b', 'qwen2.5:7b'], str(models))
        page.click('button:has-text("Test the model")')
        check('ai: model test through the container', page.wait_for_selector('text=It works', timeout=20000) is not None)
        shot(page, 'ai-03-settings')

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
        js(page, "() => import('./js/dj.js').then(m => m.guestDJ.set(null))")
        page.keyboard.press('Escape')
    ctx.close()

    # ---------- nows: DISABLE_WEBSOCKETS ----------
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
        check('nows: Connection page explains WebSockets are off', 'DISABLE_WEBSOCKETS' in status, status)
        shot(page, 'nows-01-connection')
        page.click('button:has-text("Reconnect live updates")')
        check('nows: reconnecting still avoids WebSockets', wait_mode(page, 'eventsource', 30) == 'eventsource')
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

    # ---------- custom: this device's own Ollama ----------
    if run('custom'):
        ctx = browser.new_context(**MOBILE)
        page = ctx.new_page()
        attach(page, 'custom')
        login(page, APP_NOWS)
        page.goto(APP_NOWS + '#/ai-playlist')
        page.wait_for_selector('.ai-setup')
        check('custom: asks to set up a model when there is no shared one', True)
        shot(page, 'custom-01-setup')
        page.goto(APP_NOWS + '#/settings/ai')
        page.click('.radio-row:has-text("My own Ollama server")')
        page.fill('.ai-custom input[type=url]', OLLAMA)
        page.click('.ai-custom button:has-text("Connect")')
        page.wait_for_selector('text=Connected', timeout=15000)
        page.click('.ai-models .radio-row:has-text("llama3.1:8b")')
        page.click('button:has-text("Test the model")')
        check('custom: own Ollama answers', page.wait_for_selector('text=It works', timeout=20000) is not None)
        page.goto(APP_NOWS + '#/ai-playlist')
        page.wait_for_selector('.ai-box input:not([disabled])')
        page.fill('.ai-box input', 'Moody electronic for a rainy evening')
        page.click('.chip:has-text("15 tracks")')
        page.press('.ai-box input', 'Enter')
        page.wait_for_selector('.ai-result', timeout=60000)
        check('custom: playlist from a typed description', page.locator('.ai-body .tracks .track').count() == 15)
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
        page.goto(APP + '#/ai-playlist')
        page.wait_for_selector('.ai-suggestion')
        page.click('.ai-suggestion')
        page.wait_for_selector('.ai-result', timeout=60000)
        page.click('.ai-actions button:has-text("Play")')
        page.wait_for_timeout(1200)
        page.click('.pb-right button[aria-label="Open now playing"]')
        page.wait_for_selector('.np.open')
        shot(page, 'desktop-02-now-playing')
        page.click('.np-tool[data-tool=dj]')
        page.wait_for_selector('.sheet.dialog.open')
        shot(page, 'desktop-03-guest-dj')
        check('desktop: Guest DJ dialog opens', True)
        ctx.close()

    browser.close()

failed = [name for name, ok in results if not ok]
print(f'\n{len(results) - len(failed)}/{len(results)} checks passed')
if errors:
    print('Unexpected browser errors:\n' + '\n'.join(errors))
sys.exit(1 if failed or errors else 0)
