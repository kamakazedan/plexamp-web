// Unit tests for the service: node --test server/test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { Together, cleanTrack, TogetherError } from './together.js';
import { redact, oneLine } from './log.js';
import { cleanSyslogLine } from './syslog.js';
import { Cast, CastError, privateAddress, parseTimeline } from './cast.js';
import { isPlexDirectCert, plexServerIdentity, certProblem, PlexAuth, readCapped, PLEX_TV_TIMING } from './plex.js';
import { OwnerSignIns, OWNER_LIMITS } from './owners.js';
import { Offline, OFFLINE_LIMITS, parseFrom, isOfflineToken } from './offline.js';
import { cleanChat, SharedModel, AIRequestError, AI_LIMITS, errorText } from './ai.js';
import { plainPath, clientIp } from './paths.js';
import { MusicBrainz, MusicBrainzError, isPublic, sameTitle, MBKept, MB_ADVANCED_LIMITS } from './musicbrainz.js';
import { albumKey, matchGroup, kindOf, plexKind, firstYear, norm as normOfReleases, apartFromNamesakes } from './releases.js';
import { Shares, ShareError, mergeTracks, withUnseen, missingFrom, SHARE_LIMITS, LEASE_MS } from './shares.js';
import { Spotify, SpotifyError, SPOTIFY_LIMITS, playlistId, shortCode, embedPlaylist, trackOf } from './spotify.js';
import { SettingsStore, SETTINGS_LIMITS, SYNCED_SETTINGS, cleanValue } from './settings.js';
import { MissingStore, MISSING_STORE_LIMITS, cleanOp, cleanEntry } from './missing.js';
import { applyNote, applyMerge, applyRestore, keyOf, idOf, listId, shortList, norm, MISSING_LIMITS } from './missinglist.js';
import { createServer, request as httpRequest } from 'node:http';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync, writeFileSync, rmSync, chownSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dan = { id: 1, title: 'Dan', thumb: null };
const sam = { id: 2, title: 'Sam', thumb: null };
const eve = { id: 3, title: 'Eve', thumb: null };
const server = { id: 'mock-server-1', name: 'Test', section: '1', sectionTitle: 'Music' };
const track = (id, duration = 10000) => ({ id: String(id), title: `T${id}`, artist: 'A', duration, partKey: `/library/parts/${id}/0/file.flac`, thumb: `/library/metadata/${id}/thumb/1` });

function setup(opts = {}) {
  let now = 1_000_000;
  const tg = new Together({ now: () => now });
  const s = tg.create(dan, { server, invite: [sam], queue: [track(10), track(11), track(12)], playing: true, ...opts });
  return { tg, s, tick: (ms) => (now += ms), at: () => now };
}

test('only invited people can join, and only members can control', () => {
  const { tg, s } = setup();
  assert.throws(() => tg.join(s, eve), (e) => e instanceof TogetherError && e.status === 403);
  assert.throws(() => tg.command(s, sam, { type: 'pause' }), (e) => e.status === 403);
  tg.join(s, sam);
  tg.command(s, sam, { type: 'pause' });
  assert.equal(s.playing, false);
  assert.throws(() => tg.view(s, eve.id), (e) => e.status === 403);
});

test('invited people see a summary, not the queue', () => {
  const { tg, s } = setup();
  const v = tg.view(s, sam.id);
  assert.equal(v.role, 'invited');
  assert.equal(v.queue, undefined);
  assert.equal(v.nowPlaying.title, 'T10');
});

test('tracks advance on time, carrying over the extra time', () => {
  const { tg, s, tick } = setup();
  tick(10000 + 2500);
  assert.equal(tg.settle(s), true);
  assert.equal(s.index, 1);
  assert.equal(tg.position(s), 2500);
  tick(30000);
  tg.settle(s);
  assert.equal(s.playing, false);
  assert.equal(s.index, 2);
});

test('pause freezes the position; play resumes from it', () => {
  const { tg, s, tick } = setup();
  tg.join(s, sam);
  tick(4000);
  tg.command(s, sam, { type: 'pause' });
  tick(60000);
  assert.equal(tg.position(s), 4000);
  tg.command(s, dan, { type: 'play' });
  tick(1000);
  assert.equal(tg.position(s), 5000);
});

test('queue edits: add next, play now, remove, move, clear', () => {
  const { tg, s } = setup();
  tg.command(s, dan, { type: 'add', where: 'next', tracks: [track(20)] });
  assert.deepEqual(s.queue.map((q) => q.id), ['10', '20', '11', '12']);
  tg.command(s, dan, { type: 'playNow', tracks: [track(30), track(31)], start: 1 });
  assert.equal(s.queue[s.index].id, '31');
  const sid = s.queue.find((q) => q.id === '12').sid;
  tg.command(s, dan, { type: 'remove', sid });
  assert.ok(!s.queue.some((q) => q.id === '12'));
  assert.throws(() => tg.command(s, dan, { type: 'remove', sid: s.queue[s.index].sid }), (e) => e.status === 400);
  tg.command(s, dan, { type: 'clear' });
  assert.equal(s.queue.length, s.index + 1);
});

test('skipping: next, prev near the start and later in a track', () => {
  const { tg, s, tick } = setup();
  tg.command(s, dan, { type: 'next' });
  assert.equal(s.index, 1);
  tick(1000);
  tg.command(s, dan, { type: 'prev' });
  assert.equal(s.index, 0);
  tick(5000);
  tg.command(s, dan, { type: 'prev' });
  assert.equal(s.index, 0);
  assert.equal(tg.position(s), 0);
});

test('"ended" only advances when the clock agrees', () => {
  const { tg, s, tick } = setup();
  tick(2000);
  tg.command(s, dan, { type: 'ended', sid: s.queue[0].sid });
  assert.equal(s.index, 0, 'ignored: 8 s still to go');
  tick(6000);
  tg.command(s, dan, { type: 'ended', sid: s.queue[0].sid });
  assert.equal(s.index, 1);
});

test('track data from members is cleaned', () => {
  assert.equal(cleanTrack({ id: '1 OR 1=1' }), null);
  const t = cleanTrack({
    id: '5',
    title: 'x'.repeat(1000),
    thumb: 'https://evil.example/pixel.gif',
    partKey: '/library/parts/5/../../:/scrobble',
    codec: 'flac<script>',
  });
  assert.equal(t.thumb, null);
  assert.equal(t.partKey, null);
  assert.equal(cleanTrack({ id: '5', partKey: '/library/parts/%2e%2e/%2e%2e/library/sections/1/refresh' }).partKey, null);
  assert.equal(cleanTrack({ id: '5', thumb: '/library/metadata/5/thumb/1?url=http://evil' }).thumb, null);
  assert.equal(cleanTrack({ id: '5', partKey: '/library/parts/5/file.mp3' }).partKey, '/library/parts/5/file.mp3');
  assert.equal(t.codec, '');
  assert.equal(t.title.length, 300);
  const ok = cleanTrack(track(7));
  assert.equal(ok.partKey, '/library/parts/7/0/file.flac');
  assert.equal(ok.thumb, '/library/metadata/7/thumb/1');
});

test('only the host invites and removes; the host leaving hands over', () => {
  const { tg, s } = setup();
  tg.join(s, sam);
  assert.throws(() => tg.invite(s, sam, [eve]), (e) => e.status === 403);
  assert.throws(() => tg.remove(s, sam, dan.id), (e) => e.status === 403);
  tg.leave(s, dan);
  assert.ok(!s.ended);
  assert.equal(s.host.id, sam.id);
  tg.command(s, sam, { type: 'pause' });
  tg.invite(s, sam, [eve]);
  assert.equal(tg.roleOf(s, eve.id), 'invited');
  tg.remove(s, sam, eve.id);
  assert.equal(tg.roleOf(s, eve.id), null);
  tg.leave(s, sam);
  assert.ok(s.ended, 'the last one out ends it');
  assert.throws(() => tg.command(s, sam, { type: 'play' }), (e) => e.status === 410);
});

test('one session per person: starting or joining another leaves the first', () => {
  const { tg, s } = setup();
  const s2 = tg.create(dan, { server, queue: [track(1)] });
  assert.ok(s.ended, 'Dan was alone, so his old session ended');
  assert.ok(!s2.ended);
  const s3 = tg.create(eve, { server, invite: [dan], queue: [track(2)] });
  tg.join(s3, dan);
  assert.ok(s2.ended);
  assert.equal(tg.roleOf(s3, dan.id), 'member');
  assert.deepEqual(tg.forUser(dan.id).map((x) => x.id), [s3.id], 'ended sessions are not listed');
});

test('declining an invitation removes it', () => {
  const { tg, s } = setup();
  tg.leave(s, sam);
  assert.equal(tg.roleOf(s, sam.id), null);
  assert.ok(s.events.some((e) => e.text.includes('no thanks')));
});

test('long-poll waits for a change', async () => {
  const { tg, s } = setup();
  const p = tg.wait(s, s.version, 5000);
  tg.command(s, dan, { type: 'pause' });
  assert.equal(await p, true);
  assert.equal(await tg.wait(s, s.version, 10), false);
});

test('nginx errors relayed in debug mode lose their tokens', () => {
  const raw = '<11>Oct 15 18:00:00 nginx: 2026/10/15 18:00:00 [error] 31#31: *7 connect() failed (111: Connection refused) while connecting to upstream, client: 10.0.0.2, server: _, request: "GET /pms/library/sections?X-Plex-Token=abcDEF123456ghiJKL78 HTTP/1.1", upstream: "http://10.0.0.5:32400/library/sections?X-Plex-Token=abcDEF123456ghiJKL78"';
  const line = oneLine(cleanSyslogLine(raw));
  assert.ok(line.startsWith('[error] 31#31: *7 connect() failed'), line);
  assert.ok(!line.includes('abcDEF123456ghiJKL78'));
  assert.ok(line.includes('X-Plex-Token=[redacted]'));
});

test('redaction removes tokens and keys', () => {
  const line = redact('GET /pms/library?X-Plex-Token=abcDEF123456ghiJKL78&x=1 Bearer sk-12345 {"authToken":"zzz"}');
  assert.ok(!line.includes('abcDEF123456ghiJKL78'));
  assert.ok(!line.includes('sk-12345'));
  assert.ok(!line.includes('zzz'));
  assert.ok(!redact('a token abcDEF123456ghiJKL78 alone').includes('abcDEF123456ghiJKL78'));
  assert.equal(oneLine('line one\nfake: second line'), 'line one fake: second line');
  // Inside another address (URL-encoded), as a header, and other names for them.
  const inner = redact('/photo/:/transcode?url=%2Flibrary%2Fx%3FX-Plex-Token%3Dsecret1%26w%3D3&width=10');
  assert.ok(!inner.includes('secret1') && inner.includes('%26w%3D3&width=10'), inner);
  assert.ok(!redact('X-Plex-Token: secret2').includes('secret2'));
  assert.ok(!redact('{"accessToken":"secret3"}').includes('secret3'));
  assert.ok(!redact('token=secret4 first').includes('secret4'));
  // A Plex Home PIN, as switching sends it to plex.tv, or in JSON.
  assert.ok(!redact('POST https://clients.plex.tv/api/v2/home/users/abc/switch?X-Plex-Token=t&pin=0427').includes('0427'));
  assert.ok(!redact('{"pin":"0913"}').includes('0913'));
});

test('redaction takes the same time whatever the text (nothing can make it crawl)', () => {
  const started = Date.now();
  for (const text of ['a-'.repeat(200000), 'a1'.repeat(200000), `${'a'.repeat(19)}-`.repeat(20000), 'X-Plex-Token='.repeat(30000)]) {
    oneLine(text, 2000);
    redact(text.slice(0, 100000));
  }
  assert.ok(Date.now() - started < 2000, `${Date.now() - started} ms`);
  // Only the start of a long text is kept, with a secret near the cut still found.
  const cut = oneLine(`${'x'.repeat(490)} X-Plex-Token=abcdefghij1234567890 ${'y'.repeat(5000)}`, 500);
  assert.ok(cut.length <= 501 && !cut.includes('abcdefghij'), cut);
});

test('only plain request paths are answered', () => {
  for (const p of ['/api/health', '/api/together/sessions/abc_D-1/join', '/api/shares/0123abcd', '/api/ai/chat']) assert.ok(plainPath(p), p);
  for (const p of ['/api\\internal/pms-auth', '/api/x/..\\internal', '/api//internal/pms-auth', '/api/./ai/chat', '/api/x/../ai/chat', '/api/%2e%2e/ai/chat', '/api%2Fai/chat', '/api%5Cai/chat', '/api/ai/chat/..', 'api/health', '', '/api/a b'])
    assert.ok(!plainPath(p), p);
});

test('limits go by address, and by network for IPv6', () => {
  const ip = (a) => clientIp({ headers: { 'x-real-ip': a } });
  assert.equal(ip('192.168.1.5'), '192.168.1.5');
  assert.equal(ip('::ffff:192.168.1.5'), '192.168.1.5');
  assert.equal(ip('2001:db8:1:2:aaaa::1'), '2001:db8:1:2::/64');
  assert.equal(ip('2001:0db8:0001:0002:ffff:ffff:ffff:ffff'), '2001:db8:1:2::/64');
  assert.equal(ip('2001:db8::1'), '2001:db8:0:0::/64');
  assert.equal(ip('::1'), '0:0:0:0::/64');
  assert.equal(clientIp({ headers: {} }), 'local');
});

test('sign-ins: checked once however many requests ask at once, and remembered', async () => {
  let asked = 0;
  const tv = createServer((req, res) => {
    asked += 1;
    const token = req.headers['x-plex-token'];
    setTimeout(() => {
      if (token === 'good-token') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 7, uuid: 'u7', username: 'dan', friendlyName: 'Dan' }));
      } else {
        res.writeHead(401);
        res.end();
      }
    }, 50);
  });
  await new Promise((r) => tv.listen(0, '127.0.0.1', r));
  try {
    const auth = new PlexAuth({ plexTvUrl: `http://127.0.0.1:${tv.address().port}` });
    assert.equal(auth.knows('good-token'), false);
    const users = await Promise.all([auth.identify('good-token'), auth.identify('good-token'), auth.identify('good-token')]);
    assert.equal(asked, 1);
    assert.ok(users.every((u) => u.id === 7 && u.title === 'Dan'));
    assert.equal(auth.knows('good-token'), true);
    await assert.rejects(auth.identify('made-up-token'), (e) => e.status === 401);
    await assert.rejects(auth.identify('made-up-token'), (e) => e.status === 401);
    assert.equal(asked, 2);
    assert.equal(auth.knows('made-up-token'), true);
  } finally {
    tv.close();
  }
});

test('plex.tv: never followed elsewhere, and answers read up to a limit', async () => {
  const tv = createServer((req, res) => {
    if (req.url.startsWith('/api/v2/user')) {
      res.writeHead(302, { Location: 'http://127.0.0.1:9/steal' });
      return res.end();
    }
    res.writeHead(200);
    return res.end('x'.repeat(5000));
  });
  await new Promise((r) => tv.listen(0, '127.0.0.1', r));
  try {
    const base = `http://127.0.0.1:${tv.address().port}`;
    const auth = new PlexAuth({ plexTvUrl: base });
    await assert.rejects(auth.identify('good-token'), (e) => e.network === true);
    await assert.rejects(readCapped(await fetch(`${base}/big`), 1000), (e) => e.code === 'TOO_LONG');
    assert.equal((await readCapped(await fetch(`${base}/big`), 10000)).length, 5000);
  } finally {
    tv.close();
  }
});

// ---------- casting ----------

const devices = [
  { name: 'Living Room', product: 'Plexamp', provides: 'client,player,pubsub-player', clientIdentifier: 'p1', owned: true, presence: true,
    connections: [{ protocol: 'http', address: '192.168.1.50', port: 32500, local: true }] },
  { name: 'Router', provides: 'player', clientIdentifier: 'p2', owned: true, connections: [{ protocol: 'http', address: '192.168.1.1', port: 80 }] },
  { name: 'Far away', provides: 'player', clientIdentifier: 'p3', owned: true, connections: [{ protocol: 'http', address: '203.0.113.9', port: 32500 }] },
  { name: 'Not mine', provides: 'player', clientIdentifier: 'p4', owned: false, connections: [{ protocol: 'http', address: '192.168.1.60', port: 32500 }] },
  { name: 'Phone', provides: 'player', clientIdentifier: 'p5', owned: true, connections: [{ protocol: 'https', address: '192.168.1.70', port: 32500 }] },
  { name: 'Server', provides: 'server', clientIdentifier: 'srv-machine-1', owned: true,
    connections: [{ protocol: 'https', address: '203.0.113.5', port: 32400, local: false }, { protocol: 'http', address: '192.168.1.10', port: 32400, local: true }] },
];

function castSetup() {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url: new URL(url), headers: opts.headers });
    const body = new URL(url).pathname.endsWith('/timeline/poll')
      ? '<MediaContainer commandID="3"><Timeline type="video" state="stopped"/><Timeline type="music" state="playing" time="42442" duration="235225" ratingKey="120" playQueueID="7" playQueueItemID="701" volume="80" shuffle="0" repeat="2"/></MediaContainer>'
      : '<Response code="200" status="OK"/>';
    return { ok: true, status: 200, text: async () => body };
  };
  const cast = new Cast({ auth: { resources: async () => devices }, fetchImpl });
  return { cast, calls };
}

test('a Plex server\'s own certificate is accepted at its network address, and only there', () => {
  const plex = { subject: { CN: '*.0123456789abcdef0123456789abcdef.plex.direct' }, subjectaltname: 'DNS:*.0123456789abcdef0123456789abcdef.plex.direct' };
  assert.ok(isPlexDirectCert(plex));
  assert.equal(plexServerIdentity('10.10.10.100', plex), undefined);
  assert.equal(plexServerIdentity('fd00::12', plex), undefined);
  // At a name, the name has to match, as usual.
  assert.ok(plexServerIdentity('plex.example.com', plex) instanceof Error);
  assert.equal(plexServerIdentity('10-10-10-100.0123456789abcdef0123456789abcdef.plex.direct', plex), undefined);
  // Other certificates are checked as usual, at addresses too.
  assert.ok(plexServerIdentity('10.10.10.100', { subject: { CN: 'nas.local' }, subjectaltname: 'DNS:nas.local' }) instanceof Error);
  for (const name of ['DNS:*.plex.direct.example.com', 'DNS:plex.direct', 'DNS:*.a.b.plex.direct', 'DNS:x.plex.direct', 'DNS:*.plex.directory'])
    assert.ok(!isPlexDirectCert({ subject: {}, subjectaltname: name }), name);
  assert.equal(certProblem('DEPTH_ZERO_SELF_SIGNED_CERT'), 'its certificate is self-signed');
  assert.equal(certProblem('ECONNREFUSED'), null);
});

test('only private addresses count as being on the home network', () => {
  for (const a of ['10.0.0.2', '172.16.5.1', '172.31.255.1', '192.168.1.5', '100.64.0.1', 'fd12:3456::1', 'fc00::5']) assert.ok(privateAddress(a), a);
  for (const a of ['8.8.8.8', '172.32.0.1', '127.0.0.1', '::1', '2001:db8::1', 'example.com', '192.168.1.5.nip.io', '', '169.254.169.254', 'fe80::1', '::ffff:192.168.1.5', '0.0.0.0'])
    assert.ok(!privateAddress(a), a);
  assert.ok(privateAddress('127.0.0.1', { loopback: true }));
});

test('players are the account\'s own, at a private address and a Plex player port', async () => {
  const { cast } = castSetup();
  const players = await cast.players('tok');
  assert.deepEqual(players.map((p) => p.id), ['p1']);
  assert.equal(players[0].url, 'http://192.168.1.50:32500');
  await assert.rejects(cast.timeline({ id: 1 }, 'tok', 'p2'), (e) => e instanceof CastError && e.status === 404);
  await assert.rejects(cast.timeline({ id: 1 }, 'tok', '../p1'), (e) => e.status === 404);
});

test('commands are built by the service, with the target and a command id', async () => {
  const { cast, calls } = castSetup();
  const me = { id: 1 };
  await cast.command(me, 'tok', 'p1', { command: 'pause' });
  await cast.command(me, 'tok', 'p1', { command: 'seekTo', offset: 61000 });
  await cast.command(me, 'tok', 'p1', { command: 'setParameters', volume: 55 });
  assert.equal(calls[0].url.pathname, '/player/playback/pause');
  assert.equal(calls[0].headers['X-Plex-Target-Client-Identifier'], 'p1');
  assert.equal(calls[1].url.searchParams.get('offset'), '61000');
  assert.equal(calls[2].url.searchParams.get('volume'), '55');
  assert.deepEqual(calls.map((c) => c.url.searchParams.get('commandID')), ['1', '2', '3']);
  for (const bad of [{ command: 'navigation/home' }, { command: 'seekTo', offset: -5 }, { command: 'setParameters', volume: 500 }, { command: 'skipTo', key: '/system/x' }]) {
    await assert.rejects(cast.command(me, 'tok', 'p1', bad), (e) => e.status === 400, JSON.stringify(bad));
  }
  assert.equal(calls.length, 3);
});

test('playing a queue sends the server\'s local address and the temporary token', async () => {
  const { cast, calls } = castSetup();
  await cast.play({ id: 1 }, 'tok', 'p1', { key: '/library/metadata/120', offset: 5000, playQueueID: 7, serverId: 'srv-machine-1', token: 'transient-abc123' });
  const q = calls[0].url.searchParams;
  assert.equal(calls[0].url.pathname, '/player/playback/playMedia');
  assert.equal(q.get('address'), '192.168.1.10');
  assert.equal(q.get('protocol'), 'http');
  assert.equal(q.get('containerKey'), '/playQueues/7?own=1&window=200');
  assert.equal(q.get('token'), 'transient-abc123');
  await assert.rejects(cast.play({ id: 1 }, 'tok', 'p1', { key: '/library/metadata/120', playQueueID: 7, serverId: 'srv-machine-1', token: 'x y' }), (e) => e.status === 400);
  await assert.rejects(cast.play({ id: 1 }, 'tok', 'p1', { key: '/library/metadata/120', playQueueID: 7, serverId: 'someone-elses', token: 'transient-abc123' }), (e) => e.status === 403);
});

test('timelines are read for the music, and nothing else', async () => {
  const { cast } = castSetup();
  const t = await cast.timeline({ id: 1 }, 'tok', 'p1');
  assert.deepEqual(t, { state: 'playing', time: 42442, duration: 235225, ratingKey: '120', playQueueID: '7', playQueueItemID: '701', playQueueVersion: null, volume: 80, shuffle: false, repeat: 2 });
  assert.deepEqual(parseTimeline('<html>login</html>'), { state: 'stopped' });
  assert.equal(parseTimeline('{"MediaContainer":{"Timeline":[{"type":"music","state":"paused","time":"5"}]}}').state, 'paused');
  assert.equal(parseTimeline('<Timeline type="music" state="evil" ratingKey="1;rm"/>').ratingKey, null);
});

// ---------- your devices ----------

import { Devices, DevicesError, LIMITS as DEVICE_LIMITS, cleanCommand, cleanQueueTrack } from './devices.js';

const mac = { id: 'mac-0000-aaaa', name: 'Firefox on macOS' };
const phone = { id: 'phone-000-bbbb', name: 'Chrome on Android' };
const qTrack = (id, qid) => ({ id: String(id), title: `T${id}`, duration: 200000, partKey: `/library/parts/${id}/1/file.flac`, thumb: `/library/metadata/${id}/thumb/1`, qid });

test('your devices: one plays, and only it reports', () => {
  let now = 1000;
  const d = new Devices({ now: () => now });
  const h = d.home(1001, 'mock-server-1');
  assert.equal(d.home(1001, 'mock-server-1'), h);
  assert.notEqual(d.home(1002, 'mock-server-1'), h); // another account
  assert.notEqual(d.home(1001, 'another-server'), h); // another server
  d.seen(h, phone);
  assert.throws(() => d.report(h, phone, { qid: '1' }), (e) => e instanceof DevicesError && e.status === 409);
  d.activate(h, mac);
  d.report(h, mac, { queue: [qTrack(10, 1), qTrack(11, 2), { ...qTrack(12, 3), partKey: 'https://evil.example/x' }, { id: 'x' }], qid: '2', playing: true, position: 5000 });
  const v = d.view(h, phone.id);
  assert.equal(v.active.id, mac.id);
  assert.deepEqual(v.queue.map((t) => t.qid), ['1', '2', '3']);
  assert.equal(v.queue[2].partKey, null); // not Plex's shape: dropped
  assert.equal(v.state.qid, '2');
  now += 3000;
  assert.equal(d.view(h, phone.id).state.position, 8000); // moved on while playing
  assert.equal(d.view(h, phone.id, { queueVersion: v.queueVersion }).queue, undefined); // unchanged: not sent again
  assert.ok(d.view(h, phone.id).devices.some((x) => x.id === phone.id && !x.active));
});

test('your devices: commands reach the device that plays, once', () => {
  const d = new Devices();
  const h = d.home(1001, 'mock-server-1');
  assert.throws(() => d.command(h, phone, { type: 'pause' }), (e) => e.status === 409); // nothing plays
  d.activate(h, mac);
  d.report(h, mac, { queue: [qTrack(10, 1)], qid: '1', playing: true });
  assert.throws(() => d.command(h, phone, { type: 'format-disk' }), (e) => e.status === 400);
  const id = d.command(h, phone, { type: 'seek', position: 61000 });
  d.command(h, phone, { type: 'play-tracks', tracks: [qTrack(20), { id: '21', partKey: '/library/parts/../../x/file.mp3' }], start: 9 });
  assert.equal(d.view(h, phone.id).commands.length, 0); // only for the one playing
  const cmds = d.view(h, mac.id).commands;
  assert.deepEqual(cmds.map((c) => c.type), ['seek', 'play-tracks']);
  assert.equal(cmds[1].start, 1); // within the list
  assert.equal(cmds[1].tracks[1].partKey, null);
  assert.equal(d.view(h, mac.id, { after: id }).commands.length, 1);
  d.report(h, mac, { qid: '1', playing: true, ack: cmds[1].id });
  assert.equal(d.view(h, mac.id).commands.length, 0); // done
  d.command(h, mac, { type: 'pause' });
  d.activate(h, phone); // the phone takes over: what waited for the Mac is dropped
  assert.equal(d.view(h, phone.id).commands.length, 0);
  assert.equal(d.view(h, mac.id).active.id, phone.id);
});

test('your devices: one that goes quiet stops being the one that plays', async () => {
  let now = 0;
  const d = new Devices({ now: () => now });
  const h = d.home(1001, 'mock-server-1');
  d.activate(h, mac);
  d.report(h, mac, { queue: [qTrack(10, 1)], qid: '1', playing: true, position: 1000 });
  d.seen(h, phone);
  now = 30000;
  d.seen(h, phone);
  now = DEVICE_LIMITS.goneMs + 1000;
  assert.deepEqual(d.sweep(), [mac.name]); // (named in the log)
  assert.deepEqual(d.sweep(), []);
  const v = d.view(h, phone.id);
  assert.equal(v.active, null);
  assert.equal(v.state.playing, false); // kept, paused where it got to
  assert.ok(v.state.position > 1000);
  assert.deepEqual(v.devices.map((x) => x.id), [phone.id]);
  // Releasing: the same, straight away.
  d.activate(h, phone);
  d.report(h, phone, { queue: [qTrack(10, 1)], qid: '1', playing: true });
  assert.equal(d.release(h, mac.id), false); // only the one playing can
  assert.equal(d.release(h, phone.id), true);
  // Waiting for a change: answered when something changes.
  const waiting = d.wait(h, h.version, 1000);
  d.seen(h, mac);
  assert.equal(await waiting, true);
});

test('your devices: what one device can send another is checked', () => {
  assert.equal(cleanCommand({ type: 'jump', qid: '../x' }), null);
  assert.deepEqual(cleanCommand({ type: 'volume', volume: 7 }), { type: 'volume', volume: 1 });
  assert.equal(cleanCommand({ type: 'repeat', mode: 'forever' }), null);
  assert.equal(cleanCommand({ type: 'play-tracks', tracks: [] }), null);
  const ctx = cleanCommand({ type: 'play-tracks', tracks: [qTrack(1)], context: { title: 'Mix', href: '//evil.example' } }).context;
  assert.deepEqual(ctx, { title: 'Mix', href: null });
  assert.equal(cleanQueueTrack({ ...qTrack(5), qid: undefined }), null); // a queue entry needs its place
  assert.throws(() => new Devices().home(1, 'bad server id'), (e) => e.status === 400);
  const d = new Devices();
  const h = d.home(1, 'srv');
  assert.throws(() => d.seen(h, { id: 'x' }), (e) => e.status === 400);
  for (let i = 0; i < DEVICE_LIMITS.devices + 5; i++) d.seen(h, { id: `device-${String(i).padStart(4, '0')}`, name: `D${i}` });
  assert.equal(h.devices.size, DEVICE_LIMITS.devices);
  // Commands the playing device hasn't carried out stay few, and small.
  d.activate(h, { id: 'device-0000', name: 'D0' });
  const many = Array.from({ length: DEVICE_LIMITS.tracksAtOnce }, (_, i) => qTrack(i + 1));
  for (let i = 0; i < 10; i++) d.command(h, { id: 'device-0001', name: 'D1' }, { type: 'add', tracks: many });
  for (let i = 0; i < DEVICE_LIMITS.commands + 10; i++) d.command(h, { id: 'device-0001', name: 'D1' }, { type: 'next' });
  assert.equal(h.commands.length, DEVICE_LIMITS.commands);
  assert.ok(h.commands.reduce((n, c) => n + (c.tracks?.length || 0), 0) <= DEVICE_LIMITS.commandTracks);
  for (let i = 0; i < 5; i++) d.command(h, { id: 'device-0001', name: 'D1' }, { type: 'add', tracks: many });
  assert.ok(h.commands.reduce((n, c) => n + (c.tracks?.length || 0), 0) <= DEVICE_LIMITS.commandTracks);
});

test('the shared AI model: only the one model, and only what the app sends', () => {
  const body = {
    model: 'llama3.1:70b',
    messages: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'Hello', images: ['x'] }],
    stream: true,
    format: { type: 'object' },
    options: { temperature: 9, num_ctx: 999999, num_predict: 20.4, num_gpu: 99, stop: ['x'] },
    keep_alive: '24h',
    think: false,
    tools: [{ type: 'function' }],
    template: '{{ .Prompt }}',
  };
  const out = cleanChat(body, 'gemma4:12b');
  // The context and how long the model stays loaded are the service's to
  // set (they decide how much memory it takes), not the request's.
  assert.deepEqual(out, {
    model: 'gemma4:12b',
    messages: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'Hello' }],
    stream: true,
    format: { type: 'object' },
    options: { temperature: 2, num_predict: 20, num_ctx: 8192 },
    think: false,
    keep_alive: '15m',
  });
  assert.equal(cleanChat({ messages: [{ role: 'user', content: 'x' }], keep_alive: '-1' }, 'm').keep_alive, '15m');
  assert.equal(cleanChat({ messages: [{ role: 'user', content: 'x'.repeat(60000) }], options: { num_ctx: 512 } }, 'm').options.num_ctx, 32768);
  assert.equal(cleanChat({ messages: [{ role: 'user', content: 'x' }], format: 'json' }, 'm').format, 'json');
  // Answer formats are kept small and shallow.
  let deep = { type: 'string' };
  for (let i = 0; i < 12; i++) deep = { type: 'object', properties: { a: deep } };
  assert.throws(() => cleanChat({ messages: [{ role: 'user', content: 'x' }], format: deep }, 'm'), (e) => e.status === 400);
  assert.throws(() => cleanChat({ messages: [{ role: 'user', content: 'x' }], format: { type: 'object', description: 'x'.repeat(9000) } }, 'm'), (e) => e.status === 400);
  assert.throws(() => cleanChat({ messages: [] }, 'm'), (e) => e instanceof AIRequestError && e.status === 400);
  assert.throws(() => cleanChat({ messages: [{ role: 'tool', content: 'x' }] }, 'm'), (e) => e.status === 400);
  assert.throws(() => cleanChat({ messages: [{ role: 'user', content: 'x'.repeat(AI_LIMITS.chars + 1) }] }, 'm'), (e) => e.status === 413);
  assert.throws(() => cleanChat({ messages: Array.from({ length: AI_LIMITS.messages + 1 }, () => ({ role: 'user', content: 'x' })) }, 'm'), (e) => e.status === 400);
});

test('the shared AI model: its name, whether it is ready and loaded, nothing else', async () => {
  const seen = [];
  const ollama = createServer((req, res) => {
    seen.push(`${req.method} ${req.url} ${req.headers.authorization || ''}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.url === '/api/ps') return res.end(JSON.stringify({ models: [{ name: 'llama3.1:8b' }] }));
    return res.end(JSON.stringify({ models: [{ name: 'qwen2.5:7b', size: 1 }, { name: 'nomic-embed-text:latest', details: { families: ['nomic-bert'] } }, { name: 'llama3.1:8b' }] }));
  });
  await new Promise((r) => ollama.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${ollama.address().port}`;
  try {
    const chosen = new SharedModel({ url, key: 'sk-1', model: 'llama3.1:8b' });
    assert.deepEqual(await chosen.status(), { model: 'llama3.1:8b', ready: true, problem: null, loaded: true, loading: false });
    assert.equal(await chosen.model(), 'llama3.1:8b');
    const missing = new SharedModel({ url, model: 'mistral' });
    assert.deepEqual(await missing.status(), { model: 'mistral', ready: false, problem: 'not-installed', loaded: false, loading: false });
    // Not in memory: ready, but not loaded.
    const asleep = new SharedModel({ url, model: 'qwen2.5:7b' });
    assert.equal((await asleep.status()).loaded, false);
    // Not set: the first chat model installed (not an embedding model).
    const first = new SharedModel({ url, log: { info() {} } });
    assert.equal(await first.model(), 'llama3.1:8b');
    assert.ok(seen.every((l) => l.startsWith('GET /api/tags') || l.startsWith('GET /api/ps')), seen.join('; '));
    assert.ok(seen[0].endsWith('Bearer sk-1'));
  } finally {
    ollama.close();
  }
  const down = new SharedModel({ url: 'http://127.0.0.1:9', model: 'x' });
  assert.deepEqual(await down.status(), { model: 'x', ready: false, problem: 'unreachable' });
});

test('the shared AI model loads in a request of its own, once for everyone waiting', async () => {
  const loads = [];
  const ollama = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.url !== '/api/generate') {
        res.writeHead(404);
        return res.end();
      }
      const ask = JSON.parse(body);
      loads.push(ask);
      if (ask.model === 'nope') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: "model 'nope' not found" }));
      }
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ model: ask.model, done: true, done_reason: 'load' }));
      }, 200);
      return undefined;
    });
  });
  await new Promise((r) => ollama.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${ollama.address().port}`;
  try {
    const m = new SharedModel({ url, model: 'llama3.1:8b', log: { info() {} } });
    await Promise.all([m.load('llama3.1:8b', { numCtx: 8192, keepAlive: '900s' }), m.load('llama3.1:8b', { numCtx: 8192 })]);
    assert.equal(loads.length, 1);
    // As the chat will ask for it, so Ollama doesn't load it again for that.
    assert.deepEqual(loads[0], { model: 'llama3.1:8b', keep_alive: '900s', options: { num_ctx: 8192 } });
    await m.load('llama3.1:8b', { numCtx: 16384 });
    assert.equal(loads.length, 2);
    // Said in the service's own words (what Ollama said is for the log).
    await assert.rejects(m.load('nope'), (e) => e instanceof AIRequestError && e.status === 404 && e.message === 'The model "nope" isn’t installed on the AI server.' && /not found/.test(e.detail));
  } finally {
    ollama.close();
  }
});

test('the shared AI model: what Ollama turned down once is left out from then on', () => {
  const m = new SharedModel({ url: 'http://127.0.0.1:1', model: 'm' });
  const chat = { model: 'm', messages: [], think: false, format: { type: 'object' } };
  assert.deepEqual(m.adapt(chat), chat);
  assert.equal(m.retryWithout(chat, 'something else entirely'), false);
  // Another chat sent with "think" before the first was turned down goes again too.
  const before = m.adapt(chat);
  assert.equal(m.retryWithout(chat, '"m" does not support thinking'), true);
  assert.equal(m.retryWithout(before, '"m" does not support thinking'), true);
  assert.equal('think' in m.adapt(chat), false);
  assert.equal(m.retryWithout(m.adapt(chat), 'invalid format: json: cannot unmarshal object'), true);
  assert.equal(m.adapt(chat).format, 'json');
  // What was left out isn't what it objects to now.
  assert.equal(m.retryWithout(m.adapt(chat), 'does not support thinking'), false);
  // And after an hour it's asked for again (Ollama may have been updated).
  m.noThinkAt -= 3600001;
  m.plainJsonAt -= 3600001;
  assert.deepEqual(m.adapt(chat), chat);
  assert.equal(errorText('{"error":"model requires more system memory (12.3 GiB) than is available"}'), 'model requires more system memory (12.3 GiB) than is available');
});

test('MusicBrainz: real songs and artists, albums taken for songs, and made-up ones', async () => {
  const asked = [];
  const known = {
    artists: ['The Prodigy', 'Groove Armada'],
    recordings: [['The Prodigy', 'Out of Space'], ['Groove Armada', 'At the River']],
    albums: [['The Prodigy', 'The Fat of the Land']],
  };
  const answer = (path, query) => {
    const field = (name) => (new RegExp(`${name}:"([^"]*)"`).exec(query) || [])[1] || '';
    const same = (a, b) => a.toLowerCase() === b.toLowerCase();
    if (path === '/ws/2/artist') return { artists: known.artists.filter((n) => same(n, field('artist')) || same(n, `The ${field('artist')}`)).map((name) => ({ name, score: 100 })) };
    if (path === '/ws/2/recording') {
      return { recordings: known.recordings.filter(([a, t]) => same(a, field('artist')) && same(t, field('recording'))).map(([a, t]) => ({ title: `${t} (Remastered)`, score: 100, 'artist-credit': [{ name: a }] })) };
    }
    return { 'release-groups': known.albums.filter(([a, t]) => same(a, field('artist')) && same(t, field('releasegroup'))).map(([a, t]) => ({ title: t, score: 100, 'artist-credit': [{ name: a }] })) };
  };
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    asked.push({ path: u.pathname, query: u.searchParams.get('query'), fmt: u.searchParams.get('fmt'), agent: init.headers['User-Agent'], at: Date.now() });
    return { ok: true, status: 200, json: async () => answer(u.pathname, u.searchParams.get('query')) };
  };
  const mb = new MusicBrainz({ base: 'https://mb.test', fetchImpl, gapMs: 60 });
  const results = await mb.check([
    { kind: 'track', artist: 'The Prodigy', title: 'Out of Space' },
    { kind: 'track', artist: 'The Prodigy', title: 'The Fat of the Land' },
    { kind: 'track', artist: 'The Prodigy', title: 'A Song They Never Made' },
    { kind: 'artist', artist: 'Prodigy' },
    { kind: 'artist', artist: 'Not A Real Band' },
  ]);
  assert.deepEqual(results, ['real', 'album', 'unknown', 'real', 'unknown']);
  assert.ok(asked.every((a) => a.fmt === 'json' && /^plexamp-web \( https:\/\/github\.com\//.test(a.agent)), JSON.stringify(asked[0]));
  // One request at a time, spaced out (MusicBrainz asks for one a second).
  assert.ok(asked.slice(1).every((a, i) => a.at - asked[i].at >= 55), asked.map((a) => a.at - asked[0].at).join(','));
  // Answers are kept: asking again sends nothing.
  const before = asked.length;
  assert.deepEqual(await mb.check([{ kind: 'track', artist: 'the prodigy', title: 'Out Of Space' }, { kind: 'artist', artist: 'Not A Real Band' }]), ['real', 'unknown']);
  assert.equal(asked.length, before);
  // Quotes in a name can't end the search phrase.
  await mb.check([{ kind: 'track', artist: 'Groove Armada', title: 'At "the" River' }]);
  assert.ok(asked.filter((a) => a.query.includes('River')).every((a) => (a.query.match(/"/g) || []).length === 4), asked.map((a) => a.query).join(' | '));
  // MusicBrainz busy, or unreachable: said so, not taken for "made up".
  const busy = new MusicBrainz({ fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }), gapMs: 0 });
  await assert.rejects(busy.check([{ kind: 'artist', artist: 'X' }]), (e) => e instanceof MusicBrainzError && e.status === 503);
  const down = new MusicBrainz({ fetchImpl: async () => { throw new Error('ECONNREFUSED'); }, gapMs: 0 });
  await assert.rejects(down.check([{ kind: 'artist', artist: 'X' }]), (e) => e instanceof MusicBrainzError && e.status === 502);
  // Busy part way: what it found so far, the rest unchecked (null).
  let calls = 0;
  const tiring = new MusicBrainz({
    fetchImpl: async () => (++calls > 1 ? { ok: false, status: 503, json: async () => ({}) } : { ok: true, status: 200, json: async () => ({ artists: [{ name: 'A', score: 100 }] }) }),
    gapMs: 0,
  });
  assert.deepEqual(await tiring.check([{ kind: 'artist', artist: 'A' }, { kind: 'artist', artist: 'B' }, { kind: 'artist', artist: 'C' }]), ['real', null, null]);
});

test('MusicBrainz: an artist in another script, and their songs, are checked by name (before 0.25.0, the artist was taken for made up, and their song for real if anyone had one of that title)', async () => {
  const fetchImpl = async (url) => {
    const u = new URL(url);
    // Whatever's asked for: an artist in the same script, and someone
    // else's song of that title.
    if (u.pathname === '/ws/2/artist') return { ok: true, status: 200, json: async () => ({ artists: [{ name: 'Кино', score: 100 }] }) };
    if (u.pathname === '/ws/2/recording') return { ok: true, status: 200, json: async () => ({ recordings: [{ title: 'First Love', score: 100, 'artist-credit': [{ name: 'Someone Else' }] }] }) };
    return { ok: true, status: 200, json: async () => ({ 'release-groups': [] }) };
  };
  const mb = new MusicBrainz({ base: 'https://mb.test', fetchImpl, gapMs: 0 });
  assert.deepEqual(
    await mb.check([{ kind: 'artist', artist: 'Аквариум' }, { kind: 'artist', artist: 'КИНО' }, { kind: 'track', artist: '宇多田ヒカル', title: 'First Love' }]),
    ['unknown', 'real', 'unknown'],
  );
});

test('MusicBrainz: musicbrainz.org once a second, your own server as fast as it answers, saying which version asks', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ host: new URL(url).host, at: Date.now(), agent: init.headers['User-Agent'] });
    return { ok: true, status: 200, json: async () => ({ artists: [] }) };
  };
  const items = ['A', 'B', 'C'].map((artist) => ({ kind: 'artist', artist }));
  assert.ok(isPublic('https://musicbrainz.org') && isPublic('https://beta.musicbrainz.org/') && !isPublic('http://192.168.1.30:5000') && !isPublic('https://musicbrainz.org.example.com'));
  const own = new MusicBrainz({ base: 'http://192.168.1.30:5000', version: '0.13.0', fetchImpl });
  let t0 = Date.now();
  await own.check(items);
  assert.ok(Date.now() - t0 < 500, `${Date.now() - t0} ms`);
  assert.ok(seen.every((s) => s.host === '192.168.1.30:5000' && s.agent === 'plexamp-web/0.13.0 ( https://github.com/kamakazedan/plexamp-web )'), JSON.stringify(seen[0]));
  seen.length = 0;
  const pub = new MusicBrainz({ base: 'https://musicbrainz.org', version: 'not a version', fetchImpl });
  t0 = Date.now();
  await pub.check(items);
  assert.ok(seen.slice(1).every((s, i) => s.at - seen[i].at >= 1000), seen.map((s) => s.at - t0).join(','));
  assert.equal(seen[0].agent, 'plexamp-web ( https://github.com/kamakazedan/plexamp-web )');
  // Your own server failing a search: most likely its search indexes.
  const noIndexes = new MusicBrainz({ base: 'http://mb.local:5000', fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }) });
  await assert.rejects(noIndexes.check([{ kind: 'artist', artist: 'X' }]), (e) => e instanceof MusicBrainzError && e.status === 502 && /search indexes/.test(e.message));
});

test('MusicBrainz: a check stops when whoever asked has gone, or its time is up', async () => {
  const asked = [];
  const fetchImpl = async (url) => {
    asked.push(new URL(url).searchParams.get('query'));
    return { ok: true, status: 200, json: async () => ({ artists: [] }) };
  };
  const items = ['A', 'B', 'C', 'D', 'E'].map((artist) => ({ kind: 'artist', artist }));
  // Gone after the second request: nothing more is asked.
  const mb = new MusicBrainz({ fetchImpl, gapMs: 40 });
  const ctrl = new AbortController();
  const check = mb.check(items, { signal: ctrl.signal });
  await new Promise((r) => setTimeout(r, 60));
  ctrl.abort();
  const out = await check;
  assert.ok(asked.length >= 1 && asked.length <= 3, String(asked.length));
  assert.equal(out.filter(Boolean).length, asked.length);
  assert.ok(out.slice(asked.length).every((a) => a === null));
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(asked.length <= 3, String(asked.length));
  // Out of time: the rest come back unchecked, for another time.
  asked.length = 0;
  const slow = new MusicBrainz({ fetchImpl, gapMs: 50 });
  const timed = await slow.check(items, { until: Date.now() + 120 });
  assert.ok(timed.filter(Boolean).length >= 1 && timed.filter(Boolean).length < items.length, JSON.stringify(timed));
  assert.equal(asked.length, timed.filter(Boolean).length);
  // Someone else's turn isn't held up by a check that's been given up on.
  const queued = new MusicBrainz({ fetchImpl, gapMs: 100 });
  const gone = new AbortController();
  const first = queued.check(items, { signal: gone.signal });
  gone.abort();
  const t0 = Date.now();
  await queued.check([{ kind: 'artist', artist: 'Z' }]);
  assert.ok(Date.now() - t0 < 350, `${Date.now() - t0} ms`);
  await first;
});

// ---------- the MusicBrainz features (MUSICBRAINZ_ADVANCED) ----------

const MB_ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
// A small MusicBrainz: artists (with other names and genres), their release
// groups, and those groups' genres; and what it was asked.
function fakeMusicBrainz({ groups = 3, fail = () => false } = {}) {
  const asked = [];
  const artistsKnown = [
    { id: MB_ID(1), name: 'Sigur Rós', 'sort-name': 'Sigur Rós', aliases: [{ name: 'Sigur Ros', 'sort-name': 'Sigur Ros' }], genres: [{ name: 'post-rock', count: 5 }, { name: 'ambient', count: 2 }, { name: 'nope', count: 0 }] },
    { id: MB_ID(2), name: 'Мумий Тролль', 'sort-name': 'Mumiy Troll', aliases: [{ name: 'Mumiy Troll' }], genres: [] },
  ];
  const groupsOf = {
    [MB_ID(1)]: [
      { id: MB_ID(101), title: 'Ágætis byrjun', 'primary-type': 'Album', 'secondary-types': [], 'first-release-date': '1999-06-12' },
      { id: MB_ID(102), title: 'Takk...', 'primary-type': 'Album', 'secondary-types': [], 'first-release-date': '2005-09-12' },
      { id: MB_ID(103), title: 'Inni', 'primary-type': 'Album', 'secondary-types': ['Live'], 'first-release-date': '2011-11-07' },
      ...Array.from({ length: groups }, (_, i) => ({ id: MB_ID(200 + i), title: `Single ${i}`, 'primary-type': 'Single', 'secondary-types': [], 'first-release-date': '2010' })),
    ],
    [MB_ID(2)]: [],
  };
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    asked.push({ path: u.pathname, query: u.searchParams.get('query'), offset: u.searchParams.get('offset'), inc: u.searchParams.get('inc'), at: Date.now(), agent: init.headers['User-Agent'] });
    if (fail(u)) return { ok: false, status: 503, json: async () => ({}) };
    let body = {};
    if (u.pathname === '/ws/2/artist') {
      const names = [...(u.searchParams.get('query') || '').matchAll(/:"([^"]*)"/g)].map((m) => m[1].toLowerCase());
      body = { artists: artistsKnown.filter((a) => [a.name, ...a.aliases.map((x) => x.name)].some((n) => names.includes(n.toLowerCase()))).map((a) => ({ id: a.id, name: a.name, 'sort-name': a['sort-name'], score: 100, aliases: a.aliases })) };
    } else if (u.pathname.startsWith('/ws/2/artist/')) {
      body = artistsKnown.find((a) => a.id === u.pathname.split('/').pop()) || {};
    } else if (u.pathname === '/ws/2/release-group') {
      const all = groupsOf[u.searchParams.get('artist')] || [];
      const from = Number(u.searchParams.get('offset')) || 0;
      body = { 'release-group-count': all.length, 'release-groups': all.slice(from, from + 100) };
    } else if (u.pathname.startsWith('/ws/2/release-group/')) {
      body = { genres: u.pathname.endsWith(MB_ID(101)) ? [{ name: 'post-rock', count: 3 }, { name: 'dream pop', count: 1 }] : [] };
    }
    return { ok: true, status: 200, json: async () => body };
  };
  return { asked, fetchImpl };
}

test('MusicBrainz features: the release rules are the same file in the app (web/js/releases.js) and here', () => {
  const app = readFileSync(new URL('../web/js/releases.js', import.meta.url), 'utf8');
  const here = readFileSync(new URL('./releases.js', import.meta.url), 'utf8');
  assert.equal(here, app);
  assert.ok(!/^import /m.test(here), 'nothing imported: the same in a browser and in Node');
  // ...and names compared as the rest of the app compares them.
  const names = ['The Beatles', 'Sigur Rós', 'AC/DC (Live)', 'Simon & Garfunkel', '  Mötley  Crüe ', '宇多田ヒカル', 'Кино (Live)', 'BTS 방탄소년단', '!!!', 'Israel Kamakawiwoʻole', 'مـرحبا', 'שָׁלוֹם', 'Symphony № 5', 'ΑΓΑΠΗ ΜΟΥ', 'Пётр', 'ايران'];
  for (const n of names) assert.equal(normOfReleases(n), norm(n), n);
});

test('MusicBrainz features: an album\'s kind and its release group, whatever edition the library has', () => {
  assert.equal(kindOf('Album', []), 'albums');
  assert.equal(kindOf('EP'), 'singles');
  assert.equal(kindOf('Single', []), 'singles');
  assert.equal(kindOf('Album', ['Compilation', 'Live']), 'compilations');
  assert.equal(kindOf('Album', ['Live']), 'live');
  assert.equal(kindOf('Album', ['Demo']), 'demos');
  assert.equal(kindOf('Album', ['DJ-mix']), 'djmixes');
  assert.equal(kindOf('Broadcast'), 'other');
  assert.equal(plexKind({ Format: [{ tag: 'EP' }] }), 'singles');
  assert.equal(plexKind({ Format: [{ tag: 'Album' }], Subformat: [{ tag: 'Live' }] }), 'live');
  assert.equal(plexKind({ title: 'No kind said' }), null);
  assert.equal(firstYear({ date: '1977-02-04' }), 1977);
  assert.equal(firstYear({ date: '' }), null);
  assert.equal(albumKey('Rumours - 35th Anniversary Edition'), 'rumours');
  assert.equal(albumKey('Abbey Road (Remastered 2009)'), 'abbey road');
  assert.equal(albumKey('Takk... [Deluxe]'), 'takk');
  assert.equal(albumKey('Songs: Ohia'), 'songs ohia', 'a colon that isn\'t an edition stays');
  const groups = [
    { id: '1', title: 'Heroes', primary: 'Single', secondary: [], date: '1977-09-23' },
    { id: '2', title: '"Heroes"', primary: 'Album', secondary: [], date: '1977-10-14' },
    { id: '3', title: 'Station to Station', primary: 'Album', secondary: [], date: '1976-01-23' },
  ];
  assert.equal(matchGroup(groups, 'Heroes (2017 Remaster)').id, '2', 'an album before a single of the same name');
  assert.equal(matchGroup(groups, 'Heroes', 'singles').id, '1', '...unless it\'s known to be the single');
  assert.equal(matchGroup(groups, 'Station to Statio').id, '3', 'a letter out');
  assert.equal(matchGroup(groups, 'Lodger'), null);
  // Albums of one title (self-titled, or a re-recording): the one that came
  // out the year Plex has, or none, as which it is can't be told.
  const weezer = [
    { id: 'blue', title: 'Weezer', primary: 'Album', secondary: [], date: '1994-05-10' },
    { id: 'green', title: 'Weezer', primary: 'Album', secondary: [], date: '2001-05-15' },
    { id: 'red', title: 'Weezer', primary: 'Album', secondary: [], date: '2008-06-03' },
    { id: 'tv', title: 'Fearless (Taylor’s Version)', primary: 'Album', secondary: [], date: '2021-04-09' },
    { id: 'f', title: 'Fearless', primary: 'Album', secondary: [], date: '2008-11-11' },
  ];
  assert.equal(matchGroup(weezer, 'Weezer', 'albums', 2001).id, 'green');
  assert.equal(matchGroup(weezer, 'Weezer', 'albums', 2004), null, 'a reissue\'s year: which it is can\'t be told');
  assert.equal(matchGroup(weezer, 'Weezer'), null, 'nor without a year');
  assert.equal(matchGroup(weezer, 'Fearless (Taylor’s Version)', 'albums', 2021).id, 'tv');
  assert.equal(matchGroup(weezer, 'Fearless', null, 2008).id, 'f');
});

test('MusicBrainz features: an album of a title the artist has more of, by the year Plex has (or not at all); an artist by Plex\'s MusicBrainz id; never Various Artists', async () => {
  const W = MB_ID(7);
  const VA = '89ad4ac3-39f7-470e-963a-56509c546377';
  const asked = [];
  const fetchImpl = async (url) => {
    const u = new URL(url);
    asked.push(u.pathname);
    let body = {};
    if (u.pathname === '/ws/2/artist') body = { artists: [{ id: W, name: 'Weezer', score: 100 }, { id: VA, name: 'Various Artists', score: 100, aliases: [{ name: 'Compilation Hits' }] }] };
    else if (u.pathname === `/ws/2/artist/${W}`) body = { id: W, name: 'Weezer', aliases: [], genres: [] };
    else if (u.pathname.startsWith('/ws/2/artist/')) return { ok: false, status: 404, json: async () => ({}) };
    else if (u.pathname === '/ws/2/release-group') {
      body = {
        'release-group-count': 3,
        'release-groups': [
          { id: MB_ID(71), title: 'Weezer', 'primary-type': 'Album', 'secondary-types': [], 'first-release-date': '1994-05-10' },
          { id: MB_ID(72), title: 'Weezer', 'primary-type': 'Album', 'secondary-types': [], 'first-release-date': '2001-05-15' },
          { id: MB_ID(73), title: 'Pinkerton', 'primary-type': 'Album', 'secondary-types': [], 'first-release-date': '1996-09-24' },
        ],
      };
    }
    return { ok: true, status: 200, json: async () => body };
  };
  const mb = new MusicBrainz({ base: 'https://mb.test', fetchImpl, gapMs: 0 }).advanced(new MBKept());
  assert.equal((await mb.album('Weezer', 'Weezer', { year: 2001 })).date, '2001-05-15');
  assert.equal(await mb.album('Weezer', 'Weezer', { year: 2004 }), null, 'which it is can\'t be told');
  assert.equal((await mb.album('Weezer', 'Pinkerton', { year: 2010 })).date, '1996-09-24', 'the only one of its title, whatever year Plex has');
  const got = await mb.albums([{ artist: 'Weezer', title: 'Weezer', year: 1994 }, { artist: 'Weezer', title: 'Weezer', year: 2008 }]);
  assert.deepEqual(got.map((g) => g && g.date), ['1994-05-10', null]);
  // By Plex's MusicBrainz id for the artist: no search, whatever the tags say.
  const n = asked.length;
  assert.equal((await mb.artistInfo('Wheezer', { id: W })).name, 'Weezer');
  assert.deepEqual(asked.slice(n), [`/ws/2/artist/${W}`]);
  // An id MusicBrainz doesn't know (out of date in Plex): by name, then,
  // and that id isn't asked about again.
  assert.equal((await mb.artistInfo('Weezer', { id: MB_ID(99) })).id, W);
  const k = asked.length;
  assert.equal((await mb.artistInfo('Weezer', { id: MB_ID(99) })).id, W);
  assert.equal(asked.length, k);
  // Never Various Artists, by any of its names, its id, or as a search finds it.
  const m = asked.length;
  for (const name of ['Various Artists', 'V.A.', 'VA', 'Verschiedene Interpreten', 'オムニバス', 'Різні виконавці']) assert.equal(await mb.artistInfo(name), null, name);
  assert.equal(await mb.artistInfo('', { id: VA }), null);
  assert.equal(asked.length, m, 'not asked about');
  assert.equal(await mb.artistInfo('Compilation Hits'), null, 'nor taken from a search');
  assert.ok(!asked.includes(`/ws/2/artist/${VA}`));
  // Works by no one known, by MusicBrainz's id for that ([anonymous]) or by
  // name: never a real artist who has the name, the second time either.
  const ANON = 'f731ccc4-e22a-43af-a747-64213329e088';
  const a = asked.length;
  for (let i = 0; i < 2; i++) {
    assert.equal(await mb.artistInfo('Anon', { id: ANON }), null);
    for (const name of ['Anonymous', 'Traditional', 'Trad.']) assert.equal(await mb.artistInfo(name), null, name);
  }
  assert.equal(asked.length, a, 'not asked about');
});

test('MusicBrainz features: when MusicBrainz doesn\'t answer, nothing new is asked of it for a minute (what\'s kept is still answered)', async () => {
  const { fetchImpl: answers } = fakeMusicBrainz();
  let down = false;
  let calls = 0;
  const fetchImpl = async (url, init) => {
    calls += 1;
    if (down) throw new Error('connect ETIMEDOUT');
    return answers(url, init);
  };
  const mb = new MusicBrainz({ base: 'https://mb.test', fetchImpl, gapMs: 0 }).advanced(new MBKept());
  await mb.artistInfo('Sigur Rós');
  down = true;
  await assert.rejects(mb.artistInfo('Mumiy Troll'), (e) => e instanceof MusicBrainzError && e.status === 502);
  const n = calls;
  await assert.rejects(mb.artistInfo('Someone Else'), (e) => e instanceof MusicBrainzError && e.status === 503);
  assert.equal(mb.later('Someone Else', 'Their Album'), false, 'nothing put off till later meanwhile either');
  assert.equal(calls, n, 'not asked');
  assert.equal((await mb.artistInfo('Sigur Ros')).name, 'Sigur Rós', 'what\'s kept is still answered');
  // A minute on, it's asked again.
  mb.downUntil = Date.now() - 1;
  down = false;
  assert.equal((await mb.artistInfo('Mumiy Troll')).name, 'Мумий Тролль');
  // And what's kept is written now and then, not after each answer (the
  // first time soon after the first).
  assert.equal(new MBKept().writeDelayMs, MB_ADVANCED_LIMITS.writeMs);
  assert.ok(MB_ADVANCED_LIMITS.writeMs >= 60000);
  assert.ok(new MBKept().firstWriteMs <= 15000);
});

test('MusicBrainz features: what\'s kept is written soon after the first answer, then no more often than every so often', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pw-mbw-'));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const has = (key) => JSON.parse(readFileSync(join(dir, 'musicbrainz.json'), 'utf8')).kept.some((row) => row[0] === key);
  try {
    const kept = new MBKept({ dir, writeDelayMs: 600, firstWriteMs: 30 });
    kept.set('artist|a', null);
    assert.throws(() => statSync(join(dir, 'musicbrainz.json')), 'not straight away');
    await wait(200);
    assert.ok(has('artist|a'), 'soon after the first answer');
    kept.set('artist|b', null);
    await wait(200);
    assert.ok(!has('artist|b'), 'not again so soon');
    await wait(500);
    assert.ok(has('artist|b'), 'then, once it\'s time');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('MusicBrainz features: an artist by name or other name, their other names and genres, kept', async () => {
  const { asked, fetchImpl } = fakeMusicBrainz();
  const mb = new MusicBrainz({ base: 'https://mb.test', fetchImpl, gapMs: 0 }).advanced(new MBKept());
  const a = await mb.artistInfo('Sigur Ros');
  assert.deepEqual(a, { id: MB_ID(1), name: 'Sigur Rós', aliases: ['Sigur Rós', 'Sigur Ros'], genres: ['Post-Rock', 'Ambient'] });
  assert.equal((await mb.artistInfo('Mumiy Troll')).name, 'Мумий Тролль');
  assert.equal(await mb.artistInfo('Nobody At All'), null);
  const n = asked.length;
  assert.deepEqual(await mb.artistInfo('SIGUR RÓS'), a);
  assert.equal(await mb.artistInfo('nobody at all'), null);
  assert.equal(asked.length, n, 'asked once each, not found ones too');
  assert.ok(asked.every((x) => !x.query || x.query.includes('alias:')), 'looked for among other names too');
  // Without the features: nothing's asked.
  const off = new MusicBrainz({ base: 'https://mb.test', fetchImpl, gapMs: 0 });
  assert.equal(await off.artistInfo('Sigur Ros'), null);
  assert.equal(asked.length, n);
});

test('MusicBrainz features: an artist\'s release groups (100 to a page) and an album\'s, with its genres, by artist', async () => {
  const { asked, fetchImpl } = fakeMusicBrainz({ groups: 150 });
  const mb = new MusicBrainz({ base: 'https://mb.test', fetchImpl, gapMs: 0 }).advanced(new MBKept());
  const info = await mb.artistInfo('Sigur Rós');
  const groups = await mb.releaseGroups(info.id);
  assert.equal(groups.length, 153);
  assert.deepEqual(asked.filter((x) => x.path === '/ws/2/release-group').map((x) => x.offset), ['0', '100']);
  assert.deepEqual(groups[0], { id: MB_ID(101), title: 'Ágætis byrjun', primary: 'Album', secondary: [], date: '1999-06-12' });
  const before = asked.length;
  const album = await mb.album('Sigur Ros', 'Ágætis byrjun (Deluxe Edition)', { genres: true });
  assert.deepEqual(album, { ...groups[0], genres: ['Post-Rock', 'Dream Pop'] });
  assert.equal(asked.length, before + 1, 'only its genres were asked about');
  assert.equal((await mb.album('Sigur Rós', 'Inni')).secondary[0], 'Live');
  assert.equal(await mb.album('Sigur Rós', 'An Album They Never Made'), null);
  assert.equal(await mb.album('Nobody At All', 'Anything'), null);
  assert.equal(asked.length, before + 2, 'the rest from what was kept (and nobody\'s looked for once)');
  // Known without asking, or not.
  assert.equal(mb.knownAlbum('Sigur Rós', 'Takk...').date, '2005-09-12');
  assert.equal(mb.knownAlbum('Sigur Rós', 'Takk...', { genres: true }), undefined, 'its genres not asked about yet');
  assert.equal(mb.knownAlbum('Someone Never Asked About', 'X'), undefined);
  assert.equal(mb.knownAlbum('Nobody At All', 'Anything'), null);
  assert.equal(groups.capped, undefined); // (all they have)
});

test('MusicBrainz features: an artist with more release groups than are asked for has a list that says so, as it\'s kept too', async () => {
  const { asked, fetchImpl } = fakeMusicBrainz({ groups: 600 });
  const kept = new MBKept();
  const mb = new MusicBrainz({ base: 'https://mb.test', fetchImpl, gapMs: 0 }).advanced(kept);
  const info = await mb.artistInfo('Sigur Rós');
  const groups = await mb.releaseGroups(info.id);
  assert.equal(groups.length, MB_ADVANCED_LIMITS.groupPages * 100);
  assert.equal(groups.capped, true);
  assert.equal(asked.filter((x) => x.path === '/ws/2/release-group').length, MB_ADVANCED_LIMITS.groupPages);
  const again = await new MusicBrainz({ base: 'https://mb.test', fetchImpl, gapMs: 0 }).advanced(kept).releaseGroups(info.id);
  assert.equal(again.capped, true);
  assert.equal(again.length, groups.length);
});

test('MusicBrainz features: albums not known yet are looked up in the background, after anything someone\'s waiting on', async () => {
  const { asked, fetchImpl } = fakeMusicBrainz();
  const mb = new MusicBrainz({ base: 'https://mb.test', fetchImpl, gapMs: 30 }).advanced(new MBKept());
  const items = [{ artist: 'Sigur Rós', title: 'Takk...' }, { artist: 'Mumiy Troll', title: 'Morskaya' }, { artist: 'Nobody At All', title: 'X' }];
  const first = await mb.albums(items);
  assert.deepEqual(first, ['pending', 'pending', 'pending']);
  // Someone waiting on an answer meanwhile: theirs first.
  const t0 = Date.now();
  const mine = await mb.artistInfo('Sigur Rós');
  assert.ok(mine && Date.now() - t0 < 400, `${Date.now() - t0} ms`);
  const later = await mb.albums(items, { waitMs: 3000 });
  assert.equal(later[0].title, 'Takk...');
  assert.deepEqual(later.slice(1), [null, null]);
  // Asked again: nothing new goes to MusicBrainz.
  const n = asked.length;
  assert.equal((await mb.albums(items))[0].date, '2005-09-12');
  assert.equal(asked.length, n);
  // MusicBrainz busy: tried again later, not taken for "not on MusicBrainz".
  const flaky = fakeMusicBrainz({ fail: (u) => u.pathname === '/ws/2/artist' && !flaky.once++ });
  flaky.once = 0;
  // (A rest, and a minute of not asking it anything new: here, moments.)
  const was = [MB_ADVANCED_LIMITS.restMs, MB_ADVANCED_LIMITS.downMs];
  MB_ADVANCED_LIMITS.restMs = 10;
  MB_ADVANCED_LIMITS.downMs = 50;
  try {
    const mb2 = new MusicBrainz({ base: 'https://mb.test', fetchImpl: flaky.fetchImpl, gapMs: 0 }).advanced(new MBKept());
    assert.deepEqual(await mb2.albums([items[0]]), ['pending']);
    const got = await mb2.albums([items[0]], { waitMs: 2000 });
    assert.equal(got[0]?.title, 'Takk...');
  } finally {
    [MB_ADVANCED_LIMITS.restMs, MB_ADVANCED_LIMITS.downMs] = was;
  }
  // At most so many waiting.
  const full = new MusicBrainz({ base: 'https://mb.test', fetchImpl: async () => new Promise(() => {}), gapMs: 0 }).advanced(new MBKept());
  // (Nothing's looked up here, only how many can wait: as if it were busy
  // with one already.)
  full.working = true;
  const limit = MB_ADVANCED_LIMITS.queued;
  const each = MB_ADVANCED_LIMITS.queuedEach;
  MB_ADVANCED_LIMITS.queued = 3;
  MB_ADVANCED_LIMITS.queuedEach = 2;
  try {
    assert.ok(full.later('A', 'One', { who: 'sam' }) && full.later('B', 'Two', { who: 'sam' }));
    assert.equal(full.later('C', 'Three', { who: 'sam' }), false, 'at most so many of one account\'s');
    assert.ok(full.later('A', 'One', { who: 'sam' }), 'one already waiting');
    assert.ok(full.later('C', 'Three', { who: 'dan' }), 'someone else\'s still go');
    assert.equal(full.later('D', 'Four', { who: 'eve' }), false, 'and at most so many in all');
  } finally {
    MB_ADVANCED_LIMITS.queued = limit;
    MB_ADVANCED_LIMITS.queuedEach = each;
  }
});

test('MusicBrainz features: what\'s looked up is kept in a file only the service can read, for a month, and read back checked', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pw-mb-'));
  try {
    const { asked, fetchImpl } = fakeMusicBrainz();
    let now = Date.now();
    const kept = new MBKept({ dir, now: () => now, writeDelayMs: 1 });
    const mb = new MusicBrainz({ base: 'https://mb.test', fetchImpl, gapMs: 0 }).advanced(kept);
    await mb.album('Sigur Rós', 'Takk...', { genres: true });
    kept.flush();
    const file = join(dir, 'musicbrainz.json');
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const n = asked.length;
    const again = new MusicBrainz({ base: 'https://mb.test', fetchImpl, gapMs: 0 }).advanced(new MBKept({ dir, now: () => now }));
    assert.equal((await again.album('Sigur Rós', 'Takk...', { genres: true })).date, '2005-09-12');
    assert.equal(asked.length, n, 'from the file: nothing asked');
    // What doesn't check out is left out; a month on, it's all gone.
    const data = JSON.parse(readFileSync(file, 'utf8'));
    data.kept.push(['artist|evil', { id: '../../etc', name: 'x' }, now], ['groups|x', 'not a list', now], ['made up|y', 1, now], ['genres|' + MB_ID(9), ['Fine'], now + 86400000]);
    writeFileSync(file, JSON.stringify(data));
    const read = new MBKept({ dir, now: () => now });
    assert.equal(read.get('artist|evil'), undefined);
    assert.equal(read.get('groups|x'), undefined);
    assert.equal(read.get('made up|y'), undefined);
    assert.equal(read.get(`genres|${MB_ID(9)}`), undefined, 'not from the future');
    assert.ok(read.get('artist|sigur ros'));
    now += 32 * 86400000;
    assert.equal(new MBKept({ dir, now: () => now }).map.size, 0);
    writeFileSync(file, '{ not json');
    assert.equal(new MBKept({ dir }).map.size, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- shared playlists ----------

test('shared playlists: changes on both sides are merged, whoever made them', () => {
  const m = (base, mine, theirs) => mergeTracks(base.split(' '), mine.split(' '), theirs.split(' ')).join(' ');
  // Only one side changed: that side.
  assert.equal(m('1 2 3', '1 2 3', '1 3'), '1 3');
  assert.equal(m('1 2 3', '1 2 3 4', '1 2 3'), '1 2 3 4');
  // Both: an addition here, a removal there.
  assert.equal(m('1 2 3', '1 2 3 4', '1 3'), '1 3 4');
  // Added after the track it followed.
  assert.equal(m('1 2 3', '1 5 2 3', '1 2 3 4'), '1 5 2 3 4');
  // The same track added on both sides is in once.
  assert.equal(m('1 2 3', '1 2 3 5', '1 2 3 5'), '1 2 3 5');
  // Taken out on either side: out.
  assert.equal(m('1 2 3 4', '1 3 4', '1 2 3'), '1 3');
  // Reordered here, added to there: this order, with the addition (at the
  // end, where it was).
  assert.equal(m('1 2 3', '3 2 1', '1 2 3 4'), '3 2 1 4');
  assert.equal(m('1 2 3', '3 2 1', '1 2 4 3'), '3 2 4 1');
  // Reordered there: that order wins, with what was added here.
  assert.equal(m('1 2 3', '1 2 3 9', '3 1 2'), '3 1 2 9');
  // A track that's in it twice is two entries.
  assert.equal(m('1 2 1', '1 2 1 1', '2 1'), '2 1 1');
});

function shareSetup(dir = null) {
  const store = new Shares({ dir, writeDelayMs: 1 });
  const s = store.create(dan, { server: 'mock-server-1', playlist: '500', title: 'Road trip', tracks: ['1', '2', '3'], members: [{ id: sam.id, title: 'Sam', role: 'edit' }, { id: eve.id, title: 'Eve', role: 'view' }] });
  return { store, s };
}

test('shared playlists: who sees what, and who can change it', () => {
  const { store, s } = shareSetup();
  assert.deepEqual(store.forUser(sam.id, 'mock-server-1').map((x) => x.id), [s.id]);
  assert.deepEqual(store.forUser(sam.id, 'another-server'), []);
  assert.deepEqual(store.forUser(4, 'mock-server-1'), []);
  // Its owner sees who it's shared with; the others, whose it is.
  assert.deepEqual(store.view(s, dan.id).members.map((m) => [m.title, m.role, m.joined]), [['Sam', 'edit', false], ['Eve', 'view', false]]);
  const samView = store.view(s, sam.id);
  assert.equal(samView.members, undefined);
  assert.deepEqual([samView.role, samView.joined, samView.copy, samView.owner.title, samView.server], ['edit', false, null, 'Dan', 'mock-server-1']);
  // Not added yet: nothing to bring up to date.
  assert.throws(() => store.sync(s, sam, { tracks: ['1'] }), (e) => e instanceof ShareError && e.status === 409);
  store.join(s, sam, { playlist: '600', tracks: ['1', '2', '3'], version: 1, title: 'Road trip' });
  store.join(s, eve, { playlist: '700', tracks: ['1', '2', '3'], version: 1, title: 'Road trip' });
  // Someone who can edit it: their change is everyone's.
  const r = store.sync(s, sam, { tracks: ['1', '3', '4'], title: 'Road trip', unseen: [] });
  assert.deepEqual([r.tracks, r.changed, r.version], [['1', '3', '4'], true, 2]);
  store.synced(s, sam, { version: r.version, tracks: r.tracks, title: 'Road trip', lease: r.lease });
  // Someone who can only view it: theirs is undone.
  const v = store.sync(s, eve, { tracks: ['9'], title: 'Mine now', unseen: [] });
  assert.deepEqual([v.tracks, v.undone, v.changed, s.title], [['1', '3', '4'], true, false, 'Road trip']);
  // Its owner's changes since go in with Sam's; its owner names it.
  const o = store.sync(s, dan, { tracks: ['1', '2', '3', '5'], title: 'Road trip 2' });
  assert.deepEqual([o.tracks, s.title, o.wasTitle], [['1', '3', '4', '5'], 'Road trip 2', 'Road trip']);
  // A member's own name for it stays theirs.
  store.synced(s, sam, { version: s.version, tracks: s.tracks, title: 'Our trip' });
  assert.equal(store.sync(s, sam, { tracks: s.tracks, title: 'Our trip' }).title, 'Road trip 2');
  assert.equal(s.title, 'Road trip 2');
});

test('shared playlists: a copy read before another device of theirs brought it up to date is read again', () => {
  const { store, s } = shareSetup();
  store.join(s, sam, { playlist: '600', tracks: ['1', '2', '3'], version: 1, title: 'Road trip' });
  assert.equal(store.view(s, sam.id).at, 1);
  // Dan adds one; Sam's phone brings his copy up to date...
  store.sync(s, dan, { tracks: ['1', '2', '3', '4'], title: 'Road trip', since: 1 });
  const phone = store.sync(s, sam, { tracks: ['1', '2', '3'], title: 'Road trip', since: 1 });
  store.synced(s, sam, { version: phone.version, tracks: phone.tracks, title: 'Road trip', lease: phone.lease });
  // ...while his laptop had read it before: that would undo Dan's.
  const laptop = store.sync(s, sam, { tracks: ['1', '2', '3'], title: 'Road trip', since: 1 });
  assert.deepEqual(laptop, { stale: true, at: 2 });
  assert.deepEqual(s.tracks, ['1', '2', '3', '4']);
  // Read again, it's in step.
  const again = store.sync(s, sam, { tracks: ['1', '2', '3', '4'], title: 'Road trip', since: laptop.at });
  assert.deepEqual([again.tracks, again.changed], [['1', '2', '3', '4'], false]);
});

test('shared playlists: a copy brought up to date by another device meanwhile is read again, even with nothing new shared', () => {
  const { store, s } = shareSetup();
  // Eve can only view it, and took track 3 out in another app. One tab of
  // hers reads her copy; another undoes her change first.
  store.join(s, eve, { playlist: '700', tracks: ['1', '2', '3'], version: 1, title: 'Road trip' });
  const first = store.sync(s, eve, { tracks: ['1', '2'], title: 'Road trip', since: 1, unseen: [] });
  assert.deepEqual([first.tracks, first.undone, first.version], [['1', '2', '3'], true, 1]);
  assert.deepEqual(store.synced(s, eve, { version: first.version, tracks: ['1', '2', '3'], title: 'Road trip', lease: first.lease }), { at: 2 });
  assert.equal(store.view(s, eve.id).at, 2);
  // The other tab's read is from before: it reads again (rather than add 3 a
  // second time).
  assert.deepEqual(store.sync(s, eve, { tracks: ['1', '2'], title: 'Road trip', since: 1, unseen: [] }), { stale: true, at: 2 });
});

test('shared playlists: tracks someone can no longer see in their copy are not taken out for everyone', () => {
  const { store, s } = shareSetup();
  store.join(s, sam, { playlist: '600', tracks: ['1', '2', '3'], version: 1, title: 'Road trip' });
  // Missing from Sam's copy: 2 (a library that isn't shared with him now)
  // and 3 (he took it out). Which, he's asked first.
  assert.deepEqual(store.sync(s, sam, { tracks: ['1'], title: 'Road trip', since: 1 }), { confirm: ['2', '3'] });
  assert.deepEqual(s.tracks, ['1', '2', '3']);
  const r = store.sync(s, sam, { tracks: ['1'], title: 'Road trip', since: 1, unseen: ['2', '9'] });
  assert.deepEqual([r.tracks, r.changed], [['1', '2'], true]);
  // His copy still holds 2, hidden: so it's still there for him, and he's
  // asked about it again next time (and only about it).
  store.synced(s, sam, { version: r.version, tracks: ['1'], title: 'Road trip', lease: r.lease });
  assert.deepEqual(s.copies[sam.id].tracks, ['1', '2']);
  assert.deepEqual(store.sync(s, sam, { tracks: ['1', '4'], title: 'Road trip', since: 2 }), { confirm: ['2'] });
  const next = store.sync(s, sam, { tracks: ['1', '4'], title: 'Road trip', since: 2, unseen: ['2'] });
  assert.deepEqual([next.confirm, next.tracks], [undefined, ['1', '2', '4']]);
  // Put back where they were, each time they were there.
  assert.deepEqual(withUnseen(['1', '2', '3', '2'], ['1', '3'], ['2']), ['1', '2', '3', '2']);
  assert.deepEqual(withUnseen(['1', '2', '3'], ['3', '1'], ['2']), ['3', '1', '2']);
  assert.deepEqual(withUnseen(['2', '1'], ['1'], ['2']), ['2', '1']);
  assert.deepEqual(withUnseen(['1', '2'], ['1', '2'], ['2']), ['1', '2']);
  assert.deepEqual(missingFrom(['1', '2', '2', '3'], ['2', '3', '4']), ['1', '2']);
  assert.throws(() => store.sync(s, sam, { tracks: ['1'], title: 'Road trip', since: 2, lease: next.lease, unseen: ['x'] }), (e) => e.status === 400);
});

test('shared playlists: a hidden track someone else takes out stays out once it can be seen again', () => {
  const { store, s } = shareSetup();
  const title = 'Road trip';
  store.join(s, sam, { playlist: '600', tracks: ['1', '2', '3'], version: 1, title });
  // 2 is hidden from Sam (its library isn't shared with him now): his copy
  // still holds it, he just can't see it, nor take it out.
  const a = store.sync(s, sam, { tracks: ['1', '3'], title, since: 1, unseen: ['2'] });
  assert.deepEqual([a.held, a.tracks, a.changed], [['1', '2', '3'], ['1', '2', '3'], false]);
  store.synced(s, sam, { version: a.version, tracks: ['1', '3'], title, lease: a.lease });
  assert.deepEqual(s.copies[sam.id].tracks, ['1', '2', '3']);
  // Dan takes it out.
  store.sync(s, dan, { tracks: ['1', '3'], title, unseen: [] });
  assert.deepEqual(s.tracks, ['1', '3']);
  // Sam, still not seeing it: it's out for everyone, still in his copy.
  const b = store.sync(s, sam, { tracks: ['1', '3'], title, since: 2, unseen: ['2'] });
  assert.deepEqual([b.held, b.tracks], [['1', '2', '3'], ['1', '3']]);
  store.synced(s, sam, { version: b.version, tracks: ['1', '3'], title, lease: b.lease });
  assert.deepEqual(s.copies[sam.id].tracks, ['1', '2', '3']);
  // Seen again, it isn't taken for one he added: it goes from his copy too.
  const c = store.sync(s, sam, { tracks: ['1', '2', '3'], title, since: 3 });
  assert.deepEqual([c.tracks, c.changed, s.tracks], [['1', '3'], false, ['1', '3']]);
});

test('shared playlists: one device at a time brings a copy up to date', () => {
  const { store, s } = shareSetup();
  store.join(s, sam, { playlist: '600', tracks: ['1', '2', '3'], version: 1, title: 'Road trip' });
  const phone = store.sync(s, sam, { tracks: ['1', '2', '3'], title: 'Road trip', since: 1 });
  assert.match(phone.lease, /^[a-f0-9]{24}$/);
  // His laptop, meanwhile: not until the phone's done.
  assert.deepEqual(store.sync(s, sam, { tracks: ['1', '2'], title: 'Road trip', since: 1 }), { busy: true });
  assert.throws(() => store.synced(s, sam, { version: 1, tracks: ['1', '2'], title: 'Road trip' }), (e) => e.status === 409);
  assert.throws(() => store.synced(s, sam, { version: 1, tracks: ['1', '2'], title: 'Road trip', lease: 'ab'.repeat(12) }), (e) => e.status === 409);
  assert.deepEqual(s.copies[sam.id].tracks, ['1', '2', '3']);
  // The phone again, with its lease: fine. Other people's copies aren't held up.
  assert.equal(store.sync(s, sam, { tracks: ['1', '2', '3'], title: 'Road trip', since: 1, lease: phone.lease }).lease, phone.lease);
  assert.ok(store.sync(s, dan, { tracks: ['1', '2', '3'], title: 'Road trip' }).lease);
  // A long one: the phone keeps its turn for longer (no one else can).
  const until = store.leases.get(`${s.id}|${sam.id}`).until;
  assert.deepEqual(store.renew(s, sam, { lease: phone.lease }), { ok: true });
  assert.ok(store.leases.get(`${s.id}|${sam.id}`).until >= until && store.leases.get(`${s.id}|${sam.id}`).until <= Date.now() + LEASE_MS);
  assert.throws(() => store.renew(s, sam, { lease: 'ab'.repeat(12) }), (e) => e.status === 409);
  assert.deepEqual(store.synced(s, sam, { version: phone.version, tracks: phone.tracks, title: 'Road trip', lease: phone.lease }), { at: 2 });
  assert.throws(() => store.renew(s, sam, { lease: phone.lease }), (e) => e.status === 409);
  // Done: the laptop's turn.
  const laptop = store.sync(s, sam, { tracks: ['1', '2', '3'], title: 'Road trip', since: 2 });
  assert.ok(laptop.lease && laptop.lease !== phone.lease);
  // A device that never says it's done holds it up for a while, not for ever.
  store.leases.get(`${s.id}|${sam.id}`).until = Date.now() - 1;
  assert.ok(store.sync(s, sam, { tracks: ['1', '2', '3'], title: 'Road trip', since: 2 }).lease);
  // Gone with the copy.
  store.leave(s, sam.id);
  assert.equal(store.leases.has(`${s.id}|${sam.id}`), false);
});

test('shared playlists: who it is shared with changes; when it stops, everyone keeps theirs', () => {
  const { store, s } = shareSetup();
  store.join(s, sam, { playlist: '600', tracks: s.tracks, version: 1, title: 'Road trip' });
  // Eve left out, Sam now view only (his copy kept).
  store.setMembers(s, [{ id: sam.id, role: 'view' }]);
  assert.deepEqual([store.roleOf(s, sam.id), store.roleOf(s, eve.id), store.view(s, sam.id).copy], ['view', null, '600']);
  assert.deepEqual(store.forUser(eve.id, 'mock-server-1'), []);
  // Its owner can't be a member, a bad role isn't taken, and there's a limit.
  store.setMembers(s, [{ id: dan.id, role: 'edit' }, { id: sam.id, role: 'edit' }]);
  assert.deepEqual(s.members.map((m) => m.id), [sam.id]);
  assert.throws(() => store.setMembers(s, [{ id: 9, role: 'admin' }]), (e) => e.status === 400);
  assert.throws(() => store.setMembers(s, Array.from({ length: SHARE_LIMITS.members + 1 }, (_, i) => ({ id: 100 + i, role: 'view' }))), (e) => e.status === 413);
  store.leave(s, sam.id);
  assert.equal(store.roleOf(s, sam.id), null);
  store.remove(s);
  assert.throws(() => store.get(s.id), (e) => e.status === 404);
});

test('shared playlists: what is accepted, and limits', () => {
  const { store } = shareSetup();
  const create = (over) => store.create(dan, { server: 'mock-server-1', playlist: '501', title: 'X', tracks: ['1'], ...over });
  assert.throws(() => create({ tracks: ['1', '2; DROP'] }), (e) => e.status === 400);
  assert.throws(() => create({ tracks: [] }), (e) => e.status === 400);
  assert.throws(() => create({ playlist: '../x' }), (e) => e.status === 400);
  assert.throws(() => create({ server: 'a/b' }), (e) => e.status === 400);
  assert.throws(() => create({ tracks: Array.from({ length: SHARE_LIMITS.tracks + 1 }, (_, i) => String(i)) }), (e) => e.status === 413);
  // The same playlist twice: no.
  assert.throws(() => create({ playlist: '500' }), (e) => e.status === 409);
  const s = create({ title: 'Line one\nline two\u0000' });
  assert.equal(s.title, 'Line one line two');
  assert.throws(() => store.get('../../etc/passwd'), (e) => e.status === 404);
});

test('shared playlists: kept in a file only the service can read, without anyone\'s sign-in, and read back', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pw-shares-'));
  try {
    const { store, s } = shareSetup(dir);
    store.join(s, sam, { playlist: '600', tracks: s.tracks, version: 1, title: 'Road trip' });
    store.flush();
    const file = join(dir, 'shares.json');
    const text = readFileSync(file, 'utf8');
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.doesNotMatch(text, /token/i);
    const again = new Shares({ dir });
    const t = again.get(s.id);
    assert.deepEqual([t.title, t.tracks, again.view(t, sam.id).copy, again.roleOf(t, eve.id)], ['Road trip', ['1', '2', '3'], '600', 'view']);
    // A file that's been tampered with: what doesn't check out is left out.
    const data = JSON.parse(text);
    data.shares.push({ ...data.shares[0], id: 'nope' }, { ...data.shares[0], id: 'ab'.repeat(12), tracks: ['x'] });
    writeFileSync(file, JSON.stringify(data));
    assert.equal(new Shares({ dir }).list.size, 1);
    writeFileSync(file, '{ not json');
    assert.equal(new Shares({ dir }).list.size, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- settings that follow an account ----------

test('account settings: each account its own, changed a few at a time, never a device\'s own', () => {
  const store = new SettingsStore();
  assert.deepEqual(store.get(dan.id), { settings: {}, changed: {}, rev: 0, off: false });
  const kept = store.update(dan.id, {
    set: { ratingSystem: 'tick', gridSize: 'large', home: { '*': { order: ['mixes', 'stations'], hidden: [], options: { topAlbums: { period: 'month' } }, seen: ['mixes'] } } },
  });
  assert.equal(kept.rev, 1);
  store.update(dan.id, { set: { gridSize: 'small', ai: { apiKey: 'secret', url: 'http://x' }, playerName: 'Kitchen', quality: '128', route: 'direct', version: 9 } });
  const now = store.get(dan.id);
  assert.equal(now.rev, 2);
  assert.deepEqual(Object.keys(now.settings).sort(), ['gridSize', 'home', 'ratingSystem']);
  assert.equal(now.settings.gridSize, 'small');
  assert.equal(now.settings.home['*'].options.topAlbums.period, 'month');
  // When each last changed: a browser that couldn't send a change can tell
  // whether it's been overtaken.
  assert.deepEqual(now.changed, { ratingSystem: 1, gridSize: 2, home: 1 });
  assert.deepEqual(store.get(sam.id), { settings: {}, changed: {}, rev: 0, off: false });
  // Turned off for the account: nothing kept, nothing more taken, until it's on again.
  assert.deepEqual(store.update(dan.id, { off: true }), { settings: {}, changed: {}, rev: 3, off: true });
  assert.throws(() => store.update(dan.id, { set: { gridSize: 'large' } }), (e) => e.status === 409);
  assert.equal(store.update(dan.id, { off: false }).off, false);
  assert.equal(store.update(dan.id, { set: { gridSize: 'large' } }).rev, 5);
  store.forget(dan.id);
  assert.deepEqual(store.get(dan.id), { settings: {}, changed: {}, rev: 0, off: false });
});

test('account settings: only those that follow an account, each the kind of value it is, and not too many', () => {
  const store = new SettingsStore();
  const bad = (set) => assert.throws(() => store.update(dan.id, { set }), (e) => e.status === 400 || e.status === 413);
  bad(null);
  bad(['ratingSystem']);
  bad({ gapless: 'yes' });
  bad({ fadeLength: Infinity });
  bad({ gridSize: { large: true } });
  bad({ fades: 'not one of them!' });
  bad({ ratingSystem: 'x'.repeat(41) });
  bad({ home: JSON.parse('{"__proto__": {"polluted": true}}') });
  bad({ home: { 'bad key!': 1 } });
  bad({ home: { '*': { title: 'x'.repeat(SETTINGS_LIMITS.text + 1) } } });
  bad({ home: { a: { b: { c: { d: { e: { f: 1 } } } } } } });
  bad({ home: { '*': { order: Array.from({ length: SETTINGS_LIMITS.items + 1 }, () => 'x') } } });
  bad({ home: ['mixes'] });
  assert.equal({}.polluted, undefined);
  const lots = { '*': { options: Object.fromEntries(Array.from({ length: 115 }, (_, i) => [`k${i}`, 'x'.repeat(SETTINGS_LIMITS.text)])) } };
  assert.throws(() => store.update(dan.id, { set: { home: lots } }), (e) => e.status === 413);
  assert.deepEqual(store.get(dan.id), { settings: {}, changed: {}, rev: 0, off: false });
  // Anything else (a device's own, a setting that isn't one, an object's own
  // __proto__) isn't kept, and changes nothing.
  assert.deepEqual(store.update(dan.id, { set: { ...JSON.parse('{"__proto__": {"x": 1}}'), quality: '128', made: 'up', ai: { apiKey: 'k' } } }), { settings: {}, changed: {}, rev: 0, off: false });
  assert.equal(store.accounts.size, 0);
  assert.deepEqual(cleanValue({ a: [true, 1, 'x', null] }), { a: [true, 1, 'x', null] });
  // So many accounts kept: no more.
  const full = new SettingsStore();
  for (let i = 1; i <= SETTINGS_LIMITS.accounts; i++) full.accounts.set(i, { settings: {}, rev: 1, at: 0 });
  assert.throws(() => full.update(SETTINGS_LIMITS.accounts + 1, { set: { gridSize: 'large' } }), (e) => e.status === 507);
  assert.equal(full.update(1, { set: { gridSize: 'large' } }).rev, 2);
});

test('account settings: the same ones follow an account here as in the app (web/js/sync.js)', () => {
  const src = readFileSync(new URL('../web/js/sync.js', import.meta.url), 'utf8');
  const list = src.match(/export const SYNCED_SETTINGS = Object\.freeze\(\[([^\]]*)\]\)/);
  assert.ok(list, 'SYNCED_SETTINGS in web/js/sync.js');
  const app = [...list[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual([...app].sort(), Object.keys(SYNCED_SETTINGS).sort());
  const device = src.match(/export const DEVICE_SETTINGS = Object\.freeze\(\[([^\]]*)\]\)/);
  const own = [...device[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  for (const k of ['quality', 'route', 'playerName', 'ai', 'loadAhead', 'keepPlayed', 'shareDevices', 'speed']) {
    assert.ok(own.includes(k), `${k} is a device's own`);
    assert.ok(!(k in SYNCED_SETTINGS), `${k} isn't kept for an account`);
  }
  // (Gone in 0.25.0: live updates are the player's choice, WEBSOCKETS, and
  // codecInfo is the four codec settings.)
  for (const k of ['liveUpdates', 'codecBadges', 'coverBadges', 'searchCodecs', 'showCodec']) assert.ok(!own.includes(k) && !(k in SYNCED_SETTINGS), `${k} is no setting now`);
});

test('account settings: kept in a file only the service can read, and read back (what doesn\'t check out left out)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pw-settings-'));
  try {
    const store = new SettingsStore({ dir });
    store.update(dan.id, { set: { ratingSystem: 'stars' } });
    store.update(sam.id, { set: { gridSize: 'large' } });
    store.flush();
    const file = join(dir, 'settings.json');
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const again = new SettingsStore({ dir });
    assert.deepEqual(again.get(dan.id), { settings: { ratingSystem: 'stars' }, changed: { ratingSystem: 1 }, rev: 1, off: false });
    const data = JSON.parse(readFileSync(file, 'utf8'));
    data.accounts['abc'] = { settings: { gridSize: 'large' }, rev: 1 };
    data.accounts['7'] = { settings: { ai: { apiKey: 'secret' }, gridSize: 'large', gapless: 'not a yes or no', made: 'up' }, rev: 3 };
    data.accounts['8'] = { settings: { home: { a: { b: { c: { d: { e: { f: 1 } } } } } } }, rev: 1 };
    writeFileSync(file, JSON.stringify(data));
    const read = new SettingsStore({ dir });
    assert.deepEqual([...read.accounts.keys()].sort(), [1, 2, 7, 8]);
    assert.deepEqual(read.get(7), { settings: { gridSize: 'large' }, changed: { gridSize: 3 }, rev: 3, off: false });
    assert.deepEqual(read.get(8).settings, {});
    writeFileSync(file, '{ not json');
    assert.equal(new SettingsStore({ dir }).accounts.size, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('account settings: loudness levelling kept off from 0.19.0 (how it started then) goes, once, so it starts on as in 0.20.0', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pw-settings-'));
  const said = [];
  const log = { info: (m) => said.push(m), warn: (m) => said.push(m), error: (m) => said.push(m) };
  try {
    const file = join(dir, 'settings.json');
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        accounts: {
          1: { settings: { loudness: false, gapless: false }, changed: { loudness: 2, gapless: 2 }, rev: 2 },
          2: { settings: { loudness: true, gridSize: 'large' }, changed: { loudness: 1, gridSize: 1 }, rev: 1 },
          3: { settings: {}, rev: 4, off: true },
        },
      }),
    );
    const store = new SettingsStore({ dir, log });
    assert.deepEqual(store.get(1), { settings: { gapless: false }, changed: { gapless: 2 }, rev: 2, off: false });
    assert.deepEqual(store.get(2), { settings: { loudness: true, gridSize: 'large' }, changed: { loudness: 1, gridSize: 1 }, rev: 1, off: false });
    assert.deepEqual(store.get(3), { settings: {}, changed: {}, rev: 4, off: true });
    assert.equal(said.length, 1);
    assert.match(said[0], /1 account kept it off/);
    store.flush();
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).version, 3);
    // Only once: turned off from then on, it stays off.
    store.update(1, { set: { loudness: false } });
    store.flush();
    assert.deepEqual(new SettingsStore({ dir, log }).get(1).settings, { gapless: false, loudness: false });
    assert.equal(said.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('account settings: the four codec settings kept before 0.25.0 are one, off where they all were', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pw-settings-'));
  try {
    const file = join(dir, 'settings.json');
    const all = (v) => ({ codecBadges: v, coverBadges: v, searchCodecs: v, showCodec: v });
    writeFileSync(
      file,
      JSON.stringify({
        version: 2,
        accounts: {
          1: { settings: { ...all(false), gapless: false }, changed: { codecBadges: 2, coverBadges: 2, searchCodecs: 2, showCodec: 2, gapless: 1 }, rev: 2 },
          2: { settings: { ...all(false), searchCodecs: true }, rev: 3 },
          3: { settings: { gridSize: 'large' }, rev: 1 },
          4: { settings: {}, rev: 5, off: true },
          // (Kept before 0.23.0 had covers': not all four.)
          5: { settings: { codecBadges: false, searchCodecs: false, showCodec: false }, rev: 2 },
        },
      }),
    );
    const store = new SettingsStore({ dir });
    assert.deepEqual(store.get(1), { settings: { gapless: false, codecInfo: false }, changed: { gapless: 1, codecInfo: 2 }, rev: 2, off: false });
    assert.deepEqual(store.get(2).settings, {}, 'one of them on: codec information stays on, as it starts');
    assert.deepEqual(store.get(3).settings, { gridSize: 'large' });
    assert.deepEqual(store.get(4), { settings: {}, changed: {}, rev: 5, off: true });
    assert.deepEqual(store.get(5).settings, {}, 'three of the four off, the fourth never kept: on, as each device has it');
    store.flush();
    const kept = readFileSync(file, 'utf8');
    assert.equal(JSON.parse(kept).version, 3);
    assert.ok(!/codecBadges|coverBadges|searchCodecs|showCodec/.test(kept), 'the four go from the file');
    // Only once: turned on again from then on, it stays on.
    store.update(1, { set: { codecInfo: true } });
    store.flush();
    assert.equal(new SettingsStore({ dir }).get(1).settings.codecInfo, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- Spotify import ----------

const SP_ID = '37i9dQZF1DXcBWIGoYBM5M';
const spTrack = (n, extra = {}) => ({ uri: `spotify:track:${String(n).padStart(22, 'x')}`, title: `Song ${n}`, subtitle: `Artist ${n}, Guest`, duration: 200000 + n, isPlayable: true, ...extra });
const spEntity = (tracks, extra = {}) => ({ type: 'playlist', name: 'Road trip', uri: `spotify:playlist:${SP_ID}`, subtitle: 'Dan', trackList: tracks, ...extra });
const nextPage = (e) =>
  `<!doctype html><html><head><title>x</title></head><body><div id="root"></div><script src="https://embed-cdn.spotifycdn.com/x.js"></script>` +
  `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { state: { data: { entity: e } } } } })}</script></body></html>`;
const statePage = (e) => `<html><body><script id="initial-state" type="text/plain">\n${Buffer.from(JSON.stringify({ data: { entity: e } })).toString('base64')}\n</script></body></html>`;
const resourcePage = (e) => `<html><body><script id="resource" type="text/plain">${Buffer.from(JSON.stringify(e)).toString('base64')}</script></body></html>`;
const otherPage = (e) => `<html><body><script type="application/json">${JSON.stringify({ deep: { inside: [{ x: 1 }, { playlist: e }] } })}</script></body></html>`;

test('Spotify: a playlist from its link, URI or id, and nothing else', () => {
  for (const ok of [
    `https://open.spotify.com/playlist/${SP_ID}?si=abc123&pt=x`,
    `https://open.spotify.com/intl-de/playlist/${SP_ID}`,
    `https://open.spotify.com/intl-pt-BR/playlist/${SP_ID}/`,
    `http://open.spotify.com/embed/playlist/${SP_ID}`,
    `https://play.spotify.com/user/dan/playlist/${SP_ID}`,
    `spotify:playlist:${SP_ID}`,
    `spotify:user:dan:playlist:${SP_ID}`,
    `  ${SP_ID}  `,
  ]) {
    assert.equal(playlistId(ok), SP_ID, ok);
  }
  for (const no of [
    `https://open.spotify.com/album/${SP_ID}`,
    `https://evil.example/playlist/${SP_ID}`,
    `https://open.spotify.com.evil.example/playlist/${SP_ID}`,
    `https://user:pw@open.spotify.com/playlist/${SP_ID}`,
    `ftp://open.spotify.com/playlist/${SP_ID}`,
    `https://open.spotify.com/playlist/${SP_ID}/../../etc`,
    `https://open.spotify.com/playlist/short`,
    'javascript:alert(1)',
    `${SP_ID}x`,
    'x'.repeat(600),
    '',
    null,
  ]) {
    assert.equal(playlistId(no), null, String(no));
  }
  assert.equal(shortCode('https://spotify.link/AbC123xyz'), 'AbC123xyz');
  assert.equal(shortCode('http://spotify.link/AbC123xyz'), null);
  assert.equal(shortCode('https://spotify.link.evil.example/AbC123xyz'), null);
  assert.equal(shortCode('https://spotify.link/a/b'), null);
});

test('Spotify: the playlist is found in each shape its page has had, and nothing that isn\'t one', () => {
  const e = spEntity([spTrack(1), spTrack(2)]);
  for (const page of [nextPage(e), statePage(e), resourcePage(e), otherPage(e)]) {
    assert.deepEqual(embedPlaylist(page)?.trackList?.map((t) => t.title), ['Song 1', 'Song 2']);
  }
  assert.equal(embedPlaylist(nextPage({ type: 'track', name: 'One song', uri: 'spotify:track:x' })), null);
  assert.equal(embedPlaylist('<html><body><script>window.x = 1</script><p>no data</p></body></html>'), null);
  assert.equal(embedPlaylist('<script id="__NEXT_DATA__">{ broken'), null);
  assert.equal(embedPlaylist(''), null);
});

test('Spotify: tracks come out as plain text and numbers, and only tracks', () => {
  assert.deepEqual(trackOf(spTrack(1)), { title: 'Song 1', artist: 'Artist 1, Guest', duration: 200001 });
  assert.deepEqual(trackOf({ uri: 'spotify:track:a', title: 'Two', artists: [{ name: 'Tyler, The Creator' }, { name: 'Kali Uchis' }], album: { name: 'Flower Boy' }, duration: { totalMilliseconds: 1234 } }), {
    title: 'Two',
    artist: 'Tyler, The Creator, Kali Uchis',
    artists: ['Tyler, The Creator', 'Kali Uchis'],
    album: 'Flower Boy',
    duration: 1234,
  });
  assert.equal(trackOf({ uri: 'spotify:episode:a', title: 'A podcast' }), null);
  assert.equal(trackOf({ uri: 'spotify:track:a', title: '' }), null);
  assert.equal(trackOf('nope'), null);
  const odd = trackOf({ title: `Line one\nline two\u0000 x${'y'.repeat(400)}`, subtitle: 42, duration: -5 });
  assert.equal(odd.title.length, 300);
  assert.match(odd.title, /^Line one line two x/);
  assert.equal(odd.artist, '');
  assert.equal(odd.duration, undefined);
  assert.equal(trackOf({ title: 'Long', duration: 49 * 3600 * 1000 }).duration, undefined);
  assert.equal(trackOf({ uri: 'spotify:local:a:b:c:1', title: 'A local file' }).title, 'A local file');
});

// A stand-in for Spotify: answers by path, and remembers what was asked.
function fakeSpotify(routes) {
  const asked = [];
  const fetchImpl = async (url, opts) => {
    asked.push({ url, opts });
    const r = routes[new URL(url).pathname] ?? { status: 404, body: 'Not found' };
    if (r.throws) throw new Error(r.throws);
    return new Response(r.body ?? '', { status: r.status ?? 200, headers: r.headers ?? { 'Content-Type': 'text/html' } });
  };
  return { asked, fetchImpl };
}

test('Spotify: a public playlist is read from its page at Spotify\'s own address, and kept a while', async () => {
  const { asked, fetchImpl } = fakeSpotify({ [`/embed/playlist/${SP_ID}`]: { body: nextPage(spEntity([spTrack(1), spTrack(2, { uri: 'spotify:episode:x' }), spTrack(3)])) } });
  const sp = new Spotify({ base: 'https://spotify.test', version: '0.18.0', fetchImpl });
  const pl = await sp.playlist(SP_ID);
  assert.deepEqual(pl, {
    id: SP_ID,
    name: 'Road trip',
    owner: 'Dan',
    tracks: [
      { title: 'Song 1', artist: 'Artist 1, Guest', duration: 200001 },
      { title: 'Song 3', artist: 'Artist 3, Guest', duration: 200003 },
    ],
    capped: false,
  });
  assert.equal(asked[0].url, `https://spotify.test/embed/playlist/${SP_ID}`);
  assert.equal(asked[0].opts.redirect, 'manual');
  assert.match(asked[0].opts.headers['User-Agent'], /^plexamp-web\/0\.18\.0 /);
  assert.equal(asked[0].opts.headers.Cookie, undefined);
  await sp.playlist(SP_ID);
  assert.equal(asked.length, 1, 'kept for a while');
  await assert.rejects(sp.playlist('../../etc/passwd'), (e) => e instanceof SpotifyError && e.status === 400);
  // As many as the page lists: there may be more.
  const many = fakeSpotify({ [`/embed/playlist/${SP_ID}`]: { body: statePage(spEntity(Array.from({ length: SPOTIFY_LIMITS.shown }, (_, i) => spTrack(i)))) } });
  assert.equal((await new Spotify({ base: 'https://spotify.test', fetchImpl: many.fetchImpl }).playlist(SP_ID)).capped, true);
});

test('Spotify: private, missing, changed or unreachable pages each say so, and redirects stay at Spotify', async () => {
  const say = async (route, expect) => {
    const { fetchImpl } = fakeSpotify({ [`/embed/playlist/${SP_ID}`]: route, '/elsewhere': { body: nextPage(spEntity([spTrack(1)])) } });
    await assert.rejects(new Spotify({ base: 'https://spotify.test', fetchImpl }).playlist(SP_ID), (e) => e instanceof SpotifyError && e.status === expect.status && expect.says.test(e.message));
  };
  await say({ status: 404 }, { status: 404, says: /no public playlist/ });
  await say({ status: 429 }, { status: 503, says: /slow down/ });
  await say({ status: 500 }, { status: 502, says: /answered 500/ });
  await say({ body: '<html><body>Something else entirely</body></html>' }, { status: 502, says: /changed the page/ });
  await say({ throws: 'ECONNREFUSED' }, { status: 502, says: /couldn’t be reached/ });
  await say({ status: 302, headers: { Location: 'https://evil.example/elsewhere' } }, { status: 502, says: /redirect elsewhere/ });
  await say({ body: `<html><body><script type="application/json">${'x'.repeat(SPOTIFY_LIMITS.bytes + 10)}</script></body></html>` }, { status: 502, says: /bigger than expected/ });
  // Within Spotify's own address, a redirect is followed.
  const { asked, fetchImpl } = fakeSpotify({ [`/embed/playlist/${SP_ID}`]: { status: 301, headers: { Location: '/elsewhere' } }, '/elsewhere': { body: nextPage(spEntity([spTrack(1)])) } });
  assert.equal((await new Spotify({ base: 'https://spotify.test', fetchImpl }).playlist(SP_ID)).tracks.length, 1);
  assert.deepEqual(asked.map((a) => a.url), [`https://spotify.test/embed/playlist/${SP_ID}`, 'https://spotify.test/elsewhere']);
});

test('Spotify: a short link from the share sheet leads to its playlist', async () => {
  const { fetchImpl } = fakeSpotify({
    '/AbC123xyz': { status: 307, headers: { Location: `https://open.spotify.com/playlist/${SP_ID}?si=1` } },
    '/InPage1234': { body: `<html><a href="https://open.spotify.com/playlist/${SP_ID}?si=2">Open</a></html>` },
  });
  const sp = new Spotify({ shortBase: 'https://short.test', fetchImpl });
  assert.equal(await sp.resolveShort('https://spotify.link/AbC123xyz'), SP_ID);
  assert.equal(await sp.resolveShort('https://spotify.link/InPage1234'), SP_ID);
  assert.equal(await sp.resolveShort('https://spotify.link/Nothing123'), null);
  assert.equal(await sp.resolveShort('https://example.com/AbC123xyz'), null);
});

// ---------- Missing tracks that follow each account ----------

const SRV = 'mock-server-1';
let opN = 0;
const opId = () => (++opN).toString(16).padStart(12, '0');
const AT = 1_800_000_000; // seconds
const song = (artist, title, extra = {}) => ({ kind: 'track', artist, title, ...extra });
const noteOp = (items, extra = {}) => ({ type: 'note', id: opId(), items, found: [], unreal: [], via: '', section: '1', library: 'Music (Test)', at: AT, ...extra });
const store = (opts = {}) => new MissingStore({ now: () => AT * 1000, ...opts });
const mineOf = (st, uid) => st.view(uid, SRV).entries;
// Dan owns the server; Sam and Eve are friends.
const asOwner = (st, ops, server = SRV) => st.apply(dan.id, server, ops, { owner: true });
const asFriend = (st, who, ops, server = SRV) => st.apply(who.id, server, ops);

test('missing tracks: the rules are the same file in the app (web/js/missinglist.js) and here', () => {
  const app = readFileSync(new URL('../web/js/missinglist.js', import.meta.url), 'utf8');
  const here = readFileSync(new URL('./missinglist.js', import.meta.url), 'utf8');
  assert.equal(here, app);
  assert.ok(!/^import /m.test(here), 'nothing imported: the same in a browser and in Node');
});

test('missing tracks: a friend\'s list is kept for their account as they use it, for the owner to see (0.24.0\'s share and unshare are no changes now)', () => {
  const st = store();
  asFriend(st, sam, [noteOp([song('A', 'One')])]);
  assert.deepEqual(mineOf(st, sam.id).map((m) => m.title), ['One']);
  assert.ok(!('shared' in st.view(sam.id, SRV)));
  assert.equal(st.view(dan.id, SRV, { owner: true }).others.length, 1);
  // What a 0.24.0 page may still send: left out, nothing taken off, and not remembered.
  const r = asFriend(st, sam, [{ type: 'unshare', id: opId() }, { type: 'share', id: opId() }]);
  assert.equal(r.skipped, 2);
  assert.deepEqual(mineOf(st, sam.id).map((m) => m.title), ['One']);
  assert.equal(st.view(sam.id, SRV).done.length, 1);
  assert.equal(st.view(dan.id, SRV, { owner: true }).others.length, 1);
  // The server's owner's own, as ever.
  asOwner(st, [noteOp([song('C', 'Three')])]);
  assert.deepEqual(mineOf(st, dan.id).map((m) => m.title), ['Three']);
});

test('missing tracks: each account its own list; AI suggestions counted again, a change sent twice made once', () => {
  const st = store();
  const op = noteOp([song('A', 'One'), song('A', 'One'), { kind: 'artist', artist: 'B' }]);
  asOwner(st, [op]);
  asOwner(st, [op]); // (sent again, as the page went)
  let mine = mineOf(st, dan.id);
  assert.deepEqual(mine.map((m) => [m.kind, m.artist, m.title, m.times]), [['track', 'A', 'One', 1], ['artist', 'B', '', 1]]);
  assert.ok(mine.every((m) => !('server' in m) && !('prompt' in m)));
  asOwner(st, [noteOp([song('a', 'one')])]);
  mine = mineOf(st, dan.id);
  assert.equal(mine.find((m) => m.title === 'One').times, 2);
  assert.deepEqual(mineOf(st, sam.id), []);
  // Found in the library: let go; and what MusicBrainz doesn't know, unless from Spotify.
  asOwner(st, [noteOp([], { found: [keyOf(song('A', 'One'))], unreal: [keyOf({ kind: 'artist', artist: 'B', title: '' })] })]);
  assert.deepEqual(mineOf(st, dan.id), []);
});

test('missing tracks: a change sent again after another device\'s is made once (a clear doesn\'t take what came since)', () => {
  const st = store();
  const clear = { type: 'clear', id: opId() };
  asOwner(st, [noteOp([song('A', 'One')]), clear]);
  asOwner(st, [noteOp([song('B', 'Two')])]);
  // ...even after many changes since, for weeks.
  asOwner(st, Array.from({ length: 40 }, (_, i) => noteOp([song('Z', `Z${i}`)])));
  asOwner(st, [clear]);
  assert.ok(mineOf(st, dan.id).some((m) => m.title === 'Two'));
  const later = store({ now: () => (AT + 50 * 86400) * 1000 });
  asOwner(later, [clear]);
  asOwner(later, [noteOp([song('B', 'Two')], { at: AT + 50 * 86400 })]);
  asOwner(later, [clear]);
  assert.ok(mineOf(later, dan.id).some((m) => m.title === 'Two'), 'remembered for 50 days');
  // ...and one that isn't a track or an artist leaves the rest of its change.
  const one = store();
  asOwner(one, [noteOp([{ kind: 'album', artist: 'X', title: 'Y' }, song('C', 'Three')])]);
  assert.deepEqual(mineOf(one, dan.id).map((m) => m.title), ['Three']);
});

test('missing tracks: the app sends what fits in one request (names in other scripts are bigger)', () => {
  const app = readFileSync(new URL('../web/js/missingsync.js', import.meta.url), 'utf8');
  const kb = (name) => Number(app.match(new RegExp(`const ${name} = (\\d+) \\* 1024`))?.[1]);
  assert.ok(kb('BATCH_BYTES') > 0 && kb('BATCH_BYTES') <= 400, 'a request well under the 512 KB nginx and the service take');
  const items = Array.from({ length: 250 }, (_, i) => song('日本語のアーティスト名'.repeat(12).slice(0, 120), `曲の名前${i}`.repeat(20).slice(0, 160)));
  assert.ok(Buffer.byteLength(JSON.stringify(noteOp(items))) < 400 * 1024, 'a change of 250 of the longest names fits');
});

test('missing tracks: a Spotify one is counted once for each playlist, by its listId, never its name', () => {
  const st = store();
  const sp = (list) => noteOp([song('S', 'Tune')], { via: 'spotify', list: listId(list) });
  asOwner(st, [sp('Road trip'), sp('Road trip'), sp('Gym')]);
  const [m] = mineOf(st, dan.id);
  assert.equal(m.via, 'spotify');
  assert.equal(m.times, 2);
  assert.deepEqual(m.lists, [listId('Road trip'), listId('Gym')]);
  assert.ok(!JSON.stringify(st.view(dan.id, SRV)).includes('Road trip'));
  // A name instead of a listId isn't one.
  assert.equal(cleanOp({ ...sp('x'), list: 'Road trip' }, AT), null);
});

// listId before 0.25.0: the whole hash of the name.
const longListId = (name) => {
  let x = 0x811c9dc5;
  for (const ch of String(name).trim().toLowerCase()) x = Math.imul(x ^ ch.codePointAt(0), 0x01000193) >>> 0;
  return x.toString(36);
};

test('missing tracks: a playlist\'s listId is twelve bits of a hash of its name, too few to work a name out from (and one kept before 0.25.0 is cut down)', () => {
  const names = Array.from({ length: 5000 }, (_, i) => `Playlist ${i}`);
  const ids = names.map(listId);
  assert.ok(ids.every((id) => /^[a-z0-9]{1,3}$/.test(id) && parseInt(id, 36) < 4096), ids.find((id) => parseInt(id, 36) >= 4096));
  // Many names to each: 5,000 names have at most 4,096 ids.
  assert.ok(new Set(ids).size <= 4096);
  assert.equal(listId('  Road Trip '), listId('road trip'));
  // One from before is cut down as listId cuts it, wherever it's met: what a
  // browser sends, and what the player kept.
  // (Mix 954's whole hash was short: 5jz.)
  for (const name of ['Road trip', 'Gym', 'Late night', '夜', 'Mix 954']) {
    assert.ok(parseInt(longListId(name), 36) > 4095, name);
    assert.equal(shortList(longListId(name)), listId(name), name);
    assert.equal(shortList(listId(name)), listId(name), name);
  }
  assert.equal(longListId('Mix 954'), '5jz');
  assert.equal(cleanOp(noteOp([song('S', 'Tune')], { via: 'spotify', list: longListId('Gym') }), AT).list, listId('Gym'));
  const e = cleanEntry({ kind: 'track', artist: 'S', title: 'Tune', via: 'spotify', lists: [longListId('Gym'), listId('Gym'), longListId('Road trip')], last: AT, section: '1' }, AT);
  assert.deepEqual(e.lists, [listId('Gym'), listId('Road trip')]);
  // ...and by the app's rules: noted, put together with another list, or
  // put back.
  const st = store();
  asOwner(st, [noteOp([song('S', 'Tune')], { via: 'spotify', list: longListId('Gym') }), noteOp([song('S', 'Tune')], { via: 'spotify', list: listId('Gym') })]);
  assert.deepEqual(mineOf(st, dan.id)[0].lists, [listId('Gym')]);
  const old = { kind: 'track', artist: 'T', title: 'Other', via: 'spotify', lists: [longListId('Road trip')], times: 1, first: AT, last: AT, section: '1', library: 'L' };
  assert.deepEqual(applyMerge([], [old], { server: SRV })[0].lists, [listId('Road trip')]);
  assert.deepEqual(applyRestore([], [old], { server: SRV })[0].lists, [listId('Road trip')]);
});

test('names in other scripts are told apart (norm), as Latin ones always were', () => {
  // Latin letters and numbers alone: as they always were.
  for (const [name, was] of [['The Beatles', 'beatles'], ['Sigur Rós & Friends (Live)', 'sigur ros and friends'], ['Mø', 'm'], ['Røyksopp', 'r yksopp'], ['2002', '2002'], ['!!!', ''], ['ＡＢＣ １２３', 'abc 123'], ['Israel Kamakawiwoʻole', 'israel kamakawiwo ole']]) {
    assert.equal(norm(name), was, name);
  }
  // ...the same, however they're written: an ʻokina or an apostrophe;
  // Arabic and Hebrew with their vowel points and tatweel or without.
  // Greek in capitals (without its accents) or not, Russian's ё as е, and
  // Persian's ی and ک as Arabic's ي and ك.
  for (const [a, b] of [["Israel Kamakawiwo'ole", 'Israel Kamakawiwoʻole'], ['مـرحبا', 'مرحبا'], ['שָׁלוֹם', 'שלום'], ['µ-Ziq', 'μ-Ziq'], ['Αγάπη μου', 'ΑΓΑΠΗ ΜΟΥ'],
    ['Θεοδωράκης', 'ΘΕΟΔΩΡΑΚΗΣ'], ['Ἀθῆναι', 'ΑΘΗΝΑΙ'], ['Пётр Чайковский', 'Петр Чайковский'], ['Всё идёт по плану', 'Все идет по плану'], ['ایران', 'ايران']]) {
    assert.equal(norm(a), norm(b), `${a} / ${b}`);
  }
  // Another script: its letters and numbers as they're written.
  assert.equal(norm('КИНО'), 'кино');
  assert.equal(norm('그리움'), '그리움', 'composed, not in parts');
  const apart = [['宇多田ヒカル', '椎名林檎'], ['Симфония № 5', 'Концерт № 5'], ['第9番', '9月'], ['Мой', 'Мои'], ['그리움', '그리운'], ['Love 사랑', 'Love 이별'], ['BTS 방탄소년단', 'BTS'], ['ラーメン', 'ラメン'], ['Київ', 'Киів']];
  for (const [a, b] of apart) assert.notEqual(norm(a), norm(b), `${a} / ${b}`);
  // ...and not taken for each other as a letter or two different, where
  // one character can be another word.
  assert.equal(sameTitle(norm('君の名は希望だ'), norm('君の名は希望か')), false);
  assert.equal(sameTitle(norm('Out of Spacee'), norm('Out of Space')), true);
  // Nor are titles with other numbers, in any script's digits (though a
  // number's leading zeros don't count).
  for (const [a, b] of [['Symphony No. 5', 'Symphony No. 6'], ['Piano Sonata No. 1', 'Piano Sonata No. 10'], ['BWV 846', 'BWV 847'], ['Симфония № 5', 'Симфония № 6'], ['سمفونية رقم ٥', 'سمفونية رقم ٦'], ['सिम्फनी ५', 'सिम्फनी ६']]) {
    assert.equal(sameTitle(norm(a), norm(b)), false, `${a} / ${b}`);
  }
  assert.equal(sameTitle(norm('Symphony No. 5'), norm('Symphony No. 5 - Allegro con brio')), true);
  assert.equal(sameTitle(norm('Interlude 01'), norm('Interlude 1')), true);
  // Two songs of the same name by two artists in another script are two
  // entries, not one.
  const st = store();
  asOwner(st, [noteOp([song('宇多田ヒカル', 'First Love'), song('椎名林檎', 'First Love'), song('Чайковский', 'Симфония № 5'), song('Чайковский', 'Концерт № 5'), song('久石譲', '第9番'), song('久石譲', '9月')])]);
  assert.equal(mineOf(st, dan.id).length, 6);
});

test('missing tracks: what the app sends that isn\'t kept (what it was asked for) never is, and what can\'t be read is left out', () => {
  const st = store();
  const r = asOwner(st, [
    { ...noteOp([song('A', 'One')]), prompt: 'my secret request' },
    { type: 'merge', id: opId(), entries: [{ kind: 'track', artist: 'C', title: 'Three', times: 2, first: AT - 10, last: AT - 5, section: '1', library: 'L', prompt: 'another secret', server: 'elsewhere' }] },
    { type: 'note', id: 'not an id', items: [] },
    { type: 'note', id: opId(), items: [{ kind: 'track', artist: 'X', title: 'Y' }], section: '../1' },
    { type: 'note', id: opId(), items: Array.from({ length: MISSING_STORE_LIMITS.items + 1 }, (_, i) => song('Z', `T${i}`)), section: '1' },
    { type: 'made up', id: opId() },
    // (For everyone's, only taking some off, or clearing it.)
    { type: 'mb', id: opId(), real: [], dropped: [], everyone: true },
  ]);
  assert.equal(r.skipped, 5);
  const kept = JSON.stringify(st.view(dan.id, SRV));
  assert.ok(!kept.includes('secret') && !kept.includes('elsewhere'));
  assert.deepEqual(mineOf(st, dan.id).map((m) => m.title).sort(), ['One', 'Three']);
  assert.equal(cleanEntry({ kind: 'track', artist: 'A', title: 'B', last: AT + 2 * 86400, section: '1' }, AT), null, 'not from the future');
  assert.equal(cleanEntry({ kind: 'track', artist: 'A', title: 'B', last: AT, section: '../1' }, AT), null);
  assert.equal(cleanEntry({ kind: 'track', artist: 'A\u0000\u0007', title: 'B', last: AT, section: 1, times: 1e9 }, AT).times, 1);
  assert.throws(() => asOwner(st, new Array(MISSING_STORE_LIMITS.ops + 1).fill(noteOp([]))), (e) => e.status === 413);
  assert.throws(() => st.apply(dan.id, '../etc', []), (e) => e.status === 400);
});

test('missing tracks: a browser\'s own list, the first time, is put together with the account\'s (and again, nothing twice)', () => {
  const st = store();
  asOwner(st, [noteOp([song('A', 'One')], { at: AT - 100 }), noteOp([song('S', 'Tune')], { via: 'spotify', list: listId('Gym'), at: AT - 100 })]);
  const here = [
    { kind: 'track', artist: 'A', title: 'One', times: 2, first: AT - 500, last: AT - 50, section: '1', library: 'L' },
    { kind: 'track', artist: 'S', title: 'Tune', via: 'spotify', lists: [listId('Gym'), listId('Road trip')], times: 2, first: AT - 500, last: AT - 60, section: '1', library: 'L' },
    { kind: 'artist', artist: 'New', title: '', times: 1, first: AT - 5, last: AT - 5, section: '1', library: 'L' },
  ];
  asOwner(st, [{ type: 'merge', id: opId(), entries: here }]);
  const by = Object.fromEntries(mineOf(st, dan.id).map((m) => [m.title || m.artist, m]));
  assert.equal(by.One.times, 2);
  assert.equal(by.One.first, AT - 500);
  assert.equal(by.One.last, AT - 50);
  assert.equal(by.Tune.times, 2);
  assert.deepEqual(by.Tune.lists, [listId('Gym'), listId('Road trip')]);
  assert.ok(by.New);
  // Put together again (kept on that device a while): nothing's counted twice.
  const once = JSON.stringify(mineOf(st, dan.id));
  asOwner(st, [{ type: 'merge', id: opId(), entries: here }]);
  assert.equal(JSON.stringify(mineOf(st, dan.id)), once);
  // The browser's rules, the same: one from somewhere else on each is as it was noted last.
  const [m] = applyMerge([{ kind: 'track', artist: 'A', title: 'One', via: 'spotify', lists: ['x'], times: 1, first: 1, last: 10, section: '1', server: SRV }], [{ kind: 'track', artist: 'A', title: 'One', times: 4, first: 2, last: 20, section: '1' }], { server: SRV });
  assert.equal(m.via, undefined);
  assert.equal(m.times, 4);
});

test('missing tracks: the server\'s owner sees everyone else\'s put together, whose by id, and takes some off everyone\'s', () => {
  const st = store();
  asOwner(st, [noteOp([song('A', 'One')])]);
  asFriend(st, sam, [noteOp([song('A', 'One'), song('B', 'Two')]), noteOp([song('A', 'One')])]);
  asFriend(st, eve, [noteOp([song('a', 'ONE')], { via: 'spotify', list: listId('Gym') })]);
  // Only for its owner (the service asks plex.tv).
  assert.equal(st.view(sam.id, SRV).others, undefined);
  const others = st.view(dan.id, SRV, { owner: true }).others;
  const one = others.find((r) => keyOf(r) === keyOf(song('A', 'One')));
  assert.deepEqual([one.ai, one.spotify, one.who.sort()], [2, 1, [sam.id, eve.id].sort()]);
  assert.ok(!others.some((r) => r.who.includes(dan.id)), 'not their own');
  // Their change to everyone's, not someone else's.
  const two = idOf({ ...song('B', 'Two'), section: '1' });
  assert.equal(asFriend(st, sam, [{ type: 'forget', id: opId(), ids: [two], everyone: true }]).skipped, 1);
  asOwner(st, [{ type: 'forget', id: opId(), ids: [idOf({ ...song('A', 'One'), section: '1' })], everyone: true }]);
  assert.deepEqual(mineOf(st, dan.id), []);
  assert.deepEqual(mineOf(st, sam.id).map((m) => m.title), ['Two']);
  assert.deepEqual(mineOf(st, eve.id), []);
  // What MusicBrainz said is for their own list only.
  asOwner(st, [{ type: 'mb', id: opId(), real: [], dropped: [two] }]);
  assert.deepEqual(mineOf(st, sam.id).map((m) => m.title), ['Two']);
  // Cleared: everyone's on this server.
  asFriend(st, sam, [noteOp([song('C', 'Three')])]);
  asFriend(st, sam, [noteOp([song('C', 'Three')])], 'other-server');
  asOwner(st, [{ type: 'clear', id: opId(), everyone: true }]);
  assert.deepEqual(mineOf(st, sam.id), []);
  assert.equal(st.view(sam.id, 'other-server').entries.length, 1);
});

test('missing tracks: revs say what changed since, and a fresh start never passes for before', () => {
  const st = store();
  const first = st.view(dan.id, SRV, { owner: true });
  assert.ok(Array.isArray(first.entries) && Array.isArray(first.others));
  const same = st.view(dan.id, SRV, { owner: true, have: first.rev });
  assert.equal(same.entries, undefined);
  assert.equal(same.others, undefined);
  asFriend(st, sam, [noteOp([song('A', 'One')])]);
  const after = st.view(dan.id, SRV, { owner: true, have: first.rev });
  assert.equal(after.entries, undefined, 'their own: as it was');
  assert.equal(after.others.length, 1, 'everyone else\'s: changed');
  const r = asOwner(st, [noteOp([song('B', 'Two')])]);
  assert.equal(r.before.mine, first.rev.mine);
  assert.notEqual(r.rev.mine, r.before.mine);
  assert.notEqual(store().revs(SRV, dan.id).mine, store().revs(SRV, dan.id).mine);
});

test('missing tracks: limits, and what there\'s no room for is refused by id (not taken from anyone)', () => {
  const st = store();
  const many = (n, p = 'T') => Array.from({ length: n }, (_, i) => song('A', `${p}${i}`));
  asOwner(st, [noteOp(many(MISSING_STORE_LIMITS.items))]);
  assert.equal(mineOf(st, dan.id).length, MISSING_LIMITS.ai);
  for (let i = 2; i <= MISSING_STORE_LIMITS.servers; i += 1) asOwner(st, [noteOp([song('A', 'One')])], `s${i}`);
  const op = noteOp([song('A', 'One')]);
  const r = asOwner(st, [op], 's-one-too-many');
  assert.deepEqual([r.full, r.refused], [true, [op.id]], 'more servers than one account has lists for');
  const few = store();
  const was = MISSING_STORE_LIMITS.entries;
  MISSING_STORE_LIMITS.entries = 3;
  try {
    asOwner(few, [noteOp(many(2))]);
    const big = noteOp(many(2, 'U'));
    const r2 = asFriend(few, sam, [big]);
    assert.deepEqual(r2.refused, [big.id]);
    assert.deepEqual(mineOf(few, sam.id), []);
    // Taking some off is never refused.
    assert.equal(asOwner(few, [{ type: 'clear', id: opId() }]).full, false);
  } finally {
    MISSING_STORE_LIMITS.entries = was;
  }
});

test('missing tracks: kept in a file only the service can read, and read back (what doesn\'t check out left out)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pw-missing-'));
  try {
    const st = new MissingStore({ dir, now: () => AT * 1000 });
    asOwner(st, [noteOp([song('A', 'One')])]);
    asFriend(st, sam, [noteOp([song('B', 'Two')], { via: 'spotify', list: listId('Gym') })]);
    st.flush();
    const file = join(dir, 'missing.json');
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const data = JSON.parse(readFileSync(file, 'utf8'));
    assert.ok(!readFileSync(file, 'utf8').includes('Gym'));
    data.servers[SRV].accounts.abc = { entries: [song('C', 'x')] };
    data.servers[SRV].accounts[7] = { rev: 2, shared: true, entries: [{ kind: 'track', artist: 'D', title: 'Four', last: AT, section: '1' }, { kind: 'album', artist: 'E', last: AT, section: '1' }, 'nonsense'], done: [['zz', AT * 1000], ['abcdef123456', AT * 1000], ['abcdef654321', 1000]] };
    // (0.24.0's: a friend's choice to share, with nothing on their list yet.)
    data.servers[SRV].accounts[8] = { rev: 1, shared: true, entries: [], done: [] };
    data.servers['../x'] = { accounts: { 1: { entries: [{ kind: 'track', artist: 'F', title: 'Five', last: AT, section: '1' }] } } };
    writeFileSync(file, JSON.stringify(data));
    // (Before 0.25.0, a playlist's whole hash, in a file of version 1.)
    assert.equal(data.version, 2);
    data.version = 1;
    data.servers[SRV].accounts[sam.id].entries[0].lists = [longListId('Gym')];
    writeFileSync(file, JSON.stringify(data));
    const again = new MissingStore({ dir, now: () => AT * 1000 });
    assert.deepEqual(mineOf(again, dan.id).map((m) => m.title), ['One']);
    assert.deepEqual(mineOf(again, sam.id).map((m) => [m.title, m.lists]), [['Two', [listId('Gym')]]]);
    // A file from before is written again soon, as it's kept now.
    again.flush();
    const now = readFileSync(file, 'utf8');
    assert.equal(JSON.parse(now).version, 2);
    assert.ok(!now.includes(longListId('Gym')) && !now.includes('"shared"'), now.slice(0, 300));
    assert.ok(!again.servers.get(SRV).accounts.has(8), 'nothing kept for a choice that\'s no choice now');
    assert.deepEqual(mineOf(again, 7).map((m) => m.title), ['Four']);
    assert.deepEqual(again.view(7, SRV).done, ['abcdef123456'], 'what isn\'t a change, or is too old, left out');
    assert.deepEqual([...again.servers.keys()], [SRV]);
    assert.equal(again.total, 3);
    writeFileSync(file, '{ not json');
    assert.equal(new MissingStore({ dir }).servers.size, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('missing tracks: the app\'s rules note a playlist as before (applyNote)', () => {
  const one = applyNote([], noteOp([song('A', 'One')]), { server: SRV, prompt: 'chill' });
  assert.deepEqual(one.keys, [keyOf(song('A', 'One'))]);
  assert.equal(one.list[0].prompt, 'chill');
  // Without a prompt (the service), none is kept.
  const two = applyNote(one.list, noteOp([song('A', 'One')]), { server: SRV });
  assert.equal(two.list[0].times, 2);
  assert.ok(!('prompt' in two.list[0]));
  // Another library on the same server is another list.
  const other = applyNote(two.list, noteOp([song('A', 'One')], { section: '2' }), { server: SRV });
  assert.equal(other.list.length, 2);
});

// ---------- /pms/: the Plex server's owner, and everyone else ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A Plex server and plex.tv, as the service sees them. Dan (owner-token)
// owns the server, which Sam (sam-token) can use; Alex (alex-token) has a
// Plex account, but can't. state.open: the server lets the service in
// without signing in, taking its requests for its owner's: every one
// (honour false), or those without a sign-in it knows (honour true: its
// people's are theirs). state.nobody: it shows nobody what only its owner
// may see (its settings, who's playing); state.tokenless: what it answers
// a request for its library without a sign-in (0: as above). state.down:
// plex.tv answers 503.
async function fakePlex() {
  const state = { open: false, honour: false, down: false, noSessions: false, broken: false, nobody: false, tokenless: 0 };
  const accounts = {
    'owner-token': { id: 1, uuid: 'u1', username: 'dan', friendlyName: 'Dan' },
    'sam-token': { id: 2, uuid: 'u2', username: 'sam', friendlyName: 'Sam' },
    'alex-token': { id: 3, uuid: 'u3', username: 'alex', friendlyName: 'Alex' },
  };
  const known = new Set(['owner-token', 'sam-token']); // the server's people's sign-ins
  const asked = []; // { path, token } the server was asked
  const tvAsked = []; // { path, token } plex.tv was asked
  const tvTokens = [];
  const asOwner = (t) => t === 'owner-token' || (state.open && !(state.honour && known.has(t)));
  const json = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(body === undefined ? '' : JSON.stringify(body));
  };
  const pms = createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const t = req.headers['x-plex-token'] || u.searchParams.get('X-Plex-Token') || '';
    asked.push({ path: u.pathname, token: t });
    if (state.broken) return json(res, 503, {});
    if (u.pathname === '/identity') return json(res, 200, { MediaContainer: { machineIdentifier: 'srv-1' } });
    if (u.pathname === '/library/sections') {
      if (!t && state.tokenless) return json(res, state.tokenless, {});
      return json(res, known.has(t) || asOwner(t) ? 200 : 401, { MediaContainer: { size: 1 } });
    }
    if (u.pathname === '/:/prefs' || (u.pathname === '/status/sessions' && !state.noSessions)) return json(res, asOwner(t) && !state.nobody ? 200 : 401, { MediaContainer: {} });
    return json(res, 404, {});
  });
  const tv = createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const t = req.headers['x-plex-token'] || '';
    if (t) tvTokens.push(t);
    tvAsked.push({ path: u.pathname, token: t });
    if (state.down) return json(res, 503, {});
    if (u.pathname === '/api/v2/ping') return json(res, 200, { pong: true });
    const a = accounts[t];
    if (!a) return json(res, 401, {});
    if (u.pathname === '/api/v2/user') return json(res, 200, a);
    if (u.pathname === '/api/v2/resources') return json(res, 200, t === 'alex-token' ? [] : [{ clientIdentifier: 'srv-1', provides: 'server', owned: t === 'owner-token' }]);
    return json(res, 404, {});
  });
  await Promise.all([pms, tv].map((x) => new Promise((r) => x.listen(0, '127.0.0.1', r))));
  return {
    state,
    known,
    asked,
    tvAsked,
    tvTokens,
    pms: `http://127.0.0.1:${pms.address().port}`,
    tv: `http://127.0.0.1:${tv.address().port}`,
    close: () => {
      pms.close();
      tv.close();
      pms.closeAllConnections?.();
      tv.closeAllConnections?.();
    },
  };
}

test('the owner\'s sign-ins: fingerprints only, for 30 days since last used, the latest 50, kept in a file only the service can read', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pw-owners-'));
  try {
    let now = 1_000_000_000_000;
    const fp = (n) => createHash('sha256').update(`token-${n}`).digest('hex');
    const o = new OwnerSignIns({ dir, now: () => now });
    o.add(fp(1));
    o.add('not-a-fingerprint');
    assert.equal(o.has(fp(1)), true);
    assert.equal(o.has(fp(2)), false);
    assert.equal(o.has('not-a-fingerprint'), false);
    o.flush();
    const file = join(dir, 'owners.json');
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { version: 1, owners: { [fp(1)]: now } });
    const again = new OwnerSignIns({ dir, now: () => now });
    assert.equal(again.has(fp(1)), true);
    now += OWNER_LIMITS.keepMs + 1;
    assert.equal(again.has(fp(1)), false);
    for (let i = 0; i < OWNER_LIMITS.kept + 10; i++) {
      now += 1000;
      o.add(fp(100 + i));
    }
    assert.equal(o.has(fp(100)), false);
    assert.equal(o.has(fp(100 + OWNER_LIMITS.kept + 9)), true);
    o.drop(fp(100 + OWNER_LIMITS.kept + 9));
    assert.equal(o.has(fp(100 + OWNER_LIMITS.kept + 9)), false);
    // (What doesn't check out is left out; a file that can't be read, all.)
    writeFileSync(file, JSON.stringify({ version: 1, owners: { x: now, [fp(7)]: now, [fp(8)]: 'soon' } }));
    assert.deepEqual([...new OwnerSignIns({ dir, now: () => now }).map.keys()], [fp(7)]);
    writeFileSync(file, '{');
    assert.equal(new OwnerSignIns({ dir, now: () => now }).map.size, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('offline mode: where the key can be used from (OFFLINE_FROM)', () => {
  assert.equal(parseFrom('any'), null);
  assert.equal(parseFrom('ANY'), null);
  const at = (from) => new Offline({ key: 'twelve chars!', from, auth: {} });
  const home = at('private');
  for (const ip of ['10.1.2.3', '192.168.0.9', '172.20.0.1', '127.0.0.1', '169.254.3.4', '100.100.1.1', '::1', 'fd00::5', 'fe80::1', '::ffff:192.168.1.2']) assert.equal(home.allowedFrom(ip), true, ip);
  for (const ip of ['8.8.8.8', '172.32.0.1', '2001:db8::1', '::ffff:8.8.8.8', '', 'local', 'not an address']) assert.equal(home.allowedFrom(ip), false, ip);
  assert.equal(at('').allowedFrom('10.0.0.1'), true); // (private, unless it's said)
  const list = at('192.168.1.0/24, 2001:db8::/32,10.9.9.9');
  for (const ip of ['192.168.1.200', '2001:db8:5::1', '10.9.9.9']) assert.equal(list.allowedFrom(ip), true, ip);
  for (const ip of ['192.168.2.1', '10.9.9.8', '127.0.0.1']) assert.equal(list.allowedFrom(ip), false, ip);
  assert.equal(at('any').allowedFrom('203.0.113.9'), true);
  for (const bad of ['192.168.1.0/33', 'example.com', '10.0.0.1/', '1.2.3.4/8/9', 'privat', '10.0.0.0/0x8', '::/129']) assert.throws(() => parseFrom(bad), /OFFLINE_FROM/, bad);
});

// Offline mode with plex.tv as `tv` says, and a server that lets this
// container in.
function offlineSetup({ key = 'correct horse battery', open = true } = {}) {
  let now = 1_000_000;
  const tv = { down: true, since: now - OFFLINE_LIMITS.downForMs };
  const auth = {
    tv,
    nudgePlexTv() {},
    plexTvDown: async ({ forMs = 0 } = {}) => tv.down && now - tv.since >= forMs,
    plexTvUpFor: (ms) => !tv.down && now - tv.since >= ms,
    openNow: async () => open,
  };
  const off = new Offline({ key, auth, now: () => now });
  return { off, tv, key, tick: (ms) => (now += ms), at: () => now };
}

test('offline mode: the key only once plex.tv hasn\'t answered for a while, where the server lets this player in, from where it may be used', async () => {
  const { off, tv, key, tick, at } = offlineSetup();
  tv.down = false;
  await assert.rejects(off.signIn(key, '192.168.1.5'), (e) => e.status === 409 && e.reason === 'plex-tv');
  tv.down = true;
  tv.since = at();
  await assert.rejects(off.signIn(key, '192.168.1.5'), (e) => e.status === 409 && e.reason === 'plex-tv'); // (not for long yet)
  tick(OFFLINE_LIMITS.downForMs);
  await assert.rejects(off.signIn(key, '203.0.113.9'), (e) => e.status === 403 && e.reason === 'network');
  await assert.rejects(off.signIn('correct horse batter', '192.168.1.5'), (e) => e.status === 401);
  await assert.rejects(off.signIn({ key }, '192.168.1.5'), (e) => e.status === 401);
  const { token } = await off.signIn(key, '192.168.1.5');
  assert.equal(isOfflineToken(token), true);
  assert.equal(off.valid(token), true);
  assert.equal(off.valid(`pwoff-${'0'.repeat(48)}`), false);
  assert.equal(off.valid('owner-token'), false);
  assert.deepEqual(await off.state('192.168.1.5'), { on: true, plexTv: 'down', why: '' });
  // plex.tv answering again: every session ends, once it has for a while
  tv.down = false;
  tv.since = at();
  assert.equal(off.valid(token), true);
  tick(OFFLINE_LIMITS.endsUpForMs);
  assert.equal(off.valid(token), false);
  assert.equal(off.sessions.size, 0);
  // ...and after 14 days, whatever plex.tv does
  tv.down = true;
  tv.since = at() - OFFLINE_LIMITS.downForMs;
  const later = await off.signIn(key, '192.168.1.6');
  tick(OFFLINE_LIMITS.sessionMs + 1);
  assert.equal(off.valid(later.token), false);
  off.end(later.token);
  // Nothing to play: the key isn't taken
  const shut = offlineSetup({ open: false });
  await assert.rejects(shut.off.signIn(shut.key, '10.0.0.2'), (e) => e.status === 409 && e.reason === 'server');
  // No key: no offline mode
  const none = offlineSetup({ key: '' });
  await assert.rejects(none.off.signIn('', '10.0.0.2'), (e) => e.status === 404);
  assert.equal((await none.off.state('10.0.0.2')).on, false);
});

test('offline mode: a few tries a minute from an address, and once too many wrong keys have come from anywhere, none for the rest of the hour from where one came', async () => {
  const { off, key, tick } = offlineSetup();
  for (let i = 0; i < OFFLINE_LIMITS.triesPerMinute; i++) await assert.rejects(off.signIn('wrong', '10.0.0.1'), (e) => e.status === 401);
  await assert.rejects(off.signIn(key, '10.0.0.1'), (e) => e.status === 429); // (the right one too)
  assert.ok((await off.signIn(key, '10.0.0.2')).token);
  tick(60001);
  assert.ok((await off.signIn(key, '10.0.0.1')).token);
  for (let i = OFFLINE_LIMITS.triesPerMinute; i < OFFLINE_LIMITS.wrongPerHour; i++) await assert.rejects(off.signIn('wrong', `10.0.1.${i}`), (e) => e.status === 401);
  await assert.rejects(off.signIn(key, '10.0.1.9'), (e) => e.status === 429 && /hour/.test(e.message));
  await assert.rejects(off.signIn(key, '10.0.0.1'), (e) => e.status === 429 && /hour/.test(e.message));
  // ...but from anywhere else, the right key: nobody else's wrong ones keep it out
  assert.ok((await off.signIn(key, '10.0.2.1')).token);
  await assert.rejects(off.signIn('wrong', '10.0.2.2'), (e) => e.status === 401);
  await assert.rejects(off.signIn(key, '10.0.2.2'), (e) => e.status === 429 && /hour/.test(e.message));
  tick(3600001);
  assert.ok((await off.signIn(key, '10.0.1.9')).token);
});

test('/pms/: where the Plex server lets this container in, it\'s asked about each request with that sign-in, there and then, never from what it said before', async () => {
  const p = await fakePlex();
  try {
    const auth = new PlexAuth({ plexTvUrl: p.tv, plexServerUrl: p.pms });
    assert.equal(await auth.openNow(), false);
    p.state.open = true;
    p.state.honour = true;
    assert.equal(await auth.openNow(), true);
    // (Asked without a sign-in, for the server to check nothing with plex.tv.)
    assert.ok(p.asked.filter((a) => a.path === '/library/sections').every((a) => a.token === ''));
    const asks = (t) => p.asked.filter((a) => a.token === t).length;
    // Refused both, while it shows them to its owner (a request without a sign-in, asked along): Sam, as himself
    assert.equal(await auth.askOwnersOnly('sam-token'), 'refused');
    assert.equal(await auth.askOwnersOnly('sam-token'), 'refused');
    assert.equal(asks('sam-token'), 4); // (each time)
    const without = asks('');
    await Promise.all([1, 2, 3].map(() => auth.askOwnersOnly('sam-token')));
    assert.equal(asks('sam-token'), 6); // (those at once share an answer)
    assert.equal(asks(''), without + 2); // (the server's own, asked along, too)
    assert.equal(await auth.askOwnersOnly('owner-token'), 'shown');
    assert.equal(await auth.askOwnersOnly('made-up-token'), 'shown'); // (a sign-in it doesn't know: taken for its owner's)
    p.known.delete('sam-token'); // his share taken away
    assert.equal(await auth.askOwnersOnly('sam-token'), 'shown');
    p.known.add('sam-token');
    p.state.honour = false; // a server that takes everyone here for its owner
    assert.equal(await auth.askOwnersOnly('sam-token'), 'shown');
    p.state.honour = true;
    // One that starts showing nobody what only its owner may see: seen there and then, as it's asked along each time, so
    // a refusal says nothing (only the owner gets through, for a while)
    p.state.nobody = true;
    assert.equal(await auth.askOwnersOnly('made-up-token'), 'cant-tell');
    p.state.nobody = false;
    assert.equal(await auth.askOwnersOnly('sam-token'), 'cant-tell');
    // ...or one where some of that isn't there at all
    const other = new PlexAuth({ plexTvUrl: p.tv, plexServerUrl: p.pms });
    p.state.noSessions = true;
    assert.equal(await other.askOwnersOnly('sam-token'), 'cant-tell');
    p.state.noSessions = false;
    // Only Plex's own refusal of a request without a sign-in says the server doesn't let this container in (a 403 from
    // something in front of it says nothing of that)
    p.state.open = false;
    assert.equal(await other.openNow(), false);
    p.state.tokenless = 403;
    await assert.rejects(other.openNow());
    p.state.tokenless = 0;
    p.state.open = true;
    // ...and one that doesn't answer: never a yes (and not asked again for a while)
    const third = new PlexAuth({ plexTvUrl: p.tv, plexServerUrl: p.pms });
    p.state.broken = true;
    await assert.rejects(third.showsOwnersOnly('sam-token'));
    await assert.rejects(third.openNow());
    await assert.rejects(third.askOwnersOnly('sam-token'));
    p.state.broken = false;
    await assert.rejects(third.askOwnersOnly('sam-token'));
  } finally {
    p.close();
  }
});

// What nginx does for the service's own requests to the Plex server (see
// pms-probe in 40-plexamp-web.sh): a socket that passes them on to `target`.
async function socketProxy(dir, target) {
  const path = join(dir, 'plex.sock');
  const t = new URL(target);
  const srv = createServer((req, res) => {
    const up = httpRequest({ host: t.hostname, port: t.port, path: req.url, method: req.method, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    });
    up.on('error', () => {
      res.writeHead(502);
      res.end();
    });
    req.pipe(up);
  });
  await new Promise((r) => srv.listen(path, r));
  chmodSync(path, 0o666); // (as nginx makes it: its folder is what keeps others out)
  return { path, close: () => srv.close() };
}

test('/pms/: a Plex server\'s name with more than one address can\'t be asked for each request, so only the owner gets through then', async () => {
  const p = await fakePlex();
  const sockets = mkdtempSync(join(tmpdir(), 'pw-nginx-'));
  const nginx = await socketProxy(sockets, p.pms);
  let addresses = ['10.0.0.5'];
  let looked = 0;
  const resolve4 = async (name) => {
    looked += 1;
    assert.equal(name, 'plex.test');
    if (!addresses) throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
    return addresses;
  };
  try {
    const auth = new PlexAuth({ plexTvUrl: p.tv, plexServerUrl: 'http://plex.test:32400', pmsProbe: nginx.path, pmsResolver: '10.0.0.1', resolve4 });
    assert.equal(await auth.openNow(), false);
    assert.equal(await auth.openNow(), false);
    assert.equal(looked, 1); // (looked up again a second later at most)
    addresses = ['10.0.0.5', '10.0.0.6', '10.0.0.5'];
    await sleep(1100);
    await assert.rejects(auth.openNow(), /more than one address/);
    addresses = ['10.0.0.6'];
    await sleep(1100);
    await assert.rejects(auth.openNow(), /more than one address/); // (for a while after, as nginx may still have both)
    addresses = null;
    const other = new PlexAuth({ plexTvUrl: p.tv, plexServerUrl: 'http://plex.test:32400', pmsProbe: nginx.path, pmsResolver: '10.0.0.1', resolve4 });
    await assert.rejects(other.openNow(), /couldn't look up plex\.test/);
    // (An address, or a name nginx isn't asked to look up: nothing to look up.)
    const plain = new PlexAuth({ plexTvUrl: p.tv, plexServerUrl: p.pms, pmsResolver: '10.0.0.1', resolve4 });
    looked = 0;
    assert.equal(await plain.openNow(), false);
    assert.equal(looked, 0);
  } finally {
    nginx.close();
    p.close();
    rmSync(sockets, { recursive: true, force: true });
  }
});

test('/pms/: the Plex server is asked the way nginx reaches it, through nginx, never some other way', async () => {
  const there = await fakePlex(); // the server, as nginx reaches it: it lets this container in
  const elsewhere = await fakePlex(); // the same address, some other way (over IPv6, say): it doesn't
  there.state.open = true;
  const dir = mkdtempSync(join(tmpdir(), 'pw-service-'));
  const sockets = mkdtempSync(join(tmpdir(), 'pw-nginx-'));
  chmodSync(sockets, 0o755);
  const nginx = await socketProxy(sockets, there.pms);
  const svc = await startService({ PW_SERVICE_PLEX_SERVER_URL: elsewhere.pms, PW_SERVICE_PMS_PROBE: nginx.path, PW_SERVICE_PLEX_TV_URL: there.tv }, dir);
  const check = (token) =>
    fetch(`${svc.url}/api/internal/pms-auth`, { headers: { 'X-PW-Route': 'internal', 'X-Real-IP': '192.168.1.20', 'X-PW-PMS-Tokens': '1 0', 'X-PW-Plex-Token': token } }).then((r) => r.status);
  try {
    assert.equal(await check('made-up-token'), 401); // (the server nginx reaches would take it for its owner's)
    assert.equal(await check('sam-token'), 403);
    assert.equal(await check('owner-token'), 204);
    assert.equal(elsewhere.asked.length, 0);
    assert.ok(there.asked.some((a) => a.path === '/identity'));
  } finally {
    await svc.stop();
    nginx.close();
    there.close();
    elsewhere.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(sockets, { recursive: true, force: true });
  }
});

test('plex.tv: heard to stop answering and to answer again, not waited on meanwhile, and what it said of the owner kept', async () => {
  const p = await fakePlex();
  const timing = { ...PLEX_TV_TIMING };
  try {
    const auth = new PlexAuth({ plexTvUrl: p.tv, plexServerUrl: p.pms });
    assert.equal(await auth.loadServerId(), 'srv-1');
    assert.equal(auth.ownerLately('owner-token'), false);
    await auth.identify('owner-token');
    await auth.serverAccess('owner-token', 'srv-1');
    await auth.identify('sam-token');
    await auth.serverAccess('sam-token', 'srv-1');
    assert.equal(auth.ownerLately('owner-token'), true);
    assert.equal(auth.ownerLately('sam-token'), false);
    assert.equal(auth.tv.down, false);
    p.state.down = true;
    await assert.rejects(auth.identify('another-token'), (e) => e.down === true);
    assert.equal(auth.tv.down, true);
    assert.equal(await auth.plexTvDown(), true);
    const n = p.tvTokens.length;
    await assert.rejects(auth.identify('yet-another-token'), (e) => e.down === true);
    assert.equal(p.tvTokens.length, n); // (not asked: it isn't answering)
    assert.equal(auth.ownerLately('owner-token'), true); // (what it said is kept as long as ever)
    p.state.down = false;
    assert.equal(await auth.pingPlexTv(), true); // (its ping is asked all the same)
    assert.equal(auth.plexTvUpFor(0), true);
    PLEX_TV_TIMING.retryMs = 0;
    p.close();
    await assert.rejects(auth.identify('one-more-token'), (e) => e.down === true); // (no answer at all)
    assert.equal(auth.tv.down, true);
  } finally {
    Object.assign(PLEX_TV_TIMING, timing);
    p.close();
  }
});

// The service itself (server/index.js), on a port of its own, with these
// settings (PW_SERVICE_*). Run as root, it becomes nginx, as in the
// container: its data folder is made that user's.
async function startService(env, dir) {
  const port = await new Promise((r) => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const { port: p } = probe.address();
      probe.close(() => r(p));
    });
  });
  if (process.getuid?.() === 0) {
    const line = readFileSync('/etc/passwd', 'utf8').split('\n').find((l) => l.startsWith('nginx:'));
    if (line) chownSync(dir, Number(line.split(':')[2]), Number(line.split(':')[3]));
  }
  const child = spawn(process.execPath, [fileURLToPath(new URL('./index.js', import.meta.url)), join(dir, 'no-config.json')], {
    env: { ...process.env, PW_SERVICE_PORT: String(port), PW_SERVICE_DATA_DIR: dir, PW_SERVICE_TOGETHER: 'false', PW_SERVICE_SHARING: 'false', PW_SERVICE_SETTINGS_SYNC: 'false', PW_SERVICE_MISSING_SYNC: 'false', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 200; i++) {
    if (child.exitCode !== null) throw new Error(`the service stopped: ${out}`);
    if (await fetch(`${url}/api/health`).then((r) => r.ok, () => false)) break;
    await sleep(25);
  }
  return {
    url,
    out: () => out,
    stop: () =>
      new Promise((r) => {
        if (child.exitCode !== null) return r();
        child.once('exit', r);
        child.kill('SIGTERM');
      }),
  };
}

test('/pms/, end to end: the owner, friends the server knows as themselves, made-up sign-ins, the notification stream, plex.tv not answering, and the offline key', async () => {
  const p = await fakePlex();
  const dir = mkdtempSync(join(tmpdir(), 'pw-service-'));
  const env = { PW_SERVICE_PLEX_SERVER_URL: p.pms, PW_SERVICE_PLEX_TV_URL: p.tv, PW_SERVICE_OFFLINE_KEY: 'the offline key', PW_SERVICE_OFFLINE_TIMING: '400,1500,100,100' };
  let svc = await startService(env, dir);
  // nginx's check of a request to /pms/: its token (from the query string, or the header), where it came from, how often a
  // token's name is in it (`seen`, as nginx counts: one in the query string, to begin with), whether it's to
  // /security/token (`path`), and whether it asks for a stream.
  const checked = (token, { stream = false, header = false, seen = header ? 0 : 1, path = false, also = {}, asks = '' } = {}) =>
    fetch(`${svc.url}/api/internal/pms-auth${stream ? '/stream' : ''}`, {
      headers: {
        'X-PW-Route': 'internal',
        'X-Real-IP': '192.168.1.20',
        'X-PW-PMS-Tokens': `${seen} ${path ? 1 : 0}`,
        ...(asks ? { 'X-PW-PMS-Stream': asks } : {}),
        ...(header ? { 'X-Plex-Token': token } : { 'X-PW-Plex-Token': token }),
        ...also,
      },
    });
  const check = (token, opts) => checked(token, opts).then((r) => r.status);
  // (What the check tells nginx: an offline-key session's request goes without its sign-in.)
  const offlineSaid = (token, opts) => checked(token, opts).then((r) => r.headers.get('x-pw-pms-offline'));
  try {
    // A server that doesn't let this container in: everything goes through, as Plex checks it.
    assert.equal(await check('owner-token'), 204);
    assert.equal(await check('sam-token'), 204);
    assert.equal(await check('made-up-token'), 204);
    assert.equal(await check('sam-token', { stream: true }), 204);
    assert.equal(await check(''), 401);
    // Then it does (asked each time): only the owner, where it takes everyone here for its owner...
    p.state.open = true;
    assert.equal(await check('owner-token'), 204);
    assert.equal(await check('owner-token', { header: true }), 204);
    assert.equal(await check('sam-token'), 403);
    assert.equal(await check('sam-token', { header: true }), 403);
    assert.equal(await check('made-up-token'), 401);
    // ...and Sam, as himself, where it knows its people's sign-ins: asked each time, so not once his share's taken away
    p.state.honour = true;
    assert.equal(await check('sam-token'), 204);
    assert.equal(await check('made-up-token'), 401);
    assert.equal(await check('sam-token', { stream: true }), 403);
    assert.equal(await check('owner-token', { stream: true }), 204);
    p.known.delete('sam-token');
    assert.equal(await check('sam-token'), 403);
    p.known.add('sam-token');
    assert.equal(await check('sam-token'), 204);
    // ...and only with that one sign-in in the request: nothing Plex might read as another, and take for its owner's
    assert.equal(await check('sam-token', { seen: 2 }), 403); // (a second token, or something like one: X-Plex-Token=…&x-plex-token=…)
    assert.equal(await check('sam-token', { also: { 'X-Plex-Token': 'made-up-token' } }), 401); // (another in the header: that one's checked, and made up)
    assert.equal(await check('sam-token', { header: true, also: { 'X-PW-Plex-Token': 'made-up-token' } }), 403); // (another in the query string)
    assert.equal(await check('sam-token', { header: true, also: { 'X-PW-Plex-Token': 'sam-token' }, seen: 1 }), 204); // (the same in both)
    assert.equal(await check('sam-token', { asks: 'websocket' }), 403); // (a stream, at any path)
    assert.equal(await check('sam-token', { asks: 'events' }), 403);
    assert.equal(await check('owner-token', { seen: 2 }), 204); // (the owner's own: whatever else, it's theirs)
    assert.equal(await check('owner-token', { asks: 'websocket' }), 204);
    // ...and as it's written in the query string, as Plex is given it: never with %-escapes
    assert.equal(await check('sam-token', { also: { 'X-PW-Plex-Token': 'sam%2Dtoken' } }), 403);
    assert.equal(await check('sam-token'), 204);
    assert.equal(await offlineSaid('owner-token'), null);
    // The offline key, while plex.tv is answering: no
    const signIn = (key, ip = '192.168.1.20') =>
      fetch(`${svc.url}/api/offline/session`, { method: 'POST', headers: { 'X-Real-IP': ip, 'Content-Type': 'application/json' }, body: JSON.stringify({ key }) });
    let r = await signIn('the offline key');
    assert.equal(r.status, 409);
    assert.equal((await r.json()).reason, 'plex-tv');
    // (Only as JSON: another site's page can't have a browser send that without asking first.)
    r = await fetch(`${svc.url}/api/offline/session`, { method: 'POST', headers: { 'X-Real-IP': '192.168.1.20', 'Content-Type': 'text/plain' }, body: JSON.stringify({ key: 'the offline key' }) });
    assert.equal(r.status, 415);
    // plex.tv stops answering, and the service restarts meanwhile (nothing in memory): the owner's sign-in is known, as a fingerprint
    await svc.stop();
    assert.ok(!readFileSync(join(dir, 'owners.json'), 'utf8').includes('owner-token'));
    p.state.down = true;
    svc = await startService(env, dir);
    assert.equal(await check('owner-token'), 204);
    assert.equal(await check('sam-token'), 204); // (the server knows him)
    assert.equal(await check('made-up-token'), 503); // (can't be told: refused)
    p.state.honour = false;
    assert.equal(await check('sam-token'), 503);
    p.state.honour = true;
    // The offline key: once plex.tv hasn't answered for a while, from where it may be used
    await sleep(450);
    r = await signIn('not the offline key');
    assert.equal(r.status, 401);
    r = await signIn('the offline key', '203.0.113.7');
    assert.equal(r.status, 403);
    r = await signIn('the offline key');
    assert.equal(r.status, 200);
    const { token } = await r.json();
    assert.equal(await check(token), 204);
    // ...its requests going to the server without its sign-in (nginx leaves it out, as the check says), and only as the
    // app sends them: not the notification stream, nor Plex's own sign-ins (they'd outlast the session), and with
    // nothing else in them Plex might read as a sign-in
    assert.equal(await offlineSaid(token), '1');
    assert.equal(await offlineSaid(token, { header: true }), '1');
    assert.equal(await check(token, { stream: true }), 403);
    assert.equal(await check(token, { asks: 'events' }), 403);
    assert.equal(await check(token, { path: true, seen: 2 }), 403);
    assert.equal(await check(token, { seen: 2 }), 403);
    const state = (t) => fetch(`${svc.url}/api/offline`, { headers: { 'X-Real-IP': '192.168.1.20', ...(t ? { 'X-Plex-Token': t } : {}) } }).then((x) => x.json());
    assert.deepEqual(await state(token), { configured: true, on: true, plexTv: 'down', why: '', session: 'on' });
    // ...never a Plex sign-in anywhere else, nor sent to plex.tv
    assert.equal((await fetch(`${svc.url}/api/devices`, { headers: { 'X-Plex-Token': token } })).status, 403);
    assert.equal(p.tvTokens.includes(token), false);
    // plex.tv answering again: the session ends once it has for a while
    p.state.down = false;
    await sleep(150);
    assert.equal((await state(token)).plexTv, 'up');
    assert.equal(await check(token), 204);
    await sleep(1600);
    assert.equal(await check(token), 401);
    assert.deepEqual(await state(token), { configured: true, on: false, plexTv: 'up', why: 'plex-tv', session: 'ended' });
    // Signed out: gone
    r = await fetch(`${svc.url}/api/offline/session`, { method: 'DELETE', headers: { 'X-Plex-Token': token } });
    assert.equal(r.status, 204);
  } finally {
    await svc.stop();
    p.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('/pms/: nobody else\'s requests keep the owner out, a sign-in\'s many requests at once ask plex.tv once, and friends are told from those who can\'t use the server', async () => {
  const p = await fakePlex();
  const dir = mkdtempSync(join(tmpdir(), 'pw-service-'));
  const env = { PW_SERVICE_PLEX_SERVER_URL: p.pms, PW_SERVICE_PLEX_TV_URL: p.tv };
  let svc = await startService(env, dir);
  const check = (token, ip = '192.168.1.20') =>
    fetch(`${svc.url}/api/internal/pms-auth`, { headers: { 'X-PW-Route': 'internal', 'X-Real-IP': ip, 'X-PW-PMS-Tokens': '1 0', 'X-PW-Plex-Token': token } }).then((r) => r.status);
  const resources = (t) => p.tvAsked.filter((a) => a.path === '/api/v2/resources' && a.token === t).length;
  const taken = /took someone else's Plex sign-in, from this container, for yours/;
  try {
    p.state.open = true;
    p.state.honour = true;
    // A server that knows its people takes a sign-in it doesn't know for its owner's: one that can't use it is
    // refused, and that's nothing to say in the log
    assert.equal(await check('alex-token'), 403);
    assert.doesNotMatch(svc.out(), taken);
    // The owner's many requests at once (a page of pictures): plex.tv is asked once
    const all = await Promise.all(Array.from({ length: 20 }, () => check('owner-token')));
    assert.ok(all.every((x) => x === 204), all.join(' '));
    assert.equal(resources('owner-token'), 1);
    // Restarted (nothing in memory but what plex.tv said was the owner's sign-in, by its fingerprint), with a server
    // that takes everyone here for its owner's
    await svc.stop();
    svc = await startService(env, dir);
    p.state.honour = false;
    // A friend's many requests are counted once: the address can still have new sign-ins checked
    for (let i = 0; i < 70; i++) assert.equal(await check('sam-token', '192.168.1.30'), 403);
    assert.equal(await check('made-up-token-0', '192.168.1.30'), 401);
    assert.match(svc.out(), taken); // (why friends are refused, for the owner)
    // Made-up sign-ins from the owner's address, as many as it takes to use up what it may have checked...
    for (let i = 1; i <= 70; i++) await check(`made-up-token-${i}`);
    assert.equal(await check('made-up-token-99'), 503);
    // ...don't keep the owner out: asked about again (and plex.tv asked), but not counted
    assert.equal(await check('owner-token'), 204);
    assert.equal(resources('owner-token'), 2);
    // A server whose answer to a request without a sign-in says nothing (a 403, from something in front of it): it
    // can't be told whether it lets this container in, so the owner gets through, as plex.tv says, and nobody else
    await svc.stop();
    svc = await startService(env, dir);
    p.state.tokenless = 403;
    assert.equal(await check('sam-token'), 503);
    assert.equal(await check('made-up-token-100'), 503);
    assert.equal(await check('owner-token'), 204);
  } finally {
    await svc.stop();
    p.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- MusicBrainz features: artists of the same name ----------

test('MusicBrainz features: an artist\'s albums told from those of another artist of their name, only on plain evidence', () => {
  let n = 0;
  const g = (title, date, primary = 'Album') => ({ id: `00000000-0000-4000-8000-${String((n += 1)).padStart(12, '0')}`, title, primary, secondary: [], date });
  const producer = [g('Bloom', '2015-01-01'), g('Fierce', '2017-02-02'), g('Never Give Up', '2019-03-03')];
  const rapper = { id: 'r', name: 'Maduk', groups: [g('Cocaine', '2026-01-01'), g('Evolution', '2025-05-05'), g('Vício', '2025-06-06'), g('Madrugz', '2023-01-01'), g('Fierce', '2017-01-01')] };
  const page = [
    { id: 1, title: 'Bloom', year: 2015 },
    { id: 2, title: 'Fierce', year: 2017 }, // (the rapper has one of that title too: stays)
    { id: 3, title: 'Never Give Up (Remastered)', year: 2020 },
    { id: 4, title: 'Cocaine', year: 2026 },
    { id: 5, title: 'Evolution', year: 2024 }, // (within a year)
    { id: 6, title: 'Vicio', year: 2025 },
    { id: 7, title: 'Madrugz', year: 2020 }, // (another year: which it is can't be told)
    { id: 8, title: 'Unreleased Demos', year: 2021 }, // (no one's on MusicBrainz)
    { id: 9, title: 'Evolution Part 2', year: 2025 }, // (only near the rapper's: not enough)
    { id: 10, title: 'Cocaine', year: null }, // (no year: not enough)
  ];
  const ids = (m) => [...m.keys()].sort((a, b) => a - b);
  // Plex says who the page's artist is: the rapper's three, apart
  const apart = apartFromNamesakes(page, { groups: producer, byId: true, namesakes: [rapper] });
  assert.deepEqual(ids(apart), ['4', '5', '6']);
  assert.equal(apart.get('4'), rapper);
  // ...and nothing where MusicBrainz has nothing of the page for them
  assert.equal(apartFromNamesakes(page, { groups: [], byId: true, namesakes: [rapper] }).size, 0);
  assert.equal(apartFromNamesakes(page, { groups: producer, byId: true, namesakes: [] }).size, 0);
  // Without Plex's word: only where more of the page is theirs than the other's (three each here: nothing)
  assert.equal(apartFromNamesakes(page, { groups: producer, namesakes: [rapper] }).size, 0);
  assert.deepEqual(ids(apartFromNamesakes(page.filter((it) => it.id !== 6), { groups: producer, namesakes: [rapper] })), ['4', '5']);
  // ...and two of theirs at least
  assert.equal(apartFromNamesakes([page[0], page[3]], { groups: producer, namesakes: [rapper] }).size, 0);
  assert.deepEqual(ids(apartFromNamesakes([page[0], page[3]], { groups: producer, byId: true, namesakes: [rapper] })), ['4']);
  // Two other artists of the name with the album: which it is can't be told
  const another = { id: 'x', name: 'Maduk', groups: [g('Cocaine', '2026-03-03')] };
  assert.deepEqual(ids(apartFromNamesakes(page, { groups: producer, byId: true, namesakes: [rapper, another] })), ['5', '6']);
  // Never an album titled as the artist is (artists of one name have those by construction)
  const selfTitled = { id: 's', name: 'Maduk', groups: [g('Maduk', '2019-01-01')] };
  const withOwn = [...page, { id: 11, title: 'Maduk', year: 2020 }];
  assert.deepEqual(ids(apartFromNamesakes(withOwn, { groups: producer, byId: true, namesakes: [selfTitled] })), ['11']); // (were the name not said)
  assert.equal(apartFromNamesakes(withOwn, { name: 'Maduk', groups: producer, byId: true, namesakes: [selfTitled] }).size, 0);
  assert.equal(apartFromNamesakes(withOwn, { name: 'MADUK', groups: producer, byId: true, namesakes: [selfTitled] }).size, 0);
  // ...and nothing where what MusicBrainz lists of either isn't all they have
  assert.equal(apartFromNamesakes(page, { name: 'Maduk', groups: producer, capped: true, byId: true, namesakes: [rapper] }).size, 0);
  assert.equal(apartFromNamesakes(page, { name: 'Maduk', groups: producer, byId: true, namesakes: [{ ...rapper, capped: true }] }).size, 0);
  assert.deepEqual(ids(apartFromNamesakes(page, { name: 'Maduk', groups: producer, byId: true, namesakes: [rapper] })), ['4', '5', '6']);
});

test('MusicBrainz features: other artists of a name, and their release groups, looked up once and kept', async () => {
  const asked = [];
  const ids = { a: '11111111-1111-4111-8111-111111111111', b: '22222222-2222-4222-8222-222222222222', c: '33333333-3333-4333-8333-333333333333' };
  const fetchImpl = async (url) => {
    const u = new URL(url);
    asked.push(`${u.pathname}?${u.searchParams.get('query') || u.searchParams.get('artist') || ''}`);
    let body = {};
    if (u.pathname === '/ws/2/artist') {
      body = { artists: [
        { id: ids.a, name: 'Maduk', disambiguation: 'Dutch drum & bass producer', score: 100 },
        { id: ids.b, name: 'Maduk', disambiguation: 'Brazilian rapper', score: 100 },
        { id: ids.c, name: 'Maduk Collective', score: 90 },
        { id: '89ad4ac3-39f7-470e-963a-56509c546377', name: 'Maduk', score: 80 },
      ] };
    } else if (u.pathname === '/ws/2/release-group') {
      body = { 'release-group-count': 1, 'release-groups': [{ id: '44444444-4444-4444-8444-444444444444', title: u.searchParams.get('artist') === ids.b ? 'Cocaine' : 'Bloom', 'primary-type': 'Album', 'first-release-date': '2026-01-01' }] };
    }
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  };
  const mb = new MusicBrainz({ base: 'http://mb.test', fetchImpl, gapMs: 0 }).advanced(new MBKept());
  const others = await mb.namesakes('Maduk', { but: ids.a });
  assert.deepEqual(others.map((a) => [a.id, a.name, a.note, a.groups.map((x) => x.title)]), [[ids.b, 'Maduk', 'Brazilian rapper', ['Cocaine']]]);
  assert.match(asked[0], /^\/ws\/2\/artist\?artist:"Maduk" OR sortname:"Maduk"$/);
  const n = asked.length;
  await mb.namesakes('Maduk', { but: ids.b });
  assert.equal(asked.length, n + 1); // (the search kept: only the other's release groups asked for)
  assert.deepEqual(await mb.namesakes('Various Artists'), []);
});
