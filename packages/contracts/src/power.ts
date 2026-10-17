// Power monitor M4 (dashboard monitors): DK2 day-ahead spot price and CO2 intensity from Energi Data Service.
// Spot price only (no tariffs, fees or VAT); hours are Copenhagen local hours built from UTC quarter-hour rows.
import { z } from 'zod';

const isoInstant = z.iso.datetime({ offset: true });

export const POWER_SOURCE = 'Energi Data Service';
export const POWER_SOURCE_URL = 'https://www.energidataservice.dk/';
/** Length of the cheapest-window search, in whole hours. */
export const POWER_WINDOW_HOURS = 3;

export const PowerUnavailableReason = z.enum(['timeout', 'provider-error', 'malformed', 'empty']);
export type PowerUnavailableReason = z.infer<typeof PowerUnavailableReason>;

export const POWER_REASON_NOTES: Record<PowerUnavailableReason, string> = {
  timeout: 'Energi Data Service did not answer in time.',
  'provider-error': 'Energi Data Service is unavailable right now.',
  malformed: 'Energi Data Service sent price data we could not read.',
  empty: 'No DK2 spot prices are published for today.',
};

/** One Copenhagen local hour: the mean of its published quarter-hour prices. */
export const PowerHour = z.strictObject({
  start: isoInstant,
  /** Local two-digit hour; on the autumn DST day `02` appears twice. */
  label: z.string().regex(/^\d{2}$/),
  krPerKwh: z.number(),
  /** How many quarter-hour prices the mean is built from (fewer than 4 = the provider left gaps). */
  quarters: z.number().int().min(1).max(4),
});
export type PowerHour = z.infer<typeof PowerHour>;

export const PowerWindow = z.strictObject({
  /** Local date of the window's first hour. */
  day: z.iso.date(),
  start: isoInstant,
  end: isoInstant,
  /** `HH-HH` in local hours; an end at local midnight is written `24`. */
  label: z.string().regex(/^\d{2}-\d{2}$/),
  averageKrPerKwh: z.number(),
});
export type PowerWindow = z.infer<typeof PowerWindow>;

export const PowerDay = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('ok'),
    day: z.iso.date(),
    hours: z.array(PowerHour).min(1).max(25),
    averageKrPerKwh: z.number(),
    minKrPerKwh: z.number(),
    maxKrPerKwh: z.number(),
    cheapestWindow: PowerWindow.nullable(),
  }),
  /** The provider answered without rows for this day (tomorrow before ~13:00): never drawn as an empty chart. */
  z.strictObject({ status: z.literal('not-published'), day: z.iso.date() }),
]);
export type PowerDay = z.infer<typeof PowerDay>;

export const PowerCo2 = z.strictObject({
  at: isoInstant,
  gPerKwh: z.number().min(0),
  kind: z.enum(['measured', 'forecast']),
});
export type PowerCo2 = z.infer<typeof PowerCo2>;

export const PowerResponse = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('ok'),
    now: isoInstant,
    /** When the price rows were fetched; an older value than expected means a failed refresh reused them. */
    fetchedAt: isoInstant,
    area: z.literal('DK2'),
    today: PowerDay,
    tomorrow: PowerDay,
    nowHour: PowerHour.nullable(),
    /** Cheapest window among hours not yet over, today and tomorrow (may cross midnight). */
    upcomingWindow: PowerWindow.nullable(),
    co2: PowerCo2.nullable(),
  }),
  z.strictObject({
    status: z.literal('unavailable'),
    now: isoInstant,
    reason: PowerUnavailableReason,
    note: z.string(),
  }),
]);
export type PowerResponse = z.infer<typeof PowerResponse>;
