# ergo-mse

An ergonomic replacement for the browser's MediaSource and SourceBuffer APIs with built-in support for text tracks and wall-clock time mapping.

## Overview

`ergo-mse` provides a unified interface for working with both audio/video and text media sources. It transparently handles:

- **Audio/Video streams** via the standard MSE SourceBuffer (wrapped for promise-based operations)
- **Text tracks** (VTT, TTML/IMSC) delivered as fMP4 or sidecar files
- **Wall-clock time mapping** for live and DVR streaming scenarios

The library exports a common `ISourceBuffer` interface that both real MSE SourceBuffers and text tracks implement, allowing consumers to treat them identically.

## Installation

```bash
npm install ergo-mse
```

## Core Concepts

### Wall-Clock Time Mapping

All time values in `ergo-mse` use **wall-clock epoch seconds** — the same coordinate system used by DASH MPD `@availabilityStartTime` and segment timing information. This enables seamless handling of VOD, live, and live-DVR streams.

```
Wall-clock epoch (seconds) ──┬──────────────────────────────────────────
                             │ wallAnchor (set once during setup)
                             ↓
video.currentTime space ─────0──────────────────────────────────────────
                             ↑
                      playback starts here
```

**Setting wallAnchor:**

- **VOD**: `wallAnchor = 0` (identity mapping; wall-clock values equal currentTime)
- **Live**: `wallAnchor = currentServerTime` (live edge maps to currentTime = 0)
- **Live-DVR**: `wallAnchor = currentServerTime − TSBD` (DVR start maps to currentTime = 0)

All `ISourceBuffer` implementations translate wall-clock values to player-time internally by subtracting `wallAnchor`.

## API Documentation

### ErgoMediaSource

Main entry point. Wraps the browser's `MediaSource` API with promise-based attachment and transparent text track support.

```typescript
class ErgoMediaSource {
  // Wall-clock epoch second corresponding to video.currentTime = 0
  wallAnchor: number;

  // Attach to video element and wait for sourceopen
  attach(videoEl: HTMLVideoElement, signal?: AbortSignal): Promise<void>;

  // Revoke object URL, clean up resources
  detach(): void;

  // Add audio/video or text source buffer
  addSourceBuffer(mimeAndCodecs: string, options?: AddSourceBufferOptions): ISourceBuffer;

  // Check if MIME/codec is supported (including text types)
  static isTypeSupported(mimeAndCodecs: string): boolean;

  // Get/set presentation duration
  duration: number;

  // Signal end of media stream
  endOfStream(error?: 'network' | 'decode'): void;

  // Update seekable range for live streams (wall-clock epoch seconds)
  setLiveSeekableRange(wallStart: number, wallEnd: number): void;

  // Underlying MediaSource ready state
  readyState: 'closed' | 'open' | 'ended';
}

interface AddSourceBufferOptions {
  label?: string;  // Human-readable label for TextTrack
  lang?: string;   // BCP-47 language tag (e.g. "en", "fr")
}
```

### ManagedSourceBuffer

Promise-based wrapper around a native MSE `SourceBuffer`. Queues all operations and translates wall-clock time to player-time.

```typescript
class ManagedSourceBuffer implements ISourceBuffer {
  wallAnchor: number;

  // Append media bytes
  append(data: ArrayBuffer | ArrayBufferView): Promise<void>;

  // Remove buffered range [start, end) — wall-clock epoch seconds
  remove(start: number, end: number): Promise<void>;

  // Abort in-flight operation and clear queue
  abort(): Promise<void>;

  // Change MIME+codecs type
  changeType(mimeAndCodecs: string): void;

  // True while an async operation is in progress
  readonly updating: boolean;

  // Buffered ranges in wall-clock epoch seconds
  readonly buffered: TimeRanges;

  // Offset (wall-clock) added to media decode times
  timestampOffset: number;

  // Start of append window (wall-clock epoch seconds)
  appendWindowStart: number;

  // End of append window (wall-clock epoch seconds)
  appendWindowEnd: number;

  // SourceBuffer mode: 'segments' (absolute timestamps) or 'sequence'
  mode: 'segments' | 'sequence';
}
```

### TextSourceBuffer

Fake SourceBuffer backed by a `<video>` element's `TextTrack`. Handles text-format segments (VTT, TTML/IMSC) delivered as fMP4 or sidecar files, injecting `VTTCue` objects into the track.

```typescript
class TextSourceBuffer implements ISourceBuffer {
  // The underlying TextTrack
  textTrack: TextTrack;

  wallAnchor: number;

  // Append text segment (fMP4 or sidecar format)
  append(data: ArrayBuffer | ArrayBufferView): Promise<void>;

  // Remove cues in range [start, end) — wall-clock epoch seconds
  remove(start: number, end: number): Promise<void>;

  // Abort in-flight operation and clear queue
  abort(): Promise<void>;

  // Update codec hint and reset demuxer
  changeType(mimeAndCodecs: string): void;

  // True while an async operation is in progress
  readonly updating: boolean;

  // Buffered cue ranges in wall-clock epoch seconds
  readonly buffered: TimeRanges;

  // Offset (wall-clock) applied to media presentation times
  timestampOffset: number;

  // Start of append window (wall-clock epoch seconds)
  appendWindowStart: number;

  // End of append window (wall-clock epoch seconds)
  appendWindowEnd: number;

  // Always 'segments' for text tracks (setter is no-op)
  mode: 'segments';

  // Show the text track (mode = 'showing')
  show(): void;

  // Hide the text track (mode = 'hidden')
  hide(): void;
}

constructor(
  videoEl: HTMLVideoElement,
  label: string,
  lang: string,
  codecHint?: string
);
```

### ISourceBuffer

Common interface implemented by both `ManagedSourceBuffer` and `TextSourceBuffer`. All consumers should type against this interface.

```typescript
interface ISourceBuffer {
  wallAnchor: number;

  append(data: ArrayBuffer | ArrayBufferView): Promise<void>;
  remove(start: number, end: number): Promise<void>;
  abort(): Promise<void>;
  changeType(mimeAndCodecs: string): void;

  readonly updating: boolean;
  readonly buffered: TimeRanges;

  timestampOffset: number;
  appendWindowStart: number;
  appendWindowEnd: number;
  mode: 'segments' | 'sequence';

  show?(): void;
  hide?(): void;
}
```

### SyntheticTimeRanges

Mutable TimeRanges-like object for tracking buffered time ranges. Used internally by `TextSourceBuffer` and can be used independently.

```typescript
class SyntheticTimeRanges {
  // Number of ranges
  readonly length: number;

  // Get start time of range i (throws if out of bounds)
  start(i: number): number;

  // Get end time of range i (throws if out of bounds)
  end(i: number): number;

  // Add [start, end) to tracked ranges, merging overlapping ranges
  add(start: number, end: number): void;

  // Remove [start, end) from all tracked ranges
  cut(start: number, end: number): void;

  // Remove all tracked ranges
  clear(): void;
}
```

### OffsetTimeRanges

Read-only TimeRanges wrapper that applies a fixed offset to all start/end values. Used internally to convert between player-time and wall-clock coordinate systems.

```typescript
class OffsetTimeRanges implements TimeRanges {
  // Number of ranges (from inner TimeRanges)
  readonly length: number;

  // Get start time of range i with offset applied
  start(i: number): number;

  // Get end time of range i with offset applied
  end(i: number): number;

  constructor(inner: TimeRanges, offset: number);
}
```

### Text Codec Classification

Utilities for classifying text MIME types and codec strings.

```typescript
type TextCodecClass =
  | { kind: 'wvtt' }         // WebVTT-in-ISOBMFF (ISO 14496-30)
  | { kind: 'stpp-text' }    // TTML/IMSC text profile
  | { kind: 'stpp-image' }   // TTML image profile (not supported)
  | { kind: 'vtt-sidecar' }  // Sidecar WebVTT file
  | { kind: 'ttml-sidecar' } // Sidecar TTML document
  | { kind: 'unknown' };     // Unrecognized

// Classify a bare fMP4 codec string (e.g. "wvtt", "stpp", "stpp.ttml.im1t")
function classifyTextCodec(codec: string): TextCodecClass;

// Classify a full MIME or "MIME; codecs=..." string
function classifyTextMimeAndCodecs(mimeAndCodecs: string): TextCodecClass;
```

## Usage Examples

### Basic VOD Setup

```typescript
import { ErgoMediaSource } from 'ergo-mse';

const videoEl = document.querySelector('video');
const mse = new ErgoMediaSource();

// Attach and wait for sourceopen
await mse.attach(videoEl);

// Add video buffer
const videoBuf = mse.addSourceBuffer('video/mp4; codecs="avc1.42E01E"');

// Add audio buffer
const audioBuf = mse.addSourceBuffer('audio/mp4; codecs="mp4a.40.2"');

// Add English subtitles (fMP4 wvtt)
const subtitlesBuf = mse.addSourceBuffer(
  'application/mp4; codecs="wvtt"',
  { label: 'English', lang: 'en' }
);

// Set presentation duration
mse.duration = 120; // 120 seconds

// Append segments
await videoBuf.append(videoInitSegment);
await videoBuf.append(videoMediaSegment1);
await audioBuf.append(audioInitSegment);
await audioBuf.append(audioMediaSegment1);
await subtitlesBuf.append(subtitleInitSegment);
await subtitlesBuf.append(subtitleMediaSegment1);

// Signal end of stream
mse.endOfStream();

// Clean up when done
mse.detach();
```

### Live Streaming with Wall-Clock Time Mapping

```typescript
import { ErgoMediaSource } from 'ergo-mse';

const videoEl = document.querySelector('video');
const mse = new ErgoMediaSource();

// Get current server time from MPD
const nowSeconds = Date.now() / 1000;
const availabilityStartTime = 1700000000;

// For live, wallAnchor is the current time
mse.wallAnchor = nowSeconds;

await mse.attach(videoEl);

const videoBuf = mse.addSourceBuffer('video/mp4; codecs="avc1.42E01E"');
const audioBuf = mse.addSourceBuffer('audio/mp4; codecs="mp4a.40.2"');
const subtitlesBuf = mse.addSourceBuffer('application/mp4; codecs="wvtt"', {
  label: 'English',
  lang: 'en'
});

// Set wallAnchor on all buffers
videoBuf.wallAnchor = nowSeconds;
audioBuf.wallAnchor = nowSeconds;
subtitlesBuf.wallAnchor = nowSeconds;

// Segments use wall-clock timing from the MPD
const videoSegmentStartTime = availabilityStartTime + 60; // 1 min into stream
const videoSegmentEndTime = videoSegmentStartTime + 10;

// timestampOffset is in wall-clock space
videoBuf.timestampOffset = videoSegmentStartTime;
audioBuf.timestampOffset = videoSegmentStartTime;
subtitlesBuf.timestampOffset = videoSegmentStartTime;

await videoBuf.append(videoInitSegment);
await videoBuf.append(videoMediaSegment);
await audioBuf.append(audioInitSegment);
await audioBuf.append(audioMediaSegment);
await subtitlesBuf.append(subtitleInitSegment);
await subtitlesBuf.append(subtitleMediaSegment);

// Update seekable range on every pump tick
setInterval(() => {
  const nowSeconds = Date.now() / 1000;
  const availableStart = nowSeconds - (15 * 60); // 15 min DVR window
  const availableEnd = nowSeconds;
  mse.setLiveSeekableRange(availableStart, availableEnd);
}, 1000);
```

### Live-DVR with Time Shift Buffer Depth

```typescript
import { ErgoMediaSource } from 'ergo-mse';

const videoEl = document.querySelector('video');
const mse = new ErgoMediaSource();

const nowSeconds = Date.now() / 1000;
const timeShiftBufferDepth = 15 * 60; // 15 minutes
const dvrWindowStart = nowSeconds - timeShiftBufferDepth;

// For live-DVR, wallAnchor maps DVR window start to currentTime = 0
mse.wallAnchor = dvrWindowStart;

await mse.attach(videoEl);

const videoBuf = mse.addSourceBuffer('video/mp4; codecs="avc1.42E01E"');
videoBuf.wallAnchor = dvrWindowStart;

// Now currentTime = 0 is the start of the DVR window
// and currentTime = timeShiftBufferDepth is the live edge
```

### Text Track with Sidecar VTT

```typescript
import { ErgoMediaSource } from 'ergo-mse';

const videoEl = document.querySelector('video');
const mse = new ErgoMediaSource();

await mse.attach(videoEl);

// Use sidecar text/vtt MIME type
const subtitlesBuf = mse.addSourceBuffer('text/vtt', {
  label: 'English',
  lang: 'en'
});

mse.duration = 120;

// Append entire VTT file (segments are the full file each time)
const vttData = new TextEncoder().encode(`WEBVTT

00:00:00.500 --> 00:00:07.000
Caption 1

00:00:10.000 --> 00:00:20.000
Caption 2
`);

await subtitlesBuf.append(vttData);

// Show/hide the track
subtitlesBuf.show();
// subtitlesBuf.hide();
```

### Text Track with TTML/IMSC

```typescript
import { ErgoMediaSource } from 'ergo-mse';

const videoEl = document.querySelector('video');
const mse = new ErgoMediaSource();

await mse.attach(videoEl);

// Use sidecar TTML MIME type
const subtitlesBuf = mse.addSourceBuffer('application/ttml+xml', {
  label: 'French',
  lang: 'fr'
});

mse.duration = 120;

// Append TTML document
const ttML = `<?xml version="1.0" encoding="UTF-8"?>
<tt xml:lang="fr" xmlns="http://www.w3.org/ns/ttml">
  <body>
    <div>
      <p begin="00:00:00" end="00:00:10">Premier sous-titre</p>
      <p begin="00:00:10" end="00:00:20">Deuxième sous-titre</p>
    </div>
  </body>
</tt>`;

await subtitlesBuf.append(new TextEncoder().encode(ttML));
```

### Handling Adaptive Bitrate Switching

```typescript
const videoBuf = mse.addSourceBuffer('video/mp4; codecs="avc1.42E01E"');

// When switching bitrates, call changeType
const newCodec = 'video/mp4; codecs="avc1.64001F"'; // different profile
videoBuf.changeType(newCodec);

// Queue append for new bitrate
await videoBuf.append(newInitSegment);
await videoBuf.append(newMediaSegment);
```

### Graceful AbortSignal Support

```typescript
import { ErgoMediaSource } from 'ergo-mse';

const videoEl = document.querySelector('video');
const mse = new ErgoMediaSource();
const controller = new AbortController();

// Attach with cancellation support
const attachPromise = mse.attach(videoEl, controller.signal);

// User clicks "cancel" button
document.querySelector('#cancel').addEventListener('click', () => {
  controller.abort();
});

try {
  await attachPromise;
} catch (err) {
  if (err instanceof DOMException && err.name === 'AbortError') {
    console.log('Attachment cancelled by user');
  }
}
```

## Error Handling

All async operations on `ISourceBuffer` implementations reject with an `Error` if:

- **MediaSource error**: Network or decoder error occurred
- **Aborted**: The operation was aborted via `abort()` or an `AbortSignal`
- **Invalid type**: (ManagedSourceBuffer) The MIME type is not supported
- **Queue error**: An earlier operation in the queue failed

Example:

```typescript
try {
  await videoBuf.append(data);
} catch (err) {
  console.error('Append failed:', err.message);
  // May want to abort and retry
  await videoBuf.abort();
}
```

## Supported Text Formats

| Delivery Model | Format | MIME Type | Codec |
|---|---|---|---|
| fMP4 | WebVTT | `application/mp4` | `wvtt` |
| fMP4 | TTML/IMSC text | `application/mp4` | `stpp`, `stpp.ttml.im1t`, `stpp.ttml.im2t`, `stpp.ttml.etd1` |
| Sidecar | WebVTT | `text/vtt` | — |
| Sidecar | TTML/IMSC | `application/ttml+xml` | — |

**Note**: TTML image profiles (`stpp.ttml.im1i`, `stpp.ttml.im2i`) are not supported; segments are silently discarded with a console warning.

## License

MIT
