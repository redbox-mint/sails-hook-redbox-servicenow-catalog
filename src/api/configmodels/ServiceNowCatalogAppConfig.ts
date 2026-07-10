import { AppConfig, type ValueBinding as CoreValueBinding } from '@researchdatabox/redbox-core';

/** Brand-aware application configuration for the ServiceNow catalog integration. */

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

export interface ServiceNowCatalogConfigData {
  enabled: boolean;
  connection: ServiceNowConnectionConfig;
  oauth: ServiceNowOAuthConfig;
  /** Static request body the request field mappings are applied over. */
  bodyTemplate: Record<string, unknown>;
  /** Mappings from the workspace/rdmp context into the outgoing request body. */
  requestFields: ServiceNowFieldMapping[];
  /** Mappings from the ServiceNow response into the workspace metadata. */
  responseFields: ServiceNowFieldMapping[];
}

export class ServiceNowCatalogAppConfig extends AppConfig implements ServiceNowCatalogConfigData {
  enabled = false;
  connection: ServiceNowConnectionConfig = {
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
  };
  oauth: ServiceNowOAuthConfig = {
    enabled: false,
    url: '',
    clientId: '',
    clientSecret: '',
    grantType: 'client_credentials'
  };
  bodyTemplate: Record<string, unknown> = {
    sysparm_quantity: '1',
    // Required by ServiceNow to avoid the known portal message response issue.
    get_portal_messages: 'true',
    variables: {}
  };
  requestFields: ServiceNowFieldMapping[] = [];
  responseFields: ServiceNowFieldMapping[] = [
    { source: { kind: 'path', path: 'result.cart_id' }, destination: 'metadata.servicenow_cart_id' },
    { source: { kind: 'path', path: 'result.number' }, destination: 'metadata.servicenow_number' },
    { source: { kind: 'path', path: 'result.parent_id' }, destination: 'metadata.servicenow_parent_id' },
    { source: { kind: 'path', path: 'result.parent_table' }, destination: 'metadata.servicenow_parent_table' },
    { source: { kind: 'path', path: 'result.sys_id' }, destination: 'metadata.servicenow_sys_id' },
    { source: { kind: 'path', path: 'result.table' }, destination: 'metadata.servicenow_table' }
  ];

  public static getFieldOrder(): string[] {
    return ['enabled', 'connection', 'oauth', 'bodyTemplate', 'requestFields', 'responseFields'];
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

export const SERVICENOW_CATALOG_SCHEMA = {
  type: 'object',
  properties: {
    enabled: { type: 'boolean', title: 'Enabled', default: false },
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
          }
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
    requestFields: {
      type: 'array',
      title: 'Request field mappings',
      items: FIELD_MAPPING_SCHEMA,
      default: []
    },
    responseFields: {
      type: 'array',
      title: 'Response field mappings',
      items: FIELD_MAPPING_SCHEMA,
      default: []
    }
  },
  required: ['enabled', 'connection', 'oauth', 'bodyTemplate', 'requestFields', 'responseFields']
};

export const SERVICENOW_CATALOG_CONFIG_KEY = 'servicenowCatalog';

export const SERVICENOW_CATALOG_CONFIG_MODEL = {
  key: SERVICENOW_CATALOG_CONFIG_KEY,
  modelName: 'ServiceNowCatalogAppConfig',
  title: 'ServiceNow Catalog',
  class: ServiceNowCatalogAppConfig,
  schema: SERVICENOW_CATALOG_SCHEMA,
  secretFields: [
    'connection.headers.Authorization',
    'oauth.clientSecret',
    'oauth.password',
    'oauth.refreshToken'
  ]
};
