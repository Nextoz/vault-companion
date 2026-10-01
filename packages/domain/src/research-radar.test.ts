import { describe, expect, it, vi } from 'vitest';
import { RadarResponse } from '@vault-companion/contracts';
import { buildResearchRadar, createResearchRadarService, mergeRadarCandidates, parseRadarItems, radarDecisionPath, radarTopics, rankRadarCandidates, type RadarCandidate } from './research-radar.ts';
import { appendRadarDecisionLine, radarPaperId } from './research-radar-format.ts';
import { FileTooLarge, StoreUnavailable } from './store.ts';
import { InMemoryStore } from './testing/in-memory-store.ts';

const SCOUT_DIR = 'Research/Daily Research Scout';
const BRIEF_DIR = 'Research/Reading Briefs';
const IMPORTANT_DIR = 'Research/Important Research Updates';
const EXPLAINED_DIR = 'Research/Explained';
const NOW = new Date('2026-09-30T10:00:00Z');
const TZ = 'Europe/Copenhagen';

const scout = (date: string, title: string, url: string, score = 85, topic = 'ai') => `---
created: ${date}
status: complete
scout_health: ok
confidence: 0.9
source: synthetic
tags:
  - ai
  - ${topic}
---
## Most relevant items
- ${title}
- ${url}
- why synthetic ${score}/100
`;

const brief = (date: string, title: string, url: string) => `---
created: ${date}
status: complete
tags:
  - ai
  - llm
---
## Read today
- [${title}](${url})
`;

const important = (created: string, title: string, url: string, status = 'active') => `---
title: ${title}
created: ${created}
status: ${status}
source: ${url}
tags:
  - ai
  - safety
---
## Curation decision
- Curated because it matters synthetically.
`;

const explained = (url: string) => `---
source: ${url}
tags:
  - ai
---
# Explanation
Synthetic explanation body.
`;

function candidate(over: Partial<RadarCandidate> = {}): RadarCandidate {
  return {
    paperId: '0123456789abcdef0123',
    sourceUrl: 'https://example.com/a',
    title: 'Paper A',
    why: '',
    topic: 'ai',
    sourceDate: '2026-09-29',
    priority: 1,
    score: 0,
    intake: 'scout',
    notePath: null,
    ...over,
  };
}

describe('Research Radar parsers and ranking', () => {
  it('parses Scout triplets and Brief inline links into title, URL, why and score', () => {
    const scoutItems = parseRadarItems(scout('2026-09-29', 'Scout paper', 'https://example.com/scout', 72), 'Most relevant items');
    expect(scoutItems).toHaveLength(1);
    expect(scoutItems[0]).toMatchObject({ title: 'Scout paper', url: 'https://example.com/scout', score: 72 });
    expect(scoutItems[0]!.why).toContain('why synthetic');

    const briefItems = parseRadarItems(brief('2026-09-29', 'Brief paper', 'https://example.com/brief'), 'Read today');
    expect(briefItems).toHaveLength(1);
    expect(briefItems[0]).toMatchObject({ title: 'Brief paper', url: 'https://example.com/brief', score: null });
  });

  it('merges duplicate canonical papers by the highest priority/score source', () => {
    const sameId = 'aaaaaaaaaaaaaaaaaaaa';
    const merged = mergeRadarCandidates([
      candidate({ paperId: sameId, priority: 1, score: 90, title: 'Scout duplicate' }),
      candidate({ paperId: sameId, priority: 2, score: 0, title: 'Brief duplicate' }),
      candidate({ paperId: sameId, priority: 3, score: 0, title: 'Important duplicate', intake: 'important' }),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ priority: 3, title: 'Important duplicate', intake: 'important' });
  });

  it('ranks important > brief > scout score, then canonical-URL stable tiebreak', () => {
    const ranked = rankRadarCandidates([
      candidate({ paperId: 'cccccccccccccccccccc', sourceUrl: 'https://example.com/c', priority: 1, score: 90 }),
      candidate({ paperId: 'bbbbbbbbbbbbbbbbbbbb', sourceUrl: 'https://example.com/b', priority: 2, score: 0, intake: 'brief' }),
      candidate({ paperId: 'aaaaaaaaaaaaaaaaaaaa', sourceUrl: 'https://example.com/a', priority: 3, score: 0, intake: 'important' }),
      candidate({ paperId: 'dddddddddddddddddddd', sourceUrl: 'https://example.com/d', priority: 1, score: 50 }),
    ]);
    expect(ranked.map((x) => x.sourceUrl)).toEqual([
      'https://example.com/a',
      'https://example.com/b',
      'https://example.com/c',
      'https://example.com/d',
    ]);
    expect(radarTopics(ranked)).toEqual([
      { topic: 'ai', count: 4 },
    ]);
  });

  it('selects same-priority duplicates deterministically independent of file order', () => {
    const id = 'aaaaaaaaaaaaaaaaaaaa';
    const a = candidate({ paperId: id, sourceUrl: 'https://example.com/a?utm_source=x', title: 'A' });
    const b = candidate({ paperId: id, sourceUrl: 'https://example.com/a', title: 'B' });
    expect(mergeRadarCandidates([a, b])[0]).toMatchObject({ title: 'A' });
    expect(mergeRadarCandidates([b, a])[0]).toMatchObject({ title: 'A' });
  });

  it('uses the Copenhagen calendar date for the monthly decision path', () => {
    expect(radarDecisionPath('2026-09-30T22:30:00Z', TZ)).toBe('Research/Radar/Decisions/2026-10.jsonl');
    expect(radarDecisionPath('2026-09-30T10:00:00Z', TZ)).toBe('Research/Radar/Decisions/2026-09.jsonl');
  });
});

describe('buildResearchRadar read model', () => {
  async function build(files: Record<string, string | Uint8Array>, now: Date = NOW, timeZone = TZ) {
    const store = await InMemoryStore.create(files);
    return buildResearchRadar({ store, now: () => now, timeZone });
  }

  const encodeDecision = (value: Parameters<typeof appendRadarDecisionLine>[1]) =>
    new TextDecoder().decode(appendRadarDecisionLine(null, value));

  it('dedupes one paper across scout/brief/important and prefers explanation then note read targets', async () => {
    const url = 'https://arxiv.org/abs/2101.00001';
    const out = await build({
      [`${SCOUT_DIR}/Daily Research Scout - 2026-09-29.md`]: scout('2026-09-29', 'Scout duplicate', url, 88),
      [`${BRIEF_DIR}/Research Reading Brief - 2026-09-29.md`]: brief('2026-09-29', 'Brief duplicate', url),
      [`${IMPORTANT_DIR}/Important Paper.md`]: important('2026-09-29', 'Important duplicate', url),
      [`${EXPLAINED_DIR}/Explanation.md`]: explained(url),
    });
    expect(out.papers).toHaveLength(1);
    expect(out.papers[0]).toMatchObject({
      title: 'Important duplicate',
      sourceUrl: url,
      badges: ['important', 'explained'],
      read: { kind: 'explanation', path: `${EXPLAINED_DIR}/Explanation.md` },
    });
    expect(out.topics).toEqual([{ topic: 'safety', count: 1 }]);
  });

  it('applies the seven-day rolling window and Copenhagen timezone boundary', async () => {
    const inWindow = 'https://example.com/in';
    const outOfWindow = 'https://example.com/out';
    const files = {
      [`${SCOUT_DIR}/Daily Research Scout - 2026-09-24.md`]: scout('2026-09-24', 'In window', inWindow, 80),
      [`${SCOUT_DIR}/Daily Research Scout - 2026-09-23.md`]: scout('2026-09-23', 'Out of window', outOfWindow, 99),
    };
    const sept30 = await build(files);
    expect(sept30.papers.map((p) => p.sourceUrl)).toEqual([inWindow]);

    // 22:30Z is already 1 October in Copenhagen, so the window starts 25 September.
    const oct1 = await build(files, new Date('2026-09-30T22:30:00Z'));
    expect(oct1.papers.map((p) => p.sourceUrl)).toEqual([]);
  });

  it('skips inactive important updates and invalid source dates', async () => {
    const out = await build({
      [`${IMPORTANT_DIR}/Inactive.md`]: important('2026-09-29', 'Inactive', 'https://example.com/inactive', 'inactive'),
      [`${IMPORTANT_DIR}/Bad date.md`]: important('not-a-date', 'Bad date', 'https://example.com/bad-date'),
    });
    expect(out.papers).toHaveLength(0);
    expect(out.sources.importantUpdates).toEqual({ state: 'degraded', count: 0 });
    expect(out.warnings).toContain('importantUpdates has notes, but no papers could be read.');
  });

  it('drops invalid source URLs and reports missing/degraded sources honestly', async () => {
    const out = await build({
      [`${SCOUT_DIR}/Daily Research Scout - 2026-09-29.md`]: scout('2026-09-29', 'Unsafe', 'javascript:alert(1)', 90),
    });
    expect(out.papers).toHaveLength(0);
    expect(out.sources.dailyScout).toEqual({ state: 'degraded', count: 0 });
    expect(out.sources.readingBriefs).toEqual({ state: 'absent', count: 0 });
    expect(out.warnings).toContain('dailyScout has notes in the last seven days, but no papers could be read.');
    expect(out.warnings).toContain('readingBriefs has no readable notes in the last seven days.');
  });

  it('counts topics from the eligible ranked papers only', async () => {
    const out = await build({
      [`${SCOUT_DIR}/Daily Research Scout - 2026-09-29.md`]: scout('2026-09-29', 'One', 'https://example.com/one', 90, 'transformers'),
      [`${SCOUT_DIR}/Daily Research Scout - 2026-09-28.md`]: scout('2026-09-28', 'Two', 'https://example.com/two', 80, 'transformers'),
      [`${SCOUT_DIR}/Daily Research Scout - 2026-09-27.md`]: scout('2026-09-27', 'Three', 'https://example.com/three', 70, 'rl'),
    });
    expect(out.topics).toEqual([
      { topic: 'transformers', count: 2 },
      { topic: 'rl', count: 1 },
    ]);
  });

  it('accepts Brief `Read this week` items as well as `Read today`', async () => {
    const out = await build({
      [`${BRIEF_DIR}/Research Reading Brief - 2026-09-29.md`]: `---
created: 2026-09-29
status: complete
tags:
  - ai
  - week
---
## Read this week
- [Weekly paper](https://example.com/week)
`,
    });
    expect(out.papers.map((p) => p.sourceUrl)).toEqual(['https://example.com/week']);
    expect(out.sources.readingBriefs).toEqual({ state: 'ok', count: 1 });
  });

  it('marks a usable but unhealthy scout as degraded rather than ok', async () => {
    const out = await build({
      [`${SCOUT_DIR}/Daily Research Scout - 2026-09-29.md`]: `---
created: 2026-09-29
status: complete
scout_health: degraded
confidence: 0.4
source: synthetic
tags:
  - ai
---
## Most relevant items
- Degraded paper
- https://example.com/degraded
- why synthetic 80/100
`,
    });
    expect(out.papers.map((p) => p.sourceUrl)).toEqual(['https://example.com/degraded']);
    expect(out.sources.dailyScout).toEqual({ state: 'degraded', count: 1 });
  });

  it('reports a partial unreadable source as degraded, never an empty success', async () => {
    const out = await build({
      [`${SCOUT_DIR}/Daily Research Scout - 2026-09-29.md`]: scout('2026-09-29', 'Readable', 'https://example.com/readable', 80),
      [`${SCOUT_DIR}/Daily Research Scout - 2026-09-28.md`]: new Uint8Array([0xff, 0xfe]),
    });
    expect(out.papers.map((p) => p.sourceUrl)).toEqual(['https://example.com/readable']);
    expect(out.sources.dailyScout).toEqual({ state: 'degraded', count: 1 });
  });

  it('keeps old keep/remove decisions excluding resurfacing papers after two months', async () => {
    const removeUrl = 'https://example.com/old-remove';
    const keepUrl = 'https://example.com/old-keep';
    const removeId = (await radarPaperId(removeUrl))!;
    const keepId = (await radarPaperId(keepUrl))!;
    const log = encodeDecision({ schemaVersion: 1, decisionId: '11111111-1111-4111-8111-111111111111', paperId: removeId, decision: 'remove', undoes: null, at: '2026-08-05T10:00:00Z', card: { title: 'Old remove', source: removeUrl, topic: 'AI' } })
      + encodeDecision({ schemaVersion: 1, decisionId: '22222222-2222-4222-8222-222222222222', paperId: keepId, decision: 'keep', undoes: null, at: '2026-08-05T10:01:00Z', card: { title: 'Old keep', source: keepUrl, topic: 'AI' } });
    const out = await build({
      [`${SCOUT_DIR}/Daily Research Scout - 2026-10-01.md`]: scout('2026-10-01', 'Remove resurfaces', removeUrl, 80),
      [`${SCOUT_DIR}/Daily Research Scout - 2026-10-02.md`]: scout('2026-10-02', 'Keep resurfaces', keepUrl, 80),
      'Research/Radar/Decisions/2026-08.jsonl': log,
    }, new Date('2026-10-03T10:00:00Z'));
    expect(out.papers).toHaveLength(0);
    expect(out.decisions.map((d) => d.decisionId)).toEqual(['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222']);
  });

  it('replays a targeted old Undo across months while preserving a later decision', async () => {
    const url = 'https://example.com/undo-then-keep';
    const paperId = (await radarPaperId(url))!;
    const card = { title: 'Undo then keep', source: url, topic: 'AI' };
    const august = encodeDecision({ schemaVersion: 1, decisionId: '11111111-1111-4111-8111-111111111111', paperId, decision: 'remove', undoes: null, at: '2026-08-05T10:00:00Z', card });
    const september = encodeDecision({ schemaVersion: 1, decisionId: '22222222-2222-4222-8222-222222222222', paperId, decision: 'undo', undoes: '11111111-1111-4111-8111-111111111111', at: '2026-09-01T10:00:00Z', card })
      + encodeDecision({ schemaVersion: 1, decisionId: '33333333-3333-4333-8333-333333333333', paperId, decision: 'keep', undoes: null, at: '2026-09-01T10:01:00Z', card });
    const out = await build({
      [`${SCOUT_DIR}/Daily Research Scout - 2026-10-01.md`]: scout('2026-10-01', 'Still kept later', url, 80),
      'Research/Radar/Decisions/2026-08.jsonl': august,
      'Research/Radar/Decisions/2026-09.jsonl': september,
    }, new Date('2026-10-03T10:00:00Z'));
    expect(out.papers).toHaveLength(0);
    expect(out.decisions.map((d) => d.decision)).toEqual(['remove', 'undo', 'keep']);
  });

  it('uses Copenhagen months for decision history even when USER_TIME_ZONE is elsewhere', async () => {
    const url = 'https://example.com/copenhagen-boundary';
    const paperId = (await radarPaperId(url))!;
    const october = encodeDecision({ schemaVersion: 1, decisionId: '11111111-1111-4111-8111-111111111111', paperId, decision: 'remove', undoes: null, at: '2026-10-01T01:00:00Z', card: { title: 'Boundary', source: url, topic: 'AI' } });
    const out = await build({
      [`${SCOUT_DIR}/Daily Research Scout - 2026-09-30.md`]: scout('2026-09-30', 'Boundary', url, 80),
      'Research/Radar/Decisions/2026-10.jsonl': october,
    }, new Date('2026-09-30T22:30:00-04:00'), 'America/New_York');
    expect(out.papers).toHaveLength(0);
  });

  it('refuses decision history beyond the bounded monthly window instead of inventing absence', async () => {
    const url = 'https://example.com/too-old';
    const paperId = (await radarPaperId(url))!;
    const store = await InMemoryStore.create({
      'Research/Radar/Decisions/2024-08.jsonl': encodeDecision({ schemaVersion: 1, decisionId: '11111111-1111-4111-8111-111111111111', paperId, decision: 'remove', undoes: null, at: '2024-08-05T10:00:00Z', card: { title: 'Too old', source: url, topic: 'AI' } }),
    });
    await expect(buildResearchRadar({ store, now: () => NOW, timeZone: TZ })).rejects.toThrow();
  });

  it('does not claim last-seven-days notes when only old important updates exist', async () => {
    const out = await build({
      [`${IMPORTANT_DIR}/Old.md`]: important('2026-09-01', 'Old update', 'https://example.com/old-important'),
    });
    expect(out.sources.importantUpdates).toEqual({ state: 'degraded', count: 0 });
    expect(out.warnings).toContain('importantUpdates has notes, but no papers could be read.');
    expect(out.warnings.join(' ')).not.toContain('importantUpdates has notes in the last seven days');
  });

  it('normalizes control characters in frontmatter title/topic so RadarResponse still parses', async () => {
    const url = 'https://example.com/control-title';
    const out = await build({
      [`${IMPORTANT_DIR}/Important.md`]: `---
title: Bad\tTitle\u0001
created: 2026-09-29
status: active
source: ${url}
tags:
  - bad\ttopic
---
## Curation decision
- Curated because it matters synthetically.
`,
    });
    const parsed = RadarResponse.parse(out);
    expect(parsed.papers[0]).toMatchObject({ title: 'Bad Title', topic: 'bad topic' });
  });

  it('does not turn an unreadable applied.json into a successful empty read', async () => {
    const store = await InMemoryStore.create({ 'Research/Radar/applied.json': '{not-json' });
    await expect(buildResearchRadar({ store, now: () => NOW, timeZone: TZ })).rejects.toThrow();
  });

  it('does not turn an unreadable decision JSONL into a successful empty read', async () => {
    const store = await InMemoryStore.create({ 'Research/Radar/Decisions/2026-09.jsonl': new Uint8Array([0xff, 0xfe]) });
    await expect(buildResearchRadar({ store, now: () => NOW, timeZone: TZ })).rejects.toThrow();
  });

  it('does not turn malformed decision JSONL into a successful empty read', async () => {
    const store = await InMemoryStore.create({ 'Research/Radar/Decisions/2026-09.jsonl': 'not-json\n' });
    await expect(buildResearchRadar({ store, now: () => NOW, timeZone: TZ })).rejects.toThrow();
  });

  it('carries the validated file month on decisions, not the client at timestamp', async () => {
    const url = 'https://example.com/file-month';
    const paperId = (await radarPaperId(url))!;
    const log = encodeDecision({ schemaVersion: 1, decisionId: '11111111-1111-4111-8111-111111111111', paperId, decision: 'remove', undoes: null, at: '2026-09-01T10:00:00Z', card: { title: 'File month', source: url, topic: 'AI' } });
    const out = await build({ 'Research/Radar/Decisions/2026-08.jsonl': log }, new Date('2026-10-03T10:00:00Z'));
    expect(out.decisions[0]).toMatchObject({ month: '2026-08', at: '2026-09-01T10:00:00Z' });
  });

  it('degrades an oversized source note instead of failing the whole Radar read', async () => {
    const store = await InMemoryStore.create({
      [`${SCOUT_DIR}/Daily Research Scout - 2026-09-29.md`]: scout('2026-09-29', 'Readable', 'https://example.com/readable', 80),
      [`${SCOUT_DIR}/Daily Research Scout - 2026-09-28.md`]: scout('2026-09-28', 'Oversized', 'https://example.com/oversized', 99),
    });
    const original = store.readFile.bind(store);
    const spy = vi.spyOn(store, 'readFile').mockImplementation(async (p, at) => {
      if ((p as string) === `${SCOUT_DIR}/Daily Research Scout - 2026-09-28.md`) throw new FileTooLarge('file exceeds 1 MB');
      return original(p, at);
    });
    try {
      const out = await buildResearchRadar({ store, now: () => NOW, timeZone: TZ });
      expect(out.papers.map((p) => p.sourceUrl)).toEqual(['https://example.com/readable']);
      expect(out.sources.dailyScout).toEqual({ state: 'degraded', count: 1 });
    } finally {
      spy.mockRestore();
    }
  });

  it('still surfaces a real store outage from a source read', async () => {
    const store = await InMemoryStore.create({
      [`${SCOUT_DIR}/Daily Research Scout - 2026-09-29.md`]: scout('2026-09-29', 'Readable', 'https://example.com/readable', 80),
    });
    const spy = vi.spyOn(store, 'readFile').mockRejectedValue(new StoreUnavailable('down'));
    try {
      const service = createResearchRadarService({ store, now: () => NOW, timeZone: TZ });
      await expect(service.readResearchRadar()).resolves.toMatchObject({ code: 'upstream-unavailable', retryable: true });
    } finally {
      spy.mockRestore();
    }
  });

  it('turns a decision-log FileTooLarge store throw into a nonretryable invalid read', async () => {
    const store = await InMemoryStore.create({ 'Research/Radar/Decisions/2026-09.jsonl': '{}\n' });
    const original = store.readFile.bind(store);
    const spy = vi.spyOn(store, 'readFile').mockImplementation(async (p, at) => {
      if ((p as string) === 'Research/Radar/Decisions/2026-09.jsonl') throw new FileTooLarge('file exceeds 1 MB');
      return original(p, at);
    });
    try {
      const service = createResearchRadarService({ store, now: () => NOW, timeZone: TZ });
      await expect(service.readResearchRadar()).resolves.toMatchObject({ code: 'invalid', retryable: false });
    } finally {
      spy.mockRestore();
    }
  });

  it('turns an applied.json FileTooLarge store throw into a nonretryable invalid read', async () => {
    const store = await InMemoryStore.create({ 'Research/Radar/applied.json': '{}' });
    const original = store.readFile.bind(store);
    const spy = vi.spyOn(store, 'readFile').mockImplementation(async (p, at) => {
      if ((p as string) === 'Research/Radar/applied.json') throw new FileTooLarge('file exceeds 1 MB');
      return original(p, at);
    });
    try {
      const service = createResearchRadarService({ store, now: () => NOW, timeZone: TZ });
      await expect(service.readResearchRadar()).resolves.toMatchObject({ code: 'invalid', retryable: false });
    } finally {
      spy.mockRestore();
    }
  });

  it('caps large Important/Explained directories and reports honest partial coverage', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 40; i += 1) files[`${IMPORTANT_DIR}/Note ${String(i).padStart(2, '0')}.md`] = important('2026-09-29', `Note ${i}`, `https://example.com/imp-${i}`);
    for (let i = 0; i < 40; i += 1) files[`${EXPLAINED_DIR}/Expl ${String(i).padStart(2, '0')}.md`] = explained(`https://example.com/exp-${i}`);
    const store = await InMemoryStore.create(files);
    const out = await buildResearchRadar({ store, now: () => NOW, timeZone: TZ });
    expect(out.sources.importantUpdates).toEqual({ state: 'degraded', count: 13 });
    expect(out.sources.explained).toEqual({ state: 'degraded', count: 3 });
    expect(out.warnings.join(' ')).toContain('importantUpdates read only 13 of 40 papers before the read budget');
    expect(out.warnings.join(' ')).toContain('explained read only 3 of 40 explanations before the read budget');
  });

  it('prioritizes a current-window dated Important over many older dated files', async () => {
    const current = 'https://example.com/current-important';
    const files: Record<string, string> = {};
    for (let i = 0; i < 20; i += 1) {
      files[`${IMPORTANT_DIR}/2026-01-01 Old ${String(i).padStart(2, '0')}.md`] = important('2026-01-01', `Old ${i}`, `https://example.com/old-${i}`);
    }
    files[`${IMPORTANT_DIR}/2026-09-29 Current.md`] = important('2026-09-29', 'Current', current);
    const out = await build(files);
    expect(out.papers.map((p) => p.sourceUrl)).toContain(current);
  });

  it('reserves a positive share for Explained even when Scout/Brief/Important are full', async () => {
    const files: Record<string, string> = {};
    for (const date of ['2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27', '2026-09-28', '2026-09-29', '2026-09-30']) {
      files[`${SCOUT_DIR}/Daily Research Scout - ${date}.md`] = scout(date, `Scout ${date}`, `https://example.com/scout-${date}`, 80);
      files[`${BRIEF_DIR}/Research Reading Brief - ${date}.md`] = brief(date, `Brief ${date}`, `https://example.com/brief-${date}`);
    }
    for (let i = 0; i < 40; i += 1) files[`${IMPORTANT_DIR}/Note ${String(i).padStart(2, '0')}.md`] = important('2026-09-29', `Note ${i}`, `https://example.com/imp-${i}`);
    for (let i = 0; i < 40; i += 1) files[`${EXPLAINED_DIR}/Expl ${String(i).padStart(2, '0')}.md`] = explained(`https://example.com/exp-${i}`);
    const out = await build(files);
    expect(out.sources.explained.count).toBe(3);
  });

  it('reads the matching explanation for a ranked candidate when many explanations compete', async () => {
    const url = 'https://example.com/match';
    const files: Record<string, string> = {
      [`${IMPORTANT_DIR}/2026-09-29 Matching Paper.md`]: important('2026-09-29', 'Matching Paper', url),
    };
    for (let i = 0; i < 40; i += 1) files[`${EXPLAINED_DIR}/Expl ${String(i).padStart(2, '0')}.md`] = explained(`https://example.com/exp-${i}`);
    files[`${EXPLAINED_DIR}/ZZ Matching Paper.md`] = explained(url);
    const out = await build(files);
    expect(out.papers).toHaveLength(1);
    expect(out.papers[0]!.badges).toContain('explained');
    expect(out.papers[0]!.read).toEqual({ kind: 'explanation', path: `${EXPLAINED_DIR}/ZZ Matching Paper.md` });
  });

  it('keeps undated Important filenames as deterministic fallback instead of dropping them', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 20; i += 1) {
      files[`${IMPORTANT_DIR}/Mystery ${String(i).padStart(2, '0')}.md`] = important('2026-09-29', `Mystery ${i}`, `https://example.com/mystery-${i}`);
    }
    const out = await build(files);
    expect(out.sources.importantUpdates).toEqual({ state: 'degraded', count: 16 });
  });

  it('selects the same capped sources regardless of listing order', async () => {
    const mapping = Array.from({ length: 30 }, (_, i) => [`${IMPORTANT_DIR}/Note ${String(i).padStart(2, '0')}.md`, `https://example.com/imp-${i}`] as const);
    const makeStore = (reverse: boolean) => {
      const files: Record<string, string> = {};
      const entries = reverse ? [...mapping].reverse() : mapping;
      for (const [path, url] of entries) files[path] = important('2026-09-29', path.slice(IMPORTANT_DIR.length + 1), url);
      return InMemoryStore.create(files);
    };
    const a = await buildResearchRadar({ store: await makeStore(false), now: () => NOW, timeZone: TZ });
    const b = await buildResearchRadar({ store: await makeStore(true), now: () => NOW, timeZone: TZ });
    expect(a.papers.map((p) => p.sourceUrl)).toEqual(b.papers.map((p) => p.sourceUrl));
  });
});
