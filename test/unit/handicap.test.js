'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { strokesForHole } = require('../../src/services/scoring/handicap.service');

test('strokesForHole returns base+remainder strokes correctly', () => {
  assert.equal(strokesForHole(20, 1), 2);
  assert.equal(strokesForHole(20, 2), 2);
  assert.equal(strokesForHole(20, 3), 1);
  assert.equal(strokesForHole(20, 18), 1);
});

test('strokesForHole clamps negative handicap to zero', () => {
  assert.equal(strokesForHole(-4, 5), 0);
});
