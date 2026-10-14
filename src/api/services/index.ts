import type { ServicenowCatalogService as ServicenowCatalogServiceExports } from './ServicenowCatalogService';

export type HookRedboxServices = {
  ServicenowCatalogService: ServicenowCatalogServiceExports;
};

const serviceCache: Partial<HookRedboxServices> = {};

function getOrCreateService<K extends keyof HookRedboxServices>(
  name: K,
  factory: () => HookRedboxServices[K]
): HookRedboxServices[K] {
  if (!(name in serviceCache)) {
    serviceCache[name] = factory();
  }
  return serviceCache[name] as HookRedboxServices[K];
}

export const ServiceExports = {
  get ServicenowCatalogService(): ServicenowCatalogServiceExports {
    return getOrCreateService(
      'ServicenowCatalogService',
      () => require('./ServicenowCatalogService') as ServicenowCatalogServiceExports
    );
  }
};
