import { describe, expect, it } from 'vitest';
import { AiBudgetProvider, AiBudgetResponse, AiUsageDay, AiUsageProvider, AiUsageResponse, CaptureNotePayload, CaptureTaskPayload, ScoutStatus, TasksResponse } from './index.ts';

describe('capture context', () => {
  it.each(['[[Projects/Boat]]', '[[Boat|the boat]]', 'https://example.com/a?b=c'])('accepts %j', (context) => {
    expect(CaptureNotePayload.safeParse({ text: 't', context }).success).toBe(true);
  });
  it.each([
    '[[a\u2028b]]',
    '[[a\u2029b]]',
    '[[a\u0085b]]',
    '[[a\u0000b]]',
    '[[a\nb]]',
    'https://example.com/\u2028x',
    'javascript:alert(1)',
    '[[a]] trailing',
    'plain text',
  ])('rejects %j', (context) => {
    expect(CaptureTaskPayload.safeParse({ text: 't', context }).success).toBe(false);
  });
});

describe('vault metadata schema', () => {
  const schema = TasksResponse.shape.vault;
  it('requires nullable, strict metadata and an ISO instant with a zone', () => {
    expect(schema.parse(null)).toBeNull();
    expect(schema.parse({ committedAt: '2026-09-26T14:07:00+02:00', fromApp: true })).toEqual({ committedAt: '2026-09-26T14:07:00+02:00', fromApp: true });
    for (const value of [undefined, {}, { committedAt: '2026-09-26T14:07:00', fromApp: false }, { committedAt: 'bad', fromApp: false }, { committedAt: '2026-09-26T12:07:00Z', fromApp: 'yes' }, { committedAt: '2026-09-26T12:07:00Z', fromApp: false, message: 'private' }]) {
      expect(schema.safeParse(value).success).toBe(false);
    }
  });
});

describe('scout status schema', () => {
  const base = {
    schemaVersion: 1,
    scoutId: 'scout-a',
    displayName: 'Scout A',
    schedule: null,
    expectedEveryHours: null,
    lastAttemptAt: null,
    lastSuccessAt: null,
    runStatus: 'success',
    sources: null,
    aiHealth: 'healthy',
    findings: 3,
    added: 1,
    errors: 0,
    lastError: null,
    latestOutput: null,
    history: [],
  } as const;

  it('turns an unknown aiHealth into null and keeps the rest of the record', () => {
    const parsed = ScoutStatus.parse({ ...base, aiHealth: 'degraded-cache' });
    expect(parsed.aiHealth).toBeNull();
    expect(parsed.runStatus).toBe('success');
    expect(parsed.displayName).toBe('Scout A');
    expect(parsed.findings).toBe(3);
  });

  it('turns an unknown runStatus into null and keeps the rest of the record', () => {
    const parsed = ScoutStatus.parse({ ...base, runStatus: 'paused' });
    expect(parsed.runStatus).toBeNull();
    expect(parsed.aiHealth).toBe('healthy');
    expect(parsed.scoutId).toBe('scout-a');
  });

  it('passes known enum values through unchanged', () => {
    const parsed = ScoutStatus.parse({ ...base, runStatus: 'degraded', aiHealth: 'failed' });
    expect(parsed.runStatus).toBe('degraded');
    expect(parsed.aiHealth).toBe('failed');
  });

  it('still rejects a wrong schemaVersion', () => {
    expect(ScoutStatus.safeParse({ ...base, schemaVersion: 2 }).success).toBe(false);
  });
});

describe('ai budget schema', () => {
  const provider = { id: 'claude', label: 'Claude weekly', kind: 'percent', value: 58, limit: 100, unit: null, resetsAt: null, history: [1, 2] };

  it('accepts a full provider, including nulls and history', () => {
    expect(AiBudgetProvider.safeParse(provider).success).toBe(true);
    expect(AiBudgetProvider.safeParse({ ...provider, limit: null, unit: null, resetsAt: null, history: null }).success).toBe(true);
  });

  it('rejects an unknown provider id or kind, and any extra field', () => {
    expect(AiBudgetProvider.safeParse({ ...provider, id: 'mystery' }).success).toBe(false);
    expect(AiBudgetProvider.safeParse({ ...provider, kind: 'credits' }).success).toBe(false);
    expect(AiBudgetProvider.safeParse({ ...provider, extra: 1 }).success).toBe(false);
  });

  it('is a strict response envelope with a nullable freeRamGb', () => {
    const rev = 'a'.repeat(40);
    const ok = { revision: rev, generatedAt: '2026-10-03T06:31:00+02:00', providers: [provider], freeRamGb: null };
    expect(AiBudgetResponse.safeParse(ok).success).toBe(true);
    expect(AiBudgetResponse.safeParse({ ...ok, extra: 1 }).success).toBe(false);
    expect(AiBudgetResponse.safeParse({ ...ok, revision: 'nope' }).success).toBe(false);
    expect(AiBudgetResponse.safeParse({ ...ok, generatedAt: '2026-10-03' }).success).toBe(false);
  });
});

describe('ai usage schema', () => {
  const day = { date: '2026-10-01', calls: 3, inputTokens: 100, outputTokens: 200, cacheWriteTokens: 10, cacheReadTokens: 20, cost: 0.42 };
  const provider = { label: 'Claude', currency: 'USD', days: [day], since: '2026-09-01' };

  it('accepts a day, including a provider without the optional fields', () => {
    expect(AiUsageDay.safeParse(day).success).toBe(true);
    expect(AiUsageProvider.safeParse({ days: [] }).success).toBe(true);
    expect(AiUsageProvider.safeParse({ label: 'Claude', currency: 'USD', days: [day], since: '2026-09-01' }).success).toBe(true);
  });

  it('rejects a malformed day and ignores unknown extra fields on a provider', () => {
    expect(AiUsageDay.safeParse({ ...day, date: '2026-10-01T00:00:00Z' }).success).toBe(false);
    expect(AiUsageDay.safeParse({ ...day, calls: -1 }).success).toBe(false);
    expect(AiUsageDay.safeParse({ ...day, cost: 'free' }).success).toBe(false);
    const parsed = AiUsageProvider.safeParse({ ...provider, extra: 1 });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).not.toHaveProperty('extra');
  });

  it('is a strict response envelope keyed by provider id, with a skipped count', () => {
    const rev = 'b'.repeat(40);
    const ok = { revision: rev, generatedAt: '2026-10-04T06:31:00+02:00', providers: { claude: provider, mystery: { days: [] } }, skipped: 1 };
    expect(AiUsageResponse.safeParse(ok).success).toBe(true);
    expect(AiUsageResponse.safeParse({ ...ok, extra: 1 }).success).toBe(false);
    expect(AiUsageResponse.safeParse({ ...ok, revision: 'nope' }).success).toBe(false);
    expect(AiUsageResponse.safeParse({ ...ok, skipped: -1 }).success).toBe(false);
  });
});