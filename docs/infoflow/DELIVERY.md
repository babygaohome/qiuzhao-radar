# InfoFlow integration — verified 2026-10-29

The mini-program now reads real `intel_items` through its authenticated API, with signed pagination, source/type/date display, detail and original-link copy. The two initial sources are official GitHub Releases metadata from Transformers and Chisel. They are software/developer releases, not a complete industry-news feed. No LLM summaries or daily digest are fabricated.

## Actual verification

- Live ingestion previously created 30 AI and 25 semiconductor records. A final bounded 10-record-per-source pull succeeded for both sources; independent database counts remain 30 + 25, proving stable-key upserts preserve history without duplicating records.
- Actual WeChat Developer Tools list shows Transformers and Chisel releases. Chisel detail displayed the real source/date and link-copy control. Actual scroll pagination loaded 20, then 40, then all 55 records and displayed the end state.
- All 21 security test scripts passed. Entry tests additionally cover platform-only mode, forged events, gateway/client rejection, bounded audit logging and retired-trigger rejection.
- `intelCrawlerEvery6Hours` is the sole listed trigger, `0 0 */6 * * * *`, Enable=1, Available, BindStatus=on. The old `intelCrawlerSixHours` identifier is retired in code before SDK/database initialization, so stale old deliveries cannot fetch or write.

Evidence: [validation.json](validation.json), [test log](persistence-test-log.txt), [real list](infoflow-live-list.png), [detail](infoflow-live-detail.png), [pagination end](infoflow-live-pagination.png).

## Security and operations

All three collections deny direct client access. `intelCrawler.invoke=false` is applied at platform level. `INFOFLOW_PLATFORM_ONLY=true` is enabled only with that platform restriction; the code permits observed provider `SOURCE=wx_trigger` and server sources, rejects identities/gateway requests, and requires the exact registered timer envelope. `INTEL_ENABLED=true` and a private server-only cursor key enable API reads. No secrets are stored in Git.

First-document reads use `throwOnNotFound:false`. Transaction leases fence stale writers and checkpoints advance only after writes. Requests use TLS validation, an exact source URL allowlist, IPv4, a full 8-second deadline, bounded bodies and at most one additional transient retry per source in cloud execution. Each scheduled pull requests at most 10 latest API records per source; it is not a complete historical archive. Errors retain prior records, expose only fixed stages/codes in protected logs and never delete the feed. GitHub/network outages can still produce partial runs; this is recorded, not represented as success.

## Scope and rollback

Cloud functions and collections were deployed. The frontend is running in the independent `outputs/qiuzhao-infoflow-preview` development project; the original checkout was not overwritten, no PR was merged, and no mini-program release/experience build was published. Deep/dark/device matrix, real dual-account end-to-end and the next naturally scheduled six-hour run are not claimed tested. M3 preferences/feedback and M4 digests remain future phases.

Rollback: disable the ingestion feature switch with operator approval, remove the new timer, disable API reads and restore the backed-up API entry. Keep the client-deny rules. Existing recruitment data needs no migration and is unaffected.
