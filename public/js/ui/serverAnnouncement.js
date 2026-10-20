import { useEffect, useState } from '../../vendor/hooks.module.js';
import { html } from './components.js';
import { t } from '../../../shared/i18n.js';

/** Only the public, published document; draft and owner APIs use a different port. */
export function ServerAnnouncement() {
  const [announcement, setAnnouncement] = useState(null);
  useEffect(() => {
    let live = true, busy = false;
    let controller = null;
    const refresh = async () => {
      if (busy || document.hidden) return;
      busy = true;
      controller = new AbortController();
      const timeout = setTimeout(() => controller?.abort(), 10000);
      try {
        const response = await fetch('/api/announcement', { cache: 'no-store', signal: controller.signal });
        if (!response.ok) return;
        const result = await response.json();
        if (live) setAnnouncement(result.announcement || null);
      } catch { /* retain last published notice during a brief network loss */ }
      finally { clearTimeout(timeout); controller = null; busy = false; }
    };
    void refresh();
    const timer = setInterval(refresh, 30000);
    document.addEventListener('visibilitychange', refresh);
    return () => { live = false; clearInterval(timer); controller?.abort(); document.removeEventListener('visibilitychange', refresh); };
  }, []);
  if (!announcement) return null;
  return html`<aside class="server-announcement" data-testid="server-announcement" aria-label=${t('服务器公告')}>
    <div class="server-announcement__head"><span>${t('服务器公告')}</span><time>${new Date(announcement.publishedAt).toLocaleDateString()}</time></div>
    <details open><summary>${announcement.title}</summary><p>${announcement.body}</p></details>
  </aside>`;
}
