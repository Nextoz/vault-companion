import { expect, it } from 'vitest';
import { captureDefaultForTab } from './prefs.ts';

it.each([
  ['notes', 'note'],
  ['today', 'task'],
  ['all', 'task'],
  ['scouts', undefined],
  ['history', undefined],
] as const)('capture default for %s is %s', (tab, expected) => {
  expect(captureDefaultForTab(tab)).toBe(expected);
});
