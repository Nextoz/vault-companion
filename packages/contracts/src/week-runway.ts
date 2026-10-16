// Week runway read model (M8). The next 7 Copenhagen evenings (17:00-23:00 local) marked free / busy / pick /
// unknown with that day's weather. Pure projection of already-public read models: no secrets, no writes, no identity.
import { z } from 'zod';

// Disallow runtime code generation (eval/Function probe) under strict CSP (script-src 'self') and Cloudflare Workers.
z.config({ jitless: true });

const isoInstant = z.iso.datetime({ offset: true });

export const WeekRunwayState = z.enum(['free', 'busy', 'pick', 'unknown']);
export type WeekRunwayState = z.infer<typeof WeekRunwayState>;

/** An evening the user picked for: latest triage decision 'go', enriched from the feed card when present. */
export const WeekRunwayPick = z.strictObject({
  eventId: z.string().regex(/^[0-9a-f]{20}$/),
  title: z.string().max(500),
  start: isoInstant,
  end: isoInstant.nullable(),
});
export type WeekRunwayPick = z.infer<typeof WeekRunwayPick>;

/** One evening 17:00-23:00 local wall time: state plus that day's weather (null when the source has none). */
export const WeekRunwayEvening = z.strictObject({
  day: z.iso.date(),
  highTemperatureC: z.number().finite().nullable(),
  weatherCode: z.number().int().min(0).nullable(),
  state: WeekRunwayState,
  picks: z.array(WeekRunwayPick).max(20),
});
export type WeekRunwayEvening = z.infer<typeof WeekRunwayEvening>;

export const WeekRunwaySource = z.enum(['ok', 'unavailable']);
export type WeekRunwaySource = z.infer<typeof WeekRunwaySource>;

/** `/api/week-runway` answers this read model. Exactly 7 evenings starting at the user's current date. */
export const WeekRunwayResponse = z.strictObject({
  now: isoInstant,
  sources: z.strictObject({
    calendar: WeekRunwaySource,
    weather: WeekRunwaySource,
    triage: WeekRunwaySource,
  }),
  evenings: z.array(WeekRunwayEvening).length(7),
  counts: z.strictObject({
    free: z.number().int().nonnegative(),
    busy: z.number().int().nonnegative(),
    picked: z.number().int().nonnegative(),
  }),
});
export type WeekRunwayResponse = z.infer<typeof WeekRunwayResponse>;
