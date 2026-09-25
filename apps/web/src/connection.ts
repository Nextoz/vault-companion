// What the screen says about reaching the vault (P4-B). Every session outcome leads somewhere: `ok` goes on to the
// task read, `signed-out` has its own banner, and every other outcome — offline, a server error, a read that timed
// out — ends in the one actionable "Couldn't reach your vault — Try again" state, never in an endless "Loading…".
import type { Fetched } from './api.ts';

/** `refreshing`: the last read was stale against the watermark (G3-1); the last good read stays, if any. */
export type Connection = 'loading' | 'online' | 'offline' | 'error' | 'refreshing';

export interface WakeDeps {
  /** Confirms the session (and records it, or the sign-out); resolves with its outcome. */
  session(): Promise<Fetched<unknown>['kind']>;
  /** Retry the queue now. */
  kick(): void;
  /** Read the tasks; sets its own connection state. */
  tasks(): Promise<void>;
  setConnection(connection: Connection): void;
}

/** Start, `online`, focus and "Try again": re-confirm the session, then retry the queue and read the tasks. */
export async function wake(deps: WakeDeps): Promise<void> {
  const kind = await deps.session();
  switch (kind) {
    case 'ok':
      deps.kick();
      await deps.tasks();
      return;
    case 'signed-out':
      return;
    case 'offline':
    case 'error':
      deps.setConnection(kind);
      return;
    default:
      kind satisfies never;
  }
}

/** Banner text for a read that did not reach the vault; both carry "Try again". */
export function unreachableText(connection: 'offline' | 'error'): string {
  return connection === 'offline'
    ? "Couldn't reach your vault — you're offline. Captures are kept on this device and sent when you're back online."
    : "Couldn't reach your vault.";
}
