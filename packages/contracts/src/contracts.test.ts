import { describe, expect, it } from 'vitest';
import { CaptureNotePayload, CaptureTaskPayload, TasksResponse } from './index.ts';

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
