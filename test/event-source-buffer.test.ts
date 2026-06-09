/**
 * EventSourceBuffer — timing correctness tests.
 *
 * The core invariant under test:
 *
 *   cue.startTime (player time) = periodRelSec + wallTimestampOffset − wallAnchor
 *
 * where:
 *   periodRelSec = (Event@presentationTime − presentationTimeOffset) / timescale
 *
 * This is verified for:
 *   - timestampOffset = 0, wallAnchor = 0   (simple / VOD default)
 *   - timestampOffset > 0, wallAnchor > 0   (live stream with epoch wall-clock)
 *   - timestampOffset < 0                   (negative offset)
 *   - presentationTimeOffset combined with timestampOffset
 *
 * Buffered-range and append-window tests confirm the coordinate bookkeeping is
 * consistent.
 */

import './test-helpers';  // installs globalThis.VTTCue + MediaSource
import test    from 'node:test';
import assert  from 'node:assert/strict';
import sinon   from 'sinon';
import { EventSourceBuffer } from '../src/event-source-buffer';
import { EventSink }         from '../src/event-sink';

// ── Minimal DOMParser mock ────────────────────────────────────────────────────
//
// Node.js has no DOMParser.  We wire up the same stub used in
// event-stream-parser.test.ts: tests queue a pre-built MockDocument, and the
// mock DOMParser returns it on the next parseFromString() call.

class MockElement {
  localName: string;
  children:  MockElement[]    = [];
  textContent: string | null  = null;
  private attrs               = new Map<string, string>();

  constructor(localName: string) { this.localName = localName; }

  setAttribute(name: string, value: string): void { this.attrs.set(name, value); }
  getAttribute(name: string): string | null        { return this.attrs.get(name) ?? null; }
  hasAttribute(name: string): boolean              { return this.attrs.has(name); }
  querySelector(_: string): MockElement | null     { return null; }
  querySelectorAll(sel: string): MockElement[] {
    return sel === 'Event' ? this.children.filter(c => c.localName === 'Event') : [];
  }
}

class MockDocument {
  documentElement: MockElement;
  constructor(root: MockElement) { this.documentElement = root; }
  querySelector(_: string): null { return null; }
}

let _nextDoc: MockDocument | null = null;

(globalThis as any).DOMParser = class {
  parseFromString(_xml: string, _type: string): MockDocument {
    if (_nextDoc) { const d = _nextDoc; _nextDoc = null; return d; }
    // No document queued → return a parsererror document.
    const errEl = new MockElement('parsererror');
    const errDoc = new MockDocument(errEl);
    (errDoc as any).querySelector = (sel: string) =>
      sel === 'parsererror' ? errEl : null;
    return errDoc;
  }
};

/** Queue a document to be returned by the next DOMParser.parseFromString(). */
function withDoc(doc: MockDocument, fn: () => void): void {
  _nextDoc = doc;
  fn();
}

// ── Document builders ─────────────────────────────────────────────────────────

/** <EventStream timescale="…" …><Event …/></EventStream> */
function makeEventStreamDoc(
  streamAttrs: Record<string, string>,
  eventAttrs:  Record<string, string>,
): MockDocument {
  const root = new MockElement('EventStream');
  for (const [k, v] of Object.entries(streamAttrs)) root.setAttribute(k, v);
  const ev = new MockElement('Event');
  for (const [k, v] of Object.entries(eventAttrs)) ev.setAttribute(k, v);
  root.children.push(ev);
  return new MockDocument(root);
}

/** Helper: UTF-8 ArrayBuffer (content is never actually parsed — DOMParser is mocked). */
function enc(s: string): ArrayBuffer {
  return new TextEncoder().encode(s).buffer;
}

// ── Test infrastructure ───────────────────────────────────────────────────────

function createFakeTrack(): any {
  const cues: any[] = [];
  return {
    cues,
    addCue:    sinon.stub().callsFake((c: any) => cues.push(c)),
    removeCue: sinon.stub().callsFake((c: any) => {
      const i = cues.indexOf(c);
      if (i !== -1) cues.splice(i, 1);
    }),
    addEventListener:    sinon.stub(),
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

/** Create a wired-up (EventSourceBuffer, fake track) pair ready for assertions. */
function makeBuffer(): { buf: EventSourceBuffer; track: ReturnType<typeof createFakeTrack> } {
  const track   = createFakeTrack();
  const emitter = createFakeEmitter();
  const sink    = new EventSink(track, emitter);
  const buf     = new EventSourceBuffer(track, sink);
  return { buf, track };
}

/**
 * Append a single-event EventStream XML to `buf` and return the first cue
 * added to the fake track.
 *
 * @param buf        Target buffer (timestampOffset + wallAnchor already set).
 * @param timescale  EventStream@timescale
 * @param ptRaw      Event@presentationTime (timescale units)
 * @param durRaw     Event@duration (timescale units, default 1000)
 * @param pto        EventStream@presentationTimeOffset (timescale units, default 0)
 */
async function appendAndGetCue(
  buf:       EventSourceBuffer,
  track:     ReturnType<typeof createFakeTrack>,
  timescale: number,
  ptRaw:     number,
  durRaw     = 1000,
  pto        = 0,
): Promise<any> {
  const streamAttrs: Record<string, string> = {
    schemeIdUri: 'urn:test',
    timescale:   String(timescale),
  };
  if (pto !== 0) streamAttrs.presentationTimeOffset = String(pto);

  const doc = makeEventStreamDoc(streamAttrs, {
    presentationTime: String(ptRaw),
    duration:         String(durRaw),
    id:               '1',
  });

  await withDoc(doc, () => buf.append(enc('<xml/>')));
  // append() is async (queue pump via Promise.resolve microtask)
  await Promise.resolve();
  await Promise.resolve();

  return track.cues[track.cues.length - 1];
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test('EventSourceBuffer timing', async (t) => {

  // ── 1. Baseline: timestampOffset=0, wallAnchor=0 ───────────────────────────

  await t.test('timestampOffset=0 wallAnchor=0: cue.startTime = periodRelSec', async () => {
    const { buf, track } = makeBuffer();
    buf.timestampOffset = 0;
    buf.wallAnchor      = 0;

    // timescale=1000, pt=10000 → periodRelSec = 10 s
    // wallTimestampOffset=0, wallAnchor=0 → cue.startTime = 10
    const cue = await appendAndGetCue(buf, track, 1000, 10_000, 1000);
    assert.ok(cue, 'cue should have been created');
    assert.ok(Math.abs(cue.startTime - 10) < 1e-9,
      `startTime should be 10, got ${cue.startTime}`);
    assert.ok(Math.abs(cue.endTime - 11) < 1e-9,
      `endTime should be 11, got ${cue.endTime}`);
  });

  // ── 2. Live stream: large positive timestampOffset and wallAnchor ──────────

  await t.test('timestampOffset=W wallAnchor=A: cue.startTime = periodRelSec + W - A', async () => {
    const { buf, track } = makeBuffer();
    const W = 1_700_000_000;   // typical Unix epoch for a live stream Period start
    const A = 1_700_000_005;   // wallAnchor 5 s after Period start
    buf.timestampOffset = W;
    buf.wallAnchor      = A;

    // timescale=1, pt=10 → periodRelSec=10
    // expected cue.startTime = 10 + W - A = 10 + 1_700_000_000 - 1_700_000_005 = 5
    const cue = await appendAndGetCue(buf, track, 1, 10, 1);
    assert.ok(cue, 'cue should have been created');
    assert.ok(Math.abs(cue.startTime - 5) < 1e-9,
      `startTime should be 5, got ${cue.startTime}`);
  });

  // ── 3. Negative timestampOffset ────────────────────────────────────────────

  await t.test('negative timestampOffset: cue.startTime = periodRelSec + W - A', async () => {
    const { buf, track } = makeBuffer();
    buf.timestampOffset = -5;
    buf.wallAnchor      = 0;

    // timescale=1, pt=10 → periodRelSec=10
    // expected cue.startTime = 10 + (-5) - 0 = 5
    const cue = await appendAndGetCue(buf, track, 1, 10, 1);
    assert.ok(cue, 'cue should have been created');
    assert.ok(Math.abs(cue.startTime - 5) < 1e-9,
      `startTime should be 5, got ${cue.startTime}`);
  });

  await t.test('negative timestampOffset with non-zero wallAnchor', async () => {
    const { buf, track } = makeBuffer();
    buf.timestampOffset = -100;
    buf.wallAnchor      = 3;

    // timescale=1, pt=120 → periodRelSec=120
    // expected cue.startTime = 120 + (-100) - 3 = 17
    const cue = await appendAndGetCue(buf, track, 1, 120, 1);
    assert.ok(cue, 'cue should have been created');
    assert.ok(Math.abs(cue.startTime - 17) < 1e-9,
      `startTime should be 17, got ${cue.startTime}`);
  });

  // ── 4. presentationTimeOffset combined with timestampOffset ────────────────

  await t.test('presentationTimeOffset is subtracted before timescale division', async () => {
    const { buf, track } = makeBuffer();
    buf.timestampOffset = 100;
    buf.wallAnchor      = 0;

    // timescale=1000, pto=5000, pt=15000 → periodRelSec=(15000-5000)/1000 = 10
    // wallClock = 10 + 100 = 110; cue.startTime = 110 - 0 = 110
    const cue = await appendAndGetCue(buf, track, 1000, 15_000, 1000, 5000);
    assert.ok(cue, 'cue should have been created');
    assert.ok(Math.abs(cue.startTime - 110) < 1e-9,
      `startTime should be 110, got ${cue.startTime}`);
  });

  // ── 5. Buffered ranges are in wall-clock epoch (player-time + wallAnchor) ──

  await t.test('buffered.start/end reflect wall-clock epoch', async () => {
    const { buf, track } = makeBuffer();
    const W = 200;
    const A = 10;
    buf.timestampOffset = W;
    buf.wallAnchor      = A;

    // timescale=1, pt=5, dur=3 → periodRelSec=5, wallClock=205
    // playerStart = 205 - 10 = 195; buffered (internal) stores 195..198
    // buffered getter adds wallAnchor → 205..208
    const cue = await appendAndGetCue(buf, track, 1, 5, 3);
    assert.ok(cue, 'cue should have been created');
    assert.equal(buf.buffered.length, 1);
    assert.ok(Math.abs(buf.buffered.start(0) - 205) < 1e-9,
      `buffered.start should be 205, got ${buf.buffered.start(0)}`);
    assert.ok(Math.abs(buf.buffered.end(0) - 208) < 1e-9,
      `buffered.end should be 208, got ${buf.buffered.end(0)}`);
  });

  // ── 6. Append window filters by wall-clock epoch ───────────────────────────

  await t.test('event outside appendWindowEnd is filtered out', async () => {
    const { buf, track } = makeBuffer();
    buf.timestampOffset = 0;
    buf.wallAnchor      = 0;

    // Window: [0, 5) — event at t=10 should be dropped.
    buf.appendWindowStart = 0;
    buf.appendWindowEnd   = 5;

    await appendAndGetCue(buf, track, 1, 10, 1);
    assert.equal(track.cues.length, 0, 'cue should have been filtered by appendWindowEnd');
  });

  await t.test('event inside append window passes through', async () => {
    const { buf, track } = makeBuffer();
    buf.timestampOffset = 0;
    buf.wallAnchor      = 0;

    buf.appendWindowStart = 0;
    buf.appendWindowEnd   = 15;

    await appendAndGetCue(buf, track, 1, 10, 1);
    assert.equal(track.cues.length, 1, 'cue should have been accepted by append window');
  });

  await t.test('append window uses wall-clock epoch (offset shifts which events pass)', async () => {
    const { buf, track } = makeBuffer();
    const W = 1000;
    buf.timestampOffset = W;   // wallClock = periodRelSec + 1000
    buf.wallAnchor      = 0;

    // periodRelSec=5 → wallClock=1005; window [1000, 1010) → passes
    buf.appendWindowStart = 1000;
    buf.appendWindowEnd   = 1010;

    await appendAndGetCue(buf, track, 1, 5, 1);
    assert.equal(track.cues.length, 1, 'event at wallClock=1005 should pass window [1000,1010)');
  });
});
