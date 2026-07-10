const { expect } = require('@researchdatabox/redbox-dev-tools/testing');
const { clearHookTestGlobals, installHookTestGlobals } = require('../support/globals');

describe('ServiceNow catalog API components', function () {
  let hookModule;

  beforeEach(() => {
    installHookTestGlobals();
    hookModule = require('../../dist/index.js');
  });

  afterEach(() => {
    clearHookTestGlobals();
  });

  it('maps ServiceNow response fields into nested workspace metadata', async function () {
    const service = hookModule.registerRedboxServices().ServicenowCatalogService;
    const target = { metadata: {} };

    const result = await service.remapData(
      { result: { number: 'REQ001234', sys_id: 'abc123' } },
      target,
      [
        {
          source: { kind: 'path', path: 'result.number' },
          destination: 'metadata.servicenow_number'
        },
        {
          source: { kind: 'path', path: 'result.sys_id' },
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
});
