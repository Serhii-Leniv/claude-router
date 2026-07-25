#!/usr/bin/env node

import { serve, type ServerType } from '@hono/node-server';
import type { Hono } from 'hono';
import fs from 'node:fs';
import { createProxyApp } from './server.js';
import { createProviderClient, DEFAULT_UPSTREAM, type Provider } from './handler.js';
import { DEFAULT_MODELS, BEDROCK_MODELS, VERTEX_MODELS, DISPLAY_TIERS } from '../models.js';
import type { Tier } from '../types.js';
import { term } from './term.js';
import { formatSavedCents } from './format.js';
import {
  err,
  failLine,
  failed,
  ok,
  out,
  raw,
  renderResult,
  warnLine,
  type CommandResult,
  type OutputLine,
} from './command.js';
import { failureCount, formatDiagnostics, runDiagnostics, type DoctorProbes } from './doctor.js';
import {
  CliUsageError,
  applyRegionEnv,
  configFromOptions,
  getVersion,
  loadFileConfig,
  parseServeArgs,
  routerPaths,
  serveArgsFrom,
  suggestCommand,
  type RouterPaths,
  type ServeOptions,
} from './cli-config.js';
import {
  checkHealth,
  isProcessAlive,
  readDaemonState,
  resolveStatusPort,
  startDaemon,
  statusPid,
  stoppedStatusDetail,
  stopDaemon,
  writeDaemonState,
} from './daemon.js';
import { readLifetimeStats } from './history.js';
import {
  addStatusline,
  installAutostart,
  isAutostartRegistered,
  isEnvVarSet,
  isStatuslineConfigured,
  platformName,
  removeStatusline,
  setEnvVar,
  supervisorPid,
  uninstallAutostart,
  unsetEnvVar,
  type StepResult,
} from './platform.js';

const COMMANDS = [
  'start', 'stop', 'restart', 'status', 'stats', 'logs',
  'install', 'uninstall', 'init', 'doctor', 'help',
];

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Parse the serve options, carrying any config-file complaint back as a line
 * rather than printing it. Every command starts its output with these.
 */
function resolveOptions(
  args: string[],
  paths: RouterPaths,
): { options: ServeOptions; warnings: OutputLine[] } {
  const { config, error } = loadFileConfig(paths.configFile);
  const warnings = error
    ? [warnLine(`Ignoring invalid config at ${paths.configFile}: ${error}`)]
    : [];
  return { options: parseServeArgs(args, config), warnings };
}

/** Split command-specific boolean flags out of an arg list before serve parsing. */
function extractFlags(args: string[], flags: string[]): { rest: string[]; found: Set<string> } {
  const found = new Set<string>();
  const rest = args.filter((a) => {
    if (flags.includes(a)) {
      found.add(a);
      return false;
    }
    return true;
  });
  return { rest, found };
}

function stepLine(result: StepResult): OutputLine {
  const glyph = result.ok ? term.ok() : result.skipped ? term.warn() : term.fail();
  return out(`  ${glyph} ${result.detail}`);
}

function modelsForProvider(provider: Provider): Record<Tier, string> {
  if (provider === 'bedrock') return BEDROCK_MODELS;
  if (provider === 'vertex') return VERTEX_MODELS;
  return DEFAULT_MODELS;
}

// ── start ──────────────────────────────────────────────────────────────────

/** True when the bind address reaches beyond this machine. */
export function isNetworkExposed(host: string): boolean {
  return host !== '127.0.0.1' && host !== 'localhost';
}

/**
 * The startup banner, plus the network-exposure warning that must precede it.
 *
 * Pure so both are testable: the warning is a security notice with two distinct
 * texts (an unauthenticated relay to Anthropic vs. exposed cloud credentials),
 * and the "Upstream" row is deliberately unconditional when redirected —
 * silently sending traffic somewhere other than Anthropic is the worst failure
 * this tool can hide.
 */
export function startBanner(
  options: ServeOptions,
  models: Record<Tier, string>,
  configLoaded: boolean,
  paths: RouterPaths,
): OutputLine[] {
  const lines: OutputLine[] = [];
  const exposed = isNetworkExposed(options.host);

  if (exposed) {
    // Every provider is dangerous on a network bind: bedrock/vertex spend the
    // operator's cloud credentials, and anthropic is an unauthenticated open
    // relay to api.anthropic.com for anyone who supplies a key.
    lines.push(
      err(
        term.warn() +
          (options.provider === 'anthropic'
            ? ` Binding to ${options.host} makes this proxy an open, unauthenticated relay to the Anthropic API for anyone on the network.`
            : ` Binding to ${options.host} with the ${options.provider} provider exposes YOUR cloud credentials to the network — incoming requests are not authenticated.`),
      ),
    );
  }

  const regionDisplay = options.region ||
    (options.provider === 'bedrock' ? process.env['AWS_REGION'] ?? 'us-east-1' :
     options.provider === 'vertex' ? process.env['ANTHROPIC_VERTEX_REGION'] ?? 'us-east5' : '');

  const displayHost = exposed ? options.host : 'localhost';
  const rows: Array<[string, string]> = [
    ['URL', term.accent(`http://${displayHost}:${options.port}`)],
    ['Dashboard', `http://${displayHost}:${options.port}/dashboard`],
    ['Provider', options.provider],
    ['Classifier', options.classifier],
    ['Force-route', options.forceRoute ? term.green('on') : term.dim('off')],
    ['Tiers', `${term.tier('haiku')} ${term.dim('→')} ${models.haiku}`],
    ['', `${term.tier('sonnet')} ${term.dim('→')} ${models.sonnet}`],
    ['', `${term.tier('opus')} ${term.dim('→')} ${models.opus}`],
  ];
  // A pinned coordinator changes routing meaningfully (the main session skips the
  // classifier), so surface it — and flag when it can't take effect.
  if (options.sessionModel) {
    const note = options.forceRoute
      ? term.dim('(subagents still routed)')
      : term.yellow('(needs --force-route to take effect)');
    rows.push(['Session', `${term.tier(options.sessionModel as Tier)} pinned ${note}`]);
  }
  // A redirected upstream means requests are NOT going to Anthropic. That is the
  // point when testing, and a silent disaster otherwise — so it is always on the
  // banner, never merely absent when default.
  if (options.upstream !== DEFAULT_UPSTREAM) {
    rows.push(['Upstream', `${options.upstream} ${term.yellow('(not Anthropic)')}`]);
  }
  if (exposed) rows.push(['Bind', `${options.host} ${term.yellow('(network-exposed)')}`]);
  if (regionDisplay) rows.push(['Region', regionDisplay]);
  if (configLoaded) rows.push(['Config', paths.configFile]);

  lines.push(out('\n' + term.box(`claude-router ${term.dim('v' + getVersion())}`, rows) + '\n'));
  return lines;
}

async function cmdStart(args: string[], paths: RouterPaths): Promise<CommandResult> {
  const { rest, found } = extractFlags(args, ['--daemon', '-d']);
  const { options, warnings } = resolveOptions(rest, paths);

  if (found.size > 0) {
    const result = await startDaemon(serveArgsFrom(options), options.port, paths);
    if (!result.ok) return failed([...warnings, failLine(result.detail)]);
    return ok([
      ...warnings,
      out(`${term.ok()} ${result.detail}`),
      out(term.dim(`  logs: claude-router logs   stop: claude-router stop`)),
    ]);
  }

  applyRegionEnv(options);
  const models = { ...modelsForProvider(options.provider), ...(options.tiers ?? {}) };

  let providerClient;
  try {
    providerClient = await createProviderClient(options.provider);
  } catch (e) {
    return failed([...warnings, failLine(`Provider init failed: ${String(e)}`)]);
  }

  const app = createProxyApp({
    classifier: options.classifier,
    defaultModel: models.sonnet,
    verbose: options.verbose,
    provider: options.provider,
    models,
    forceRoute: options.forceRoute,
    sessionModel: options.sessionModel ? (options.sessionModel as Tier) : undefined,
    pricing: options.pricing,
    routing: options.routing,
    historyFile: paths.historyFile,
    upstream: options.upstream,
  }, providerClient);

  const { loaded } = loadFileConfig(paths.configFile);

  // Process-global handlers stay here rather than in `startServer`: they outlive
  // any one bind, and a test that imports `startServer` must not inherit them.
  process.on('unhandledRejection', (e) => {
    term.errorLine(`Fatal error: ${String(e)}`);
    if (options.provider === 'vertex') {
      console.error('\nVertex auth failed. Run: gcloud auth application-default login');
    } else if (options.provider === 'bedrock') {
      console.error('\nBedrock auth failed. Check: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION');
    }
    process.exit(1);
  });

  const server = startServer(app, options.port, options.host);

  // SIGINT covers Ctrl+C on all platforms. SIGTERM covers `kill` on POSIX; on
  // Windows process.kill is TerminateProcess and no handler runs — acceptable,
  // since history appends are per-event synchronous and there is nothing to flush.
  const shutdown = (signal: string) => {
    console.log(term.dim(`\n[claude-router] ${signal} — shutting down`));
    server.close(() => process.exit(0));
    // In-flight SSE streams can hold the server open indefinitely — cap the drain.
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  return ok([...warnings, ...startBanner(options, models, loaded, paths)]);
}

/**
 * Bind the server with a clean failure path and a graceful shutdown.
 * Exported so the EADDRINUSE handling is testable without spawning a CLI
 * process. `serve()` returns the underlying node:http server, so listen
 * errors arrive as 'error' events — not promise rejections, which is why the
 * unhandledRejection handler above never saw them.
 */
export function startServer(
  app: Pick<Hono, 'fetch'>,
  port: number,
  hostname: string,
  // Injectable so tests can observe the fatal path without killing the runner.
  onFatal: (code: number) => void = (code) => process.exit(code),
): ServerType {
  const server = serve({ fetch: app.fetch, port, hostname });

  server.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code === 'EADDRINUSE') {
      term.errorLine(`Port ${port} is already in use — another proxy or app owns it.`);
      console.error(term.dim(`  Check: claude-router status   ·   or pick a port: claude-router start --port <n>`));
    } else if (e.code === 'EACCES') {
      term.errorLine(`No permission to bind ${hostname}:${port}.`);
    } else {
      term.errorLine(`Server error: ${String(e)}`);
    }
    onFatal(1);
  });

  return server;
}

// ── stop / restart ─────────────────────────────────────────────────────────

async function cmdStop(_args: string[], paths: RouterPaths): Promise<CommandResult> {
  const result = await stopDaemon(paths);
  return result.ok
    ? ok([out(`${term.ok()} ${result.detail}`)])
    : failed([failLine(result.detail)]);
}

/**
 * Which options a restart runs with: the ones just given, else the ones the
 * previous daemon recorded, else defaults. Pure, because "does a restart carry
 * `--force-route` over" is the whole point of the command.
 */
export function restartArgs(args: string[], previous: string[] | undefined): string[] {
  return args.length > 0 ? args : previous ?? [];
}

async function cmdRestart(args: string[], paths: RouterPaths): Promise<CommandResult> {
  const state = readDaemonState(paths);
  const stop = await stopDaemon(paths);
  if (!stop.ok) return failed([failLine(stop.detail)]);

  const lines: OutputLine[] = [];
  if (args.length === 0 && !state) {
    lines.push(
      warnLine(
        'No previous daemon state found — restarting with defaults. Any flags the old daemon ran with (e.g. --force-route, --provider) are not carried over; pass them again if needed.',
      ),
    );
  }

  const { options, warnings } = resolveOptions(restartArgs(args, state?.args), paths);
  lines.push(...warnings);

  const result = await startDaemon(serveArgsFrom(options), options.port, paths);
  if (!result.ok) return failed([...lines, failLine(result.detail)]);
  return ok([...lines, out(`${term.ok()} ${result.detail}`)]);
}

// ── status ─────────────────────────────────────────────────────────────────

async function cmdStatus(args: string[], paths: RouterPaths): Promise<CommandResult> {
  const { options, warnings } = resolveOptions(args, paths);
  const state = readDaemonState(paths);
  // A foreground `start --port` writes no daemon.json, so only an explicit
  // --port here can reach it; a background daemon records its port, so prefer
  // that over the default when the user did not pin one (#39).
  const portFromFlag = args.includes('--port') || args.includes('-p');
  // Only a live daemon's recorded port is evidence; a stale record must not
  // steer the probe away from the port the user actually configured.
  const daemon = state && isProcessAlive(state.pid) ? state : null;
  const check = resolveStatusPort(options.port, portFromFlag, daemon);
  const health = await checkHealth(check.port);

  if (!health) {
    const lines = [
      ...warnings,
      out(`${term.fail()} ${term.bold('stopped')} ${term.dim(`(${stoppedStatusDetail(check)})`)}`),
    ];
    if (state && !isProcessAlive(state.pid)) {
      lines.push(out(term.dim(`  stale daemon state found (pid ${state.pid} is gone)`)));
    }
    lines.push(out(`\nStart it:  ${term.accent('claude-router start -d')}  ${term.dim('(or claude-router install)')}`));
    return failed(lines);
  }

  // Only name a pid when the port that answered is the daemon's own (#52).
  const pid = statusPid(check, daemon);
  const rows: Array<[string, string]> = [
    ['Status', `${term.green('running')}${pid !== null ? term.dim(` (pid ${pid})`) : ''}`],
    ['URL', `http://localhost:${check.port}`],
    ['Dashboard', `http://localhost:${check.port}/dashboard`],
    ['Provider', health.provider],
    ['Classifier', health.classifier],
    ['Force-route', health.forceRoute ? term.green('on') : term.dim('off')],
    ['Requests', String(health.requests)],
    ['Last tier', health.lastTier ? term.tier(health.lastTier) : term.dim('none')],
    ['Autostart', isAutostartRegistered(paths) ? term.green('registered') : term.dim('not registered')],
    ['Env var', isEnvVarSet(check.port) ? term.green('set') : term.dim('not set')],
  ];
  return ok([...warnings, out('\n' + term.box('claude-router status', rows) + '\n')]);
}

// ── stats ──────────────────────────────────────────────────────────────────

function cmdStats(args: string[], paths: RouterPaths): CommandResult {
  const asJson = args.includes('--json');
  const stats = readLifetimeStats(paths.historyFile);

  if (asJson) return ok([out(JSON.stringify(stats, null, 2))]);

  if (stats.requests === 0 && stats.errors === 0) {
    return ok([out(term.dim('No routing history yet — savings are recorded once requests flow through the proxy.'))]);
  }

  // DISPLAY_TIERS, not a hand-written list — the copy here had gone stale and
  // omitted `fable`, so a fable route counted toward the totals and appeared
  // under no tier at all.
  const tierLine = DISPLAY_TIERS
    .filter((t) => stats.tiers[t])
    .map((t) => `${term.tier(t)} ${stats.tiers[t]}`)
    .join(term.dim('  ·  '));

  const rows: Array<[string, string]> = [
    ['Requests', String(stats.requests)],
    ['Total cost', `$${(stats.costCents / 100).toFixed(2)}`],
    ['Total saved', formatSavedCents(stats.savedCents)],
    ['Auto-retried', String(stats.retried)],
    ['Tiers', tierLine || term.dim('none')],
  ];

  // Mid-flight failures (e.g. a stream that died after headers went out) are
  // counted apart from the money figures — shown only when there are any.
  if (stats.errors > 0) {
    rows.push(['Errors', term.red(String(stats.errors))]);
  }

  // The totals above exclude every unpriced call. Saying so is the difference
  // between "we saved little" and "we can't tell you what we saved".
  const unpriced = Object.entries(stats.unpricedModels);
  if (unpriced.length > 0) {
    const calls = unpriced.reduce((n, [, c]) => n + c, 0);
    rows.push(['Unpriced', term.yellow(`${calls} call${calls === 1 ? '' : 's'} — ${unpriced.map(([m]) => m).join(', ')}`)]);
  }

  const lines = [out('\n' + term.box('claude-router — lifetime savings', rows))];

  if (unpriced.length > 0) {
    lines.push(
      out(
        term.dim('\nUnpriced models are excluded from the cost and savings figures above.\n') +
          term.dim('Add a "pricing" entry for each in ') + paths.configFile,
      ),
    );
  }

  const days = Object.keys(stats.byDay).sort().slice(-7);
  if (days.length > 0) {
    lines.push(out('\n' + term.bold('Last 7 days')));
    for (const day of days) {
      const d = stats.byDay[day]!;
      const saved = formatSavedCents(d.savedCents, true);
      lines.push(out(`  ${day}  ${String(d.requests).padStart(5)} req   ${saved}`));
    }
  }
  lines.push(out(term.dim(`\nHistory: ${paths.historyFile}`)));
  return ok(lines);
}

// ── logs ───────────────────────────────────────────────────────────────────

/** Parse `logs`' own flags. Separate from the serve options — `logs` shares none. */
export function parseLogsArgs(args: string[]): { lines: number; follow: boolean } {
  let lines = 50;
  let follow = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '-f' || arg === '--follow') follow = true;
    else if ((arg === '-n' || arg === '--lines') && args[i + 1]) {
      lines = parseInt(args[++i]!, 10) || 50;
    } else {
      throw new CliUsageError(`Unknown option '${arg}' for logs.`);
    }
  }
  return { lines, follow };
}

function cmdLogs(args: string[], paths: RouterPaths): CommandResult {
  const { lines, follow } = parseLogsArgs(args);

  if (!fs.existsSync(paths.logFile)) {
    return ok([out(term.dim(`No log file yet (${paths.logFile}). Start the daemon: claude-router start -d`))]);
  }

  const initial = readLogTail(paths.logFile, null);
  const tail = initial.text.split('\n').slice(-lines - 1).join('\n');
  const result: OutputLine[] = [];
  if (tail) result.push(raw(tail.endsWith('\n') ? tail : tail + '\n'));

  let size = initial.size;
  if (follow) {
    result.push(out(term.dim('— following (ctrl+c to exit) —')));
    // The follow loop is a stream, not a report — it writes as bytes arrive and
    // keeps the process alive, which is why it is the one place outside
    // `renderResult` that touches stdout.
    fs.watchFile(paths.logFile, { interval: 500 }, () => {
      const next = readLogTail(paths.logFile, size);
      if (next.text) process.stdout.write(next.text);
      size = next.size;
    });
  }
  return ok(result);
}

/**
 * Bounded read of a log file's tail — never the whole file into memory.
 * `fromByte: null` reads the last `maxBytes` (initial tail); a number reads
 * `[fromByte, EOF)` (follow mode). A file that shrank under us (rotation)
 * resets to a fresh tail instead of silently going quiet, which is what the
 * old length-comparison follow loop did. Exported for tests.
 */
export function readLogTail(
  file: string,
  fromByte: number | null,
  maxBytes: number = 256 * 1024,
): { text: string; size: number } {
  let size: number;
  try {
    size = fs.statSync(file).size;
  } catch {
    return { text: '', size: 0 };
  }
  let start = fromByte ?? Math.max(0, size - maxBytes);
  if (start > size) start = Math.max(0, size - maxBytes);
  if (start >= size) return { text: '', size };

  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    return { text: buf.toString('utf8'), size };
  } finally {
    fs.closeSync(fd);
  }
}

// ── install / uninstall ────────────────────────────────────────────────────

async function cmdInstall(args: string[], paths: RouterPaths): Promise<CommandResult> {
  const { rest, found } = extractFlags(args, ['--no-autostart', '--no-env', '--no-statusline']);
  const { options, warnings } = resolveOptions(rest, paths);
  const serveArgs = serveArgsFrom(options);

  const lines: OutputLine[] = [
    ...warnings,
    out(`\nInstalling claude-router ${term.dim(`(${platformName()})`)}\n`),
  ];
  let failures = 0;

  // 1. Autostart on login. On macOS/Linux the supervisor (launchd RunAtLoad /
  //    systemd --now) ALSO starts the proxy immediately, so this must run before
  //    we consider starting our own daemon — otherwise both bind the port and the
  //    supervisor's instance loops forever on EADDRINUSE.
  if (!found.has('--no-autostart')) {
    const result = installAutostart(serveArgs, paths);
    lines.push(stepLine(result));
    if (!result.ok && !result.skipped) failures++;
  }

  // 2. Ensure the proxy is running — but don't start a second one if the
  //    autostart supervisor already brought it up (that's the port race).
  let running = await checkHealth(options.port);
  // Only macOS/Linux supervisors start the proxy at install time; the Windows Run
  // key fires at next login, so there's nothing to wait for there.
  if (!running && !found.has('--no-autostart') && platformName() !== 'windows') {
    // Give the just-loaded supervisor a moment to bind the port before deciding.
    for (let i = 0; i < 15 && !running; i++) {
      await new Promise((r) => setTimeout(r, 200));
      running = await checkHealth(options.port);
    }
  }
  if (running) {
    // Record the supervised process so status/stop/restart keep working without
    // a redundant daemon of our own.
    const pid = supervisorPid(paths);
    if (pid) {
      writeDaemonState(
        { pid, port: options.port, startedAt: new Date().toISOString(), args: serveArgs },
        paths,
      );
    }
    lines.push(stepLine({
      ok: true,
      detail: pid
        ? `Proxy running on port ${options.port} (pid ${pid}, autostart-supervised)`
        : `Proxy already running on port ${options.port}`,
    }));
  } else {
    const start = await startDaemon(serveArgs, options.port, paths);
    lines.push(stepLine({ ok: start.ok, detail: start.detail }));
    if (!start.ok) failures++;
  }

  // 3. Environment variable
  if (!found.has('--no-env')) {
    const result = setEnvVar(options.port, paths);
    lines.push(stepLine(result));
    if (!result.ok && !result.skipped) failures++;
  }

  // 4. Claude Code statusline
  if (!found.has('--no-statusline')) {
    const result = addStatusline(options.port, paths);
    lines.push(stepLine(result));
    if (!result.ok && !result.skipped) failures++;
  }

  if (failures > 0) {
    lines.push(out(`\n${term.fail()} Install finished with ${failures} failed step(s) — see above.`));
    return failed(lines);
  }

  const envNote = platformName() === 'windows'
    ? 'Open a new terminal (setx applies to new sessions only)'
    : 'Restart your terminal (or: source your shell rc file)';
  lines.push(out(`
${term.ok()} Done. Requests to ${term.accent(`http://localhost:${options.port}`)} are auto-routed.

  ${term.dim('→')} ${envNote}
  ${term.dim('→')} Use ${term.accent('claude')} normally — calls route through the proxy
  ${term.dim('→')} Check anytime: ${term.accent('claude-router status')} · ${term.accent('claude-router doctor')}
`));
  return ok(lines);
}

async function cmdUninstall(_args: string[], paths: RouterPaths): Promise<CommandResult> {
  const lines: OutputLine[] = [
    out(`\nUninstalling claude-router ${term.dim(`(${platformName()})`)}\n`),
  ];

  const stop = await stopDaemon(paths);
  lines.push(stepLine({ ok: stop.ok, detail: stop.detail, skipped: !stop.ok }));
  lines.push(stepLine(uninstallAutostart(paths)));
  lines.push(stepLine(unsetEnvVar(paths)));
  lines.push(stepLine(removeStatusline(paths)));
  lines.push(out(`\n${term.ok()} claude-router uninstalled.\n`));
  return ok(lines);
}

// ── init ───────────────────────────────────────────────────────────────────

function cmdInit(args: string[], paths: RouterPaths): CommandResult {
  const { rest, found } = extractFlags(args, ['--force']);
  if (fs.existsSync(paths.configFile) && !found.has('--force')) {
    return failed([failLine(`${paths.configFile} already exists. Use --force to overwrite.`)]);
  }

  const options = parseServeArgs(rest, {});
  const config = configFromOptions(options);

  fs.mkdirSync(paths.configDir, { recursive: true });
  fs.writeFileSync(paths.configFile, JSON.stringify(config, null, 2) + '\n', 'utf8');
  return ok([
    out(`${term.ok()} Wrote ${paths.configFile}`),
    out(term.dim('  Edit it to add per-tier model overrides ("tiers") or pricing ("pricing").')),
  ]);
}

// ── doctor ─────────────────────────────────────────────────────────────────

/** The live probes — the production adapter for {@link DoctorProbes}. */
function liveProbes(paths: RouterPaths): DoctorProbes {
  return {
    nodeVersion: process.versions.node,
    platform: platformName(),
    loadConfig: () => loadFileConfig(paths.configFile),
    checkHealth: (port) => checkHealth(port),
    isEnvVarSet: (port) => isEnvVarSet(port),
    apiKeySet: () => Boolean(process.env['ANTHROPIC_API_KEY']),
    daemonState: () => readDaemonState(paths),
    isProcessAlive: (pid) => isProcessAlive(pid),
    isAutostartRegistered: () => isAutostartRegistered(paths),
    isStatuslineConfigured: () => isStatuslineConfigured(paths),
  };
}

async function cmdDoctor(args: string[], paths: RouterPaths): Promise<CommandResult> {
  const { options, warnings } = resolveOptions(args, paths);
  const diagnostics = await runDiagnostics(
    { port: options.port, provider: options.provider, configFile: paths.configFile },
    liveProbes(paths),
  );

  return {
    lines: [
      ...warnings,
      out(`\n${term.bold('claude-router doctor')} ${term.dim(`(${platformName()})`)}\n`),
      ...formatDiagnostics(diagnostics),
    ],
    // The exit code IS doctor's contract for CI users: the number of hard
    // failures. Derived from the diagnostics rather than counted while printing.
    exitCode: failureCount(diagnostics),
  };
}

// ── help ───────────────────────────────────────────────────────────────────

function helpResult(): CommandResult {
  const a = (s: string) => term.accent(s);
  const d = (s: string) => term.dim(s);
  return ok([out(`
${term.bold('claude-router')} ${d('v' + getVersion())} — auto-route Claude API calls by prompt complexity

${term.bold('Usage')}
  ${a('claude-router install')} [options]     One-time setup: daemon + autostart + env + statusline
  ${a('claude-router uninstall')}             Remove everything install added
  ${a('claude-router start')} [options]       Run the proxy in the foreground
  ${a('claude-router start -d')}              Run it in the background (daemon)
  ${a('claude-router stop')}                  Stop the background proxy
  ${a('claude-router restart')} [options]     Restart the background proxy
  ${a('claude-router status')}                Health, routing stats, install state
  ${a('claude-router stats')} [--json]        Lifetime savings and per-day breakdown
  ${a('claude-router logs')} [-f] [-n N]      Show (or follow) the daemon log
  ${a('claude-router init')} [--force] [options]  Scaffold ~/.claude-router/config.json from the given options
  ${a('claude-router doctor')}                Diagnose common setup problems

${term.bold('Options')} ${d('(install / start / restart / status / doctor)')}
  --port, -p <number>      Port (default: 4000)
  --host <address>         Bind address (default: 127.0.0.1 — local only; 0.0.0.0 exposes to the network)
  --force-route            Route even explicit model requests — required for Claude Code
  --verbose, -v            Log each routing decision
  --classifier <mode>      heuristic | ai | hybrid (default: hybrid)
  --provider <mode>        anthropic | bedrock | vertex (default: anthropic)
  --region <string>        AWS/GCP region
  --version, -V            Print version

${term.bold('Install-only options')}
  --no-autostart           Skip login autostart registration
  --no-env                 Skip setting ANTHROPIC_BASE_URL
  --no-statusline          Skip the Claude Code statusline

${term.bold('Config file')} ${d('(~/.claude-router/config.json — flags always win)')}
  Any option above, plus per-tier model overrides ("tiers"), pricing ("pricing"),
  and classifier tuning ("routing"). Scaffold with: ${a('claude-router init')}

${term.bold('Quick start')}
  ${a('claude-router install --force-route')}
  ${d('# open a new terminal, then use `claude` normally')}
`)]);
}

// ── Entry ──────────────────────────────────────────────────────────────────

/**
 * Dispatch one invocation and report what should be shown and exited with.
 *
 * Takes argv and paths rather than reading `process.argv` and `os.homedir()`:
 * `paths` used to be resolved once at module scope, which pinned every command
 * to the operator's real `~/.claude-router` — the leaf modules all accepted an
 * injectable `RouterPaths` already, so the seam existed everywhere except at the
 * root that used it.
 */
export async function main(
  argv: string[],
  paths: RouterPaths = routerPaths(),
): Promise<CommandResult> {
  const [subcommand, ...rest] = argv;

  if (!subcommand || subcommand === '--help' || subcommand === '-h' || subcommand === 'help') {
    return helpResult();
  }

  if (subcommand === '--version' || subcommand === '-V') {
    return ok([out(getVersion())]);
  }

  // Lines emitted before the command runs, so they survive a usage error the
  // same way they did when they were printed on the way in.
  const prefix: OutputLine[] = [];

  try {
    // Legacy invocation: bare flags with no subcommand used to mean `start`
    if (subcommand.startsWith('-')) {
      prefix.push(
        warnLine('Deprecated: bare flags now require the `start` subcommand — running `start` for you.'),
      );
      const result = await cmdStart(argv, paths);
      return { ...result, lines: [...prefix, ...result.lines] };
    }

    if (rest.includes('--help') || rest.includes('-h')) return helpResult();

    switch (subcommand) {
      case 'start': return await cmdStart(rest, paths);
      case 'stop': return await cmdStop(rest, paths);
      case 'restart': return await cmdRestart(rest, paths);
      case 'status': return await cmdStatus(rest, paths);
      case 'stats': return cmdStats(rest, paths);
      case 'logs': return cmdLogs(rest, paths);
      case 'install': return await cmdInstall(rest, paths);
      case 'uninstall': return await cmdUninstall(rest, paths);
      case 'init': return cmdInit(rest, paths);
      case 'doctor': return await cmdDoctor(rest, paths);
      default: {
        const suggestion = suggestCommand(subcommand, COMMANDS);
        return failed([
          failLine(`Unknown command '${subcommand}'.` + (suggestion ? ` Did you mean '${suggestion}'?` : '')),
          err(term.dim(`Run 'claude-router help' for usage.`)),
        ]);
      }
    }
  } catch (e) {
    if (e instanceof CliUsageError) return failed([...prefix, failLine(e.message)]);
    throw e;
  }
}

// Only dispatch when executed as the entry script (`claude-router …` /
// `node dist/proxy/cli.js`). Importing this module (tests need main/startServer)
// must not run the CLI — before this guard, a bare import executed main()
// against the importer's argv and exited the process. (CJS output, so the
// require.main idiom is the entry check.)
if (require.main === module) {
  main(process.argv.slice(2))
    .then(renderResult)
    .catch((e) => {
      term.errorLine(String(e));
      process.exit(1);
    });
}
