import { describe, expect, it } from 'vitest';
import { CONFLICT_BANNER, taskListLock } from './writeBlock.ts';

describe('taskListLock (write-blocked task list)', () => {
  it('is null for a writable list or no read', () => {
    expect(taskListLock(null)).toBeNull();
    expect(taskListLock({ writeBlock: null })).toBeNull();
  });

  it('leads with the sync-conflict banner for Git conflict markers', () => {
    const lock = taskListLock({ writeBlock: { code: 'refused:vault-conflict', message: 'File contains Git conflict markers.', retryable: false } });
    expect(lock).toEqual({ banner: CONFLICT_BANNER, conflict: true });
  });

  it("shows the server's reason for other blocks, and does not mark the rows as conflicted", () => {
    const message = 'File needs exactly one "## Open" and one "## Done" heading.';
    expect(taskListLock({ writeBlock: { code: 'refused:structure', message, retryable: false } })).toEqual({ banner: message, conflict: false });
  });
});
