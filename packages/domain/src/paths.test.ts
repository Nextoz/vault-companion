import { describe, expect, it } from 'vitest';
import { canReadLinkedNote, canReadRadarSource, canWrite, EXPLAINER_STATUS_PATH, isInboxNotePath, isRadarDecisionPath, isResearchLibraryPath, MORNING_BRIEF_PATH, MORNING_BRIEF_STATUS_PATH, parseVaultPath, TODO_LIST_PATH } from './paths.ts';

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
  it('allows updates to To-Do and Active Work, and creates of direct Inbox children', () => {
    expect(canWrite(parseVaultPath(TODO_LIST_PATH)!, 'update')).toBe(true);
    expect(canWrite(parseVaultPath('Tasks/Active Work Now.md')!, 'update')).toBe(true);
    expect(canWrite(parseVaultPath('Inbox/Note - 2026-09-24.md')!, 'create')).toBe(true);
  });
  it('denies Inbox subfolders, creates of the To-Do list, and anything else', () => {
    expect(canWrite(parseVaultPath('Inbox/sub/Note.md')!, 'create')).toBe(false);
  });

  it('ADR-0022: update of Inbox notes directly in Inbox/ only; subfolders and other roots stay denied', () => {
    expect(canWrite(parseVaultPath('Inbox/Note.md')!, 'update')).toBe(true);
    expect(canWrite(parseVaultPath('Inbox/Note - 2026-09-24 (2).md')!, 'update')).toBe(true);
    expect(canWrite(parseVaultPath('Inbox/sub/Note.md')!, 'update')).toBe(false);
    expect(canWrite(parseVaultPath('Inbox/.hidden.md')!, 'update')).toBe(false);
    expect(canWrite(parseVaultPath('Projects/Note.md')!, 'update')).toBe(false);
    expect(canWrite(parseVaultPath('Tasks/Other.md')!, 'update')).toBe(false);
    expect(canWrite(parseVaultPath('Scratch/Inbox/Note.md')!, 'update')).toBe(false);
    expect(isInboxNotePath('Inbox/Note.md')).toBe(true);
    for (const bad of ['Inbox/sub/Note.md', 'Inbox/Note.txt', 'Inbox/', 'Inbox/../Note.md', 'inbox/Note.md', 'Inbox/ Note.md', 'Inbox/Note%2F.md', 'Inbox/.x.md', 'Inbox/Cafe' + String.fromCharCode(0x301) + '.md']) {
      expect(isInboxNotePath(bad), bad).toBe(false);
    }
    expect(canWrite(parseVaultPath(TODO_LIST_PATH)!, 'create')).toBe(false);
    expect(canWrite(parseVaultPath('Tasks/Active Work Now.md')!, 'create')).toBe(false);
    // ADR-0036: daily journals are now a create target; other Journal paths stay denied.
    expect(canWrite(parseVaultPath('Journal/Daily/2026-09-24.md')!, 'create')).toBe(true);
    expect(canWrite(parseVaultPath('Journal/2026-09-24.md')!, 'create')).toBe(false);
    expect(canWrite(parseVaultPath('Journal/Daily/Notes/2026-09-24.md')!, 'create')).toBe(false);
  });
});

describe('linked-note read policy', () => {
  it('allows only Projects/, Tasks/ and Inbox/ (D2 default)', () => {
    expect(canReadLinkedNote(parseVaultPath('Journal/Daily/2026-09-24.md')!)).toBe(false);
    expect(canReadLinkedNote(parseVaultPath('Health/Anything.md')!)).toBe(false);
    expect(canReadLinkedNote(parseVaultPath('Projects/Some Project.md')!)).toBe(true);
    // Review A8: an allowlist, not a denylist — any other root is denied.
    for (const root of ['Finance', 'Personal', 'Area Example', 'Daily']) expect(canReadLinkedNote(parseVaultPath(`${root}/x.md`)!)).toBe(false);
    expect(canReadLinkedNote(parseVaultPath('Inbox/x.md')!)).toBe(true);
    expect(canReadLinkedNote(parseVaultPath('Tasks/Active Work Now.md')!)).toBe(true);
    // Denied folders are matched case-insensitively (Windows desktop: `TMP/` is `tmp/`) — security review of P4-A.
    for (const p of ['Projects/TMP/x.md', 'Projects/tools/x.md', 'Inbox/Output/x.md']) expect(canReadLinkedNote(parseVaultPath(p)!)).toBe(false);
    for (const p of ['TMP/x.md', 'tools/x.md', 'OUTPUT/x.md']) expect(parseVaultPath(p)).toBeNull();
    // P4-A: hidden or denied folders are off-limits at any depth, not only as roots.
    for (const p of ['Projects/.obsidian/x.md', 'Projects/a/.trash/x.md', 'Inbox/tmp/x.md', 'Tasks/output/x.md', 'Projects/.x.md']) {
      expect(canReadLinkedNote(parseVaultPath(p)!)).toBe(false);
    }
    expect(canReadLinkedNote(parseVaultPath('Projects/a/b/Deep Note.md')!)).toBe(true);
    expect(parseVaultPath(`Inbox/x${String.fromCharCode(0x85)}.md`)).toBeNull();
    expect(parseVaultPath(`Inbox/x${String.fromCharCode(0x2028)}.md`)).toBeNull();
  });
});

describe('ADR-0024 triage write scope', () => {
  it('allows only the monthly decisions file; feed, applier status and other Events paths stay unwritable', () => {
    expect(canWrite(parseVaultPath('Events/Triage/Decisions/2026-09.jsonl')!, 'create')).toBe(true);
    expect(canWrite(parseVaultPath('Events/Triage/Decisions/2026-09.jsonl')!, 'update')).toBe(true);
    for (const p of ['Events/Triage/feed.json', 'Events/Triage/applied.json']) {
      expect(canWrite(parseVaultPath(p)!, 'create')).toBe(false);
      expect(canWrite(parseVaultPath(p)!, 'update')).toBe(false);
    }
    expect(parseVaultPath('Events/Triage/Decisions/2026-13.jsonl')).toBeNull();
    expect(parseVaultPath('Events/Triage/Decisions/sub/2026-09.jsonl')).toBeNull();
    expect(parseVaultPath('Events/Triage/other.json')).toBeNull();
  });
});

describe('ADR-0029 research explainer write scope', () => {
  const w = (p: string, kind: 'create' | 'update') => {
    const path = parseVaultPath(p);
    return path !== null && canWrite(path, kind);
  };
  it("creates and updates notes directly in Research/Explained (updates only replace the job's pending notes; the job checks their blob SHA)", () => {
    expect(w('Research/Explained/2026-09-28 - sparse-attention.md', 'create')).toBe(true);
    expect(w('Research/Explained/2026-09-28 - sparse-attention.md', 'update')).toBe(true);
  });
  it.each([
    'Research/Explained/sub/2026-09-28 - x.md',
    'Research/Explained/.hidden.md',
    'Research/Explained/2026-09-28 - x.txt',
    'Research/Explained.md',
    'Research/Reading Briefs/Research Reading Brief - 2026-09-28.md',
    'Research/Daily Research Scout/Daily Research Scout - 2026-09-28.md',
    'Research/x.md',
    'Other/Research/Explained/x.md',
    'research/explained/x.md',
  ])('refuses sibling or other folder %s', (p) => {
    expect(w(p, 'create')).toBe(false);
    expect(w(p, 'update')).toBe(false);
  });
  it('creates and updates only its own status record', () => {
    expect(w(EXPLAINER_STATUS_PATH, 'create')).toBe(true);
    expect(w(EXPLAINER_STATUS_PATH, 'update')).toBe(true);
    expect(w('Automation/Scout Status/city-events.json', 'create')).toBe(false);
    expect(w('Automation/Scout Status/city-events.json', 'update')).toBe(false);
    expect(w('Automation/Scout Status/research-explainer.md', 'create')).toBe(false);
  });
});

describe('ADR-0046 Morning Brief write scope', () => {
  it('allows exactly the documented JSON path for create and update-by-CAS', () => {
    expect(parseVaultPath(MORNING_BRIEF_PATH)).toBe(MORNING_BRIEF_PATH);
    expect(canWrite(parseVaultPath(MORNING_BRIEF_PATH)!, 'create')).toBe(true);
    expect(canWrite(parseVaultPath(MORNING_BRIEF_PATH)!, 'update')).toBe(true);
    expect(parseVaultPath('Daily/Morning Digest/Morning Brief - 2026-06-15.json')).toBeNull();
    expect(parseVaultPath('Daily/Morning Digest/Other.json')).toBeNull();
  });

  it('allows the ADR-0055 Morning Brief status record beside the explainer record', () => {
    expect(canWrite(parseVaultPath(MORNING_BRIEF_STATUS_PATH)!, 'create')).toBe(true);
    expect(canWrite(parseVaultPath(MORNING_BRIEF_STATUS_PATH)!, 'update')).toBe(true);
  });
});

describe('ADR-0032 Research Radar path scope', () => {
  it('writes only the monthly decisions JSONL, never applied.json or Library', () => {
    expect(canWrite(parseVaultPath('Research/Radar/Decisions/2026-09.jsonl')!, 'create')).toBe(true);
    expect(canWrite(parseVaultPath('Research/Radar/Decisions/2026-09.jsonl')!, 'update')).toBe(true);
    expect(canWrite(parseVaultPath('Research/Radar/applied.json')!, 'create')).toBe(false);
    expect(canWrite(parseVaultPath('Research/Radar/applied.json')!, 'update')).toBe(false);
    expect(parseVaultPath('Research/Radar/Decisions/2026-13.jsonl')).toBeNull();
    expect(parseVaultPath('Research/Radar/Decisions/sub/2026-09.jsonl')).toBeNull();
    expect(isRadarDecisionPath('Research/Radar/Decisions/../2026-09.jsonl')).toBe(false);
  });

  it('reads exactly the four research note folders plus Radar JSON files', () => {
    for (const p of [
      'Research/Daily Research Scout/Daily Research Scout - 2026-09-29.md',
      'Research/Reading Briefs/Research Reading Brief - 2026-09-29.md',
      'Research/Important Research Updates/Paper.md',
      'Research/Explained/Explanation.md',
      'Research/Radar/Decisions/2026-09.jsonl',
      'Research/Radar/applied.json',
    ]) expect(canReadRadarSource(p), p).toBe(true);
    for (const p of [
      'Research/Daily Research Scout/sub/note.md',
      'Research/Daily Research Scout/.hidden.md',
      'Research/Other/Paper.md',
      'Research/Radar/Decisions/2026-09.md',
      'Inbox/Paper.md',
    ]) expect(canReadRadarSource(p), p).toBe(false);
  });

  it('accepts only safe Research/Library applied paths', () => {
    expect(isResearchLibraryPath('Research/Library/Paper.md')).toBe(true);
    expect(isResearchLibraryPath('Research/Library/Topic/Paper.md')).toBe(true);
    for (const p of ['Research/Library/../Paper.md', 'Research/Library/.hidden.md', 'Research/Library/tmp/Paper.md', 'Research/Library/TMP/Paper.md', 'Inbox/Paper.md', 'Research/Library/Paper.txt']) {
      expect(isResearchLibraryPath(p), p).toBe(false);
    }
  });
});
