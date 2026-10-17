#!/usr/bin/env python3
"""A fake Ollama server for working on the AI features without a model.

Implements /api/version, /api/tags and /api/chat (streamed or not), and
behaves like Ollama for cross-origin requests: browsers on other sites are
refused unless allowed with --origins. Replies are built from the prompt, so
the app's parsing and library matching run as they would with a real model.

    python3 dev/mock-ollama.py                 # http://127.0.0.1:11434
    python3 dev/mock-ollama.py --origins '*'   # allow any website
    python3 dev/mock-ollama.py --delay 0.05    # slower streaming
    python3 dev/mock-ollama.py --reject-think  # act like an Ollama without "think"

In the app, choose Settings > AI > My own Ollama server and enter
http://127.0.0.1:11434.
"""

import argparse
import json
import random
import re
import sys
import time
from fnmatch import fnmatch
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ap = argparse.ArgumentParser()
ap.add_argument('--port', type=int, default=11434)
ap.add_argument('--origins', default='', help='extra allowed origins, comma separated ("*" for any)')
ap.add_argument('--delay', type=float, default=0.01, help='seconds between streamed chunks')
ap.add_argument('--reject-think', action='store_true')
ap.add_argument('--quiet', action='store_true')
ARGS = ap.parse_args()

MODELS = [
    {'name': 'llama3.1:8b', 'size': 4920753328, 'details': {'family': 'llama', 'parameter_size': '8.0B', 'quantization_level': 'Q4_K_M'}},
    {'name': 'qwen2.5:7b', 'size': 4683087332, 'details': {'family': 'qwen2', 'parameter_size': '7.6B', 'quantization_level': 'Q4_K_M'}},
    {'name': 'nomic-embed-text:latest', 'size': 274302450, 'details': {'family': 'nomic-bert', 'families': ['nomic-bert'], 'parameter_size': '137M'}},
]
# Ollama's defaults, plus anything passed with --origins.
ORIGINS = ['http://localhost', 'https://localhost', 'http://localhost:*', 'https://localhost:*', 'http://127.0.0.1',
           'https://127.0.0.1', 'http://127.0.0.1:*', 'https://127.0.0.1:*', 'http://0.0.0.0', 'http://0.0.0.0:*']
ORIGINS += [o.strip() for o in ARGS.origins.split(',') if o.strip()]


def origin_allowed(origin):
    return not origin or any(o == '*' or fnmatch(origin, o) for o in ORIGINS)


def numbered(text):
    return [(int(m.group(1)), m.group(2)) for m in re.finditer(r'^(\d+)\. (.+)$', text, re.M)]


def tag_line(text, label):
    m = re.search(rf'^{label}: (.*)$', text, re.M)
    return [] if not m or m.group(1) == '(none)' else [t.strip() for t in m.group(1).split(',') if t.strip()]


def reply_for(body):
    """Build the JSON content a model would return, from the request."""
    text = '\n'.join(m.get('content', '') for m in body.get('messages', []))
    fmt = body.get('format')
    props = set((fmt or {}).get('properties', {}).keys()) if isinstance(fmt, dict) else set()
    rnd = random.Random(len(text))
    if 'ok' in props or 'Reply with {"ok": true}' in text:
        return {'ok': True}
    if 'pick' in props or 'Choose the next song' in text:
        options = numbered(text)
        n, line = rnd.choice(options) if options else (1, 'a song')
        song = line.split(' — ', 1)[-1].split(' (')[0]
        return {'pick': n, 'intro': f'Keeping that warm late-night feel going, here is {song}.'}
    if 'genres' in props or 'Tags used in the library' in text:
        asked = re.search(r'^Playlist request: (.*)$', text, re.M)
        best = re.match(r'(?i)\s*best of (.+?)(?: playlist)?\s*$', asked.group(1) if asked else '')
        if best:
            # Like a small model that names the artist, and similar ones, but
            # doesn't say the playlist is only about them: the app has to
            # work that out from the request.
            name = best.group(1)
            return {
                'title': f'Best of {name}',
                'summary': f'The essential {name}.',
                'focus_artists': [],
                'artist_scope': 'any',
                'genres': tag_line(text, 'Genres')[:1],
                'styles': [],
                'moods': [],
                'decades': [],
                'artists': [name, 'Juniper & Ash', 'Kilo Meridian'],
                'tracks': [{'artist': 'Kilo Meridian', 'title': 'Ember'}],
            }
        return {
            'title': 'Late Night Harbour Lights',
            'summary': 'A moody, slow-building mix for driving after dark.',
            'focus_artists': [],
            'artist_scope': 'any',
            'genres': tag_line(text, 'Genres')[:2],
            'styles': tag_line(text, 'Styles')[:2],
            'moods': tag_line(text, 'Moods')[:1],
            'decades': [],
            'artists': ['Glass Harbour', 'Juniper & Ash', 'Not A Real Band'],
            'tracks': [{'artist': 'Glass Harbour', 'title': 'Engine'}, {'artist': 'Imaginary Act', 'title': 'Made Up Song'}],
        }
    # Choosing and ordering tracks.
    options = [n for n, _ in numbered(text)]
    m = re.search(r'Choose (\d+) tracks', text)
    want = int(m.group(1)) if m else 25
    rnd.shuffle(options)
    return {'title': 'Harbour Lights After Dark', 'tracks': options[:want]}


class Handler(BaseHTTPRequestHandler):
    server_version = 'MockOllama/0.1'

    def log_message(self, fmt, *args):
        if not ARGS.quiet:
            sys.stderr.write('%s %s\n' % (self.command, self.path))

    def cors(self):
        origin = self.headers.get('Origin')
        if origin and origin_allowed(origin):
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Vary', 'Origin')

    def refuse_origin(self):
        origin = self.headers.get('Origin')
        if origin_allowed(origin):
            return False
        self.send_response(403)
        self.end_headers()
        return True

    def send_json(self, obj, status=200):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.cors()
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        if self.refuse_origin():
            return
        self.send_response(204)
        self.cors()
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Authorization, Content-Type, User-Agent, Accept, X-Requested-With')
        self.end_headers()

    def do_GET(self):
        if self.refuse_origin():
            return
        if self.path == '/api/version':
            return self.send_json({'version': '0.12.0-mock'})
        if self.path == '/api/tags':
            return self.send_json({'models': [dict(m, model=m['name'], modified_at='2026-10-01T10:00:00Z', digest='0' * 64) for m in MODELS]})
        if self.path == '/':
            return self.send_json({'status': 'Ollama is running'})
        return self.send_json({'error': 'not found'}, 404)

    def do_DELETE(self):
        self.do_POST()

    def do_POST(self):
        if self.refuse_origin():
            return
        length = int(self.headers.get('Content-Length') or 0)
        try:
            body = json.loads(self.rfile.read(length) or b'{}')
        except ValueError:
            return self.send_json({'error': 'invalid JSON'}, 400)
        if self.path in ('/api/pull', '/api/delete', '/api/create', '/api/copy', '/api/push'):
            return self.send_json({'status': 'success'})  # so a proxy test can tell it got through
        if self.path != '/api/chat':
            return self.send_json({'error': 'not found'}, 404)
        model = body.get('model', '')
        if model not in [m['name'] for m in MODELS]:
            return self.send_json({'error': f'model "{model}" not found, try pulling it first'}, 404)
        if ARGS.reject_think and 'think' in body:
            return self.send_json({'error': f'"{model}" does not support thinking'}, 400)

        content = json.dumps(reply_for(body))
        started = time.time()
        if body.get('stream', True) is False:
            return self.send_json({'model': model, 'message': {'role': 'assistant', 'content': content}, 'done': True})
        self.send_response(200)
        self.cors()
        self.send_header('Content-Type', 'application/x-ndjson')
        self.end_headers()
        for i in range(0, len(content), 8):
            chunk = {'model': model, 'created_at': time.strftime('%Y-%m-%dT%H:%M:%SZ'), 'message': {'role': 'assistant', 'content': content[i:i + 8]}, 'done': False}
            self.wfile.write((json.dumps(chunk) + '\n').encode())
            self.wfile.flush()
            time.sleep(ARGS.delay)
        done = {'model': model, 'message': {'role': 'assistant', 'content': ''}, 'done': True, 'done_reason': 'stop',
                'total_duration': int((time.time() - started) * 1e9), 'eval_count': len(content) // 4}
        self.wfile.write((json.dumps(done) + '\n').encode())
        self.wfile.flush()


class Server(ThreadingHTTPServer):
    daemon_threads = True


if __name__ == '__main__':
    print(f'Mock Ollama on http://127.0.0.1:{ARGS.port}', flush=True)
    Server(('0.0.0.0', ARGS.port), Handler).serve_forever()
