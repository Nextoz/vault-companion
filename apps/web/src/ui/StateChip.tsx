import type { ItemState } from '../queue/queue.ts';

// The only claims the UI may make (sync.md). "Saved to GitHub" never implies the desktop has it.
const TEXT: Record<ItemState, string> = {
  pending: 'On this device',
  saving: 'Saving…',
  saved: 'Saved to GitHub',
  attention: 'Needs attention',
};

export function StateChip({ state }: { state: ItemState }) {
  return <span className={`chip chip-${state}`}>{TEXT[state]}</span>;
}
