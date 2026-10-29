# InfoFlow durable ingestion

`cloudfunctions/intelCrawler` now includes a CloudBase-backed store for three collections:

- `intel_items`: normalized, deduplicated release records keyed by the stable SHA-256 `_id`.
- `intel_sources`: per-source completion checkpoints. A checkpoint advances only after every valid item in the first page has been saved.
- `intel_runs`: a five-minute lease document and one sanitized run document per invocation.

The crawler intentionally fetches only the first GitHub releases page (`per_page=30`) from each of its two allowlisted repositories. It does not paginate historical releases. Each source is independent, so a failure leaves the prior checkpoint untouched while a later invocation can retry. Existing item records are upserted; ingestion never deletes records.

Every item, checkpoint, and run metadata write uses a CloudBase transaction that reads the lease and checks both its token and expiry in the same transaction. An expired lease can be taken over. An old invocation then fails its next guarded write, and it cannot release or overwrite the new owner's lease. Lease conflicts do not fetch. Request, database, and run errors returned to callers are reduced to allowlisted codes; request headers, response bodies, and raw platform exceptions are not persisted as run metadata.

## Timer and deployment gates

`config.json` declares `intelCrawlerSixHours` (`0 0 */6 * * * *`). Deployment remains inert unless `INFOFLOW_INGESTION_ENABLED=true` is set in the function environment. Even when enabled, the entry point rejects user identities and requires both the CloudBase runtime's `TRIGGER_SRC=timer` environment marker and a valid timer event containing the exact trigger name and a parseable `Time`. Caller-supplied event fields alone are insufficient. The runtime marker must be verified in a controlled deployment before enabling the flag; if the platform runtime does not supply that marker, the function remains fail-closed until the platform's trusted invocation marker is confirmed and implemented.

Before deployment, explicitly create all three collections with deny rules; the function does not auto-create collections. Apply `database.rules.json` (deny client reads and writes) to each collection. Confirm server SDK access under the deployed function identity, then run a controlled timer invocation with the feature flag still disabled to confirm the actual runtime envelope and `TRIGGER_SRC` behavior. Only after reviewing that evidence should an operator enable the flag. See the live deployment record below for actual cloud changes.

The package and lockfile reuse the repository's existing `wx-server-sdk` 4.0.2 CloudBase runtime dependency and local lodash vendor packages; no network install or new external dependency is required.

## Live deployment record — 2026-10-29

Primary reviewer reran all 19 security scripts: exit 0 (persistence-test-log.txt). Downloaded pre-change live api for rollback to local work/cloud-backup/api (not committed). Compared entry point: only InfoFlow import and route registration changed.

Created intel_items, intel_sources, intel_runs in cloud1-d5g4idwry1a351b71 via console, selecting all-users-cannot-read/write at creation. Full CLI deploy hit Creating/Updating conflicts; subsequent incremental uploads of api/intel, api/index.js and intelCrawler succeeded. New crawler uses existing live API dependency tree for upload. Its timeout was set to 60 seconds and INFOFLOW_INGESTION_ENABLED=false in console. API still requires INTEL_ENABLED=true and a private INFOFLOW_CURSOR_SECRET; no signing key is committed.

Verified both api and intelCrawler Active with 60-second timeout. Remaining: configure API signing secret, verify actual trusted timer marker and six-hour trigger creation, enable ingestion, confirm records and real authenticated client display. A timer config file is not proof a scheduled trigger is active. No successful real database ingestion or live frontend display is claimed yet.

## Safe-log follow-up

Added separate fixed trusted-timer status and rejected-request audit documents. Rejected audit writes are transaction-limited to once per 60 seconds, store only booleans/phase/timestamp, never authorize ingestion, and never return diagnostics to callers. No new diagnostic action is exposed. Actual console test initially logged REJECTION_AUDIT_WRITE_FAILED; setting the database SDK option throwOnNotFound:false fixed first-document creation. Confirmed __timer_rejections__ exists in the real collection, while manual requests still return INVALID_TRIGGER. Targeted ingestion/persistence/entry tests pass with injected database substitutes and no external calls. Latest real timer result still awaits console readback; do not claim successful ingestion or frontend display yet. The temporary schedule restore was uploaded using fresh full accessibility indices.

## Platform invocation compatibility

Actual timer audit showed event type/name/time valid, no user identity and no gateway, but runtimeTimer=false. This environment does not supply the TRIGGER_SRC marker. Applied and read back the exact function rule intelCrawler.invoke=false, preserving all other function rules. CloudBase documents that client invoke rules do not apply to authenticated management API calls or timer triggers: https://docs.cloudbase.net/cloud-function/security-rules . Only after that rule was saved, enabled server-side INFOFLOW_PLATFORM_ONLY=true. The code still rejects client identities and gateway/non-SCF sources and requires the exact registered timer envelope. Event fields cannot set this server configuration. The platform deny rule is a required deployment control; removing it requires disabling platform-only mode first. It is represented by function.rules.json for review, not auto-applied by code.

## Final verified state (supersedes earlier pending gates)

See DELIVERY.md and validation.json. Both sources now succeed on bounded 10-record requests; stored totals remain 30 AI + 25 semiconductor. Native runtime lacks TRIGGER_SRC but uses SOURCE=wx_trigger; the deployment uses the separately applied client-deny rule plus explicit server mode and identity/gateway/name guards. The new unique trigger is intelCrawlerEvery6Hours, enabled/available/bound at cron 0 0 */6 * * * *. Old-name deliveries return RETIRED_TRIGGER before SDK initialization. Actual UI list/detail/pagination 20→40→55 passed. Earlier large responses caused reset/body-timeout failures; smaller requests, strict deadline and bounded transient retries were validated successfully. Natural future six-hour execution remains to be observed, not assumed tested.
