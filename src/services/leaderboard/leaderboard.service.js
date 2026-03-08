'use strict';

const { calculateAmbroseLeaderboard } = require('../scoring/ambrose.service');
const { calculateEclecticLeaderboard } = require('../scoring/eclectic.service');
const { calculateSultansLeaderboard } = require('../scoring/sultans.service');
const { calculateStablefordLeaderboards } = require('../scoring/stableford-leaderboard.service');
const { calculateEventSkinsForDays } = require('../scoring/skins.service');
const { clearLeaderboardDirty } = require('./dirty.service');

async function buildLeaderboards(db, eventId, options = {}) {
  const finalizedDaysForSkins = Array.isArray(options.finalizedDaysForSkins)
    ? options.finalizedDaysForSkins
    : [1, 2, 3, 4];
  const [ambrose, stableford, eclectic, sultans, skins] = await Promise.all([
    calculateAmbroseLeaderboard(db, eventId),
    calculateStablefordLeaderboards(db, eventId),
    calculateEclecticLeaderboard(db, eventId),
    calculateSultansLeaderboard(db, eventId),
    calculateEventSkinsForDays(db, eventId, finalizedDaysForSkins)
  ]);

  const result = {
    ambrose,
    stableford,
    eclectic,
    sultans,
    skins
  };

  await clearLeaderboardDirty(db, eventId);
  return result;
}

module.exports = { buildLeaderboards };
