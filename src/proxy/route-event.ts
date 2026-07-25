import { costFields, type RouteCost } from '../models.js';
import type { ClassifyResult, Tier } from '../types.js';

/**
 * The proxy's route outcome record — one line of `history.jsonl`, one row of the
 * dashboard, one fold into `RouteTotals`.
 *
 * It lives here rather than in `handler.ts` because four modules (`history`,
 * `dashboard`, `health`, `server`) need the shape and none of them needs the
 * request handler. With the type declared inside the handler, the 617-line file
 * that answers HTTP requests was also the type root for the whole proxy subtree.
 *
 * Construction goes through {@link buildRouteEvent} / {@link errorRouteEvent} so
 * the record is assembled once. The non-streaming path, the streaming success
 * path and the streaming error path each used to spell all fourteen fields out
 * inline, and they had already diverged: the streaming paths hardcoded
 * `retried: false` and none of the three carried the classifier timing that the
 * `x-router-classifier-ms` header reports.
 */
export interface RouteEvent {
  timestamp: string;
  tier: Tier | 'passthrough';
  model: string;
  costCents: number;
  savedCents: number;
  confidence: number;
  classifier: string;
  /** Classifier overhead in ms — the same figure `x-router-classifier-ms` reports. */
  classifierMs?: number;
  retried: boolean;
  retryReason: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  /**
   * Set to false when `costCents`/`savedCents` are placeholder zeros because the
   * model has no known price. Absent means priced — history.jsonl lines written
   * before this field existed must keep counting as measured.
   */
  priced?: boolean;
  /**
   * Set when the request failed mid-flight (stream died after headers were
   * sent). `foldOutcome` counts such events only toward `RouteTotals.errors` —
   * their zeros are placeholders, not measurements.
   */
  error?: string;
}

export interface RouteEventInput {
  tier: Tier;
  model: string;
  cost: RouteCost;
  classifyResult: ClassifyResult;
  retried?: boolean;
  retryReason?: string | null;
}

/** Record of one completed routed call. */
export function buildRouteEvent(input: RouteEventInput): RouteEvent {
  const { tier, model, cost, classifyResult, retried = false, retryReason = null } = input;
  return {
    timestamp: new Date().toISOString(),
    tier,
    model,
    confidence: classifyResult.confidence,
    classifier: classifyResult.method,
    classifierMs: classifyResult.ms,
    retried,
    retryReason,
    ...costFields(cost),
  };
}

/**
 * Record of a request that died after its headers were committed. The money and
 * token figures are placeholder zeros, and `error` is what keeps them out of the
 * totals — `foldOutcome` counts this only toward `RouteTotals.errors`, so a
 * failure never reads as a $0.00 success.
 */
export function errorRouteEvent(input: {
  tier: Tier;
  model: string;
  classifyResult: ClassifyResult;
  error: unknown;
}): RouteEvent {
  const { tier, model, classifyResult, error } = input;
  return {
    timestamp: new Date().toISOString(),
    tier,
    model,
    costCents: 0,
    savedCents: 0,
    confidence: classifyResult.confidence,
    classifier: classifyResult.method,
    classifierMs: classifyResult.ms,
    retried: false,
    retryReason: null,
    inputTokens: 0,
    outputTokens: 0,
    error: String(error).slice(0, 200),
  };
}
