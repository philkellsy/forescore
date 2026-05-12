'use strict';

function dayLabel(day) {
  const value = Number(day);
  if (!Number.isFinite(value)) return `Day ${day}`;
  return `Day ${value}`;
}

module.exports = { dayLabel };
