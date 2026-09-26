// Cloudflare Workers entry: composes the production app from environment bindings.
// Refuses to serve if auth is not Access or any binding is missing (docs/security.md).
import { createCommandService, createLinkedNoteService, DEFAULT_USER_TIME_ZONE } from '@vault-companion/domain';
import { createInstallationTokenSource, GitHubContentsStore } from '@vault-companion/github';
import { createRemoteJWKSet, type JWTVerifyGetKey } from 'jose';
import { createApp } from './app.ts';
import { createAccessVerifier } from './auth.ts';
import type { LogRecord } from './log.ts';

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
  };
  return createApp({ verify, appOrigin: env.APP_ORIGIN, services, log });
}

export default {
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
