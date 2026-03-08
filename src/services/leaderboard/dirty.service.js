'use strict';

async function markLeaderboardDirty(db, eventId) {
  if (!eventId) return;
  await db('events')
    .where({ id: eventId })
    .update({ leaderboard_dirty_at: db.fn.now(), updated_at: db.fn.now() });
}

async function clearLeaderboardDirty(db, eventId) {
  if (!eventId) return;
  await db('events')
    .where({ id: eventId })
    .update({ leaderboard_dirty_at: null, updated_at: db.fn.now() });
}

module.exports = {
  markLeaderboardDirty,
  clearLeaderboardDirty
};
