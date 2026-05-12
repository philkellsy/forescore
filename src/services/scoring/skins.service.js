'use strict';

const HOLE_SEQUENCE = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18];
const SKIN_STAKE_PER_PLAYER = 1;

function nextHole(roundNumbers, roundNumber, holeNumber) {
  if (holeNumber < 18) return { roundNumber, holeNumber: holeNumber + 1 };
  const idx = roundNumbers.indexOf(roundNumber);
  if (idx < roundNumbers.length - 1) return { roundNumber: roundNumbers[idx + 1], holeNumber: 1 };
  return null;
}

async function getActivePlayerCount(db, tourId) {
  const row = await db('event_players')
    .where({ tour_id: tourId })
    .andWhere((q) => q.where('status', 'active').orWhereNull('status'))
    .count({ total: '*' })
    .first();

  return Number(row?.total || 0);
}

function analyzeHole(rows) {
  if (!rows.length) return { winner: null, tiedCount: 0, topStableford: 0 };
  const maxPoints = Math.max(...rows.map((r) => Number(r.stableford || 0)));
  const topScorers = rows.filter((r) => Number(r.stableford || 0) === maxPoints);
  if (topScorers.length !== 1) return { winner: null, tiedCount: topScorers.length, topStableford: maxPoints };
  return {
    winner: {
      participantId: topScorers[0].participant_id,
      stableford: maxPoints,
      gross: Number(topScorers[0].gross || 0)
    },
    tiedCount: 1,
    topStableford: maxPoints
  };
}

async function getHoleResults(db, tourId, roundNumber, holeNumber, participantType) {
  if (participantType === 'team') {
    return db('scorecards as s')
      .join('scorecard_holes as sh', 'sh.scorecard_id', 's.id')
      .where({ 's.tour_id': tourId, 's.round_number': roundNumber, 's.type': 'team', 'sh.hole_number': holeNumber })
      .whereNotNull('s.team_id')
      .select({ participant_id: 's.team_id', stableford: 'sh.stableford_points', gross: 'sh.gross_score' });
  }

  return db('scorecards as s')
    .join('scorecard_holes as sh', 'sh.scorecard_id', 's.id')
    .where({ 's.tour_id': tourId, 's.round_number': roundNumber, 's.type': 'individual', 'sh.hole_number': holeNumber })
    .whereNotNull('s.user_id')
    .select({ participant_id: 's.user_id', stableford: 'sh.stableford_points', gross: 'sh.gross_score' });
}

async function writeSkinsHole(db, row) {
  const existing = await db('skins_holes')
    .where({ tour_id: row.tour_id, round_number: row.round_number, hole_number: row.hole_number })
    .first();

  if (existing) {
    await db('skins_holes').where({ id: existing.id }).update({ ...row, updated_at: db.fn.now() });
    return;
  }

  await db('skins_holes').insert(row);
}

async function calculateEventSkinsForDays(db, tourId, finalizedRoundNumbers = [], options = {}) {
  const activePlayerCount = await getActivePlayerCount(db, tourId);
  const basePot = Number(activePlayerCount * SKIN_STAKE_PER_PLAYER);
  const initialCarryInSkins = Math.max(0, Math.trunc(Number(options.initialCarryInSkins || 0)));

  await db('skins_holes').where({ tour_id: tourId }).del();
  await db('skins_carry').where({ tour_id: tourId }).del();

  if (!finalizedRoundNumbers.length) {
    return {
      stakePerPlayer: SKIN_STAKE_PER_PLAYER,
      activePlayerCount,
      initialCarryInSkins,
      holes: [],
      winners: []
    };
  }

  // Determine participant type per round from golf_rounds.calc_type
  const roundRows = await db('golf_rounds')
    .where({ tour_id: tourId })
    .whereIn('round_number', finalizedRoundNumbers)
    .orderBy('round_number')
    .select('round_number', 'calc_type');

  const roundTypeMap = new Map(roundRows.map((r) => [Number(r.round_number), r.calc_type]));
  const orderedRounds = roundRows.map((r) => Number(r.round_number));

  let carryIn = basePot > 0 ? initialCarryInSkins * basePot : 0;
  const tiedCountMap = new Map();
  const topStablefordMap = new Map();

  for (const roundNumber of orderedRounds) {
    const calcType = roundTypeMap.get(roundNumber);
    const participantType = calcType === 'ambrose_nett' ? 'team' : 'player';

    for (const holeNumber of HOLE_SEQUENCE) {
      const results = await getHoleResults(db, tourId, roundNumber, holeNumber, participantType);
      if (!results.length) continue; // hole not yet scored — no pot contribution, no carry change
      const totalPot = basePot + carryIn;
      const { winner, tiedCount, topStableford } = analyzeHole(results);
      const status = winner ? 'won' : 'jackpot';

      tiedCountMap.set(`${roundNumber}:${holeNumber}`, tiedCount);
      topStablefordMap.set(`${roundNumber}:${holeNumber}`, topStableford);

      await writeSkinsHole(db, {
        tour_id: tourId,
        round_number: roundNumber,
        hole_number: holeNumber,
        participant_type: participantType,
        winning_participant_id: winner ? winner.participantId : null,
        winning_gross: winner ? winner.gross : null,
        winning_stableford: winner ? winner.stableford : null,
        base_pot_amount: basePot,
        carry_in_amount: carryIn,
        total_pot_amount: totalPot,
        status
      });

      if (!winner) {
        const next = nextHole(orderedRounds, roundNumber, holeNumber);
        await db('skins_carry').insert({
          tour_id: tourId,
          from_round_number: roundNumber,
          from_hole: holeNumber,
          to_round_number: next ? next.roundNumber : null,
          to_hole: next ? next.holeNumber : null,
          carry_amount: totalPot
        });
      }

      carryIn = winner ? 0 : totalPot;
    }
  }

  const holes = await db('skins_holes')
    .where({ tour_id: tourId })
    .orderBy([{ column: 'round_number', order: 'asc' }, { column: 'hole_number', order: 'asc' }]);

  const teamNames = await db('teams').where({ tour_id: tourId }).select('id', 'name');
  const userNames = await db('users').select('id', 'first_name', 'last_name');

  const teamNameMap = new Map(teamNames.map((t) => [t.id, t.name]));
  const userNameMap = new Map(userNames.map((u) => [u.id, `${u.first_name} ${u.last_name}`]));

  const byWinner = new Map();

  for (const hole of holes) {
    if (!hole.winning_participant_id) continue;

    const key = `${hole.participant_type}:${hole.winning_participant_id}`;
    if (!byWinner.has(key)) {
      byWinner.set(key, {
        participantType: hole.participant_type,
        participantId: hole.winning_participant_id,
        name:
          hole.participant_type === 'team'
            ? teamNameMap.get(hole.winning_participant_id) || `Team ${hole.winning_participant_id}`
            : userNameMap.get(hole.winning_participant_id) || `Player ${hole.winning_participant_id}`,
        holesWon: 0,
        totalWon: 0
      });
    }

    const entry = byWinner.get(key);
    entry.holesWon += 1;
    entry.totalWon += Number(hole.total_pot_amount || 0);
  }

  const enrichedHoles = holes.map((hole) => {
    const winnerName =
      hole.winning_participant_id
        ? (hole.participant_type === 'team'
            ? teamNameMap.get(hole.winning_participant_id)
            : userNameMap.get(hole.winning_participant_id))
        : null;
    return {
      ...hole,
      winner_name: winnerName || null,
      tied_count: tiedCountMap.get(`${hole.round_number}:${hole.hole_number}`) || 0,
      top_stableford: topStablefordMap.get(`${hole.round_number}:${hole.hole_number}`) || 0
    };
  });

  return {
    stakePerPlayer: SKIN_STAKE_PER_PLAYER,
    activePlayerCount,
    initialCarryInSkins,
    holes: enrichedHoles,
    winners: [...byWinner.values()].sort((a, b) => b.totalWon - a.totalWon)
  };
}

module.exports = {
  calculateEventSkinsForDays
};
