# openapi-spec ↔ go-proton-api route cross-validation

Date: 2026-06-03.

Sources compared:
- `go-proton-api/server/router.go` @ commit `c2ffcb6` (hand-walked; `gin.RouterGroup` prefixes need source-order unfolding, not regex-grep)
- `openapi-spec/spec/euroton.openapi.yaml` at this report's commit
- Ground-truth tie-breaker: `proton-webclients-mirror/packages/shared/lib/api/*.ts`

Normalization for the set-diff: `{paramName}` → `{ID}` so `{authUID}` vs `{UID}` doesn't show as a false delta (param-name deltas captured separately).

Raw inputs preserved under `/tmp/euroton-crossvalidate/{gopa-routes.txt, yaml-routes.txt}` during the original run; regenerate at any time by hand-walking `router.go` and `python -c "import yaml; ..."` over the YAML.

## Headline

| Bucket | Count |
|---|---|
| Routes in both (set-equal after normalization) | **41** |
| In go-proton-api, missing from our spec | **21** (classified below) |
| In our spec, missing from go-proton-api | **547** (expected; gopa is Bridge-scoped) |

The 547 is expected: gopa is the dev mock for Proton Bridge, so it omits Calendar, Drive, Pass, Wallet, organizations, payments, etc. Skim that list only if you want a "what does gopa NOT cover" answer.

The 21; gopa-only; is the actionable list, and after classification it collapses to **one real extractor gap and six Bridge-only endpoints**.

## Three places gopa lies, our spec wins

### 1. Login family; gopa says `/auth/v4`, upstream TS says `/core/v4/auth`

`packages/shared/lib/api/auth.ts` is the wire-truth:

```ts
export const auth = (...) => ({ method: 'post', url: 'core/v4/auth', ... });
export const auth2FA = (...) => ({ url: 'core/v4/auth/2fa', ... });
export const authJwt = (...) => ({ url: 'core/v4/auth/jwt', ... });
export const revoke = (...) => ({ method: 'delete', url: 'core/v4/auth', ... });
export const getInfo = (...) => ({ url: 'core/v4/auth/info', ... });
export const getModulus = (...) => ({ url: 'core/v4/auth/modulus', ... });
```

Our YAML correctly has the `/core/v4/auth/*` family. Gopa flattens these under `/auth/v4`, which is wrong relative to production.

Note: `/auth/v4/sessions/*`, `/auth/v4/mnemonic/*`, `/auth/v4/devices/*`, `/auth/v4/organizations/loginlink/*` *are* real upstream paths (different family). So production uses **both** `core/v4/auth` and `auth/v4`; gopa collapses the split.

This is load-bearing for `euroton-server`: `src/server.ts:102` registers `registerAuthRoutes` at prefix `/core/v4/auth`; correct, don't move it.

### 2. Contacts; gopa says `/contacts/v4`, upstream TS says `/contacts/v4/contacts`

`packages/shared/lib/api/contacts.ts`:

```ts
url: 'contacts/v4/contacts'
url: `contacts/v4/contacts/${contactID}`
url: 'contacts/v4/contacts/emails'
... (10 more, all double-`contacts`)
```

Gopa drops the second `contacts/` segment. Our YAML matches upstream.

### 3. Events; gopa says `/core/v4/events/{eventID}`, upstream has moved on

`packages/shared/lib/api/events.ts` references `core/v4/events/latest`, `core/v5/events/{id}`, `core/v6/events/{id}`. `euroton-server/src/modules/events/routes.ts:58` already serves `/core/v5/events/:eventID`. Gopa is stale here.

### 4. Domains-available; gopa adds a spurious `/core/v4` prefix

`packages/shared/lib/api/domains.ts`:

```ts
url: 'domains/available'  // no version prefix
```

Our YAML has `/domains/available`. Gopa's `/core/v4/domains/available` is the gopa form, not wire-truth. (Production Proton evidently uses *unversioned* `/domains/*` for the addressable-domain queries; confirmed by the rest of `domains.ts` also using bare `domains/...`.)

## Real extractor gap; exactly one

After classifying all 21 gopa-only routes against upstream TS, **one** is a genuine "TS calls this, our extractor missed it":

| Method | Path | Source TS | Why missed |
|---|---|---|---|
| POST | `/auth/refresh` | `packages/shared/lib/api/auth.ts` (`setRefreshCookies`) | Block-body arrow with conditional return. The extractor's "first return statement" logic bails on `return config;` (an identifier), never reaches the second return. Fix: when a return statement is an identifier, resolve it to the matching `const X = {...}` in the same scope. |

Fixed in this slice; see `src/extract/extractOp.ts` changes.

## Bridge-only; 6 endpoints

These exist in `go-proton-api/server/` but are **absent from upstream TS web-client API surface** (web clients don't call them). They're real production Proton endpoints used by Proton Bridge (the desktop IMAP/SMTP shim):

- `POST /mail/v4/messages/import`; bulk message import
- `PUT /mail/v4/messages/forward`; mark message as forwarded
- `PUT /mail/v4/messages/unforward`; unmark forwarded
- `GET /mail/v4/messages/ids`; list message IDs (lighter than the full GET)
- `POST /core/v4/reports/bug/attachments`; bug-report attachment upload
- `POST /data/v1/metrics`; observability push

For Phase 2 (web clients) these don't strictly matter. For Phase 4 (`euroton-imap-bridge`, parked) they become required. Adding them now to the spec via a small `spec/augment.yaml` so the surface is complete even while Phase 4 sleeps; tagged `Bridge` so they're easy to slice out.

## Gopa-only test surface; 3, ignore

Not real Proton endpoints:

- `ANY /proxy/{path}`; gopa dev passthrough to upstream
- `GET /internal/quark/{command}`; Proton "quark" test-fixture API (Bridge integration tests only)
- `GET /feature/v2/frontend`; gopa stubs this; production clients consume Unleash via SDK frame (binary), not via REST

## Param-name delta (cosmetic)

| Path family | gopa | yaml |
|---|---|---|
| `/auth/v4/sessions/{...}` | `{authUID}` | `{UID}` |

Both refer to the `x-pm-uid` header value. Keep `{UID}`; closer to header name.

## What changed in this slice

1. **Extractor fix**: `src/extract/extractOp.ts` now handles block-body arrows whose first return is an identifier; it resolves the identifier to a sibling `const X = {...}` and re-runs the operation extraction against that. Recovers `setRefreshCookies` (POST `/auth/refresh`).
2. **Bridge augment**: new `spec/augment.yaml` holds the 6 Bridge-only endpoints with minimal `requestBody`/`parameters` shapes inferred from `go-proton-api/server/messages.go`, `reports.go`, and `events.go`. Loaded and merged by `src/cli.ts` after `buildOpenApi`. Each operation is tagged `Bridge` and includes a description pointer at the gopa source.
3. **Report landed**: this file, at `openapi-spec/reports/2026-06-03-gopa-crossvalidate.md`.

## Rules of thumb crystallized

- **`upstream TS > gopa`**; when they disagree on wire shape or path, TS is canonical. Gopa is a Bridge-test mock; it lags and simplifies.
- **`HAR > TS for body shape`**; still holds. TS declares types that don't always reflect wire shape; HAR captures are the wire.
- **`Bridge surface ≠ Web surface`**; non-overlap is real; track Bridge endpoints separately so Phase 4 has a head start.

## Future hook

A `openapi-spec/src/crossvalidate/` sub-command would re-run this comparison on every extract:
- regex `\.(GET|POST|PUT|DELETE|PATCH)\(` over `router.go` (after expanding `gin.RouterGroup` prefixes; needs a small in-file walk)
- diff against the YAML's extracted operations
- emit a markdown report under `openapi-spec/reports/<date>-gopa-diff.md`

Weekend-scale work. Tracked in `Euroton/TODO.md`.
