import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// Local Windows checkouts use a sibling directory under C:/Dev; CI/Linux use the portable runner temp.
const tempBase = fs.realpathSync(process.platform === 'win32' &&
  root.toLowerCase().replaceAll('\\', '/').startsWith('c:/dev/') ? path.resolve(root, '..') : os.tmpdir());
const temporary = fs.mkdtempSync(path.join(tempBase, 'h1-gate-'));
afterAll(() => { if (path.dirname(temporary) === tempBase) fs.rmSync(temporary, { recursive: true, force: true }); });
const connection = <T>(items: T[]) => ({ nodes: items, pageInfo: { hasNextPage: false } });
function fixture() {
  const head = 'a'.repeat(40); const diffDigest = 'b'.repeat(64);
  const api = { diffDigest, changedPaths: ['note.md'], protection: { contexts: ['test'], checks: [] as { context: string; app_id: number }[] }, pull: { number: 7, state: 'OPEN', isDraft: false, headRefOid: head,
    baseRefName: 'main', author: { login: 'implementer' }, labels: connection<{ name: string }>([]),
    comments: connection<{ id: string; url: string; createdAt: string; author: { login: string } }>([]),
    reviews: connection<{ id: string; state: string; submittedAt: string; author: { login: string } }>([]),
    reviewThreads: connection<{ isResolved: boolean; comments: ReturnType<typeof connection<{ id: string; author: { login: string } }>> }>([]),
    commits: { nodes: [{ commit: { oid: head, statusCheckRollup: { contexts: connection([{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', checkSuite: { app: { databaseId: 123 } } }]) } } }] } } };
  const lead = { version: 1, issuer: 'Nextoz', repo: 'synthetic/repo', pr: 7, head, diffDigest, riskClass: 'high', requiredChecks: ['test'], implementers: ['implementer'],
    review: { kind: 'independent-review', backend: 'claude', approved: true, reviewer: 'independent-reviewer', repo: 'synthetic/repo', pr: 7, head, diffDigest,
      issuedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString() },
    handoffs: [{ id: 'H1', disposition: 'follow-up', reference: 'https://example.invalid/disposition' }],
    findings: [] as { id: string; disposition: string; reference: string }[],
    ownerResponses: [] as { commentId?: string; reviewId?: string; by: string; disposition: string; reference: string; at: string }[] };
  return { api, lead };
}
function gate(f: ReturnType<typeof fixture>) {
  const dir = fs.mkdtempSync(path.join(temporary, 'case-'));
  fs.writeFileSync(path.join(dir, 'api.json'), JSON.stringify(f.api)); fs.writeFileSync(path.join(dir, 'lead.json'), JSON.stringify(f.lead));
  const r = spawnSync(process.execPath, [path.join(root, 'tools/harness/merge-gate.mjs'), '--fixture', path.join(dir, 'api.json'), path.join(dir, 'lead.json'), 'synthetic/repo', '7'], { encoding: 'utf8', timeout: 10000, windowsHide: true });
  if (r.error) throw r.error;
  return { status: r.status, ...JSON.parse(r.stdout) as { allowed: boolean; reason: string } };
}
describe('merge gate API fixture CLI', () => {
  it('allows clean current independently reviewed evidence', () => { expect(gate(fixture())).toMatchObject({ status: 0, allowed: true }); });
  it.each(['PENDING', 'SKIPPED', 'FAILURE', 'NEUTRAL'])('denies %s CI despite review approval', conclusion => {
    const f = fixture(); f.api.pull.commits.nodes[0]!.commit.statusCheckRollup.contexts.nodes[0]!.conclusion = conclusion;
    expect(gate(f).reason).toBe('ci-not-green');
  });
  it('denies absent CI and missing required contexts', () => {
    const f = fixture(); f.api.pull.commits.nodes[0]!.commit.statusCheckRollup.contexts.nodes = []; expect(gate(f).reason).toBe('missing-ci');
    const g = fixture(); g.api.protection.contexts.push('security'); expect(gate(g).reason).toBe('required-ci-absent');
  });
  it('binds required CI to its configured GitHub app identity', () => {
    const f = fixture(); f.api.protection.checks.push({ context: 'test', app_id: 456 }); expect(gate(f).reason).toBe('required-ci-app-mismatch');
    f.api.protection.checks[0]!.app_id = 123; expect(gate(f).allowed).toBe(true);
  });
  it('denies incomplete evidence and API failure payloads', () => {
    const f = fixture(); f.api.pull.comments.pageInfo.hasNextPage = true; expect(gate(f).reason).toBe('incomplete-api-evidence');
    Object.assign(f, { api: { errors: [{ message: 'synthetic API failure' }] } }); expect(gate(f).allowed).toBe(false);
  });
  it('denies stale receipt and head/diff mismatches', () => {
    const f = fixture(); f.lead.head = 'c'.repeat(40); expect(gate(f).reason).toBe('stale-or-unbound-lead-evidence');
    const g = fixture(); g.lead.review.diffDigest = 'c'.repeat(64); expect(gate(g).reason).toBe('independent-review-missing-or-stale');
    const h = fixture(); h.lead.review.issuedAt = '2020-01-01T00:00:00Z'; expect(gate(h).allowed).toBe(false);
  });
  it('denies hold, undispositioned handoff, and weakening findings', () => {
    const f = fixture(); f.api.pull.labels.nodes.push({ name: 'hold' }); expect(gate(f).reason).toBe('hold-label');
    const g = fixture(); g.lead.handoffs[0]!.disposition = ''; expect(gate(g).reason).toBe('undispositioned-handoffs');
    const h = fixture(); h.lead.findings.push({ id: 'weakened', disposition: '', reference: '' }); expect(gate(h).reason).toBe('undispositioned-findings');
    const k = fixture(); k.api.changedPaths.push('.agent/handoffs/worker.md'); expect(gate(k).reason).toBe('undispositioned-handoff-file');
  });
  it('worker final handoff or self review cannot serve as independent review', () => {
    const f = fixture(); f.lead.review.kind = 'handoff'; expect(gate(f).allowed).toBe(false);
    const g = fixture(); g.lead.review.reviewer = 'IMPLEMENTER'; expect(gate(g).allowed).toBe(false);
  });
  it('requires explicit timely response to each owner comment ID, not a newer generic comment', () => {
    const f = fixture(); const createdAt = new Date(Date.now() - 10000).toISOString();
    f.api.pull.comments.nodes.push({ id: 'OWNER_1', url: 'https://example.invalid/comment/1', createdAt, author: { login: 'Nextoz' } });
    f.api.pull.comments.nodes.push({ id: 'GENERIC', url: 'https://example.invalid/comment/2', createdAt: new Date().toISOString(), author: { login: 'implementer' } });
    expect(gate(f).reason).toBe('unanswered-owner-comment');
    f.lead.ownerResponses.push({ commentId: 'OWNER_1', by: 'Nextoz', disposition: 'answered', reference: 'https://example.invalid/response/3', at: new Date(Date.now() - 1000).toISOString() });
    expect(gate(f).allowed).toBe(true);
    f.lead.ownerResponses[0]!.at = createdAt; expect(gate(f).allowed).toBe(false);
  });
  it('blocks unresolved owner review threads and CHANGES_REQUESTED', () => {
    const f = fixture(); f.api.pull.reviewThreads.nodes.push({ isResolved: false, comments: connection([{ id: 'THREAD_1', author: { login: 'Nextoz' } }]) });
    expect(gate(f).reason).toBe('unresolved-owner-thread');
    f.api.pull.reviewThreads.nodes[0]!.isResolved = true;
    f.api.pull.reviews.nodes.push({ id: 'REVIEW_1', state: 'CHANGES_REQUESTED', submittedAt: new Date().toISOString(), author: { login: 'Nextoz' } });
    expect(gate(f).reason).toBe('owner-changes-requested');
  });
  it('requires an explicit disposition for standalone owner COMMENTED reviews', () => {
    const f = fixture();
    f.api.pull.reviews.nodes.push({ id: 'OWNER_REVIEW', state: 'COMMENTED', submittedAt: new Date(Date.now() - 10000).toISOString(), author: { login: 'Nextoz' } });
    expect(gate(f).reason).toBe('unanswered-owner-review');
    f.lead.ownerResponses.push({ reviewId: 'OWNER_REVIEW', by: 'Nextoz', disposition: 'answered', reference: 'https://example.invalid/review-response', at: new Date(Date.now() - 1000).toISOString() });
    expect(gate(f).allowed).toBe(true);
  });
});
