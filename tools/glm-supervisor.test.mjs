import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runSupervisor, parseReview, validateManifest, assertScope, LIMITS } from './glm-supervisor.mjs';

async function fixture() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'glm-controller-test-'));
  const workspace = path.join(base, 'workspace'); await fs.mkdir(workspace);
  const manifest = { version: 1, workspace, jobs: [{ id: 'fixture', allowedPaths: ['apps/a.ts', 'apps/a.test.ts'], testPaths: ['apps/a.test.ts'], developer: 'implement', analyst: 'test', reviewer: 'review', checks: ['leaderboard', 'typecheck'] }] };
  const roles = [];
  const worker = async o => { roles.push(o.item.role); return { status: 'completed', upstreamAttempts: 2, reservedTokens: 100, usageKnown: true, usage: { totalTokens: 50 }, finalText: '{"verdict":"pass","findings":[]}' }; };
  const check = async name => ({ name, code: 0, output: 'passed' });
  return { base, home: path.join(base, 'state'), manifest, worker, check, roles };
}
test('complete standalone sequence persists independent roles, check evidence and usage', async () => {
  const f = await fixture(), r = await runSupervisor(f);
  assert.equal(r.status, 'completed'); assert.deepEqual(f.roles, ['developer','test-analyst','reviewer']); assert.equal(r.attempts, 6);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.home, 'fixture-review-0.json'))).verdict, 'pass');
  assert.equal(JSON.parse(await fs.readFile(path.join(f.home, 'controller.json'))).status, 'completed');
});
test('failed checks allow exactly one repair then fresh checks and independent review', async () => {
  const f = await fixture(); let count = 0;
  f.check = async name => ({ name, code: count++ === 0 ? 1 : 0, output: 'assertion' });
  const r = await runSupervisor(f); assert.equal(r.status, 'completed'); assert.equal(r.repairs, 1);
  assert.deepEqual(f.roles, ['developer','test-analyst','developer','reviewer']);
});
test('second failed check stops and cannot be approved by developer', async () => {
  const f = await fixture(); f.check = async name => ({ name, code: 1, output: 'assertion' });
  const r = await runSupervisor(f); assert.equal(r.status, 'blocked'); assert.match(r.error, /one repair exhausted/); assert.equal(f.roles.length, 3);
});
test('independent review findings trigger one repair and another reviewer', async () => {
  const f = await fixture(), original = f.worker; let reviews = 0;
  f.worker = async o => { const r = await original(o); if (o.item.role === 'reviewer' && reviews++ === 0) r.finalText = '{"verdict":"fail","findings":["apps/a.ts:1 incorrect"]}'; return r; };
  const r = await runSupervisor(f); assert.equal(r.status, 'completed'); assert.equal(reviews, 2); assert.equal(r.repairs, 1);
});
test('terminal quota stops immediately without repair or reviewer', async () => {
  const f = await fixture(); f.worker = async () => ({ status: 'failed', error: 'quota', upstreamAttempts: 1, reservedTokens: 10, circuit: { open: true } });
  const r = await runSupervisor(f); assert.equal(r.status, 'blocked'); assert.equal(r.error, 'quota'); assert.equal(r.attempts, 1); assert.equal(r.results.length, 1);
});
test('unknown usage stops conservatively with reserved accounting saved', async () => {
  const f = await fixture(), original = f.worker; f.worker = async o => ({ ...await original(o), usageKnown: false });
  const r = await runSupervisor(f); assert.equal(r.status, 'blocked'); assert.match(r.error, /usage incomplete/); assert.equal(r.reserved, 100);
});
test('malformed or contradictory review cannot approve', async () => {
  for (const text of ['', 'looks good', '{}', '{"verdict":"pass","findings":["bug"]}', '{"verdict":"fail","findings":[]}']) assert.throws(() => parseReview(text));
  const f = await fixture(), original = f.worker; f.worker = async o => ({ ...await original(o), finalText: 'looks good' });
  const r = await runSupervisor(f); assert.equal(r.status, 'blocked'); assert.equal(f.roles.length, 3);
});
test('interrupted controller is never silently replayed', async () => {
  const f = await fixture(); await fs.mkdir(f.home); await fs.writeFile(path.join(f.home, 'controller.json'), '{"status":"running"}');
  await assert.rejects(() => runSupervisor(f), /no automatic replay/); assert.equal(f.roles.length, 0);
});
test('corrupt state fails closed', async () => {
  const f = await fixture(); await fs.mkdir(f.home); await fs.writeFile(path.join(f.home, 'controller.json'), '{bad');
  await assert.rejects(() => runSupervisor(f)); assert.equal(f.roles.length, 0);
});
test('global usage ceiling blocks later roles', async () => {
  const f = await fixture(), original = f.worker; f.worker = async o => ({ ...await original(o), usage: { totalTokens: LIMITS.actual } });
  const r = await runSupervisor(f); assert.equal(r.status, 'blocked'); assert.equal(f.roles.length, 1);
});
test('two controllers with different homes cannot overlap', async () => {
  const f = await fixture(), original = f.worker; let release, acquired;
  const gate = new Promise(r => release = r), ready = new Promise(r => acquired = r);
  f.worker = async o => { acquired(); await gate; return original(o); };
  const first = runSupervisor(f); await ready;
  try { await assert.rejects(() => runSupervisor({ ...f, home: path.join(f.base, 'other') }), /holds the lock/); } finally { release(); }
  assert.equal((await first).status, 'completed');
});
test('worker cannot alter controller, other sources, or manifest', async () => {
  assert.throws(() => assertScope({ 'tools/a.mjs':'old' }, { 'tools/a.mjs':'new' }, ['apps/a.ts']), /unassigned/);
  const f = await fixture(), original = f.worker;
  f.worker = async o => { await fs.writeFile(path.join(f.manifest.workspace, 'unexpected.txt'), 'changed'); return original(o); };
  const r = await runSupervisor(f); assert.equal(r.status, 'blocked'); assert.match(r.error, /unassigned/);
});
test('manifest rejects arbitrary commands and paths outside assigned app sources', async () => {
  const f = await fixture(); f.manifest.jobs[0].checks.push('deploy'); assert.throws(() => validateManifest(f.manifest));
  f.manifest.jobs[0].checks.pop(); f.manifest.jobs[0].allowedPaths.push('apps/../../tools/glm-supervisor.mjs'); assert.throws(() => validateManifest(f.manifest));
});
