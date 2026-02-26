'use strict';

function strokesForHole(playingHandicap, strokeIndex) {
  const hcap = Math.max(0, Math.floor(Number(playingHandicap) || 0));
  const base = Math.floor(hcap / 18);
  const remainder = hcap % 18;
  return base + (strokeIndex <= remainder ? 1 : 0);
}

module.exports = { strokesForHole };
