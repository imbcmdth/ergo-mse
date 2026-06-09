/**
 * DASH EventStream XML parser.
 *
 * The player treats EventStreams like Representations and Events like Segments:
 *   - append(<EventStream …>…</EventStream>) — updates the buffer's context
 *     (schemeIdUri, value, timescale, presentationTimeOffset) and processes any
 *     child <Event> elements inline. Analogous to an fMP4 init segment.
 *   - append(<Event …/>) or append(<Event …>payload</Event>) — processed using
 *     the most recently set context. Analogous to a media segment.
 *
 * Both shapes may be repeated. The EventStream wrapper may be re-sent whenever
 * the player switches rendition / period; re-processing it is safe because the
 * EventSink deduplicates by unique key.
 *
 * Timing formula
 * ──────────────
 *   periodRelativeSec = (Event@presentationTime − presentationTimeOffset) / timescale
 *   wallClock         = periodRelativeSec + wallTimestampOffset
 *
 * DashEvent.presentationTime is wall-clock epoch seconds, matching the emsg
 * path.  EventSink.#add subtracts wallAnchor to convert to player time for the
 * VTTCue, so effectiveOffset must be wallTimestampOffset (not
 * wallTimestampOffset − wallAnchor).
 *
 * Payload resolution priority (for an <Event> element)
 * ──────────────────────────────────────────────────────
 *   1. @messageData attribute (base64-encoded binary) → DashEvent.messageData
 *   2. Element text content (trimmed) → DashEvent.payload
 *   3. Neither present → both fields undefined
 */

import type { DashEvent, EventStreamContext } from './dash-event';

// ── Public API ────────────────────────────────────────────────────────────────

export interface ParseEventStreamResult {
  /** Updated context (may be the same object as input if no <EventStream> root). */
  context: EventStreamContext;
  events:  DashEvent[];
}

/**
 * Parse a UTF-8 XML buffer containing either an <EventStream> wrapper or a
 * bare <Event> element (or several wrapped in an arbitrary container).
 *
 * @param data          Raw bytes or view — must be valid UTF-8 XML.
 * @param context       Current EventStream context (schemeIdUri, timescale, …).
 * @param effectiveOffset  wallTimestampOffset, in seconds (wall-clock epoch of
 *                      the Period/segment origin).  Applied to convert
 *                      Period-relative time to wall-clock epoch time.
 */
export function parseEventStreamXml(
  data:            ArrayBuffer | ArrayBufferView,
  context:         EventStreamContext,
  effectiveOffset: number
): ParseEventStreamResult {
  const bytes  = data instanceof ArrayBuffer
    ? new Uint8Array(data)
    : new Uint8Array((data as ArrayBufferView).buffer,
                     (data as ArrayBufferView).byteOffset,
                     (data as ArrayBufferView).byteLength);

  const xml = new TextDecoder().decode(bytes);

  // DOMParser is available in browsers and can be mocked in tests.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const parser = new (globalThis as any).DOMParser() as DOMParser;
  const doc    = parser.parseFromString(xml, 'application/xml');

  // Check for parse errors (all browsers inject a <parsererror> element).
  if (doc.querySelector('parsererror')) {
    // eslint-disable-next-line no-console
    console.warn('[ergo-mse] EventSourceBuffer: XML parse error — append ignored.\n', xml.slice(0, 200));
    return { context, events: [] };
  }

  const root = doc.documentElement;
  let   ctx  = context;

  // ── Case 1: <EventStream> wrapper ─────────────────────────────────────────
  if (root.localName === 'EventStream') {
    ctx = extractContext(root, context);
    const events = Array.from(root.children)
      .filter(el => el.localName === 'Event')
      .map(el  => parseEventElement(el, ctx, effectiveOffset))
      .filter((e): e is DashEvent => e !== null);
    return { context: ctx, events };
  }

  // ── Case 2: bare <Event> or a container of <Event> elements ──────────────
  const eventEls = root.localName === 'Event'
    ? [root]
    : Array.from(root.querySelectorAll('Event'));

  const events = eventEls
    .map(el  => parseEventElement(el, ctx, effectiveOffset))
    .filter((e): e is DashEvent => e !== null);

  return { context: ctx, events };
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function extractContext(el: Element, existing: EventStreamContext): EventStreamContext {
  return {
    schemeIdUri:            el.getAttribute('schemeIdUri')            ?? existing.schemeIdUri,
    value:                  el.getAttribute('value')                  ?? existing.value,
    timescale:              numAttr(el, 'timescale',              existing.timescale),
    presentationTimeOffset: numAttr(el, 'presentationTimeOffset', existing.presentationTimeOffset),
  };
}

function parseEventElement(
  el:              Element,
  ctx:             EventStreamContext,
  effectiveOffset: number
): DashEvent | null {
  const ts    = ctx.timescale || 1;
  const ptRaw = numAttr(el, 'presentationTime', 0);
  const durRaw= numAttr(el, 'duration',         0);
  const id    = el.hasAttribute('id') ? Math.trunc(Number(el.getAttribute('id'))) : undefined;
  const value = el.getAttribute('value') ?? (ctx.value || undefined);

  const periodRelSec   = (ptRaw - ctx.presentationTimeOffset) / ts;
  const presentationTime = periodRelSec + effectiveOffset;
  const duration         = durRaw / ts;

  // Payload: @messageData (base64) takes priority; else trimmed inner content.
  let messageData: Uint8Array | undefined;
  let payload:     string    | undefined;

  const b64 = el.getAttribute('messageData');
  if (b64 !== null) {
    try {
      messageData = base64ToBytes(b64);
    } catch {
      // eslint-disable-next-line no-console
      console.warn('[ergo-mse] EventSourceBuffer: invalid base64 in @messageData — ignored.');
    }
  } else {
    const text = el.textContent?.trim();
    if (text) payload = text;
  }

  const schemeIdUri = ctx.schemeIdUri;
  const uniqueKey   = `${schemeIdUri}|${value ?? ''}|${id ?? ''}|${presentationTime}`;

  return {
    schemeIdUri,
    value,
    id,
    presentationTime,
    duration,
    messageData,
    payload,
    source:    'event-stream',
    uniqueKey,
  };
}

function numAttr(el: Element, name: string, fallback: number): number {
  const raw = el.getAttribute(name);
  if (raw === null) return fallback;
  const n = Number(raw);
  return isFinite(n) ? n : fallback;
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes  = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
