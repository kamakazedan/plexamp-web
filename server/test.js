// Unit tests for the service: node --test server/test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { Together, cleanTrack, TogetherError } from './together.js';
import { redact, oneLine } from './log.js';
import { cleanSyslogLine } from './syslog.js';
import { Cast, CastError, privateAddress, parseTimeline } from './cast.js';
import { isPlexDirectCert, plexServerIdentity, certProblem, PlexAuth, readCapped } from './plex.js';
import { cleanChat, SharedModel, AIRequestError, AI_LIMITS, errorText } from './ai.js';
import { plainPath, clientIp } from './paths.js';
import { MusicBrainz, MusicBrainzError, isPublic } from './musicbrainz.js';
import { Shares, ShareError, mergeTracks, withUnseen, missingFrom, SHARE_LIMITS, LEASE_MS } from './shares.js';
import { Spotify, SpotifyError, SPOTIFY_LIMITS, playlistId, shortCode, embedPlaylist, trackOf } from './spotify.js';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  d.sweep();
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
