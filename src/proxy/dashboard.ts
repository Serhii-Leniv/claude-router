import { emptyTotals, foldOutcome, tierBreakdown } from '../totals.js';
import { DISPLAY_TIERS, type DisplayTier } from '../models.js';
import { savedCentsDisplay } from './format.js';
import type { RouteEvent } from './route-event.js';
import type { LifetimeStats } from './history.js';

const TIER_BAR_LABEL: Record<DisplayTier, string> = {
  haiku: 'Haiku',
  sonnet: 'Sonnet',
  opus: 'Opus',
  fable: 'Fable',
  passthrough: 'Pass',
};

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderDashboard(history: RouteEvent[], lifetime?: LifetimeStats): string {
  const totals = emptyTotals();
  for (const e of history) foldOutcome(totals, e);

  const totalRequests = totals.requests;
  const totalCost = totals.costCents;
  const totalSaved = totals.savedCents;
  const retried = totals.retried;

  // DISPLAY_TIERS, not a hand-written list: the list here used to omit `fable`,
  // which both hid fable routes from the chart and left them out of its own
  // percentage denominator, so the bars quietly failed to total 100%.
  const tierCounts = tierBreakdown(totals, DISPLAY_TIERS);
  const tierTotal = DISPLAY_TIERS.reduce((n, t) => n + tierCounts[t], 0) || 1;
  const tierBars = DISPLAY_TIERS.map((t) => ({
    tier: t,
    pct: ((tierCounts[t] / tierTotal) * 100).toFixed(1),
  }))
    .filter((b) => Number(b.pct) > 0)
    .map((b) => `<div class="tier-${b.tier}" style="width:${b.pct}%">${TIER_BAR_LABEL[b.tier]} ${b.pct}%</div>`)
    .join('');

  // A card reading "$0.0000 saved" is indistinguishable from a quiet week, so
  // any unpriced call gets called out next to the figures it silently deflates.
  const unpricedNote = (models: Record<string, number>): string => {
    const entries = Object.entries(models);
    if (entries.length === 0) return '';
    const calls = entries.reduce((n, [, c]) => n + c, 0);
    const names = entries.map(([m]) => m).join(', ');
    return `<div class="warn">${calls} call${calls === 1 ? '' : 's'} unpriced: ${esc(names)}</div>`;
  };
  const sessionUnpriced = unpricedNote(totals.unpricedModels);
  const lifetimeUnpriced = lifetime ? unpricedNote(lifetime.unpricedModels) : '';

  const recent = history.slice(-50).reverse();

  const rows = recent
    .map(
      (e) => `
      <tr>
        <td>${esc(e.timestamp.replace('T', ' ').slice(0, 19))}</td>
        <td><span class="badge badge-${esc(String(e.tier))}">${esc(String(e.tier))}</span></td>
        <td>${esc(e.model)}</td>
        <td>${e.priced === false ? '<span class="unknown" title="no pricing for this model">—</span>' : `$${(e.costCents / 100).toFixed(4)}`}</td>
        <td class="${e.priced === false ? 'unknown' : e.savedCents >= 0 ? 'positive' : 'negative'}">${e.priced === false ? '—' : `$${(e.savedCents / 100).toFixed(4)}`}</td>
        <td>${e.confidence.toFixed(2)}</td>
        <td>${e.inputTokens}</td>
        <td>${e.outputTokens}</td>
        <td>${e.retried ? `<span class="badge badge-retry">${esc(e.retryReason ?? '')}</span>` : '<span class="none">-</span>'}</td>
      </tr>`,
    )
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="10">
  <title>claude-router dashboard</title>
  <style>
    :root {
      --void: #030304;
      --orange: #f7931a;
      --gold: #ffd166;
      --green: #0ecb81;
      --red: #f6465d;
      --violet: #b47cff;
      --steel: #8b95a7;
      --ink: #ece9e2;
      --ink-dim: #8f8a7e;
      --glass: rgba(255, 255, 255, 0.03);
      --glass-2: rgba(255, 255, 255, 0.015);
      --edge: rgba(247, 147, 26, 0.16);
      --edge-soft: rgba(255, 255, 255, 0.07);
      --sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, Roboto, sans-serif;
      --mono: 'SF Mono', 'Cascadia Code', 'JetBrains Mono', Consolas, 'Roboto Mono', monospace;
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html { background: var(--void); }
    body {
      font-family: var(--sans);
      color: var(--ink);
      background-color: var(--void);
      background-image:
        radial-gradient(ellipse 70% 45% at 22% -8%, rgba(247, 147, 26, 0.09), transparent 65%),
        radial-gradient(ellipse 55% 40% at 85% 4%, rgba(255, 209, 102, 0.05), transparent 60%),
        linear-gradient(rgba(247, 147, 26, 0.024) 1px, transparent 1px),
        linear-gradient(90deg, rgba(247, 147, 26, 0.024) 1px, transparent 1px);
      background-size: auto, auto, 44px 44px, 44px 44px;
      padding: 30px clamp(16px, 4vw, 52px) 44px;
      max-width: 1320px;
      margin: 0 auto;
      min-height: 100vh;
    }
    ::selection { background: rgba(247, 147, 26, 0.85); color: var(--void); }

    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      flex-wrap: wrap;
      margin-bottom: 28px;
      padding-bottom: 18px;
      border-bottom: 1px solid var(--edge);
      position: relative;
    }
    /* golden ember on the divider — light emanating from the structure itself */
    header::after {
      content: '';
      position: absolute;
      left: 0; bottom: -1px;
      height: 1px; width: 220px;
      background: linear-gradient(90deg, var(--orange), var(--gold) 60%, transparent);
      box-shadow: 0 0 12px rgba(247, 147, 26, 0.55);
    }
    h1 {
      font-size: 19px;
      font-weight: 650;
      letter-spacing: 0.01em;
      background: linear-gradient(90deg, var(--ink), var(--gold) 85%);
      -webkit-background-clip: text;
      background-clip: text;
      -webkit-text-fill-color: transparent;
      color: var(--ink);
    }
    .tagline {
      margin-top: 2px;
      font-family: var(--mono);
      font-size: 10px;
      letter-spacing: 0.24em;
      text-transform: uppercase;
      color: var(--ink-dim);
    }
    .live {
      display: flex; align-items: center; gap: 8px;
      font-family: var(--mono);
      font-size: 10px;
      letter-spacing: 0.22em;
      text-transform: uppercase;
      color: var(--ink-dim);
      padding: 7px 14px;
      border: 1px solid var(--edge-soft);
      border-radius: 999px;
      background: var(--glass);
      white-space: nowrap;
    }
    .live .dot {
      width: 7px; height: 7px; border-radius: 50%;
      background: var(--green);
      box-shadow: 0 0 10px rgba(14, 203, 129, 0.9);
      animation: pulse 2.4s ease-in-out infinite;
    }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }

    /* Glass panel: transparency stack + 1px edge + inner top highlight + warm glow */
    .card {
      position: relative;
      background: linear-gradient(160deg, var(--glass), var(--glass-2) 60%);
      border: 1px solid var(--edge-soft);
      border-radius: 14px;
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
      box-shadow: 0 1px 0 rgba(255, 255, 255, 0.05) inset, 0 12px 34px rgba(0, 0, 0, 0.5);
      transition: border-color 0.25s ease, box-shadow 0.25s ease, transform 0.25s ease;
    }
    .card:hover {
      border-color: var(--edge);
      box-shadow: 0 1px 0 rgba(255, 255, 255, 0.06) inset, 0 12px 34px rgba(0, 0, 0, 0.5), 0 0 28px rgba(247, 147, 26, 0.12);
    }

    .stats { display: flex; gap: 14px; margin-bottom: 26px; flex-wrap: wrap; }
    .stat-card { min-width: 182px; flex: 0 1 auto; padding: 16px 20px 17px; }
    .stat-card:hover { transform: translateY(-2px); }
    .stat-card .label {
      font-family: var(--mono);
      font-size: 10px;
      color: var(--ink-dim);
      text-transform: uppercase;
      letter-spacing: 0.2em;
    }
    .stat-card .value {
      font-family: var(--mono);
      font-variant-numeric: tabular-nums;
      font-size: 27px;
      font-weight: 700;
      margin-top: 7px;
      color: var(--ink);
    }
    .stat-card .value.blue   { color: var(--orange); text-shadow: 0 0 18px rgba(247, 147, 26, 0.4); }
    .stat-card .value.orange { color: var(--gold);   text-shadow: 0 0 18px rgba(255, 209, 102, 0.35); }
    .stat-card .value.green  { color: var(--green);  text-shadow: 0 0 18px rgba(14, 203, 129, 0.35); }

    .section-label {
      display: flex; align-items: center; gap: 10px;
      font-family: var(--mono);
      font-size: 10px;
      letter-spacing: 0.24em;
      text-transform: uppercase;
      color: var(--ink-dim);
      margin: 0 0 10px 2px;
    }
    .section-label::after {
      content: '';
      height: 1px; flex: 1;
      background: linear-gradient(90deg, var(--edge), transparent);
    }

    .tier-shell { margin-bottom: 26px; padding: 8px; }
    .tier-bar { display: flex; gap: 3px; height: 30px; border-radius: 8px; overflow: hidden; }
    .tier-bar div {
      display: flex; align-items: center; justify-content: center;
      overflow: hidden; white-space: nowrap;
      font-family: var(--mono);
      font-size: 10.5px; font-weight: 700;
      letter-spacing: 0.06em;
      border-radius: 5px;
    }
    .tier-haiku       { background: linear-gradient(180deg, #14e695, #0bb371); color: #01180e; box-shadow: 0 0 16px rgba(14, 203, 129, 0.3); }
    .tier-sonnet      { background: linear-gradient(180deg, #ffa53d, #ef8a0e); color: #1d0e00; box-shadow: 0 0 16px rgba(247, 147, 26, 0.35); }
    .tier-opus        { background: linear-gradient(180deg, #ffdd85, #f5c04e); color: #1e1400; box-shadow: 0 0 16px rgba(255, 209, 102, 0.35); }
    .tier-fable       { background: linear-gradient(180deg, #c79bff, #9d5ff0); color: #16022e; box-shadow: 0 0 16px rgba(180, 124, 255, 0.35); }
    .tier-passthrough { background: linear-gradient(180deg, #55607a, #414b61); color: #dde3ee; }

    .table-shell { padding: 4px; }
    .table-wrap { overflow-x: auto; border-radius: 10px; }
    table {
      width: 100%;
      border-collapse: collapse;
      font-family: var(--mono);
      font-variant-numeric: tabular-nums;
    }
    th {
      background: rgba(255, 255, 255, 0.025);
      text-align: left;
      padding: 11px 14px;
      font-size: 10px;
      font-weight: 600;
      color: var(--ink-dim);
      text-transform: uppercase;
      letter-spacing: 0.16em;
      border-bottom: 1px solid var(--edge);
      white-space: nowrap;
    }
    td {
      padding: 9px 14px;
      border-top: 1px solid rgba(255, 255, 255, 0.045);
      font-size: 12.5px;
      white-space: nowrap;
    }
    tbody tr { transition: background 0.15s ease; }
    tbody tr:hover td { background: rgba(247, 147, 26, 0.045); }
    .badge {
      display: inline-block;
      padding: 3px 10px;
      border-radius: 999px;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      border: 1px solid;
    }
    .badge-haiku       { background: rgba(14, 203, 129, 0.1);  color: var(--green);  border-color: rgba(14, 203, 129, 0.35); }
    .badge-sonnet      { background: rgba(247, 147, 26, 0.1);  color: var(--orange); border-color: rgba(247, 147, 26, 0.4); }
    .badge-opus        { background: rgba(255, 209, 102, 0.1); color: var(--gold);   border-color: rgba(255, 209, 102, 0.4); }
    .badge-fable       { background: rgba(180, 124, 255, 0.1); color: var(--violet); border-color: rgba(180, 124, 255, 0.4); }
    .badge-passthrough { background: rgba(139, 149, 167, 0.1); color: var(--steel);  border-color: rgba(139, 149, 167, 0.35); }
    .badge-retry       { background: rgba(246, 70, 93, 0.1);   color: var(--red);    border-color: rgba(246, 70, 93, 0.4); }
    .none { color: var(--ink-dim); }
    .unknown { color: var(--gold); }
    .warn {
      margin-top: 9px;
      padding: 5px 10px;
      font-family: var(--mono);
      font-size: 10.5px;
      line-height: 1.5;
      color: var(--gold);
      background: rgba(255, 209, 102, 0.07);
      border: 1px solid rgba(255, 209, 102, 0.25);
      border-radius: 8px;
    }
    .warn::before { content: '\\26A0 '; }
    .positive { color: var(--green); }
    .negative { color: var(--red); text-shadow: 0 0 12px rgba(246, 70, 93, 0.35); }
    .empty { text-align: center; padding: 30px; color: var(--ink-dim); font-family: var(--sans); font-size: 13px; }
    .footer {
      margin-top: 18px;
      font-family: var(--mono);
      font-size: 10.5px;
      letter-spacing: 0.1em;
      color: var(--ink-dim);
    }

    @media (prefers-reduced-motion: reduce) {
      .live .dot { animation: none; }
      .card, .stat-card, tbody tr { transition: none; }
      .stat-card:hover { transform: none; }
    }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>claude-router dashboard</h1>
      <div class="tagline">routing ledger &middot; cost engine</div>
    </div>
    <div class="live"><span class="dot"></span>live &middot; refresh 10s</div>
  </header>

  <div class="stats">
    <div class="stat-card card">
      <div class="label">Session Requests</div>
      <div class="value blue">${totalRequests}</div>
    </div>
    <div class="stat-card card">
      <div class="label">Session Cost</div>
      <div class="value orange">$${(totalCost / 100).toFixed(4)}</div>
    </div>
    ${(() => {
      const d = savedCentsDisplay(totalSaved, false, 4);
      const toneClass = d.tone === 'neutral' ? '' : d.tone;
      return `<div class="stat-card card">
      <div class="label">Session Saved</div>
      <div class="value${toneClass ? ` ${toneClass}` : ''}">${d.text}</div>
      ${sessionUnpriced}
    </div>`;
    })()}
    <div class="stat-card card">
      <div class="label">Auto-retried</div>
      <div class="value">${retried}</div>
    </div>
    ${lifetime ? (() => {
      const d = savedCentsDisplay(lifetime.savedCents);
      const toneClass = d.tone === 'neutral' ? '' : d.tone;
      return `
    <div class="stat-card card">
      <div class="label">Lifetime Saved</div>
      <div class="value${toneClass ? ` ${toneClass}` : ''}">${d.text}</div>
      ${lifetimeUnpriced}
    </div>
    <div class="stat-card card">
      <div class="label">Lifetime Requests</div>
      <div class="value blue">${lifetime.requests}</div>
    </div>`;
    })() : ''}
  </div>

  <div class="section-label">Tier Distribution</div>
  <div class="tier-shell card">
    <div class="tier-bar">
      ${tierBars}
    </div>
  </div>

  <div class="section-label">Route Feed</div>
  <div class="table-shell card">
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>Tier</th>
            <th>Model</th>
            <th>Cost</th>
            <th>Saved</th>
            <th>Confidence</th>
            <th>In Tokens</th>
            <th>Out Tokens</th>
            <th>Retry</th>
          </tr>
        </thead>
        <tbody>
          ${rows || '<tr><td colspan="9" class="empty">No requests yet. Send requests to the proxy to see data here.</td></tr>'}
        </tbody>
      </table>
    </div>
  </div>

  <div class="footer">Auto-refreshes every 10 seconds. Showing last 50 of ${totalRequests} requests.</div>
</body>
</html>`;
}
