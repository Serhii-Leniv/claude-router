import type Anthropic from '@anthropic-ai/sdk';
import type { ModelPricing, Tier } from './types.js';

export const DEFAULT_MODELS: Record<Tier, string> = {
  haiku: 'claude-haiku-4-5',
  sonnet: 'claude-sonnet-5',
  opus: 'claude-opus-4-8',
  fable: 'claude-fable-5',
};

// NOTE: Bedrock inference-profile IDs vary by account/region and Anthropic's
// snapshot naming — verify these against your Bedrock console if routing 400s.
// Pricing is unaffected (resolved by family in priceForModel).
export const BEDROCK_MODELS: Record<Tier, string> = {
  haiku:  'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  sonnet: 'us.anthropic.claude-sonnet-5-v1:0',
  opus:   'us.anthropic.claude-opus-4-8-v1:0',
  // Fable's availability and inference-profile ID on Bedrock are unverified, so
  // the fable tier resolves to Opus here rather than risking a 404. Fable
  // routing is opt-in and off by default, so this is inert unless enabled.
  fable:  'us.anthropic.claude-opus-4-8-v1:0',
};

export const VERTEX_MODELS: Record<Tier, string> = {
  haiku:  'claude-haiku-4-5',
  sonnet: 'claude-sonnet-5',
  opus:   'claude-opus-4-8',
  // Same reasoning as Bedrock above.
  fable:  'claude-opus-4-8',
};

/**
 * Current-generation Claude pricing ($ per 1M tokens), keyed by tier/family.
 * Verified against platform.claude.com pricing (last checked 2026-07-17):
 *   Haiku 4.5 — $1.00 / $5.00
 *   Sonnet 5  — $3.00 / $15.00 standard (intro $2.00 / $10.00 through 2026-08-31)
 *   Opus 4.6/4.7/4.8 — $5.00 / $25.00  (note: NOT the old $15/$75 of Opus 4.0/4.1)
 *
 *   Fable 5  — $10.00 / $50.00 (2x Opus; the most expensive routable tier)
 *
 * We price Sonnet at the standard rate so savings math stays stable when the
 * intro discount ends.
 *
 * Pricing drift here silently corrupts every `savedCents` figure the router
 * reports — keep this in sync when a new generation ships, and rely on the
 * family fallback in `priceForModel` to cover Bedrock/Vertex/dated IDs.
 */
export const FAMILY_PRICING: Record<Tier, ModelPricing> = {
  haiku:  { input: 1.00, output: 5.00 },
  sonnet: { input: 3.00, output: 15.00 },
  opus:   { input: 5.00, output: 25.00 },
  fable:  { input: 10.00, output: 50.00 },
};

/** Old-generation Opus (4.0, 4.1) — 3x the current Opus family rate. */
const LEGACY_OPUS: ModelPricing = { input: 15.00, output: 75.00 };

/**
 * Models whose price does NOT follow their family default. Each exact entry is
 * the only thing standing between that model and a wrong cost figure — two
 * distinct failure modes:
 *
 *  - **Legacy Opus** (4.0, 4.1) family-matches to the *current* Opus price, so
 *    the fallback understates every call by 3x.
 *  - **Mythos 5** matches no family at all (`familyForModel` has no substring to
 *    key on), so the fallback prices it at *nothing* — see `warnIfUnpriced` for
 *    what happens when a model reaches that state. Fable 5 no longer needs an
 *    entry here: it is a tier now, so the family fallback resolves it.
 *
 * Every entry here must genuinely diverge from its family (or have no family);
 * `models.test.ts` asserts that, so a redundant entry fails the build rather
 * than quietly rotting. Keeping the divergent set as its own exported table is
 * also what lets that test derive its exclusions instead of hand-maintaining a
 * parallel list that silently drifts.
 */
export const DIVERGENT_PRICING: Record<string, ModelPricing> = {
  'claude-opus-4-1': LEGACY_OPUS,
  'claude-opus-4-1-20250805': LEGACY_OPUS,
  'claude-opus-4-0': LEGACY_OPUS,
  'claude-opus-4-20250514': LEGACY_OPUS,
  // Same price as the fable tier, but no substring for familyForModel to match.
  'claude-mythos-5': FAMILY_PRICING.fable,
};

/** IDs that price at their family default. Listed for clarity, not necessity —
 * `priceForModel`'s family fallback would resolve each of these anyway. */
const FAMILY_DERIVED_PRICING: Record<string, ModelPricing> = {
  'claude-haiku-4-5': FAMILY_PRICING.haiku,
  'claude-haiku-4-5-20251001': FAMILY_PRICING.haiku,
  'claude-sonnet-5': FAMILY_PRICING.sonnet,
  'claude-sonnet-4-6': FAMILY_PRICING.sonnet,
  'claude-opus-4-8': FAMILY_PRICING.opus,
  'claude-opus-4-7': FAMILY_PRICING.opus,
  'claude-opus-4-6': FAMILY_PRICING.opus,
  'claude-fable-5': FAMILY_PRICING.fable,
};

/**
 * Pricing keyed by exact model ID. Any first-party, Bedrock, or Vertex ID not
 * listed here is resolved by family in `priceForModel` — so a newly-dated
 * snapshot still prices right.
 */
export const DEFAULT_PRICING: Record<string, ModelPricing> = {
  ...FAMILY_DERIVED_PRICING,
  ...DIVERGENT_PRICING,
};

export const TIER_ORDER: Tier[] = ['haiku', 'sonnet', 'opus', 'fable'];

/**
 * The fixed label set for a per-tier breakdown: every tier, plus `passthrough`
 * for requests that bypassed routing. `RouteTotals.tiers` carries only labels
 * actually seen, so consumers that render a stable set (the dashboard bars,
 * `claude-router stats`) zero-fill from this via `tierBreakdown`.
 *
 * Derived from TIER_ORDER on purpose: both consumers used to spell the list out
 * by hand and both had gone stale, omitting `fable` — a fable route was folded
 * into the totals and then rendered nowhere, and it was excluded from the bar
 * chart's own percentage denominator.
 */
export const DISPLAY_TIERS = [...TIER_ORDER, 'passthrough'] as const;
export type DisplayTier = (typeof DISPLAY_TIERS)[number];

/**
 * Automatic escalation stops here. Fable is 2x opus, and the triggers that would
 * reach it — truncation and refusal — have never fired on real traffic
 * (`research/2026-07-21-detector-measurement.md`: 0 of 35,314 responses). Paying
 * 2x on a signal with no observed activations is not a trade worth making
 * silently. Fable stays reachable by classification (opt-in) and by an explicit
 * tier pin, just not by the retry path.
 */
export const ESCALATION_CEILING: Tier = 'opus';

/**
 * Map any Claude model ID (first-party, Bedrock `us.anthropic.*`, Vertex,
 * dated snapshot, or `auto`) to its tier by family name. Returns undefined for
 * non-Claude IDs.
 */
export function familyForModel(model: string): Tier | undefined {
  const m = model.toLowerCase();
  if (m.includes('haiku')) return 'haiku';
  if (m.includes('sonnet')) return 'sonnet';
  if (m.includes('opus')) return 'opus';
  if (m.includes('fable')) return 'fable';
  return undefined;
}

/**
 * Resolve pricing for a model: exact match first (so user overrides win), then
 * fall back to the model's family. This keeps savings math correct across
 * providers and across newly-released dated snapshots without a code change.
 */
export function priceForModel(
  model: string,
  pricing: Record<string, ModelPricing>,
): ModelPricing | undefined {
  if (pricing[model]) return pricing[model];
  const fam = familyForModel(model);
  if (!fam) return undefined;
  // Honor a user override that targets the family's default model ID, else the
  // canonical family price.
  return pricing[DEFAULT_MODELS[fam]] ?? FAMILY_PRICING[fam];
}

/**
 * Prompt-cache pricing multipliers (fractions of the model's input rate):
 * cache reads bill at 10%, cache writes (5-minute TTL) at 125%.
 * Claude Code uses caching heavily — ignoring these understates every cost.
 */
export const CACHE_READ_RATE = 0.1;
export const CACHE_WRITE_RATE = 1.25;

export interface CacheTokens {
  readTokens?: number;
  creationTokens?: number;
}

/** Sink for library warnings. Defaults to `console.warn` everywhere it's accepted. */
export type WarnFn = (message: string) => void;

// Models we've already warned about, so a hot request path warns once, not per call.
// Deliberately module-global: dedup across router instances is fine — the sink
// itself is per-call so two instances with different loggers never fight.
const warnedUnpriced = new Set<string>();

/** @internal Test hook */
export function resetUnpricedWarnings(): void {
  warnedUnpriced.clear();
}

/**
 * An unpriced model is the router's worst failure mode: the cost is not zero,
 * we just don't know it, and a product whose whole pitch is "here is what you
 * saved" reporting $0.00 reads as a slow week rather than a bug. Callers get the
 * machine-readable signal via `RouteCost.priced`; this is the human one.
 */
function warnIfUnpriced(model: string, priced: boolean, warn: WarnFn = console.warn): void {
  if (priced || warnedUnpriced.has(model)) return;
  warnedUnpriced.add(model);
  warn(
    `[claude-router] No pricing for "${model}" — its cost and savings are reported as 0, ` +
      `not measured. Add a "pricing" entry for it in ~/.claude-router/config.json.`,
  );
}

/**
 * Cost in cents for a token count. Returns 0 for a model with no resolvable
 * price — deliberately side-effect-free, so it stays a pure math function. The
 * "we don't know this model" signal is raised by `computeRouteCost`, which is
 * the path every routed call takes and the one that knows the baseline too.
 */
export function computeCostCents(
  model: string,
  inputTokens: number,
  outputTokens: number,
  pricing: Record<string, ModelPricing>,
  cache?: CacheTokens,
): number {
  const p = priceForModel(model, pricing);
  if (!p) return 0;
  const cacheCost =
    (cache?.readTokens ?? 0) * p.input * CACHE_READ_RATE +
    (cache?.creationTokens ?? 0) * p.input * CACHE_WRITE_RATE;
  return ((inputTokens * p.input + outputTokens * p.output + cacheCost) / 1_000_000) * 100;
}

export function tierForModel(
  model: string,
  tiers: Record<Tier, string>,
): Tier | undefined {
  for (const [tier, modelId] of Object.entries(tiers)) {
    if (modelId === model) return tier as Tier;
  }
  return undefined;
}

/** Cost of a routed call plus its savings vs a baseline model, rounded and cache-aware. */
export interface RouteCost {
  costCents: number;
  savedCents: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  inputTokens: number;
  outputTokens: number;
  /**
   * False when `costCents`/`savedCents` are placeholder zeros rather than
   * measured figures — i.e. the routed model, the baseline model, or both
   * resolved to no price. Both are included because an unpriced baseline makes
   * `savedCents` just as wrong as an unpriced routed model (it reports the
   * negative of the cost). Consumers must render these figures as "unknown",
   * not as $0.00; see `RouteTotals.unpricedModels`.
   */
  priced: boolean;
}

/**
 * Cost + savings for a completed response, including prompt-cache tokens. Shared
 * by the library (`RouteMeta`) and the proxy (`RouteEvent`) so both price a call
 * the same way. `savedCents` is `baseline − actual` and can be negative.
 *
 * `usage` may be missing/partial on an unexpected response shape — guard every
 * field so a routing proxy never crashes on cost math. The resolved token counts
 * are returned so callers record the same guarded values they priced.
 */
export function computeRouteCost(
  model: string,
  usage: Anthropic.Usage | undefined,
  defaultModel: string,
  pricing: Record<string, ModelPricing>,
  warn: WarnFn = console.warn,
): RouteCost {
  const inputTokens = usage?.input_tokens ?? 0;
  const outputTokens = usage?.output_tokens ?? 0;
  const cache = {
    readTokens: usage?.cache_read_input_tokens ?? 0,
    creationTokens: usage?.cache_creation_input_tokens ?? 0,
  };
  const cost = computeCostCents(model, inputTokens, outputTokens, pricing, cache);
  const baseline = computeCostCents(defaultModel, inputTokens, outputTokens, pricing, cache);

  const modelPriced = priceForModel(model, pricing) !== undefined;
  const baselinePriced = priceForModel(defaultModel, pricing) !== undefined;
  warnIfUnpriced(model, modelPriced, warn);
  warnIfUnpriced(defaultModel, baselinePriced, warn);

  return {
    costCents: Math.round(cost * 1000) / 1000,
    savedCents: Math.round((baseline - cost) * 1000) / 1000,
    cacheReadTokens: cache.readTokens,
    cacheCreationTokens: cache.creationTokens,
    inputTokens,
    outputTokens,
    priced: modelPriced && baselinePriced,
  };
}

/** The cost and token fields a route outcome record carries, plus the `priced` flag. */
export interface RouteCostFields {
  costCents: number;
  savedCents: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  inputTokens: number;
  outputTokens: number;
  priced?: false;
}

/**
 * Shape a {@link RouteCost} into the fields every route outcome record carries.
 *
 * The library's `RouteMeta` and the proxy's `RouteEvent` are different records,
 * but the step from priced call to recorded figures is the same one — and it
 * used to be written out longhand at four sites (`index.buildMeta`, plus the
 * non-streaming, streaming-success and streaming-error paths in the proxy
 * handler), which is how `priced` and the cache-token fields drifted between
 * them. One place to change means one place to get it wrong.
 *
 * `priced` is emitted **only when false**: absent means priced, so history lines
 * written before the flag existed keep counting as measured.
 */
export function costFields(cost: RouteCost): RouteCostFields {
  const {
    costCents,
    savedCents,
    cacheReadTokens,
    cacheCreationTokens,
    inputTokens,
    outputTokens,
    priced,
  } = cost;
  return {
    costCents,
    savedCents,
    cacheReadTokens,
    cacheCreationTokens,
    inputTokens,
    outputTokens,
    ...(priced ? {} : { priced: false as const }),
  };
}
