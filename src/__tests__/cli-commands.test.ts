import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main, startBanner, restartArgs, parseLogsArgs, isNetworkExposed } from '../proxy/cli.js';
import { routerPaths, parseServeArgs, type RouterPaths } from '../proxy/cli-config.js';
import { resetHistoryCache } from '../proxy/history.js';
import { DEFAULT_MODELS } from '../models.js';
import type { CommandResult } from '../proxy/command.js';

/**
 * Commands are reachable from a test at all because `paths` is a parameter now.
 * It used to be resolved once at module scope, so every command wrote to the
 * operator's real ~/.claude-router — even though daemon.ts, platform.ts and
 * cli-config.ts had all accepted an injectable RouterPaths for some time.
 */
function tempHome(): RouterPaths {
  return routerPaths(fs.mkdtempSync(path.join(os.tmpdir(), 'crouter-home-')));
}

/** Everything the command chose to show, stdout and stderr in emitted order. */
function text(result: CommandResult): string {
  return result.lines.map((l) => l.text).join('\n');
}

function stderrText(result: CommandResult): string {
  return result.lines.filter((l) => l.stderr).map((l) => l.text).join('\n');
}

describe('main — dispatch', () => {
  it('prints usage for no subcommand, help, and --help alike', async () => {
    for (const argv of [[], ['help'], ['--help'], ['-h']]) {
      const result = await main(argv, tempHome());
      assert.equal(result.exitCode, 0);
      assert.match(text(result), /claude-router install/);
    }
  });

  it('prints the bare version for -V', async () => {
    const result = await main(['--version'], tempHome());
    assert.equal(result.exitCode, 0);
    assert.match(text(result), /^\d+\.\d+\.\d+$/);
  });

  it('suggests the nearest command and exits 1 on a typo', async () => {
    const result = await main(['statuss'], tempHome());
    assert.equal(result.exitCode, 1);
    assert.match(stderrText(result), /Unknown command 'statuss'.*Did you mean 'status'/s);
  });

  it('turns a usage error into an exit code rather than a throw', async () => {
    const result = await main(['logs', '--bogus'], tempHome());
    assert.equal(result.exitCode, 1);
    assert.match(stderrText(result), /Unknown option '--bogus' for logs/);
  });

  it('warns that bare flags are deprecated before running start', async () => {
    // `--version` short-circuits before the legacy branch, so use a flag that
    // reaches it and then fails cheaply rather than binding a port.
    const result = await main(['--provider', 'nope'], tempHome());
    assert.match(stderrText(result), /Deprecated: bare flags now require the `start` subcommand/);
  });
});

describe('stats', () => {
  beforeEach(() => resetHistoryCache());

  it('says so plainly when nothing has been routed yet', async () => {
    const result = await main(['stats'], tempHome());
    assert.equal(result.exitCode, 0);
    assert.match(text(result), /No routing history yet/);
  });

  it('reports every tier that appears in history, fable included', async () => {
    const paths = tempHome();
    fs.mkdirSync(paths.configDir, { recursive: true });
    const events = [
      { timestamp: '2026-07-20T10:00:00.000Z', tier: 'haiku', model: 'claude-haiku-4-5', costCents: 1, savedCents: 2, confidence: 1, classifier: 'heuristic', retried: false, retryReason: null, inputTokens: 5, outputTokens: 5 },
      { timestamp: '2026-07-20T10:01:00.000Z', tier: 'fable', model: 'claude-fable-5', costCents: 9, savedCents: -4, confidence: 1, classifier: 'heuristic', retried: false, retryReason: null, inputTokens: 5, outputTokens: 5 },
    ];
    fs.writeFileSync(paths.historyFile, events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');

    const result = await main(['stats'], paths);
    assert.equal(result.exitCode, 0);
    const shown = text(result);
    assert.match(shown, /Requests\s+2/);
    assert.match(shown, /haiku 1/);
    assert.match(shown, /fable 1/, 'a fable route must not vanish from the tier line');
  });

  it('--json emits the raw totals', async () => {
    const result = await main(['stats', '--json'], tempHome());
    const parsed = JSON.parse(text(result)) as { requests: number };
    assert.equal(parsed.requests, 0);
  });
});

describe('init', () => {
  it('writes a config file, then refuses to clobber it without --force', async () => {
    const paths = tempHome();

    const first = await main(['init', '--port', '4111'], paths);
    assert.equal(first.exitCode, 0);
    assert.equal(JSON.parse(fs.readFileSync(paths.configFile, 'utf8')).port, 4111);

    const second = await main(['init', '--port', '4222'], paths);
    assert.equal(second.exitCode, 1);
    assert.match(stderrText(second), /already exists\. Use --force to overwrite/);
    assert.equal(JSON.parse(fs.readFileSync(paths.configFile, 'utf8')).port, 4111, 'left untouched');

    const forced = await main(['init', '--force', '--port', '4222'], paths);
    assert.equal(forced.exitCode, 0);
    assert.equal(JSON.parse(fs.readFileSync(paths.configFile, 'utf8')).port, 4222);
  });
});

describe('logs', () => {
  it('points at the daemon command when there is no log file yet', async () => {
    const result = await main(['logs'], tempHome());
    assert.equal(result.exitCode, 0);
    assert.match(text(result), /No log file yet/);
  });

  it('emits the tail verbatim, without a second newline', async () => {
    const paths = tempHome();
    fs.mkdirSync(paths.configDir, { recursive: true });
    fs.writeFileSync(paths.logFile, 'one\ntwo\nthree\n', 'utf8');

    const result = await main(['logs', '-n', '2'], paths);
    const tail = result.lines.find((l) => l.raw);
    assert.ok(tail, 'log content is written raw, not through console.log');
    assert.equal(tail.text, 'two\nthree\n');
  });
});

describe('parseLogsArgs', () => {
  it('defaults to 50 lines, no follow', () => {
    assert.deepEqual(parseLogsArgs([]), { lines: 50, follow: false });
  });

  it('accepts -f/--follow and -n/--lines', () => {
    assert.deepEqual(parseLogsArgs(['-f', '-n', '10']), { lines: 10, follow: true });
    assert.deepEqual(parseLogsArgs(['--follow', '--lines', '7']), { lines: 7, follow: true });
  });

  it('falls back to 50 on a non-numeric count', () => {
    assert.equal(parseLogsArgs(['-n', 'abc']).lines, 50);
  });

  it('rejects an unknown flag', () => {
    assert.throws(() => parseLogsArgs(['--nope']), /Unknown option '--nope' for logs/);
  });
});

describe('restartArgs', () => {
  it('inherits the previous daemon args when none are given', () => {
    assert.deepEqual(restartArgs([], ['--force-route', '--port', '4500']), ['--force-route', '--port', '4500']);
  });

  it('prefers the args just given', () => {
    assert.deepEqual(restartArgs(['--verbose'], ['--force-route']), ['--verbose']);
  });

  it('falls back to defaults with no args and no previous state', () => {
    assert.deepEqual(restartArgs([], undefined), []);
  });
});

describe('startBanner', () => {
  const paths = routerPaths(path.join(os.tmpdir(), 'crouter-banner'));
  const banner = (argv: string[]) =>
    startBanner(parseServeArgs(argv, {}), DEFAULT_MODELS, false, paths);

  it('does not warn on the default local bind', () => {
    assert.equal(isNetworkExposed('127.0.0.1'), false);
    assert.equal(banner([]).filter((l) => l.stderr).length, 0);
  });

  it('warns about an open relay when anthropic is exposed to the network', () => {
    const warning = banner(['--host', '0.0.0.0']).find((l) => l.stderr);
    assert.ok(warning);
    assert.match(warning.text, /open, unauthenticated relay to the Anthropic API/);
  });

  it('warns about cloud credentials instead when the provider is bedrock', () => {
    const warning = banner(['--host', '0.0.0.0', '--provider', 'bedrock']).find((l) => l.stderr);
    assert.ok(warning);
    assert.match(warning.text, /exposes YOUR cloud credentials/);
  });

  it('shows a pinned coordinator session, and flags when it cannot take effect', () => {
    // The pin skips the classifier for the main session, so it belongs on the
    // banner — and silently doing nothing without --force-route is worse than
    // saying so.
    const inert = banner(['--session-model', 'opus']).map((l) => l.text).join('\n');
    assert.match(inert, /Session/);
    assert.match(inert, /needs --force-route to take effect/);

    const live = banner(['--session-model', 'opus', '--force-route']).map((l) => l.text).join('\n');
    assert.match(live, /subagents still routed/);

    assert.ok(!banner([]).map((l) => l.text).join('\n').includes('Session'), 'absent when unpinned');
  });

  it('always shows a redirected upstream, and never a default one', () => {
    const redirected = banner(['--upstream', 'http://localhost:9999']).map((l) => l.text).join('\n');
    assert.match(redirected, /Upstream/);
    assert.match(redirected, /\(not Anthropic\)/);

    assert.ok(!banner([]).map((l) => l.text).join('\n').includes('Upstream'));
  });
});
