import {
  DEFAULT_SERVICENOW_CATALOG_NAME,
  ServiceNowCatalogAppConfig,
  createDefaultCatalogDefinition,
  type ServiceNowCatalogConfigData,
  type ServiceNowCatalogDefinition,
  type ServiceNowFieldMapping
} from '../../configmodels/ServiceNowCatalogAppConfig';

export type DeprecationLogger = (message: string) => void;

export interface ResolvedServiceNowCatalog {
  enabled: unknown;
  catalog?: ServiceNowCatalogDefinition;
  usedLegacyShape: boolean;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

/** Merges override into base recursively; arrays and primitives replace wholesale. */
export function mergeConfig<T>(base: T, override: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return (override === undefined ? base : override) as T;
  }
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    merged[key] = mergeConfig(merged[key], value);
  }
  return merged as T;
}

function legacyResponseFields(value: unknown): {
  workspace: ServiceNowFieldMapping[];
  parentRecord: ServiceNowFieldMapping[];
} | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return {
    workspace: value as ServiceNowFieldMapping[],
    parentRecord: []
  };
}

function isLegacyCatalogShape(value: Record<string, unknown>): boolean {
  return !isPlainObject(value.catalogs) && [
    'connection',
    'oauth',
    'bodyTemplate',
    'requestFields',
    'responseFields'
  ].some(key => Object.prototype.hasOwnProperty.call(value, key));
}

/**
 * Converts the temporary v1 single-catalog shape into a catalog named default.
 * The returned value is deliberately partial at this stage; catalog defaults are
 * applied only after hook and brand layers have been merged.
 */
export interface NormalizedServiceNowCatalogConfig {
  enabled: unknown;
  catalogs: Record<string, unknown>;
}

export function normalizeServiceNowCatalogConfig(
  input: unknown,
  warn?: DeprecationLogger
): { config: NormalizedServiceNowCatalogConfig; usedLegacyShape: boolean } {
  if (!isPlainObject(input)) {
    const defaults = new ServiceNowCatalogAppConfig();
    return { config: { enabled: defaults.enabled, catalogs: defaults.catalogs }, usedLegacyShape: false };
  }

  if (!isLegacyCatalogShape(input)) {
    return {
      config: {
        enabled: input.enabled ?? false,
        catalogs: isPlainObject(input.catalogs) ? input.catalogs : {}
      },
      usedLegacyShape: false
    };
  }

  warn?.(
    "The single-catalog servicenowCatalog configuration is deprecated; move it under servicenowCatalog.catalogs.'" +
    DEFAULT_SERVICENOW_CATALOG_NAME + "'."
  );
  const responseFields = legacyResponseFields(input.responseFields);
  const legacyDefinition: Record<string, unknown> = {
    enabled: input.enabled ?? true,
    connection: input.connection,
    oauth: input.oauth,
    bodyTemplate: input.bodyTemplate,
    requestFields: input.requestFields,
    responseFields
  };
  for (const key of Object.keys(legacyDefinition)) {
    if (legacyDefinition[key] === undefined) {
      delete legacyDefinition[key];
    }
  }
  return {
    config: {
      enabled: input.enabled ?? false,
      catalogs: {
        [DEFAULT_SERVICENOW_CATALOG_NAME]: legacyDefinition
      }
    },
    usedLegacyShape: true
  };
}

/** Resolve one named catalog with brand configuration taking precedence over hook defaults. */
export function resolveServiceNowCatalog(
  catalogName: string,
  hookConfig: unknown,
  brandConfig: unknown,
  warn?: DeprecationLogger
): ResolvedServiceNowCatalog {
  const defaults = new ServiceNowCatalogAppConfig();
  const hook = normalizeServiceNowCatalogConfig(hookConfig, warn);
  const brand = normalizeServiceNowCatalogConfig(brandConfig, warn);
  const hookHasEnabled = isPlainObject(hookConfig)
    && Object.prototype.hasOwnProperty.call(hookConfig, 'enabled');
  const brandHasEnabled = isPlainObject(brandConfig)
    && Object.prototype.hasOwnProperty.call(brandConfig, 'enabled');
  const enabled = brandHasEnabled
    ? brand.config.enabled
    : hookHasEnabled
      ? hook.config.enabled
      : defaults.enabled;
  const hookCatalog = hook.config.catalogs[catalogName];
  const brandCatalog = brand.config.catalogs[catalogName];
  const catalog = hookCatalog == null && brandCatalog == null
    ? undefined
    : mergeConfig(
      mergeConfig(createDefaultCatalogDefinition(), hookCatalog),
      brandCatalog
    );

  return {
    enabled,
    catalog,
    usedLegacyShape: hook.usedLegacyShape || brand.usedLegacyShape
  };
}
