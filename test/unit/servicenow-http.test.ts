import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { ServiceNowCatalogDefinition } from '../../src/api/configmodels/ServiceNowCatalogAppConfig';
import type { SubmitRunContext } from '../../src/api/services/servicenow/context';

const http = require('node:http') as typeof import('node:http');
const { Cause, Effect, Exit } = require('effect') as typeof import('effect');
const { expect } = require('@researchdatabox/redbox-dev-tools/testing') as { expect: Chai.ExpectStatic };
const { createDefaultCatalogDefinition } = require(
  '../../dist/api/configmodels/ServiceNowCatalogAppConfig.js'
) as typeof import('../../src/api/configmodels/ServiceNowCatalogAppConfig');
const { makeLiveClient } = require('../../dist/api/services/servicenow/http.js') as
  typeof import('../../src/api/services/servicenow/http');
const { normalizeServiceNowResponse } = require('../../dist/api/services/servicenow/normalizeResponse.js') as
  typeof import('../../src/api/services/servicenow/normalizeResponse');

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
  return { server, url: 'http://127.0.0.1:' + address.port };
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

function configFor(url: string): ServiceNowCatalogDefinition {
  const config = createDefaultCatalogDefinition();
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

function runContext(): SubmitRunContext {
  return {
    oid: 'workspace-http',
    catalog: 'storage-new',
    event: 'create',
    brandId: 'brand-1',
    brandName: 'default',
    parentAudit: null,
    now: '2026-08-18T00:00:00.000Z'
  };
}

describe('ServiceNow Effect HTTP client', function () {
  let activeServer: Server | undefined;

  afterEach(async () => {
    await close(activeServer);
    activeServer = undefined;
  });

  it('normalizes objects, JSON strings, invalid strings, and disabled parsing', function () {
    const config = createDefaultCatalogDefinition();
    const objectResponse = { result: { number: 'REQ1' } };
    expect(normalizeServiceNowResponse(objectResponse, config)).to.equal(objectResponse);
    expect(normalizeServiceNowResponse('{"result":{"number":"REQ2"}}', config)).to.deep.equal({
      result: { number: 'REQ2' }
    });
    expect(normalizeServiceNowResponse('not-json', config)).to.equal('not-json');
    config.responseNormalization = { parseJsonString: false };
    expect(normalizeServiceNowResponse('{"result":{}}', config)).to.equal('{"result":{}}');
  });

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

    const client = makeLiveClient(configFor(testServer.url + '/catalog'), runContext());
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

    const client = makeLiveClient(configFor(testServer.url + '/catalog'), runContext());
    const exit = await Effect.runPromiseExit(client.submitCatalogOrder({}));

    expect(attempts).to.equal(1);
    expect(Exit.isFailure(exit)).to.equal(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(failure._tag).to.equal('Some');
      if (failure._tag === 'Some') {
        expect(failure.value).to.include({
          _tag: 'CatalogRequestError',
          statusCode: 400,
          retryable: false
        });
        if (failure.value._tag === 'CatalogRequestError') {
          expect(failure.value.responseBody).to.deep.equal({ error: 'bad request' });
        }
      }
    }
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

    const config = configFor(testServer.url + '/catalog');
    config.oauth = {
      enabled: true,
      url: testServer.url + '/oauth',
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

    const config = configFor(testServer.url + '/catalog');
    config.connection.timeoutMs = 10;
    config.connection.retry.maxAttempts = 1;
    const client = makeLiveClient(config, runContext());
    const exit = await Effect.runPromiseExit(client.submitCatalogOrder({}));

    expect(Exit.isFailure(exit)).to.equal(true);
    if (Exit.isFailure(exit)) {
      expect(exit.cause.toString()).to.contain('CatalogTimeoutError');
    }
  });
});
