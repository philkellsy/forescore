'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { stablefordPoints } = require('../../src/services/scoring/stableford.service');

test('stablefordPoints calculates points from net-to-par', () => {
  const result = stablefordPoints({
    grossScore: 5,
    par: 4,
    strokeIndexPrimary: 1,
    strokeIndexSecondary: 19,
    playingHandicap: 18
  });

  assert.equal(result.shots, 1);
  assert.equal(result.netScore, 4);
  assert.equal(result.points, 2);
});

test('stablefordPoints bottoms at zero points', () => {
  const result = stablefordPoints({
    grossScore: 10,
    par: 4,
    strokeIndexPrimary: 10,
    strokeIndexSecondary: 28,
    playingHandicap: 0
  });

  assert.equal(result.points, 0);
});
