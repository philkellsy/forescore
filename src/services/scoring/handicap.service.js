'use strict';

function strokesForHole(playingHandicap, strokeIndexPrimary, strokeIndexSecondary) {
  const handicap = Math.trunc(Number(playingHandicap) || 0);
  const primary = Number(strokeIndexPrimary);
  const secondary = Number(strokeIndexSecondary);

  if (handicap >= 0) {
    let strokes = 0;
    if (Number.isFinite(primary) && primary >= 1 && primary <= 18 && handicap >= primary) {
      strokes += 1;
    }
    if (Number.isFinite(secondary) && secondary >= 19 && secondary <= 36 && handicap >= secondary) {
      strokes += 1;
    }
    return strokes;
  }

  // Plus handicap: player gives strokes back on easiest indexed holes.
  const plusSize = Math.min(18, Math.abs(handicap));
  if (!Number.isFinite(primary) || primary < 1 || primary > 18) return 0;
  return primary > 18 - plusSize ? -1 : 0;
}

module.exports = { strokesForHole };
