import { describe, expect, it } from 'vitest';
import { groupClassSuggestions, rowToDraft, trainingRowKeys, trainingSummary } from './training.ts';
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

it('keeps each existing row key when a refresh prepends a session, and separates identical rows', () => {
  const older = { ...base, note: 'first' };
  const before = trainingRowKeys([older, base, base]);
  const after = trainingRowKeys([{ ...base, date: '2026-09-29' }, older, base, base]);
  expect(after.slice(1)).toEqual(before);
  expect(new Set(after).size).toBe(4);
});
it('suggests Group class names newest-first, distinct case-sensitively, capped at six, ignoring other splits', () => {
  const group = (split: string) => ({ ...base, type: 'Gym', split });
  const rows = [
    group('Group: Functional Express'), group('Group: Yoga'), group('Bicep'), group('Group: functional express'),
    group('Group: Run Club'), group('Group: Spin'), group('Group: Pilates'), group('Group: Boxing'),
    group('Group: HIIT'), group('Group: '), { ...base, split: 'Group:no-space' },
  ];
  expect(groupClassSuggestions(rows)).toEqual(['Functional Express', 'Yoga', 'functional express', 'Run Club', 'Spin', 'Pilates']);
});

describe('rowToDraft (B12)', () => {
  it('turns canonical cells into the sheet draft', () => {
    expect(rowToDraft({ date: '2026-09-28', time: '10:00', type: 'Run', distance: '5.2 km', duration: '28 min', weight: '', split: '', note: 'Easy loop' }))
      .toEqual({ type: 'Run', when: '2026-09-28T10:00', distance: '5.2', duration: '28', weight: '', split: 'Bicep', className: '', note: 'Easy loop' });
    expect(rowToDraft({ date: '2026-09-28', time: '', type: 'Gym', distance: '', duration: '60 min', weight: '82.4 kg', split: 'Tricep', note: '' }))
      .toEqual({ type: 'Gym', when: '', distance: '', duration: '60', weight: '82.4', split: 'Tricep', className: '', note: '' });
  });
  it('reads a legacy run without a unit and leaves unparseable cells empty', () => {
    expect(rowToDraft({ ...base, distance: '5.2km', duration: '28 min' }).distance).toBe('5.2');
    expect(rowToDraft({ ...base, distance: 'fast', duration: '', weight: 'heavy', note: '' }))
      .toMatchObject({ distance: '', duration: '', weight: '' });
    expect(rowToDraft({ ...base, type: 'Gym', split: 'Push' }).split).toBe('Bicep');
  });
  it('reads Group with its class name and unescapes the writer’s cells', () => {
    const draft = rowToDraft({ ...base, type: 'Gym', split: 'Group: Yoga\\|Spin', note: 'a \\\\ b \\| c' });
    expect(draft.split).toBe('Group');
    expect(draft.className).toBe('Yoga|Spin');
    expect(draft.note).toBe('a \\ b | c');
  });
});
