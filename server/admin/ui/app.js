// i18n-ignore-file: owner console is a standalone Simplified Chinese interface.
const $ = id => document.getElementById(id);
let token = sessionStorage.getItem('sp.admin.session') || '';
let current = null, draftRevision = null, dirty = false, pending = false, loading = false, confirmAction = null;
const date = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';
const bytes = value => {
  if (!Number.isFinite(value)) return '不可用';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let index = 0;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index++; }
  return `${value.toFixed(index ? 1 : 0)} ${units[index]}`;
};
function node(tag, text, cls) {
  const item = document.createElement(tag);
  if (text != null) item.textContent = String(text);
  if (cls) item.className = cls;
  return item;
}
function message(text, error = false) { $('message').textContent = text; $('message').className = error ? 'error' : ''; }
function signedIn(on) {
  $('dashboard').hidden = !on; $('login-card').hidden = on; $('logout').hidden = !on;
  if (!on) { token = ''; sessionStorage.removeItem('sp.admin.session'); }
}
async function api(route, value) {
  const response = await fetch(`/api/${route}`, {
    method: value === undefined ? 'GET' : 'POST', cache: 'no-store', credentials: 'omit',
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(value === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: value === undefined ? undefined : JSON.stringify(value), signal: AbortSignal.timeout(15000),
  });
  const result = await response.json();
  if (!response.ok) { if (response.status === 401) signedIn(false); throw new Error(result.error || `请求失败 (${response.status})`); }
  return result;
}
function button(text, action, danger = false) {
  const b = node('button', text, danger ? 'danger' : '');
  b.type = 'button'; b.addEventListener('click', action); return b;
}
function ask(title, detail, action, ban = false) {
  $('confirm-title').textContent = title; $('confirm-text').textContent = detail;
  $('ban-fields').hidden = !ban; $('ban-reason').value = ''; $('ban-ip').checked = false;
  confirmAction = action; $('confirm-dialog').showModal();
}
async function mutate(route, input, success) {
  if (pending) return;
  pending = true;
  try { await api(route, input); message(success); await refresh(); }
  catch (error) { message(error.message, true); }
  finally { pending = false; }
}
function metric(title, value, detail) {
  const card = node('article', null, 'metric');
  card.append(node('span', title), node('b', value), node('small', detail));
  return card;
}
function render(state) {
  current = state;
  const m = state.metrics, memory = m.memory, disk = m.disk, net = m.network;
  const percent = (a, b) => b ? `${(100 * a / b).toFixed(1)}%` : '采样中';
  $('metrics').replaceChildren(
    metric('CPU 占用', m.cpuPercent == null ? '采样中' : `${m.cpuPercent.toFixed(1)}%`, `${m.cores || '—'} 核 · 运行 ${Math.floor(state.uptimeSec / 3600)} 小时`),
    metric('内存占用', memory ? percent(memory.used, memory.total) : '采样中', memory ? `${bytes(memory.used)} / ${bytes(memory.total)} · 游戏 ${bytes(memory.processRss)}` : '读取中'),
    metric('磁盘占用', disk ? percent(disk.used, disk.total) : '不可用', disk ? `${bytes(disk.used)} / ${bytes(disk.total)} · 可用 ${bytes(disk.available)}` : '无法读取文件系统'),
    metric('实时网速', net?.upBytesPerSec != null ? `↑ ${bytes(net.upBytesPerSec)}/s` : '不可用',
      net?.downBytesPerSec != null ? `↓ ${bytes(net.downBytesPerSec)}/s · 网卡累计发送 ${bytes(net.sentBytes)}` : 'Linux 网卡采样中'),
  );
  $('updated').textContent = `更新于 ${new Date(state.now).toLocaleTimeString('zh-CN')}`;
  $('player-count').textContent = `${state.players.filter(p => p.online).length} 人在线`;
  $('player-rows').replaceChildren(...state.players.map(p => {
    const row = node('tr'), name = node('td', p.name);
    name.append(node('small', p.id));
    const status = node('td'); status.append(node('span', p.online ? '在线' : '离线保留', `badge${p.online ? '' : ' offline'}`));
    const actions = node('td');
    actions.append(button('踢出', () => ask('踢出玩家', `将 ${p.name} 移出当前房间并断开连接。`, () => mutate('player/kick', { id: p.id }, '玩家已踢出'))),
      button('拉黑', () => ask('封禁玩家', `封禁 ${p.name} 并立即断开连接，记录在重启后仍保留。`, () => mutate('ban/add',
        { id: p.id, reason: $('ban-reason').value, withIp: $('ban-ip').checked }, '玩家已封禁'), true), true));
    row.append(name, status, node('td', p.room || '大厅'), node('td', p.ip), node('td', date(p.lastSeen)), actions); return row;
  }));
  if (!state.players.length) { const row = node('tr'); const cell = node('td', '当前没有玩家', 'empty'); cell.colSpan = 6; row.append(cell); $('player-rows').append(row); }
  $('room-count').textContent = `${state.rooms.length} 个房间`;
  $('room-cards').replaceChildren(...state.rooms.map(r => {
    const card = node('article', null, 'room'), head = node('div', null, 'section-head');
    head.append(node('h3', `#${r.number} · ${r.code}`), node('span', r.inMatch ? '进行中' : '等待中', 'badge'));
    const list = node('ul');
    list.append(...r.players.map(p => node('li', `${p.name}${p.bot ? ' · AI' : p.online ? ' · 在线' : ' · 离线'}`)));
    card.append(head, node('p', `${r.mode === 'solo' ? '单人' : '合作'} / ${r.difficulty} / ${r.isPublic ? '公开' : '私密'}`),
      node('small', `${r.phase} · 第 ${r.round} 回合 · ${r.spectators} 人观战`), list,
      button('关闭房间', () => ask('关闭房间', `关闭 ${r.code} 会终止这间房的对局，并将所有成员移回大厅。`,
        () => mutate('room/close', { code: r.code }, '房间已关闭')), true));
    return card;
  }));
  if (!state.rooms.length) $('room-cards').append(node('p', '当前没有房间', 'empty'));
  $('ban-rows').replaceChildren(...state.bans.map(b => {
    const row = node('tr'), name = node('td', b.name); name.append(node('small', b.playerId));
    const actions = node('td');
    actions.append(button('解除封禁', () => ask('解除封禁', `允许 ${b.name} 的原身份${b.ip ? '及此记录的 IP' : ''}重新进入。`,
      () => mutate('ban/remove', { id: b.id }, '封禁已解除'))));
    row.append(name, node('td', b.ip ? `身份 + ${b.ip}` : '玩家身份'), node('td', b.reason || '未填写'), node('td', date(b.createdAt)), actions);
    return row;
  }));
  $('audit-list').replaceChildren(...state.audit.map(a => {
    const row = node('div', null, 'audit-row'); row.append(node('time', date(a.at)), node('span', a.action)); return row;
  }));
  if (!dirty) {
    $('notice-title').value = state.draft.title; $('notice-body').value = state.draft.body; draftRevision = state.revision;
  }
  $('publish-state').textContent = state.published ? `已发布 · ${date(state.published.publishedAt)}` : '尚未发布';
  $('published-preview').replaceChildren(...(state.published
    ? [node('h4', state.published.title), node('p', state.published.body)] : [node('p', '暂无公开公告')]));
}
async function refresh() {
  if (!token || loading) return;
  loading = true;
  try { const state = await api('state'); signedIn(true); render(state); }
  catch (error) { message(error.message, true); }
  finally { loading = false; }
}
$('login').addEventListener('submit', async event => {
  event.preventDefault(); if (pending) return; pending = true;
  try {
    const result = await api('login', { password: $('password').value });
    token = result.token; sessionStorage.setItem('sp.admin.session', token); $('password').value = '';
    message('登录成功'); dirty = false; await refresh();
  } catch (error) { message(error.message, true); }
  finally { pending = false; }
});
$('logout').addEventListener('click', async () => {
  try { await api('logout', {}); } catch { /* local credentials are cleared even if the network is unavailable */ }
  finally { signedIn(false); message('已退出'); }
});
$('refresh').addEventListener('click', refresh);
for (const tab of document.querySelectorAll('[data-tab]')) tab.addEventListener('click', () => {
  for (const item of document.querySelectorAll('[data-tab]')) item.classList.toggle('active', item === tab);
  for (const panel of document.querySelectorAll('.tab')) panel.hidden = panel.id !== tab.dataset.tab;
});
for (const id of ['notice-title', 'notice-body']) $(id).addEventListener('input', () => { dirty = true; });
$('announcement-form').addEventListener('submit', async event => {
  event.preventDefault(); if (pending) return; pending = true;
  try {
    await api('announcement/draft', { title: $('notice-title').value, body: $('notice-body').value, revision: draftRevision });
    dirty = false; message('草稿已保存，点击发布后玩家才能看到'); await refresh();
  } catch (error) { message(error.message, true); }
  finally { pending = false; }
});
$('publish').addEventListener('click', () => {
  if (dirty) { message('请先保存草稿，再发布', true); return; }
  ask('发布服务器公告', '将已保存草稿显示在所有玩家的主页和服务器大厅。', () => mutate('announcement/publish', { revision: current.revision }, '公告已发布'));
});
$('unpublish').addEventListener('click', () => ask('撤下服务器公告', '公开页面将不再显示公告，草稿仍保留。', () => mutate('announcement/unpublish', {}, '公告已撤下')));
$('cancel').addEventListener('click', () => { confirmAction = null; $('confirm-dialog').close(); });
$('confirm-form').addEventListener('submit', async event => { event.preventDefault(); const action = confirmAction; confirmAction = null; $('confirm-dialog').close(); await action?.(); });
setInterval(() => { if (!document.hidden && !$('confirm-dialog').open) void refresh(); }, 5000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
if (token) void refresh();
