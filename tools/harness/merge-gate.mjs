import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { coordinator, run, hash, safeFile, object } from './core.mjs';

const query = `query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){pullRequest(number:$number){
    number state isDraft headRefOid baseRefName author{login}
    labels(first:100){nodes{name} pageInfo{hasNextPage}}
    comments(first:100){nodes{id url createdAt author{login}} pageInfo{hasNextPage}}
    reviews(first:100){nodes{id state submittedAt author{login}} pageInfo{hasNextPage}}
    reviewThreads(first:100){nodes{isResolved comments(first:100){nodes{id author{login}} pageInfo{hasNextPage}}} pageInfo{hasNextPage}}
    commits(last:1){nodes{commit{oid statusCheckRollup{contexts(first:100){
      nodes{... on CheckRun{name status conclusion checkSuite{app{databaseId}}} ... on StatusContext{context state}}
      pageInfo{hasNextPage}
    }}}}}
  }}
}`;
function api(cwd, args) {
  const r = run('gh', ['api', ...args], cwd, 10000);
  if (!r.ok) throw new Error('github-api-failed');
  return r.stdout;
}
export function fetchEvidence(cwd, repo, pr) {
  const [owner, name] = repo.split('/');
  const body = JSON.parse(api(cwd, ['graphql', '-f', `query=${query}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${pr}`]));
  if (body.errors) throw new Error('github-graphql-errors');
  const pull = body.data?.repository?.pullRequest;
  if (!pull || !/^[\w./-]+$/u.test(pull.baseRefName)) throw new Error('missing-pr');
  const protection = JSON.parse(api(cwd, [`repos/${repo}/branches/${encodeURIComponent(pull.baseRefName)}/protection/required_status_checks`]));
  const diff = api(cwd, [`repos/${repo}/pulls/${pr}`, '-H', 'Accept: application/vnd.github.diff']);
  const files = JSON.parse(api(cwd, [`repos/${repo}/pulls/${pr}/files?per_page=100`]));
  if (!Array.isArray(files) || files.length >= 100 || files.some(f => typeof f.filename !== 'string')) throw new Error('incomplete-file-evidence');
  // Re-fetch the head after collecting diff/protection to reject a racing push.
  const current = JSON.parse(api(cwd, [`repos/${repo}/pulls/${pr}`]));
  if (current.head?.sha !== pull.headRefOid) throw new Error('head-changed-during-gate');
  if (current.changed_files !== files.length) throw new Error('incomplete-file-evidence');
  return { pull, protection, changedPaths: files.map(f => f.filename), diffDigest: hash(diff) };
}
function nodes(connection) {
  if (!connection || !Array.isArray(connection.nodes) || connection.pageInfo?.hasNextPage !== false) throw new Error('incomplete-api-evidence');
  return connection.nodes;
}
function requireTrue(condition, code) { if (!condition) throw new Error(code); }
export function assess(apiEvidence, lead, repo, pr, now = Date.now()) {
  object(lead, ['version', 'issuer', 'repo', 'pr', 'head', 'diffDigest', 'riskClass', 'requiredChecks', 'implementers', 'review', 'handoffs', 'findings', 'ownerResponses']);
  const p = apiEvidence.pull;
  requireTrue(lead.version === 1 && lead.issuer === 'Nextoz' && lead.repo === repo && lead.pr === pr &&
    lead.head === p.headRefOid && /^[a-f0-9]{40}$/u.test(lead.head) && lead.diffDigest === apiEvidence.diffDigest &&
    /^[a-f0-9]{64}$/u.test(lead.diffDigest), 'stale-or-unbound-lead-evidence');
  requireTrue(p.number === pr && p.state === 'OPEN' && p.isDraft === false, 'pr-not-ready');
  requireTrue(!nodes(p.labels).some(l => String(l.name).toLowerCase() === 'hold'), 'hold-label');
  requireTrue(['low', 'ordinary', 'high', 'critical'].includes(lead.riskClass), 'missing-risk');
  const protection = apiEvidence.protection;
  requireTrue(protection && Array.isArray(protection.contexts) && Array.isArray(protection.checks) &&
    protection.contexts.every(c => typeof c === 'string' && c.length) &&
    protection.checks.every(c => typeof c.context === 'string' && c.context.length && (c.app_id === null || Number.isInteger(c.app_id))), 'incomplete-required-ci');
  const required = new Set([...protection.contexts, ...protection.checks.map(c => c.context)]);
  requireTrue(required.size > 0 && Array.isArray(lead.requiredChecks) && lead.requiredChecks.length > 0 &&
    lead.requiredChecks.every(s => typeof s === 'string' && s.length > 0), 'missing-required-ci');
  lead.requiredChecks.forEach(c => required.add(c));
  const commit = p.commits?.nodes;
  requireTrue(Array.isArray(commit) && commit.length === 1 && commit[0].commit.oid === p.headRefOid, 'ci-head-mismatch');
  const checks = nodes(commit[0].commit.statusCheckRollup?.contexts);
  requireTrue(checks.length > 0, 'missing-ci');
  // Every reported check must be green; skipped/neutral/pending never substitute for required success.
  requireTrue(checks.every(c => c.name ? c.status === 'COMPLETED' && c.conclusion === 'SUCCESS' : c.state === 'SUCCESS'), 'ci-not-green');
  requireTrue([...required].every(name => checks.some(c => (c.name ?? c.context) === name)), 'required-ci-absent');
  requireTrue(protection.checks.every(required => required.app_id === null || required.app_id === -1 ||
    checks.some(c => c.name === required.context && c.checkSuite?.app?.databaseId === required.app_id)), 'required-ci-app-mismatch');
  for (const key of ['handoffs', 'findings']) {
    requireTrue(Array.isArray(lead[key]), 'missing-lead-dispositions');
    requireTrue(lead[key].every(d => typeof d.id === 'string' && d.id.length > 0 &&
      ['fixed', 'follow-up', 'rejected'].includes(d.disposition) && typeof d.reference === 'string' && d.reference.length > 0), `undispositioned-${key}`);
  }
  requireTrue(Array.isArray(apiEvidence.changedPaths) && apiEvidence.changedPaths.every(p => typeof p === 'string'), 'missing-file-evidence');
  requireTrue(apiEvidence.changedPaths.filter(p => p.startsWith('.agent/handoffs/')).every(p => lead.handoffs.some(d => d.id === p)), 'undispositioned-handoff-file');
  requireTrue(Array.isArray(lead.implementers) && lead.implementers.length > 0 && lead.implementers.every(v => typeof v === 'string' && v.length), 'missing-implementer-identity');
  if (['high', 'critical'].includes(lead.riskClass)) {
    const r = lead.review;
    requireTrue(r && r.kind === 'independent-review' && r.backend === 'claude' && r.approved === true &&
      typeof r.reviewer === 'string' && r.reviewer.length > 0 &&
      ![...lead.implementers, p.author?.login].some(s => s?.toLowerCase() === r.reviewer.toLowerCase()) &&
      r.repo === repo && r.pr === pr && r.head === lead.head && r.diffDigest === lead.diffDigest &&
      Number.isFinite(Date.parse(r.issuedAt)) && Date.parse(r.issuedAt) <= now && now - Date.parse(r.issuedAt) <= 7 * 86400000 &&
      Number.isFinite(Date.parse(r.expiresAt)) && Date.parse(r.expiresAt) > now, 'independent-review-missing-or-stale');
  }
  for (const thread of nodes(p.reviewThreads)) {
    const comments = nodes(thread.comments);
    requireTrue(thread.isResolved === true || !comments.some(c => c.author?.login?.toLowerCase() === 'nextoz'), 'unresolved-owner-thread');
  }
  const reviews = nodes(p.reviews).filter(r => r.author?.login?.toLowerCase() === 'nextoz');
  // Conservative: even an older active changes-requested review must be explicitly dismissed on GitHub.
  requireTrue(!reviews.some(r => r.state === 'CHANGES_REQUESTED'), 'owner-changes-requested');
  requireTrue(Array.isArray(lead.ownerResponses), 'missing-owner-dispositions');
  for (const review of reviews.filter(r => !['APPROVED', 'DISMISSED'].includes(r.state))) {
    requireTrue(review.state === 'COMMENTED' && typeof review.id === 'string' &&
      Number.isFinite(Date.parse(review.submittedAt)) && lead.ownerResponses.some(r => r.reviewId === review.id &&
        r.by === 'Nextoz' && ['answered', 'dispositioned'].includes(r.disposition) &&
        typeof r.reference === 'string' && r.reference.length > 0 &&
        Date.parse(r.at) > Date.parse(review.submittedAt) && Date.parse(r.at) <= now), 'unanswered-owner-review');
  }
  for (const c of nodes(p.comments).filter(c => c.author?.login?.toLowerCase() === 'nextoz')) {
    requireTrue(typeof c.id === 'string' && typeof c.url === 'string' && Number.isFinite(Date.parse(c.createdAt)), 'incomplete-owner-comment');
    requireTrue(lead.ownerResponses.some(r => (r.commentId === c.id || r.commentUrl === c.url) &&
      r.by === 'Nextoz' && ['answered', 'dispositioned'].includes(r.disposition) &&
      typeof r.reference === 'string' && r.reference.length > 0 &&
      Date.parse(r.at) > Date.parse(c.createdAt) && Date.parse(r.at) <= now), 'unanswered-owner-comment');
  }
  return { allowed: true, reason: 'current-evidence-green' };
}
export function gate(cwd, repo, pr) {
  try {
    if (!/^[\w.-]+\/[\w.-]+$/u.test(repo) || !Number.isSafeInteger(pr) || pr < 1) throw new Error('explicit-repo-and-pr-required');
    const file = safeFile(coordinator, `.agent/harness/merge/${repo}/${pr}.json`);
    const lead = JSON.parse(fs.readFileSync(file, 'utf8'));
    return assess(fetchEvidence(cwd, repo, pr), lead, repo, pr);
  } catch (err) { return { allowed: false, reason: /^[a-z-]+$/u.test(err.message) ? err.message : 'merge-evidence-unavailable' }; }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let verdict;
  try {
    const [mode, source, evidence, repo, number] = process.argv.slice(2);
    // Offline API fixtures are only available on this diagnostic CLI, never via a hook/env override.
    verdict = mode === '--fixture' ? assess(JSON.parse(fs.readFileSync(source, 'utf8')), JSON.parse(fs.readFileSync(evidence, 'utf8')), repo, Number(number)) :
      mode === '--live' ? gate(process.cwd(), source, Number(evidence)) : { allowed: false, reason: 'invalid-gate-arguments' };
  } catch (err) { verdict = { allowed: false, reason: /^[a-z-]+$/u.test(err.message) ? err.message : 'merge-evidence-unavailable' }; }
  console.log(JSON.stringify(verdict)); process.exitCode = verdict.allowed ? 0 : 1;
}
