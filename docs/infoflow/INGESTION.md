# InfoFlow ingestion draft

## Status

This branch contains a staging ingestion core and a local preview tool. It is **not a deployed CloudBase service**: `cloudfunctions/intelCrawler/index.js` fails closed, there is no CloudBase SDK wiring, durable database adapter, function configuration, trigger, or deployment change. The local `MemoryStore` is test/preview-only. No cloud data is read or written.

## Sources and boundaries

The controlled catalog contains exactly two GitHub public release feeds:

| Source | Category | Meaning |
| --- | --- | --- |
| `huggingface/transformers` | AI | Open-source project release metadata |
| `chipsalliance/chisel` | Semiconductor | Semiconductor design developer-tool release metadata; this is not industry news |

Requests are constructed from this catalog, limited to one API page per source and at most two sources per run. URLs must exactly match HTTPS `api.github.com/repos/{catalog owner}/{catalog repo}/releases?per_page=30`. Redirects are rejected. User-supplied URLs are not accepted. Request timeout is 8 seconds and response limit is 1 MiB. Source errors are isolated. Transient timeout/5xx errors receive at most two bounded retries; calls across sources are separated by one second. GitHub 403/429 responses are deferred: `Retry-After` is honored, exhausted primary limits defer until reset, and missing hints defer at least 60 seconds. The preview does not sleep through extended deferrals; it records the deferred result.

GitHub release `id` plus repository forms the stable key. Only title, source URL, category, release metadata and fetch time are kept. Release descriptions/body are never copied, and no summary is invented (`summaryStatus: unavailable`). Missing publication time is `unconfirmed`. `originalUrl` is preserved for source attribution.

## Runner contract

`runIngestion` accepts injected `fetchJson`, `store`, `clock`, and `sleep`. The store must provide token-based `acquireLease` / `releaseLease`, idempotent `upsert`, and checkpoint read/write methods. A source checkpoint advances only after all valid items on its single page are written. A failed source does not clear prior items or prevent another source from running. Production lease atomicity, persistence, TTL/recovery and database indexes remain to be designed and verified with an actual CloudBase adapter before deployment.

## Preview

Default mode uses deterministic fixture data and performs no network access:

```sh
node tools/intel-preview.cjs
node tools/intel-preview.cjs --output work/intel-preview.json
```

Live mode fetches metadata from the two fixed GitHub endpoints and still writes only a local JSON artifact; it does not connect to CloudBase:

```sh
node tools/intel-preview.cjs --live --output work/intel-live-preview.json
```

The CLI is capped at two sources and one page each. It does not ingest release bodies. Treat generated dates and response contents as source data, not instructions.

## Required before a later deployment stage

- Implement and review a durable CloudBase adapter with atomic lease acquisition and token-checked release/checkpoint writes.
- Decide idempotent collection/index strategy and failure/recovery retention; do not mix these documents into `companies`.
- Add platform-authenticated scheduler wiring only after security review; a caller event must never enable it.
- Run staged CloudBase permission, concurrency, timeout and recovery checks without touching production.
- Review GitHub API version and rate-limit behavior against official docs: [REST API releases](https://docs.github.com/en/rest/releases/releases) and [REST API best practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api).


## Primary review and live check — 2026-10-29

All 17 security scripts independently executed with exit 0; see ingestion-test-log.txt. Ingestion tests contain 8 passing cases, including cross-source rate-limit deferral and malformed/credential URL rejection. One small live metadata dry run executed successfully without authentication or cloud writes: Transformers returned 30 entries (30 normalized), Chisel returned 30 entries (25 normalized after filtering). Total 55 metadata records. Raw release bodies and assets were not retained. This is a first-page snapshot, not a complete historical import or a continuously updated service.

This branch is stacked on feature/infoflow-mvp (PR #1), which has not been merged. No production deployment or permission change is part of this delivery. The lease/checkpoint store is in-memory only; durable transactions, lease expiry, CloudBase runtime rules and collection integration remain necessary before enabling scheduling. Existing mini-program still uses its fixture source and is not claimed connected to these records.
