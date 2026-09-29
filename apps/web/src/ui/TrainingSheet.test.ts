import { describe, expect, it } from 'vitest';
import { parseDecimal } from './TrainingSheet.tsx';

describe('parseDecimal (B1)', () => {
  it('accepts a dot or a Danish comma with at most one decimal', () => {
    expect(parseDecimal('84.5')).toBe(84.5);
    expect(parseDecimal('84,5')).toBe(84.5);
    expect(parseDecimal(' 84 ')).toBe(84);
    expect(parseDecimal('5,2')).toBe(5.2);
  });
  it('refuses anything else', () => {
    for (const t of ['', '84.55', '84,', ',5', '1,234', '84.5 kg', '-3', '1e2', '84 5']) expect(parseDecimal(t)).toBeNaN();
  });
});
