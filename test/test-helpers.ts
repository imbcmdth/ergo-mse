/**
 * Test helpers — sinon-based stubs for browser globals.
 *
 * Sets MockMediaSource and MockVTTCue on globalThis so library code that
 * references bare globals (new MediaSource(), new VTTCue()) works in Node.js.
 * URL.createObjectURL/revokeObjectURL are set as plain functions so individual
 * tests can use sinon.stub(URL, ...) to spy on them.
 *
 * Tests verify *semantics*: which methods the library calls on the browser
 * interfaces and with what arguments — not real browser behaviour.
 */

import sinon from 'sinon';

// ── VTTCue mock ────────────────────────────────────────────────────────────────

export class MockVTTCue {
  id        = '';
  line: number | 'auto'     = 'auto';
  position: number | 'auto' = 'auto';
  size      = 100;
  align     = 'center';

  constructor(
    public startTime: number,
    public endTime:   number,
    public text:      string
  ) {}
}

// ── MediaSource mock ───────────────────────────────────────────────────────────

/**
 * The most recently constructed MockMediaSource.
 * Tests capture this after new ErgoMediaSource() to inspect what the library
 * called on the inner MediaSource instance.
 */
export let lastMediaSource: MockMediaSource | null = null;

export class MockMediaSource {
  static isTypeSupported: sinon.SinonStub = sinon.stub().returns(false);

  readyState: ReadyState = 'closed';
  duration               = NaN;

  addSourceBuffer: sinon.SinonStub      = sinon.stub().returns(createFakeSourceBuffer());
  endOfStream: sinon.SinonStub          = sinon.stub();
  setLiveSeekableRange: sinon.SinonStub = sinon.stub();

  private readonly _handlers = new Map<string, Function[]>();

  constructor() {
    lastMediaSource = this;
  }

  addEventListener(event: string, handler: Function, _opts?: unknown): void {
    const list = this._handlers.get(event) ?? [];
    list.push(handler);
    this._handlers.set(event, list);
    // Auto-fire sourceopen after a microtask so ErgoMediaSource.attach() resolves.
    if (event === 'sourceopen') {
      this.readyState = 'open';
      Promise.resolve().then(() => { handler(); });
    }
  }

  removeEventListener(event: string, handler: Function): void {
    const list  = this._handlers.get(event) ?? [];
    const idx   = list.indexOf(handler);
    if (idx !== -1) {
      list.splice(idx, 1);
    }
  }

  /** Synchronously fires the 'error' event — lets tests exercise the error path. */
  _fireError(): void {
    for (const h of this._handlers.get('error') ?? []) {
      h();
    }
  }
}

// ── Fake SourceBuffer (returned by MockMediaSource.addSourceBuffer) ─────────────

export function createFakeSourceBuffer(): any {
  return {
    updating:          false,
    buffered:          { length: 0, start: () => 0, end: () => 0 } as TimeRanges,
    timestampOffset:   0,
    appendWindowStart: 0,
    appendWindowEnd:   Infinity,
    mode:              'segments' as const,
    appendBuffer:      sinon.stub(),
    remove:            sinon.stub(),
    abort:             sinon.stub(),
    changeType:        sinon.stub(),
    addEventListener:  sinon.stub(),
    removeEventListener: sinon.stub(),
  };
}

// ── URL stubs ──────────────────────────────────────────────────────────────────
// Plain functions so sinon.stub(URL, 'createObjectURL') works in individual tests.

(URL as any).createObjectURL = (): string => 'blob:mock-url';
(URL as any).revokeObjectURL = (): void   => {};

// ── Install globals ────────────────────────────────────────────────────────────

(globalThis as any).MediaSource = MockMediaSource;
(globalThis as any).VTTCue      = MockVTTCue;
