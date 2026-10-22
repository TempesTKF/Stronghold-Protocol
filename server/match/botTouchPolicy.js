// Touch (外勤医疗) AI strategy core: Touch 迅捷锡人 — an elite 锡人 wearing 源石溶剂 beside three 坚守, three 精准 and two
// 迅捷 (player guide: 星梦明月夜, 「邪修兜底打法：Touch迅，下限很高，上限不明」, BV1CqDBBuEJT). All numeric scores and round
// limits are [ASSUMED]. Reads own holdings, visible offers and public stock; no hidden shops or future waves.
// Pure decisions only: it reads m / ps / gd and board.js and imports no bot code, so the same core serves every bot
// framework; botTouch.js and bot.js apply the decisions (the Match option botTouchPolicy switches it).
import { inField, ownerRangeKeys, parseKey, tileKey } from './board.js';

export const TOUCH_ELITE_VALUE = 24;
export const TOUCH_PARAMS = Object.freeze({
  exitL1MinRound: 3,       // 找到溶剂后再升本: not before R3
  exitL1Round: 5,          // no 源石溶剂 by then: level anyway
  exitL2Round: 10,         // 二本持续刷新，直到锡人进阶
  l4UpgradeRound: 9,
  l5UpgradeRound: 11,
  l6UpgradeRound: 13,
  itemHoldRound: 12,       // 源石溶剂 waits in the hand for a 锡人 until then
  eliteTinmanLineup: 20,   // lineup bonus per deployed elite 锡人
  tinmanLineup: 8,         // per deployed normal 锡人
  planLineup: 5,           // per other deployed plan target (三坚守、三精准、两迅捷)
  touchLineup: 15,         // two deployed elites: Touch replaces the reserve medic at battle start
  solvent: 30,             // 源石溶剂 while a 锡人 without one is owned, or before any 锡人
  favoredItem: 10,         // 炎国短刀 / 阿戈尔重刃 while a 锡人 has room
  coreFirst: 20,
  corePair: 30,
  coreMerge: 48,
  tinmanExtra: 10,
  singleFirst: 16,
  surplusCopy: -160,
});

export const TOUCH_OPS = Object.freeze({
  tinman: 'chess_char_2_19_a',
  // 三精准
  jumping: 'chess_char_1_09_a', indigo: 'chess_char_1_17_a', executor: 'chess_char_2_01_a',
  // 三坚守
  branch: 'chess_char_2_17_a', cuora: 'chess_char_3_16_a', gummy: 'chess_char_1_10_a', bubble: 'chess_char_2_08_a',
  tippi: 'chess_char_2_13_a',
  // 后期：莱恩哈特、缇缇、妮芙、引星棘刺、异客
  reinhardt: 'chess_char_4_14_a', titi: 'chess_char_5_02_a', nymph: 'chess_char_5_22_a', ashlock: 'chess_char_5_15_a',
  stranger: 'chess_char_6_05_a',
});

// 源石溶剂、炎国短刀、阿戈尔重刃 (both qualities)
export const TOUCH_ITEMS = Object.freeze(['chess_item_1_05_e', 'chess_item_3_04_e', 'chess_item_3_07_e']);
export const touchFavoredItem = (id) => TOUCH_ITEMS.some((p) => String(id).startsWith(p));
export const isSolvent = (id) => String(id).startsWith(TOUCH_ITEMS[0]);

const GOALS = Object.freeze({ steadShip: 3, preciShip: 3, swiftShip: 2 });
const WEIGHT = { steadShip: 12, preciShip: 10, swiftShip: 8 };

// [ASSUMED] The shop part (purchases, level-ups, searches, item and lineup weights: TOUCH_POLICY) is off for now
// (2026-10-22): a Touch seat buys and levels like the generic bot; the band pick, item carriers and the 锡人 move stay.
export const TOUCH_SHOP_ON = false;

export const touchEnabled = (m, ps) => m?.botTouchPolicy === 'experimental' && ps?.bandId === 'band_amedic';

// public match information: the mode's static exclusions and the drawn disabled bonds
const bondOff = (m, ps, id) => (ps.gd || m.gd).modeInactiveBonds.has(id)
  || (m.disabledBonds instanceof Set ? m.disabledBonds.has(id) : (m.disabledBonds || []).includes(id));

// holdings / stock helpers as in botDuskPolicy.js
function holdings(gd, ps, ctx = {}) {
  const normal = ctx.copies || new Map();
  const elites = new Set();
  for (const p of ps.allChess()) {
    const base = gd.baseIdOf(p.id);
    if (gd.isGolden(p.id)) elites.add(base);
    else if (!ctx.copies) normal.set(base, (normal.get(base) || 0) + 1);
  }
  return { normal, elites };
}

function visibleCounts(gd, ps) {
  const out = new Map();
  for (const s of [...ps.shop.slots, ...(ps.offers || []).flatMap((o) => o.slots)]) {
    if (!s || s.sold || s.kind !== 'chess') continue;
    const base = gd.baseIdOf(s.id);
    out.set(base, (out.get(base) || 0) + 1);
  }
  return out;
}

function stockLeft(m, ps, base) {
  const pool = typeof ps.poolOf === 'function' ? ps.poolOf(base) : m.pool;
  return Math.max(0, pool?.left(base) || 0);
}

const obtainable = (m, ps, base, held, visible) =>
  held.elites.has(base) || held.normal.has(base) || visible.has(base) || stockLeft(m, ps, base) > 0;

function thresholds(gd, bond) {
  const rec = gd.bond(bond);
  return Array.isArray(rec?.thresholds) && rec.thresholds.length ? rec.thresholds : [rec?.activeCount || 2];
}

function canFinish(m, ps, target, held, visible) {
  if (held.elites.has(target.base)) return true;
  const need = target.copies - (held.normal.get(target.base) || 0);
  return need <= stockLeft(m, ps, target.base) + (visible.get(target.base) || 0);
}

function makePlan(m, ps) {
  const gd = ps.gd || m.gd;
  const held = holdings(gd, ps);
  const visible = visibleCounts(gd, ps);
  const targets = [];
  // bond null: 锡人 is the core whatever bond the mode switches off
  const add = (base, bond, elite, stage = gd.tierOf(base)) => {
    if ((bond && bondOff(m, ps, bond)) || !gd.chess(base) || !obtainable(m, ps, base, held, visible)) return;
    targets.push(Object.freeze({ base, bond, elite, stage, copies: elite ? gd.mergeCount(base) : 1 }));
  };
  const o = TOUCH_OPS;
  add(o.tinman, null, true);
  // the cheap 精准 elites also meet Touch's two-elite condition early
  add(o.jumping, 'preciShip', true);
  add(o.indigo, 'preciShip', true);
  add(o.executor, 'preciShip', false);
  add(o.branch, 'steadShip', true);
  add(o.cuora, 'steadShip', true);
  add(o.gummy, 'steadShip', false);
  add(o.bubble, 'steadShip', false);
  add(o.tippi, 'swiftShip', false);
  for (const base of [o.reinhardt, o.titi]) add(base, 'preciShip', false);
  for (const base of [o.nymph, o.ashlock, o.stranger]) add(base, 'swiftShip', false);
  const goals = {};
  for (const [bond, n] of Object.entries(GOALS)) if (!bondOff(m, ps, bond)) goals[bond] = n;
  return Object.freeze({ goals: Object.freeze(goals), targets: Object.freeze(targets), round: m.round });
}

const state = (ps) => ((ps.botStrategyState ??= {}).touch ??= {});

/** The only policy-memory mutation of the plan. Call once at prep start, before lineup probes. */
export function refreshTouchPlan(m, ps) {
  if (!touchEnabled(m, ps)) return null;
  const plan = makePlan(m, ps);
  state(ps).plan = plan;
  return plan;
}

export function touchPlan(m, ps) {
  return touchEnabled(m, ps) ? ps.botStrategyState?.touch?.plan || makePlan(m, ps) : null;
}

export function touchTarget(m, ps, id) {
  const gd = ps.gd || m.gd;
  return touchPlan(m, ps)?.targets.find((t) => t.base === gd.baseIdOf(id)) || null;
}

export function touchCore(m, ps, id) {
  const target = touchTarget(m, ps, id);
  return !!target?.elite && target.stage <= ps.shop.level;
}

/** An elite 锡人 is owned, or one can still be completed from the public stock and the visible offers. */
export function touchTinmanPossible(m, ps) {
  const gd = ps.gd || m.gd;
  const held = holdings(gd, ps);
  if (held.elites.has(TOUCH_OPS.tinman)) return true;
  const target = touchPlan(m, ps)?.targets.find((t) => t.base === TOUCH_OPS.tinman);
  return !!target && canFinish(m, ps, target, held, visibleCounts(gd, ps));
}

/** Only obtainable, unfinished targets at the current shop level justify rerolls. */
export function touchSearchTargets(m, ps) {
  const gd = ps.gd || m.gd;
  const plan = touchPlan(m, ps);
  if (!plan) return [];
  const held = holdings(gd, ps), visible = visibleCounts(gd, ps);
  return plan.targets.filter((t) => t.stage <= ps.shop.level && !held.elites.has(t.base)
    && (held.normal.get(t.base) || 0) < t.copies && canFinish(m, ps, t, held, visible));
}

/** Bonus on top of ordinary unit, role and economy scoring. */
export function touchBuyBonus(m, ps, id, ctx = {}) {
  if (!touchEnabled(m, ps)) return 0;
  const gd = ps.gd || m.gd;
  const rec = gd.chess(id);
  if (!rec) return 0;
  const base = gd.baseIdOf(id);
  const held = holdings(gd, ps, ctx);
  const n = held.normal.get(base) || 0;
  const target = touchTarget(m, ps, id);
  if (target && !rec.isGolden && (held.elites.has(base) || n >= target.copies)) return TOUCH_PARAMS.surplusCopy;
  let score = rec.isGolden ? TOUCH_ELITE_VALUE : 0;
  if (target && !held.elites.has(base)) {
    if (rec.isGolden) score += target.elite ? TOUCH_PARAMS.coreMerge : TOUCH_PARAMS.singleFirst;
    else if (target.elite && canFinish(m, ps, target, held, visibleCounts(gd, ps))) score += n + 1 >= target.copies
      ? TOUCH_PARAMS.coreMerge : n ? TOUCH_PARAMS.corePair : TOUCH_PARAMS.coreFirst;
    else if (!target.elite && !n) score += TOUCH_PARAMS.singleFirst;
    if (base === TOUCH_OPS.tinman) score += TOUCH_PARAMS.tinmanExtra;
  }
  const plan = touchPlan(m, ps);
  if (!held.elites.has(base) && !n) {
    for (const bond of rec.bonds) {
      if (!plan.goals[bond]) continue;
      const count = ctx.owned?.counts.get(bond) || 0;
      if (count < plan.goals[bond]) score += WEIGHT[bond] * (thresholds(gd, bond).includes(count + 1) ? 1.5 : 0.5);
    }
  }
  return score;
}

const tinmen = (gd, ps) => ps.allChess().filter((p) => gd.baseIdOf(p.id) === TOUCH_OPS.tinman);
const wearsSolvent = (p) => (p.items || []).some((it) => isSolvent(it.id));
const ownsSolvent = (ps) => [...ps.hand, ...ps.temp].some((p) => p && p.kind === 'item' && isSolvent(p.id))
  || ps.allChess().some(wearsSolvent);

/** A favoured item still to be held for 锡人 (bought before one is owned; botTouch.js keeps it in the hand). */
export function touchHoldItem(m, ps, id) {
  const gd = ps.gd || m.gd;
  return touchEnabled(m, ps) && touchFavoredItem(id) && m.round < TOUCH_PARAMS.itemHoldRound
    && !tinmen(gd, ps).length && touchTinmanPossible(m, ps);
}

/**
 * Extra weight of an item in the shop, merge rewards and 机变 (0 = none). [ASSUMED] 源石溶剂 while a 锡人 wears none
 * (before any 锡人 when none is already held for it); 炎国短刀 / 阿戈尔重刃 while a 锡人 has a free slot.
 */
export function touchItemBonus(m, ps, id) {
  if (!touchEnabled(m, ps) || !touchFavoredItem(id)) return 0;
  const gd = ps.gd || m.gd;
  const tin = tinmen(gd, ps);
  const room = tin.filter((p) => (p.items || []).length < gd.equipPerChess);
  if (isSolvent(id)) {
    if (tin.length) return room.some((p) => !wearsSolvent(p)) ? TOUCH_PARAMS.solvent : 0;
    const held = [...ps.hand, ...ps.temp].some((p) => p && p.kind === 'item' && isSolvent(p.id));
    return !held && touchHoldItem(m, ps, id) ? TOUCH_PARAMS.solvent : 0;
  }
  return room.length ? TOUCH_PARAMS.favoredItem : 0;
}

/** Lineup choice: the legacy score does not see Touch's two-elite condition or the 迅捷锡人 frame. */
export function touchLineupBonus(m, ps, set) {
  if (!touchEnabled(m, ps)) return 0;
  const gd = ps.gd || m.gd;
  const plan = touchPlan(m, ps);
  let v = 0, elites = 0;
  for (const p of set) {
    const base = gd.baseIdOf(p.id);
    const golden = gd.isGolden(p.id);
    if (golden) elites++;
    if (base === TOUCH_OPS.tinman) v += golden ? TOUCH_PARAMS.eliteTinmanLineup : TOUCH_PARAMS.tinmanLineup;
    else if (plan.targets.some((t) => t.base === base)) v += TOUCH_PARAMS.planLineup;
  }
  return v + (elites >= 2 ? TOUCH_PARAMS.touchLineup : 0);
}

/** Pure eligibility + affordability; the caller performs one validated level-up. */
export function touchCanLevel(m, ps) {
  if (!touchEnabled(m, ps)) return true;
  const gd = ps.gd || m.gd;
  if (ps.shop.level >= gd.maxShopLevel || ps.funds < Math.max(0, ps.shop.upgradePrice)) return false;
  const level = ps.shop.level;
  // 一本找源石溶剂，找到后再升本
  if (level === 1) return m.round >= TOUCH_PARAMS.exitL1Round || (m.round >= TOUCH_PARAMS.exitL1MinRound
    && ownsSolvent(ps));
  // 二本找锡人并做精锐 (or until it cannot be completed any more)
  if (level === 2) return m.round >= TOUCH_PARAMS.exitL2Round || !touchTinmanPossible(m, ps)
    || holdings(gd, ps).elites.has(TOUCH_OPS.tinman);
  if (level === 3) return m.round >= TOUCH_PARAMS.l4UpgradeRound;
  if (level === 4) return m.round >= TOUCH_PARAMS.l5UpgradeRound;
  return m.round >= TOUCH_PARAMS.l6UpgradeRound;
}

// ---------------------------------------------------------------------------------------------------------------
// Items and placement: decisions only (bot.js equips and moves)

/**
 * Where a favoured item goes: `{ carrier }` — a 锡人 with room (`hasRoom(piece, itemRecord)`, the caller's slot rule),
 * elite and deployed first, one 源石溶剂 each; `{ hold: true }` — kept in the hand while a 锡人 can still come
 * (touchHoldItem); null — not a Touch decision (the generic target).
 */
export function touchItemPlan(m, ps, item, hasRoom) {
  if (!touchEnabled(m, ps) || !touchFavoredItem(item.id)) return null;
  const gd = ps.gd || m.gd;
  const rec = gd.item(item.id);
  const rank = (p) => (gd.isGolden(p.id) ? 2 : 0) + (ps.find(p.uid)?.area === 'board' ? 1 : 0);
  const carrier = tinmen(gd, ps).filter((p) => hasRoom(p, rec) && !(isSolvent(item.id) && wearsSolvent(p)))
    .sort((a, b) => rank(b) - rank(a) || a.uid - b.uid)[0];
  if (carrier) return { carrier };
  return TOUCH_SHOP_ON && touchHoldItem(m, ps, item.id) ? { hold: true } : null;
}

const TOUCH_TOKEN = 'char_613_acmedc';

/**
 * Touch's board tile and facing: the stage's map-character slot on the own board (data/stages.json `mapChars`; the
 * boss and shared fields map their slots back onto the same board tile, tokens.js spawnMapChar). [ASSUMED] (10, 2)
 * facing right when the stage has none.
 */
export function touchTile(m) {
  const slot = (m.stage?.mapChars || []).find((s) => s?.key === TOUCH_TOKEN && Array.isArray(s.pos) && inField(s.pos[0], s.pos[1]));
  return slot ? [slot.pos[0], slot.pos[1], slot.dir || 'RIGHT'] : [10, 2, 'RIGHT'];
}

/** The board tiles Touch heals (its attack range around its tile; the S3 range growth is left out), its own excluded. */
export function touchHealKeys(m) {
  const [r, c, dir] = touchTile(m);
  const keys = ownerRangeKeys(m.gd.token(TOUCH_TOKEN)?.rangeGrid, r, c, dir);
  keys.delete(tileKey(r, c));
  return keys;
}

/**
 * 站位：让锡人处于 Touch 治疗范围内. The deployed 锡人 to move (elite, then the one wearing 源石溶剂, first) and its heal
 * tiles to try in order: free ones, then those held by a ranged operator without summons (a board move swaps; the
 * server refuses an illegal one). null when no 锡人 is deployed or it already stands in the range. [ASSUMED] Reading
 * order among the heal tiles; the other injured units sharing the heals are not weighed.
 */
export function touchTinmanMove(m, ps) {
  if (!touchEnabled(m, ps)) return null;
  const gd = ps.gd || m.gd;
  const heal = touchHealKeys(m);
  const tin = [...ps.board.entries()].filter(([, p]) => p.kind === 'chess' && gd.baseIdOf(p.id) === TOUCH_OPS.tinman)
    .sort(([, a], [, b]) => (gd.isGolden(b.id) - gd.isGolden(a.id)) || (wearsSolvent(b) - wearsSolvent(a)));
  if (!tin.length || heal.has(tin[0][0])) return null;
  const swappable = (p) => {
    const rec = p.kind === 'chess' ? gd.chess(p.id) : null;
    return !!rec && rec.position === 'RANGED' && !(rec.tokens || []).length && gd.baseIdOf(p.id) !== TOUCH_OPS.tinman;
  };
  const free = [], held = [];
  for (const k of heal) {
    if (!inField(...parseKey(k))) continue;
    const occ = ps.board.get(k);
    if (!occ) free.push(k);
    else if (swappable(occ)) held.push(k);
  }
  return { piece: tin[0][1], keys: [...free, ...held] };
}

/** The policy object bot.js reads (the same hook names as the experimental Ioleta policy, plus Touch's extras). */
export const TOUCH_POLICY = Object.freeze({
  refresh: refreshTouchPlan, buyBonus: touchBuyBonus, core: touchCore, canLevel: touchCanLevel, target: touchTarget,
  searchTargets: touchSearchTargets, lineupBonus: touchLineupBonus, itemBonus: touchItemBonus,
});
