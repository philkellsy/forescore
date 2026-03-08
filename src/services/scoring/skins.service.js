'use strict';

const DAY_SEQUENCE = [1, 2, 3, 4];
const HOLE_SEQUENCE = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18];
const SKIN_STAKE_PER_PLAYER = 1;

function nextHole(day, holeNumber) {
  if (holeNumber < 18) return { day, holeNumber: holeNumber + 1 };
  if (day < 4) return { day: day + 1, holeNumber: 1 };
  return null;
}

async function getActivePlayerCount(db, eventId) {
  const row = await db('event_players')
    .where({ event_id: eventId })
    .andWhere((q) => q.where('status', 'active').orWhereNull('status'))
    .count({ total: '*' })
    .first();

  return Number(row?.total || 0);
}

function findOutrightWinner(rows) {
  if (!rows.length) return null;
  const maxPoints = Math.max(...rows.map((r) => Number(r.stableford || 0)));
  const winners = rows.filter((r) => Number(r.stableford || 0) === maxPoints);
  if (winners.length !== 1) return null;
  return {
    participantId: winners[0].participant_id,
    stableford: maxPoints,
    gross: Number(winners[0].gross || 0)
  };
}

async function getHoleResults(db, eventId, day, holeNumber) {
  if (day === 1) {
    return db('scorecards as s')
      .join('scorecard_holes as sh', 'sh.scorecard_id', 's.id')
      .where({ 's.event_id': eventId, 's.day': day, 's.type': 'team', 'sh.hole_number': holeNumber })
      .whereNotNull('s.team_id')
      .select({ participant_id: 's.team_id', stableford: 'sh.stableford_points', gross: 'sh.gross_score' });
  }

  return db('scorecards as s')
    .join('scorecard_holes as sh', 'sh.scorecard_id', 's.id')
    .where({ 's.event_id': eventId, 's.day': day, 's.type': 'individual', 'sh.hole_number': holeNumber })
    .whereNotNull('s.user_id')
    .select({ participant_id: 's.user_id', stableford: 'sh.stableford_points', gross: 'sh.gross_score' });
}

async function writeSkinsHole(db, row) {
  const existing = await db('skins_holes')
    .where({ event_id: row.event_id, day: row.day, hole_number: row.hole_number })
    .first();

  if (existing) {
    await db('skins_holes').where({ id: existing.id }).update({ ...row, updated_at: db.fn.now() });
    return;
  }

  await db('skins_holes').insert(row);
}

async function calculateEventSkins(db, eventId) {
  return calculateEventSkinsForDays(db, eventId, DAY_SEQUENCE);
}

function normalizedFinalizedDays(finalizedDays = DAY_SEQUENCE) {
  const finalizedSet = new Set((Array.isArray(finalizedDays) ? finalizedDays : DAY_SEQUENCE).map((d) => Number(d)));
  const contiguous = [];
  for (const day of DAY_SEQUENCE) {
    if (!finalizedSet.has(day)) break;
    contiguous.push(day);
  }
  return contiguous;
}

async function calculateEventSkinsForDays(db, eventId, finalizedDays = DAY_SEQUENCE) {
  const activePlayerCount = await getActivePlayerCount(db, eventId);
  const basePot = Number(activePlayerCount * SKIN_STAKE_PER_PLAYER);
  const daysToProcess = normalizedFinalizedDays(finalizedDays);

  await db('skins_holes').where({ event_id: eventId }).del();
  await db('skins_carry').where({ event_id: eventId }).del();

  if (!daysToProcess.length) {
    return {
      stakePerPlayer: SKIN_STAKE_PER_PLAYER,
      activePlayerCount,
      holes: [],
      winners: []
    };
  }

  let carryIn = 0;

  for (const day of daysToProcess) {
    for (const holeNumber of HOLE_SEQUENCE) {
      const results = await getHoleResults(db, eventId, day, holeNumber);
      const participantType = day === 1 ? 'team' : 'player';
      const totalPot = basePot + carryIn;
      const winner = findOutrightWinner(results);
      const status = winner ? 'won' : 'jackpot';

      await writeSkinsHole(db, {
        event_id: eventId,
        day,
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
        const next = nextHole(day, holeNumber);
        await db('skins_carry').insert({
          event_id: eventId,
          from_day: day,
          from_hole: holeNumber,
          to_day: next ? next.day : null,
          to_hole: next ? next.holeNumber : null,
          carry_amount: totalPot
        });
      }

      carryIn = winner ? 0 : totalPot;
    }
  }

  const holes = await db('skins_holes')
    .where({ event_id: eventId })
    .orderBy([{ column: 'day', order: 'asc' }, { column: 'hole_number', order: 'asc' }]);

  const teamNames = await db('teams').where({ event_id: eventId }).select('id', 'name');
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
      winner_name: winnerName || null
    };
  });

  return {
    stakePerPlayer: SKIN_STAKE_PER_PLAYER,
    activePlayerCount,
    holes: enrichedHoles,
    winners: [...byWinner.values()].sort((a, b) => b.totalWon - a.totalWon)
  };
}

module.exports = {
  calculateEventSkins,
  calculateEventSkinsForDays
};
