import type { IncomingMessage, Server, ServerResponse } from 'node:http';

const http = require('node:http') as typeof import('node:http');
const { mock } = require('node:test');
const { expect } = require('@researchdatabox/redbox-dev-tools/testing');
const { clearHookTestGlobals, installHookTestGlobals } = require('../support/globals');

type CapturedRequest = {
  body: Record<string, unknown>;
  headers: IncomingMessage['headers'];
  method?: string;
};

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
  return { server, url: `http://127.0.0.1:${address.port}` };
}

describe('ServiceNow catalog orchestration', function () {
  let activeServer: Server | undefined;
  let ServiceNowCatalogAppConfig;
  let servicenowCatalogService;

  beforeEach(() => {
    installHookTestGlobals();
    ({ ServiceNowCatalogAppConfig } = require('../../dist/api/configmodels/ServiceNowCatalogAppConfig.js'));
    servicenowCatalogService = require('../../dist/api/services/ServicenowCatalogService.js');
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

  it('runs the mapped request, retries, write-back, and nested audit lifecycle', async function () {
    const captured: CapturedRequest[] = [];
    let catalogAttempts = 0;
    const testServer = await listen(async (req, res) => {
      catalogAttempts += 1;
      captured.push({
        body: await readJson(req),
        headers: req.headers,
        method: req.method
      });
      res.setHeader('Content-Type', 'application/json');
      if (catalogAttempts === 1) {
        res.statusCode = 503;
        res.end(JSON.stringify({ error: 'temporary' }));
        return;
      }
      res.statusCode = 201;
      res.end(JSON.stringify({
        result: {
          number: 'REQ001234',
          sys_id: 'sys-123',
          table: 'sc_request'
        }
      }));
    });
    activeServer = testServer.server;

    const config = new ServiceNowCatalogAppConfig();
    config.enabled = true;
    config.connection.url = `${testServer.url}/catalog`;
    config.connection.headers = { 'X-Integration': 'redbox' };
    config.connection.timeoutMs = 500;
    config.connection.totalTimeoutMs = 2000;
    config.connection.retry = {
      maxAttempts: 2,
      baseDelayMs: 1,
      maxDelayMs: 1,
      retryOnStatusCodes: [503]
    };
    config.requestFields = [
      {
        destination: 'variables.short_description',
        source: { kind: 'path', path: 'workspace.metadata.title' }
      },
      {
        destination: 'variables.plan',
        source: { kind: 'handlebars', template: '{{rdmp.metadata.title}} ({{brand}})' }
      },
      {
        destination: 'variables.requested_size',
        source: { kind: 'jsonata', expression: 'workspace.metadata.storage_size' }
      }
    ];

    const brandingAware = mock.fn((brandName: string) =>
      brandName === 'brand-a' ? { servicenowCatalog: config } : undefined
    );
    global.sails.config.brandingAware = brandingAware;
    const brand = { id: 'brand-id', name: 'brand-a' };
    (global as any).BrandingService = {
      getBrandById: mock.fn((brandId: string) => brandId === 'brand-id' ? brand : undefined)
    };
    const addWorkspaceToRecord = mock.fn(async () => ({ status: true }));
    (global as any).WorkspaceService = { addWorkspaceToRecord };
    const getMeta = mock.fn(async (oid: string) => {
      if (oid !== 'rdmp-1') {
        throw new Error(`Unexpected record ${oid}`);
      }
      return { metadata: { title: 'Plan A' } };
    });
    const updateMeta = mock.fn(async () => ({ status: true }));
    (global as any).RecordsService = { getMeta, updateMeta };
    (global as any).TranslationService = { t: (key: string) => key };

    let auditSequence = 0;
    const startAudit = mock.fn((oid: string, action: string, opts: Record<string, unknown> = {}) => {
      auditSequence += 1;
      return {
        redboxOid: oid,
        brandId: opts.brandId,
        integrationName: opts.integrationName,
        integrationAction: action,
        triggeredBy: opts.triggeredBy,
        traceId: opts.traceId ?? `trace-${auditSequence}`,
        spanId: `span-${auditSequence}`,
        parentSpanId: opts.parentSpanId,
        startedAt: new Date().toISOString(),
        requestSummary: opts.requestSummary
      };
    });
    const completeAudit = mock.fn();
    const failAudit = mock.fn();
    (global as any).IntegrationAuditService = { startAudit, completeAudit, failAudit };

    const workspace = {
      metadata: {
        rdmpOid: 'rdmp-1',
        title: 'Research storage',
        storage_size: '5 TB'
      },
      metaMetadata: { brandId: 'brand-id' }
    };
    const triggerResponse = { code: '200', status: true, success: true };
    const result = await servicenowCatalogService.submitRequest(
      'workspace-1',
      workspace,
      {},
      { username: 'researcher@example.edu' },
      triggerResponse
    );

    expect(result).to.equal(triggerResponse);
    expect(result).to.include({ code: '200', status: true, success: true });
    expect(catalogAttempts).to.equal(2);
    expect(captured[1]).to.deep.include({ method: 'POST' });
    expect(captured[1].headers['x-integration']).to.equal('redbox');
    expect(captured[1].body).to.deep.equal({
      sysparm_quantity: '1',
      get_portal_messages: 'true',
      variables: {
        short_description: 'Research storage',
        plan: 'Plan A (brand-a)',
        requested_size: '5 TB'
      }
    });
    expect(addWorkspaceToRecord.mock.calls).to.have.length(1);
    expect(addWorkspaceToRecord.mock.calls[0].arguments).to.deep.equal(['rdmp-1', 'workspace-1']);
    expect(getMeta.mock.calls).to.have.length(1);
    expect(getMeta.mock.calls[0].arguments).to.deep.equal(['rdmp-1']);
    expect(updateMeta.mock.calls).to.have.length(1);
    expect(updateMeta.mock.calls[0].arguments[0]).to.equal(brand);
    expect(updateMeta.mock.calls[0].arguments[1]).to.equal('workspace-1');
    expect(updateMeta.mock.calls[0].arguments[2]).to.have.nested.property(
      'metadata.servicenow_number',
      'REQ001234'
    );
    expect(updateMeta.mock.calls[0].arguments[2]).to.have.nested.property(
      'metadata.servicenow_sys_id',
      'sys-123'
    );

    const actions = startAudit.mock.calls.map((call: { arguments: unknown[] }) => call.arguments[1]);
    expect(actions).to.deep.equal([
      'submitCatalogRequest',
      'associateWorkspace',
      'catalogOrderRequest',
      'workspaceMetadataUpdate'
    ]);
    const parentContext = startAudit.mock.calls[0].result;
    for (const childCall of startAudit.mock.calls.slice(1)) {
      expect(childCall.arguments[2]).to.include({
        traceId: parentContext.traceId,
        parentSpanId: parentContext.spanId
      });
    }
    expect(failAudit.mock.calls).to.have.length(0);
    expect(completeAudit.mock.calls).to.have.length(4);
    expect(completeAudit.mock.calls[3].arguments[1]).to.have.nested.property(
      'responseSummary.result.number',
      'REQ001234'
    );
  });

  it('fails safely instead of falling back when the workspace brand is unknown', async function () {
    const brandingAware = mock.fn();
    global.sails.config.brandingAware = brandingAware;
    (global as any).BrandingService = { getBrandById: mock.fn(() => undefined) };
    (global as any).WorkspaceService = { addWorkspaceToRecord: mock.fn() };
    (global as any).RecordsService = { getMeta: mock.fn(), updateMeta: mock.fn() };

    const response = await servicenowCatalogService.submitRequest(
      'workspace-unknown-brand',
      { metadata: { rdmpOid: 'rdmp-1' }, metaMetadata: { brandId: 'missing-brand' } },
      {},
      undefined,
      {}
    );

    expect(response).to.include({ code: '400', status: false, success: false });
    expect(response.message).to.contain("unknown brand 'missing-brand'");
    expect(brandingAware.mock.calls).to.have.length(0);
    expect((global as any).WorkspaceService.addWorkspaceToRecord.mock.calls).to.have.length(0);
  });

  it('registers complete audit outcome semantics on the ready lifecycle event', function () {
    const handlers: Record<string, () => void> = {};
    global.sails.on = mock.fn((event: string, handler: () => void) => {
      handlers[event] = handler;
    });
    const registerOutcomeMapper = mock.fn();
    (global as any).IntegrationAuditService = {
      startAudit: mock.fn(),
      completeAudit: mock.fn(),
      failAudit: mock.fn(),
      registerOutcomeMapper
    };

    servicenowCatalogService.init();
    expect(handlers).to.have.keys(['ready', 'lower']);
    handlers.ready();

    expect(registerOutcomeMapper.mock.calls).to.have.length(1);
    expect(registerOutcomeMapper.mock.calls[0].arguments[0]).to.equal('servicenow-catalog');
    const mapper = registerOutcomeMapper.mock.calls[0].arguments[1];
    expect(mapper({ status: 'started' })).to.deep.include({
      state: 'in-progress',
      severity: 'in-progress',
      labelKey: '@integration-status-outcome-servicenow-catalog-in-progress'
    });
    expect(mapper({ status: 'failed' })).to.deep.include({
      state: 'error',
      severity: 'error',
      helpKey: '@integration-status-outcome-servicenow-catalog-error-help'
    });
    expect(mapper({ status: 'success' })).to.deep.include({
      state: 'provisioned',
      severity: 'success'
    });
    expect(mapper({ status: 'none' })).to.deep.include({
      state: 'none',
      severity: 'none'
    });
    expect(mapper({ status: 'unexpected' })).to.equal(undefined);
  });
});
