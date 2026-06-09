import './test-helpers';
import test from 'node:test';
import assert from 'node:assert/strict';
import sinon from 'sinon';
import { DashEventEmitter } from '../src/event-emitter';
import type { DashEvent } from '../src/dash-event';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeDashEvent(overrides: Partial<DashEvent> = {}): DashEvent {
  return {
    schemeIdUri:     'urn:example',
    value:           'v1',
    id:              1,
    presentationTime: 10,
    duration:        2,
    source:          'emsg',
    uniqueKey:       'urn:example|v1|1|10',
    ...overrides,
  };
}

function createFakeVideoEl(): any {
  const listeners: Map<string, Function[]> = new Map();
  return {
    _listeners: listeners,
    dispatchEvent: sinon.stub().callsFake((e: Event) => {
      for (const fn of listeners.get(e.type) ?? []) fn(e);
    }),
    addEventListener: sinon.stub().callsFake((type: string, fn: Function) => {
      const list = listeners.get(type) ?? [];
      list.push(fn);
      listeners.set(type, list);
    }),
    removeEventListener: sinon.stub().callsFake((type: string, fn: Function) => {
      const list = listeners.get(type) ?? [];
      const i = list.indexOf(fn);
      if (i !== -1) list.splice(i, 1);
    }),
  };
}

function createFakeTrack(): any {
  const listeners: Map<string, Function[]> = new Map();
  let activeCues: any[] = [];
  return {
    _listeners: listeners,
    get activeCues() { return activeCues; },
    set _activeCues(v: any[]) { activeCues = v; },
    addEventListener: sinon.stub().callsFake((type: string, fn: Function) => {
      const list = listeners.get(type) ?? [];
      list.push(fn);
      listeners.set(type, list);
    }),
    removeEventListener: sinon.stub().callsFake((type: string, fn: Function) => {
      const list = listeners.get(type) ?? [];
      const i = list.indexOf(fn);
      if (i !== -1) list.splice(i, 1);
    }),
    _fireCueChange() {
      for (const fn of listeners.get('cuechange') ?? []) fn();
    },
  };
}

function makeFakeCue(event: DashEvent): any {
  const cue: any = { startTime: event.presentationTime, endTime: event.presentationTime + event.duration };
  cue.dashEvent = event;
  return cue;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test('DashEventEmitter', async (t) => {
  await t.test('emitReceive dispatches event:receive on video element', () => {
    const videoEl = createFakeVideoEl();
    const track   = createFakeTrack();
    const emitter = new DashEventEmitter(videoEl, track);
    const ev      = makeDashEvent();

    emitter.emitReceive(ev);

    assert.equal(videoEl.dispatchEvent.callCount, 1);
    const dispatched: CustomEvent = videoEl.dispatchEvent.firstCall.args[0];
    assert.equal(dispatched.type, 'event:receive');
    assert.equal(dispatched.detail.schemeIdUri, 'urn:example');
    assert.equal(dispatched.detail.id, 1);
    assert.equal(dispatched.detail.source, 'emsg');
  });

  await t.test('emitActivate dispatches event:activate on video element', () => {
    const videoEl = createFakeVideoEl();
    const track   = createFakeTrack();
    const emitter = new DashEventEmitter(videoEl, track);
    const ev      = makeDashEvent();

    emitter.emitActivate(ev);

    assert.equal(videoEl.dispatchEvent.callCount, 1);
    const dispatched: CustomEvent = videoEl.dispatchEvent.firstCall.args[0];
    assert.equal(dispatched.type, 'event:activate');
  });

  await t.test('event:activate fired when cue becomes active via cuechange', () => {
    const videoEl = createFakeVideoEl();
    const track   = createFakeTrack();
    new DashEventEmitter(videoEl, track);

    const ev  = makeDashEvent();
    const cue = makeFakeCue(ev);
    track._activeCues = [cue];
    track._fireCueChange();

    const types = videoEl.dispatchEvent.args.map((a: any[]) => a[0].type) as string[];
    assert.ok(types.includes('event:activate'), 'should have fired event:activate');
  });

  await t.test('event:activate not double-fired for the same cue', () => {
    const videoEl = createFakeVideoEl();
    const track   = createFakeTrack();
    new DashEventEmitter(videoEl, track);

    const cue = makeFakeCue(makeDashEvent());
    track._activeCues = [cue];
    track._fireCueChange();
    track._fireCueChange(); // fire again with same cue active

    const activates = videoEl.dispatchEvent.args
      .map((a: any[]) => a[0].type)
      .filter((t: string) => t === 'event:activate');
    assert.equal(activates.length, 1, 'should only fire once');
  });

  await t.test('event:receive NOT re-fired on event:activate (separate paths)', () => {
    const videoEl = createFakeVideoEl();
    const track   = createFakeTrack();
    const emitter = new DashEventEmitter(videoEl, track);
    const ev      = makeDashEvent();

    // Only emitReceive was called explicitly
    emitter.emitReceive(ev);
    // Then cue becomes active
    const cue = makeFakeCue(ev);
    track._activeCues = [cue];
    track._fireCueChange();

    const receiveCount = videoEl.dispatchEvent.args
      .map((a: any[]) => a[0].type)
      .filter((t: string) => t === 'event:receive').length;
    assert.equal(receiveCount, 1, 'event:receive should not fire again on activate');
  });

  await t.test('cue without dashEvent attached does not crash or emit activate', () => {
    const videoEl = createFakeVideoEl();
    const track   = createFakeTrack();
    new DashEventEmitter(videoEl, track);

    const bareCue = { startTime: 1, endTime: 2 }; // no dashEvent property
    track._activeCues = [bareCue];
    assert.doesNotThrow(() => track._fireCueChange());

    const activates = videoEl.dispatchEvent.args
      .map((a: any[]) => a[0].type)
      .filter((t: string) => t === 'event:activate');
    assert.equal(activates.length, 0);
  });

  await t.test('dispose removes the cuechange listener', () => {
    const videoEl = createFakeVideoEl();
    const track   = createFakeTrack();
    const emitter = new DashEventEmitter(videoEl, track);

    emitter.dispose();

    assert.equal(track.removeEventListener.callCount, 1);
    // After dispose, firing cuechange should not dispatch anything
    const cue = makeFakeCue(makeDashEvent());
    track._activeCues = [cue];
    track._fireCueChange();
    assert.equal(videoEl.dispatchEvent.callCount, 0);
  });

  await t.test('detail payload contains all DashEvent fields', () => {
    const videoEl = createFakeVideoEl();
    const track   = createFakeTrack();
    const emitter = new DashEventEmitter(videoEl, track);
    const msg     = new Uint8Array([1, 2, 3]);

    emitter.emitReceive(makeDashEvent({
      schemeIdUri:     'urn:full',
      value:           'fullval',
      id:              99,
      presentationTime: 42,
      duration:        5,
      messageData:     msg,
      payload:         'text',
      source:          'event-stream',
    }));

    const detail = videoEl.dispatchEvent.firstCall.args[0].detail;
    assert.equal(detail.schemeIdUri, 'urn:full');
    assert.equal(detail.value, 'fullval');
    assert.equal(detail.id, 99);
    assert.equal(detail.presentationTime, 42);
    assert.equal(detail.duration, 5);
    assert.equal(detail.messageData, msg);
    assert.equal(detail.payload, 'text');
    assert.equal(detail.source, 'event-stream');
  });
});
