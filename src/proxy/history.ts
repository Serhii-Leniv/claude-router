import fs from 'node:fs';
import path from 'node:path';
import { emptyTotals, foldOutcome, type RouteTotals } from '../totals.js';
import type { RouteEvent } from './route-event.js';

/**
 * Persistent route history: one JSON line per event, append-only.
 * Powers `claude-router stats` and the dashboard's lifetime figures.
 *
 * Deliberately never rotated: this file IS the lifetime-savings ledger, and
 * rotating it would delete the product's headline number. At ~250 bytes/event,
 * 1M routed requests ≈ 250 MB — years of heavy use. Users may archive or
 * delete it at any time; the offset cache below self-invalidates on shrink and
 * totals restart from zero. Writes assume a single writer — the daemon's
 * pre-start health check enforces one proxy per port.
 */

const HISTORY_SIZE_NUDGE_BYTES = 100 * 1024 * 1024;
// One stat + at most one warn per process — keeps the append hot path free of
// per-event size checks. Growth past the threshold mid-run is caught on the
// next daemon start.
let checkedHistorySize = false;

export function appendEvent(file: string, event: RouteEvent): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!checkedHistorySize) {
      checkedHistorySize = true;
      try {
        if (fs.statSync(file).size > HISTORY_SIZE_NUDGE_BYTES) {
          console.warn(
            `[claude-router] ${file} is over 100 MB. It is append-only by design (it holds your lifetime savings); ` +
              `archive or delete it to start fresh — stats will restart from zero.`,
          );
        }
      } catch {
        // No file yet — nothing to nudge about.
      }
    }
    fs.appendFileSync(file, JSON.stringify(event) + '\n', 'utf8');
  } catch {
    // History is best-effort — never let persistence break a request.
  }
}

/** Lifetime figures are just accumulated {@link RouteTotals}. */
export type LifetimeStats = RouteTotals;

// Parsing and corrupt-line rejection are this module's concern (they belong to
// the file seam); the numeric folding is shared via foldOutcome.
function foldLine(stats: LifetimeStats, line: string): void {
  let event: RouteEvent;
  try {
    event = JSON.parse(line) as RouteEvent;
  } catch {
    return; // skip corrupt lines rather than losing the whole history
  }
  if (typeof event?.costCents !== 'number') return;
  foldOutcome(stats, event);
}

// Incremental cache: the file is append-only, so once a prefix is folded we
// only ever need to read the newly-appended bytes.
let cached: { file: string; offset: number; stats: LifetimeStats } | null = null;

/** @internal Test hook */
export function resetHistoryCache(): void {
  cached = null;
}

export function readLifetimeStats(file: string): LifetimeStats {
  let size: number;
  try {
    size = fs.statSync(file).size;
  } catch {
    return emptyTotals();
  }

  if (!cached || cached.file !== file || size < cached.offset) {
    cached = { file, offset: 0, stats: emptyTotals() };
  }
  if (size === cached.offset) return cached.stats;

  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(size - cached.offset);
      fs.readSync(fd, buf, 0, buf.length, cached.offset);
      const text = buf.toString('utf8');
      // Only fold complete lines; keep the offset at the last newline so a
      // partially-written trailing line is picked up next read.
      const lastNewline = text.lastIndexOf('\n');
      if (lastNewline >= 0) {
        for (const line of text.slice(0, lastNewline).split('\n')) {
          if (line.trim()) foldLine(cached.stats, line);
        }
        cached.offset += lastNewline + 1;
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // Unreadable — serve what we have
  }
  return cached.stats;
}
