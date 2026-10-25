import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { ServiceNowCatalogDefinition } from '../../src/api/configmodels/ServiceNowCatalogAppConfig';
import type { SubmitRunContext } from '../../src/api/services/servicenow/context';

const http = require('node:http') as typeof import('node:http');
const axios = require('axios') as typeof import('axios').default;
const { Cause, Effect, Exit, Fiber, Random } = require('effect') as typeof import('effect');
const { TestClock } = require('effect/testing') as typeof import('effect/testing');
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

  it('retries configured transient statuses until a request succeeds', async function () {
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

  for (const maxAttempts of [6, 1]) {
    it(`caps exponential backoff before jitter and stops after ${maxAttempts} attempt(s)`, async function () {
      const config = configFor('http://servicenow.test/catalog');
      config.connection.timeoutMs = 60_000;
      config.connection.retry = {
        maxAttempts,
        baseDelayMs: 100,
        maxDelayMs: 1000,
        retryOnStatusCodes: [503]
      };
      const requestTimes: number[] = [];
      // Exercise jitter below and above 1, including above the pre-jitter cap.
      const randomValues = [0, 0.25, 0.75, 0.125, 0.875];
      let randomIndex = 0;
      const originalAdapter = axios.defaults.adapter;
      try {
        const exit = await Effect.runPromise(Effect.gen(function* () {
          const clock = yield* TestClock.testClockWith(Effect.succeed);
          axios.defaults.adapter = async request => {
            requestTimes.push(clock.currentTimeMillisUnsafe());
            return { status: 503, statusText: 'Unavailable', data: Buffer.from('{}'), headers: {}, config: request };
          };
          const fiber = yield* makeLiveClient(config, runContext()).submitCatalogOrder({}).pipe(
            Effect.forkChild
          );
          yield* TestClock.adjust('10 seconds');
          return yield* Fiber.await(fiber);
        }).pipe(
          Effect.provide(TestClock.layer()),
          Effect.provideService(Random.Random, {
            nextIntUnsafe: () => { throw new Error('Unexpected integer random draw'); },
            nextDoubleUnsafe: () => randomValues[randomIndex++ % randomValues.length]
          })
        ));

        expect(requestTimes).to.have.length(maxAttempts);
        const delays = requestTimes.slice(1).map((time, i) => time - requestTimes[i]);
        const unjittered = [100, 200, 400, 800, 1000].slice(0, maxAttempts - 1);
        expect(delays).to.have.length(maxAttempts - 1);
        for (const [i, delay] of delays.entries()) {
          // effect/src/Schedule.ts: jittered scales each capped delay by [0.8, 1.2).
          expect(delay).to.be.within(unjittered[i] * 0.8, unjittered[i] * 1.2);
          expect(delay).to.be.closeTo(unjittered[i] * (0.8 + 0.4 * randomValues[i]), 1e-6);
        }
        expect(Exit.isFailure(exit)).to.equal(true);
        if (Exit.isFailure(exit)) {
          const failure = Cause.findErrorOption(exit.cause);
          expect(failure._tag).to.equal('Some');
          if (failure._tag === 'Some') {
            expect(failure.value).to.include({ _tag: 'CatalogRequestError', statusCode: 503, retryable: true });
          }
        }
      } finally {
        axios.defaults.adapter = originalAdapter;
      }
    });
  }

  it('stops retrying transient failures at maxAttempts and preserves the tagged error', async function () {
    let attempts = 0;
    const testServer = await listen((_req, res) => {
      attempts += 1;
      res.statusCode = 503;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'still unavailable' }));
    });
    activeServer = testServer.server;
    const client = makeLiveClient(configFor(testServer.url), runContext());
    const exit = await Effect.runPromiseExit(client.submitCatalogOrder({}));

    expect(attempts).to.equal(3);
    expect(Exit.isFailure(exit)).to.equal(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.findErrorOption(exit.cause);
      expect(failure._tag).to.equal('Some');
      if (failure._tag === 'Some') {
        expect(failure.value).to.include({ _tag: 'CatalogRequestError', statusCode: 503, retryable: true });
      }
    }
  });

  it('does not retry an OAuth rejection or dispatch a catalog order', async function () {
    const paths: Array<string | undefined> = [];
    const testServer = await listen((req, res) => {
      paths.push(req.url);
      res.statusCode = 401;
      res.end('{}');
    });
    activeServer = testServer.server;
    const config = configFor(testServer.url + '/catalog');
    config.oauth = {
      enabled: true, url: testServer.url + '/oauth',
      clientId: 'client', clientSecret: 'secret', grantType: 'client_credentials'
    };
    const exit = await Effect.runPromiseExit(makeLiveClient(config, runContext()).submitCatalogOrder({}));

    expect(paths).to.deep.equal(['/oauth']);
    expect(Exit.isFailure(exit)).to.equal(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.findErrorOption(exit.cause);
      expect(failure._tag).to.equal('Some');
      if (failure._tag === 'Some') {
        expect(failure.value).to.include({ _tag: 'OAuthTokenError', statusCode: 401 });
      }
    }
  });

  it('retries a per-attempt timeout and aborts the timed-out HTTP request', async function () {
    let attempts = 0;
    let closed: (() => void) | undefined;
    const firstClosed = new Promise<void>(resolve => { closed = resolve; });
    const testServer = await listen((_req, res) => {
      attempts += 1;
      if (attempts === 1) {
        res.on('close', () => closed?.());
        return;
      }
      res.end('{}');
    });
    activeServer = testServer.server;
    const config = configFor(testServer.url);
    config.connection.timeoutMs = 50;
    const result = await Effect.runPromise(makeLiveClient(config, runContext()).submitCatalogOrder({}));
    await firstClosed;

    expect(attempts).to.equal(2);
    expect(result.statusCode).to.equal(200);
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
      const failure = Cause.findErrorOption(exit.cause);
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
      const failure = Cause.findErrorOption(exit.cause);
      expect(failure._tag).to.equal('Some');
      if (failure._tag === 'Some') {
        expect(failure.value).to.include({ _tag: 'CatalogTimeoutError', phase: 'request', timeoutMs: 10 });
      }
    }
  });
});
