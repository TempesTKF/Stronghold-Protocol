import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRng } from '../../server/sim/rng.js';
import { createRegistry } from '../../server/match/effectsMeta.js';
import { botRefinement } from '../../server/match/botRefinements.js';
import { createRehearsalSteps, runSteps, repairLayout, supportedContact, LayoutPlan } from '../../server/match/botOwner.js';
import { makeOwnerMatch as makeMatch, give, checkInvariants } from './harness.js';

test('cloning a random stream preserves all subsequent draws, including state zero', () => {
  const r = createRng((-0x6d2b79f5) >>> 0);
  r(); assert.equal(r.state(), 0);
  const c = r.clone();
  for (let i = 0; i < 20; i++) assert.equal(c(), r());
  const before = r.state(); c(); assert.equal(r.state(), before);
});

const snapshot = ps => structuredClone(Object.fromEntries(Object.entries(ps)
  .filter(([k, v]) => k !== 'm' && k !== 'gd' && typeof v !== 'function')));

test('recommended ports default only to experimental policy with legacy formation; explicit ablation wins', () => {
  const m = { botIoletaPolicy: 'experimental', botFormationEnabled: false };
  assert.equal(botRefinement(m, 'preview'), true);
  assert.equal(botRefinement(m, 'capacity'), true);
  assert.equal(botRefinement(m, 'guards'), false);
  assert.equal(botRefinement({ ...m, botRefinements: [] }, 'preview'), false);
  assert.equal(botRefinement({ ...m, botFormationEnabled: true }, 'preview'), false);
  assert.equal(botRefinement({}, 'preview'), false);
});

test('preview uses real start inputs and RNG while isolating live state and all candidates', () => {
  const reg = createRegistry();
  const h = makeMatch({ mode: 'solo', seed: 11, registry: reg, botRehearsal: 2 }).start().toPrep();
  const { m } = h, ps = m.order[0];
  try {
    const piece = give(m, ps, 'chess_char_1_02_a', 'board', [9, 5]);
    ps.recompute();
    reg.global('preview-probe', { onBattleStart(ctx, ev) {
      ev.input.probe = ctx.rng();
      ctx.addFunds(100); ctx.setCounter('probe', 999); ctx.addLayers('steadShip', 100);
      ctx.gd.modeInactiveBonds.add('probe');
      const ally = ctx.player(ctx.playerId);
      ally.addFunds(100); ally.board()[0].id = 'bad';
      ctx.source.kind = 'bad';
    } });
    const before = snapshot(ps), rng = m.rngMeta.state(), wave = structuredClone(m.wave);
    const inputs = [], construct = m.newBattle.bind(m);
    m.newBattle = (opts, flags) => { inputs.push(opts); return construct(opts, flags); };
    m.botRefinements = ['preview'];
    const plans = ['9,5', '9,6'].map(k => new LayoutPlan([[piece.uid, k]]));
    const gen = createRehearsalSteps(m, ps, [piece], plans);
    assert.equal(gen.next().done, false);
    assert.deepEqual(snapshot(ps), before, 'even a suspended generator leaves no candidate on the live board');
    const job = runSteps(gen); job.run();
    assert.deepEqual(snapshot(ps), before);
    assert.deepEqual(m.wave, wave);
    assert.equal(m.rngMeta.state(), rng);
    assert.equal(m.gd.modeInactiveBonds.has('probe'), false);
    assert.equal(inputs.length, 2);
    assert.equal(inputs[0].players[0].probe, inputs[1].players[0].probe);
    assert.ok(inputs.every(o => o.flags.layerGainsEnabled));
    const real = m._normalOpts(ps);
    assert.equal(inputs[0].seed, real.seed);
    assert.equal(inputs[0].players[0].probe, real.players[0].probe);
    assert.equal(ps.counters.probe, 999, 'real effects still mutate the actual match');
  } finally { m.dispose(); }
});

test('failed previews are discarded and cannot enter live diagnostics', () => {
  const reg = createRegistry();
  const h = makeMatch({ mode: 'solo', registry: reg, botRehearsal: 2 }).start().toPrep();
  const { m } = h, ps = m.order[0];
  try {
    const p = give(m, ps, 'chess_char_1_02_a', 'board', [9, 5]);
    reg.global('broken-preview', { onBattleStart() { throw new Error('broken'); } });
    m.botRefinements = ['preview'];
    const plans = ['9,5', '9,6'].map(k => new LayoutPlan([[p.uid, k]]));
    const job = runSteps(createRehearsalSteps(m, ps, [p], plans)); job.run();
    assert.equal(job.best, plans[0]);
    assert.equal(m.dispatcher.errors, 0);
    assert.deepEqual(h.logs.error, []);
    checkInvariants(m);
  } finally { m.dispose(); }
});

test('damage support must cover every incoming contact; a healer does not qualify', () => {
  const model = { routes: [{ tiles: ['a', 'x'] }, { tiles: ['b', 'x'] }], index: new Map([['x', [[0, 1], [1, 1]]]]) };
  const a = { ground: true, dps: 10, cover: new Set(['a', 'x']) };
  const b = { ground: true, dps: 10, cover: new Set(['b', 'x']) };
  assert.equal(supportedContact(model, [a], 'x'), false);
  assert.equal(supportedContact(model, [a, b], 'x'), true);
  assert.equal(supportedContact(model, [a, { ...b, heal: true }], 'x'), false);
});

test('repair moves an isolated guard into fire support without RNG or moving the dealer', () => {
  const records = {
    guard: { position: 'MELEE', attackKind: 'melee', stats: { atk: 10, blockCnt: 3 }, rangeGrid: [[0, 0]] },
    damage: { position: 'RANGED', attackKind: 'ranged', stats: { atk: 100, blockCnt: 0 }, rangeGrid: [[-1, 0], [-1, 1], [-1, 2]] },
  };
  const tiles = ['9,8', '9,7', '9,6', '9,5', '9,4'];
  const gd = { chess: id => records[id] };
  const m = { round: 1, stageId: 'fixture', wave: { templateId: 'test' }, gd, botRefinements: ['guards'],
    rngBots: () => { throw new Error('repair must not draw RNG'); },
    _botPath: { key: '1|fixture|test|', routes: [{ tiles, n: 1, hp: 10000, tileTime: 1 }],
      ground: new Map(tiles.map(k => [k, { flow: 1 }])), index: new Map(tiles.map((k, i) => [k, [[0, i]]])) } };
  const ps = { gd, deployMap: () => new Map([...tiles, '10,5'].map(k => [k, 'melee'])) };
  const pieces = [{ uid: 1, id: 'guard', kind: 'chess' }, { uid: 2, id: 'damage', kind: 'chess' }];
  const plan = new LayoutPlan([[1, '9,8'], [2, '10,5']]);
  const repaired = repairLayout(m, ps, pieces, plan);
  assert.ok(['9,6', '9,5'].includes(repaired.get(1)));
  assert.equal(repaired.get(2), '10,5');
  assert.equal(plan.get(1), '9,8', 'the original candidate remains intact');
});

test('repair leaves Boss and hidden layouts and RNG untouched even with a stale normal wave', () => {
  const { m } = makeMatch({ mode: 'solo' }).start().toPrep();
  try {
    m.botRefinements = ['guards', 'medics'];
    const ps = m.order[0], p = give(m, ps, 'chess_char_1_02_a', 'hand');
    const plan = new LayoutPlan([[p.uid, '9,5']]); plan.dirs.set(p.uid, 'LEFT');
    const rng = m.rngBots.state();
    for (const round of [m.bossRound, m.hiddenRound, 14]) {
      m.round = round;
      assert.deepEqual(repairLayout(m, ps, [p], plan), plan);
      assert.equal(m.rngBots.state(), rng);
    }
  } finally { m.dispose(); }
});

test('blocking-medic repair retains healing coverage while moving off an unsupported road', () => {
  const tiles = ['9,8', '9,7', '9,6', '9,5'];
  const records = {
    medic: { position: 'RANGED', attackKind: 'heal', stats: { atk: 100, blockCnt: 1 },
      rangeGrid: Array.from({ length: 9 }, (_, i) => Array.from({ length: 9 }, (_, j) => [i - 4, j - 4])).flat() },
    damage: { position: 'RANGED', attackKind: 'ranged', stats: { atk: 100, blockCnt: 0 }, rangeGrid: [[-1, 0], [-1, 1]] },
  };
  const gd = { chess: id => records[id] };
  const m = { round: 1, stageId: 'fixture', wave: { templateId: 'test' }, gd, botRefinements: ['medics'],
    rngBots: () => { throw new Error('repair must not draw RNG'); },
    _botPath: { key: '1|fixture|test|', routes: [{ tiles, n: 1, hp: 10000, tileTime: 1 }],
      ground: new Map(tiles.map(k => [k, { flow: 1 }])), index: new Map(tiles.map((k, i) => [k, [[0, i]]])) } };
  const ps = { gd, deployMap: () => new Map(['9,8', '10,8', '10,5'].map(k => [k, 'melee'])) };
  const pieces = [{ uid: 1, id: 'medic', kind: 'chess' }, { uid: 2, id: 'damage', kind: 'chess' }];
  const plan = new LayoutPlan([[1, '9,8'], [2, '10,5']]);
  const repaired = repairLayout(m, ps, pieces, plan);
  assert.equal(repaired.get(1), '10,8');
  assert.equal(repaired.get(2), '10,5');
  assert.equal(plan.get(1), '9,8');
});
