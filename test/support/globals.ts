const { _ } = require('@researchdatabox/redbox-dev-tools/testing');

type LogFn = (...args: unknown[]) => void;

const noop: LogFn = () => undefined;

function installHookTestGlobals(overrides: Record<string, unknown> = {}): void {
  (global as any)._ = _;
  (global as any).sails = {
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
  };
}

function clearHookTestGlobals(): void {
  delete (global as any)._;
  delete (global as any).sails;
  delete (global as any).BrandingService;
  delete (global as any).IntegrationAuditService;
  delete (global as any).RecordsService;
  delete (global as any).TranslationService;
  delete (global as any).WorkspaceService;
}

module.exports = {
  installHookTestGlobals,
  clearHookTestGlobals
};
