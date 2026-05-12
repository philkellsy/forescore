'use strict';

const EVENT_STATUS = {
  DRAFT: 'draft',
  ACTIVE: 'active',
  COMPLETED: 'completed',
};

function canActivate(tour) {
  if (!tour.is_paid) {
    return { ok: false, reason: 'This tour must be approved (marked as paid) by a super admin before it can be activated.' };
  }
  if (tour.status === EVENT_STATUS.ACTIVE) {
    return { ok: false, reason: 'Tour is already active.' };
  }
  if (tour.status === EVENT_STATUS.COMPLETED) {
    return { ok: false, reason: 'Completed tours cannot be reactivated.' };
  }
  return { ok: true };
}

function canComplete(tour) {
  if (tour.status !== EVENT_STATUS.ACTIVE) {
    return { ok: false, reason: 'Only active tours can be completed.' };
  }
  return { ok: true };
}

module.exports = { EVENT_STATUS, canActivate, canComplete };
