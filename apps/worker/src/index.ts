// Cloudflare Workers entry: composes the production app from environment bindings.
// Refuses to serve if auth is not Access or any binding is missing (docs/security.md).
import { createTrainingService, createActiveWorkService, createAiBudgetReadService, createAiUsageReadService, createCalendarLinksService, createCommandService, createHealthService, createHealthIngestService, createHistoryService, createLinkedNoteService, createMorningBriefReadService, createMorningService, createNotesService, createResearchRadarService, createScoutService, createTriageService, createWeatherService, DEFAULT_USER_TIME_ZONE, slotForCron } from '@vault-companion/domain';
import { createInstallationTokenSource, GitHubContentsStore } from '@vault-companion/github';
import { WEATHER_TIME_ZONE, type ApiError } from '@vault-companion/contracts';
import { createRemoteJWKSet, type JWTVerifyGetKey } from 'jose';
import { createApp } from './app.ts';
import { createDashboardService } from './dashboard.ts';
import { createMarketSource } from './market.ts';
import { createWatchlistSource } from './watchlist.ts';
import { createWeatherProvider } from './weather-provider.ts';
import { createGoogleReader } from './google-reader.ts';
import { createCalendarWriter } from './calendar-writer.ts';
import { createCalendarService } from './calendar-service.ts';
import { createAccessVerifier, createServiceTokenVerifier } from './auth.ts';
import { createGeminiExplainer } from './gemini.ts';
import { createScalewayChat } from './scaleway-chat.ts';
import { gatherCandidates } from './morning-brief-gather.ts';
import { cloudflareMailer, type BriefEmailBinding } from './morning-brief-email.ts';
import { BRIEF_ROUTE, briefSlotForCron, runBriefJob } from './morning-brief-job.ts';
import { diagnosticDetail, type LogRecord } from './log.ts';
import { EXPLAINER_ROUTE, runExplainerJob } from './research-explainer.ts';

/** ADR-0046: the Morning Brief is always the owner's Copenhagen calendar, never another configured zone. */
const MORNING_BRIEF_TIME_ZONE = 'Europe/Copenhagen';

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
  /** HC3a service token audience. Optional: unset disables POST /api/health/ingest. */
  HEALTH_INGEST_AUD?: string;
  /** ADR-0029: only the research-explainer cron uses it; optional so the API never depends on it. Never logged. */
  GEMINI_API_KEY?: string;
  /** ADR-0045/0046: only the morning-brief cron uses it; optional, so an unset key falls back. Never logged. */
  SCALEWAY_API_KEY?: string;
  /** MB1d: Workers `send_email` binding; optional, so an absent binding simply skips the email. */
  BRIEF_EMAIL?: BriefEmailBinding;
  /** MB1d: owner from/to addresses; optional secrets, never logged or committed. Email requires both. */
  BRIEF_EMAIL_FROM?: string;
  BRIEF_EMAIL_TO?: string;
  /** ADR-0044: read-only Google Calendar/Gmail metadata. Optional; the brief runs without them when any is unset. */
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_REFRESH_TOKEN?: string;
  /** ADR-0048: calendar write credential, exactly `calendar.events`. Optional; unset makes writes unavailable. */
  GOOGLE_CAL_WRITE_CLIENT_ID?: string;
  GOOGLE_CAL_WRITE_CLIENT_SECRET?: string;
  GOOGLE_CAL_WRITE_REFRESH_TOKEN?: string;
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
export function createProductionApp(env: Env, keys?: JWTVerifyGetKey, fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)) {
  const teamDomain = env.ACCESS_TEAM_DOMAIN.replace(/\/$/, '');
  const jwks = keys ?? createRemoteJWKSet(new URL(`${teamDomain}/cdn-cgi/access/certs`));
  const verify = createAccessVerifier({
    keys: jwks,
    issuer: teamDomain,
    audience: env.ACCESS_AUD,
    allowedEmails: env.ALLOWED_EMAILS.split(',').map((e) => e.trim()).filter(Boolean),
  });
  const verifyIngest = env.HEALTH_INGEST_AUD
    ? createServiceTokenVerifier({ keys: jwks, issuer: teamDomain, audience: env.HEALTH_INGEST_AUD })
    : undefined;
  const store = new GitHubContentsStore({
    owner: env.VAULT_OWNER,
    repo: env.VAULT_REPO,
    ...(env.VAULT_BRANCH ? { branch: env.VAULT_BRANCH } : {}),
    token: createInstallationTokenSource({ appId: env.GITHUB_APP_ID, privateKeyPem: env.GITHUB_APP_PRIVATE_KEY, installationId: env.GITHUB_INSTALLATION_ID }),
  });
  const weatherService = createWeatherService({
    reader: createWeatherProvider({ fetch: fetchImpl, now: () => Date.now() }),
    now: () => new Date(),
    timeZone: WEATHER_TIME_ZONE,
  });
  const services = {
    ...createCommandService({ store, now: () => new Date(), timeZone: env.USER_TIME_ZONE ?? DEFAULT_USER_TIME_ZONE }),
    ...createLinkedNoteService({ store }),
    ...createActiveWorkService({ store }),
    ...createTrainingService({ store }),
    ...createTriageService({ store }),
    ...createResearchRadarService({ store, now: () => new Date(), timeZone: env.USER_TIME_ZONE ?? DEFAULT_USER_TIME_ZONE }),
    ...createScoutService({ store }),
    ...createHealthService({ store, now: () => new Date(), timeZone: env.USER_TIME_ZONE ?? DEFAULT_USER_TIME_ZONE }),
    ...(env.HEALTH_INGEST_AUD ? createHealthIngestService({ store, now: () => new Date(), timeZone: env.USER_TIME_ZONE ?? DEFAULT_USER_TIME_ZONE }) : {}),
    ...createMorningService({ store, now: () => new Date(), timeZone: env.USER_TIME_ZONE ?? DEFAULT_USER_TIME_ZONE }),
    ...createMorningBriefReadService({ store }),
    ...createAiBudgetReadService({ store }),
    ...createAiUsageReadService({ store }),
    ...createHistoryService({ store, now: () => new Date(), timeZone: env.USER_TIME_ZONE ?? DEFAULT_USER_TIME_ZONE }),
    ...createNotesService({ store }),
    ...createDashboardService({
      market: createMarketSource({ fetch: fetchImpl, now: () => Date.now() }),
      watchlist: createWatchlistSource({ fetch: fetchImpl, now: () => Date.now() }),
      weather: weatherService,
      now: () => new Date(),
    }),
    ...weatherService,
    ...createCalendarService({
      links: createCalendarLinksService({ store, now: () => Date.now() }),
      writer: createCalendarWriter({
        clientId: env.GOOGLE_CAL_WRITE_CLIENT_ID ?? '',
        clientSecret: env.GOOGLE_CAL_WRITE_CLIENT_SECRET ?? '',
        refreshToken: env.GOOGLE_CAL_WRITE_REFRESH_TOKEN ?? '',
        fetch: fetchImpl,
        now: () => Date.now(),
      }),
    }),
  };
  return createApp({ verify, verifyIngest, appOrigin: env.APP_ORIGIN, services, log });
}

/**
 * Cron composition: research explainer (ADR-0029) and Morning Brief (ADR-0046). Every GitHub/model request goes
 * through one counting `fetch`, so the explainer run stays inside its subrequest budget. `fetchImpl` is for tests.
 */
export async function runScheduled(cron: string, env: Env, fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)): Promise<void> {
  const base = { requestId: crypto.randomUUID(), method: 'CRON' as const, durationMs: 0 };
  if (configProblems(env).length > 0) return log({ ...base, route: 'cron:unknown', status: 503, errorCode: 'not-configured' });
  const explainerSlot = slotForCron(cron);
  const briefSlot = briefSlotForCron(cron);
  if (!explainerSlot && !briefSlot) return log({ ...base, route: 'cron:unknown', status: 400, errorCode: 'unknown-cron' });
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

  if (explainerSlot) {
    if (!env.GEMINI_API_KEY) {
      log({ ...base, route: EXPLAINER_ROUTE, status: 503, errorCode: 'gemini-key-missing' });
    } else {
      try {
        await runExplainerJob(cron, {
          store,
          explainer: createGeminiExplainer({ apiKey: env.GEMINI_API_KEY, fetch: counted }),
          now: () => new Date(),
          timeZone: env.USER_TIME_ZONE ?? DEFAULT_USER_TIME_ZONE,
          subrequests: () => used,
          log,
        });
      } catch (err) {
        const detail = diagnosticDetail(err);
        log({
          ...base,
          route: EXPLAINER_ROUTE,
          status: 500,
          errorCode: 'internal',
          errorClass: err instanceof Error ? err.name : 'unknown',
          ...(detail ? { errorDetail: detail } : {}),
        });
      }
    }
  }

  if (briefSlot) {
    const timeZone = MORNING_BRIEF_TIME_ZONE;
    const now = () => new Date();
    const command = createCommandService({ store, now, timeZone });
    const training = createTrainingService({ store });
    const health = createHealthService({ store, now, timeZone });
    const weather = createWeatherService({ reader: createWeatherProvider({ fetch: counted, now: () => Date.now() }), now, timeZone });
    const unavailable: ApiError = { code: 'upstream-unavailable', message: 'reader unavailable', retryable: true };
    const googleReader = env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REFRESH_TOKEN
      ? createGoogleReader({
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        refreshToken: env.GOOGLE_REFRESH_TOKEN,
        fetch: counted,
        now,
      })
      : {
        readCalendar: () => Promise.resolve(unavailable),
        readMail: () => Promise.resolve(unavailable),
      };
    const gather = (day: string) => gatherCandidates({
      day,
      timeZone,
      readTasks: () => command.readTasks([]),
      readHealthHistory: () => health.readHealthHistory(),
      readTraining: () => training.readTraining(),
      readWeather: () => weather.readWeather(),
      readMood: () => Promise.resolve(unavailable),
      readCalendar: () => googleReader.readCalendar(),
      readMail: () => googleReader.readMail(),
    });
    try {
      await runBriefJob(cron, {
        store,
        gather,
        ...(env.SCALEWAY_API_KEY ? { chat: createScalewayChat({ apiKey: env.SCALEWAY_API_KEY, fetch: counted }) } : {}),
        ...(env.BRIEF_EMAIL && env.BRIEF_EMAIL_FROM && env.BRIEF_EMAIL_TO
          ? { mailer: cloudflareMailer(env.BRIEF_EMAIL, env.BRIEF_EMAIL_FROM, env.BRIEF_EMAIL_TO, async (f, t, raw) => {
            const { EmailMessage } = await import('cloudflare:email');
            return new EmailMessage(f, t, raw);
          }) }
          : {}),
        now,
        timeZone,
        log,
      });
    } catch (err) {
      const detail = diagnosticDetail(err);
      log({
        ...base,
        route: BRIEF_ROUTE,
        status: 500,
        errorCode: 'internal',
        errorClass: err instanceof Error ? err.name : 'unknown',
        ...(detail ? { errorDetail: detail } : {}),
      });
    }
  }
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
