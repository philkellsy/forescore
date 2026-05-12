'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { strokesForHole, computeCourseHandicap } = require('../../src/services/scoring/handicap.service');

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
