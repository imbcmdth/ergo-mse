# MPEG DASH Events Support Implementation Plan

## Overview

This plan outlines the implementation of MPEG DASH events support in ergo-mse, enabling seamless handling of timed events from DASH sources through two delivery mechanisms:

1. **Event Source Buffer**: A new source buffer type (`application/dash+xml; codec="event-stream"`) for handling DASH event streams
2. **Automatic emsg Box Detection**: Inspect existing video/audio source buffers for emsg boxes and automatically extract events

Both mechanisms will feed events into a unified internal text track as VTT cues, and emit DOM events on the video element when cues become active.

## Current Architecture Analysis

### Existing Components
- `ErgoMediaSource`: Main entry point, factory for source buffers
- `ManagedSourceBuffer`: Promise-based wrapper for real MSE SourceBuffer  
- `TextSourceBuffer`: Fake source buffer backed by TextTrack for subtitle handling
- `ISourceBuffer`: Common interface implemented by both buffer types
- `Fmp4TextDemuxer`: MP4 box parsing infrastructure (timescale, samples, etc.)
- `box-utils.ts`: Low-level MP4 box reading utilities (findBox, iterBoxes, etc.)

### Text Track Infrastructure
- Text tracks created with `videoEl.addTextTrack('subtitles', label, lang)`
- VTTCue objects added to tracks with timing information
- Wall-clock time mapping via `wallAnchor` property
- Replace-on-append semantics with cue deduplication

## Implementation Plan

### Phase 1: Event Source Buffer Infrastructure

#### 1.1 Create EventSourceBuffer Class
**File**: `src/event-source-buffer.ts`

```typescript
export class EventSourceBuffer implements ISourceBuffer {
  readonly eventTrack: TextTrack;
  wallAnchor = 0;
  
  // Bounded dedup (shared helper) — keeps only the most recent ~20 keys.
  #dedup = new BoundedEventDedup(20);

  // EventStream-level context (set when an <EventStream> wrapper is appended;
  // analogous to a Representation's init segment).
  #context: EventStreamContext = { schemeIdUri: '', value: '', timescale: 1, presentationTimeOffset: 0 };

  constructor(
    videoEl: HTMLVideoElement,
    sink: EventSink    // SHARED sink owned by ErgoMediaSource (holds track + emitter + dedup)
  ) {
    this.eventTrack = sink.track;
  }

  // Implement ISourceBuffer interface
  async append(data: ArrayBuffer | ArrayBufferView): Promise<void>;
  async remove(start: number, end: number): Promise<void>;
  // ... other ISourceBuffer methods (queued, same pattern as TextSourceBuffer)

  // Event-specific methods
  #parseAppend(data: ArrayBuffer | ArrayBufferView): DashEvent[]; // XML parse (see Phase 4)
  #addEventAsCue(event: DashEvent): void;                          // dedup + cue + 'event:receive'
}
```

**Key design points:**

- **EventStreams behave like Representations, Events like Segments.** The player
  periodically calls `append()` with serialized DASH XML. Two shapes are accepted:
  1. An `<EventStream …>` wrapper element — its attributes (`@schemeIdUri`,
     `@value`, `@timescale`, `@presentationTimeOffset`) set the buffer's
     **context** (like an init segment), and any child `<Event>` elements it
     contains are processed immediately.
  2. A bare `<Event …>` element (or a fragment of several) — processed using the
     most recently set context.
- **Shared track + emitter.** Unlike `TextSourceBuffer` (which owns its track),
  `EventSourceBuffer` is handed the single shared event `TextTrack` and the
  shared emitter by `ErgoMediaSource`, so emsg-derived and event-stream-derived
  events land in the same place and dedup against each other.
- **`metadata` track, `hidden` mode** — never user-visible, never rendered.

#### 1.2 Define Event Data Structures
**File**: `src/dash-event.ts`

```typescript
export interface DashEvent {
  // DASH Event properties from spec
  schemeIdUri: string;      // Event scheme identifier
  value?: string;           // Optional scheme-specific value
  id?: number;              // Optional event ID for deduplication
  presentationTime: number; // Resolved event start (wall-clock epoch seconds)
  duration?: number;        // Event duration (seconds, optional / 0 => instantaneous)
  // Payload: for emsg => message_data bytes; for event-stream => messageData
  // attribute, else @value, else Event element text/inner content (string).
  messageData?: Uint8Array;
  payload?: string;
  source: 'emsg' | 'event-stream'; // where the event came from

  // Internal property
  uniqueKey: string;        // dedup key: `${schemeIdUri}|${value}|${id}|${presentationTime}`
}

// emsg v1 ONLY (CMAF-supported format — ISO 14496-12 §8.x).
// Layout after the 4-byte version(=1)/flags header:
//   timescale(4) | presentation_time(8, absolute, in timescale units) |
//   event_duration(4) | id(4) | scheme_id_uri(utf8, null-terminated) |
//   value(utf8, null-terminated) | message_data[...]
export interface EmsgBox {
  schemeIdUri: string;
  value: string;
  timescale: number;
  presentationTime: number; // absolute, in timescale units (v1)
  eventDuration: number;    // in timescale units
  id: number;
  messageData: Uint8Array;
}

// EventStream-level context (the "Representation"-equivalent for events).
export interface EventStreamContext {
  schemeIdUri: string;
  value: string;
  timescale: number;            // default 1
  presentationTimeOffset: number; // default 0, in timescale units
}

// Bounded dedup: remembers only the most recent N keys (insertion-ordered Map,
// evicting the oldest entry once size exceeds N). N defaults to 20.
export class BoundedEventDedup {
  constructor(maxEntries: number = 20);
  /** Returns true if key was already seen (duplicate); otherwise records it. */
  seen(key: string): boolean;
}
```

#### 1.3 Update Text Codec Classification
**File**: `src/text-codec.ts`

```typescript
export type TextCodecClass =
  | { kind: 'wvtt' }
  | { kind: 'stpp-text' }
  | { kind: 'stpp-image' }
  | { kind: 'vtt-sidecar' }
  | { kind: 'ttml-sidecar' }
  | { kind: 'event-stream' }    // NEW: Event stream support
  | { kind: 'unknown' };

export function classifyTextMimeAndCodecs(mimeAndCodecs: string): TextCodecClass {
  const lc = mimeAndCodecs.trim().toLowerCase();
  
  // NEW: Check for event stream MIME type
  if (lc === 'application/dash+xml' || lc.startsWith('application/dash+xml;')) {
    const codecsMatch = mimeAndCodecs.match(/codecs\s*=\s*"([^"]+)"/i);
    if (codecsMatch && codecsMatch[1].trim().toLowerCase() === 'event-stream') {
      return { kind: 'event-stream' };
    }
  }
  
  // ... existing classification logic
}
```

#### 1.4 Update ErgoMediaSource Factory
**File**: `src/ergo-media-source.ts`

```typescript
addSourceBuffer(mimeAndCodecs: string, options: AddSourceBufferOptions = {}): ISourceBuffer {
  if (!this.#videoEl) {
    throw new Error('ErgoMediaSource: call attach() before addSourceBuffer()');
  }

  const cls = classifyTextMimeAndCodecs(mimeAndCodecs);
  if (cls.kind === 'event-stream') {
    const label = options.label ?? 'Events';
    const lang = options.lang ?? '';
    this.#ensureEventInfrastructure(); // creates shared track + emitter (idempotent)
    return new EventSourceBuffer(this.#videoEl, this.#eventTrack!, this.#emitter!);
  }
  
  if (cls.kind !== 'unknown') {
    // Existing text track logic
    const label = options.label ?? options.lang ?? 'subtitles';
    const lang = options.lang ?? '';
    return new TextSourceBuffer(this.#videoEl, label, lang, mimeAndCodecs);
  }

  // Existing MSE source buffer logic
  const sb = this.#ms.addSourceBuffer(mimeAndCodecs);
  return new ManagedSourceBuffer(sb);
}
```

### Phase 2: MP4 emsg Box Parsing

#### 2.1 Create emsg Box Parser
**File**: `src/mp4/emsg-parser.ts`

**emsg v1 ONLY** (CMAF-supported). v0 boxes are skipped (with a one-time
`console.warn`). Per spec, `emsg` boxes precede `moof`; we **short-circuit the
scan on the first `moof`** so the per-append cost is bounded to the leading box
region.

```typescript
import { iterBoxes, readUint32BE, readUint64BE } from './box-utils';

export function parseEmsgBoxes(data: ArrayBuffer | ArrayBufferView): EmsgBox[] {
  const buf = data instanceof ArrayBuffer ? data : data.buffer;
  const off = data instanceof ArrayBuffer ? 0 : (data as ArrayBufferView).byteOffset;
  const len = data instanceof ArrayBuffer ? data.byteLength : (data as ArrayBufferView).byteLength;
  const view = new DataView(buf, off, len);

  const emsgBoxes: EmsgBox[] = [];

  for (const box of iterBoxes(view, 0, len)) {
    if (box.fourcc === 'moof') break;          // SHORT-CIRCUIT: emsg precedes moof
    if (box.fourcc !== 'emsg') continue;
    const emsg = parseEmsgV1(view, box.dataStart, box.end);
    if (emsg) emsgBoxes.push(emsg);
  }
  return emsgBoxes;
}

function readNullTerminatedUtf8(view: DataView, start: number, end: number): { str: string; next: number } {
  // read bytes until 0x00, decode UTF-8, return string + offset past the null
}

function parseEmsgV1(view: DataView, start: number, end: number): EmsgBox | null {
  if (start + 4 > end) return null;
  const version = view.getUint8(start);
  if (version !== 1) {
    warnOnceUnsupportedEmsgVersion(version);   // v0 unsupported — skip
    return null;
  }
  let p = start + 4;                            // skip version(1)+flags(3)

  const timescale        = readUint32BE(view, p); p += 4;
  const presentationTime = readUint64BE(view, p); p += 8; // absolute (timescale units)
  const eventDuration    = readUint32BE(view, p); p += 4;
  const id               = readUint32BE(view, p); p += 4;

  const scheme = readNullTerminatedUtf8(view, p, end); p = scheme.next;
  const value  = readNullTerminatedUtf8(view, p, end); p = value.next;

  const messageData = new Uint8Array(end - p);
  // copy [p, end) into messageData

  return { schemeIdUri: scheme.str, value: value.str, timescale,
           presentationTime, eventDuration, id, messageData };
}
```

#### 2.2 Enhanced ManagedSourceBuffer for emsg Detection
**File**: `src/managed-source-buffer.ts`

A single shared `EventSink` (owned by `ErgoMediaSource`) encapsulates the shared
event track, bounded dedup, cue creation, and `event:receive` emission — used by
both `ManagedSourceBuffer` (emsg) and `EventSourceBuffer` (event-stream) so they
dedup against each other.

```typescript
export class ManagedSourceBuffer implements ISourceBuffer {
  // ... existing properties

  // NEW: shared event sink (set by ErgoMediaSource for video/audio buffers)
  #eventSink?: EventSink;

  enableEventDetection(sink: EventSink): void {
    this.#eventSink = sink;
  }

  async append(data: ArrayBuffer | ArrayBufferView): Promise<void> {
    // NEW: scan leading boxes for emsg v1 BEFORE queuing the real append.
    if (this.#eventSink) {
      try {
        for (const emsg of parseEmsgBoxes(data)) {     // stops at first moof
          this.#eventSink.addEmsgEvent(emsg, this.wallAnchor);
        }
      } catch (e) {
        console.warn('[ergo-mse] emsg parse error (ignored):', e);
      }
    }

    return new Promise<void>((resolve, reject) => {
      this.#queue.push({ kind: 'append', data, resolve, reject });
      this.#processQueue();
    });
  }
}
```

```typescript
// src/event-sink.ts — shared by emsg + event-stream paths
export class EventSink {
  #track: TextTrack;
  #emitter: DashEventEmitter;
  #dedup = new BoundedEventDedup(20);   // last ~20 events only (point 6)

  constructor(track: TextTrack, emitter: DashEventEmitter) { /* ... */ }

  addEmsgEvent(emsg: EmsgBox, wallAnchor: number): void {
    // emsg v1 presentation_time is ABSOLUTE in timescale units.
    const startWall = emsg.presentationTime / emsg.timescale; // wall-clock epoch sec
    this.#add({
      schemeIdUri: emsg.schemeIdUri,
      value: emsg.value || undefined,
      id: emsg.id,
      presentationTime: startWall,
      duration: emsg.eventDuration / emsg.timescale,
      messageData: emsg.messageData,
      source: 'emsg',
      uniqueKey: `${emsg.schemeIdUri}|${emsg.value}|${emsg.id}|${emsg.presentationTime}`,
    }, wallAnchor);
  }

  addStreamEvent(event: DashEvent, wallAnchor: number): void { this.#add(event, wallAnchor); }

  #add(event: DashEvent, wallAnchor: number): void {
    if (this.#dedup.seen(event.uniqueKey)) return;   // duplicate => drop

    // Convert wall-clock → player-time for the cue (matches ISourceBuffer contract).
    const startPt = event.presentationTime - wallAnchor;
    const dur     = event.duration ?? 0;
    const endPt   = startPt + (dur > 0 ? dur : 0.001); // epsilon for instantaneous (point 5)

    const cue = new VTTCue(startPt, endPt, '');
    (cue as any).dashEvent = event;
    this.#track.addCue(cue);

    this.#emitter.emitReceive(event);                // 'event:receive' at append time (point 7)
  }
}
```

### Phase 3: Video Element Event Emission

#### 3.1 Create DashEventEmitter and event names
**File**: `src/event-emitter.ts`

Two events are emitted on the video element for every DASH event:

| Event name | Fires when | Detail shape |
|---|---|---|
| `event:receive` | The event is parsed and added to the track (at append time) | `DashEventDetail` |
| `event:activate` | The cue becomes active (`currentTime` enters the cue window) | `DashEventDetail` |

Consumers choose whichever lifecycle point they care about. Both carry the same
`DashEventDetail` payload.

```typescript
export interface DashEventDetail {
  schemeIdUri: string;
  value?: string;
  id?: number;
  presentationTime: number;  // wall-clock epoch seconds
  duration?: number;
  messageData?: Uint8Array;
  payload?: string;          // string payload (event-stream path)
  source: 'emsg' | 'event-stream';
}

export class DashEventEmitter {
  #videoEl: HTMLVideoElement;

  constructor(videoEl: HTMLVideoElement) { this.#videoEl = videoEl; }

  emitReceive(event: DashEvent): void {
    this.#videoEl.dispatchEvent(new CustomEvent('event:receive', { detail: toDetail(event) }));
  }

  emitActivate(event: DashEvent): void {
    this.#videoEl.dispatchEvent(new CustomEvent('event:activate', { detail: toDetail(event) }));
  }
}

function toDetail(event: DashEvent): DashEventDetail { /* map fields */ }
```

#### 3.2 Wire cuechange → `event:activate`

`DashEventEmitter` also owns the `cuechange` listener on the shared event track
(set up inside `#ensureEventInfrastructure`). When a new cue becomes active it
extracts the stored `dashEvent` and calls `emitActivate`.

```typescript
// Inside DashEventEmitter constructor (or a separate setup method):
track.addEventListener('cuechange', () => {
  const activeCues = track.activeCues;
  if (!activeCues) return;
  for (let i = 0; i < activeCues.length; i++) {
    const cue = activeCues[i] as VTTCue;
    if (!this.#seen.has(cue)) {
      this.#seen.add(cue);
      const ev = (cue as any).dashEvent as DashEvent | undefined;
      if (ev) this.emitActivate(ev);
    }
  }
  // prune #seen to only cues still in the track to avoid unbounded growth
});
```

#### 3.3 Integrate into ErgoMediaSource
**File**: `src/ergo-media-source.ts`

```typescript
export class ErgoMediaSource {
  // ... existing properties

  // NEW: event infrastructure (created lazily on first addSourceBuffer call)
  #eventTrack?: TextTrack;
  #eventSink?:  EventSink;          // shared by emsg + event-stream paths
  #emitter?:    DashEventEmitter;

  addSourceBuffer(mimeAndCodecs: string, options: AddSourceBufferOptions = {}): ISourceBuffer {
    if (!this.#videoEl) throw new Error('call attach() first');

    const cls = classifyTextMimeAndCodecs(mimeAndCodecs);

    if (cls.kind === 'event-stream') {
      this.#ensureEventInfrastructure();
      return new EventSourceBuffer(this.#videoEl, this.#eventSink!);
    }

    if (cls.kind !== 'unknown') {
      const label = options.label ?? options.lang ?? 'subtitles';
      const lang  = options.lang ?? '';
      return new TextSourceBuffer(this.#videoEl, label, lang, mimeAndCodecs);
    }

    // Real MSE buffer — also enable emsg detection
    this.#ensureEventInfrastructure();
    const sb  = this.#ms.addSourceBuffer(mimeAndCodecs);
    const msb = new ManagedSourceBuffer(sb);
    msb.enableEventDetection(this.#eventSink!);
    return msb;
  }

  #ensureEventInfrastructure(): void {
    if (this.#eventTrack) return;                    // idempotent
    this.#eventTrack  = this.#videoEl!.addTextTrack('metadata', 'DASH Events', '');
    this.#eventTrack.mode = 'hidden';
    this.#emitter     = new DashEventEmitter(this.#videoEl!, this.#eventTrack);
    this.#eventSink   = new EventSink(this.#eventTrack, this.#emitter);
  }

  detach(): void {
    // existing cleanup …
    this.#eventSink  = undefined;
    this.#emitter    = undefined;
    // #eventTrack: cannot be removed from the video element; left as-is.
    // On re-attach a NEW video element will get a NEW track.
    this.#eventTrack = undefined;
  }
}
```

### Phase 4: Event Stream XML Parser

**File**: `src/event-stream-parser.ts`

The player treats `EventStream` like a Representation and `Event` children like
Segments. `append()` on an `EventSourceBuffer` will receive **serialized XML**
(UTF-8 bytes) in one of two shapes:

1. **Full `<EventStream>` element** — sets the buffer's context (schemeIdUri,
   value, timescale, presentationTimeOffset) and processes all child `<Event>`
   elements inline.
2. **Single `<Event>` element** — processed against the previously-set context
   (just like a media segment against an already-parsed init segment).

The parser uses the browser's built-in `DOMParser` (available in all target
environments) — no external XML library required.

#### Attribute mapping

| XML attribute on `<EventStream>` | Maps to |
|---|---|
| `@schemeIdUri` | `DashEvent.schemeIdUri` |
| `@value` | `DashEvent.value` (context default; overridden per-`Event` if present) |
| `@timescale` | divisor for `Event@presentationTime` and `Event@duration`; default `1` |
| `@presentationTimeOffset` | subtracted from `Event@presentationTime` before dividing; default `0` |

| XML attribute on `<Event>` | Maps to |
|---|---|
| `@presentationTime` | `DashEvent.presentationTime` (in timescale units, absolute in Period time) |
| `@duration` | `DashEvent.duration` (timescale units); omitted → `0` (instantaneous) |
| `@id` | `DashEvent.id` |
| `@messageData` (base64) | decoded → `DashEvent.messageData`; if absent, inner XML content → `DashEvent.payload` |

#### Timing formula

```
// Period-relative seconds:
const periodRelativeSec = (Event@presentationTime - presentationTimeOffset) / timescale;
// Wall-clock:
const wallClock = periodRelativeSec + effectiveOffset;   // effectiveOffset = wallTimestampOffset − wallAnchor
```

`wallTimestampOffset` on `EventSourceBuffer` carries the period's
`@availabilityStartTime + periodStart` (same as other ISourceBuffer
implementations). `wallAnchor` is set by the player after construction.

#### Dedup key

```
`${schemeIdUri}|${value ?? ''}|${id ?? ''}|${presentationTime_wallclock}`
```

#### Code sketch

```typescript
export function parseEventStreamXml(
  bytes:     ArrayBuffer | ArrayBufferView,
  context:   EventStreamContext,       // may be updated by this call (EventStream case)
  wallOffset: number                   // effectiveOffset (wallTimestampOffset − wallAnchor)
): { updatedContext: EventStreamContext; events: ParsedEventStreamEvent[] } {

  const xml  = new TextDecoder().decode(bytes instanceof ArrayBuffer ? bytes : /* slice */);
  const doc  = new DOMParser().parseFromString(xml, 'application/xml');

  // Check parse errors
  if (doc.querySelector('parsererror')) { /* warn + return empty */ }

  const root = doc.documentElement;
  let ctx = { ...context };

  // ── Case 1: <EventStream> wrapper ─────────────────────────────────────────
  if (root.localName === 'EventStream') {
    ctx = {
      schemeIdUri:           root.getAttribute('schemeIdUri') ?? ctx.schemeIdUri,
      value:                 root.getAttribute('value')       ?? ctx.value,
      timescale:             Number(root.getAttribute('timescale') ?? ctx.timescale),
      presentationTimeOffset: Number(root.getAttribute('presentationTimeOffset') ?? ctx.presentationTimeOffset),
    };
  }

  // ── Collect <Event> elements (direct children or root itself) ─────────────
  const eventEls: Element[] = root.localName === 'Event'
    ? [root]
    : Array.from(root.querySelectorAll(':scope > Event'));

  const events = eventEls.map(el => parseEventElement(el, ctx, wallOffset));

  return { updatedContext: ctx, events };
}

function parseEventElement(
  el:        Element,
  ctx:       EventStreamContext,
  wallOffset: number
): ParsedEventStreamEvent {
  const ptRaw    = Number(el.getAttribute('presentationTime') ?? 0);
  const durRaw   = Number(el.getAttribute('duration') ?? 0);
  const id       = el.hasAttribute('id') ? Number(el.getAttribute('id')) : undefined;
  const value    = el.getAttribute('value') ?? ctx.value ?? undefined;

  const periodRelSec = (ptRaw - ctx.presentationTimeOffset) / (ctx.timescale || 1);
  const wallClock    = periodRelSec + wallOffset;
  const durationSec  = durRaw / (ctx.timescale || 1);

  // Payload: @messageData (base64) takes priority; else inner content.
  let messageData: Uint8Array | undefined;
  let payload:     string    | undefined;
  const b64 = el.getAttribute('messageData');
  if (b64) {
    messageData = base64ToUint8Array(b64);
  } else {
    payload = el.textContent?.trim() || undefined;
  }

  return {
    schemeIdUri: ctx.schemeIdUri,
    value,
    id,
    presentationTime: wallClock,
    duration: durationSec,
    messageData,
    payload,
    source:    'event-stream',
    uniqueKey: `${ctx.schemeIdUri}|${value ?? ''}|${id ?? ''}|${wallClock}`,
  };
}
```

### Phase 5: Integration and Testing Infrastructure

#### 5.1 Update Public Exports
**File**: `src/index.ts`

```typescript
// Existing exports unchanged …

export * from './event-source-buffer';   // NEW
export * from './event-sink';            // NEW
export * from './event-emitter';         // NEW (exports DashEventDetail)
export * from './dash-event';            // NEW

// TypeScript augmentation so consumers get typed event listeners:
declare global {
  interface HTMLVideoElementEventMap {
    'event:receive':  CustomEvent<DashEventDetail>;
    'event:activate': CustomEvent<DashEventDetail>;
  }
}
```

#### 5.2 Update README Documentation
**File**: `README.md`

New sections:
- DASH Events overview (two sources: emsg + event-stream)
- How to add an `EventSourceBuffer` and feed it `<EventStream>` / `<Event>` XML
- Automatic emsg v1 detection on video/audio buffers (always on)
- Listening to `event:receive` vs `event:activate`
- Deduplication behaviour and bounded cache
- Wall-clock timing examples (VOD and live)

#### 5.3 Tests
**File**: `test/emsg-parser.test.ts`
- v1 box parse (all field sizes)
- short-circuits on `moof`
- skips v0 with console.warn
- malformed boxes handled gracefully

**File**: `test/event-stream-parser.test.ts`
- `<EventStream>` wrapper updates context
- bare `<Event>` uses existing context
- `@messageData` (base64) vs inner-text payload
- timing formula: `(presentationTime - presentationTimeOffset) / timescale + wallOffset`
- malformed XML handled gracefully

**File**: `test/event-sink.test.ts`
- `BoundedEventDedup` evicts oldest after 20 entries
- duplicate key from different source (emsg + event-stream) is dropped
- instantaneous event gets 1 ms synthetic duration
- `event:receive` fired at `addEmsgEvent` / `addStreamEvent` call time

**File**: `test/event-emitter.test.ts`
- `event:activate` fires when cue enters `activeCues`
- no double-fire for the same cue
- `event:receive` NOT re-fired on activate

## Implementation Considerations

### Event Deduplication

- **Key**: `` `${schemeIdUri}|${value ?? ''}|${id ?? ''}|${presentationTime_wallclock}` ``
- **Scope**: shared `BoundedEventDedup` inside `EventSink` — deduplicates across
  both the emsg and event-stream paths, so a rendition switch that overlaps an
  already-seen event won't double-fire.
- **Bounded**: insertion-ordered Map capped at 20 entries; oldest evicted on
  overflow. Keeps memory stable over long live sessions without needing explicit
  `remove()` coupling.

### Performance

- emsg scanning on every video/audio `append()` short-circuits at the first
  `moof` box, so cost is proportional to the number of leading boxes (typically
  1–2), not segment size.
- `DOMParser` for event-stream XML runs synchronously but is isolated to
  `EventSourceBuffer` appends only (a separate, typically low-frequency path).

### Error Handling

- Malformed emsg boxes: log `console.warn`, skip the box, continue.
- XML parse errors: log `console.warn`, skip, continue. Never throw from `append()`.
- v0 emsg: one-time `console.warn('[ergo-mse] emsg v0 is not supported …')`, skip.

### Wall-Clock Time Mapping

`EventSourceBuffer` follows the identical contract as `TextSourceBuffer`:
- `wallAnchor` and `timestampOffset` are set by the player after construction.
- `effectiveOffset = wallTimestampOffset − wallAnchor` translates Period-relative
  seconds to player-time (currentTime space) for cue construction.
- `presentationTime` on `DashEvent` and `DashEventDetail` is always wall-clock
  epoch seconds (useful for live scheduling).

### Backwards Compatibility

- No changes to existing public APIs.
- emsg detection on `ManagedSourceBuffer` is **always on** once the first
  `ManagedSourceBuffer` is created (event infrastructure is spun up lazily and
  transparently). No opt-in required; cost is negligible.
- Applications that never listen for `event:receive` / `event:activate` are
  unaffected.

## New Files Summary

| File | Purpose |
|---|---|
| `src/dash-event.ts` | `DashEvent`, `EmsgBox`, `EventStreamContext`, `BoundedEventDedup` |
| `src/event-sink.ts` | `EventSink` — shared cue creation + dedup + `event:receive` emission |
| `src/event-emitter.ts` | `DashEventEmitter`, `DashEventDetail` — `event:receive` / `event:activate` |
| `src/event-source-buffer.ts` | `EventSourceBuffer` implementing `ISourceBuffer` |
| `src/mp4/emsg-parser.ts` | `parseEmsgBoxes` — v1-only, short-circuits on `moof` |
| `src/event-stream-parser.ts` | `parseEventStreamXml` — DOM parser, handles EventStream wrapper + bare Event |
| `test/emsg-parser.test.ts` | emsg parser unit tests |
| `test/event-stream-parser.test.ts` | event-stream XML parser unit tests |
| `test/event-sink.test.ts` | EventSink + BoundedEventDedup unit tests |
| `test/event-emitter.test.ts` | cuechange → `event:activate` tests |

## Modified Files Summary

| File | Change |
|---|---|
| `src/text-codec.ts` | Add `'event-stream'` kind; classify `application/dash+xml; codecs="event-stream"` |
| `src/ergo-media-source.ts` | Route event-stream to `EventSourceBuffer`; lazy-init `EventSink` + `DashEventEmitter`; wire `ManagedSourceBuffer` emsg detection |
| `src/managed-source-buffer.ts` | Add `enableEventDetection(sink)`; scan for emsg before queuing real append |
| `src/index.ts` | Re-export new types; augment `HTMLVideoElementEventMap` |
| `README.md` | Document event support |