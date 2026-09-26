import { describe, expect, it } from 'vitest';
import { displayTime, FRESH_FOR_MS, vaultFreshness } from './freshness.ts';
const now = Date.parse('2026-09-26T12:10:00Z');
const read = { revision: '2915455abcdef1234', timeZone: 'Europe/Copenhagen', vault: { committedAt: '2026-09-26T12:07:00Z', fromApp: false } };
describe('vault freshness', () => {
  it('formats today in the read zone and identifies desktop/app', () => {
    expect(vaultFreshness(read, now, false, now)).toEqual({ updated: 'Vault updated 14:07 · from desktop', checked: 'Checked 14:10', warning: false });
    expect(vaultFreshness({ ...read, vault: { ...read.vault, fromApp: true } }, now, false, now).updated).toBe('Vault updated 14:07 · from this app');
  });
  it('formats another day and uses the zone to decide today', () => {
    expect(displayTime(now, now + 86400000, read.timeZone)).toBe('Sat 26 Sep 14:10');
    const midnight = Date.parse('2026-09-26T22:10:00Z');
    expect(displayTime(now, midnight, read.timeZone)).toBe('Sat 26 Sep 14:10');
    expect(displayTime(now, midnight, 'UTC')).toBe('12:10');
  });
  it('falls back to a seven-character revision without metadata', () => {
    expect(vaultFreshness({ ...read, vault: null }, now, false, now).updated).toBe('Vault revision 2915455');
  });
  it('warns on a failed attempt without changing the last success', () => {
    expect(vaultFreshness(read, now, true, now + 60000)).toMatchObject({ checked: 'Not refreshed since 14:10', warning: true });
    expect(vaultFreshness(read, null, true, now).checked).toBe('Not refreshed yet');
  });
  it('is fresh at exactly ten minutes, stale one millisecond later', () => {
    expect(vaultFreshness(read, now, false, now + FRESH_FOR_MS).warning).toBe(false);
    expect(vaultFreshness(read, now, false, now + FRESH_FOR_MS + 1)).toMatchObject({ checked: 'Not refreshed since 14:10', warning: true });
  });
});
