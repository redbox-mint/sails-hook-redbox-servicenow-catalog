/** Shared ownership independent of request OID/catalog. */
const { expect } = require('@researchdatabox/redbox-dev-tools/testing') as { expect: Chai.ExpectStatic };
const claims = require('../../dist/api/services/servicenow/resource-claims') as typeof import('../../src/api/services/servicenow/resource-claims');

const { resourceModel } = require('../support/resource-claims') as typeof import('../support/resource-claims');
const scope = { brandId: 'brand', parentOid: 'parent', requestOid: 'request-a', catalog: 'storage' };
describe('Shared resource claims', () => {
  let model: ReturnType<typeof resourceModel>;
  beforeEach(() => { model = resourceModel(); Reflect.set(globalThis, 'ServicenowCatalogResourceClaim', model); });
  afterEach(() => Reflect.deleteProperty(globalThis, 'ServicenowCatalogResourceClaim'));
  it('allows only one request/catalog to claim the same parent option and keeps other tuples independent', async () => {
    const outcomes = await Promise.allSettled([
      claims.acquireResources(scope, ['resource-a']),
      claims.acquireResources({ ...scope, requestOid: 'request-b', catalog: 'other' }, ['resource-a'])
    ]);
    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).to.have.length(1);
    await claims.acquireResources({ ...scope, brandId: 'other' }, ['resource-a']);
    await claims.acquireResources(scope, ['resource-b']);
    expect(model.rows.size).to.equal(3);
  });
  it('rolls back only this attempt when combined resource acquisition loses', async () => {
    const held = await claims.acquireResources(scope, ['resource-b']);
    let error: unknown;
    try { await claims.acquireResources({ ...scope, requestOid: 'request-b' }, ['resource-b', 'resource-a']); } catch (cause) { error = cause; }
    expect(error).to.be.instanceOf(claims.ResourceOccupiedError);
    expect([...model.rows.keys()]).to.deep.equal([held[0]!.id]);
  });
  it('retains dispatched/uncertain claims, checks ownership and releases only confirmed reverts', async () => {
    const owned = await claims.acquireResources(scope, ['resource-a']);
    await claims.transitionResources(owned, 'dispatching');
    await claims.releaseReserved(owned);
    expect(model.rows.size).to.equal(1);
    await claims.transitionResources(owned, 'uncertain');
    await claims.releaseRevertedResources('brand', 'parent', 'someone-else');
    expect(model.rows.size).to.equal(1);
    let error: unknown;
    try { await claims.transitionResources([{ ...owned[0]!, claimToken: 'forged' }], 'submitted'); } catch (cause) { error = cause; }
    expect(error).to.be.instanceOf(Error);
    await claims.releaseRevertedResources('brand', 'parent', 'request-a');
    expect(model.rows.size).to.equal(0);
  });
  it('rejects missing/invalid resources and unavailable persistence', async () => {
    for (const value of [undefined, [], 'resource-a', [' resource-a'], [{}]]) expect(() => claims.resourceKeys(value)).to.throw();
    Reflect.deleteProperty(globalThis, 'ServicenowCatalogResourceClaim');
    let error: unknown;
    try { await claims.acquireResources(scope, ['resource-a']); } catch (cause) { error = cause; }
    expect(error).to.be.instanceOf(Error);
  });
});
