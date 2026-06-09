import './test-helpers';
import { MockMediaSource, lastMediaSource } from './test-helpers';
import test from 'node:test';
import assert from 'node:assert/strict';
import sinon from 'sinon';
import { ErgoMediaSource } from '../src/ergo-media-source';
import { ManagedSourceBuffer } from '../src/managed-source-buffer';
import { TextSourceBuffer } from '../src/text-source-buffer';

function createFakeTextTrack(): any {
  return {
    mode: 'hidden',
    cues: [],
    activeCues: [],
    addCue: sinon.stub(),
    removeCue: sinon.stub(),
    addEventListener: sinon.stub(),
    removeEventListener: sinon.stub(),
  };
}

function createFakeVideoElement(): any {
  return {
    src: '',
    removeAttribute: sinon.stub(),
    load: sinon.stub(),
    dispatchEvent: sinon.stub(),
    addTextTrack: sinon.stub().callsFake(() => createFakeTextTrack()),
  };
}

test('ErgoMediaSource', async (t) => {
  // ── Static isTypeSupported ────────────────────────────────────────────────────

  await t.test('should recognise text/vtt without delegating to MediaSource', () => {
    assert.equal(ErgoMediaSource.isTypeSupported('text/vtt'), true);
  });

  await t.test('should recognise application/ttml+xml without delegating to MediaSource', () => {
    assert.equal(ErgoMediaSource.isTypeSupported('application/ttml+xml'), true);
  });

  await t.test('should recognise fMP4 text codecs without delegating to MediaSource', () => {
    assert.equal(ErgoMediaSource.isTypeSupported('application/mp4; codecs="wvtt"'), true);
    assert.equal(ErgoMediaSource.isTypeSupported('application/mp4; codecs="stpp"'), true);
  });

  await t.test('should delegate audio/video types to MediaSource.isTypeSupported', () => {
    MockMediaSource.isTypeSupported.returns(true);
    try {
      const result = ErgoMediaSource.isTypeSupported('video/mp4; codecs="avc1"');
      assert.equal(result, true);
      assert.equal(MockMediaSource.isTypeSupported.called, true);
      assert.equal(MockMediaSource.isTypeSupported.firstCall.args[0], 'video/mp4; codecs="avc1"');
    } finally {
      MockMediaSource.isTypeSupported.reset();
      MockMediaSource.isTypeSupported.returns(false);
    }
  });

  // ── Constructor / readyState ──────────────────────────────────────────────────

  await t.test('should initialise with wallAnchor = 0', () => {
    const mse = new ErgoMediaSource();
    assert.equal(mse.wallAnchor, 0);
  });

  await t.test('should expose readyState from the underlying MediaSource', () => {
    const mse = new ErgoMediaSource();
    assert.equal(mse.readyState, 'closed');
  });

  // ── attach() ─────────────────────────────────────────────────────────────────

  await t.test('should create an object URL and set it on the video element', async () => {
    const videoEl = createFakeVideoElement();
    const mse     = new ErgoMediaSource();
    const stub    = sinon.stub(URL, 'createObjectURL').returns('blob:test');
    try {
      await mse.attach(videoEl);
      assert.equal(stub.called, true);
      // The URL should have been created from the inner MediaSource instance
      assert.equal(stub.firstCall.args[0], lastMediaSource);
      assert.equal(videoEl.src, 'blob:test');
    } finally {
      stub.restore();
      mse.detach();
    }
  });

  await t.test('should reject with AbortError when signal is aborted', async () => {
    const videoEl    = createFakeVideoElement();
    const mse        = new ErgoMediaSource();
    const controller = new AbortController();
    const stub       = sinon.stub(URL, 'createObjectURL').returns('blob:test');
    try {
      const p = mse.attach(videoEl, controller.signal);
      // Abort synchronously — fires before the sourceopen microtask
      controller.abort();
      await assert.rejects(p, { name: 'AbortError' });
    } finally {
      stub.restore();
    }
  });

  await t.test('should reject with an error when the MediaSource fires an error event', async () => {
    const videoEl = createFakeVideoElement();
    const mse     = new ErgoMediaSource();
    const stub    = sinon.stub(URL, 'createObjectURL').returns('blob:test');
    try {
      const p = mse.attach(videoEl);
      // Fire error synchronously — fires before the sourceopen microtask
      lastMediaSource!._fireError();
      await assert.rejects(p, /error on attach/);
    } finally {
      stub.restore();
    }
  });

  // ── detach() ─────────────────────────────────────────────────────────────────

  await t.test('should revoke the object URL, remove src, and call load() on detach', async () => {
    const videoEl     = createFakeVideoElement();
    const mse         = new ErgoMediaSource();
    const createStub  = sinon.stub(URL, 'createObjectURL').returns('blob:test');
    const revokeStub  = sinon.stub(URL, 'revokeObjectURL');
    try {
      await mse.attach(videoEl);
      mse.detach();
      assert.equal(revokeStub.called, true);
      assert.equal(revokeStub.firstCall.args[0], 'blob:test');
      assert.equal(videoEl.removeAttribute.firstCall.args[0], 'src');
      assert.equal(videoEl.load.called, true);
    } finally {
      createStub.restore();
      revokeStub.restore();
    }
  });

  await t.test('should not throw when detach is called twice', async () => {
    const videoEl    = createFakeVideoElement();
    const mse        = new ErgoMediaSource();
    const createStub = sinon.stub(URL, 'createObjectURL').returns('blob:test');
    const revokeStub = sinon.stub(URL, 'revokeObjectURL');
    try {
      await mse.attach(videoEl);
      mse.detach();
      assert.doesNotThrow(() => mse.detach());
    } finally {
      createStub.restore();
      revokeStub.restore();
    }
  });

  // ── duration ─────────────────────────────────────────────────────────────────

  await t.test('should get and set duration on the underlying MediaSource', () => {
    const mse = new ErgoMediaSource();
    mse.duration = 120;
    assert.equal(mse.duration, 120);
    assert.equal(lastMediaSource!.duration, 120);
  });

  // ── endOfStream() ─────────────────────────────────────────────────────────────

  await t.test('should call endOfStream on the underlying MediaSource', () => {
    const mse = new ErgoMediaSource();
    mse.endOfStream();
    assert.equal(lastMediaSource!.endOfStream.called, true);
    assert.equal(lastMediaSource!.endOfStream.firstCall.args[0], undefined);
  });

  await t.test('should forward the error argument to endOfStream', () => {
    const mse = new ErgoMediaSource();
    mse.endOfStream('network');
    assert.equal(lastMediaSource!.endOfStream.firstCall.args[0], 'network');
  });

  // ── setLiveSeekableRange() ────────────────────────────────────────────────────

  await t.test('should subtract wallAnchor before calling setLiveSeekableRange', async () => {
    const videoEl = createFakeVideoElement();
    const mse     = new ErgoMediaSource();
    mse.wallAnchor = 100;
    const stub = sinon.stub(URL, 'createObjectURL').returns('blob:test');
    try {
      await mse.attach(videoEl);
      mse.setLiveSeekableRange(150, 200);
      assert.equal(lastMediaSource!.setLiveSeekableRange.called, true);
      assert.equal(lastMediaSource!.setLiveSeekableRange.firstCall.args[0], 50);   // 150 - 100
      assert.equal(lastMediaSource!.setLiveSeekableRange.firstCall.args[1], 100);  // 200 - 100
    } finally {
      stub.restore();
      mse.detach();
    }
  });

  // ── addSourceBuffer() ─────────────────────────────────────────────────────────

  await t.test('should throw if addSourceBuffer is called before attach', () => {
    const mse = new ErgoMediaSource();
    assert.throws(() => mse.addSourceBuffer('text/vtt'), /attach/);
  });

  await t.test('should return a ManagedSourceBuffer for audio/video types', async () => {
    const videoEl = createFakeVideoElement();
    const mse     = new ErgoMediaSource();
    const stub    = sinon.stub(URL, 'createObjectURL').returns('blob:test');
    try {
      await mse.attach(videoEl);
      const sb = mse.addSourceBuffer('video/mp4; codecs="avc1"');
      assert.ok(sb instanceof ManagedSourceBuffer);
      assert.equal(lastMediaSource!.addSourceBuffer.called, true);
      assert.equal(lastMediaSource!.addSourceBuffer.firstCall.args[0], 'video/mp4; codecs="avc1"');
    } finally {
      stub.restore();
      mse.detach();
    }
  });

  await t.test('should return a TextSourceBuffer for text/vtt', async () => {
    const videoEl = createFakeVideoElement();
    const mse     = new ErgoMediaSource();
    const stub    = sinon.stub(URL, 'createObjectURL').returns('blob:test');
    try {
      await mse.attach(videoEl);
      const sb = mse.addSourceBuffer('text/vtt', { label: 'English', lang: 'en' });
      assert.ok(sb instanceof TextSourceBuffer);
      assert.equal(videoEl.addTextTrack.firstCall.args[0], 'subtitles');
      assert.equal(videoEl.addTextTrack.firstCall.args[1], 'English');
      assert.equal(videoEl.addTextTrack.firstCall.args[2], 'en');
    } finally {
      stub.restore();
      mse.detach();
    }
  });

  await t.test('should use lang as label when no explicit label is provided', async () => {
    const videoEl = createFakeVideoElement();
    const mse     = new ErgoMediaSource();
    const stub    = sinon.stub(URL, 'createObjectURL').returns('blob:test');
    try {
      await mse.attach(videoEl);
      mse.addSourceBuffer('text/vtt', { lang: 'fr' });
      assert.equal(videoEl.addTextTrack.firstCall.args[1], 'fr');
      assert.equal(videoEl.addTextTrack.firstCall.args[2], 'fr');
    } finally {
      stub.restore();
      mse.detach();
    }
  });

  await t.test('should fall back to "subtitles" when neither label nor lang is provided', async () => {
    const videoEl = createFakeVideoElement();
    const mse     = new ErgoMediaSource();
    const stub    = sinon.stub(URL, 'createObjectURL').returns('blob:test');
    try {
      await mse.attach(videoEl);
      mse.addSourceBuffer('text/vtt');
      assert.equal(videoEl.addTextTrack.firstCall.args[1], 'subtitles');
    } finally {
      stub.restore();
      mse.detach();
    }
  });
});
