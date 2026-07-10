const fs = require('node:fs');
const path = require('node:path');
const { expect } = require('@researchdatabox/redbox-dev-tools/testing');
const { clearHookTestGlobals, installHookTestGlobals } = require('../support/globals');

describe('migrated ServiceNow configuration', function () {
  let hookModule;

  beforeEach(() => {
    installHookTestGlobals();
    hookModule = require('../../dist/index.js');
  });

  afterEach(() => {
    clearHookTestGlobals();
  });

  it('contains only Handlebars runtime templates', function () {
    const runtimeConfig = JSON.stringify({
      config: hookModule.registerRedboxConfig(),
      forms: hookModule.registerRedboxFormConfigs()
    });

    expect(runtimeConfig).not.to.include('<%');
    expect(runtimeConfig).not.to.include('%>');
    expect(runtimeConfig).not.to.include('${');
    expect(runtimeConfig).not.to.include('Not yet implemented in v5');
  });

  it('backs every hook form vocabulary with production bootstrap data', function () {
    const forms = hookModule.registerRedboxFormConfigs();
    const vocabRefs = new Set();

    for (const form of Object.values(forms)) {
      for (const definition of form.componentDefinitions) {
        const config = definition.component?.config;
        if (config?.vocabRef) {
          vocabRefs.add(config.vocabRef);
          expect(config.inlineVocab).to.equal(true);
          expect(config.options).to.deep.equal([]);
        }
      }
    }

    expect([...vocabRefs].sort()).to.deep.equal([
      'servicenow-catalog-storage-sizes',
      'servicenow-catalog-storage-types'
    ]);
    for (const vocabRef of vocabRefs) {
      const vocabPath = path.resolve(
        __dirname,
        '../../bootstrap-data/vocabularies',
        `${vocabRef}.json`
      );
      expect(fs.existsSync(vocabPath), vocabPath).to.equal(true);
      expect(JSON.parse(fs.readFileSync(vocabPath, 'utf8')).slug).to.equal(vocabRef);
    }
  });
});
