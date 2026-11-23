const legacy = require('./servicenow-catalog-1.0.js');

module.exports.form = {
  forms: {
    'servicenow-catalog-1.0-provisioned': legacy.form.forms['servicenow-catalog-1.0-provisioned']
  }
};
