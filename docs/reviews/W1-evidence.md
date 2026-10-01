# W1 weather evidence

## Scope

- New: `packages/contracts/src/weather.ts` + test, `packages/domain/src/weather.ts` + test, `apps/worker/src/weather-provider.ts` + test, `apps/worker/src/weather-routes.test.ts`, `apps/web/src/ui/WeatherLab.tsx` + test + CSS, `apps/web/e2e/weather.spec.ts`.
- Wiring: minimal exports in `packages/contracts/src/index.ts` / `packages/domain/src/index.ts`, Dashboard Weather card in `apps/worker/src/dashboard.ts` and `apps/web/src/ui/Dashboard.tsx`, Today `WeatherMorning` in `apps/web/src/ui/App.tsx`, routes in `apps/worker/src/app.ts`, composition in `apps/worker/src/index.ts`, `getWeather`/`postWeatherLocation` in `apps/web/src/api.ts`, e2e mock routes in `apps/web/e2e/mock-api.ts`.

## Validation run

- `pnpm exec tsc -b --pretty false`: pass.
- Touched Vitest, dot reporter: 7 files, 63 tests, all pass.
  - `packages/contracts/src/weather.test.ts`
  - `packages/domain/src/weather.test.ts`
  - `apps/worker/src/weather-provider.test.ts`
  - `apps/worker/src/weather-routes.test.ts`
  - `apps/worker/src/dashboard.test.ts`
  - `apps/web/src/ui/WeatherLab.test.ts`
  - `apps/web/src/ui/Dashboard.test.ts`
- Targeted `pnpm exec eslint` on changed TS/TSX files: pass.

## Verified provider facts used

- DMI: `https://api.open-meteo.com/v1/forecast` with `models=dmi_harmonie_arome_europe`.
- Comparison: `https://api.open-meteo.com/v1/ecmwf` with `models=ecmwf_ifs`.
- Shared query: `hourly=temperature_2m,rain,wind_speed_10m&forecast_hours=48&wind_speed_unit=ms&timeformat=unixtime&timezone=GMT`.
- Expected units `unixtime/°C/mm/m/s`, `utc_offset_seconds=0`, 48 hourly points.
- Docs/terms: `https://open-meteo.com/en/docs/dmi-api`, `https://open-meteo.com/en/docs/ecmwf-api`, `https://open-meteo.com/en/terms`.

## Delivered behavior

- Dashboard Weather card and Today compact morning projection share `WeatherProjection`; no separate provider read model.
- Model traces with comparison toggle, temp/rain/wind controls, touch + keyboard inspection, 390 px light/dark CSS, charts split gaps.
- Honest unavailable/partial/stale/coverage states; single-model disclaimers; no calibrated confidence; no invented model issue timestamps.
- Location fallback is labeled public coarse Copenhagen; denied geolocation keeps fallback and never posts coordinates; user coordinates not persisted/logged.

## Limitations / not done

- Browser/e2e not run here; full `pnpm check` not run; Lead owns acceptance and independent review.
- No live provider call performed by this worker; all tests use synthetic provider fixtures.
- No W2 radar/nowcast, no deployment, no dependency or billing changes.
