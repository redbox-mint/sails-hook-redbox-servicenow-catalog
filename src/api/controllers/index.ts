import type { CatalogController as CatalogControllerExports } from './CatalogController';

export type HookRedboxControllers = {
  CatalogController: CatalogControllerExports;
};

const controllerCache: Partial<HookRedboxControllers> = {};

function getOrCreateController<K extends keyof HookRedboxControllers>(
  name: K,
  factory: () => HookRedboxControllers[K]
): HookRedboxControllers[K] {
  if (!controllerCache[name]) {
    controllerCache[name] = factory();
  }
  return controllerCache[name] as HookRedboxControllers[K];
}

export const ControllerExports = {
  get CatalogController(): CatalogControllerExports {
    return getOrCreateController(
      'CatalogController',
      () => require('./CatalogController') as CatalogControllerExports
    );
  }
};
