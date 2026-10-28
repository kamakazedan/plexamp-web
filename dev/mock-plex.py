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

    /__mock/config?ws=0|1&sse=0|1|silent&ping=SECONDS&open=0|1&delay=MS&loved=smart|none&nearest=N&copy=0|1&quiet=ID,...&stall=ID&bytes=N
        ws=0 refuses WebSockets (as a blocking proxy would), sse=0 refuses the
        event stream, sse=silent accepts it but never sends anything; open=1
        accepts any token; delay=MS slows library listings down; loved=smart
        adds a smart ❤️ Tracks playlist (five-star tracks, like Plexamp's),
        loved=none removes any ❤️ Tracks; nearest=N gives no more than the N
        nearest tracks (0: no limit), as a big library would, where a
        track's nearest few hundred are a sliver of it; copy=1 adds a hi-res
        copy of an album (Crate Digger: the same title, year and songs, as a
        library with two editions has), copy=0 takes it away; quiet=ID,...
        gives those tracks a quiet ending in their loudness analysis (the
        last 8 seconds about 23 dB down, a beat still ticking), quiet= none;
        hidden=ID,... keeps those tracks from the friends (as if they were in
        a library not shared with them): not added to their playlists, not
        listed in them, not found by id. hidden= none; stall=ID&bytes=N: the
        next time that track's file is asked for, its first N bytes come,
        then nothing more for a minute (as through a proxy that's stopped
        passing it on), stall= none; nogenre=ID,... takes those albums'
        genres away (as an album Plex has none for), nogenre= puts them back;
        hubs=on|titles|off: an artist's rows (/hubs/metadata/ID), with
        identifiers that say what's in them, only titles that do, or none
        (as an older server); types=off: albums' details without their
        release types (Format, Subformat), as some servers give them;
        smartcollection=1|0: a smart collection (Electronic picks) listed,
        whose items carry no tag for it, or not
    /__mock/add-artist?name=...   adds an artist with an album and a track of
                                  their own; ?remove=ID takes them away again
    /__mock/add-album?title=...[&untyped=1]
                                  adds an album and announces it (untyped:
                                  without a Format or Subformat, as an album
                                  Plex hasn't matched)
    /__mock/edits[?reset=1]       the album edits made (year, date, genres)
    /__mock/age?id=...&days=...   marks an album as last played that long ago
    /__mock/tracks                every track, with whether it starts or ends
                                  in silence (for testing transitions)
    /__mock/player[?reset=1]      the mock Plex player: what it's playing and
                                  the commands it got
    /__mock/hls?reset=1&kill=N&sessions=K&track=ID&how=stop|corrupt&short=S&slow=S
                                  converted streams (real HLS: silent MP3 in
                                  MPEG-TS, 4-second parts): the next K started
                                  (of that track, if given) stop at part N
                                  (its parts from there answer 404, as from a
                                  server that stopped the stream; corrupt:
                                  they're nothing a browser can play;
                                  kill=N1,N2,...: each its own part), every
                                  stream's last S seconds are missing, every
                                  part after the first is S seconds slow; and
                                  the streams started, their requests, and
                                  play reports since the reset

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
from urllib.parse import parse_qs, quote, unquote, urlparse

try:
    # (MOCK_NO_PILLOW=1: as in CI, where the mock runs without it.)
    if __import__('os').environ.get('MOCK_NO_PILLOW'):
        raise ImportError('Pillow left out')
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

# A MusicBrainz id, made up from what it's for (the mock MusicBrainz's, below).
def mb_id(text):
    h = hashlib.sha1(('mb|' + text).encode()).hexdigest()
    return f'{h[:8]}-{h[8:12]}-4{h[13:16]}-8{h[17:20]}-{h[20:32]}'



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


def track_guid(rk):
    """Plex's id for a recording (the same on any server that has it)."""
    return 'plex://track/' + hashlib.sha1(f'track|{rk}'.encode()).hexdigest()[:24]


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


# Artists Plex says are like an artist (its similar artists, from its
# metadata: some in the library, some not), and an artist's styles.
SIMILAR = {'Glass Harbour': ['Kilo Meridian', 'Boards of Canada', 'Marisol Vega', 'Tycho']}
ARTIST_STYLES = {'Glass Harbour': ['Ambient', 'Downtempo']}

for idx, (name, genres, bio) in enumerate(ARTISTS):
    k = key()
    a = {
        'ratingKey': k, 'key': f'/library/metadata/{k}/children', 'type': 'artist', 'title': name,
        'titleSort': name.lower().replace('the ', ''), 'thumb': f'/library/metadata/{k}/thumb/1',
        'art': f'/library/metadata/{k}/art/1', 'summary': bio, 'Genre': [tag('genre', g) for g in genres],
        'addedAt': NOW - 86400 * (300 - idx * 20), 'viewCount': 0, 'index': 1,
    }
    # (Plex's ids for it elsewhere: MusicBrainz's, as Plex has them with
    # includeGuids=1. Not for Various Artists.)
    if name != 'Various Artists':
        a['Guid'] = [{'id': 'mbid://' + mb_id('artist|' + name)}]
    if name in SIMILAR:
        a['Similar'] = [tag('similar', x) for x in SIMILAR[name]]
    if name in ARTIST_STYLES:
        a['Style'] = [tag('style', x) for x in ARTIST_STYLES[name]]
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
            'ratingKey': tk, 'key': f'/library/metadata/{tk}', 'type': 'track', 'guid': track_guid(tk),
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

# One song on several albums, for "Appears in": the original, an extended
# mix on the same artist's EP, a radio edit on a compilation, and another
# artist's song of the same name (which isn't the same song).
def nth_track(album_title, i):
    al = next(a for a in albums if a['title'] == album_title)
    return [t for t in tracks if t['parentRatingKey'] == al['ratingKey']][i]


for album_title, song, credit in [('Tidal Lines', 'Signal Fires', None), ('Buoy', 'Signal Fires (Extended Mix)', None),
                                  ('Night Drive Vol. 1', 'Signal Fires - Radio Edit', 'Glass Harbour'),
                                  ('Interference', 'Signal Fires', None)]:
    nth_track(album_title, 1)['title'] = song
    if credit:
        nth_track(album_title, 1)['originalTitle'] = credit
# (And a duo's track on the soundtrack: theirs, not Ash's, if the library
# has an artist called Ash: see /__mock/add-artist.)
nth_track('The Lighthouse (Original Score)', 0)['originalTitle'] = 'Juniper & Ash'

# ---------------------------------------------------------------- sound

# Where each track sits in a made-up sonic space, for nearest and
# computePath: an artist's tracks close together, genres apart (Hip-Hop
# between Electronic and Rock, so there's something to bridge them with),
# and the versions of one song by one artist (Signal Fires on three albums)
# on top of each other. Distances run from 0 (the same) to about 1, as
# Plex's do.
GENRE_AT = {'Electronic': (0.0, 0.0, 0.0), 'Hip-Hop': (0.35, 0.0, 0.0), 'Rock': (0.7, 0.0, 0.0),
            'Indie': (0.35, 0.35, 0.0), 'Folk': (0.35, 0.7, 0.0), 'Jazz': (0.0, 0.45, 0.45), 'Latin': (0.0, 0.45, 0.45)}
GENRE_OF = {name: genres[0] for name, genres, _ in ARTISTS}
_sound = {}


def stable_rng(text):
    return random.Random(int(hashlib.sha1(text.encode()).hexdigest()[:12], 16))


def song_key(t):
    """One song, whatever album it's on: its artist and its title without
    "(Extended Mix)" or "- Radio Edit"."""
    artist = t.get('originalTitle') or t['grandparentTitle']
    core = re.sub(r'\s*[([][^)\]]*[)\]]|\s+-\s+.*$', '', t['title']).strip().lower()
    return f'{artist.lower()}|{core}'


def sound(t):
    rk = t['ratingKey']
    if rk not in _sound:
        artist = t.get('originalTitle') or t['grandparentTitle']
        a = stable_rng('artist|' + artist)
        centre = [c + a.uniform(-0.06, 0.06) for c in GENRE_AT.get(GENRE_OF.get(artist, ''), (0.5, 0.5, 0.5))]
        song = stable_rng('song|' + song_key(t))
        jitter = random.Random(int(rk))
        _sound[rk] = tuple(c + song.uniform(-0.07, 0.07) + jitter.uniform(-0.003, 0.003) for c in centre)
    return _sound[rk]


def sonic_distance(a, b):
    return math.dist(sound(a), sound(b))


def sonic_path(a, b):
    """Like Plex's computePath: a, then tracks a step apart, then b; the
    further apart a and b sound, the more steps."""
    steps = max(1, min(12, round(sonic_distance(a, b) / 0.1)))
    used = {a['ratingKey'], b['ratingKey']}
    path = [a]
    for i in range(1, steps + 1):
        f = i / (steps + 1)
        at = [x + (y - x) * f for x, y in zip(sound(a), sound(b))]
        best = min((t for t in tracks if t['ratingKey'] not in used), key=lambda t: math.dist(sound(t), at))
        used.add(best['ratingKey'])
        path.append(best)
    return path + [b]


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


def smart_rules(query, section=SECTION):
    """A smart playlist's rules as Plex keeps them (its `content`): the
    library query it follows, escaped."""
    return 'library://mock-music/directory/' + quote(f'/library/sections/{section}/all?{query}', safe='')


def make_playlist(title, members, smart=False, viewed=None, section=SECTION, poster=False, rules='type=10', owner='t'):
    """A playlist; `poster`: with a picture of its own, set in Plex (its
    thumb), as well as the mosaic Plex makes (its composite). A smart one
    has `rules` (a library query), given out on its own page only (Plex's
    list of playlists may leave them out). Playlists are their owner's (a
    token): nobody else sees them, as on a real server."""
    k = key()
    p = {
        'ratingKey': k, 'key': f'/playlists/{k}/items', 'type': 'playlist', 'playlistType': 'audio',
        'title': title, 'smart': smart, 'composite': f'/playlists/{k}/composite/1',
        'leafCount': len(members), 'duration': sum(m['duration'] for m in members),
        'addedAt': NOW - 86400 * 40, 'updatedAt': NOW - 86400 * 3, '_items': list(members),
        '_pids': [entry_id() for _ in members], '_section': section, '_owner': owner,
    }
    if smart:
        p['_content'] = smart_rules(rules, section)
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
        pl = make_playlist('❤️ Tracks', [], smart=True, rules='type=10&userRating%3E%3E=10')
        pl['_rule'] = 'loved'
        playlists.append(follow_rule(pl))


def playlist_changed(pl):
    pl['leafCount'] = len(pl['_items'])
    pl['duration'] = sum(m['duration'] for m in pl['_items'])
    pl['updatedAt'] = int(time.time())
    timeline(pl['ratingKey'], 15, 5, section='-1')


def owner_of(token):
    """Whose playlists a token sees and makes: its account's (a server open
    to this network takes everyone for its owner)."""
    t = TRANSIENT.get(token, token)
    return t if t in SERVER_TOKENS else 't'


def can_have(rk, token):
    """Whether a token's account can have a track: not those hidden from the
    friend (/__mock/config?hidden=), as if they were in a library the owner
    hasn't shared with them."""
    return owner_of(token) == 't' or str(rk) not in MOCK['hidden']


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
if BIG:
    # Too long to read, and not of everything: left out of "Appears in".
    playlists.append(make_playlist('Long smart mix', tracks[:2500], smart=True, rules='type=10&genre=electronic'))

COLLECTION_TYPES = {8: 'artist', 9: 'album', 10: 'track'}
collections = []
# (Each with its index, as Plex has: the id of the tag its items carry. A
# smart one's items carry none: its rules decide what's in it. The smart
# one's only listed with /__mock/config?smartcollection=1.)
next_index = [9000]


def collection_index():
    next_index[0] += 7
    return next_index[0]


for i, (title, subtype, members, smart) in enumerate([
    ('Harbour Records', 'album', [a for a in albums if a['studio'] == 'Harbour Records'][:5], False),
    ('Rainy day albums', 'album', albums[2:6], False),
    ('Best of 2022', 'track', [t for t in tracks if items[t['parentRatingKey']]['year'] == 2022], False),
    ('Road trip', 'album', albums[7:11], False),
    ('Piano and strings', 'artist', [artists[2], artists[4]], False),
    ('Electronic picks', 'album', [a for a in albums if any(g['tag'] == 'Electronic' for g in a['Genre'])], True),
]):
    k = key()
    c = {'ratingKey': k, 'type': 'collection', 'subtype': subtype, 'title': title, 'childCount': len(members),
         'thumb': members[0].get('thumb') or members[0].get('parentThumb'), '_items': list(members),
         'addedAt': NOW - 86400 * (60 - i * 7), 'updatedAt': NOW - 86400 * (20 - i * 3), 'collectionSort': 0,
         'index': collection_index()}
    items[k] = c
    if smart:
        c['smart'] = '1'
        SMART_COLLECTION = c
    else:
        collections.append(c)


def collection_tags(it):
    """The collections an item is in, as its details say (Plex's Collection
    tags: each the collection's index, and its title): not smart ones."""
    return [{'id': c['index'], 'tag': c['title'], 'filter': f"collection={c['index']}"}
            for c in collections if not c.get('smart') and any(m['ratingKey'] == it['ratingKey'] for m in c['_items'])]


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
    if field == 'genre' and typ == 9:
        # Plex lists tags nothing uses any more (until the database is
        # cleaned), and their fastKey leaves out the type, as Plex's can.
        values['polka'] = 'Polka'
    return [{'key': k, 'title': v, 'fastKey': f'/library/sections/{SECTION}/all?{field}={k}'}
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
    if field == 'title':  # Plex: the title contains it
        return value.lower() in str(it.get('title', '')).lower()
    if field == 'guid':
        return it.get('guid') in values
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


LOSSY = ('mp3', 'aac', 'opus', 'vorbis')


def listed(it):
    """An item as Plex lists it: an album without its release types."""
    return {k: v for k, v in public(it).items() if k not in ('Format', 'Subformat')} if it.get('type') == 'album' else public(it)


def item_detail(it):
    """An item's details, as /library/metadata/ID gives them: a track's with
    its streams, and an artist's, album's or track's with the collections
    it's in (types=off: an album's without its release types)."""
    d = track_detail(it) if it['type'] == 'track' else public(it)
    if it['type'] == 'album' and MOCK['types'] == 'off':
        d = listed(it)
    if it['type'] in ('artist', 'album', 'track'):
        d['Collection'] = collection_tags(it)
        if not d['Collection']:
            del d['Collection']
    return d


def project(mc, q):
    """Plex's includeFields and excludeElements: each item (and the list)
    with only the fields asked for, and without those elements."""
    fields = {x for x in q.get('includeFields', [''])[0].split(',') if x}
    gone = {x for x in q.get('excludeElements', [''])[0].split(',') if x}
    if not fields and not gone:
        return mc

    def trim(d, top=False):
        out = {}
        for k, v in d.items():
            if k[:1].isupper():  # an element
                if top and k == 'Metadata':
                    out[k] = [trim(x) for x in v]
                elif k not in gone:
                    out[k] = v
            elif not fields or k in fields:
                out[k] = v
        return out
    return trim(mc, top=True)


# An artist's rows on their page (/hubs/metadata/ID), as Plexamp shows them:
# their albums by kind (by their Format and Subformat, which the rows'
# albums don't carry, as Plex's lists don't), the albums of others' with a
# track credited to them (Appears On), their popular tracks and the artists
# like them. hubs=titles: identifiers that don't say what's in a row, only
# its title does.
HUB_ROWS = [  # kind, identifier, title
    ('albums', 'artist.albums', 'Albums'),
    ('singles', 'artist.albums.single', 'Singles & EPs'),
    ('live', 'artist.albums.live', 'Live Albums'),
    ('compilations', 'artist.albums.compilation', 'Compilations'),
    ('soundtracks', 'artist.albums.soundtrack', 'Soundtracks'),
    ('remixes', 'artist.albums.remix', 'Remixes'),
    ('demos', 'artist.albums.demo', 'Demos'),
]


def album_kind(al):
    sub = ' '.join(t['tag'] for t in al.get('Subformat', [])).lower()
    for word, kind in (('compilation', 'compilations'), ('live', 'live'), ('soundtrack', 'soundtracks'), ('remix', 'remixes'), ('demo', 'demos')):
        if word in sub:
            return kind
    fmt = ' '.join(t['tag'] for t in al.get('Format', [])).lower()
    return 'singles' if re.search(r'\b(ep|single)\b', fmt) else 'albums'


def credited(t, name):
    """Whether a track's credited to the artist of that name (lowercased):
    its track artist, the whole credit or a name either side of a featured
    credit ("A feat. B", "A vs. B", "A; B"), never part of "Sam & Dave"."""
    credit = (t.get('originalTitle') or '').strip().lower()
    return bool(credit) and (credit == name or name in (p.strip() for p in re.split(
        r'\s+(?:feat\.?|ft\.?|featuring|with|vs\.?|x)\s+|\s*;\s*|\s+/\s+', credit, flags=re.I)))


def artist_hubs(artist, count):
    hubs = []

    def row(ident, title, typ, lst):
        shown = lst[:count]
        n = len(hubs) + 1
        hubs.append({'hubIdentifier': f'artist.hub.{n}' if MOCK['hubs'] == 'titles' else ident, 'title': title, 'type': typ,
                     'hubKey': f'/hubs/metadata/{artist["ratingKey"]}/{n}', 'key': f'/hubs/metadata/{artist["ratingKey"]}/{n}',
                     'size': len(shown), 'more': len(lst) > len(shown), 'Metadata': [listed(x) for x in shown]})
    own = [a for a in albums if a['parentRatingKey'] == artist['ratingKey']]
    for kind, ident, title in HUB_ROWS:
        of = sorted((a for a in own if album_kind(a) == kind), key=lambda a: -a['year'])
        if of:
            row(ident, title, 'album', of)
    name = artist['title'].lower()
    on = []
    for t in tracks:
        al = items[t['parentRatingKey']]
        if al['parentRatingKey'] != artist['ratingKey'] and credited(t, name) and al not in on:
            on.append(al)
    if on:
        row('artist.appearsOn', 'Appears On', 'album', on)
    popular = sorted((t for t in tracks if t['grandparentRatingKey'] == artist['ratingKey']), key=lambda t: -t['ratingCount'])
    if popular:
        row('artist.popularTracks', 'Popular Tracks', 'track', popular)
    like = [a for a in artists if a['title'] in SIMILAR.get(artist['title'], [])]
    if like:
        row('artist.similar', 'Similar Artists', 'artist', like)
    return hubs


def track_detail(t):
    d = public(t)
    d['Media'] = [dict(t['Media'][0])]
    codec = t['Media'][0].get('audioCodec', 'flac')
    hires = t.get('_hires', int(t['ratingKey']) % 2 == 1)
    # Loudness analysis, as Plex gives it: gains in dB to ReplayGain's -18
    # LUFS. Tracks with an even id are loud masters (-8 LUFS), the others
    # quiet (-16 LUFS); every album's gain is -7 dB.
    loud = int(t['ratingKey']) % 2 == 0
    loudness = -8.0 if loud else -16.0
    # (A lossy file has no bit depth, and is 44.1 kHz here.)
    sound = {'samplingRate': 44100, 'bitrate': t['Media'][0].get('bitrate')} if codec in LOSSY else {
        'bitDepth': 24 if hires else 16, 'samplingRate': 96000 if hires else 44100}
    d['Media'][0]['Part'] = [dict(t['Media'][0]['Part'][0], Stream=[
        dict({'id': int(t['ratingKey']) * 10 + 1, 'streamType': 2, 'codec': codec, 'channels': 2,
              'loudness': loudness, 'gain': -18.0 - loudness, 'albumGain': -7.0,
              'peak': 0.98 if loud else 0.6, 'albumPeak': 0.99}, **sound)])]
    return d


# Tracks' formats as /__mock/config?codec= changed them: what they were.
CODEC_WAS = {}


def set_codecs(spec):
    """/__mock/config?codec=ID:mp3,ID2:flac gives tracks another format
    (a lossy one at 320 kbps); codec=reset puts them back."""
    if spec == 'reset':
        for rk, media in CODEC_WAS.items():
            if rk in items:
                items[rk]['Media'] = media
        CODEC_WAS.clear()
        return
    for pair in filter(None, spec.split(',')):
        rk, _, codec = pair.partition(':')
        t = items.get(rk)
        if not t or t.get('type') != 'track' or not codec:
            continue
        CODEC_WAS.setdefault(rk, t['Media'])
        part = dict(t['Media'][0]['Part'][0], container=codec)
        t['Media'] = [{'audioCodec': codec, 'container': codec, 'bitrate': 320 if codec in LOSSY else 1411, 'Part': [part]}]


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
QUIET_END_AT = 0.6  # tracks given a quiet ending (/__mock/config?quiet=): the last 8 seconds


def loudness_levels(stream_id, n):
    # A plausible loudness curve in dB: quiet intro, a loud body with some
    # movement, a short breakdown and a fade-out, or silence where the
    # track's audio is silent. A quiet ending is about 23 dB under the rest,
    # with a louder beat every second.
    rnd = random.Random(stream_id)
    rk = stream_id // 10
    quiet_end = str(rk) in MOCK['quiet']
    out = []
    for i in range(n):
        f = i / max(1, n - 1)
        base = -10 - 6 * rnd.random()
        if f < 0.04:
            base -= 22 * (1 - f / 0.04)
        if 0.72 < f < 0.745:
            base = -48
        if quiet_end and f >= QUIET_END_AT:
            base = -24 if i % 8 == 0 else -34 - 2 * rnd.random()
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


# Songs, albums and artists the mock MusicBrainz knows that the library
# doesn't have (see Handler.musicbrainz), and what it was asked.
MB_EXTRA = {
    'artists': ['Real Missing Band'],
    'songs': [('Glass Harbour', 'Lantern Song'), ('Real Missing Band', 'Somewhere Real')],
    'albums': [('Glass Harbour', 'Sea Glass')],
}
MB_SEEN = {'requests': 0, 'agents': [], 'last': '', 'asked': []}  # asked: each request's path and query (the latest 500)

# What the mock MusicBrainz says of the library's artists, for the app's
# MusicBrainz features: other names, genres, release groups (the library's
# albums, with when they first came out, and some it doesn't have), and the
# groups' genres.
MB_ALIASES = {'Northbound Static': ['Нортбаунд Статик'], 'Glass Harbour': ['Glass Harbor']}
MB_GENRES = {'Glass Harbour': [('electronic', 4), ('ambient', 2)], 'Juniper & Ash': [('folk', 3)]}
MB_MORE_GROUPS = {
    'Glass Harbour': [('Sea Glass', 'Album', [], '2016-03-01'), ('Harbour Lights Live', 'Album', ['Live'], '2019-07-01'),
                      ('Early Tapes', 'Album', ['Demo'], '2012-01-01'), ('Undertow', 'Single', [], '2020-02-02')],
}
MB_FIRST_DATES = {'Hearthstone': '1998-03-01'}  # (the library's is a reissue)
# Another album of the same title as one of the library's, earlier (as a
# self-titled album can have: Weezer has six): the library's isn't that one.
MB_SAME_TITLE = {'Northbound Static': [('Interference', 'Album', [], '2009-06-01')]}
MB_GROUP_GENRES = {'Tidal Lines': [('ambient', 3), ('downtempo', 1)], 'Hearthstone': [('folk', 2), ('singer-songwriter', 1)]}


def mb_artists():
    out = []
    for a in artists:
        out.append({'id': mb_id('artist|' + a['title']), 'name': a['title'], 'sort-name': a['title'],
                    'aliases': [{'name': x, 'sort-name': x} for x in MB_ALIASES.get(a['title'], [])],
                    'genres': [{'name': g, 'count': n} for g, n in MB_GENRES.get(a['title'], [])]})
    return out


def mb_groups(artist_name):
    out = []
    more = {title for title, *_ in MB_MORE_GROUPS.get(artist_name, [])}
    for al in albums:
        # (One added to the library that MusicBrainz has anyway is as it has it.)
        if al['parentTitle'] != artist_name or al['title'] in more:
            continue
        sub = [t['tag'] for t in al.get('Subformat', [])]
        fmt = (al.get('Format') or [{'tag': 'Album'}])[0]['tag']
        out.append({'id': mb_id('group|' + artist_name + '|' + al['title']), 'title': al['title'], 'primary-type': fmt, 'secondary-types': sub,
                    'first-release-date': MB_FIRST_DATES.get(al['title'], f"{al.get('year') or 2000}-05-01")})
    for title, primary, sub, date in MB_MORE_GROUPS.get(artist_name, []):
        out.append({'id': mb_id('group|' + artist_name + '|' + title), 'title': title, 'primary-type': primary, 'secondary-types': sub, 'first-release-date': date})
    for title, primary, sub, date in MB_SAME_TITLE.get(artist_name, []):
        out.append({'id': mb_id('group|' + artist_name + '|' + title + '|' + date), 'title': title, 'primary-type': primary, 'secondary-types': sub, 'first-release-date': date})
    return out

# Pictures uploaded to playlists and collections (Plex calls them posters),
# by the SHA-1 of their bytes.
PICTURES = {}


def picture_info(data):
    """(format, width, height) of a JPEG or PNG, without Pillow (CI's mock
    runs without it); (None, 0, 0) for anything else."""
    if data[:8] == b'\x89PNG\r\n\x1a\n' and len(data) >= 24:
        return ('PNG', *struct.unpack('>II', data[16:24]))
    if data[:3] == b'\xff\xd8\xff':
        i = 2
        while i + 9 < len(data):
            if data[i] != 0xFF:
                i += 1
                continue
            marker = data[i + 1]
            if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
                height, width = struct.unpack('>HH', data[i + 5:i + 9])
                return ('JPEG', width, height)
            if marker in (0xD8, 0x01, 0xFF) or 0xD0 <= marker <= 0xD7:
                i += 1 if marker == 0xFF else 2
                continue
            i += 2 + struct.unpack('>H', data[i + 2:i + 4])[0]
        return ('JPEG', 0, 0)
    return (None, 0, 0)


def picture_bytes(data, size):
    """An uploaded picture at about this size, and its type (as it is,
    without Pillow)."""
    if Image is None:
        return data, 'image/png' if picture_info(data)[0] == 'PNG' else 'image/jpeg'
    img = Image.open(io.BytesIO(data)).convert('RGB')
    size = max(32, min(int(size or 300), 1024))
    img.thumbnail((size, size))
    out = io.BytesIO()
    img.save(out, 'PNG')
    return out.getvalue(), 'image/png'


def uploaded_picture(url):
    """The uploaded picture an artwork address leads to, if any: a poster's
    own address, or the thumb of an item that shows one."""
    m = re.search(r'upload(?::|%3A)(?:/|%2F){2}posters(?:/|%2F)([0-9a-f]{40})', url, re.I)
    if m:
        return PICTURES.get(m.group(1))
    m = re.match(r'/library/metadata/(\d+)/thumb/\d+', url)
    it = items.get(m.group(1)) if m else None
    if it and it.get('_poster') and (it.get('thumb') or '').startswith(m.group(0).rsplit('/', 1)[0] + '/'):
        return PICTURES.get(it['_poster'])
    return None


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


# ---------------------------------------------------------------- converted streams

# A converted track is an HLS stream, as from a real server: a playlist in
# the stream's session listing its parts, each an MPEG transport stream of
# MP3 frames (silent ones here: a frame header and nothing in it). Browsers
# without built-in HLS play it with hls.js.
HLS_PART = 4  # seconds in each part
MP3_FRAME = b'\xff\xfb\x10\xc0' + bytes(100)  # MPEG-1 layer III, 32 kbps, 44.1 kHz, mono: 104 bytes
MP3_FRAME_SECONDS = 1152 / 44100
HLS = {'sessions': {}, 'order': [], 'requests': [], 'timelines': [], 'kill': None, 'short': 0, 'slow': 0}
HLS_LOCK = threading.Lock()


def mpeg_crc32(data):
    crc = 0xffffffff
    for b in data:
        crc ^= b << 24
        for _ in range(8):
            crc = ((crc << 1) ^ 0x04c11db7) & 0xffffffff if crc & 0x80000000 else (crc << 1) & 0xffffffff
    return crc


def ts_section(pid, table):
    """A PAT or PMT in a packet of its own."""
    body = table + struct.pack('>I', mpeg_crc32(table))
    head = bytes([0x47, 0x40 | (pid >> 8), pid & 0xff, 0x10])
    return (head + b'\x00' + body).ljust(188, b'\xff')


PAT = ts_section(0, bytes([0x00, 0xb0, 13, 0, 1, 0xc1, 0, 0, 0, 1, 0xf0, 0x00]))
PMT = ts_section(0x1000, bytes([0x02, 0xb0, 18, 0, 1, 0xc1, 0, 0, 0xe1, 0x01, 0xf0, 0, 0x03, 0xe1, 0x01, 0xf0, 0]))


def pes_packet(frame, pts, cc):
    """One MP3 frame in a PES packet, in one transport stream packet (the
    rest of it stuffing)."""
    stamp = bytes([0x21 | ((pts >> 29) & 0x0e), (pts >> 22) & 0xff, 0x01 | ((pts >> 14) & 0xfe), (pts >> 7) & 0xff, 0x01 | ((pts << 1) & 0xfe)])
    pes = b'\x00\x00\x01\xc0' + struct.pack('>H', 8 + len(frame)) + b'\x80\x80\x05' + stamp + frame
    room = 184 - len(pes)
    adaptation = bytes([room - 1]) + (b'\x00' + b'\xff' * (room - 2) if room > 1 else b'')
    return bytes([0x47, 0x41, 0x01, 0x30 | (cc & 0x0f)]) + adaptation + pes


def hls_part(index, seconds):
    """Part `index` of a stream `seconds` long."""
    first = math.ceil(index * HLS_PART / MP3_FRAME_SECONDS)
    last = min(math.ceil((index + 1) * HLS_PART / MP3_FRAME_SECONDS), math.ceil(seconds / MP3_FRAME_SECONDS))
    out = [PAT, PMT]
    for n, k in enumerate(range(first, last)):
        out.append(pes_packet(MP3_FRAME, int(126000 + k * MP3_FRAME_SECONDS * 90000), n))
    return b''.join(out)


def hls_playlist(seconds):
    parts = math.ceil(seconds / HLS_PART)
    lines = ['#EXTM3U', '#EXT-X-VERSION:3', f'#EXT-X-TARGETDURATION:{HLS_PART}', '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD']
    for i in range(parts):
        lines += [f'#EXTINF:{min(HLS_PART, seconds - i * HLS_PART):.3f},', f'{i:05d}.ts']
    return '\n'.join(lines + ['#EXT-X-ENDLIST', ''])


# ---------------------------------------------------------------- notifications

MOCK = {'ws': True, 'sse': 'on', 'ping': 10.0, 'open': False, 'delay': 0, 'nearest': 0, 'copy': False, 'quiet': [], 'hidden': [], 'stall': None,
        'hubs': 'on', 'types': 'on'}
EDITS = []  # albums' years, dates and genres changed (PUT /library/sections/.../all?type=9)
NO_GENRE = {}  # album id -> its genres, taken away (/__mock/config?nogenre=)
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


COPIES = []  # the hi-res copy of Crate Digger and its tracks (see set_copy)


def set_copy(on):
    """A second edition of an album, as libraries often have: the same
    title, year and songs (a second or so longer), but hi-res FLAC."""
    if not on:
        for it in COPIES:
            items.pop(it['ratingKey'], None)
            (albums if it['type'] == 'album' else tracks).remove(it)
        COPIES.clear()
        MOCK['copy'] = False
        return
    if COPIES:
        return
    src = next(a for a in albums if a['title'] == 'Crate Digger')
    k = key()
    al = dict(src, ratingKey=k, key=f'/library/metadata/{k}/children', thumb=f'/library/metadata/{k}/thumb/1', addedAt=int(time.time()))
    items[k] = al
    albums.append(al)
    COPIES.append(al)
    for t in [t for t in tracks if t['parentRatingKey'] == src['ratingKey']]:
        tk = key()
        c = dict(t, ratingKey=tk, key=f'/library/metadata/{tk}', guid=track_guid(tk), parentRatingKey=k, parentThumb=al['thumb'], duration=t['duration'] + 1000, _hires=True)
        c['Media'] = [{'audioCodec': 'flac', 'container': 'flac', 'bitrate': 2900, 'Part': [
            {'key': f'/library/parts/{tk}/0/file.flac', 'duration': c['duration'], 'container': 'flac'}]}]
        items[tk] = c
        tracks.append(c)
        COPIES.append(c)
    MOCK['copy'] = True


def add_album(title, untyped=False):
    """Add an album to the library the way a scan would, with notifications
    (untyped: without a Format or Subformat, as one Plex hasn't matched)."""
    artist = artists[0]
    k = key()
    year = 2025
    al = dict(albums[0], ratingKey=k, key=f'/library/metadata/{k}/children', title=title, titleSort=title.lower(),
              thumb=f'/library/metadata/{k}/thumb/1', year=year, originallyAvailableAt=f'{year}-01-01',
              addedAt=int(time.time()), viewCount=0, lastViewedAt=None, leafCount=4, _palette=('402060', 'e0a0ff'))
    al.pop('lastViewedAt')
    if untyped:
        al['Format'] = []
        al['Subformat'] = []
    items[k] = al
    albums.append(al)
    LIBRARY_STATE['refreshing'] = True
    activity('started', 'Scanning Music [Hi-Res]')
    timeline(k, 9, 0)
    for i in range(4):
        tk = key()
        t = dict(tracks[0], ratingKey=tk, key=f'/library/metadata/{tk}', guid=track_guid(tk), title=f'{title} Part {i + 1}', index=i + 1,
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


def parts_of(path):
    return [x for x in path.split('/') if x]


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


# ---------------------------------------------------------------- Spotify

# Spotify's public page for a playlist (its embed player), as the container's
# Spotify import reads it (point it here with SPOTIFY_URL): the playlist's
# name, who made it, and up to 100 tracks, in the JSON the page carries. Made
# from this library's tracks as Spotify names them ("Song - Remastered 2011",
# "Song (feat. Someone)", "Artist, Guest"), with a few the library doesn't
# have and a podcast episode. Any other playlist answers 404, as Spotify does
# for a private or deleted one.
SPOTIFY_IDS = {'road': 'mockRoadTrip0000000001', 'late': 'mockLateNight000000002', 'hundred': 'mockHundred00000000003'}


def spotify_playlist(pid):
    own = [t for t in tracks if not t.get('originalTitle') and t['type'] == 'track']
    seen, lib = set(), []
    for t in own:  # one of each title, so each is plain to find
        if t['title'].lower() not in seen:
            seen.add(t['title'].lower())
            lib.append(t)

    def sp(t=None, title=None, artist=None):
        title = title or t['title']
        return {'uri': f'spotify:track:{hashlib.sha1(title.encode()).hexdigest()[:22]}', 'uid': 'x', 'title': title,
                'subtitle': artist or t['grandparentTitle'], 'duration': (t or {}).get('duration', 201000),
                'isPlayable': True, 'isExplicit': False}
    if pid == SPOTIFY_IDS['road']:
        a = lib[0]['grandparentTitle']
        tl = [sp(lib[0], title=f"{lib[0]['title']} - Remastered 2011"), sp(lib[1], artist=f"{lib[1]['grandparentTitle']}, Guest Singer"),
              sp(lib[2], title=f"{lib[2]['title']} (feat. Someone Else)")] + [sp(t) for t in lib[3:8]] + [
              {'uri': 'spotify:episode:4rOoJ6Egrf8K2IrywzwOMk', 'title': 'A podcast episode', 'subtitle': 'Some Show', 'duration': 3600000},
              sp(title='Imaginary Song', artist='Nobody Known'), sp(title='Another Missing One', artist='Ghost Band, Someone'),
              sp(title='Not On Any Album', artist=a)]
        return 'next', {'type': 'playlist', 'name': 'Road trip classics', 'uri': f'spotify:playlist:{pid}', 'subtitle': 'Dan', 'trackList': tl}
    if pid == SPOTIFY_IDS['late']:
        return 'state', {'type': 'playlist', 'name': 'Night drive mix', 'uri': f'spotify:playlist:{pid}', 'subtitle': 'Sam', 'trackList': [sp(t) for t in lib[8:12]]}
    if pid == SPOTIFY_IDS['hundred']:
        return 'next', {'type': 'playlist', 'name': 'A hundred songs', 'uri': f'spotify:playlist:{pid}', 'subtitle': 'Dan',
                        'trackList': [sp(lib[i % len(lib)]) for i in range(100)]}
    return None, None


def spotify_page(shape, entity):
    if shape == 'state':
        blob = base64.b64encode(json.dumps({'data': {'entity': entity}}).encode()).decode()
        data = f'<script id="initial-state" type="text/plain">{blob}</script>'
    else:
        blob = json.dumps({'props': {'pageProps': {'state': {'data': {'entity': entity}}}}}).replace('<', '\\u003c')
        data = f'<script id="__NEXT_DATA__" type="application/json">{blob}</script>'
    return (f'<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>{entity["name"]}</title></head><body>'
            f'<div id="__next"></div><script src="https://embed-cdn.spotifycdn.com/_next/static/chunks/main.js"></script>{data}</body></html>')


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

    def send_json(self, mc, status=200, cors=True):
        body = json.dumps({'MediaContainer': mc}).encode()
        self.send_response(status)
        if cors:
            self.cors()
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_bytes(self, data, ctype, stall_after=None):
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
        if stall_after is None:
            self.wfile.write(chunk)
            return
        self.wfile.write(chunk[:stall_after])
        self.wfile.flush()
        time.sleep(60)  # (then the connection closes short)

    def not_found(self):
        self.send_json({'size': 0}, 404)

    def page(self, lst, q, extra=None):
        start = int(q.get('X-Plex-Container-Start', ['0'])[0])
        size = int(q.get('X-Plex-Container-Size', ['50'])[0])
        chunk = lst[start:start + size] if size else []
        mc = {'size': len(chunk), 'totalSize': len(lst), 'offset': start, 'Metadata': [public(x) for x in chunk]}
        if extra:
            mc.update(extra)
        self.send_json(project(mc, q))

    def do_POST(self):
        self.do_GET()

    def do_PUT(self):
        self.do_GET()

    def do_DELETE(self):
        self.do_GET()

    def playlist_page(self, pl, q, token=''):
        follow_rule(pl)
        start = int(q.get('X-Plex-Container-Start', ['0'])[0])
        size = int(q.get('X-Plex-Container-Size', ['50'])[0])
        # Tracks the account can't have (hidden=) aren't listed, as Plex
        # leaves out what's in a library that isn't shared with someone.
        rows = [dict(public(t), playlistItemID=pid) for t, pid in zip(pl['_items'], pl['_pids']) if can_have(t['ratingKey'], token)]
        chunk = rows[start:start + size] if size else []
        self.send_json(project({'size': len(chunk), 'totalSize': len(rows), 'offset': start, 'leafCount': pl['leafCount'],
                                'Metadata': chunk}, q))

    def edit_playlist(self, pl, parts, q, token):
        """PUT/DELETE on /playlists/{id}[/items[/{entry}[/move]]]."""
        if self.command == 'DELETE' and len(parts) == 2:
            playlists.remove(pl)
            items.pop(pl['ratingKey'], None)
            timeline(pl['ratingKey'], 15, 9, section='-1')
            return self.send_json({})
        if len(parts) == 2:  # PUT: rename, or a new summary
            if 'title' in q:
                pl['title'] = q['title'][0][:200]
            if 'summary' in q:
                pl['summary'] = q['summary'][0][:2000]
            pl['updatedAt'] = int(time.time())
            return self.send_json({'size': 1, 'Metadata': [public(pl)]})
        if pl['smart']:
            return self.send_json({'error': 'Smart playlists are edited by their rules'}, 400)
        if len(parts) == 3:  # PUT .../items?uri=: add to the end
            new = [items[i] for i in ids_from_uri(q.get('uri', [''])[0]) if items[i]['type'] == 'track' and can_have(i, token)]
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

    def musicbrainz(self, p, q):
        query = q.get('query', [''])[0]
        field = lambda name: (re.search(name + r':"([^"]*)"', query) or [None, ''])[1].strip().lower()
        MB_SEEN['requests'] += 1
        MB_SEEN['agents'] = sorted(set(MB_SEEN['agents']) | {self.headers.get('User-Agent', '')})
        MB_SEEN['last'] = query or p
        MB_SEEN['asked'] = (MB_SEEN['asked'] + [self.path])[-500:]
        artists_ = {a['title'].lower() for a in artists} | {a.lower() for a in MB_EXTRA['artists']}
        # (The MusicBrainz features: an artist by name or other name, looked
        # up by id, and their release groups, and a group's genres.)
        if p == '/ws/2/artist' and ' OR alias:' in query:
            names = {m.lower() for m in re.findall(r':"([^"]*)"', query)}
            hits = [a for a in mb_artists() if a['name'].lower() in names or any(x['name'].lower() in names for x in a['aliases'])]
            return self.send_json_plain({'artists': [dict(a, score=100) for a in hits]})
        if p.startswith('/ws/2/artist/'):
            hit = next((a for a in mb_artists() if a['id'] == parts_of(p)[-1]), None)
            return self.send_json_plain(hit) if hit else self.not_found()
        if p == '/ws/2/release-group' and 'artist' in q and not query:
            who = next((a['name'] for a in mb_artists() if a['id'] == q['artist'][0]), None)
            groups = mb_groups(who) if who else []
            start = int(q.get('offset', ['0'])[0])
            size = int(q.get('limit', ['25'])[0])
            return self.send_json_plain({'release-group-count': len(groups), 'release-groups': groups[start:start + size]})
        if p.startswith('/ws/2/release-group/'):
            gid = parts_of(p)[-1]
            title = next((al['title'] for al in albums if mb_id('group|' + al['parentTitle'] + '|' + al['title']) == gid), None)
            return self.send_json_plain({'id': gid, 'genres': [{'name': g, 'count': n} for g, n in MB_GROUP_GENRES.get(title, [])]})
        if p == '/ws/2/artist':
            name = field('artist')
            hit = name in artists_ or f'the {name}' in artists_
            return self.send_json_plain({'artists': [{'name': field('artist').title(), 'score': 100}] if hit else [{'name': 'Someone Else', 'score': 41}]})
        who_, what = field('artist'), field('recording') or field('releasegroup')
        if p == '/ws/2/recording':
            songs = {((t.get('originalTitle') or t['grandparentTitle']).lower(), t['title'].lower()) for t in tracks} | {(a.lower(), t.lower()) for a, t in MB_EXTRA['songs']}
            hit = (who_, what) in songs
            return self.send_json_plain({'recordings': [{'title': what.title(), 'score': 100, 'artist-credit': [{'name': who_.title()}]}] if hit else []})
        if p == '/ws/2/release-group':
            albums_ = {(al['parentTitle'].lower(), al['title'].lower()) for al in albums} | {(a.lower(), t.lower()) for a, t in MB_EXTRA['albums']}
            hit = (who_, what) in albums_
            return self.send_json_plain({'release-groups': [{'title': what.title(), 'score': 100, 'primary-type': 'Album', 'artist-credit': [{'name': who_.title()}]}] if hit else []})
        return self.not_found()

    def send_json_plain(self, obj):
        body = json.dumps(obj).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def pictures(self, it, sub, q, token):
        """A playlist's or collection's pictures, as Plex keeps them: the list
        (GET posters), a new one (POST posters, the picture as the body),
        choosing one (PUT poster?url=) and going back to Plex's own (DELETE
        thumb). Collections are the server's owner's to change; playlists
        their owner's."""
        rk = it['ratingKey']
        if it['type'] not in ('playlist', 'collection'):
            return self.send_json({'error': 'Not supported here'}, 400)
        if it['type'] == 'playlist' and it.get('_owner') != owner_of(token):
            return self.not_found()
        changing = self.command != 'GET'
        if changing and (not pms_token_ok(token) or (it['type'] == 'collection' and not is_admin(token))):
            return self.send_json({'error': 'Forbidden'}, 403)

        def shows(pid):
            it['_poster'] = pid
            it['thumb'] = f'/library/metadata/{rk}/thumb/{int(time.time() * 1000)}'
            it['updatedAt'] = int(time.time())

        if sub == 'posters' and self.command == 'POST':
            n = int(self.headers.get('Content-Length') or 0)
            data = self.rfile.read(n) if 0 < n <= 20 * 1024 * 1024 else b''
            if not picture_info(data)[0]:
                return self.send_json({'error': 'Not a picture'}, 400)
            pid = hashlib.sha1(data).hexdigest()
            PICTURES[pid] = data
            it.setdefault('_posters', [])
            if pid not in it['_posters']:
                it['_posters'].append(pid)
            it['_uploads'] = it.get('_uploads', 0) + 1
            shows(pid)
            return self.send_json({'size': 0})
        if sub == 'poster' and self.command == 'PUT':
            m = re.fullmatch(r'upload://posters/([0-9a-f]{40})', q.get('url', [''])[0])
            if not m or m.group(1) not in it.get('_posters', []):
                return self.send_json({'error': 'Bad request'}, 400)
            shows(m.group(1))
            return self.send_json({'size': 0})
        if sub == 'thumb':  # DELETE
            it.pop('_poster', None)
            if it['type'] == 'playlist':
                it.pop('thumb', None)
            else:
                first = (it.get('_items') or [{}])[0]
                it['thumb'] = first.get('thumb') or first.get('parentThumb')
            it['updatedAt'] = int(time.time())
            return self.send_json({'size': 0})
        if sub == 'posters':
            found = [{'type': 'photo', 'key': f'/library/metadata/{rk}/file?url=upload%3A%2F%2Fposters%2F{pid}',
                      'ratingKey': f'upload://posters/{pid}', 'thumb': f'/library/metadata/{rk}/file?url=upload%3A%2F%2Fposters%2F{pid}',
                      'selected': pid == it.get('_poster'), 'provider': 'local'} for pid in it.get('_posters', [])]
            return self.send_json({'size': len(found), 'Metadata': found})
        return self.send_json({'error': 'Bad request'}, 400)

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

    def hls_file(self, sid, name):
        """A converted stream's playlist or part. A session that wasn't
        started (as the container's tests ask for) is a 20-second track.
        /__mock/hls?kill=N&sessions=K&track=ID: the next K streams started
        (of that track, if given) are stopped at part N, as a server stops a
        stream (its parts from there answer 404), or with how=corrupt, their
        parts from there are nothing a browser can play (kill=N1,N2,...: the
        first at part N1, the next at N2...); short=S: every stream's last S
        seconds are missing; slow=S: every part after the first takes S
        seconds to come."""
        with HLS_LOCK:
            s = HLS['sessions'].get(sid) or {}
            short, slow = HLS['short'], HLS['slow']
        t = items.get(s.get('track', ''))
        seconds = (t['duration'] / 1000) if t and t.get('duration') else TRACK_SECONDS
        status = 200
        m = re.fullmatch(r'(\d{5})\.ts', name)
        if name == 'index.m3u8':
            body, ctype = hls_playlist(seconds).encode(), 'application/vnd.apple.mpegurl'
        elif m and int(m.group(1)) * HLS_PART < seconds:
            index = int(m.group(1))
            if slow and index:
                time.sleep(slow)
            stopped = s.get('killAt') is not None and index >= s['killAt']
            if stopped and s.get('how') == 'corrupt':
                body, ctype = b'\x00' * 2048, 'video/mp2t'  # not a transport stream: the browser can't play it
            elif stopped or (short and (index + 1) * HLS_PART > seconds - short):
                status, body, ctype = 404, b'', 'text/plain'
            else:
                body, ctype = hls_part(index, seconds), 'video/mp2t'
        else:
            status, body, ctype = 404, b'', 'text/plain'
        with HLS_LOCK:
            HLS['requests'].append({'session': sid, 'file': name, 'status': status})
            del HLS['requests'][:-300]
        self.send_response(status)
        self.cors()
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

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
            if token == 't3':
                # Alex can't use Dan's server, but has one of his own, elsewhere.
                res.append({'name': "Alex's Server", 'product': 'Plex Media Server', 'provides': 'server', 'clientIdentifier': 'mock-server-2',
                            'owned': True, 'accessToken': 't3', 'connections': [{'protocol': 'http', 'address': '192.0.2.10', 'port': 32400,
                                                                                 'uri': 'http://192.0.2.10:32400', 'local': False, 'relay': False}]})
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
            # (quiet= and hidden= clear those: blank values count here.)
            q = parse_qs(u.query, keep_blank_values=True)
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
            if 'nearest' in q:
                MOCK['nearest'] = max(0, int(q['nearest'][0] or 0))
            if 'copy' in q:
                set_copy(q['copy'][0] in ('1', 'on', 'true'))
            if 'quiet' in q:
                MOCK['quiet'] = [x for x in q['quiet'][0].split(',') if x]
            if 'hidden' in q:
                MOCK['hidden'] = [x for x in q['hidden'][0].split(',') if x]
            if 'nogenre' in q:
                for k, was in list(NO_GENRE.items()):
                    if k in items:
                        items[k]['Genre'] = was
                    del NO_GENRE[k]
                for k in (x for x in q['nogenre'][0].split(',') if x in items):
                    NO_GENRE[k] = items[k].get('Genre', [])
                    items[k]['Genre'] = []
            if 'codec' in q:
                set_codecs(q['codec'][0])
            if 'hubs' in q:  # an artist's rows (artist_hubs): on, titles (only their titles say what's in them) or off
                MOCK['hubs'] = q['hubs'][0] if q['hubs'][0] in ('on', 'titles', 'off') else 'on'
            if 'smartcollection' in q:  # 1: the smart collection (Electronic picks) is listed; 0: it isn't
                on = q['smartcollection'][0] in ('1', 'on', 'true')
                if on and SMART_COLLECTION not in collections:
                    collections.append(SMART_COLLECTION)
                elif not on and SMART_COLLECTION in collections:
                    collections.remove(SMART_COLLECTION)
            if 'types' in q:  # off: albums' details without their release types, as some servers give them
                MOCK['types'] = 'off' if q['types'][0] in ('0', 'off', 'false') else 'on'
            if 'stall' in q:
                # stall=ID&bytes=N: the next time that track's file is asked
                # for, N bytes of it come, then nothing more (the connection
                # held open, as a proxy that's stopped passing it on does).
                MOCK['stall'] = {'track': q['stall'][0], 'bytes': int(q.get('bytes', ['60000'])[0])} if q['stall'][0] else None
            return self.send_json(dict(MOCK, listeners=len(listeners)))
        if p == '/__mock/hls':
            # Converted streams: the rules (see hls_file), and what's been
            # started and asked for since the last reset.
            with HLS_LOCK:
                if q.get('reset'):
                    HLS.update({'sessions': {}, 'order': [], 'requests': [], 'timelines': [], 'kill': None, 'short': 0, 'slow': 0})
                if 'kill' in q:
                    # kill=N&sessions=K, or kill=N1,N2,...: one part for each stream.
                    at = [int(x) for x in q['kill'][0].split(',') if x]
                    if len(at) == 1:
                        at *= int(q.get('sessions', ['1'])[0])
                    HLS['kill'] = {'at': at, 'track': q.get('track', [''])[0], 'how': q.get('how', ['stop'])[0]} if at else None
                if 'short' in q:
                    HLS['short'] = float(q['short'][0] or 0)
                if 'slow' in q:
                    HLS['slow'] = float(q['slow'][0] or 0)
                return self.send_json({'sessions': [dict(HLS['sessions'][sid], id=sid) for sid in HLS['order']],
                                       'requests': HLS['requests'], 'timelines': HLS['timelines'],
                                       'kill': HLS['kill'], 'short': HLS['short'], 'slow': HLS['slow']})
        if p == '/__mock/add-album':
            al = add_album(q.get('title', ['Fresh Arrival'])[0], untyped=q.get('untyped', ['0'])[0] == '1')
            return self.send_json({'size': 1, 'Metadata': [public(al)]})
        if p == '/__mock/add-artist':  # name=...: an artist with an album of their own; remove=ID: gone again
            gone = items.get(q.get('remove', [''])[0])
            if gone and gone.get('type') == 'artist':
                for al in [a for a in albums if a['parentRatingKey'] == gone['ratingKey']]:
                    for tr in [x for x in tracks if x['parentRatingKey'] == al['ratingKey']]:
                        tracks.remove(tr)
                        items.pop(tr['ratingKey'], None)
                    albums.remove(al)
                    items.pop(al['ratingKey'], None)
                artists.remove(gone)
                items.pop(gone['ratingKey'], None)
                return self.send_json({'size': 0})
            name = q.get('name', ['Ash'])[0]
            k = key()
            a = dict(artists[0], ratingKey=k, key=f'/library/metadata/{k}/children', title=name, titleSort=name.lower(),
                     thumb=f'/library/metadata/{k}/thumb/1', art=f'/library/metadata/{k}/art/1', summary='')
            for f in ('Guid', 'Similar', 'Style'):
                a.pop(f, None)
            items[k] = a
            artists.append(a)
            ak = key()
            al = dict(albums[0], ratingKey=ak, key=f'/library/metadata/{ak}/children', title=f'{name} Alone', titleSort=f'{name} alone'.lower(),
                      parentRatingKey=k, parentTitle=name, parentThumb=a['thumb'], thumb=f'/library/metadata/{ak}/thumb/1', leafCount=1)
            items[ak] = al
            albums.append(al)
            tk = key()
            tr = dict(tracks[0], ratingKey=tk, key=f'/library/metadata/{tk}', guid=track_guid(tk), title=f'{name} Song', index=1, parentIndex=1,
                      parentRatingKey=ak, parentTitle=al['title'], parentThumb=al['thumb'], grandparentRatingKey=k, grandparentTitle=name,
                      grandparentThumb=a['thumb'])
            tr.pop('originalTitle', None)
            items[tk] = tr
            tracks.append(tr)
            return self.send_json({'size': 1, 'Metadata': [public(a)]})
        if p == '/__mock/player':
            with PLAYER['lock']:
                if q.get('reset'):
                    PLAYER.update({'pq': None, 'entry': None, 'state': 'stopped', 'offset': 0, 'log': [], 'volume': 100})
                pos = player_position()
                t, e = player_track()
                return self.send_json({'state': PLAYER['state'] if t else 'stopped', 'time': pos, 'ratingKey': t and t['ratingKey'],
                                       'playQueueID': PLAYER['pq'] and PLAYER['pq']['id'], 'queue': [x['ratingKey'] for x, _ in (PLAYER['pq'] or {}).get('items', [])],
                                       'volume': PLAYER['volume'], 'log': PLAYER['log']})
        # A little MusicBrainz (the service is pointed here in tests): the
        # library's artists, songs and albums are real, and so are a few
        # that aren't in it.
        if p.startswith('/ws/2/'):
            return self.musicbrainz(p, q)
        if p == '/__mock/musicbrainz':
            if q.get('reset', ['0'])[0] == '1':
                MB_SEEN['asked'] = []
            return self.send_json(dict(MB_SEEN))
        if p == '/__mock/edits':
            if q.get('reset', ['0'])[0] == '1':
                EDITS.clear()
            return self.send_json({'edits': EDITS})
        if p == '/__mock/picture':  # what was uploaded as an item's picture, if anything
            it = items.get(q.get('id', [''])[0]) or {}
            data = PICTURES.get(it.get('_poster') or '')
            if not data:
                return self.send_json({'picture': None, 'uploads': it.get('_uploads', 0)})
            fmt_, w, h = picture_info(data)
            return self.send_json({'picture': {'bytes': len(data), 'uploads': it.get('_uploads', 0), 'format': fmt_, 'width': w, 'height': h}})
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
        if p.startswith('/embed/playlist/'):  # Spotify's public page for a playlist (see spotify_playlist)
            shape, entity = spotify_playlist(p.rsplit('/', 1)[-1])
            if not entity:
                return self.send_text('<!DOCTYPE html><html><body>Page not found</body></html>', 'text/html', 404)
            return self.send_text(spotify_page(shape, entity), 'text/html; charset=utf-8')
        if p == '/identity':
            # Answered without signing in, like a real server; and as on one,
            # a page on another address only gets to read the answer when the
            # request carries a token (the browser calls it a network error).
            return self.send_json({'machineIdentifier': 'mock-server-1', 'version': '1.41.0', 'claimed': True},
                                  cors=bool(token) or not self.headers.get('Origin'))
        # A converted stream's playlists live inside its session and are
        # fetched without a token, as on a real server.
        if p.startswith('/audio/:/transcode/universal/session/') and len(parts) == 8:
            return self.hls_file(parts[5], parts[7])
        if p == '/audio/:/transcode/universal/start.m3u8' and pms_token_ok(token):
            sid = q.get('transcodeSessionId', ['mock'])[0].replace('/', '')
            rk = q.get('path', [''])[0].rsplit('/', 1)[-1]
            with HLS_LOCK:
                kill = HLS['kill']
                doomed = None
                if kill and kill['at'] and kill['track'] in ('', rk):
                    doomed = kill['at'].pop(0)
                HLS['sessions'][sid] = {'track': rk, 'playback': q.get('X-Plex-Session-Identifier', [''])[0], 'killAt': doomed,
                                        'how': kill['how'] if doomed is not None else None, 'bitrate': q.get('musicBitrate', [''])[0]}
                HLS['order'].append(sid)
            return self.send_text(f'#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=320000,CODECS="mp4a.40.34"\nsession/{sid}/base/index.m3u8\n',
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
            if sub == 'all' and self.command == 'PUT' and typ == 9:  # an album's year, date or genres (locked)
                al = items.get(q.get('id', [''])[0])
                if not al or al.get('type') != 'album':
                    return self.not_found()
                if not is_admin(token):
                    return self.send_json({'error': 'Forbidden'}, 403)
                if 'year.value' in q:
                    al['year'] = int(q['year.value'][0])
                if 'originallyAvailableAt.value' in q:
                    al['originallyAvailableAt'] = q['originallyAvailableAt.value'][0][:10]
                genres = [q[k][0] for k in sorted((k for k in q if re.fullmatch(r'genre\[\d+\]\.tag\.tag', k)), key=lambda k: int(re.search(r'\d+', k).group()))]
                if genres:
                    al['Genre'] = [tag('genre', g) for g in genres]
                if 'genre[].tag.tag-' in q:
                    gone = {unquote(x) for x in q['genre[].tag.tag-'][0].split(',')}
                    al['Genre'] = [t for t in al.get('Genre', []) if t['tag'] not in gone]
                EDITS.append({'id': al['ratingKey'], 'q': {k: v[0] for k, v in q.items() if not k.startswith('X-Plex')}})
                return self.send_json({})
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
                a, b = items.get(q.get('startID', [''])[0]), items.get(q.get('endID', [''])[0])
                if not a or not b or a['type'] != 'track' or b['type'] != 'track':
                    return self.send_json({'error': 'Bad request'}, 400)
                return self.page(sonic_path(a, b), {'X-Plex-Container-Size': ['100']})
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
                 '_items': members, 'addedAt': int(time.time()), 'updatedAt': int(time.time()), 'collectionSort': 0,
                 'index': collection_index()}
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
                # Everything unless asked for a page, like Plex, which
                # refuses a page of more than 120 (some servers do).
                if int(q.get('X-Plex-Container-Size', ['0'])[0] or 0) > 120:
                    return self.send_json({'error': 'Bad request'}, 400)
                return self.page(c['_items'], {'X-Plex-Container-Size': ['500'], **q})
            return self.send_json({'size': 1, 'Metadata': [public(c)]})
        if p.startswith('/library/metadata/') and ',' in parts[2] and len(parts) == 3:
            # Several at once, as Plex gives them: those it has.
            many = [items[i] for i in parts[2].split(',') if i in items and (items[i]['type'] != 'track' or can_have(i, token))]
            return self.send_json({'size': len(many), 'Metadata': [item_detail(x) for x in many]})
        if p.startswith('/library/metadata/'):
            it = items.get(parts[2])
            if not it or (it['type'] == 'track' and not can_have(parts[2], token)):
                return self.not_found()
            sub = parts[3] if len(parts) > 3 else ''
            if sub in ('posters', 'poster') or (sub == 'thumb' and self.command == 'DELETE'):
                return self.pictures(it, sub, q, token)
            if sub == 'children':
                # (An artist's albums, as Plex lists them: without what kind
                # each is, which an album's own details have.)
                kids = [{k: v for k, v in a.items() if k not in ('Format', 'Subformat')} for a in albums if a['parentRatingKey'] == it['ratingKey']] \
                    if it['type'] == 'artist' else [t for t in tracks if t['parentRatingKey'] == it['ratingKey']]
                return self.page(kids, {'X-Plex-Container-Size': ['500']})
            if sub == 'allLeaves':
                return self.page([t for t in tracks if t['grandparentRatingKey'] == it['ratingKey']], {'X-Plex-Container-Size': ['500']})
            if sub == 'nearest':
                n = int(q.get('limit', ['20'])[0])
                if it['type'] == 'artist':
                    pool = [a for a in artists if a is not it and a['title'] != 'Various Artists']
                    return self.page(random.Random(it['ratingKey']).sample(pool, min(n, len(pool))), {'X-Plex-Container-Size': ['500']})
                # The tracks that sound most like it, nearest first, each with
                # its distance, as far as maxDistance.
                most = float(q.get('maxDistance', ['0.25'])[0])
                near = sorted(((sonic_distance(it, t), t) for t in tracks if t is not it), key=lambda x: x[0])
                found = [dict(t, distance=round(d, 4)) for d, t in near if d <= most][:n]
                if MOCK['nearest']:
                    found = found[:MOCK['nearest']]
                return self.page(found, {'X-Plex-Container-Size': ['1000']})
            if sub in ('thumb', 'art'):
                return self.send_bytes(cover_png(p, 600), 'image/png')
            return self.send_json({'size': 1, 'Metadata': [item_detail(it)]})
        if p.startswith('/hubs/metadata/') and len(parts) == 3:
            it = items.get(parts[2])
            if MOCK['hubs'] == 'off':
                return self.not_found()
            if not it:
                return self.not_found()
            hubs = artist_hubs(it, int(q.get('count', ['10'])[0])) if it['type'] == 'artist' else []
            return self.send_json({'size': len(hubs), 'Hub': hubs})
        if p == '/hubs/search':
            needle = q.get('query', [''])[0].lower()
            lim = int(q.get('limit', ['10'])[0])
            hubs = []
            mine = [pl for pl in playlists if pl['_owner'] == owner_of(token)]
            for typ, pool in (('artist', artists), ('album', albums), ('track', tracks), ('playlist', mine)):
                found = [public(x) for x in pool if needle in x['title'].lower()][:lim]
                if typ == 'track':
                    # (And by who they're by, as Plex's search finds them,
                    # saying so: their artist, where it isn't the album's.)
                    found += [dict(public(x), reason='originalTitle', reasonTitle=x['originalTitle']) for x in pool
                              if needle not in x['title'].lower() and needle in (x.get('originalTitle') or '').lower()][:lim - len(found)]
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
            members = [items[i] for i in ids if i in items and items[i]['type'] == 'track' and can_have(i, token)]
            pl = make_playlist(q.get('title', ['Untitled'])[0], members, owner=owner_of(token))
            pl['addedAt'] = pl['updatedAt'] = int(time.time())
            playlists.append(pl)
            timeline(pl['ratingKey'], 15, 5, section='-1')
            return self.send_json({'size': 1, 'Metadata': [public(pl)]})
        if p == '/playlists':
            sec = q.get('sectionID', [None])[0]
            mine = [pl for pl in playlists if pl['_owner'] == owner_of(token)]
            return self.page([follow_rule(pl) for pl in mine if not sec or pl['_section'] == sec], {'X-Plex-Container-Size': ['500']})
        if p == '/activities':
            return self.send_json({'size': 0})
        if p.startswith('/playlists/'):
            pl = items.get(parts[1])
            if not pl or pl.get('type') != 'playlist' or pl['_owner'] != owner_of(token):
                return self.not_found()
            if self.command in ('PUT', 'DELETE'):
                return self.edit_playlist(pl, parts, q, token)
            if len(parts) > 2 and parts[2] == 'items':
                return self.playlist_page(pl, q, token)
            if len(parts) > 2 and parts[2] == 'composite':
                return self.send_bytes(cover_png(p, 600), 'image/png')
            detail = public(pl)
            if pl.get('_content'):
                detail['content'] = pl['_content']
            return self.send_json({'size': 1, 'Metadata': [detail]})
        if p == '/photo/:/transcode':
            url_ = q.get('url', ['/x/x/0'])[0]
            pic = uploaded_picture(url_)
            if pic:
                return self.send_bytes(*picture_bytes(pic, q.get('width', ['300'])[0]))
            return self.send_bytes(cover_png(url_.split('?')[0], q.get('width', ['300'])[0]), 'image/png')
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
            st = MOCK['stall']
            if st and st['track'] == parts[2]:
                MOCK['stall'] = None  # (once: asked for again, it all comes)
                return self.send_bytes(tone_wav(parts[2]), 'audio/wav', stall_after=st['bytes'])
            return self.send_bytes(tone_wav(parts[2]), 'audio/wav')
        if p == '/:/timeline':
            t = items.get(q.get('ratingKey', [''])[0])
            state = q.get('state', [''])[0]
            with HLS_LOCK:
                HLS['timelines'].append({'ratingKey': q.get('ratingKey', [''])[0], 'state': state,
                                         'playback': q.get('X-Plex-Session-Identifier', [''])[0]})
                del HLS['timelines'][:-200]
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
