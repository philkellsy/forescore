'use strict';

function dayLabel(day) {
  const value = Number(day);
  if (!Number.isFinite(value)) return `Day ${day}`;
  if (value === 1) return 'Day 1 (Ambrose)';
  if (value === 2) return 'Day 2 (Round 1)';
  if (value === 3) return 'Day 3 (Round 2)';
  if (value === 4) return 'Day 4 (Round 3)';
  return `Day ${value}`;
}

module.exports = { dayLabel };
