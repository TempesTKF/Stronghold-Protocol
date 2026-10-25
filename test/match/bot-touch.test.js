// Touch AI strategy (server/match/botTouchPolicy.js core, botTouch.js, bot.js shopPolicy): 迅捷锡人 procurement, 源石溶剂
// and the attack items on 锡人, 锡人 moved into Touch's heal range; Match option botTouchPolicy ('legacy' = generic bot).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SharedPool } from '../../server/match/pool.js';
import { TOUCH_OPS as O, TOUCH_PARAMS, refreshTouchPlan, touchTarget, touchCore, touchBuyBonus, touchCanLevel,
  touchEnabled, touchItemBonus, touchItemPlan, touchLineupBonus, touchHealKeys, touchTile, touchTinmanMove } from '../../server/match/botTouchPolicy.js';
import { placeTinmanInTouchRange } from '../../server/match/botTouch.js';
import { botPickCard } from '../../server/match/botOwner.js';
import { canPlace, parseKey, placeClass } from '../../server/match/board.js';
import { makeOwnerMatch as makeMatch, give, giveItem, legalTileFor, checkInvariants } from './harness.js';

const SOLVENT = 'chess_item_1_05_e_a'; // 源石溶剂
const DAGGER = 'chess_item_3_04_e_a'; // 炎国短刀

function setup(t, { seed = 11 } = {}) {
  const h = makeMatch({ mode: 'solo', difficulty: 'HARD', seed, fake: true }).start().toPrep();
  t.after(() => h.m.dispose());
  const m = h.m, ps = m.order[0];
  m.pool = new SharedPool(m.gd);
  m.disabledBonds = [];
  ps.bandId = 'band_amedic';
  ps.hand.fill(null);
  ps.shop.slots.fill(null);
  ps.shop.freeRefreshes = 0;
  ps.funds = 20;
  return { m, ps };
}

function add(m, ps, base, { elite = false, board = false, skip = new Set() } = {}) {
  const id = elite ? ps.gd.goldenIdOf(base) : base;
  const tile = board ? legalTileFor(m, ps, id, skip) : null;
  if (board) assert.ok(tile, `no tile for ${id}`);
  return give(m, ps, id, board ? 'board' : 'hand', tile);
}

const room = (m) => (p) => (p.items || []).length < m.gd.equipPerChess;

test('touch: on by default for a Touch seat; legacy or another band turns the core off', (t) => {
  const { m, ps } = setup(t);
  assert.equal(touchEnabled(m, ps), true);
  m.botTouchPolicy = 'legacy';
  assert.equal(touchEnabled(m, ps), false);
  assert.equal(touchItemBonus(m, ps, SOLVENT), 0);
  m.botTouchPolicy = 'experimental';
  ps.bandId = 'band_amiya';
  assert.equal(touchEnabled(m, ps), false);
});

test('touch: the plan targets an elite 锡人 and the 坚守 / 精准 / 迅捷 frame', (t) => {
  const { m, ps } = setup(t);
  const plan = refreshTouchPlan(m, ps);
  assert.deepEqual(plan.goals, { steadShip: 3, preciShip: 3, swiftShip: 2 });
  for (const base of [O.tinman, O.jumping, O.indigo, O.branch, O.cuora]) assert.equal(touchTarget(m, ps, base).elite, true);
  for (const base of [O.executor, O.gummy, O.bubble, O.tippi, O.reinhardt, O.stranger]) assert.equal(touchTarget(m, ps, base).copies, 1);
  assert.equal(touchCore(m, ps, O.tinman), false, '锡人 is a 2阶 search');
  ps.shop.level = 2;
  assert.equal(touchCore(m, ps, O.tinman), true);
  checkInvariants(m);
});

test('touch: 锡人 merge progress outranks a pair and a first copy; a copy after the elite is surplus', (t) => {
  const { m, ps } = setup(t);
  refreshTouchPlan(m, ps);
  const first = touchBuyBonus(m, ps, O.tinman);
  add(m, ps, O.tinman);
  const pair = touchBuyBonus(m, ps, O.tinman);
  add(m, ps, O.tinman);
  const merge = touchBuyBonus(m, ps, O.tinman);
  assert.ok(merge > pair && pair > first, `${merge} > ${pair} > ${first}`);
  for (const p of ps.allChess()) ps.sell(p.uid);
  add(m, ps, O.tinman, { elite: true });
  assert.equal(touchBuyBonus(m, ps, O.tinman), TOUCH_PARAMS.surplusCopy);
});

test('touch: 一本 until 源石溶剂 (not before R3, at the latest R5), 二本 until the elite 锡人', (t) => {
  const { m, ps } = setup(t);
  refreshTouchPlan(m, ps);
  ps.funds = 99;
  m.round = TOUCH_PARAMS.exitL1MinRound;
  assert.equal(touchCanLevel(m, ps), false, 'no 源石溶剂 yet');
  giveItem(m, ps, SOLVENT);
  assert.equal(touchCanLevel(m, ps), true);
  m.round = TOUCH_PARAMS.exitL1MinRound - 1;
  assert.equal(touchCanLevel(m, ps), false, 'too early');
  ps.hand.fill(null);
  m.round = TOUCH_PARAMS.exitL1Round;
  assert.equal(touchCanLevel(m, ps), true, 'the R5 exit');
  ps.shop.level = 2;
  assert.equal(touchCanLevel(m, ps), false, 'searching 锡人');
  add(m, ps, O.tinman, { elite: true });
  assert.equal(touchCanLevel(m, ps), true);
});

test('touch: 源石溶剂 is held for 锡人, then one per 锡人; the attack items need a 锡人', (t) => {
  const { m, ps } = setup(t);
  refreshTouchPlan(m, ps);
  assert.equal(touchItemBonus(m, ps, SOLVENT), TOUCH_PARAMS.solvent);
  assert.equal(touchItemBonus(m, ps, DAGGER), 0);
  add(m, ps, 'chess_char_6_19_a', { board: true });
  const solvent = giveItem(m, ps, SOLVENT);
  assert.deepEqual(touchItemPlan(m, ps, solvent, room(m)), { hold: true }, 'kept for 锡人');
  assert.equal(touchItemPlan(m, ps, giveItem(m, ps, 'chess_item_1_01_e_a'), room(m)), null, 'not a favoured item');
  const tin = add(m, ps, O.tinman, { elite: true, board: true });
  assert.equal(touchItemPlan(m, ps, solvent, room(m)).carrier.uid, tin.uid);
  assert.equal(touchItemBonus(m, ps, DAGGER), TOUCH_PARAMS.favoredItem);
  assert.ok(ps.equip(solvent.uid, tin.uid).ok);
  assert.equal(touchItemBonus(m, ps, SOLVENT), 0, 'the 锡人 already wears one');
  assert.notEqual(touchItemPlan(m, ps, giveItem(m, ps, SOLVENT), room(m))?.carrier?.uid, tin.uid);
});

test('touch: 机变 prefers 源石溶剂 over an item card the generic bot would take; legacy does not', (t) => {
  const { m, ps } = setup(t);
  add(m, ps, O.tinman, { board: true });
  const cards = [{ kind: 'item', id: 'chess_item_3_01_e_a', tier: 3 }, { kind: 'item', id: SOLVENT, tier: 1 }];
  assert.equal(botPickCard(m, ps, cards, [0, 1]), 1);
  m.botTouchPolicy = 'legacy';
  assert.equal(botPickCard(m, ps, cards, [0, 1]), 0);
});

test('touch: the lineup bonus counts 锡人, plan targets and two elites for Touch', (t) => {
  const { m, ps } = setup(t);
  refreshTouchPlan(m, ps);
  const tin = add(m, ps, O.tinman, { elite: true });
  const jump = add(m, ps, O.jumping);
  const p = TOUCH_PARAMS;
  assert.equal(touchLineupBonus(m, ps, [tin]), p.eliteTinmanLineup);
  assert.equal(touchLineupBonus(m, ps, [tin, jump]), p.eliteTinmanLineup + p.planLineup);
  const jumpElite = add(m, ps, O.jumping, { elite: true });
  assert.equal(touchLineupBonus(m, ps, [tin, jumpElite]), p.eliteTinmanLineup + p.planLineup + p.touchLineup);
});

test('touch: the heal range is Touch\'s attack range on the own board, Touch\'s tile excluded', (t) => {
  const { m } = setup(t);
  const [r, c] = touchTile(m);
  const heal = touchHealKeys(m);
  assert.ok(heal.size > 0 && !heal.has(`${r},${c}`));
  for (const k of heal) {
    const [hr, hc] = parseKey(k);
    assert.ok(Math.abs(hr - r) <= 1 && hc >= c && hc <= c + 3, k);
  }
});

test('touch: 锡人 moves onto a heal tile, swapping out a ranged operator when none is free', (t) => {
  const { m, ps } = setup(t);
  const heal = touchHealKeys(m);
  const map = ps.deployMap();
  const tinRec = ps.gd.chess(ps.gd.goldenIdOf(O.tinman));
  const legal = [...heal].filter((k) => canPlace(map, placeClass(ps, tinRec), ...parseKey(k)));
  assert.ok(legal.length, 'some heal tile takes 锡人');
  const others = legal.map((k) => give(m, ps, O.jumping, 'board', parseKey(k)));
  const tin = add(m, ps, O.tinman, { elite: true, board: true, skip: heal });
  assert.ok(touchTinmanMove(m, ps).keys.length);
  assert.equal(placeTinmanInTouchRange(m, ps), true);
  assert.ok(heal.has(ps.find(tin.uid).key));
  assert.equal(touchTinmanMove(m, ps), null, 'already in range');
  // (the filled heal tiles exceed the deploy cap: a placement-only setup, no invariant check)
  assert.equal(others.filter((p) => ps.find(p.uid)?.area === 'board').length, others.length, 'the swapped one stays deployed');
});
