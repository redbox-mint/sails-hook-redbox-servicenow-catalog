const { expect } = require('@researchdatabox/redbox-dev-tools/testing');
const { clearHookTestGlobals, installHookTestGlobals } = require('../support/globals');

let hookModule;

describe('ServiceNow catalog hook entrypoint', function () {
  beforeEach(() => {
    installHookTestGlobals();
    hookModule = require('../../dist/index.js');
  });

  afterEach(() => {
    clearHookTestGlobals();
  });

  it('registers the migrated config, controller, service, and forms', function () {
    expect(hookModule.registerRedboxConfig()).to.have.keys([
      'auth',
      'recordtype',
      'servicenowCatalog',
      'workflow',
      'workspacetype'
    ]);
    expect(hookModule.registerRedboxServices()).to.have.property('ServicenowCatalogService');
    expect(hookModule.registerRedboxControllers()).to.have.property('CatalogController');
    expect(hookModule.registerRedboxFormConfigs()).to.have.keys([
      'servicenow-catalog-1.0-draft',
      'servicenow-catalog-1.0-provisioning',
      'servicenow-catalog-1.0-provisioned'
    ]);
    expect(hookModule.registerFormConfig()).to.equal(hookModule.registerRedboxFormConfigs());
  });

  it('registers the brand-aware ServiceNow application config model during lift', function () {
    const registered = [];
    let moduleLoaderHandler;
    global.sails.services.appconfigservice = {
      registerConfigModel: model => registered.push(model)
    };
    global.sails.after = (event, handler) => {
      if (event === 'hook:moduleloader:loaded') {
        moduleLoaderHandler = handler;
      }
    };

    const hook = hookModule(global.sails);
    let initialized = false;
    hook.initialize(() => {
      initialized = true;
    });
    moduleLoaderHandler();

    expect(initialized).to.equal(true);
    expect(registered).to.have.length(1);
    expect(registered[0]).to.include({
      key: 'servicenowCatalog',
      modelName: 'ServiceNowCatalogAppConfig'
    });
    expect(new registered[0].class().enabled).to.equal(false);
  });

  it('exposes all three legacy catalog routes through the v5 hook factory', function () {
    const hook = hookModule(global.sails);
    expect(hook.routes.after).to.have.keys([
      'POST /:branding/:portal/ws/catalog/rdmp',
      'POST /:branding/:portal/ws/catalog/request',
      'GET /:branding/:portal/ws/catalog/info'
    ]);
    expect(hook.routes.after['POST /:branding/:portal/ws/catalog/request']).to.include({
      controller: 'CatalogController',
      action: 'request'
    });
  });
});
