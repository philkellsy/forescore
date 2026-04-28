'use strict';

const { stablefordPoints } = require('./stableford.service');
const { markLeaderboardDirty } = require('../leaderboard/dirty.service');
const schemaSupportCache = new WeakMap();

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
    canonicalVersion: existing ? Number(existing.version || 1) : 0,
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

async function getScorecardHoleSchemaSupport(db) {
  const key = db && db.client ? db.client : db;
  if (schemaSupportCache.has(key)) return schemaSupportCache.get(key);
  const [hasVersion, hasOpId] = await Promise.all([
    db.schema.hasColumn('scorecard_holes', 'version'),
    db.schema.hasColumn('scorecard_holes', 'op_id')
  ]);
  const support = { hasVersion, hasOpId };
  schemaSupportCache.set(key, support);
  return support;
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
    force = false,
    opId = '',
    baseVersion = null
  }
) {
  const normalizedOpId = String(opId || '').trim().slice(0, 120);
  const hasBaseVersion = baseVersion !== null && baseVersion !== undefined && baseVersion !== '' && Number.isFinite(Number(baseVersion));
  const normalizedBaseVersion = hasBaseVersion ? Number(baseVersion) : null;
  const schemaSupport = await getScorecardHoleSchemaSupport(db);

  if (normalizedOpId && schemaSupport.hasOpId) {
    const existingByOp = await db('scorecard_holes').where({ op_id: normalizedOpId }).first();
    if (existingByOp) {
      return {
        points: existingByOp.stableford_points !== null ? Number(existingByOp.stableford_points) : null,
        grossScore: Number(existingByOp.gross_score),
        unchanged: true,
        version: schemaSupport.hasVersion ? Number(existingByOp.version || 1) : 1,
        opId: normalizedOpId
      };
    }
  }

  const existing = await db('scorecard_holes')
    .where({ scorecard_id: scorecardId, hole_number: holeNumber })
    .first();

  // Gross 0 is treated as clear.
  if (grossScore === 0) {
    if (!existing) {
      return { points: null, grossScore: 0, cleared: true, version: 0, opId: normalizedOpId || null };
    }

    if (!canMutateExisting(existing, requesterUserId, force)) {
      const canonical = await getCanonicalPayload(db, { scorecardId, holeNumber, existing });
      throw new ScoreConflictError(canonical);
    }

    await db('scorecard_holes').where({ id: existing.id }).del();
    await markLeaderboardDirty(db, scorecardEventId);
    return { points: null, grossScore: 0, cleared: true, version: 0, opId: normalizedOpId || null };
  }

  const stableford = stablefordPoints({ grossScore, par, strokeIndexPrimary, strokeIndexSecondary, playingHandicap });

  if (existing) {
    if (
      normalizedBaseVersion !== null
      && (schemaSupport.hasVersion ? Number(existing.version || 1) : 1) !== normalizedBaseVersion
      && !canMutateExisting(existing, requesterUserId, force)
    ) {
      const canonical = await getCanonicalPayload(db, { scorecardId, holeNumber, existing });
      throw new ScoreConflictError(canonical);
    }

    if (Number(existing.gross_score) === Number(grossScore)) {
      return {
        points: Number(existing.stableford_points),
        grossScore: Number(grossScore),
        unchanged: true,
        version: schemaSupport.hasVersion ? Number(existing.version || 1) : 1,
        opId: schemaSupport.hasOpId ? (normalizedOpId || existing.op_id || null) : null
      };
    }

    if (!canMutateExisting(existing, requesterUserId, force)) {
      const canonical = await getCanonicalPayload(db, { scorecardId, holeNumber, existing });
      throw new ScoreConflictError(canonical);
    }

    const nextVersion = (schemaSupport.hasVersion ? Number(existing.version || 1) : 1) + 1;
    const updatePayload = {
      gross_score: grossScore,
      stableford_points: stableford.points,
      owner_user_id: existing.owner_user_id || requesterUserId || null,
      updated_at: db.fn.now()
    };
    if (schemaSupport.hasVersion) updatePayload.version = nextVersion;
    if (schemaSupport.hasOpId) updatePayload.op_id = normalizedOpId || existing.op_id || null;

    await db('scorecard_holes')
      .where({ id: existing.id })
      .update(updatePayload);
    await markLeaderboardDirty(db, scorecardEventId);
    return { ...stableford, grossScore: Number(grossScore), version: nextVersion, opId: normalizedOpId || null };
  } else {
    const insertPayload = {
      scorecard_id: scorecardId,
      hole_number: holeNumber,
      gross_score: grossScore,
      stableford_points: stableford.points,
      owner_user_id: requesterUserId || null
    };
    if (schemaSupport.hasVersion) insertPayload.version = 1;
    if (schemaSupport.hasOpId) insertPayload.op_id = normalizedOpId || null;
    await db('scorecard_holes').insert(insertPayload);
    await markLeaderboardDirty(db, scorecardEventId);
    return { ...stableford, grossScore: Number(grossScore), version: 1, opId: normalizedOpId || null };
  }
}

module.exports = { upsertHoleScore, ScoreConflictError };
