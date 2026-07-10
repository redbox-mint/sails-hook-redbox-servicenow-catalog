import type { FormConfigFrame } from '@researchdatabox/sails-ng-common';

const validationGroups: NonNullable<FormConfigFrame['validationGroups']> = {
  all: {
    description: 'Validate all fields with validators.',
    initialMembership: 'all'
  },
  none: {
    description: 'Validate none of the fields.',
    initialMembership: 'none'
  }
};

const loadParentPlan: NonNullable<FormConfigFrame['behaviours']>[number] = {
  name: 'load-parent-plan',
  description: 'Load the parent plan referenced by the rdmp request parameter.',
  runOnFormReady: true,
  conditionKind: 'jsonata_query',
  condition: '$exists(runtimeContext.requestParams.rdmp) and event.sourceId = "form.definition.ready"',
  processors: [
    {
      type: 'jsonataTransform',
      config: {
        template: 'runtimeContext.requestParams.rdmp'
      }
    },
    {
      type: 'fetchMetadata'
    }
  ],
  actions: [
    {
      type: 'setValue',
      config: {
        fieldPath: '/rdmpOid',
        valueTemplate: 'value.oid',
        hasValueTemplate: true
      }
    },
    {
      type: 'setValue',
      config: {
        fieldPath: '/rdmpTitle',
        valueTemplate: 'value.title',
        hasValueTemplate: true
      }
    }
  ]
};

function commonComponents(): FormConfigFrame['componentDefinitions'] {
  return [
    {
      name: 'catalog-heading',
      component: {
        class: 'ContentComponent',
        config: {
          template: '<h1>{{t content}}</h1>',
          content: '@servicenow-catalog-label'
        }
      },
      layout: {
        class: 'DefaultLayout',
        config: {}
      }
    },
    {
      name: 'catalog-description',
      component: {
        class: 'ContentComponent',
        config: {
          template: '<h2>{{t content}}</h2>',
          content: '@servicenow-catalog-description'
        }
      },
      layout: {
        class: 'DefaultLayout',
        config: {}
      }
    },
    {
      name: 'storage_type',
      component: {
        class: 'RadioInputComponent',
        config: {
          label: '@servicenow-catalog-storage-type',
          vocabRef: 'servicenow-catalog-storage-types',
          inlineVocab: true,
          options: []
        }
      },
      model: {
        class: 'RadioInputModel',
        config: {
          validators: [{ class: 'required' }]
        }
      },
      layout: {
        class: 'DefaultLayout',
        config: {
          label: '@servicenow-catalog-storage-type',
          helpText: '@servicenow-catalog-storage-type-help'
        }
      }
    },
    {
      name: 'storage_size',
      component: {
        class: 'RadioInputComponent',
        config: {
          label: '@servicenow-catalog-storage-size',
          vocabRef: 'servicenow-catalog-storage-sizes',
          inlineVocab: true,
          options: []
        }
      },
      model: {
        class: 'RadioInputModel',
        config: {
          validators: [{ class: 'required' }]
        }
      },
      layout: {
        class: 'DefaultLayout',
        config: {
          label: '@servicenow-catalog-storage-size',
          helpText: '@servicenow-catalog-storage-size-help'
        }
      }
    },
    {
      name: 'storage_locations',
      constraints: {
        authorization: { allowRoles: [] },
        allowModes: ['view']
      },
      component: {
        class: 'SimpleInputComponent',
        config: {
          label: 'Storage locations',
          readonly: true
        }
      },
      model: {
        class: 'SimpleInputModel',
        config: {}
      },
      layout: {
        class: 'DefaultLayout',
        config: {
          label: 'Storage locations'
        }
      }
    },
    {
      name: 'rdmpOid',
      constraints: {
        authorization: { allowRoles: [] },
        allowModes: ['edit']
      },
      component: {
        class: 'SimpleInputComponent',
        config: {
          type: 'hidden',
          visible: false
        }
      },
      model: {
        class: 'SimpleInputModel',
        config: {}
      },
      layout: {
        class: 'DefaultLayout',
        config: {
          visible: false
        }
      }
    },
    {
      name: 'rdmpTitle',
      constraints: {
        authorization: { allowRoles: [] },
        allowModes: ['edit']
      },
      component: {
        class: 'SimpleInputComponent',
        config: {
          type: 'hidden',
          visible: false
        }
      },
      model: {
        class: 'SimpleInputModel',
        config: {}
      },
      layout: {
        class: 'DefaultLayout',
        config: {
          visible: false
        }
      }
    },
    {
      name: 'validation_summary',
      component: {
        class: 'ValidationSummaryComponent'
      }
    }
  ];
}

export function buildServiceNowCatalogForm(name: string, submit = false): FormConfigFrame {
  const componentDefinitions = commonComponents();

  if (submit) {
    componentDefinitions.push({
      name: 'submit-servicenow-request',
      constraints: {
        authorization: { allowRoles: [] },
        allowModes: ['edit']
      },
      component: {
        class: 'SaveButtonComponent',
        config: {
          label: '@servicenow-catalog-submit-request',
          targetStep: 'servicenow-catalog-provisioning',
          buttonCssClasses: 'btn btn-success',
          closeOnSave: true,
          redirectLocation: '/@branding/@portal/record/edit/@referrer_rdmp?focusTabId=workspaces',
          redirectDelaySeconds: 0
        }
      },
      layout: {
        class: 'InlineLayout',
        config: {}
      }
    });
  }

  return {
    name,
    type: 'servicenow-catalog',
    viewCssClasses: 'redbox-form form rb-form-view',
    editCssClasses: 'redbox-form form rb-form-edit',
    enabledValidationGroups: ['all'],
    validators: [],
    validationGroups,
    behaviours: submit ? [loadParentPlan] : [],
    componentDefinitions,
    debugValue: false,
    attachmentFields: []
  };
}
