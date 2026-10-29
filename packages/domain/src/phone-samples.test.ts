import { describe, expect, it } from 'vitest';
import { PHONE_METRICS, type PhoneMetric } from './phone-metrics.ts';
import { parsePhoneV2 } from './phone-samples.ts';

const from = '2026-10-20T00:00:00Z', start = '2026-10-21T00:00:00Z', end = '2026-10-21T01:00:00Z';
const sentAt = '2026-10-22T00:00:00Z', now = new Date(sentAt), sentinel = String(987);
const metrics: readonly PhoneMetric[] = PHONE_METRICS;
const steps = metrics.find((m) => m.required)!;
const line = (m = steps, fields: Partial<Record<'type' | 'start' | 'end' | 'value' | 'unit' | 'source', string>> = {}) =>
  [fields.type ?? m.typeName, fields.start ?? start, fields.end ?? end, fields.value ?? sentinel,
    fields.unit ?? Object.keys(m.units)[0]!, fields.source ?? 'Synthetic'].join('|');
const body = (samples = line(), patch: Record<string, unknown> = {}) => JSON.stringify({ schemaVersion: 2, from, sentAt, samples, ...patch });
const parseLine = (text: string) => parsePhoneV2(body(`${line()}\n${text}`), now);

describe('phone v2 refusals', () => {
  const percent = metrics.find((m) => m.value.max === 100)!;
  const cases: [string, string, 400 | 422][] = [
    ['five fields', line().split('|').slice(0, 5).join('|'), 400],
    ['unknown type', line(steps, { type: sentinel }), 400],
    ['wrong unit', line(steps, { unit: sentinel }), 400],
    ['comma', line(steps, { value: '1,234' }), 400],
    ['negative', line(steps, { value: `-${sentinel}` }), 400],
    ['percent bound', line(percent, { value: String(101) }), 422],
    ['percent bound before rounding', line(percent, { value: String(100.001) }), 422],
    ['end before start', line(steps, { end: from }), 400],
    ['bad ISO', line(steps, { start: sentinel }), 400],
    ['invalid calendar date', line(steps, { start: '2026-02-30T00:00:00Z' }), 400],
    ['missing offset', line(steps, { start: start.slice(0, -1) }), 400],
    ['early sample', line(steps, { start: '2026-10-18T00:00:00Z' }), 422],
    ['late sample', line(steps, { end: '2026-10-23T00:00:00Z' }), 422],
    ['empty source', line(steps, { source: '' }), 400],
    ['integer rule', line(steps, { value: String(1.5) }), 400],
    ['exponent', line(steps, { value: '1e3' }), 400],
    ['unsafe value', line(steps, { value: String(Number.MAX_SAFE_INTEGER + 1) }), 400],
    ...['PulseLoop', 'pulseloop', 'PuLsElOoP'].map((source): [string, string, 422] =>
      ['ring source', line(steps, { source: `Synthetic ${source} ${sentinel}` }), 422]),
  ];
  it.each(cases)('refuses %s without exposing input', (_name, text, status) => {
    const result = parseLine(text);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(status);
    expect(result.error).toMatch(/^line 2 /);
    expect(result.error).not.toContain(sentinel);
    expect(result.error).not.toContain('Synthetic');
  });
  it.each([
    ['no required line', body('', {}), 422], ['span', body(line(), { from: '2026-10-13T23:59:59Z' }), 400],
    ['future', body(line(), { sentAt: '2026-10-22T00:05:01Z' }), 400],
    ['equal window', body(line(), { from: sentAt }), 400], ['schema', body(line(), { schemaVersion: 1 }), 400],
    ['samples', body(line(), { samples: 987 }), 400], ['unknown field', body(line(), { [sentinel]: sentinel }), 400],
    ['bad from', body(line(), { from: sentinel }), 400], ['bad sentAt', body(line(), { sentAt: sentinel }), 400],
    ['invalid JSON', sentinel, 400], ['array', '[]', 400],
  ])('refuses body: %s', (_name, text, status) => {
    const result = parsePhoneV2(String(text), now);
    expect(result.ok).toBe(false);
    if (!result.ok) { expect(result.status).toBe(status); expect(result.error).not.toContain(sentinel); }
  });
  it('rejects invalid now and timezone', () => {
    expect(parsePhoneV2(body(), new Date(NaN))).toMatchObject({ ok: false, error: 'now' });
    expect(parsePhoneV2(body(), now, 'Synthetic/Invalid')).toMatchObject({ ok: false, error: 'tz' });
  });
});

describe('phone v2 accepted samples', () => {
  it.each([['stepLength', 'm', '0.29', 29], ['distance', 'mi', '2.5', 4.023],
    ['distance', 'm', '1234', 1.234], ['walkingSpeed', 'm/s', '0.3', 1.08],
    ['stepLength', 'm', '0.00005', 0.01]] as const)('converts %s exactly', (key, unit, value, expected) => {
    const result = parseLine(line(metrics.find((m) => m.key === key)!, { unit, value }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.samples[1]?.value).toBe(expected);
  });
  it('skips blanks and retains instants and window as dates', () => {
    const result = parsePhoneV2(body(`\r\n \n${line()}\r\n\t`), now);
    expect(result).toEqual({ ok: true, from: new Date(from), sentAt: now,
      samples: [{ key: steps.key, start: Date.parse(start), end: Date.parse(end), value: Number(sentinel) }] });
  });
  it('keeps only In Bed, with source filtering even on ignored sleep', () => {
    const sleep = metrics.find((m) => m.category)!;
    const result = parseLine(`${line(sleep, { value: 'In Bed' })}\n${line(sleep, { value: 'Synthetic other category' })}`);
    expect(result.ok).toBe(true);
    if (result.ok) { expect(result.samples).toHaveLength(2); expect(result.samples[1]).toMatchObject({ key: sleep.key, inBed: true, value: 0 }); }
    expect(parseLine(line(sleep, { value: 'Synthetic other category', source: 'PULSELOOP' }))).toMatchObject({ ok: false, status: 422 });
  });
  it('accepts every registry entry and inclusive sample/window/skew boundaries', () => {
    const samples = metrics.map((m) => line(m, { value: m.category ?? String(1), start: '2026-10-13T00:00:00Z', end: sentAt })).join('\n');
    const result = parsePhoneV2(body(samples, { from: '2026-10-14T00:00:00Z' }), now);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.samples).toHaveLength(metrics.length);
    expect(parsePhoneV2(body(line(steps, { end: start })), now).ok).toBe(true);
    expect(parsePhoneV2(body(), new Date(now.getTime() - 300_000)).ok).toBe(true);
  });
});
