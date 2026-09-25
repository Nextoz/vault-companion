import { describe, expect, it } from 'vitest';
import { decodeLinkedNoteHeader, encodeLinkedNoteHeader, LinkedNoteRequest, LinkedNoteResponse, type LinkedNoteRequest as Req } from './index.ts';

const req: Req = {
  taskLocator: {
    path: 'Tasks/To-Do List.md',
    blobSha: 'a'.repeat(40),
    lineIndex: 4,
    lineText: '- [ ] Læs [[Projekt æøå]] 📅 2026-09-30 #todo',
    occurrencesAtRead: 1,
  },
  linkIndex: 0,
};

describe('linked note request', () => {
  it('round-trips through the header encoding (Unicode, emoji)', () => {
    const value = encodeLinkedNoteHeader(req);
    expect(value).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeLinkedNoteHeader(value)).toEqual(req);
  });

  it('never accepts a client path: extra fields and other locator paths are rejected', () => {
    expect(LinkedNoteRequest.safeParse({ ...req, path: 'Projects/x.md' }).success).toBe(false);
    expect(LinkedNoteRequest.safeParse({ ...req, taskLocator: { ...req.taskLocator, path: 'Projects/x.md' } }).success).toBe(false);
    const smuggled = encodeLinkedNoteHeader({ ...req, path: 'Finance/x.md' } as Req);
    expect(decodeLinkedNoteHeader(smuggled)).toBeNull();
  });

  it.each([undefined, '', 'not base64!', 'e30', 'x'.repeat(200_000), btoa('{"linkIndex":-1}')])('rejects %j', (value) => {
    expect(decodeLinkedNoteHeader(value)).toBeNull();
  });

  it('bounds linkIndex', () => {
    expect(LinkedNoteRequest.safeParse({ ...req, linkIndex: 100 }).success).toBe(false);
    expect(LinkedNoteRequest.safeParse({ ...req, linkIndex: 1.5 }).success).toBe(false);
  });

  it('response is a strict discriminated union', () => {
    const rev = 'b'.repeat(40);
    expect(LinkedNoteResponse.safeParse({ status: 'refused', revision: rev, code: 'ambiguous', message: 'm' }).success).toBe(true);
    expect(LinkedNoteResponse.safeParse({ status: 'refused', revision: rev, code: 'refused:path', message: 'm' }).success).toBe(false);
    expect(LinkedNoteResponse.safeParse({ status: 'ok', revision: rev, path: 'Projects/a.md', blobSha: rev, markdown: '# a' }).success).toBe(true);
  });
});
