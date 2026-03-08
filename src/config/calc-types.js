'use strict';

const CALC_TYPES = {
  STABLEFORD: 'stableford',
  AMBROSE_NETT: 'ambrose_nett'
};

function defaultCalcTypeForDay(day) {
  return Number(day) === 1 ? CALC_TYPES.AMBROSE_NETT : CALC_TYPES.STABLEFORD;
}

module.exports = {
  CALC_TYPES,
  defaultCalcTypeForDay
};

