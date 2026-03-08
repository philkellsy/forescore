'use strict';

const { strokesForHole } = require('./handicap.service');

function stablefordPoints({ grossScore, par, strokeIndexPrimary, strokeIndexSecondary, playingHandicap }) {
  const shots = strokesForHole(playingHandicap, strokeIndexPrimary, strokeIndexSecondary);
  const netScore = grossScore - shots;
  const toPar = netScore - par;
  const points = Math.max(0, 2 - toPar);
  return {
    shots,
    netScore,
    points
  };
}

module.exports = { stablefordPoints };
