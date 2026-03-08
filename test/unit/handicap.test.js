'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { strokesForHole } = require('../../src/services/scoring/handicap.service');

test('strokesForHole returns base+remainder strokes correctly', () => {
  assert.equal(strokesForHole(6, 7, 19), 0);
  assert.equal(strokesForHole(9, 7, 19), 1);
  assert.equal(strokesForHole(20, 7, 19), 2);
  assert.equal(strokesForHole(22, 4, 22), 2);
});

test('strokesForHole clamps negative handicap to zero', () => {
  assert.equal(strokesForHole(-4, 5, 23), 0);
});
