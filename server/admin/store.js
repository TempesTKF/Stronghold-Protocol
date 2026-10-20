// Persistent owner-managed announcements and bans. Never served as a static file.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const tokenHash = (token) => createHash('sha256').update(token).digest('hex');
export const adminError = (status, message) => Object.assign(new Error(message), { status });
export function announcementInput(value) {
  if (!value || typeof value.title !== 'string' || typeof value.body !== 'string'
    || value.title.length > 120 || value.body.length > 12000) throw adminError(400, '公告标题最多 120 字，正文最多 12000 字');
  return { title: value.title.trim(), body: value.body.trim() };
}

export function createAdminStore(file) {
  let state = { version: 1, revision: 0, draft: { title: '', body: '' }, published: null, bans: [], audit: [] };
  if (fs.existsSync(file)) {
    state = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (state.version !== 1 || !Array.isArray(state.bans) || !Array.isArray(state.audit)
      || !Number.isInteger(state.revision)) throw new Error('Invalid admin state');
    announcementInput(state.draft);
  }
  function change(action, mutate) {
    const next = structuredClone(state);
    mutate(next);
    next.revision++;
    next.audit.push({ at: Date.now(), action });
    next.audit = next.audit.slice(-200);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
      fs.renameSync(temp, file);
    } finally {
      if (fs.existsSync(temp)) fs.unlinkSync(temp);
    }
    state = next;
  }
  return {
    get: () => structuredClone(state),
    public: () => ({ announcement: state.published }),
    blocked: ({ token, ip }) => state.bans.some(b =>
      (b.ip && b.ip === ip) || (token && b.tokenHash === tokenHash(token))),
    saveDraft(value, revision) {
      if (revision !== state.revision) throw adminError(409, '内容已被其他操作更新，请刷新后重试');
      const draft = announcementInput(value);
      change('保存公告草稿', s => { s.draft = draft; });
    },
    publish(revision) {
      if (revision !== state.revision) throw adminError(409, '内容已更新，请刷新后重试');
      if (!state.draft.title || !state.draft.body) throw adminError(400, '请先保存完整的公告标题和正文');
      change('发布公告', s => { s.published = { ...s.draft, id: randomUUID(), publishedAt: Date.now() }; });
    },
    unpublish() { change('撤下公告', s => { s.published = null; }); },
    ban(session, reason, withIp) {
      if (state.bans.length >= 5000) throw adminError(409, '封禁记录已达上限');
      if (withIp && (!session.addr || session.addr === '?')) throw adminError(400, '此玩家的 IP 不可用');
      const hash = tokenHash(session.token);
      change(`封禁玩家 ${session.playerId}`, s => {
        s.bans = s.bans.filter(b => b.tokenHash !== hash);
        s.bans.push({ id: randomUUID(), playerId: session.playerId, name: session.name,
          tokenHash: hash, ip: withIp ? session.addr : null, reason, createdAt: Date.now() });
      });
    },
    unban(id) {
      if (!state.bans.some(b => b.id === id)) throw adminError(404, '封禁记录不存在');
      change(`解除封禁 ${id}`, s => { s.bans = s.bans.filter(b => b.id !== id); });
    },
    record: (action) => change(action, () => {}),
  };
}
