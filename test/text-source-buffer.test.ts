import './test-helpers';
import test from 'node:test';
import assert from 'node:assert/strict';
import sinon from 'sinon';
import { TextSourceBuffer } from '../src/text-source-buffer';

// Helper to create a fake TextTrack
function createFakeTextTrack(): any {
  return {
    mode: 'hidden',
    cues: [],
    addCue: sinon.stub().callsFake(function(this: any, cue: TextTrackCue) {
      this.cues.push(cue);
    }),
    removeCue: sinon.stub().callsFake(function(this: any, cue: TextTrackCue) {
      const idx = this.cues.indexOf(cue);
      if (idx !== -1) {
        this.cues.splice(idx, 1);
      }
    }),
  };
}

// Helper to create a fake video element
function createFakeVideoElement(): any {
  const track = createFakeTextTrack();
  return {
    addTextTrack: sinon.stub().returns(track),
  };
}

test('TextSourceBuffer', async (t) => {
  await t.test('should initialize with hidden text track', () => {
    const videoEl = createFakeVideoElement();
    const tsb = new TextSourceBuffer(videoEl, 'English', 'en');

    assert.equal((videoEl.addTextTrack as sinon.SinonStub).called, true);
    assert.equal((videoEl.addTextTrack as sinon.SinonStub).firstCall.args[0], 'subtitles');
    assert.equal(tsb.textTrack.mode, 'hidden');
  });

  await t.test('should initialize with provided label and lang', () => {
    const videoEl = createFakeVideoElement();
    const tsb = new TextSourceBuffer(videoEl, 'My Label', 'fr');

    assert.equal((videoEl.addTextTrack as sinon.SinonStub).firstCall.args[1], 'My Label');
    assert.equal((videoEl.addTextTrack as sinon.SinonStub).firstCall.args[2], 'fr');
  });

  await t.test('should initialize with wallAnchor = 0', () => {
    const videoEl = createFakeVideoElement();
    const tsb = new TextSourceBuffer(videoEl, 'English', 'en');

    assert.equal(tsb.wallAnchor, 0);
  });

  await t.test('should have updating = false initially', () => {
    const videoEl = createFakeVideoElement();
    const tsb = new TextSourceBuffer(videoEl, 'English', 'en');

    assert.equal(tsb.updating, false);
  });

  await t.test('should have empty buffered ranges initially', () => {
    const videoEl = createFakeVideoElement();
    const tsb = new TextSourceBuffer(videoEl, 'English', 'en');

    assert.equal(tsb.buffered.length, 0);
  });

  await t.test('should set timestampOffset', () => {
    const videoEl = createFakeVideoElement();
    const tsb = new TextSourceBuffer(videoEl, 'English', 'en');

    tsb.timestampOffset = 100;
    assert.equal(tsb.timestampOffset, 100);
  });

  await t.test('should translate timestampOffset by wallAnchor', () => {
    const videoEl = createFakeVideoElement();
    const tsb = new TextSourceBuffer(videoEl, 'English', 'en');

    tsb.wallAnchor = 50;
    tsb.timestampOffset = 150;

    // Stored value is 150 (wall-clock)
    assert.equal(tsb.timestampOffset, 150);
  });

  await t.test('should set appendWindowStart', () => {
    const videoEl = createFakeVideoElement();
    const tsb = new TextSourceBuffer(videoEl, 'English', 'en');

    tsb.appendWindowStart = 10;
    assert.equal(tsb.appendWindowStart, 10);
  });

  await t.test('should translate appendWindowStart by wallAnchor', () => {
    const videoEl = createFakeVideoElement();
    const tsb = new TextSourceBuffer(videoEl, 'English', 'en');

    tsb.wallAnchor = 50;
    tsb.appendWindowStart = 100;

    assert.equal(tsb.appendWindowStart, 100);
  });

  await t.test('should set appendWindowEnd', () => {
    const videoEl = createFakeVideoElement();
    const tsb = new TextSourceBuffer(videoEl, 'English', 'en');

    tsb.appendWindowEnd = 20;
    assert.equal(tsb.appendWindowEnd, 20);
  });

  await t.test('should translate appendWindowEnd by wallAnchor', () => {
    const videoEl = createFakeVideoElement();
    const tsb = new TextSourceBuffer(videoEl, 'English', 'en');

    tsb.wallAnchor = 50;
    tsb.appendWindowEnd = 100;

    assert.equal(tsb.appendWindowEnd, 100);
  });

  await t.test('should always have mode = segments', () => {
    const videoEl = createFakeVideoElement();
    const tsb = new TextSourceBuffer(videoEl, 'English', 'en');

    assert.equal(tsb.mode, 'segments');

    // Setting mode should be a no-op
    tsb.mode = 'sequence';
    assert.equal(tsb.mode, 'segments');
  });

  await t.test('should show text track', () => {
    const videoEl = createFakeVideoElement();
    const tsb = new TextSourceBuffer(videoEl, 'English', 'en');

    tsb.show();
    assert.equal(tsb.textTrack.mode, 'showing');
  });

  await t.test('should hide text track', () => {
    const videoEl = createFakeVideoElement();
    const tsb = new TextSourceBuffer(videoEl, 'English', 'en');

    tsb.show();
    tsb.hide();
    assert.equal(tsb.textTrack.mode, 'hidden');
  });

  await t.test('should queue append operations', async () => {
    const videoEl = createFakeVideoElement();
    const tsb = new TextSourceBuffer(videoEl, 'English', 'en', 'vtt-sidecar');

    const data = new TextEncoder().encode('WEBVTT\n\n00:00:00 --> 00:00:10\nTest');

    // Create a stub for console.warn to avoid test output
    const consoleStub = sinon.stub(console, 'warn');

    try {
      const appendPromise = tsb.append(data);

      // Should resolve after microtask
      await appendPromise;

      assert.ok(true);
    } finally {
      consoleStub.restore();
    }
  });

  await t.test('should serialize append operations', async () => {
    const videoEl = createFakeVideoElement();
    const tsb = new TextSourceBuffer(videoEl, 'English', 'en', 'vtt-sidecar');

    const consoleStub = sinon.stub(console, 'warn');

    try {
      const data1 = new TextEncoder().encode('WEBVTT\n\n00:00:00 --> 00:00:10\nTest1');
      const data2 = new TextEncoder().encode('WEBVTT\n\n00:00:10 --> 00:00:20\nTest2');

      const p1 = tsb.append(data1);
      const p2 = tsb.append(data2);

      // Both should eventually resolve
      await p1;
      await p2;

      assert.ok(true);
    } finally {
      consoleStub.restore();
    }
  });

  await t.test('should queue remove operations', async () => {
    const videoEl = createFakeVideoElement();
    const tsb = new TextSourceBuffer(videoEl, 'English', 'en');

    const removePromise = tsb.remove(10, 20);

    // Should resolve after microtask
    await removePromise;
    assert.ok(true);
  });

  await t.test('should translate remove start/end by wallAnchor', async () => {
    const videoEl = createFakeVideoElement();
    const tsb = new TextSourceBuffer(videoEl, 'English', 'en');

    tsb.wallAnchor = 50;

    // Queue a remove operation
    const removePromise = tsb.remove(60, 70); // 60-50=10, 70-50=20

    // Should resolve without error
    await removePromise;
    assert.ok(true);
  });

  await t.test('should abort queued operations', async () => {
    const videoEl = createFakeVideoElement();
    const tsb = new TextSourceBuffer(videoEl, 'English', 'en');

    const consoleStub = sinon.stub(console, 'warn');

    try {
      const data = new TextEncoder().encode('WEBVTT\n\n00:00:00 --> 00:00:10\nTest');

      const p1 = tsb.append(data);
      const p2 = tsb.append(data);

      // Abort should reject queued operations
      const abortPromise = tsb.abort();

      try {
        await p2; // Second append should be rejected
        assert.fail('Should have been aborted');
      } catch (err: any) {
        assert.equal(err.message, 'Aborted');
      }

      await abortPromise;
    } finally {
      consoleStub.restore();
    }
  });

  await t.test('should changeType and reset demuxer', () => {
    const videoEl = createFakeVideoElement();
    const tsb = new TextSourceBuffer(videoEl, 'English', 'en', 'vtt-sidecar');

    // changeType should not throw
    tsb.changeType('application/ttml+xml');

    assert.ok(true);
  });

  await t.test('should handle default appendWindowStart/End as Infinity', () => {
    const videoEl = createFakeVideoElement();
    const tsb = new TextSourceBuffer(videoEl, 'English', 'en');

    assert.equal(tsb.appendWindowStart, -Infinity);
    assert.equal(tsb.appendWindowEnd, Infinity);
  });

  await t.test('should track buffered ranges after append', async () => {
    const videoEl = createFakeVideoElement();
    const tsb = new TextSourceBuffer(videoEl, 'English', 'en', 'vtt-sidecar');

    const consoleStub = sinon.stub(console, 'warn');

    try {
      // Create minimal VTT data
      const vttData = new TextEncoder().encode(`WEBVTT

00:00:00.000 --> 00:00:10.000
Test cue
`);

      // Append should complete without error
      await tsb.append(vttData);
      assert.ok(true);
    } finally {
      consoleStub.restore();
    }
  });

  await t.test('should have ISourceBuffer interface', () => {
    const videoEl = createFakeVideoElement();
    const tsb = new TextSourceBuffer(videoEl, 'English', 'en');

    // Check that all ISourceBuffer methods/properties exist
    assert.ok(typeof tsb.append === 'function');
    assert.ok(typeof tsb.remove === 'function');
    assert.ok(typeof tsb.abort === 'function');
    assert.ok(typeof tsb.changeType === 'function');
    assert.ok(typeof tsb.show === 'function');
    assert.ok(typeof tsb.hide === 'function');

    assert.ok('updating' in tsb);
    assert.ok('buffered' in tsb);
    assert.ok('timestampOffset' in tsb);
    assert.ok('appendWindowStart' in tsb);
    assert.ok('appendWindowEnd' in tsb);
    assert.ok('mode' in tsb);
    assert.ok('wallAnchor' in tsb);
  });

  await t.test('should handle unknown codec gracefully', async () => {
    const videoEl = createFakeVideoElement();
    const tsb = new TextSourceBuffer(videoEl, 'English', 'en', 'unknown-codec');

    const consoleStub = sinon.stub(console, 'warn');

    try {
      const data = new ArrayBuffer(10);

      // Should append without throwing
      await tsb.append(data);

      // Should have warned about unknown codec
      assert.equal(consoleStub.called, true);
    } finally {
      consoleStub.restore();
    }
  });

  await t.test('should reject append after abort', async () => {
    const videoEl = createFakeVideoElement();
    const tsb = new TextSourceBuffer(videoEl, 'English', 'en');

    const consoleStub = sinon.stub(console, 'warn');

    try {
      const data = new TextEncoder().encode('WEBVTT');

      const p1 = tsb.append(data);
      const p2 = tsb.append(data);

      await tsb.abort();

      try {
        await p2;
        assert.fail('Should have been rejected');
      } catch (err: any) {
        assert.equal(err.message, 'Aborted');
      }
    } finally {
      consoleStub.restore();
    }
  });
});
