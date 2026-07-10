import { Context } from 'effect';
import type { ServiceNowCatalogConfigData } from '../../configmodels/ServiceNowCatalogAppConfig';
import type { IntegrationAuditContext } from './audit';

/**
 * Per-submission run context shared by every step of the orchestration via the
 * Effect environment, so steps never reach for ambient state to know which
 * record, brand or audit trace they belong to.
 */
export interface SubmitRunContext {
  oid: string;
  rdmpOid: string;
  brandId?: string;
  brandName: string;
  triggeredBy?: string;
  parentAudit: IntegrationAuditContext | null;
}

export const ServiceNowConfigTag = Context.GenericTag<ServiceNowCatalogConfigData>(
  'servicenow-catalog/Config'
);

export const SubmitRunContextTag = Context.GenericTag<SubmitRunContext>(
  'servicenow-catalog/SubmitRunContext'
);
