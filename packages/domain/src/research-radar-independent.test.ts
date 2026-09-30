import { describe, expect, it, vi } from 'vitest';
import { buildResearchRadar, createResearchRadarService } from './research-radar.ts';
import { canonicalRadarUrl, radarPaperId } from './research-radar-format.ts';
import { InMemoryStore } from './testing/in-memory-store.ts';

describe('Independent Radar acceptance holdouts', () => {
  it('uses Copenhagen for the seven-day window even when another service zone is supplied', async () => {
    const store = await InMemoryStore.create({
      'Research/Reading Briefs/Research Reading Brief - 2026-09-24.md': '---\ncreated: 2026-09-24\nstatus: complete\ntags:\n  - ai\n---\n## Read today\n- [Synthetic boundary paper](https://example.com/boundary-paper)\n',
    });
    const control = await buildResearchRadar({
      store, now: () => new Date('2026-09-30T12:00:00+02:00'), timeZone: 'Europe/Copenhagen',
    });
    expect(control.papers).toHaveLength(1);
    const response = await buildResearchRadar({
      store, now: () => new Date('2026-10-01T00:30:00+02:00'), timeZone: 'America/New_York',
    });
    expect(response.papers).toHaveLength(0);
  });

  it('folds arXiv query variants to the same versioned paper identity', async () => {
    const canonical = 'https://arxiv.org/abs/2101.00001v2';
    const variant = 'https://export.arxiv.org/pdf/2101.00001v2.pdf?context=cs&download=1';
    expect(canonicalRadarUrl(variant)).toBe(canonical);
    expect(await radarPaperId(variant)).toBe(await radarPaperId(canonical));
    expect(canonicalRadarUrl('https://example.com/paper?context=cs')).toBe('https://example.com/paper?context=cs');
    expect(canonicalRadarUrl(`${canonical}?context=%00`)).toBeNull();
  });

  it('returns a typed unreadable state for invalid UTF-8 in desktop application status', async () => {
    const path = 'Research/Radar/applied.json';
    const store = await InMemoryStore.create({ [path]: '{}' });
    const read = store.readFile.bind(store);
    const spy = vi.spyOn(store, 'readFile').mockImplementation(async (...args) => {
      const file = await read(...args);
      return args[0] === path && file ? { ...file, bytes: new Uint8Array([0xc3, 0x28]) } : file;
    });
    try {
      const service = createResearchRadarService({ store, now: () => new Date('2026-09-30T12:00:00Z'), timeZone: 'Europe/Copenhagen' });
      await expect(service.readResearchRadar()).resolves.toMatchObject({ code: 'invalid', retryable: false });
    } finally {
      spy.mockRestore();
    }
  });

  it('refuses a malformed monthly decision filename rather than ignoring its Keep history', async () => {
    const source = 'https://example.com/synthetic-kept-paper';
    const paperId = (await radarPaperId(source))!;
    const line = JSON.stringify({ schemaVersion: 1, decisionId: '11111111-1111-4111-8111-111111111111', paperId, decision: 'keep', undoes: null, at: '2026-09-30T12:00:00Z', card: { title: 'Synthetic kept paper', source, topic: 'AI' } });
    const store = await InMemoryStore.create({ 'Research/Radar/Decisions/2026-13.jsonl': `${line}\n` });
    const service = createResearchRadarService({ store, now: () => new Date('2026-09-30T12:00:00Z'), timeZone: 'Europe/Copenhagen' });
    await expect(service.readResearchRadar()).resolves.toMatchObject({ code: 'invalid', retryable: false });
  });
});
