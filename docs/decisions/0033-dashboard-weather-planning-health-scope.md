# ADR-0033 — Owner-promoted Dashboard, Weather, planning and Health v1

Status: accepted scope and boundaries (owner, 2026-09-30); unresolved contracts below remain explicit gates.

The owner's direct build request promotes these named designs despite older idea-stage labels. The live
Projects/Vault Companion Ideas Backlog remains the design source; the Ready Backlog's older queue is not silently
rewritten. Preserve active H/SP/RR reviews/repairs, then deliver small usable app slices with existing PR gates.

## App surfaces

- Dashboard is its own surface. Compose existing projections, not a duplicate scout/research product. Start with
  a curated market card, operational AI-usage/cost cards and the designed Health card. No job-application board,
  arbitrary plugin builder or public projection. Every available card has provenance, freshness, drill-through and
  bounded history/range controls; unknown data is unknown, never zero or synthetic data presented as real.
- Preserve the design's restrained panels, mint charts, range pills and touch inspection, adapted to light/dark
  mobile use. BTC/USD is a reversible first market adapter, not a decision to exclude other designed assets.
- Weather starts with an actionable morning projection from identified high-resolution Danish forecast data and
  model agreement. Model comparison serves run/travel decisions, not an extra curiosity dashboard. Nowcast follows
  with radar/coverage/freshness evidence; do not relabel hourly/15-minute forecasts as minute-level radar predictions.
  Coordinates rounded to approximately1km before provider calls, never written to Git. No background geolocation.
- Needs You, Guided Morning Review and Weekly Review remain three distinct features. Derive facts from current
  source-backed services; existing commands own mutations. Do not create a parallel task list or merge into Today.

## Health boundaries fixed by owner

- Apple Health source; Shortcut extraction/transport; Worker validation, deterministic daily aggregation and
  idempotent CAS write. Existing Health/Data/Apple Health Daily.csv remains the only daily objective record.
  Subjective journal data is separate. No new health database, raw-sample persistence or health data sent to AI.
- Approved fields: steps, first_move, last_move, late_steps, early_steps, headphone_min, headphone_db, loud_min,
  distance_km, flights, active_kcal, walking_speed_kmh. Preserve legacy CSV header/other bytes including existing
  in_bed_h column, but collect/display no in_bed_h values and do not populate or overwrite that legacy field.
- Preserve the designed03:00 behavioural-day semantics and weighted-energy headphone maths, >=80dB loud time,
  missing-not-zero policy. Validate exact source algorithm before claiming equivalence. Home-timezone policy is
  Copenhagen per existing contract; any travel-policy change requires explicit resolution.
- Latest three days are refreshable; older rows frozen except deliberate full-export repair, never routine intake.
  Precisely define window anchor/complete-day selection in the intake ADR and executable midnight/DST tests.
- Card DesignA: yesterday's exact values plus usual range; amber means only outside that range. Tap opens30-day
  trends. Personal baseline rolling90days excluding owner-marked unusual periods and low-phone-coverage days;
  low-coverage displayed as little phone data, not low activity. No scores, diagnoses, warnings or signal cards.
- Intake credential separately scoped/revocable, no read/ordinary-command/AI authority, never exposed to PWA.
  Compare authentication options in security ADR; deployment/secrets/Access changes/realdata require owner approval.

## Unresolved evidence, not permission to invent

Phase0 must verify usable Shortcuts sample extraction on a realdevice; totals fallback only if samples cannot work.
Apple's documented HTTP actions are not proof of permetric sample fields or unlocked/background reliability.
Chosen card/layout and90day policy located in canonical design; exact statistical range method, low-coverage rule
and exclusion-config representation not found in inspected project notes. Owner reports yesterday's decision/mockup
may exist elsewhere: locate design-only evidence without reading/transmitting rawHealth data. Proposed P10–P90 and
explicit coverage marks are NOT accepted decisions. Do not build a new arbitrary rule from that proposal.
Owner granted task-relevant full Lead read access; live source-only Tools/apple_health_daily.py inspected, no
CSV/export/sample read. Reference algorithm: movement threshold20steps, first/last movement and late steps use
03:00 behavioural-day attribution; totals/speed/headphones use sample-start local calendar date. Preserve this
distinction, not a blanket03:00 shift for all metrics. Distance miles→km; speed arithmetic mean; headphone duration
and energy weighted, >=80dB loud minutes. Device offset preservation/travel and incomplete-source missing-values
still need an explicit ingestion contract; source implementation is evidence, not authority to collect sleep.

## Verification and owner handoff

Synthetic endpoint→Worker→localGitCSV→readDTO→Dashboard tests; golden splices, unrelated frozen rows, duplicates,
latecorrections, idempotent retry after lostresponse, concurrentCAS, strictschema/size/auth/privacy tests.
Daily/trend/baseline cases cover exclusions/missingcoverage/emptybaseline/DST. Fullcheck/currentCI/singlebrowser
job and independent high-risk review plus actualCodeRabbit dispositions before merge. No deployment in this request.
Deliver app changes together with receiver-exact Shortcut mappings, manual-first setup, scoped credential owner
steps, success/failure verification, optional automation and permission/retry/unlock troubleshooting. Cite current
primary documentation and label all device/UI steps not verified. A synthetic demo is not iPhone acceptance.
