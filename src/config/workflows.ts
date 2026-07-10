import type { WorkflowConfig } from '@researchdatabox/redbox-core';

export const workflows: WorkflowConfig = {
  'servicenow-catalog': {
    'servicenow-catalog-draft': {
      config: {
        workflow: {
          stage: 'servicenow-catalog-draft',
          stageLabel: 'Draft'
        },
        authorization: {
          viewRoles: ['Admin', 'Librarians'],
          editRoles: ['Admin', 'Librarians']
        },
        form: 'servicenow-catalog-1.0-draft',
        displayIndex: 0,
        dashboard: {
          table: {
            rowConfig: [
              {
                title: 'Name',
                variable: 'metadata.title',
                template: '<a href="/{{branding}}/{{portal}}/record/view/{{oid}}">{{metadata.title}}</a>',
                initialSort: 'desc'
              },
              {
                title: 'Description',
                variable: 'metadata.storage_type',
                template: '{{t metadata.storage_type}}'
              },
              {
                title: 'Size',
                variable: 'metadata.storage_size',
                template: '{{metadata.storage_size}}'
              },
              {
                title: 'Location',
                variable: 'metadata.storage_locations',
                template: '{{join metadata.storage_locations "<br/>"}}'
              },
              {
                title: 'Plan',
                variable: 'metadata.rdmpOid',
                template: '<a href="/{{branding}}/{{portal}}/record/view/{{metadata.rdmpOid}}">{{metadata.rdmpTitle}}</a>'
              }
            ]
          }
        }
      },
      starting: true
    },
    'servicenow-catalog-provisioning': {
      config: {
        workflow: {
          stage: 'servicenow-catalog-provisioning',
          stageLabel: 'Provisioning'
        },
        authorization: {
          viewRoles: ['Admin', 'Librarians'],
          editRoles: ['Admin', 'Librarians']
        },
        form: 'servicenow-catalog-1.0-provisioning',
        displayIndex: 1
      }
    },
    'servicenow-catalog-provisioned': {
      config: {
        workflow: {
          stage: 'servicenow-catalog-provisioned',
          stageLabel: 'Provisioned'
        },
        authorization: {
          viewRoles: ['Admin', 'Librarians'],
          editRoles: ['Admin', 'Librarians']
        },
        form: 'servicenow-catalog-1.0-provisioned',
        displayIndex: 2
      }
    }
  }
};
