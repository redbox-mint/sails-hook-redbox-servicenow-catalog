import { Context } from 'effect';
import type { ServiceNowCatalogDefinition } from '../../configmodels/ServiceNowCatalogAppConfig';
import type { IntegrationAuditContext } from './audit';

export interface ServiceNowTriggerOptions {
  catalog: string;
  event: 'create' | 'update' | 'delete' | string;
  idempotencyKey?: string;
  parentRecordOid?: string;
}

export interface ServiceNowTriggerContext extends ServiceNowTriggerOptions {
  idempotencyKey?: string;
  parentRecordOid?: string;
}

/** Per-submission state shared by every Effect step. */
export interface SubmitRunContext {
  oid: string;
  catalog: string;
  event: string;
  idempotencyKey?: string;
  parentRecordOid?: string;
  brandId?: string;
  brandName: string;
  triggeredBy?: string;
  parentAudit: IntegrationAuditContext | null;
  now: string;
}

export const ServiceNowConfigTag = Context.GenericTag<ServiceNowCatalogDefinition>(
  'servicenow-catalog/Config'
);

export const SubmitRunContextTag = Context.GenericTag<SubmitRunContext>(
  'servicenow-catalog/SubmitRunContext'
);
