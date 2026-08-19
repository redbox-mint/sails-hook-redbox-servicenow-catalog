import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ServicenowCatalogService } from '../../src/api/services/ServicenowCatalogService';

const http = require('node:http') as typeof import('node:http');
const { expect } = require('chai') as { expect: Chai.ExpectStatic };
const { createDefaultCatalogDefinition } = require(
  '@researchdatabox/sails-hook-redbox-servicenow-catalog/dist/api/configmodels/ServiceNowCatalogAppConfig.js'
) as typeof import('../../src/api/configmodels/ServiceNowCatalogAppConfig');

type HookModule = {
  registerRedboxConfig(): Record<string, unknown>;
  registerRedboxModels(): Record<string, unknown>;
  registerRedboxFormConfigs?: () => unknown;
};

async function listen(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>
): Promise<{ close: () => Promise<void>; url: string }> {
  const server = http.createServer((req, res) => void handler(req, res));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address == null || typeof address === 'string') {
    throw new Error('Test server did not expose a TCP address.');
  }
  return {
    url: 'http://127.0.0.1:' + address.port,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => error == null ? resolve() : reject(error));
      server.closeAllConnections();
    })
  };
}

describe('ServiceNow catalog hook integration', function () {
  it('registers the reusable service/config without hook-owned forms or record workflows', function () {
    expect(sails.services.servicenowcatalogservice).to.exist;

    const hookModule = require('@researchdatabox/sails-hook-redbox-servicenow-catalog') as HookModule;
    expect(hookModule.registerRedboxModels()).to.have.keys(['ServicenowCatalogIdempotency']);
    expect(hookModule.registerRedboxFormConfigs).to.equal(undefined);
    expect(hookModule.registerRedboxConfig()).to.have.keys(['auth', 'servicenowCatalog']);
    expect(sails.config.recordtype).not.to.have.property('servicenow-catalog');
    expect(sails.config.workflow).not.to.have.property('servicenow-catalog');

    const defaultBrand = BrandingService.getDefault();
    const brandConfig = sails.config.brandingAware(defaultBrand.name);
    const serviceNowConfig = Reflect.get(brandConfig, 'servicenowCatalog') as {
      enabled: boolean;
      catalogs: Record<string, unknown>;
    };
    expect(serviceNowConfig).to.deep.equal({ enabled: false, catalogs: {} });
  });

  it('submits through a named catalog with normalization, optional parent write-back, and persistent audits', async function () {
    let requestCount = 0;
    const testServer = await listen(async (_req, res) => {
      requestCount += 1;
      res.statusCode = 201;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(JSON.stringify({
        result: {
          number: 'REQ-INTEGRATION',
          sys_id: 'sys-integration'
        }
      })));
    });
    const originalConfig = Reflect.get(sails.config, 'servicenowCatalog');
    const originalRecordsService = RecordsService;
    const originalWorkspaceService = WorkspaceService;
    const workspaceUpdates: Array<{ oid: string; record: Record<string, unknown> }> = [];
    const associations: Array<[string, string]> = [];
    const auditOid = 'integration-success-' + Date.now();

    try {
      const definition = createDefaultCatalogDefinition();
      definition.connection.url = testServer.url + '/catalog';
      definition.connection.retry = {
        maxAttempts: 1,
        baseDelayMs: 0,
        maxDelayMs: 0,
        retryOnStatusCodes: []
      };
      definition.idempotency = { enabled: true };
      definition.parentRecord = {
        oid: { kind: 'path', path: 'workspace.metadata.parentOid' }
      };
      definition.requestFields = [{
        destination: 'variables.event',
        source: { kind: 'path', path: 'trigger.event' }
      }];
      definition.responseFields = {
        workspace: [{
          destination: 'metadata.servicenowNumber',
          source: { kind: 'path', path: 'response.result.number' }
        }],
        parentRecord: [{
          destination: 'metadata.servicenowSysId',
          source: { kind: 'path', path: 'response.result.sys_id' }
        }]
      };
      Reflect.set(sails.config, 'servicenowCatalog', {
        enabled: true,
        catalogs: { 'integration-success': definition }
      });
      Reflect.set(globalThis, 'RecordsService', {
        getMeta: async (oid: string) => ({
          metadata: { oid, title: 'Integration parent' }
        }),
        updateMeta: async (
          _brand: unknown,
          oid: string,
          record: Record<string, unknown>
        ) => {
          workspaceUpdates.push({ oid, record });
          return { status: true };
        }
      });
      Reflect.set(globalThis, 'WorkspaceService', {
        addWorkspaceToRecord: async (parentOid: string, workspaceOid: string) => {
          associations.push([parentOid, workspaceOid]);
          return { status: true };
        }
      });

      const defaultBrand = BrandingService.getDefault();
      const submittedWorkspace = {
        metadata: {
          title: 'Integration workspace',
          parentOid: 'integration-parent',
          status: 'Draft'
        },
        metaMetadata: { brandId: defaultBrand.id }
      };
      const service = sails.services.servicenowcatalogservice as ServicenowCatalogService;
      const result = await service.submitRequest(
        auditOid,
        submittedWorkspace,
        { catalog: 'integration-success', event: 'update', idempotencyKey: 'integration-key' },
        { username: 'integration-test' },
        { code: '200', status: true, success: true }
      );
      const retry = await service.submitRequest(
        auditOid,
        submittedWorkspace,
        { catalog: 'integration-success', event: 'update', idempotencyKey: 'integration-key' },
        { username: 'integration-test' },
        {}
      );

      expect(result).to.include({ code: '200', status: true, success: true });
      expect(retry).to.include({ code: '409', status: false, success: false });
      expect(requestCount).to.equal(1);
      expect(associations).to.deep.equal([['integration-parent', auditOid]]);
      expect(workspaceUpdates).to.have.length(2);
      expect(workspaceUpdates[0]).to.deep.include({ oid: auditOid });
      expect(workspaceUpdates[0].record).to.have.nested.property(
        'metadata.servicenowNumber',
        'REQ-INTEGRATION'
      );
      expect(workspaceUpdates[0].record).to.have.nested.property('metadata.status', 'Draft');
      expect(workspaceUpdates[1]).to.deep.include({ oid: 'integration-parent' });
      expect(workspaceUpdates[1].record).to.have.nested.property(
        'metadata.servicenowSysId',
        'sys-integration'
      );

      let auditRows: Record<string, unknown>[] = [];
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const log = await IntegrationAuditService.getAuditLog({
          oid: auditOid,
          integrationName: 'servicenow-catalog',
          page: 1,
          pageSize: 100
        });
        auditRows = log.rows;
        const rootComplete = auditRows.some(row =>
          row.integrationAction === 'submitCatalogRequest' && row.status === 'success'
        );
        if (rootComplete) {
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      expect(auditRows.some(row =>
        row.integrationAction === 'submitCatalogRequest' && row.status === 'success'
      )).to.equal(true);
      expect(auditRows.some(row =>
        row.integrationAction === 'parentMetadataUpdate' && row.status === 'success'
      )).to.equal(true);
    } finally {
      Reflect.set(globalThis, 'RecordsService', originalRecordsService);
      Reflect.set(globalThis, 'WorkspaceService', originalWorkspaceService);
      Reflect.set(sails.config, 'servicenowCatalog', originalConfig);
      await testServer.close();
    }
  });

  it('selects a named catalog in a lifted portal and preserves a workspace on request failure', async function () {
    const testServer = await listen(async (_req, res) => {
      res.statusCode = 503;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'integration failure' }));
    });
    const originalConfig = Reflect.get(sails.config, 'servicenowCatalog');
    try {
      const definition = createDefaultCatalogDefinition();
      definition.connection.url = testServer.url + '/catalog';
      definition.connection.retry = {
        maxAttempts: 1,
        baseDelayMs: 0,
        maxDelayMs: 0,
        retryOnStatusCodes: [503]
      };
      Reflect.set(sails.config, 'servicenowCatalog', {
        enabled: true,
        catalogs: { 'integration-test': definition }
      });
      const defaultBrand = BrandingService.getDefault();
      const submittedWorkspace = {
        metadata: { title: 'Preserved integration workspace' },
        metaMetadata: { brandId: defaultBrand.id }
      };
      const originalWorkspace = structuredClone(submittedWorkspace);
      const service = sails.services.servicenowcatalogservice as ServicenowCatalogService;
      const result = await service.submitRequest(
        'integration-workspace-does-not-persist',
        submittedWorkspace,
        { catalog: 'integration-test', event: 'create' },
        { username: 'integration-test' },
        {}
      );

      expect(result).to.include({ code: '503', status: false, success: false });
      expect(submittedWorkspace).to.deep.equal(originalWorkspace);
    } finally {
      Reflect.set(sails.config, 'servicenowCatalog', originalConfig);
      await testServer.close();
    }
  });
});
