import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { failureCount, runDiagnostics, type Diagnostic, type DoctorProbes } from '../proxy/doctor.js';
import { SERVICE_ID, type HealthInfo } from '../proxy/health.js';

const HEALTHY: HealthInfo = {
  status: 'ok',
  service: SERVICE_ID,
  classifier: 'hybrid',
  provider: 'anthropic',
  forceRoute: true,
  requests: 3,
  lastTier: 'sonnet',
  lastModel: 'claude-sonnet-5',
};

/** A machine where everything is configured. Override one field per test. */
function probes(overrides: Partial<DoctorProbes> = {}): DoctorProbes {
  return {
    nodeVersion: '22.1.0',
    platform: 'linux',
    loadConfig: () => ({ loaded: true }),
    checkHealth: async () => HEALTHY,
    isEnvVarSet: () => true,
    apiKeySet: () => true,
    daemonState: () => null,
    isProcessAlive: () => true,
    isAutostartRegistered: () => true,
    isStatuslineConfigured: () => true,
    ...overrides,
  };
}

const OPTIONS = { port: 4000, provider: 'anthropic', configFile: '/home/u/.claude-router/config.json' };

function find(diagnostics: Diagnostic[], pattern: RegExp): Diagnostic {
  const match = diagnostics.find((d) => pattern.test(d.label));
  assert.ok(match, `no diagnostic matching ${pattern}`);
  return match;
}

describe('runDiagnostics', () => {
  it('passes everything on a fully configured machine', async () => {
    const diagnostics = await runDiagnostics(OPTIONS, probes());
    assert.equal(failureCount(diagnostics), 0);
    assert.ok(diagnostics.every((d) => d.ok));
  });

  it('counts only hard failures toward the exit code', async () => {
    // The exit code is doctor's contract for CI. A missing proxy and a missing
    // env var are failures; an unregistered autostart is a warning.
    const diagnostics = await runDiagnostics(
      OPTIONS,
      probes({
        checkHealth: async () => null,
        isEnvVarSet: () => false,
        isAutostartRegistered: () => false,
        isStatuslineConfigured: () => false,
      }),
    );
    assert.equal(failureCount(diagnostics), 2);
    assert.equal(find(diagnostics, /Autostart not registered/).warnOnly, true);
  });

  it('fails an unsupported Node version', async () => {
    const diagnostics = await runDiagnostics(OPTIONS, probes({ nodeVersion: '16.20.0' }));
    assert.equal(find(diagnostics, /^Node 16/).ok, false);
    assert.equal(failureCount(diagnostics), 1);
  });

  it('reports an unreadable config file as a failure with a fix', async () => {
    const diagnostics = await runDiagnostics(
      OPTIONS,
      probes({ loadConfig: () => ({ loaded: false, error: 'Unexpected token }' }) }),
    );
    const d = find(diagnostics, /Config file invalid/);
    assert.equal(d.ok, false);
    assert.match(d.hint!, /claude-router init --force/);
  });

  it('gives a Windows-specific hint for the env var', async () => {
    const linux = await runDiagnostics(OPTIONS, probes({ isEnvVarSet: () => false }));
    assert.match(find(linux, /ANTHROPIC_BASE_URL is not set/).hint!, /export ANTHROPIC_BASE_URL/);

    const windows = await runDiagnostics(
      OPTIONS,
      probes({ isEnvVarSet: () => false, platform: 'windows' }),
    );
    assert.match(find(windows, /ANTHROPIC_BASE_URL is not set/).hint!, /^Set it: setx/);
  });

  describe('ANTHROPIC_API_KEY', () => {
    it('is fine when unset on the anthropic provider — Claude Code sends its own', async () => {
      const diagnostics = await runDiagnostics(OPTIONS, probes({ apiKeySet: () => false }));
      const d = find(diagnostics, /ANTHROPIC_API_KEY/);
      assert.equal(d.warnOnly, true);
      assert.match(d.label, /fine if Claude Code sends its own auth/);
    });

    it('says why a missing key passes on a cloud provider', async () => {
      // The verdict and its label used to disagree: with --provider bedrock and
      // no key, a green tick sat next to the words "ANTHROPIC_API_KEY not set".
      const diagnostics = await runDiagnostics(
        { ...OPTIONS, provider: 'bedrock' },
        probes({ apiKeySet: () => false }),
      );
      const d = find(diagnostics, /ANTHROPIC_API_KEY/);
      assert.equal(d.ok, true);
      assert.match(d.label, /not needed for the bedrock provider/);
    });
  });

  describe('daemon state', () => {
    it('is not reported at all when there is no state file', async () => {
      const diagnostics = await runDiagnostics(OPTIONS, probes());
      assert.equal(diagnostics.find((d) => /daemon state/i.test(d.label)), undefined);
    });

    it('warns about a stale record without failing the run', async () => {
      const diagnostics = await runDiagnostics(
        OPTIONS,
        probes({
          daemonState: () => ({ pid: 4242, port: 4000, startedAt: '2026-07-01T00:00:00.000Z', args: [] }),
          isProcessAlive: () => false,
        }),
      );
      const d = find(diagnostics, /Stale daemon state/);
      assert.equal(d.ok, false);
      assert.equal(d.warnOnly, true);
      assert.match(d.label, /pid 4242 is gone/);
      assert.equal(failureCount(diagnostics), 0);
    });
  });

  it('probes each fact exactly once', async () => {
    // Every probe used to run twice — once for the verdict and once to build the
    // label — which on Windows meant two `reg query` subprocesses per check.
    const calls: Record<string, number> = {};
    const count = <T>(name: string, value: T) => () => {
      calls[name] = (calls[name] ?? 0) + 1;
      return value;
    };

    await runDiagnostics(
      OPTIONS,
      probes({
        daemonState: count('daemonState', { pid: 1, port: 4000, startedAt: '', args: [] }),
        isProcessAlive: count('isProcessAlive', true),
        isAutostartRegistered: count('isAutostartRegistered', true),
        isStatuslineConfigured: count('isStatuslineConfigured', true),
        isEnvVarSet: count('isEnvVarSet', true),
        apiKeySet: count('apiKeySet', true),
      }),
    );

    assert.deepEqual(calls, {
      daemonState: 1,
      isProcessAlive: 1,
      isAutostartRegistered: 1,
      isStatuslineConfigured: 1,
      isEnvVarSet: 1,
      apiKeySet: 1,
    });
  });
});
