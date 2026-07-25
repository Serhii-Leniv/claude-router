import { describe, it } from 'node:test';
import assert from 'node:assert';
import { buildRouteEvent, errorRouteEvent } from '../proxy/route-event.js';
import { costFields, type RouteCost } from '../models.js';
import { emptyTotals, foldOutcome } from '../totals.js';
import type { ClassifyResult } from '../types.js';

const CLASSIFY: ClassifyResult = {
  tier: 'sonnet',
  score: -1,
  method: 'heuristic',
  ms: 7,
  confidence: 0.8,
};

function cost(overrides: Partial<RouteCost> = {}): RouteCost {
  return {
    costCents: 1.25,
    savedCents: 0.75,
    cacheReadTokens: 30,
    cacheCreationTokens: 10,
    inputTokens: 200,
    outputTokens: 100,
    priced: true,
    ...overrides,
  };
}

describe('costFields', () => {
  it('carries the cost and token figures through unchanged', () => {
    assert.deepEqual(costFields(cost()), {
      costCents: 1.25,
      savedCents: 0.75,
      cacheReadTokens: 30,
      cacheCreationTokens: 10,
      inputTokens: 200,
      outputTokens: 100,
    });
  });

  it('omits priced when the call was priced', () => {
    // Absent means priced. Writing `priced: true` would be harmless here but
    // would start appearing on every history line, and the field only exists to
    // mark the exception.
    assert.ok(!('priced' in costFields(cost())));
  });

  it('emits priced: false when the model or baseline had no price', () => {
    assert.equal(costFields(cost({ priced: false })).priced, false);
  });
});

describe('buildRouteEvent', () => {
  it('records the tier, model and priced figures of a completed call', () => {
    const e = buildRouteEvent({ tier: 'haiku', model: 'claude-haiku-4-5', cost: cost(), classifyResult: CLASSIFY });
    assert.equal(e.tier, 'haiku');
    assert.equal(e.model, 'claude-haiku-4-5');
    assert.equal(e.costCents, 1.25);
    assert.equal(e.savedCents, 0.75);
    assert.equal(e.cacheReadTokens, 30);
    assert.equal(e.cacheCreationTokens, 10);
    assert.ok(!('priced' in e), 'a priced call carries no priced field');
    assert.match(e.timestamp, /^\d{4}-\d{2}-\d{2}T/);
  });

  it('carries the classifier method and its timing', () => {
    // classifierMs reaches the x-router-classifier-ms header on every routed
    // response; before the record had one constructor it reached history on none.
    const e = buildRouteEvent({ tier: 'sonnet', model: 'm', cost: cost(), classifyResult: CLASSIFY });
    assert.equal(e.classifier, 'heuristic');
    assert.equal(e.classifierMs, 7);
    assert.equal(e.confidence, 0.8);
  });

  it('defaults to not-retried, and records an escalation when told', () => {
    const plain = buildRouteEvent({ tier: 'sonnet', model: 'm', cost: cost(), classifyResult: CLASSIFY });
    assert.equal(plain.retried, false);
    assert.equal(plain.retryReason, null);

    const escalated = buildRouteEvent({
      tier: 'opus',
      model: 'm',
      cost: cost(),
      classifyResult: CLASSIFY,
      retried: true,
      retryReason: 'truncation',
    });
    assert.equal(escalated.retried, true);
    assert.equal(escalated.retryReason, 'truncation');
  });

  it('marks an unpriced call so the totals can exclude it', () => {
    const e = buildRouteEvent({
      tier: 'sonnet',
      model: 'some-future-model',
      cost: cost({ priced: false, costCents: 0, savedCents: 0 }),
      classifyResult: CLASSIFY,
    });
    assert.equal(e.priced, false);

    const totals = emptyTotals();
    foldOutcome(totals, e);
    assert.deepEqual(totals.unpricedModels, { 'some-future-model': 1 });
  });
});

describe('errorRouteEvent', () => {
  it('zeroes the money figures and truncates the error text', () => {
    const e = errorRouteEvent({
      tier: 'sonnet',
      model: 'claude-sonnet-5',
      classifyResult: CLASSIFY,
      error: new Error('x'.repeat(500)),
    });
    assert.equal(e.costCents, 0);
    assert.equal(e.savedCents, 0);
    assert.equal(e.inputTokens, 0);
    assert.equal(e.outputTokens, 0);
    assert.equal(e.error?.length, 200);
  });

  it('counts only toward errors — a dead stream is not a $0.00 success', () => {
    const totals = emptyTotals();
    foldOutcome(totals, errorRouteEvent({ tier: 'sonnet', model: 'm', classifyResult: CLASSIFY, error: 'boom' }));
    assert.equal(totals.errors, 1);
    assert.equal(totals.requests, 0);
    assert.deepEqual(totals.tiers, {});
  });
});
