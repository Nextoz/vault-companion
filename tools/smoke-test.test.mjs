import { describe, expect, it, vi } from 'vitest';
import {
  buildRollbackCommand,
  extractDeployedVersionId,
  fetchWithRetry,
  findVersionAt100,
  formatSummary,
  isAllowedSmokeStatus,
  rollbackArgs,
  rollbackIfSmokeFailed,
  runSmokeTest,
} from './smoke-test.mjs';

const noSleep = async () => {};

describe('smoke-test.mjs', () => {
  it('accepts only the anonymous Access stop responses', () => {
    expect(isAllowedSmokeStatus(302)).toBe(true);
    expect(isAllowedSmokeStatus(403)).toBe(true);
    expect(isAllowedSmokeStatus(200)).toBe(false);
    expect(isAllowedSmokeStatus(301)).toBe(false);
  });

  it('extracts the deployed version id without printing wrangler output', () => {
    expect(extractDeployedVersionId('Uploaded assets\nCurrent Version ID: 11111111-1111-1111-1111-111111111111\n')).toBe(
      '11111111-1111-1111-1111-111111111111',
    );
    expect(() => extractDeployedVersionId('deploy failed')).toThrow(/Current Version ID/);
  });

  it('finds the production version carrying 100% traffic', () => {
    const deployment = {
      versions: [
        { version_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', percentage: 30 },
        { version_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', percentage: 70 },
        { version_id: 'cccccccc-cccc-cccc-cccc-cccccccccccc', percentage: 100 },
      ],
    };
    expect(findVersionAt100(deployment)).toBe('cccccccc-cccc-cccc-cccc-cccccccccccc');
    expect(findVersionAt100({ versions: [] })).toBeNull();
  });

  it('passes when both anonymous endpoints are blocked and the new version is at 100%', async () => {
    const fetchImpl = vi.fn(async (url) => ({ status: url.endsWith('/api/session') ? 403 : 302 }));
    const result = await runSmokeTest({
      baseUrl: 'https://vc.example.com/',
      newVersionId: 'new-version',
      deploymentStatus: { versions: [{ version_id: 'new-version', percentage: 100 }] },
      fetchImpl,
      sleep: noSleep,
    });

    expect(result.ok).toBe(true);
    expect(result.statusOk).toBe(true);
    expect(result.versionOk).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('retries a flaky fetch up to three times before failing', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error('network reset'))
      .mockResolvedValueOnce({ status: 302 })
      .mockResolvedValue({ status: 403 });
    const result = await runSmokeTest({
      baseUrl: 'https://vc.example.com',
      newVersionId: 'new-version',
      deploymentStatus: { versions: [{ version_id: 'new-version', percentage: 100 }] },
      fetchImpl,
      attempts: 3,
      sleep: noSleep,
    });

    expect(result.ok).toBe(true);
    expect(result.checks[0].attempts).toBe(2);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('fails the smoke when an endpoint answers 200, never rolling back from the pure test result', async () => {
    const fetchImpl = vi.fn(async () => ({ status: 200 }));
    const result = await runSmokeTest({
      baseUrl: 'https://vc.example.com',
      newVersionId: 'new-version',
      deploymentStatus: { versions: [{ version_id: 'new-version', percentage: 100 }] },
      fetchImpl,
      sleep: noSleep,
    });

    expect(result.ok).toBe(false);
    expect(result.statusOk).toBe(false);
    expect(result.versionOk).toBe(true);
  });

  it('fails the smoke when the deployed version is not at 100% traffic', async () => {
    const result = await runSmokeTest({
      baseUrl: 'https://vc.example.com',
      newVersionId: 'new-version',
      deploymentStatus: {
        versions: [
          { version_id: 'old-version', percentage: 70 },
          { version_id: 'new-version', percentage: 30 },
        ],
      },
      fetchImpl: async () => ({ status: 302 }),
      sleep: noSleep,
    });

    expect(result.ok).toBe(false);
    expect(result.statusOk).toBe(true);
    expect(result.versionOk).toBe(false);
    expect(result.currentVersionId).toBeNull();
  });

  it('runs rollback for a failing smoke result but not a passing one', () => {
    const rollback = vi.fn(() => ({ ok: true, status: 0, stdout: '', stderr: '' }));
    const failing = { ok: false, statusOk: false, versionOk: true, currentVersionId: 'new', versionError: null };
    const passing = { ok: true, statusOk: true, versionOk: true, currentVersionId: 'new', versionError: null };

    expect(rollbackIfSmokeFailed({ smoke: failing, previousVersionId: 'old', rollback }).rolledBack).toBe(true);
    expect(rollback).toHaveBeenCalledTimes(1);

    expect(rollbackIfSmokeFailed({ smoke: passing, previousVersionId: 'old', rollback }).rolledBack).toBe(false);
    expect(rollback).toHaveBeenCalledTimes(1);
  });

  it('does not roll back when the Cloudflare status API cannot be read', () => {
    const rollback = vi.fn();
    const smoke = { ok: false, statusOk: true, versionOk: false, currentVersionId: null, versionError: 'API down' };
    const decision = rollbackIfSmokeFailed({ smoke, previousVersionId: 'old', rollback });

    expect(decision.rolledBack).toBe(false);
    expect(decision.skippedReason).toMatch(/API down/);
    expect(rollback).not.toHaveBeenCalled();
  });

  it('builds an exact, secret-free rollback command and summary', () => {
    const command = buildRollbackCommand('old-version', 'CI smoke test failed');
    expect(command).toBe(
      'pnpm --filter @vault-companion/worker exec wrangler rollback old-version --message "CI smoke test failed" --yes',
    );
    expect(rollbackArgs('old-version', 'CI smoke test failed')).toEqual([
      '--filter',
      '@vault-companion/worker',
      'exec',
      'wrangler',
      'rollback',
      'old-version',
      '--message',
      'CI smoke test failed',
      '--yes',
    ]);

    const summary = formatSummary({
      newVersionId: 'new-version',
      previousVersionId: 'old-version',
      rollbackCommand: command,
      smoke: {
        ok: false,
        statusOk: false,
        versionOk: true,
        versionError: null,
        checks: [{ path: '/', status: 200, attempts: 3, error: null }],
      },
      decision: { rolledBack: true, rollbackResult: { ok: true, status: 0 } },
    });

    expect(summary).toContain('new-version');
    expect(summary).toContain('old-version');
    expect(summary).toContain(command);
    expect(summary).not.toMatch(/CLOUDFLARE_API_TOKEN|CLOUDFLARE_ACCOUNT_ID|hunter2/);
  });
});
