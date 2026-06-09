/**
 * EventSink — the single shared funnel through which all DASH events (whether
 * from emsg boxes or from EventSourceBuffer XML appends) flow into the shared
 * internal TextTrack and trigger 'event:receive' emissions.
 *
 * Owned by ErgoMediaSource; passed by reference to both ManagedSourceBuffer
 * (emsg path) and EventSourceBuffer (event-stream path).  Having one shared
 * sink means the BoundedEventDedup instance is common to both paths, so a
 * rendition switch that replays events already seen via emsg will be silently
 * dropped by the event-stream path (and vice-versa).
 */

import type { DashEvent, EmsgBox } from './dash-event';
import { BoundedEventDedup }       from './dash-event';
import type { DashEventEmitter }   from './event-emitter';

export class EventSink {
  readonly track:    TextTrack;
  readonly #emitter: DashEventEmitter;
  readonly #dedup:   BoundedEventDedup;

  constructor(track: TextTrack, emitter: DashEventEmitter, maxDedup = 20) {
    this.track    = track;
    this.#emitter = emitter;
    this.#dedup   = new BoundedEventDedup(maxDedup);
  }

  // ── Public entry points ───────────────────────────────────────────────────

  /**
   * Add an event derived from an emsg v1 box.
   *
   * @param emsg       Parsed emsg box (presentation_time is absolute, in
   *                   timescale units).
   * @param wallAnchor Wall-clock epoch second corresponding to currentTime=0
   *                   (sourced from the owning ManagedSourceBuffer.wallAnchor).
   *
   * Wall-clock epoch of the event:
   *   presentationTime / timescale
   * (emsg v1 presentation_time is already absolute wall-clock in timescale
   *  units — no additional offset needed.)
   */
  addEmsgEvent(emsg: EmsgBox, wallAnchor: number): void {
    const wallClock = emsg.presentationTime / (emsg.timescale || 1);
    const duration  = emsg.eventDuration === 0xFFFF_FFFF
      ? 0                           // unknown/open-ended → treat as instantaneous
      : emsg.eventDuration / (emsg.timescale || 1);

    const uniqueKey = `${emsg.schemeIdUri}|${emsg.value}|${emsg.id}|${wallClock}`;

    const event: DashEvent = {
      schemeIdUri:      emsg.schemeIdUri,
      value:            emsg.value || undefined,
      id:               emsg.id,
      presentationTime: wallClock,
      duration,
      messageData:      emsg.messageData,
      source:           'emsg',
      uniqueKey,
    };

    this.#add(event, wallAnchor);
  }

  /**
   * Add an event derived from a parsed EventStream XML element.
   *
   * @param event      Already-parsed DashEvent (presentationTime is wall-clock).
   * @param wallAnchor Wall-clock epoch second corresponding to currentTime=0.
   */
  addStreamEvent(event: DashEvent, wallAnchor: number): void {
    this.#add(event, wallAnchor);
  }

  // ── Private ───────────────────────────────────────────────────────────────

  #add(event: DashEvent, wallAnchor: number): void {
    if (this.#dedup.seen(event.uniqueKey)) return;

    // Convert wall-clock → player-time (currentTime space) for the cue.
    const startPt = event.presentationTime - wallAnchor;
    const endPt   = startPt + (event.duration > 0 ? event.duration : 0.001);

    const cue = new VTTCue(startPt, endPt, '');
    // Attach the full DashEvent to the cue for retrieval in the cuechange handler.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (cue as any).dashEvent = event;

    this.track.addCue(cue);
    this.#emitter.emitReceive(event);
  }
}
