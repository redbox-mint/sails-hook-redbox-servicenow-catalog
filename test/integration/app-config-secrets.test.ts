import type { ServiceNowCatalogDefinition } from '../../src/api/configmodels/ServiceNowCatalogAppConfig';

const { expect } = require('chai') as { expect: Chai.ExpectStatic };
const { createDefaultCatalogDefinition, SERVICENOW_CATALOG_CONFIG_KEY: configKey } = require(
  '@researchdatabox/sails-hook-redbox-servicenow-catalog/dist/api/configmodels/ServiceNowCatalogAppConfig.js'
) as typeof import('../../src/api/configmodels/ServiceNowCatalogAppConfig');
const { resolveServiceNowCatalog } = require(
  '@researchdatabox/sails-hook-redbox-servicenow-catalog/dist/api/services/servicenow/configuration.js'
) as typeof import('../../src/api/services/servicenow/configuration');
const { APP_CONFIG_SECRET_MASK, APP_CONFIG_SECRET_CLEAR } = require(
  '@researchdatabox/redbox-core/dist/services/AppConfigService'
) as { APP_CONFIG_SECRET_MASK: string; APP_CONFIG_SECRET_CLEAR: string };

type CatalogConfig = { enabled: boolean; catalogs: Record<string, ServiceNowCatalogDefinition> };

function withSecrets(value: string): ServiceNowCatalogDefinition {
  const catalog = createDefaultCatalogDefinition();
  catalog.connection.headers = { Authorization: value, 'X-Public': 'public-header' };
  Object.assign(catalog.oauth, {
    clientId: 'public-client', clientSecret: value, password: value, refreshToken: value
  });
  return catalog;
}

function expectSecrets(catalog: ServiceNowCatalogDefinition, value?: string): void {
  if (value === undefined) {
    expect(catalog.connection.headers).not.to.have.property('Authorization');
    for (const key of ['clientSecret', 'password', 'refreshToken']) {
      expect(catalog.oauth).not.to.have.property(key);
    }
  } else {
    expect(catalog.connection.headers.Authorization).to.equal(value);
    expect(catalog.oauth.clientSecret).to.equal(value);
    expect(catalog.oauth.password).to.equal(value);
    expect(catalog.oauth.refreshToken).to.equal(value);
  }
  expect(catalog.connection.headers['X-Public']).to.equal('public-header');
  expect(catalog.oauth.clientId).to.equal('public-client');
}

describe('ServiceNow catalog AppConfig secret lifecycle', function () {
  // Exercise real core masking/merging and Mongo persistence, with the model
  // registered by the installed plugin. Do not reimplement core path expansion.
  for (const catalogName of ['storage-request', 'storage.request[1]']) {
    describe(catalogName, function () {
      let brand: ReturnType<typeof BrandingService.getDefault>;
      let originalHookConfig: unknown;
      let originalSecretsConfig: typeof sails.config.appConfigSecrets;

      function config(value: string): CatalogConfig {
        return { enabled: true, catalogs: { [catalogName]: withSecrets(value) } };
      }

      async function stored(): Promise<CatalogConfig> {
        const rows = await AppConfig.find({ branding: brand.id, configKey }) as Array<{ configData: CatalogConfig }>;
        expect(rows).to.have.length(1);
        return rows[0].configData as CatalogConfig;
      }

      async function form(): Promise<CatalogConfig> {
        const result = await AppConfigService.getAppConfigForm(brand, configKey);
        return result.model as CatalogConfig;
      }

      beforeEach(function () {
        brand = BrandingService.getDefault();
        originalHookConfig = Reflect.get(sails.config, configKey);
        originalSecretsConfig = sails.config.appConfigSecrets;
        sails.config.appConfigSecrets = {
          ...(originalSecretsConfig as Record<string, unknown> | undefined), provider: 'database'
        };
      });

      afterEach(async function () {
        await AppConfig.destroy({ branding: brand.id, configKey });
        Reflect.set(sails.config, configKey, originalHookConfig);
        sails.config.appConfigSecrets = originalSecretsConfig;
        await AppConfigService.bootstrap();
      });

      it('masks every stored secret in getAppConfigForm without changing backend values', async function () {
        await AppConfigService.createOrUpdateConfig(brand, configKey, config('stored-secret'));
        // Reload from Mongo so this also covers stored values loaded at startup.
        await AppConfigService.bootstrap();

        expectSecrets((await form()).catalogs[catalogName], APP_CONFIG_SECRET_MASK);
        expectSecrets((await stored()).catalogs[catalogName], 'stored-secret');
        const backend = Reflect.get(AppConfigService.getAppConfigurationForBrand(brand.name), configKey) as CatalogConfig;
        expectSecrets(backend.catalogs[catalogName], 'stored-secret');
      });

      it('preserves existing stored secrets when the masked form is saved', async function () {
        await AppConfigService.createOrUpdateConfig(brand, configKey, config('stored-secret'));
        const masked = await form();
        // Explicit assertion prevents a broken masker hiding a broken merger.
        expectSecrets(masked.catalogs[catalogName], APP_CONFIG_SECRET_MASK);
        masked.catalogs[catalogName].connection.url = 'https://example.invalid/changed';
        await AppConfigService.createOrUpdateConfig(brand, configKey, masked);

        expectSecrets((await stored()).catalogs[catalogName], 'stored-secret');
        expect((await stored()).catalogs[catalogName].connection.url).to.equal('https://example.invalid/changed');
        expectSecrets(masked.catalogs[catalogName], APP_CONFIG_SECRET_MASK);
      });

      it('omits placeholders without stored secrets on create and update, preserving environment fallback', async function () {
        const environmentConfig = config('environment-only-secret');
        Reflect.set(sails.config, configKey, environmentConfig);
        // First insert and then update the row, both with no existing secrets.
        for (let save = 0; save < 2; save += 1) {
          await AppConfigService.createOrUpdateConfig(brand, configKey, config(APP_CONFIG_SECRET_MASK));
          expectSecrets((await stored()).catalogs[catalogName]);
          const backend = Reflect.get(AppConfigService.getAppConfigurationForBrand(brand.name), configKey);
          const resolved = resolveServiceNowCatalog(catalogName, Reflect.get(sails.config, configKey), backend);
          expectSecrets(resolved.catalog!, 'environment-only-secret');
        }
        expectSecrets(environmentConfig.catalogs[catalogName], 'environment-only-secret');
      });

      it('replaces every stored secret with a new real form value', async function () {
        await AppConfigService.createOrUpdateConfig(brand, configKey, config('stored-secret'));
        const edited = await form();
        edited.catalogs[catalogName] = withSecrets('replacement-secret');
        const saved = await AppConfigService.createOrUpdateConfig(brand, configKey, edited) as CatalogConfig;

        expectSecrets((await stored()).catalogs[catalogName], 'replacement-secret');
        expectSecrets(saved.catalogs[catalogName], APP_CONFIG_SECRET_MASK);
        expectSecrets((await form()).catalogs[catalogName], APP_CONFIG_SECRET_MASK);
      });

      it('clears stored overrides with APP_CONFIG_SECRET_CLEAR and restores environment fallback', async function () {
        Reflect.set(sails.config, configKey, config('environment-only-secret'));
        await AppConfigService.createOrUpdateConfig(brand, configKey, config('stored-secret'));
        await AppConfigService.createOrUpdateConfig(brand, configKey, config(APP_CONFIG_SECRET_CLEAR));

        expectSecrets((await stored()).catalogs[catalogName]);
        const backend = Reflect.get(AppConfigService.getAppConfigurationForBrand(brand.name), configKey);
        expectSecrets(resolveServiceNowCatalog(catalogName, Reflect.get(sails.config, configKey), backend).catalog!,
          'environment-only-secret');
      });
    });
  }
});
