'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  groupSizes,
  distributeGroups,
  reverseLeaderboardGroups,
} = require('../../src/services/scoring/group-generator.service');

describe('groupSizes', () => {
  it('returns empty for n=0', () => {
    assert.deepEqual(groupSizes(0), []);
  });

  it('single player', () => {
    assert.deepEqual(groupSizes(1), [1]);
  });

  it('2-ball when n=2', () => {
    assert.deepEqual(groupSizes(2), [2]);
  });

  it('threesome when n=3', () => {
    assert.deepEqual(groupSizes(3), [3]);
  });

  it('foursome when n=4', () => {
    assert.deepEqual(groupSizes(4), [4]);
  });

  it('n=5 produces 3+2 (unavoidable 2-ball)', () => {
    assert.deepEqual(groupSizes(5), [3, 2]);
  });

  it('n=6 produces two threesomes (no 2-ball)', () => {
    assert.deepEqual(groupSizes(6), [3, 3]);
  });

  it('n=7 produces 4+3', () => {
    assert.deepEqual(groupSizes(7), [4, 3]);
  });

  it('n=8 produces two foursomes', () => {
    assert.deepEqual(groupSizes(8), [4, 4]);
  });

  it('n=9 produces three threesomes (avoids 4+4+1)', () => {
    assert.deepEqual(groupSizes(9), [3, 3, 3]);
  });

  it('n=10 produces 4+3+3', () => {
    assert.deepEqual(groupSizes(10), [4, 3, 3]);
  });

  it('n=11 produces 4+4+3', () => {
    assert.deepEqual(groupSizes(11), [4, 4, 3]);
  });

  it('n=12 produces three foursomes', () => {
    assert.deepEqual(groupSizes(12), [4, 4, 4]);
  });

  it('n=13 produces 4+3+3+3', () => {
    assert.deepEqual(groupSizes(13), [4, 3, 3, 3]);
  });

  it('n=16 produces four foursomes', () => {
    assert.deepEqual(groupSizes(16), [4, 4, 4, 4]);
  });

  it('sizes always sum to n', () => {
    for (let n = 1; n <= 24; n += 1) {
      const sizes = groupSizes(n);
      const sum = sizes.reduce((a, b) => a + b, 0);
      assert.equal(sum, n, `groupSizes(${n}) sums to ${sum}, expected ${n}`);
    }
  });

  it('no group smaller than 2 for n >= 6', () => {
    for (let n = 6; n <= 24; n += 1) {
      const sizes = groupSizes(n);
      assert.ok(sizes.every((s) => s >= 3), `groupSizes(${n}) has a group smaller than 3: ${sizes}`);
    }
  });
});

describe('distributeGroups', () => {
  const makePlayers = (ids) => ids.map((id) => ({ user_id: id }));

  it('returns correct number of groups', () => {
    const players = makePlayers([1, 2, 3, 4, 5, 6, 7, 8]);
    const groups = distributeGroups(players, [], groupSizes(8));
    assert.equal(groups.length, 2);
    assert.equal(groups[0].length + groups[1].length, 8);
  });

  it('every player appears exactly once', () => {
    const players = makePlayers([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    const groups = distributeGroups(players, [], groupSizes(12));
    const allIds = groups.flat().map((p) => p.user_id).sort((a, b) => a - b);
    assert.deepEqual(allIds, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it('avoids repeat pairings when possible', () => {
    // Day 1: players 1+2+3+4 played together, 5+6+7+8 played together
    const priorGroups = [
      { players: [{ user_id: 1 }, { user_id: 2 }, { user_id: 3 }, { user_id: 4 }] },
      { players: [{ user_id: 5 }, { user_id: 6 }, { user_id: 7 }, { user_id: 8 }] },
    ];
    const players = makePlayers([1, 2, 3, 4, 5, 6, 7, 8]);
    // Run many times — distribution should consistently mix players
    let mixedCount = 0;
    for (let t = 0; t < 10; t += 1) {
      const groups = distributeGroups(players, priorGroups, groupSizes(8));
      // If distribution works, group 1 should not be [1,2,3,4] or [5,6,7,8]
      const g1ids = new Set(groups[0].map((p) => p.user_id));
      const allSameAsDay1 = ([1, 2, 3, 4].every((id) => g1ids.has(id))) ||
                            ([5, 6, 7, 8].every((id) => g1ids.has(id)));
      if (!allSameAsDay1) mixedCount += 1;
    }
    // With 10 trials of 80 internal attempts, mixing should win every time
    assert.ok(mixedCount >= 8, `Expected mixing in at least 8/10 trials, got ${mixedCount}`);
  });
});

describe('reverseLeaderboardGroups', () => {
  it('places worst player first', () => {
    const players = [
      { user_id: 1 }, { user_id: 2 }, { user_id: 3 }, { user_id: 4 },
    ];
    const leaderboard = [
      { userId: 1, position: 1 }, // leader
      { userId: 2, position: 2 },
      { userId: 3, position: 3 },
      { userId: 4, position: 4 }, // last
    ];
    const groups = reverseLeaderboardGroups(players, leaderboard, [4]);
    // All in one group, ordered worst→best
    assert.equal(groups[0][0].user_id, 4);
    assert.equal(groups[0][3].user_id, 1);
  });

  it('leader goes in last group', () => {
    const players = [
      { user_id: 1 }, { user_id: 2 }, { user_id: 3 }, { user_id: 4 },
      { user_id: 5 }, { user_id: 6 }, { user_id: 7 }, { user_id: 8 },
    ];
    const leaderboard = players.map((p, i) => ({ userId: p.user_id, position: i + 1 }));
    const sizes = groupSizes(8); // [4, 4]
    const groups = reverseLeaderboardGroups(players, leaderboard, sizes);
    // Player 1 (position 1 = leader) should be in the last group
    const lastGroup = groups[groups.length - 1];
    assert.ok(lastGroup.some((p) => p.user_id === 1));
    // Player 8 (position 8 = worst) should be in first group
    assert.ok(groups[0].some((p) => p.user_id === 8));
  });

  it('players not on leaderboard go to front', () => {
    const players = [{ user_id: 1 }, { user_id: 99 }]; // 99 not on leaderboard
    const leaderboard = [{ userId: 1, position: 1 }];
    const groups = reverseLeaderboardGroups(players, leaderboard, [2]);
    // 99 has no position → treated as Infinity → goes first (worst)
    assert.equal(groups[0][0].user_id, 99);
    assert.equal(groups[0][1].user_id, 1);
  });
});
