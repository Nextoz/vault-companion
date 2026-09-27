import { MAX_NOTE_BYTES, SCOUT_STATUS_DIR, ScoutsResponse, LinkedNoteResponse } from '@vault-companion/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createScoutService } from './scouts.ts';
import { canReadScoutOutput, canWrite, parseVaultPath } from './paths.ts';
import { FileTooLarge, StoreUnavailable, StoreUnknownOutcome } from './store.ts';
import { InMemoryStore } from './testing/in-memory-store.ts';

// Synthetic fixtures only. Keep the producer's schema, including explicit nulls.
const failed = {
  schemaVersion: 1, scoutId: 'city-events', displayName: 'City events', schedule: 'daily 06:50', expectedEveryHours: 24,
  lastAttemptAt: '2026-09-27T06:50:02+02:00', lastSuccessAt: null, runStatus: 'failed', sources: null, aiHealth: null,
  findings: null, added: null, errors: 1, lastError: 'runner could not start', latestOutput: null,
  history: [{ at: '2026-09-27T06:50:02+02:00', status: 'failed', findings: null }],
};
const healthy = {
  schemaVersion: 1, scoutId: 'city-events', displayName: 'City events', schedule: 'daily 06:50', expectedEveryHours: 24,
  lastAttemptAt: '2026-09-26T06:50:02+02:00', lastSuccessAt: '2026-09-26T06:51:02+02:00', runStatus: 'success',
  sources: { configured: 12, successful: 12 }, aiHealth: 'healthy', findings: 9, added: 3, errors: 0, lastError: '',
  latestOutput: 'Events/City Events/City Events - 2026-09-26.md',
  history: [
    { at: '2026-09-22T06:50:02+02:00', status: 'success', findings: 4 },
    { at: '2026-09-23T06:50:02+02:00', status: 'success', findings: 6 },
    { at: '2026-09-24T06:50:02+02:00', status: 'success', findings: 0 },
    { at: '2026-09-25T06:50:02+02:00', status: 'success', findings: 7 },
    { at: '2026-09-26T06:50:02+02:00', status: 'success', findings: 9 },
  ],
};
const FILE = `${SCOUT_STATUS_DIR}/city-events.json`;
const NOW = '2026-09-27T12:00:00.000Z';
const service = (store: InMemoryStore) => createScoutService({ store, now: () => new Date(NOW) });
const seed = (patch: Record<string, unknown> = {}, extra: Record<string, string | Uint8Array> = {}) =>
  InMemoryStore.create({ [FILE]: JSON.stringify({ ...healthy, ...patch }), [healthy.latestOutput]: '# Findings\r\n9 events\n', ...extra });
afterEach(() => vi.restoreAllMocks());

describe('scout status reads', () => {
  it('accepts nulls, strips unknown fields, and returns server now at one commit without writes', async () => {
    const store = await InMemoryStore.create({ [FILE]: JSON.stringify({ ...failed, future: true }) });
    const x = store.headCommit;
    store.afterHead = async () => { await store.commitFiles({ [FILE]: JSON.stringify(healthy) }); };
    const result = await service(store).readScouts();
    expect(ScoutsResponse.safeParse(result).success).toBe(true);
    expect(result).toEqual({ revision: x, now: NOW, scouts: [{ state: 'ok', file: FILE, status: failed }] });
    expect(store.calls.filter((c) => c === 'head')).toHaveLength(1);
    expect(store.writeCalls).toBe(0);
  });

  it('accepts every populated field and five history entries', async () => {
    const result = ScoutsResponse.parse(await service(await seed()).readScouts());
    expect(result.scouts).toEqual([{ state: 'ok', file: FILE, status: healthy }]);
  });

  it('flattens line separators and truncates error text before schema validation', async () => {
    const lastError = `first\r\nsecond\u0085third\u2028fourth\u2029${'z'.repeat(220)}`;
    const result = ScoutsResponse.parse(await service(await seed({ lastError })).readScouts());
    expect(result.scouts[0]).toMatchObject({ state: 'ok', status: { lastError: `first second third fourth ${'z'.repeat(174)}` } });
  });

  it.each([
    ['invalid JSON', '{'],
    ['invalid UTF-8', new Uint8Array([...new TextEncoder().encode(JSON.stringify({ ...failed, lastError: 'Z' }))].map((b) => b === 90 ? 255 : b))],
    ['wrong version', JSON.stringify({ ...failed, schemaVersion: 2 })],
    ['wrong field type', JSON.stringify({ ...failed, findings: '9' })],
    ['non-string error', JSON.stringify({ ...failed, lastError: 5 })],
    ['missing fields', '{}'],
    ['array', '[]'],
    ['null', 'null'],
    ['oversized', JSON.stringify(healthy).padEnd(64 * 1024 + 1, ' ')],
  ])('%s is unreadable', async (_name, content) => {
    const store = await InMemoryStore.create({ [FILE]: content });
    expect(ScoutsResponse.parse(await service(store).readScouts()).scouts).toEqual([{ state: 'unreadable', file: FILE }]);
  });

  it('accepts exactly 64 KiB and isolates bad files from good files', async () => {
    const store = await seed({}, { [FILE]: JSON.stringify(healthy).padEnd(64 * 1024, ' '), [`${SCOUT_STATUS_DIR}/bad.json`]: '{' });
    expect(ScoutsResponse.parse(await service(store).readScouts()).scouts.map((s) => s.state)).toEqual(['unreadable', 'ok']);
  });

  it('ignores non-JSON, nested and unlisted files; absent directory is empty', async () => {
    const store = await InMemoryStore.create({ [`${SCOUT_STATUS_DIR}/readme.md`]: '{}', [`${SCOUT_STATUS_DIR}/sub/scout.json`]: '{}' });
    expect(ScoutsResponse.parse(await service(store).readScouts()).scouts).toEqual([]);
    expect(ScoutsResponse.parse(await service(await InMemoryStore.create({})).readScouts()).scouts).toEqual([]);
    const linked = await seed();
    vi.spyOn(linked, 'listFiles').mockResolvedValue([]); // VaultStore excludes symlinks.
    const read = vi.spyOn(linked, 'readFile');
    expect(ScoutsResponse.parse(await service(linked).readScouts()).scouts).toEqual([]);
    expect(read).not.toHaveBeenCalled();
  });

  it('reads at most 50 direct JSON files in stable order', async () => {
    const files = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`${SCOUT_STATUS_DIR}/${String(50 - i).padStart(2, '0')}.json`, JSON.stringify({ ...healthy, scoutId: `scout-${50 - i}` })]));
    const store = await InMemoryStore.create(files);
    const read = vi.spyOn(store, 'readFile');
    const result = ScoutsResponse.parse(await service(store).readScouts());
    expect(result.scouts).toHaveLength(50);
    expect(result.scouts[0]?.file).toBe(`${SCOUT_STATUS_DIR}/00.json`);
    expect(result.scouts.at(-1)?.file).toBe(`${SCOUT_STATUS_DIR}/49.json`);
    expect(read).toHaveBeenCalledTimes(50);
  });

  it('rejects unsafe status names and discards out-of-directory listing entries', async () => {
    const store = await seed();
    vi.spyOn(store, 'listFiles').mockResolvedValue([
      { path: `${SCOUT_STATUS_DIR}/bad\n.json`, blobSha: 'a'.repeat(40) },
      { path: 'Elsewhere/status.json', blobSha: 'b'.repeat(40) },
    ]);
    const read = vi.spyOn(store, 'readFile');
    expect(ScoutsResponse.parse(await service(store).readScouts()).scouts).toEqual([{ state: 'unreadable', file: `${SCOUT_STATUS_DIR}/bad\n.json` }]);
    expect(read).not.toHaveBeenCalled();
  });

  it.each(['missing', 'wrong-blob', 'too-large'] as const)('treats %s status bytes as unreadable', async (fault) => {
    const store = await seed();
    const read = vi.spyOn(store, 'readFile');
    if (fault === 'missing') read.mockResolvedValue(null);
    if (fault === 'wrong-blob') read.mockResolvedValue({ bytes: new TextEncoder().encode(JSON.stringify(healthy)), blobSha: 'f'.repeat(40), commitSha: store.headCommit });
    if (fault === 'too-large') read.mockRejectedValue(new FileTooLarge());
    expect(ScoutsResponse.parse(await service(store).readScouts()).scouts).toEqual([{ state: 'unreadable', file: FILE }]);
  });
});

describe('scout path policy', () => {
  it('permits direct status JSON reads but denies all status writes', () => {
    expect(parseVaultPath(FILE)).toBe(FILE);
    for (const kind of ['create', 'update'] as const) expect(canWrite(parseVaultPath(FILE)!, kind)).toBe(false);
    expect(parseVaultPath(`${SCOUT_STATUS_DIR}/nested/a.json`)).toBeNull();
    expect(parseVaultPath('Automation/other.json')).toBeNull();
    expect(parseVaultPath('Inbox/a.json')).toBeNull();
    expect(parseVaultPath(`${SCOUT_STATUS_DIR}/a.txt`)).toBeNull();
  });
});

describe('scout output reads', () => {
  it.each(['Events/City Events/City Events - 2026-09-26.md', 'Any New Folder/note.md', 'Root.md'])('reads %s byte-faithfully at one commit, outside linked-note roots', async (path) => {
    const markdown = '# Findings\r\n\n- synthetic\n';
    const store = await seed({ latestOutput: path }, { [path]: markdown });
    const x = store.headCommit;
    store.afterHead = async () => { await store.commitFiles({ [FILE]: JSON.stringify({ ...healthy, latestOutput: 'Tools/no.md' }), [path]: 'new text' }); };
    const result = LinkedNoteResponse.parse(await service(store).readScoutOutput('city-events'));
    expect(result).toMatchObject({ status: 'ok', revision: x, path, markdown });
    expect(store.calls.filter((c) => c === 'head')).toHaveLength(1);
    expect(store.writeCalls).toBe(0);
  });

  it.each([
    '../escape.md', 'Events/../escape.md', '/absolute.md', 'C:/absolute.md', 'Events\\note.md', 'Events/%2e%2e/note.md',
    'Events/x\n.md', '.obsidian/a.md', 'Tools/a.md', 'tools/a.md', '.git/a.md', '.trash/a.md', 'tmp/a.md', 'output/a.md',
    'Events/.obsidian/a.md', 'Events/Tools/a.md', 'Events/.hidden.md', 'Events/note.txt',
  ])('refuses unsafe output %j before reading it', async (path) => {
    expect(canReadScoutOutput(path)).toBe(false);
    const store = await seed({ latestOutput: path }, { [path]: 'secret' });
    const read = vi.spyOn(store, 'readFile');
    expect(await service(store).readScoutOutput('city-events')).toMatchObject({ status: 'refused', code: 'outside-allowlist' });
    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0]?.[0]).toBe(FILE);
  });

  it.each(['unknown', 'null-output', 'missing', 'unreadable', 'duplicate', 'invalid-id'] as const)('refuses %s', async (kind) => {
    const store = await seed(kind === 'null-output' ? { latestOutput: null } : {});
    if (kind === 'missing') await store.commitFiles({ [healthy.latestOutput]: null });
    if (kind === 'unreadable') await store.commitFiles({ [FILE]: '{' });
    if (kind === 'duplicate') await store.commitFiles({ [`${SCOUT_STATUS_DIR}/other.json`]: JSON.stringify(healthy) });
    const id = kind === 'unknown' ? 'another' : kind === 'invalid-id' ? '../city-events' : 'city-events';
    const read = vi.spyOn(store, 'readFile');
    expect(await service(store).readScoutOutput(id)).toMatchObject({ status: 'refused', code: 'not-found' });
    if (kind === 'invalid-id') expect(read).not.toHaveBeenCalled();
  });

  it('re-reads the status on each request and resolves ID independently of filename', async () => {
    const store = await seed();
    const svc = service(store);
    expect(await svc.readScoutOutput('city-events')).toMatchObject({ status: 'ok' });
    await store.commitFiles({ [FILE]: null, [`${SCOUT_STATUS_DIR}/renamed.json`]: JSON.stringify({ ...healthy, latestOutput: null }) });
    expect(await svc.readScoutOutput('city-events')).toMatchObject({ status: 'refused' });
    await store.commitFiles({ [`${SCOUT_STATUS_DIR}/renamed.json`]: JSON.stringify(healthy) });
    expect(await svc.readScoutOutput('city-events')).toMatchObject({ status: 'ok' });
  });

  it('does not follow unlisted output (symlink) or accept changed blob proof', async () => {
    const store = await seed();
    const realList = store.listFiles.bind(store);
    vi.spyOn(store, 'listFiles').mockImplementation(async (dir, at) => dir === SCOUT_STATUS_DIR ? realList(dir, at) : []);
    const read = vi.spyOn(store, 'readFile');
    expect(await service(store).readScoutOutput('city-events')).toMatchObject({ code: 'not-found' });
    expect(read).toHaveBeenCalledTimes(1);
    vi.mocked(store.listFiles).mockImplementation(async (dir, at) => (await realList(dir, at)).map((f) => dir === SCOUT_STATUS_DIR ? f : { ...f, blobSha: 'f'.repeat(40) }));
    expect(await service(store).readScoutOutput('city-events')).toMatchObject({ code: 'outside-allowlist' });
  });

  it.each(['size', 'adapter-size', 'encoding', 'missing', 'listing-size'] as const)('retains linked-note %s guard', async (fault) => {
    const bytes = fault === 'size' ? 'x'.repeat(MAX_NOTE_BYTES + 1) : fault === 'encoding' ? new Uint8Array([0xff]) : 'ok';
    const store = await seed({}, { [healthy.latestOutput]: bytes });
    const realRead = store.readFile.bind(store);
    if (fault === 'adapter-size' || fault === 'missing') vi.spyOn(store, 'readFile').mockImplementation(async (path, at) => {
      if (path === FILE) return realRead(path, at);
      if (fault === 'missing') return null;
      throw new FileTooLarge();
    });
    if (fault === 'listing-size') {
      const realList = store.listFiles.bind(store);
      vi.spyOn(store, 'listFiles').mockImplementation(async (dir, at) => {
        if (dir === SCOUT_STATUS_DIR) return realList(dir, at);
        throw new FileTooLarge();
      });
    }
    const result = await service(store).readScoutOutput('city-events');
    expect(result).toMatchObject({ status: 'refused', code: fault === 'encoding' ? 'encoding' : fault === 'missing' ? 'not-found' : 'too-large' });
    if (fault === 'adapter-size') expect(result).toMatchObject({ message: 'the note is larger than 1 MB' });
  });
});

describe('scout upstream errors', () => {
  it.each([StoreUnavailable, StoreUnknownOutcome])('maps %s from head, listing and bytes for both endpoints', async (ErrorType) => {
    for (const method of ['head', 'listFiles', 'readFile'] as const) {
      const store = await seed();
      vi.spyOn(store, method).mockRejectedValue(new ErrorType('private diagnostic'));
      const svc = service(store);
      for (const read of [() => svc.readScouts(), () => svc.readScoutOutput('city-events')]) {
        expect(await read()).toEqual({ code: 'upstream-unavailable', message: 'GitHub is not reachable right now', retryable: true });
      }
    }
  });

  it('fails closed when status listing is truncated', async () => {
    const store = await seed();
    store.listFilesLimit = 0;
    expect(await service(store).readScouts()).toMatchObject({ code: 'upstream-unavailable' });
    expect(await service(store).readScoutOutput('city-events')).toMatchObject({ status: 'refused', code: 'too-large' });
  });
});

it('matches a decomposed (NFD) latestOutput to the stored NFC note (CodeRabbit #31)', async () => {
  const composed = 'Events/Caf' + String.fromCharCode(0xe9) + '.md';
  const decomposed = 'Events/Cafe' + String.fromCharCode(0x301) + '.md';
  expect(decomposed).not.toBe(composed);
  const store = await seed({ latestOutput: decomposed }, { [composed]: '# Findings\n' });
  expect(await service(store).readScoutOutput('city-events')).toMatchObject({ status: 'ok', path: composed });
});
