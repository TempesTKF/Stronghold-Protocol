import { useEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { html, Button, Icon, MicroLabel, Tabs, TextField, DifficultyTag, AvatarFrame, Spinner } from '../ui/components.js';
import { LobbyHeader } from '../ui/lobbyHeader.js';
import { ServerAnnouncement } from '../ui/serverAnnouncement.js';
import { net } from '../net.js';
import { useStore } from '../store.js';
import { toastError } from '../ui/toasts.js';
import { PHASE_NAMES } from '../../../shared/constants.js';
import { t } from '../../../shared/i18n.js';

const REFRESH_MS = 3000;

function useDirectory(online) {
  const [state, setState] = useState({ snapshot: null, refreshing: true, error: false });
  const refresh = useRef(() => {});
  useEffect(() => {
    let disposed = false;
    let pending = false;
    let timer;
    let controller;
    const load = async () => {
      if (disposed || pending) return;
      clearTimeout(timer);
      pending = true;
      controller = new AbortController();
      const deadline = setTimeout(() => controller.abort(), 8000);
      setState((s) => ({ ...s, refreshing: true }));
      try {
        const response = await fetch('/api/lobby', { cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw new Error('Directory unavailable');
        const snapshot = await response.json();
        if (!snapshot.ok || !Array.isArray(snapshot.rooms)) throw new Error('Invalid directory');
        if (!disposed) setState({ snapshot, refreshing: false, error: false });
      } catch {
        if (!disposed) setState((s) => ({ ...s, refreshing: false, error: true }));
      } finally {
        clearTimeout(deadline);
        pending = false;
        if (!disposed) timer = setTimeout(() => {
          if (document.visibilityState === 'hidden') { timer = setTimeout(load, REFRESH_MS); return; }
          load();
        }, REFRESH_MS);
      }
    };
    refresh.current = load;
    const visible = () => { if (document.visibilityState === 'visible') load(); };
    document.addEventListener('visibilitychange', visible);
    load();
    return () => {
      disposed = true;
      clearTimeout(timer);
      controller?.abort();
      document.removeEventListener('visibilitychange', visible);
    };
  }, [online]);
  return { ...state, refresh: () => refresh.current() };
}

function ServerStat({ value, label, micro, icon, tone = 'mint' }) {
  return html`<div class=${`server-stat server-stat--${tone} brackets`}>
    <span class="server-stat__icon"><${Icon} name=${icon} /></span>
    <div class="server-stat__text"><span>${label}</span><${MicroLabel}>${micro}<//></div>
    <strong class="server-stat__number num">${value ?? '—'}</strong>
  </div>`;
}

function DirectoryRoom({ room, online, busy, onEnter }) {
  const solo = room.mode === 'solo';
  const phaseName = t(PHASE_NAMES[room.phase] || '模拟进行中');
  const action = room.inMatch ? 'spectate' : 'join';
  const available = room.inMatch ? room.canSpectate : room.canJoin;
  return html`<article class=${`server-room${room.inMatch ? ' is-running' : ''}`} aria-label=${t('同盟编号 {number}', { number: room.number })}>
    <div class="server-room__identity">
      <span class="server-room__emblem"><${Icon} name=${solo ? 'user' : 'users'} /></span>
      <div class="server-room__name"><strong>${t(solo ? '{name}的独立模拟' : '{name}的同盟', { name: room.hostName || t('博士') })}</strong>
        <span class="server-room__key"><${Icon} name="users" /><span class="num">${room.number}</span></span>
      </div>
    </div>
    <div class="server-room__protocol">
      <span>${solo ? t('独立模拟') : t('同盟模拟')}</span>
      <${DifficultyTag} difficulty=${room.difficulty} />
    </div>
    <div class="server-room__members">
      <div class="server-room__avatars">${room.players.map((player, i) => html`<span key=${i}
        class=${player.connected || player.isBot ? '' : 'is-offline'} title=${`${player.name}${player.isBot ? ' · AI' : player.connected ? '' : ` · ${t('离线')}`}`}>
        <${AvatarFrame} size="sm" name=${player.name} seat=${i} bot=${player.isBot} />
      </span>`)}</div>
      <span class="server-room__occupancy"><b class="num">${room.playerCount}</b><span class="num t-lo"> / ${room.capacity}</span>
        <span class="server-room__spectators"><${Icon} name="eye" /><span class="num">${room.spectatorCount} / ${room.spectatorCapacity}</span></span>
      </span>
    </div>
    <div class="server-room__status">
      <span class=${`server-room__badge${room.inMatch ? ' is-running' : ''}`}><i></i>${room.inMatch ? t('模拟进行中') : t('等待中')}</span>
      <span class="server-room__phase">${room.inMatch
        ? `${room.round > 0 ? t('第 {n} 回合', { n: room.round }) + ' · ' : ''}${phaseName}`
        : solo ? t('独立模拟房间') : room.canJoin ? t('等待博士加入') : t('博士席位已满')}</span>
    </div>
    <div class="server-room__actions">
      ${solo ? html`<span class="server-room__private"><${Icon} name="user" />${t('独立模拟')}</span>`
        : html`<${Button} variant=${room.inMatch ? 'amber' : 'primary'} size="md" icon=${room.inMatch ? 'eye' : 'users'}
          disabled=${!online || !!busy || !available} loading=${busy === `${action}:${room.directoryId}`}
          onClick=${() => onEnter(room, action)}>
          ${room.inMatch ? room.canSpectate ? t('观战') : t('观战席已满') : room.canJoin ? t('加入同盟') : t('席位已满')}<//>`}
    </div>
  </article>`;
}

export function ServerDirectory({ onCreate, onJoin, onMatch, onBack }) {
  const online = useStore((s) => s.connection.status === 'online');
  const { snapshot, refreshing, error, refresh } = useDirectory(online);
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(null);
  const pending = useRef(false);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  const query = search.trim().toLowerCase();
  const listed = snapshot?.rooms || [];
  const waiting = listed.filter(room => !room.inMatch).length;
  const rooms = listed.filter((room) =>
    (filter === 'all' || (filter === 'running' ? room.inMatch : !room.inMatch)) &&
    (!query || `${room.number} ${room.hostName}`.toLowerCase().includes(query)));
  const enter = async (room, action) => {
    if (!online || pending.current) return;
    pending.current = true;
    setBusy(`${action}:${room.directoryId}`);
    try { await net.request('room.enter', { directoryId: room.directoryId, spectate: action === 'spectate' }); }
    catch (err) { toastError(err); if (alive.current) refresh(); }
    finally { pending.current = false; if (alive.current) setBusy(null); }
  };
  return html`<div class="screen lobby-screen server-directory">
    <${LobbyHeader} title=${t('服务器大厅')} micro="SERVER LOBBY" onBack=${onBack} backTitle=${t('返回标题')} />
    <div class="server-body screen__scroll">
      <${ServerAnnouncement} />
      <div class="server-overview__head">
        <div class="section-label"><span class="section-label__idx num">01</span>${t('服务器概况')}<${MicroLabel}>SERVER STATUS<//></div>
        <span class=${`server-live${error || !online ? ' is-stale' : ''}`} role="status"><i></i>${error ? t('更新失败，显示上次数据') : online ? t('已连接 · 每 3 秒自动更新') : t('正在连接服务器…')}</span>
      </div>
      <section class="server-stats" aria-label=${t('服务器概况')}>
        <${ServerStat} value=${snapshot?.onlinePlayers} label=${t('在线人数')} micro="DOCTORS ONLINE" icon="user" />
        <${ServerStat} value=${snapshot?.roomCount} label=${t('房间总数')} micro="ALL ALLIANCES" icon="users" />
        <${ServerStat} value=${snapshot?.waitingRooms} label=${t('等待中的房间')} micro="AWAITING DEPLOYMENT" icon="info" />
        <${ServerStat} value=${snapshot?.runningRooms} label=${t('进行中的房间')} micro="SIMULATION IN PROGRESS" icon="rook" tone="amber" />
      </section>

      <section class="server-create brackets" aria-label=${t('创建或加入同盟')}>
        <span class="server-create__icon"><${Icon} name="users" /></span>
        <div class="server-create__text"><${MicroLabel} tone="mint">ESTABLISH AN ALLIANCE<//>
          <h2>${t('集结同盟，准备出发')}</h2><p>${t('创建你的同盟，或加入下方等待中的房间，与其他博士一起开始模拟。')}</p></div>
        <div class="server-create__actions">
          <${Button} variant="amber" size="lg" icon="search" onClick=${onMatch}>${t('匹配房间')}<//>
          <${Button} variant="primary" size="lg" icon="plus" iconRight="chevrons" onClick=${onCreate}>${t('创建同盟')}<//>
          <${Button} variant="secondary" size="lg" icon="key" onClick=${onJoin}>${t('密钥 / 邀请链接加入')}<//>
        </div>
      </section>

      <section class="server-rooms" aria-label=${t('同盟列表')}>
        <div class="server-rooms__heading"><div class="section-label"><span class="section-label__idx num">02</span>${t('同盟列表')}<${MicroLabel}>ALLIANCE DIRECTORY<//></div>
          <span class="server-rooms__count num">${rooms.length} / ${listed.length}</span></div>
        <div class="server-toolbar">
          <${Tabs} value=${filter} onChange=${setFilter} items=${[
            { id: 'all', label: t('全部同盟'), badge: listed.length },
            { id: 'waiting', label: t('等待中'), badge: waiting },
            { id: 'running', label: t('模拟进行中'), badge: listed.length - waiting },
          ]} />
          <div class="server-toolbar__tools"><${TextField} icon="search" value=${search} onInput=${setSearch} label=${t('搜索同盟')} placeholder=${t('搜索编号 / 房主昵称')} />
            <${Button} size="sm" icon="refresh" loading=${refreshing} onClick=${refresh} title=${t('刷新房间列表')}>${t('刷新')}<//></div>
        </div>
        <div class="server-list-head" aria-hidden="true"><span>${t('同盟 / 编号')}</span><span>${t('模拟协议')}</span><span>${t('成员 / 观战')}</span><span>${t('游戏状态')}</span><span>${t('操作')}</span></div>
        <div class="server-room-list" aria-busy=${refreshing ? 'true' : 'false'}>
          ${rooms.length ? rooms.map((room) => html`<${DirectoryRoom} key=${room.directoryId} room=${room} online=${online && !error} busy=${busy} onEnter=${enter} />`)
            : html`<div class="server-empty" role="status"><span class="server-empty__icon"><${Icon} name="users" /></span>
              ${!snapshot && refreshing ? html`<${Spinner} label=${t('正在读取服务器房间…')} />`
                : html`<h3>${!snapshot && error ? t('暂时无法获取房间列表') : query || filter !== 'all' ? t('没有符合条件的同盟') : t('暂无同盟，等待你的集结')}</h3>
                  <p>${!snapshot && error ? t('请检查服务器连接，或点击刷新重试。') : query || filter !== 'all' ? t('试试其他编号、昵称或房间状态。') : t('点击上方「创建同盟」，发起本服务器的第一场模拟。')}</p>`}
            </div>`}
        </div>
        <div class="server-rooms__foot"><span><${Icon} name="info" />${t('等待中的同盟可直接加入；模拟已开始时可进入观战席。')}</span>
          <${MicroLabel}>${snapshot ? `STRONGHOLD PROTOCOL · V${snapshot.app}` : 'STRONGHOLD PROTOCOL'}<//></div>
      </section>
    </div>
  </div>`;
}
