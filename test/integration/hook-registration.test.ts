const { expect } = require('@researchdatabox/redbox-dev-tools/testing');

describe('ServiceNow catalog hook integration', function () {
  it('registers the ServiceNow service and all migrated form stages with the lifted portal', function () {
    expect(sails.services.servicenowcatalogservice).to.exist;

    const hookModule = require('@researchdatabox/sails-hook-redbox-servicenow-catalog');
    expect(hookModule.registerRedboxFormConfigs()).to.have.keys([
      'servicenow-catalog-1.0-draft',
      'servicenow-catalog-1.0-provisioning',
      'servicenow-catalog-1.0-provisioned'
    ]);
    expect(sails.config.recordtype).to.have.property('servicenow-catalog');
    expect(sails.config.workflow).to.have.property('servicenow-catalog');

    const defaultBrand = sails.services.brandingservice.getDefault();
    const brandConfig = sails.config.brandingAware(defaultBrand.name);
    expect(brandConfig).to.have.nested.property('servicenowCatalog.enabled', false);
    expect(brandConfig.servicenowCatalog.responseFields).to.be.an('array').that.is.not.empty;
  });
});
