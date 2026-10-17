import { JobRadarResponse } from '@vault-companion/contracts';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { projectJobRadar } from './job-radar.ts';

// Synthetic values, real producer schema (apps/web/src/ui/monitors/fixtures, schema captured 2026-10-16).
const fixture = JobRadarResponse.parse({
  revision: 'a'.repeat(40),
  ...JSON.parse(readFileSync(new URL('./fixtures/job-radar.json', import.meta.url), 'utf8')),
});
const GENERATED = Date.parse(fixture.generatedAt);
const view = projectJobRadar(fixture, GENERATED + 60_000);

describe('projectJobRadar', () => {
  it('summarises applied, interviews and follow-ups on one line', () => {
    expect(view.summary).toBe('9 applied · 1 interview · 2 follow-ups');
  });

  it('swings to the plural away from one, in both counts', () => {
    const plural = projectJobRadar(
      { ...fixture, counts: { ...fixture.counts, interview: 2 }, followUps: fixture.followUps.slice(0, 1) },
      GENERATED,
    );
    expect(plural.summary).toBe('9 applied · 2 interviews · 1 follow-up');
  });

  it('lists the stages in a fixed order with shares relative to the widest bar', () => {
    expect(view.stages).toEqual([
      { stage: 'saved', label: 'Saved', count: 19, share: 1 },
      { stage: 'applied', label: 'Applied', count: 9, share: 9 / 19 },
      { stage: 'interview', label: 'Interview', count: 1, share: 1 / 19 },
      { stage: 'offer', label: 'Offer', count: 0, share: 0 },
      { stage: 'closed', label: 'Closed', count: 11, share: 11 / 19 },
    ]);
    const unmapped = projectJobRadar(
      { ...fixture, counts: { ...fixture.counts, other: 2 }, otherStatuses: ['ghosted', 'limbo'] },
      GENERATED,
    );
    expect(unmapped.stages.at(-1)).toEqual({ stage: 'other', label: 'Other', count: 2, share: 2 / 19 });
    const empty = projectJobRadar(
      { ...fixture, counts: { saved: 0, applied: 0, interview: 0, offer: 0, closed: 0, other: 0 } },
      GENERATED,
    );
    expect(empty.stages.every((s) => s.share === 0)).toBe(true);
  });

  it('caps the in-flight list at six with a human age label per row', () => {
    expect(view.inFlight).toHaveLength(6);
    expect(view.inFlight[0]).toEqual({ title: 'Acme Platform', stage: 'applied', ageLabel: 'Updated 4 days ago' });
    expect(view.inFlight.map((i) => i.title)).toEqual([
      'Acme Platform', 'Beta Backend', 'Gamma DevOps', 'Delta Cloud', 'Epsilon Data', 'Zeta SRE',
    ]);
    expect(view.inFlight.map((i) => i.ageLabel)).toEqual([
      'Updated 4 days ago', 'Updated 26 days ago', 'Updated 29 days ago', 'Updated 46 days ago',
      'Updated 54 days ago', 'Updated 54 days ago',
    ]);
    const edges = projectJobRadar({
      ...fixture,
      inFlight: [
        { ...fixture.inFlight[0]!, daysSinceUpdate: 0 },
        { ...fixture.inFlight[1]!, updated: null, daysSinceUpdate: null },
      ],
    }, GENERATED);
    expect(edges.inFlight.map((i) => i.ageLabel)).toEqual(['Updated today', 'Update date unknown']);
  });

  it('labels each follow-up with its due day and urgency', () => {
    expect(view.followUps).toEqual([
      { title: 'Acme Platform', due: '14 Oct', overdue: true, label: 'overdue' },
      { title: 'Beta Backend', due: '18 Oct', overdue: false, label: 'due soon' },
    ]);
  });

  it('explains notes whose status the stage table does not map, only when there are any', () => {
    expect(view.otherNote).toBeNull();
    const unmapped = projectJobRadar(
      { ...fixture, counts: { ...fixture.counts, other: 2 }, otherStatuses: ['ghosted', 'limbo'] },
      GENERATED,
    );
    expect(unmapped.otherNote).toBe('2 with a status the table does not map: ghosted, limbo');
  });

  it('is current inside 26 hours and stale after, with the footer in Copenhagen time', () => {
    // generatedAt is 06:10 local (+02:00).
    expect(projectJobRadar(fixture, GENERATED + 25 * 3_600_000)).toMatchObject({
      stale: false,
      footer: 'Job Search 2026 notes · Updated 06:10',
    });
    const stale = projectJobRadar(fixture, GENERATED + 27 * 3_600_000);
    expect(stale.stale).toBe(true);
    expect(stale.footer).toBe('Job Search 2026 notes · Stale · Updated 16 Oct 06:10');
  });
});
