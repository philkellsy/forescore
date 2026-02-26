'use strict';

function groupPlayers(playerIds, groupSize = 4) {
  const groups = [];
  for (let i = 0; i < playerIds.length; i += groupSize) {
    groups.push(playerIds.slice(i, i + groupSize));
  }
  return groups;
}

module.exports = { groupPlayers };
