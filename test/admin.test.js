import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { startServer } from '../server/index.js';
import { StubMatch } from '../server/match/StubMatch.js';
import { TestClient } from './helpers/wsClient.js';
import { createAdminStore } from '../server/admin/store.js';
import { passwordRecord, createAdminAuth } from '../server/admin/auth.js';
import { createServiceHistory, probeGameServer } from '../server/admin/history.js';

test('admin HTTP isolation, announcement publication, moderation and durable bans', async t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-admin-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const file = path.join(folder, 'state.json');
  const password = await passwordRecord('test-password-123');
  const srv = await startServer({ host: '127.0.0.1', port: 0, quiet: true, assetIndex: false, studio: false,
    MatchClass: StubMatch, admin: { port: 0, host: '127.0.0.1', password, stateFile: file } });
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.admin.server.address().port}`;
  let token = '';
  async function call(route, body, extra = {}) {
    const r = await fetch(base + '/api/' + route, { method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...extra },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, data: await r.json() };
  }
  assert.equal((await call('state')).status, 401);
  assert.equal((await call('login', { password: 'bad' })).status, 401);
  assert.equal((await call('login', { password: 'test-password-123' }, { Origin: srv.url })).status, 403);
  const login = await call('login', { password: 'test-password-123' }, { Origin: base });
  assert.equal(login.status, 200); token = login.data.token;
  assert.equal(token.length, 64);
  const gameAdmin = await fetch(srv.url + '/api/state', { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(gameAdmin.status, 404);
  assert.equal((await fetch(srv.url + '/admin/')).status, 404);
  const s0 = (await call('state')).data;
  assert.equal(s0.published, null);
  assert.equal(s0.serviceHistory.buckets.length, 48);
  assert.equal(s0.serviceHistory.lastCheck.ok, true, 'the game health check is sampled without a browser');
  assert.equal(s0.serviceHistory.buckets.at(-1).healthy, 1);
  assert.equal((await call('announcement/draft', { title: '<b>公告</b>', body: '<script>alert(1)</script>\n测试', revision: s0.revision })).status, 200);
  assert.equal((await (await fetch(srv.url + '/api/announcement')).json()).announcement, null, 'draft is private');
  assert.equal((await call('announcement/publish', { revision: s0.revision })).status, 409);
  const s1 = (await call('state')).data;
  assert.equal((await call('announcement/publish', { revision: s1.revision })).status, 200);
  const notice = (await (await fetch(srv.url + '/api/announcement')).json()).announcement;
  assert.equal(notice.title, '<b>公告</b>');
  assert.equal(notice.body, '<script>alert(1)</script>\n测试');
  assert.deepEqual(createAdminStore(file).public().announcement, notice);
  assert.equal((await call('announcement/unpublish', {})).status, 200);
  assert.equal((await (await fetch(srv.url + '/api/announcement')).json()).announcement, null);
  assert.equal((await call('announcement/draft', { title: 'x'.repeat(121), body: 'test', revision: (await call('state')).data.revision })).status, 400);
  const player = await TestClient.connect(srv.url.replace('http', 'ws') + '/ws');
  const guest = await TestClient.connect(srv.url.replace('http', 'ws') + '/ws');
  t.after(async () => { await player.terminate(); await guest.terminate(); });
  const owner = await player.hello('管理员测试甲');
  const visitor = await guest.hello('管理员测试乙');
  await player.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' });
  const room = await player.waitFor('room.state');
  await guest.request({ t: 'room.join', code: room.code });
  const view = (await call('state')).data;
  assert.equal(view.players.length, 2);
  assert.equal(view.rooms.length, 1);
  assert.ok(!JSON.stringify(view).includes(owner.token), 'never disclose reconnect tokens');
  await guest.request({ t: 'room.ready', ready: true });
  assert.equal((await player.request({ t: 'room.start' })).t, 'ok');
  assert.ok(srv.lobby.rooms.get(room.code).match, 'exercise closing a running match');
  assert.equal((await call('room/close', { code: room.code })).status, 200);
  assert.equal((await player.waitFor('room.closed')).reason, 'admin');
  assert.equal((await guest.waitFor('room.closed')).reason, 'admin');
  assert.equal(srv.lobby.rooms.size, 0);
  assert.equal(srv.lobby.offlineTimers.size, 0);
  await player.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' });
  await player.waitFor('room.state');
  assert.equal((await call('ban/add', { id: owner.playerId, reason: 'test', withIp: false })).status, 200);
  assert.equal((await player.closed).code, 1008);
  assert.equal(srv.lobby.rooms.size, 0);
  assert.equal(createAdminStore(file).blocked({ token: owner.token }), true, 'ban survives restart');
  const denied = await TestClient.connect(srv.url.replace('http', 'ws') + '/ws');
  denied.ws.send(JSON.stringify({ t: 'hello', name: '重连测试', token: owner.token, version: 1 }));
  assert.equal((await denied.closed).code, 1008);
  const banned = (await call('state')).data.bans;
  assert.equal(banned.length, 1); assert.equal(banned[0].tokenHash, undefined);
  assert.equal((await call('ban/remove', { id: banned[0].id })).status, 200);
  const resumed = await TestClient.connect(srv.url.replace('http', 'ws') + '/ws');
  t.after(() => resumed.terminate());
  assert.equal((await resumed.hello('恢复', owner.token)).playerId, owner.playerId);
  assert.equal((await call('ban/add', { id: visitor.playerId, reason: 'ip', withIp: true })).status, 200);
  await guest.closed; await resumed.closed;
  await assert.rejects(TestClient.connect(srv.url.replace('http', 'ws') + '/ws'), /403/);
  const ipBan = (await call('state')).data.bans[0];
  assert.equal((await call('ban/remove', { id: ipBan.id })).status, 200);
  assert.equal((await call('logout', {})).status, 200);
  assert.equal((await call('state')).status, 401);
});

test('without configured admin, game serves no announcement or owner API', async t => {
  const srv = await startServer({ host: '127.0.0.1', port: 0, quiet: true, admin: false, studio: false, assetIndex: false });
  t.after(() => srv.close());
  assert.equal(srv.admin, null);
  assert.deepEqual(await (await fetch(srv.url + '/api/announcement')).json(), { announcement: null });
  assert.equal((await fetch(srv.url + '/server/admin/ui/index.html')).status, 404);
});

test('admin rate limits failed passwords and rejects invalid stored credentials', async () => {
  assert.throws(() => createAdminAuth({ salt: 'bad', hash: 'bad' }));
  const auth = createAdminAuth(await passwordRecord('secret'));
  for (let i = 0; i < 5; i++) assert.equal((await auth.login('wrong', 'test-ip')).status, 401);
  assert.equal((await auth.login('secret', 'test-ip')).status, 429);
  const other = await auth.login('secret', 'other-ip');
  assert.ok(auth.valid(other.token));
  auth.logout(other.token); assert.equal(auth.valid(other.token), false);
});

test('admin bind failure closes the already-bound game listener', async () => {
  const occupied = http.createServer();
  await new Promise(resolve => occupied.listen(0, '127.0.0.1', resolve));
  const port = occupied.address().port;
  try {
    await assert.rejects(startServer({ host: '127.0.0.1', port: 0, assetIndex: false, studio: false, quiet: true,
      admin: { port, host: '127.0.0.1', password: await passwordRecord('test') } }), { code: 'EADDRINUSE' });
  } finally { await new Promise(resolve => occupied.close(resolve)); }
});

test('48-hour history preserves observations across restarts and leaves gaps unknown', async t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-history-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const file = path.join(folder, 'service-history.jsonl');
  let clock = Date.UTC(2026, 9, 30, 12), healthy = true;
  const create = () => createServiceHistory({ file, now: () => clock, probe: async () => healthy, sampleMs: 3_600_000 });
  let history = create();
  await history.start();
  let view = history.snapshot();
  assert.equal(view.buckets.length, 48);
  assert.equal(view.buckets.filter(b => b.status === 'unknown').length, 47);
  assert.deepEqual({ status: view.buckets.at(-1).status, healthy: view.buckets.at(-1).healthy, missing: view.buckets.at(-1).missing },
    { status: 'partial', healthy: 1, missing: 59 });
  for (let i = 1; i < 60; i++) { clock += 60_000; await history.sample(); }
  assert.equal(history.snapshot().buckets.at(-1).status, 'healthy', 'a full observed hour is healthy');
  clock += 60_000; healthy = false; await history.sample();
  assert.equal(history.snapshot().buckets.at(-1).status, 'failed');
  healthy = true; await history.sample();
  assert.equal(history.snapshot().buckets.at(-1).failed, 1, 'a later success cannot erase a failure in the same minute');
  await history.close();
  // Simulate a partial final write followed by a period in which no monitoring ran.
  fs.appendFileSync(file, '{"minute":');
  clock += 10 * 60_000;
  history = create();
  await history.start();
  view = history.snapshot();
  assert.equal(view.buckets.at(-1).failed, 1, 'failed observation survives restart');
  assert.equal(view.buckets.at(-1).missing, 9, 'unmonitored minutes are not labeled failures');
  await history.close();
  history = create();
  await history.start();
  assert.equal(history.snapshot().buckets.at(-1).failed, 1, 'repairing a partial line keeps prior observations');
  await history.close();
  clock += 49 * 60 * 60_000;
  history = create();
  await history.start();
  view = history.snapshot();
  assert.equal(view.buckets.filter(b => b.status === 'unknown').length, 47);
  assert.equal(view.buckets.at(-1).healthy, 1);
  await history.close();
  assert.ok(fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length < 3, 'expired history is compacted');
});

test('local probe checks the health response and reports failed or unavailable listeners', async t => {
  let reply = { status: 200, body: '{"ok":true}' };
  const server = http.createServer((_req, res) => { res.writeHead(reply.status); res.end(reply.body); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { if (server.listening) server.close(); });
  assert.equal(await probeGameServer(server), true);
  reply = { status: 503, body: '{"ok":true}' };
  assert.equal(await probeGameServer(server), false);
  reply = { status: 200, body: '{broken' };
  assert.equal(await probeGameServer(server), false);
  await new Promise(resolve => server.close(resolve));
  assert.equal(await probeGameServer(server), false);
});

test('history storage failure is reported without preventing live checks', async t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-history-unwritable-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const history = createServiceHistory({ file: folder, probe: async () => true, log: {}, sampleMs: 3_600_000 });
  await history.start();
  assert.equal(history.snapshot().storageOk, false);
  assert.equal(history.snapshot().lastCheck.ok, true);
  await history.close();
});
