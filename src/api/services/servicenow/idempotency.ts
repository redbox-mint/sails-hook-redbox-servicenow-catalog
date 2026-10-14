import { createHash, randomUUID } from 'node:crypto';
import type { ServicenowCatalogIdempotencyStatus } from '../../models/ServicenowCatalogIdempotency';

type LedgerRow = {
  id: string;
  claimToken: string;
  status: ServicenowCatalogIdempotencyStatus;
  leaseExpiresAt?: string;
  updatedAt?: string;
};

type DeferredQuery<T> = PromiseLike<T>;

type LedgerModel = {
  create: (values: Record<string, unknown>) => { fetch: () => DeferredQuery<LedgerRow> };
  findOne: (criteria: Record<string, unknown>) => DeferredQuery<LedgerRow | undefined>;
  updateOne: (criteria: Record<string, unknown>) => {
    set: (values: Record<string, unknown>) => DeferredQuery<LedgerRow | undefined>;
  };
};

export type CatalogIdempotencyClaim = {
  id: string;
  claimToken: string;
  recoveredStaleClaim: boolean;
};

export type CatalogIdempotencyClaimDecision =
  | { decision: 'claimed'; claim: CatalogIdempotencyClaim }
  | { decision: 'completed' | 'in-progress' };

function getLedgerModel(): LedgerModel {
  const candidate = Reflect.get(globalThis, 'ServicenowCatalogIdempotency');
  if (candidate == null || typeof candidate !== 'object') {
    throw new Error('ServicenowCatalogIdempotency durable ledger is unavailable.');
  }
  const model = candidate as Partial<LedgerModel>;
  if (
    typeof model.create !== 'function'
    || typeof model.findOne !== 'function'
    || typeof model.updateOne !== 'function'
  ) {
    throw new Error('ServicenowCatalogIdempotency durable ledger is invalid.');
  }
  return model as LedgerModel;
}

function errorCode(error: unknown): unknown {
  if (error == null || typeof error !== 'object') {
    return undefined;
  }
  const direct = Reflect.get(error, 'code');
  if (direct != null) {
    return direct;
  }
  const cause = Reflect.get(error, 'cause');
  return cause != null && typeof cause === 'object' ? Reflect.get(cause, 'code') : undefined;
}

function isUniqueViolation(error: unknown): boolean {
  const code = errorCode(error);
  return code === 'E_UNIQUE' || code === 11000 || code === '11000';
}

function existingDecision(row: LedgerRow | undefined): 'completed' | 'in-progress' {
  return row?.status === 'completed' ? 'completed' : 'in-progress';
}

export const CATALOG_IDEMPOTENCY_CLAIM_LEASE_MS = 5 * 60 * 1000;
export const CATALOG_IDEMPOTENCY_CLAIM_LEASE_SAFETY_MS = 60 * 1000;

export function catalogIdempotencyClaimLeaseMs(totalTimeoutMs: number): number {
  if (!Number.isFinite(totalTimeoutMs) || totalTimeoutMs <= 0) {
    throw new RangeError('ServiceNow orchestration timeout must be a positive finite number.');
  }
  return Math.max(
    CATALOG_IDEMPOTENCY_CLAIM_LEASE_MS,
    Math.ceil(totalTimeoutMs) + CATALOG_IDEMPOTENCY_CLAIM_LEASE_SAFETY_MS
  );
}

export type CatalogIdempotencyScope = {
  redboxOid: string;
  brandId: string;
  catalog: string;
  idempotencyKey: string;
};

/** JSON array encoding keeps every valid component boundary unambiguous. */
export function catalogIdempotencyScope(details: CatalogIdempotencyScope): string {
  return JSON.stringify([
    details.brandId,
    details.redboxOid,
    details.catalog,
    details.idempotencyKey
  ]);
}

function durableClaimId(scope: string): string {
  // sails-mongo requires a custom `_id` string to retain Mongo's 24-hex format.
  // The unhashed scope is also stored in the row's individual fields.
  return createHash('sha256').update(scope).digest('hex').slice(0, 24);
}

export async function claimCatalogIdempotency(
  details: CatalogIdempotencyScope,
  options: {
    leaseDurationMs?: number;
    now?: Date;
  } = {}
): Promise<CatalogIdempotencyClaimDecision> {
  const model = getLedgerModel();
  const claimToken = randomUUID();
  const ledgerId = durableClaimId(catalogIdempotencyScope(details));
  const now = options.now ?? new Date();
  const leaseDurationMs = options.leaseDurationMs ?? CATALOG_IDEMPOTENCY_CLAIM_LEASE_MS;
  if (!Number.isFinite(leaseDurationMs) || leaseDurationMs <= 0) {
    throw new RangeError('ServiceNow idempotency claim lease must be a positive finite number.');
  }
  const leaseExpiresAt = new Date(now.getTime() + leaseDurationMs).toISOString();
  try {
    await model.create({ id: ledgerId, claimToken, status: 'claimed', leaseExpiresAt, ...details }).fetch();
    return { decision: 'claimed', claim: { id: ledgerId, claimToken, recoveredStaleClaim: false } };
  } catch (error) {
    if (!isUniqueViolation(error)) {
      throw error;
    }
  }

  const existing = await model.findOne({ id: ledgerId });
  if (existing?.status === 'completed' || existing?.status === 'uncertain') {
    return { decision: existingDecision(existing) };
  }

  const explicitLeaseTime = Date.parse(existing?.leaseExpiresAt ?? '');
  const updatedTime = Date.parse(existing?.updatedAt ?? '');
  const leaseTime = Number.isFinite(explicitLeaseTime)
    ? explicitLeaseTime
    : updatedTime + CATALOG_IDEMPOTENCY_CLAIM_LEASE_MS;
  const staleClaim = existing?.status === 'claimed'
    && (!Number.isFinite(leaseTime) || leaseTime <= now.getTime());
  if (existing?.status !== 'failed' && !staleClaim) {
    return { decision: existingDecision(existing) };
  }

  const reclaimCriteria = existing?.status === 'failed'
    ? { id: ledgerId, status: 'failed', claimToken: existing.claimToken }
    : {
      id: ledgerId,
      status: 'claimed',
      claimToken: existing?.claimToken,
      ...(existing?.leaseExpiresAt == null ? {} : { leaseExpiresAt: existing.leaseExpiresAt })
    };
  const reclaimed = await model.updateOne(reclaimCriteria).set({
    claimToken,
    status: 'claimed',
    leaseExpiresAt
  });
  return reclaimed == null
    ? { decision: 'in-progress' }
    : {
      decision: 'claimed',
      claim: { id: ledgerId, claimToken, recoveredStaleClaim: staleClaim }
    };
}

export async function concludeCatalogIdempotency(
  claim: CatalogIdempotencyClaim,
  status: Exclude<ServicenowCatalogIdempotencyStatus, 'claimed'>
): Promise<void> {
  const model = getLedgerModel();
  await model.updateOne({ id: claim.id, claimToken: claim.claimToken }).set({ status });
}
