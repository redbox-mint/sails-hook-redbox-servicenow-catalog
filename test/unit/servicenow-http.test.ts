import type { IncomingMessage, Server, ServerResponse } from 'node:http';

const http = require('node:http') as typeof import('node:http');
const { Cause, Effect, Exit } = require('effect');
const { expect } = require('@researchdatabox/redbox-dev-tools/testing');

type TestServer = {
  server: Server;
  url: string;
};

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<TestServer> {
  const server = http.createServer(handler);
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

async function close(server: Server | undefined): Promise<void> {
  if (server == null) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    server.close(error => error == null ? resolve() : reject(error));
    server.closeAllConnections();
  });
}

describe('ServiceNow Effect HTTP client', function () {
  let activeServer: Server | undefined;
  let ServiceNowCatalogAppConfig;
  let makeLiveClient;

  beforeEach(() => {
    ({ ServiceNowCatalogAppConfig } = require('../../dist/api/configmodels/ServiceNowCatalogAppConfig.js'));
    ({ makeLiveClient } = require('../../dist/api/services/servicenow/http.js'));
  });

  afterEach(async () => {
    await close(activeServer);
    activeServer = undefined;
  });

  function configFor(url: string) {
    const config = new ServiceNowCatalogAppConfig();
    config.enabled = true;
    config.connection.url = url;
    config.connection.timeoutMs = 250;
    config.connection.totalTimeoutMs = 1000;
    config.connection.retry = {
      maxAttempts: 3,
      baseDelayMs: 1,
      maxDelayMs: 1,
      retryOnStatusCodes: [429, 503]
    };
    return config;
  }

  function runContext() {
    return {
      oid: 'workspace-http',
      rdmpOid: 'rdmp-http',
      brandId: 'brand-1',
      brandName: 'default',
      parentAudit: null
    };
  }

  it('retries configured transient statuses with bounded exponential scheduling', async function () {
    let attempts = 0;
    const testServer = await listen((_req, res) => {
      attempts += 1;
      res.setHeader('Content-Type', 'application/json');
      if (attempts < 3) {
        res.statusCode = 503;
        res.end(JSON.stringify({ error: 'temporarily unavailable' }));
        return;
      }
      res.statusCode = 201;
      res.end(JSON.stringify({ result: { number: 'REQ0001' } }));
    });
    activeServer = testServer.server;

    const client = makeLiveClient(configFor(`${testServer.url}/catalog`), runContext());
    const result = await Effect.runPromise(client.submitCatalogOrder({ variables: { title: 'Storage' } }));

    expect(attempts).to.equal(3);
    expect(result).to.deep.equal({
      statusCode: 201,
      data: { result: { number: 'REQ0001' } }
    });
  });

  it('does not retry a non-transient response status', async function () {
    let attempts = 0;
    const testServer = await listen((_req, res) => {
      attempts += 1;
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'bad request' }));
    });
    activeServer = testServer.server;

    const client = makeLiveClient(configFor(`${testServer.url}/catalog`), runContext());
    const exit = await Effect.runPromiseExit(client.submitCatalogOrder({}));

    expect(attempts).to.equal(1);
    expect(Exit.isFailure(exit)).to.equal(true);
    const failure = Cause.failureOption(exit.cause);
    expect(failure._tag).to.equal('Some');
    expect(failure.value).to.include({ _tag: 'CatalogRequestError', statusCode: 400, retryable: false });
  });

  it('memoizes one OAuth token across retried catalog attempts', async function () {
    let tokenRequests = 0;
    let catalogRequests = 0;
    const authorizations: Array<string | undefined> = [];
    const testServer = await listen((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/oauth') {
        tokenRequests += 1;
        res.end(JSON.stringify({ access_token: 'test-token' }));
        return;
      }
      catalogRequests += 1;
      authorizations.push(req.headers.authorization);
      if (catalogRequests === 1) {
        res.statusCode = 503;
        res.end(JSON.stringify({ error: 'retry me' }));
        return;
      }
      res.end(JSON.stringify({ result: { sys_id: 'sys-1' } }));
    });
    activeServer = testServer.server;

    const config = configFor(`${testServer.url}/catalog`);
    config.oauth = {
      enabled: true,
      url: `${testServer.url}/oauth`,
      clientId: 'client-id',
      clientSecret: 'client-secret',
      grantType: 'client_credentials'
    };
    const client = makeLiveClient(config, runContext());
    await Effect.runPromise(client.submitCatalogOrder({}));

    expect(tokenRequests).to.equal(1);
    expect(catalogRequests).to.equal(2);
    expect(authorizations).to.deep.equal(['Bearer test-token', 'Bearer test-token']);
  });

  it('interrupts a slow request at the per-attempt timeout', async function () {
    const testServer = await listen((_req, res) => {
      setTimeout(() => {
        if (!res.destroyed) {
          res.end(JSON.stringify({ result: {} }));
        }
      }, 100);
    });
    activeServer = testServer.server;

    const config = configFor(`${testServer.url}/catalog`);
    config.connection.timeoutMs = 10;
    config.connection.retry.maxAttempts = 1;
    const client = makeLiveClient(config, runContext());
    const exit = await Effect.runPromiseExit(client.submitCatalogOrder({}));

    expect(Exit.isFailure(exit)).to.equal(true);
    expect(exit.cause.toString()).to.contain('CatalogTimeoutError');
  });
});
