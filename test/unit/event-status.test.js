'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { canActivate, canComplete, EVENT_STATUS } = require('../../src/services/event-status.service');

// ---------------------------------------------------------------------------
// canActivate
// ---------------------------------------------------------------------------
describe('canActivate', () => {
  it('blocks unpaid draft event', () => {
    const result = canActivate({ status: EVENT_STATUS.DRAFT, is_paid: false });
    assert.equal(result.ok, false);
    assert.match(result.reason, /paid/i);
  });

  it('blocks unpaid active event', () => {
    const result = canActivate({ status: EVENT_STATUS.ACTIVE, is_paid: false });
    assert.equal(result.ok, false);
  });

  it('allows paid draft event', () => {
    const result = canActivate({ status: EVENT_STATUS.DRAFT, is_paid: true });
    assert.equal(result.ok, true);
  });

  it('blocks event that is already active', () => {
    const result = canActivate({ status: EVENT_STATUS.ACTIVE, is_paid: true });
    assert.equal(result.ok, false);
    assert.match(result.reason, /already active/i);
  });

  it('blocks completed event from being reactivated', () => {
    const result = canActivate({ status: EVENT_STATUS.COMPLETED, is_paid: true });
    assert.equal(result.ok, false);
    assert.match(result.reason, /completed/i);
  });
});

// ---------------------------------------------------------------------------
// canComplete
// ---------------------------------------------------------------------------
describe('canComplete', () => {
  it('allows active event to be completed', () => {
    const result = canComplete({ status: EVENT_STATUS.ACTIVE });
    assert.equal(result.ok, true);
  });

  it('blocks draft event', () => {
    const result = canComplete({ status: EVENT_STATUS.DRAFT });
    assert.equal(result.ok, false);
    assert.match(result.reason, /active/i);
  });

  it('blocks already-completed event', () => {
    const result = canComplete({ status: EVENT_STATUS.COMPLETED });
    assert.equal(result.ok, false);
  });
});
