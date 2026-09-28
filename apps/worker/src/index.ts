// Cloudflare Workers entry: composes the production app from environment bindings.
// Refuses to serve if auth is not Access or any binding is missing (docs/security.md).
import { createTrainingService, createActiveWorkService, createCommandService, createHistoryService, createLinkedNoteService, createNotesService, createScoutService, createTriageService, DEFAULT_USER_TIME_ZONE } from '@vault-companion/domain';
import { createInstallationTokenSource, GitHubContentsStore } from '@vault-companion/github';
import { createRemoteJWKSet, type JWTVerifyGetKey } from 'jose';
import { createApp } from './app.ts';
import { createAccessVerifier } from './auth.ts';
import { createGeminiExplainer } from './gemini.ts';
import type { LogRecord } from './log.ts';
import { EXPLAINER_ROUTE, runExplainerJob } from './research-explainer.ts';

export interface Env {
  AUTH_MODE: string;
  ACCESS_TEAM_DOMAIN: string; // e.g. https://<team>.cloudflareaccess.com
  ACCESS_AUD: string;
  ALLOWED_EMAILS: string; // comma-separated
  APP_ORIGIN: string;
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string; // secret, PKCS#8 PEM
  GITHUB_INSTALLATION_ID: string;
  VAULT_OWNER: string;
  VAULT_REPO: string;
  VAULT_BRANCH?: string;
  USER_TIME_ZONE?: string;
  /** ADR-0029: only the research-explainer cron uses it; optional so the API never depends on it. Never logged. */
  GEMINI_API_KEY?: string;
}

/** The two members of Cloudflare's ScheduledController/ExecutionContext the cron handler uses. */
export interface CronEvent {
  readonly cron: string;
}
export interface WaitUntil {
  waitUntil(promise: Promise<unknown>): void;
}

const REQUIRED: readonly (keyof Env)[] = [
  'ACCESS_TEAM_DOMAIN', 'ACCESS_AUD', 'ALLOWED_EMAILS', 'APP_ORIGIN',
  'GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY', 'GITHUB_INSTALLATION_ID', 'VAULT_OWNER', 'VAULT_REPO',
];

/** Names of missing/invalid settings; empty when the configuration may serve traffic. */
export function configProblems(env: Partial<Env>): string[] {
  const problems = REQUIRED.filter((k) => !env[k]).map((k) => `missing ${k}`);
  if (env.AUTH_MODE !== 'access') problems.push('AUTH_MODE must be "access" in production');
  if (env.APP_ORIGIN && !/^https:\/\/[^/]+$/.test(env.APP_ORIGIN)) problems.push('APP_ORIGIN must be an https origin');
  if (env.ACCESS_TEAM_DOMAIN && !/^https:\/\/[^/]+\/?$/.test(env.ACCESS_TEAM_DOMAIN)) problems.push('ACCESS_TEAM_DOMAIN must be an https origin');
  if (env.USER_TIME_ZONE && !isValidTimeZone(env.USER_TIME_ZONE)) problems.push('USER_TIME_ZONE is not a valid IANA zone');
  return problems;
}

const log = (r: LogRecord) => {
  // eslint-disable-next-line no-console -- the only log sink; records are allowlisted by type and sanitize()
  console.log(JSON.stringify(r));
};

let cached: { env: Env; app: ReturnType<typeof createApp> } | null = null;

function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** Production composition. `keys` is injectable so tests can prove the real wiring with a local JWKS (review R10). */
export function createProductionApp(env: Env, keys?: JWTVerifyGetKey) {
  const teamDomain = env.ACCESS_TEAM_DOMAIN.replace(/\/$/, '');
  const verify = createAccessVerifier({
    keys: keys ?? createRemoteJWKSet(new URL(`${teamDomain}/cdn-cgi/access/certs`)),
    issuer: teamDomain,
    audience: env.ACCESS_AUD,
    allowedEmails: env.ALLOWED_EMAILS.split(',').map((e) => e.trim()).filter(Boolean),
  });
  const store = new GitHubContentsStore({
    owner: env.VAULT_OWNER,
    repo: env.VAULT_REPO,
    ...(env.VAULT_BRANCH ? { branch: env.VAULT_BRANCH } : {}),
    token: createInstallationTokenSource({ appId: env.GITHUB_APP_ID, privateKeyPem: env.GITHUB_APP_PRIVATE_KEY, installationId: env.GITHUB_INSTALLATION_ID }),
  });
  const services = {
    ...createCommandService({ store, now: () => new Date(), timeZone: env.USER_TIME_ZONE ?? DEFAULT_USER_TIME_ZONE }),
    ...createLinkedNoteService({ store }),
    ...createActiveWorkService({ store }),
    ...createTrainingService({ store }),
    ...createTriageService({ store }),
    ...createScoutService({ store }),
    ...createHistoryService({ store, now: () => new Date(), timeZone: env.USER_TIME_ZONE ?? DEFAULT_USER_TIME_ZONE }),
    ...createNotesService({ store }),
  };
  return createApp({ verify, appOrigin: env.APP_ORIGIN, services, log });
}

/**
 * ADR-0029 cron: production composition of the research explainer. Every GitHub and Gemini request goes through one
 * counting `fetch`, so the run stays inside the subrequest budget (ADR-0029 amendment). `fetchImpl` is for tests.
 */
export async function runScheduled(cron: string, env: Env, fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)): Promise<void> {
  const started = { requestId: crypto.randomUUID(), method: 'CRON', route: EXPLAINER_ROUTE, durationMs: 0 };
  if (configProblems(env).length > 0) return log({ ...started, status: 503, errorCode: 'not-configured' });
  if (!env.GEMINI_API_KEY) return log({ ...started, status: 503, errorCode: 'gemini-key-missing' });
  let used = 0;
  const counted: typeof fetch = (input, init) => {
    used++;
    return fetchImpl(input, init);
  };
  const store = new GitHubContentsStore({
    owner: env.VAULT_OWNER,
    repo: env.VAULT_REPO,
    ...(env.VAULT_BRANCH ? { branch: env.VAULT_BRANCH } : {}),
    fetch: counted,
    token: createInstallationTokenSource({ appId: env.GITHUB_APP_ID, privateKeyPem: env.GITHUB_APP_PRIVATE_KEY, installationId: env.GITHUB_INSTALLATION_ID, fetch: counted }),
  });
  await runExplainerJob(cron, {
    store,
    explainer: createGeminiExplainer({ apiKey: env.GEMINI_API_KEY, fetch: counted }),
    now: () => new Date(),
    timeZone: env.USER_TIME_ZONE ?? DEFAULT_USER_TIME_ZONE,
    subrequests: () => used,
    log,
  });
}

export default {
  scheduled(event: CronEvent, env: Env, ctx: WaitUntil): void {
    ctx.waitUntil(runScheduled(event.cron, env));
  },

  fetch(request: Request, env: Env): Response | Promise<Response> {
    const problems = configProblems(env);
    if (problems.length > 0) {
      // Never reveal configuration details to the client.
      return new Response('Service not configured', { status: 503, headers: { 'Cache-Control': 'no-store' } });
    }
    if (!cached || cached.env !== env) cached = { env, app: createProductionApp(env) };
    return cached.app.fetch(request);
  },
};
