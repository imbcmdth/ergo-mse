/**
 * DashEventEmitter — dispatches 'event:receive' and 'event:activate' CustomEvents
 * on the attached video element.
 *
 * Two event names are emitted for every DASH event:
 *
 *   'event:receive'   — fired synchronously when the event is parsed and added
 *                       to the internal TextTrack (at append time). Useful for
 *                       consumers that want to react as soon as the player
 *                       downloads and processes a segment.
 *
 *   'event:activate'  — fired when the event's cue window becomes active, i.e.
 *                       video.currentTime enters [cue.startTime, cue.endTime).
 *                       Driven by the TextTrack's 'cuechange' event. Useful for
 *                       consumers that want to react precisely at playback time.
 *
 * Consumers choose whichever lifecycle point they need; both carry the same
 * DashEventDetail payload.
 */

import type { DashEvent } from './dash-event';

// ── Public types ──────────────────────────────────────────────────────────────

export interface DashEventDetail {
  schemeIdUri: string;
  value?:      string;
  id?:         number;
  /** Wall-clock epoch seconds. */
  presentationTime: number;
  /** Duration in seconds (0 = instantaneous). */
  duration:    number;
  /** Binary payload (from emsg message_data or base64 @messageData). */
  messageData?: Uint8Array;
  /** String payload (from <Event> inner text content). */
  payload?:     string;
  /** Which delivery path produced this event. */
  source: 'emsg' | 'event-stream';
}

// ── DashEventEmitter ──────────────────────────────────────────────────────────

export class DashEventEmitter {
  readonly #videoEl:    HTMLVideoElement;
  readonly #eventTrack: TextTrack;
  /** Cues that have already been seen as active — prevents double-firing. */
  readonly #seen = new WeakSet<TextTrackCue>();

  constructor(videoEl: HTMLVideoElement, eventTrack: TextTrack) {
    this.#videoEl    = videoEl;
    this.#eventTrack = eventTrack;
    this.#eventTrack.addEventListener('cuechange', this.#onCueChange);
  }

  /** Emit 'event:receive' immediately when a DASH event is parsed. */
  emitReceive(event: DashEvent): void {
    this.#dispatch('event:receive', event);
  }

  /** Emit 'event:activate' when a cue enters the active window. */
  emitActivate(event: DashEvent): void {
    this.#dispatch('event:activate', event);
  }

  /** Remove the cuechange listener (called by ErgoMediaSource.detach). */
  dispose(): void {
    this.#eventTrack.removeEventListener('cuechange', this.#onCueChange);
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  readonly #onCueChange = (): void => {
    const active = this.#eventTrack.activeCues;
    if (!active) return;
    for (let i = 0; i < active.length; i++) {
      const cue = active[i];
      if (this.#seen.has(cue)) continue;
      this.#seen.add(cue);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ev = (cue as any).dashEvent as DashEvent | undefined;
      if (ev) this.emitActivate(ev);
    }
  };

  #dispatch(name: 'event:receive' | 'event:activate', event: DashEvent): void {
    const detail: DashEventDetail = {
      schemeIdUri:      event.schemeIdUri,
      value:            event.value,
      id:               event.id,
      presentationTime: event.presentationTime,
      duration:         event.duration,
      messageData:      event.messageData,
      payload:          event.payload,
      source:           event.source,
    };
    this.#videoEl.dispatchEvent(new CustomEvent(name, { detail }));
  }
}
