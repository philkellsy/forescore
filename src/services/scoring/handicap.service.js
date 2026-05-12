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

// WHS course handicap: ROUND(index × slope/113 + (course_rating − par))
// coursePar is the sum of all hole pars for the tee set being played.
function computeCourseHandicap(handicapIndex, slopeRating, courseRating, coursePar) {
  const index = Number(handicapIndex) || 0;
  const slope = Number(slopeRating) || 113;
  const rating = Number(courseRating) || Number(coursePar) || 0;
  const par = Number(coursePar) || 0;
  return Math.round(index * (slope / 113) + (rating - par));
}

module.exports = { strokesForHole, computeCourseHandicap };
