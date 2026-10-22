// Touch (外勤医疗) AI policy switch and adapter: Match option `botTouchPolicy`, 'experimental' (default) or 'legacy'.
// experimental: the band pick takes Touch second, after 伊奥莱塔·罗素 (bot.js botPickBand), and a Touch seat runs the
// strategy core (botTouchPolicy.js) through bot.js's shop policy; legacy keeps the generic bot.
import { parseKey, pieceDir } from './board.js';
import { touchTinmanMove } from './botTouchPolicy.js';

export const TOUCH_BAND = 'band_amedic';
export const touchPolicyOn = (m) => m?.botTouchPolicy === 'experimental';

/** Move the deployed 锡人 onto Touch's heal range (touchTinmanMove's tiles in order); true when a move went through. */
export function placeTinmanInTouchRange(m, ps) {
  const plan = touchTinmanMove(m, ps);
  if (!plan) return false;
  for (const k of plan.keys) {
    const [row, col] = parseKey(k);
    const res = ps.move(plan.piece.uid, { area: 'board', row, col }, pieceDir(plan.piece));
    if (res?.ok) return true;
  }
  return false;
}
