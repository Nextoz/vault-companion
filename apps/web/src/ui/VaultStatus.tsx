import type { TasksResponse } from '@vault-companion/contracts';
import { useEffect, useState } from 'react';
import { FRESH_FOR_MS, vaultFreshness } from '../freshness.ts';

export function VaultStatus({ read, checkedAt, failed, busy, onRefresh }: {
  read: TasksResponse | null; checkedAt: number | null; failed: boolean; busy: boolean; onRefresh: () => Promise<void>;
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    setNow(Date.now());
    if (checkedAt === null) return;
    // Update only the display when it ages; this never initiates a read.
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, checkedAt + FRESH_FOR_MS + 1 - Date.now()));
    return () => clearTimeout(timer);
  }, [checkedAt]);
  const status = read ? vaultFreshness(read, checkedAt, failed, now) : null;
  const build = typeof __APP_BUILD__ === 'undefined' ? { commit: 'dev', builtAt: null } : __APP_BUILD__;
  const builtAt = build.builtAt ? new Intl.DateTimeFormat('en-GB', { timeZone: read?.timeZone ?? 'Europe/Copenhagen', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(build.builtAt)) : 'unknown';
  return (
    <section className="vault-status" aria-label="Vault status">
      <details>
        <summary>
          <span>{status?.updated ?? 'Vault not loaded'}</span>
          <span className={status?.warning || failed ? 'chip chip-attention' : 'muted'}>{status?.checked ?? 'Not refreshed yet'}</span>
        </summary>
        <div className="muted">{read && <div>Vault {read.revision.slice(0, 12)}</div>}<div>App {build.commit} · built {builtAt}</div></div>
      </details>
      <button type="button" aria-label="Refresh vault" aria-busy={busy} disabled={busy} onClick={() => void onRefresh()}>Refresh</button>
    </section>
  );
}
