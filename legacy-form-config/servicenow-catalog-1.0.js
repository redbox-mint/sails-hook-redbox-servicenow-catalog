// Preserved v4 source used to produce the stage-specific v5 form configs.
const commonFields = [
  {
    class: 'Container',
    compClass: 'TextBlockComponent',
    definition: {
      type: 'h1',
      value: '@servicenow-catalog-label'
    }
  },
  {
    class: 'Container',
    compClass: 'TextBlockComponent',
    definition: {
      type: 'h2',
      value: '@servicenow-catalog-description'
    }
  },
  {
    class: 'SelectionField',
    compClass: 'SelectionFieldComponent',
    definition: {
      name: 'storage_type',
      label: '@servicenow-catalog-storage-type',
      help: '@servicenow-catalog-storage-type-help',
      controlType: 'radio',
      required: true,
      options: [
        {
          value: "@servicenow-catalog-storage-type-hpc",
          label: "@servicenow-catalog-storage-type-hpc"
        },
        {
          value: "@servicenow-catalog-storage-type-cloudstor",
          label: "@servicenow-catalog-storage-type-cloudstor"
        },
        {
          value: "@servicenow-catalog-storage-type-s3",
          label: "@servicenow-catalog-storage-type-s3"
        },
        {
          value: "@servicenow-catalog-storage-type-gcp",
          label: "@servicenow-catalog-storage-type-gcp"
        }
      ]
    }
  },
  {
    class: 'SelectionField',
    compClass: 'SelectionFieldComponent',
    definition: {
      name: 'storage_size',
      label: '@servicenow-catalog-storage-size',
      help: '@servicenow-catalog-storage-size-help',
      controlType: 'radio',
      required: true,
      options: [
        {
          value: "@servicenow-catalog-storage-size-less-than-1tb",
          label: "@servicenow-catalog-storage-size-less-than-1tb"
        },
        {
          value: "@servicenow-catalog-storage-size-1-5tb",
          label: "@servicenow-catalog-storage-size-1-5tb"
        },
        {
          value: "@servicenow-catalog-storage-size-more-than-5tb",
          label: "@servicenow-catalog-storage-size-more-than-5tb"
        }
      ]
    }
  },
  {
    class: 'Textfield',
    compClass: 'TextfieldComponent',
    viewOnly: true,
    definition: {
      label: "Storage locations",
      name: "storage_locations"
    }
  }
// Some hidden fields...
  ,
  {
    class: "ParameterRetriever",
    compClass: 'ParameterRetrieverComponent',
    editOnly: true,
    definition: {
      name: 'parameterRetriever',
      parameterName:'rdmp'
    }
  },
  {
    class: 'RecordMetadataRetriever',
    compClass: 'RecordMetadataRetrieverComponent',
    editOnly: true,
    definition: {
      name: 'rdmpGetter',
      subscribe: {
        'parameterRetriever': {
          onValueUpdate: [{
            action: 'publishMetadata'
          }]
        }
      }
    }
  },
  {
    class: 'HiddenValue',
    editOnly: true,
    definition: {
      name: 'rdmpOid',
      subscribe: {
        'rdmpGetter': {
          onValueUpdate: [
            {
              action: 'utilityService.getPropertyFromObject',
              field: 'oid'
            }
          ]
        }
      }
    }
  },
  {
    class: 'HiddenValue',
    editOnly: true,
    definition: {
      name: 'rdmpTitle',
      subscribe: {
        'rdmpGetter': {
          onValueUpdate: [
            {
              action: 'utilityService.getPropertyFromObject',
              field: 'title'
            }
          ]
        }
      }
    }
  }
];

const draftFields = commonFields.slice(0);
draftFields.push({
  class: 'SaveButton',
  compClass: 'SaveButtonComponent',
  definition: {
    label: "@servicenow-catalog-submit-request",
    targetStep: 'servicenow-catalog-provisioning',
    closeOnSave: true,
    redirectLocation: '/@branding/@portal/record/edit/@referrer_rdmp?focusTabId=workspaces'
  },
  variableSubstitutionFields: ['redirectLocation']
});

const readOnlyFields = commonFields.slice(0);

const formMessages = {
  "saving": ["@dmpt-form-saving"],
  "validationFail": ["@dmpt-form-validation-fail-prefix", "@dmpt-form-validation-fail-suffix"],
  "saveSuccess": ["@dmpt-form-save-success"],
  "saveError": ["@dmpt-form-save-error"]
};

module.exports.form = {
  forms: {
    "servicenow-catalog-1.0-draft": {
      name: "servicenow-catalog-1.0-draft",
      type: "servicenow-catalog",
      skipValidationOnSave: false,
      editCssClasses: 'row col-md-12',
      viewCssClasses: 'row col-md-offset-1 col-md-10',
      messages: formMessages,
      fields: draftFields
    },
    "servicenow-catalog-1.0-provisioning": {
      name: "servicenow-catalog-1.0-provisioning",
      type: "servicenow-catalog",
      skipValidationOnSave: false,
      editCssClasses: 'row col-md-12',
      viewCssClasses: 'row col-md-offset-1 col-md-10',
      messages: formMessages,
      fields: readOnlyFields
    },
    "servicenow-catalog-1.0-provisioned": {
      name: "servicenow-catalog-1.0-provisioned",
      type: "servicenow-catalog",
      skipValidationOnSave: false,
      editCssClasses: 'row col-md-12',
      viewCssClasses: 'row col-md-offset-1 col-md-10',
      messages: formMessages,
      fields: readOnlyFields
    }
  }
};
