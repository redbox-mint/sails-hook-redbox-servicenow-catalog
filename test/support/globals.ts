const { _ } = require('@researchdatabox/redbox-dev-tools/testing') as { _: unknown };

type LogFn = (...args: unknown[]) => void;

const noop: LogFn = () => undefined;

type TestLedgerRow = Record<string, unknown> & {
  id: string;
  claimToken: string;
  status: string;
};

export function createTestIdempotencyLedger() {
  const rows = new Map<string, TestLedgerRow>();
  return {
    rows,
    create: (values: Record<string, unknown>) => ({
      fetch: async () => {
        const row = values as TestLedgerRow;
        if (rows.has(row.id)) {
          throw Object.assign(new Error('duplicate idempotency claim'), { code: 'E_UNIQUE' });
        }
        rows.set(row.id, { ...row });
        return rows.get(row.id);
      }
    }),
    findOne: async (criteria: Record<string, unknown>) => {
      const id = String(criteria.id ?? '');
      return rows.get(id);
    },
    updateOne: (criteria: Record<string, unknown>) => ({
      set: async (values: Record<string, unknown>) => {
        const id = String(criteria.id ?? '');
        const row = rows.get(id);
        if (
          row == null
          || Object.entries(criteria).some(([key, value]) => row[key] !== value)
        ) {
          return undefined;
        }
        const updated = { ...row, ...values };
        rows.set(id, updated);
        return updated;
      }
    })
  };
}

export function setHookTestGlobal(name: string, value: unknown): void {
  Reflect.set(globalThis, name, value);
}

export function getHookTestGlobal<T>(name: string): T | undefined {
  return Reflect.get(globalThis, name) as T | undefined;
}

export function getTestSails(): typeof sails {
  return Reflect.get(globalThis, 'sails') as typeof sails;
}

export function installHookTestGlobals(overrides: Record<string, unknown> = {}): void {
  setHookTestGlobal('_', _);
  setHookTestGlobal('sails', {
    config: {
      appPath: process.cwd(),
      appUrl: 'https://example.redbox.local',
      http: {
        rootContext: 'redbox'
      },
      brandingConfigurationDefaults: {},
      reusableFormDefinitions: {},
      ...overrides
    },
    log: {
      trace: noop,
      verbose: noop,
      info: noop,
      warn: noop,
      error: noop,
      debug: noop
    },
    services: {},
    on: noop,
    after: noop
  });
  setHookTestGlobal('ServicenowCatalogIdempotency', createTestIdempotencyLedger());
}

export function clearHookTestGlobals(): void {
  for (const name of [
    '_',
    'sails',
    'BrandingService',
    'IntegrationAuditService',
    'RecordsService',
    'ServicenowCatalogIdempotency',
    'TranslationService',
    'WorkspaceService'
  ]) {
    Reflect.deleteProperty(globalThis, name);
  }
}

module.exports = {
  installHookTestGlobals,
  clearHookTestGlobals,
  createTestIdempotencyLedger,
  getHookTestGlobal,
  getTestSails,
  setHookTestGlobal
};
