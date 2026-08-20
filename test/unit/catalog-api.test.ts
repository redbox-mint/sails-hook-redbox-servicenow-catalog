import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { CatalogController } from '../../src/api/controllers/CatalogController';
import type { ServicenowCatalogService } from '../../src/api/services/ServicenowCatalogService';

const http = require('node:http') as typeof import('node:http');
const { mock } = require('node:test') as typeof import('node:test');
const { of } = require('rxjs') as typeof import('rxjs');
const { expect } = require('@researchdatabox/redbox-dev-tools/testing') as { expect: Chai.ExpectStatic };
const {
  clearHookTestGlobals,
  getTestSails,
  installHookTestGlobals,
  setHookTestGlobal
} = require('../support/globals') as typeof import('../support/globals');

type HookModule = {
  registerRedboxServices(): { ServicenowCatalogService: ServicenowCatalogService };
  registerRedboxControllers(): { CatalogController: CatalogController };
};

let hookModule: HookModule;

function request(
  params: Record<string, unknown> = {},
  username = 'researcher'
): Sails.Req {
  return Object.assign(Object.create(null) as Sails.Req, {
    headers: {},
    query: {},
    url: '/default/rdmp/ws/catalog/request',
    user: { username },
    param: (name: string) => params[name]
  });
}

function responseCapture(): { res: Sails.Res; value: () => unknown } {
  let payload: unknown;
  const res = Object.assign(Object.create(null) as Sails.Res, {
    set: () => res,
    status: () => res,
    json: (value: unknown) => {
      payload = value;
      return value;
    }
  });
  return { res, value: () => payload };
}

async function listen(
  handler: (req: IncomingMessage, res: ServerResponse) => void
): Promise<{ server: Server; url: string }> {
  const server = http.createServer(handler);
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

describe('ServiceNow catalog API components', function () {
  beforeEach(() => {
    installHookTestGlobals();
    hookModule = require('../../dist/index.js') as HookModule;
  });

  afterEach(() => {
    mock.restoreAll();
    clearHookTestGlobals();
  });

  it('maps an explicit response context into nested workspace metadata', async function () {
    const service = hookModule.registerRedboxServices().ServicenowCatalogService;
    const target = { metadata: {} };

    const result = await service.remapData(
      { response: { result: { number: 'REQ001234', sys_id: 'abc123' } } },
      target,
      [
        {
          source: { kind: 'path', path: 'response.result.number' },
          destination: 'metadata.servicenow_number'
        },
        {
          source: { kind: 'path', path: 'response.result.sys_id' },
          destination: 'metadata.servicenow_sys_id'
        }
      ]
    );

    expect(result).to.deep.equal({
      metadata: {
        servicenow_number: 'REQ001234',
        servicenow_sys_id: 'abc123'
      }
    });
  });

  it('maps legacy catalog form fields into ServiceNow variables', function () {
    const controller = hookModule.registerRedboxControllers().CatalogController;
    const variables = controller.requestToVariables({
      title: { variable: 'short_description', value: 'Research storage' },
      size: { variable: 'requested_size', value: { name: '5 TB' } },
      singleton: { variable: 'location', value: ['Adelaide'] }
    });

    expect(variables).to.deep.equal({
      short_description: 'Research storage',
      requested_size: '5 TB',
      location: 'Adelaide'
    });
  });

  it('requires customer-owned record and workflow names before the legacy request does any work', async function () {
    const testSails = getTestSails();
    Reflect.set(testSails.config, 'workspaces', {
      catalog: {
        domain: 'https://example.service-now.com',
        user: 'legacy-user',
        password: 'legacy-password'
      }
    });
    const controller = hookModule.registerRedboxControllers().CatalogController;
    const captured = responseCapture();

    await controller.request(request(), captured.res);
    expect(captured.value()).to.deep.equal({ status: false });
  });

  it('uses configured customer record/workflow names and preserves the legacy success shape', async function () {
    const requests: Array<{ method?: string; url?: string }> = [];
    const testServer = await listen((req, res) => {
      requests.push({ method: req.method, url: req.url });
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'GET') {
        const email = new URL(req.url ?? '/', 'http://localhost').searchParams.get('sysparm_query');
        res.end(JSON.stringify({
          result: [{ sys_id: email === 'email=assignee@example.edu' ? 'assigned-id' : 'requester-id' }]
        }));
        return;
      }
      res.end(JSON.stringify({
        result: { request_number: 'REQ001234', sys_id: 'ticket-sys-id' }
      }));
    });

    try {
      const testSails = getTestSails();
      Reflect.set(testSails.config, 'workspaces', {
        portal: { authorization: 'Bearer portal-token' },
        catalog: {
          domain: testServer.url,
          user: 'legacy-user',
          password: 'legacy-password',
          assignedToEmail: 'assignee@example.edu',
          taskURL: '/task/',
          recordType: 'customer-workspace',
          workflowStage: 'customer-workspace-draft',
          items: [{ name: 'Storage', id: 'catalog-item-id' }]
        }
      });
      const createWorkspaceRecord = mock.fn((
        _config: unknown,
        _username: string,
        _project: Record<string, unknown>,
        _recordType: string,
        _workflowStage: string
      ) => of({ data: { oid: 'workspace-created' } }));
      const addWorkspaceToRecord = mock.fn(async () => ({ status: true }));
      setHookTestGlobal('BrandingService', {
        getFullPath: () => 'http://redbox/default/rdmp'
      });
      setHookTestGlobal('RecordsService', {
        getMeta: async () => ({ metadata: { title: 'Research Plan' } })
      });
      setHookTestGlobal('WorkspaceService', {
        createWorkspaceRecord,
        addWorkspaceToRecord
      });

      const controller = hookModule.registerRedboxControllers().CatalogController;
      const captured = responseCapture();
      await controller.request(request({
        rdmp: 'parent-1',
        catalogName: 'Storage',
        workspaceType: 'Project storage',
        workspaceInfo: {
          workspaceTitle: 'Storage workspace',
          workspaceDescription: 'for microscopy data'
        },
        request: {
          data_manager: { variable: 'data_manager', value: 'requester@example.edu' },
          data_supervisor: { variable: 'data_supervisor', value: 'supervisor@example.edu' },
          size: { variable: 'size', value: '5 TB' }
        }
      }), captured.res);

      expect(captured.value()).to.deep.equal({
        status: true,
        createTicket: { request_number: 'REQ001234', sys_id: 'ticket-sys-id' },
        request_number: 'REQ001234',
        workspaceLocation: testServer.url + '/task/ticket-sys-id',
        workspaceOid: 'workspace-created'
      });
      expect(requests).to.have.length(3);
      expect(createWorkspaceRecord.mock.calls[0].arguments.slice(3)).to.deep.equal([
        'customer-workspace',
        'customer-workspace-draft'
      ]);
      expect(createWorkspaceRecord.mock.calls[0].arguments[2]).to.include({
        rdmpOid: 'parent-1',
        type: 'customer-workspace'
      });
      expect(addWorkspaceToRecord.mock.calls[0].arguments).to.deep.equal([
        'parent-1',
        'workspace-created'
      ]);
    } finally {
      await new Promise<void>((resolve, reject) => {
        testServer.server.close(error => error == null ? resolve() : reject(error));
        testServer.server.closeAllConnections();
      });
    }
  });

  it('keeps the legacy info and parent-metadata response shapes', async function () {
    setHookTestGlobal('BrandingService', { getFullPath: () => '/default/rdmp' });
    setHookTestGlobal('RecordsService', {
      getMeta: async (oid: string) => ({ metadata: { oid, title: 'Research Plan' } })
    });
    const controller = hookModule.registerRedboxControllers().CatalogController;

    const info = responseCapture();
    controller.info(request(), info.res);
    expect(info.value()).to.deep.equal({ status: true });

    const parent = responseCapture();
    await controller.rdmpInfo(request({ rdmp: 'parent-1' }), parent.res);
    expect(parent.value()).to.deep.equal({
      status: true,
      recordMetadata: { oid: 'parent-1', title: 'Research Plan' }
    });
  });
});
