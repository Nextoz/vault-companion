// Security review (parser differential): the contract accepts exactly the Inbox note paths the server policy accepts.
import { describe, expect, it } from 'vitest';
import { InboxNotePath } from './index.ts';

const cp = (...codes: number[]) => String.fromCharCode(...codes);
describe('InboxNotePath', () => {
  it('accepts a plain, NFC note directly in Inbox/', () => {
    expect(InboxNotePath.safeParse('Inbox/Garden idea - 2026-09-27.md').success).toBe(true);
    expect(InboxNotePath.safeParse('Inbox/Caf' + cp(0xe9) + '.md').success).toBe(true);
  });
  it.each([
    ['subfolder', 'Inbox/sub/note.md'],
    ['backslash', 'Inbox/a' + cp(92) + 'b.md'],
    ['percent escape', 'Inbox/a%2Fb.md'],
    ['dot file', 'Inbox/.hidden.md'],
    ['dot-dot', 'Inbox/...md'],
    ['padded name', 'Inbox/ note.md'],
    ['control character', 'Inbox/a' + cp(1) + 'b.md'],
    ['line separator', 'Inbox/a' + cp(0x2028) + 'b.md'],
    ['decomposed (NFD)', 'Inbox/Cafe' + cp(0x301) + '.md'],
    ['not markdown', 'Inbox/note.txt'],
    ['other root', 'Projects/note.md'],
  ])('refuses %s', (_label, path) => {
    expect(InboxNotePath.safeParse(path).success).toBe(false);
  });
});
