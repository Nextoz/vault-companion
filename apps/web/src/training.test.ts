import { expect, it } from 'vitest';
import { trainingSummary } from './training.ts';
const base = { date: '2026-09-28', time: '', type: 'Run', distance: '5.2', duration: '28', weight: '', split: '', note: '' };
it('shows run distance, duration and computed minute:second pace', () => {
  expect(trainingSummary(base)).toBe('5.2 km · 28 min · 5:23 /km');
  expect(trainingSummary({ ...base, distance: '5.2 km', duration: '28 min' })).toBe('5.2 km · 28 min · 5:23 /km');
});
it('shows Gym fields and preserves legacy free text without invented pace', () => {
  expect(trainingSummary({ ...base, type: 'Gym', distance: '', split: 'Bicep', duration: '60', weight: '82.4' })).toBe('Bicep · 60 min · 82.4 kg');
  expect(trainingSummary({ ...base, type: 'Group workout', distance: '', duration: '' })).toBe('');
  expect(trainingSummary({ ...base, distance: 'unknown', duration: '' })).toBe('unknown');
  expect(trainingSummary({ ...base, distance: '0', duration: '28' })).toBe('0 km · 28 min');
});
