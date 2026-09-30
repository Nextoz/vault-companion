import { describe, expect, it } from 'vitest';
import type { RadarDecisionLine } from '@vault-companion/contracts';
import { appendRadarDecisionLine, canonicalRadarUrl, effectiveRadarDecisions, parseRadarApplied, parseRadarDecisionLines, radarPaperId } from './research-radar-format.ts';

const line = (over: Partial<RadarDecisionLine> = {}): RadarDecisionLine => ({
  schemaVersion: 1,
  decisionId: '11111111-1111-4111-8111-111111111111',
  paperId: '0123456789abcdef0123',
  decision: 'remove',
  undoes: null,
  at: '2026-09-30T14:00:00+02:00',
  card: { title: 'Synthetic paper', source: 'https://example.com/paper', topic: 'AI' },
  ...over,
});

describe('canonicalRadarUrl', () => {
  it('lower-cases the host but preserves www, drops only unambiguous tracking, and folds arXiv forms', () => {
    expect(canonicalRadarUrl('HTTPS://WWW.Example.COM/a?utm_source=x&b=2#frag')).toBe('https://www.example.com/a?b=2');
    expect(canonicalRadarUrl('https://arxiv.org/pdf/2101.00001.pdf')).toBe('https://arxiv.org/abs/2101.00001');
    expect(canonicalRadarUrl('http://arxiv.org/abs/2101.00001')).toBe('https://arxiv.org/abs/2101.00001');
    expect(canonicalRadarUrl('https://export.arxiv.org/abs/2101.00001')).toBe('https://arxiv.org/abs/2101.00001');
    expect(canonicalRadarUrl('https://example.com/a?mc_cid=1&q=2')).toBe('https://example.com/a?q=2');
  });

  it('preserves source/ref params, arXiv version/category identity, and www hosts', () => {
    expect(canonicalRadarUrl('https://example.com/a?source=a')).toBe('https://example.com/a?source=a');
    expect(canonicalRadarUrl('https://example.com/a?ref=b')).toBe('https://example.com/a?ref=b');
    expect(canonicalRadarUrl('https://www.example.com/a')).toBe('https://www.example.com/a');
    expect(canonicalRadarUrl('https://arxiv.org/abs/hep-th/9901001v2')).toBe('https://arxiv.org/abs/hep-th/9901001v2');
    expect(canonicalRadarUrl('https://export.arxiv.org/pdf/2101.00001v3.pdf')).toBe('https://arxiv.org/abs/2101.00001v3');
  });

  it('never guesses an unsupported or unsafe source', () => {
    for (const bad of [
      '', 'not a url', 'javascript:alert(1)', 'ftp://example.com/x', 'file:///etc/passwd',
      'https://arxiv.org/list/hep-th/9901001', 'https://arxiv.org/abs/%00', 'https://user@example.com/x', 'https://example.com/x\u0000',
    ]) {
      expect(canonicalRadarUrl(bad)).toBeNull();
    }
  });
});

describe('radarPaperId', () => {
  it('is the first 20 hex SHA-256 chars and dedupes equivalent URLs', async () => {
    const a = await radarPaperId('https://arxiv.org/abs/2101.00001');
    const b = await radarPaperId('https://arxiv.org/pdf/2101.00001.pdf');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{20}$/);
  });

  it('returns null for an unsupported URL', async () => {
    await expect(radarPaperId('javascript:alert(1)')).resolves.toBeNull();
  });
});

describe('appendRadarDecisionLine', () => {
  it('writes the exact ordered JSONL line for a new file', () => {
    const value = line();
    const bytes = appendRadarDecisionLine(null, value);
    expect(new TextDecoder().decode(bytes)).toBe(
      '{"schemaVersion":1,"decisionId":"11111111-1111-4111-8111-111111111111","paperId":"0123456789abcdef0123","decision":"remove","undoes":null,"at":"2026-09-30T14:00:00+02:00","card":{"title":"Synthetic paper","source":"https://example.com/paper","topic":"AI"}}\n',
    );
  });

  it('preserves existing bytes and adds one newline only when needed', () => {
    const value = line({ decisionId: '22222222-2222-4222-8222-222222222222' });
    const plain = 'old line\n';
    expect(new TextDecoder().decode(appendRadarDecisionLine(plain, value))).toBe(plain + JSON.stringify({
      schemaVersion: 1,
      decisionId: value.decisionId,
      paperId: value.paperId,
      decision: value.decision,
      undoes: value.undoes,
      at: value.at,
      card: value.card,
    }) + '\n');
    const missing = 'no final newline';
    expect(new TextDecoder().decode(appendRadarDecisionLine(missing, value))).toBe(missing + '\n' + JSON.stringify({
      schemaVersion: 1,
      decisionId: value.decisionId,
      paperId: value.paperId,
      decision: value.decision,
      undoes: value.undoes,
      at: value.at,
      card: value.card,
    }) + '\n');
  });

  it('preserves CRLF bytes when appending', () => {
    const prefix = 'first\r\n';
    const out = new TextDecoder().decode(appendRadarDecisionLine(prefix, line()));
    expect(out.startsWith(prefix)).toBe(true);
    expect(out).toContain('\r\n{');
  });
});

describe('parseRadarDecisionLines', () => {
  it('reads valid lines in file order', () => {
    const a = line();
    const b = line({ decisionId: '22222222-2222-4222-8222-222222222222', decision: 'keep', at: '2026-09-30T15:00:00+02:00' });
    const text = `${JSON.stringify(a)}\n${JSON.stringify(b)}\n`;
    expect(parseRadarDecisionLines(text).map((d) => d.decisionId)).toEqual([a.decisionId, b.decisionId]);
  });

  it('treats malformed JSONL and duplicate IDs as unreadable, not absent', () => {
    const a = line();
    expect(() => parseRadarDecisionLines('not-json\n')).toThrow();
    expect(() => parseRadarDecisionLines(`${JSON.stringify(a)}\n${JSON.stringify(a)}\n`)).toThrow();
  });
});

describe('parseRadarApplied', () => {
  it('only accepts valid decision entries under Research/Library', () => {
    const good = '11111111-1111-4111-8111-111111111111';
    const bad = '22222222-2222-4222-8222-222222222222';
    const text = JSON.stringify({
      schemaVersion: 1,
      updatedAt: '2026-09-30T16:00:00+02:00',
      decisions: {
        [good]: { status: 'applied', at: '2026-09-30T15:00:00+02:00', message: '', libraryPath: 'Research/Library/Paper.md' },
        [bad]: { status: 'applied', at: '2026-09-30T15:00:00+02:00', message: '', libraryPath: 'Inbox/unsafe.md' },
      },
    });
    expect(parseRadarApplied(text).applied).toHaveProperty(good);
    expect(parseRadarApplied(text).applied).not.toHaveProperty(bad);
    expect(parseRadarApplied(text).appliedUpdatedAt).toBe('2026-09-30T16:00:00+02:00');
  });

  it('refuses unknown JSON and an invalid updatedAt instead of returning an empty read', () => {
    expect(() => parseRadarApplied('{not-json')).toThrow();
    expect(() => parseRadarApplied(JSON.stringify({ schemaVersion: 1, updatedAt: 'yesterday', decisions: {} }))).toThrow();
  });

  it('never claims applied without a safe Library path, but failed may omit one', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const badApplied = parseRadarApplied(JSON.stringify({ schemaVersion: 1, updatedAt: '2026-09-30T16:00:00+02:00', decisions: { [id]: { status: 'applied', at: '2026-09-30T15:00:00+02:00', message: '', libraryPath: null } } }));
    expect(badApplied.applied).not.toHaveProperty(id);
    const failed = parseRadarApplied(JSON.stringify({ schemaVersion: 1, updatedAt: '2026-09-30T16:00:00+02:00', decisions: { [id]: { status: 'failed', at: '2026-09-30T15:00:00+02:00', message: '', libraryPath: null } } }));
    expect(failed.applied).toHaveProperty(id);
  });
});

describe('effectiveRadarDecisions', () => {
  it('replays remove/keep and undo as a new line without rewriting history', () => {
    const paper = '0123456789abcdef0123';
    const remove = line();
    const undo = line({ decisionId: '33333333-3333-4333-8333-333333333333', decision: 'undo', undoes: remove.decisionId, at: '2026-09-30T16:00:00+02:00' });
    const first = effectiveRadarDecisions([remove]);
    expect(first.removed.has(paper)).toBe(true);
    const after = effectiveRadarDecisions([remove, undo]);
    expect(after.removed.has(paper)).toBe(false);
    expect(after.kept.has(paper)).toBe(false);
  });

  it('ignores an undo naming a missing or undo target', () => {
    const paper = '0123456789abcdef0123';
    const remove = line();
    const foreign = line({ decisionId: '33333333-3333-4333-8333-333333333333', decision: 'undo', undoes: '99999999-9999-4999-8999-999999999999' });
    const state = effectiveRadarDecisions([remove, foreign]);
    expect(state.removed.has(paper)).toBe(true);
  });

  it('replays append order, not device timestamps, and undo cancels exactly its named decision', () => {
    const paper = '0123456789abcdef0123';
    const a1 = line({ decisionId: '33333333-3333-4333-8333-333333333333', at: '2026-09-30T18:00:00+02:00' });
    const a2 = line({ decisionId: '44444444-4444-4444-8444-444444444444', at: '2026-09-30T10:00:00+02:00' });
    const undoA1 = line({ decisionId: '55555555-5555-4555-8555-555555555555', decision: 'undo', undoes: a1.decisionId, at: '2026-09-30T20:00:00+02:00' });
    const state = effectiveRadarDecisions([a1, a2, undoA1]);
    expect(state.removed.has(paper)).toBe(true);
    expect(state.keepDecisionByPaper.has(paper)).toBe(false);
  });

  it('restores the latest surviving same-paper decision after an undo', () => {
    const paper = '0123456789abcdef0123';
    const keep = line({ decisionId: '33333333-3333-4333-8333-333333333333', decision: 'keep' });
    const remove = line({ decisionId: '44444444-4444-4444-8444-444444444444', decision: 'remove' });
    const undoRemove = line({ decisionId: '55555555-5555-4555-8555-555555555555', decision: 'undo', undoes: remove.decisionId });
    const state = effectiveRadarDecisions([keep, remove, undoRemove]);
    expect(state.kept.has(paper)).toBe(true);
    expect(state.keepDecisionByPaper.get(paper)).toBe(keep.decisionId);
  });

  it('ignores cross-paper and future undo targets on read', () => {
    const a = '0123456789abcdef0123';
    const b = 'aaaaaaaaaaaaaaaaaaaa';
    const target = line({ paperId: a });
    const cross = line({ paperId: b, decisionId: '33333333-3333-4333-8333-333333333333', decision: 'undo', undoes: target.decisionId });
    const future = line({ decisionId: '44444444-4444-4444-8444-444444444444', decision: 'undo', undoes: '55555555-5555-4555-8555-555555555555' });
    expect(effectiveRadarDecisions([cross, target]).removed.has(a)).toBe(true);
    expect(effectiveRadarDecisions([future, target]).removed.has(a)).toBe(true);
  });
});
