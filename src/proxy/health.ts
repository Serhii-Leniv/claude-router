import type { RouteEvent } from './route-event.js';

/**
 * The `/health` contract, defined once. `server.ts` produces it; `daemon.ts`
 * (`checkHealth`) and `cli.ts` (`status`) consume it. Keeping the shape and the
 * identity string in one module stops the three consumers from re-declaring a
 * contract that can silently drift from what the server actually emits.
 */

/** Identity marker distinguishing our proxy from any other service on the port. */
export const SERVICE_ID = 'claude-router-proxy';

export interface HealthInfo {
  status: string;
  service: string;
  classifier: string;
  provider: string;
  forceRoute: boolean;
  requests: number;
  lastTier: string | null;
  lastModel: string | null;
}

/** Build the `/health` payload from the current config and route history. */
export function buildHealth(
  config: { classifier: string; provider: string; forceRoute: boolean },
  history: RouteEvent[],
): HealthInfo {
  const last = history[history.length - 1] ?? null;
  return {
    status: 'ok',
    service: SERVICE_ID,
    classifier: config.classifier,
    provider: config.provider,
    forceRoute: config.forceRoute,
    requests: history.length,
    lastTier: last ? String(last.tier) : null,
    lastModel: last?.model ?? null,
  };
}

/**
 * The Claude Code statusline text, e.g. `[auto:sonnet #42]`. Kept here so the
 * `/health` contract module stays the one owner of these fields — the shell
 * statusline fetches this preformatted string (via `GET /statusline`) instead
 * of parsing JSON, so the installed command is plain `curl`, no `jq`/`python`.
 */
export function formatStatusLine(info: HealthInfo): string {
  return `[auto:${info.lastTier ?? 'ready'} #${info.requests}]`;
}
