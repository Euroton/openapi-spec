# openapi-spec

Mechanically-extracted OpenAPI 3.1 specification of the Proton server API, derived from the [ProtonWebClients](https://github.com/ProtonMail/WebClients) TypeScript sources.

## Contents

```
openapi-spec/
├── spec/
│   ├── euroton.openapi.yaml      ← generated OpenAPI 3.1 document
│   └── augment.yaml              ← manual additions merged on top (Bridge-only, etc.)
├── src/
│   ├── extract/                  ← ts-morph based extractor
│   └── build/                    ← ExtractedSpec → OpenAPI 3.1 doc
├── reports/                      ← cross-validation reports (e.g. against go-proton-api)
└── README.md
```

## How it works

The extractor parses each `packages/shared/lib/api/*.ts` file from the upstream client checkout. Every exported function in those files returns an object of the canonical shape:

```typescript
{ method: 'get'|'post'|'put'|'delete', url: string, params?: object, data?: object }
```

The extractor:

1. Walks `packages/shared/lib/api/` via ts-morph for the canonical shared-API descriptors.
2. Also walks `packages/pass/lib/**/(*.requests.ts | *.request.ts)` for the Pass surface, which uses a different convention: each exported `async` helper contains an inline `api({ url, method, ... })` call rather than returning a flat descriptor (see ADR 192).
3. Statically evaluates each returned object literal (resolving template literals against function parameters to recover URL templates like `/messages/{id}`; module-level const string identifiers are inlined, so Pass's `${PAT_BASE_URL}/${tokenId}` becomes `/account/v4/personal-access-token/{tokenId}`).
4. Resolves parameter types via the TypeScript type-checker → JSON Schema (`ts-json-schema-generator`).
5. Groups operations by file → OpenAPI tag (Mail, Contacts, Labels, Keys, Events, Auth, Pass Vaults, Pass Shares, ...).
6. Emits a single `spec/euroton.openapi.yaml`.

Response shapes are inferred from consumer code in `applications/mail/src/app/store/` because the upstream API functions don't declare return types.

After step 5, the build also merges `spec/augment.yaml` if present. Augment holds operations the extractor can't see; real Proton endpoints that the upstream **web** clients don't call (and thus aren't in `packages/shared/lib/api/`), but that other Proton clients (notably Proton Bridge) do call. Type shapes for these come from Proton's `go-proton-api` repo, in `server/`. Augment paths win on conflict, so the file doubles as a one-off correction layer for extractor bugs.

## Usage

The extractor reads a WebClients checkout from `../WebClients` by default. Set `PROTON_WEBCLIENTS` to use another path.

```bash
pnpm install --ignore-workspace
pnpm run extract           # writes spec/euroton.openapi.yaml
pnpm run lint              # spectral validation
```

## License

GPL-3.0-or-later. See `LICENSE`.

This repository contains derived metadata about a GPL-3.0 work. The output spec is itself licensed GPL-3.0 to keep downstream consumers (notably `euroton-server`) free to be AGPL-3.0.
