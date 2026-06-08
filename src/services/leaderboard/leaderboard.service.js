'use strict';

const { calculateAmbroseLeaderboard } = require('../scoring/ambrose.service');
const { calculateEclecticLeaderboard } = require('../scoring/eclectic.service');
const { calculateStablefordLeaderboards } = require('../scoring/stableford-leaderboard.service');
const { calculateEventSkinsForDays } = require('../scoring/skins.service');
const { clearLeaderboardDirty } = require('./dirty.service');
const { findLatest, save } = require('../../db/repositories/leaderboard-snapshots');

async function buildLeaderboards(db, tourId, options = {}) {
  // When not dirty, serve cached snapshot if available
  if (!options.leaderboardDirtyAt) {
    const snapshot = await findLatest(db, tourId, 0, 'full');
    if (snapshot) return snapshot.payload;
  }

  const finalizedRoundsForSkins = Array.isArray(options.finalizedRoundsForSkins)
    ? options.finalizedRoundsForSkins
    : [];
  const roundNumbers = Array.isArray(options.roundNumbers) ? options.roundNumbers : [];

  const [ambrose, stableford, eclectic, skins] = await Promise.all([
    calculateAmbroseLeaderboard(db, tourId),
    calculateStablefordLeaderboards(db, tourId, { roundNumbers, bestOf: options.bestOf, lastRoundRequired: options.lastRoundRequired }),
    calculateEclecticLeaderboard(db, tourId, roundNumbers),
    calculateEventSkinsForDays(db, tourId, finalizedRoundsForSkins, {
      initialCarryInSkins: options.initialCarryInSkins || 0
    })
  ]);

  const result = { ambrose, stableford, eclectic, skins };

  await Promise.all([
    save(db, tourId, 0, 'full', result),
    clearLeaderboardDirty(db, tourId),
  ]);

  return result;
}

module.exports = { buildLeaderboards };
