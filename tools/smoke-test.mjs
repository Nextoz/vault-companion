import { appendFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const WORKER_PACKAGE = '@vault-companion/worker';
const DEFAULT_REASON = 'CI smoke test failed';
const ALLOWED_STATUSES = new Set([302, 403]);

class NoCurrentDeploymentError extends Error {}

export function isAllowedSmokeStatus(status) {
  return ALLOWED_STATUSES.has(status);
}

export function buildRollbackCommand(previousVersionId, reason = DEFAULT_REASON) {
  if (!previousVersionId || previousVersionId === 'none') {
    return 'none (no previous production version was recorded)';
  }
  return `pnpm --filter ${WORKER_PACKAGE} exec wrangler rollback ${previousVersionId} --message "${reason}" --yes`;
}

export function rollbackArgs(previousVersionId, reason = DEFAULT_REASON) {
  return [
    '--filter',
    WORKER_PACKAGE,
    'exec',
    'wrangler',
    'rollback',
    previousVersionId,
    '--message',
    reason,
    '--yes',
  ];
}

export function executeRollback({ previousVersionId, reason = DEFAULT_REASON, spawn = spawnSync } = {}) {
  let result;
  try {
    result = spawn('pnpm', rollbackArgs(previousVersionId, reason), {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    return { ok: false, status: null, stdout: '', stderr: '', error: String(error.message ?? error) };
  }
  const status = result.status ?? 1;
  return {
    ok: status === 0,
    status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: null,
  };
}

export function parseJsonOutput(output) {
  const text = String(output);
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1) {
    throw new Error('no JSON object found in wrangler output');
  }
  return JSON.parse(text.slice(start, end + 1));
}

export function findVersionAt100(deployment) {
  const versions = Array.isArray(deployment?.versions) ? deployment.versions : [];
  const current = versions.find((entry) => entry && entry.percentage === 100);
  return current?.version_id ?? null;
}

export function extractDeployedVersionId(output) {
  const match = /Current Version ID:\s*([0-9a-f-]{36})/i.exec(String(output));
  if (!match) {
    throw new Error('could not find Current Version ID in wrangler deploy output');
  }
  return match[1];
}

function defaultSleep() {
  return new Promise((resolve) => setTimeout(resolve, 1_000));
}

export async function fetchWithRetry(url, { fetchImpl = globalThis.fetch, attempts = 3, sleep = defaultSleep } = {}) {
  const maxAttempts = Math.max(1, attempts);
  let response;
  let error = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      response = await fetchImpl(url);
      if (isAllowedSmokeStatus(response?.status)) {
        return { response, attempts: attempt, error: null };
      }
    } catch (caught) {
      error = caught;
      response = undefined;
    }
    if (attempt < maxAttempts) {
      await sleep(attempt);
    }
  }

  return { response, attempts: maxAttempts, error };
}

export async function runSmokeTest({
  baseUrl,
  newVersionId,
  deploymentStatus,
  versionError = null,
  fetchImpl = globalThis.fetch,
  attempts = 3,
  sleep,
} = {}) {
  const origin = String(baseUrl).replace(/\/+$/, '');
  const checks = [];

  for (const path of ['/', '/api/session']) {
    const result = await fetchWithRetry(`${origin}${path}`, { fetchImpl, attempts, sleep });
    checks.push({
      path,
      status: result.response?.status ?? null,
      attempts: result.attempts,
      error: result.error ? String(result.error.message ?? result.error) : null,
    });
  }

  const statusOk = checks.every((check) => check.error === null && isAllowedSmokeStatus(check.status));
  const currentVersionId = versionError ? null : findVersionAt100(deploymentStatus);
  const versionOk = versionError ? false : currentVersionId === newVersionId;

  return {
    ok: statusOk && versionOk,
    statusOk,
    versionOk,
    currentVersionId,
    versionError: versionError ?? null,
    checks,
  };
}

export function rollbackIfSmokeFailed({
  smoke,
  previousVersionId,
  reason = DEFAULT_REASON,
  rollback = executeRollback,
} = {}) {
  if (smoke.ok) {
    return { rolledBack: false, skippedReason: null, rollbackResult: null };
  }
  if (smoke.versionError && smoke.statusOk) {
    return {
      rolledBack: false,
      skippedReason: `Cloudflare deployment status could not be read: ${smoke.versionError}`,
      rollbackResult: null,
    };
  }
  if (!previousVersionId || previousVersionId === 'none') {
    return { rolledBack: false, skippedReason: 'no previous production version was recorded', rollbackResult: null };
  }
  let rollbackResult;
  try {
    rollbackResult = rollback({ previousVersionId, reason });
  } catch (error) {
    rollbackResult = { ok: false, status: null, stdout: '', stderr: '', error: String(error.message ?? error) };
  }
  return { rolledBack: true, skippedReason: null, rollbackResult };
}

export function formatSummary({ newVersionId, previousVersionId, rollbackCommand, smoke, decision }) {
  const lines = [
    '## Production deploy',
    `- New version: \`${newVersionId || 'unknown'}\``,
    `- Previous version: \`${previousVersionId || 'none'}\``,
    `- Rollback command: \`${rollbackCommand}\``,
    '',
    '### Smoke test',
  ];

  for (const check of smoke.checks) {
    const attempts = check.attempts > 1 ? ` after ${check.attempts} attempts` : '';
    const result = check.error ? `error (${check.error})` : `HTTP ${check.status}`;
    lines.push(`- ${check.path}: ${result}${attempts}`);
  }

  lines.push(
    `- New version at 100%: ${smoke.versionOk ? 'yes' : smoke.versionError ? `not verified (${smoke.versionError})` : 'no'}`,
  );
  lines.push('', `- Result: ${smoke.ok ? 'passed' : 'failed'}`);

  if (!smoke.ok) {
    if (decision?.rolledBack) {
      lines.push('- Rollback: executed');
      if (!decision.rollbackResult?.ok) {
        lines.push(`- **ROLLBACK FAILED (exit ${decision.rollbackResult?.status ?? 'unknown'})** — run it by hand: \`${rollbackCommand}\``);
      }
    } else if (decision?.skippedReason) {
      lines.push(`- Rollback: not run (${decision.skippedReason})`);
    }
  }

  return `${lines.join('\n')}\n`;
}

function runWrangler(args) {
  return spawnSync('pnpm', ['--filter', WORKER_PACKAGE, 'exec', 'wrangler', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function readDeploymentStatus() {
  const result = runWrangler(['deployments', 'status', '--json']);
  if (result.status !== 0) {
    const combined = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    if (/no deployments/i.test(combined)) {
      throw new NoCurrentDeploymentError('no current deployment found');
    }
    throw new Error('could not read Cloudflare deployment status');
  }
  return parseJsonOutput(result.stdout ?? '');
}

function readCurrentVersionId() {
  try {
    return findVersionAt100(readDeploymentStatus()) ?? 'none';
  } catch (error) {
    if (error instanceof NoCurrentDeploymentError) {
      return 'none';
    }
    throw error;
  }
}

function writeSummary(summaryFile, summary) {
  if (summaryFile) {
    appendFileSync(summaryFile, summary);
  } else {
    process.stdout.write(summary);
  }
}

function fail(message, exitCode = 2) {
  process.stderr.write(`smoke-test: ${message}\n`);
  process.exit(exitCode);
}

async function smokeMain(options) {
  const attempts = Number.parseInt(options.attempts ?? '3', 10) || 3;
  const baseUrl = options['base-url'];
  const newVersionId = options['new-version'];
  const previousVersionId = options['previous-version'];
  const summaryFile = options['summary-file'];

  if (!baseUrl) fail('--base-url is required');
  if (!newVersionId) fail('--new-version is required');
  if (!previousVersionId) fail('--previous-version is required');

  let deploymentStatus;
  let versionError = null;
  try {
    deploymentStatus = readDeploymentStatus();
  } catch (error) {
    versionError = error.message;
  }

  const smoke = await runSmokeTest({ baseUrl, newVersionId, deploymentStatus, versionError, attempts });
  const rollbackCommand = buildRollbackCommand(previousVersionId);
  const decision = rollbackIfSmokeFailed({ smoke, previousVersionId });
  const summary = formatSummary({ newVersionId, previousVersionId, rollbackCommand, smoke, decision });

  writeSummary(summaryFile, summary);
  if (!smoke.ok) {
    if (decision.rolledBack && !decision.rollbackResult?.ok) {
      process.stderr.write(`ROLLBACK FAILED (exit ${decision.rollbackResult?.status ?? 'unknown'}). ${rollbackCommand}\n`);
    }
    process.exit(1);
  }
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      'base-url': { type: 'string' },
      'new-version': { type: 'string' },
      'previous-version': { type: 'string' },
      'summary-file': { type: 'string' },
      attempts: { type: 'string' },
      file: { type: 'string', short: 'f' },
    },
  });

  const command = positionals[0];

  if (command === 'current-version') {
    try {
      process.stdout.write(`${readCurrentVersionId()}\n`);
    } catch (error) {
      fail(error.message);
    }
  } else if (command === 'deploy-version') {
    if (!values.file) fail('--file is required for deploy-version');
    try {
      process.stdout.write(`${extractDeployedVersionId(readFileSync(values.file, 'utf8'))}\n`);
    } catch (error) {
      fail(error.message);
    }
  } else {
    await smokeMain(values);
  }
}
