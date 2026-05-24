'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { strokesForHole, computeCourseHandicap, warmRoundCourseCache, invalidateRoundCourseCache, getCachedCourseData, getCachedParByHole } = require('../../src/services/scoring/handicap.service');

describe('strokesForHole', () => {
  it('returns base+remainder strokes correctly', () => {
    assert.equal(strokesForHole(6, 7, 19), 0);
    assert.equal(strokesForHole(9, 7, 19), 1);
    assert.equal(strokesForHole(20, 7, 19), 2);
    assert.equal(strokesForHole(22, 4, 22), 2);
  });

  it('clamps negative handicap to zero', () => {
    assert.equal(strokesForHole(-4, 5, 23), 0);
  });
});

describe('computeCourseHandicap', () => {
  it('standard WHS: ROUND(index × slope/113 + (rating − par))', () => {
    // 10.0 × (120/113) + (72 − 72) ≈ 10.619 → 11
    assert.equal(computeCourseHandicap(10.0, 120, 72.0, 72), 11);
  });

  it('course rating below par reduces handicap', () => {
    // 10.0 × (113/113) + (71.5 − 72) = 10 − 0.5 = 9.5 → 10
    assert.equal(computeCourseHandicap(10.0, 113, 71.5, 72), 10);
  });

  it('course rating above par increases handicap', () => {
    // 8.7 × (125/113) + (73.2 − 72) ≈ 9.62 + 1.2 = 10.82 → 11
    assert.equal(computeCourseHandicap(8.7, 125, 73.2, 72), 11);
  });

  it('zero index gives course adjustment only', () => {
    // 0 × anything + (74 − 72) = 2
    assert.equal(computeCourseHandicap(0, 130, 74, 72), 2);
  });

  it('plus (negative) handicap index', () => {
    // −2.0 × 1 + 0 = −2
    assert.equal(computeCourseHandicap(-2.0, 113, 72, 72), -2);
  });

  it('falls back gracefully when slope is missing', () => {
    // null slope → uses 113 → 10 × 1 + 0 = 10
    assert.equal(computeCourseHandicap(10, null, 72, 72), 10);
  });
});

describe('round course cache', () => {
  // holeListRows: array of { hole_number, par } for the primary course (course_id 10)
  const DEFAULT_HOLE_ROWS = Array.from({ length: 18 }, (_, i) => ({ hole_number: i + 1, par: 4 }));

  const fakeDb = (courseRows, parRows, holeListRows = DEFAULT_HOLE_ROWS) => {
    const q = { where: () => q, sum: () => q, select: async () => [], first: async () => null };
    return Object.assign((table) => {
      if (table === 'golf_rounds') {
        return { where: () => ({ first: async () => ({ course_id: 10, female_course_id: 20, status: 'open' }) }) };
      }
      if (table === 'courses') {
        return { where: ({ id }) => ({ first: async () => courseRows[id] || null }) };
      }
      if (table === 'holes') {
        return {
          where: ({ course_id }) => ({
            sum: () => ({ first: async () => parRows[course_id] || null }),
            select: async () => (course_id === 10 ? holeListRows : []),
          }),
        };
      }
      return q;
    });
  };

  beforeEach(() => {
    invalidateRoundCourseCache(99, 1);
    invalidateRoundCourseCache(99, 2);
  });

  it('warmRoundCourseCache populates course entries for both male and female courses', async () => {
    const db = fakeDb(
      { 10: { slope_rating: 120, course_rating: 72.5 }, 20: { slope_rating: 110, course_rating: 71.0 } },
      { 10: { total: 72 }, 20: { total: 71 } },
    );
    await warmRoundCourseCache(db, 99, 1);
    assert.deepEqual(getCachedCourseData(99, 1, 10), { slope: 120, rating: 72.5, par: 72 });
    assert.deepEqual(getCachedCourseData(99, 1, 20), { slope: 110, rating: 71.0, par: 71 });
  });

  it('warmRoundCourseCache populates per-hole par map for primary course', async () => {
    const holeRows = [{ hole_number: 1, par: 4 }, { hole_number: 2, par: 3 }];
    const db = fakeDb(
      { 10: { slope_rating: 120, course_rating: 72.5 }, 20: { slope_rating: 110, course_rating: 71.0 } },
      { 10: { total: 72 }, 20: { total: 71 } },
      holeRows,
    );
    await warmRoundCourseCache(db, 99, 1);
    const parMap = getCachedParByHole(99, 1);
    assert.ok(parMap instanceof Map);
    assert.equal(parMap.get(1), 4);
    assert.equal(parMap.get(2), 3);
  });

  it('getCachedCourseData returns null for unknown key', () => {
    assert.equal(getCachedCourseData(99, 2, 99), null);
  });

  it('getCachedParByHole returns null before warming', () => {
    assert.equal(getCachedParByHole(99, 2), null);
  });

  it('invalidateRoundCourseCache removes all entries for that round', async () => {
    const db = fakeDb(
      { 10: { slope_rating: 120, course_rating: 72.5 }, 20: { slope_rating: 110, course_rating: 71.0 } },
      { 10: { total: 72 }, 20: { total: 71 } },
    );
    await warmRoundCourseCache(db, 99, 1);
    assert.notEqual(getCachedCourseData(99, 1, 10), null);
    assert.notEqual(getCachedParByHole(99, 1), null);
    invalidateRoundCourseCache(99, 1);
    assert.equal(getCachedCourseData(99, 1, 10), null);
    assert.equal(getCachedCourseData(99, 1, 20), null);
    assert.equal(getCachedParByHole(99, 1), null);
  });
});
