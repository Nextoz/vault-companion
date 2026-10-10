import type { GameResponse } from '@vault-companion/contracts';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { getGame } from '../api.ts';
import type { CopyView } from '../lastCopy.ts';
import { useLastCopy } from './useLastCopy.tsx';

export interface CharacterReadState {
  readonly view: CopyView<GameResponse>;
  /** The loaded payload, or null while loading / after a failed read with no copy. */
  readonly data: GameResponse | null;
  /** Re-run the read (the error state's Retry). */
  readonly retry: () => void;
}

/**
 * One read of /api/game shared by the Log card and the Character screen. The retry key is local so the error state
 * can re-read without waiting for the app's refresh cycle, while the last-copy mechanism still shows stale data.
 */
export function CharacterRead({ refreshKey, accountKey, children }: {
  refreshKey: number | null;
  accountKey: string | null;
  children: (state: CharacterReadState) => ReactNode;
}) {
  const [retries, setRetries] = useState(0);
  const view = useLastCopy<GameResponse>(accountKey, 'game', getGame, `${refreshKey ?? 'none'}:${retries}`);
  const data = view.res?.kind === 'ok' ? view.res.data : null;
  return <>{children({ view, data, retry: () => setRetries((n) => n + 1) })}</>;
}
