// ADR-0022: the X-VC-Note header round-trips any valid Inbox note path and decodes nothing else.
import { describe, expect, it } from 'vitest';
import { decodeNoteHeader, encodeNoteHeader } from './index.ts';

describe('note header', () => {
  it('round-trips non-ASCII names as an ASCII header value', () => {
    const path = 'Inbox/Blåbær & æøå #1 - 2026-09-27.md';
    const value = encodeNoteHeader(path);
    expect(value).toMatch(/^[\x21-\x7e]+$/);
    expect(decodeNoteHeader(value)).toBe(path);
  });
  it.each([undefined, '', '%E0%A4%A', encodeNoteHeader('Inbox/Sub/a.md'), encodeNoteHeader('Projects/a.md'), encodeNoteHeader('Inbox/a%2F.md'), 'x'.repeat(5000)])(
    'rejects %s',
    (value) => expect(decodeNoteHeader(value)).toBeNull(),
  );
});
