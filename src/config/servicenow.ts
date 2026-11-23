import {
  ServiceNowCatalogAppConfig,
  type ServiceNowCatalogConfigData
} from '../api/configmodels/ServiceNowCatalogAppConfig';

/**
 * Hook-level fallback defaults. Brand application configuration with the same
 * key overrides these values at runtime.
 */
export const servicenowCatalog: ServiceNowCatalogConfigData = new ServiceNowCatalogAppConfig();
