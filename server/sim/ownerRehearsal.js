export { rehearsalCap } from './rehearsal.js';
export function rehearsalLimits(o = {}) {
  const int = (v) => Number.isInteger(v) && v > 0 ? v : 0;
  return { stage: Math.min(8, int(o?.stage)), tickBudget: int(o?.tickBudget) };
}
