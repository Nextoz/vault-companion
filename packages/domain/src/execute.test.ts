import { beforeEach, describe, expect, it } from 'vitest';
import { executeWrite, MAX_ATTEMPTS, type WritePlan } from './execute.ts';
import { TRAILER_OP, TRAILER_PAYLOAD, type VaultPath, type VaultStore } from './store.ts';
import { InMemoryStore, type WriteFault } from './testing/in-memory-store.ts';

// A deliberately simple plan: append one line to a file. Tests exercise the executor, not Markdown.
const PATH = 'Tasks/To-Do List.md' as VaultPath;
const enc = new TextEncoder();
const dec = new TextDecoder();

function appendPlan(line: string): WritePlan<{ appended: string }> {
  return {
    message: 'Vault Companion: test append',
    async compute(store: VaultStore, at: string) {
      const file = await store.readFile(PATH, at);
      if (!file) return { ok: false, code: 'refused:structure', message: 'missing' };
      return { ok: true, path: PATH, expect: 'regular-file', bytes: enc.encode(dec.decode(file.bytes) + line + '\n'), effect: { appended: line } };
    },
  };
}

const count = (text: string | null, line: string) => (text ?? '').split('\n').filter((l) => l === line).length;

let store: InMemoryStore;
let base: string;
const OP = '11111111-1111-4111-8111-111111111111';
const HASH = 'sha256:' + 'a'.repeat(64);

beforeEach(async () => {
  store = await InMemoryStore.create({ [PATH]: '- [ ] one\n' });
  base = store.headCommit;
});

describe('executeWrite', () => {
  it('applies once and writes both trailers and a text-free message', async () => {
    const r = await executeWrite(store, { operationId: OP, baseRevision: base, payloadHash: HASH }, appendPlan('- [ ] two'));
    expect(r).toMatchObject({ ok: true, status: 'applied', path: PATH, commitSha: store.headCommit });
    expect(store.commitsWithOp(OP)).toHaveLength(1);
    expect(store.commitMessages().at(-1)).toBe('Vault Companion: test append');
    const found = await store.findOperation(base, store.headCommit, OP);
    expect(found).toMatchObject({ kind: 'found', op: { payloadHash: HASH } });
  });

  it('lost response on the first PUT: second attempt dedupes, one durable effect (commands.md step 5)', async () => {
    store.writeFaults.push('apply-then-unknown');
    const r = await executeWrite(store, { operationId: OP, baseRevision: base, payloadHash: HASH }, appendPlan('- [ ] two'));
    expect(r).toMatchObject({ ok: true, status: 'already-applied', effect: { appended: '- [ ] two' } });
    expect(store.commitsWithOp(OP)).toHaveLength(1);
    expect(count(store.text(PATH), '- [ ] two')).toBe(1);
  });

  it('client retry after a success returns the original commit and writes nothing', async () => {
    const first = await executeWrite(store, { operationId: OP, baseRevision: base, payloadHash: HASH }, appendPlan('- [ ] two'));
    const writes = store.writeCalls;
    const again = await executeWrite(store, { operationId: OP, baseRevision: base, payloadHash: HASH }, appendPlan('- [ ] two'));
    expect(again).toMatchObject({ ok: true, status: 'already-applied' });
    expect(again.ok && first.ok && again.commitSha === first.commitSha).toBe(true);
    expect(store.writeCalls).toBe(writes);
  });

  it('A25/F1: an earlier attempt that lands after HEAD is resolved is not applied twice', async () => {
    // Attempt 1 times out without GitHub having processed it yet; while attempt 2 is running
    // (after it resolved X), the delayed PUT of attempt 1 lands.
    store.writeFaults.push('drop-then-unknown');
    let heads = 0;
    store.afterHead = async () => {
      if (++heads !== 2) return;
      const f = await store.readFile(PATH, store.headCommit);
      await store.writeFile({
        path: PATH,
        baseCommit: store.headCommit,
        expect: 'regular-file',
        bytes: enc.encode(dec.decode(f!.bytes) + '- [ ] two\n'),
        message: 'Vault Companion: test append',
        trailers: { [TRAILER_OP]: OP, [TRAILER_PAYLOAD]: HASH },
      });
    };
    const r = await executeWrite(store, { operationId: OP, baseRevision: base, payloadHash: HASH }, appendPlan('- [ ] two'));
    expect(r).toMatchObject({ ok: true, status: 'already-applied' });
    expect(store.commitsWithOp(OP)).toHaveLength(1);
    expect(count(store.text(PATH), '- [ ] two')).toBe(1);
  });

  it('operation ID reused with another payload is rejected and writes nothing', async () => {
    await executeWrite(store, { operationId: OP, baseRevision: base, payloadHash: HASH }, appendPlan('- [ ] two'));
    const writes = store.writeCalls;
    const r = await executeWrite(store, { operationId: OP, baseRevision: base, payloadHash: 'sha256:' + 'b'.repeat(64) }, appendPlan('- [ ] other'));
    expect(r).toMatchObject({ ok: false, code: 'operation-id-reused', retryable: false });
    expect(store.writeCalls).toBe(writes);
  });

  it('a concurrent edit to the same file after X loses the CAS, then re-plans on the new content', async () => {
    let heads = 0;
    store.afterHead = async () => {
      if (++heads === 1) await store.commitFiles({ [PATH]: '- [ ] one\n- [ ] desktop\n' });
    };
    const r = await executeWrite(store, { operationId: OP, baseRevision: base, payloadHash: HASH }, appendPlan('- [ ] two'));
    expect(r).toMatchObject({ ok: true, status: 'applied' });
    expect(store.text(PATH)).toBe('- [ ] one\n- [ ] desktop\n- [ ] two\n');
  });

  it('A32/F9: an unsearchable dedupe window never writes (unknown base, truncated window)', async () => {
    const unknownBase = await executeWrite(store, { operationId: OP, baseRevision: 'f'.repeat(40), payloadHash: HASH }, appendPlan('- [ ] two'));
    expect(unknownBase).toMatchObject({ ok: false, code: 'dedupe-unknown' });
    for (let i = 0; i < 3; i++) await store.commitFiles({ 'Inbox/x.md': `v${i}` });
    store.dedupeWindowLimit = 2;
    const truncated = await executeWrite(store, { operationId: OP, baseRevision: base, payloadHash: HASH }, appendPlan('- [ ] two'));
    expect(truncated).toMatchObject({ ok: false, code: 'dedupe-unknown' });
    expect(store.writeCalls).toBe(0);
  });

  it('already-applied commit whose effect cannot be re-derived is reported, not trusted', async () => {
    await executeWrite(store, { operationId: OP, baseRevision: base, payloadHash: HASH }, appendPlan('- [ ] two'));
    // Same op/payload hash, but the plan now computes a different line (e.g. a tampered or changed client).
    const r = await executeWrite(store, { operationId: OP, baseRevision: base, payloadHash: HASH }, appendPlan('- [ ] different'));
    expect(r).toMatchObject({ ok: false, code: 'dedupe-unknown' });
  });

  it('upstream outage is retryable and writes nothing', async () => {
    store.writeFaults.push('unavailable');
    const r = await executeWrite(store, { operationId: OP, baseRevision: base, payloadHash: HASH }, appendPlan('- [ ] two'));
    expect(r).toMatchObject({ ok: false, code: 'upstream-unavailable', retryable: true });
    expect(store.commitsWithOp(OP)).toHaveLength(0);
  });

  it('repeated unknown outcomes end retryable (client retries with the same op ID)', async () => {
    store.writeFaults.push(...Array<WriteFault>(MAX_ATTEMPTS).fill('drop-then-unknown'));
    const r = await executeWrite(store, { operationId: OP, baseRevision: base, payloadHash: HASH }, appendPlan('- [ ] two'));
    expect(r).toMatchObject({ ok: false, code: 'upstream-unavailable', retryable: true });
  });

  it('constant churn on the file ends in conflict:stale after MAX_ATTEMPTS', async () => {
    let n = 0;
    store.afterHead = async () => {
      await store.commitFiles({ [PATH]: `- [ ] one\n- [ ] churn ${n++}\n` });
    };
    const r = await executeWrite(store, { operationId: OP, baseRevision: base, payloadHash: HASH }, appendPlan('- [ ] two'));
    expect(r).toMatchObject({ ok: false, code: 'conflict:stale', retryable: true });
    expect(store.commitsWithOp(OP)).toHaveLength(0);
  });
});
