import { Fragment } from '../../vendor/preact.module.js';
import { useState } from '../../vendor/hooks.module.js';
import { html, Button, Icon, MicroLabel, PingPill, AvatarFrame, doctorNo } from './components.js';
import { ResumeMatchButton } from './resumeMatch.js';
import { GuideButton } from './guide.js';
import { SettingsButton } from './settings.js';
import { PwaInstallButton } from './device.js';
import { LoadoutButton } from '../screens/loadout.js';
import { openStats } from '../screens/stats.js';
import { SweepReport } from '../screens/sweep.js';
import { NoticesButton } from './notices.js';
import { useStore, shallowEqual } from '../store.js';
import { t } from '../../../shared/i18n.js';

/** Shared chrome for the server directory and the original protocol selection screen. */
export function LobbyHeader({ title, micro, onBack, backTitle }) {
  const me = useStore((s) => s.me, shallowEqual);
  const conn = useStore((s) => s.connection, shallowEqual);
  const [sweepOpen, setSweepOpen] = useState(false);
  return html`<${Fragment}><header class="topbar">
    <div class="topbar__left">
      <${Button} variant="ghost" size="sm" icon="chevronLeft" onClick=${onBack} title=${backTitle}>${t('返回')}<//>
      <${PingPill} ms=${conn.ping} online=${conn.status === 'online'} />
      <span class="topbar__sep" aria-hidden="true"></span>
      <div class="topbar__tools">
        <${NoticesButton} />
        <${SettingsButton} class="lobby-settings" variant="secondary" square=${true} />
        <${GuideButton} class="lobby-guide" variant="secondary" square=${true} />
        <${PwaInstallButton} class="lobby-pwa" square=${true} />
      </div>
    </div>
    <div class="topbar__center">
      <${MicroLabel} tone="mint">${micro}<//>
      <h1 class="topbar__title">${title}</h1>
    </div>
    <div class="topbar__right">
      <${ResumeMatchButton} />
      <${Button} variant="secondary" size="sm" icon="book" class="lobby-sweep" onClick=${() => setSweepOpen(true)}
        title=${t('S.W.E.E.P.报告：盟约、策略与敌方资料')}>S.W.E.E.P.<//>
      <${LoadoutButton} from="lobby" size="sm" class="lobby-loadout" label=${t('干员调配')} />
      <button type="button" class="me-chip me-chip--btn stats-entry" onClick=${openStats} title=${t('统计数据')} aria-label=${t('统计数据')}>
        <${AvatarFrame} size="sm" name=${me.name} seat=${0} self=${true} />
        <span class="me-chip__text">
          <span class="me-chip__name">${me.name || t('博士')}</span>
          <${MicroLabel}>${me.playerId != null ? `DOCTOR #${doctorNo(me.playerId)}` : 'DOCTOR'}<//>
        </span>
        <${Icon} name="chart" class="me-chip__stats" />
      </button>
    </div>
  </header>
  ${sweepOpen ? html`<${SweepReport} onClose=${() => setSweepOpen(false)} />` : null}
  <//>`;
}
