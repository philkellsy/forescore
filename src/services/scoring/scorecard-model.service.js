'use strict';

const { strokesForHole, computeCourseHandicap } = require('./handicap.service');
const { CALC_TYPES } = require('../../config/calc-types');
const { dayLabel } = require('../events/day-label.service');

async function getCourseHolesForRound(db, tourId, roundNumber) {
  return db('golf_rounds as gr')
    .join('holes as h', 'h.course_id', 'gr.course_id')
    .where({ 'gr.tour_id': tourId, 'gr.round_number': roundNumber })
    .orderBy('h.hole_number', 'asc')
    .select('h.hole_number', 'h.par', 'h.stroke_index_primary', 'h.stroke_index_secondary');
}

function toScorecardMatrixModel(base) {
  const holes = (base.holes || []).map((h) => ({
    holeNumber: Number(h.holeNumber),
    par: Number(h.par || 0),
    siPrimary: Number(h.siPrimary || 0),
    gross: h.gross == null ? null : Number(h.gross),
    net: h.net == null ? null : Number(h.net),
    stableford: h.stableford == null ? null : Number(h.stableford)
  }));
  const front9 = holes.filter((h) => h.holeNumber >= 1 && h.holeNumber <= 9).sort((a, b) => a.holeNumber - b.holeNumber);
  const back9 = holes.filter((h) => h.holeNumber >= 10 && h.holeNumber <= 18).sort((a, b) => a.holeNumber - b.holeNumber);
  return { ...base, holes, front9, back9 };
}

function summarizeTotals(holes) {
  const valid = (holes || []).filter((h) => h.gross != null);
  const sum = (arr, key) => arr.reduce((acc, row) => acc + Number(row[key] || 0), 0);
  const front = valid.filter((h) => h.holeNumber <= 9);
  const back = valid.filter((h) => h.holeNumber >= 10);
  return {
    grossFront: sum(front, 'gross'),
    grossBack: sum(back, 'gross'),
    grossTotal: sum(valid, 'gross'),
    netFront: sum(front, 'net'),
    netBack: sum(back, 'net'),
    netTotal: sum(valid, 'net'),
    stablefordFront: sum(front, 'stableford'),
    stablefordBack: sum(back, 'stableford'),
    stablefordTotal: sum(valid, 'stableford')
  };
}

async function buildIndividualScorecardModel(db, tour, roundNumber, userId) {
  const [scorecard, user, handicap, roundHcp, holeConfig, holeScores, roundRow] = await Promise.all([
    db('scorecards').where({ tour_id: tour.id, round_number: roundNumber, type: 'individual', user_id: userId }).first(),
    db('users').where({ id: userId }).first(),
    db('player_handicaps').where({ tour_id: tour.id, user_id: userId }).first(),
    db('player_day_handicaps').where({ tour_id: tour.id, round_number: roundNumber, user_id: userId }).first(),
    getCourseHolesForRound(db, tour.id, roundNumber),
    db('scorecards as s')
      .join('scorecard_holes as sh', 'sh.scorecard_id', 's.id')
      .where({ 's.tour_id': tour.id, 's.round_number': roundNumber, 's.type': 'individual', 's.user_id': userId })
      .select('sh.hole_number', 'sh.gross_score', 'sh.stableford_points'),
    db('golf_rounds').where({ tour_id: tour.id, round_number: roundNumber }).first()
  ]);
  if (!scorecard || !user || !holeConfig.length) return null;

  const isHcpOverride = !!roundHcp;
  const handicapIndex = isHcpOverride ? Number(roundHcp.handicap_index) : Number(handicap?.playing_handicap || 0);
  let hcp = Math.round(handicapIndex);
  if (!isHcpOverride && roundRow?.course_id) {
    const [course, parRow] = await Promise.all([
      db('courses').where({ id: roundRow.course_id }).first(),
      db('holes').where({ course_id: roundRow.course_id }).sum({ total: 'par' }).first()
    ]);
    if (course) hcp = computeCourseHandicap(handicapIndex, course.slope_rating, course.course_rating, parRow?.total || 72, user?.gender || null);
  }
  const byHole = new Map(holeScores.map((row) => [Number(row.hole_number), row]));
  const holes = holeConfig.map((hole) => {
    const saved = byHole.get(Number(hole.hole_number));
    const gross = saved ? Number(saved.gross_score) : null;
    const shots = strokesForHole(hcp, Number(hole.stroke_index_primary), Number(hole.stroke_index_secondary));
    return {
      holeNumber: Number(hole.hole_number),
      par: Number(hole.par || 0),
      siPrimary: Number(hole.stroke_index_primary || 0),
      siSecondary: Number(hole.stroke_index_secondary || 0),
      gross,
      net: gross == null ? null : gross - shots,
      stableford: saved && saved.stableford_points != null ? Number(saved.stableford_points) : null
    };
  });

  const calcType = String(roundRow?.calc_type || CALC_TYPES.STABLEFORD);
  const totals = summarizeTotals(holes);
  const resultLabel = calcType === CALC_TYPES.STABLEFORD
    ? `${totals.stablefordTotal} pts`
    : `${totals.grossTotal} gross / ${totals.netTotal} net`;

  return toScorecardMatrixModel({
    mode: 'individual',
    roundNumber,
    roundLabel: dayLabel(roundNumber),
    dayLabel: dayLabel(roundNumber),
    calcType,
    showStablefordTotals: calcType === CALC_TYPES.STABLEFORD,
    showGrossOnlyTotals: calcType !== CALC_TYPES.STABLEFORD,
    title: `${user.first_name || ''} ${user.last_name || ''}`.trim(),
    subtitle: `Hcp ${hcp}`,
    resultLabel,
    totals,
    holes
  });
}

module.exports = {
  getCourseHolesForRound,
  toScorecardMatrixModel,
  summarizeTotals,
  buildIndividualScorecardModel
};
