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
  responseBody?: unknown;
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

const MAX_RESPONSE_SUMMARY_LENGTH = 1000;
const MAX_RESPONSE_SUMMARY_DEPTH = 5;
const MAX_RESPONSE_SUMMARY_ITEMS = 20;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return normalized.includes('token')
    || normalized.includes('authorization')
    || normalized.includes('secret')
    || normalized.includes('apikey')
    || normalized.includes('api_key')
    || normalized.includes('password')
    || normalized.includes('credential');
}

/**
 * Keep upstream diagnostics useful without allowing a remote response to
 * inject credentials, circular data, or an unbounded payload into logs/audit.
 */
function summarizeResponseValue(
  value: unknown,
  depth = 0,
  visited: WeakSet<object> = new WeakSet<object>()
): unknown {
  if (typeof value === 'string') {
    return value.length > MAX_RESPONSE_SUMMARY_LENGTH
      ? value.slice(0, MAX_RESPONSE_SUMMARY_LENGTH) + '…'
      : value;
  }
  if (value == null || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (depth >= MAX_RESPONSE_SUMMARY_DEPTH) {
    return '[Truncated]';
  }
  if (visited.has(value)) {
    return '[Circular]';
  }
  visited.add(value);
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_RESPONSE_SUMMARY_ITEMS)
      .map(item => summarizeResponseValue(item, depth + 1, visited));
  }
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    result[key] = isSensitiveKey(key)
      ? 'REDACTED'
      : summarizeResponseValue(entry, depth + 1, visited);
  }
  return result;
}

function responseBodyFor(error: ServiceNowCatalogError): unknown {
  if (error._tag === 'CatalogRequestError' || error._tag === 'OAuthTokenError') {
    return error.responseBody;
  }
  return undefined;
}

/** A bounded/redacted response payload suitable for IntegrationAuditService. */
export function errorResponseSummary(error: ServiceNowCatalogError): Record<string, unknown> | undefined {
  const body = responseBodyFor(error);
  if (body == null) {
    return undefined;
  }
  const summarized = summarizeResponseValue(body);
  if (isRecord(summarized)) {
    return summarized;
  }
  if (Array.isArray(summarized)) {
    return { items: summarized };
  }
  return { value: summarized };
}

/** A short actionable detail for logs and the trigger response. */
export function errorResponseMessage(error: ServiceNowCatalogError): string | undefined {
  const summary = errorResponseSummary(error);
  if (summary == null) {
    return undefined;
  }
  const message = typeof summary.message === 'string' ? summary.message : undefined;
  const errorName = typeof summary.error === 'string' ? summary.error : undefined;
  if (message != null && errorName != null && errorName !== message) {
    return errorName + ': ' + message;
  }
  if (message != null) {
    return message;
  }
  if (errorName != null) {
    return errorName;
  }
  const serialized = JSON.stringify(summary);
  return serialized.length > MAX_RESPONSE_SUMMARY_LENGTH
    ? serialized.slice(0, MAX_RESPONSE_SUMMARY_LENGTH) + '…'
    : serialized;
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
      return 'ServiceNow OAuth token request failed: ' + error.reason
        + (errorResponseMessage(error) == null ? '' : ' Upstream response: ' + errorResponseMessage(error));
    case 'CatalogRequestError':
      return (error.statusCode != null
        ? 'ServiceNow catalog request failed with status ' + error.statusCode + '.'
        : 'ServiceNow catalog request failed: ' + causeMessage(error.cause))
        + (errorResponseMessage(error) == null ? '' : ' Upstream response: ' + errorResponseMessage(error));
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
