import { useEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { html, Button, Icon, MicroLabel, DifficultyIcon } from '../ui/components.js';
import { LobbyHeader } from '../ui/lobbyHeader.js';
import { net, NetError } from '../net.js';
import { useStore, loadPref, savePref, serverNow } from '../store.js';
import { useData, getConfig } from '../data.js';
import { lobbyVersion, offeredDifficulties, fallbackDifficulty } from '../versions.js';
import { toastError } from '../ui/toasts.js';
import { DIFFICULTIES, DIFFICULTY_NAMES, DIFFICULTY_COLORS } from '../../../shared/constants.js';
import { t, tc } from '../../../shared/i18n.js';
import { difficultyInfo } from './lobby.js';
function DifficultyCard({ roomMode, difficulty, selected, onSelect, disabled = false }) {
  const info = difficultyInfo(roomMode, difficulty);
  return html`<button type="button" class=${`diff-card${selected ? ' is-selected' : ''}`}
      style=${`--d-color:${DIFFICULTY_COLORS[difficulty]}`} disabled=${disabled} onClick=${() => onSelect(difficulty)} aria-pressed=${selected ? 'true' : 'false'}>
    <span class="diff-card__bar" aria-hidden="true"></span>
    <span class="diff-card__head">
      <${DifficultyIcon} difficulty=${difficulty} class="diff-card__glyph" />
      <span class="diff-card__name">${t(DIFFICULTY_NAMES[difficulty])}</span>
      <span class="diff-card__code num">${info.code}</span>
      <span class="diff-card__meta">
        <span class="num">${info.rounds}</span> ${tc('rounds', '回合')}${info.hidden ? html`<span class="diff-card__hidden">${t('+ 隐秘核心')}</span>` : null}
      </span>
    </span>
    <span class="diff-card__desc">${info.desc}</span>
    <span class="diff-card__effects">${info.effects.map((e) => html`<span key=${e}>${e}</span>`)}${info.stageNote ? html`<span key="stage" class="diff-card__stage"><${Icon} name="rook" />${info.stageNote}</span>` : null}</span>
    <span class="diff-card__check" aria-hidden="true"><${Icon} name="check" /><span>${t('已选定')}</span></span>
  </button>`;
}

/** Start opens the directory; creation and key entry reuse the existing protocol screen. */
export function MatchmakingScreen({ onBack }) {
  const online = useStore(s => s.connection.status === 'online');
  useData('config');
  const version = useStore(lobbyVersion);
  const difficulties = offeredDifficulties(getConfig(), 'coop');
  const [difficulty, setDifficulty] = useState(() => {
    const d = loadPref('lobby.difficulty', 'FUNNY');
    return DIFFICULTIES.includes(d) ? d : 'FUNNY';
  });
  const [search, setSearch] = useState(null);
  const [now, setNow] = useState(serverNow);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    const off = net.on('match.state', msg => {
      setSearch(msg.searching ? msg : null);
      setNow(serverNow());
      if (msg.error) toastError(new NetError(msg.error));
    });
    return () => { alive.current = false; off(); net.send('match.cancel'); };
  }, []);
  useEffect(() => { if (!online) setSearch(null); }, [online]);
  useEffect(() => {
    if (!search) return;
    const timer = setInterval(() => setNow(serverNow()), 250);
    return () => clearInterval(timer);
  }, [search]);
  const run = async (cancel, back = false) => {
    if (pending.current) return;
    if (!online) { if (back) onBack(); return; }
    pending.current = true;
    setBusy(true);
    try {
      await net.request(cancel ? 'match.cancel' : 'match.start', cancel ? {} : { difficulty: fallbackDifficulty(difficulties, difficulty), version });
      if (back && alive.current) onBack();
    } catch (err) { toastError(err); }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  };
  const remaining = search ? Math.max(0, Math.ceil((search.deadlineAt - now) / 1000)) : 30;
  const locked = !!search || busy;
  return html`<div class="screen lobby-screen matchmaking-screen">
    <${LobbyHeader} title=${t('匹配房间')} micro="ALLIANCE MATCHMAKING" onBack=${() => run(true, true)} backTitle=${t('返回服务器大厅')} />
    <main class="matchmaking-body screen__scroll">
      <section class="matchmaking-difficulty">
        <div class="section-label"><span class="section-label__idx num">01</span>${t('模拟难度')}<${MicroLabel}>DIFFICULTY<//></div>
        <div class="diff-list">${difficulties.map(d => html`<${DifficultyCard} key=${d} roomMode="coop" difficulty=${d}
          selected=${difficulty === d} disabled=${locked} onSelect=${d => { setDifficulty(d); savePref('lobby.difficulty', d); }} />`)}</div>
      </section>
      <section class=${`matchmaking-status brackets${search ? ' is-searching' : ''}`} aria-label=${t('匹配状态')}>
        <${MicroLabel} tone="mint">ALLIANCE NETWORK<//>
        <div class="matchmaking-radar" aria-hidden="true"><${Icon} name="search" /></div>
        <h2>${search ? t('正在寻找同盟…') : t('集结你的同盟')}</h2>
        <p>${t('自动加入相同难度的公开等待房间，30 秒内未找到则创建新同盟。')}</p>
        <div class="matchmaking-clock" role="status" aria-live="polite">${search
          ? html`<strong class="num">${remaining}</strong><span>${t('秒后自动创建同盟')}</span>`
          : html`<span>${online ? t('选择难度，准备开始匹配') : t('连接中断，请稍候重试')}</span>`}</div>
        <div class="matchmaking-progress" aria-hidden="true"><i style=${`width:${search ? (30 - remaining) / 30 * 100 : 0}%`}></i></div>
        <${Button} variant=${search ? 'secondary' : 'primary'} size="xl" icon=${search ? 'close' : 'search'}
          loading=${busy} disabled=${!online || busy} onClick=${() => run(!!search)}>${search ? t('取消匹配') : t('开始匹配')}<//>
        <span class="matchmaking-note">${t('取消或断开连接后停止匹配，不会自动创建房间。')}</span>
      </section>
    </main>
  </div>`;
}
