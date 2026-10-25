// Regression cases ported from sganggs/Stronghold-Protocol c24e17ee (#577/#315).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arrange, botPrepBegin } from '../../server/match/botOwner.js';
import { makeOwnerMatch as makeMatch, give, giveItem, legalTileFor, checkInvariants } from './harness.js';
test('user: Given a bond that counts the hand, When replacing a deployed member, Then count it only when there is room to withdraw it', () => {
  for (const [deployed, crowded] of [[false, false], [true, false], [true, true]]) {
    const { m } = makeMatch({ mode: 'coop', humans: 2, seed: 11 }).start().toPrep();
    m.botRefinements = ['capacity', 'cheap'];
    const ps = m.order[0];
    try {
      for (const p of ps.allChess()) ps.sell(p.uid);
      const medic = 'chess_char_2_02_a';
      const damage = 'chess_char_3_11_a';
      const ids = [medic, 'chess_char_3_03_a', damage,
        'chess_char_6_01_b', 'chess_char_6_02_b', 'chess_char_6_03_b', 'chess_char_6_04_b',
        'chess_char_6_05_b', 'chess_char_6_06_b'];
      if (crowded) ids.push('chess_char_6_07_b');
      for (const [i, id] of ids.entries()) {
        give(m, ps, id, deployed && i === 0 ? 'board' : 'hand', deployed && i === 0 ? legalTileFor(m, ps, id) : null);
      }
      ps.layers.visiShip = 120;
      ps.recompute();
      assert.equal(ps.bonds.visiShip.active, true);
      arrange(m, ps);
      assert.equal([...ps.board.values()].some((p) => p.id === damage), !crowded, 'replace the medic only when withdrawal preserves the bond');
      assert.equal(ps.hand.some((p) => p?.id === medic), !crowded, 'the medic contributes from the hand when it fits');
      assert.equal(ps.bonds.visiShip.active, true);
      checkInvariants(m);
    } finally { m.dispose(); }
  }
});

test('user: Given a purchase that needs to withdraw a bond member, When the purchase consumes the last hand slot, Then do not count that member as retained', () => {
  for (const occupied of [8, 9]) {
    const { m } = makeMatch({ mode: 'coop', humans: 2, seed: 11 }).start().toPrep();
    m.botRefinements = ['capacity', 'cheap'];
    const ps = m.order[0];
    try {
      for (const p of ps.allChess()) ps.sell(p.uid);
      const medic = 'chess_char_2_02_a';
      const damage = 'chess_char_3_11_a';
      give(m, ps, medic, 'board', legalTileFor(m, ps, medic));
      for (const id of ['chess_char_3_03_a', 'chess_char_6_01_b', 'chess_char_6_02_b', 'chess_char_6_03_b', 'chess_char_6_04_b', 'chess_char_6_05_b', 'chess_char_6_06_b']) {
        const p = give(m, ps, id, 'hand');
        if (id === 'chess_char_3_03_a') p.items = [ps.newPiece('item', 'chess_item_1_01_e_a'), ps.newPiece('item', 'chess_item_1_02_e_a')];
      }
      while (ps.hand.filter(Boolean).length < occupied) giveItem(m, ps, 'chess_item_1_01_e_a');
      ps.layers.visiShip = 120;
      ps.shop.level = m.gd.maxShopLevel;
      ps.shop.freeRefreshes = 0;
      ps.funds = 3;
      for (const slot of ps.shop.slots) if (slot) slot.sold = true;
      ps.shop.slots[0] = { kind: 'chess', id: damage, basePrice: 3, sold: false };
      ps.recompute();
      botPrepBegin(m, ps);
      assert.equal(ps.allChess().some((p) => p.id === damage), occupied === 8,
        'buy the replacement only when a hand slot remains for the deployed bond member');
      assert.equal(ps.bonds.visiShip.active, true);
      checkInvariants(m);
    } finally { m.dispose(); }
  }
});

test('user: Given a full lineup with its last operator in a crowded hand, When preparing with no purchase available, Then keep and deploy that operator', () => {
  const { m } = makeMatch({ mode: 'solo', seed: 11 }).start().toPrep();
  m.botRefinements = ['capacity', 'cheap'];
    const ps = m.order[0];
  try {
    for (const p of ps.allChess()) ps.sell(p.uid);
    ps.shop.level = m.gd.maxShopLevel;
    for (const slot of ps.shop.slots) if (slot) slot.sold = true;
    ps.shop.freeRefreshes = 0;
    ps.funds = 0;
    const ids = ['1_01_a', '1_02_a', '1_03_a', '1_04_a', '1_06_a', '1_09_a', '1_12_a', '1_20_b'];
    assert.equal(ps.deployCap, ids.length);
    for (const id of ids.slice(0, -1)) {
      const chess = `chess_char_${id}`;
      give(m, ps, chess, 'board', legalTileFor(m, ps, chess));
    }
    const reserve = give(m, ps, `chess_char_${ids.at(-1)}`, 'hand');
    reserve.boughtRound = 0;
    for (let i = 0; i < m.gd.benchSize - 2; i++) giveItem(m, ps, i % 2 ? 'chess_item_1_01_e_a' : 'chess_item_1_02_e_a');
    botPrepBegin(m, ps);
    assert.ok([...ps.board.values()].some((p) => p.uid === reserve.uid), 'the available eighth operator is deployed, not sold to reserve a hand slot');
    assert.equal(ps.allChess().length, ids.length);
    checkInvariants(m);
  } finally { m.dispose(); }
});

test('user: Given equally scored purchases, When buying with limited funds, Then prefer the cheaper offer without overriding a real score advantage', () => {
  for (const expensive of ['chess_char_3_06_a', 'chess_char_3_05_a']) {
    for (const reverse of [false, true]) {
      const { m } = makeMatch({ mode: 'solo', seed: 11 }).start().toPrep();
      m.botRefinements = ['capacity', 'cheap'];
    const ps = m.order[0];
      try {
        for (const p of ps.allChess()) ps.sell(p.uid);
        ps.shop.level = m.gd.maxShopLevel;
        ps.shop.freeRefreshes = 0;
        ps.funds = 3;
        const cheap = 'chess_char_1_12_a';
        const offers = [{ kind: 'chess', id: expensive, basePrice: 3, sold: false }, { kind: 'chess', id: cheap, basePrice: 2, sold: false }];
        if (reverse) offers.reverse();
        for (const slot of ps.shop.slots) if (slot) slot.sold = true;
        ps.shop.slots.splice(0, 2, ...offers);
        botPrepBegin(m, ps);
        const expected = expensive === 'chess_char_3_06_a' ? cheap : expensive;
        assert.deepEqual(ps.allChess().map((p) => p.id), [expected]);
        checkInvariants(m);
      } finally { m.dispose(); }
    }
  }
});
