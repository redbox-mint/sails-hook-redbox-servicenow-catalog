import { Data } from 'effect';

/**
 * Typed failure channel for the ServiceNow catalog orchestration. Every step fails
 * with one of these tagged errors so callers can discriminate on `_tag` instead of
 * parsing messages, and the audit/response layers can derive HTTP codes uniformly.
 */

export class ServiceNowConfigError extends Data.TaggedError('ServiceNowConfigError')<{
  oid: string;
  reason: string;
  httpCode?: string;
}> {}

export class WorkspaceAssociationError extends Data.TaggedError('WorkspaceAssociationError')<{
  oid: string;
  rdmpOid: string;
  cause: unknown;
}> {}

export class RdmpLookupError extends Data.TaggedError('RdmpLookupError')<{
  oid: string;
  rdmpOid: string;
  cause: unknown;
}> {}

export class MappingError extends Data.TaggedError('MappingError')<{
  oid: string;
  destination: string;
  cause: unknown;
}> {}

export class OAuthTokenError extends Data.TaggedError('OAuthTokenError')<{
  oid: string;
  reason: string;
  statusCode?: number;
  cause?: unknown;
}> {}

export class CatalogRequestError extends Data.TaggedError('CatalogRequestError')<{
  oid: string;
  statusCode?: number;
  responseBody?: unknown;
  retryable: boolean;
  cause?: unknown;
}> {}

export class CatalogTimeoutError extends Data.TaggedError('CatalogTimeoutError')<{
  oid: string;
  timeoutMs: number;
  phase: 'request' | 'orchestration';
}> {}

export class WorkspaceUpdateError extends Data.TaggedError('WorkspaceUpdateError')<{
  oid: string;
  cause: unknown;
}> {}

export type ServiceNowCatalogError =
  | ServiceNowConfigError
  | WorkspaceAssociationError
  | RdmpLookupError
  | MappingError
  | OAuthTokenError
  | CatalogRequestError
  | CatalogTimeoutError
  | WorkspaceUpdateError;

export function causeMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** HTTP-style code reported back on the trigger response for each failure kind. */
export function errorHttpCode(error: ServiceNowCatalogError): string {
  switch (error._tag) {
    case 'ServiceNowConfigError':
      return error.httpCode ?? '500';
    case 'CatalogRequestError':
      return error.statusCode != null ? String(error.statusCode) : '500';
    case 'OAuthTokenError':
      return error.statusCode != null ? String(error.statusCode) : '500';
    case 'CatalogTimeoutError':
      return '504';
    default:
      return '500';
  }
}

/** Operator-facing description of the failure, safe to log and audit. */
export function errorDescription(error: ServiceNowCatalogError): string {
  switch (error._tag) {
    case 'ServiceNowConfigError':
      return error.reason;
    case 'WorkspaceAssociationError':
      return `Failed to associate workspace ${error.oid} with parent record ${error.rdmpOid}: ${causeMessage(error.cause)}`;
    case 'RdmpLookupError':
      return `Failed to load parent RDMP ${error.rdmpOid} for workspace ${error.oid}: ${causeMessage(error.cause)}`;
    case 'MappingError':
      return `Failed to evaluate field mapping for '${error.destination}': ${causeMessage(error.cause)}`;
    case 'OAuthTokenError':
      return `ServiceNow OAuth token request failed: ${error.reason}`;
    case 'CatalogRequestError':
      return error.statusCode != null
        ? `ServiceNow catalog request failed with status ${error.statusCode}.`
        : `ServiceNow catalog request failed: ${causeMessage(error.cause)}`;
    case 'CatalogTimeoutError':
      return error.phase === 'request'
        ? `ServiceNow catalog request timed out after ${error.timeoutMs}ms.`
        : `ServiceNow catalog orchestration exceeded its ${error.timeoutMs}ms budget.`;
    case 'WorkspaceUpdateError':
      return `Failed to update workspace ${error.oid} with the ServiceNow response: ${causeMessage(error.cause)}`;
  }
}
