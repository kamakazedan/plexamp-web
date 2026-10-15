// Unit tests for the service: node --test server/test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { Together, cleanTrack, TogetherError } from './together.js';
import { redact, oneLine } from './log.js';
import { cleanSyslogLine } from './syslog.js';

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
