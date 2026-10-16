#!/usr/bin/env python3
"""A fake Plex Media Server for working on the UI without a real library.

Serves an invented music library (made-up artists, generated cover art and
short test tones) on the endpoints plexamp-web uses, with CORS enabled.

    python3 dev/mock-plex.py            # listens on http://127.0.0.1:32400
    python3 -m http.server 8080 -d web  # serves the app

Then open http://127.0.0.1:8080, choose "Use a server address and token
instead", and connect to http://127.0.0.1:32400 with the token "t".

It also answers the plex.tv calls the container's service makes (point the
service at it with PLEX_TV_URL). Three made-up accounts:

    t    Dan, who owns this server
    t2   Sam, a friend of Dan's with access to the server
    t3   Alex, a friend of Dan's without access

Like a real server it refuses other tokens, unless /__mock/config?open=1
makes it behave like a server that lets this network in without signing in.

Live notifications are sent over a WebSocket (/:/websockets/notifications)
and an event stream (/:/eventsource/notifications), like a real server. For
testing, these endpoints need no token:

    /__mock/config?ws=0|1&sse=0|1|silent&ping=SECONDS&open=0|1&delay=MS&loved=smart|none
        ws=0 refuses WebSockets (as a blocking proxy would), sse=0 refuses the
        event stream, sse=silent accepts it but never sends anything; open=1
        accepts any token; delay=MS slows library listings down; loved=smart
        adds a smart ❤️ Tracks playlist (five-star tracks, like Plexamp's),
        loved=none removes any ❤️ Tracks
    /__mock/add-album?title=...   adds an album and announces it
    /__mock/age?id=...&days=...   marks an album as last played that long ago
    /__mock/tracks                every track, with whether it starts or ends
                                  in silence (for testing transitions)
    /__mock/player[?reset=1]      the mock Plex player: what it's playing and
                                  the commands it got

It also runs a Plex player (like Plexamp on a Raspberry Pi) on the next port
up from the server's plus 100 (32500), controlled with Plex's remote-control
protocol, and listed among Dan's devices on plex.tv as "Living Room".

Every track is a 20-second tune. Some end with 6 seconds of silence, some
start with 3, and their loudness analysis says so, the way a real server's
would.

Artwork needs Pillow (pip install pillow); without it, covers are blank.

    python3 dev/mock-plex.py 32401 --big 3000

adds 3000 more albums (and artists and tracks to go with them), for trying
the app with a large library: long grids, big playlists and memory use.

    python3 dev/mock-plex.py 32400 --tls 32443 cert.pem key.pem

also serves HTTPS on port 32443 with that certificate (for trying the
container with an https:// PLEX_SERVER_URL; a real server's certificate is
for its plex.direct name).
"""

import base64
import hashlib
import io
import json
import math
import queue
import random
import re
import struct
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

try:
    from PIL import Image, ImageDraw, ImageFont, ImageOps
except ImportError:  # pragma: no cover
    Image = ImageDraw = ImageFont = ImageOps = None

def flag_value(name, default):
    if name in sys.argv:
        i = sys.argv.index(name)
        if i + 1 < len(sys.argv) and sys.argv[i + 1].isdigit():
            return int(sys.argv[i + 1])
    return default


BIG = flag_value('--big', 0)
PORT = int(next((a for i, a in enumerate(sys.argv[1:], 1) if a.isdigit() and sys.argv[i - 1] not in ('--big', '--tls')), 32400))
TLS = None
if '--tls' in sys.argv:
    _i = sys.argv.index('--tls')
    TLS = (int(sys.argv[_i + 1]), sys.argv[_i + 2], sys.argv[_i + 3])
SECTION = '1'
NOW = int(time.time())
TRACK_SECONDS = 20
random.seed(7)

# ---------------------------------------------------------------- library

ARTISTS = [
    ('Glass Harbour', ['Electronic'], 'Bristol duo making slow-burning electronic records with field recordings from the harbour.'),
    ('The Wren Collective', ['Indie'], 'A rotating cast of musicians writing warm, ramshackle indie songs.'),
    ('Marisol Vega', ['Jazz', 'Latin'], 'Pianist and composer blending Latin rhythms with modern jazz.'),
    ('Northbound Static', ['Rock'], 'Loud, fast and fond of a long instrumental outro.'),
    ('Juniper & Ash', ['Folk'], 'Two voices, one guitar and a fiddle.'),
    ('Kilo Meridian', ['Hip-Hop'], 'Producer and MC with a soft spot for dusty soul samples.'),
    ('Various Artists', ['Electronic'], ''),
]

ALBUMS = [
    # artist index, title, year, palette, subformat, format
    (0, 'Tidal Lines', 2021, ('1e3a5f', '6fa8dc'), None, 'Album'),
    (0, 'Low Light Signals', 2018, ('3b1f4a', 'c27ba0'), None, 'Album'),
    (0, 'Buoy', 2022, ('0b3d3b', '76d7c4'), None, 'EP'),
    (1, 'Kitchen Table Hymns', 2019, ('5b3a1a', 'f6b26b'), None, 'Album'),
    (1, 'Paper Boats', 2023, ('4a4a12', 'd9d96c'), None, 'Album'),
    (2, 'Noches de Cobre', 2017, ('5c1f1f', 'e06666'), None, 'Album'),
    (2, 'Live at the Lantern', 2020, ('2b2b2b', 'b7b7b7'), 'Live', 'Album'),
    (3, 'Interference', 2016, ('1a1a1a', 'ff6d01'), None, 'Album'),
    (3, 'Long Way North', 2024, ('16324f', 'a4c2f4'), None, 'Album'),
    (4, 'Hearthstone', 2015, ('3d2b1f', 'b6a07a'), None, 'Album'),
    (5, 'Crate Digger', 2022, ('2f1b0c', 'e69138'), None, 'Album'),
    (6, 'Night Drive Vol. 1', 2020, ('101030', '8e7cc3'), 'Compilation', 'Album'),
    (6, 'The Lighthouse (Original Score)', 2021, ('0f2a2a', '93c47d'), 'Soundtrack', 'Album'),
]

WORDS = ('Harbour Lights Ember Northern Static Paper Wren Copper Tide Drift Signal Hollow Lantern Meridian Slow '
         'Glass Morning Velvet River Quiet Engine Orchard Neon Satellite Winter Salt Cinder Echo Atlas Bloom').split()

if BIG:
    big_rnd = random.Random(11)
    first = len(ARTISTS)
    for i in range(max(1, BIG // 5)):
        ARTISTS.append((f'{big_rnd.choice(WORDS)} {big_rnd.choice(WORDS)} {i + 1}',
                        [big_rnd.choice(['Electronic', 'Indie', 'Jazz', 'Rock', 'Folk', 'Hip-Hop'])], ''))
    for i in range(BIG):
        pal = ('%06x' % big_rnd.randrange(0x1000000), '%06x' % big_rnd.randrange(0x1000000))
        ALBUMS.append((first + i % max(1, BIG // 5), f'{big_rnd.choice(WORDS)} {big_rnd.choice(WORDS)} {i + 1}',
                       big_rnd.randint(1965, 2025), pal, None, 'Album'))

items = {}  # ratingKey -> metadata dict
artists, albums, tracks = [], [], []
next_key = [100]


def key():
    next_key[0] += 1
    return str(next_key[0])


def slug(v):
    return str(v).lower().replace(' ', '-')


def tag(field, value):
    return {'tag': value, 'id': slug(value), 'filter': f'{field}={slug(value)}'}


def lighten(hexc, f):
    r, g, b = (int(hexc[i:i + 2], 16) for i in (0, 2, 4))
    return '%02x%02x%02x' % tuple(min(255, int(c + (255 - c) * f)) if f > 0 else int(c * (1 + f)) for c in (r, g, b))


for idx, (name, genres, bio) in enumerate(ARTISTS):
    k = key()
    a = {
        'ratingKey': k, 'key': f'/library/metadata/{k}/children', 'type': 'artist', 'title': name,
        'titleSort': name.lower().replace('the ', ''), 'thumb': f'/library/metadata/{k}/thumb/1',
        'art': f'/library/metadata/{k}/art/1', 'summary': bio, 'Genre': [tag('genre', g) for g in genres],
        'addedAt': NOW - 86400 * (300 - idx * 20), 'viewCount': 0, 'index': 1,
    }
    items[k] = a
    artists.append(a)

for ai, (artist_idx, title, year, pal, sub, fmt) in enumerate(ALBUMS):
    artist = artists[artist_idx]
    k = key()
    al = {
        'ratingKey': k, 'key': f'/library/metadata/{k}/children', 'type': 'album', 'title': title,
        'titleSort': title.lower(), 'parentRatingKey': artist['ratingKey'], 'parentTitle': artist['title'],
        'parentThumb': artist['thumb'], 'thumb': f'/library/metadata/{k}/thumb/1', 'year': year,
        'originallyAvailableAt': f'{year}-05-01', 'Genre': artist['Genre'][:1],
        'studio': ['Harbour Records', 'Harbour Records', 'Lantern Sound'][ai % 3],
        'addedAt': NOW - 86400 * (len(ALBUMS) - ai) * (9 if not BIG else 1), 'viewCount': 0, 'leafCount': 0,
        'summary': f'{title} is the {year} release from {artist["title"]}. Recorded over a long winter, it is '
                   'patient, detailed and best heard start to finish. ' * 2,
        'Format': [{'tag': fmt}], 'Subformat': [{'tag': sub}] if sub else [],
        'Style': [tag('style', ['Ambient', 'Lo-fi', 'Downtempo', 'Post-rock', 'Bossa nova'][ai % 5])],
        'Mood': [tag('mood', ['Calm', 'Warm', 'Restless', 'Bright'][ai % 4])],
        'UltraBlurColors': [{'topLeft': lighten(pal[0], -0.35), 'topRight': lighten(pal[1], -0.45),
                             'bottomRight': lighten(pal[0], -0.1), 'bottomLeft': lighten(pal[0], -0.6)}],
        '_palette': pal,
    }
    items[k] = al
    albums.append(al)
    n = 5 + (ai % 4)
    for ti in range(n):
        tk = key()
        t_artist = artists[random.randrange(6)] if artist['title'] == 'Various Artists' else artist
        t = {
            'ratingKey': tk, 'key': f'/library/metadata/{tk}', 'type': 'track',
            'title': f'{random.choice(WORDS)} {random.choice(WORDS)}' if ti % 3 else random.choice(WORDS),
            'index': ti + 1, 'parentIndex': 1 if ti < n - 2 or ai % 5 else 2,
            'parentRatingKey': k, 'parentTitle': title, 'parentThumb': al['thumb'], 'parentYear': year,
            'grandparentRatingKey': artist['ratingKey'], 'grandparentTitle': artist['title'],
            'grandparentThumb': artist['thumb'],
            'originalTitle': t_artist['title'] if t_artist is not artist else None,
            'duration': TRACK_SECONDS * 1000, 'addedAt': al['addedAt'], 'viewCount': 0,
            'ratingCount': random.randint(0, 900000),
            'Media': [{'audioCodec': 'flac', 'container': 'flac', 'bitrate': 1411, 'Part': [
                {'key': f'/library/parts/{tk}/0/file.flac', 'duration': TRACK_SECONDS * 1000, 'container': 'flac'}]}],
        }
        if not t['originalTitle']:
            del t['originalTitle']
        items[tk] = t
        tracks.append(t)
    al['leafCount'] = n

# Some listening history so "recent" and "top" lists have content.
for i, t in enumerate(random.sample(tracks, 25)):
    t['viewCount'] = random.randint(1, 40)
    t['lastViewedAt'] = NOW - i * 5400
    alb = items[t['parentRatingKey']]
    alb['viewCount'] = alb.get('viewCount', 0) + t['viewCount']
    alb['lastViewedAt'] = max(alb.get('lastViewedAt', 0), t['lastViewedAt'])
    art_ = items[t['grandparentRatingKey']]
    art_['viewCount'] = art_.get('viewCount', 0) + t['viewCount']
    art_['lastViewedAt'] = max(art_.get('lastViewedAt', 0), t['lastViewedAt'])


# Albums last played long ago, for "Haven't played in ...".
for al in albums[9:12]:
    if not al.get('lastViewedAt'):
        al['lastViewedAt'] = NOW - 86400 * 200
        al['viewCount'] = al.get('viewCount', 0) + 3


next_entry = [5000]


def entry_id():
    next_entry[0] += 1
    return next_entry[0]


def make_playlist(title, members, smart=False, viewed=None, section=SECTION, poster=False):
    """A playlist; `poster`: with a picture of its own, set in Plex (its
    thumb), as well as the mosaic Plex makes (its composite)."""
    k = key()
    p = {
        'ratingKey': k, 'key': f'/playlists/{k}/items', 'type': 'playlist', 'playlistType': 'audio',
        'title': title, 'smart': smart, 'composite': f'/playlists/{k}/composite/1',
        'leafCount': len(members), 'duration': sum(m['duration'] for m in members),
        'addedAt': NOW - 86400 * 40, 'updatedAt': NOW - 86400 * 3, '_items': list(members),
        '_pids': [entry_id() for _ in members], '_section': section,
    }
    if viewed:
        p['lastViewedAt'] = viewed
    if poster:
        p['thumb'] = f'/library/metadata/{k}/thumb/1700000000'
    items[k] = p
    return p


def follow_rule(pl):
    """A smart playlist made from ratings (Plexamp's ❤️ Tracks): five-star
    tracks, worked out when it's asked for."""
    if pl.get('_rule') == 'loved':
        loved = [t for t in tracks if (t.get('userRating') or 0) >= 10]
        pl['_items'] = loved
        pl['_pids'] = [900000 + int(t['ratingKey']) for t in loved]
        pl['leafCount'] = len(loved)
        pl['duration'] = sum(t['duration'] for t in loved)
    return pl


def set_loved(mode):
    """/__mock/config?loved=smart adds a smart ❤️ Tracks; loved=none removes
    every ❤️ Tracks playlist."""
    for pl in [p for p in playlists if p['title'] == '❤️ Tracks']:
        playlists.remove(pl)
        items.pop(pl['ratingKey'], None)
    if mode == 'smart':
        pl = make_playlist('❤️ Tracks', [], smart=True)
        pl['_rule'] = 'loved'
        playlists.append(follow_rule(pl))


def playlist_changed(pl):
    pl['leafCount'] = len(pl['_items'])
    pl['duration'] = sum(m['duration'] for m in pl['_items'])
    pl['updatedAt'] = int(time.time())
    timeline(pl['ratingKey'], 15, 5, section='-1')


def ids_from_uri(uri):
    """Item ids from a server://.../library/metadata/1,2,3 address."""
    return [i for i in uri.rsplit('/library/metadata/', 1)[-1].split(',') if i in items] if '/library/metadata/' in uri else []


playlists = [
    make_playlist('Favourite tracks', random.sample(tracks, 18), viewed=NOW - 3600 * 20),
    make_playlist('Everything', tracks * 3, smart=True, viewed=NOW - 86400 * 2),
    make_playlist('Sunday morning', random.sample(tracks, 9)),
    make_playlist('Late night', random.sample(tracks, 14), viewed=NOW - 86400 * 9, poster=True),
    make_playlist('Workout', random.sample(tracks, 11)),
    make_playlist('Bedtime stories', random.sample(tracks, 4), section='3'),
]

COLLECTION_TYPES = {8: 'artist', 9: 'album', 10: 'track'}
collections = []
for i, (title, subtype, members) in enumerate([
    ('Harbour Records', 'album', [a for a in albums if a['studio'] == 'Harbour Records'][:5]),
    ('Rainy day albums', 'album', albums[2:6]),
    ('Best of 2022', 'track', [t for t in tracks if items[t['parentRatingKey']]['year'] == 2022]),
    ('Road trip', 'album', albums[7:11]),
    ('Piano and strings', 'artist', [artists[2], artists[4]]),
]):
    k = key()
    c = {'ratingKey': k, 'type': 'collection', 'subtype': subtype, 'title': title, 'childCount': len(members),
         'thumb': members[0].get('thumb') or members[0].get('parentThumb'), '_items': list(members),
         'addedAt': NOW - 86400 * (60 - i * 7), 'updatedAt': NOW - 86400 * (20 - i * 3), 'collectionSort': 0}
    items[k] = c
    collections.append(c)


def tag_dir(field, typ):
    pool = artists if typ == 8 else albums
    values = {}
    for it in pool:
        if field == 'decade':
            if it.get('year'):
                d = str(it['year'] // 10 * 10)
                values[d] = d + 's'
            continue
        for t in it.get(field.capitalize(), []):
            values[t['tag'].lower().replace(' ', '-')] = t['tag']
    return [{'key': k, 'title': v, 'fastKey': f'/library/sections/{SECTION}/all?type={typ}&{field}={k}'}
            for k, v in sorted(values.items())]


UNITS = {'s': 1, 'm': 60, 'h': 3600, 'd': 86400, 'w': 604800, 'mon': 2592000, 'y': 31536000}


def when(value):
    """A filter value as epoch seconds: a number, or relative like -30d or -6mon."""
    import re
    m = re.fullmatch(r'-(\d+)(mon|[smhdwy])', value)
    if m:
        return time.time() - int(m.group(1)) * UNITS[m.group(2)]
    return float(value)


def matches(it, field, value):
    values = value.split(',')
    if field == 'studio':
        return it.get('studio') in values
    if field == 'artist.id':
        return it.get('grandparentRatingKey') in values or it.get('parentRatingKey') in values
    if field.startswith('album.') and it.get('type') == 'track':
        return matches(items.get(it['parentRatingKey'], {}), field[6:], value)
    if field in ('subformat', 'album.subformat'):
        return any(t['tag'] in values for t in it.get('Subformat', []))
    if field == 'decade':
        return bool(it.get('year')) and str(it['year'] // 10 * 10) in values
    if field in ('genre', 'style', 'mood'):
        return any(slug(t['tag']) in values for t in it.get(field.capitalize(), []))
    return True


SORTS = {
    'titleSort': lambda x: x.get('titleSort', x['title'].lower()),
    'artist.titleSort': lambda x: (x.get('parentTitle') or x.get('grandparentTitle') or '').lower(),
    'album.titleSort': lambda x: (x.get('parentTitle') or '').lower(),
}


def sort_items(lst, sort):
    if not sort:
        return sorted(lst, key=SORTS['titleSort'])
    if sort == 'random':
        lst = lst[:]
        random.shuffle(lst)
        return lst
    field, _, direction = sort.partition(':')
    keyf = SORTS.get(field) or (lambda x, f=field: x.get(f) or 0)
    return sorted(lst, key=keyf, reverse=direction == 'desc')


def public(it):
    return {k: v for k, v in it.items() if not k.startswith('_')}


def track_detail(t):
    d = public(t)
    d['Media'] = [dict(t['Media'][0])]
    d['Media'][0]['Part'] = [dict(t['Media'][0]['Part'][0], Stream=[
        {'id': int(t['ratingKey']) * 10 + 1, 'streamType': 2, 'codec': 'flac',
         'bitDepth': 24 if int(t['ratingKey']) % 2 else 16,
         'samplingRate': 96000 if int(t['ratingKey']) % 2 else 44100, 'channels': 2,
         'loudness': -11.5, 'peak': 0.98}])]
    return d


# Tracks that end, or start, in silence (and are analysed: see the levels
# endpoint, which leaves every third track unanalysed).
def silent_end(rk):
    rk = int(rk)
    return rk % 4 == 1 and rk % 3 != 0


def silent_start(rk):
    rk = int(rk)
    return rk % 5 == 2 and rk % 3 != 0 and not silent_end(rk)


SILENT_END_AT = 0.7  # of the track: the last 6 seconds are silent
SILENT_START_TO = 0.15  # the first 3 seconds are silent


def loudness_levels(stream_id, n):
    # A plausible loudness curve in dB: quiet intro, a loud body with some
    # movement, a short breakdown and a fade-out, or silence where the
    # track's audio is silent.
    rnd = random.Random(stream_id)
    rk = stream_id // 10
    out = []
    for i in range(n):
        f = i / max(1, n - 1)
        base = -10 - 6 * rnd.random()
        if f < 0.04:
            base -= 22 * (1 - f / 0.04)
        if 0.72 < f < 0.745:
            base = -48
        if f > 0.94:
            base -= 30 * (f - 0.94) / 0.06
        if (silent_end(rk) and f >= SILENT_END_AT) or (silent_start(rk) and f < SILENT_START_TO):
            base = -120
        out.append({'v': round(base, 2)})
    return out


# ---------------------------------------------------------------- media

FONT = None
for path in ('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', '/System/Library/Fonts/Helvetica.ttc'):
    try:
        FONT = path
        ImageFont.truetype(path, 10)
        break
    except Exception:
        FONT = None

image_cache = {}


BLANK_PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==')


def cover_png(thumb, size):
    if Image is None:
        return BLANK_PNG
    size = max(32, min(int(size or 300), 1024))
    ck = (thumb, size)
    if ck in image_cache:
        return image_cache[ck]
    parts = thumb.strip('/').split('/')
    rk = next((x for x in parts if x.isdigit()), '0')
    it = items.get(rk, {})
    S = 512
    img = Image.new('RGB', (S, S))
    d = ImageDraw.Draw(img)
    if it.get('type') == 'album':
        c1, c2 = it['_palette']
        a = tuple(int(c1[i:i + 2], 16) for i in (0, 2, 4))
        b = tuple(int(c2[i:i + 2], 16) for i in (0, 2, 4))
        img = ImageOps.colorize(Image.linear_gradient('L').resize((S, S)), a, b)
        d = ImageDraw.Draw(img)
        rnd = random.Random(int(rk))
        for _ in range(3):
            r = rnd.randint(60, 200)
            x, y = rnd.randint(0, S), rnd.randint(0, S)
            d.ellipse([x - r, y - r, x + r, y + r], outline=(255, 255, 255), width=rnd.choice([3, 6, 10]))
        if FONT:
            f = ImageFont.truetype(FONT, 40)
            d.text((28, S - 70), it['title'][:22].upper(), font=f, fill=(255, 255, 255))
    elif it.get('type') == 'playlist' and '/composite/' in thumb:
        members = it['_items'][:4]
        for i, m in enumerate(members):
            tile = Image.open(io.BytesIO(cover_png(m['parentThumb'], 256))).resize((S // 2, S // 2))
            img.paste(tile, ((i % 2) * S // 2, (i // 2) * S // 2))
    else:
        rnd = random.Random(int(rk) if rk.isdigit() else 1)
        hue = rnd.random()
        import colorsys
        base = tuple(int(c * 255) for c in colorsys.hls_to_rgb(hue, 0.35, 0.45))
        light = tuple(int(c * 255) for c in colorsys.hls_to_rgb(hue, 0.6, 0.5))
        img = Image.new('RGB', (S, S), base)
        d = ImageDraw.Draw(img)
        d.ellipse([140, 90, 372, 322], fill=light)
        d.ellipse([60, 300, 452, 700], fill=light)
        if FONT and it.get('title'):
            f = ImageFont.truetype(FONT, 120)
            d.text((S / 2, 210), it['title'][0], font=f, fill=base, anchor='mm')
    img = img.resize((size, size), Image.LANCZOS)
    out = io.BytesIO()
    img.save(out, 'PNG')
    image_cache[ck] = out.getvalue()
    return image_cache[ck]


audio_cache = {}


def tone_wav(rk):
    if rk in audio_cache:
        return audio_cache[rk]
    rate = 22050
    n = rate * TRACK_SECONDS
    rnd = random.Random(int(rk))
    notes = [220 * 2 ** (rnd.choice([0, 3, 5, 7, 10, 12]) / 12) for _ in range(8)]
    frames = bytearray()
    seg = n // len(notes)
    quiet_from = int(n * SILENT_END_AT) if silent_end(rk) else n
    quiet_to = int(n * SILENT_START_TO) if silent_start(rk) else 0
    for i in range(n):
        f = notes[min(i // seg, len(notes) - 1)]
        env = max(0, min(1, (i - quiet_to) / 2000, (min(n, quiet_from) - i) / 2000))
        v = 0.25 * env * math.sin(2 * math.pi * f * i / rate)
        frames += struct.pack('<h', int(v * 32767))
    header = b'RIFF' + struct.pack('<I', 36 + len(frames)) + b'WAVEfmt ' + struct.pack('<IHHIIHH', 16, 1, 1, rate, rate * 2, 2, 16) + \
        b'data' + struct.pack('<I', len(frames))
    audio_cache[rk] = header + bytes(frames)
    return audio_cache[rk]


# ---------------------------------------------------------------- notifications

MOCK = {'ws': True, 'sse': 'on', 'ping': 10.0, 'open': False, 'delay': 0}
LIBRARY_STATE = {'contentChangedAt': NOW, 'refreshing': False}
listeners = []  # {'kind': 'ws'|'sse', 'send': callable}
listeners_lock = threading.Lock()


def ws_frame(payload, opcode=1):
    n = len(payload)
    head = bytes([0x80 | opcode])
    if n < 126:
        head += bytes([n])
    elif n < 65536:
        head += bytes([126]) + struct.pack('!H', n)
    else:
        head += bytes([127]) + struct.pack('!Q', n)
    return head + payload


def broadcast(ntype, key, entries):
    """Send one notification to every listener. WebSocket clients get the
    NotificationContainer wrapper; event stream clients get one event per entry."""
    container = json.dumps({'NotificationContainer': {'type': ntype, 'size': len(entries), key: entries}})
    with listeners_lock:
        current = list(listeners)
    for l in current:
        try:
            if l['kind'] == 'ws':
                l['send'](container)
            else:
                for e in entries:
                    l['send'](ntype, json.dumps({key: e}))
        except Exception:
            with listeners_lock:
                if l in listeners:
                    listeners.remove(l)


def timeline(item_id, typ, state, section=SECTION):
    broadcast('timeline', 'TimelineEntry', [{
        'identifier': 'com.plexapp.plugins.library', 'sectionID': section, 'itemID': int(item_id),
        'type': typ, 'title': items.get(str(item_id), {}).get('title', ''), 'state': state, 'updatedAt': int(time.time()),
    }])


def activity(event, title):
    broadcast('activity', 'ActivityNotification', [{
        'event': event, 'uuid': 'mock-scan',
        'Activity': {'uuid': 'mock-scan', 'type': 'library.update.section', 'cancellable': False, 'userID': 1,
                     'title': title, 'subtitle': '', 'progress': 0 if event == 'started' else 100,
                     'Context': {'librarySectionID': SECTION}},
    }])


def add_album(title):
    """Add an album to the library the way a scan would, with notifications."""
    artist = artists[0]
    k = key()
    year = 2025
    al = dict(albums[0], ratingKey=k, key=f'/library/metadata/{k}/children', title=title, titleSort=title.lower(),
              thumb=f'/library/metadata/{k}/thumb/1', year=year, originallyAvailableAt=f'{year}-01-01',
              addedAt=int(time.time()), viewCount=0, lastViewedAt=None, leafCount=4, _palette=('402060', 'e0a0ff'))
    al.pop('lastViewedAt')
    items[k] = al
    albums.append(al)
    LIBRARY_STATE['refreshing'] = True
    activity('started', 'Scanning Music [Hi-Res]')
    timeline(k, 9, 0)
    for i in range(4):
        tk = key()
        t = dict(tracks[0], ratingKey=tk, key=f'/library/metadata/{tk}', title=f'{title} Part {i + 1}', index=i + 1,
                 parentIndex=1, parentRatingKey=k, parentTitle=title, parentThumb=al['thumb'], parentYear=year,
                 addedAt=al['addedAt'], viewCount=0)
        t.pop('lastViewedAt', None)
        t['Media'] = [{'audioCodec': 'flac', 'container': 'flac', 'bitrate': 1411, 'Part': [
            {'key': f'/library/parts/{tk}/0/file.flac', 'duration': TRACK_SECONDS * 1000, 'container': 'flac'}]}]
        items[tk] = t
        tracks.append(t)
        timeline(tk, 10, 0)
    timeline(k, 9, 5)
    LIBRARY_STATE['contentChangedAt'] = int(time.time())
    LIBRARY_STATE['refreshing'] = False
    activity('ended', 'Scanning Music [Hi-Res]')
    return al


# ---------------------------------------------------------------- plex.tv

ACCOUNTS = {
    't': {'id': 1001, 'uuid': 'a1001', 'username': 'dan', 'title': 'Dan', 'friendlyName': 'Dan', 'email': 'dan@example.com'},
    't2': {'id': 1002, 'uuid': 'a1002', 'username': 'sam', 'title': 'Sam', 'friendlyName': 'Sam', 'email': 'sam@example.com'},
    't3': {'id': 1003, 'uuid': 'a1003', 'username': 'alex', 'title': 'Alex', 'friendlyName': 'Alex', 'email': 'alex@example.com'},
}
# Tokens this server accepts: its owner's and a friend's it's shared with.
SERVER_TOKENS = {'t': 'owned', 't2': 'shared'}
FRIENDS = {'t': ['t2', 't3'], 't2': ['t', 't3'], 't3': ['t']}


# Temporary tokens the server handed out (/security/token), and whose.
TRANSIENT = {}


def pms_token_ok(token):
    if MOCK['open']:
        return bool(token) and token != 'bad'
    return token in SERVER_TOKENS or token in TRANSIENT


def role(token):
    return SERVER_TOKENS.get(token) or SERVER_TOKENS.get(TRANSIENT.get(token, ''))


def is_admin(token):
    # A server open to this network treats every request as its owner's.
    return MOCK['open'] or role(token) == 'owned'


# ---------------------------------------------------------------- play queues and a player

PLAY_QUEUES = {}  # id -> {'id', 'items': [(item, pqid)], 'selected': pqid, 'version'}
next_pq = [700]


def pq_add(pq, new, after=None):
    """Insert items after the entry `after` (a pqid), or at the end."""
    entries = [(it, entry_id()) for it in new]
    at = len(pq['items']) if after is None else next((i + 1 for i, (_, e) in enumerate(pq['items']) if e == after), len(pq['items']))
    pq['items'][at:at] = entries
    pq['version'] += 1
    return entries


def pq_json(pq):
    rows = [dict(public(t), playQueueItemID=e) for t, e in pq['items']]
    return {'playQueueID': pq['id'], 'playQueueSelectedItemID': pq['selected'], 'playQueueSelectedItemOffset': 0,
            'playQueueVersion': pq['version'], 'playQueueTotalCount': len(rows), 'size': len(rows), 'Metadata': rows}


def private_ip():
    """This machine's address on its network, for the player's plex.tv
    entry (falls back to 127.0.0.1 when it isn't a home-network address)."""
    import socket
    try:
        sk = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sk.connect(('10.255.255.255', 1))
        ip = sk.getsockname()[0]
        sk.close()
    except OSError:
        return '127.0.0.1'
    a, b = (int(x) for x in ip.split('.')[:2])
    home = a == 10 or (a == 172 and 16 <= b <= 31) or (a == 192 and b == 168)
    return ip if home else '127.0.0.1'


PLAYER_PORT = PORT + 100
PLAYER = {'id': 'mock-player-1', 'name': 'Living Room', 'pq': None, 'entry': None, 'state': 'stopped', 'offset': 0,
          'since': 0.0, 'volume': 100, 'shuffle': 0, 'repeat': 0, 'log': [], 'lock': threading.Lock()}


def player_index():
    pq = PLAYER['pq']
    if not pq:
        return -1
    return next((i for i, (_, e) in enumerate(pq['items']) if e == PLAYER['entry']), -1)


def player_track():
    """The entry playing: (track, pqid), or (None, None). The player follows
    its entry when the queue changes around it."""
    i = player_index()
    return PLAYER['pq']['items'][i] if i >= 0 else (None, None)


def player_position():
    """Where the player is (ms), moving on to the next track at the end of one."""
    t, _ = player_track()
    if not t:
        return 0
    pos = PLAYER['offset'] + ((time.monotonic() - PLAYER['since']) * 1000 if PLAYER['state'] == 'playing' else 0)
    while t and pos >= t['duration']:
        pos -= t['duration']
        i = player_index()
        if i + 1 < len(PLAYER['pq']['items']):
            PLAYER['entry'] = PLAYER['pq']['items'][i + 1][1]
        else:
            PLAYER['state'], pos = 'stopped', 0
            break
        t, _ = player_track()
    if PLAYER['state'] == 'playing':
        PLAYER['offset'], PLAYER['since'] = pos, time.monotonic()
    if PLAYER['entry'] is not None and PLAYER['pq']:
        PLAYER['pq']['selected'] = PLAYER['entry']
    return int(pos)


def player_go(entry=None, offset=0, state='playing'):
    if entry is not None:
        PLAYER['entry'] = entry
    PLAYER['offset'], PLAYER['since'], PLAYER['state'] = int(offset), time.monotonic(), state


def player_timeline():
    pos = player_position()
    t, e = player_track()
    music = {'type': 'music', 'state': PLAYER['state'] if t else 'stopped', 'controllable': 'playPause,stop,volume,shuffle,repeat,seekTo,skipPrevious,skipNext'}
    if t:
        music.update({'time': pos, 'duration': t['duration'], 'ratingKey': t['ratingKey'], 'key': f'/library/metadata/{t["ratingKey"]}',
                      'playQueueID': PLAYER['pq']['id'], 'playQueueItemID': e, 'playQueueVersion': PLAYER['pq']['version'],
                      'volume': PLAYER['volume'], 'shuffle': PLAYER['shuffle'], 'repeat': PLAYER['repeat'],
                      'machineIdentifier': 'mock-server-1'})
    attr = lambda d: ' '.join(f'{k}="{v}"' for k, v in d.items())
    return (f'<?xml version="1.0" encoding="UTF-8"?>\n<MediaContainer commandID="{PLAYER.get("commandID", 0)}" location="fullScreenMusic">'
            f'<Timeline type="video" state="stopped"/><Timeline type="photo" state="stopped"/><Timeline {attr(music)}/></MediaContainer>')


class PlayerHandler(BaseHTTPRequestHandler):
    """Plex's remote-control protocol, as Plexamp on a Raspberry Pi speaks it."""
    server_version = 'MockPlexamp/0.1'

    def log_message(self, fmt, *args):
        pass

    def reply(self, status, body, ctype='text/xml'):
        data = body.encode()
        self.send_response(status)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):  # noqa: C901 - one command per branch
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        if self.headers.get('X-Plex-Target-Client-Identifier', PLAYER['id']) != PLAYER['id']:
            return self.reply(404, '<Response code="404" status="Not this player"/>')
        cmd = u.path.removeprefix('/player/')
        with PLAYER['lock']:
            if not cmd.startswith('timeline/'):
                PLAYER['log'].append({'command': cmd, 'params': dict(q),
                                      'client': self.headers.get('X-Plex-Client-Identifier', ''), 'hasToken': bool(self.headers.get('X-Plex-Token'))})
                del PLAYER['log'][:-50]
            PLAYER['commandID'] = int(q.get('commandID', '0') or 0)
            player_position()
            pq = PLAYER['pq']
            by_key = lambda items, key: next((e for t, e in items if f'/library/metadata/{t["ratingKey"]}' == key), None)
            if cmd == 'timeline/poll':
                return self.reply(200, player_timeline())
            if cmd == 'playback/playMedia':
                # A real player fetches the queue from the server with this token.
                if q.get('token') not in TRANSIENT:
                    return self.reply(401, '<Response code="401" status="The server refused the token"/>')
                m = re.fullmatch(r'/playQueues/(\d+)(\?.*)?', q.get('containerKey', ''))
                new = PLAY_QUEUES.get(int(m.group(1))) if m else None
                if not new:
                    return self.reply(500, '<Response code="500" status="No such play queue"/>')
                PLAYER['pq'] = new
                sel = new['selected'] if by_key([(t, e) for t, e in new['items'] if e == new['selected']], q.get('key')) else by_key(new['items'], q.get('key'))
                player_go(sel or new['items'][0][1], int(q.get('offset', '0') or 0))
            elif cmd == 'playback/setParameters':
                for k in ('volume', 'shuffle', 'repeat'):
                    if k in q:
                        PLAYER[k] = int(q[k])
            elif not pq:
                return self.reply(500, '<Response code="500" status="Nothing to play"/>')
            elif cmd == 'playback/play':
                player_go(offset=player_position())
            elif cmd == 'playback/pause':
                player_go(offset=player_position(), state='paused')
            elif cmd == 'playback/stop':
                player_go(offset=0, state='stopped')
            elif cmd in ('playback/skipNext', 'playback/skipPrevious'):
                i = player_index()
                if cmd.endswith('Next'):
                    j = i + 1 if i + 1 < len(pq['items']) else None
                else:
                    j = i - 1 if player_position() < 3000 and i > 0 else i
                if j is not None:
                    player_go(pq['items'][j][1], 0, 'playing')
            elif cmd == 'playback/seekTo':
                player_go(offset=int(q.get('offset', '0') or 0), state=PLAYER['state'])
            elif cmd == 'playback/skipTo':
                e = next((e for _, e in pq['items'] if str(e) == q.get('playQueueItemID')), None) or by_key(pq['items'], q.get('key'))
                if e:
                    player_go(e, 0, 'playing')
            elif cmd == 'playback/refreshPlayQueue':
                pass  # the player follows its entry, wherever it is in the queue now
            else:
                return self.reply(404, '<Response code="404" status="Unknown command"/>')
            return self.reply(200, '<Response code="200" status="OK"/>')


def server_resource(token, base):
    return {
        'name': "Dan's Test Server", 'product': 'Plex Media Server', 'provides': 'server',
        'clientIdentifier': 'mock-server-1', 'owned': SERVER_TOKENS[token] == 'owned', 'accessToken': token,
        'sourceTitle': None if SERVER_TOKENS[token] == 'owned' else 'Dan',
        'connections': [{'protocol': 'http', 'address': '127.0.0.1', 'port': PORT, 'uri': base, 'local': True, 'relay': False}],
    }


def friends_xml(token):
    from xml.sax.saxutils import quoteattr
    rows = []
    for ft in FRIENDS.get(token, []):
        a = ACCOUNTS[ft]
        # <Server> lists the requester's own servers shared with this friend.
        shared = SERVER_TOKENS.get(token) == 'owned' and ft in SERVER_TOKENS
        server = '<Server id="1" machineIdentifier="mock-server-1" name="Dan&apos;s Test Server" owned="1"/>' if shared else ''
        rows.append(f'<User id="{a["id"]}" title={quoteattr(a["title"])} username={quoteattr(a["username"])} '
                    f'thumb="https://plex.tv/users/{a["uuid"]}/avatar?c=1" home="0" restricted="0">{server}</User>')
    return f'<?xml version="1.0" encoding="UTF-8"?>\n<MediaContainer friendlyName="myPlex" size="{len(rows)}">{"".join(rows)}</MediaContainer>'


# ---------------------------------------------------------------- HTTP

class Handler(BaseHTTPRequestHandler):
    server_version = 'MockPlex/0.1'

    def log_message(self, fmt, *args):
        if '--quiet' not in sys.argv:
            sys.stderr.write('%s %s\n' % (self.command, self.path.split('?')[0]))

    def cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
        self.send_header('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length')

    def do_OPTIONS(self):
        self.send_response(204)
        self.cors()
        self.end_headers()

    def send_json(self, mc, status=200):
        body = json.dumps({'MediaContainer': mc}).encode()
        self.send_response(status)
        self.cors()
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_bytes(self, data, ctype):
        rng = self.headers.get('Range')
        start, end = 0, len(data) - 1
        status = 200
        if rng and rng.startswith('bytes='):
            a, _, b = rng[6:].partition('-')
            start = int(a) if a else 0
            end = int(b) if b else len(data) - 1
            status = 206
        chunk = data[start:end + 1]
        self.send_response(status)
        self.cors()
        self.send_header('Content-Type', ctype)
        self.send_header('Accept-Ranges', 'bytes')
        self.send_header('Content-Length', str(len(chunk)))
        if status == 206:
            self.send_header('Content-Range', f'bytes {start}-{end}/{len(data)}')
        self.send_header('Cache-Control', 'max-age=3600')
        self.end_headers()
        self.wfile.write(chunk)

    def not_found(self):
        self.send_json({'size': 0}, 404)

    def page(self, lst, q, extra=None):
        start = int(q.get('X-Plex-Container-Start', ['0'])[0])
        size = int(q.get('X-Plex-Container-Size', ['50'])[0])
        chunk = lst[start:start + size] if size else []
        mc = {'size': len(chunk), 'totalSize': len(lst), 'offset': start, 'Metadata': [public(x) for x in chunk]}
        if extra:
            mc.update(extra)
        self.send_json(mc)

    def do_POST(self):
        self.do_GET()

    def do_PUT(self):
        self.do_GET()

    def do_DELETE(self):
        self.do_GET()

    def playlist_page(self, pl, q):
        follow_rule(pl)
        start = int(q.get('X-Plex-Container-Start', ['0'])[0])
        size = int(q.get('X-Plex-Container-Size', ['50'])[0])
        rows = [dict(public(t), playlistItemID=pid) for t, pid in zip(pl['_items'], pl['_pids'])]
        chunk = rows[start:start + size] if size else []
        self.send_json({'size': len(chunk), 'totalSize': len(rows), 'offset': start, 'leafCount': pl['leafCount'],
                        'Metadata': chunk})

    def edit_playlist(self, pl, parts, q):
        """PUT/DELETE on /playlists/{id}[/items[/{entry}[/move]]]."""
        if self.command == 'DELETE' and len(parts) == 2:
            playlists.remove(pl)
            items.pop(pl['ratingKey'], None)
            timeline(pl['ratingKey'], 15, 9, section='-1')
            return self.send_json({})
        if len(parts) == 2:  # PUT: rename
            if 'title' in q:
                pl['title'] = q['title'][0][:200]
            pl['updatedAt'] = int(time.time())
            return self.send_json({'size': 1, 'Metadata': [public(pl)]})
        if pl['smart']:
            return self.send_json({'error': 'Smart playlists are edited by their rules'}, 400)
        if len(parts) == 3:  # PUT .../items?uri=: add to the end
            new = [items[i] for i in ids_from_uri(q.get('uri', [''])[0]) if items[i]['type'] == 'track']
            pl['_items'] += new
            pl['_pids'] += [entry_id() for _ in new]
            playlist_changed(pl)
            return self.send_json({'size': 1, 'Metadata': [public(pl)]})
        pid = int(parts[3]) if parts[3].isdigit() else -1
        if pid not in pl['_pids']:
            return self.not_found()
        at = pl['_pids'].index(pid)
        if self.command == 'DELETE':
            del pl['_items'][at], pl['_pids'][at]
        elif len(parts) == 5 and parts[4] == 'move':
            entry = (pl['_items'].pop(at), pl['_pids'].pop(at))
            after = int(q.get('after', ['0'])[0] or 0)
            to = pl['_pids'].index(after) + 1 if after in pl['_pids'] else 0
            pl['_items'].insert(to, entry[0])
            pl['_pids'].insert(to, entry[1])
        else:
            return self.not_found()
        playlist_changed(pl)
        return self.send_json({})

    def edit_collection(self, c, parts, q, token):
        """PUT/DELETE on /library/collections/{id}[/items[/{id}[/move]]|/prefs]: the server's admin only."""
        if not is_admin(token):
            return self.send_json({'error': 'Forbidden'}, 403)
        sub = parts[3] if len(parts) > 3 else ''
        if self.command == 'DELETE' and not sub:
            collections.remove(c)
            items.pop(c['ratingKey'], None)
            return self.send_json({})
        if sub == 'prefs':
            if 'collectionSort' in q:
                c['collectionSort'] = int(q['collectionSort'][0])
            return self.send_json({})
        if sub != 'items':
            return self.not_found()
        if len(parts) == 4:  # PUT: add
            want = c['subtype']
            new = [items[i] for i in ids_from_uri(q.get('uri', [''])[0]) if items[i]['type'] == want and items[i] not in c['_items']]
            c['_items'] += new
        else:
            it = items.get(parts[4])
            if it not in c['_items']:
                return self.not_found()
            if self.command == 'DELETE':
                c['_items'].remove(it)
            elif len(parts) == 6 and parts[5] == 'move':
                if c['collectionSort'] != 2:  # like Plex: custom order needs custom sorting
                    return self.send_json({'error': 'Sort this collection by custom order first'}, 400)
                c['_items'].remove(it)
                after = items.get(q.get('after', [''])[0])
                c['_items'].insert(c['_items'].index(after) + 1 if after in c['_items'] else 0, it)
            else:
                return self.not_found()
        c['childCount'] = len(c['_items'])
        c['updatedAt'] = int(time.time())
        if c['_items']:
            c['thumb'] = c['_items'][0].get('thumb') or c['_items'][0].get('parentThumb')
        return self.send_json({})

    def websocket(self):
        if not MOCK['ws']:
            return self.send_json({'error': 'WebSockets are blocked'}, 403)
        key_ = self.headers.get('Sec-WebSocket-Key', '')
        accept = base64.b64encode(hashlib.sha1((key_ + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest()).decode()
        self.protocol_version = 'HTTP/1.1'  # browsers expect an HTTP/1.1 status line here
        self.send_response(101, 'Switching Protocols')
        self.send_header('Upgrade', 'websocket')
        self.send_header('Connection', 'Upgrade')
        self.send_header('Sec-WebSocket-Accept', accept)
        self.end_headers()
        self.wfile.flush()
        lock = threading.Lock()

        def send(text):
            with lock:
                self.wfile.write(ws_frame(text.encode()))
                self.wfile.flush()

        me = {'kind': 'ws', 'send': send}
        with listeners_lock:
            listeners.append(me)
        try:
            while True:  # read client frames until it closes
                head = self.rfile.read(2)
                if len(head) < 2:
                    break
                opcode, n = head[0] & 0x0F, head[1] & 0x7F
                if n == 126:
                    n = struct.unpack('!H', self.rfile.read(2))[0]
                elif n == 127:
                    n = struct.unpack('!Q', self.rfile.read(8))[0]
                mask = self.rfile.read(4) if head[1] & 0x80 else b''
                data = bytearray(self.rfile.read(n))
                for i in range(len(data)):
                    data[i] ^= mask[i % 4]
                if opcode == 8:
                    with lock:
                        self.wfile.write(ws_frame(b'', 8))
                    break
                if opcode == 9:
                    with lock:
                        self.wfile.write(ws_frame(bytes(data), 10))
        except (OSError, ValueError):
            pass
        finally:
            with listeners_lock:
                if me in listeners:
                    listeners.remove(me)
        self.close_connection = True

    def eventsource(self):
        if MOCK['sse'] in ('off', '0'):
            return self.not_found()
        self.send_response(200)
        self.cors()
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Cache-Control', 'no-cache')
        self.end_headers()
        self.wfile.flush()
        if MOCK['sse'] == 'silent':  # a proxy that holds the stream back
            time.sleep(120)
            return
        events = queue.Queue()
        me = {'kind': 'sse', 'send': lambda name, data: events.put((name, data))}
        with listeners_lock:
            listeners.append(me)
        try:
            while True:
                try:
                    name, data = events.get(timeout=MOCK['ping'])
                except queue.Empty:
                    name, data = 'ping', '{}'
                self.wfile.write(f'event: {name}\ndata: {data}\n\n'.encode())
                self.wfile.flush()
        except OSError:
            pass
        finally:
            with listeners_lock:
                if me in listeners:
                    listeners.remove(me)
        self.close_connection = True

    def send_text(self, text, ctype, status=200):
        body = text.encode()
        self.send_response(status)
        self.cors()
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def plex_tv(self, p, token):
        account = ACCOUNTS.get(token)
        if p == '/api/v2/ping':
            return self.send_text('{"pong": true}', 'application/json')
        if not account:
            return self.send_text('{"errors": [{"code": 1001, "message": "User could not be authenticated"}]}', 'application/json', 401)
        if p == '/api/v2/user':
            return self.send_text(json.dumps(dict(account, thumb=f'https://plex.tv/users/{account["uuid"]}/avatar?c=1')), 'application/json')
        if p == '/api/v2/resources':
            base = f'http://{self.headers.get("Host") or f"127.0.0.1:{PORT}"}'
            res = [server_resource(token, base)] if token in SERVER_TOKENS else []
            if token == 't':
                res.append({'name': PLAYER['name'], 'product': 'Plexamp', 'platform': 'Linux', 'device': 'Raspberry Pi',
                            'provides': 'client,player,pubsub-player', 'clientIdentifier': PLAYER['id'], 'owned': True, 'presence': True,
                            'connections': [{'protocol': 'http', 'address': PLAYER_ADDRESS, 'port': PLAYER_PORT,
                                             'uri': f'http://{PLAYER_ADDRESS}:{PLAYER_PORT}', 'local': True, 'relay': False}]})
            return self.send_text(json.dumps(res), 'application/json')
        if p == '/api/users':
            return self.send_text(friends_xml(token), 'application/xml')
        return self.send_text('{}', 'application/json', 404)

    def do_GET(self):  # noqa: C901 - a router in one place is easier to read here
        u = urlparse(self.path)
        p = u.path.rstrip('/') or '/'
        q = parse_qs(u.query)
        parts = p.strip('/').split('/')

        if p == '/__mock/config':
            if 'ws' in q:
                MOCK['ws'] = q['ws'][0] not in ('0', 'off', 'false')
            if 'sse' in q:
                MOCK['sse'] = q['sse'][0]
            if 'ping' in q:
                MOCK['ping'] = float(q['ping'][0])
            if 'open' in q:
                MOCK['open'] = q['open'][0] in ('1', 'on', 'true')
            if 'delay' in q:
                MOCK['delay'] = max(0, int(q['delay'][0]))
            if 'loved' in q:
                set_loved(q['loved'][0])
            return self.send_json(dict(MOCK, listeners=len(listeners)))
        if p == '/__mock/add-album':
            al = add_album(q.get('title', ['Fresh Arrival'])[0])
            return self.send_json({'size': 1, 'Metadata': [public(al)]})
        if p == '/__mock/player':
            with PLAYER['lock']:
                if q.get('reset'):
                    PLAYER.update({'pq': None, 'entry': None, 'state': 'stopped', 'offset': 0, 'log': [], 'volume': 100})
                pos = player_position()
                t, e = player_track()
                return self.send_json({'state': PLAYER['state'] if t else 'stopped', 'time': pos, 'ratingKey': t and t['ratingKey'],
                                       'playQueueID': PLAYER['pq'] and PLAYER['pq']['id'], 'queue': [x['ratingKey'] for x, _ in (PLAYER['pq'] or {}).get('items', [])],
                                       'volume': PLAYER['volume'], 'log': PLAYER['log']})
        if p == '/__mock/tracks':
            return self.send_json({'size': len(tracks), 'Metadata': [
                {'ratingKey': t['ratingKey'], 'title': t['title'], 'album': t['parentRatingKey'], 'index': t['index'],
                 'silentEnd': silent_end(t['ratingKey']), 'silentStart': silent_start(t['ratingKey'])} for t in tracks]})
        if p == '/__mock/age':  # an album (and its tracks) last played this many days ago
            al = items.get(q.get('id', [''])[0])
            if not al or al['type'] != 'album':
                return self.not_found()
            when_ = int(time.time()) - int(q.get('days', ['200'])[0]) * 86400
            for it in [al] + [t for t in tracks if t['parentRatingKey'] == al['ratingKey']]:
                it['lastViewedAt'] = when_
                it['viewCount'] = max(1, it.get('viewCount', 0))
            return self.send_json({'size': 1, 'Metadata': [public(al)]})

        token = q.get('X-Plex-Token', [''])[0] or self.headers.get('X-Plex-Token', '')
        if p.startswith('/api/'):
            return self.plex_tv(p, token)
        if p == '/identity':  # answered without signing in, like a real server
            return self.send_json({'machineIdentifier': 'mock-server-1', 'version': '1.41.0', 'claimed': True})
        # A converted stream's playlists live inside its session and are
        # fetched without a token, as on a real server. (The segments here
        # aren't real audio; this is for testing the proxy.)
        if p.startswith('/audio/:/transcode/universal/session/'):
            if p.endswith('/index.m3u8'):
                return self.send_text('#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\n00000.ts\n#EXT-X-ENDLIST\n',
                                      'application/vnd.apple.mpegurl')
            return self.send_bytes(b'\x47' + b'\xff' * 187, 'video/mp2t')
        if p == '/audio/:/transcode/universal/start.m3u8' and pms_token_ok(token):
            sid = q.get('transcodeSessionId', ['mock'])[0].replace('/', '')
            return self.send_text(f'#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=320000,CODECS="mp4a.40.2"\nsession/{sid}/base/index.m3u8\n',
                                  'application/vnd.apple.mpegurl')
        if not pms_token_ok(token) and not p.startswith('/library/parts'):
            return self.send_json({'error': 'Unauthorized'}, 401)
        if p == '/:/websockets/notifications' and self.headers.get('Upgrade', '').lower() == 'websocket':
            return self.websocket()
        if p == '/:/eventsource/notifications':
            return self.eventsource()

        if p == '/':
            return self.send_json({'friendlyName': "Dan's Test Server", 'machineIdentifier': 'mock-server-1', 'version': '1.41.0'})
        if p == '/:/prefs':  # server settings: the admin only
            return self.send_json({'size': 0, 'Setting': []}) if is_admin(token) else self.send_json({'error': 'Unauthorized'}, 401)
        if p == '/security/token':
            t = 'transient-' + hashlib.sha1(f'{token}{time.time()}{random.random()}'.encode()).hexdigest()[:24]
            TRANSIENT[t] = token
            return self.send_json({'token': t})
        if p == '/identity':
            return self.send_json({'machineIdentifier': 'mock-server-1', 'version': '1.41.0', 'claimed': True})
        if p == '/library/sections':
            return self.send_json({'size': 3, 'Directory': [
                {'key': SECTION, 'type': 'artist', 'title': 'Music [Hi-Res]', 'uuid': 'mock-music',
                 'contentChangedAt': LIBRARY_STATE['contentChangedAt'], 'updatedAt': NOW, 'scannedAt': NOW,
                 'refreshing': LIBRARY_STATE['refreshing']},
                {'key': '2', 'type': 'movie', 'title': 'Movies'},
                {'key': '3', 'type': 'artist', 'title': 'Audiobooks'},
            ]})
        if p.startswith('/library/sections/'):
            sec = parts[2]
            sub = parts[3] if len(parts) > 3 else ''
            if sec != SECTION:
                return self.send_json({'size': 0, 'totalSize': 0, 'Metadata': []})
            typ = int(q.get('type', ['9'])[0])
            if sub == 'all' and self.command == 'PUT' and typ == 18:  # rename a collection
                c = items.get(q.get('id', [''])[0])
                if not c or c.get('type') != 'collection':
                    return self.not_found()
                if not is_admin(token):
                    return self.send_json({'error': 'Forbidden'}, 403)
                if 'title.value' in q:
                    c['title'] = q['title.value'][0][:200]
                return self.send_json({})
            if sub == 'all':
                if MOCK['delay']:
                    time.sleep(MOCK['delay'] / 1000)
                pool = {8: artists, 9: albums, 10: tracks}.get(typ, albums)
                res = pool
                for f, vals in q.items():
                    if f in ('type', 'sort', 'group') or f.startswith('X-Plex'):
                        continue
                    if f.endswith('>>') or f.endswith('<<'):
                        fld, limit = f[:-2], when(vals[0])
                        if f.endswith('>>'):
                            res = [x for x in res if (x.get(fld) or 0) > limit]
                        else:  # before: items never played don't match
                            res = [x for x in res if x.get(fld) and x[fld] < limit]
                        continue
                    res = [x for x in res if matches(x, f, vals[0])]
                return self.page(sort_items(res, q.get('sort', [None])[0]), q)
            if sub in ('genre', 'style', 'mood', 'decade'):
                return self.send_json({'size': 0, 'Directory': tag_dir(sub, typ)})
            if sub == 'collections':
                return self.page(sort_items(collections, q.get('sort', [None])[0]), q)
            if sub == 'computePath':
                a, b = q.get('startID', [''])[0], q.get('endID', [''])[0]
                path = [items[a]] + random.sample(tracks, 8) + [items[b]]
                return self.page(path, {'X-Plex-Container-Size': ['100']})
        if p == '/library/collections' and self.command == 'POST':
            if not is_admin(token):
                return self.send_json({'error': 'Forbidden'}, 403)
            subtype = COLLECTION_TYPES.get(int(q.get('type', ['0'])[0] or 0))
            if not subtype:
                return self.send_json({'error': 'Bad type'}, 400)
            members = [items[i] for i in ids_from_uri(q.get('uri', [''])[0]) if items[i]['type'] == subtype]
            k = key()
            c = {'ratingKey': k, 'type': 'collection', 'subtype': subtype, 'title': q.get('title', ['Untitled'])[0][:200],
                 'childCount': len(members), 'thumb': (members[0].get('thumb') or members[0].get('parentThumb')) if members else None,
                 '_items': members, 'addedAt': int(time.time()), 'updatedAt': int(time.time()), 'collectionSort': 0}
            items[k] = c
            collections.append(c)
            return self.send_json({'size': 1, 'Metadata': [public(c)]})
        if p.startswith('/library/collections/'):
            c = items.get(parts[2])
            if not c or c.get('type') != 'collection':
                return self.not_found()
            if self.command in ('PUT', 'DELETE', 'POST'):
                return self.edit_collection(c, parts, q, token)
            if len(parts) > 3 and parts[3] == 'children':
                return self.page(c['_items'], {'X-Plex-Container-Size': ['500']})
            return self.send_json({'size': 1, 'Metadata': [public(c)]})
        if p.startswith('/library/metadata/'):
            it = items.get(parts[2])
            if not it:
                return self.not_found()
            sub = parts[3] if len(parts) > 3 else ''
            if sub == 'children':
                kids = [a for a in albums if a['parentRatingKey'] == it['ratingKey']] if it['type'] == 'artist' else \
                    [t for t in tracks if t['parentRatingKey'] == it['ratingKey']]
                return self.page(kids, {'X-Plex-Container-Size': ['500']})
            if sub == 'allLeaves':
                return self.page([t for t in tracks if t['grandparentRatingKey'] == it['ratingKey']], {'X-Plex-Container-Size': ['500']})
            if sub == 'nearest':
                pool = [a for a in artists if a is not it and a['title'] != 'Various Artists'] if it['type'] == 'artist' else \
                    [t for t in tracks if t is not it]
                n = int(q.get('limit', ['20'])[0])
                return self.page(random.Random(it['ratingKey']).sample(pool, min(n, len(pool))), {'X-Plex-Container-Size': ['500']})
            if sub in ('thumb', 'art'):
                return self.send_bytes(cover_png(p, 600), 'image/png')
            return self.send_json({'size': 1, 'Metadata': [track_detail(it) if it['type'] == 'track' else public(it)]})
        if p == '/hubs/search':
            needle = q.get('query', [''])[0].lower()
            lim = int(q.get('limit', ['10'])[0])
            hubs = []
            for typ, pool in (('artist', artists), ('album', albums), ('track', tracks), ('playlist', playlists)):
                found = [public(x) for x in pool if needle in x['title'].lower()][:lim]
                hubs.append({'type': typ, 'hubIdentifier': typ, 'size': len(found), 'Metadata': found})
            return self.send_json({'size': len(hubs), 'Hub': hubs})
        if p == '/playQueues' and self.command == 'POST':
            new = [items[i] for i in ids_from_uri(q.get('uri', [''])[0]) if items[i]['type'] == 'track']
            if not new:
                return self.send_json({'error': 'Nothing to play'}, 400)
            next_pq[0] += 1
            pq = {'id': next_pq[0], 'items': [], 'selected': None, 'version': 1}
            pq_add(pq, new)
            want = q.get('key', [''])[0]
            pq['selected'] = next((e for t, e in pq['items'] if f'/library/metadata/{t["ratingKey"]}' == want), pq['items'][0][1])
            PLAY_QUEUES[pq['id']] = pq
            return self.send_json(pq_json(pq))
        if p.startswith('/playQueues/'):
            pq = PLAY_QUEUES.get(int(parts[1])) if parts[1].isdigit() else None
            if not pq:
                return self.not_found()
            with PLAYER['lock']:
                if PLAYER['pq'] is pq:
                    player_position()  # the selected entry is the one playing
                if self.command == 'PUT' and len(parts) == 2:  # add: after the selected entry (next=1) or at the end
                    new = [items[i] for i in ids_from_uri(q.get('uri', [''])[0]) if items[i]['type'] == 'track']
                    pq_add(pq, new, after=pq['selected'] if q.get('next', ['0'])[0] == '1' else None)
                elif self.command == 'DELETE' and len(parts) == 4 and parts[2] == 'items':
                    pq['items'] = [(t, e) for t, e in pq['items'] if str(e) != parts[3]]
                    pq['version'] += 1
                elif self.command == 'PUT' and len(parts) == 5 and parts[4] == 'move':
                    entry = next(((t, e) for t, e in pq['items'] if str(e) == parts[3]), None)
                    if not entry:
                        return self.not_found()
                    pq['items'].remove(entry)
                    after = q.get('after', [''])[0]
                    at = next((i + 1 for i, (_, e) in enumerate(pq['items']) if str(e) == after), 0)
                    pq['items'].insert(at, entry)
                    pq['version'] += 1
                elif self.command != 'GET':
                    return self.not_found()
            return self.send_json(pq_json(pq))
        if p == '/playlists' and self.command == 'POST':
            uri = q.get('uri', [''])[0]
            ids = uri.rsplit('/', 1)[-1].split(',') if '/library/metadata/' in uri else []
            members = [items[i] for i in ids if i in items and items[i]['type'] == 'track']
            pl = make_playlist(q.get('title', ['Untitled'])[0], members)
            pl['addedAt'] = pl['updatedAt'] = int(time.time())
            playlists.append(pl)
            timeline(pl['ratingKey'], 15, 5, section='-1')
            return self.send_json({'size': 1, 'Metadata': [public(pl)]})
        if p == '/playlists':
            sec = q.get('sectionID', [None])[0]
            return self.page([follow_rule(pl) for pl in playlists if not sec or pl['_section'] == sec], {'X-Plex-Container-Size': ['500']})
        if p == '/activities':
            return self.send_json({'size': 0})
        if p.startswith('/playlists/'):
            pl = items.get(parts[1])
            if not pl or pl.get('type') != 'playlist':
                return self.not_found()
            if self.command in ('PUT', 'DELETE'):
                return self.edit_playlist(pl, parts, q)
            if len(parts) > 2 and parts[2] == 'items':
                return self.playlist_page(pl, q)
            if len(parts) > 2 and parts[2] == 'composite':
                return self.send_bytes(cover_png(p, 600), 'image/png')
            return self.send_json({'size': 1, 'Metadata': [public(pl)]})
        if p == '/photo/:/transcode':
            return self.send_bytes(cover_png(q.get('url', ['/x/x/0'])[0].split('?')[0], q.get('width', ['300'])[0]), 'image/png')
        if p == '/services/ultrablur/colors':
            return self.send_json({'size': 1, 'UltraBlurColors': [{'topLeft': '2a2440', 'topRight': '5b4a8a', 'bottomRight': '332a52', 'bottomLeft': '15121f'}]})
        if p.startswith('/library/streams/') and p.endswith('/levels'):
            n = max(8, min(1000, int(q.get('subsample', ['128'])[0])))
            sid = int(parts[2])
            if (sid // 10) % 3 == 0:  # some tracks "not analysed" to exercise the plain bar
                return self.send_json({'size': 0})
            return self.send_json({'size': n, 'Level': loudness_levels(sid, n)})
        if p == '/:/rate':
            t = items.get(q.get('key', [''])[0])
            rating = float(q.get('rating', ['-1'])[0])
            if t is not None:
                if rating < 0:
                    t.pop('userRating', None)
                else:
                    t['userRating'] = rating
            sys.stderr.write(f'  rate {q.get("key", [""])[0]} -> {rating}\n')
            if t is not None:
                timeline(t['ratingKey'], 10, 5)
            return self.send_json({})
        if p.startswith('/library/parts/'):
            return self.send_bytes(tone_wav(parts[2]), 'audio/wav')
        if p == '/:/timeline':
            t = items.get(q.get('ratingKey', [''])[0])
            state = q.get('state', [''])[0]
            if t and state == 'stopped' and int(q.get('time', ['0'])[0]) >= t['duration'] * 0.9:
                t['viewCount'] = t.get('viewCount', 0) + 1
                t['lastViewedAt'] = int(time.time())
                alb = items[t['parentRatingKey']]
                alb['lastViewedAt'] = t['lastViewedAt']
                timeline(t['ratingKey'], 10, 5)
            sys.stderr.write(f'  timeline {state} {q.get("ratingKey", [""])[0]} t={q.get("time", [""])[0]}\n')
            return self.send_json({})
        return self.not_found()


class Server(ThreadingHTTPServer):
    daemon_threads = True  # long-lived WebSocket and event stream threads don't block exit


PLAYER_ADDRESS = private_ip()

if __name__ == '__main__':
    print(f'Mock Plex server on http://127.0.0.1:{PORT} '
          f'({len(artists)} artists, {len(albums)} albums, {len(tracks)} tracks, {len(playlists)} playlists); '
          f'player "{PLAYER["name"]}" on http://{PLAYER_ADDRESS}:{PLAYER_PORT}', flush=True)
    threading.Thread(target=Server(('0.0.0.0', PLAYER_PORT), PlayerHandler).serve_forever, daemon=True).start()
    if TLS:
        import ssl
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(TLS[1], TLS[2])
        secure = Server(('0.0.0.0', TLS[0]), Handler)
        secure.socket = context.wrap_socket(secure.socket, server_side=True)
        print(f'  and https on port {TLS[0]}', flush=True)
        threading.Thread(target=secure.serve_forever, daemon=True).start()
    Server(('0.0.0.0', PORT), Handler).serve_forever()
