import { describe, expect, it } from 'vitest';
import { canReadLinkedNote, canWrite, parseVaultPath, TODO_LIST_PATH } from './paths.ts';

describe('parseVaultPath', () => {
  it.each([
    '../secret.md',
    'Tasks/../../x.md',
    '/Tasks/To-Do List.md',
    'C:/Tasks/x.md',
    'Tasks\\To-Do List.md',
    'Tasks//x.md',
    'Tasks/./x.md',
    'Inbox/x\u0000.md',
    'Inbox/x\n.md',
    '',
    'Inbox/',
    '.git/config',
    '.obsidian/app.json',
    'Tools/backup/x.md',
    '.trash/x.md',
    'tmp/x.md',
    'output/x.md',
    'Inbox/x.txt',
    'Inbox/%2e%2e/x.md',
  ])('rejects %j', (raw) => {
    expect(parseVaultPath(raw)).toBeNull();
  });

  it('accepts a normal note path and NFC-normalises it', () => {
    const decomposed = 'Inbox/Cafe\u0301 - 2026-09-24.md';
    expect(parseVaultPath(decomposed)).toBe('Inbox/Caf\u00e9 - 2026-09-24.md');
  });
});

describe('write allowlist', () => {
  it('allows only the To-Do List and direct Inbox children', () => {
    expect(canWrite(parseVaultPath(TODO_LIST_PATH)!, 'update')).toBe(true);
    expect(canWrite(parseVaultPath('Inbox/Note - 2026-09-24.md')!, 'create')).toBe(true);
  });
  it('denies Inbox subfolders, updates of Inbox notes, creates of the To-Do list, and anything else', () => {
    expect(canWrite(parseVaultPath('Inbox/sub/Note.md')!, 'create')).toBe(false);
    expect(canWrite(parseVaultPath('Inbox/Note.md')!, 'update')).toBe(false);
    expect(canWrite(parseVaultPath(TODO_LIST_PATH)!, 'create')).toBe(false);
    expect(canWrite(parseVaultPath('Tasks/Active Work Now.md')!, 'update')).toBe(false);
    expect(canWrite(parseVaultPath('Journal/Daily/2026-09-24.md')!, 'create')).toBe(false);
  });
});

describe('linked-note read policy', () => {
  it('denies Journal and Health by default, allows other notes', () => {
    expect(canReadLinkedNote(parseVaultPath('Journal/Daily/2026-09-24.md')!)).toBe(false);
    expect(canReadLinkedNote(parseVaultPath('Health/Anything.md')!)).toBe(false);
    expect(canReadLinkedNote(parseVaultPath('Projects/Some Project.md')!)).toBe(true);
  });
});
