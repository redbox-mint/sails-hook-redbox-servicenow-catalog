import type { ServiceNowCatalogDefinition } from '../../configmodels/ServiceNowCatalogAppConfig';

/** Normalize JSON-encoded root response strings without changing ordinary strings or objects. */
export function normalizeServiceNowResponse(
  data: unknown,
  config: Pick<ServiceNowCatalogDefinition, 'responseNormalization'>
): unknown {
  if (config.responseNormalization?.parseJsonString === false || typeof data !== 'string') {
    return data;
  }
  try {
    return JSON.parse(data) as unknown;
  } catch {
    return data;
  }
}
