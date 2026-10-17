# Complete-layout coordination — 2026-10-17

This follow-up to TKF PR #3 adds bounded, deterministic geometry repair to final ordinary-round layouts.
The implementation and historical experiments have different candidate ordering/budget contexts; the
numbers below retain their original baselines. The paired rows and original local log SHA-256 values are
in [bot-coordination-results.json](bot-coordination-results.json). Ignored source snapshots are local research
inputs; the shipped regression tests use small reproducible route fixtures and real operator records.

## Implementation

`server/match/botCoordination.js` scores support on each incoming contact, damage dealers that can attack
before the first blocking body, and approach exposure. `coordinatePlanSteps` clones a completed candidate,
turns dealers first and then tries free legal tiles, for at most two passes. It retains existing support,
air and healing coverage, active dealers and held routes. Ranged units can be blocking bodies; incantation
medics are damage dealers. Pure medics and summons are not moved by this repair. Application uses the
existing summon withdrawal/redeployment path. No additional bot RNG is drawn by the geometry search.

Ordinary learned/combined modes retain their previous candidates plus repaired copies. Adaptive retains
all original candidates as an unchanged prefix, then appends repaired copies under its existing stage 3
and 12-cap tick limits. Thus a zero-leak original still ends adaptive expansion. Disabled rehearsal uses
the repaired plan directly. Explicit legacy/disabled formation, unknown maps and Boss/Hidden rounds bypass
this integration. Host answer indices accept 0–39 and the server also validates the actual sent count.

These are [ASSUMED] AI heuristics, building on upstream #452 and 0.3.0 medic-placement rules. Range and
deployment legality come from the existing game data. The geometry does not forecast survival or skill timing.

## Historical paired evidence

1. Ioleta, learned formation before/after coordination: HARD/ABYSS seeds 71–75, R8–11, 40 frozen snapshots.
   Counted rehearsal leaks 66 → 59; four improvements and 36 ties. This was the local learned-mode integration,
   not the adaptive-prefix integration in this TKF patch. Archetto's focused replay went from zero attacks to
   70 attacks / 67,042 damage; Vendela to 56 attacks / 68,714 damage / 10,322 healing, both retaining zero leaks.
2. Default-layout comparison: the layout implementation at TKF `61c6e614`, with the local battle engine,
   HARD/ABYSS seed 71, R10–11. Default → default plus coordination: Ioleta 7 → 7 (4 pairs), Amiya 0 → 0
   (4 pairs), Cannot 9 → 9 (3 valid pairs), Touch 19 → 15 (4 pairs). The old transplant harness invalidated
   one Cannot/Muelsyse token placement; its entire pair was excluded. These rows count all leaked enemies.
3. Equal-cohort follow-up: each of the four roles had 37 identical difficulty/seed/round samples. Discovery
   used seeds 71–72 (16 each); validation used 73–75 (21 each). The three snapshots with a dead seat were
   excluded for every role. Seeds 73–75 existed in earlier research; they were not used to select these new rules.
   Full production deployment, including summons, replaced token transplantation. All comparisons retain the
   selected operator roster/equipment and use counted leaks. There were 592 direct rule scenarios and 84
   selected-plan replays; replayed results matched exactly and all deployed pieces passed legality checks.

In validation, direct medic-coverage expansion changed leaks 228 → 231, active-dealer exposure maximization
228 → 318, and their combination 228 → 313. The frozen exploratory selector kept zero-leak baselines and
otherwise tested one exposure alternative: Ioleta 34 → 34, Amiya 82 → 76, Cannot 55 → 52, Touch 57 → 57,
total 228 → 219 (four improvements / 80 ties), requiring 30 extra trials. This offline selector evaluates
fully deployed battle inputs; it is research evidence, not an implementation of this patch's adaptive search.
The active-dealer and medic-expansion rules are not shipped.

The snapshots isolate single-wave placement. The cohort totals cannot be combined into a full-match win rate.
Extra candidates cost preparation time; a selected zero-leak outcome does not guarantee faster clearance.

## Validation

The PR description records checks performed on this TKF branch and the moved golden scenarios separately.
