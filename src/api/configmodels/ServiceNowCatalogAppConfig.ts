import type { ValueBinding as CoreValueBinding } from '@researchdatabox/redbox-core';

/** Brand-aware application configuration for reusable ServiceNow catalog submissions. */

// Reuse the binding contract exposed by core so ServiceNow mappings stay aligned
// with the DOI and Figshare configuration editors.
export type ValueBinding = CoreValueBinding;

export interface ServiceNowFieldMapping {
  /** Dot-notation path in the target object the evaluated value is written to. */
  destination: string;
  source: ValueBinding;
  /** Parse a string result as JSON before writing it to the destination. */
  parseJson?: boolean;
}

/**
 * A post-mapping request transform. The binding receives the current target
 * value as `value`, the complete outgoing body as `request`, and the normal
 * workspace/parent mapping context. A null/undefined result removes the
 * destination; any other result replaces it.
 */
export interface ServiceNowRequestFilter {
  destination: string;
  source: ValueBinding;
}

export interface ServiceNowRetryConfig {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  retryOnStatusCodes: number[];
}

export interface ServiceNowConnectionConfig {
  url: string;
  method: string;
  headers: Record<string, string>;
  /** Per-attempt request timeout. */
  timeoutMs: number;
  /** Overall budget for the whole submit orchestration, retries included. */
  totalTimeoutMs: number;
  retry: ServiceNowRetryConfig;
}

export interface ServiceNowOAuthConfig {
  enabled: boolean;
  url: string;
  clientId: string;
  clientSecret: string;
  scope?: string;
  grantType: 'client_credentials' | 'password' | 'refresh_token';
  username?: string;
  password?: string;
  refreshToken?: string;
}

export interface ServiceNowCatalogDefinition {
  enabled: boolean;
  connection: ServiceNowConnectionConfig;
  oauth: ServiceNowOAuthConfig;
  /** Static request body the request field mappings are applied over. */
  bodyTemplate: Record<string, unknown>;
  /** Mappings from the stable submission context into the outgoing request body. */
  requestFields: ServiceNowFieldMapping[];
  /** Optional JSONata/path transforms applied to the built request body. */
  requestFilters?: ServiceNowRequestFilter[];
  /** Response mappings are independently applied to the workspace and optional parent. */
  responseFields: {
    workspace: ServiceNowFieldMapping[];
    parentRecord?: ServiceNowFieldMapping[];
  };
  /** When present, the binding resolves the record associated with the submitted workspace. */
  parentRecord?: {
    oid: ValueBinding;
  };
  responseNormalization?: {
    /** Parse a JSON-encoded root response string when possible. */
    parseJsonString: boolean;
  };
  idempotency?: {
    enabled: boolean;
    /** Used when a trigger does not supply an explicit idempotency key. */
    key?: ValueBinding;
  };
}

export interface ServiceNowCatalogConfigData {
  enabled: boolean;
  catalogs: Record<string, ServiceNowCatalogDefinition>;
}

export const DEFAULT_SERVICENOW_CATALOG_NAME = 'default';

export function createDefaultCatalogDefinition(): ServiceNowCatalogDefinition {
  return {
    enabled: true,
    connection: {
      url: '',
      method: 'post',
      headers: {},
      timeoutMs: 30000,
      totalTimeoutMs: 120000,
      retry: {
        maxAttempts: 3,
        baseDelayMs: 1000,
        maxDelayMs: 10000,
        retryOnStatusCodes: [408, 429, 500, 502, 503, 504]
      }
    },
    oauth: {
      enabled: false,
      url: '',
      clientId: '',
      clientSecret: '',
      grantType: 'client_credentials'
    },
    bodyTemplate: {
      sysparm_quantity: '1',
      // Required by ServiceNow to avoid the known portal message response issue.
      get_portal_messages: 'true',
      variables: {}
    },
    requestFields: [],
    requestFilters: [],
    responseFields: {
      workspace: [],
      parentRecord: []
    },
    responseNormalization: {
      parseJsonString: true
    },
    idempotency: {
      enabled: false
    }
  };
}

export class ServiceNowCatalogAppConfig implements ServiceNowCatalogConfigData {
  enabled = false;
  catalogs: Record<string, ServiceNowCatalogDefinition> = {};

  public static getFieldOrder(): string[] {
    return ['enabled', 'catalogs'];
  }
}

const VALUE_BINDING_EDITOR_WIDGET = {
  widget: {
    formlyConfig: {
      type: 'value-binding-editor'
    }
  }
};

const VALUE_BINDING_SCHEMA = {
  type: 'object',
  title: 'Value binding',
  properties: {
    kind: {
      type: 'string',
      title: 'Binding type',
      enum: ['path', 'handlebars', 'jsonata'],
      default: 'path'
    },
    path: { type: 'string', title: 'Source path' },
    template: { type: 'string', title: 'Handlebars template' },
    expression: { type: 'string', title: 'JSONata expression' },
    defaultValue: { title: 'Default value' }
  },
  required: ['kind'],
  ...VALUE_BINDING_EDITOR_WIDGET
};

const FIELD_MAPPING_SCHEMA = {
  type: 'object',
  title: 'Field mapping',
  properties: {
    destination: { type: 'string', title: 'Destination path' },
    source: VALUE_BINDING_SCHEMA,
    parseJson: { type: 'boolean', title: 'Parse result as JSON', default: false }
  },
  required: ['destination', 'source']
};

const FIELD_MAPPINGS_SCHEMA = {
  type: 'array',
  items: FIELD_MAPPING_SCHEMA,
  default: []
};

const CATALOG_DEFINITION_SCHEMA = {
  type: 'object',
  title: 'Catalog definition',
  properties: {
    enabled: { type: 'boolean', title: 'Enabled', default: true },
    connection: {
      type: 'object',
      title: 'Connection',
      properties: {
        url: { type: 'string', title: 'Catalog order URL' },
        method: { type: 'string', title: 'HTTP method', default: 'post' },
        headers: {
          type: 'object',
          title: 'Additional headers',
          additionalProperties: { type: 'string' },
          default: {}
        },
        timeoutMs: { type: 'number', title: 'Request timeout (ms)', minimum: 1, default: 30000 },
        totalTimeoutMs: {
          type: 'number',
          title: 'Total orchestration timeout (ms)',
          minimum: 1,
          default: 120000
        },
        retry: {
          type: 'object',
          title: 'Retry',
          properties: {
            maxAttempts: { type: 'number', title: 'Maximum attempts', minimum: 1, default: 3 },
            baseDelayMs: { type: 'number', title: 'Base delay (ms)', minimum: 0, default: 1000 },
            maxDelayMs: { type: 'number', title: 'Maximum delay (ms)', minimum: 0, default: 10000 },
            retryOnStatusCodes: {
              type: 'array',
              title: 'Retry on HTTP status codes',
              items: { type: 'number' },
              default: [408, 429, 500, 502, 503, 504]
            }
          },
          required: ['maxAttempts', 'baseDelayMs', 'maxDelayMs', 'retryOnStatusCodes']
        }
      },
      required: ['url', 'method', 'headers', 'timeoutMs', 'totalTimeoutMs', 'retry']
    },
    oauth: {
      type: 'object',
      title: 'OAuth',
      properties: {
        enabled: { type: 'boolean', title: 'Enabled', default: false },
        url: { type: 'string', title: 'Token URL' },
        clientId: { type: 'string', title: 'Client ID' },
        clientSecret: { type: 'string', title: 'Client secret' },
        scope: { type: 'string', title: 'Scope' },
        grantType: {
          type: 'string',
          title: 'Grant type',
          enum: ['client_credentials', 'password', 'refresh_token'],
          default: 'client_credentials'
        },
        username: { type: 'string', title: 'Username (password grant)' },
        password: { type: 'string', title: 'Password (password grant)' },
        refreshToken: { type: 'string', title: 'Refresh token (refresh_token grant)' }
      },
      required: ['enabled', 'url', 'clientId', 'clientSecret', 'grantType']
    },
    bodyTemplate: { type: 'object', title: 'Request body template', default: {} },
    requestFields: { ...FIELD_MAPPINGS_SCHEMA, title: 'Request field mappings' },
    requestFilters: { ...FIELD_MAPPINGS_SCHEMA, title: 'Request filters / transforms' },
    responseFields: {
      type: 'object',
      title: 'Response field mappings',
      properties: {
        workspace: { ...FIELD_MAPPINGS_SCHEMA, title: 'Workspace mappings' },
        parentRecord: { ...FIELD_MAPPINGS_SCHEMA, title: 'Parent record mappings' }
      },
      required: ['workspace']
    },
    parentRecord: {
      type: 'object',
      title: 'Parent record',
      properties: {
        oid: VALUE_BINDING_SCHEMA
      },
      required: ['oid']
    },
    responseNormalization: {
      type: 'object',
      title: 'Response normalization',
      properties: {
        parseJsonString: {
          type: 'boolean',
          title: 'Parse a JSON-encoded root string',
          default: true
        }
      },
      required: ['parseJsonString']
    },
    idempotency: {
      type: 'object',
      title: 'Idempotency',
      properties: {
        enabled: { type: 'boolean', title: 'Enabled', default: false },
        key: VALUE_BINDING_SCHEMA
      },
      required: ['enabled']
    }
  },
  required: ['enabled', 'connection', 'oauth', 'bodyTemplate', 'requestFields', 'responseFields']
};

export const SERVICENOW_CATALOG_SCHEMA = {
  type: 'object',
  title: 'ServiceNow Catalog',
  properties: {
    enabled: { type: 'boolean', title: 'Enabled', default: false },
    catalogs: {
      type: 'object',
      title: 'Named catalogs',
      additionalProperties: CATALOG_DEFINITION_SCHEMA,
      default: {}
    }
  },
  required: ['enabled', 'catalogs']
};

export const SERVICENOW_CATALOG_CONFIG_KEY = 'servicenowCatalog';

const NAMED_CATALOG_SECRET_SUFFIXES = [
  'connection.headers.Authorization',
  'oauth.clientSecret',
  'oauth.password',
  'oauth.refreshToken'
] as const;

/**
 * AppConfigService currently resolves lodash paths literally and does not
 * expand wildcard map keys. Keep one mutable path list and let its form adapter
 * add concrete, safely quoted catalog paths before core masks or merges them.
 */
export const SERVICENOW_CATALOG_SECRET_FIELDS = [
  'connection.headers.Authorization',
  'oauth.clientSecret',
  'oauth.password',
  'oauth.refreshToken'
];

export function registerServiceNowCatalogSecretFields(model: unknown): unknown {
  if (model == null || typeof model !== 'object' || Array.isArray(model)) {
    return model;
  }
  const catalogs = Reflect.get(model, 'catalogs');
  if (catalogs == null || typeof catalogs !== 'object' || Array.isArray(catalogs)) {
    return model;
  }

  for (const catalogName of Object.keys(catalogs)) {
    const catalogPath = 'catalogs[' + JSON.stringify(catalogName) + ']';
    for (const suffix of NAMED_CATALOG_SECRET_SUFFIXES) {
      const fieldPath = catalogPath + '.' + suffix;
      if (!SERVICENOW_CATALOG_SECRET_FIELDS.includes(fieldPath)) {
        SERVICENOW_CATALOG_SECRET_FIELDS.push(fieldPath);
      }
    }
  }
  return model;
}

export const SERVICENOW_CATALOG_CONFIG_MODEL = {
  key: SERVICENOW_CATALOG_CONFIG_KEY,
  modelName: 'ServiceNowCatalogAppConfig',
  title: 'ServiceNow Catalog',
  class: ServiceNowCatalogAppConfig,
  schema: SERVICENOW_CATALOG_SCHEMA,
  secretFields: SERVICENOW_CATALOG_SECRET_FIELDS,
  formAdapter: {
    toForm: registerServiceNowCatalogSecretFields,
    fromForm: registerServiceNowCatalogSecretFields
  }
};
