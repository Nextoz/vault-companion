import { describe, expect, it } from 'vitest';
import { sanitize, type LogRecord } from './log.ts';

const base: LogRecord = { requestId: 'r', method: 'CRON', route: 'cron:morning-brief', status: 200, durationMs: 1 };

describe('sanitize unavailableCodes', () => {
  it('keeps known reader names mapped to a fixed ApiError code or threw', () => {
    expect(sanitize({ ...base, unavailableCodes: { calendar: 'google-reauth-needed', mail: 'upstream-unavailable', tasks: 'threw' } }))
      .toMatchObject({ unavailableCodes: { calendar: 'google-reauth-needed', mail: 'upstream-unavailable', tasks: 'threw' } });
  });

  it('drops an unknown reader name and an unknown code instead of logging them', () => {
    const record = sanitize({ ...base, unavailableCodes: { calendar: 'google-reauth-needed', 'SENTINEL-NAME': 'threw', mail: 'SENTINEL-CODE' } });
    expect(record.unavailableCodes).toEqual({ calendar: 'google-reauth-needed' });
    expect(JSON.stringify(record)).not.toContain('SENTINEL');
  });

  it('drops the field when nothing is valid, and leaves other fields untouched', () => {
    const record = sanitize({ ...base, operationId: 'op', unavailableCodes: { nope: 'nope' } as unknown as Record<string, string> });
    expect(record).toEqual({ ...base, operationId: 'op' });
  });

  it('drops the field for a non-object value', () => {
    expect(sanitize({ ...base, unavailableCodes: 'SENTINEL' as unknown as Record<string, string> })).toEqual(base);
  });
});
