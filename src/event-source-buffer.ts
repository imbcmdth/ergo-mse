/**
 * EventSourceBuffer — an ISourceBuffer implementation that accepts serialized
 * DASH EventStream XML and injects the contained events as VTTCue objects into
 * the shared internal TextTrack owned by ErgoMediaSource.
 *
 * MIME type:  application/dash+xml; codecs="event-stream"
 *
 * Usage model (mirrors how the player treats Representations):
 *   - append(<EventStream …>…</EventStream>) — sets the buffer's EventStream
 *     context (schemeIdUri, value, timescale, presentationTimeOffset) and
 *     processes any inline <Event> children.  Re-sending is safe: duplicates
 *     are dropped by the shared EventSink deduplicator.
 *   - append(<Event …/>) — processed against the most-recently-set context.
 *
 * Wall-clock timing (same contract as TextSourceBuffer / ManagedSourceBuffer):
 *   wallAnchor        — set by the player after construction.
 *   timestampOffset   — wall-clock epoch value for the Period/segment origin.
 *
 * DashEvent.presentationTime is wall-clock epoch seconds.  EventSink converts
 * to player time by subtracting wallAnchor.  #buffered stores player time;
 * the buffered getter wraps it in OffsetTimeRanges(+wallAnchor) for external
 * wall-clock access.
 *
 * The `buffered`, `remove`, `abort` operations maintain an internal
 * SyntheticTimeRanges so the player can reason about which time ranges have
 * been processed — mirroring TextSourceBuffer behaviour.
 */

import type { ISourceBuffer }       from './i-source-buffer';
import type { EventStreamContext }  from './dash-event';
import type { EventSink }           from './event-sink';
import { SyntheticTimeRanges }      from './synthetic-time-ranges';
import { OffsetTimeRanges }         from './offset-time-ranges';
import { parseEventStreamXml }      from './event-stream-parser';

// ── Queue entry type ──────────────────────────────────────────────────────────

type QueueEntry =
  | { kind: 'append'; data: ArrayBuffer | ArrayBufferView; resolve: () => void; reject: (e: Error) => void }
  | { kind: 'remove'; start: number; end: number;           resolve: () => void; reject: (e: Error) => void }
  | { kind: 'abort';                                         resolve: () => void; reject: (e: Error) => void };

// ── EventSourceBuffer ─────────────────────────────────────────────────────────

export class EventSourceBuffer implements ISourceBuffer {
  /** The shared internal TextTrack (owned by ErgoMediaSource). */
  readonly eventTrack: TextTrack;

  wallAnchor = 0;

  #wallTimestampOffset = 0;
  #appendWindowStart   = -Infinity;
  #appendWindowEnd     = Infinity;

  #updating      = false;
  #buffered      = new SyntheticTimeRanges();
  #queue: QueueEntry[] = [];
  #isProcessing  = false;

  /** EventStream-level context — updated on each <EventStream> append. */
  #context: EventStreamContext = {
    schemeIdUri:            '',
    value:                  '',
    timescale:              1,
    presentationTimeOffset: 0,
  };

  readonly #sink: EventSink;

  constructor(eventTrack: TextTrack, sink: EventSink) {
    this.eventTrack = eventTrack;
    this.#sink      = sink;
  }

  // ── ISourceBuffer ─────────────────────────────────────────────────────────

  get updating(): boolean { return this.#updating; }

  /** Buffered ranges in wall-clock epoch seconds. */
  get buffered(): TimeRanges {
    return new OffsetTimeRanges(this.#buffered as unknown as TimeRanges, this.wallAnchor);
  }

  get timestampOffset(): number { return this.#wallTimestampOffset; }
  set timestampOffset(v: number) { this.#wallTimestampOffset = v; }

  get appendWindowStart(): number {
    return this.#appendWindowStart === -Infinity ? -Infinity : this.#appendWindowStart + this.wallAnchor;
  }
  set appendWindowStart(v: number) {
    this.#appendWindowStart = v === -Infinity ? -Infinity : v - this.wallAnchor;
  }

  get appendWindowEnd(): number {
    return this.#appendWindowEnd === Infinity ? Infinity : this.#appendWindowEnd + this.wallAnchor;
  }
  set appendWindowEnd(v: number) {
    this.#appendWindowEnd = v === Infinity ? Infinity : v - this.wallAnchor;
  }

  get mode(): 'segments' | 'sequence' { return 'segments'; }
  set mode(_: 'segments' | 'sequence') { /* no-op */ }

  async append(data: ArrayBuffer | ArrayBufferView): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.#queue.push({ kind: 'append', data, resolve, reject });
      this.#pump();
    });
  }

  async remove(start: number, end: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const a = start - this.wallAnchor;
      const b = end === Infinity ? Infinity : end - this.wallAnchor;
      this.#queue.push({ kind: 'remove', start: a, end: b, resolve, reject });
      this.#pump();
    });
  }

  async abort(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const startIdx = this.#isProcessing ? 1 : 0;
      const drained  = this.#queue.splice(startIdx);
      for (const op of drained) op.reject(new Error('Aborted'));
      if (!this.#isProcessing) { resolve(); return; }
      this.#queue.push({ kind: 'abort', resolve, reject });
    });
  }

  changeType(_mimeAndCodecs: string): void {
    // Context is reset; the next <EventStream> append will set new context.
    this.#context = { schemeIdUri: '', value: '', timescale: 1, presentationTimeOffset: 0 };
  }

  // Optional show/hide — no-op (event track is always hidden/metadata).
  show(): void { /* no-op */ }
  hide(): void { /* no-op */ }

  // ── Queue pump ────────────────────────────────────────────────────────────

  #pump(): void {
    if (this.#isProcessing || this.#queue.length === 0) return;

    this.#isProcessing = true;
    this.#updating     = true;
    const op           = this.#queue[0];

    Promise.resolve().then(() => {
      try {
        switch (op.kind) {
          case 'append': this.#doAppend(op.data); break;
          case 'remove': this.#doRemove(op.start, op.end); break;
          case 'abort':  break;
        }
        op.resolve();
      } catch (err) {
        const all = this.#queue.splice(0);
        this.#isProcessing = false;
        this.#updating     = false;
        for (const o of all) o.reject(err as Error);
        return;
      }

      this.#queue.shift();
      this.#isProcessing = false;
      this.#updating     = this.#queue.length > 0;
      this.#pump();
    });
  }

  // ── Internal operations ───────────────────────────────────────────────────

  #doAppend(data: ArrayBuffer | ArrayBufferView): void {
    // Pass wallTimestampOffset so the parser produces wall-clock epoch seconds in
    // event.presentationTime.  EventSink.#add subtracts wallAnchor to get player
    // time for the VTTCue, so the value must be wall-clock here.
    const result = parseEventStreamXml(data, this.#context, this.#wallTimestampOffset);
    this.#context = result.context;

    let minPt = Infinity;
    let maxPt = -Infinity;

    for (const event of result.events) {
      // event.presentationTime is wall-clock epoch seconds.
      // appendWindowStart/End getters also return wall-clock epoch seconds.
      const wallClock = event.presentationTime;
      if (wallClock < this.appendWindowStart || wallClock >= this.appendWindowEnd) continue;

      this.#sink.addStreamEvent(event, this.wallAnchor);

      // #buffered stores player time (OffsetTimeRanges adds wallAnchor externally).
      const playerStart = wallClock - this.wallAnchor;
      if (playerStart < minPt) minPt = playerStart;
      const playerEnd = playerStart + (event.duration > 0 ? event.duration : 0.001);
      if (playerEnd   > maxPt) maxPt = playerEnd;
    }

    if (minPt < Infinity) {
      this.#buffered.add(minPt, maxPt);
    }
  }

  #doRemove(start: number, end: number): void {
    // Remove cues in the range from the shared track.
    const cues = this.eventTrack.cues;
    if (cues && cues.length > 0) {
      const toRemove: TextTrackCue[] = [];
      for (let i = 0; i < cues.length; i++) {
        const c = cues[i];
        if (c.startTime < end && c.endTime > start) toRemove.push(c);
      }
      for (const c of toRemove) this.eventTrack.removeCue(c);
    }
    this.#buffered.cut(start, end);
  }
}
