import { Data } from 'effect';

/** Typed failure channel for the ServiceNow catalog orchestration. */

export class ServiceNowConfigError extends Data.TaggedError('ServiceNowConfigError')<{
  oid: string;
  reason: string;
  httpCode?: string;
}> {}

export class UnknownCatalogError extends Data.TaggedError('UnknownCatalogError')<{
  oid: string;
  catalog: string;
}> {}

export class ParentRecordRequiredError extends Data.TaggedError('ParentRecordRequiredError')<{
  oid: string;
  catalog: string;
}> {}

export class ParentAssociationError extends Data.TaggedError('ParentAssociationError')<{
  oid: string;
  parentRecordOid: string;
  cause: unknown;
}> {}

export class ParentLookupError extends Data.TaggedError('ParentLookupError')<{
  oid: string;
  parentRecordOid: string;
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

export class ParentUpdateError extends Data.TaggedError('ParentUpdateError')<{
  oid: string;
  parentRecordOid: string;
  cause: unknown;
}> {}

export class DuplicateSubmissionError extends Data.TaggedError('DuplicateSubmissionError')<{
  oid: string;
  catalog: string;
  idempotencyKey: string;
  state: 'completed' | 'in-progress';
}> {}

export class IdempotencyLookupError extends Data.TaggedError('IdempotencyLookupError')<{
  oid: string;
  catalog: string;
  idempotencyKey: string;
  cause: unknown;
}> {}

export type ServiceNowCatalogError =
  | ServiceNowConfigError
  | UnknownCatalogError
  | ParentRecordRequiredError
  | ParentAssociationError
  | ParentLookupError
  | MappingError
  | OAuthTokenError
  | CatalogRequestError
  | CatalogTimeoutError
  | WorkspaceUpdateError
  | ParentUpdateError
  | DuplicateSubmissionError
  | IdempotencyLookupError;

export function causeMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** HTTP-style code reported back on the trigger response for each failure kind. */
export function errorHttpCode(error: ServiceNowCatalogError): string {
  switch (error._tag) {
    case 'ServiceNowConfigError':
      return error.httpCode ?? '500';
    case 'UnknownCatalogError':
    case 'ParentRecordRequiredError':
      return '400';
    case 'DuplicateSubmissionError':
      return '409';
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
    case 'UnknownCatalogError':
      return "Unknown ServiceNow catalog '" + error.catalog + "'.";
    case 'ParentRecordRequiredError':
      return "ServiceNow catalog '" + error.catalog + "' requires a non-empty parent record OID.";
    case 'ParentAssociationError':
      return 'Failed to associate workspace ' + error.oid + ' with parent record ' + error.parentRecordOid + ': ' + causeMessage(error.cause);
    case 'ParentLookupError':
      return 'Failed to load parent record ' + error.parentRecordOid + ' for workspace ' + error.oid + ': ' + causeMessage(error.cause);
    case 'MappingError':
      return "Failed to evaluate field mapping for '" + error.destination + "': " + causeMessage(error.cause);
    case 'OAuthTokenError':
      return 'ServiceNow OAuth token request failed: ' + error.reason;
    case 'CatalogRequestError':
      return error.statusCode != null
        ? 'ServiceNow catalog request failed with status ' + error.statusCode + '.'
        : 'ServiceNow catalog request failed: ' + causeMessage(error.cause);
    case 'CatalogTimeoutError':
      return error.phase === 'request'
        ? 'ServiceNow catalog request timed out after ' + error.timeoutMs + 'ms.'
        : 'ServiceNow catalog orchestration exceeded its ' + error.timeoutMs + 'ms budget.';
    case 'WorkspaceUpdateError':
      return 'Failed to update workspace ' + error.oid + ' with the ServiceNow response: ' + causeMessage(error.cause);
    case 'ParentUpdateError':
      return 'Failed to update parent record ' + error.parentRecordOid + ' for workspace ' + error.oid + ': ' + causeMessage(error.cause);
    case 'DuplicateSubmissionError':
      return error.state === 'completed'
        ? "ServiceNow catalog '" + error.catalog + "' already accepted idempotency key '" + error.idempotencyKey + "' for workspace " + error.oid + '.'
        : "ServiceNow catalog '" + error.catalog + "' has an uncertain or in-progress submission for idempotency key '" + error.idempotencyKey + "'.";
    case 'IdempotencyLookupError':
      return "Cannot verify idempotency state for ServiceNow catalog '" + error.catalog + "': " + causeMessage(error.cause);
  }
}
