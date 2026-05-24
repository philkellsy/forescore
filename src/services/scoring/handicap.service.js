'use strict';

// Module-level cache: keyed by `${tourId}:${roundNumber}:${courseId}`.
// Populated when a round is opened (course assignment frozen at that point).
// Cleared when a round reverts to draft.
const _roundCourseCache = new Map();

async function warmRoundCourseCache(db, tourId, roundNumber) {
  const round = await db('golf_rounds').where({ tour_id: tourId, round_number: roundNumber }).first();
  if (!round) return;
  const courseIds = [round.course_id, round.female_course_id].filter(Boolean).map(Number);
  await Promise.all(courseIds.map(async (courseId) => {
    const key = `${tourId}:${roundNumber}:${courseId}`;
    if (_roundCourseCache.has(key)) return;
    const course = await db('courses').where({ id: courseId }).first();
    if (!course) return;
    const parRow = await db('holes').where({ course_id: courseId }).sum({ total: 'par' }).first();
    _roundCourseCache.set(key, {
      slope: Number(course.slope_rating) || 113,
      rating: Number(course.course_rating) || 0,
      par: Number(parRow?.total) || 72,
    });
  }));
}

function invalidateRoundCourseCache(tourId, roundNumber) {
  const prefix = `${tourId}:${roundNumber}:`;
  for (const key of _roundCourseCache.keys()) {
    if (key.startsWith(prefix)) _roundCourseCache.delete(key);
  }
}

function getCachedCourseData(tourId, roundNumber, courseId) {
  return _roundCourseCache.get(`${tourId}:${roundNumber}:${courseId}`) || null;
}

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

module.exports = {
  strokesForHole,
  computeCourseHandicap,
  warmRoundCourseCache,
  invalidateRoundCourseCache,
  getCachedCourseData,
};
