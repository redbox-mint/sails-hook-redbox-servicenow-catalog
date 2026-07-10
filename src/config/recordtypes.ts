import type { RecordTypeConfig } from '@researchdatabox/redbox-core';

export const recordtypes: RecordTypeConfig = {
  'servicenow-catalog': {
    packageType: 'workspace',
    packageName: 'servicenow-catalog',
    searchable: false,
    searchFilters: [
      {
        name: 'text_title',
        title: 'search-refine-title',
        type: 'exact',
        typeLabel: 'search-refine-contains'
      },
      {
        name: 'text_description',
        title: 'search-refine-description',
        type: 'exact',
        typeLabel: 'search-refine-contains'
      }
    ],
    hooks: {
      onCreate: {
        postSync: [
          {
            function: 'sails.services.servicenowcatalogservice.submitRequest',
            options: {}
          }
        ]
      }
    }
  }
};
