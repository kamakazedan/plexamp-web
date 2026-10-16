#!/usr/bin/env python3
"""Browser tests for plexamp-web, run in headless Chromium with Playwright
against the mock Plex and Ollama servers in dev/.

CI runs them against the real container (see tests/run-browser-tests.sh).
They can also run against any server that serves web/ with a matching
config.js. Settings come from the environment:

    APP_URL          app with a shared AI model and WebSockets allowed
    APP_URL_NOWS     app with DISABLE_WEBSOCKETS=true and no shared model
    APP_URL_DEBUG    app with DEBUG=true (the debug section is skipped
                     without it)
    APP_URL_BIG      app on a mock Plex server started with --big 3000, and
    MOCK_PLEX_BIG    that server (the memory section is skipped without them)
    MOCK_PLEX        mock Plex server, e.g. http://127.0.0.1:32400
    PLEX_LOGIN_URL   server address to sign in with; empty to use the
                     container's /pms proxy
    OLLAMA_DIRECT    mock Ollama the browser can reach directly
    OLLAMA_NOTHINK   mock Ollama started with --reject-think

The apps' services must use the mock for plex.tv (PLEX_TV_URL), whose
accounts are t (Dan, who owns the server), t2 (Sam, a friend with access)
and t3 (Alex, a friend without access).

    python3 tests/browser_test.py [screenshot-dir] [section ...]

Sections: core ws ai dj nows blocked poll custom desktop nav edit cast fades
together settings home debug memory (default: all).
"""

import json
import os
import sys
import time
import urllib.request

from playwright.sync_api import sync_playwright

APP = os.environ.get('APP_URL', 'http://127.0.0.1:8081/')
APP_NOWS = os.environ.get('APP_URL_NOWS', 'http://127.0.0.1:8082/')
APP_DEBUG = os.environ.get('APP_URL_DEBUG', '')
APP_BIG = os.environ.get('APP_URL_BIG', '')
MOCK_BIG = os.environ.get('MOCK_PLEX_BIG', '').rstrip('/')
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


def annotate(title, message):
    """In GitHub Actions, a failure also becomes an annotation, shown on the
    run's summary page (and readable through the API)."""
    if os.environ.get('GITHUB_ACTIONS'):
        text = str(message).replace('%', '%25').replace('\r', ' ').replace('\n', ' ')[:900]
        print(f'::error title={title}::{text}', flush=True)


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


def shot(page, name):
    page.wait_for_timeout(400)
    page.screenshot(path=os.path.join(OUT, f'{name}.png'))


def login(page, app, token='t'):
    page.goto(app + '#/login')
    page.click('text=Use a server address and token instead')
    if LOGIN_URL:
        page.fill('input[type=url]', LOGIN_URL)
    page.fill('input[type=password]', token)
    page.click('button:has-text("Connect")')
    page.wait_for_selector('.wide-card:not(.skeleton)', timeout=20000)


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

        page.locator('section[data-section=recentlyAdded] .card').first.click()
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

        tap_tab('library')
        page.click('a.row:has-text("Albums")')
        settle('.grid .card')
        page.locator('.grid .card').nth(1).click()
        settle('.hero-album')
        tap_tab('library')
        check('nav: tapping the tab you\'re in goes to its first page', where() == '#/library', where())
        page.click('a.row:has-text("Albums")')
        settle('.grid .card')
        page.locator('.grid .card').nth(2).click()
        settle('.hero-album')
        deep = where()
        page.reload()
        settle('.hero-album')
        header_back()
        check('nav: after a reload, back still stays in the tab', where().startswith('#/browse/albums') and tab() == 'library', where())
        page.go_forward()
        page.wait_for_timeout(600)
        check('nav: forward works too', where() == deep, where())
        page.click('.back-head button[aria-label="More options"]')
        page.wait_for_selector('.sheet.open')
        page.go_back()
        page.wait_for_timeout(500)
        check('nav: back closes a sheet first', page.locator('.sheet.open').count() == 0 and where() == deep, where())

        page.goto(APP + '#/')
        settle('.page-sub')
        page.click('.page-sub')  # "on <server>": the library switcher
        page.click('.sheet.open .sheet-action:has-text("Change server")')
        settle('.source-body')
        check('nav: a link into another tab opens there', tab() == 'settings' and where() == '#/settings/source', f'{where()} in {tab()}')
        header_back()
        check('nav: ...and back goes to that tab\'s first page', where() == '#/settings', where())
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
        locked = page.locator('.view .tracks .track .drag-handle, .tracks .track .row-remove').count()
        page.click('.lock-btn')
        page.wait_for_selector('.edit-bar:not([hidden])')
        shot(page, 'edit-01-playlist-unlocked')
        check('edit: a playlist is locked until unlocked', locked == 0 and page.locator('.view .tracks .track .drag-handle').count() == made['leafCount'])
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

        def queue(ids, at):
            """Play these tracks (by id), starting `at` seconds into the first."""
            js(page, "() => Promise.all([import('./js/state.js'), import('./js/plex.js'), import('./js/player.js')])"
                     ".then(async ([{ app }, { normTrack }, { player }]) => {"
                     f" const list = await Promise.all({json.dumps(ids)}.map(async (id) => normTrack(await app.server.metadata(id))));"
                     " player.playTracks(list, 0, { context: { title: 'Fades', href: null } });"
                     " for (let i = 0; i < 100 && player.state !== 'playing'; i++) await new Promise((r) => setTimeout(r, 100));"
                     f" player.seek({at}); }})")

        def watch(seconds, until_id=None):
            """The player every 0.2 s, for `seconds` or until `until_id` has been playing a moment."""
            out = []
            end = time.time() + seconds
            while time.time() < end:
                out.append(player(page, "({ cur: p.current?.id, t: p.time, kind: p.transition?.plan.kind || null, state: p.state,"
                                        " vols: p.decks.map((d) => d.el.volume), times: p.decks.map((d) => d.el.currentTime),"
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

        # Always: at the very end of each track, album or not.
        settings(page, {'fades': 'always'})
        queue([c['ratingKey'], d['ratingKey']], 12)
        got = watch(12, d['ratingKey'])
        fading = [x for x in got if x['kind'] == 'fade']
        last, first = switch_point(got, c['ratingKey'], d['ratingKey'])
        check('fades: "Always" fades between album tracks too, at the very end',
              fading and fading[0]['t'] >= 14.5 and last is not None and last > 19 and 3.5 <= first <= 6.5,
              f'{fading[0]["t"] if fading else None}, {last} -> {first}')

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

        sam_ctx = browser.new_context(**MOBILE)
        sam = sam_ctx.new_page()
        attach(sam, 'sam')
        login(sam, APP, 't2')
        check('together: invitation shows on the tab',
              wait_for(lambda: sam.locator('#tabs .tab[data-tab=together] .tab-dot:not([hidden])').count() == 1, 15))
        sam.goto(APP + '#/together')
        sam.wait_for_selector('.together-card:has-text("Dan invited you")')
        shot(sam, 'together-03-invitation')
        sam.click('.together-card button:has-text("Join")')
        sam.wait_for_selector('.together-session')
        same = lambda: player(sam, 'p.current && p.current.sid') == player(dan, 'p.current && p.current.sid')
        check('together: joining plays the same track', wait_for(lambda: same() and player(sam, 'p.state') == 'playing', 10))
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
        settings(page, {'codecBadges': False, 'previewButtons': True, 'oneTapPlayback': True})
        page.reload()
        page.wait_for_selector('.hero-album')
        check('settings: codec badge can be turned off', page.locator('.codec-badge').count() == 0)
        page.locator('.album-tracks .track-main').first.click()  # the reload stopped playback
        wait_for(lambda: player(page, "p.state === 'playing'"), 10)
        page.locator('.album-tracks .track-preview').nth(2).click()
        check('settings: preview plays without touching the queue',
              wait_for(lambda: not player(page, 'p.isPlaying'), 5) and page.locator('.track-preview.on').count() == 1)
        page.locator('.album-tracks .track-preview.on').click()
        check('settings: playback carries on after a preview', wait_for(lambda: player(page, 'p.isPlaying'), 5))

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
        page.goto(APP + '#/library/playlists')
        page.wait_for_selector('.grid .card')
        before = page.locator('.card-title').all_text_contents()
        settings(page, {'playlistsAllLibraries': False})
        page.reload()
        page.wait_for_selector('.grid .card')
        after = page.locator('.card-title').all_text_contents()
        check('settings: playlists from this library only', 'Bedtime stories' in before and 'Bedtime stories' not in after, f'{before} / {after}')
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
        check('home: Stations', page.locator('section[data-section=stations] .station').count() == 4)
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

    # ---------- debug: DEBUG=true ----------
    if run('debug') and APP_DEBUG:
        ctx = browser.new_context(**MOBILE)
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
        page.click('#tabs .tab[data-tab=library]')
        until("() => !!document.querySelector('a[href=\"#/browse/tracks\"]')")
        mock_big = lambda path: urllib.request.urlopen(MOCK_BIG + path, timeout=20).read()
        mock_big('/__mock/config?delay=600')
        page.click('a[href="#/browse/tracks"]')
        until("() => !!document.querySelector('.view .sentinel')")
        page.click('#tabs .tab[data-tab=home]')
        page.wait_for_timeout(5000)
        mock_big('/__mock/config?delay=0')
        page.click('#tabs .tab[data-tab=library]')
        until("() => location.hash.startsWith('#/browse/tracks') && document.querySelectorAll('.tracks .track').length > 0")
        rows = count('.tracks .track')
        check('memory: a list you leave stops loading', 0 < rows <= 200, rows)

        # Far from the screen, artwork lets go of its picture, and gets it back.
        page.click('#tabs .tab[data-tab=library]')
        until("() => location.hash === '#/library'")
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
        page.click('#tabs .tab[data-tab=library]')
        until("() => location.hash === '#/library'")
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

failed = [name for name, ok in results if not ok]
print(f'\n{len(results) - len(failed)}/{len(results)} checks passed')
if errors:
    print('Unexpected browser errors:\n' + '\n'.join(errors))
    for e in errors[:5]:
        annotate('Browser error', e)
sys.exit(1 if failed or errors else 0)
