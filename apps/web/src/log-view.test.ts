import { describe, expect, it } from 'vitest';
import { LOG_VIEWS, rememberedLogView } from './log-view.ts';

describe('remembered Log view (R3b)', () => {
  it('reopens the saved view', () => {
    for (const view of LOG_VIEWS) expect(rememberedLogView(view)).toBe(view);
  });

  it('falls back to Training when nothing or something unknown was saved', () => {
    expect(rememberedLogView(null)).toBe('training');
    expect(rememberedLogView('')).toBe('training');
    // Real screens that are not Log views must never be reopened by the Log tab.
    expect(rememberedLogView('today')).toBe('training');
    expect(rememberedLogView('status')).toBe('training');
    expect(rememberedLogView('Reading')).toBe('training');
  });
});
