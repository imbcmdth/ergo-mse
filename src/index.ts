/**
 * @videl/lib-ergo-mse — Ergonomic MSE abstractions.
 *
 * Provides a common ISourceBuffer interface implemented by both
 * ManagedSourceBuffer (real MSE SourceBuffer wrapper) and TextSourceBuffer
 * (TextTrack-backed fake source buffer for DASH text tracks). Supporting
 * types: SyntheticTimeRanges and the codec classifier. Intended to be spun
 * off as a standalone package.
 *
 * DASH timed events are supported transparently:
 *   - emsg v1 boxes in video/audio segments are auto-detected and emitted.
 *   - addSourceBuffer('application/dash+xml; codecs="event-stream"') returns
 *     an EventSourceBuffer that accepts <EventStream>/<Event> XML appends.
 * Both paths emit 'event:receive' (at parse time) and 'event:activate' (at
 * playback time) CustomEvents on the attached video element.
 */
export type { ISourceBuffer } from './i-source-buffer';

export type { TextCodecClass } from './text-codec';
export { classifyTextCodec, classifyTextMimeAndCodecs } from './text-codec';

export { SyntheticTimeRanges } from './synthetic-time-ranges';
export { OffsetTimeRanges } from './offset-time-ranges';

export { ManagedSourceBuffer } from './managed-source-buffer';
export { TextSourceBuffer } from './text-source-buffer';
export { EventSourceBuffer } from './event-source-buffer';
export { ErgoMediaSource } from './ergo-media-source';
export type { AddSourceBufferOptions } from './ergo-media-source';

// DASH event types
export type { DashEvent, EmsgBox, EventStreamContext } from './dash-event';
export { BoundedEventDedup } from './dash-event';
export type { DashEventDetail } from './event-emitter';

// Augment the browser's HTMLVideoElement event map so TypeScript consumers
// get fully typed event listeners for DASH events.
declare global {
  interface HTMLVideoElementEventMap {
    'event:receive':  CustomEvent<import('./event-emitter').DashEventDetail>;
    'event:activate': CustomEvent<import('./event-emitter').DashEventDetail>;
  }
}
