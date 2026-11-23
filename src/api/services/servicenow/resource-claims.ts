import { createHash, randomUUID } from 'node:crypto';
import type { ResourceClaimState } from '../../models/ServicenowCatalogResourceClaim';

export type ResourceClaim = {
  id: string; brandId: string; parentOid: string; resourceKey: string;
  requestOid: string; catalog: string; claimToken: string; state: ResourceClaimState;
};
export interface ResourceClaimModel {
  create(values: ResourceClaim): { fetch(): PromiseLike<ResourceClaim> };
  find(criteria: Record<string, unknown>): PromiseLike<ResourceClaim[]>;
  updateOne(criteria: Record<string, unknown>): { set(values: Partial<ResourceClaim>): PromiseLike<ResourceClaim | undefined> };
  destroyOne(criteria: Record<string, unknown>): PromiseLike<ResourceClaim | undefined>;
}
declare global { var ServicenowCatalogResourceClaim: ResourceClaimModel; }

function model(): ResourceClaimModel {
  if (typeof ServicenowCatalogResourceClaim === 'undefined') throw new Error('ServiceNow resource claim storage is unavailable.');
  return ServicenowCatalogResourceClaim;
}
export function resourceScope(brandId: string, parentOid: string, resourceKey: string): string {
  return JSON.stringify([brandId, parentOid, resourceKey]);
}
export function resourceKeys(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some(key => typeof key !== 'string' || !key.trim() || key !== key.trim())) {
    throw new Error('ServiceNow dispatch resources must be a nonempty array of canonical strings.');
  }
  return [...new Set<string>(value)].sort();
}
function owner(claim: ResourceClaim): Record<string, unknown> {
  return { id: claim.id, claimToken: claim.claimToken, requestOid: claim.requestOid, brandId: claim.brandId, parentOid: claim.parentOid };
}
export class ResourceOccupiedError extends Error {
  constructor(resource: string) { super(`A request already owns resource '${resource}' for this parent record.`); }
}
export async function acquireResources(scope: { brandId: string; parentOid: string; requestOid: string; catalog: string }, keys: string[]): Promise<ResourceClaim[]> {
  const claims: ResourceClaim[] = [];
  try {
    for (const resourceKey of resourceKeys(keys)) {
      const row: ResourceClaim = { ...scope, resourceKey,
        id: createHash('sha256').update(resourceScope(scope.brandId, scope.parentOid, resourceKey)).digest('hex').slice(0, 24),
        claimToken: randomUUID(), state: 'reserved' };
      try { await model().create(row).fetch(); }
      catch (error) {
        const code = error != null && typeof error === 'object' ? Reflect.get(error, 'code') : undefined;
        if (code === 'E_UNIQUE' || code === 11000 || code === '11000') throw new ResourceOccupiedError(resourceKey);
        throw error;
      }
      claims.push(row);
    }
    return claims;
  } catch (error) {
    await releaseReserved(claims);
    throw error;
  }
}
export async function transitionResources(claims: ResourceClaim[], state: Exclude<ResourceClaimState, 'reserved'>): Promise<void> {
  for (const claim of claims) {
    const result = await model().updateOne({ ...owner(claim), state: claim.state }).set({ state });
    if (!result) throw new Error('ServiceNow resource claim ownership was lost; dispatch is blocked.');
    claim.state = state;
  }
}
export async function releaseReserved(claims: ResourceClaim[]): Promise<void> {
  for (const claim of claims) await model().destroyOne({ ...owner(claim), state: 'reserved' });
}
export async function requestResources(brandId: string, requestOid: string): Promise<ResourceClaim[]> {
  return await model().find({ brandId, requestOid });
}
/** Called only after the service verifies an authorised, completed local revert. */
export async function releaseRevertedResources(brandId: string, parentOid: string, requestOid: string): Promise<void> {
  const claims = await model().find({ brandId, parentOid, requestOid });
  if (claims.some(claim => claim.state === 'dispatching' || claim.state === 'reserved')) throw new Error('A request with an unfinished dispatch cannot release its resource claims.');
  for (const claim of claims) {
    if (!await model().destroyOne({ ...owner(claim), state: claim.state })) throw new Error('Resource claim changed during revert; reconciliation is required.');
  }
}
