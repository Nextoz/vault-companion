// Weather read model (ADR-0033 W1). Public forecast data only: fixed Open-Meteo endpoints/models/fields, rounded
// locations, honest gaps and provider attribution. No secrets, no writes, no identity data, no private locations.
import { z } from 'zod';

// Disallow runtime code generation (eval/Function probe) under strict CSP (script-src 'self') and Cloudflare Workers.
z.config({ jitless: true });

const isoInstant = z.iso.datetime({ offset: true });

/** The only timezone weather is interpreted in. The provider is asked in GMT (offset 0); UI daytime bounds use this. */
export const WEATHER_TIME_ZONE = 'Europe/Copenhagen';

/** Verified provider plan: 48 hourly points. */
export const WEATHER_FORECAST_HOURS = 48;

/** ~0.01 degrees is roughly 1 km in Copenhagen. Applied before any provider call, cache key or log. */
export const WEATHER_COORDINATE_STEP = 0.01;

export const WEATHER_MODELS = ['dmi_harmonie_arome_europe', 'ecmwf_ifs'] as const;
export const WeatherModel = z.enum(WEATHER_MODELS);
export type WeatherModel = z.infer<typeof WeatherModel>;

export const WeatherVariable = z.enum(['temperature', 'rain', 'wind']);
export type WeatherVariable = z.infer<typeof WeatherVariable>;

/** One provider's public forecast series. Fixed selector/URL facts live here, never accepted from a client. */
export const WEATHER_MODEL_PLAN: Record<
  WeatherModel,
  { readonly label: string; readonly resolutionKm: number; readonly sourceUrl: string; readonly baseUrl: string; readonly selector: string }
> = {
  dmi_harmonie_arome_europe: {
    label: 'DMI HARMONIE AROME Europe',
    resolutionKm: 2,
    sourceUrl: 'https://open-meteo.com/en/docs/dmi-api',
    baseUrl: 'https://api.open-meteo.com/v1/forecast',
    selector: 'dmi_harmonie_arome_europe',
  },
  ecmwf_ifs: {
    label: 'ECMWF IFS 9 km',
    resolutionKm: 9,
    sourceUrl: 'https://open-meteo.com/en/docs/ecmwf-api',
    baseUrl: 'https://api.open-meteo.com/v1/ecmwf',
    selector: 'ecmwf_ifs',
  },
};

export const WEATHER_TERMS_URL = 'https://open-meteo.com/en/terms';
export const WEATHER_ATTRIBUTION = 'Forecast data by DMI and ECMWF via Open-Meteo, CC-BY 4.0.';

/** The public coarse Copenhagen city-centre fallback. Never inferred from or described as the owner's home. */
export const WEATHER_FALLBACK_LOCATION: WeatherLocation = {
  label: 'Copenhagen city centre (coarse fallback)',
  latitude: 55.68,
  longitude: 12.57,
  precision: 'city-fallback',
  timeZone: WEATHER_TIME_ZONE,
};

/** Round one coordinate to the fixed ~1 km grid. Same rule on device, server and cache key. */
export function roundWeatherCoordinate(value: number): number {
  return Number((Math.round(value / WEATHER_COORDINATE_STEP) * WEATHER_COORDINATE_STEP).toFixed(2));
}

export const WeatherLocation = z.strictObject({
  /** Human-facing label only. Never a saved or reverse-geocoded private address. */
  label: z.string().min(1).max(120),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  precision: z.enum(['city-fallback', 'device-rounded']),
  timeZone: z.literal(WEATHER_TIME_ZONE),
});
export type WeatherLocation = z.infer<typeof WeatherLocation>;

/** Device coordinates before rounding. The Worker rounds them before any provider call/cache key. */
export const WeatherLocationRequest = z.strictObject({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});
export type WeatherLocationRequest = z.infer<typeof WeatherLocationRequest>;

/** One hourly point. Provider nulls stay null: charts must draw them as gaps, never interpolate them. */
export const WeatherPoint = z.strictObject({
  time: isoInstant,
  temperatureC: z.number().finite().nullable(),
  rainMm: z.number().finite().min(0).nullable(),
  windMs: z.number().finite().min(0).nullable(),
});
export type WeatherPoint = z.infer<typeof WeatherPoint>;

export const WeatherModelSeries = z.strictObject({
  model: WeatherModel,
  label: z.string().min(1).max(80),
  resolutionKm: z.number().int().positive(),
  sourceUrl: z.string().min(1).max(200),
  /** When this series was successfully retrieved. Never rewritten when a later refresh fails and stale data is reused. */
  retrievedAt: isoInstant,
  expectedPoints: z.number().int().positive(),
  points: z.array(WeatherPoint).max(WEATHER_FORECAST_HOURS),
  /** Hourly buckets inside the 48-hour range the provider did not return (and therefore we do not draw). */
  missingIntervals: z.number().int().nonnegative(),
});
export type WeatherModelSeries = z.infer<typeof WeatherModelSeries>;

/** Agreement is a fact about model coverage, never a calibrated confidence. */
export const WeatherAgreement = z.enum(['two-models', 'single-model', 'unavailable']);
export type WeatherAgreement = z.infer<typeof WeatherAgreement>;
export const WeatherPartialError = z.enum(['none', 'one-model-unavailable']);
export type WeatherPartialError = z.infer<typeof WeatherPartialError>;
export const WeatherFailureReason = z.enum(['timeout', 'malformed', 'provider-error', 'no-data']);
export type WeatherFailureReason = z.infer<typeof WeatherFailureReason>;

export const WeatherMinMax = z.strictObject({ min: z.number().finite(), max: z.number().finite() });
export type WeatherMinMax = z.infer<typeof WeatherMinMax>;

/**
 * The lowest-rain contiguous two-hour window inside Copenhagen daytime 08:00-20:00. It reports actual model values and
 * spread, and says explicitly that it is not a guarantee of dry or daylight weather.
 */
export const WeatherRunWindow = z.strictObject({
  day: z.iso.date(),
  daytimeStart: z.literal('08:00'),
  daytimeEnd: z.literal('20:00'),
  start: isoInstant,
  end: isoInstant,
  agreement: WeatherAgreement,
  /** Models whose overlapping points cover this window (two = agreement, one = single-model). */
  models: z.array(WeatherModel).min(1).max(2),
  /** Lowest model total rain for the selected two-hour window. */
  rainMm: z.number().finite().min(0).nullable(),
  rainRangeMm: WeatherMinMax,
  temperatureRangeC: WeatherMinMax,
  windRangeMs: WeatherMinMax,
  note: z.string().min(1).max(300),
});
export type WeatherRunWindow = z.infer<typeof WeatherRunWindow>;

export const WeatherCoverage = z.strictObject({
  expectedPoints: z.number().int().positive(),
  primaryReturned: z.number().int().nonnegative(),
  comparisonReturned: z.number().int().nonnegative(),
  primaryMissingIntervals: z.number().int().nonnegative(),
  comparisonMissingIntervals: z.number().int().nonnegative(),
});
export type WeatherCoverage = z.infer<typeof WeatherCoverage>;

/** The shared projection rendered by Dashboard and Today. */
export const WeatherProjection = z.strictObject({
  location: WeatherLocation,
  now: isoInstant,
  models: z.array(WeatherModelSeries).min(1).max(2),
  agreement: WeatherAgreement,
  coverage: WeatherCoverage,
  runWindow: WeatherRunWindow.nullable(),
  partialError: WeatherPartialError,
  attribution: z.string().min(1).max(200),
  termsUrl: z.string().min(1).max(200),
});
export type WeatherProjection = z.infer<typeof WeatherProjection>;

/** `/api/weather` and `/api/weather/location` answer this same read model. */
export const WeatherResponse = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('ok'), projection: WeatherProjection }),
  z.strictObject({
    status: z.literal('unavailable'),
    now: isoInstant,
    location: WeatherLocation,
    reason: WeatherFailureReason,
    message: z.string().min(1).max(300),
  }),
]);
export type WeatherResponse = z.infer<typeof WeatherResponse>;
