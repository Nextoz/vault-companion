# HEALTH0 — capability evidence before final intake mappings

Owner approved scope ADR0033, synthetic-only development. Lead has inspected aggregation source code; no real
HealthCSV/export/sample read or transfer to AI. This brief is queued after current repair/Dashboard work, not launched.
Pro/high for receiver/auth/write design; Flash for documentation/UI pieces once contract is fixed. No realcredentials,
Access/secrets changes, endpoints/production calls, realHealthwrites or deployment. A mock test is not Phase0deviceproof.

## Already fixed, do not redesign

Canonical CSV header preserved: date,weekday,steps,distance_km,flights,active_kcal,walking_speed_kmh,first_move,
last_move,late_steps,early_steps,headphone_min,headphone_db,loud_min,in_bed_h. No collecting/displaying sleep/in_bed_h;
existing historical values/column untouched. Subjective journal records stay separate. Daily recent3day corrections,
frozen older rows, operationID/hash/baseRevision/headCAS/trailers/exactgolden splices and dedupebeforewrite.
CardA exactyesterday values plus normalrange text, amber onlyoutsideusualrange; tap30daytrends. Baselineprior90days,
ownerunusualperiods/lowphonecoverage excluded. Statisticalrange/coverage/exclusionconfiguration needs locateddecision.

## Code-only reference findings to reproduce with synthetic fixtures

Step/movement threshold20; first_move/last_move determined only qualifying steps, behavioural day03:00–03:00.
late_steps00:00–02:59 attributed priorbehaviouralday, early_steps03:00–05:59 samecalendar day.
Totals steps/distance/flights/activeenergy, walking-speed samples and headphones use sample-start calendar date,
not blanketbehaviouralday. Distance mi×1.609344; walking speed mi/hr×1.609344; speed arithmeticmean.
Headphone minutes=end-start, nonnegative; weightedenergy mean dB=10log10(sum(minutes×10^(dB/10))/summinutes);
loudminutes>=80dB. Preserve formatter/rounding parity: Python round tie-to-even differs from Math.round.
Reference export keeps each sample's offset, new normalapp policy Copenhagen; do not silently reinterpret travel
offsets or split span durations if claiming referenceparity. Unsupported source/unit/interval/metric refusal.
Empty query/deniedpermissions/missingmetrics distinct from validmeasuredzero; any intentional reference semantic
change documented, never silentlyfilled zeros. No rawsamples retained beyond request handling or in receipts/logs.

## Real iPhone capability worksheet (owner-run; device unavailable to Lead)

1. Local unlocked manual Shortcut, approved metrics only; verify Health read permission for each metric.
2. Confirm Find Health Samples and detail action names in this iOSversion. Apple HTTP documentation does not verify
   Health action fields; exact menu/property names remain device-unverified until checked.
3. For synthetic/local-only probing, record only accessible field NAMES/units, supporteddate/offset representation,
   abilitytoiterateper-sample start/end/value/source/identifier, denied-vs-empty distinction and querywindow handling.
   Do not send actualsample values/dates/exports/screenshots ofprivatevalues to Lead/AI/repository.
4. Check headphone exposure interval/dB extraction, movement sample values/start/end, distance/energy/speed units
   independently. Test background/locked separately after unlocked manual works; no promiseunattended reliability.
5. Samplepayload preferred ifusable; only documentedfailedcapability permits daily-totalsfallback. Don't guess
   HealthKit fields or claim a invented Dictionaryschema is native Shortcuts output. Totals must retain approved
   movement/headphone aggregation semantics or clearly mark unavailable, not claimequivalence.

## Contract/security tasks before receiver implementation

Compare route-scoped CloudflareAccess service-token/JWT audience versus separately scoped signed intake secret,
revocation/rotation/Shortcuts storage, edgeAccess interaction and nointeractivePWA bypass. ExplicitADR selects
implementation, owner alone creates/configures creds. Defaultdisabled ifunconfigured; PWAnevergetintakesecret.
Workerrouteaccepts onlyapproved schema/destination/three recent days; rawbody capped/streambounded/nologging;
intakecredential cannotreadHealth/tasks/notes or ordinarycommands/invokeAI. Syntheticnegativetests prove eachboundary.
Define complete-snapshot/corrections ordering preventing stale retry from revertingnewerday; howclientgetsbaseRevision
withoutgrantingvaultread; durable audit metadata nohealthvalues; idempotency/cached receipt afterunknownoutcome.
Latest3days window anchoring must beexplicit relative toserverhomeclock and partialdaypolicy, midnight/DST tests.
Full-exportrepair is a separate deliberateoperator path, not a magicclientflag on normal intake.

## Deliverable and oracle

HEALTH1 onward: synthetic request→realWorker→localGit→exactCSV→authenticatedreadDTO→DashboardCardA/30daytrend;
wrongsecret/route/body/units/frozenrow/corruptCSV/missingcoverage/oldresponse/duplicate/stalepayload/CAS/lostresponse
must fail honestly. Leadfullcheck/browser/CI/independentreview/actualCodeRabbit beforeacceptance.
Final practical Shortcut guide MUST match receiver's implementedfield names, not this conceptual worksheet. Include
prerequisites/readpermissions, orderedactions/mappings, ownercredentialsetup, manualsync/readback+receipt statuses,
retry sameoperation/body, denied/missing/unlock/offline troubleshooting; optional dailyautomation onlyaftermanual
reliability, manualfallback retained. No realendpoint configured/called in this task.

## Current primary-source verification (2026-09-30)

- Apple Get Contents of URL supports POST/requestbody; transport is documented, sampleextraction remains unverified:
  https://support.apple.com/guide/shortcuts/request-your-first-api-apd58d46713f/ios
- Personalautomation userguide: verify exacttrigger/action UI on owneriOS before writing exacttapinstructions:
  https://support.apple.com/en-gb/guide/shortcuts/apd690170742/9.0/ios/26
- Cloudflare servicetoken separateServiceAuth/application configuration requires owner setup, not appautochange:
  https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/

This worksheet is not the completed Shortcut setupguide or proof of implemented intake. Record remaining evidence
in plan; proceed on independent Dashboard/Weather/planning slices while device/contract evidence is pending.
