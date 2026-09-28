import { exactTime, relativeTime } from '../scouts.ts';

export function ScoutTime({ at, now }: { at: string | null; now: string | number }) {
  return <time dateTime={at ?? undefined} title={exactTime(at)}>{relativeTime(at, now)}</time>;
}
