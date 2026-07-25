import Anthropic from '@anthropic-ai/sdk';
import {
  classify,
  DEFAULT_CLASSIFY_CACHE_SIZE,
} from './classifier.js';
import { LruCache } from './cache.js';
import {
  DEFAULT_MODELS,
  DEFAULT_PRICING,
  computeRouteCost,
  costFields,
  type WarnFn,
} from './models.js';
import { CostTracker } from './tracker.js';
import { executeRoute, startRouteStream, type MessageStream } from './route.js';
import { warnDeadRoutingKeys } from './routing.js';
import type {
  ClassifyInput,
  ClassifyResult,
  ModelPricing,
  RoutedMessage,
  RouteMeta,
  RouterConfig,
  RouterStats,
  RoutingTuning,
  Tier,
} from './types.js';

interface ResolvedConfig {
  apiKey: string;
  defaultModel: string;
  classifier: 'heuristic' | 'ai' | 'hybrid';
  tiers: Record<Tier, string>;
  pricing: Record<string, ModelPricing>;
  fallback: boolean;
  verbose: boolean;
  routing: RoutingTuning;
  warn: WarnFn;
}

/** Re-exported from the routing kernel, which owns the streaming entry point. */
export type { MessageStream } from './route.js';

export interface StreamResult {
  /** The real SDK stream: `for await`, `.on()` chaining, `.finalMessage()` all work. */
  stream: MessageStream;
  /**
   * Resolves once the stream completes and the route is priced/recorded.
   * Rejects if the stream errors — pre-marked as handled, so ignoring it
   * cannot crash the host process; awaiting it still surfaces the error.
   */
  meta: Promise<RouteMeta>;
}

type SendParams = Omit<Anthropic.MessageCreateParamsNonStreaming, 'model'> & {
  tier?: Tier;
};

type StreamParams = Omit<
  Anthropic.MessageStreamParams,
  'model'
> & {
  tier?: Tier;
};

function resolveConfig(config: RouterConfig): ResolvedConfig {
  // Resolve the warn sink before anything that might warn.
  const warn: WarnFn = config.logger
    ? config.logger.warn.bind(config.logger)
    : console.warn;
  warnDeadRoutingKeys(config.routing as Record<string, unknown> | undefined, warn);
  const tiers: Record<Tier, string> = {
    haiku: config.tiers?.haiku ?? DEFAULT_MODELS.haiku,
    sonnet: config.tiers?.sonnet ?? DEFAULT_MODELS.sonnet,
    opus: config.tiers?.opus ?? DEFAULT_MODELS.opus,
    fable: config.tiers?.fable ?? DEFAULT_MODELS.fable,
  };

  return {
    apiKey: config.apiKey,
    defaultModel: config.defaultModel ?? tiers.sonnet,
    classifier: config.classifier ?? 'hybrid',
    tiers,
    pricing: { ...DEFAULT_PRICING, ...config.pricing },
    fallback: config.fallback ?? true,
    verbose: config.verbose ?? false,
    routing: config.routing ?? {},
    warn,
  };
}

/**
 * The synthetic classification for an explicitly pinned tier: no classifier ran,
 * so there is no method, timing or uncertainty to report. `send` and `stream`
 * both need it and had drifted into two spellings of the same five fields.
 */
function forcedClassification(tier: Tier): ClassifyResult {
  return { tier, score: -1, method: 'heuristic', ms: 0, confidence: 1.0 };
}

function buildClassifyInput(
  params: SendParams | StreamParams,
): ClassifyInput {
  const system = params.system;
  let systemInput: ClassifyInput['system'];
  if (typeof system === 'string') {
    systemInput = system;
  } else if (Array.isArray(system)) {
    systemInput = system.filter(
      (b): b is Anthropic.TextBlockParam =>
        'type' in b && b.type === 'text',
    );
  }

  return {
    messages: params.messages,
    system: systemInput,
    tools: (params as { tools?: unknown[] }).tools,
  };
}

export class ClaudeRouter {
  /** @internal Exposed for testing — do not depend on this. */
  _client: Anthropic;
  private config: ResolvedConfig;
  private tracker: CostTracker;
  private classifyCache: LruCache<string, ClassifyResult>;

  constructor(config: RouterConfig) {
    this.config = resolveConfig(config);
    this._client = new Anthropic({ apiKey: this.config.apiKey });
    this.tracker = new CostTracker();
    this.classifyCache = new LruCache(
      this.config.routing.classifyCacheSize ?? DEFAULT_CLASSIFY_CACHE_SIZE,
    );
  }

  private async classify(input: ClassifyInput): Promise<ClassifyResult> {
    return classify(
      this._client,
      input,
      this.config.classifier,
      this.config.tiers.haiku,
      { ...this.config.routing, cache: this.classifyCache },
    );
  }

  private buildMeta(
    tier: Tier,
    model: string,
    usage: Anthropic.Usage,
    classifyResult: ClassifyResult,
    fallbackUsed: boolean,
    retried: boolean = false,
    retryReason: string | null = null,
  ): RouteMeta {
    const cost = computeRouteCost(model, usage, this.config.defaultModel, this.config.pricing, this.config.warn);

    return {
      tier,
      model,
      // `priced` is only carried when false — absent means priced. That rule and
      // the cache-token fields live in `costFields`, shared with the proxy's
      // RouteEvent so the two records cannot drift.
      ...costFields(cost),
      classifierMethod: classifyResult.method,
      classifierMs: classifyResult.ms,
      fallbackUsed,
      confidence: classifyResult.confidence,
      retried,
      retryReason,
    };
  }

  private log(meta: RouteMeta, classifyResult: ClassifyResult): void {
    if (!this.config.verbose) return;

    const fallbackNote = meta.fallbackUsed
      ? `, fallback from ${classifyResult.tier}`
      : '';
    // An unpriced model has no cost figure to report — printing "$0.0000" here
    // is exactly the lie this signal exists to stop.
    const money =
      meta.priced === false
        ? `cost: unknown (no pricing for ${meta.model})`
        : `cost: $${(meta.costCents / 100).toFixed(4)} | ${
            meta.savedCents >= 0
              ? `saved: $${(meta.savedCents / 100).toFixed(4)}`
              : `extra: $${(Math.abs(meta.savedCents) / 100).toFixed(4)}`
          } vs ${this.config.defaultModel}`;

    console.log(
      `[claude-router] → ${meta.tier} (${meta.classifierMethod}, ${meta.classifierMs}ms${fallbackNote}) | ${money}`,
    );
  }

  async send(params: SendParams): Promise<RoutedMessage> {
    const { tier: forcedTier, ...apiParams } = params;
    const input = buildClassifyInput(params);

    const classifyResult = forcedTier
      ? forcedClassification(forcedTier)
      : await this.classify(input);

    const result = await executeRoute(
      this._client,
      apiParams as Record<string, unknown>,
      classifyResult.tier,
      this.config.tiers,
      { fallbackOnRateLimit: this.config.fallback },
    );

    const meta = this.buildMeta(
      result.tier,
      result.model,
      result.response.usage,
      classifyResult,
      result.fallbackUsed,
      result.retried,
      result.retryReason,
    );

    this.tracker.record(meta);
    this.log(meta, classifyResult);

    const routed = result.response as RoutedMessage;
    routed.meta = meta;
    return routed;
  }

  /**
   * Classify first (awaited — `classify()` never throws by contract), then hand
   * back the real SDK `MessageStream` untouched. Streaming intentionally
   * bypasses `executeRoute`: there is no retry once bytes have flowed.
   */
  async stream(params: StreamParams): Promise<StreamResult> {
    const { tier: forcedTier, ...apiParams } = params;

    const classifyResult = forcedTier
      ? forcedClassification(forcedTier)
      : await this.classify(buildClassifyInput(params));

    // Same kernel as `send`, stopping before the retry loop. Tier validation,
    // model resolution and normalization used to be re-implemented here, and the
    // duplicate unknown-tier TypeError listed its expected tiers from the config
    // keys rather than from TIER_ORDER.
    const { stream, tier, model } = startRouteStream(
      this._client,
      apiParams as Record<string, unknown>,
      classifyResult.tier,
      this.config.tiers,
    );

    const meta = stream.finalMessage().then((finalMessage) => {
      const m = this.buildMeta(tier, model, finalMessage.usage, classifyResult, false);
      this.tracker.record(m);
      this.log(m, classifyResult);
      return m;
    });
    // Mark handled: a caller consuming only `stream` must not be able to crash
    // the host on a mid-stream error. `await meta` still sees the rejection.
    meta.catch(() => {});

    return { stream, meta };
  }

  stats(): RouterStats {
    return this.tracker.stats();
  }

  reset(): void {
    this.tracker.reset();
  }
}

export function createRouter(config: RouterConfig): ClaudeRouter {
  return new ClaudeRouter(config);
}

// Re-export types
export type {
  Tier,
  ModelPricing,
  RouterConfig,
  RouteMeta,
  RoutedMessage,
  RouterStats,
  RoutingTuning,
  ClassifyInput,
  ClassifyResult,
} from './types.js';

export { classifyHeuristic, classify } from './classifier.js';
// Routing is gate-based now. `heuristicScore`, `heuristicScoreDetailed`,
// `scoreToTier`, `scoreToConfidence` and `HEURISTIC_WEIGHTS` were the additive
// scorer's surface and are gone — there is no score to expose. Inspect a
// decision with `routeByEvidence`, which returns the tier, the gate that chose
// it, and a confidence.
export { routeByEvidence, isAgentic, isMidLoop, warnDeadRoutingKeys } from './routing.js';
export type { RouteDecision, RoutingOptions } from './routing.js';
export { shouldRetry, nextTier } from './retry.js';
export { normalizeParamsForTier } from './params.js';
export {
  DEFAULT_MODELS,
  DEFAULT_PRICING,
  FAMILY_PRICING,
  computeCostCents,
  priceForModel,
  familyForModel,
} from './models.js';
export { CostTracker } from './tracker.js';
