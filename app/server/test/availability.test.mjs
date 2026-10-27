// The rule the Drive mirror and reconciliation share for writing down a check:
// an outcome that is new is always recorded; the same outcome again only once
// the record is old enough that it would soon count as stale.
import test from 'node:test';
import assert from 'node:assert/strict';
import { STALE_AFTER_MS, setAvailability } from '../src/services/availability.js';

const ago = (ms) => new Date(Date.now() - ms).toISOString();
const check = (status, detail = null) => ({
  status, lastCheckedAt: new Date().toISOString(), lastVerifiedAt: new Date().toISOString(), checkMethod: 'TEST', detail,
});

test('leaves a recent record of the same outcome alone', () => {
  const was = { ...check('AVAILABLE'), lastCheckedAt: ago(60_000) };
  const asset = { availability: was };
  assert.equal(setAvailability(asset, check('AVAILABLE')), false);
  assert.equal(asset.availability, was, 'the very same object, so the row is not dirty');
});

test('records a different outcome straight away', () => {
  const asset = { availability: { ...check('AVAILABLE'), lastCheckedAt: ago(60_000) } };
  assert.equal(setAvailability(asset, check('TRASHED', 'In the bin')), true);
  assert.equal(asset.availability.status, 'TRASHED');
});

test('records a changed explanation for the same status', () => {
  const asset = { availability: { ...check('MISMATCH', 'size 1 → 2'), lastCheckedAt: ago(60_000) } };
  assert.equal(setAvailability(asset, check('MISMATCH', 'size 1 → 3')), true);
});

test('re-stamps the same outcome before it would turn stale', () => {
  const asset = { availability: { ...check('AVAILABLE'), lastCheckedAt: ago(STALE_AFTER_MS / 2 + 60_000) } };
  assert.equal(setAvailability(asset, check('AVAILABLE')), true);
});

test('records a first check, and one over a record with no timestamp', () => {
  assert.equal(setAvailability({}, check('AVAILABLE')), true);
  assert.equal(setAvailability({ availability: { status: 'AVAILABLE', detail: null } }, check('AVAILABLE')), true);
});
