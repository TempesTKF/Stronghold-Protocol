// Upstream c24e17ee real-battle rehearsal regression, adapted to opt-in local refinements.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rehearse } from '../../server/match/botOwner.js';
import { buildNormalWave } from '../../server/match/waves.js';
import { parseKey } from '../../server/match/board.js';
import { makeOwnerMatch as makeMatch, give, checkInvariants } from './harness.js';
test('user: Given normal battle-start effects, When rehearsing candidate layouts, Then choose the layout with fewer actual battle leaks', async (t) => {
  // Real round-7 wave from seed 104; no equipment, bench, effects or prior layers are needed.
  // Blemishine also gains Kazimierz layers in battle; Touch is supplied by the teammate's contentInfo.
  const lineup = [
    ['chess_char_4_02_a', '12,4', 'DOWN'],
    ['chess_char_1_17_a', '12,5', 'DOWN'],
    ['chess_char_3_17_a', '11,4', 'RIGHT'],
    ['chess_char_2_18_a', '10,5', 'RIGHT'],
    ['chess_char_3_12_a', '9,4', 'RIGHT'],
  ];
  const prep = () => {
    const h = makeMatch({ mode: 'coop', humans: 2, difficulty: 'HARD', seed: 104, botRehearsal: 2 }).start().toPrep(1, { band: 'band_ducklord' });
    const m = h.m, ps = m.order[0];
    m.botRefinements = ['preview'];
    m.round = 7;
    m.wave = buildNormalWave(m.gd, m.rngWave, m.factions, m.round);
    ps.bandId = 'band_ducklord';
    m.order[1].bandId = 'band_amedic';
    const pieces = lineup.map(([id, key, dir]) => {
      const p = give(m, ps, id, 'board', parseKey(key));
      p.dir = dir;
      return p;
    });
    ps.recompute();
    return { h, m, ps, pieces };
  };
  const cases = [
    // This regression runs on the local 0.2.6 combat engine.
    { effect: 'in-battle layer gains', keys: ['9,4', '9,5'] },
    { effect: 'duck replacements and a teammate medic', keys: ['9,9', '9,7'] },
  ];
  for (const { effect, keys } of cases) {
    await t.test(`user: Given ${effect}, When comparing two layouts, Then prefer the second layout's lower leak count`, () => {
      // Each normal combat starts from a fresh, identical prep state, including the meta RNG.
      const actual = keys.map((key) => {
        const { h, m, ps, pieces } = prep();
        try {
          ps.board.delete('9,4');
          ps.board.set(key, pieces.at(-1));
          ps.recompute();
          checkInvariants(m);
          m.startCombat();
          assert.ok(h.run(() => m.lastResults.has(ps.playerId)));
          assert.equal(m.errorCount, 0);
          const result = m.lastResults.get(ps.playerId);
          return { leaks: result.leaked.filter((l) => l.counted !== false).length, layers: result.layerGains.kazimierzShip };
        } finally { m.dispose(); }
      });
      assert.ok(actual.every((result) => result.layers > 0), 'both battles exercise in-battle layer gains');
      assert.ok(actual[1].leaks < actual[0].leaks, 'normal combat gives the second layout a strict leak advantage');
      const { m, ps, pieces } = prep();
      try {
        const plans = keys.map((key) => {
          const plan = new Map(pieces.map((p, i) => [p.uid, i === pieces.length - 1 ? key : lineup[i][1]]));
          plan.dirs = new Map(pieces.map((p) => [p.uid, p.dir]));
          return plan;
        });
        assert.equal(rehearse(m, ps, pieces, plans), plans[1], `${effect}: choose ${keys[1]} (${actual[1].leaks} leaks), not ${keys[0]} (${actual[0].leaks} leaks)`);
        assert.equal(m.errorCount, 0);
        checkInvariants(m);
      } finally { m.dispose(); }
    });
  }
});
