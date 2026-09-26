// Unexpected errors are logged with their class and, only for the adapters' fixed diagnostics, their message — so a
// production 503 can be diagnosed without ever logging task or note text.
import { describe, expect, it } from 'vitest';
import { createApp, type Services } from './app.ts';
import type { LogRecord } from './log.ts';

const ACCOUNT = 'a'.repeat(64);

function appThrowing(error: Error) {
  const logs: LogRecord[] = [];
  const services = {
    execute: async () => { throw error; },
    readTasks: async () => { throw error; },
  } as unknown as Services;
  const app = createApp({
    verify: async () => ({ ok: true, email: 'owner@example.com', accountKey: ACCOUNT }),
    appOrigin: 'https://vc.example.com',
    services,
    log: (r) => logs.push(r),
  });
  return { app, logs };
}

class StoreUnavailable extends Error {
  override name = 'StoreUnavailable';
}

describe('unexpected-error diagnostics in the log', () => {
  it('logs the class and a fixed adapter diagnostic', async () => {
    const { app, logs } = appThrowing(new StoreUnavailable('installation token request failed with status 401'));
    const res = await app.request('/api/tasks');
    expect(res.status).toBe(503);
    expect(logs.at(-1)).toMatchObject({ route: '/api/tasks', status: 503, errorClass: 'StoreUnavailable', errorDetail: 'installation token request failed with status 401' });
  });

  it('drops any other message, even plain words that could be task text', async () => {
    const { app, logs } = appThrowing(new Error('Water the plants tomorrow'));
    await app.request('/api/tasks');
    const last = logs.at(-1)!;
    expect(last.errorClass).toBe('Error');
    expect(last.errorDetail).toBeUndefined();
    expect(JSON.stringify(logs)).not.toContain('Water');
  });
});
