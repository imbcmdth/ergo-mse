/**
 * MPEG DASH emsg (Event Message) box parser — version 1 only.
 *
 * emsg v1 is the CMAF-supported format and uses an *absolute* presentation
 * time, making it self-contained without needing the surrounding moof/tfdt
 * context. Version 0 (which carries a presentation_time_delta relative to the
 * segment's earliest presentation time) is skipped with a one-time warning.
 *
 * Per the DASH spec (§5.10.3.3), emsg boxes appear BEFORE the moof box in a
 * segment. The scanner therefore short-circuits on the first moof it encounters,
 * keeping the per-append overhead proportional to the small number of leading
 * boxes rather than the full segment size.
 *
 * emsg v1 binary layout (after the 8-byte ISO BMFF box header):
 *   version(1=1) + flags(3)
 *   timescale(4, big-endian uint32)
 *   presentation_time(8, big-endian uint64) — absolute in timescale units
 *   event_duration(4, big-endian uint32)    — 0xFFFF_FFFF = unknown/open-ended
 *   id(4, big-endian uint32)
 *   scheme_id_uri(variable, UTF-8, NUL-terminated)
 *   value(variable, UTF-8, NUL-terminated)
 *   message_data[...] (remaining bytes)
 */

import type { EmsgBox } from '../dash-event';
import { iterBoxes, readUint32BE, readUint64BE } from './box-utils';

let warnedV0 = false;

/**
 * Scan the top-level boxes of `data` for emsg v1 boxes.
 * Stops scanning as soon as a `moof` box is encountered.
 * Returns an array (often empty) of parsed EmsgBox objects.
 */
export function parseEmsgBoxes(data: ArrayBuffer | ArrayBufferView): EmsgBox[] {
  const buf  = data instanceof ArrayBuffer ? data : data.buffer;
  const off  = data instanceof ArrayBuffer ? 0    : (data as ArrayBufferView).byteOffset;
  const len  = data instanceof ArrayBuffer ? data.byteLength : (data as ArrayBufferView).byteLength;
  const view = new DataView(buf, off, len);

  const result: EmsgBox[] = [];

  for (const box of iterBoxes(view, 0, len)) {
    if (box.fourcc === 'moof') break;      // short-circuit — no emsg after moof
    if (box.fourcc !== 'emsg') continue;

    const emsg = parseEmsgV1(view, box.dataStart, box.end);
    if (emsg) result.push(emsg);
  }

  return result;
}

// ── Internal ──────────────────────────────────────────────────────────────────

function parseEmsgV1(view: DataView, start: number, end: number): EmsgBox | null {
  // Need at least version(1)+flags(3)+timescale(4)+presentation_time(8)+
  // event_duration(4)+id(4) = 20 bytes of fixed fields.
  if (start + 20 > end) return null;

  const version = view.getUint8(start);
  if (version !== 1) {
    if (!warnedV0) {
      // eslint-disable-next-line no-console
      console.warn('[ergo-mse] emsg v0 is not supported (only v1 / CMAF). The box will be skipped.');
      warnedV0 = true;
    }
    return null;
  }

  // flags(3) — unused, skip
  let p = start + 4;

  const timescale        = readUint32BE(view, p); p += 4;
  const presentationTime = readUint64BE(view, p); p += 8;
  const eventDuration    = readUint32BE(view, p); p += 4;
  const id               = readUint32BE(view, p); p += 4;

  // scheme_id_uri — NUL-terminated UTF-8
  const schemeResult = readNullTerminatedUtf8(view, p, end);
  if (!schemeResult) return null;
  const schemeIdUri = schemeResult.str;
  p = schemeResult.next;

  // value — NUL-terminated UTF-8
  const valueResult = readNullTerminatedUtf8(view, p, end);
  if (!valueResult) return null;
  const value = valueResult.str;
  p = valueResult.next;

  // message_data — remaining bytes (copy, not a view)
  const msgLen     = end - p;
  const messageData = new Uint8Array(msgLen);
  for (let i = 0; i < msgLen; i++) {
    messageData[i] = view.getUint8(p + i);
  }

  return { schemeIdUri, value, timescale, presentationTime, eventDuration, id, messageData };
}

function readNullTerminatedUtf8(
  view:  DataView,
  start: number,
  end:   number
): { str: string; next: number } | null {
  let i = start;
  while (i < end && view.getUint8(i) !== 0) i++;
  if (i >= end) return null; // no NUL terminator found — malformed

  const bytes = new Uint8Array(i - start);
  for (let j = 0; j < bytes.length; j++) {
    bytes[j] = view.getUint8(start + j);
  }
  const str = new TextDecoder().decode(bytes);
  return { str, next: i + 1 }; // +1 to skip the NUL
}
