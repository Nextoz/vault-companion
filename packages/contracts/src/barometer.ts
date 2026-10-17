// Barometer monitor (dashboard monitors): sea-level pressure at Trianglen, Copenhagen. Measured by DMI (two stations
// weighted by distance); when both are stale the Open-Meteo `dmi_seamless` model stands in, labelled "model".
import { z } from 'zod';

const isoInstant = z.iso.datetime({ offset: true });

export const BAROMETER_PLACE = 'Trianglen';
/** Trianglen, Copenhagen. */
export const BAROMETER_LATITUDE = 55.6996;
export const BAROMETER_LONGITUDE = 12.5772;
/** DMI open data stations used for the measurement: Kastrup and Jægersborg. */
export const BAROMETER_STATIONS = ['06180', '06181'] as const;
/** A station reading older than this is not "now"; with no fresh station the model is used instead. */
export const BAROMETER_MAX_AGE_MS = 60 * 60_000;
/** Pressure moved by more than this many hPa in three hours is rising/falling, otherwise steady. */
export const BAROMETER_STEADY_HPA = 1;
export const BAROMETER_MIN_HPA = 950;
export const BAROMETER_MAX_HPA = 1050;

export const BAROMETER_SOURCE_LABELS = { dmi: 'DMI measured', model: 'Model (Open-Meteo)' } as const;

export const BarometerZone = z.enum(['Stormy', 'Rain', 'Change', 'Fair', 'Very dry']);
export type BarometerZone = z.infer<typeof BarometerZone>;
/** Dial colour zones, lower bound inclusive: Stormy below 980, Rain 980-1000, Change 1000-1020, Fair 1020-1040, Very dry from 1040. */
export const BAROMETER_ZONES: readonly { readonly zone: BarometerZone; readonly from: number; readonly to: number }[] = [
  { zone: 'Stormy', from: BAROMETER_MIN_HPA, to: 980 },
  { zone: 'Rain', from: 980, to: 1000 },
  { zone: 'Change', from: 1000, to: 1020 },
  { zone: 'Fair', from: 1020, to: 1040 },
  { zone: 'Very dry', from: 1040, to: BAROMETER_MAX_HPA },
];

export function barometerZone(hPa: number): BarometerZone {
  if (hPa < 980) return 'Stormy';
  if (hPa < 1000) return 'Rain';
  if (hPa < 1020) return 'Change';
  if (hPa < 1040) return 'Fair';
  return 'Very dry';
}

export const BarometerTrend = z.enum(['rising', 'falling', 'steady']);
export type BarometerTrend = z.infer<typeof BarometerTrend>;

export const BarometerUnavailableReason = z.enum(['timeout', 'provider-error', 'malformed', 'empty']);
export type BarometerUnavailableReason = z.infer<typeof BarometerUnavailableReason>;

export const BAROMETER_REASON_NOTES: Record<BarometerUnavailableReason, string> = {
  timeout: 'DMI and the model fallback did not answer in time.',
  'provider-error': 'Pressure data is unavailable right now.',
  malformed: 'Pressure data arrived in a form we could not read.',
  empty: 'No recent pressure reading is available.',
};

export const BarometerResponse = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('ok'),
    now: isoInstant,
    /** When the provider rows were fetched; older than expected means a failed refresh reused them. */
    fetchedAt: isoInstant,
    /** `dmi` = measured by stations; `model` = Open-Meteo dmi_seamless, never presented as measured. */
    source: z.enum(['dmi', 'model']),
    place: z.literal(BAROMETER_PLACE),
    /** Sea-level pressure at Trianglen, one decimal. */
    hPa: z.number().min(800).max(1100),
    /** When the reading was observed (the oldest observation that went into it). */
    observedAt: isoInstant,
    /** The reading three hours before `observedAt` from the same source, one decimal; null when history lacks it. */
    hPaThreeHoursAgo: z.number().min(800).max(1100).nullable(),
    /** hPa minus hPaThreeHoursAgo, one decimal; null when there is no history. */
    changeHpa: z.number().nullable(),
    trend: BarometerTrend.nullable(),
    zone: BarometerZone,
  }),
  z.strictObject({
    status: z.literal('unavailable'),
    now: isoInstant,
    reason: BarometerUnavailableReason,
    note: z.string(),
  }),
]);
export type BarometerResponse = z.infer<typeof BarometerResponse>;
