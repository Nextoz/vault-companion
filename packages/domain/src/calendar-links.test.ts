// ADR-0052 tests: synthetic fixtures only. The links file is deterministic, minimal-splice, and idempotent.
import { describe, expect, it } from 'vitest';
import {
  createCalendarLinksService,
  parseCalendarLinksFile,
  serializeCalendarLinksFile,
  type CalendarLink,
  type CalendarLinksFile,
} from './calendar-links.ts';
import { calendarItemKey } from '@vault-companion/contracts';
import { CALENDAR_LINKS_PATH, TODO_LIST_PATH } from './paths.ts';
import { InMemoryStore } from './testing/in-memory-store.ts';

const OP_A = '00000000-0000-4000-8000-000000000001';
const OP_B = '00000000-0000-4000-8000-000000000002';
const OP_C = '00000000-0000-4000-8000-000000000003';
const NOW = new Date('2026-10-04T08:00:00.000Z');

const link = (eventId: string, operationId: string): CalendarLink => ({ eventId, operationId, createdAt: NOW.toISOString() });

function file(links: Record<string, CalendarLink>): CalendarLinksFile {
  return { schema: 1, links };
}

function text(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function makeService(store: InMemoryStore, now: () => Date = () => NOW) {
  return createCalendarLinksService({ store, now });
}

const raw = (operationId: string, itemKey: string) => ({ operationId, itemKey });

describe('parse/serialize calendar links file', () => {
  it('round-trips with stable key order and one trailing newline', () => {
    const input = file({ 'item-a': link('event-a', OP_A), 'item-b': link('event-b', OP_B) });
    const bytes = serializeCalendarLinksFile(input);
    expect(text(bytes)).toBe([
      '{',
      '  "schema": 1,',
      '  "links": {',
      '    "item-a": {',
      '      "eventId": "event-a",',
      '      "operationId": "00000000-0000-4000-8000-000000000001",',
      '      "createdAt": "2026-10-04T08:00:00.000Z"',
      '    },',
      '    "item-b": {',
      '      "eventId": "event-b",',
      '      "operationId": "00000000-0000-4000-8000-000000000002",',
      '      "createdAt": "2026-10-04T08:00:00.000Z"',
      '    }',
      '  }',
      '}',
      '',
    ].join('\n'));
    expect(parseCalendarLinksFile(bytes)).toEqual(input);
  });
});

describe('putCalendarLink', () => {
  it('writes one link and leaves the other links untouched', async () => {
    const store = await InMemoryStore.create({
      [CALENDAR_LINKS_PATH]: serializeCalendarLinksFile(file({ 'item-a': link('event-a', OP_A), 'item-b': link('event-b', OP_B) })),
    });
    const service = makeService(store);
    const result = await service.putCalendarLink({ operationId: OP_C, itemKey: 'item-c', eventId: 'event-c', raw: raw(OP_C, 'item-c') });
    expect(result).toMatchObject({ status: 'applied' });
    expect(store.text(CALENDAR_LINKS_PATH)).toBe(text(serializeCalendarLinksFile(file({
      'item-a': link('event-a', OP_A),
      'item-b': link('event-b', OP_B),
      'item-c': link('event-c', OP_C),
    }))));
    expect(store.writeCalls).toBe(1);
  });

  it('retrying the same operation id is already-applied and writes nothing', async () => {
    const store = await InMemoryStore.create({ [CALENDAR_LINKS_PATH]: serializeCalendarLinksFile(file({})) });
    const service = makeService(store);
    const input = { operationId: OP_C, itemKey: 'item-c', eventId: 'event-c', raw: raw(OP_C, 'item-c') };
    await service.putCalendarLink(input);
    const head = store.headCommit;
    const again = await service.putCalendarLink(input);
    expect(again).toMatchObject({ status: 'already-applied' });
    expect(store.headCommit).toBe(head);
    expect(store.writeCalls).toBe(1);
  });

  it('re-reads once after a HEAD/CAS conflict and preserves the concurrent link', async () => {
    const store = await InMemoryStore.create({
      [CALENDAR_LINKS_PATH]: serializeCalendarLinksFile(file({ 'item-a': link('event-a', OP_A) })),
    });
    const service = makeService(store);
    store.afterHead = async () => {
      store.afterHead = null;
      await store.commitFiles({
        [CALENDAR_LINKS_PATH]: serializeCalendarLinksFile(file({ 'item-a': link('event-a', OP_A), 'item-desktop': link('event-desktop', OP_B) })),
      });
    };
    const result = await service.putCalendarLink({ operationId: OP_C, itemKey: 'item-c', eventId: 'event-c', raw: raw(OP_C, 'item-c') });
    expect(result).toMatchObject({ status: 'applied' });
    expect(store.text(CALENDAR_LINKS_PATH)).toBe(text(serializeCalendarLinksFile(file({
      'item-a': link('event-a', OP_A),
      'item-desktop': link('event-desktop', OP_B),
      'item-c': link('event-c', OP_C),
    }))));
    expect(store.writeCalls).toBe(2);
  });
});

describe('removeCalendarLink', () => {
  it('removes only the named link and is idempotent', async () => {
    const store = await InMemoryStore.create({
      [CALENDAR_LINKS_PATH]: serializeCalendarLinksFile(file({ 'item-a': link('event-a', OP_A), 'item-b': link('event-b', OP_B) })),
    });
    const service = makeService(store);
    const input = { operationId: OP_C, itemKey: 'item-a', raw: raw(OP_C, 'item-a') };
    expect(await service.removeCalendarLink(input)).toMatchObject({ status: 'removed' });
    expect(store.text(CALENDAR_LINKS_PATH)).toBe(text(serializeCalendarLinksFile(file({ 'item-b': link('event-b', OP_B) }))));
    const head = store.headCommit;
    expect(await service.removeCalendarLink(input)).toMatchObject({ status: 'already-removed' });
    expect(store.headCommit).toBe(head);
    expect(store.writeCalls).toBe(1);
  });
});

describe('readCalendarLinks', () => {
  it('returns per-item event ids only', async () => {
    const store = await InMemoryStore.create({
      [CALENDAR_LINKS_PATH]: serializeCalendarLinksFile(file({ 'item-a': link('event-a', OP_A) })),
    });
    const result = await makeService(store).readCalendarLinks();
    expect(result).toEqual({ revision: store.headCommit, links: { 'item-a': 'event-a' } });
  });

  it('types a missing or malformed file, never throws', async () => {
    expect(await makeService(await InMemoryStore.create({})).readCalendarLinks()).toMatchObject({ code: 'not-found' });
    const bad = await InMemoryStore.create({ [CALENDAR_LINKS_PATH]: '{not json' });
    expect(await makeService(bad).readCalendarLinks()).toMatchObject({ code: 'invalid' });
  });

  it('resolves a legacy key to the current ADR-0056 key from text and file, after unrelated changes', async () => {
    const text = '- [ ] Call the bank #todo';
    const legacyKey = `task:${'a'.repeat(40)}:4:${text}`;
    const markdown = [
      '## Open',
      '- [ ] Water the plants #todo',
      '- [ ] Buy oat milk #todo',
      text,
      '## Done',
    ].join('\n') + '\n';
    const store = await InMemoryStore.create({
      [CALENDAR_LINKS_PATH]: serializeCalendarLinksFile(file({ [legacyKey]: link('event-legacy', OP_A) })),
      [TODO_LIST_PATH]: new TextEncoder().encode(markdown),
    });
    const result = await makeService(store).readCalendarLinks();
    expect(result).toEqual({
      revision: store.headCommit,
      links: { [calendarItemKey('task', text, 1)]: 'event-legacy' },
    });
  });

  it('does not silently bind an ambiguous duplicate legacy line', async () => {
    const text = '- [ ] Call the bank #todo';
    const legacyKey = `task:${'a'.repeat(40)}:4:${text}`;
    const markdown = ['## Open', text, text, '## Done'].join('\n') + '\n';
    const store = await InMemoryStore.create({
      [CALENDAR_LINKS_PATH]: serializeCalendarLinksFile(file({ [legacyKey]: link('event-legacy', OP_A) })),
      [TODO_LIST_PATH]: new TextEncoder().encode(markdown),
    });
    const result = await makeService(store).readCalendarLinks();
    expect(result).toEqual({ revision: store.headCommit, links: {} });
  });
});

describe('findCalendarItemLink ADR-0056', () => {
  it('returns ambiguous when a legacy text currently occurs more than once', async () => {
    const text = '- [ ] Call the bank #todo';
    const legacyKey = `task:${'a'.repeat(40)}:4:${text}`;
    const markdown = ['## Open', text, text, '## Done'].join('\n') + '\n';
    const store = await InMemoryStore.create({
      [CALENDAR_LINKS_PATH]: serializeCalendarLinksFile(file({ [legacyKey]: link('event-legacy', OP_A) })),
      [TODO_LIST_PATH]: new TextEncoder().encode(markdown),
    });
    const result = await makeService(store).findCalendarItemLink(calendarItemKey('task', text, 2));
    expect(result).toEqual({ status: 'ambiguous' });
  });

  it('does not report already-migrated when the new key holds a different link', async () => {
    const text = '- [ ] Call the bank #todo';
    const legacyKey = `task:${'a'.repeat(40)}:4:${text}`;
    const newKey = calendarItemKey('task', text, 1);
    const store = await InMemoryStore.create({
      [CALENDAR_LINKS_PATH]: serializeCalendarLinksFile(file({
        [legacyKey]: link('event-legacy', OP_A),
        [newKey]: link('event-other', OP_B),
      })),
    });
    const result = await makeService(store).migrateCalendarLink({ operationId: OP_C, itemKey: newKey, legacyKey, raw: {} });
    expect(result).toMatchObject({ code: 'conflict:stale' });
  });
});
