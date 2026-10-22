// Local owner rule (2026-10-15): AI opening strategies exclude 歌利亚 / 杜宾 and prefer 伊奥莱塔·罗素, then Touch
// (botTouchPolicy 'experimental', the default; 'legacy' keeps the weighted pick after 罗素).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PHASE } from '../../shared/constants.js';
import { botPickBand } from '../../server/match/bot.js';
import { makeMatch } from './harness.js';

const PREFERRED = 'band_ioleta';
const TOUCH = 'band_amedic';
const BANNED = ['band_sarkazb', 'band_doberm'];
const DIFFICULTIES = ['FUNNY', 'NORMAL', 'HARD', 'ABYSS'];

test('AI takes 伊奥莱塔·罗素 whenever free, in solo and co-op at every difficulty', () => {
  for (const difficulty of DIFFICULTIES) for (const mode of ['solo', 'coop']) {
    const h = makeMatch({ mode, difficulty, seed: 19, fake: true });
    try {
      for (const roll of [0, 0.25, 0.5, 0.999999]) {
        let draws = 0;
        h.m.rngBots = () => { draws++; return roll; };
        assert.equal(botPickBand(h.m, h.m.order[0]), PREFERRED, `${mode}/${difficulty}/${roll}`);
        assert.equal(draws, 1, 'priority still consumes one seeded draw');
      }
    } finally { h.m.dispose(); }
  }
});

test('when the preferred strategy is taken, all remaining eligible strategies are possible and banned ones never are', () => {
  const h = makeMatch({ humans: 2, difficulty: 'HARD', fake: true });
  h.m.botTouchPolicy = 'legacy';
  const [human, bot] = h.m.order;
  try {
    h.m.draft = { picks: { [human.playerId]: PREFERRED } };
    const ids = h.m.gd.bandIds().filter((id) => id !== PREFERRED && !BANNED.includes(id));
    const seen = new Set();
    for (let i = 0; i < 10000; i++) {
      h.m.rngBots = () => (i + 0.5) / 10000;
      seen.add(botPickBand(h.m, bot));
    }
    assert.deepEqual([...seen].sort(), ids.sort(), 'no extra exclusion in HARD');
    assert.equal(botPickBand(h.m, human), PREFERRED, 'a player does not exclude its own draft entry');
  } finally { h.m.dispose(); }
});

test('Touch is the second priority: taken when 罗素 is absent or taken, by one seeded draw; legacy draws', () => {
  let checked = 0;
  for (const difficulty of DIFFICULTIES) {
    const h = makeMatch({ humans: 2, difficulty, fake: true });
    const [human, bot] = h.m.order;
    try {
      assert.equal(h.m.botTouchPolicy, 'experimental', 'the default');
      if (!h.m.gd.bandIds().includes(TOUCH)) continue;
      checked++;
      h.m.draft = { picks: { [human.playerId]: PREFERRED } };
      for (const roll of [0, 0.5, 0.999999]) {
        let draws = 0;
        h.m.rngBots = () => { draws++; return roll; };
        assert.equal(botPickBand(h.m, bot), TOUCH, difficulty + '/' + roll);
        assert.equal(draws, 1, 'the Touch pick still consumes one seeded draw');
      }
      h.m.draft = { picks: {} };
      h.m.rngBots = () => 0.5;
      assert.equal(botPickBand(h.m, bot), PREFERRED, '罗素 first');
      h.m.draft = { picks: { [human.playerId]: TOUCH } };
      h.m.gd.bandIds = () => h.m.gd.constructor.prototype.bandIds.call(h.m.gd).filter((id) => id !== PREFERRED);
      const seen = new Set();
      for (let i = 0; i < 2000; i++) { h.m.rngBots = () => (i + 0.5) / 2000; seen.add(botPickBand(h.m, bot)); }
      assert.ok(!seen.has(TOUCH) && seen.size > 1, 'Touch taken by a teammate: the weighted pick');
      h.m.draft = { picks: { [human.playerId]: PREFERRED } };
      delete h.m.gd.bandIds;
      h.m.botTouchPolicy = 'legacy';
      const legacy = new Set();
      for (let i = 0; i < 2000; i++) { h.m.rngBots = () => (i + 0.5) / 2000; legacy.add(botPickBand(h.m, bot)); }
      assert.ok(legacy.size > 1 && legacy.has(TOUCH), 'legacy: Touch only by the weighted draw');
    } finally { h.m.dispose(); }
  }
  assert.ok(checked > 0, 'Touch is offered in some difficulty');
});

test('preferred absent from the mode offer: AI uses the remaining allowed strategy', () => {
  const h = makeMatch({ fake: true });
  try {
    h.m.gd.bandIds = () => [...BANNED, 'band_amiya'];
    for (const roll of [0, 0.5, 0.999999]) {
      h.m.rngBots = () => roll;
      assert.equal(botPickBand(h.m, h.m.order[0]), 'band_amiya');
    }
    h.m.gd.bandIds = () => BANNED;
    assert.equal(botPickBand(h.m, h.m.order[0]), h.m.gd.defaultBandId, 'safe default for an exhausted custom offer');
    Object.defineProperty(h.m.gd, 'defaultBandId', { value: BANNED[0] });
    assert.equal(botPickBand(h.m, h.m.order[0]), null, 'a fallback cannot select a forbidden strategy');
  } finally { h.m.dispose(); }
});

test('four AI seats finish a real draft with distinct allowed strategies and exactly one priority pick', () => {
  for (const difficulty of DIFFICULTIES) for (const seed of [1, 2, 7, 41]) {
    const h = makeMatch({ humans: 0, bots: 4, difficulty, seed, fake: true }).start();
    try {
      h.runToPhase(PHASE.BATTLE_CHECK);
      const ids = h.m.order.map((ps) => ps.bandId);
      assert.equal(new Set(ids).size, 4);
      assert.equal(ids.filter((id) => id === PREFERRED).length, 1);
      assert.ok(ids.every((id) => !BANNED.includes(id)));
      assert.equal(h.m.draft.picks[h.m.draft.order[0]], PREFERRED);
    } finally { h.m.dispose(); }
  }
});

test('human picks remain unrestricted; AI never duplicates a human priority pick', () => {
  for (const bandId of [...BANNED, PREFERRED]) {
    const h = makeMatch({ humans: 1, bots: 3, aiPicksLast: true, fake: true }).start();
    try {
      assert.deepEqual(h.m.handle('p_0', { t: 'g.infoReady' }), { ok: true });
      h.runToPhase(PHASE.BAND_DRAFT);
      assert.deepEqual(h.m.handle('p_0', { t: 'g.band', bandId }), { ok: true });
      h.runToPhase(PHASE.BATTLE_CHECK);
      const bots = h.m.order.filter((ps) => ps.isBot).map((ps) => ps.bandId);
      assert.ok(bots.every((id) => !BANNED.includes(id)));
      assert.equal(bots.includes(PREFERRED), bandId !== PREFERRED);
      assert.equal(new Set(h.m.order.map((ps) => ps.bandId)).size, 4);
    } finally { h.m.dispose(); }
  }
});

test('AI takeover and timeout ignore a forbidden highlight and choose the preferred strategy', () => {
  const h = makeMatch({ humans: 1, bots: 1, aiPicksLast: true, fake: true }).start();
  try {
    h.m.handle('p_0', { t: 'g.infoReady' });
    h.runToPhase(PHASE.BAND_DRAFT);
    h.m.handle('p_0', { t: 'g.bandFocus', bandId: BANNED[0] });
    assert.equal(h.m.timeoutBand('p_0'), BANNED[0], 'a human keeps their highlighted choice');
    const human = h.ps('p_0');
    human.autoplay = true;
    assert.equal(h.m.timeoutBand('p_0'), PREFERRED, 'AI timeout follows the bot policy');
    h.m.scheduleBandBot();
    h.runToPhase(PHASE.BATTLE_CHECK);
    assert.equal(human.bandId, PREFERRED);
    assert.ok(!BANNED.includes(h.ps('ai_0').bandId));
  } finally { h.m.dispose(); }
});

test('forced draft completion applies the same policy to unpicked AI seats', () => {
  const h = makeMatch({ humans: 0, bots: 4, fake: true }).start();
  try {
    h.runToPhase(PHASE.BAND_DRAFT);
    h.m.finishBandDraft(true);
    assert.equal(h.m.phase, PHASE.BATTLE_CHECK);
    const ids = h.m.order.map((ps) => ps.bandId);
    assert.equal(new Set(ids).size, 4);
    assert.equal(ids.filter((id) => id === PREFERRED).length, 1);
    assert.ok(ids.every((id) => !BANNED.includes(id)));
  } finally { h.m.dispose(); }
});
