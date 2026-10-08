import assert from 'node:assert/strict';
import test from 'node:test';
import { batchAnchorDay, istDateString, startOfNextIstDay } from '../src/common/time/ist.js';

test('IST date rolls at 00:00 Asia/Kolkata, which is 18:30 UTC', () => {
  assert.equal(istDateString(new Date('2026-09-29T18:29:59.000Z')), '2026-09-29');
  assert.equal(istDateString(new Date('2026-09-29T18:30:00.000Z')), '2026-09-30');
});

test('next IST midnight is 18:30 UTC of the same UTC date', () => {
  const morning = new Date('2026-09-30T03:30:00.000Z'); // 09:00 IST
  assert.equal(startOfNextIstDay(morning).toISOString(), '2026-09-30T18:30:00.000Z');
});

test('batch anchor day prefers the stored processing day', () => {
  const now = new Date('2026-10-01T05:00:00.000Z');
  assert.equal(batchAnchorDay('2026-09-30', new Date('2026-10-01T00:00:00.000Z'), now), '2026-09-30');
  assert.equal(batchAnchorDay(null, new Date('2026-09-29T18:30:00.000Z'), now), '2026-09-30');
  assert.equal(batchAnchorDay(null, null, new Date('2026-09-29T18:30:00.000Z')), '2026-09-30');
});
