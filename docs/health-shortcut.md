# Health Shortcut — exact steps (HC3, ADR-0043)

The iPhone Shortcut that sends Health samples to `POST /api/health/ingest`. The contract is fixed: the Worker adapts
to the Shortcut. No health value is ever stored in this repository.

## Version 2 (ADR-0070)

Send to the same endpoint with the same service token. The JSON body has exactly `schemaVersion: 2`, `from`,
`sentAt` (ISO dates with explicit offsets), and `samples` (one newline-separated string). Each sample line has
six pipe-separated fields: `TypeName|StartISO|EndISO|Value|Unit|SourceName`. Use type names and units from
`packages/domain/src/phone-metrics.ts`; values use a decimal point. Sleep uses `In Bed` and an empty unit.
Filter out PulseLoop sources in Find Health Samples; the server also refuses any such line (422).

The server converts samples once, writes 15-minute phone slots by Copenhagen month (oldest first, replacing only
sent non-null cells), then updates Apple Health Daily using the existing v1 aggregation. Activity Daily is a
separate slice. Success is `{ok:true,days:[…],slots:n,months:[…]}`. Failure is `{ok:false,error:…}` with status
400/422 for input, 409 for stored structure, or 503 for an unavailable/conflicting write. Re-send the same body
after a partial failure: unchanged files make no commit and the missing write is repaired. Values and source names
are never included in v2 errors or logs. Version 1 continues to use the steps below unchanged.

## Once (version 1)

1. Cloudflare → Access → Service tokens: `vault-companion-health-shortcut` exists (done). Keep its Client ID and
   Client Secret in the password manager.
2. Worker secret (the ingest Access app's AUD; the endpoint answers 404 until it is set):
   `cd apps/worker; npx wrangler secret put HEALTH_INGEST_AUD`

## Shortcut "Vault Health Sync"

1. **Date** → *Current Date*; **Set Variable** `SentAt`.
2. **Adjust Date**: subtract 3 days from `SentAt`; **Set Variable** `From`.
3. For each type below, in this order, build one text block:
   - **Find Health Samples** where *Type* is `<type>` and *Start Date* is in the last 3 days; sort by *Start Date*,
     oldest first; no limit.
   - **Repeat with Each** sample: **Text** `Start Date|End Date|Value|Unit` (the sample's details; both dates in
     *ISO 8601* format with *Include ISO 8601 Time* on).
   - After the repeat: **Combine Text** (*Repeat Results*, separator *New Lines*); **Set Variable** `<field>`.

   | Health type | Variable / JSON field | Unit (as already chosen) |
   |---|---|---|
   | Steps | `steps` | count |
   | Walking + Running Distance | `distance` | km |
   | Flights Climbed | `flights` | count |
   | Active Energy | `activeEnergy` | kcal |
   | Walking Speed | `walkingSpeed` | km/hr |
   | Headphone Audio Levels | `headphone` | dBASPL |
   | Sleep | `sleep` | (value is the category text) |

4. **Get Contents of URL** `https://app.karpov.dk/api/health/ingest`
   - Method **POST**; headers `CF-Access-Client-Id` and `CF-Access-Client-Secret` (the service token's values).
   - Request Body **JSON**: `schemaVersion` (Number) `1`; `from` (Text) = `From` in ISO 8601 with time; `sentAt`
     (Text) = `SentAt` in ISO 8601 with time; then the seven text fields above.
5. **Get Dictionary Value** `ok` from the result. **If** it is not `true`: **Show Notification** with the result's
   `error` value. Otherwise nothing (or a quiet notification with `days`, while testing).

## Automations (Personal → Run Immediately)

- **Time of Day** 22:30 daily → run "Vault Health Sync".
- **Charging** "is connected" → run "Vault Health Sync" (catches the morning while the phone is unlocked).

Health data is unreadable while the phone is locked. The Worker then sees an empty `steps` field and answers
`Health was locked: no step samples` without writing anything; the next run catches up. Each run rewrites the two
full days before today plus today so far; sending the same data again changes nothing.

## First run (owner, once)

Run the Shortcut by hand with the phone unlocked. Expect `{"ok":true,"days":[…]}`. If it answers an error naming a
field and a line (for example an unexpected unit), tell the Lead the field name and line number only, never the values.

## Ring Sync

1. **Get ring data** (PulseLoop app action). Set **Days** to **2** for the automation (it runs every time PulseLoop
   closes, so two days always overlap the last send and keep each request small for the Workers Free CPU budget).
   To catch up after more than a day without syncing, run it once by hand with **7**; never more than 7: the Worker
   accepts only slots from the last 8 days and refuses the whole send otherwise.
2. **Get Contents of URL** `https://app.karpov.dk/api/health/ring/ingest`, Method **POST**, three headers
   `CF-Access-Client-Id`, `CF-Access-Client-Secret` (the same service token) and `Content-Type: application/json`;
   Request Body **File** = the output of *Get ring data*. Send the JSON text as it is; do not rebuild it as a
   Shortcuts dictionary (that retypes nulls and numbers).
3. **Get Dictionary Value** `error` → **If** it *has any value* → **Show Notification** with it.

Automation: **App → PulseLoop → Is Closed → Run Ring Sync** (Run Immediately). The earlier "Find Health Samples"
blocks for ring types are **not** needed.

Every Worker failure has `ok: false` and an `error` string; success has no `error` key. Cloudflare Access refusals and network failures never reach the Worker and may stay silent. Judge delivery by the slot file commit time.
