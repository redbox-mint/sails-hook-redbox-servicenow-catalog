import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { ServiceNowCatalogDefinition } from '../../src/api/configmodels/ServiceNowCatalogAppConfig';
import type { ServicenowCatalogService } from '../../src/api/services/ServicenowCatalogService';
import type { IntegrationAuditContext } from '../../src/api/services/servicenow/audit';

const http = require('node:http') as typeof import('node:http');
const { mock } = require('node:test') as typeof import('node:test');
const { expect } = require('@researchdatabox/redbox-dev-tools/testing') as { expect: Chai.ExpectStatic };
const {
  clearHookTestGlobals,
  createTestIdempotencyLedger,
  getTestSails,
  installHookTestGlobals,
  setHookTestGlobal
} = require('../support/globals') as typeof import('../support/globals');
const { createDefaultCatalogDefinition } = require(
  '../../dist/api/configmodels/ServiceNowCatalogAppConfig.js'
) as typeof import('../../src/api/configmodels/ServiceNowCatalogAppConfig');

type CapturedRequest = {
  body: Record<string, unknown>;
  headers: IncomingMessage['headers'];
  method?: string;
};

type AuditRow = Record<string, unknown>;

type TestAuditService = ReturnType<typeof makeAuditService>;

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

async function listen(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>
): Promise<{ server: Server; url: string }> {
  const server = http.createServer((req, res) => {
    void handler(req, res);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address == null || typeof address === 'string') {
    throw new Error('Test server did not expose a TCP address.');
  }
  return { server, url: 'http://127.0.0.1:' + address.port };
}

function makeAuditService(rows: AuditRow[] = []) {
  let sequence = 0;
  const scopedRows = rows.map(row => ({
    integrationName: 'servicenow-catalog',
    ...row
  }));
  const startAudit = mock.fn((
    oid: string,
    action: string,
    opts: Record<string, unknown> = {}
  ): IntegrationAuditContext => {
    sequence += 1;
    return {
      redboxOid: oid,
      brandId: typeof opts.brandId === 'string' ? opts.brandId : undefined,
      integrationName: String(opts.integrationName ?? ''),
      integrationAction: action,
      triggeredBy: typeof opts.triggeredBy === 'string' ? opts.triggeredBy : undefined,
      traceId: String(opts.traceId ?? 'trace-' + sequence),
      spanId: 'span-' + sequence,
      parentSpanId: typeof opts.parentSpanId === 'string' ? opts.parentSpanId : undefined,
      startedAt: new Date().toISOString(),
      requestSummary: opts.requestSummary as Record<string, unknown> | undefined
    };
  });
  return {
    startAudit,
    completeAudit: mock.fn((_context: IntegrationAuditContext, _details?: Record<string, unknown>) => undefined),
    failAudit: mock.fn((
      _context: IntegrationAuditContext,
      _error: unknown,
      _details?: Record<string, unknown>
    ) => undefined),
    getAuditLog: mock.fn(async (_params?: Record<string, unknown>) => ({
      rows: scopedRows,
      total: scopedRows.length
    })),
    registerOutcomeMapper: mock.fn((_name: string, _mapper: unknown) => undefined)
  };
}

function configureBrandAndCatalog(
  config: ServiceNowCatalogDefinition,
  brandCatalogOverride?: Record<string, unknown>
): void {
  const testSails = getTestSails();
  Reflect.set(testSails.config, 'servicenowCatalog', {
    enabled: true,
    catalogs: { 'storage-new': config }
  });
  Reflect.set(testSails.config, 'brandingAware', () => brandCatalogOverride == null
    ? undefined
    : {
      servicenowCatalog: {
        catalogs: { 'storage-new': brandCatalogOverride }
      }
    });
  setHookTestGlobal('BrandingService', {
    getBrandById: (brandId: string) => brandId === 'brand-id'
      ? { id: 'brand-id', name: 'brand-a' }
      : undefined
  });
  setHookTestGlobal('TranslationService', {
    t: (key: string) => key
  });
}

function workspace(metadata: Record<string, unknown> = {}): {
  metadata: Record<string, unknown>;
  metaMetadata: { brandId: string };
} {
  return {
    metadata,
    metaMetadata: { brandId: 'brand-id' }
  };
}

function successResponse(): { code: string; status: boolean; success: boolean } {
  return { code: '200', status: true, success: true };
}

describe('ServiceNow catalog orchestration', function () {
  let activeServer: Server | undefined;
  let service: ServicenowCatalogService;

  beforeEach(() => {
    installHookTestGlobals();
    service = require('../../dist/api/services/ServicenowCatalogService.js') as ServicenowCatalogService;
  });

  afterEach(async () => {
    mock.restoreAll();
    clearHookTestGlobals();
    if (activeServer != null) {
      await new Promise<void>((resolve, reject) => {
        activeServer?.close(error => error == null ? resolve() : reject(error));
        activeServer?.closeAllConnections();
      });
      activeServer = undefined;
    }
  });

  it('runs named request mapping, optional parent association, split write-back, and nested audits', async function () {
    const captured: CapturedRequest[] = [];
    const testServer = await listen(async (req, res) => {
      captured.push({ body: await readJson(req), headers: req.headers, method: req.method });
      res.statusCode = 201;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ result: { number: 'REQ001234', sys_id: 'sys-123', state: 'Accepted' } }));
    });
    activeServer = testServer.server;

    const config = createDefaultCatalogDefinition();
    config.connection.url = testServer.url + '/catalog';
    config.connection.headers = { 'X-Integration': 'redbox' };
    config.connection.retry = {
      maxAttempts: 1,
      baseDelayMs: 0,
      maxDelayMs: 0,
      retryOnStatusCodes: []
    };
    config.parentRecord = { oid: { kind: 'path', path: 'workspace.metadata.parentOid' } };
    config.requestFields = [
      {
        destination: 'variables.short_description',
        source: { kind: 'path', path: 'workspace.metadata.title' }
      },
      {
        destination: 'variables.plan',
        source: { kind: 'handlebars', template: '{{parentRecord.metadata.title}} ({{brand}})' }
      },
      {
        destination: 'variables.event',
        source: { kind: 'jsonata', expression: 'trigger.event' }
      }
    ];
    config.responseFields = {
      workspace: [{
        destination: 'metadata.servicenow_number',
        source: { kind: 'path', path: 'response.result.number' }
      }],
      parentRecord: [{
        destination: 'metadata.servicenow_sys_id',
        source: { kind: 'path', path: 'response.result.sys_id' }
      }]
    };
    configureBrandAndCatalog(config, { connection: { url: testServer.url + '/brand-catalog' } });

    const addWorkspaceToRecord = mock.fn(async (_parentOid: string, _workspaceOid: string) => ({ status: true }));
    setHookTestGlobal('WorkspaceService', { addWorkspaceToRecord });
    const parent = { metadata: { title: 'Plan A', existing: 'keep' } };
    const getMeta = mock.fn(async (oid: string) => {
      if (oid !== 'parent-1') {
        throw new Error('Unexpected record ' + oid);
      }
      return parent;
    });
    const updateMeta = mock.fn(async (
      _brand: unknown,
      _oid: string,
      _record: Record<string, unknown>
    ) => ({ status: true }));
    setHookTestGlobal('RecordsService', { getMeta, updateMeta });
    const audit = makeAuditService();
    setHookTestGlobal('IntegrationAuditService', audit);

    const submittedWorkspace = workspace({
      parentOid: 'parent-1',
      title: 'Research storage',
      status: 'Draft'
    });
    const triggerResponse = successResponse();
    const result = await service.submitRequest(
      'workspace-1',
      submittedWorkspace,
      { catalog: 'storage-new', event: 'create' },
      { username: 'researcher@example.edu' },
      triggerResponse
    );

    expect(result).to.equal(triggerResponse);
    expect(captured).to.have.length(1);
    expect(captured[0].method).to.equal('POST');
    expect(captured[0].headers['x-integration']).to.equal('redbox');
    expect(captured[0].body).to.deep.equal({
      sysparm_quantity: '1',
      get_portal_messages: 'true',
      variables: {
        short_description: 'Research storage',
        plan: 'Plan A (brand-a)',
        event: 'create'
      }
    });
    expect(addWorkspaceToRecord.mock.calls[0].arguments).to.deep.equal(['parent-1', 'workspace-1']);
    expect(getMeta.mock.calls[0].arguments).to.deep.equal(['parent-1']);
    expect(updateMeta.mock.calls).to.have.length(2);
    expect(updateMeta.mock.calls[0].arguments[1]).to.equal('workspace-1');
    expect(updateMeta.mock.calls[0].arguments[2]).to.have.nested.property(
      'metadata.servicenow_number',
      'REQ001234'
    );
    expect(submittedWorkspace).to.have.nested.property(
      'metadata.servicenow_number',
      'REQ001234'
    );
    expect(updateMeta.mock.calls[0].arguments[2]).to.have.nested.property('metadata.status', 'Draft');
    expect(updateMeta.mock.calls[1].arguments[1]).to.equal('parent-1');
    expect(updateMeta.mock.calls[1].arguments[2]).to.deep.equal({
      metadata: { title: 'Plan A', existing: 'keep', servicenow_sys_id: 'sys-123' }
    });

    const actions = audit.startAudit.mock.calls.map(call => call.arguments[1]);
    expect(actions).to.deep.equal([
      'submitCatalogRequest',
      'parentLookup',
      'associateWorkspace',
      'catalogOrderRequest',
      'workspaceMetadataUpdate',
      'parentMetadataUpdate'
    ]);
    const parentContext = audit.startAudit.mock.calls[0]?.result;
    expect(parentContext).to.exist;
    if (parentContext != null) {
      for (const childCall of audit.startAudit.mock.calls.slice(1)) {
        expect(childCall.arguments[2]).to.include({
          traceId: parentContext.traceId,
          parentSpanId: parentContext.spanId
        });
      }
    }
    expect(audit.failAudit.mock.calls).to.have.length(0);
  });

  it('submits without parent lookup, association, or metadata writes when none are configured', async function () {
    let requests = 0;
    const testServer = await listen(async (_req, res) => {
      requests += 1;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ result: { number: 'REQ-NO-PARENT' } }));
    });
    activeServer = testServer.server;
    const config = createDefaultCatalogDefinition();
    config.connection.url = testServer.url + '/catalog';
    configureBrandAndCatalog(config);
    const audit = makeAuditService();
    setHookTestGlobal('IntegrationAuditService', audit);

    const result = await service.submitRequest(
      'workspace-no-parent',
      workspace({ title: 'No parent' }),
      { catalog: 'storage-new', event: 'update' },
      undefined,
      successResponse()
    );

    expect(result).to.include({ status: true, success: true });
    expect(requests).to.equal(1);
    expect(audit.startAudit.mock.calls.map(call => call.arguments[1])).to.deep.equal([
      'submitCatalogRequest',
      'catalogOrderRequest'
    ]);
  });

  it('rejects missing trigger context, unknown catalogs, and skips disabled catalogs', async function () {
    const config = createDefaultCatalogDefinition();
    config.connection.url = 'https://example.service-now.com/catalog';
    configureBrandAndCatalog(config);

    const missingCatalog = await service.submitRequest(
      'workspace-options',
      workspace(),
      { catalog: '', event: 'create' },
      undefined,
      {}
    );
    expect(missingCatalog).to.include({ code: '400', status: false, success: false });

    const unknown = await service.submitRequest(
      'workspace-unknown',
      workspace(),
      { catalog: 'does-not-exist', event: 'create' },
      undefined,
      {}
    );
    expect(unknown).to.include({ code: '400', status: false, success: false });
    expect(unknown.message).to.contain("Unknown ServiceNow catalog 'does-not-exist'");

    config.enabled = false;
    configureBrandAndCatalog(config);
    const disabledResponse = successResponse();
    const disabled = await service.submitRequest(
      'workspace-disabled',
      workspace(),
      { catalog: 'storage-new', event: 'create' },
      undefined,
      disabledResponse
    );
    expect(disabled).to.equal(disabledResponse);
  });

  it('fails a configured parent with an empty OID before making an external request', async function () {
    const config = createDefaultCatalogDefinition();
    config.connection.url = 'https://example.service-now.com/catalog';
    config.parentRecord = { oid: { kind: 'path', path: 'workspace.metadata.parentOid' } };
    configureBrandAndCatalog(config);
    const audit = makeAuditService();
    setHookTestGlobal('IntegrationAuditService', audit);

    const result = await service.submitRequest(
      'workspace-missing-parent',
      workspace(),
      { catalog: 'storage-new', event: 'create' },
      undefined,
      {}
    );

    expect(result).to.include({ code: '400', status: false, success: false });
    expect(result.message).to.contain('requires a non-empty parent record OID');
    expect(audit.startAudit.mock.calls[0].arguments[1]).to.equal('submitCatalogRequest');
    expect(audit.failAudit.mock.calls).to.have.length(1);
  });

  it('audits association failure and never calls ServiceNow or deletes the workspace', async function () {
    let requests = 0;
    const testServer = await listen(async (_req, res) => {
      requests += 1;
      res.end('{}');
    });
    activeServer = testServer.server;
    const config = createDefaultCatalogDefinition();
    config.connection.url = testServer.url + '/catalog';
    config.parentRecord = { oid: { kind: 'path', path: 'workspace.metadata.parentOid' } };
    configureBrandAndCatalog(config);
    setHookTestGlobal('WorkspaceService', {
      addWorkspaceToRecord: mock.fn(async (_parentOid: string, _workspaceOid: string) => {
        throw new Error('association unavailable');
      })
    });
    const updateMeta = mock.fn(async () => ({ status: true }));
    setHookTestGlobal('RecordsService', {
      getMeta: mock.fn(async () => ({ metadata: { title: 'Parent' } })),
      updateMeta
    });
    const audit = makeAuditService();
    setHookTestGlobal('IntegrationAuditService', audit);
    const submittedWorkspace = workspace({ parentOid: 'parent-1', title: 'Preserve me' });
    const original = structuredClone(submittedWorkspace);

    const result = await service.submitRequest(
      'workspace-association-failure',
      submittedWorkspace,
      { catalog: 'storage-new', event: 'create' },
      undefined,
      {}
    );

    expect(result).to.include({ code: '500', status: false, success: false });
    expect(requests).to.equal(0);
    expect(updateMeta.mock.calls).to.have.length(1);
    expect(updateMeta.mock.calls[0].arguments[1]).to.equal('workspace-association-failure');
    expect(updateMeta.mock.calls[0].arguments[2]).to.have.nested.property(
      'metadata.servicenow_status',
      'Failed'
    );
    expect(submittedWorkspace).to.deep.equal(original);
    expect(audit.failAudit.mock.calls.length).to.be.greaterThan(0);
  });

  it('preserves the saved workspace after a bounded ServiceNow failure', async function () {
    const testServer = await listen(async (_req, res) => {
      res.statusCode = 503;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'unavailable' }));
    });
    activeServer = testServer.server;
    const config = createDefaultCatalogDefinition();
    config.connection.url = testServer.url + '/catalog';
    config.connection.retry = {
      maxAttempts: 1,
      baseDelayMs: 0,
      maxDelayMs: 0,
      retryOnStatusCodes: [503]
    };
    config.responseFields.workspace = [{
      destination: 'metadata.number',
      source: { kind: 'path', path: 'response.result.number' }
    }];
    configureBrandAndCatalog(config);
    const updateMeta = mock.fn(async () => ({ status: true }));
    setHookTestGlobal('RecordsService', { updateMeta });
    const audit = makeAuditService();
    setHookTestGlobal('IntegrationAuditService', audit);
    const submittedWorkspace = workspace({ title: 'Preserve me' });
    const original = structuredClone(submittedWorkspace);

    const result = await service.submitRequest(
      'workspace-http-failure',
      submittedWorkspace,
      { catalog: 'storage-new', event: 'update' },
      undefined,
      {}
    );

    expect(result).to.include({ code: '503', status: false, success: false });
    expect(result.message).to.contain('unavailable');
    expect(updateMeta.mock.calls).to.have.length(1);
    expect(updateMeta.mock.calls[0].arguments[1]).to.equal('workspace-http-failure');
    expect(updateMeta.mock.calls[0].arguments[2]).to.have.nested.property(
      'metadata.servicenow_status',
      'Failed'
    );
    expect(submittedWorkspace).to.deep.equal(original);
    const catalogFailure = audit.failAudit.mock.calls.find(call =>
      call.arguments[0]?.integrationAction === 'catalogOrderRequest'
    );
    expect(catalogFailure).to.exist;
    expect(catalogFailure?.arguments[2]?.responseSummary).to.deep.equal({ error: 'unavailable' });
  });

  it('rejects prior successful and interrupted idempotency keys', async function () {
    const config = createDefaultCatalogDefinition();
    config.connection.url = 'https://example.service-now.com/catalog';
    config.idempotency = { enabled: true };
    configureBrandAndCatalog(config);

    for (const prior of [
      {
        rows: [{ status: 'success', uncertain: false }],
        expectedState: 'already accepted'
      },
      {
        rows: [
          { status: 'started', uncertain: false },
          { status: 'failed', uncertain: true }
        ],
        expectedState: 'uncertain or in-progress'
      }
    ]) {
      setHookTestGlobal('ServicenowCatalogIdempotency', createTestIdempotencyLedger());
      const audit = makeAuditService(prior.rows.map(row => ({
        integrationAction: 'submitCatalogRequest',
        status: row.status,
        spanId: 'prior-span',
        requestSummary: {
          catalog: 'storage-new',
          idempotencyKey: 'stable-key',
          ...(row.uncertain ? { submissionCertainty: 'uncertain' } : {})
        }
      })));
      setHookTestGlobal('IntegrationAuditService', audit);
      const result = await service.submitRequest(
        'workspace-idempotent',
        workspace(),
        { catalog: 'storage-new', event: 'create', idempotencyKey: 'stable-key' },
        undefined,
        {}
      );
      expect(result).to.include({ code: '409', status: false, success: false });
      expect(result.message).to.contain(prior.expectedState);
    }
  });

  it('ignores matching audit rows owned by another integration', async function () {
    const audit = makeAuditService([{
      integrationName: 'another-integration',
      integrationAction: 'submitCatalogRequest',
      status: 'success',
      spanId: 'foreign-span',
      requestSummary: {
        catalog: 'storage-new',
        idempotencyKey: 'shared-key'
      }
    }]);
    setHookTestGlobal('IntegrationAuditService', audit);
    const {
      getCatalogIdempotencyDecision
    } = require(
      '../../dist/api/services/servicenow/audit.js'
    ) as typeof import('../../src/api/services/servicenow/audit');

    const decision = await getCatalogIdempotencyDecision(
      'workspace-shared-audit',
      'storage-new',
      'shared-key'
    );

    expect(decision).to.equal('clear');
    expect(audit.getAuditLog.mock.calls[0].arguments[0]).to.include({
      integrationName: 'servicenow-catalog'
    });
  });

  it('permits retry after a failed idempotent trace and propagates the stable key to audit', async function () {
    const testServer = await listen(async (_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ result: { number: 'REQ-RETRY' } }));
    });
    activeServer = testServer.server;
    const config = createDefaultCatalogDefinition();
    config.connection.url = testServer.url + '/catalog';
    config.idempotency = { enabled: true };
    configureBrandAndCatalog(config);
    const audit = makeAuditService([
      {
        integrationAction: 'submitCatalogRequest',
        status: 'started',
        spanId: 'failed-span',
        requestSummary: { catalog: 'storage-new', idempotencyKey: 'retry-key' }
      },
      {
        integrationAction: 'submitCatalogRequest',
        status: 'failed',
        spanId: 'failed-span',
        requestSummary: { catalog: 'storage-new', idempotencyKey: 'retry-key' }
      }
    ]);
    setHookTestGlobal('IntegrationAuditService', audit);

    const result = await service.submitRequest(
      'workspace-retry',
      workspace(),
      { catalog: 'storage-new', event: 'update', idempotencyKey: 'retry-key' },
      undefined,
      successResponse()
    );

    expect(result).to.include({ status: true, success: true });
    expect(audit.getAuditLog.mock.calls).to.have.length(1);
    const submitAudit = audit.startAudit.mock.calls.find(
      call => call.arguments[1] === 'submitCatalogRequest'
    );
    expect(submitAudit?.arguments[2]).to.have.nested.property(
      'requestSummary.idempotencyKey',
      'retry-key'
    );
  });

  it('atomically rejects a concurrent request before an awaited audit lookup can race', async function () {
    let requests = 0;
    const testServer = await listen(async (_req, res) => {
      requests += 1;
      await new Promise(resolve => setTimeout(resolve, 25));
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ result: { number: 'REQ-CONCURRENT' } }));
    });
    activeServer = testServer.server;
    const config = createDefaultCatalogDefinition();
    config.connection.url = testServer.url + '/catalog';
    config.idempotency = { enabled: true };
    configureBrandAndCatalog(config);
    const audit = makeAuditService();
    audit.getAuditLog = mock.fn(async () => {
      await new Promise(resolve => setTimeout(resolve, 25));
      return { rows: [], total: 0 };
    });
    setHookTestGlobal('IntegrationAuditService', audit);

    const results = await Promise.all([
      service.submitRequest(
        'workspace-concurrent',
        workspace(),
        { catalog: 'storage-new', event: 'create', idempotencyKey: 'concurrent-key' },
        undefined,
        successResponse()
      ),
      service.submitRequest(
        'workspace-concurrent',
        workspace(),
        { catalog: 'storage-new', event: 'create', idempotencyKey: 'concurrent-key' },
        undefined,
        successResponse()
      )
    ]);

    expect(requests).to.equal(1);
    expect(results.filter(result => result.status === true)).to.have.length(1);
    expect(results.filter(result => result.code === '409')).to.have.length(1);
  });

  it('blocks an immediate retry from the durable completed claim before audit visibility', async function () {
    let requests = 0;
    const testServer = await listen(async (_req, res) => {
      requests += 1;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ result: { number: 'REQ-COMPLETE' } }));
    });
    activeServer = testServer.server;
    const config = createDefaultCatalogDefinition();
    config.connection.url = testServer.url + '/catalog';
    config.idempotency = { enabled: true };
    configureBrandAndCatalog(config);
    setHookTestGlobal('IntegrationAuditService', makeAuditService());

    const first = await service.submitRequest(
      'workspace-immediate',
      workspace(),
      { catalog: 'storage-new', event: 'create', idempotencyKey: 'immediate-key' },
      undefined,
      successResponse()
    );
    const retry = await service.submitRequest(
      'workspace-immediate',
      workspace(),
      { catalog: 'storage-new', event: 'create', idempotencyKey: 'immediate-key' },
      undefined,
      {}
    );

    expect(first.status).to.equal(true);
    expect(retry).to.include({ code: '409', status: false });
    expect(requests).to.equal(1);
  });

  it('persists an interrupted submission as uncertain and blocks its retry', async function () {
    let requestStarted: (() => void) | undefined;
    const started = new Promise<void>(resolve => {
      requestStarted = resolve;
    });
    let requests = 0;
    const testServer = await listen(async () => {
      requests += 1;
      requestStarted?.();
    });
    activeServer = testServer.server;
    const config = createDefaultCatalogDefinition();
    config.connection.url = testServer.url + '/catalog';
    config.idempotency = { enabled: true };
    configureBrandAndCatalog(config);
    const audit = makeAuditService();
    setHookTestGlobal('IntegrationAuditService', audit);
    const handlers: Record<string, () => void> = {};
    getTestSails().on = (event: string, handler: () => void) => {
      handlers[event] = handler;
    };
    service.init();

    const submission = service.submitRequest(
      'workspace-interrupted',
      workspace(),
      { catalog: 'storage-new', event: 'create', idempotencyKey: 'interrupted-key' },
      undefined,
      {}
    );
    await started;
    handlers.lower();
    const interrupted = await submission;
    const retry = await service.submitRequest(
      'workspace-interrupted',
      workspace(),
      { catalog: 'storage-new', event: 'create', idempotencyKey: 'interrupted-key' },
      undefined,
      {}
    );

    expect(interrupted).to.include({ code: '503', status: false });
    expect(retry).to.include({ code: '409', status: false });
    expect(requests).to.equal(1);
    expect(audit.failAudit.mock.calls.some(call => {
      const details = call.arguments[2];
      const summary = details?.requestSummary as Record<string, unknown> | undefined;
      return summary?.submissionCertainty === 'uncertain';
    })).to.equal(true);
  });

  it('reclaims an expired crash-before-submission claim after a clear audit reconciliation', async function () {
    let requests = 0;
    const testServer = await listen(async (_req, res) => {
      requests += 1;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ result: { number: 'REQ-RECOVERED' } }));
    });
    activeServer = testServer.server;
    const config = createDefaultCatalogDefinition();
    config.connection.url = testServer.url + '/catalog';
    config.idempotency = { enabled: true };
    configureBrandAndCatalog(config);
    setHookTestGlobal('IntegrationAuditService', makeAuditService());
    const ledger = createTestIdempotencyLedger();
    setHookTestGlobal('ServicenowCatalogIdempotency', ledger);
    const {
      CATALOG_IDEMPOTENCY_CLAIM_LEASE_MS,
      claimCatalogIdempotency
    } = require(
      '../../dist/api/services/servicenow/idempotency.js'
    ) as typeof import('../../src/api/services/servicenow/idempotency');
    const details = {
      redboxOid: 'workspace-crashed-before-submit',
      brandId: 'brand-id',
      catalog: 'storage-new',
      idempotencyKey: 'crashed-key'
    };
    const crashedClaim = await claimCatalogIdempotency(
      details,
      { now: new Date(Date.now() - CATALOG_IDEMPOTENCY_CLAIM_LEASE_MS - 1) }
    );
    expect(crashedClaim.decision).to.equal('claimed');

    const result = await service.submitRequest(
      details.redboxOid,
      workspace(),
      { catalog: details.catalog, event: 'create', idempotencyKey: details.idempotencyKey },
      undefined,
      successResponse()
    );

    expect(result).to.include({ status: true, success: true });
    expect(requests).to.equal(1);
    expect([...ledger.rows.values()][0]?.status).to.equal('completed');
  });

  it('reconciles an expired claim left by a crash before ledger conclusion', async function () {
    const config = createDefaultCatalogDefinition();
    config.connection.url = 'https://example.service-now.com/catalog';
    config.idempotency = { enabled: true };
    configureBrandAndCatalog(config);
    const details = {
      redboxOid: 'workspace-crashed-after-submit',
      brandId: 'brand-id',
      catalog: 'storage-new',
      idempotencyKey: 'accepted-key'
    };
    setHookTestGlobal('IntegrationAuditService', makeAuditService([{
      integrationAction: 'submitCatalogRequest',
      status: 'success',
      spanId: 'accepted-span',
      requestSummary: {
        catalog: details.catalog,
        idempotencyKey: details.idempotencyKey
      }
    }]));
    const ledger = createTestIdempotencyLedger();
    setHookTestGlobal('ServicenowCatalogIdempotency', ledger);
    const {
      CATALOG_IDEMPOTENCY_CLAIM_LEASE_MS,
      claimCatalogIdempotency
    } = require(
      '../../dist/api/services/servicenow/idempotency.js'
    ) as typeof import('../../src/api/services/servicenow/idempotency');
    const crashedClaim = await claimCatalogIdempotency(
      details,
      { now: new Date(Date.now() - CATALOG_IDEMPOTENCY_CLAIM_LEASE_MS - 1) }
    );
    expect(crashedClaim.decision).to.equal('claimed');

    const retry = await service.submitRequest(
      details.redboxOid,
      workspace(),
      { catalog: details.catalog, event: 'create', idempotencyKey: details.idempotencyKey },
      undefined,
      {}
    );

    expect(retry).to.include({ code: '409', status: false });
    expect([...ledger.rows.values()][0]?.status).to.equal('completed');
  });

  it('keeps delimiter-containing idempotency scopes distinct', async function () {
    const {
      catalogIdempotencyScope,
      claimCatalogIdempotency
    } = require(
      '../../dist/api/services/servicenow/idempotency.js'
    ) as typeof import('../../src/api/services/servicenow/idempotency');
    const ledger = createTestIdempotencyLedger();
    setHookTestGlobal('ServicenowCatalogIdempotency', ledger);
    const first = {
      redboxOid: 'workspace-scope',
      brandId: 'brand-id',
      catalog: 'a',
      idempotencyKey: 'b:c'
    };
    const second = {
      ...first,
      catalog: 'a:b',
      idempotencyKey: 'c'
    };

    expect(catalogIdempotencyScope(first)).not.to.equal(catalogIdempotencyScope(second));
    expect((await claimCatalogIdempotency(first)).decision).to.equal('claimed');
    expect((await claimCatalogIdempotency(second)).decision).to.equal('claimed');
    expect(ledger.rows.size).to.equal(2);
  });

  it('keeps a long-running claim leased for the configured orchestration window', async function () {
    let requestStarted: (() => void) | undefined;
    const started = new Promise<void>(resolve => {
      requestStarted = resolve;
    });
    const testServer = await listen(async () => {
      requestStarted?.();
    });
    activeServer = testServer.server;
    const config = createDefaultCatalogDefinition();
    config.connection.url = testServer.url + '/catalog';
    config.connection.totalTimeoutMs = 10 * 60 * 1000;
    config.idempotency = { enabled: true };
    configureBrandAndCatalog(config);
    setHookTestGlobal('IntegrationAuditService', makeAuditService());
    const ledger = createTestIdempotencyLedger();
    setHookTestGlobal('ServicenowCatalogIdempotency', ledger);
    const handlers: Record<string, () => void> = {};
    getTestSails().on = (event: string, handler: () => void) => {
      handlers[event] = handler;
    };
    service.init();
    const details = {
      redboxOid: 'workspace-long-running',
      brandId: 'brand-id',
      catalog: 'storage-new',
      idempotencyKey: 'long-running-key'
    };

    const submission = service.submitRequest(
      details.redboxOid,
      workspace(),
      { catalog: details.catalog, event: 'create', idempotencyKey: details.idempotencyKey },
      undefined,
      {}
    );
    await started;
    const {
      CATALOG_IDEMPOTENCY_CLAIM_LEASE_MS,
      catalogIdempotencyClaimLeaseMs,
      claimCatalogIdempotency
    } = require(
      '../../dist/api/services/servicenow/idempotency.js'
    ) as typeof import('../../src/api/services/servicenow/idempotency');
    const competingClaim = await claimCatalogIdempotency(
      details,
      {
        leaseDurationMs: catalogIdempotencyClaimLeaseMs(config.connection.totalTimeoutMs),
        now: new Date(Date.now() + CATALOG_IDEMPOTENCY_CLAIM_LEASE_MS + 1)
      }
    );

    expect(competingClaim.decision).to.equal('in-progress');
    handlers.lower();
    expect(await submission).to.include({ code: '503', status: false });
  });

  it('does not consult the idempotency ledger when the catalog setting is disabled', async function () {
    const testServer = await listen(async (_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end('{}');
    });
    activeServer = testServer.server;
    const config = createDefaultCatalogDefinition();
    config.connection.url = testServer.url + '/catalog';
    config.idempotency = { enabled: false };
    configureBrandAndCatalog(config);
    const audit = makeAuditService();
    setHookTestGlobal('IntegrationAuditService', audit);

    await service.submitRequest(
      'workspace-no-idempotency',
      workspace(),
      { catalog: 'storage-new', event: 'create', idempotencyKey: 'ignored-key' },
      undefined,
      successResponse()
    );

    expect(audit.getAuditLog.mock.calls).to.have.length(0);
  });

  it('uses hook fallback config unless the brand has a persisted ServiceNow override', async function () {
    let requests = 0;
    const testServer = await listen(async (_req, res) => {
      requests += 1;
      res.setHeader('Content-Type', 'application/json');
      res.end('{}');
    });
    activeServer = testServer.server;
    const config = createDefaultCatalogDefinition();
    config.connection.url = testServer.url + '/catalog';
    configureBrandAndCatalog(config);

    const appConfig = {
      servicenowCatalog: { enabled: false, catalogs: {} }
    };
    const presentKeys = new Set<string>();
    Object.defineProperty(appConfig, Symbol.for('redbox.appConfig.presentKeys'), {
      value: presentKeys,
      enumerable: false
    });
    Reflect.set(getTestSails().config, 'brandingAware', () => appConfig);
    setHookTestGlobal('IntegrationAuditService', makeAuditService());

    const fallbackResult = await service.submitRequest(
      'workspace-hook-fallback',
      workspace(),
      { catalog: 'storage-new', event: 'create' },
      undefined,
      successResponse()
    );
    expect(fallbackResult).to.include({ status: true, success: true });
    expect(requests).to.equal(1);

    presentKeys.add('servicenowCatalog');
    const skippedResponse = successResponse();
    const storedOverrideResult = await service.submitRequest(
      'workspace-brand-disabled',
      workspace(),
      { catalog: 'storage-new', event: 'create' },
      undefined,
      skippedResponse
    );
    expect(storedOverrideResult).to.equal(skippedResponse);
    expect(requests).to.equal(1);
  });

  it('fails safely instead of falling back when the workspace brand is unknown', async function () {
    const config = createDefaultCatalogDefinition();
    config.connection.url = 'https://example.service-now.com/catalog';
    configureBrandAndCatalog(config);
    setHookTestGlobal('BrandingService', { getBrandById: () => undefined });

    const result = await service.submitRequest(
      'workspace-unknown-brand',
      workspace(),
      { catalog: 'storage-new', event: 'create' },
      undefined,
      {}
    );

    expect(result).to.include({ code: '400', status: false, success: false });
    expect(result.message).to.contain("unknown brand 'brand-id'");
  });

  it('registers complete audit outcome semantics on the ready lifecycle event', function () {
    const handlers: Record<string, () => void> = {};
    const testSails = getTestSails();
    testSails.on = (event: string, handler: () => void) => {
      handlers[event] = handler;
    };
    const audit = makeAuditService();
    setHookTestGlobal('IntegrationAuditService', audit);

    service.init();
    expect(handlers).to.have.keys(['ready', 'lower']);
    handlers.ready();

    expect(audit.registerOutcomeMapper.mock.calls).to.have.length(1);
    expect(audit.registerOutcomeMapper.mock.calls[0].arguments[0]).to.equal('servicenow-catalog');
    const mapper = audit.registerOutcomeMapper.mock.calls[0].arguments[1] as (
      summary: { status: string }
    ) => Record<string, unknown> | undefined;
    expect(mapper({ status: 'started' })).to.deep.include({
      state: 'in-progress',
      severity: 'in-progress'
    });
    expect(mapper({ status: 'failed' })).to.deep.include({ state: 'error', severity: 'error' });
    expect(mapper({ status: 'success' })).to.deep.include({ state: 'provisioned', severity: 'success' });
    expect(mapper({ status: 'none' })).to.deep.include({ state: 'none', severity: 'none' });
    expect(mapper({ status: 'unexpected' })).to.equal(undefined);
  });
});
