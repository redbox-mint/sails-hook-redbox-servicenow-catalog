import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { ServiceNowCatalogDefinition } from '../../src/api/configmodels/ServiceNowCatalogAppConfig';
import type { WorkspaceRecord, ServiceNowSubmissionError as SubmissionError, ServicenowCatalogService } from '../../src/api/services/ServicenowCatalogService';
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

const { ServiceNowSubmissionError } = require('../../dist/api/services/servicenow/errors') as typeof import('../../src/api/services/servicenow/errors');
async function rejected(promise: Promise<unknown>): Promise<SubmissionError> {
  try { await promise; } catch (error) {
    expect(error).to.be.instanceOf(ServiceNowSubmissionError);
    return error as SubmissionError;
  }
  throw new Error('Expected ServiceNowSubmissionError');
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

  type MutationOptions = Omit<Parameters<typeof RecordsService.mutateMetaInternal>[0], 'mutate'> & {
    mutate: (snapshot: WorkspaceRecord) => WorkspaceRecord;
  };

  for (const scenario of [
    { name: 'parent lookup', tag: 'ParentLookupError', code: '500', uncertain: false, dispatched: false },
    { name: 'association', tag: 'ParentAssociationError', code: '500', uncertain: false, dispatched: false },
    { name: 'request mapping', tag: 'MappingError', code: '500', uncertain: false, dispatched: false },
    { name: 'OAuth', tag: 'OAuthTokenError', code: '401', uncertain: false, dispatched: true },
    { name: 'HTTP', tag: 'CatalogRequestError', code: '503', uncertain: false, dispatched: true },
    { name: 'transport', tag: 'CatalogRequestError', code: '500', uncertain: true, dispatched: true },
    { name: 'request timeout', tag: 'CatalogTimeoutError', code: '504', uncertain: true, dispatched: true },
    { name: 'workspace rejection', tag: 'WorkspaceUpdateError', code: '500', uncertain: true, dispatched: true },
    { name: 'missing revision', tag: 'WorkspaceUpdateError', code: '500', uncertain: true, dispatched: true },
    { name: 'invalid revision', tag: 'WorkspaceUpdateError', code: '500', uncertain: true, dispatched: true },
    { name: 'read failure', tag: 'WorkspaceUpdateError', code: '500', uncertain: true, dispatched: true },
    { name: 'unusable read', tag: 'WorkspaceUpdateError', code: '500', uncertain: true, dispatched: true },
    { name: 'wrong OID', tag: 'WorkspaceUpdateError', code: '500', uncertain: true, dispatched: true },
    { name: 'read brand mismatch', tag: 'WorkspaceUpdateError', code: '500', uncertain: true, dispatched: true },
    { name: 'brand mismatch', tag: 'WorkspaceUpdateError', code: '500', uncertain: true, dispatched: true },
    { name: 'parent write', tag: 'ParentUpdateError', code: '500', uncertain: true, dispatched: true },
    { name: 'defect', tag: 'Defect', code: '500', uncertain: true, dispatched: true }
  ]) {
    it(`throws typed ${scenario.name} failure after status, audit, ledger and resource claim cleanup`, async function () {
      const endpoint = await listen(async (req, res) => {
        req.resume();
        if (scenario.name === 'transport') { req.socket.destroy(); return; }
        if (scenario.name === 'request timeout') return;
        res.statusCode = scenario.name === 'OAuth' ? 401 : scenario.name === 'HTTP' ? 503 : 201;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ result: { number: 'REQ-FAILURE' }, error: 'unavailable', password: 'private-password' }));
      });
      activeServer = endpoint.server;
      const config = createDefaultCatalogDefinition();
      config.connection.url = endpoint.url;
      config.connection.timeoutMs = 50;
      config.connection.retry.maxAttempts = 1;
      config.parentRecord = { oid: { kind: 'path', path: 'workspace.metadata.parentOid' } };
      config.idempotency = { enabled: true };
      config.dispatchClaim = { enabled: true, resources: { kind: 'path', path: 'workspace.metadata.resources' } };
      config.responseFields.workspace = [{ destination: 'metadata.number', source: { kind: 'path', path: 'response.result.number' } }];
      if (scenario.name === 'request mapping') config.requestFields = [{ destination: '__proto__.unsafe', source: { kind: 'path', path: 'oid' } }];
      if (scenario.name === 'OAuth') config.oauth = { enabled: true, url: endpoint.url, clientId: 'client', clientSecret: 'private-client-secret', grantType: 'client_credentials' };
      if (scenario.name === 'parent write') config.responseFields.parentRecord = config.responseFields.workspace;
      if (scenario.name === 'defect') {
        const httpModule = require('../../dist/api/services/servicenow/http') as typeof import('../../src/api/services/servicenow/http');
        const { Effect, Layer } = require('effect') as typeof import('effect');
        mock.method(httpModule, 'makeClientLayer', () => Layer.succeed(httpModule.ServiceNowClientTag, { submitCatalogOrder: () => Effect.die(new Error('injected defect')) }));
      }
      configureBrandAndCatalog(config);
      const audit = makeAuditService();
      setHookTestGlobal('IntegrationAuditService', audit);
      const ledger = createTestIdempotencyLedger();
      setHookTestGlobal('ServicenowCatalogIdempotency', ledger);
      const { resourceModel } = require('../support/resource-claims') as typeof import('../support/resource-claims');
      const resources = resourceModel();
      setHookTestGlobal('ServicenowCatalogResourceClaim', resources);
      const input = workspace({ parentOid: 'parent', title: 'original', resources: ['resource'] });
      let stored: WorkspaceRecord = { ...structuredClone(input), redboxOid: 'typed-failure', revision: 1 };
      const mutateMetaInternal = mock.fn(async (options: MutationOptions) => {
        const writeBack = options.actor.id.endsWith('responseWriteBack');
        if (writeBack && scenario.name === 'workspace rejection') return { success: false, concurrency: { revision: 1 } };
        const fresh = structuredClone(stored);
        if (writeBack && scenario.name === 'brand mismatch') fresh.metaMetadata = { brandId: 'another-brand' };
        stored = options.mutate(fresh);
        stored.revision = scenario.name === 'missing revision' && writeBack ? undefined : scenario.name === 'invalid revision' && writeBack ? -1 : 2;
        return { success: true, concurrency: { revision: 2 } };
      });
      setHookTestGlobal('RecordsService', {
        getMeta: async (oid: string) => {
          if (oid === 'parent') {
            if (scenario.name === 'parent lookup') throw new Error('parent unavailable');
            return workspace();
          }
          if (scenario.name === 'read failure') throw new Error('read unavailable after commit');
          if (scenario.name === 'unusable read') return { ...stored, metadata: null };
          if (scenario.name === 'wrong OID') return { ...stored, redboxOid: 'another-record' };
          if (scenario.name === 'read brand mismatch') return { ...stored, metaMetadata: { brandId: 'another-brand' } };
          return stored;
        },
        updateMeta: async () => { throw new Error('parent write failed'); },
        mutateMetaInternal
      });
      setHookTestGlobal('WorkspaceService', { addWorkspaceToRecord: async () => {
        if (scenario.name === 'association') throw new Error('association failed');
      } });
      const options = { catalog: 'storage-new', event: 'create', idempotencyKey: 'failure-key' };
      const error = await rejected(service.submitRequest('typed-failure', input, options, undefined));
      expect(error).to.include({ oid: 'typed-failure', code: scenario.code, uncertain: scenario.uncertain, tag: scenario.tag });
      expect(JSON.stringify(error)).not.to.include('private-password');
      expect(error.message).not.to.include('private-client-secret');
      expect(stored.metadata.servicenow_status).to.equal(scenario.uncertain ? 'Uncertain' : 'Failed');
      if (['read failure', 'unusable read', 'wrong OID', 'read brand mismatch', 'missing revision', 'invalid revision'].includes(scenario.name)) {
        expect(stored.metadata.number, 'committed mappings survive read failure and status write').to.equal('REQ-FAILURE');
      }
      expect([...ledger.rows.values()][0].status).to.equal(scenario.uncertain ? 'uncertain' : 'failed');
      expect(audit.failAudit.mock.calls.some(call => call.arguments[0].integrationAction === 'submitCatalogRequest')).to.equal(true);
      if (scenario.dispatched) expect([...resources.rows.values()][0].state).to.equal('uncertain');
      else expect(resources.rows.size).to.equal(0);
      for (const call of mutateMetaInternal.mock.calls) {
        expect(call.arguments[0]).to.include({ triggerPreSaveTriggers: false, triggerPostSaveTriggers: false });
      }
      // A subsequent call must reach the durable ledger (or reclaim its failed row),
      // proving the in-process idempotency lock was released when the API threw.
      const lookups = audit.startAudit.mock.calls.length;
      const retry = await rejected(service.submitRequest('typed-failure', input, options, undefined));
      expect(retry.code).to.equal(scenario.uncertain || scenario.dispatched ? '409' : scenario.code);
      expect(audit.startAudit.mock.calls.length).to.be.greaterThan(lookups);
      const handlers: Record<string, () => void> = {};
      getTestSails().on = (event: string, handler: () => void) => { handlers[event] = handler; };
      const warnings: unknown[][] = [];
      getTestSails().log.warn = (...args: unknown[]) => { warnings.push(args); };
      service.init(); handlers.lower();
      expect(warnings).to.deep.equal([]); // No completed fiber remains in flight.
    });
  }

  it('throws an idempotency lookup error and releases the local guard', async function () {
    const config = createDefaultCatalogDefinition();
    config.connection.url = 'https://example.invalid/catalog';
    config.idempotency = { enabled: true };
    configureBrandAndCatalog(config);
    const ledger = createTestIdempotencyLedger();
    setHookTestGlobal('ServicenowCatalogIdempotency', { ...ledger, create: () => ({ fetch: async () => { throw new Error('ledger offline'); } }) });
    const audit = makeAuditService();
    setHookTestGlobal('IntegrationAuditService', audit);
    for (let i = 0; i < 2; i++) {
      expect(await rejected(service.submitRequest('lookup-failure', workspace(), { catalog: 'storage-new', event: 'create', idempotencyKey: 'key' }, undefined)))
        .to.include({ code: '500', uncertain: false, tag: 'IdempotencyLookupError' });
    }
    expect(audit.failAudit.mock.calls.filter(call => call.arguments[0].integrationAction === 'submitCatalogRequest')).to.have.length(2);
    expect(ledger.rows.size).to.equal(0);
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
    config.bodyTemplate.variables = {
      requesterEmail: 'admin@example.com',
      contributors: [
        { email: 'ada@auckland.ac.nz' },
        { email: 'grace@example.com' }
      ]
    };
    config.requestFilters = [
      {
        destination: 'variables.requesterEmail',
        source: {
          kind: 'jsonata',
          expression: '$substringAfter($lowercase(value), "@") = "auckland.ac.nz" ? value : null'
        }
      },
      {
        destination: 'variables.contributors',
        source: {
          kind: 'jsonata',
          expression: '$append([], $filter(value, function($person) { $substringAfter($lowercase($string($person.email)), "@") = "auckland.ac.nz" }))'
        }
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
    let stored: WorkspaceRecord;
    const parent = { metadata: { title: 'Plan A', existing: 'keep' } };
    const getMeta = mock.fn(async (oid: string) => {
      if (oid === 'workspace-1') return stored;
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
    const mutateMetaInternal = mock.fn(async (options: Omit<Parameters<typeof RecordsService.mutateMetaInternal>[0], 'mutate'> & { mutate: (snapshot: WorkspaceRecord) => WorkspaceRecord }) => {
      const fresh = { ...workspace({ parentOid: 'parent-1', title: 'Concurrent title', status: 'Published', concurrent: 'keep' }), revision: 7 };
      options.mutate(fresh);
      stored = { ...structuredClone(fresh), redboxOid: 'workspace-1', revision: 8, metaMetadata: { ...fresh.metaMetadata, lastSavedBy: 'core-normalised' } };
      expect(fresh.metadata).to.deep.equal({ parentOid: 'parent-1', title: 'Concurrent title', status: 'Published', concurrent: 'keep', servicenow_number: 'REQ001234' });
      return { success: true, concurrency: { revision: 8 } };
    });
    setHookTestGlobal('RecordsService', { getMeta, updateMeta, mutateMetaInternal });
    const audit = makeAuditService();
    setHookTestGlobal('IntegrationAuditService', audit);

    const submittedWorkspace = workspace({
      parentOid: 'parent-1',
      title: 'Research storage',
      status: 'Draft'
    });

    const result = await service.submitRequest(
      'workspace-1',
      submittedWorkspace,
      { catalog: 'storage-new', event: 'create' },
      { username: 'researcher@example.edu' }
    );

    expect(result).to.have.nested.property('metadata.servicenow_number', 'REQ001234');
    expect(result).to.equal(stored!);
    expect(result.metaMetadata?.lastSavedBy).to.equal('core-normalised');
    expect(result.revision).to.equal(8);
    expect(getMeta.mock.calls.map(call => call.arguments[0])).to.deep.equal(['parent-1', 'workspace-1']);
    expect(captured).to.have.length(1);
    expect(captured[0].method).to.equal('POST');
    expect(captured[0].headers['x-integration']).to.equal('redbox');
    expect(captured[0].body).to.deep.equal({
      sysparm_quantity: '1',
      get_portal_messages: 'true',
      variables: {
        short_description: 'Research storage',
        plan: 'Plan A (brand-a)',
        event: 'create',
        contributors: [{ email: 'ada@auckland.ac.nz' }]
      }
    });
    expect(addWorkspaceToRecord.mock.calls[0].arguments).to.deep.equal(['parent-1', 'workspace-1']);
    expect(getMeta.mock.calls[0].arguments).to.deep.equal(['parent-1']);
    expect(mutateMetaInternal.mock.calls).to.have.length(1);
    expect(mutateMetaInternal.mock.calls[0].arguments[0]).to.include({
      oid: 'workspace-1', triggerPreSaveTriggers: false, triggerPostSaveTriggers: false
    });
    expect(mutateMetaInternal.mock.calls[0].arguments[0].retry).to.deep.equal({ idempotent: true, recomputable: true, maxAttempts: 3 });
    expect(submittedWorkspace.metadata).not.to.have.property('servicenow_number');
    expect(result).to.have.nested.property('metadata.concurrent', 'keep');
    expect(updateMeta.mock.calls).to.have.length(1);
    expect(updateMeta.mock.calls[0].arguments[1]).to.equal('parent-1');
    expect(updateMeta.mock.calls[0].arguments[2]).to.deep.equal({
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

  for (const concurrent of [false, true]) {
    it(`returns the exact stored read with literal bracket and nested destinations${concurrent ? ' after a concurrent commit' : ''}`, async function () {
      const endpoint = await listen(async (_req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ result: { number: 'REQ-PATH' } }));
      });
      activeServer = endpoint.server;
      const config = createDefaultCatalogDefinition();
      config.connection.url = endpoint.url;
      config.responseFields.workspace = ['metadata.answer[0]', 'metadata.a.b'].map(destination => ({
        destination, source: { kind: 'path', path: 'response.result.number' }
      }));
      configureBrandAndCatalog(config);
      setHookTestGlobal('IntegrationAuditService', makeAuditService());
      let stored: WorkspaceRecord = { ...workspace({ title: 'Original', a: { keep: true } }), redboxOid: 'path-record', revision: 7 };
      let candidate: WorkspaceRecord | undefined;
      const getMeta = mock.fn(async (_oid: string) => stored);
      setHookTestGlobal('RecordsService', {
        getMeta,
        mutateMetaInternal: async (options: MutationOptions) => {
          candidate = options.mutate(structuredClone(stored));
          stored = { ...structuredClone(candidate), revision: 8, metaMetadata: { ...candidate.metaMetadata, lastSavedBy: 'normalised', lastSaveDate: 'normalised-date' } };
          if (concurrent) stored = { ...stored, metadata: { ...stored.metadata, title: 'Concurrent title' }, revision: 9 };
          // This is the review probe: finishSave can report revision 9 for a
          // callback candidate whose write was revision 8.
          return { success: true, concurrency: { revision: stored.revision } };
        }
      });
      const result = await service.submitRequest('path-record', workspace(), { catalog: 'storage-new', event: 'create' }, undefined);
      expect(result).to.equal(stored);
      expect(result).not.to.equal(candidate);
      expect(getMeta.mock.calls).to.have.length(1);
      expect(getMeta.mock.calls[0].arguments).to.deep.equal(['path-record']);
      expect(result.revision).to.equal(concurrent ? 9 : 8);
      expect(result.metaMetadata).to.include({ lastSavedBy: 'normalised', lastSaveDate: 'normalised-date' });
      expect(result.metadata).to.deep.equal({ title: concurrent ? 'Concurrent title' : 'Original', 'answer[0]': 'REQ-PATH', a: { keep: true, b: 'REQ-PATH' } });
      expect(result.metadata).not.to.have.property('answer');
    });
  }

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

    const input = workspace({ title: 'No parent' });
    const getMeta = mock.fn(async () => { throw new Error('Unexpected read'); });
    const mutateMetaInternal = mock.fn(async () => { throw new Error('Unexpected write'); });
    setHookTestGlobal('RecordsService', { getMeta, mutateMetaInternal });
    const result = await service.submitRequest(
      'workspace-no-parent',
      input,
      { catalog: 'storage-new', event: 'update' },
      undefined
    );

    expect(result).to.have.property('metadata');
    expect(result).to.equal(input);
    expect(getMeta.mock.calls).to.have.length(0);
    expect(mutateMetaInternal.mock.calls).to.have.length(0);
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

    const missingCatalog = await rejected(service.submitRequest(
      'workspace-options',
      workspace(),
      { catalog: '', event: 'create' },
      undefined
    ));
    expect(missingCatalog).to.include({ code: '400', uncertain: false, tag: 'ServiceNowConfigError' });

    const unknown = await rejected(service.submitRequest(
      'workspace-unknown',
      workspace(),
      { catalog: 'does-not-exist', event: 'create' },
      undefined
    ));
    expect(unknown).to.include({ code: '400', uncertain: false, tag: 'UnknownCatalogError' });
    expect(unknown.message).to.contain("Unknown ServiceNow catalog 'does-not-exist'");

    config.enabled = false;
    configureBrandAndCatalog(config);
    const disabledResponse = workspace();
    const disabled = await service.submitRequest(
      'workspace-disabled',
      disabledResponse,
      { catalog: 'storage-new', event: 'create' },
      undefined
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

    const result = await rejected(service.submitRequest(
      'workspace-missing-parent',
      workspace(),
      { catalog: 'storage-new', event: 'create' },
      undefined
    ));

    expect(result).to.include({ code: '400', uncertain: false, tag: 'ParentRecordRequiredError' });
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
    const updateMeta = mock.fn(async (
      _brand: unknown,
      _oid: string,
      _record: Record<string, unknown>
    ) => ({ status: true }));
    setHookTestGlobal('RecordsService', {
      getMeta: mock.fn(async () => ({ metadata: { title: 'Parent' } })),
      updateMeta
    });
    const audit = makeAuditService();
    setHookTestGlobal('IntegrationAuditService', audit);
    const submittedWorkspace = workspace({ parentOid: 'parent-1', title: 'Preserve me' });
    const original = structuredClone(submittedWorkspace);

    const result = await rejected(service.submitRequest(
      'workspace-association-failure',
      submittedWorkspace,
      { catalog: 'storage-new', event: 'create' },
      undefined
    ));

    expect(result).to.include({ code: '500' });
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
    const updateMeta = mock.fn(async (
      _brand: unknown,
      _oid: string,
      _record: Record<string, unknown>
    ) => ({ status: true }));
    setHookTestGlobal('RecordsService', { updateMeta });
    const audit = makeAuditService();
    setHookTestGlobal('IntegrationAuditService', audit);
    const submittedWorkspace = workspace({ title: 'Preserve me' });
    const original = structuredClone(submittedWorkspace);

    const result = await rejected(service.submitRequest(
      'workspace-http-failure',
      submittedWorkspace,
      { catalog: 'storage-new', event: 'update' },
      undefined
    ));

    expect(result).to.include({ code: '503' });
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
      const result = await rejected(service.submitRequest(
        'workspace-idempotent',
        workspace(),
        { catalog: 'storage-new', event: 'create', idempotencyKey: 'stable-key' },
        undefined
      ));
      expect(result).to.include({ code: '409' });
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
      undefined
    );

    expect(result).to.have.property('metadata');
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

    const results = await Promise.allSettled([
      service.submitRequest(
        'workspace-concurrent',
        workspace(),
        { catalog: 'storage-new', event: 'create', idempotencyKey: 'concurrent-key' },
        undefined),
      service.submitRequest(
        'workspace-concurrent',
        workspace(),
        { catalog: 'storage-new', event: 'create', idempotencyKey: 'concurrent-key' },
        undefined)
    ]);

    expect(requests).to.equal(1);
    expect(results.filter(result => result.status === 'fulfilled')).to.have.length(1);
    expect(results.filter(result => result.status === 'rejected' && result.reason instanceof ServiceNowSubmissionError && result.reason.code === '409')).to.have.length(1);
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
      undefined
    );
    const retry = await rejected(service.submitRequest(
      'workspace-immediate',
      workspace(),
      { catalog: 'storage-new', event: 'create', idempotencyKey: 'immediate-key' },
      undefined
    ));

    expect(first).to.have.property('metadata');
    expect(retry).to.include({ code: '409' });
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

    let stored: WorkspaceRecord = workspace();
    setHookTestGlobal('RecordsService', {
      updateMeta: async () => { throw new Error('Unexpected fallback'); },
      mutateMetaInternal: async (options: MutationOptions) => {
        stored = options.mutate(stored);
        return { success: true, concurrency: { revision: 2 } };
      }
    });
    const submission = rejected(service.submitRequest(
      'workspace-interrupted',
      workspace(),
      { catalog: 'storage-new', event: 'create', idempotencyKey: 'interrupted-key' },
      undefined
    ));
    await started;
    handlers.lower();
    const interrupted = await submission;
    const retry = await rejected(service.submitRequest(
      'workspace-interrupted',
      workspace(),
      { catalog: 'storage-new', event: 'create', idempotencyKey: 'interrupted-key' },
      undefined
    ));

    expect(interrupted).to.include({ code: '503', uncertain: true, tag: 'Interrupted' });
    expect(retry).to.include({ code: '409' });
    expect(requests).to.equal(1);
    expect(stored.metadata.servicenow_status).to.equal('Uncertain');
    expect(audit.failAudit.mock.calls.some(call => {
      const details = call.arguments[2];
      const summary = details?.requestSummary as Record<string, unknown> | undefined;
      return summary?.submissionCertainty === 'uncertain';
    })).to.equal(true);
  });

  it('concludes the total timeout as uncertain and blocks replay', async function () {
    let requests = 0;
    const testServer = await listen(async () => { requests += 1; });
    activeServer = testServer.server;
    const config = createDefaultCatalogDefinition();
    config.connection.url = testServer.url;
    config.connection.timeoutMs = 1000;
    config.connection.totalTimeoutMs = 100;
    config.idempotency = { enabled: true };
    configureBrandAndCatalog(config);
    const audit = makeAuditService();
    setHookTestGlobal('IntegrationAuditService', audit);
    const updates: Record<string, unknown>[] = [];
    setHookTestGlobal('RecordsService', {
      updateMeta: async (_brand: unknown, _oid: string, record: Record<string, unknown>) => {
        updates.push(record);
        return { status: true };
      }
    });

    const result = await rejected(service.submitRequest(
      'workspace-total-timeout', workspace(),
      { catalog: 'storage-new', event: 'create', idempotencyKey: 'total-timeout-key' },
      undefined
    ));
    const replay = await rejected(service.submitRequest(
      'workspace-total-timeout', workspace(),
      { catalog: 'storage-new', event: 'create', idempotencyKey: 'total-timeout-key' },
      undefined
    ));

    expect(result).to.include({ code: '504', uncertain: true, tag: 'CatalogTimeoutError' });
    expect(replay).to.include({ code: '409' });
    expect(requests).to.equal(1);
    expect(updates[0]).to.have.nested.property('metadata.servicenow_status', 'Uncertain');
    expect(audit.failAudit.mock.calls.some(call => {
      const error = call.arguments[1];
      return error instanceof Error && Reflect.get(error, '_tag') === 'CatalogTimeoutError'
        && Reflect.get(error, 'phase') === 'orchestration';
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
      undefined
    );

    expect(result).to.have.property('metadata');
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

    const retry = await rejected(service.submitRequest(
      details.redboxOid,
      workspace(),
      { catalog: details.catalog, event: 'create', idempotencyKey: details.idempotencyKey },
      undefined
    ));

    expect(retry).to.include({ code: '409' });
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

    const submission = rejected(service.submitRequest(
      details.redboxOid,
      workspace(),
      { catalog: details.catalog, event: 'create', idempotencyKey: details.idempotencyKey },
      undefined
    ));
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
    expect(await submission).to.include({ code: '503' });
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
      undefined
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
      undefined
    );
    expect(fallbackResult).to.have.property('metadata');
    expect(requests).to.equal(1);

    presentKeys.add('servicenowCatalog');
    const skippedResponse = workspace();
    const storedOverrideResult = await service.submitRequest(
      'workspace-brand-disabled',
      skippedResponse,
      { catalog: 'storage-new', event: 'create' },
      undefined
    );
    expect(storedOverrideResult).to.equal(skippedResponse);
    expect(requests).to.equal(1);
  });

  it('fails safely instead of falling back when the workspace brand is unknown', async function () {
    const config = createDefaultCatalogDefinition();
    config.connection.url = 'https://example.service-now.com/catalog';
    configureBrandAndCatalog(config);
    setHookTestGlobal('BrandingService', { getBrandById: () => undefined });

    const result = await rejected(service.submitRequest(
      'workspace-unknown-brand',
      workspace(),
      { catalog: 'storage-new', event: 'create' },
      undefined
    ));

    expect(result).to.include({ code: '400' });
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
  it('releases only the private claimed parent after authorised detachment', async () => {
    const { resourceModel } = require('../support/resource-claims') as typeof import('../support/resource-claims');
    const { acquireResources, transitionResources } = require('../../dist/api/services/servicenow/resource-claims') as typeof import('../../src/api/services/servicenow/resource-claims');
    const ledger = resourceModel();
    setHookTestGlobal('ServicenowCatalogResourceClaim', ledger);
    configureBrandAndCatalog(createDefaultCatalogDefinition());
    const claims = await acquireResources({ brandId: 'brand-id', parentOid: 'private-parent', requestOid: 'request', catalog: 'storage-new' }, ['resource-a']);
    await transitionResources(claims, 'submitted');
    let links: unknown = { id: 'request' };
    let authorised = false;
    const parents: string[] = [];
    setHookTestGlobal('RolesService', { getAdmin: () => 'brand-admin' });
    setHookTestGlobal('UsersService', { hasRole: () => authorised });
    setHookTestGlobal('RecordsService', {
      getDeletedRecordMeta: async () => ({ lifecycleState: 'deleted', metadata: { customerParent: 'edited-parent' }, metaMetadata: { brandId: 'brand-id' } }),
      getMeta: async (oid: string) => { parents.push(oid); return { metadata: { workspaces: links }, metaMetadata: { brandId: 'brand-id' } }; },
      hasEditAccess: () => true
    });
    const attempt = async () => {
      try { await service.releaseRequestClaims('request', workspace(), {}, { roles: [] }, {}); return undefined; }
      catch (error) { return error; }
    };
    expect(await attempt()).to.be.instanceOf(Error);
    expect(parents).to.have.length(0);
    authorised = true;
    expect(await attempt()).to.be.instanceOf(Error);
    expect(ledger.rows.size).to.equal(1);
    links = 'request';
    expect(await attempt()).to.be.instanceOf(Error);
    links = [];
    expect(await attempt()).to.equal(undefined);
    expect(parents).to.deep.equal(['private-parent', 'private-parent', 'private-parent']);
    expect(ledger.rows.size).to.equal(0);
  });

  for (const uncertain of [false, true]) {
    it(`excludes different request OIDs and retains ${uncertain ? 'uncertain' : 'submitted'} resources`, async () => {
      let finish: () => void = () => undefined;
      let reached: () => void = () => undefined;
      const received = new Promise<void>(resolve => { reached = resolve; });
      const hold = new Promise<void>(resolve => { finish = resolve; });
      let count = 0;
      const endpoint = await listen(async (_req, res) => {
        count++; reached(); await hold;
        res.statusCode = uncertain ? 503 : 201;
        res.setHeader('Content-Type', 'application/json'); res.end('{}');
      });
      activeServer = endpoint.server;
      const config = createDefaultCatalogDefinition();
      config.connection.url = endpoint.url;
      config.connection.retry.maxAttempts = 1;
      config.parentRecord = { oid: { kind: 'path', path: 'workspace.metadata.parentOid' } };
      config.idempotency = { enabled: true, key: { kind: 'handlebars', template: '{{oid}}' } };
      config.dispatchClaim = { enabled: true, resources: { kind: 'path', path: 'workspace.metadata.options' } };
      configureBrandAndCatalog(config);
      const { resourceModel } = require('../support/resource-claims') as typeof import('../support/resource-claims');
      const ledger = resourceModel();
      setHookTestGlobal('ServicenowCatalogResourceClaim', ledger);
      setHookTestGlobal('IntegrationAuditService', makeAuditService());
      setHookTestGlobal('RecordsService', {
        getMeta: async () => ({ metadata: {}, metaMetadata: { brandId: 'brand-id' } }),
        updateMeta: async () => ({ success: true })
      });
      const associated: string[] = [];
      setHookTestGlobal('WorkspaceService', { addWorkspaceToRecord: async (_parent: string, oid: string) => { associated.push(oid); } });
      const input = workspace({ parentOid: 'parent', options: ['resource-a'] });
      const first = service.submitRequest('request-a', input, { catalog: 'storage-new', event: 'create' }, {}).then(record => record, error => { expect(error).to.be.instanceOf(ServiceNowSubmissionError); return error as SubmissionError; });
      try {
        await received;
        const second = await rejected(service.submitRequest('request-b', input, { catalog: 'storage-new', event: 'create' }, {}));
        expect(second).to.include({ code: '409' });
        expect(associated).to.deep.equal(['request-a']);
      } finally { finish(); }
      const outcome = await first;
      if (uncertain) expect(outcome).to.include({ code: '503', uncertain: false });
      else expect(outcome).to.equal(input);
      expect([...ledger.rows.values()][0]!.state).to.equal(uncertain ? 'uncertain' : 'submitted');
      const third = await rejected(service.submitRequest('request-c', input, { catalog: 'storage-new', event: 'create' }, {}));
      expect(third.code).to.equal('409');
      expect(count).to.equal(1);
      Reflect.deleteProperty(globalThis, 'ServicenowCatalogResourceClaim');
    });
  }

});
