'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createTestDb, seedTenantAndOwner, seedScoringScenario } = require('../helpers/pg');
const { calculateEventSkinsForDays } = require('../../src/services/scoring/skins.service');

// Adds a second round to an existing tour (shares the same course)
async function addRound(db, tour, course, roundNumber) {
  const [round] = await db('golf_rounds').insert({
    tour_id: tour.id,
    round_number: roundNumber,
    course_id: course.id,
    calc_type: 'stableford',
    status: 'open',
    tour_date: `2030-01-0${roundNumber}`,
    leaderboard_published: false,
    ambrose_prizes: '[]',
  }).returning('*');
  return round;
}

// Adds a second player to the tour with an individual scorecard for the given round
async function addPlayer(db, tenantId, tour, roundNumber, email) {
  const ts = Date.now();
  const [user] = await db('users').insert({
    first_name: 'Extra', last_name: 'Player',
    email: email || `extra-${ts}@test.local`,
    email_verified_at: db.fn.now(),
  }).returning('*');
  await db('tenant_memberships').insert({ tenant_id: tenantId, user_id: user.id, role: 'player' });
  await db('event_players').insert({ tour_id: tour.id, user_id: user.id, status: 'active' });
  await db('player_handicaps').insert({ tour_id: tour.id, user_id: user.id, playing_handicap: 18 });
  const [sc] = await db('scorecards').insert({
    tour_id: tour.id, round_number: roundNumber, type: 'individual',
    user_id: user.id, status: 'draft',
  }).returning('*');
  return { user, scorecard: sc };
}

// Records a stableford score for a player on a specific hole
async function scoreHole(db, scorecardId, holeNumber, grossScore, stablefordPoints) {
  await db('scorecard_holes').insert({
    scorecard_id: scorecardId,
    hole_number: holeNumber,
    gross_score: grossScore,
    stableford_points: stablefordPoints,
  });
}

test('unscored holes do not accumulate carry in skins calculation', async () => {
  const db = await createTestDb();
  const ts = Date.now();

  try {
    const { tenant, owner } = await seedTenantAndOwner(db, { slug: `skins-empty-${ts}` });
    const { tour, scorecard } = await seedScoringScenario(db, tenant.id, owner.id);

    // No scores entered — all 18 holes empty
    const result = await calculateEventSkinsForDays(db, tour.id, [1]);

    assert.equal(result.holes.length, 0, 'no holes should be written when none are scored');
    assert.equal(result.winners.length, 0);
  } finally {
    await db.destroy();
  }
});

test('empty round after scored round does not multiply the carry', async () => {
  const db = await createTestDb();
  const ts = Date.now();

  try {
    const { tenant, owner } = await seedTenantAndOwner(db, { slug: `skins-carry-${ts}` });
    const { tour, course, scorecard: sc1 } = await seedScoringScenario(db, tenant.id, owner.id);

    // Add a second player so ties are possible (2 players each scoring the same)
    const { scorecard: sc2 } = await addPlayer(db, tenant.id, tour, 1, `extra-${ts}@test.local`);

    // Round 1: both players tie on hole 1 (jackpot → should carry to hole 2)
    //          player A wins hole 2 outright
    //          no other holes scored
    await scoreHole(db, sc1.id, 1, 4, 2); // par 4, tied
    await scoreHole(db, sc2.id, 1, 4, 2); // par 4, tied
    await scoreHole(db, sc1.id, 2, 3, 3); // birdie — wins
    await scoreHole(db, sc2.id, 2, 5, 1); // bogey

    // Round 2: no scores at all
    await addRound(db, tour, course, 2);
    const { scorecard: sc3 } = await addPlayer(db, tenant.id, tour, 2, `extra2-${ts}@test.local`);
    // sc3 exists but has no scorecard_holes

    const result = await calculateEventSkinsForDays(db, tour.id, [1, 2]);

    // Should only have entries for the 2 scored holes of round 1
    const r1Holes = result.holes.filter((h) => Number(h.round_number) === 1);
    const r2Holes = result.holes.filter((h) => Number(h.round_number) === 2);

    assert.equal(r1Holes.length, 2, 'round 1 should have 2 holes (the 2 that were scored)');
    assert.equal(r2Holes.length, 0, 'round 2 should have no holes — nothing was scored');

    // Hole 1 of round 1 is a jackpot (2-player tie)
    const hole1 = r1Holes.find((h) => Number(h.hole_number) === 1);
    assert.equal(hole1.status, 'jackpot', 'tied hole should be a jackpot');
    assert.equal(hole1.winning_participant_id, null);

    // Hole 2 of round 1 is won (carry from hole 1 included)
    const hole2 = r1Holes.find((h) => Number(h.hole_number) === 2);
    assert.equal(hole2.status, 'won', 'hole 2 should be won');
    assert.ok(hole2.carry_in_amount > 0, 'carry from hole 1 jackpot should appear in hole 2');

    // Total carry into hole 2 = basePot (hole 1) + basePot (hole 2) — no more
    // basePot = active player count × stake (1). With 2 players basePot = 2.
    // hole 1 totalPot = 2, no winner → carryIn for hole 2 = 2
    // hole 2 totalPot = 2 + 2 = 4
    assert.equal(Number(hole2.total_pot_amount), Number(hole1.base_pot_amount) * 2,
      'carry should be exactly 1 jackpot worth of skins — not multiplied by 18 empty holes');
  } finally {
    await db.destroy();
  }
});

test('cross-round carry does not grow through unscored holes', async () => {
  const db = await createTestDb();
  const ts = Date.now();

  try {
    const { tenant, owner } = await seedTenantAndOwner(db, { slug: `skins-xround-${ts}` });
    const { tour, course, scorecard: sc1 } = await seedScoringScenario(db, tenant.id, owner.id);
    const { scorecard: sc2 } = await addPlayer(db, tenant.id, tour, 1, `extra-${ts}@test.local`);

    // Round 1 hole 18 ties → should carry to round 2
    await scoreHole(db, sc1.id, 18, 4, 2);
    await scoreHole(db, sc2.id, 18, 4, 2);

    // Round 2 exists but has no scores
    await addRound(db, tour, course, 2);

    const result = await calculateEventSkinsForDays(db, tour.id, [1, 2]);

    const r2Holes = result.holes.filter((h) => Number(h.round_number) === 2);
    assert.equal(r2Holes.length, 0,
      'round 2 has no scores so no skins_holes should be written — carry must not multiply through 18 empty holes');

    // The carry from round 1 hole 18 should be tracked in skins_carry
    const carry = await db('skins_carry')
      .where({ tour_id: tour.id, from_round_number: 1, from_hole: 18 })
      .first();
    assert.ok(carry, 'skins_carry row should exist for the round-1 hole-18 jackpot');
    assert.equal(Number(carry.to_round_number), 2);
    assert.equal(Number(carry.to_hole), 1);
  } finally {
    await db.destroy();
  }
});
