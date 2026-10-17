// Sky monitor M7 (dashboard monitors): the planetary Kp index from NOAA SWPC. Sun and moon times are computed in code
// (packages/domain/src/sun.ts) and are not part of this wire contract.
import { z } from 'zod';

const isoInstant = z.iso.datetime({ offset: true });

export const KP_SOURCE = 'NOAA SWPC';
export const KP_SOURCE_URL = 'https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json';

export const SkyUnavailableReason = z.enum(['timeout', 'provider-error', 'malformed', 'empty']);
export type SkyUnavailableReason = z.infer<typeof SkyUnavailableReason>;

export const SKY_REASON_NOTES: Record<SkyUnavailableReason, string> = {
  timeout: 'NOAA did not answer in time.',
  'provider-error': 'NOAA space weather data is unavailable right now.',
  malformed: 'NOAA sent space weather data we could not read.',
  empty: 'NOAA published no Kp values.',
};

/** One 3-hour planetary Kp value: observed, estimated or predicted, exactly as the provider labels it. */
export const KpPoint = z.strictObject({
  /** Start of the 3-hour slot (the provider's UTC `time_tag`). */
  time: isoInstant,
  kp: z.number().min(0).max(9),
  kind: z.enum(['observed', 'estimated', 'predicted']),
});
export type KpPoint = z.infer<typeof KpPoint>;

export const SkyResponse = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('ok'),
    now: isoInstant,
    /** When the Kp rows were fetched; an older value than expected means a failed refresh reused them. */
    fetchedAt: isoInstant,
    /** The last 24 hours and everything forecast after them. */
    points: z.array(KpPoint),
    /** The slot containing `now`, if the provider covers it. */
    current: KpPoint.nullable(),
    /** Highest Kp in the next 24 hours (ties: earliest). */
    next24hMax: KpPoint.nullable(),
  }),
  z.strictObject({
    status: z.literal('unavailable'),
    now: isoInstant,
    reason: SkyUnavailableReason,
    note: z.string(),
  }),
]);
export type SkyResponse = z.infer<typeof SkyResponse>;

/** Aurora outlook at Copenhagen's latitude (~55 degrees N): only a strong storm reaches it. */
export function kpAuroraLevel(kp: number): 'low' | 'possible' | 'likely' {
  if (kp >= 7) return 'likely';
  return kp >= 5 ? 'possible' : 'low';
}
