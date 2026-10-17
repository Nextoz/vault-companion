import { AgentActivityResponse } from '@vault-companion/contracts';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { projectAgentActivity } from './agent-activity.ts';

// Synthetic values, real producer schema (apps/web/src/ui/monitors/fixtures, schema captured 2026-10-16).
const fixture = AgentActivityResponse.parse({
  revision: 'a'.repeat(40),
  ...JSON.parse(readFileSync(new URL('./fixtures/agent-activity.json', import.meta.url), 'utf8')),
});
const GENERATED = Date.parse(fixture.generatedAt);
const NOW = GENERATED + 60_000;
const view = projectAgentActivity(fixture, NOW);
const ci = (over: Record<string, unknown>) => ({ ...fixture, ci: { ...fixture.ci!, ...over } });
const spend = (over: Record<string, unknown>) => ({ ...fixture, spend: { ...fixture.spend, ...over } });

describe('projectAgentActivity', () => {
  it('summarises merged PRs, CI and what needs the owner on one short line, without the deploy words', () => {
    expect(view.summary).toBe('3 PRs merged · CI green · 1 needs you');
    expect(view.ciLabel).toBe('CI green · deploy green');
  });

  it('names running, failing and unknown CI, and the deploy job on its own', () => {
    expect(projectAgentActivity(ci({ status: 'in_progress', conclusion: null }) as AgentActivityResponse, NOW).summary).toContain('CI running');
    expect(projectAgentActivity(ci({ conclusion: 'failure' }) as AgentActivityResponse, NOW).summary).toContain('CI failing');
    expect(projectAgentActivity(ci({ conclusion: 'neutral' }) as AgentActivityResponse, NOW).summary).toContain('CI unknown');
    expect(projectAgentActivity({ ...fixture, ci: null }, NOW).summary).toContain('CI unknown');
    expect(projectAgentActivity(ci({ deploy: { ...fixture.ci!.deploy!, status: 'in_progress', conclusion: null } }) as AgentActivityResponse, NOW).ciLabel).toBe('CI green · deploy running');
    expect(projectAgentActivity(ci({ deploy: { ...fixture.ci!.deploy!, conclusion: 'failure' } }) as AgentActivityResponse, NOW).ciLabel).toBe('CI green · deploy failing');
    expect(projectAgentActivity(ci({ deploy: null }) as AgentActivityResponse, NOW).ciLabel).toBe('CI green');
  });

  it('uses the singular for one merged PR', () => {
    const one = { ...fixture, prs: { ...fixture.prs, merged: fixture.prs.merged.slice(0, 1) } };
    expect(projectAgentActivity(one, NOW).summary).toMatch(/^1 PR merged · /);
  });

  it('lists merged PRs with their Copenhagen time, branch and change size', () => {
    expect(view.merged[0]).toMatchObject({ number: 208, meta: 'merged 19:52 · claude/monitor-card-4adec1', change: '+654 −56' });
    const unknown = { ...fixture, prs: { ...fixture.prs, merged: [{ ...fixture.prs.merged[0]!, additions: null, branch: null }] } };
    expect(projectAgentActivity(unknown, NOW).merged[0]).toMatchObject({ meta: 'merged 19:52', change: '' });
  });

  it('caps the open PRs at five and marks drafts', () => {
    const many = Array.from({ length: 7 }, (_, i) => ({ ...fixture.prs.open[0]!, number: 300 + i, isDraft: i === 0 }));
    const rows = projectAgentActivity({ ...fixture, prs: { ...fixture.prs, open: many } }, NOW).open;
    expect(rows).toHaveLength(5);
    expect(rows[0]).toMatchObject({ draft: true, meta: 'opened 11 Oct' });
    expect(view.open.map((r) => r.number)).toEqual([188, 127]);
  });

  it('shows only the spend values that exist and never invents a zero', () => {
    expect(view.spendLines).toEqual([
      'Scaleway EUR 3.20 today', 'DeepSeek $0.19 today', 'Claude 14 % of week', 'GLM relay ~EUR 5.15 (since relay start)',
    ]);
    const some = projectAgentActivity(spend({ scalewayEur: null, deepseekUsd: null, relay: null }) as AgentActivityResponse, NOW);
    expect(some.spendLines).toEqual(['Claude 14 % of week']);
    const none = projectAgentActivity(spend({ scalewayEur: null, deepseekUsd: null, claudeWeekPercent: null, relay: null }) as AgentActivityResponse, NOW);
    expect(none.spendLines).toEqual(['No spend recorded yet today.']);
  });

  it('turns the action-log items into dated rows, and says so when the log is stale or empty', () => {
    expect(view.needsYou).toEqual([{ at: '16 Oct 18:40', text: 'Synthetic action: pick between two layouts.' }]);
    const stale = projectAgentActivity({ ...fixture, needsYou: { ...fixture.needsYou, stale: true, items: [] } }, NOW);
    expect(stale.summary).toMatch(/action log stale$/);
    expect(stale.needsYouStale).toBe(true);
    const none = projectAgentActivity({ ...fixture, needsYou: { ...fixture.needsYou, items: [] } }, NOW);
    expect(none.summary).toMatch(/nothing needs you$/);
  });

  it('is current inside the 3 hour cadence and stale after, with the footer saying which', () => {
    // generatedAt is 19:17 local (+02:00).
    const fresh = projectAgentActivity(fixture, GENERATED + 2 * 3_600_000);
    expect(fresh).toMatchObject({ stale: false, footer: 'GitHub · AI usage · Updated 19:17' });
    const old = projectAgentActivity(fixture, GENERATED + 4 * 3_600_000);
    expect(old.stale).toBe(true);
    expect(old.footer).toBe('GitHub · AI usage · Stale · Updated 16 Oct 19:17');
  });
});
