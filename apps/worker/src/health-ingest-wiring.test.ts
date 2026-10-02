import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { createProductionApp, type Env } from './index.ts';

const ORIGIN = 'https://vc.example.com';
const TEAM = 'https://team.cloudflareaccess.com';
const INGEST_AUD = 'health-ingest-aud';

const env: Env = {
  AUTH_MODE: 'access',
  ACCESS_TEAM_DOMAIN: TEAM,
  ACCESS_AUD: 'aud-1',
  ALLOWED_EMAILS: 'owner@example.com',
  APP_ORIGIN: ORIGIN,
  GITHUB_APP_ID: '1',
  GITHUB_APP_PRIVATE_KEY: 'unused-in-this-test',
  GITHUB_INSTALLATION_ID: '2',
  VAULT_OWNER: 'o',
  VAULT_REPO: 'r',
};

async function buildApp(audience?: string) {
  const kp = await generateKeyPair('RS256', { extractable: true });
  const keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(kp.publicKey)), kid: 'k', alg: 'RS256' }] });
  const configured = audience ? { ...env, HEALTH_INGEST_AUD: audience } : env;
  const app = createProductionApp(configured, keys);
  const token = await new SignJWT({ common_name: 'health-ingest-shortcut' })
    .setProtectedHeader({ alg: 'RS256', kid: 'k' })
    .setIssuer(TEAM)
    .setAudience(audience ?? INGEST_AUD)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(kp.privateKey);
  return { app, token };
}

function request(app: ReturnType<typeof createProductionApp>, token: string) {
  return app.fetch(
    new Request(`${ORIGIN}/api/health/ingest`, {
      method: 'POST',
      headers: { 'Cf-Access-Jwt-Assertion': token, 'Content-Type': 'application/json' },
      body: '{}',
    }),
  );
}

describe('health ingest production wiring', () => {
  it('wires ingestHealth when HEALTH_INGEST_AUD is set; a valid service token reaches the service, not 404', async () => {
    const { app, token } = await buildApp(INGEST_AUD);
    const res = await request(app, token);
    expect(res.status).not.toBe(404);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: 'invalid schemaVersion' });
  });

  it('leaves the route disabled when HEALTH_INGEST_AUD is unset', async () => {
    const { app, token } = await buildApp(undefined);
    const res = await request(app, token);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ ok: false, error: 'not found' });
  });
});
