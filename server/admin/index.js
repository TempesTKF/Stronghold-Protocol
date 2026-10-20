// Owner console on its own HTTP listener. Bearer sessions, never cross-port cookies.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAdminAuth } from './auth.js';
import { adminError, createAdminStore } from './store.js';
import { createMetrics } from './metrics.js';
import { clientAddress } from '../net.js';

const UI = fileURLToPath(new URL('./ui/', import.meta.url));
const ASSETS = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };

export function adminOptions(root, supplied) {
  if (supplied === false) return null;
  if (supplied) return supplied;
  if (!process.env.SP_ADMIN_CONFIG) return null;
  const config = JSON.parse(fs.readFileSync(process.env.SP_ADMIN_CONFIG, 'utf8'));
  return { ...config, stateFile: config.stateFile || path.join(root, '.admin', 'state.json') };
}

async function bodyJson(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw adminError(415, '需要 JSON 请求');
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 65536) throw adminError(413, '请求内容过大');
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('shape');
    return value;
  } catch { throw adminError(400, '无效的 JSON'); }
}
function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

export function createAdmin({ options, root, registry, lobby, network, startedAt, log }) {
  const auth = createAdminAuth(options.password);
  const state = createAdminStore(options.stateFile || path.join(root, '.admin', 'state.json'));
  const metrics = createMetrics({ root });
  const disconnect = (session) => {
    // Explicit departure removes the human seat rather than retaining an offline room.
    lobby.leave(session);
    const conn = network.conns.get(session.ws);
    if (conn) conn.close(1008, 'removed by administrator');
  };
  function snapshot() {
    const players = [...registry.all()].filter(s => s.connected || s.roomCode).map(s => ({
      id: s.playerId, name: s.name, online: s.connected, ip: s.addr, room: s.roomCode,
      lastSeen: s.lastSeen, disconnectedAt: s.disconnectedAt,
    }));
    const rooms = [...lobby.rooms.values()].filter(r => !r.disposed).map(r => {
      let view = null;
      try { view = r.matchCtx?.lastPublic ? JSON.parse(r.matchCtx.lastPublic) : null; } catch { /* pending view */ }
      return { code: r.code, number: r.number, mode: r.mode, difficulty: r.difficulty, isPublic: r.isPublic,
        inMatch: !!r.match, phase: r.match?.phase || view?.phase || 'LOBBY', round: r.match?.round ?? view?.round ?? 0,
        createdAt: r.createdAt, host: r.hostId,
        players: r.seats.filter(s => s && !s.left).map(s => ({ id: s.playerId, name: s.name, bot: s.isBot, online: s.connected })),
        spectators: r.spectators.length };
    });
    const stored = state.get();
    return { now: Date.now(), uptimeSec: (Date.now() - startedAt) / 1000, players, rooms,
      metrics: metrics.snapshot(), revision: stored.revision, draft: stored.draft, published: stored.published,
      bans: stored.bans.map(({ tokenHash: _secret, ...ban }) => ban), audit: stored.audit.slice(-50).reverse() };
  }

  async function handle(req, res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    const raw = (req.url || '').split('?')[0];
    if (req.method === 'GET' && Object.hasOwn(ASSETS, raw)) {
      const [file, type] = ASSETS[raw];
      res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store' });
      res.end(fs.readFileSync(path.join(UI, file))); return;
    }
    if (!raw.startsWith('/api/')) { json(res, 404, { error: '不存在' }); return; }
    // NAT changes the port, not the browser's Host header. No permissive CORS.
    const origin = req.headers.origin;
    let same = false;
    try { same = new URL(origin).host === req.headers.host && /^https?:$/.test(new URL(origin).protocol); } catch { /* non-browser clients may omit Origin */ }
    if (origin && !same) throw adminError(403, '跨站请求被拒绝');
    if (req.headers['sec-fetch-site'] === 'cross-site') throw adminError(403, '跨站请求被拒绝');
    if (req.method === 'POST' && raw === '/api/login') {
      const input = await bodyJson(req);
      const result = await auth.login(input.password, req.socket.remoteAddress || '?');
      json(res, result.status || 200, result); return;
    }
    const token = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization || '')?.[1];
    if (!auth.valid(token)) throw adminError(401, '请先登录');
    if (req.method === 'GET' && raw === '/api/state') { json(res, 200, snapshot()); return; }
    if (req.method !== 'POST') throw adminError(405, '不支持的请求方法');
    const input = await bodyJson(req);
    if (raw === '/api/logout') { auth.logout(token); json(res, 200, { ok: true }); return; }
    if (raw === '/api/announcement/draft') state.saveDraft(input, input.revision);
    else if (raw === '/api/announcement/publish') state.publish(input.revision);
    else if (raw === '/api/announcement/unpublish') state.unpublish();
    else if (raw === '/api/ban/remove') state.unban(input.id);
    else if (raw === '/api/room/close') {
      const room = lobby.rooms.get(input.code);
      if (!room || room.disposed) throw adminError(404, '房间已不存在');
      state.record(`关闭房间 ${room.code}`);
      lobby.disposeRoom(room, 'admin');
    } else if (raw === '/api/player/kick' || raw === '/api/ban/add') {
      const session = registry.byId(input.id);
      if (!session) throw adminError(404, '玩家已离线或会话已过期');
      if (raw === '/api/ban/add') {
        if (typeof input.reason !== 'string' || input.reason.length > 300 || typeof input.withIp !== 'boolean') throw adminError(400, '无效封禁参数');
        state.ban(session, input.reason.trim(), input.withIp);
        for (const other of [...registry.all()]) if (other === session || (input.withIp && other.addr === session.addr)) disconnect(other);
      } else { state.record(`踢出玩家 ${session.playerId}`); disconnect(session); }
    } else throw adminError(404, '不存在');
    json(res, 200, { ok: true, revision: state.get().revision });
  }
  const server = http.createServer((req, res) => {
    handle(req, res).catch(error => {
      if (!error.status) log.error('[admin] request failed', error);
      if (!res.headersSent) json(res, error.status || 500, { error: error.status ? error.message : '服务器操作失败' });
      else res.destroy();
    });
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  return {
    state, snapshot, server,
    blocked: (token, ip) => state.blocked({ token, ip }),
    deniedRequest: req => state.blocked({ ip: clientAddress(req, network.opts.trustProxy).ip }),
    async listen() {
      const port = options.port ?? 3001;
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid admin port');
      await new Promise((resolve, reject) => {
        const fail = e => reject(e);
        server.once('error', fail);
        server.listen(port, options.host || '127.0.0.1', () => { server.off('error', fail); resolve(); });
      });
      server.on('error', e => log.error('[admin] listener', e));
      return server.address();
    },
    async close() {
      auth.close(); metrics.close();
      if (server.listening) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    },
  };
}
