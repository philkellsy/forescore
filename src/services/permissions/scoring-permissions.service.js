'use strict';

function canEditAllScores(user) {
  return user && (user.role === 'admin' || user.role === 'scorer');
}

module.exports = { canEditAllScores };
