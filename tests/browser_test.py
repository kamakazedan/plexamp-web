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
    MOCK_PLEX        mock Plex server, e.g. http://127.0.0.1:32400
    PLEX_LOGIN_URL   server address to sign in with; empty to use the
                     container's /pms proxy
    OLLAMA_DIRECT    mock Ollama the browser can reach directly
    OLLAMA_NOTHINK   mock Ollama started with --reject-think

The apps' services must use the mock for plex.tv (PLEX_TV_URL), whose
accounts are t (Dan, who owns the server), t2 (Sam, a friend with access)
and t3 (Alex, a friend without access).

    python3 tests/browser_test.py [screenshot-dir] [section ...]

Sections: core ws ai dj nows blocked poll custom desktop together settings
home debug (default: all).
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
              tg(dan, 't.active && t.session.queue.length >= 5 && t.session.playing') and player(dan, 'p.state') == 'playing')
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
        check('home: collection cards say what they hold', subs and all(s.split()[-1] in ('albums', 'artists', 'tracks') for s in subs), str(subs))
        shot(page, 'home-01-home')
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

    browser.close()

failed = [name for name, ok in results if not ok]
print(f'\n{len(results) - len(failed)}/{len(results)} checks passed')
if errors:
    print('Unexpected browser errors:\n' + '\n'.join(errors))
sys.exit(1 if failed or errors else 0)
