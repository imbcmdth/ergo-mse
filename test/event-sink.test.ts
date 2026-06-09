import './test-helpers';
import test from 'node:test';
import assert from 'node:assert/strict';
import sinon from 'sinon';
import { BoundedEventDedup } from '../src/dash-event';
import { EventSink } from '../src/event-sink';
import type { EmsgBox, DashEvent } from '../src/dash-event';

// ── Helpers ───────────────────────────────────────────────────────────────────

function createFakeTrack(): any {
  const cues: any[] = [];
  return {
    cues,
    addCue: sinon.stub().callsFake((c: any) => cues.push(c)),
    removeCue: sinon.stub().callsFake((c: any) => {
      const i = cues.indexOf(c);
      if (i !== -1) cues.splice(i, 1);
    }),
    addEventListener: sinon.stub(),
    removeEventListener: sinon.stub(),
  };
}

function createFakeEmitter(): any {
  return {
    emitReceive:  sinon.stub(),
    emitActivate: sinon.stub(),
    dispose:      sinon.stub(),
  };
}

function makeEmsg(overrides: Partial<EmsgBox> = {}): EmsgBox {
  return {
    schemeIdUri:     'urn:example',
    value:           'test',
    timescale:       90000,
    presentationTime: 180000, // 2 s at 90 kHz
    eventDuration:   90000,   // 1 s
    id:              1,
    messageData:     new Uint8Array([0xAB]),
    ...overrides,
  };
}

function makeDashEvent(overrides: Partial<DashEvent> = {}): DashEvent {
  const base: DashEvent = {
    schemeIdUri:     'urn:example',
    value:           'v',
    id:              1,
    presentationTime: 10,
    duration:        5,
    source:          'event-stream',
    uniqueKey:       'urn:example|v|1|10',
  };
  return { ...base, ...overrides };
}

// ── BoundedEventDedup tests ───────────────────────────────────────────────────

test('BoundedEventDedup', async (t) => {
  await t.test('returns false for unseen keys', () => {
    const d = new BoundedEventDedup(5);
    assert.equal(d.seen('a'), false);
  });

  await t.test('returns true for previously seen keys', () => {
    const d = new BoundedEventDedup(5);
    d.seen('a');
    assert.equal(d.seen('a'), true);
  });

  await t.test('evicts oldest entry when cap is exceeded', () => {
    const d = new BoundedEventDedup(3);
    d.seen('a');
    d.seen('b');
    d.seen('c');
    // Adding 'd' should evict 'a'
    d.seen('d');
    assert.equal(d.size, 3);
    // 'a' was evicted — no longer a duplicate
    assert.equal(d.seen('a'), false);
    // 'b', 'c', 'd' still present
  });

  await t.test('size stays bounded at maxEntries', () => {
    const d = new BoundedEventDedup(5);
    for (let i = 0; i < 20; i++) d.seen(`key-${i}`);
    assert.equal(d.size, 5);
  });

  await t.test('different keys are independent', () => {
    const d = new BoundedEventDedup(10);
    d.seen('x');
    assert.equal(d.seen('y'), false);
    assert.equal(d.seen('x'), true);
  });
});

// ── EventSink tests ───────────────────────────────────────────────────────────

test('EventSink', async (t) => {
  await t.test('addEmsgEvent creates a cue with correct player-time', () => {
    const track   = createFakeTrack();
    const emitter = createFakeEmitter();
    const sink    = new EventSink(track, emitter);

    // Simple numbers: timescale=1, presentationTime=5 s (wall-clock absolute),
    // wallAnchor=2 s → playerTime = 5 - 2 = 3 s.
    const wallAnchor = 2;
    sink.addEmsgEvent(makeEmsg({
      timescale:        1,
      presentationTime: 5,  // 5 s absolute wall-clock
      eventDuration:    1,  // 1 s
    }), wallAnchor);

    assert.equal(track.addCue.callCount, 1);
    const cue = track.cues[0];
    assert.ok(Math.abs(cue.startTime - 3) < 0.001, `startTime should be 3, got ${cue.startTime}`);
    assert.ok(Math.abs(cue.endTime   - 4) < 0.001, `endTime should be 4, got ${cue.endTime}`);
  });

  await t.test('addEmsgEvent fires event:receive immediately', () => {
    const track   = createFakeTrack();
    const emitter = createFakeEmitter();
    const sink    = new EventSink(track, emitter);
    sink.addEmsgEvent(makeEmsg(), 0);
    assert.equal(emitter.emitReceive.callCount, 1);
  });

  await t.test('duplicate emsg events are dropped (same uniqueKey)', () => {
    const track   = createFakeTrack();
    const emitter = createFakeEmitter();
    const sink    = new EventSink(track, emitter);
    sink.addEmsgEvent(makeEmsg({ id: 5 }), 0);
    sink.addEmsgEvent(makeEmsg({ id: 5 }), 0); // same key → dropped
    assert.equal(track.addCue.callCount, 1);
    assert.equal(emitter.emitReceive.callCount, 1);
  });

  await t.test('emsg with unknown duration (0xFFFF_FFFF) → instantaneous cue', () => {
    const track   = createFakeTrack();
    const emitter = createFakeEmitter();
    const sink    = new EventSink(track, emitter);
    sink.addEmsgEvent(makeEmsg({ eventDuration: 0xFFFF_FFFF, timescale: 1, presentationTime: 5 }), 0);
    const cue = track.cues[0];
    assert.ok(cue.endTime - cue.startTime <= 0.002, 'should be near instantaneous');
  });

  await t.test('instantaneous stream events get 1 ms synthetic duration', () => {
    const track   = createFakeTrack();
    const emitter = createFakeEmitter();
    const sink    = new EventSink(track, emitter);
    const ev = makeDashEvent({ duration: 0, presentationTime: 10 });
    sink.addStreamEvent(ev, 0);
    const cue = track.cues[0];
    assert.ok(cue.endTime > cue.startTime, 'endTime must be > startTime');
    assert.ok(cue.endTime - cue.startTime <= 0.002);
  });

  await t.test('cross-source deduplication: emsg then event-stream same key', () => {
    const track   = createFakeTrack();
    const emitter = createFakeEmitter();
    const sink    = new EventSink(track, emitter);

    // emsg with presentationTime=2 s (90000/90000), id=1, scheme='urn:example', value='test'
    sink.addEmsgEvent(makeEmsg({
      schemeIdUri: 'urn:x', value: 'y', id: 7, timescale: 1, presentationTime: 100, eventDuration: 10,
    }), 0);

    // Same event delivered via event-stream — uniqueKey must match and be dropped
    const ev = makeDashEvent({
      schemeIdUri: 'urn:x', value: 'y', id: 7, presentationTime: 100, duration: 10,
      uniqueKey: 'urn:x|y|7|100',
      source: 'event-stream',
    });
    sink.addStreamEvent(ev, 0);

    assert.equal(track.addCue.callCount, 1);
  });

  await t.test('cue has dashEvent property attached', () => {
    const track   = createFakeTrack();
    const emitter = createFakeEmitter();
    const sink    = new EventSink(track, emitter);
    sink.addEmsgEvent(makeEmsg(), 0);
    const cue = track.cues[0];
    assert.ok((cue as any).dashEvent, 'cue.dashEvent should be set');
    assert.equal((cue as any).dashEvent.source, 'emsg');
  });

  await t.test('dedup is bounded to ~20 entries', () => {
    const track   = createFakeTrack();
    const emitter = createFakeEmitter();
    const sink    = new EventSink(track, emitter, 3); // small cap for test

    // Fill to cap
    sink.addEmsgEvent(makeEmsg({ id: 1, presentationTime: 1 }), 0);
    sink.addEmsgEvent(makeEmsg({ id: 2, presentationTime: 2 }), 0);
    sink.addEmsgEvent(makeEmsg({ id: 3, presentationTime: 3 }), 0);
    // Overflow — oldest (id=1) evicted
    sink.addEmsgEvent(makeEmsg({ id: 4, presentationTime: 4 }), 0);

    // id=1 should be accepted again (was evicted)
    sink.addEmsgEvent(makeEmsg({ id: 1, presentationTime: 1 }), 0);
    assert.equal(track.addCue.callCount, 5); // all 5 accepted
  });
});
