# ServiceNow Catalog Hook for ReDBox v5

This Sails hook adds a ServiceNow-backed workspace record type to ReDBox. Creating a
`servicenow-catalog` workspace can submit a configured ServiceNow catalog request,
write the returned ServiceNow identifiers onto the workspace, and associate the
workspace with its parent research data management plan.

## ReDBox v5 structure

- `src/index.ts` registers hook config, routes, controllers, services, and forms.
- `src/config` contains typed ServiceNow, record type, workflow, authorization, and workspace type config.
- `src/form-config` contains the draft, provisioning, and provisioned form stages.
- `bootstrap-data/vocabularies` contains the production option vocabularies used by the forms.
- `language-defaults/en/translation.json` contains the hook's default English labels.
- `legacy-form-config` preserves the source v4 form and the single-form wrappers used by the migration tool.

The legacy Angular 5 catalog app remains under `angular/catalog` as migration evidence.
It depends on the removed v4 shared Angular tree and is not part of the v5 build.

## Configuration

The record trigger uses the brand-aware `servicenowCatalog` application configuration.
It is disabled by default. Configure and enable it independently for each brand through
the ReDBox Application Configuration administration interface.

```json
{
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
  "requestFields": [
    {
      "destination": "variables.short_description",
      "source": { "kind": "handlebars", "template": "{{workspace.metadata.title}}" }
    },
    {
      "destination": "variables.requested_size",
      "source": { "kind": "jsonata", "expression": "workspace.metadata.storage_size" }
    }
  ]
}
```

Mappings use the same path, Handlebars, and JSONata value-binding model as the core DOI
and Figshare integrations. Response mappings write ServiceNow identifiers back to the
workspace. Trigger options can override the brand configuration for a single run.

OAuth client-credentials, password, and refresh-token grants are supported through the
`oauth` block. Application Configuration masks OAuth secrets and the Authorization
header; do not commit raw credentials to this hook.

The compatibility endpoints under `/:branding/:portal/ws/catalog` use the legacy
`sails.config.workspaces.catalog` settings when the standalone workspace flow is still enabled.

## Development

```bash
npm install
npm run compile
npm run test:unit
redbox-dev-tools check
```

The Docker-backed portal integration harness is available with:

```bash
npm run test:integration:mocha
```
