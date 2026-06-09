import './test-helpers';
import test from 'node:test';
import assert from 'node:assert/strict';
import { SyntheticTimeRanges } from '../src/synthetic-time-ranges';

test('SyntheticTimeRanges', async (t) => {
  await t.test('should have zero length initially', () => {
    const ranges = new SyntheticTimeRanges();
    assert.equal(ranges.length, 0);
  });

  await t.test('should add a single range', () => {
    const ranges = new SyntheticTimeRanges();
    ranges.add(0, 10);
    assert.equal(ranges.length, 1);
    assert.equal(ranges.start(0), 0);
    assert.equal(ranges.end(0), 10);
  });

  await t.test('should merge overlapping ranges', () => {
    const ranges = new SyntheticTimeRanges();
    ranges.add(0, 10);
    ranges.add(5, 15);
    assert.equal(ranges.length, 1);
    assert.equal(ranges.start(0), 0);
    assert.equal(ranges.end(0), 15);
  });

  await t.test('should merge touching ranges', () => {
    const ranges = new SyntheticTimeRanges();
    ranges.add(0, 10);
    ranges.add(10, 20);
    assert.equal(ranges.length, 1);
    assert.equal(ranges.start(0), 0);
    assert.equal(ranges.end(0), 20);
  });

  await t.test('should keep separate ranges', () => {
    const ranges = new SyntheticTimeRanges();
    ranges.add(0, 10);
    ranges.add(20, 30);
    assert.equal(ranges.length, 2);
    assert.equal(ranges.start(0), 0);
    assert.equal(ranges.end(0), 10);
    assert.equal(ranges.start(1), 20);
    assert.equal(ranges.end(1), 30);
  });

  await t.test('should absorb new range into existing', () => {
    const ranges = new SyntheticTimeRanges();
    ranges.add(0, 20);
    ranges.add(5, 15);
    assert.equal(ranges.length, 1);
    assert.equal(ranges.start(0), 0);
    assert.equal(ranges.end(0), 20);
  });

  await t.test('should ignore invalid add (start >= end)', () => {
    const ranges = new SyntheticTimeRanges();
    ranges.add(10, 10);
    assert.equal(ranges.length, 0);
    ranges.add(20, 10);
    assert.equal(ranges.length, 0);
  });

  await t.test('should cut a range in the middle', () => {
    const ranges = new SyntheticTimeRanges();
    ranges.add(0, 20);
    ranges.cut(5, 15);
    assert.equal(ranges.length, 2);
    assert.equal(ranges.start(0), 0);
    assert.equal(ranges.end(0), 5);
    assert.equal(ranges.start(1), 15);
    assert.equal(ranges.end(1), 20);
  });

  await t.test('should remove a range entirely', () => {
    const ranges = new SyntheticTimeRanges();
    ranges.add(0, 10);
    ranges.cut(0, 10);
    assert.equal(ranges.length, 0);
  });

  await t.test('should cut from the start', () => {
    const ranges = new SyntheticTimeRanges();
    ranges.add(0, 20);
    ranges.cut(0, 10);
    assert.equal(ranges.length, 1);
    assert.equal(ranges.start(0), 10);
    assert.equal(ranges.end(0), 20);
  });

  await t.test('should cut from the end', () => {
    const ranges = new SyntheticTimeRanges();
    ranges.add(0, 20);
    ranges.cut(10, 20);
    assert.equal(ranges.length, 1);
    assert.equal(ranges.start(0), 0);
    assert.equal(ranges.end(0), 10);
  });

  await t.test('should ignore invalid cut (start >= end)', () => {
    const ranges = new SyntheticTimeRanges();
    ranges.add(0, 20);
    ranges.cut(10, 10);
    assert.equal(ranges.length, 1);
    assert.equal(ranges.end(0), 20);
  });

  await t.test('should throw on out-of-bounds start()', () => {
    const ranges = new SyntheticTimeRanges();
    ranges.add(0, 10);
    assert.throws(() => ranges.start(-1));
    assert.throws(() => ranges.start(1));
  });

  await t.test('should throw on out-of-bounds end()', () => {
    const ranges = new SyntheticTimeRanges();
    ranges.add(0, 10);
    assert.throws(() => ranges.end(-1));
    assert.throws(() => ranges.end(1));
  });

  await t.test('should clear all ranges', () => {
    const ranges = new SyntheticTimeRanges();
    ranges.add(0, 10);
    ranges.add(20, 30);
    ranges.clear();
    assert.equal(ranges.length, 0);
  });

  await t.test('should handle complex merge scenarios', () => {
    const ranges = new SyntheticTimeRanges();
    ranges.add(0, 5);
    ranges.add(10, 15);
    ranges.add(20, 25);
    ranges.add(3, 12); // Should merge first two ranges
    assert.equal(ranges.length, 2);
    assert.equal(ranges.start(0), 0);
    assert.equal(ranges.end(0), 15);
    assert.equal(ranges.start(1), 20);
    assert.equal(ranges.end(1), 25);
  });
});
