// Phase 2 disposable end-to-end (docs/testing.md, roadmap Phase 2): the real Worker app on Node, the real command
// service over LocalGitStore on a temp bare repo, a desktop clone synced by the W1–W5 model, and a phone speaking the
// real contracts over HTTP. No mocks. Every scenario ends by asserting the exact bytes in the desktop clone.
import { rename } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Receipt } from '@vault-companion/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { Desktop } from './desktop.ts';
import { createRemote, git, logWithOps, tryGit, type RemoteFixture } from './git.ts';
import { Phone, type CommandAnswer } from './phone.ts';
import { startServer, type HarnessServer } from './server.ts';

const TODO = 'Tasks/To-Do List.md';
const NOW = new Date('2026-09-24T10:00:00Z');
const OCCURRED_AT = '2026-09-24T12:00:00+02:00'; // = NOW; Copenhagen date 2026-09-24

// Synthetic text only.
const WATER = '- [ ] Water the plants #todo ➕ 2026-09-01';
const BIKE = '- [ ] Call the bike shop #todo ➕ 2026-09-02';
const RECEIPTS = '- [ ] Sort the receipts #todo ➕ 2026-09-03';
const GARDEN = '- [ ] Draft the garden plan #todo ➕ 2026-09-04';
const PERMIT = '- [ ] Renew the parking permit #todo ➕ 2026-09-05';
const DENTIST = '- [ ] Book the dentist #todo ➕ 2026-09-06';
const OLD_DONE = '- [x] Fixed the bike light #todo ➕ 2026-09-01 ✅ 2026-09-20';
const OPEN = [WATER, BIKE, RECEIPTS, GARDEN, PERMIT, DENTIST];

const done = (open: string) => `${open.replace('- [ ]', '- [x]')} ✅ 2026-09-24`;
const captured = (text: string) => `- [ ] ${text} #todo ➕ 2026-09-24`;

/** The whole To-Do List, byte for byte. */
function todo(open: readonly string[], doneItems: readonly string[] = [OLD_DONE], eol = '\n'): string {
  return ['---', 'title: To-Do List', '---', '', '## Open', '', ...open, '', '## Done', '', ...doneItems, ''].join(eol);
}

interface Harness {
  readonly remote: RemoteFixture;
  readonly server: HarnessServer;
  readonly phone: Phone;
  readonly desktop: Desktop;
  /** Commits on the bare repo's main carrying `Vault-Companion-Op: <operationId>`. */
  commitsFor(operationId: string): string[];
  bareHead(): string;
}

let current: Harness | null = null;

async function setup(seed: string = todo(OPEN)): Promise<Harness> {
  const remote = createRemote({ [TODO]: seed });
  const server = await startServer({ bare: remote.bare, gitEnv: remote.env, now: () => NOW, timeZone: 'Europe/Copenhagen' });
  const phone = await Phone.signIn(server.baseUrl, await server.token(), OCCURRED_AT);
  const desktop = Desktop.clone(remote.env, remote.bare, join(remote.root, 'desktop'));
  current = {
    remote,
    server,
    phone,
    desktop,
    commitsFor: (op) => logWithOps(remote.env, remote.bare).filter((c) => c.operationId === op).map((c) => c.sha),
    bareHead: () => git(remote.env, remote.bare, 'rev-parse', 'main'),
  };
  return current;
}

afterEach(async () => {
  if (!current) return;
  const { server, remote } = current;
  current = null;
  await server.close();
  // A18 across the whole harness: no task or note text, no clear-text vault path reaches the log sink.
  const logged = JSON.stringify(server.logs);
  for (const word of ['Water', 'bike', 'receipts', 'garden', 'permit', 'dentist', 'bakery', 'insurance', 'stamps', 'Inbox/', 'To-Do']) {
    expect(logged).not.toContain(word);
  }
  rmSync(remote.root, { recursive: true, force: true });
});

function receiptOf(answer: CommandAnswer): Receipt {
  if (!('receipt' in answer)) throw new Error(`expected a receipt, got ${answer.status} ${answer.error.code}`);
  return answer.receipt;
}

const locatorOf = (tasks: Awaited<ReturnType<Phone['read']>>, lineText: string) => {
  const hits = tasks.allOpen.filter((t) => t.locator.lineText === lineText);
  expect(hits).toHaveLength(1);
  return hits[0]!.locator;
};

describe.each([
  ['LF', '\n'],
  ['CRLF', '\r\n'],
])('app → desktop completion (%s)', (_name, eol) => {
  it('the completion reaches the desktop clone byte-exact, with trailers and no task text in the commit message', async () => {
    const h = await setup(todo(OPEN, [OLD_DONE], eol));
    const tasks = await h.phone.read();
    const cmd = h.phone.envelope('CompleteTask', { task: locatorOf(tasks, WATER) }, tasks.revision);
    const receipt = receiptOf(await h.phone.send(cmd));
    expect(receipt.status).toBe('applied');
    expect(receipt.effect).toEqual({ kind: 'completed', completedLineText: done(WATER), openLineText: WATER, completedInPlace: false, doneDate: '2026-09-24' });

    expect(h.desktop.sync()).toEqual({ committedLocal: false, integrated: 'fast-forward', conflicts: [], pushed: false });
    expect(h.desktop.read(TODO)).toBe(todo([BIKE, RECEIPTS, GARDEN, PERMIT, DENTIST], [done(WATER), OLD_DONE], eol));
    expect(h.desktop.head()).toBe(receipt.commitSha);
    expect(h.desktop.git('rev-parse', `HEAD:${TODO}`)).toBe(receipt.blobSha);
    const message = h.desktop.git('log', '-1', '--format=%B', receipt.commitSha);
    expect(message).toContain(`Vault-Companion-Op: ${cmd.operationId}`);
    expect(message).toMatch(/Vault-Companion-Payload: sha256:[0-9a-f]{64}/);
    expect(message).not.toContain('Water');
  });
});

describe('desktop → app', () => {
  it('a desktop edit pushed by sync is what the next read serves', async () => {
    const h = await setup();
    const before = await h.phone.read();
    const permitDue = PERMIT.replace('#todo', '#todo 📅 2026-10-01');
    h.desktop.edit(TODO, (t) => t.replace(PERMIT, permitDue));
    expect(h.desktop.sync()).toEqual({ committedLocal: true, integrated: 'up-to-date', conflicts: [], pushed: true });

    const after = await h.phone.read();
    expect(after.revision).toBe(h.desktop.head());
    expect(after.revision).not.toBe(before.revision);
    expect(after.blobSha).toBe(h.desktop.git('rev-parse', `HEAD:${TODO}`));
    expect(locatorOf(after, permitDue).lineIndex).toBe(10);
    expect(after.allOpen.map((t) => t.locator.lineText)).not.toContain(PERMIT);
    expect(h.desktop.read(TODO)).toBe(todo([WATER, BIKE, RECEIPTS, GARDEN, permitDue, DENTIST]));
  });
});

describe('captures', () => {
  it('capture task lands at the top of Open (ADR-0010)', async () => {
    const h = await setup();
    const tasks = await h.phone.read();
    const receipt = receiptOf(await h.phone.send(h.phone.envelope('CaptureTask', { text: 'Call the bakery' }, tasks.revision)));
    expect(receipt.effect).toEqual({ kind: 'task-captured', lineText: captured('Call the bakery') });

    h.desktop.sync();
    expect(h.desktop.read(TODO)).toBe(todo([captured('Call the bakery'), ...OPEN]));
  });

  it('capture note creates the Inbox file with exact bytes and leaves the To-Do List alone', async () => {
    const h = await setup();
    const tasks = await h.phone.read();
    const cmd = h.phone.envelope('CaptureNote', { text: 'Call the insurance office\nAsk about the bike cover', context: '[[Projects/Bikes|bikes]]' }, tasks.revision);
    const receipt = receiptOf(await h.phone.send(cmd));
    const path = 'Inbox/Call the insurance office - 2026-09-24.md';
    expect(receipt).toMatchObject({ status: 'applied', path, effect: { kind: 'note-captured', path } });

    h.desktop.sync();
    expect(h.desktop.read(path)).toBe(
      '---\ndate: 2026-09-24\ncreated: 2026-09-24T12:00:00+02:00\ntype: inbox-note\nstatus: open\nsource: vault-companion\n' +
        'tags:\n  - inbox\ncontext: "[[Projects/Bikes|bikes]]"\n---\n\nCall the insurance office\nAsk about the bike cover\n',
    );
    expect(h.desktop.read(TODO)).toBe(todo(OPEN));
  });
});

describe('retries', () => {
  it('lost response: the server committed, the phone never heard; the retry answers already-applied with one commit', async () => {
    const h = await setup();
    const tasks = await h.phone.read();
    const cmd = h.phone.envelope('CaptureTask', { text: 'Call the bakery' }, tasks.revision);

    h.server.dropNextCommandResponse();
    await expect(h.phone.send(cmd)).rejects.toThrow();
    const committed = h.commitsFor(cmd.operationId);
    expect(committed).toHaveLength(1); // the effect happened although the answer was lost

    const retry = receiptOf(await h.phone.send(cmd));
    expect(retry.status).toBe('already-applied');
    expect(retry.commitSha).toBe(committed[0]);
    expect(retry.effect).toEqual({ kind: 'task-captured', lineText: captured('Call the bakery') });
    expect(h.commitsFor(cmd.operationId)).toHaveLength(1);

    h.desktop.sync();
    expect(h.desktop.read(TODO)).toBe(todo([captured('Call the bakery'), ...OPEN]));
  });

  it('double submit: two identical requests in flight produce one commit and one shared receipt', async () => {
    const h = await setup();
    const tasks = await h.phone.read();
    const cmd = h.phone.envelope('CompleteTask', { task: locatorOf(tasks, WATER) }, tasks.revision);

    const [a, b] = (await Promise.all([h.phone.send(cmd), h.phone.send(cmd)])).map(receiptOf) as [Receipt, Receipt];
    expect([a.status, b.status].sort()).toEqual(['already-applied', 'applied']);
    expect(a.commitSha).toBe(b.commitSha);
    expect(h.commitsFor(cmd.operationId)).toEqual([a.commitSha]);

    h.desktop.sync();
    expect(h.desktop.read(TODO)).toBe(todo([BIKE, RECEIPTS, GARDEN, PERMIT, DENTIST], [done(WATER), OLD_DONE]));
  });
});

describe('divergence', () => {
  it('dirty desktop edit to another task + app completion: sync commits first, merges, both survive', async () => {
    const h = await setup();
    const tasks = await h.phone.read();
    const permitDue = PERMIT.replace('#todo', '#todo 📅 2026-10-01');
    h.desktop.edit(TODO, (t) => t.replace(PERMIT, permitDue)); // uncommitted, like Obsidian mid-session
    const receipt = receiptOf(await h.phone.send(h.phone.envelope('CompleteTask', { task: locatorOf(tasks, WATER) }, tasks.revision)));

    expect(h.desktop.sync()).toEqual({ committedLocal: true, integrated: 'merged', conflicts: [], pushed: true });
    expect(h.desktop.read(TODO)).toBe(todo([BIKE, RECEIPTS, GARDEN, permitDue, DENTIST], [done(WATER), OLD_DONE]));
    expect(h.bareHead()).toBe(h.desktop.head());
    expect(tryGit(h.remote.env, h.remote.bare, 'merge-base', '--is-ancestor', receipt.commitSha, 'main').code).toBe(0); // W1
  });

  it('compatible divergence: desktop commit + app commits, then sync merges without loss', async () => {
    const h = await setup();
    const tasks = await h.phone.read();
    const dentistDue = DENTIST.replace('#todo', '#todo 📅 2026-10-02');
    h.desktop.edit(TODO, (t) => t.replace(DENTIST, dentistDue));
    const desktopCommit = h.desktop.commit('desktop: reschedule');
    const completed = receiptOf(await h.phone.send(h.phone.envelope('CompleteTask', { task: locatorOf(tasks, WATER) }, tasks.revision)));
    const capturedTask = receiptOf(await h.phone.send(h.phone.envelope('CaptureTask', { text: 'Call the bakery' }, tasks.revision)));

    expect(h.desktop.sync()).toEqual({ committedLocal: false, integrated: 'merged', conflicts: [], pushed: true });
    expect(h.desktop.read(TODO)).toBe(todo([captured('Call the bakery'), BIKE, RECEIPTS, GARDEN, PERMIT, dentistDue], [done(WATER), OLD_DONE]));
    for (const sha of [desktopCommit, completed.commitSha, capturedTask.commitSha]) {
      expect(tryGit(h.remote.env, h.remote.bare, 'merge-base', '--is-ancestor', sha, 'main').code).toBe(0);
    }
    const mergeParents = h.desktop.git('log', '-1', '--format=%P').split(' ');
    expect(mergeParents).toEqual([desktopCommit, capturedTask.commitSha]);
  });

  it('desktop QuickAdd append at the end of Open + app capture at the top merge cleanly (ADR-0010)', async () => {
    const h = await setup();
    const tasks = await h.phone.read();
    const stamps = '- [ ] Buy stamps #todo ➕ 2026-09-24';
    h.desktop.edit(TODO, (t) => t.replace(`${DENTIST}\n`, `${DENTIST}\n${stamps}\n`));
    receiptOf(await h.phone.send(h.phone.envelope('CaptureTask', { text: 'Call the bakery' }, tasks.revision)));

    expect(h.desktop.sync()).toEqual({ committedLocal: true, integrated: 'merged', conflicts: [], pushed: true });
    expect(h.desktop.read(TODO)).toBe(todo([captured('Call the bakery'), ...OPEN, stamps]));
  });
});

describe('same-task conflict', () => {
  const waterDue = WATER.replace('#todo', '#todo 📅 2026-09-30');

  it('desktop edit published first: the app refuses the stale completion and writes nothing', async () => {
    const h = await setup();
    const tasks = await h.phone.read();
    h.desktop.edit(TODO, (t) => t.replace(WATER, waterDue));
    h.desktop.sync();
    const headBefore = h.bareHead();

    const answer = await h.phone.send(h.phone.envelope('CompleteTask', { task: locatorOf(tasks, WATER) }, tasks.revision));
    expect(answer.status).toBe(409);
    expect('error' in answer && answer.error).toMatchObject({ code: 'conflict:task-changed', retryable: false });
    expect(h.bareHead()).toBe(headBefore);

    expect(h.desktop.sync().integrated).toBe('up-to-date');
    expect(h.desktop.read(TODO)).toBe(todo([waterDue, BIKE, RECEIPTS, GARDEN, PERMIT, DENTIST]));
  });

  it('concurrent edit and completion: sync preserves both sides as committed markers; the app then refuses writes', async () => {
    const h = await setup();
    const tasks = await h.phone.read();
    h.desktop.edit(TODO, (t) => t.replace(WATER, waterDue)); // not yet synced
    const completed = receiptOf(await h.phone.send(h.phone.envelope('CompleteTask', { task: locatorOf(tasks, WATER) }, tasks.revision)));

    expect(h.desktop.sync()).toEqual({ committedLocal: true, integrated: 'conflict', conflicts: [TODO], pushed: true });
    // Nothing lost: the desktop's edited line (ours) and the app's completion (Done) are both in the file.
    const expected =
      '---\ntitle: To-Do List\n---\n\n## Open\n\n' +
      `<<<<<<< HEAD\n${waterDue}\n=======\n>>>>>>> origin/main\n` +
      `${BIKE}\n${RECEIPTS}\n${GARDEN}\n${PERMIT}\n${DENTIST}\n\n## Done\n\n${done(WATER)}\n${OLD_DONE}\n`;
    expect(h.desktop.read(TODO)).toBe(expected);
    expect(h.bareHead()).toBe(h.desktop.head());
    expect(tryGit(h.remote.env, h.remote.bare, 'merge-base', '--is-ancestor', completed.commitSha, 'main').code).toBe(0);

    const after = await h.phone.read();
    expect(after.writeBlock).toMatchObject({ code: 'refused:vault-conflict', retryable: false });
    const headBefore = h.bareHead();
    const refused = await h.phone.send(h.phone.envelope('CaptureTask', { text: 'Call the bakery' }, after.revision));
    expect(refused.status).toBe(422);
    expect('error' in refused && refused.error.code).toBe('refused:vault-conflict');
    expect(h.bareHead()).toBe(headBefore);

    expect(h.desktop.sync().integrated).toBe('up-to-date');
    expect(h.desktop.read(TODO)).toBe(expected);
  });
});

describe('concurrency and upstream', () => {
  it('remote race: concurrent app commands each land exactly once, history stays linear', async () => {
    const h = await setup();
    const tasks = await h.phone.read();
    const texts = ['Call the bakery', 'Buy stamps', 'Book the insurance call'];
    const cmds = [
      ...texts.map((text) => h.phone.envelope('CaptureTask', { text }, tasks.revision)),
      h.phone.envelope('CompleteTask', { task: locatorOf(tasks, RECEIPTS) }, tasks.revision),
    ];
    const answers = await Promise.all(cmds.map((c) => h.phone.sendUntilSettled(c)));
    for (const a of answers) expect(a.status).toBe(200);

    const log = logWithOps(h.remote.env, h.remote.bare);
    for (const c of cmds) expect(h.commitsFor(c.operationId)).toHaveLength(1);
    expect(log).toHaveLength(1 + cmds.length);
    for (const commit of log) expect(commit.parents.length).toBeLessThanOrEqual(1);

    // Each capture goes to the top of Open, so the newest commit's line is first.
    const captureOrder = log.map((c) => cmds.findIndex((x) => x.operationId === c.operationId)).filter((i) => i >= 0 && i < texts.length);
    const topOfOpen = captureOrder.reverse().map((i) => captured(texts[i]!));
    h.desktop.sync();
    expect(h.desktop.read(TODO)).toBe(todo([...topOfOpen, WATER, BIKE, GARDEN, PERMIT, DENTIST], [done(RECEIPTS), OLD_DONE]));
  });

  it('upstream unavailable: 503 retryable while the repository is unreadable, then the same envelope succeeds once', async () => {
    const h = await setup();
    const tasks = await h.phone.read();
    const cmd = h.phone.envelope('CaptureTask', { text: 'Call the bakery' }, tasks.revision);
    const offline = `${h.remote.bare}.offline`;

    await rename(h.remote.bare, offline);
    try {
      const read = await h.phone.tasks();
      expect(read.status).toBe(503);
      expect('error' in read && read.error).toMatchObject({ code: 'upstream-unavailable', retryable: true });
      const write = await h.phone.send(cmd);
      expect(write.status).toBe(503);
      expect('error' in write && write.error).toMatchObject({ code: 'upstream-unavailable', retryable: true });
    } finally {
      await rename(offline, h.remote.bare);
    }

    const receipt = receiptOf(await h.phone.send(cmd));
    expect(receipt.status).toBe('applied');
    expect(h.commitsFor(cmd.operationId)).toEqual([receipt.commitSha]);
    h.desktop.sync();
    expect(h.desktop.read(TODO)).toBe(todo([captured('Call the bakery'), ...OPEN]));
  });

  it('stale read: a desktop commit after the phone read shifts the task; the completion replans and keeps the desktop edit', async () => {
    const h = await setup();
    const tasks = await h.phone.read();
    const stale = locatorOf(tasks, WATER);
    const oil = '- [ ] Oil the chain #todo ➕ 2026-09-23';
    h.desktop.edit(TODO, (t) => t.replace(`## Open\n\n${WATER}`, `## Open\n\n${oil}\n${WATER}`));
    h.desktop.sync();
    const desktopCommit = h.desktop.head();

    const receipt = receiptOf(await h.phone.send(h.phone.envelope('CompleteTask', { task: stale }, tasks.revision)));
    expect(receipt.status).toBe('applied');
    expect(git(h.remote.env, h.remote.bare, 'rev-parse', `${receipt.commitSha}^`)).toBe(desktopCommit); // replanned on the newer head

    const next = await h.phone.tasks([receipt.commitSha]);
    expect('tasks' in next && next.tasks.known).toEqual({ [receipt.commitSha]: 'included' });

    expect(h.desktop.sync().integrated).toBe('fast-forward');
    expect(h.desktop.read(TODO)).toBe(todo([oil, BIKE, RECEIPTS, GARDEN, PERMIT, DENTIST], [done(WATER), OLD_DONE]));
  });
});
