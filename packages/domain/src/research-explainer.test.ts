import { ScoutStatus } from '@vault-companion/contracts';
import { describe, expect, it } from 'vitest';
import {
  buildExplainerStatus,
  EXPLANATION_RESPONSE_SCHEMA,
  ExplanationJson,
  explainerOperationId,
  inline,
  itemSlug,
  parseReadingItems,
  readableUrl,
  renderExplanation,
  slotForCron,
  slugify,
  uuidV5,
} from './research-explainer.ts';

const BRIEF = [
  '---',
  'type: brief',
  '---',
  '# Research Reading Brief - 2026-09-28',
  '',
  '## Read today',
  '',
  '- [Sparse Mixture Routing for Tiny Models](https://arxiv.org/abs/2601.00001) — cheaper inference on a laptop',
  '* [**Synthetic** Curriculum Distillation](https://arxiv.org/abs/2601.00002v2): teaches small models faster',
  '  - nested [ignored](https://arxiv.org/abs/2601.00099)',
  '1. https://example.org/papers/fictional-graph-study. graph study for planning',
  '- no link here',
  '- [dup](https://arxiv.org/abs/2601.00001) again',
  '- [bad scheme](javascript:alert(1))',
  '```',
  '- [in a fence](https://arxiv.org/abs/2601.00098)',
  '```',
  '### Sub heading keeps the section',
  '- [Fourth](https://arxiv.org/abs/2601.00004)',
  '',
  '## Most relevant items',
  '- [Other](https://arxiv.org/abs/2601.00009)',
].join('\r\n');

describe('parseReadingItems', () => {
  it('takes top-level list items with a link under the exact section, in order, distinct, safe schemes only', () => {
    expect(parseReadingItems(BRIEF, 'Read today')).toEqual([
      { url: 'https://arxiv.org/abs/2601.00001', title: 'Sparse Mixture Routing for Tiny Models', why: 'cheaper inference on a laptop' },
      { url: 'https://arxiv.org/abs/2601.00002v2', title: 'Synthetic Curriculum Distillation', why: 'teaches small models faster' },
      { url: 'https://example.org/papers/fictional-graph-study', title: null, why: 'graph study for planning' },
      { url: 'https://arxiv.org/abs/2601.00004', title: 'Fourth', why: '' },
    ]);
    expect(parseReadingItems(BRIEF, 'Most relevant items').map((i) => i.url)).toEqual(['https://arxiv.org/abs/2601.00009']);
    expect(parseReadingItems(BRIEF, 'Missing')).toEqual([]);
  });
  it('stops at five papers', () => {
    const md = ['## Read today', ...Array.from({ length: 7 }, (_, i) => `- https://arxiv.org/abs/2601.0000${i}`)].join('\n');
    expect(parseReadingItems(md, 'Read today')).toHaveLength(5);
  });
});

describe('paper URLs and slugs', () => {
  it.each([
    ['https://arxiv.org/abs/2601.00001', 'https://arxiv.org/pdf/2601.00001'],
    ['http://www.arxiv.org/abs/2601.00002v3', 'https://arxiv.org/pdf/2601.00002v3'],
    ['https://export.arxiv.org/abs/hep-th/9901001?context=x', 'https://arxiv.org/pdf/hep-th/9901001'],
    ['https://arxiv.org/pdf/2601.00001', 'https://arxiv.org/pdf/2601.00001'],
    ['https://example.org/abs/2601.00001', 'https://example.org/abs/2601.00001'],
  ])('%s is read as %s', (url, expected) => expect(readableUrl(url)).toBe(expected));

  it('slugs are ASCII, lowercase, hyphenated, at most 80 characters and never empty', () => {
    expect(slugify('Æble-Grød: Søren’s Tiny LLMs, résumé!')).toBe('aeble-grod-sorens-tiny-llms-resume');
    expect(slugify('日本語')).toBe('paper');
    const long = slugify('word '.repeat(40));
    expect(long.length).toBeLessThanOrEqual(80);
    expect(long.endsWith('-')).toBe(false);
    expect(itemSlug({ url: 'https://www.example.org/papers/x-1', title: null, why: '' })).toBe('example-org-papers-x-1');
  });
});

describe('operation IDs', () => {
  it('uuidV5 matches the RFC 9562 test vector', async () => {
    expect(await uuidV5('www.example.com', '6ba7b810-9dad-11d1-80b4-00c04fd430c8')).toBe('2ed6657d-e927-568b-95e1-2665a8aea6a2');
  });
  it('is deterministic per date and slot, and the catch-up differs', async () => {
    const a = await explainerOperationId('2026-09-28', 'primary');
    expect(await explainerOperationId('2026-09-28', 'primary')).toBe(a);
    expect(await explainerOperationId('2026-09-28', 'catchup')).not.toBe(a);
    expect(await explainerOperationId('2026-09-29', 'primary')).not.toBe(a);
    expect(a).toBe(await uuidV5('research-explainer:2026-09-28'));
  });
  it('maps only the two crons', () => {
    expect([slotForCron('30 4 * * *'), slotForCron('30 6 * * *'), slotForCron('* * * * *')]).toEqual(['primary', 'catchup', null]);
  });
});

const EXPLANATION = {
  title: 'Sparse Mixture Routing for Tiny Models',
  authors: ['A. Example', 'B. Sample'],
  venue: 'Synthetic Workshop 2026',
  plainWords: 'Small models can pick a few experts per word. That saves work.',
  keyIdeas: [
    { idea: 'Route each word', example: 'a spelling word goes to a spelling expert' },
    { idea: 'Keep most experts idle', example: '2 of 16 run per word' },
    { idea: 'Train the router too', example: 'it learns which expert helps' },
  ],
  whyItMatters: 'It may make local models on a laptop cheaper.',
  glossary: [{ term: 'Expert', meaning: 'a small sub-network' }],
  tryIt: [{ experiment: 'Time a small model with and without routing', minutes: 30 }],
  howSolid: { limits: ['Only tested on toy tasks'], evidence: 'Two benchmarks, no ablation.' },
};
const META = { date: '2026-09-28', source: 'https://arxiv.org/abs/2601.00001', scoutNote: 'Research Reading Brief - 2026-09-28', model: 'gemini-3.5-flash-lite' };

describe('renderExplanation', () => {
  it('renders the exact golden note', () => {
    expect(renderExplanation(ExplanationJson.parse(EXPLANATION), META)).toBe(`---
type: research-explained
created: 2026-09-28
source: "https://arxiv.org/abs/2601.00001"
scout_note: "[[Research Reading Brief - 2026-09-28]]"
model: gemini-3.5-flash-lite
status: complete
---

# Sparse Mixture Routing for Tiny Models

## In plain words

Small models can pick a few experts per word. That saves work.

## Key ideas

- **Route each word** Example: a spelling word goes to a spelling expert
- **Keep most experts idle** Example: 2 of 16 run per word
- **Train the router too** Example: it learns which expert helps

## Why it may matter to you

It may make local models on a laptop cheaper.

## Glossary

- **Expert**: a small sub-network

## Try it

- Time a small model with and without routing (about 30 min)

## How solid is it

- Limit: Only tested on toy tasks
- Evidence: Two benchmarks, no ablation.

## Source

- [Sparse Mixture Routing for Tiny Models](https://arxiv.org/abs/2601.00001)
- Authors: A. Example, B. Sample
- Venue: Synthetic Workshop 2026
`);
  });

  it('keeps model text inert: no new blocks, headings, HTML or frontmatter', () => {
    const hostile = ExplanationJson.parse({
      ...EXPLANATION,
      title: '# Title ](javascript:x) [',
      plainWords: 'one\n\n## Injected\n---\n<script>x</script>',
      glossary: [],
      venue: null,
      authors: [],
    });
    const md = renderExplanation(hostile, META);
    expect(md.match(/^## /gm)).toHaveLength(7);
    expect(md.match(/^---$/gm)).toHaveLength(2);
    expect(md).not.toContain('<script>');
    expect(md).toContain('# \\# Title ](javascript:x) [');
    expect(md).toContain('- [\\# Title \\](javascript:x) \\[](https://arxiv.org/abs/2601.00001)');
    expect(md).toContain('one ## Injected --- &lt;script&gt;x&lt;/script&gt;');
    expect(md).toContain('## Glossary\n\n- (none)\n');
    expect(md).not.toContain('Authors:');
    expect(inline('1. item')).toBe('\\1. item');
    expect(inline(`a${String.fromCharCode(0x2028)}b${String.fromCharCode(0x202e)}c`)).toBe('a b c');
  });

  it('rejects out-of-contract model JSON', () => {
    expect(ExplanationJson.safeParse({ ...EXPLANATION, keyIdeas: EXPLANATION.keyIdeas.slice(0, 2) }).success).toBe(false);
    expect(ExplanationJson.safeParse({ ...EXPLANATION, tryIt: [] }).success).toBe(false);
    expect(ExplanationJson.safeParse({ ...EXPLANATION, title: ' ' }).success).toBe(false);
    expect(ExplanationJson.safeParse({ error: 'unreadable' }).success).toBe(false);
    expect(Object.keys(EXPLANATION_RESPONSE_SCHEMA.properties)).toEqual(Object.keys(ExplanationJson.shape));
  });
});

describe('buildExplainerStatus', () => {
  const facts = {
    nowIso: '2026-09-28T04:30:05.000Z', operationId: '00000000-0000-5000-8000-000000000000', configured: 3,
    written: ['Research/Explained/2026-09-28 - a.md'], failures: ['invalid-json' as const], deferred: ['https://arxiv.org/abs/2601.00003'],
    stats: { errors: 1, successes: 2 },
  };
  it('is a valid ScoutStatus with counts and fixed phrases only', () => {
    const s = buildExplainerStatus(null, facts);
    expect(ScoutStatus.parse(s)).toEqual(s);
    expect(s).toMatchObject({
      runStatus: 'degraded', aiHealth: 'degraded', findings: 1, errors: 1, sources: { configured: 3, successful: 1 },
      lastError: '1 of 3 papers not explained (invalid model output); 1 deferred to the next run (subrequest budget)',
      latestOutput: 'Research/Explained/2026-09-28 - a.md', deferred: ['https://arxiv.org/abs/2601.00003'], lastSuccessAt: null,
    });
    expect(s.history).toEqual([{ at: facts.nowIso, status: 'degraded', findings: 1, operationId: facts.operationId }]);
  });
  it('keeps at most 30 history entries and older records without the new fields still parse', () => {
    const old = { ...buildExplainerStatus(null, { ...facts, failures: [], deferred: [] }), history: Array.from({ length: 30 }, () => ({ at: facts.nowIso, status: 'success' as const, findings: 1 })) };
    const s = buildExplainerStatus(ScoutStatus.parse(old), { ...facts, failures: [], deferred: [] });
    expect(s.history).toHaveLength(30);
    expect(s.history.at(-1)?.operationId).toBe(facts.operationId);
    expect(s).not.toHaveProperty('deferred');
    expect(s.runStatus).toBe('success');
  });
});
