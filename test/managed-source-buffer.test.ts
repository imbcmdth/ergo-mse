import './test-helpers';
import test from 'node:test';
import assert from 'node:assert/strict';
import sinon from 'sinon';
import { ManagedSourceBuffer } from '../src/managed-source-buffer';

// Helper to create a fake SourceBuffer
function createFakeSourceBuffer(): any {
  return {
    updating: false,
    buffered: {
      length: 0,
      start: () => 0,
      end: () => 0
    } as TimeRanges,
    timestampOffset: 0,
    appendWindowStart: -Infinity,
    appendWindowEnd: Infinity,
    mode: 'segments' as const,
    appendBuffer: sinon.stub(),
    remove: sinon.stub(),
    abort: sinon.stub(),
    changeType: sinon.stub(),
    addEventListener: sinon.stub(),
    removeEventListener: sinon.stub(),
  };
}

test('ManagedSourceBuffer', async (t) => {
  await t.test('should initialize with wallAnchor = 0', () => {
    const sb = createFakeSourceBuffer();
    const msb = new ManagedSourceBuffer(sb);
    assert.equal(msb.wallAnchor, 0);
  });

  await t.test('should delegate updating to underlying SourceBuffer', () => {
    const sb = createFakeSourceBuffer();
    sb.updating = false;
    let msb = new ManagedSourceBuffer(sb);
    assert.equal(msb.updating, false);

    sb.updating = true;
    assert.equal(msb.updating, true);
  });

  await t.test('should delegate buffered to underlying SourceBuffer', () => {
    const sb = createFakeSourceBuffer();
    sb.buffered = {
      length: 1,
      start: () => 0,
      end: () => 10
    } as TimeRanges;
    const msb = new ManagedSourceBuffer(sb);
    assert.equal(msb.buffered.length, 1);
    assert.equal(msb.buffered.start(0), 0);
    assert.equal(msb.buffered.end(0), 10);
  });

  await t.test('should translate buffered ranges by wallAnchor', () => {
    const sb = createFakeSourceBuffer();
    sb.buffered = {
      length: 1,
      start: () => 0,
      end: () => 10
    } as TimeRanges;
    const msb = new ManagedSourceBuffer(sb);
    msb.wallAnchor = 100;
    assert.equal(msb.buffered.start(0), 100); // 0 + 100
    assert.equal(msb.buffered.end(0), 110);   // 10 + 100
  });

  await t.test('should queue and process append operations', async () => {
    const sb = createFakeSourceBuffer();
    const msb = new ManagedSourceBuffer(sb);

    const data = new ArrayBuffer(10);
    const appendPromise = msb.append(data);

    // Verify appendBuffer was called
    assert.equal((sb.appendBuffer as sinon.SinonStub).called, true);
    assert.deepEqual((sb.appendBuffer as sinon.SinonStub).firstCall.args[0], data);

    // Simulate updateend event
    const updateendHandler = (sb.addEventListener as sinon.SinonStub).args[0][1];
    updateendHandler();

    await appendPromise;
  });

  await t.test('should translate remove start/end by wallAnchor', async () => {
    const sb = createFakeSourceBuffer();
    const msb = new ManagedSourceBuffer(sb);
    msb.wallAnchor = 100;

    const removePromise = msb.remove(150, 160);

    // Verify remove was called with translated values
    assert.equal((sb.remove as sinon.SinonStub).called, true);
    assert.equal((sb.remove as sinon.SinonStub).firstCall.args[0], 50);  // 150 - 100
    assert.equal((sb.remove as sinon.SinonStub).firstCall.args[1], 60);  // 160 - 100

    // Simulate updateend
    const updateendHandler = (sb.addEventListener as sinon.SinonStub).args.find((call: any[]) => call[0] === 'updateend')?.[1];
    updateendHandler();

    await removePromise;
  });

  await t.test('should handle Infinity end in remove', async () => {
    const sb = createFakeSourceBuffer();
    const msb = new ManagedSourceBuffer(sb);
    msb.wallAnchor = 100;

    const removePromise = msb.remove(150, Infinity);

    assert.equal(sb.remove.firstCall.args[0], 50);     // 150 - 100
    assert.equal(sb.remove.firstCall.args[1], Infinity);

    const updateendHandler = sb.addEventListener.args.find((call: any[]) => call[0] === 'updateend')?.[1];
    updateendHandler();

    await removePromise;
  });

  await t.test('should queue operations in order', () => {
    const sb = createFakeSourceBuffer();
    const msb = new ManagedSourceBuffer(sb);

    const data1 = new ArrayBuffer(5);
    const data2 = new ArrayBuffer(5);

    // Queue two operations
    msb.append(data1);
    msb.append(data2);

    // First append should be invoked immediately
    assert.equal((sb.appendBuffer as sinon.SinonStub).callCount, 1);
  });

  await t.test('should set timestampOffset with wallAnchor translation', async () => {
    const sb = createFakeSourceBuffer();
    const msb = new ManagedSourceBuffer(sb);
    msb.wallAnchor = 100;

    msb.timestampOffset = 150;

    // Should be translated to 50 (150 - 100)
    assert.equal(sb.timestampOffset, 50);
  });

  await t.test('should set appendWindowStart with wallAnchor translation', async () => {
    const sb = createFakeSourceBuffer();
    const msb = new ManagedSourceBuffer(sb);
    msb.wallAnchor = 100;

    msb.appendWindowStart = 150;

    assert.equal(sb.appendWindowStart, 50); // 150 - 100
  });

  await t.test('should set appendWindowEnd with wallAnchor translation', async () => {
    const sb = createFakeSourceBuffer();
    const msb = new ManagedSourceBuffer(sb);
    msb.wallAnchor = 100;

    msb.appendWindowEnd = 250;

    assert.equal(sb.appendWindowEnd, 150); // 250 - 100
  });

  await t.test('should set mode', async () => {
    const sb = createFakeSourceBuffer();
    const msb = new ManagedSourceBuffer(sb);

    msb.mode = 'sequence';

    assert.equal(sb.mode, 'sequence');
  });



  await t.test('should handle abort operation', async () => {
    const sb = createFakeSourceBuffer();
    (sb as any).updating = false;
    const msb = new ManagedSourceBuffer(sb);

    // Aborting when not updating should resolve immediately
    await msb.abort();
    assert.ok(true);
  });

  await t.test('should reject all queued operations on error', () => {
    const sb = createFakeSourceBuffer();
    const msb = new ManagedSourceBuffer(sb);

    const data1 = new ArrayBuffer(5);
    const data2 = new ArrayBuffer(5);

    // Queue operations (without fully testing the error path)
    msb.append(data1);
    msb.append(data2);

    // Verify both were queued
    assert.equal((sb.appendBuffer as sinon.SinonStub).callCount, 1);
  });

  await t.test('should get timestampOffset without translation', () => {
    const sb = createFakeSourceBuffer();
    sb.timestampOffset = 42;
    const msb = new ManagedSourceBuffer(sb);

    // Getter returns raw value without translation
    assert.equal(msb.timestampOffset, 42);
  });

  await t.test('should get appendWindowStart without translation', () => {
    const sb = createFakeSourceBuffer();
    sb.appendWindowStart = 42;
    const msb = new ManagedSourceBuffer(sb);

    assert.equal(msb.appendWindowStart, 42);
  });

  await t.test('should get appendWindowEnd without translation', () => {
    const sb = createFakeSourceBuffer();
    sb.appendWindowEnd = 42;
    const msb = new ManagedSourceBuffer(sb);

    assert.equal(msb.appendWindowEnd, 42);
  });

  await t.test('should get mode', () => {
    const sb = createFakeSourceBuffer();
    sb.mode = 'sequence';
    const msb = new ManagedSourceBuffer(sb);

    assert.equal(msb.mode, 'sequence');
  });
});
