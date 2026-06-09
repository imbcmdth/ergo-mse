/**
 * Test helpers — DOM setup and utilities for tests.
 */

import { JSDOM } from 'jsdom';

// Initialize jsdom once
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost',
  pretendToBeVisual: true,
  resources: 'usable'
});

// Set up global browser APIs
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLVideoElement: dom.window.HTMLVideoElement,
  HTMLElement: dom.window.HTMLElement,
  URL: dom.window.URL,
  TextTrack: dom.window.TextTrack,
  VTTCue: dom.window.VTTCue,
  TextTrackCue: dom.window.TextTrackCue,
  MediaSource: dom.window.MediaSource,
  SourceBuffer: dom.window.SourceBuffer,
  TimeRanges: dom.window.TimeRanges,
  DOMException: dom.window.DOMException,
  ArrayBuffer: dom.window.ArrayBuffer,
  DataView: dom.window.DataView,
  Uint8Array: dom.window.Uint8Array,
  TextEncoder: dom.window.TextEncoder,
  AbortSignal: dom.window.AbortSignal,
  AbortController: dom.window.AbortController
});

export {};
