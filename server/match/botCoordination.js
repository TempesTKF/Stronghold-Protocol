// [ASSUMED] Complete-layout geometry, not a combat forecast. Normal-round bot coordination only.
// Enemies approach the first blocking body before reaching downstream tiles; every road body needs support.
const attacks = u => !u.heal && u.rec?.attackKind !== 'none' && u.dps > 0;
const blocks = u => (u.rec?.stats?.blockCnt ?? u.block ?? 0) > 0;

export function coordinationValue(model, units) {
  const supported = units.map(() => true), active = units.map(() => false);
  // A missing second entrance must not permit taking away the first entrance's existing support.
  const contacts = units.map(() => model.routes.map(() => null));
  const held = [], air = [], healed = units.map(u => units.some(h => h !== u && h.heal && h.cover.has(u.key)));
  let missing = 0, exposure = 0;
  for (const [ri, rt] of model.routes.entries()) {
    const fronts = rt.fly ? [] : units.map((u, i) => ({ u, i, at: rt.tiles.indexOf(u.key) }))
      .filter(f => blocks(f.u) && f.at >= 0);
    held.push(fronts.length > 0);
    for (const f of fronts) {
      const previous = rt.tiles[Math.max(0, f.at - 1)];
      const hasSupport = units.some(a => a !== f.u && attacks(a) && a.ground
        && a.cover.has(f.u.key) && a.cover.has(previous));
      contacts[f.i][ri] = hasSupport;
      if (!hasSupport) { supported[f.i] = false; missing++; }
    }
    const first = fronts.length ? Math.min(...fronts.map(f => f.at)) : rt.tiles.length - 1;
    const approach = rt.tiles.slice(0, first + 1);
    const contact = fronts.length ? rt.tiles[Math.max(0, first - 1)] : null;
    let airDps = 0;
    for (let i = 0; i < units.length; i++) {
      const u = units[i];
      if (!attacks(u) || (rt.fly ? !u.air : !u.ground)) continue;
      let tiles = approach.filter(k => u.cover.has(k)).length;
      // Contact is occupied longer than a traversed tile; retain incoming coverage as well as the blocker tile.
      if (contact && u.cover.has(contact)) tiles += 3;
      if (tiles) active[i] = true;
      exposure += (rt.n || 1) * u.dps * tiles;
      if (rt.fly && tiles) airDps += u.dps * tiles;
    }
    air.push(airDps);
  }
  const idle = units.filter((u, i) => attacks(u) && !active[i]).length;
  return { rank: [-missing, -idle, exposure], supported, contacts, active, held, air, healed };
}

/** Never repair one front by orphaning another, abandoning a held route or losing existing air/heal coverage. */
export function preservesCoordination(before, after) {
  return before.supported.every((v, i) => !v || after.supported[i])
    && before.contacts.every((row, i) => row.every((v, ri) => v !== true || after.contacts[i][ri] !== false))
    && before.active.every((v, i) => !v || after.active[i])
    && before.held.every((v, i) => !v || after.held[i])
    && before.air.every((v, i) => after.air[i] >= v)
    && before.healed.every((v, i) => !v || after.healed[i]);
}

export function betterCoordination(a, b) {
  for (let i = 0; i < a.rank.length; i++) {
    if (Math.abs(a.rank[i] - b.rank[i]) > 1e-9) return a.rank[i] > b.rank[i];
  }
  return false;
}
