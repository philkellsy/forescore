'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { stablefordPoints } = require('../../src/services/scoring/stableford.service');

test('stablefordPoints calculates points from net-to-par', () => {
  const result = stablefordPoints({
    grossScore: 5,
    par: 4,
    strokeIndex: 1,
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
    strokeIndex: 10,
    playingHandicap: 0
  });

  assert.equal(result.points, 0);
});
