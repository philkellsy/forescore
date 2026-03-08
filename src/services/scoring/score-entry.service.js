'use strict';

const { stablefordPoints } = require('./stableford.service');
const { markLeaderboardDirty } = require('../leaderboard/dirty.service');

class ScoreConflictError extends Error {
  constructor(payload) {
    super('Score conflict');
    this.name = 'ScoreConflictError';
    this.status = 409;
    this.code = 'SCORE_CONFLICT';
    this.payload = payload;
  }
}

async function getCanonicalPayload(db, { scorecardId, holeNumber, existing }) {
  let ownerName = null;
  if (existing?.owner_user_id) {
    const owner = await db('users')
      .where({ id: existing.owner_user_id })
      .select('first_name', 'last_name')
      .first();
    if (owner) {
      const first = String(owner.first_name || '').trim();
      const initial = String(owner.last_name || '').trim().charAt(0);
      ownerName = `${first}${initial ? ` ${initial}.` : ''}`.trim() || null;
    }
  }

  return {
    scorecardId,
    holeNumber,
    canonicalGross: existing ? Number(existing.gross_score) : null,
    canonicalStableford: existing && existing.stableford_points !== null ? Number(existing.stableford_points) : null,
    ownerUserId: existing?.owner_user_id ? Number(existing.owner_user_id) : null,
    ownerName,
    updatedAt: existing?.updated_at || null
  };
}

function canMutateExisting(existing, requesterUserId, force) {
  if (force) return true;
  if (!existing) return true;
  if (!existing.owner_user_id) return true;
  return Number(existing.owner_user_id) === Number(requesterUserId);
}

async function upsertHoleScore(
  db,
  {
    scorecardId,
    holeNumber,
    grossScore,
    par,
    strokeIndexPrimary,
    strokeIndexSecondary,
    playingHandicap,
    scorecardEventId,
    requesterUserId,
    force = false
  }
) {
  const existing = await db('scorecard_holes')
    .where({ scorecard_id: scorecardId, hole_number: holeNumber })
    .first();

  // Gross 0 is treated as clear.
  if (grossScore === 0) {
    if (!existing) {
      return { points: null, grossScore: 0, cleared: true };
    }

    if (!canMutateExisting(existing, requesterUserId, force)) {
      const canonical = await getCanonicalPayload(db, { scorecardId, holeNumber, existing });
      throw new ScoreConflictError(canonical);
    }

    await db('scorecard_holes').where({ id: existing.id }).del();
    await markLeaderboardDirty(db, scorecardEventId);
    return { points: null, grossScore: 0, cleared: true };
  }

  const stableford = stablefordPoints({ grossScore, par, strokeIndexPrimary, strokeIndexSecondary, playingHandicap });

  if (existing) {
    if (Number(existing.gross_score) === Number(grossScore)) {
      return { points: Number(existing.stableford_points), grossScore: Number(grossScore), unchanged: true };
    }

    if (!canMutateExisting(existing, requesterUserId, force)) {
      const canonical = await getCanonicalPayload(db, { scorecardId, holeNumber, existing });
      throw new ScoreConflictError(canonical);
    }

    await db('scorecard_holes')
      .where({ id: existing.id })
      .update({
        gross_score: grossScore,
        stableford_points: stableford.points,
        owner_user_id: existing.owner_user_id || requesterUserId || null,
        updated_at: db.fn.now()
      });
    await markLeaderboardDirty(db, scorecardEventId);
  } else {
    await db('scorecard_holes').insert({
      scorecard_id: scorecardId,
      hole_number: holeNumber,
      gross_score: grossScore,
      stableford_points: stableford.points,
      owner_user_id: requesterUserId || null
    });
    await markLeaderboardDirty(db, scorecardEventId);
  }

  return { ...stableford, grossScore: Number(grossScore) };
}

module.exports = { upsertHoleScore, ScoreConflictError };
