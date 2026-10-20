// Unit tests for the service: node --test server/test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { Together, cleanTrack, TogetherError } from './together.js';
import { redact, oneLine } from './log.js';
import { cleanSyslogLine } from './syslog.js';
import { Cast, CastError, privateAddress, parseTimeline } from './cast.js';
import { isPlexDirectCert, plexServerIdentity, certProblem } from './plex.js';
import { cleanChat, SharedModel, AIRequestError, AI_LIMITS } from './ai.js';
import { MusicBrainz, MusicBrainzError, isPublic } from './musicbrainz.js';
import { createServer } from 'node:http';

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
  assert.deepEqual(out, {
    model: 'gemma4:12b',
    messages: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'Hello' }],
    stream: true,
    format: { type: 'object' },
    options: { temperature: 2, num_ctx: 32768, num_predict: 20 },
    think: false,
    keep_alive: '3600s',
  });
  assert.equal(cleanChat({ messages: [{ role: 'user', content: 'x' }], keep_alive: '-1' }, 'm').keep_alive, undefined);
  assert.equal(cleanChat({ messages: [{ role: 'user', content: 'x' }], format: 'json' }, 'm').format, 'json');
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
    await assert.rejects(m.load('nope'), (e) => e instanceof AIRequestError && e.status === 404 && /not found/.test(e.message));
  } finally {
    ollama.close();
  }
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
