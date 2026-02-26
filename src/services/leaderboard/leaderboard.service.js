'use strict';

const { calculateAmbroseLeaderboard } = require('../scoring/ambrose.service');
const { calculateEclecticLeaderboard } = require('../scoring/eclectic.service');
const { calculateSultansLeaderboard } = require('../scoring/sultans.service');

async function buildLeaderboards(db, eventId) {
  const [ambrose, eclectic, sultans] = await Promise.all([
    calculateAmbroseLeaderboard(db, eventId),
    calculateEclecticLeaderboard(db, eventId),
    calculateSultansLeaderboard(db, eventId)
  ]);

  return {
    ambrose,
    eclectic,
    sultans
  };
}

module.exports = { buildLeaderboards };
