import type { HookRegistrationMap } from '@researchdatabox/redbox-core';
import type { CatalogController } from '../../src/api/controllers/CatalogController';
import type { ServicenowCatalogService } from '../../src/api/services/ServicenowCatalogService';

const { expect } = require('@researchdatabox/redbox-dev-tools/testing') as { expect: Chai.ExpectStatic };
const {
  clearHookTestGlobals,
  getTestSails,
  installHookTestGlobals
} = require('../support/globals') as typeof import('../support/globals');

type RegisteredConfigModel = {
  key: string;
  modelName: string;
  class: new () => { enabled: boolean; catalogs: Record<string, unknown> };
  tsGlob: string;
};

type HookInstance = {
  initialize(done: () => void): void;
  routes: { after: Record<string, { controller: string; action: string }> };
};

type HookModule = {
  (sailsInstance: typeof sails): HookInstance;
  registerRedboxConfig(): HookRegistrationMap;
  registerRedboxModels(): HookRegistrationMap;
  registerRedboxServices(): { ServicenowCatalogService: ServicenowCatalogService };
  registerRedboxControllers(): { CatalogController: CatalogController };
  registerRedboxFormConfigs?: () => unknown;
  registerFormConfig?: () => unknown;
};

let hookModule: HookModule;

describe('ServiceNow catalog hook entrypoint', function () {
  beforeEach(() => {
    installHookTestGlobals();
    hookModule = require('../../dist/index.js') as HookModule;
  });

  afterEach(() => {
    clearHookTestGlobals();
  });

  it('registers reusable config, model, controller, and service surfaces', function () {
    expect(hookModule.registerRedboxConfig()).to.have.keys(['auth', 'servicenowCatalog']);
    expect(hookModule.registerRedboxModels()).to.have.keys(['ServicenowCatalogIdempotency']);
    expect(hookModule.registerRedboxServices()).to.have.property('ServicenowCatalogService');
    expect(hookModule.registerRedboxControllers()).to.have.property('CatalogController');
    expect(hookModule.registerRedboxFormConfigs).to.equal(undefined);
    expect(hookModule.registerFormConfig).to.equal(undefined);
  });

  it('registers the named-catalog application config model during lift', function () {
    const registered: RegisteredConfigModel[] = [];
    let moduleLoaderHandler: (() => void) | undefined;
    const testSails = getTestSails();
    Reflect.set(testSails.services, 'appconfigservice', {
      registerConfigModel: (model: RegisteredConfigModel) => registered.push(model)
    });
    testSails.after = (event: string | string[], handler: () => void) => {
      if (event === 'hook:moduleloader:loaded') {
        moduleLoaderHandler = handler;
      }
    };

    const hook = hookModule(testSails);
    let initialized = false;
    hook.initialize(() => {
      initialized = true;
    });
    expect(moduleLoaderHandler).to.be.a('function');
    moduleLoaderHandler?.();

    expect(initialized).to.equal(true);
    expect(registered).to.have.length(1);
    expect(registered[0]).to.include({
      key: 'servicenowCatalog',
      modelName: 'ServiceNowCatalogAppConfig'
    });
    expect(registered[0].tsGlob).to.equal(
      require('node:path').join(__dirname, '../../src/api/configmodels/*.ts')
    );
    expect(new registered[0].class()).to.deep.include({ enabled: false, catalogs: {} });
  });

  it('retains the three isolated compatibility routes and their auth rule', function () {
    const hook = hookModule(getTestSails());
    expect(hook.routes.after).to.have.keys([
      'POST /:branding/:portal/ws/catalog/rdmp',
      'POST /:branding/:portal/ws/catalog/request',
      'GET /:branding/:portal/ws/catalog/info'
    ]);
    expect(hook.routes.after['POST /:branding/:portal/ws/catalog/request']).to.include({
      controller: 'CatalogController',
      action: 'request'
    });
    const auth = hookModule.registerRedboxConfig().auth as { rules: Array<Record<string, unknown>> };
    expect(auth.rules[0]).to.deep.include({
      path: '/:branding/:portal/ws/catalog(/*)',
      role: 'Researcher',
      can_update: true
    });
  });
});
