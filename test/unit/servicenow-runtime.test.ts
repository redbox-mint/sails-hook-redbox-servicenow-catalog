const { Effect } = require('effect') as typeof import('effect');
const { expect } = require('@researchdatabox/redbox-dev-tools/testing') as { expect: Chai.ExpectStatic };
const { sailsLoggerLayer } = require('../../dist/api/services/servicenow/runtime.js') as
  typeof import('../../src/api/services/servicenow/runtime');
const { installHookTestGlobals, clearHookTestGlobals, setHookTestGlobal } = require('../support/globals') as
  typeof import('../support/globals');

describe('ServiceNow Effect runtime logging', function () {
  afterEach(() => clearHookTestGlobals());

  it('routes levels and fiber annotations to Sails once per message', async function () {
    installHookTestGlobals();
    const entries: Array<{ level: string; message: unknown }> = [];
    const logAt = (level: string) => (message: unknown) => { entries.push({ level, message }); };
    setHookTestGlobal('sails', {
      log: { verbose: logAt('verbose'), warn: logAt('warn'), error: logAt('error') }
    });

    await Effect.runPromise(Effect.gen(function* () {
      yield* Effect.logInfo('submitted');
      yield* Effect.logWarning('retry');
      yield* Effect.logError('failed');
    }).pipe(
      Effect.annotateLogs({ oid: 'workspace-log', catalog: 'storage' }),
      Effect.provide(sailsLoggerLayer)
    ));

    expect(entries).to.deep.equal([
      { level: 'verbose', message: 'submitted [oid=workspace-log catalog=storage]' },
      { level: 'warn', message: 'retry [oid=workspace-log catalog=storage]' },
      { level: 'error', message: 'failed [oid=workspace-log catalog=storage]' }
    ]);
  });
});
