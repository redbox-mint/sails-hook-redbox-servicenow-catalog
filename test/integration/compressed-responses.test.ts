import type { ServiceNowCatalogDefinition } from '../../src/api/configmodels/ServiceNowCatalogAppConfig';
import type { ServicenowCatalogService } from '../../src/api/services/ServicenowCatalogService';
import { listen } from './helpers';

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
      oid, workspace, { catalog: 'compressed', event: 'create' }, { username: 'integration-test' },
      { code: '200', status: true, success: true }
    );
  }

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
        expect(await submit()).to.include({ code: '200', success: true, status: true });
        expect(paths).to.deep.equal(['/oauth', '/catalog']);
        const stored = await portalModel('record').findOne({ redboxOid: oid });
        expect(stored).to.have.property('metadata').that.includes(response.result);
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
    expect(await submit()).to.include({ success: true });
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
      const result = await submit();
      expect(result).to.include({ code: '500', status: false, success: false });
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
      expect(await submit()).to.include({ code: '504', success: false, status: false });
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
