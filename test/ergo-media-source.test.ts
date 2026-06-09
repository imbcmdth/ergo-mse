import './test-helpers';
import test from 'node:test';
import assert from 'node:assert/strict';
import sinon from 'sinon';
import { ErgoMediaSource } from '../src/ergo-media-source';

// Helper to create a fake video element
function createFakeVideoElement(): any {
  return {
    src: '',
    removeAttribute: sinon.stub(),
    load: sinon.stub(),
    addTextTrack: sinon.stub(),
  };
}

test('ErgoMediaSource', async (t) => {
  await t.test('should recognize text/vtt as supported', () => {
    assert.equal(ErgoMediaSource.isTypeSupported('text/vtt'), true);
  });

  await t.test('should recognize application/ttml+xml as supported', () => {
    assert.equal(ErgoMediaSource.isTypeSupported('application/ttml+xml'), true);
  });

  await t.test('should recognize fMP4 text codecs as supported', () => {
    assert.equal(ErgoMediaSource.isTypeSupported('application/mp4; codecs="wvtt"'), true);
    assert.equal(ErgoMediaSource.isTypeSupported('application/mp4; codecs="stpp"'), true);
  });
});
