// Small per-device conveniences in localStorage. None of it is vault content; all of it is optional.
export type CaptureKind = 'task' | 'note';

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private mode or storage disabled: the preference is simply not remembered.
  }
}

export const prefs = {
  captureKind: (): CaptureKind => (read('vc.captureKind') === 'note' ? 'note' : 'task'),
  setCaptureKind: (kind: CaptureKind) => write('vc.captureKind', kind),
  /** Last TasksResponse revision: the baseRevision for actions taken while offline. */
  lastRevision: () => read('vc.lastRevision'),
  setLastRevision: (sha: string) => write('vc.lastRevision', sha),
  /** Last confirmed accountKey: binds items created before the session can be re-confirmed. */
  lastAccountKey: () => read('vc.lastAccountKey'),
  setLastAccountKey: (key: string) => write('vc.lastAccountKey', key),
  /** Active Work card folded away on this device (expanded by default). */
  activeWorkCollapsed: () => read('vc.activeWorkCollapsed') === '1',
  setActiveWorkCollapsed: (collapsed: boolean) => write('vc.activeWorkCollapsed', collapsed ? '1' : '0'),
};
