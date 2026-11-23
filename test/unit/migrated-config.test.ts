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

  it('declares the named-catalog form schema', function () {
    const rootSchema = SERVICENOW_CATALOG_SCHEMA as {
      required: string[];
      properties: {
        catalogs: {
          items: {
            required: string[];
            properties: Record<string, unknown>;
          }
        }
      };
    };
    expect(rootSchema.required).to.deep.equal(['enabled', 'catalogs']);
    expect(rootSchema.properties.catalogs.items.required).to.include.members([
      'enabled',
      'connection',
      'oauth',
      'bodyTemplate',
      'requestFields',
      'responseFields'
    ]);
    expect(rootSchema.properties.catalogs.items.properties)
      .to.have.property('requestFilters');
  });

  it('declares all named-catalog secrets as static core wildcard paths', function () {
    expect(SERVICENOW_CATALOG_CONFIG_MODEL.secretFields).to.deep.equal([
      'catalogs.*.connection.headers.Authorization',
      'catalogs.*.oauth.clientSecret',
      'catalogs.*.oauth.password',
      'catalogs.*.oauth.refreshToken',
      'connection.headers.Authorization',
      'oauth.clientSecret',
      'oauth.password',
      'oauth.refreshToken'
    ]);
    expect(SERVICENOW_CATALOG_CONFIG_MODEL).to.have.property('formAdapter');
  });

  it('keeps secret declarations for the supported temporary single-catalog shape', function () {
    expect(SERVICENOW_CATALOG_CONFIG_MODEL.secretFields).to.include.members([
      'connection.headers.Authorization',
      'oauth.password',
      'oauth.refreshToken',
      'oauth.clientSecret'
    ]);
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

describe('catalog form adapter', function () {
  const adapter = configModule.SERVICENOW_CATALOG_FORM_ADAPTER;

  it('round-trips multiple partial catalogs and legacy inputs unchanged', function () {
    for (const stored of [
      { enabled: true, catalogs: { first: createDefaultCatalogDefinition(), second: { enabled: false } } },
      { enabled: false, catalogs: {} },
      { enabled: true, connection: { url: 'https://legacy.example' }, responseFields: [] },
      { oauth: {}, bodyTemplate: { untouched: true } }
    ]) {
      expect(adapter.fromForm(adapter.toForm(stored))).to.deep.equal(stored);
    }
  });

  it('rejects empty, duplicate and unsafe catalog names', function () {
    for (const name of ['', ' ', '__proto__', 'constructor', 'prototype', 'a.b', 'a[0]', 'a]']) {
      expect(() => adapter.fromForm({ catalogs: [{ name }] })).to.throw();
    }
    expect(() => adapter.fromForm({ catalogs: [{ name: 'same' }, { name: 'same' }] })).to.throw();
  });

  it('provides an array schema with a required name and catalog properties', function () {
    const schema = SERVICENOW_CATALOG_SCHEMA.properties.catalogs;
    expect(schema.type).to.equal('array');
    expect(schema.items.required).to.include('name');
    expect(schema.items.properties.name.type).to.equal('string');
    expect(schema.items.properties).to.have.property('connection');
  });

  it('core wildcard matching masks array entries and restores stored map paths before merging', function () {
    const stored = { enabled: true, catalogs: { first: createDefaultCatalogDefinition(), second: createDefaultCatalogDefinition() } };
    for (const definition of Object.values(stored.catalogs)) {
      definition.oauth.clientSecret = String(Math.random());
      definition.oauth.password = String(Math.random());
      definition.oauth.refreshToken = String(Math.random());
      definition.connection.headers.Authorization = String(Math.random());
    }
    const form = adapter.toForm(structuredClone(stored));
    let count = 0;
    // Core AppConfigService.getSecretPaths expands own keys, including array indices.
    const visit = (value: unknown, parts: string[]) => {
      if (value == null || typeof value !== 'object') return;
      const [part, ...rest] = parts;
      for (const key of part === '*' ? Object.keys(value) : [part]) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
        if (rest.length) visit(Reflect.get(value, key), rest);
        else { Reflect.set(value, key, '__REDACTED__'); count++; }
      }
    };
    for (const path of configModule.SERVICENOW_CATALOG_SECRET_FIELDS) visit(form, path.split('.'));
    expect(count).to.equal(8);
    const incoming = adapter.fromForm(form) as typeof stored;
    for (const name of ['first', 'second'] as const) {
      const definition = incoming.catalogs[name];
      expect(definition.oauth.clientSecret === '__REDACTED__').to.equal(true);
      expect(definition.oauth.password === '__REDACTED__').to.equal(true);
      expect(definition.oauth.refreshToken === '__REDACTED__').to.equal(true);
      expect(definition.connection.headers.Authorization === '__REDACTED__').to.equal(true);
      // Core merges placeholders against the original stored map after fromForm.
      for (const key of ['clientSecret', 'password', 'refreshToken'] as const) {
        if (definition.oauth[key] === '__REDACTED__') Reflect.set(definition.oauth, key, stored.catalogs[name].oauth[key]);
      }
      if (definition.connection.headers.Authorization === '__REDACTED__') {
        definition.connection.headers.Authorization = stored.catalogs[name].connection.headers.Authorization;
      }
      expect(JSON.stringify(definition) === JSON.stringify(stored.catalogs[name])).to.equal(true);
    }
  });
});
