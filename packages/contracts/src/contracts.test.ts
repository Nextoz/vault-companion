import { describe, expect, it } from 'vitest';
import { CaptureNotePayload, CaptureTaskPayload } from './index.ts';

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
