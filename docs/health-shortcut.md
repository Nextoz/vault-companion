# Health Shortcut — exact steps (HC3, ADR-0043)

The iPhone Shortcut that sends Health samples to `POST /api/health/ingest`. The contract is fixed: the Worker adapts
to the Shortcut. No health value is ever stored in this repository.

## Once

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
