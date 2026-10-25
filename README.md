# ServiceNow Catalog Hook for ReDBox v5

This hook provides reusable ServiceNow catalog submission mechanics for ReDBox.
Customer hooks own record types, forms, workflows, and the decision to submit.
This hook owns named catalog configuration, mapping, OAuth, HTTP retries and
timeouts, optional parent association, response write-back, auditing, and
opt-in idempotency.

The hook does not register a `servicenow-catalog` record type, workspace type,
workflow, form, Angular application, view, or navigation entry.

## Runtime compatibility

This hook requires an Effect-4 ReDBox core (develop after portal #4918),
Node.js 24 or newer, and a host-provided `effect` satisfying `^4.0.4`.
Effect is a peer dependency so the hook shares the portal's runtime; the exact
`4.0.4` development dependency is used for compilation and unit tests.

The core peer range `>=5.1.0-beta.0 <6.0.0` identifies the supported core line,
but cannot identify the Effect migration: the published `5.1.0-beta.12573`
core still uses Effect 3. That core and older portal images are not supported
by this port. Installing a separate Effect 4 beside an Effect-3 core is not a
supported compatibility mode. Until an Effect-4 core beta is published, use a
portal develop image containing the migrated core. Some develop images report
an internal core version that requires `--legacy-peer-deps` when installing
the hook tarball; verify the host's actual Effect version as well.

## Configuration

`servicenowCatalog` is brand-aware and disabled by default. It contains any
number of named catalog definitions:

```json
{
  "enabled": true,
  "catalogs": {
    "storage-new": {
      "enabled": true,
      "connection": {
        "url": "https://example.service-now.com/api/sn_sc/servicecatalog/items/ITEM_ID/order_now",
        "method": "post",
        "headers": {
          "Authorization": "Basic BASE64_CREDENTIALS"
        },
        "timeoutMs": 30000,
        "totalTimeoutMs": 120000,
        "retry": {
          "maxAttempts": 3,
          "baseDelayMs": 1000,
          "maxDelayMs": 10000,
          "retryOnStatusCodes": [408, 429, 500, 502, 503, 504]
        }
      },
      "oauth": {
        "enabled": false,
        "url": "",
        "clientId": "",
        "clientSecret": "",
        "grantType": "client_credentials"
      },
      "bodyTemplate": {
        "sysparm_quantity": "1",
        "get_portal_messages": "true",
        "variables": {}
      },
      "requestFields": [
        {
          "destination": "variables.short_description",
          "source": {
            "kind": "handlebars",
            "template": "{{workspace.metadata.title}}"
          }
        },
        {
          "destination": "variables.requested_size",
          "source": {
            "kind": "jsonata",
            "expression": "workspace.metadata.storage_size"
          }
        }
      ],
      "responseFields": {
        "workspace": [
          {
            "destination": "metadata.servicenow_number",
            "source": {
              "kind": "path",
              "path": "response.result.number"
            }
          },
          {
            "destination": "metadata.status",
            "source": {
              "kind": "path",
              "path": "response.result.state",
              "defaultValue": "Provisioning"
            }
          }
        ],
        "parentRecord": [
          {
            "destination": "metadata.storage_request_number",
            "source": {
              "kind": "path",
              "path": "response.result.number"
            }
          }
        ]
      },
      "parentRecord": {
        "oid": {
          "kind": "path",
          "path": "workspace.metadata.parentOid"
        }
      },
      "responseNormalization": {
        "parseJsonString": true
      },
      "idempotency": {
        "enabled": true,
        "key": {
          "kind": "handlebars",
          "template": "{{oid}}:{{trigger.event}}:storage-new"
        }
      }
    }
  }
}
```

Hook defaults are merged with brand configuration, with the brand values taking
precedence. New configuration must use named catalogs. The previous
single-catalog shape is temporarily accepted as a catalog named `default` and
emits a deprecation warning.

The application-configuration model declares the Authorization header, OAuth
client secret, password, and refresh token as secrets. Do not put credentials
in mappings, audit summaries, source control, or trigger options.

Secret fields use core's static `catalogs.*` wildcard paths. A wildcard matches
one literal catalog name, including hyphens, dots and brackets (for example,
`storage-request` or `storage.request[1]`). The deprecated single-catalog shape
also retains its secret declarations. This requires the wildcard-aware
AppConfigService introduced by redbox-portal commit `d6b9ad357` (#4900).

Saving `__REDACTED__` preserves an existing stored secret; with no existing
secret it omits the field so hook/environment defaults can apply. To remove a
stored override explicitly, submit core's `__CLEAR_SECRET__` marker.

An affected build using the old bracket-path declarations with this core may
have stored `__REDACTED__` over real per-catalog credentials or exposed stored
credentials in the admin form. This fix cannot recover overwritten values.
Before reusing an affected installation, inspect stored per-catalog fields for
that literal placeholder without logging credentials. Restore the real value
from an authoritative source, or explicitly clear the override to restore an
environment fallback. Rotate credentials that may have been exposed. No
automatic migration deletes placeholder values.

### OAuth

OAuth client-credentials, password, and refresh-token grants are supported.
When OAuth is enabled, the access token is fetched through the shared HTTP
runtime and reused across retries for one submission. Additional connection
headers are still applied, with the OAuth bearer token taking precedence over
an Authorization header.

## Calling the service

A customer-owned save hook calls the standard exported service:

```ts
const result = await sails.services.servicenowcatalogservice.submitRequest(
  oid,
  workspaceData,
  {
    catalog: 'storage-new',
    event: 'create',
    // Optional when the catalog's idempotency binding resolves a key.
    idempotencyKey: oid + ':create:storage-new',
    // Optional when the caller has already resolved the relationship.
    parentRecordOid: workspaceData.metadata.parentOid
  },
  req.user,
  response
);
```

`catalog` and `event` are required. Runtime options cannot replace catalog
URLs, credentials, body templates, retry policy, or mappings. An integration or
catalog that is explicitly disabled returns the incoming trigger response
unchanged. Validation, duplicate, mapping, parent, OAuth, request, timeout, and
write-back failures return the normal structured trigger failure without
deleting the saved workspace.

## Mapping contract

Request and response fields use the core `ValueBinding` model:

- `path`: read a dot-notation path;
- `handlebars`: render a Handlebars template;
- `jsonata`: evaluate a JSONata expression.

Every request mapping receives this stable context:

```ts
{
  workspace,
  parentRecord,       // undefined when the catalog has no parent
  oid,
  brand,              // resolved brand name
  trigger: {
    catalog,
    event,
    idempotencyKey?,
    parentRecordOid?
  },
  now,                // ISO-8601 string
  translationService
}
```

Response mappings receive the same values plus `response`, containing the
normalized ServiceNow response. New response mappings should use paths such as
`response.result.number`. A temporary raw-response root alias is retained for
older `result.*` mappings.

Mappings are applied to clones and reject prototype-polluting destination
paths. Workspace and parent mappings are independent. Metadata is written only
when the corresponding mapping list is non-empty. The service never assigns a
hard-coded status; status changes must be expressed as ordinary response
mappings, binding defaults, or expressions.

## Parent records

Parent handling is optional and relationship-neutral. A caller can supply
`parentRecordOid`, or the catalog can resolve it from `parentRecord.oid`.
When configured, the OID must be non-empty and the record must exist. The
service loads the parent through `RecordsService`, associates the workspace
through `WorkspaceService.addWorkspaceToRecord`, and applies optional parent
response mappings through `RecordsService.updateMeta`.

Catalogs without a parent binding perform no parent lookup, association, or
parent update. Parent identity is resolved through the configured binding.

## Response normalization

With `responseNormalization.parseJsonString` enabled (the default), an HTTP
response whose root value is a JSON-encoded string is parsed before response
mapping. Object and array responses are unchanged. A root string that is not
valid JSON is preserved as a string.

OAuth and catalog responses are decompressed with strict zlib defaults before
JSON parsing, including Brotli, gzip, and deflate. A corrupt or truncated catalog
response fails with a non-retryable `CatalogRequestError` and an `Uncertain`
submission state: ServiceNow may already have accepted the order, so replaying
it automatically could create a duplicate. Normal failure audits are retained
without the compressed payload or request credentials. Reconcile the upstream
order before retrying an uncertain submission.

## Auditing and idempotency

The integration audit records the overall submission and nested phases for
parent lookup, association, ServiceNow HTTP work, workspace update, parent
update, and idempotency decisions. Request summaries include the selected
catalog, trigger event, optional parent OID, and stable idempotency key, but not
credentials or full request bodies.

Idempotency is disabled by default. When enabled, a key must come from the
trigger or the configured binding. The hook-owned
`ServicenowCatalogIdempotency` Waterline model is the atomic durable claim
ledger. Its primary key is derived from an unambiguous JSON-array encoding of
brand ID, record OID, catalog, and idempotency key. Integration audit history
provides the submission evidence used to reconcile claim state:

- a prior completed key is rejected as a duplicate;
- a prior started/interrupted key is rejected because ServiceNow may have
  accepted the request;
- a prior failed trace can be retried;
- an in-process guard also rejects concurrent duplicates in one portal process.

Claims move through `claimed`, `completed`, `failed`, and `uncertain`.
A `claimed` row is leased for the greater of five minutes or the configured
`totalTimeoutMs` plus a one-minute safety margin, so the lease covers the
complete orchestration side-effect window. After expiry, one process atomically
takes reconciliation ownership and checks ServiceNow-scoped audit history
before doing anything external: a successful trace becomes `completed`, a
started or interrupted trace becomes `uncertain`, and a clear trace may be
submitted again. If reconciliation lookup itself fails, a recovered stale
claim becomes `uncertain` rather than retryable.

Completed and uncertain rows have no automatic retention expiry because deleting
them re-enables their keys. Operators may remove them only when the corresponding
idempotency-key protection window has deliberately ended. Failed rows are
retained until atomically reclaimed by a later attempt.

## Legacy compatibility endpoints

These routes remain for compatibility only and are not the reusable save-hook
API:

- `POST /:branding/:portal/ws/catalog/rdmp`
- `POST /:branding/:portal/ws/catalog/request`
- `GET /:branding/:portal/ws/catalog/info`

They continue to use the isolated legacy `sails.config.workspaces.catalog`
settings and their existing authorization/response conventions. The request
endpoint no longer falls back to hook-owned record or workflow names:
`workspaces.catalog.recordType` and `workspaces.catalog.workflowStage` must
be configured when that endpoint creates a workspace.

The historical `legacy-form-config/` and `angular/catalog/` directories are
migration evidence only. They are not compiled, registered, or included in the
published package.

## Development

Use the hook archetype scripts:

```bash
npm install --include=dev
npm run compile
npm run test:unit
npm run test:integration:mocha
npm run test:integration:bruno
```

Set `REDBOX_PORTAL_IMAGE` to select the portal image for both integration suites
(for example `qcifengineering/redbox-portal:develop-pdfgen-20261022`). Use a unique
`COMPOSE_PROJECT_NAME` for isolated runs.

The integration suites build and lift a real ReDBox portal with MongoDB and
Solr. Mocha covers the service orchestration and Bruno covers authorization for
every retained compatibility route. Clean their Docker resources when needed:

```bash
npm run test:integration:mocha:clean
npm run test:integration:bruno:clean
```

## CI and releases

CircleCI compiles and runs the unit suite for every branch. Stable Git tags
matching `vMAJOR.MINOR.PATCH` publish the matching package version with the npm
`latest` dist-tag.

Beta packages are published by triggering a CircleCI pipeline with
`npm_publish_mode=beta`, a stable base `npm_publish_version`, and an
`npm_publish_dist_tag` such as `beta`, `next`, or `alpha`.

### Shared parent/resource dispatch claims

A named catalog can opt into shared parent/resource dispatch claims:

```json
"dispatchClaim": {
  "enabled": true,
  "resources": { "kind": "path", "path": "workspace.metadata.requestedResources" }
}
```

This requires `parentRecord.oid` and enabled request idempotency. The plugin claims each resource string under **brand + parent OID + resource**, independently of catalog/request OID. Acquire all options before associating the request or sending HTTP. Success and uncertain outcomes retain ownership; database failures prevent dispatch. Other catalogs retain their existing behaviour when this setting is absent/false. Legacy `/ws/catalog/request` ordering is unavailable for brands opting into shared claims, because that route has no persisted request identity before HTTP.

Customer hooks still enforce authoritative eligibility and permissions, including requests created before these claim rows existed. Keep the ordinary awaited post-save call; no queue is introduced. The existing same-request replay ledger remains separate.

`releaseRequestClaims` is a server-side post-delete hook, not an HTTP reset API. It verifies a completed deleted lifecycle, the brand administrator role, parent edit access and removal of the parent link, then releases only that deleted request's owned claims. Incomplete dispatches remain occupied. An ambiguous HTTP result never authorises a second request automatically. As with other external integrations, the database and remote HTTP call are not one atomic transaction.
