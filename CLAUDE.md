# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run build          # TypeScript → dist/ (chmod via node — Windows-safe)
npm test               # Build + run all tests (node:test, quoted glob — cmd.exe-safe)
npm run dev            # tsc --watch
node --test dist/__tests__/classifier.test.js  # Run single test file (build first)
```

## Architecture

**claude-router** is a routing layer that auto-routes Claude API calls across Haiku/Sonnet/Opus/Fable by evidence-based gates. The routing engine (classifier, cost model, tier fallback, retry/escalation) is the project's own; it builds on `@anthropic-ai/sdk` as the transport to Anthropic (and its Bedrock/Vertex siblings) and stays drop-in compatible with it.

```
ClaudeRouter.send(params)
  → Classifier (heuristic | ai | hybrid) → picks tier
  → Anthropic SDK messages.create() with resolved model
  → On RateLimitError: fallback to next tier up
  → CostTracker records meta (cost, savings vs baseline)
  → Returns RoutedMessage (Anthropic.Message + RouteMeta)
```

### Key files

- `src/types.ts` — All interfaces (Tier, RouterConfig, RoutingTuning, RouteMeta, RoutedMessage, RouterStats, ClassifyInput/Result)
- `src/models.ts` — Pricing constants, `DISPLAY_TIERS`, `costFields()`, `computeCostCents()`, `computeRouteCost()` (cost + savings for a completed response), tier→model mapping
- `src/classifier.ts` — AI classification via Haiku, hybrid mode, unified `classify()` entry point with LRU cache. Tier selection itself lives in `src/routing.ts`
- `src/cache.ts` — Generic bounded `LruCache` (classification results, per-credential SDK clients)
- `src/route.ts` — the routing-execution kernel, entered by all four routed paths: `executeRoute()` (normalize → create → rate-limit walk-up → escalation retry, returns a `RouteResult`) and `startRouteStream()` (validate → resolve model → normalize → open the stream, no retry). See Retry / escalation
- `src/totals.ts` — Shared route-event aggregation: `RouteTotals`, `emptyTotals()`, pure `foldOutcome(acc, e)` over the minimal `RouteOutcomeLike` shape (see Route aggregation)
- `src/tracker.ts` — CostTracker folds each `RouteMeta` via `foldOutcome` into a `RouteTotals`, maps to `RouterStats` (O(1) memory; no per-call array)
- `src/routing.ts` — `routeByEvidence()`: gate-based tier selection (see Routing)
- `src/params.ts` — `normalizeParamsForTier()`: strips/adapts model-specific params to the routed tier (see Parameter normalization)
- `src/index.ts` — ClaudeRouter class, `createRouter()` factory, re-exports

### Pricing (`src/models.ts`)

`computeCostCents()` accepts optional prompt-cache tokens (5th param): cache reads bill at `CACHE_READ_RATE` (10%) and writes at `CACHE_WRITE_RATE` (125%) of the input rate. Both routed paths pass `usage.cache_read_input_tokens`/`cache_creation_input_tokens` — omitting them understates every Claude Code cost figure.

Pricing is **family-based**, not per-ID. `priceForModel()` resolves an exact ID match first (so user overrides win), then falls back to the model's family (`familyForModel()` matches on `haiku`/`sonnet`/`opus`/`fable` substrings). This keeps `savedCents` correct for dated snapshots and Bedrock/Vertex `us.anthropic.*` IDs without a code change. Default tiers (`DEFAULT_MODELS`): haiku→`claude-haiku-4-5`, sonnet→`claude-sonnet-5`, opus→`claude-opus-4-8`, fable→`claude-fable-5`. Current generation (`FAMILY_PRICING`, $/1M in/out): Haiku 4.5 $1/$5, Sonnet 5 $3/$15 (standard; intro $2/$10 through 2026-08-31), Opus 4.6–4.8 $5/$25, Fable 5 $10/$50. **Opus is NOT the old $15/$75 — drift here silently corrupts every savings figure.**

`DEFAULT_PRICING` is assembled as family-derived entries ← spread ← `DIVERGENT_PRICING`. The latter is the exported table of models the family fallback would misprice: legacy Opus 4.0/4.1 (`$15/$75`, 3x the current family rate) and Mythos 5 (`$10/$50`, no family substring to match). Fable 5 is a tier now, so the family fallback covers it. Adding a divergent model is one row there — `models.test.ts` derives its exclusion set from the same table, in both directions, so a redundant or missing entry fails the build instead of rotting.

**Unpriced models are loud, never free.** A model with no exact entry *and* no family match is not $0 — it's unknown, and the old `if (!p) return 0` collapsed the two (this is what shipped Fable 5 at zero cost). `computeCostCents` stays a pure math function returning 0; `computeRouteCost` — the path every routed call takes — raises the signal: `RouteCost.priced` is false when the routed model, the baseline, or both are unpriced (an unpriced baseline makes `savedCents` just as wrong), plus one `console.warn` per model ID. `priced: false` flows into `RouteMeta`/`RouteEvent` → `foldOutcome` → `RouteTotals.unpricedModels`, which `stats`, the dashboard, and the verbose log render as "unknown" rather than `$0.00`. The field is written **only when false**, so pre-existing `history.jsonl` lines keep counting as measured.

### Routing (`src/routing.ts`)

**There is no score.** The additive 0–100 keyword scorer was removed: it let unrelated weak signals sum into an expensive decision (`matrix` +25 and `determinant` +25 reached the Opus threshold on a beginner numpy question, with neither word being evidence of difficulty). Summing was the bug, so no weight tuning could fix it. `routing.test.ts` pins that regression.

`routeByEvidence(input, opts)` returns `{ tier, reason, confidence }` under three rules:

1. **Sonnet is the default.** Leaving it requires positive evidence — absence of complexity is not evidence of simplicity (`"hi"` routes to sonnet, not haiku).
2. **Gates are conjunctive.** Every condition must hold, so two coincidental matches cannot combine into a verdict.
3. **The two traffic profiles are scored separately**, because they expose different signals.

**Agentic branch** (tools defined, or tool blocks in `messages`). The signal is `isMidLoop()` — is the last message a `tool_result`. This is the only routing signal in the codebase with a measurement behind it (`research/2026-07-21-tier-ceiling.md`: mid-loop tool selection is largely tier-insensitive, sonnet adequate 75% with zero clear losses; final synthesis is not, opus won 10 of 11). It is purely structural: no keywords, no language dependence, no verb-without-object failure mode.

**Single-turn branch.** Demotion to haiku requires **all** of: no tools, single message, short task text, no code fence, short system, no images, no depth markers, and a transform verb present. The boundary here is **unmeasured** — the attempt to measure it failed (`research/2026-07-21-single-turn-failed.md`) — so this branch is deliberately conservative rather than tuned. Do not widen the gate without evidence.

**Fable** is opt-in (`allowFable`) and needs depth **and** long-horizon signals together. Nothing measured supports predicting "super hard" from request text, and at $10/$50 a wrong promotion is the most expensive mistake the router can make.

Hybrid mode defers to the AI classifier exactly when no gate fired and routing fell through to the default (`reason` ends with `:default`). Both call sites use the unified `classify()` entry — do not reintroduce per-caller switch statements.

`ClassifyResult.reason` records which gate decided, so a routing decision is auditable after the fact. `routing.haikuMax` / `opusMin` / `hybridBand` are accepted-but-dead config knobs (marked `@deprecated`); they thresholded a score that no longer exists.

**`latestUserText()` is the one extractor — gates and AI snippet both use it.** It takes the newest user turn and strips `<system-reminder>…</system-reminder>` blocks, walking further back if a turn is nothing but injected context. Two separate bugs came from not doing this:

- Joining the whole message array let prior turns and `tool_result` payloads outvote the request (#18, fixed for the heuristic path in `5557d2c`; `buildAISnippet` was missed until #34).
- Keeping the injected context let the *project's own docs* decide the tier (#34). Claude Code injects CLAUDE.md into the user turn as its own text block. Captured from a real session: the opening request carries a 21,558-character injected block ahead of the user's 65 characters, and this CLAUDE.md contains "end-to-end" — a `DEPTH_MARKERS` hit — so `read package.json then tsconfig.json and tell me the build target` routed to **opus** via `agentic:depth-requested`. Any repo whose CLAUDE.md contains a depth word paid opus rates on every turn.

**The filter is structural, not textual.** An injected block is its own text block that opens and closes with the tag; whole blocks are dropped and nothing is parsed inside them. Do not replace this with a regex over the text. The first attempt did exactly that and failed *on this repo*: the paragraph above documents the tag, CLAUDE.md gets injected, and the literal closing tag ended the non-greedy match 8,039 characters in, leaving 13,519 characters of documentation still carrying the depth marker. Content can always mention the delimiter; block boundaries can't be forged by content. A block that merely mentions the tag mid-sentence is a real question and is kept.

**Quoted material is the subject, not the task.** Claude Code's meta-calls quote the conversation and state the instruction after it — `<session>…</session>\n\nWrite the title in the predominant language…`. Scoring the quoted prompt charged opus to name a session. On a 45-request wire corpus these meta-calls were 29% of all requests. The `<session>` region arrives inline in the same text block, so it is matched rather than dropped structurally, and the match is **greedy on purpose**: the real closing tag is last because the instruction follows it, so quoted text containing the literal tag cannot end the match early.

`buildAISnippet` head/tail-truncates the extractor's output, falling back to the joined text only when no user turn carries a request at all (`mode: 'ai'` bypasses the gates, so a pure tool_result history can reach it). Do not reintroduce a second extractor, and do not add a keyword gate that reads raw message content.

**Verified against real traffic** (`isMidLoop` fires correctly on Claude Code — a captured tool loop yields `agentic:mid-loop`; an earlier suspicion that the trailing `role: 'system'` message suppressed it was wrong).

**AI classifier never throws**: 1.5s `AbortSignal.timeout` + try/catch fall back to `classifyHeuristic()`. Only genuine `method: 'ai'` results are cached (sha1 key over normalized snippet/system/message count/tool count); heuristic fallbacks are recomputed so a transient Haiku outage isn't cached. Tuning knobs (`RouterConfig.routing` / `FileConfig.routing`): `aiTimeoutMs`, `classifyCacheSize` — optional. `haikuMax`/`opusMin`/`hybridBand` are accepted-but-dead (see Routing).

### Route aggregation

`src/totals.ts` owns the one fold that turns route events into running figures — "sum cost/saved, count per tier, bucket by day". Three call sites reuse it, each keeping its own execution model: `CostTracker.record` folds one `RouteMeta` at a time (O(1)), `history.foldLine` folds newly-appended JSONL lines behind an offset cache, and `dashboard` reduces the live `routeHistory` array. `foldOutcome(acc, e)` reads only `RouteOutcomeLike` (`tier`, `costCents`, `savedCents`, optional `retried`/`timestamp`/`model`/`priced`/`error`), so both `RouteMeta` and `RouteEvent` satisfy it structurally without a unified record. `priced === false` buckets the event into `RouteTotals.unpricedModels` (count per model ID) instead of contributing a fake zero — absent means priced, so legacy records aren't retroactively voided. An `error` event (a stream that died mid-flight) counts **only** toward `RouteTotals.errors` — its placeholder zeros stay out of the money/tier figures, same principle as unpriced. `RouteTotals.tiers` is string-keyed (holds `passthrough` too) and carries only tiers actually seen; the shared `tierBreakdown(totals, labels)` helper zero-fills a fixed label set (used by both `RouterStats.tierBreakdown` and the dashboard bars — add/rename a tier in one place). Do not reintroduce a second copy of the aggregation — extend `foldOutcome`. Aggregation is shared here; *construction* is shared separately (see Route outcome) — the two are different seams and `foldOutcome` stays structural over `RouteOutcomeLike` rather than demanding one record type. Line-parsing/corrupt-line rejection stays in `history` (its file seam), not in the shared fold.

### Route outcome

`computeRouteCost` returns a `RouteCost`; `costFields()` (`src/models.ts`) shapes it into the cost/token fields every outcome record carries, including the rule that `priced` is written **only when false** (absent means priced, so pre-existing `history.jsonl` lines keep counting as measured). One place, four consumers: `index.buildMeta` plus the proxy's three record sites. Those four used to spell the same seven-field destructure and re-spread out longhand, which is how they drifted — `classifierMs` reached the `x-router-classifier-ms` header on every routed response and history on none, and the streaming paths hardcoded their own `retried`.

`src/proxy/route-event.ts` owns the proxy's `RouteEvent` plus `buildRouteEvent()` (a completed call) and `errorRouteEvent()` (a stream that died after headers went out — placeholder zeros kept out of the money figures by `error`). It lives outside `handler.ts` because `history`, `dashboard`, `health` and `server` all need the type and none of them needs the request handler; with the record declared inside the handler, the 617-line file that answers HTTP requests was also the type root for the whole proxy subtree.

`DISPLAY_TIERS` (`src/models.ts`) is `TIER_ORDER` plus `passthrough` — the fixed label set `tierBreakdown` zero-fills for the dashboard bars and `claude-router stats`. Both consumers previously wrote the list out by hand and both had gone stale, omitting `fable`: a fable route folded into the totals and rendered nowhere, and was missing from the bar chart's own percentage denominator, so the bars did not total 100%. Add a tier in `TIER_ORDER` and both follow.

### Retry / escalation

`src/retry.ts` — `shouldRetry()` checks two conditions on a completed response:
- **Truncation**: `stop_reason === 'max_tokens'` with >20 output tokens → escalate tier
- **Refusal (structural)**: `stop_reason === 'refusal'` → escalate tier. Language-independent, checked first. Branch on `stop_reason` **only** — the companion `stop_details` is informational and can be `null` on a genuine refusal. Escalation is uniform, not per-`stop_details.category`: opus has already returned by this point, so the only refusals reaching the check are on haiku/sonnet. `stop_reason` is widened to `string` before comparison because the pinned SDK's union predates the value.
- **Refusal (lexical)**: output <200 chars whose first 80 chars match `REFUSAL_PATTERNS` → escalate tier (anchored to the opening so quoted refusal phrases mid-answer don't false-positive). This is a **fallback**, not dead code: only Opus 4.7+/Sonnet 5/Fable 5 set the structural flag (Haiku 4.5, the default entry tier, never does), and soft refusals — the model declining conversationally rather than the classifier firing — arrive as `end_turn`. New languages need only reach the soft-refusal case.

`nextTier()` walks `TIER_ORDER` (haiku→sonnet→opus→fable) but stops at `ESCALATION_CEILING` (opus): fable is 2x opus and the escalation triggers have never fired on real traffic (`research/2026-07-21-detector-measurement.md`: 0 of 35,314 responses). `shouldRetry` gates on the same ceiling — deriving it from `TIER_ORDER.length` silently made opus retryable when fable was added.

`src/route.ts` `executeRoute(client, apiParams, startTier, models, { fallbackOnRateLimit })` is the one place this loop lives — shared by `ClaudeRouter.send` and the proxy `handleNonStreaming`. It normalizes for the tier's model, calls the API, optionally walks up `TIER_ORDER` on a `RateLimitError`, and escalates **once** on truncation/refusal — but only on the originally-classified tier's first response (`!fallbackUsed`), never after a rate-limit walk-up. The library passes `fallbackOnRateLimit: true` (config `fallback`), the proxy `false` (a 429 surfaces to the client). Both then price via `computeRouteCost` and record through their own sink (CostTracker / RouteEvent). Do not re-inline this loop at a caller — the two copies had already drifted on the escalation condition before this was unified. An unknown `startTier` throws a `TypeError` up front (indexOf -1 used to send `model: undefined` to the API), and the escalated retry is **best-effort**: if it fails (e.g. the escalated tier is rate-limited), the truncated/refused-but-real original response is served rather than letting the error reach the walk-up catch, which would discard it. Streaming paths enter the kernel through `startRouteStream(client, apiParams, tier, models, { requestOptions })`, which does the same validate → resolve → normalize and then stops: there is still no retry once bytes flow, but that is now enforced by construction rather than by each streaming caller re-implementing the setup. `ClaudeRouter.stream` and the proxy `handleStreaming` both use it — before, they duplicated normalization and model resolution, and `stream()` carried a second unknown-tier `TypeError` that listed its expected tiers from the config keys instead of `TIER_ORDER`.

**Library streaming** (`src/index.ts`): `stream()` is async — classification is awaited (it never throws by contract), then the caller gets `{ stream, meta }` where `stream` is the untouched SDK `MessageStream` and `meta` resolves from `finalMessage()`. `meta` is pre-marked handled (`meta.catch(() => {})`) so a caller consuming only the stream can't crash the host via unhandledRejection; awaiting it still surfaces errors. Do not reintroduce a synchronous return wrapping the stream in a Proxy — that shape broke `for await` and `.on()` chaining and shipped as the 0.2.x streaming bug. `MessageStream` is typed off the client surface (`ReturnType<Anthropic['messages']['stream']>`), never a deep `lib/` import.

### Parameter normalization

`src/params.ts` — `normalizeParamsForTier(params, tier)` is applied immediately before **every** routed `messages.create`/`stream` in both the library (`src/index.ts`) and the proxy (`src/proxy/handler.ts`), including escalated-retry calls. The router picks the model, so it must also strip/adapt model-coupled params or the request 400s on the routed model:
- **haiku** (Haiku 4.5): delete `thinking` (no adaptive support) and `output_config.effort` (unsupported). Sampling params kept.
- **sonnet/opus** (Sonnet 5 / Opus 4.8): delete `temperature`/`top_p`/`top_k`; rewrite `thinking:{type:'enabled',budget_tokens}` → `{type:'adaptive'}`.

Never touches `messages`/`system`/`tools`/`max_tokens`. This is what makes `--force-route` work with Claude Code (which sends adaptive thinking + effort, which Haiku rejects). The AI classifier builds its own clean request and is not normalized.

### Proxy server (`src/proxy/`)

HTTP proxy that sits in front of the Anthropic API — zero code changes needed on the client side.

```
src/proxy/
  server.ts     — Hono app, routes: GET /health (via buildHealth), GET /dashboard, POST /v1/messages
  handler.ts    — classify → call API → retry if needed → set x-router-* headers
  health.ts     — single source of truth for the /health contract: SERVICE_ID, HealthInfo type, buildHealth(). server.ts produces it; daemon.checkHealth and cli status consume it (see Health contract)
  route-event.ts— the proxy's `RouteEvent` record + its two constructors (`buildRouteEvent`, `errorRouteEvent`); the type root history/dashboard/health import (see Route outcome)
  dashboard.ts  — HTML dashboard; aggregates routeHistory via foldOutcome (src/totals.ts)
  cli.ts        — CLI dispatcher + commands; every command returns a `CommandResult` (see CLI). bin name `claude-router` (package.json `bin`)
  command.ts    — `OutputLine`/`CommandResult` + `renderResult()`: the one place a command's output reaches the terminal
  doctor.ts     — `runDiagnostics(options, probes)` → `Diagnostic[]`; `failureCount()` derives doctor's exit code (see CLI)
  cli-config.ts — paths (routerPaths), FileConfig loading; one `OPTIONS` table drives parseServeArgs / serveArgsFrom / configFromOptions (see Serve options); getVersion, suggestCommand
  daemon.ts     — detached-spawn daemon, ~/.claude-router/daemon.json state, health polling, stopDaemon; calls rotateLogIfLarge at start
  log-rotate.ts — rotateLogIfLarge (proxy.log → proxy.log.1 at 5 MiB, only between daemon runs — never rotate under a live writer; #49)
  platform.ts   — per-OS autostart/env-var behind PlatformIntegration adapters (windows/macos/linux) + platformIntegration() selector; pure builders + cross-platform statusline stay outside the adapters; exported functions are thin delegators (see Platform integration)
  term.ts       — zero-dep ANSI styling (Claude Code aesthetic), tier colors, box(), NO_COLOR/TTY detection
  format.ts     — `formatSavedCents()`: the one place a saved/extra figure becomes text. An amount that rounds away renders as a neutral, unlabelled `$0.00` — never green `saved $0.00`, because a sub-cent loss is not a saving (same principle as unpriced models being loud rather than free)
  history.ts    — persistent route history (~/.claude-router/history.jsonl, append-only JSONL) with an incremental-read aggregate cache (folds via src/totals.ts); powers `stats` and the dashboard's lifetime cards. Only active when HandlerConfig.historyFile is set (the CLI sets it; tests/library don't). Deliberately NEVER rotated — it is the lifetime-savings ledger; users may archive/delete it (cache self-invalidates, totals restart from zero) and a one-per-process warn nudges archival past 100MB. Single-writer by design (the daemon's pre-start health check enforces one proxy per port).
```

**Health contract** (`src/proxy/health.ts`): the `/health` shape and the `'claude-router-proxy'` identity string live here once. `server.ts` builds the payload with `buildHealth(config, routeHistory)`; `daemon.checkHealth` imports `HealthInfo`/`SERVICE_ID` to verify the port is actually ours; `cli status` types its display off the same `HealthInfo`. Don't re-declare the shape or re-inline the identity string at a consumer.

**Platform integration** (`src/proxy/platform.ts`): OS-specific autostart + `ANTHROPIC_BASE_URL` env work lives in one `PlatformIntegration` adapter per OS (`windows`/`macos`/`linux`), selected once by `platformIntegration()`. macOS's `onStop` unloads the KeepAlive LaunchAgent (called by `daemon.stopDaemon` via the `unloadLaunchAgent` delegator). The exported `installAutostart`/`setEnvVar`/… functions are thin delegators to the current adapter, so call sites and tests are unchanged. Pure string builders (`buildPlist`/`buildSystemdUnit`/`buildRcBlock`/…) and the cross-platform statusline functions are shared and stay outside the adapters. Add per-OS behaviour to the adapter, not as a new `platformName()` switch.

Providers: `anthropic` (per-credential client from `x-api-key` or `Authorization: Bearer`, cached in an LRU of 100 via `getAnthropicClient()` to preserve keep-alive), `bedrock` (singleton `@anthropic-ai/bedrock-sdk`), `vertex` (singleton `@anthropic-ai/vertex-sdk`).

Passthrough: if `model` field is set and not `"auto"`, request bypasses routing and forwards directly to `api.anthropic.com` — **unless `--force-route` is set** (Claude Code always pins a model, so it needs `--force-route`). Passthrough only applies to the `anthropic` provider. The body is read **once as text** and forwarded verbatim; forwarded responses pipe `response.body` and must strip `content-encoding`/`content-length` (undici already decompressed).

**Coordinator-session pin** (`HandlerConfig.sessionModel`, CLI `--session-model <tier>` / `FileConfig.sessionModel`): pins the Claude Code **main session** to one tier while subagents still route by evidence. The signal is the gateway protocol's `x-claude-code-agent-id` header — Claude Code sets it **only** on requests from a subagent it spawned, so a request *without* it is not a subagent. **Not-a-subagent is not the same as the coordinator's agent turn**, which is why the pin also requires `body.tools` to be non-empty. Claude Code's meta-calls (session title, summary) arrive without the header too, and they are exactly the `<session>…</session>` quoted-prompt shape `latestUserText` exists to route cheap — 29% of requests on the wire corpus. Pinning them charged opus rates to name a session (measured against live Claude Code v2.1.220: the title call went sonnet → opus the moment `--session-model opus` was on). Every real coordinator turn ships Claude Code's tool set (165–217 tools observed); the meta-calls ship none, so this is the same structural agentic/single-turn split `routing.ts` already makes — **do not replace it with a text test on the prompt.** A genuinely tool-less coordinator turn degrades to classification, which is the cheap path anyway. When `sessionModel` is set, `!isSubagent`, and tools are present, `handleMessages` skips the classifier and synthesizes a `ClassifyResult` with `method: 'pinned'` / `reason: 'session:coordinator-pinned'` (so headers/log/history record it uniformly — `method` is widened to `'heuristic' | 'ai' | 'pinned'`). It **degrades safely**: a config typo whose tier has no `models[tier]` entry falls back to classification rather than sending `model: undefined`. Only meaningful under `--force-route` (otherwise the client's pinned model already passes through); the banner flags when it can't take effect. Verified against live Claude Code traffic (main session sends the header; subagents carry `x-claude-code-agent-id`).

`routeHistory` is an in-memory capped array (max 1000 events) used by `/dashboard`.

Streaming responses only set `x-router-tier/model/classifier/confidence` headers (cost/saved aren't known until the stream finishes); non-streaming sets the full `x-router-*` set including cost and savings.

**Streaming error contract** (`handleStreaming`): the first stream event is awaited **before** the Response is committed, so pre-stream failures (401 auth, 400 validation, connection refused → 502) return their real HTTP status via the shared `apiErrorResponse` mapper — never a `200` carrying an SSE error frame. Once headers are out, a mid-stream failure emits the SSE `event: error` frame *and* records a `RouteEvent` with `error` set so it lands in `RouteTotals.errors` instead of vanishing. `apiErrorResponse` gates on a **numeric** `status` — `APIConnectionError` is APIError-shaped with `status: undefined`, and passing that to `c.json` silently produced a 200.

**No CORS, on purpose** (`server.ts`): every legitimate consumer is same-origin (dashboard) or CORS-exempt (Node fetch). The old wildcard let any webpage in the operator's browser POST /v1/messages to localhost and read the response. A test pins the header's absence — do not add `cors()` back.

### CLI (`src/proxy/cli.ts`)

Subcommands: `start` (foreground; `-d`/`--daemon` for background), `stop`, `restart`, `status`, `stats [--json]`, `logs [-f] [-n N]`, `install`/`uninstall` (**cross-platform**: detached daemon + per-OS autostart — Windows HKCU Run key, macOS LaunchAgent, Linux systemd user unit — plus env var via setx/rc-block and a node-based Claude Code statusline), `init` (scaffold config), `doctor` (diagnostics, exit code = failure count), `help`, `-V`/`--version`. Unknown subcommands error with a Levenshtein suggestion (no more silent fallthrough to `start`); bare flags still run `start` behind a deprecation warning. Install steps report honestly — ✓ only after the daemon's `/health` actually passes.

**Commands return, one place prints.** `main(argv, paths)` returns a `CommandResult` (`{ lines, exitCode }`, `src/proxy/command.ts`) and `renderResult` is the only thing that writes — it sets `process.exitCode` rather than calling `process.exit`, so a command that leaves work running (the foreground server, `logs -f`) stays alive and one that doesn't exits on its own. `paths` is a parameter: it used to be resolved once at module scope, which pinned every command to the real `~/.claude-router` even though `daemon.ts`, `platform.ts` and `cli-config.ts` all already accepted an injectable `RouterPaths` — the seam existed in every leaf and was unused at the root, which is why 740 lines of commands had 91 lines of tests. Decisions worth testing are extracted rather than inlined next to a `console.log`: `startBanner` (both network-exposure warning texts, the always-shown redirected-upstream row), `restartArgs`, `parseLogsArgs`, `isNetworkExposed`.

**`doctor` is data** (`src/proxy/doctor.ts`): `runDiagnostics(options, probes)` returns `Diagnostic[]` and `failureCount()` derives the exit code — which *is* doctor's contract for CI users. `DoctorProbes` is one member per fact it inspects, each called exactly once; the previous inline version evaluated `isProcessAlive`/`isAutostartRegistered`/`isStatuslineConfigured` twice apiece (once for the verdict, once for the label), i.e. two `reg query` subprocesses per check on Windows. Deciding and rendering being one statement is also what let a check's predicate drift from its label: with `--provider bedrock` and no key, a green ✓ appeared beside the text "ANTHROPIC_API_KEY not set".

`cli.js` dispatches only when it is the entry script (`require.main === module`) — tests import `startServer`/`readLogTail` from it, and before the guard a bare import ran `main()` against the importer's argv. `startServer` maps `EADDRINUSE`/`EACCES` to clean messages (listen failures are server `'error'` events, invisible to the `unhandledRejection` handler) and takes an injectable `onFatal` for tests; the SIGINT/SIGTERM graceful-close handlers live in `cmdStart`, not in the helper, because they're process-global. `cmdLogs` reads a bounded tail via `readLogTail` (last 256KB, or `[fromByte, EOF)` when following; a shrink re-tails) — never the whole file.

`--upstream <url>` (`FileConfig.upstream`, default `https://api.anthropic.com`) redirects where routed *and* passed-through requests go, including the classifier's own Haiku call. It exists so the proxy can be exercised end to end without credentials or spend — previously that meant editing `DEFAULT_UPSTREAM` inside `node_modules` (see `research/2026-07-21-end-to-end-savings.md`). It is **explicit-only and never read from the environment**: the 0.2.1 self-recursion bug was the proxy inheriting `ANTHROPIC_BASE_URL` and calling itself, and a flag someone has to type cannot be inherited by accident. `getAnthropicClient` keys its cache on upstream as well as credential — a cached client carries its `baseURL`. A non-default upstream is always shown on the startup banner, because silently sending traffic somewhere other than Anthropic is the worst possible failure to hide.

The proxy binds `127.0.0.1` by default (`--host` / `FileConfig.host` to override). This is a security boundary, not a convenience: with `bedrock`/`vertex` the proxy uses the operator's cloud credentials and does not authenticate incoming requests — do not change the default bind.

Config file: `~/.claude-router/config.json` (`FileConfig`) supplies defaults for every flag plus `tiers` (per-tier model ID overrides), `pricing` (per-ID `$/1M` overrides), and `routing` (classifier tuning). **CLI flags always override the file.** Precedence for tier→model: provider defaults (`DEFAULT_MODELS`/`BEDROCK_MODELS`/`VERTEX_MODELS`) ← spread ← config `tiers`.

**Serve options** (`cli-config.ts`): the CLI flag set is one declarative `OPTIONS` table (key, flags, kind, default, emit rules). `parseServeArgs` (file defaults ← flags, throws `CliUsageError` on bad/unknown flags), `serveArgsFrom` (rebuild spawn args), and `configFromOptions` (scaffold `init`'s config.json) all fold over it — a new flag is one row, not five parallel edits. Emit predicates key off each option's `default`, so a value and "when to omit it" can't disagree. `tiers`/`pricing`/`routing` are file-only (no flag) and pass through untouched.

### Testing

Tests use `node:test` (no external test framework). Router tests mock the `_client` property directly — no network calls. Most tests are pure unit tests; a few bind an ephemeral **loopback** TCP port (`serve({ port: 0 })` / `http.createServer().listen(0)`) to exercise the proxy over a real socket — `daemon.test.ts` (health polling) and `integration.test.ts` (full end-to-end against a fake in-process Anthropic upstream). None reach the public internet by default. The two `proxy.test.ts` passthrough cases that *do* call `api.anthropic.com` are skipped unless `RUN_NETWORK_TESTS=1` is set.

### Module system

ES2022 target, Node16 module resolution. All internal imports use `.js` extension suffix.
