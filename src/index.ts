import '@researchdatabox/redbox-core';
import { defineRedboxHook, type HookRegistrationMap } from '@researchdatabox/redbox-core';
import * as path from 'node:path';
import { ModelExports } from './api/models';
import { SERVICENOW_CATALOG_CONFIG_MODEL } from './api/configmodels/ServiceNowCatalogAppConfig';
import type { HookRedboxControllers } from './api/controllers';
import type { HookRedboxServices } from './api/services';
import { auth } from './config/auth';
import { servicenowCatalog } from './config/servicenow';

export {};

const hook = defineRedboxHook({
  initialize(sails, done) {
    sails.after('hook:moduleloader:loaded', () => {
      try {
        const appConfigService = (sails.services as Record<string, unknown>)?.['appconfigservice'] as {
          registerConfigModel?: (model: Record<string, unknown>) => void;
        } | undefined;
        if (appConfigService?.registerConfigModel == null) {
          sails.log.warn(
            'sails-hook-redbox-servicenow-catalog: AppConfigService is unavailable; ' +
            'skipping ServiceNow config model registration.'
          );
          return;
        }
        appConfigService.registerConfigModel({
          ...SERVICENOW_CATALOG_CONFIG_MODEL,
          tsGlob: path.join(__dirname, '../src/api/configmodels/*.ts')
        });
      } catch (error) {
        sails.log.error(
          'sails-hook-redbox-servicenow-catalog: Failed to register the ServiceNow config model:',
          error
        );
      }
    });
    done();
  },
  routes() {
    return {
      before: {},
      after: {
        'POST /:branding/:portal/ws/catalog/rdmp': {
          controller: 'CatalogController',
          action: 'rdmpInfo',
          csrf: false
        },
        'POST /:branding/:portal/ws/catalog/request': {
          controller: 'CatalogController',
          action: 'request',
          csrf: false
        },
        'GET /:branding/:portal/ws/catalog/info': {
          controller: 'CatalogController',
          action: 'info',
          csrf: false
        }
      }
    };
  },
  defaults: {
    __configKey__: {
      _hookTimeout: 120000
    },
    policies: {}
  },
  registerRedboxConfig(): HookRegistrationMap {
    return {
      auth,
      servicenowCatalog
    };
  },
  registerRedboxControllers(): HookRedboxControllers {
    return require('./api/controllers').ControllerExports as HookRedboxControllers;
  },
  registerRedboxServices(): HookRedboxServices {
    return require('./api/services').ServiceExports as HookRedboxServices;
  },
  additionalExports: {
    registerRedboxModels: () => ModelExports,
    ControllerExports: require('./api/controllers').ControllerExports,
    ServiceExports: require('./api/services').ServiceExports
  }
});

module.exports = hook;
