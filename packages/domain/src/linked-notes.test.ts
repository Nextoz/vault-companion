// Linked-note resolution (vault-contract §1, brief P4-A): server-side, pinned to one commit, allowlisted, 1 MB guard.
// Synthetic vault only.
import { MAX_NOTE_BYTES, type LinkedNoteResponse, type TaskView } from '@vault-companion/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import { createCommandService } from './commands.ts';
import { createLinkedNoteService } from './linked-notes.ts';
import type { StoredFile, VaultPath } from './store.ts';
import { InMemoryStore } from './testing/in-memory-store.ts';

const TODO = 'Tasks/To-Do List.md';
const BS = String.fromCharCode(92);
const TASKS: Record<string, string> = {
  exact: '[[Projects/Garden/Plan]]',
  exactMd: '[[Projects/Garden/Plan.md|the plan]]',
  heading: '[[Projects/Garden/Plan#Beds]]',
  basename: '[[Recipe]]',
  basenameCase: '[[recipe]]',
  second: '[[Nowhere]] then [[Recipe]]',
  ambiguous: '[[Dup]]',
  missing: '[[Nowhere]]',
  dotdot: '[[../Finance/Budget]]',
  dotdotBare: '[[..]]',
  inner: '[[Projects/../Finance/Budget]]',
  absolute: '[[/Projects/Garden/Plan]]',
  backslash: `[[Projects${BS}Garden${BS}Plan]]`,
  percent: '[[Projects%2FGarden%2FPlan]]',
  obsidian: '[[.obsidian/workspace]]',
  nestedHidden: '[[Projects/.obsidian/workspace]]',
  nestedDenied: '[[Projects/tmp/Scratch]]',
  otherRoot: '[[Finance/Budget]]',
  otherRootBare: '[[Budget]]',
  big: '[[Projects/Big]]',
  edge: '[[Projects/Edge]]',
  latin1: '[[Projects/Latin]]',
  hiddenOnly: '[[Hidden]]',
  gitDir: '[[.git/config]]',
};
const todoText = () =>
  ['## Open', ...Object.entries(TASKS).map(([k, link]) => `- [ ] ${k} ${link} #todo`), '', '## Done', ''].join('\n');

const bytes = (n: number) => new Uint8Array(n).fill(0x61);
const SEED: Record<string, string | Uint8Array> = {
  [TODO]: todoText(),
  'Projects/Garden/Plan.md': '# Plan\n\nBeds in [[Recipe]].\n',
  'Inbox/deep/er/Recipe.md': 'Bread\n',
  'Projects/Dup.md': 'one\n',
  'Tasks/sub/dup.md': 'two\n',
  'Finance/Budget.md': 'SECRET-FINANCE\n',
  'Projects/.obsidian/workspace.md': 'SECRET-HIDDEN\n',
  'Projects/.hidden/Hidden.md': 'SECRET-HIDDEN\n',
  'Projects/tmp/Scratch.md': 'SECRET-TMP\n',
  'Projects/Big.md': bytes(MAX_NOTE_BYTES + 1),
  'Projects/Edge.md': bytes(MAX_NOTE_BYTES),
  'Projects/Latin.md': new Uint8Array([0x63, 0x61, 0x66, 0xe9]),
};

let store: InMemoryStore;
let notes: ReturnType<typeof createLinkedNoteService>;
let views: Map<string, TaskView>;

async function loadViews() {
  const r = await createCommandService({ store, now: () => new Date('2026-09-24T12:00:00Z'), timeZone: 'Europe/Copenhagen' }).readTasks([]);
  if ('code' in r) throw new Error(r.code);
  views = new Map(r.allOpen.map((t) => [t.description.split(' ')[0]!, t]));
}

beforeEach(async () => {
  store = await InMemoryStore.create(SEED);
  notes = createLinkedNoteService({ store });
  await loadViews();
});

async function open(key: string, linkIndex = 0): Promise<LinkedNoteResponse> {
  const task = views.get(key);
  if (!task) throw new Error(`no task ${key}`);
  const r = await notes.readLinkedNote({ taskLocator: task.locator, linkIndex });
  if ('retryable' in r) throw new Error(r.code);
  return r;
}
const refusal = async (key: string, linkIndex = 0) => {
  const r = await open(key, linkIndex);
  return r.status === 'refused' ? r.code : `ok:${r.path}`;
};

describe('linked note resolution', () => {
  it('exact path (with or without .md, alias or heading) reads that note at the pinned commit', async () => {
    const r = await open('exact');
    expect(r).toMatchObject({ status: 'ok', path: 'Projects/Garden/Plan.md', revision: store.headCommit, markdown: '# Plan\n\nBeds in [[Recipe]].\n' });
    expect(await refusal('exactMd')).toBe('ok:Projects/Garden/Plan.md');
    expect(await refusal('heading')).toBe('ok:Projects/Garden/Plan.md');
  });

  it('bare name resolves to the unique basename under the allowlisted roots, at any depth, case-insensitively', async () => {
    expect(await refusal('basename')).toBe('ok:Inbox/deep/er/Recipe.md');
    expect(await refusal('basenameCase')).toBe('ok:Inbox/deep/er/Recipe.md');
    expect(await refusal('second', 1)).toBe('ok:Inbox/deep/er/Recipe.md');
    expect(await refusal('second', 0)).toBe('not-found');
  });

  it('several notes with the name ⇒ ambiguous (also when they differ only by case)', async () => {
    expect(await refusal('ambiguous')).toBe('ambiguous');
  });

  it('missing note, and a link index the task does not have ⇒ not-found', async () => {
    expect(await refusal('missing')).toBe('not-found');
    expect(await refusal('exact', 1)).toBe('not-found');
  });

  it.each(['dotdot', 'dotdotBare', 'inner', 'absolute', 'backslash', 'percent', 'obsidian', 'gitDir', 'nestedHidden', 'nestedDenied', 'otherRoot'])(
    'unsafe or out-of-scope target %s ⇒ outside-allowlist, nothing read',
    async (key) => {
      const r = await open(key);
      expect(r).toMatchObject({ status: 'refused', code: 'outside-allowlist' });
      expect(JSON.stringify(r)).not.toContain('SECRET');
    },
  );

  it('bare names never search outside the allowlist or inside hidden folders', async () => {
    expect(await refusal('otherRootBare')).toBe('not-found'); // Finance/Budget.md exists but is never a candidate
    expect(await refusal('hiddenOnly')).toBe('not-found'); // Projects/.hidden/Hidden.md likewise
  });

  it('1 MB guard: 1 MB + 1 byte ⇒ too-large; exactly 1 MB is readable', async () => {
    expect(await refusal('big')).toBe('too-large');
    const edge = await open('edge');
    expect(edge.status === 'ok' && edge.markdown.length).toBe(MAX_NOTE_BYTES);
  });

  it('a folder listing that is truncated ⇒ too-large (uniqueness cannot be proven)', async () => {
    store.listFilesLimit = 2;
    expect(await refusal('basename')).toBe('too-large');
  });

  it('invalid UTF-8 ⇒ encoding', async () => {
    expect(await refusal('latin1')).toBe('encoding');
  });

  it('task changed since the locator was read ⇒ task-changed', async () => {
    await store.commitFiles({ [TODO]: todoText().replace('- [ ] exact [[Projects/Garden/Plan]] #todo', '- [ ] exact [[Finance/Budget]] #todo') });
    expect(await refusal('exact')).toBe('task-changed');
  });

  it('a moved but otherwise unchanged unique line still resolves (vault-contract §3 rule 2)', async () => {
    await store.commitFiles({ [TODO]: todoText().replace('## Open\n', '## Open\n- [ ] new task #todo\n') });
    expect(await refusal('exact')).toBe('ok:Projects/Garden/Plan.md');
  });

  it('a locator with identical twins and a changed blob ⇒ task-changed (never guesses)', async () => {
    const task = views.get('exact')!;
    const r = await notes.readLinkedNote({ taskLocator: { ...task.locator, occurrencesAtRead: 2, blobSha: 'f'.repeat(40) }, linkIndex: 0 });
    expect(r).toMatchObject({ status: 'refused', code: 'task-changed' });
  });

  it('every read is pinned to one commit X: a commit landing mid-request is not seen', async () => {
    const x = store.headCommit;
    store.afterHead = async () => {
      store.afterHead = null;
      await store.commitFiles({ 'Projects/Garden/Plan.md': 'NEWER\n' });
    };
    const r = await open('exact');
    expect(r).toMatchObject({ status: 'ok', revision: x, markdown: '# Plan\n\nBeds in [[Recipe]].\n' });
  });

  it('bytes must be the listed regular file: an adapter serving another blob (symlink follow) is refused', async () => {
    const real = store.readFile.bind(store);
    store.readFile = async (path: VaultPath, at: string): Promise<StoredFile | null> => {
      const f = await real(path, at);
      return f && path !== TODO ? { ...f, blobSha: 'e'.repeat(40), bytes: new TextEncoder().encode('SECRET-FINANCE\n') } : f;
    };
    const r = await open('exact');
    expect(r).toMatchObject({ status: 'refused', code: 'outside-allowlist' });
    expect(JSON.stringify(r)).not.toContain('SECRET');
  });

  it('store outage ⇒ retryable upstream-unavailable', async () => {
    store.readFile = async () => {
      const { StoreUnavailable } = await import('./store.ts');
      throw new StoreUnavailable('down');
    };
    const r = await notes.readLinkedNote({ taskLocator: views.get('exact')!.locator, linkIndex: 0 });
    expect(r).toEqual({ code: 'upstream-unavailable', message: expect.any(String), retryable: true });
  });
});
