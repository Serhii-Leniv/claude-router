import type { Context } from 'hono';
import Anthropic from '@anthropic-ai/sdk';
import {
  classify as classifyUnified,
  DEFAULT_CLASSIFY_CACHE_SIZE,
} from '../classifier.js';
import { LruCache } from '../cache.js';
import {
  DEFAULT_PRICING,
  computeRouteCost,
} from '../models.js';
import { executeRoute, startRouteStream, type MessageStream } from '../route.js';
import { term } from './term.js';
import { appendEvent } from './history.js';
import { buildRouteEvent, errorRouteEvent, type RouteEvent } from './route-event.js';
import type { ClassifyInput, ClassifyResult, ModelPricing, RoutingTuning, Tier } from '../types.js';

export type Provider = 'anthropic' | 'bedrock' | 'vertex';

export interface HandlerConfig {
  classifier: 'heuristic' | 'ai' | 'hybrid';
  defaultModel: string;
  verbose: boolean;
  provider: Provider;
  models: Record<Tier, string>;
  forceRoute: boolean;
  /**
   * Pin the Claude Code coordinator session to this tier, bypassing the
   * classifier for it. The main interactive session sends NO x-claude-code-agent-id
   * header; only subagents Claude Code spawns do (gateway protocol). So a request
   * without that header is the coordinator — pinning it keeps a large context
   * window for the whole session (no early compaction) while subagents still
   * route by evidence. Only meaningful under forceRoute (otherwise the client's
   * pinned model already passes through). Undefined = classify every request.
   */
  sessionModel?: Tier;
  /** Pricing table for savings math (default: current-generation DEFAULT_PRICING) */
  pricing?: Record<string, ModelPricing>;
  /** Classifier thresholds/band/timeout/cache tuning */
  routing?: RoutingTuning;
  /** JSONL file for persistent route history (undefined = in-memory only) */
  historyFile?: string;
  /**
   * Where routed and passed-through requests actually go. Defaults to the real
   * API; override only to point at a stub. See `DEFAULT_UPSTREAM` for why this
   * is an explicit setting and never read from the environment.
   */
  upstream?: string;
}

export const MAX_HISTORY = 1000;
// Overshoot before trimming so the amortized cost of bounding the array is O(1)
// per event. `shift()` moved ~1000 elements on *every* request past the cap;
// splicing a whole batch at a high-water mark makes it one O(n) move per
// TRIM_BATCH inserts (~10x fewer element moves per event here). The array holds
// the most recent MAX_HISTORY..MAX_HISTORY+TRIM_BATCH events — every consumer
// (/health, /statusline, /dashboard, /api/last-route) reads it as a plain
// chronological array and tolerates the small overshoot; the newest event is
// always last.
const TRIM_BATCH = 100;
export const routeHistory: RouteEvent[] = [];

/** Bound `routeHistory` to ~MAX_HISTORY, trimming the oldest in batches.
 * Exported so the amortized-bound invariant can be tested directly. */
export function boundHistory(history: RouteEvent[]): void {
  if (history.length >= MAX_HISTORY + TRIM_BATCH) history.splice(0, TRIM_BATCH);
}

function recordEvent(event: RouteEvent, config?: HandlerConfig): void {
  routeHistory.push(event);
  boundHistory(routeHistory);
  if (config?.historyFile) appendEvent(config.historyFile, event);
}

/** Cost + savings for a completed response, including prompt-cache tokens.
 * `usage` may be missing/partial on an unexpected response shape — computeRouteCost
 * guards every field so cost math (and the event record built from it) can't crash. */
function computeCosts(model: string, usage: Anthropic.Usage | undefined, config: HandlerConfig) {
  return computeRouteCost(model, usage, config.defaultModel, config.pricing ?? DEFAULT_PRICING);
}

function buildClassifyInput(body: Record<string, unknown>): ClassifyInput {
  const messages = (body.messages ?? []) as Anthropic.MessageParam[];
  const system = body.system as string | Anthropic.TextBlockParam[] | undefined;

  let systemInput: ClassifyInput['system'];
  if (typeof system === 'string') {
    systemInput = system;
  } else if (Array.isArray(system)) {
    systemInput = system.filter(
      (b): b is Anthropic.TextBlockParam =>
        typeof b === 'object' && b !== null && 'type' in b && b.type === 'text',
    );
  }

  return { messages, system: systemInput, tools: body.tools as unknown[] | undefined };
}

// One classification cache per handler config (i.e. per proxy app instance)
const classifyCaches = new WeakMap<HandlerConfig, LruCache<string, ClassifyResult>>();

async function classify(
  client: Anthropic,
  input: ClassifyInput,
  config: HandlerConfig,
): Promise<ClassifyResult> {
  let cache = classifyCaches.get(config);
  if (!cache) {
    cache = new LruCache(config.routing?.classifyCacheSize ?? DEFAULT_CLASSIFY_CACHE_SIZE);
    classifyCaches.set(config, cache);
  }
  return classifyUnified(client, input, config.classifier, config.models.haiku, {
    ...config.routing,
    cache,
  });
}

function log(tier: Tier, model: string, classifyResult: ClassifyResult, costCents: number, savedCents: number, defaultModel: string, retried: boolean = false, retryReason: string | null = null, priced: boolean = true): void {
  // Without a price there is no cost figure to print — "$0.0000" would read as
  // a free call rather than an unmeasured one.
  const money = !priced
    ? term.yellow(`cost: unknown (no pricing for ${model})`)
    : `cost: $${(costCents / 100).toFixed(4)} | ${
        savedCents >= 0
          ? term.green(`saved: $${(savedCents / 100).toFixed(4)}`)
          : term.red(`extra: $${(Math.abs(savedCents) / 100).toFixed(4)}`)
      } ${term.dim(`vs ${defaultModel}`)}`;

  const retryNote = retried ? term.yellow(` [retried: ${retryReason}]`) : '';
  const cachedNote = classifyResult.cached ? ', cached' : '';

  console.log(
    `${term.dim('[claude-router]')} → ${term.tier(tier)} ${term.dim(`(${classifyResult.method}, ${classifyResult.ms}ms, conf:${classifyResult.confidence}${cachedNote})`)}${retryNote} | ${money}`,
  );
}

function setRouterHeaders(
  headers: Headers,
  tier: Tier,
  model: string,
  costCents: number,
  savedCents: number,
  classifyResult: ClassifyResult,
  retried: boolean = false,
  retryReason: string | null = null,
): void {
  headers.set('x-router-tier', tier);
  headers.set('x-router-model', model);
  headers.set('x-router-cost-cents', costCents.toFixed(3));
  headers.set('x-router-saved-cents', savedCents.toFixed(3));
  headers.set('x-router-classifier', classifyResult.method);
  headers.set('x-router-classifier-ms', classifyResult.ms.toString());
  headers.set('x-router-confidence', classifyResult.confidence.toString());
  if (retried) {
    headers.set('x-router-retried', 'true');
    headers.set('x-router-retry-reason', retryReason ?? '');
  }
}

/**
 * Create provider-specific client at startup.
 * Returns null for 'anthropic' — client is created per-request from x-api-key header.
 */
export async function createProviderClient(provider: Provider): Promise<Anthropic | null> {
  if (provider === 'bedrock') {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mod = await import('@anthropic-ai/bedrock-sdk' as any);
      const AnthropicBedrock = mod.default ?? mod.AnthropicBedrock;
      return new AnthropicBedrock({ timeout: CLIENT_TIMEOUT_MS }) as unknown as Anthropic;
    } catch {
      throw new Error(
        'Bedrock provider requires @anthropic-ai/bedrock-sdk.\nInstall it: npm install @anthropic-ai/bedrock-sdk\n' +
        'Also set: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION',
      );
    }
  }
  if (provider === 'vertex') {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mod = await import('@anthropic-ai/vertex-sdk' as any);
      const AnthropicVertex = mod.AnthropicVertex ?? mod.default;
      return new AnthropicVertex({
        projectId: process.env['ANTHROPIC_VERTEX_PROJECT_ID'] ?? '',
        region: process.env['ANTHROPIC_VERTEX_REGION'] ?? 'us-east5',
        timeout: CLIENT_TIMEOUT_MS,
      }) as unknown as Anthropic;
    } catch {
      throw new Error(
        'Vertex provider requires @anthropic-ai/vertex-sdk.\nInstall it: npm install @anthropic-ai/vertex-sdk\n' +
        'Also set: ANTHROPIC_VERTEX_PROJECT_ID, run: gcloud auth application-default login',
      );
    }
  }
  return null; // 'anthropic' — per-request client
}

// The SDK refuses a non-streaming create whose implied duration exceeds 10 min
// (expectedTimeout = 3600 * max_tokens / 128000 s), throwing a base AnthropicError.
// Claude Code sends large max_tokens on non-streaming requests, tripping that guard.
// The guard is skipped entirely once a CLIENT-level timeout is set (it only falls
// back to the guard when this._options.timeout is null), so any value suppresses it.
// 15 min clears the guard for the largest max_tokens while not pinning a dead
// connection open for an hour under load.
const CLIENT_TIMEOUT_MS = 15 * 60 * 1000;

// The real Anthropic API. Never read from the environment: once ANTHROPIC_BASE_URL
// points at this proxy (which is the whole point of installing it), inheriting it
// makes the proxy call itself in an infinite loop — routing AND the classifier's
// Haiku call both go back through here. That was the 0.2.1 bug.
//
// Configurable, but only explicitly (`--upstream`, `FileConfig.upstream`). An
// opt-in setting someone has to type cannot be inherited by accident, which is
// what made the env var dangerous. Overriding it is how the proxy gets exercised
// end to end without live credentials or spend — previously that required editing
// this line inside node_modules.
export const DEFAULT_UPSTREAM = 'https://api.anthropic.com';

// Reusing clients per credential preserves HTTP keep-alive connections to the API.
const MAX_CLIENT_CACHE = 100;
const clientCache = new LruCache<string, Anthropic>(MAX_CLIENT_CACHE);

export function getAnthropicClient(
  apiKey: string | undefined,
  bearerToken: string | null,
  upstream: string = DEFAULT_UPSTREAM,
): Anthropic {
  // Upstream is part of the cache key: a cached client carries its baseURL, so
  // keying on the credential alone would serve a client pointed at the wrong host.
  const key = `${upstream}\u0000${apiKey ? `k:${apiKey}` : `b:${bearerToken}`}`;
  let client = clientCache.get(key);
  if (!client) {
    client = apiKey
      ? new Anthropic({ apiKey, timeout: CLIENT_TIMEOUT_MS, baseURL: upstream })
      : new Anthropic({ authToken: bearerToken!, timeout: CLIENT_TIMEOUT_MS, baseURL: upstream });
    clientCache.set(key, client);
  }
  return client;
}

/** @internal Test hook */
export function clearClientCache(): void {
  clientCache.clear();
}

export async function handleMessages(
  c: Context,
  config: HandlerConfig,
  providerClient: Anthropic | null,
): Promise<Response> {
  let client: Anthropic;

  if (providerClient) {
    // Bedrock or Vertex — use singleton client, no x-api-key needed
    client = providerClient;
  } else {
    // Anthropic direct — accept x-api-key (API key) or Authorization: Bearer (Pro/Max subscription)
    const apiKey = c.req.header('x-api-key');
    const authHeader = c.req.header('authorization');
    const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

    if (!apiKey && !bearerToken) {
      return c.json(
        { error: { type: 'authentication_error', message: 'Missing x-api-key or Authorization header' } },
        401,
      );
    }

    client = getAnthropicClient(apiKey, bearerToken, config.upstream);
  }

  // Read once as text so passthrough can forward the exact client bytes
  const rawBody = await c.req.text();
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return c.json(
      { error: { type: 'invalid_request_error', message: 'Request body is not valid JSON' } },
      400,
    );
  }
  const isStreaming = body.stream === true;
  const requestedModel = body.model as string | undefined;

  // Passthrough only for Anthropic provider with explicit model (not "auto"), unless --force-route
  if (!config.forceRoute && config.provider === 'anthropic' && requestedModel && requestedModel !== 'auto') {
    return proxyPassthrough(c, rawBody, config.upstream ?? DEFAULT_UPSTREAM);
  }

  // Coordinator-session pin (Claude Code): a request WITHOUT x-claude-code-agent-id
  // is the main interactive session; subagents carry that header. When sessionModel
  // is set (and maps to a known tier), pin the coordinator to it and skip the
  // classifier entirely — subagents fall through to normal evidence routing. The
  // config-file value is trusted like `classifier`/`provider`, but a typo'd tier
  // has no `models[tier]` entry, so we degrade to classification rather than send
  // `model: undefined` to the API.
  //
  // The pin needs a second condition: **the request must carry tools.** Absence of
  // the agent-id header means "not a subagent", which is not the same as "the
  // coordinator's agent turn". Claude Code's meta-calls — session title, summary —
  // also arrive without it, and they are the `<session>…</session>` quoted-prompt
  // shape the classifier already routes cheap (29% of requests on the wire corpus;
  // see latestUserText in src/routing.ts). Pinning those charged opus rates to name
  // a session: measured in the sandbox against live Claude Code v2.1.220, the title
  // call went sonnet → opus the moment `--session-model opus` was on. Every real
  // coordinator turn ships Claude Code's tool set (165–217 tools observed); the
  // meta-calls ship none, so this is the same structural agentic/single-turn split
  // routing.ts already makes — no text is parsed. A genuinely tool-less coordinator
  // turn degrades to classification, which is the cheap path anyway.
  const isSubagent = c.req.header('x-claude-code-agent-id') != null;
  const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
  const pinTier = config.sessionModel;
  const classifyResult: ClassifyResult =
    pinTier && !isSubagent && hasTools && config.models[pinTier]
      ? { tier: pinTier, score: 0, method: 'pinned', ms: 0, confidence: 1, reason: 'session:coordinator-pinned' }
      : await classify(client, buildClassifyInput(body), config);

  // The tier's model is resolved inside the routing kernel, which is also where
  // an unknown tier is caught — resolving it here too gave the non-streaming
  // path a `model` argument it never read.
  const tier = classifyResult.tier;

  // Remove 'model' and 'stream' from body, we control them
  const { model: _m, stream: _s, ...apiParams } = body;

  // Forward the client's anthropic-beta header on routed calls. The SDK rebuilds the
  // request and would otherwise drop it, breaking beta features the body relies on
  // (e.g. context_management → "Extra inputs are not permitted").
  const anthropicBeta = c.req.header('anthropic-beta');

  if (isStreaming) {
    return handleStreaming(c, client, apiParams, tier, classifyResult, config, anthropicBeta);
  }

  return handleNonStreaming(c, client, apiParams, tier, classifyResult, config, anthropicBeta);
}

/** SDK request options that relay the client's anthropic-beta header, if any. */
function betaRequestOptions(anthropicBeta: string | undefined): { headers: Record<string, string> } | undefined {
  return anthropicBeta ? { headers: { 'anthropic-beta': anthropicBeta } } : undefined;
}

async function handleNonStreaming(
  c: Context,
  client: Anthropic,
  apiParams: Record<string, unknown>,
  tier: Tier,
  classifyResult: ClassifyResult,
  config: HandlerConfig,
  anthropicBeta?: string,
): Promise<Response> {
  const reqOpts = betaRequestOptions(anthropicBeta);
  try {
    // Proxy does not walk up on rate limits (a 429 surfaces to the client);
    // executeRoute still handles the truncation/refusal escalation and forwards
    // the anthropic-beta header on both the initial and any escalated call.
    const result = await executeRoute(client, apiParams, tier, config.models, {
      fallbackOnRateLimit: false,
      requestOptions: reqOpts,
    });

    const cost = computeCosts(result.model, result.response.usage, config);

    if (config.verbose) {
      log(result.tier, result.model, classifyResult, cost.costCents, cost.savedCents, config.defaultModel, result.retried, result.retryReason, cost.priced);
    }

    recordEvent(buildRouteEvent({
      tier: result.tier,
      model: result.model,
      cost,
      classifyResult,
      retried: result.retried,
      retryReason: result.retryReason,
    }), config);

    const headers = new Headers({ 'content-type': 'application/json' });
    setRouterHeaders(headers, result.tier, result.model, cost.costCents, cost.savedCents, classifyResult, result.retried, result.retryReason);

    return new Response(JSON.stringify(result.response), { status: 200, headers });
  } catch (err) {
    return apiErrorResponse(c, err);
  }
}

/**
 * Map an upstream/SDK error to a clean HTTP response — shared by the
 * non-streaming path and the pre-stream phase of the streaming path, so an auth
 * or validation failure gets the same status code whether or not the client
 * asked to stream. Rethrows anything it doesn't recognize.
 */
function apiErrorResponse(c: Context, err: unknown): Response {
  // Catch Anthropic API errors from any provider SDK (instanceof fails cross-bundle).
  // Gate on a numeric status: a connection failure is APIError-shaped but carries
  // status undefined, and passing that to c.json would silently produce a 200.
  if (err instanceof Error && 'status' in err && typeof (err as { status: unknown }).status === 'number') {
    const status = (err as { status: number }).status;
    return c.json({ error: { type: 'api_error', message: err.message } }, status as 400);
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return c.json({ error: { type: 'proxy_error', message: `Failed to reach upstream: ${err.message}` } }, 502);
  }
  // Non-API SDK errors (e.g. the client-side non-streaming timeout guard) are
  // AnthropicError without a status. Return a clean error instead of letting it
  // throw uncaught — that surfaced as an opaque 500 and leaked the connection.
  if (err instanceof Anthropic.AnthropicError) {
    return c.json({ error: { type: 'proxy_error', message: err.message } }, 500);
  }
  throw err;
}

async function handleStreaming(
  c: Context,
  client: Anthropic,
  apiParams: Record<string, unknown>,
  tier: Tier,
  classifyResult: ClassifyResult,
  config: HandlerConfig,
  anthropicBeta?: string,
): Promise<Response> {
  // Pre-stream phase: everything before the Response is committed. The SDK
  // rarely throws synchronously; the real pre-stream failures (401 auth,
  // 400 validation) surface on the first iterator pull — awaiting it here,
  // before any headers go out, lets them map to proper HTTP statuses exactly
  // like the non-streaming path instead of a `200 OK` carrying an error frame.
  let stream: MessageStream;
  let model: string;
  let iterator: AsyncIterator<Anthropic.MessageStreamEvent>;
  let first: IteratorResult<Anthropic.MessageStreamEvent>;
  try {
    // Same kernel the non-streaming path enters, stopping before the retry loop
    // — model resolution and parameter normalization were duplicated here.
    ({ stream, model } = startRouteStream(client, apiParams, tier, config.models, {
      requestOptions: betaRequestOptions(anthropicBeta),
    }));
    iterator = stream[Symbol.asyncIterator]();
    first = await iterator.next();
  } catch (err) {
    return apiErrorResponse(c, err);
  }

  const headers = new Headers({
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    'connection': 'keep-alive',
    'x-router-tier': tier,
    'x-router-model': model,
    'x-router-classifier': classifyResult.method,
    'x-router-classifier-ms': classifyResult.ms.toString(),
    'x-router-confidence': classifyResult.confidence.toString(),
  });

  const encoder = new TextEncoder();

  const readable = new ReadableStream({
    async start(controller) {
      try {
        for (let r = first; !r.done; r = await iterator.next()) {
          const event = r.value;
          const data = `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`;
          controller.enqueue(encoder.encode(data));
        }

        const finalMessage = await stream.finalMessage();
        const cost = computeCosts(model, finalMessage.usage, config);

        if (config.verbose) {
          log(tier, model, classifyResult, cost.costCents, cost.savedCents, config.defaultModel, false, null, cost.priced);
        }

        recordEvent(buildRouteEvent({ tier, model, cost, classifyResult }), config);

        controller.close();
      } catch (err) {
        // Headers are long gone — an SSE error frame is the only signal the
        // client can still receive. But the failure must not vanish from the
        // proxy's own books: record it so history/stats count it as an error
        // rather than showing nothing (or a $0.00 "success").
        const errorData = `event: error\ndata: ${JSON.stringify({ error: { message: String(err) } })}\n\n`;
        controller.enqueue(encoder.encode(errorData));
        if (config.verbose) {
          console.error(
            `${term.dim('[claude-router]')} ${term.red('stream error')} → ${tier} (${model}): ${String(err)}`,
          );
        }
        recordEvent(errorRouteEvent({ tier, model, classifyResult, error: err }), config);
        controller.close();
      }
    },
  });

  return new Response(readable, { status: 200, headers });
}

/**
 * Forward a non-routed endpoint (count_tokens, model listing, …) straight to the
 * Anthropic API, preserving the client's auth + beta headers. Routing only makes
 * sense for /v1/messages; every other endpoint the client needs must still reach
 * the origin, or Claude Code (and the VS Code extension) 404s on count_tokens.
 */
export async function handlePassthrough(
  c: Context,
  config: HandlerConfig,
): Promise<Response> {
  if (config.provider !== 'anthropic') {
    // ponytail: bedrock/vertex have no HTTP passthrough target; count_tokens there is rare.
    return c.json(
      { error: { type: 'not_found_error', message: `${c.req.path} is only proxied for the anthropic provider` } },
      404,
    );
  }

  const url = new URL(c.req.url);
  const headers = new Headers();
  c.req.raw.headers.forEach((value, key) => {
    // host/content-length are recomputed by fetch; forward everything else
    // (x-api-key, authorization, anthropic-version, anthropic-beta, …).
    if (key === 'host' || key === 'content-length') return;
    headers.set(key, value);
  });

  const method = c.req.method;
  const body = method === 'GET' || method === 'HEAD' ? undefined : await c.req.text();

  try {
    const response = await fetch((config.upstream ?? DEFAULT_UPSTREAM) + url.pathname + url.search, {
      method,
      headers,
      body,
    });
    const outHeaders = new Headers();
    response.headers.forEach((value, key) => outHeaders.set(key, value));
    outHeaders.delete('content-encoding');
    outHeaders.delete('content-length');
    outHeaders.set('x-router-tier', 'passthrough');
    return new Response(response.body, { status: response.status, headers: outHeaders });
  } catch (err) {
    return c.json(
      { error: { type: 'proxy_error', message: `Failed to reach Anthropic API: ${String(err)}` } },
      502,
    );
  }
}

async function proxyPassthrough(
  c: Context,
  rawBody: string,
  upstream: string,
): Promise<Response> {
  try {
    // Forward original auth headers (x-api-key or Authorization: Bearer)
    const passthroughHeaders: Record<string, string> = {
      'content-type': 'application/json',
      'anthropic-version': c.req.header('anthropic-version') ?? '2023-06-01',
    };
    const apiKey = c.req.header('x-api-key');
    const authHeader = c.req.header('authorization');
    if (apiKey) passthroughHeaders['x-api-key'] = apiKey;
    if (authHeader) passthroughHeaders['authorization'] = authHeader;
    // Relay anthropic-beta — a beta-dependent request (e.g. context-management)
    // 400s upstream without it. The routed path and handlePassthrough both
    // forward it; this path must too.
    const anthropicBeta = c.req.header('anthropic-beta');
    if (anthropicBeta) passthroughHeaders['anthropic-beta'] = anthropicBeta;

    const response = await fetch(`${upstream}/v1/messages`, {
      method: 'POST',
      headers: passthroughHeaders,
      body: rawBody,
    });

    const headers = new Headers();
    response.headers.forEach((value, key) => headers.set(key, value));
    // fetch already decompressed the body; origin encoding headers no longer apply
    headers.delete('content-encoding');
    headers.delete('content-length');
    headers.set('x-router-tier', 'passthrough');

    // Pipe the upstream body through without buffering
    return new Response(response.body, { status: response.status, headers });
  } catch (err) {
    return c.json(
      { error: { type: 'proxy_error', message: `Failed to reach Anthropic API: ${String(err)}` } },
      502,
    );
  }
}
