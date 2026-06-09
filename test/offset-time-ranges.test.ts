import './test-helpers';
import test from 'node:test';
import assert from 'node:assert/strict';
import { OffsetTimeRanges } from '../src/offset-time-ranges';
import { SyntheticTimeRanges } from '../src/synthetic-time-ranges';

test('OffsetTimeRanges', async (t) => {
  await t.test('should delegate length to inner ranges', () => {
    const inner = new SyntheticTimeRanges();
    inner.add(0, 10);
    inner.add(20, 30);
    const offset = new OffsetTimeRanges(inner, 100);
    assert.equal(offset.length, 2);
  });

  await t.test('should apply offset to start() values', () => {
    const inner = new SyntheticTimeRanges();
    inner.add(0, 10);
    const offset = new OffsetTimeRanges(inner, 100);
    assert.equal(offset.start(0), 100); // 0 + 100
  });

  await t.test('should apply offset to end() values', () => {
    const inner = new SyntheticTimeRanges();
    inner.add(0, 10);
    const offset = new OffsetTimeRanges(inner, 100);
    assert.equal(offset.end(0), 110); // 10 + 100
  });

  await t.test('should apply negative offset', () => {
    const inner = new SyntheticTimeRanges();
    inner.add(100, 110);
    const offset = new OffsetTimeRanges(inner, -50);
    assert.equal(offset.start(0), 50);  // 100 - 50
    assert.equal(offset.end(0), 60);    // 110 - 50
  });

  await t.test('should handle multiple ranges with offset', () => {
    const inner = new SyntheticTimeRanges();
    inner.add(0, 10);
    inner.add(20, 30);
    const offset = new OffsetTimeRanges(inner, 500);
    assert.equal(offset.start(0), 500);
    assert.equal(offset.end(0), 510);
    assert.equal(offset.start(1), 520);
    assert.equal(offset.end(1), 530);
  });

  await t.test('should throw on out-of-bounds indices', () => {
    const inner = new SyntheticTimeRanges();
    inner.add(0, 10);
    const offset = new OffsetTimeRanges(inner, 100);
    assert.throws(() => offset.start(-1));
    assert.throws(() => offset.start(1));
    assert.throws(() => offset.end(-1));
    assert.throws(() => offset.end(1));
  });
});
