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
      .toEqual({ type: 'Run', when: '2026-09-28T10:00', distance: '5.2', distanceWas: null, duration: '28', durationWas: null, weight: '', weightWas: null, split: '', className: '', note: 'Easy loop' });
    expect(rowToDraft({ date: '2026-09-28', time: '', type: 'Gym', distance: '', duration: '60 min', weight: '82.4 kg', split: 'Tricep', note: '' }))
      .toEqual({ type: 'Gym', when: '', distance: '', distanceWas: null, duration: '60', durationWas: null, weight: '82.4', weightWas: null, split: 'Tricep', className: '', note: '' });
  });
  it('reads a legacy run without a unit and remembers cells it cannot parse', () => {
    expect(rowToDraft({ ...base, distance: '5.2km', duration: '28 min' }).distance).toBe('5.2');
    expect(rowToDraft({ ...base, distance: 'fast', duration: '', weight: 'heavy', note: '' }))
      .toMatchObject({ distance: '', distanceWas: 'fast', duration: '', durationWas: null, weight: '', weightWas: 'heavy' });
  });
  it('leaves an unsupported split unselected instead of defaulting it', () => {
    const draft = rowToDraft({ ...base, type: 'Gym', split: 'Push' });
    expect(draft.split).toBe('');
    expect(draft.className).toBe('');
  });
  it('keeps a literal backslash-pipe in the read’s note and class unchanged', () => {
    const draft = rowToDraft({ ...base, type: 'Gym', split: 'Group: Yoga\\|Spin', note: 'a \\| b' });
    expect(draft.split).toBe('Group');
    expect(draft.className).toBe('Yoga\\|Spin');
    expect(draft.note).toBe('a \\| b');
  });
});
