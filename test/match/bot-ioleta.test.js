import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arrange, botPrepBegin, levelUp } from '../../server/match/botOwner.js';
import { eliteCount, ioletaBondScore, ioletaBuyBondBonus } from '../../server/match/botIoletaOwner.js';
import { makeOwnerMatch as makeMatch, give, checkInvariants } from './harness.js';

const STEAD = ['chess_char_1_02_a', 'chess_char_1_10_a', 'chess_char_2_08_a'];
const PRECI = ['chess_char_1_09_a', 'chess_char_1_17_a', 'chess_char_2_01_a'];
const OTHER = ['chess_char_1_03_a', 'chess_char_1_07_a'];

function setup(t) {
  const h = makeMatch({ mode: 'solo', difficulty: 'HARD', seed: 11, fake: true }).start().toPrep();
  t.after(() => h.m.dispose());
  const m = h.m, ps = m.order[0];
  m.botIoletaPolicy = 'legacy';
  ps.bandId = 'band_ioleta';
  for (const slot of ps.shop.slots) if (slot) slot.sold = true;
  ps.shop.freeRefreshes = 0;
  ps.funds = 0;
  return { m, ps };
}

function roster(m, ps, ids, elite = false) {
  return ids.map((id) => give(m, ps, elite ? m.gd.goldenIdOf(id) : id));
}

test('Ioleta: deployed 3 / 6 elites gate L2 / L3, including free upgrades and spare funds', (t) => {
  const { m, ps } = setup(t);
  m.round = 10;
  roster(m, ps, [...STEAD, ...PRECI], true);
  ps.shop.upgradePrice = 0;
  levelUp(m, ps);
  assert.equal(ps.shop.level, 1, 'six bench elites do not unlock an upgrade');
  arrange(m, ps);
  assert.equal(eliteCount(ps.gd, [...ps.board.values()]), 6);
  // Remove four from the board through the real move handler.
  for (const p of [...ps.board.values()].slice(2)) assert.ok(ps.move(p.uid, { area: 'hand', idx: ps.hand.findIndex((x) => !x) }).ok);
  ps.funds = 100;
  levelUp(m, ps, { spare: true });
  assert.equal(ps.shop.level, 1, 'two deployed elites: neither free nor rich overrides the gate');
  arrange(m, ps);
  for (const p of [...ps.board.values()].slice(3)) assert.ok(ps.move(p.uid, { area: 'hand', idx: ps.hand.findIndex((x) => !x) }).ok);
  levelUp(m, ps);
  assert.equal(ps.shop.level, 2, 'three elites unlock L2 but the same call cannot skip the L3 gate');
  ps.shop.upgradePrice = 0;
  levelUp(m, ps, { spare: true });
  assert.equal(ps.shop.level, 2, 'free L3 is still locked');
  arrange(m, ps);
  ps.funds = 0;
  levelUp(m, ps);
  assert.equal(ps.shop.level, 3, 'six deployed elites unlock free L3');
  checkInvariants(m);
});

test('Ioleta: a fresh hand elite is deployed before this prep checks the upgrade gate', (t) => {
  const { m, ps } = setup(t);
  roster(m, ps, STEAD, true);
  ps.shop.upgradePrice = 0;
  botPrepBegin(m, ps);
  assert.equal(ps.shop.level, 2);
  assert.equal(eliteCount(ps.gd, [...ps.board.values()]), 3);
  checkInvariants(m);
});

test('Ioleta: affordable merges and their chained rewards happen before a permitted upgrade', (t) => {
  const { m, ps } = setup(t);
  m.round = 10;
  roster(m, ps, STEAD, true);
  roster(m, ps, [PRECI[0], PRECI[0], PRECI[1], PRECI[1]]);
  arrange(m, ps);
  ps.funds = 2;
  ps.shop.upgradePrice = 0;
  ps.shop.slots = [{ kind: 'chess', id: PRECI[0], basePrice: 2, sold: false }];
  const events = [];
  const buy = ps.buy.bind(ps), upgrade = ps.levelUp.bind(ps), reward = ps.pickReward.bind(ps);
  ps.buy = (idx) => {
    events.push('buy');
    const result = buy(idx);
    // A deterministic real merge reward completes the second held pair.
    if (result.ok && ps.offers[0]) ps.offers[0].slots = [{ kind: 'chess', id: PRECI[1], sold: false }];
    return result;
  };
  ps.pickReward = (idx) => { events.push('reward'); return reward(idx); };
  ps.levelUp = () => { events.push('upgrade'); return upgrade(); };
  levelUp(m, ps);
  assert.equal(ps.shop.level, 1, 'even a free upgrade waits for the affordable third copy');
  botPrepBegin(m, ps);
  assert.equal(events[0], 'buy');
  assert.ok(events.indexOf('reward') > 0 && events.indexOf('reward') < events.indexOf('upgrade'), events.join());
  assert.ok(ps.allChess().some((p) => p.id === m.gd.goldenIdOf(PRECI[0])));
  assert.ok(ps.allChess().some((p) => p.id === m.gd.goldenIdOf(PRECI[1])), 'reward chain completed');
  assert.equal(ps.shop.level, 2);
  checkInvariants(m);
});

test('Ioleta: keep six low-tier elites instead of adding a high-tier normal or a third bond member', (t) => {
  const { m, ps } = setup(t);
  const kept = roster(m, ps, [STEAD[0], STEAD[1], ...PRECI, OTHER[0]], true);
  arrange(m, ps);
  roster(m, ps, ['chess_char_6_03_a', 'chess_char_6_01_a', OTHER[1]]);
  arrange(m, ps);
  assert.ok(kept.every((p) => ps.find(p.uid)?.area === 'board'));
  assert.equal(eliteCount(ps.gd, [...ps.board.values()]), 6);
  checkInvariants(m);
});

test('Ioleta: duplicate elites count for upgrade gates but not as three distinct 坚守', (t) => {
  const { m, ps } = setup(t);
  roster(m, ps, [STEAD[0], STEAD[0], STEAD[0]], true);
  arrange(m, ps);
  assert.equal(ps.bonds.steadShip.count, 1);
  ps.shop.upgradePrice = 0;
  levelUp(m, ps);
  assert.equal(ps.shop.level, 2);
  assert.equal(eliteCount(ps.gd, [...ps.board.values()]), 3);
});

test('Ioleta: all three bonds get independent small preferences before any is completed', (t) => {
  const { ps } = setup(t);
  const owned = { counts: new Map() };
  const bonus = (id) => ioletaBuyBondBonus(ps.gd, { bonds: [id] }, owned);
  assert.ok(bonus('steadShip') > bonus('preciShip'));
  assert.ok(bonus('preciShip') > bonus('arcaneShip'));
  assert.ok(bonus('arcaneShip') > 0, '奥术 is preferred even with no 坚守 or 精准');
  assert.ok(bonus('steadShip') < 1, 'a close-choice preference, not a build target');
  const arcane = bonus('arcaneShip');
  owned.counts.set('steadShip', 3);
  assert.equal(bonus('steadShip'), 0, 'a fourth member has ordinary value');
  assert.equal(bonus('arcaneShip'), arcane, 'completing 坚守 does not switch other weights');
  ps.gd.modeInactiveBonds.add('arcaneShip');
  assert.equal(bonus('arcaneShip'), 0);
});

test('Ioleta: take an offered elite outside the preferred bonds and buy useful stock without searching for them', (t) => {
  const { m, ps } = setup(t);
  ps.pushRewardOffer('merge', { tier: 6, ids: [STEAD[1], m.gd.goldenIdOf(OTHER[0])] });
  botPrepBegin(m, ps);
  assert.ok(ps.allChess().some((p) => p.id === m.gd.goldenIdOf(OTHER[0])));
  ps.shop.slots = [{ kind: 'chess', id: OTHER[1], basePrice: 2, sold: false }];
  ps.funds = 4;
  const actions = [];
  const buy = ps.buy.bind(ps), refresh = ps.refresh.bind(ps);
  ps.buy = (idx) => { actions.push('buy'); return buy(idx); };
  ps.refresh = () => { actions.push('refresh'); return refresh(); };
  botPrepBegin(m, ps);
  assert.equal(actions[0], 'buy', 'missing preferred bonds does not reject useful offered stock for a reroll');
  assert.ok(ps.allChess().some((p) => p.id === OTHER[1]));
});

test('Ioleta: elite gates do not apply to other strategies or to L3 and above', (t) => {
  const { m, ps } = setup(t);
  ps.bandId = 'band_bldsk';
  ps.shop.upgradePrice = 0;
  levelUp(m, ps);
  assert.equal(ps.shop.level, 2);
  ps.bandId = 'band_ioleta';
  ps.shop.level = 3;
  ps.shop.upgradePrice = 0;
  levelUp(m, ps);
  assert.equal(ps.shop.level, 4);
});

test('Ioleta: bond preference caps at three, fourth members add none, and disabled 奥术 is skipped', (t) => {
  const { m, ps } = setup(t);
  roster(m, ps, [...STEAD, ...PRECI], true);
  arrange(m, ps);
  const before = ioletaBondScore(ps.gd, ps.bonds);
  roster(m, ps, ['chess_char_2_17_a']);
  arrange(m, ps);
  assert.equal(ps.bonds.steadShip.count, 4);
  assert.ok(Math.abs(ioletaBondScore(ps.gd, ps.bonds) - before) < 1e-9, 'no extra goal value for the fourth 坚守');
  const fewer = { ...ps.bonds, steadShip: { count: 2 } };
  assert.ok(ioletaBondScore(ps.gd, fewer) < before, 'breaking three loses the retained completion value');
  ps.gd.modeInactiveBonds.add('arcaneShip');
  assert.equal(ioletaBondScore(ps.gd, ps.bonds), ioletaBondScore(ps.gd, { ...ps.bonds, arcaneShip: { count: 3 } }));
});
