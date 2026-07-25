import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { appendEvent, readLifetimeStats, resetHistoryCache } from '../proxy/history.js';
import type { RouteEvent } from '../proxy/route-event.js';

function makeEvent(overrides: Partial<RouteEvent> = {}): RouteEvent {
  return {
    timestamp: '2026-07-02T10:00:00.000Z',
    tier: 'haiku',
    model: 'claude-haiku-4-5',
    costCents: 0.1,
    savedCents: 0.3,
    confidence: 0.9,
    classifier: 'heuristic',
    retried: false,
    retryReason: null,
    inputTokens: 100,
    outputTokens: 50,
    ...overrides,
  };
}

function tempFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crouter-history-'));
  return path.join(dir, 'history.jsonl');
}

describe('history', () => {
  beforeEach(() => resetHistoryCache());

  it('appends and aggregates events', () => {
    const file = tempFile();
    appendEvent(file, makeEvent());
    appendEvent(file, makeEvent({ tier: 'opus', costCents: 2, savedCents: -1.5, retried: true, retryReason: 'truncation' }));

    const stats = readLifetimeStats(file);
    assert.equal(stats.requests, 2);
    assert.equal(Math.round(stats.costCents * 100) / 100, 2.1);
    assert.equal(Math.round(stats.savedCents * 100) / 100, -1.2);
    assert.equal(stats.retried, 1);
    assert.deepEqual(stats.tiers, { haiku: 1, opus: 1 });
    assert.equal(stats.byDay['2026-07-02']!.requests, 2);
  });

  it('missing file yields empty stats', () => {
    const stats = readLifetimeStats(path.join(os.tmpdir(), 'nope', 'missing.jsonl'));
    assert.equal(stats.requests, 0);
    assert.equal(stats.savedCents, 0);
  });

  it('reads appended events incrementally after a cached read', () => {
    const file = tempFile();
    appendEvent(file, makeEvent());
    assert.equal(readLifetimeStats(file).requests, 1);

    appendEvent(file, makeEvent({ timestamp: '2026-07-03T09:00:00.000Z', savedCents: 1 }));
    const stats = readLifetimeStats(file);
    assert.equal(stats.requests, 2);
    assert.equal(Math.round(stats.savedCents * 100) / 100, 1.3);
    assert.equal(Object.keys(stats.byDay).length, 2);
  });

  it('skips corrupt lines without losing valid ones', () => {
    const file = tempFile();
    appendEvent(file, makeEvent());
    fs.appendFileSync(file, 'this is not json\n{"also":"not an event"}\n', 'utf8');
    appendEvent(file, makeEvent({ savedCents: 0.5 }));

    const stats = readLifetimeStats(file);
    assert.equal(stats.requests, 2);
    assert.equal(Math.round(stats.savedCents * 100) / 100, 0.8);
  });

  it('appendEvent never throws on an unwritable path', () => {
    assert.doesNotThrow(() => appendEvent('\0invalid\0path', makeEvent()));
  });

  it('counts errored events apart from the money figures', () => {
    const file = tempFile();
    appendEvent(file, makeEvent());
    appendEvent(file, makeEvent({ error: 'stream died', costCents: 0, savedCents: 0 }));

    const stats = readLifetimeStats(file);
    assert.equal(stats.errors, 1);
    assert.equal(stats.requests, 1, 'errored event must not count as a completed request');
    assert.equal(Math.round(stats.costCents * 100) / 100, 0.1, 'placeholder zeros stay out of the totals');
    assert.deepEqual(stats.tiers, { haiku: 1 });
  });

  it('truncate-then-append refolds from zero (documented archival stance)', () => {
    const file = tempFile();
    appendEvent(file, makeEvent());
    appendEvent(file, makeEvent());
    assert.equal(readLifetimeStats(file).requests, 2);

    // User archives/deletes the ledger; the offset cache must self-invalidate
    // and totals restart from zero rather than serving stale figures.
    fs.writeFileSync(file, '', 'utf8');
    appendEvent(file, makeEvent({ savedCents: 2 }));

    const stats = readLifetimeStats(file);
    assert.equal(stats.requests, 1);
    assert.equal(Math.round(stats.savedCents * 100) / 100, 2);
  });

  it('legacy lines without an error field keep counting as measured', () => {
    const file = tempFile();
    // A pre-`error`-field line, written verbatim as an old version would have.
    const { error: _e, ...legacy } = makeEvent() as RouteEvent & { error?: string };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(legacy) + '\n', 'utf8');

    const stats = readLifetimeStats(file);
    assert.equal(stats.requests, 1);
    assert.equal(stats.errors, 0);
  });
});
