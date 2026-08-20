import type {
  ServiceNowCatalogDefinition,
  ServiceNowFieldMapping
} from '../../src/api/configmodels/ServiceNowCatalogAppConfig';

const { expect } = require('@researchdatabox/redbox-dev-tools/testing') as { expect: Chai.ExpectStatic };
const configModule = require('../../dist/api/configmodels/ServiceNowCatalogAppConfig.js') as
  typeof import('../../src/api/configmodels/ServiceNowCatalogAppConfig');
const configurationModule = require('../../dist/api/services/servicenow/configuration.js') as
  typeof import('../../src/api/services/servicenow/configuration');

const {
  SERVICENOW_CATALOG_CONFIG_MODEL,
  SERVICENOW_CATALOG_SCHEMA,
  ServiceNowCatalogAppConfig,
  createDefaultCatalogDefinition
} = configModule;
const {
  normalizeServiceNowCatalogConfig,
  resolveServiceNowCatalog
} = configurationModule;

describe('named ServiceNow catalog configuration', function () {
  it('defaults to a disabled integration with no implicit customer catalog', function () {
    const config = new ServiceNowCatalogAppConfig();
    expect(config).to.deep.equal({ enabled: false, catalogs: {} });
    expect(ServiceNowCatalogAppConfig.getFieldOrder()).to.deep.equal(['enabled', 'catalogs']);

    const definition = createDefaultCatalogDefinition();
    expect(definition).to.have.nested.property('responseNormalization.parseJsonString', true);
    expect(definition).to.have.nested.property('idempotency.enabled', false);
    expect(definition.requestFilters).to.deep.equal([]);
    expect(definition.responseFields).to.deep.equal({ workspace: [], parentRecord: [] });
  });

  it('validates the canonical named-catalog schema', function () {
    const rootSchema = SERVICENOW_CATALOG_SCHEMA as {
      required: string[];
      properties: {
        catalogs: {
          additionalProperties: {
            required: string[];
            properties: Record<string, unknown>;
          }
        }
      };
    };
    expect(rootSchema.required).to.deep.equal(['enabled', 'catalogs']);
    expect(rootSchema.properties.catalogs.additionalProperties.required).to.include.members([
      'enabled',
      'connection',
      'oauth',
      'bodyTemplate',
      'requestFields',
      'responseFields'
    ]);
    expect(rootSchema.properties.catalogs.additionalProperties.properties)
      .to.have.property('requestFilters');
  });

  it('expands concrete secret paths for named catalogs and keeps temporary legacy paths', function () {
    const model = {
      enabled: true,
      catalogs: {
        'storage-new': createDefaultCatalogDefinition(),
        'catalog.with.dot': createDefaultCatalogDefinition()
      }
    };
    const adapted = SERVICENOW_CATALOG_CONFIG_MODEL.formAdapter.toForm(model);

    expect(adapted).to.equal(model);
    expect(SERVICENOW_CATALOG_CONFIG_MODEL.secretFields).to.include.members([
      'catalogs["storage-new"].connection.headers.Authorization',
      'catalogs["storage-new"].oauth.clientSecret',
      'catalogs["storage-new"].oauth.password',
      'catalogs["storage-new"].oauth.refreshToken',
      'catalogs["catalog.with.dot"].oauth.clientSecret',
      'oauth.clientSecret'
    ]);

    const beforeSave = SERVICENOW_CATALOG_CONFIG_MODEL.secretFields.length;
    SERVICENOW_CATALOG_CONFIG_MODEL.formAdapter.fromForm(model);
    expect(SERVICENOW_CATALOG_CONFIG_MODEL.secretFields).to.have.length(beforeSave);
  });

  it('normalizes a temporary single-catalog config under the default name with a warning', function () {
    const warnings: string[] = [];
    const legacy = createDefaultCatalogDefinition();
    legacy.connection.url = 'https://legacy.example/catalog';
    const responseFields: ServiceNowFieldMapping[] = [{
      destination: 'metadata.number',
      source: { kind: 'path', path: 'result.number' }
    }];
    const result = normalizeServiceNowCatalogConfig(
      {
        enabled: true,
        connection: legacy.connection,
        oauth: legacy.oauth,
        bodyTemplate: legacy.bodyTemplate,
        requestFields: legacy.requestFields,
        responseFields
      },
      (message: string) => warnings.push(message)
    );

    expect(result.usedLegacyShape).to.equal(true);
    const normalizedDefault = result.config.catalogs.default as ServiceNowCatalogDefinition;
    expect(normalizedDefault).to.have.nested.property(
      'responseFields.workspace[0].destination',
      'metadata.number'
    );
    expect(warnings).to.have.length(1);
    expect(warnings[0]).to.contain('deprecated');
  });

  it('resolves brand catalog values over hook defaults', function () {
    const hookCatalog = createDefaultCatalogDefinition();
    hookCatalog.connection.url = 'https://hook.example/catalog';
    hookCatalog.connection.timeoutMs = 1000;
    const resolved = resolveServiceNowCatalog(
      'storage-new',
      { enabled: true, catalogs: { 'storage-new': hookCatalog } },
      {
        catalogs: {
          'storage-new': {
            connection: { url: 'https://brand.example/catalog' },
            requestFields: [{
              destination: 'variables.title',
              source: { kind: 'path', path: 'workspace.metadata.title' }
            }]
          }
        }
      }
    );

    expect(resolved.enabled).to.equal(true);
    expect(resolved.catalog?.connection.url).to.equal('https://brand.example/catalog');
    expect(resolved.catalog?.connection.timeoutMs).to.equal(1000);
    expect(resolved.catalog?.requestFields).to.have.length(1);
  });
});
