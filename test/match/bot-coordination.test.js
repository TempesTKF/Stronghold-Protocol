import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arrange, coordinatePlanSteps, runSteps, fieldModel, planLayout as initialPlan, rangeRec, rangeTiles } from '../../server/match/bot.js';
import { canPlace, parseKey, placeClass } from '../../server/match/board.js';
import { createRng } from '../../server/sim/rng.js';
import { makeMatch, give, checkInvariants } from './harness.js';
import { FakeBattle } from './fakeBattle.js';
import { C2S } from '../../shared/protocol.js';

const route = (row, reverse = false, extra = {}) => ({
  tiles: Array.from({ length: 8 }, (_, i) => `${row},${reverse ? 9 - i : i + 2}`),
  n: 1, hp: 100, fly: false, tileTime: 2, ...extra,
});

// Small route/deployment fixtures isolate complete-layout decisions. Operators keep their real
// records, loadouts, ranges and placement classes; no ignored benchmark snapshot is needed.
function fixture(t, { ids, tiles, routes, rehearsal = 0 }) {
  const h = makeMatch({ mode: 'solo', difficulty: 'HARD', seed: 11, botRehearsal: rehearsal, fake: true })
    .start().toPrep().setStage('act2autochess_m04');
  const { m } = h, ps = m.order[0];
  t.after(() => m.dispose());
  m.round = 10;
  const pieces = ids.map(id => give(m, ps, `chess_char_${id}`, 'hand'));
  const deploy = new Map(tiles);
  ps.deployMap = () => deploy;
  const model = fieldModel(m, ps);
  model.routes = routes;
  model.ground = new Map();
  model.index = new Map();
  model.airflow.clear();
  model.armor = [];
  model.flyTotal = routes.filter(rt => rt.fly).reduce((n, rt) => n + rt.n, 0);
  routes.forEach((rt, ri) => rt.tiles.forEach((key, i) => {
    model.index.set(key, [...(model.index.get(key) || []), [ri, i]]);
    if (!rt.fly) model.ground.set(key, { flow: (model.ground.get(key)?.flow || 0) + rt.n });
  }));
  return { m, ps, pieces, model };
}

function unitsOf(ps, pieces, plan) {
  return pieces.map(p => {
    const key = plan.get(p.uid), rec = rangeRec(ps, ps.gd.chess(p.id));
    assert.ok(key, `${rec.name} is deployed`);
    assert.ok(canPlace(ps.deployMap(), placeClass(ps, rec), ...parseKey(key)), `${rec.name} has a legal tile`);
    return { uid: p.uid, key, rec, cover: new Set(rangeTiles(rec, ...parseKey(key), plan.dirOf(p.uid))) };
  });
}

function supportedFronts(model, units) {
  return units.filter(u => u.rec.position === 'MELEE' && u.rec.stats.blockCnt > 0 && model.ground.has(u.key))
    .filter(front => (model.index.get(front.key) || []).every(([ri, i]) => {
      const rt = model.routes[ri];
      return rt.fly || units.some(ally => ally !== front && ally.rec.attackKind !== 'heal'
        && ally.rec.attackKind !== 'none' && ally.rec.stats.atk > 0
        && ally.cover.has(front.key) && ally.cover.has(rt.tiles[Math.max(0, i - 1)]));
    }));
}

const planSignature = plan => [...plan].sort(([a], [b]) => a - b)
  .map(([uid, key]) => `${uid}@${key}:${plan.dirOf(uid)}`).join(' ');

const twoLanes = {
  ids: ['1_02_a', '3_16_a', '3_21_a', '1_06_a'], // Matterhorn, Cuora, Archetto, Vendela
  tiles: [['9,4', 'melee'], ['12,4', 'melee'], ['10,5', 'ranged'], ['11,5', 'ranged']],
  routes: [route(9), route(12)],
};

test('a complete formation aims Archetto at the first blocker and its incoming contact, beyond saturated road scores', t => {
  const { m, ps, pieces, model } = fixture(t, {
    ids: ['1_02_a', '3_21_a'], tiles: [['9,4', 'melee'], ['10,5', 'ranged']], routes: [route(9)],
  });
  m.rngBots = () => { throw new Error('complete-layout coordination must not draw RNG'); };
  const before = planLayout(m, ps, pieces, undefined, { formation: true, coordinate: false });
  const oldUnits = unitsOf(ps, pieces, before), oldArchetto = oldUnits[1];
  assert.ok(oldArchetto.cover.has('9,4'), 'the old range reaches the blocker tile');
  assert.ok(oldArchetto.cover.has('9,6'), 'the old range also reaches downstream road');
  assert.ok(!oldArchetto.cover.has('9,3'), 'the old direction misses the actual incoming contact');
  assert.equal(supportedFronts(model, oldUnits).length, 0);

  const after = planLayout(m, ps, pieces, undefined, { formation: true });
  const units = unitsOf(ps, pieces, after);
  assert.equal(supportedFronts(model, units).length, 1);
  assert.ok(units[1].cover.has('9,3') && units[1].cover.has('9,4'));
  assert.equal(after.get(pieces[1].uid), before.get(pieces[1].uid), 'the available direction repair keeps its legal tile');
  assert.deepEqual(planLayout(m, ps, pieces, undefined, { formation: true }), after, 'the repair is deterministic');
});

test('separate front lines each receive their own damage support after the full formation is placed', t => {
  const { m, ps, pieces, model } = fixture(t, twoLanes);
  const before = planLayout(m, ps, pieces, undefined, { formation: true, coordinate: false });
  assert.equal(supportedFronts(model, unitsOf(ps, pieces, before)).length, 0, 'both old lanes miss their incoming contact');
  const plan = planLayout(m, ps, pieces, undefined, { formation: true });
  const units = unitsOf(ps, pieces, plan), fronts = supportedFronts(model, units);
  assert.equal(fronts.length, 2, 'both distinct blockers get support');
  for (const row of [9, 12]) {
    assert.ok(fronts.some(front => front.key === `${row},4`), `the front on row ${row} is supported`);
    assert.ok(units.slice(2).some(ally => ally.cover.has(`${row},3`) && ally.cover.has(`${row},4`)),
      `a damage dealer covers row ${row}'s blocker and incoming contact`);
  }
});

test('repairing a different front never rotates away the only support of an already supported front', t => {
  const { m, ps, pieces, model } = fixture(t, {
    ids: ['1_02_a', '3_16_a', '3_21_a'],
    tiles: [['9,4', 'melee'], ['11,6', 'melee'], ['10,5', 'ranged']],
    routes: [route(9, false, { n: 2, hp: 1000 }), route(11, true, { hp: 1000 })],
  });
  const before = planLayout(m, ps, pieces, undefined, { formation: true, coordinate: false });
  const supported = supportedFronts(model, unitsOf(ps, pieces, before));
  assert.equal(supported.length, 1, 'one dealer can support only one of the opposing contact pairs');
  const plan = planLayout(m, ps, pieces, undefined, { formation: true });
  const after = supportedFronts(model, unitsOf(ps, pieces, plan));
  assert.ok(after.some(front => front.uid === supported[0].uid), 'the existing supported blocker stays supported');
});

test('a front with two incoming routes retains support of one entrance while the other remains uncovered', t => {
  const { m, ps, pieces, model } = fixture(t, {
    ids: ['1_02_a', '3_21_a'], tiles: [['10,4', 'melee'], ['11,5', 'ranged']],
    routes: [route(10, false, { hp: 1000 }),
      { tiles: ['9,4', '10,4', '11,4', '12,4'], n: 2, hp: 1000, fly: false, tileTime: 2 }],
  });
  const before = planLayout(m, ps, pieces, undefined, { formation: true, coordinate: false });
  const oldUnits = unitsOf(ps, pieces, before), oldArchetto = oldUnits[1];
  assert.equal(supportedFronts(model, oldUnits).length, 0, 'the blocker lacks support on one of its two entrances');
  assert.ok(oldArchetto.cover.has('10,4') && oldArchetto.cover.has('10,3'), 'the horizontal entrance has support');
  assert.ok(!oldArchetto.cover.has('9,4'), 'the vertical entrance lacks support');
  const plan = planLayout(m, ps, pieces, undefined, { formation: true });
  const archetto = unitsOf(ps, pieces, plan)[1];
  assert.ok(archetto.cover.has('10,4') && archetto.cover.has('10,3'),
    'supporting the vertical entrance cannot replace the existing horizontal support');
});

test('a contact repair preserves the sole anti-air coverage when ground support and air coverage compete', t => {
  const { m, ps, pieces } = fixture(t, {
    ids: ['1_02_a', '3_21_a'], tiles: [['9,4', 'melee'], ['10,5', 'ranged']],
    routes: [route(9), { tiles: ['9,8'], n: 10, hp: 100, fly: true, tileTime: 2 }],
  });
  const before = planLayout(m, ps, pieces, undefined, { formation: true, coordinate: false });
  const oldArchetto = unitsOf(ps, pieces, before)[1];
  assert.ok(oldArchetto.rec.canHitFly && oldArchetto.cover.has('9,8'), 'the old layout covers the air route');
  const plan = planLayout(m, ps, pieces, undefined, { formation: true });
  const archetto = unitsOf(ps, pieces, plan)[1];
  assert.ok(archetto.cover.has('9,8'), 'fixing ground contact cannot abandon that air route');
  assert.equal(plan.dirOf(pieces[1].uid), before.dirOf(pieces[1].uid));
});


function planLayout(m, ps, pieces, params, opts = {}) {
  const plan = initialPlan(m, ps, pieces, params, opts);
  return opts.coordinate === false ? plan : runSteps(coordinatePlanSteps(m, ps, pieces, plan));
}

test('final non-adaptive arrangement retains every original candidate and adds coordinated alternatives without RNG', t => {
 const {m,ps,pieces,model}=fixture(t,{...twoLanes,rehearsal:3});
 m.botFormationMode='learned';m.botFormationEnabled=false;m.rngBots=createRng(123);
 const original=arrange(m,ps,{final:true,defer:true}),tail=m.rngBots();
 m.botFormationEnabled=true;m.rngBots=createRng(123);
 const job=arrange(m,ps,{final:true,defer:true});
 assert.ok(job);assert.equal(m.rngBots(),tail);
 const signatures=new Set(job.plans.map(planSignature));
 for(const p of original.plans)assert.ok(signatures.has(planSignature(p)));
 assert.ok(job.plans.length<=2*(m.botRehearsal+1));
 assert.equal(supportedFronts(model,unitsOf(ps,pieces,job.plans[0])).length,2);
});

test('a leaking coordinated layout loses to an original zero-leak layout',t=>{
 const {m,ps,model}=fixture(t,{...twoLanes,rehearsal:3});
 m.botFormationMode='learned';t.after(()=>FakeBattle.reset());
 const seen=[];
 FakeBattle.script=b=>{
  const units=b.opts.players.find(p=>p.playerId===ps.playerId).units.map(u=>{
   const rec=rangeRec(ps,ps.gd.chess(u.chessId));
   return {uid:u.uid,key:u.row+','+u.col,rec,cover:new Set(rangeTiles(rec,u.row,u.col,u.dir))};
  });
  const n=supportedFronts(model,units).length;seen.push(n);
  return {duration:0.1,leaks:{[ps.playerId]:n===2?2:0}};
 };
 const job=arrange(m,ps,{final:true,defer:true});job.run();
 assert.ok(seen.includes(2)&&seen.some(n=>n<2));
 assert.ok(supportedFronts(model,unitsOf(ps,job.chosen,job.best)).length<2);
});

test('coordination keeps pure medics fixed and handles Vendela as a damage dealer',t=>{
 const {m,ps,pieces}=fixture(t,{ids:['1_02_a','1_06_a','2_05_a'],tiles:[['9,4','melee'],['10,5','ranged'],['10,6','ranged']],routes:[route(9)]});
 const before=initialPlan(m,ps,pieces,undefined,{formation:true});
 const after=runSteps(coordinatePlanSteps(m,ps,pieces,before));
 const medic=pieces[2];assert.equal(rangeRec(ps,ps.gd.chess(medic.id)).attackKind,'heal');
 assert.equal(after.get(medic.uid),before.get(medic.uid));assert.equal(after.dirOf(medic.uid),before.dirOf(medic.uid));
 assert.notEqual(rangeRec(ps,ps.gd.chess(pieces[1].id)).attackKind,'heal');
});

test('final coordinated arrangement redeploys Muelsyse summons within their owner range', t => {
 const h=makeMatch({mode:'solo',difficulty:'HARD',seed:11,fake:true,botRehearsal:0}).start().toPrep().setStage('act2autochess_m04');
 const {m}=h,ps=m.order[0];t.after(()=>m.dispose());m.round=10;m.botFormationMode='learned';
 for(const id of ['chess_char_6_11_a','chess_char_1_02_a','chess_char_3_21_a'])give(m,ps,id,'hand');
 for(let pass=0;pass<2;pass++) {
  arrange(m,ps,{final:true});
  const tokens=[...ps.board].filter(([,p])=>p.kind==='token');
  assert.ok(tokens.some(([,p])=>p.id==='token_10030_mlyss_wtrman'));
  for(const [key,p]of ps.board)assert.ok(ps._legal(p,...parseKey(key)));
  for(const [key,p]of tokens)assert.ok(ps.summonRange(p)?.has(key));
  checkInvariants(m);
 }
});

test('delegated rehearsal protocol accepts expanded candidate indices and rejects invalid bounds',()=>{
 const valid=C2S['b.rehearsalResult'].choice;
 for(const n of [0,7,8,19,20,39])assert.equal(valid(n),true);
 for(const n of [-1,40,0.5,'8',NaN,Infinity])assert.equal(valid(n),false);
});

test('adaptive can select a repaired suffix after every original leaks, within unchanged limits', t => {
 const {m,ps}=fixture(t,{...twoLanes,rehearsal:3});
 m.botFormationMode='adaptive';t.after(()=>FakeBattle.reset());
 const job=arrange(m,ps,{final:true,defer:true});
 const index=job.plans.findIndex(p=>p.source?.startsWith('coordinate:'));
 assert.ok(index>0,'there is a distinct repaired suffix');
 assert.ok(job.plans.slice(0,index).every(p=>!p.source.startsWith('coordinate:')));
 const winning=job.plans[index];let built=0;
 FakeBattle.script=b=>{
  built++;
  const matches=b.opts.players.find(p=>p.playerId===ps.playerId).units.every(u=>
   winning.get(u.uid)===u.row+','+u.col&&winning.dirOf(u.uid)===u.dir);
  return {duration:0.1,leaks:{[ps.playerId]:matches?0:1}};
 };
 job.run();
 assert.equal(job.best,winning);
 assert.equal(built,index+1,'the zero-leak repaired plan stops further expansion');
 assert.equal(job.limits.stage,3);
});
