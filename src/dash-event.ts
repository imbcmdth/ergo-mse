/**
 * Core data structures for MPEG DASH timed events.
 *
 * Events can be delivered via two mechanisms:
 *   1. emsg boxes embedded in fMP4 video/audio segments (v1 only, CMAF).
 *   2. EventSourceBuffer fed serialized <EventStream>/<Event> XML fragments.
 *
 * Both paths produce a DashEvent and share the same EventSink for deduplication,
 * cue creation, and emission.
 */

// ── DashEvent ─────────────────────────────────────────────────────────────────

export interface DashEvent {
  /** Event scheme identifier URI (from EventStream@schemeIdUri or emsg). */
  schemeIdUri: string;
  /** Optional scheme-specific value string. */
  value?: string;
  /** Optional event ID (used in dedup key). */
  id?: number;
  /**
   * Event start time in wall-clock epoch seconds.
   * For VOD with wallAnchor=0 this equals Period-relative seconds.
   */
  presentationTime: number;
  /**
   * Event duration in seconds.  0 means instantaneous; a synthetic 1 ms end
   * time is used internally so the cue fires a cuechange.
   */
  duration: number;
  /** Raw binary payload (emsg message_data, or decoded @messageData base64). */
  messageData?: Uint8Array;
  /** String payload (inner text content of an <Event> element). */
  payload?: string;
  /** Which delivery path produced this event. */
  source: 'emsg' | 'event-stream';
  /**
   * Composite deduplication key.
   * Format: `${schemeIdUri}|${value ?? ''}|${id ?? ''}|${presentationTime}`
   */
  uniqueKey: string;
}

// ── EmsgBox ───────────────────────────────────────────────────────────────────

/**
 * Parsed emsg v1 box (ISO 14496-12 §12.3.3 / DASH spec §5.10.3.3).
 * Version 0 is not supported (CMAF mandates v1).
 *
 * Binary layout after the 8-byte box header (size + 'emsg'):
 *   version(1=1) + flags(3) | timescale(4) | presentation_time(8, absolute) |
 *   event_duration(4) | id(4) | scheme_id_uri(utf8 NUL) | value(utf8 NUL) |
 *   message_data[...]
 */
export interface EmsgBox {
  schemeIdUri: string;
  value: string;
  timescale: number;
  /** Absolute presentation time in timescale units. */
  presentationTime: number;
  /** Event duration in timescale units. 0xFFFF_FFFF means unknown/open-ended. */
  eventDuration: number;
  id: number;
  messageData: Uint8Array;
}

// ── EventStreamContext ────────────────────────────────────────────────────────

/**
 * Attributes lifted from an <EventStream> wrapper element.
 * Analogous to a Representation's init segment — set once, reused for all
 * subsequent bare <Event> appends.
 */
export interface EventStreamContext {
  schemeIdUri: string;
  value: string;
  /** Divisor for Event@presentationTime and Event@duration. Default: 1. */
  timescale: number;
  /** Subtracted from Event@presentationTime before dividing. Default: 0. */
  presentationTimeOffset: number;
}

// ── BoundedEventDedup ─────────────────────────────────────────────────────────

/**
 * Insertion-ordered deduplication store capped at `maxEntries`.
 *
 * Once the cap is reached the oldest entry is evicted, keeping memory bounded
 * over long live sessions without needing explicit coupling to remove() calls.
 * The cap defaults to 20 — large enough to cover rendition-switch overlap while
 * staying effectively O(1) for the lookup.
 */
export class BoundedEventDedup {
  readonly #max: number;
  readonly #keys: Map<string, true>;

  constructor(maxEntries: number = 20) {
    this.#max  = maxEntries;
    this.#keys = new Map();
  }

  /**
   * Returns `true` if the key was already recorded (duplicate).
   * If not a duplicate, records it and returns `false`.
   * Evicts the oldest entry when the store would exceed `maxEntries`.
   */
  seen(key: string): boolean {
    if (this.#keys.has(key)) {
      return true;
    }
    if (this.#keys.size >= this.#max) {
      // Map preserves insertion order; first key is the oldest.
      const oldest = this.#keys.keys().next().value as string;
      this.#keys.delete(oldest);
    }
    this.#keys.set(key, true);
    return false;
  }

  /** Current number of tracked keys. */
  get size(): number {
    return this.#keys.size;
  }
}
