import Anthropic from '@anthropic-ai/sdk';
import { TIER_ORDER } from './models.js';
import { shouldRetry, nextTier } from './retry.js';
import { normalizeParamsForTier } from './params.js';
import type { Tier } from './types.js';

/**
 * The routing execution kernel, shared by all four routed paths: the library's
 * `ClaudeRouter.send`/`stream` and the proxy's `handleNonStreaming`/
 * `handleStreaming`. Given a chosen tier it validates the tier, resolves its
 * model and normalizes the request for that model — and, for the non-streaming
 * entry, calls the API, optionally walks up on rate limits, and escalates once
 * if the response is truncated or a refusal.
 *
 * Keeping this in one module is what makes routing semantics consistent across
 * the callers — before, each re-implemented the loop and they had already
 * drifted on the escalation condition.
 *
 * Retry is deliberately non-streaming only: there is no retry once bytes have
 * flowed. That is why {@link startRouteStream} stops after opening the stream
 * rather than sharing `executeRoute`'s loop. What it does share is everything
 * *before* the call — which the two streaming callers used to re-implement, with
 * `stream()` growing a second unknown-tier `TypeError` that read its expected
 * tiers from a different source than this one.
 */

/** The SDK's streaming handle, derived from the client surface rather than a
 * deep `lib/` import — internal SDK layout is not a stable export. */
export type MessageStream = ReturnType<Anthropic['messages']['stream']>;

/**
 * A tier outside TIER_ORDER would otherwise reach the API as `model: undefined`
 * — fail loudly at the seam instead.
 */
function unknownTierError(tier: string): TypeError {
  return new TypeError(
    `[claude-router] Unknown tier "${tier}" — expected one of: ${TIER_ORDER.join(', ')}`,
  );
}

export interface RouteResult {
  response: Anthropic.Message;
  tier: Tier;
  model: string;
  /** True if the served tier differs from the classified one (rate-limit walk-up or escalation). */
  fallbackUsed: boolean;
  retried: boolean;
  retryReason: 'truncation' | 'refusal' | null;
}

export interface ExecuteRouteOptions {
  /** Walk up `TIER_ORDER` on a `RateLimitError` instead of throwing. */
  fallbackOnRateLimit: boolean;
  /** Per-request SDK options forwarded to every create call (e.g. the anthropic-beta header). */
  requestOptions?: { headers: Record<string, string> };
}

export interface StreamRouteResult {
  /** The real SDK stream: `for await`, `.on()` chaining, `.finalMessage()` all work. */
  stream: MessageStream;
  tier: Tier;
  model: string;
}

/**
 * Open a stream on the given tier: validate, resolve the model, normalize for
 * it, call `messages.stream`. Returns the untouched SDK handle — the caller owns
 * consumption, and there is no retry once bytes flow.
 *
 * The resolved `tier`/`model` come back so callers record and report what was
 * actually sent rather than re-deriving it alongside.
 */
export function startRouteStream(
  client: Anthropic,
  apiParams: Record<string, unknown>,
  tier: Tier,
  models: Record<Tier, string>,
  opts: { requestOptions?: { headers: Record<string, string> } } = {},
): StreamRouteResult {
  if (TIER_ORDER.indexOf(tier) < 0) throw unknownTierError(tier);
  const model = models[tier];

  const stream = client.messages.stream(
    normalizeParamsForTier({ ...apiParams, model }, tier) as Anthropic.MessageStreamParams,
    opts.requestOptions,
  );

  return { stream, tier, model };
}

export async function executeRoute(
  client: Anthropic,
  apiParams: Record<string, unknown>,
  startTier: Tier,
  models: Record<Tier, string>,
  opts: ExecuteRouteOptions,
): Promise<RouteResult> {
  const startIndex = TIER_ORDER.indexOf(startTier);
  // An unknown tier would start the loop at -1 and send `model: undefined`.
  if (startIndex < 0) throw unknownTierError(startTier);
  let lastError: unknown;

  for (let i = startIndex; i < TIER_ORDER.length; i++) {
    const tier = TIER_ORDER[i]!;
    const model = models[tier];
    const fallbackUsed = i !== startIndex;

    try {
      const response = await client.messages.create(
        normalizeParamsForTier({ ...apiParams, model }, tier) as Anthropic.MessageCreateParamsNonStreaming,
        opts.requestOptions,
      );

      // Escalate only on the originally-classified tier's first response — never
      // after a rate-limit walk-up, which has already moved us up a tier.
      const decision = shouldRetry(response, tier);
      if (decision.retry && !fallbackUsed) {
        const escalated = nextTier(tier);
        if (escalated) {
          const escalatedModel = models[escalated];
          // Escalation is best-effort: if the escalated call fails (e.g. its
          // tier is rate-limited), serve the truncated/refused-but-real original
          // rather than letting the error escape into the outer catch, where a
          // RateLimitError would discard the response we already have and
          // re-walk the tiers.
          try {
            const retryResponse = await client.messages.create(
              normalizeParamsForTier(
                { ...apiParams, model: escalatedModel },
                escalated,
              ) as Anthropic.MessageCreateParamsNonStreaming,
              opts.requestOptions,
            );
            return {
              response: retryResponse,
              tier: escalated,
              model: escalatedModel,
              fallbackUsed: true,
              retried: true,
              retryReason: decision.reason,
            };
          } catch {
            return { response, tier, model, fallbackUsed, retried: false, retryReason: null };
          }
        }
      }

      return { response, tier, model, fallbackUsed, retried: false, retryReason: null };
    } catch (err) {
      lastError = err;
      if (
        opts.fallbackOnRateLimit &&
        err instanceof Anthropic.RateLimitError &&
        i < TIER_ORDER.length - 1
      ) {
        continue;
      }
      throw err;
    }
  }

  throw lastError ?? new Error('[claude-router] executeRoute exhausted all tiers without a response');
}
