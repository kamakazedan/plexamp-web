#!/usr/bin/env python3
"""A fake Plex Media Server for working on the UI without a real library.

Serves an invented music library (made-up artists, generated cover art and
short test tones) on the endpoints plexamp-web uses, with CORS enabled.

    python3 dev/mock-plex.py            # listens on http://127.0.0.1:32400
    python3 -m http.server 8080 -d web  # serves the app

Then open http://127.0.0.1:8080, choose "Use a server address and token
instead", and connect to http://127.0.0.1:32400 with any token.

Needs Pillow for artwork (pip install pillow).
"""

import io
import json
import math
import random
import struct
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:  # pragma: no cover
    sys.exit('Pillow is required: pip install pillow')

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 32400
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

items = {}  # ratingKey -> metadata dict
artists, albums, tracks = [], [], []
next_key = [100]


def key():
    next_key[0] += 1
    return str(next_key[0])


def lighten(hexc, f):
    r, g, b = (int(hexc[i:i + 2], 16) for i in (0, 2, 4))
    return '%02x%02x%02x' % tuple(min(255, int(c + (255 - c) * f)) if f > 0 else int(c * (1 + f)) for c in (r, g, b))


for idx, (name, genres, bio) in enumerate(ARTISTS):
    k = key()
    a = {
        'ratingKey': k, 'key': f'/library/metadata/{k}/children', 'type': 'artist', 'title': name,
        'titleSort': name.lower().replace('the ', ''), 'thumb': f'/library/metadata/{k}/thumb/1',
        'art': f'/library/metadata/{k}/art/1', 'summary': bio, 'Genre': [{'tag': g} for g in genres],
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
        'originallyAvailableAt': f'{year}-05-01', 'Genre': artist['Genre'][:1], 'studio': 'Harbour Records',
        'addedAt': NOW - 86400 * (len(ALBUMS) - ai) * 9, 'viewCount': 0, 'leafCount': 0,
        'summary': f'{title} is the {year} release from {artist["title"]}. Recorded over a long winter, it is '
                   'patient, detailed and best heard start to finish. ' * 2,
        'Format': [{'tag': fmt}], 'Subformat': [{'tag': sub}] if sub else [],
        'Style': [{'tag': ['Ambient', 'Lo-fi', 'Downtempo', 'Post-rock', 'Bossa nova'][ai % 5]}],
        'Mood': [{'tag': ['Calm', 'Warm', 'Restless', 'Bright'][ai % 4]}],
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


def make_playlist(title, members, smart=False, viewed=None):
    k = key()
    p = {
        'ratingKey': k, 'key': f'/playlists/{k}/items', 'type': 'playlist', 'playlistType': 'audio',
        'title': title, 'smart': smart, 'composite': f'/playlists/{k}/composite/1',
        'leafCount': len(members), 'duration': sum(m['duration'] for m in members),
        'addedAt': NOW - 86400 * 40, 'updatedAt': NOW - 86400 * 3, '_items': members,
    }
    if viewed:
        p['lastViewedAt'] = viewed
    items[k] = p
    return p


playlists = [
    make_playlist('Favourite tracks', random.sample(tracks, 18), viewed=NOW - 3600 * 20),
    make_playlist('Everything', tracks * 3, smart=True, viewed=NOW - 86400 * 2),
    make_playlist('Sunday morning', random.sample(tracks, 9)),
    make_playlist('Late night', random.sample(tracks, 14), viewed=NOW - 86400 * 9),
    make_playlist('Workout', random.sample(tracks, 11)),
]

collections = []
for title, subtype, members in [
    ('Harbour Records', 'album', [a for a in albums if a['studio']][:5]),
    ('Rainy day albums', 'album', albums[2:6]),
    ('Best of 2022', 'track', [t for t in tracks if items[t['parentRatingKey']]['year'] == 2022]),
]:
    k = key()
    c = {'ratingKey': k, 'type': 'collection', 'subtype': subtype, 'title': title, 'childCount': len(members),
         'thumb': members[0].get('thumb') or members[0].get('parentThumb'), '_items': members}
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


def matches(it, field, value):
    if field == 'artist.id':
        return it.get('grandparentRatingKey') == value or it.get('parentRatingKey') == value
    if field in ('subformat', 'album.subformat'):
        tags = [t['tag'] for t in it.get('Subformat', [])]
        return value in tags
    if field == 'decade':
        return bool(it.get('year')) and str(it['year'] // 10 * 10) == value
    if field in ('genre', 'style', 'mood'):
        return any(t['tag'].lower().replace(' ', '-') == value for t in it.get(field.capitalize(), []))
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
        {'streamType': 2, 'codec': 'flac', 'bitDepth': 24 if int(t['ratingKey']) % 2 else 16,
         'samplingRate': 96000 if int(t['ratingKey']) % 2 else 44100, 'channels': 2}])]
    return d


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


def cover_png(thumb, size):
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
        for y in range(S):
            f = y / S
            d.line([(0, y), (S, y)], fill=tuple(int(a[i] + (b[i] - a[i]) * f) for i in range(3)))
        rnd = random.Random(int(rk))
        for _ in range(3):
            r = rnd.randint(60, 200)
            x, y = rnd.randint(0, S), rnd.randint(0, S)
            d.ellipse([x - r, y - r, x + r, y + r], outline=(255, 255, 255), width=rnd.choice([3, 6, 10]))
        if FONT:
            f = ImageFont.truetype(FONT, 40)
            d.text((28, S - 70), it['title'][:22].upper(), font=f, fill=(255, 255, 255))
    elif it.get('type') == 'playlist':
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
    for i in range(n):
        f = notes[min(i // seg, len(notes) - 1)]
        env = min(1, i / 2000, (n - i) / 2000)
        v = 0.25 * env * math.sin(2 * math.pi * f * i / rate)
        frames += struct.pack('<h', int(v * 32767))
    header = b'RIFF' + struct.pack('<I', 36 + len(frames)) + b'WAVEfmt ' + struct.pack('<IHHIIHH', 16, 1, 1, rate, rate * 2, 2, 16) + \
        b'data' + struct.pack('<I', len(frames))
    audio_cache[rk] = header + bytes(frames)
    return audio_cache[rk]


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

    def do_GET(self):  # noqa: C901 - a router in one place is easier to read here
        u = urlparse(self.path)
        p = u.path.rstrip('/') or '/'
        q = parse_qs(u.query)
        if not q.get('X-Plex-Token', [''])[0] and not p.startswith('/library/parts'):
            return self.send_json({'error': 'Unauthorized'}, 401)
        parts = p.strip('/').split('/')

        if p == '/':
            return self.send_json({'friendlyName': "Dan's Test Server", 'machineIdentifier': 'mock-server-1', 'version': '1.41.0'})
        if p == '/identity':
            return self.send_json({'machineIdentifier': 'mock-server-1', 'version': '1.41.0', 'claimed': True})
        if p == '/library/sections':
            return self.send_json({'size': 3, 'Directory': [
                {'key': SECTION, 'type': 'artist', 'title': 'Music [Hi-Res]', 'uuid': 'mock-music'},
                {'key': '2', 'type': 'movie', 'title': 'Movies'},
                {'key': '3', 'type': 'artist', 'title': 'Audiobooks'},
            ]})
        if p.startswith('/library/sections/'):
            sec = parts[2]
            sub = parts[3] if len(parts) > 3 else ''
            if sec != SECTION:
                return self.send_json({'size': 0, 'totalSize': 0, 'Metadata': []})
            typ = int(q.get('type', ['9'])[0])
            if sub == 'all':
                pool = {8: artists, 9: albums, 10: tracks}.get(typ, albums)
                res = pool
                for f, vals in q.items():
                    if f in ('type', 'sort', 'group') or f.startswith('X-Plex'):
                        continue
                    if f.endswith('>>'):
                        fld = f[:-2]
                        res = [x for x in res if (x.get(fld) or 0) > float(vals[0])]
                        continue
                    res = [x for x in res if matches(x, f, vals[0])]
                return self.page(sort_items(res, q.get('sort', [None])[0]), q)
            if sub in ('genre', 'style', 'mood', 'decade'):
                return self.send_json({'size': 0, 'Directory': tag_dir(sub, typ)})
            if sub == 'collections':
                return self.page(collections, q)
            if sub == 'computePath':
                a, b = q.get('startID', [''])[0], q.get('endID', [''])[0]
                path = [items[a]] + random.sample(tracks, 8) + [items[b]]
                return self.page(path, {'X-Plex-Container-Size': ['100']})
        if p.startswith('/library/collections/'):
            c = items.get(parts[2])
            if not c:
                return self.not_found()
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
        if p == '/playlists':
            return self.page(playlists, {'X-Plex-Container-Size': ['500']})
        if p.startswith('/playlists/'):
            pl = items.get(parts[1])
            if not pl:
                return self.not_found()
            if len(parts) > 2 and parts[2] == 'items':
                return self.page(pl['_items'], q, {'leafCount': pl['leafCount']})
            if len(parts) > 2 and parts[2] == 'composite':
                return self.send_bytes(cover_png(p, 600), 'image/png')
            return self.send_json({'size': 1, 'Metadata': [public(pl)]})
        if p == '/photo/:/transcode':
            return self.send_bytes(cover_png(q.get('url', ['/x/x/0'])[0].split('?')[0], q.get('width', ['300'])[0]), 'image/png')
        if p == '/services/ultrablur/colors':
            return self.send_json({'size': 1, 'UltraBlurColors': [{'topLeft': '2a2440', 'topRight': '5b4a8a', 'bottomRight': '332a52', 'bottomLeft': '15121f'}]})
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
            sys.stderr.write(f'  timeline {state} {q.get("ratingKey", [""])[0]} t={q.get("time", [""])[0]}\n')
            return self.send_json({})
        return self.not_found()


if __name__ == '__main__':
    print(f'Mock Plex server on http://127.0.0.1:{PORT} '
          f'({len(artists)} artists, {len(albums)} albums, {len(tracks)} tracks, {len(playlists)} playlists)')
    ThreadingHTTPServer(('0.0.0.0', PORT), Handler).serve_forever()
