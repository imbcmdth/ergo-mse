import './test-helpers';
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyTextCodec, classifyTextMimeAndCodecs } from '../src/text-codec';

test('classifyTextCodec', async (t) => {
  await t.test('should classify wvtt', () => {
    assert.deepEqual(classifyTextCodec('wvtt'), { kind: 'wvtt' });
    assert.deepEqual(classifyTextCodec('WVTT'), { kind: 'wvtt' });
    assert.deepEqual(classifyTextCodec('  wvtt  '), { kind: 'wvtt' });
  });

  await t.test('should classify stpp variants as stpp-text', () => {
    assert.deepEqual(classifyTextCodec('stpp'), { kind: 'stpp-text' });
    assert.deepEqual(classifyTextCodec('stpp.ttml.im1t'), { kind: 'stpp-text' });
    assert.deepEqual(classifyTextCodec('stpp.ttml.im2t'), { kind: 'stpp-text' });
    assert.deepEqual(classifyTextCodec('stpp.ttml.etd1'), { kind: 'stpp-text' });
  });

  await t.test('should classify stpp image variants as stpp-image', () => {
    assert.deepEqual(classifyTextCodec('stpp.ttml.im1i'), { kind: 'stpp-image' });
    assert.deepEqual(classifyTextCodec('stpp.ttml.im2i'), { kind: 'stpp-image' });
  });

  await t.test('should be case-insensitive', () => {
    assert.deepEqual(classifyTextCodec('STPP.TTML.IM1I'), { kind: 'stpp-image' });
    assert.deepEqual(classifyTextCodec('StPp'), { kind: 'stpp-text' });
  });

  await t.test('should return unknown for unrecognized codecs', () => {
    assert.deepEqual(classifyTextCodec('unknown'), { kind: 'unknown' });
    assert.deepEqual(classifyTextCodec('avc1'), { kind: 'unknown' });
    assert.deepEqual(classifyTextCodec(''), { kind: 'unknown' });
  });
});

test('classifyTextMimeAndCodecs', async (t) => {
  await t.test('should recognize text/vtt sidecar', () => {
    assert.deepEqual(classifyTextMimeAndCodecs('text/vtt'), { kind: 'vtt-sidecar' });
    assert.deepEqual(classifyTextMimeAndCodecs('TEXT/VTT'), { kind: 'vtt-sidecar' });
    assert.deepEqual(classifyTextMimeAndCodecs('text/vtt; charset=utf-8'), { kind: 'vtt-sidecar' });
    assert.deepEqual(classifyTextMimeAndCodecs('text/vtt charset=utf-8'), { kind: 'vtt-sidecar' });
  });

  await t.test('should recognize application/ttml+xml sidecar', () => {
    assert.deepEqual(classifyTextMimeAndCodecs('application/ttml+xml'), { kind: 'ttml-sidecar' });
    assert.deepEqual(classifyTextMimeAndCodecs('APPLICATION/TTML+XML'), { kind: 'ttml-sidecar' });
    assert.deepEqual(classifyTextMimeAndCodecs('application/ttml+xml; charset=utf-8'), { kind: 'ttml-sidecar' });
  });

  await t.test('should extract and classify fMP4 codecs', () => {
    assert.deepEqual(
      classifyTextMimeAndCodecs('application/mp4; codecs="wvtt"'),
      { kind: 'wvtt' }
    );
    assert.deepEqual(
      classifyTextMimeAndCodecs('application/mp4; codecs="stpp"'),
      { kind: 'stpp-text' }
    );
    assert.deepEqual(
      classifyTextMimeAndCodecs('video/mp4; codecs="stpp.ttml.im1i"'),
      { kind: 'stpp-image' }
    );
  });

  await t.test('should handle multiple codecs (use first)', () => {
    assert.deepEqual(
      classifyTextMimeAndCodecs('application/mp4; codecs="wvtt,avc1"'),
      { kind: 'wvtt' }
    );
  });

  await t.test('should handle codecs with spaces and quotes variations', () => {
    assert.deepEqual(
      classifyTextMimeAndCodecs('application/mp4; codecs="stpp"'),
      { kind: 'stpp-text' }
    );
    assert.deepEqual(
      classifyTextMimeAndCodecs("application/mp4; codecs='stpp'"),
      { kind: 'unknown' } // single quotes not supported
    );
  });

  await t.test('should treat bare codec string as codec', () => {
    assert.deepEqual(classifyTextMimeAndCodecs('wvtt'), { kind: 'wvtt' });
    assert.deepEqual(classifyTextMimeAndCodecs('stpp'), { kind: 'stpp-text' });
  });

  await t.test('should handle whitespace', () => {
    assert.deepEqual(
      classifyTextMimeAndCodecs('  text/vtt  '),
      { kind: 'vtt-sidecar' }
    );
  });

  await t.test('should return unknown for unrecognized types', () => {
    assert.deepEqual(classifyTextMimeAndCodecs('audio/mp4'), { kind: 'unknown' });
    assert.deepEqual(classifyTextMimeAndCodecs('video/mp4'), { kind: 'unknown' });
  });
});
