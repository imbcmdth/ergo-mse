import './test-helpers';
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEventStreamXml } from '../src/event-stream-parser';
import type { EventStreamContext } from '../src/dash-event';

// ── Mock DOMParser ────────────────────────────────────────────────────────────
// Node.js does not have DOMParser. We install a lightweight implementation
// backed by a minimal Element/Document stub sufficient for our parser's queries.

class MockAttr {
  constructor(public name: string, public value: string) {}
}

class MockElement {
  localName: string;
  children: MockElement[] = [];
  textContent: string | null = null;
  private attrs: Map<string, string> = new Map();

  constructor(localName: string) {
    this.localName = localName;
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }
  getAttribute(name: string): string | null {
    return this.attrs.has(name) ? this.attrs.get(name)! : null;
  }
  hasAttribute(name: string): boolean {
    return this.attrs.has(name);
  }
  querySelector(selector: string): MockElement | null {
    if (selector === 'parsererror') return null;
    return null;
  }
  querySelectorAll(selector: string): MockElement[] {
    if (selector === 'Event') {
      return this.children.filter(c => c.localName === 'Event');
    }
    return [];
  }
}

class MockDocument {
  documentElement: MockElement;
  constructor(root: MockElement) { this.documentElement = root; }
  querySelector(sel: string): MockElement | null {
    if (sel === 'parsererror') return null;
    return null;
  }
}

class MockErrorDocument {
  documentElement: MockElement = new MockElement('parsererror');
  querySelector(sel: string): MockElement | null {
    if (sel === 'parsererror') return new MockElement('parsererror');
    return null;
  }
}

/** Build an <EventStream> document with optional child <Event> elements. */
function makeEventStreamDoc(streamAttrs: Record<string, string>, events: Record<string, string>[]): MockDocument {
  const root = new MockElement('EventStream');
  for (const [k, v] of Object.entries(streamAttrs)) root.setAttribute(k, v);
  for (const evAttrs of events) {
    const ev = new MockElement('Event');
    for (const [k, v] of Object.entries(evAttrs)) ev.setAttribute(k, v);
    root.children.push(ev);
  }
  return new MockDocument(root);
}

/** Build a bare <Event> document. */
function makeEventDoc(attrs: Record<string, string>, textContent?: string): MockDocument {
  const root = new MockElement('Event');
  for (const [k, v] of Object.entries(attrs)) root.setAttribute(k, v);
  if (textContent !== undefined) root.textContent = textContent;
  return new MockDocument(root);
}

/** Helper to encode string as UTF-8 bytes. */
function enc(s: string): ArrayBuffer {
  return new TextEncoder().encode(s).buffer;
}

// Install mock DOMParser. parseFromString returns a pre-built document
// based on whether the XML contains 'EventStream' or 'Event' as root.
let _nextDoc: MockDocument | null = null;
(globalThis as any).DOMParser = class {
  parseFromString(_xml: string, _type: string): MockDocument {
    if (_nextDoc) {
      const doc = _nextDoc;
      _nextDoc = null;
      return doc;
    }
    // Fallback: parse error document
    return new MockErrorDocument() as unknown as MockDocument;
  }
};

function withDoc(doc: MockDocument, fn: () => void): void {
  _nextDoc = doc;
  fn();
}

// ── Default context ───────────────────────────────────────────────────────────

function defaultCtx(overrides: Partial<EventStreamContext> = {}): EventStreamContext {
  return {
    schemeIdUri:            'urn:default',
    value:                  '',
    timescale:              1,
    presentationTimeOffset: 0,
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test('parseEventStreamXml', async (t) => {
  await t.test('<EventStream> root updates context', () => {
    const doc = makeEventStreamDoc(
      { schemeIdUri: 'urn:new', value: 'v', timescale: '90000', presentationTimeOffset: '900' },
      [],
    );
    withDoc(doc, () => {
      const result = parseEventStreamXml(enc('<EventStream/>'), defaultCtx(), 0);
      assert.equal(result.context.schemeIdUri, 'urn:new');
      assert.equal(result.context.value, 'v');
      assert.equal(result.context.timescale, 90000);
      assert.equal(result.context.presentationTimeOffset, 900);
    });
  });

  await t.test('<EventStream> with inline <Event> children processes them', () => {
    const doc = makeEventStreamDoc(
      { schemeIdUri: 'urn:test', timescale: '1000' },
      [
        { presentationTime: '2000', duration: '1000', id: '1' },
        { presentationTime: '5000', duration: '500',  id: '2' },
      ],
    );
    withDoc(doc, () => {
      const result = parseEventStreamXml(enc('<x/>'), defaultCtx(), 0);
      assert.equal(result.events.length, 2);
      assert.equal(result.events[0].presentationTime, 2); // 2000/1000
      assert.equal(result.events[0].duration, 1);
      assert.equal(result.events[0].id, 1);
      assert.equal(result.events[1].presentationTime, 5);
      assert.equal(result.events[1].duration, 0.5);
    });
  });

  await t.test('bare <Event> root uses existing context', () => {
    const ctx = defaultCtx({ schemeIdUri: 'urn:ctx', timescale: 100 });
    const doc = makeEventDoc({ presentationTime: '300', duration: '50', id: '7' });
    withDoc(doc, () => {
      const result = parseEventStreamXml(enc('<x/>'), ctx, 0);
      assert.equal(result.events.length, 1);
      assert.equal(result.events[0].schemeIdUri, 'urn:ctx');
      assert.equal(result.events[0].presentationTime, 3);   // 300/100
      assert.equal(result.events[0].duration, 0.5);         // 50/100
      assert.equal(result.events[0].id, 7);
      assert.equal(result.events[0].source, 'event-stream');
    });
  });

  await t.test('effectiveOffset is added to presentationTime', () => {
    const ctx = defaultCtx({ timescale: 1 });
    const doc = makeEventDoc({ presentationTime: '10' });
    withDoc(doc, () => {
      const result = parseEventStreamXml(enc('<x/>'), ctx, 1000000); // e.g. wall epoch
      assert.equal(result.events[0].presentationTime, 1000010);
    });
  });

  await t.test('presentationTimeOffset is subtracted before dividing', () => {
    const ctx = defaultCtx({ timescale: 1000, presentationTimeOffset: 500 });
    const doc = makeEventDoc({ presentationTime: '1500' }); // (1500-500)/1000 = 1.0s
    withDoc(doc, () => {
      const result = parseEventStreamXml(enc('<x/>'), ctx, 0);
      assert.equal(result.events[0].presentationTime, 1.0);
    });
  });

  await t.test('@messageData (base64) decoded to messageData', () => {
    // "hello" in base64 = "aGVsbG8="
    const doc = makeEventDoc({ presentationTime: '0', messageData: 'aGVsbG8=' });
    withDoc(doc, () => {
      const result = parseEventStreamXml(enc('<x/>'), defaultCtx(), 0);
      const ev = result.events[0];
      assert.ok(ev.messageData instanceof Uint8Array);
      assert.equal(new TextDecoder().decode(ev.messageData), 'hello');
      assert.equal(ev.payload, undefined);
    });
  });

  await t.test('inner text content used as payload when no @messageData', () => {
    const doc = makeEventDoc({ presentationTime: '0' }, 'my payload');
    withDoc(doc, () => {
      const result = parseEventStreamXml(enc('<x/>'), defaultCtx(), 0);
      const ev = result.events[0];
      assert.equal(ev.payload, 'my payload');
      assert.equal(ev.messageData, undefined);
    });
  });

  await t.test('uniqueKey is stable and contains all discriminating fields', () => {
    const ctx = defaultCtx({ schemeIdUri: 'urn:s', value: 'v', timescale: 1 });
    const doc1 = makeEventDoc({ presentationTime: '10', id: '3' });
    const doc2 = makeEventDoc({ presentationTime: '10', id: '3' });
    let key1: string, key2: string;
    withDoc(doc1, () => { key1 = parseEventStreamXml(enc('<x/>'), ctx, 0).events[0].uniqueKey; });
    withDoc(doc2, () => { key2 = parseEventStreamXml(enc('<x/>'), ctx, 0).events[0].uniqueKey; });
    assert.equal(key1!, key2!);
    assert.ok(key1!.includes('urn:s'));
  });

  await t.test('XML parse error returns empty events and original context', () => {
    const warnings: string[] = [];
    const orig = console.warn;
    console.warn = (...a: unknown[]) => warnings.push(String(a[0]));
    try {
      // _nextDoc is null → DOMParser returns MockErrorDocument
      const ctx = defaultCtx({ schemeIdUri: 'urn:safe' });
      const result = parseEventStreamXml(enc('<<not xml>>'), ctx, 0);
      assert.equal(result.events.length, 0);
      assert.equal(result.context.schemeIdUri, 'urn:safe');
      assert.ok(warnings.some(w => w.includes('XML parse error')));
    } finally {
      console.warn = orig;
    }
  });

  await t.test('missing optional attributes use sensible defaults', () => {
    // no presentationTime, no duration, no id
    const doc = makeEventDoc({});
    withDoc(doc, () => {
      const result = parseEventStreamXml(enc('<x/>'), defaultCtx(), 0);
      const ev = result.events[0];
      assert.equal(ev.presentationTime, 0);
      assert.equal(ev.duration, 0);
      assert.equal(ev.id, undefined);
    });
  });
});
