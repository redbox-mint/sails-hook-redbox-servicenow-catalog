import type { ResourceClaim, ResourceClaimModel } from '../../src/api/services/servicenow/resource-claims';
export function resourceModel(): ResourceClaimModel & { rows: Map<string, ResourceClaim> } {
  const rows = new Map<string, ResourceClaim>();
  const match = (criteria: Record<string, unknown>) => [...rows.values()].find(row => Object.entries(criteria).every(([key, value]) => Reflect.get(row, key) === value));
  return { rows,
    create: values => ({ fetch: async () => {
      if (rows.has(values.id)) throw Object.assign(new Error('duplicate'), { code: 'E_UNIQUE' });
      rows.set(values.id, { ...values }); return { ...values };
    } }),
    find: async criteria => [...rows.values()].filter(row => Object.entries(criteria).every(([key, value]) => Reflect.get(row, key) === value)),
    updateOne: criteria => ({ set: async values => { const row = match(criteria); if (!row) return undefined; Object.assign(row, values); return { ...row }; } }),
    destroyOne: async criteria => { const row = match(criteria); if (row) rows.delete(row.id); return row; }
  };
}
