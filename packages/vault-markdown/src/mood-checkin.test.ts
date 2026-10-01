// Daily-note mood check-in: exact golden bytes. Synthetic notes only.
import { describe, expect, it } from 'vitest';
import { applyMoodCheckin, renderDailyNote } from './mood-checkin.ts';
import type { MoodCheckinInput } from './mood-checkin.ts';

const BOM = '\uFEFF';
const ISO = '2026-10-01T06:14:00.000Z';

function applied(text: string, input: MoodCheckinInput): string {
  const result = applyMoodCheckin(text, input);
  if (!result.ok) throw new Error(`refused: ${result.code}`);
  return result.text;
}

function refusal(text: string, input: MoodCheckinInput): string {
  const result = applyMoodCheckin(text, input);
  return result.ok ? 'ok' : result.code;
}

function renderCode(template: string, date: string): string {
  const result = renderDailyNote(template, date);
  return result.ok ? 'ok' : result.code;
}

const valid: MoodCheckinInput = { mood: -1, energy: 2, sleep: 7.5, checkinAt: ISO };

describe('applyMoodCheckin golden bytes', () => {
  it('writes empty values and leaves other keys, tags and body byte-identical', () => {
    const source = ['---', 'date: 2026-10-01', 'mood:', 'energy:', 'sleep:', 'checkin_at:', 'irritability: high', 'tags:', '  - daily', '---', '', 'Body text', ''].join('\n');
    const expected = ['---', 'date: 2026-10-01', 'mood: -1', 'energy: 2', 'sleep: 7.5', 'checkin_at: 2026-10-01T06:14:00.000Z', 'irritability: high', 'tags:', '  - daily', '---', '', 'Body text', ''].join('\n');
    expect(applied(source, valid)).toBe(expected);
  });

  it('replaces existing signed integers, a sleep number and an HH:MM time', () => {
    const source = ['---', 'mood: -2', 'energy: 0', 'sleep: 6', 'checkin_at: 06:14', '---', '', 'Body', ''].join('\n');
    const expected = ['---', 'mood: 3', 'energy: -3', 'sleep: 8', 'checkin_at: 2026-10-01T06:14:00.000Z', '---', '', 'Body', ''].join('\n');
    expect(applied(source, { mood: 3, energy: -3, sleep: 8, checkinAt: ISO })).toBe(expected);
  });

  it('keeps CRLF and every untouched byte', () => {
    const source = ['---', 'mood:', 'energy: 1', 'sleep: 8.5', 'checkin_at: 06:14', '---', 'Body'].join('\r\n') + '\r\n';
    const expected = ['---', 'mood: -2', 'energy: 0', 'sleep: 7', 'checkin_at: 2026-10-01T06:14:00.000Z', '---', 'Body'].join('\r\n') + '\r\n';
    expect(applied(source, { mood: -2, energy: 0, sleep: 7, checkinAt: ISO })).toBe(expected);
  });

  it('keeps BOM and accepts a quoted existing checkin_at time', () => {
    const source = `${BOM}---\nmood: -1\nenergy: 2\nsleep: 7\ncheckin_at: "06:14"\n---\nBody\n`;
    const expected = `${BOM}---\nmood: 2\nenergy: 3\nsleep: 0.5\ncheckin_at: 2026-10-01T06:14:00.000Z\n---\nBody\n`;
    expect(applied(source, { mood: 2, energy: 3, sleep: 0.5, checkinAt: ISO })).toBe(expected);
  });

  it('apply-then-apply with new values is the same as one direct write', () => {
    const source = ['---', 'mood: -1', 'energy: 0', 'sleep: 7', 'checkin_at: 06:14', '---', '', 'Body', ''].join('\n');
    const first = applyMoodCheckin(source, valid);
    if (!first.ok) throw new Error(`refused: ${first.code}`);
    const next: MoodCheckinInput = { mood: 3, energy: -3, sleep: 0.5, checkinAt: ISO };
    expect(applied(first.text, next)).toBe(applied(source, next));
  });
});

describe('applyMoodCheckin refusals', () => {
  it('missing or unclosed frontmatter ⇒ no-frontmatter', () => {
    expect(refusal('Body\n', valid)).toBe('no-frontmatter');
    expect(refusal('---\nmood: -1\nenergy: 2\nsleep: 7\ncheckin_at: 06:14\n', valid)).toBe('no-frontmatter');
  });

  it('missing field, including a key only in the body or an indented key, ⇒ checkin-field-missing', () => {
    expect(refusal('---\nmood: -1\nsleep: 7\ncheckin_at: 06:14\n---\n', valid)).toBe('checkin-field-missing');
    expect(refusal('---\nenergy: 2\nsleep: 7\ncheckin_at: 06:14\n---\n\nmood: -1\n', valid)).toBe('checkin-field-missing');
    expect(refusal('---\n  mood: -1\nenergy: 2\nsleep: 7\ncheckin_at: 06:14\n---\n', valid)).toBe('checkin-field-missing');
  });

  it('duplicate top-level check-in key ⇒ checkin-field-ambiguous', () => {
    expect(refusal('---\nmood: -1\nmood: 2\nenergy: 2\nsleep: 7\ncheckin_at: 06:14\n---\n', valid)).toBe('checkin-field-ambiguous');
  });

  it('prose value ⇒ checkin-field-unsupported', () => {
    expect(refusal('---\nmood: feeling great\nenergy: 2\nsleep: 7\ncheckin_at: 06:14\n---\n', valid)).toBe('checkin-field-unsupported');
  });

  it('a check-in line with a stray CR in an LF file ⇒ refused:mixed-eol (the CR is never dropped)', () => {
    expect(refusal('---\nmood: 1\r\nenergy: 2\nsleep: 7\ncheckin_at: 06:14\n---\n', valid)).toBe('refused:mixed-eol');
  });

  it('block scalar value ⇒ checkin-field-unsupported', () => {
    expect(refusal('---\nmood: |\n  happy\nenergy: 2\nsleep: 7\ncheckin_at: 06:14\n---\n', valid)).toBe('checkin-field-unsupported');
  });

  it('out-of-range, non-integer, half-step or bad instant input ⇒ checkin-invalid-input', () => {
    expect(refusal('---\nmood:\nenergy:\nsleep:\ncheckin_at:\n---\n', { ...valid, mood: 4 })).toBe('checkin-invalid-input');
    expect(refusal('---\nmood:\nenergy:\nsleep:\ncheckin_at:\n---\n', { ...valid, energy: 3.5 })).toBe('checkin-invalid-input');
    expect(refusal('---\nmood:\nenergy:\nsleep:\ncheckin_at:\n---\n', { ...valid, sleep: 24.5 })).toBe('checkin-invalid-input');
    expect(refusal('---\nmood:\nenergy:\nsleep:\ncheckin_at:\n---\n', { ...valid, sleep: 0.25 })).toBe('checkin-invalid-input');
    expect(refusal('---\nmood:\nenergy:\nsleep:\ncheckin_at:\n---\n', { ...valid, checkinAt: '2026-10-01T06:14:00Z' })).toBe('checkin-invalid-input');
  });

  it('accepts boundary inputs −3, 3 and 0.5-step sleep', () => {
    const source = ['---', 'mood:', 'energy:', 'sleep:', 'checkin_at:', '---', ''].join('\n');
    expect(applied(source, { mood: -3, energy: 3, sleep: 0.5, checkinAt: ISO })).toBe(['---', 'mood: -3', 'energy: 3', 'sleep: 0.5', 'checkin_at: 2026-10-01T06:14:00.000Z', '---', ''].join('\n'));
    expect(applied(source, { mood: 0, energy: 0, sleep: 24, checkinAt: ISO })).toBe(['---', 'mood: 0', 'energy: 0', 'sleep: 24', 'checkin_at: 2026-10-01T06:14:00.000Z', '---', ''].join('\n'));
  });
});

describe('renderDailyNote', () => {
  it('replaces every date placeholder and returns the rendered text', () => {
    const result = renderDailyNote('{{date:YYYY-MM-DD}} daily\n{{date:YYYY-MM-DD}}', '2026-10-01');
    expect(result).toMatchObject({ ok: true, text: '2026-10-01 daily\n2026-10-01', effect: { kind: 'daily-note-rendered' } });
  });

  it('leftover placeholder ⇒ template-unsupported-placeholder', () => {
    expect(renderCode('{{date:YYYY-MM-DD}} {{title}}', '2026-10-01')).toBe('template-unsupported-placeholder');
  });

  it('invalid date ⇒ checkin-invalid-input', () => {
    expect(renderCode('{{date:YYYY-MM-DD}}', '2026-02-29')).toBe('checkin-invalid-input');
  });
});
