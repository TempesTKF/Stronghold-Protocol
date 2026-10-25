import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arrange } from '../../server/match/botOwner.js';
import { resolveFormationMode } from '../../server/match/botFormation.js';
import { experimentalEnabled } from '../../server/match/botIoletaExperimental.js';
import { createRng } from '../../server/sim/rng.js';
import { makeOwnerMatch as makeMatch, give } from './harness.js';

const ids = ['chess_char_1_02_a', 'chess_char_1_10_a', 'chess_char_2_08_a', 'chess_char_3_16_a'];
const signature = plan => [...plan].map(([uid, key]) => [uid, key, plan.dirOf(uid)]).sort();

test('Ioleta default is scoped per player, including human AI takeover; constructor overrides persist', t => {
  const h = makeMatch({ humans: 1, bots: 1 }).start().toPrep();
  t.after(() => h.m.dispose());
  const { m } = h;
  assert.equal(m.botIoletaPolicy, 'experimental');
  for (const ps of m.order) {
    ps.bandId = 'band_ioleta';
    assert.equal(experimentalEnabled(m, ps), true);
    assert.equal(resolveFormationMode(m, ps), 'adaptive');
    ps.bandId = 'band_amiya';
    assert.equal(experimentalEnabled(m, ps), false);
    assert.equal(resolveFormationMode(m, ps), 'learned');
  }
  const old = makeMatch({ botIoletaPolicy: 'legacy', botFormationMode: 'learned', botFormationEnabled: false });
  t.after(() => old.m.dispose());
  assert.equal(old.m.botIoletaPolicy, 'legacy');
  assert.equal(old.m.botFormationMode, 'learned');
  assert.equal(old.m.botFormationEnabled, false);
});

for (const band of ['band_ioleta', 'band_amiya']) test(`default final rehearsal matches explicit mode for ${band}`, t => {
  const h = makeMatch({ mode: 'solo', difficulty: 'HARD', seed: 31, botRehearsal: 3 }).start().toPrep();
  t.after(() => h.m.dispose());
  h.setStage('act2autochess_m03');
  const { m } = h, ps = m.order[0];
  ps.bandId = band;
  for (const id of ids) give(m, ps, id, 'hand');
  m.rngBots = createRng(456);
  const automatic = arrange(m, ps, { final: true, defer: true });
  const tail = m.rngBots();
  m.botFormationMode = band === 'band_ioleta' ? 'adaptive' : 'learned';
  m.rngBots = createRng(456);
  const explicit = arrange(m, ps, { final: true, defer: true });
  assert.equal(m.rngBots(), tail);
  assert.ok(automatic && explicit);
  assert.deepEqual(automatic.plans.map(signature), explicit.plans.map(signature));
  assert.deepEqual(automatic.limits, explicit.limits);
  automatic.run(); explicit.run();
  assert.deepEqual(signature(automatic.best), signature(explicit.best));
});

test('explicit legacy formation bypasses adaptive without changing purchase policy', t => {
  const h = makeMatch({ mode: 'solo', difficulty: 'HARD', seed: 31, botRehearsal: 3 }).start().toPrep();
  t.after(() => h.m.dispose());
  h.setStage('act2autochess_m03');
  const { m } = h, ps = m.order[0];
  ps.bandId = 'band_ioleta';
  for (const id of ids) give(m, ps, id, 'hand');
  m.botFormationMode = 'legacy';
  m.rngBots = createRng(456);
  const mode = arrange(m, ps, { final: true, defer: true });
  m.botFormationMode = null;
  m.botFormationEnabled = false;
  m.rngBots = createRng(456);
  const disabled = arrange(m, ps, { final: true, defer: true });
  assert.deepEqual(mode?.plans.map(signature), disabled?.plans.map(signature));
  assert.equal(experimentalEnabled(m, ps), true);
});
