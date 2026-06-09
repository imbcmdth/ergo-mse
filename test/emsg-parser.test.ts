import './test-helpers';
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEmsgBoxes } from '../src/mp4/emsg-parser';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Write a big-endian uint32 at offset. */
function writeU32(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value, false);
}

/** Write a big-endian uint64 (as two uint32s) at offset. */
function writeU64(view: DataView, offset: number, hi: number, lo: number): void {
  view.setUint32(offset,     hi, false);
  view.setUint32(offset + 4, lo, false);
}

/** Write a NUL-terminated ASCII string at offset; returns next offset. */
function writeStr(buf: Uint8Array, offset: number, str: string): number {
  for (let i = 0; i < str.length; i++) {
    buf[offset + i] = str.charCodeAt(i);
  }
  buf[offset + str.length] = 0; // NUL
  return offset + str.length + 1;
}

/**
 * Build a minimal emsg v1 box.
 *
 * Layout:
 *   size(4) + 'emsg'(4) + version/flags(4) + timescale(4) +
 *   presentation_time(8) + event_duration(4) + id(4) +
 *   scheme_id_uri(NUL) + value(NUL) + message_data
 */
function buildEmsgV1(opts: {
  schemeIdUri?:     string;
  value?:           string;
  timescale?:       number;
  presentationTime?: number; // full 32-bit lo (hi=0)
  eventDuration?:   number;
  id?:              number;
  messageData?:     Uint8Array;
}): ArrayBuffer {
  const scheme  = opts.schemeIdUri  ?? 'urn:test:scheme';
  const value   = opts.value        ?? '';
  const ts      = opts.timescale    ?? 90000;
  const pt      = opts.presentationTime ?? 0;
  const dur     = opts.eventDuration ?? 0;
  const id      = opts.id           ?? 0;
  const msg     = opts.messageData  ?? new Uint8Array(0);

  const fixedSize  = 4 + 4 + 4 + 4 + 8 + 4 + 4; // header + version/flags + fixed fields
  const strSize    = scheme.length + 1 + value.length + 1;
  const totalSize  = fixedSize + strSize + msg.length;

  const buf  = new ArrayBuffer(totalSize);
  const view = new DataView(buf);
  const u8   = new Uint8Array(buf);

  let p = 0;
  writeU32(view, p, totalSize); p += 4; // box size
  u8[p] = 0x65; u8[p+1] = 0x6D; u8[p+2] = 0x73; u8[p+3] = 0x67; p += 4; // 'emsg'
  u8[p] = 1; p += 4;            // version=1, flags=0
  writeU32(view, p, ts);    p += 4;  // timescale
  writeU64(view, p, 0, pt); p += 8;  // presentation_time (hi=0, lo=pt)
  writeU32(view, p, dur);   p += 4;  // event_duration
  writeU32(view, p, id);    p += 4;  // id
  p = writeStr(u8, p, scheme);
  p = writeStr(u8, p, value);
  u8.set(msg, p);

  return buf;
}

/**
 * Build an emsg v0 box (presentation_time_delta instead of absolute time).
 */
function buildEmsgV0(schemeIdUri = 'urn:test'): ArrayBuffer {
  const scheme  = schemeIdUri;
  const value   = '';
  const fixedSz = 4 + 4 + 4; // box-header + ver/flags
  // v0 fields: scheme_id_uri + value + timescale(4) + pt_delta(4) + dur(4) + id(4)
  const strSz   = scheme.length + 1 + value.length + 1;
  const total   = fixedSz + strSz + 4 + 4 + 4 + 4;

  const buf  = new ArrayBuffer(total);
  const view = new DataView(buf);
  const u8   = new Uint8Array(buf);

  let p = 0;
  writeU32(view, p, total); p += 4;
  u8[p] = 0x65; u8[p+1] = 0x6D; u8[p+2] = 0x73; u8[p+3] = 0x67; p += 4;
  u8[p] = 0; p += 4; // version=0
  p = writeStr(u8, p, scheme);
  p = writeStr(u8, p, value);
  writeU32(view, p, 90000); p += 4; // timescale
  writeU32(view, p, 0);     p += 4; // pt_delta
  writeU32(view, p, 0);     p += 4; // duration
  writeU32(view, p, 1);             // id
  return buf;
}

/** Concatenate multiple ArrayBuffers. */
function concat(...bufs: ArrayBuffer[]): ArrayBuffer {
  const total  = bufs.reduce((s, b) => s + b.byteLength, 0);
  const result = new Uint8Array(total);
  let   offset = 0;
  for (const b of bufs) {
    result.set(new Uint8Array(b), offset);
    offset += b.byteLength;
  }
  return result.buffer;
}

/** Build a minimal moof box (just size + fourcc). */
function buildMoof(): ArrayBuffer {
  const buf = new ArrayBuffer(8);
  const view = new DataView(buf);
  view.setUint32(0, 8, false);
  const u8 = new Uint8Array(buf);
  u8[0] = 0; u8[1] = 0; u8[2] = 0; u8[3] = 8;
  u8[4] = 0x6D; u8[5] = 0x6F; u8[6] = 0x6F; u8[7] = 0x66; // 'moof'
  return buf;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test('parseEmsgBoxes', async (t) => {
  await t.test('parses a single emsg v1 box', () => {
    const msgData = new Uint8Array([1, 2, 3]);
    const buf = buildEmsgV1({
      schemeIdUri:     'urn:example:scheme',
      value:           'myvalue',
      timescale:       90000,
      presentationTime: 180000, // 2 seconds at 90 kHz
      eventDuration:   90000,   // 1 second
      id:              42,
      messageData:     msgData,
    });

    const boxes = parseEmsgBoxes(buf);
    assert.equal(boxes.length, 1);

    const box = boxes[0];
    assert.equal(box.schemeIdUri, 'urn:example:scheme');
    assert.equal(box.value, 'myvalue');
    assert.equal(box.timescale, 90000);
    assert.equal(box.presentationTime, 180000);
    assert.equal(box.eventDuration, 90000);
    assert.equal(box.id, 42);
    assert.deepEqual(box.messageData, msgData);
  });

  await t.test('handles empty value and empty message data', () => {
    const buf = buildEmsgV1({ schemeIdUri: 'urn:x', value: '', messageData: new Uint8Array(0) });
    const boxes = parseEmsgBoxes(buf);
    assert.equal(boxes.length, 1);
    assert.equal(boxes[0].value, '');
    assert.equal(boxes[0].messageData.length, 0);
  });

  await t.test('parses multiple emsg boxes before moof', () => {
    const buf = concat(
      buildEmsgV1({ schemeIdUri: 'urn:a', id: 1 }),
      buildEmsgV1({ schemeIdUri: 'urn:b', id: 2 }),
      buildMoof(),
    );
    const boxes = parseEmsgBoxes(buf);
    assert.equal(boxes.length, 2);
    assert.equal(boxes[0].schemeIdUri, 'urn:a');
    assert.equal(boxes[1].schemeIdUri, 'urn:b');
  });

  await t.test('short-circuits on moof — ignores emsg after moof', () => {
    const buf = concat(
      buildEmsgV1({ schemeIdUri: 'urn:before', id: 1 }),
      buildMoof(),
      buildEmsgV1({ schemeIdUri: 'urn:after',  id: 2 }), // must be ignored
    );
    const boxes = parseEmsgBoxes(buf);
    assert.equal(boxes.length, 1);
    assert.equal(boxes[0].schemeIdUri, 'urn:before');
  });

  await t.test('returns empty array when no emsg boxes present', () => {
    const buf = buildMoof();
    assert.deepEqual(parseEmsgBoxes(buf), []);
  });

  await t.test('skips emsg v0 with a console.warn and continues', () => {
    const warnings: string[] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(String(args[0])); };

    try {
      const buf = concat(
        buildEmsgV0('urn:v0'),
        buildEmsgV1({ schemeIdUri: 'urn:v1', id: 99 }),
      );
      const boxes = parseEmsgBoxes(buf);
      // v0 skipped, v1 parsed
      assert.equal(boxes.length, 1);
      assert.equal(boxes[0].schemeIdUri, 'urn:v1');
      assert.ok(warnings.some(w => w.includes('emsg v0')), 'should warn about v0');
    } finally {
      console.warn = orig;
    }
  });

  await t.test('handles ArrayBufferView (Uint8Array) input', () => {
    const fullBuf = buildEmsgV1({ schemeIdUri: 'urn:view', id: 7 });
    // Embed in a larger buffer and use a view
    const wrapper = new ArrayBuffer(fullBuf.byteLength + 10);
    new Uint8Array(wrapper).set(new Uint8Array(fullBuf), 5);
    const view = new Uint8Array(wrapper, 5, fullBuf.byteLength);
    const boxes = parseEmsgBoxes(view);
    assert.equal(boxes.length, 1);
    assert.equal(boxes[0].schemeIdUri, 'urn:view');
  });

  await t.test('returns empty array for an empty buffer', () => {
    assert.deepEqual(parseEmsgBoxes(new ArrayBuffer(0)), []);
  });

  await t.test('handles 0xFFFF_FFFF event duration (unknown duration)', () => {
    const buf = buildEmsgV1({ eventDuration: 0xFFFF_FFFF });
    const boxes = parseEmsgBoxes(buf);
    assert.equal(boxes.length, 1);
    assert.equal(boxes[0].eventDuration, 0xFFFF_FFFF);
  });
});
