import type { ServiceNowCatalogDefinition } from '../../src/api/configmodels/ServiceNowCatalogAppConfig';
import type { WorkspaceRecord, ServicenowCatalogService } from '../../src/api/services/ServicenowCatalogService';
import { listen, rejectedSubmission } from './helpers';

const { expect } = require('chai') as { expect: Chai.ExpectStatic };
const { brotliCompressSync, gzipSync, deflateSync, constants } = require('node:zlib') as typeof import('node:zlib');
const { setImmediate: nextTurn } = require('node:timers/promises') as typeof import('node:timers/promises');
const { Cause, Effect, Exit } = require('effect') as typeof import('effect');
const { createDefaultCatalogDefinition } = require(
  '@researchdatabox/sails-hook-redbox-servicenow-catalog/dist/api/configmodels/ServiceNowCatalogAppConfig.js'
) as typeof import('../../src/api/configmodels/ServiceNowCatalogAppConfig');
const { makeLiveClient } = require(
  '@researchdatabox/sails-hook-redbox-servicenow-catalog/dist/api/services/servicenow/http.js'
) as typeof import('../../src/api/services/servicenow/http');
const { CatalogRequestError } = require(
  '@researchdatabox/sails-hook-redbox-servicenow-catalog/dist/api/services/servicenow/errors.js'
) as typeof import('../../src/api/services/servicenow/errors');

const compress = { br: brotliCompressSync, gzip: gzipSync, deflate: deflateSync };

function portalModel(name: string) {
  const model = sails.models[name];
  if (model == null) throw new Error('Portal model is not registered: ' + name);
  return model;
}

async function audits(
  oid: string,
  status: string,
  actions = ['submitCatalogRequest']
): Promise<Record<string, unknown>[]> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const { rows } = await IntegrationAuditService.getAuditLog({
      oid, integrationName: 'servicenow-catalog', page: 1, pageSize: 100
    });
    // Core queues audit writes independently; a root row does not guarantee
    // that every child row has reached Mongo yet.
    if (actions.every(action => rows.some(row => row.integrationAction === action && row.status === status))) {
      return rows;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Terminal integration audit did not persist for ' + oid);
}

// Deterministic, poorly compressible data exercises both network and decoded
// bodies above 1 MiB, rather than a huge string compressed to a single packet.
function largePayload(): string {
  const bytes = Buffer.alloc(1200 * 1024);
  let state = 123456789;
  for (let i = 0; i < bytes.length; i++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    bytes[i] = state & 255;
  }
  return bytes.toString('base64');
}

describe('ServiceNow compressed responses in the portal runtime', function () {
  let originalConfig: unknown;
  let oid: string;
  let workspace: { metadata: Record<string, unknown>; metaMetadata: { brandId: string; type: string; form: string } };
  let seedRevision: number;
  let definition: ServiceNowCatalogDefinition;
  let mock: Awaited<ReturnType<typeof listen>> | undefined;
  let unhandled: unknown[];
  const onUnhandled = (error: unknown) => { unhandled.push(error); };
  let sequence = 0;

  before(async function () {
    console.info('ServiceNow transport runtime:', process.version, 'OpenSSL', process.versions.openssl);
    const branding = BrandingService.getDefault().id;
    // The reusable hook deliberately ships no record types or forms. Register
    // a minimal test-owned type so real core save validation can resolve it.
    await portalModel('recordtype').create({ name: 'compressed-fixture', branding, searchable: false });
    await portalModel('form').create({ name: 'compressed-fixture-form', branding, configuration: { fields: [] } });
  });

  after(async function () {
    await portalModel('form').destroy({ name: 'compressed-fixture-form' });
    await portalModel('recordtype').destroy({ name: 'compressed-fixture' });
  });

  beforeEach(async function () {
    originalConfig = Reflect.get(sails.config, 'servicenowCatalog');
    oid = 'compressed-response-' + ++sequence;
    unhandled = [];
    process.on('unhandledRejection', onUnhandled);
    workspace = {
      metadata: { title: 'Compressed response test', servicenow_status: 'Draft' },
      metaMetadata: { brandId: BrandingService.getDefault().id, type: 'compressed-fixture', form: 'compressed-fixture-form' }
    };
    // Seed a real Mongo record; all mapping write-back uses real RecordsService.
    await portalModel('record').create({ redboxOid: oid, ...workspace, workflow: { stage: 'draft' }, authorization: {} });
    const seedSave = await RecordsService.updateMeta(BrandingService.getDefault(), oid, workspace);
    expect(seedSave.success, JSON.stringify(seedSave)).to.equal(true);
    const revision = (await RecordsService.getMeta(oid)).revision;
    if (typeof revision !== 'number') throw new Error('Seed save returned no revision');
    seedRevision = revision;
    definition = createDefaultCatalogDefinition();
    definition.connection.timeoutMs = 5000;
    definition.connection.totalTimeoutMs = 10000;
    definition.connection.retry = { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, retryOnStatusCodes: [503] };
    definition.responseFields.workspace = ['number', 'sys_id', 'payload'].map(field => ({
      destination: 'metadata.' + field, source: { kind: 'path', path: 'response.result.' + field }
    }));
  });

  afterEach(async function () {
    try {
      await mock?.close();
      mock = undefined;
      await nextTurn();
      expect(unhandled, 'unhandled promise rejections').to.deep.equal([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      Reflect.set(sails.config, 'servicenowCatalog', originalConfig);
      await portalModel('record').destroy({ redboxOid: oid });
    }
  });

  async function submit() {
    definition.connection.url = mock!.url + '/catalog';
    Reflect.set(sails.config, 'servicenowCatalog', { enabled: true, catalogs: { compressed: definition } });
    return (sails.services.servicenowcatalogservice as ServicenowCatalogService).submitRequest(
      oid, workspace, { catalog: 'compressed', event: 'create' }, { username: 'integration-test' });
  }

  it('preserves a concurrent unmapped edit made during the HTTP request', async function () {
    mock = await listen(async (req, res) => {
      req.resume();
      const edited = await RecordsService.mutateMetaInternal({
        actor: { kind: 'service', id: 'ServiceNowFixture.concurrentEdit' }, authorization: { kind: 'service' }, oid,
        triggerPreSaveTriggers: false, triggerPostSaveTriggers: false,
        mutate: snapshot => { snapshot.metadata.concurrent = 'new value'; snapshot.metadata.title = 'Concurrent title'; return snapshot; }
      });
      expect(edited.success).to.equal(true);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ result: { number: 'REQ-CONCURRENT' } }));
    });
    const committed = await submit();
    const stored = await RecordsService.getMeta(oid);
    expect(committed.metadata).to.include({ concurrent: 'new value', title: 'Concurrent title', number: 'REQ-CONCURRENT' });
    expect(stored.metadata).to.include({ concurrent: 'new value', title: 'Concurrent title', number: 'REQ-CONCURRENT' });
    expect(stored).to.have.property('revision', committed.revision);
    expect(committed.revision).to.be.greaterThan(seedRevision + 1);
  });

  it('returns a consistent stored record after a concurrent edit following write-back', async function () {
    mock = await listen((req, res) => {
      req.resume(); res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ result: { number: 'REQ-AFTER-WRITE' } }));
    });
    const originalMutation = RecordsService.mutateMetaInternal;
    let inserted = false;
    RecordsService.mutateMetaInternal = async options => {
      const receipt = await originalMutation(options);
      if (options.actor.id === 'ServicenowCatalogService.responseWriteBack' && receipt.success) {
        inserted = true;
        const edit = await originalMutation({
          actor: { kind: 'service', id: 'ServiceNowFixture.afterWrite' }, authorization: { kind: 'service' }, oid,
          triggerPreSaveTriggers: false, triggerPostSaveTriggers: false,
          mutate: snapshot => { snapshot.metadata.title = 'Edited after write-back'; snapshot.metadata.concurrent = 'preserved'; return snapshot; }
        });
        expect(edit.success, JSON.stringify(edit)).to.equal(true);
      }
      return receipt;
    };
    try {
      const returned = await submit();
      const stored = await RecordsService.getMeta(oid);
      expect(inserted).to.equal(true);
      expect(returned).to.deep.equal(stored);
      expect(returned.metadata).to.include({ title: 'Edited after write-back', concurrent: 'preserved', number: 'REQ-AFTER-WRITE' });
      expect(returned.revision).to.equal(seedRevision + 2);
    } finally {
      RecordsService.mutateMetaInternal = originalMutation;
    }
  });

  for (const concurrentAfterReturn of [false, true]) {
    it(`creates through core onCreate postSync with ${concurrentAfterReturn ? 'a stale returned revision rejected' : 'the plugin stored record adopted'}`, async function () {
      const { createRecordSaveContext } = require('@researchdatabox/redbox-core/dist/RecordSaveResponse') as typeof import('@researchdatabox/redbox-core/dist/RecordSaveResponse');
      mock = await listen((req, res) => {
        req.resume(); res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ result: { number: 'REQ-CORE-CREATE', sys_id: 'core-sys-id', payload: 'mapped' } }));
      });
      definition.connection.url = mock.url + '/catalog';
      Reflect.set(sails.config, 'servicenowCatalog', { enabled: true, catalogs: { compressed: definition } });
      let returned: WorkspaceRecord | undefined;
      let returnedOid: string | undefined;
      let concurrentRevision: number | undefined;
      const service = sails.services.servicenowcatalogservice as ServicenowCatalogService;
      Reflect.set(globalThis, 'serviceNowCreateFixture', async (createdOid: string, record: WorkspaceRecord) => {
        returnedOid = createdOid;
        returned = await service.submitRequest(createdOid, record, { catalog: 'compressed', event: 'create' }, { username: 'integration-test' });
        expect(returned).to.deep.equal(await RecordsService.getMeta(createdOid));
        if (concurrentAfterReturn) {
          const edit = await RecordsService.mutateMetaInternal({
            actor: { kind: 'service', id: 'ServiceNowFixture.afterReturn' }, authorization: { kind: 'service' }, oid: createdOid,
            triggerPreSaveTriggers: false, triggerPostSaveTriggers: false,
            mutate: snapshot => { snapshot.metadata.title = 'Concurrent edit after return'; snapshot.metadata.concurrent = 'preserved'; return snapshot; }
          });
          expect(edit.success, JSON.stringify(edit)).to.equal(true);
          concurrentRevision = (await RecordsService.getMeta(createdOid)).revision;
        }
        return returned;
      });
      const type = await portalModel('recordtype').updateOne({ name: 'compressed-fixture' }).set({
        hooks: { onCreate: { postSync: [{ function: '(oid, record) => globalThis.serviceNowCreateFixture(oid, record)' }] } }
      });
      if (type == null || typeof type !== 'object' || !('id' in type)) throw new Error('Fixture record type missing');
      await portalModel('workflowstep').create({
        name: 'compressed-fixture-draft', recordType: type.id, starting: true,
        config: { form: 'compressed-fixture-form', workflow: { stage: 'compressed-fixture-draft', stageLabel: 'Draft' }, authorization: { viewRoles: [], editRoles: [] } }
      });
      try {
        const response = await RecordsService.create(BrandingService.getDefault(), {
          metadata: { title: 'Core create test' }, metaMetadata: {}
        }, type, { username: 'integration-test' }, true, true, null,
        createRecordSaveContext({ routeFamily: 'internal', operation: 'create' }));
        expect(returned, JSON.stringify(response)).to.exist;
        const stored = await RecordsService.getMeta(returnedOid!);
        expect(stored.metadata).to.include({ number: 'REQ-CORE-CREATE', sys_id: 'core-sys-id', payload: 'mapped' });
        expect(response.concurrency?.revision).to.equal(stored.revision);
        console.info('ServiceNow core create outcome:', JSON.stringify({ concurrentAfterReturn, outcome: response.outcome, problems: response.problems, returnedRevision: returned!.revision, storedRevision: stored.revision }));
        if (concurrentAfterReturn) {
          expect(response.outcome, JSON.stringify(response)).to.equal('saved-with-warnings');
          expect(response.problems.some(problem => problem.issues.some(issue => issue.code === 'record-revision-stale')), JSON.stringify(response)).to.equal(true);
          expect(stored.metadata).to.include({ title: 'Concurrent edit after return', concurrent: 'preserved' });
          expect(stored.revision).to.equal(concurrentRevision);
          expect(stored.revision).to.equal(returned!.revision! + 1);
        } else {
          expect(response.outcome, JSON.stringify(response)).to.equal('saved');
          expect(response.problems).to.deep.equal([]);
          expect(stored.revision).to.equal(returned!.revision! + 1);
        }
      } finally {
        Reflect.deleteProperty(globalThis, 'serviceNowCreateFixture');
        if (returnedOid) await portalModel('record').destroy({ redboxOid: returnedOid });
        await portalModel('workflowstep').destroy({ recordType: type.id });
        await portalModel('recordtype').updateOne({ name: 'compressed-fixture' }).set({ hooks: {} });
      }
    });
  }

  it('does not run configured record-type pre, postSync or detached hooks on write-back', async function () {
    const calls: string[] = [];
    Reflect.set(globalThis, 'serviceNowFixtureCalls', calls);
    const hook = (phase: string) => ({ function: `(oid, record) => { globalThis.serviceNowFixtureCalls.push('${phase}'); return record; }` });
    await portalModel('recordtype').updateOne({ name: 'compressed-fixture' }).set({
      hooks: { onUpdate: { pre: [hook('pre')], postSync: [hook('postSync')], post: [hook('post')] } }
    });
    try {
      // Positive control: the same record type runs all three phases on an ordinary save.
      const control = await RecordsService.updateMeta(BrandingService.getDefault(), oid, await RecordsService.getMeta(oid));
      expect(control.success, JSON.stringify(control)).to.equal(true);
      for (let i = 0; i < 50 && calls.length < 3; i++) await new Promise(resolve => setTimeout(resolve, 20));
      expect(calls).to.deep.equal(['pre', 'postSync', 'post']);
      calls.length = 0;
      mock = await listen((req, res) => {
        req.resume(); res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ result: { number: 'REQ-NO-HOOKS' } }));
      });
      const committed = await submit();
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(calls).to.deep.equal([]);
      expect(committed.revision).to.equal((await RecordsService.getMeta(oid)).revision);
    } finally {
      await portalModel('recordtype').updateOne({ name: 'compressed-fixture' }).set({ hooks: {} });
      Reflect.deleteProperty(globalThis, 'serviceNowFixtureCalls');
    }
  });

  it('throws a definite HTTP failure and persists Failed without response mappings', async function () {
    mock = await listen((req, res) => {
      req.resume(); res.statusCode = 503; res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'unavailable' }));
    });
    const error = await rejectedSubmission(submit());
    expect(error).to.include({ oid, code: '503', uncertain: false, tag: 'CatalogRequestError' });
    expect((await RecordsService.getMeta(oid)).metadata.servicenow_status).to.equal('Failed');
    await audits(oid, 'failed');
  });

  for (const encoding of ['br', 'gzip', 'deflate'] as const) {
    for (const doubleEncoded of [false, true]) {
      it(`persists ${encoding} ${doubleEncoded ? 'double-encoded JSON' : 'JSON'} with a Brotli OAuth token`, async function () {
        const response = { result: { number: 'REQ-' + encoding, sys_id: 'sys-' + encoding, payload: 'mapped' } };
        const paths: string[] = [];
        mock = await listen((req, res) => {
          paths.push(req.url!);
          req.resume();
          res.setHeader('Content-Type', 'application/json');
          if (req.url === '/oauth') {
            res.setHeader('Content-Encoding', 'br');
            res.end(brotliCompressSync(Buffer.from(JSON.stringify({ access_token: 'private-test-token' }))));
          } else {
            expect(req.headers.authorization).to.equal('Bearer private-test-token');
            expect(req.headers['accept-encoding']).to.include(encoding);
            res.statusCode = 201;
            res.setHeader('Content-Encoding', encoding);
            const json = JSON.stringify(response);
            res.end(compress[encoding](Buffer.from(doubleEncoded ? JSON.stringify(json) : json)));
          }
        });
        definition.oauth = {
          enabled: true, url: mock.url + '/oauth', grantType: 'client_credentials',
          clientId: 'public-client', clientSecret: 'private-client-secret'
        };
        const committed = await submit();
        expect(paths).to.deep.equal(['/oauth', '/catalog']);
        const stored = await portalModel('record').findOne({ redboxOid: oid });
        expect(stored).to.have.property('metadata').that.includes(response.result);
        expect(stored).to.have.property('revision', committed.revision);
        expect(committed.revision).to.be.greaterThan(seedRevision);
        const rows = await audits(oid, 'success', [
          'submitCatalogRequest', 'oauthTokenRequest', 'catalogOrderRequest', 'workspaceMetadataUpdate'
        ]);
        for (const action of ['oauthTokenRequest', 'catalogOrderRequest', 'workspaceMetadataUpdate']) {
          expect(rows.some(row => row.integrationAction === action && row.status === 'success'), action).to.equal(true);
        }
        expect(JSON.stringify(rows)).not.to.include('private-test-token');
        expect(JSON.stringify(rows)).not.to.include('private-client-secret');
      });
    }
  }

  it('persists a double-encoded Brotli body larger than 1 MiB delivered in many chunks', async function () {
    const payload = largePayload();
    const body = brotliCompressSync(Buffer.from(JSON.stringify(JSON.stringify({
      result: { number: 'REQ-LARGE', sys_id: 'sys-large', payload }
    }))), { params: { [constants.BROTLI_PARAM_QUALITY]: 1 } });
    expect(body.length).to.be.greaterThan(1024 * 1024);
    let chunks = 0;
    mock = await listen(async (req, res) => {
      req.resume();
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Encoding', 'br');
      for (let offset = 0; offset < body.length; offset += 16 * 1024) {
        res.write(body.subarray(offset, offset + 16 * 1024));
        chunks++;
        await nextTurn();
      }
      res.end();
    });
    expect(await submit()).to.have.nested.property('metadata.number', 'REQ-LARGE');
    expect(chunks).to.be.greaterThan(64);
    const stored = await portalModel('record').findOne({ redboxOid: oid });
    expect(stored).to.have.property('metadata').that.includes({ number: 'REQ-LARGE', sys_id: 'sys-large', payload });
    await audits(oid, 'success');
  });

  for (const damaged of ['corrupt', 'truncated'] as const) {
    it(`fails ${damaged} Brotli with a non-retryable typed error and persistent redacted failure audits`, async function () {
      const complete = brotliCompressSync(Buffer.from(JSON.stringify({ result: { number: 'REQ-DAMAGED' } })));
      const body = damaged === 'corrupt' ? Buffer.from([255, 255, 255, 255]) : complete.subarray(0, complete.length >> 1);
      let attempts = 0;
      mock = await listen((req, res) => {
        req.resume();
        attempts++;
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Encoding', 'br');
        res.end(body);
      });
      definition.connection.url = mock.url + '/catalog';
      definition.connection.headers.Authorization = 'Bearer private-catalog-token';
      definition.connection.retry.maxAttempts = 3;
      const exit = await Effect.runPromiseExit(makeLiveClient(definition, {
        oid, catalog: 'compressed', event: 'create', brandId: workspace.metaMetadata.brandId,
        brandName: 'default', parentAudit: null, now: '2026-10-26T00:00:00.000Z'
      }).submitCatalogOrder({ password: 'private-request-password' }));
      expect(Exit.isFailure(exit)).to.equal(true);
      if (Exit.isFailure(exit)) {
        const error = Cause.findErrorOption(exit.cause);
        expect(error._tag).to.equal('Some');
        if (error._tag === 'Some') {
          expect(error.value).to.be.instanceOf(CatalogRequestError);
          expect(error.value).to.include({ _tag: 'CatalogRequestError', retryable: false });
        }
      }
      expect(attempts).to.equal(1);
      definition.bodyTemplate.password = 'private-request-password';
      const result = await rejectedSubmission(submit());
      expect(result).to.include({ code: '500', uncertain: true, tag: 'CatalogRequestError' });
      expect(result.message).to.include('could not be decompressed (br)');
      expect(attempts).to.equal(2); // One direct client call and one full submission; neither retried.
      const stored = await portalModel('record').findOne({ redboxOid: oid });
      expect(stored).to.have.property('metadata').that.includes({ title: 'Compressed response test', servicenow_status: 'Uncertain' });
      expect(stored).not.to.have.nested.property('metadata.number');
      const rows = await audits(oid, 'failed', ['submitCatalogRequest', 'catalogOrderRequest']);
      expect(rows.some(row => row.integrationAction === 'catalogOrderRequest' && row.status === 'failed')).to.equal(true);
      const serialized = JSON.stringify({ rows, result });
      for (const secret of ['private-catalog-token', 'private-request-password']) {
        expect(serialized).not.to.include(secret);
      }
    });
  }

  for (const phase of ['catalog', 'oauth', 'orchestration'] as const) {
    it(`aborts the in-flight ${phase} request and releases its socket before server shutdown`, async function () {
      let attempts = 0;
      let closed!: () => void;
      const socketClosed = new Promise<void>(resolve => { closed = resolve; });
      mock = await listen((req, res) => {
        req.resume();
        attempts++;
        // Never schedule a delayed response: only cancellation can close it.
        res.socket!.once('close', closed);
      });
      definition.connection.timeoutMs = phase === 'orchestration' ? 5000 : 150;
      definition.connection.totalTimeoutMs = phase === 'orchestration' ? 150 : 5000;
      if (phase === 'oauth') {
        definition.oauth = {
          enabled: true, url: mock.url + '/oauth', grantType: 'client_credentials',
          clientId: 'client', clientSecret: 'private-client-secret'
        };
      }
      expect(await rejectedSubmission(submit())).to.include({ code: '504' });
      // Bound the wait and close naturally, without closeAllConnections hiding a leak.
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([socketClosed, new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Aborted request leaked a socket')), 1000);
        })]);
      } finally {
        clearTimeout(timer);
      }
      expect(attempts).to.equal(1);
      await audits(oid, 'failed');
    });
  }
});
