# InfoFlow first delivery: fixture-only contract

## Scope and changed behavior

This change adds a fourth 情报 tab, a list and detail view, and two authenticated API actions. The production API reads a deliberately empty fixture array. It performs no collection access, network request, crawling, digest generation, notification, or write. The UI flag `miniprogram/config.js:intelEnabled` and cloud flag `INTEL_ENABLED` both default off. The tab remains visible and shows an off-state; turn the local UI flag on only to preview a locally injected dataset.

`miniprogram/pages/intel/demo-fixtures.js` contains two explicitly synthetic rows for layout review. They carry `demo: true`, have no date or external URL, and both list and detail views display “演示数据 · 非真实资讯”. The preview mode is off by default and does not call the cloud API. The cloud fixture file remains empty.

## API contract

Both actions are dispatched by the existing `api` cloud function after its current identity resolution. The handler receives `openid` as its second, server-derived argument and ignores any `openid` in the request object.

### `intelFeed`

Request: `{ action: "intelFeed", category?: "all"|"jobs"|"ai"|"semiconductor"|"electronics", limit?: 1..20, cursor?: string|null }`.

Response: `{ items: [...], nextCursor: null, digestAt: null }`. Only `status: "published"` fixture records are eligible. Public item fields include `summaryStatus`; absent source, publication date, or summary status is rendered explicitly as unknown. Pagination uses a signed cursor bound to the authenticated user, category, page size, snapshot, and expiry. Configure INFOFLOW_CURSOR_SECRET with at least 32 characters in an isolated environment before testing multiple pages; no secret is committed.

### `intelItem`

Request: `{ action: "intelItem", id: string }`, where id is 1–128 ASCII letters, digits, dot, underscore, colon, or hyphen and starts with a letter or digit.

Response: `{ item }` for a published fixture, otherwise `{ error, message }`. Draft or missing records are not disclosed. Public item projection includes only id, category, title, summary, summary status, publication time, source name, original URL, and evidence links.

Feature-off, unauthenticated, invalid request, and missing-item errors use `{error,message}`. The existing `util.api(action,data)` wrapper is reused unchanged by both pages.

## Data and index recommendations

No database collection or index is created in this delivery. Future persistence should keep public articles separate from `companies`, and should not enable client direct access. Before adding a live store, consider:

- `intel_items`: `(status, publishedAt desc)`, `(category, publishedAt desc)`, and `contentFingerprint` lookup.
- `intel_feedback`: `(openid, itemId)` unique/idempotent lookup and `(openid, updatedAt desc)`.
- `intel_preferences`: server-derived OPENID document key; no client-supplied identity.
- `intel_digests`: `(openid, localDate desc)` with an idempotent stable key.

These are recommendations only; this PR creates none of them.

## File inventory

- Changed: `cloudfunctions/api/index.js`, `miniprogram/app.json`, `miniprogram/theme.json`, `miniprogram/config.js`.
- Added API: `cloudfunctions/api/intel/handlers.js`, `cloudfunctions/api/intel/fixtures.js`.
- Added UI: `miniprogram/pages/intel/{index.js,index.json,index.wxml,index.wxss,demo-fixtures.js}`, `miniprogram/pages/intel-detail/{detail.js,detail.json,detail.wxml,detail.wxss}`.
- Added icons: `miniprogram/images/{tab-intel.png,tab-intel-on.png,tab-intel-d.png,tab-intel-d-on.png}`.
- Added verification: `security/infoflow.test.cjs`, `docs/infoflow/test-log.txt`.

## Local review steps

1. Open `miniprogram/config.js` and temporarily set `intelDemoMode: true` (leave `intelEnabled: false`).
2. Run the mini-program in WeChat Developer Tools. Open 情报, inspect the visible synthetic-data label, switch category chips, open either detail, and confirm the detail still says “演示数据 · 非真实资讯”. There are deliberately no fabricated dates or URLs to copy.
3. Restore `intelDemoMode: false` before packaging. In this state the page displays the disabled message and makes no API call.
4. The cloud action requires a separate explicit `INTEL_ENABLED=true`; do not set it in production for this fixture-only delivery.

Real Developer Tools screenshots are now available: [list](wechat-list.png) and [detail](wechat-detail.png).

## Rollback

For a deployed follow-up, leave/unset `INTEL_ENABLED` and restore `intelEnabled: false` to disable the API and page loading. To remove this change entirely, revert the four tracked config/router changes and remove the added `cloudfunctions/api/intel`, `miniprogram/pages/intel`, `miniprogram/pages/intel-detail`, icon assets, test, and `docs/infoflow` files. No user data, existing collection, permission, trigger, dependency, or recruitment code is migrated by this delivery.

## Actual checks and unverified items

Actual command results, including pre-change failures and post-change regression results, are recorded in `test-log.txt`. This is local fixture/mocked verification only. CloudBase identity integration, deployed environment flags, real WeChat account isolation, Developer Tools rendering, dark-mode device rendering, and any production configuration were not verified.

## Final reviewer verification

All 16 security scripts rerun independently: exit 0. See final-test-log.txt. The isolation harness now compares query array values structurally and resolves crawler relative dependencies correctly. The complete legal company name fixture remains intact. Manual review assertions match current generic provenance labels; production policy was not weakened or changed.

Actual UI: WeChat Developer Tools 2.02.2609231 RC on macOS, HUAWEI Pura 80 Pro simulator, WeChatLib 3.17.3. Imported a separate preview copy with intelDemoMode=true, intel page first, and cloud initialization disabled. Initial 3.17.6 simulator launch failed; switching the preview private setting to the existing project's 3.17.3 and recompiling succeeded. Observed zero console errors and preload/hot-reload warnings. List renders, card opens detail, back returns to list, semiconductor filter selects one correct demo card, all restores both. Screenshots are from the actual simulator, using labeled synthetic data. No live API, dark-mode device run, deployment, or cloud identity validation is claimed. Shipped flags remain off.
