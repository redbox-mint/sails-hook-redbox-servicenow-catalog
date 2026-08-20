import type { IntegrationOutcomeMapper } from '@researchdatabox/redbox-core';
import { Cause, Effect, Exit } from 'effect';

/**
 * IntegrationAuditService bridge for the ServiceNow catalog integration.
 *
 * The structural types below mirror the core service's public surface
 * (`startAudit`/`completeAudit`/`failAudit`); the published redbox-core barrel
 * does not re-export them, so they are declared locally and the runtime service
 * is resolved off the Sails-injected global — guarded so orchestration never
 * fails because auditing is unavailable.
 */

export const SERVICENOW_INTEGRATION_NAME = 'servicenow-catalog' as const;

export const ServiceNowAuditAction = {
  submitCatalogRequest: 'submitCatalogRequest',
  idempotencyDecision: 'idempotencyDecision',
  parentLookup: 'parentLookup',
  associateWorkspace: 'associateWorkspace',
  catalogOrderRequest: 'catalogOrderRequest',
  oauthTokenRequest: 'oauthTokenRequest',
  workspaceMetadataUpdate: 'workspaceMetadataUpdate',
  parentMetadataUpdate: 'parentMetadataUpdate'
} as const;

export type ServiceNowAuditAction = (typeof ServiceNowAuditAction)[keyof typeof ServiceNowAuditAction];

export type IntegrationAuditContext = {
  redboxOid: string;
  brandId?: string;
  integrationName: string;
  integrationAction: string;
  triggeredBy?: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  startedAt: string;
  requestSummary?: Record<string, unknown>;
};

type StartAuditOptions = {
  brandId?: string;
  integrationName?: string;
  triggeredBy?: string;
  requestSummary?: Record<string, unknown>;
  traceId?: string;
  parentSpanId?: string;
};

type IntegrationAuditServiceShape = {
  startAudit: (oid: string, action: string, opts?: StartAuditOptions) => IntegrationAuditContext;
  completeAudit: (ctx: IntegrationAuditContext | null | undefined, result?: Record<string, unknown>) => void;
  failAudit: (ctx: IntegrationAuditContext | null | undefined, error: unknown, details?: Record<string, unknown>) => void;
  registerOutcomeMapper?: (integrationName: string, mapper: IntegrationOutcomeMapper) => void;
  getAuditLog?: (params: {
    oid: string;
    integrationName?: string;
    page?: number;
    pageSize?: number;
  }) => Promise<{ rows: Record<string, unknown>[]; total: number }>;
};

export function getAuditService(): IntegrationAuditServiceShape | undefined {
  const globals = globalThis as {
    IntegrationAuditService?: IntegrationAuditServiceShape;
    sails?: { services?: Record<string, unknown> };
  };
  const candidate = globals.IntegrationAuditService
    ?? globals.sails?.services?.['integrationauditservice'] as IntegrationAuditServiceShape | undefined;
  if (candidate == null || typeof candidate !== 'object' || typeof candidate.startAudit !== 'function') {
    return undefined;
  }
  return candidate;
}

function outcome(state: string, severity: 'none' | 'in-progress' | 'success' | 'error', withHelp = false) {
  return {
    state,
    severity,
    labelKey: `@integration-status-outcome-${SERVICENOW_INTEGRATION_NAME}-${state}`,
    helpKey: withHelp
      ? `@integration-status-outcome-${SERVICENOW_INTEGRATION_NAME}-${state}-help`
      : undefined
  };
}

/** User-facing status mapping consumed by the core integration-status component. */
export const mapServiceNowOutcome: IntegrationOutcomeMapper = summary => {
  switch (summary.status) {
    case 'started':
      return outcome('in-progress', 'in-progress');
    case 'failed':
      return outcome('error', 'error', true);
    case 'success':
      return outcome('provisioned', 'success');
    case 'none':
      return outcome('none', 'none');
    default:
      return undefined;
  }
};

export function registerServiceNowOutcomeMapper(): boolean {
  const service = getAuditService();
  if (service?.registerOutcomeMapper == null) {
    return false;
  }
  try {
    service.registerOutcomeMapper(SERVICENOW_INTEGRATION_NAME, mapServiceNowOutcome);
    return true;
  } catch {
    return false;
  }
}

export type StartCatalogAuditOptions = {
  brandId?: string;
  triggeredBy?: string;
  requestSummary?: Record<string, unknown>;
  parent?: IntegrationAuditContext | null;
};

export function startCatalogAudit(
  oid: string,
  action: ServiceNowAuditAction,
  options: StartCatalogAuditOptions = {}
): IntegrationAuditContext | null {
  const service = getAuditService();
  if (service == null) {
    return null;
  }
  try {
    return service.startAudit(oid, action, {
      integrationName: SERVICENOW_INTEGRATION_NAME,
      brandId: options.brandId,
      triggeredBy: options.triggeredBy,
      requestSummary: options.requestSummary,
      traceId: options.parent?.traceId,
      parentSpanId: options.parent?.spanId
    });
  } catch {
    return null;
  }
}

export function completeCatalogAudit(
  ctx: IntegrationAuditContext | null | undefined,
  result: Record<string, unknown> = {}
): void {
  const service = getAuditService();
  if (ctx == null || service == null) {
    return;
  }
  try {
    service.completeAudit(ctx, result);
  } catch {
    // Auditing must never break the integration itself.
  }
}

export function failCatalogAudit(
  ctx: IntegrationAuditContext | null | undefined,
  error: unknown,
  details: Record<string, unknown> = {}
): void {
  const service = getAuditService();
  if (ctx == null || service == null) {
    return;
  }
  try {
    service.failAudit(ctx, error, details);
  } catch {
    // Auditing must never break the integration itself.
  }
}

export type WithAuditOptions<A> = StartCatalogAuditOptions & {
  onSuccess?: (value: A) => Record<string, unknown>;
  onFailure?: (error: unknown) => Record<string, unknown>;
};

function safeAuditDetails<A>(factory: ((value: A) => Record<string, unknown>) | undefined, value: A) {
  if (factory == null) {
    return {};
  }
  try {
    return factory(value);
  } catch {
    return {};
  }
}

/**
 * Wraps an effect in an audit span: opens the audit when the effect starts and
 * closes it from the effect's `Exit`, so success, typed failure, defects and
 * interruption are all recorded. Interruption is audited as a failure with an
 * explicit message rather than being lost.
 */
export function withIntegrationAudit<A, E, R>(
  oid: string,
  action: ServiceNowAuditAction,
  options: WithAuditOptions<A> = {}
) {
  return (self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.suspend(() => {
      const ctx = startCatalogAudit(oid, action, options);
      return self.pipe(
        Effect.onExit(exit =>
          Effect.sync(() => {
            if (Exit.isSuccess(exit)) {
              completeCatalogAudit(ctx, safeAuditDetails(options.onSuccess, exit.value));
            } else if (Exit.isInterrupted(exit)) {
              failCatalogAudit(ctx, 'interrupted', {
                message: `ServiceNow catalog step '${action}' was interrupted before completion.`,
                requestSummary: { submissionCertainty: 'uncertain' }
              });
            } else {
              const error = Cause.squash(exit.cause);
              failCatalogAudit(ctx, error, safeAuditDetails(options.onFailure, error));
            }
          })
        )
      );
    });
}


export type CatalogIdempotencyDecision = 'clear' | 'completed' | 'in-progress';

function rowSummary(row: Record<string, unknown>): Record<string, unknown> {
  const value = row.requestSummary;
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/**
 * Consults the persistent core audit log. Failed traces are retryable; a
 * successful trace is a duplicate, while a started trace without a terminal
 * entry is treated as uncertain because ServiceNow may already have accepted it.
 */
export async function getCatalogIdempotencyDecision(
  oid: string,
  catalog: string,
  idempotencyKey: string
): Promise<CatalogIdempotencyDecision> {
  const service = getAuditService();
  if (service?.getAuditLog == null) {
    throw new Error('IntegrationAuditService does not expose persistent audit lookup.');
  }

  const rows: Record<string, unknown>[] = [];
  const pageSize = 500;
  let page = 1;
  let total = 0;
  do {
    const result = await service.getAuditLog({
      oid,
      integrationName: SERVICENOW_INTEGRATION_NAME,
      page,
      pageSize
    });
    rows.push(...result.rows);
    total = result.total;
    page += 1;
  } while (rows.length < total);

  const matching = rows.filter(row => {
    if (
      row.integrationName !== SERVICENOW_INTEGRATION_NAME
      || row.integrationAction !== ServiceNowAuditAction.submitCatalogRequest
    ) {
      return false;
    }
    const summary = rowSummary(row);
    return summary.catalog === catalog && summary.idempotencyKey === idempotencyKey;
  });
  if (matching.length === 0) {
    return 'clear';
  }

  const statusesBySpan = new Map<string, Set<string>>();
  const uncertainSpans = new Set<string>();
  matching.forEach((row, index) => {
    const spanIdentity = String(row.spanId ?? row.traceId ?? 'audit-row-' + index);
    const statuses = statusesBySpan.get(spanIdentity) ?? new Set<string>();
    statuses.add(String(row.status ?? ''));
    statusesBySpan.set(spanIdentity, statuses);
    if (rowSummary(row).submissionCertainty === 'uncertain') {
      uncertainSpans.add(spanIdentity);
    }
  });

  for (const statuses of statusesBySpan.values()) {
    if (statuses.has('success')) {
      return 'completed';
    }
  }
  for (const spanIdentity of uncertainSpans) {
    if (statusesBySpan.get(spanIdentity)?.has('failed')) {
      return 'in-progress';
    }
  }
  for (const statuses of statusesBySpan.values()) {
    if (statuses.has('started') && !statuses.has('failed')) {
      return 'in-progress';
    }
  }
  return 'clear';
}
