import { Services as CoreServices } from '@researchdatabox/redbox-core';
import { Cause, Duration, Effect, Exit, Fiber } from 'effect';
import {
  SERVICENOW_CATALOG_CONFIG_KEY,
  ServiceNowCatalogAppConfig,
  type ServiceNowCatalogConfigData,
  type ServiceNowFieldMapping
} from '../configmodels/ServiceNowCatalogAppConfig';
import {
  ServiceNowAuditAction,
  completeCatalogAudit,
  failCatalogAudit,
  registerServiceNowOutcomeMapper,
  startCatalogAudit,
  withIntegrationAudit,
  type IntegrationAuditContext
} from './servicenow/audit';
import { ServiceNowConfigTag, SubmitRunContextTag, type SubmitRunContext } from './servicenow/context';
import {
  CatalogTimeoutError,
  RdmpLookupError,
  ServiceNowConfigError,
  WorkspaceAssociationError,
  WorkspaceUpdateError,
  causeMessage,
  errorDescription,
  errorHttpCode,
  type ServiceNowCatalogError
} from './servicenow/errors';
import { ServiceNowClientTag, type ServiceNowHttpResult } from './servicenow/http';
import { applyFieldMappings } from './servicenow/mapping';
import { makeRuntimeLayer } from './servicenow/runtime';

interface WorkspaceRecord {
  metadata: Record<string, unknown>;
  metaMetadata?: { brandId?: string;[key: string]: unknown };
  [key: string]: unknown;
}

interface TriggerResponse {
  code?: string;
  status?: boolean;
  success?: boolean;
  message?: string;
  [key: string]: unknown;
}

interface WorkspaceServiceContract {
  addWorkspaceToRecord(targetRecordOid: string, workspaceOid: string): Promise<unknown>;
}

interface RecordsServiceContract {
  getMeta(oid: string): Promise<Record<string, unknown>>;
  updateMeta(brand: unknown, oid: string, record: WorkspaceRecord): Promise<unknown>;
}

interface TranslationServiceContract {
  t(key: string): string;
}

interface BrandingServiceContract {
  getBrandById(id: string): { id?: string; name?: string } | undefined;
  getBrand(name: string): { id?: string; name?: string } | undefined;
}

declare const WorkspaceService: WorkspaceServiceContract;
declare const RecordsService: RecordsServiceContract;
declare const TranslationService: TranslationServiceContract;
declare const BrandingService: BrandingServiceContract;

type BrandingAwareFn = (brandName: string) => Record<string, unknown> | undefined;

interface ResolvedBrand {
  brandId: string;
  brandName: string;
  brand: { id?: string; name?: string };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

/** Merges override into base recursively; arrays and primitives replace wholesale. */
function mergeConfig<T>(base: T, override: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return (override === undefined ? base : override) as T;
  }
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    merged[key] = mergeConfig(merged[key], value);
  }
  return merged as T;
}

export namespace Services {
  export class ServicenowCatalog extends CoreServices.Core.Service {
    protected override _exportedMethods: string[] = [
      'init',
      'submitRequest',
      'remapData'
    ];

    private readonly inFlight = new Set<Fiber.RuntimeFiber<ServiceNowHttpResult, ServiceNowCatalogError>>();

    public init(): void {
      this.registerSailsHook('on', 'ready', () => this.registerOutcomeMapper());
      this.registerSailsHook('on', 'lower', () => this.interruptInFlight());
    }

    public async submitRequest(
      oid: string,
      workspaceData: WorkspaceRecord,
      options: Record<string, unknown>,
      user: { username?: string } | undefined,
      response: TriggerResponse
    ): Promise<TriggerResponse> {
      this.logger.verbose(`ServiceNow catalog processing request for ${oid}.`);

      const rdmpOid = String(workspaceData.metadata?.rdmpOid ?? '').trim();
      const resolvedBrand = this.resolveBrand(oid, workspaceData);
      if (resolvedBrand instanceof ServiceNowConfigError) {
        return this.fail(response, errorHttpCode(resolvedBrand), errorDescription(resolvedBrand));
      }
      const { brandId, brandName, brand } = resolvedBrand;
      const config = this.resolveConfig(brandName, options);

      if (typeof config.enabled !== 'boolean') {
        return this.fail(response, '500', 'ServiceNow Catalog enabled configuration must be a boolean.');
      }
      if (!config.enabled) {
        this.logger.verbose(`ServiceNow catalog integration is disabled for brand '${brandName}'; skipping ${oid}.`);
        return response;
      }

      const parentAudit = startCatalogAudit(oid, ServiceNowAuditAction.submitCatalogRequest, {
        brandId,
        triggeredBy: user?.username,
        requestSummary: {
          rdmpOid,
          brandName,
          url: isPlainObject(config.connection) ? String(config.connection.url ?? '') : ''
        }
      });
      const configError = this.validateConfig(oid, rdmpOid, config);
      if (configError != null) {
        const message = errorDescription(configError);
        failCatalogAudit(parentAudit, configError, { message });
        return this.fail(response, errorHttpCode(configError), message);
      }
      const runContext: SubmitRunContext = {
        oid,
        rdmpOid,
        brandId,
        brandName,
        triggeredBy: user?.username,
        parentAudit
      };

      const program = this.submitProgram(workspaceData, brand).pipe(
        Effect.timeoutFail({
          duration: Duration.millis(config.connection.totalTimeoutMs),
          onTimeout: () => new CatalogTimeoutError({
            oid,
            timeoutMs: config.connection.totalTimeoutMs,
            phase: 'orchestration'
          })
        }),
        Effect.withSpan('servicenow.submitRequest', {
          attributes: { oid, rdmpOid, brand: brandName }
        }),
        Effect.provide(makeRuntimeLayer(config, runContext))
      );

      // Run as a tracked fiber so an in-flight submission can be interrupted
      // (and audited as interrupted) when Sails lowers mid-request.
      const fiber = Effect.runFork(program);
      this.inFlight.add(fiber);
      let exit: Exit.Exit<ServiceNowHttpResult, ServiceNowCatalogError>;
      try {
        exit = await Effect.runPromise(Fiber.await(fiber));
      } finally {
        this.inFlight.delete(fiber);
      }

      return this.concludeSubmit(oid, parentAudit, exit, response);
    }

    /**
     * Applies the configured field mappings from `source` onto `target`.
     * Exposed for trigger/template reuse; mapping evaluation is asynchronous
     * because JSONata bindings evaluate asynchronously.
     */
    public remapData<T>(source: unknown, target: T, mappings: ServiceNowFieldMapping[]): Promise<T> {
      const context = this.mappingContext(source);
      return Effect.runPromise(applyFieldMappings('remapData', mappings, context, target));
    }

    private submitProgram(
      workspaceData: WorkspaceRecord,
      brand: unknown
    ): Effect.Effect<
      ServiceNowHttpResult,
      ServiceNowCatalogError,
      ServiceNowCatalogConfigData | SubmitRunContext | import('./servicenow/http').ServiceNowClient
    > {
      return Effect.gen(this, function* (this: ServicenowCatalog) {
        const runContext = yield* SubmitRunContextTag;
        const config = yield* ServiceNowConfigTag;
        const client = yield* ServiceNowClientTag;
        const { oid, rdmpOid } = runContext;

        yield* Effect.tryPromise({
          try: () => WorkspaceService.addWorkspaceToRecord(rdmpOid, oid),
          catch: cause => new WorkspaceAssociationError({ oid, rdmpOid, cause })
        }).pipe(
          Effect.withSpan('servicenow.associateWorkspace', { attributes: { oid, rdmpOid } }),
          withIntegrationAudit(oid, ServiceNowAuditAction.associateWorkspace, {
            brandId: runContext.brandId,
            triggeredBy: runContext.triggeredBy,
            parent: runContext.parentAudit,
            requestSummary: { rdmpOid },
            onSuccess: () => ({ message: 'Workspace associated with its parent RDMP.' })
          })
        );

        const rdmpData = yield* Effect.tryPromise({
          try: () => RecordsService.getMeta(rdmpOid),
          catch: cause => new RdmpLookupError({ oid, rdmpOid, cause })
        }).pipe(Effect.withSpan('servicenow.getRdmpMeta', { attributes: { oid, rdmpOid } }));

        const requestBody = yield* applyFieldMappings(
          oid,
          config.requestFields,
          this.mappingContext({ workspace: workspaceData, rdmp: rdmpData, oid, brand: runContext.brandName }),
          structuredClone(config.bodyTemplate)
        );

        yield* Effect.logInfo(`ServiceNow catalog submitting order for workspace ${oid}.`).pipe(
          Effect.annotateLogs({ oid, rdmpOid, brand: runContext.brandName })
        );

        const result = yield* client.submitCatalogOrder(requestBody).pipe(
          withIntegrationAudit(oid, ServiceNowAuditAction.catalogOrderRequest, {
            brandId: runContext.brandId,
            triggeredBy: runContext.triggeredBy,
            parent: runContext.parentAudit,
            requestSummary: { url: config.connection.url, method: config.connection.method },
            onSuccess: httpResult => ({
              message: 'ServiceNow catalog order accepted.',
              httpStatusCode: httpResult.statusCode,
              responseSummary: isPlainObject(httpResult.data) ? httpResult.data : { rawResponseBody: httpResult.data }
            }),
            onFailure: error => ({
              message: 'ServiceNow catalog order failed.',
              httpStatusCode: error instanceof Object && 'statusCode' in error ? (error as { statusCode?: number }).statusCode : undefined
            })
          })
        );

        const updatedWorkspace = yield* applyFieldMappings(
          oid,
          config.responseFields,
          this.mappingContext(result.data),
          workspaceData
        );

        yield* Effect.tryPromise({
          try: () => RecordsService.updateMeta(brand, oid, updatedWorkspace),
          catch: cause => new WorkspaceUpdateError({ oid, cause })
        }).pipe(
          Effect.withSpan('servicenow.updateWorkspaceMeta', { attributes: { oid } }),
          withIntegrationAudit(oid, ServiceNowAuditAction.workspaceMetadataUpdate, {
            brandId: runContext.brandId,
            triggeredBy: runContext.triggeredBy,
            parent: runContext.parentAudit,
            onSuccess: () => ({ message: 'Workspace metadata updated with ServiceNow identifiers.' })
          })
        );

        return result;
      });
    }

    private concludeSubmit(
      oid: string,
      parentAudit: IntegrationAuditContext | null,
      exit: Exit.Exit<ServiceNowHttpResult, ServiceNowCatalogError>,
      response: TriggerResponse
    ): TriggerResponse {
      if (Exit.isSuccess(exit)) {
        completeCatalogAudit(parentAudit, {
          message: 'ServiceNow catalog request completed.',
          httpStatusCode: exit.value.statusCode,
          responseSummary: isPlainObject(exit.value.data)
            ? exit.value.data
            : { rawResponseBody: exit.value.data }
        });
        this.logger.verbose(`ServiceNow catalog completed request for ${oid}.`);
        return response;
      }

      if (Exit.isInterrupted(exit)) {
        failCatalogAudit(parentAudit, 'interrupted', {
          message: 'ServiceNow catalog request was interrupted during shutdown.'
        });
        return this.fail(response, '503', `ServiceNow catalog request for ${oid} was interrupted during shutdown.`);
      }

      const failure = Cause.failureOption(exit.cause);
      if (failure._tag === 'Some') {
        const error = failure.value;
        const message = errorDescription(error);
        failCatalogAudit(parentAudit, error, { message });
        this.logger.error(`ServiceNow catalog request failed for workspace ${oid} [${error._tag}]: ${message}`);
        return this.fail(response, errorHttpCode(error), message);
      }

      const defect = Cause.squash(exit.cause);
      failCatalogAudit(parentAudit, defect, { message: 'ServiceNow catalog request failed with an unexpected defect.' });
      this.logger.error(`ServiceNow catalog request crashed for workspace ${oid}: ${causeMessage(defect)}`);
      return this.fail(response, '500', `ServiceNow catalog request failed for workspace ${oid}; check the server logs.`);
    }

    private resolveBrand(oid: string, workspaceData: WorkspaceRecord): ResolvedBrand | ServiceNowConfigError {
      const brandId = String(workspaceData.metaMetadata?.brandId ?? '').trim();
      if (!brandId) {
        return new ServiceNowConfigError({
          oid,
          reason: 'Cannot resolve ServiceNow Catalog configuration because the workspace has no brand identifier.',
          httpCode: '400'
        });
      }
      const brandingService = typeof BrandingService === 'undefined' ? undefined : BrandingService;
      if (brandingService == null) {
        return new ServiceNowConfigError({
          oid,
          reason: 'Cannot resolve ServiceNow Catalog configuration because BrandingService is unavailable.'
        });
      }
      const brand = brandingService.getBrandById(brandId);
      if (brand?.name) {
        return { brandId, brandName: String(brand.name), brand };
      }
      return new ServiceNowConfigError({
        oid,
        reason: `Cannot resolve ServiceNow Catalog configuration for unknown brand '${brandId}'.`,
        httpCode: '400'
      });
    }

    /**
     * Configuration precedence: per-trigger options override brand application
     * configuration, which overrides hook-level and model defaults.
     */
    private resolveConfig(brandName: string, options: Record<string, unknown>): ServiceNowCatalogConfigData {
      const defaults = new ServiceNowCatalogAppConfig();
      const sailsConfig = sails.config as unknown as Record<string, unknown> & { brandingAware?: BrandingAwareFn };
      const brandingAware = sailsConfig.brandingAware;
      const hookConfig = sailsConfig[SERVICENOW_CATALOG_CONFIG_KEY];
      let brandConfig: unknown;
      try {
        brandConfig = brandingAware?.(brandName)?.[SERVICENOW_CATALOG_CONFIG_KEY];
      } catch (error) {
        this.logger.warn(`ServiceNow catalog could not load brand configuration for '${brandName}': ${causeMessage(error)}`);
      }
      return mergeConfig(
        mergeConfig(
          mergeConfig({ ...defaults } as ServiceNowCatalogConfigData, hookConfig),
          brandConfig
        ),
        options
      );
    }

    private validateConfig(
      oid: string,
      rdmpOid: string,
      config: ServiceNowCatalogConfigData
    ): ServiceNowConfigError | null {
      const invalid = (reason: string, httpCode = '500') =>
        new ServiceNowConfigError({ oid, reason, httpCode });

      if (!rdmpOid) {
        return invalid('Missing parent RDMP identifier on ServiceNow workspace.', '400');
      }
      if (!isPlainObject(config.connection)) {
        return invalid('Missing ServiceNow Catalog connection configuration.');
      }
      if (!String(config.connection.url ?? '').trim()) {
        return invalid('Missing ServiceNow Catalog URL configuration.');
      }
      try {
        new URL(config.connection.url);
      } catch {
        return invalid('ServiceNow Catalog URL configuration must be an absolute URL.');
      }
      if (!String(config.connection.method ?? '').trim()) {
        return invalid('Missing ServiceNow Catalog HTTP method configuration.');
      }
      if (!Number.isFinite(config.connection.timeoutMs) || config.connection.timeoutMs <= 0) {
        return invalid('ServiceNow Catalog request timeout must be greater than zero.');
      }
      if (!Number.isFinite(config.connection.totalTimeoutMs) || config.connection.totalTimeoutMs <= 0) {
        return invalid('ServiceNow Catalog orchestration timeout must be greater than zero.');
      }
      const retry = config.connection.retry;
      if (!isPlainObject(retry)
        || !Number.isInteger(retry.maxAttempts)
        || retry.maxAttempts < 1
        || !Number.isFinite(retry.baseDelayMs)
        || retry.baseDelayMs < 0
        || !Number.isFinite(retry.maxDelayMs)
        || retry.maxDelayMs < 0
        || !Array.isArray(retry.retryOnStatusCodes)
        || retry.retryOnStatusCodes.some(status => !Number.isInteger(status))) {
        return invalid('ServiceNow Catalog retry configuration is invalid.');
      }
      if (!Array.isArray(config.requestFields) || !Array.isArray(config.responseFields)) {
        return invalid('ServiceNow Catalog request and response field mappings must be arrays.');
      }
      for (const mapping of [...config.requestFields, ...config.responseFields]) {
        if (!mapping || !String(mapping.destination ?? '').trim() || !isPlainObject(mapping.source)) {
          return invalid('ServiceNow Catalog field mappings require a destination and source binding.');
        }
        const binding = mapping.source;
        if (binding.kind === 'path' && !String(binding.path ?? '').trim()) {
          return invalid(`Path mapping '${mapping.destination}' requires a source path.`);
        }
        if (binding.kind === 'handlebars' && !String(binding.template ?? '').trim()) {
          return invalid(`Handlebars mapping '${mapping.destination}' requires a template.`);
        }
        if (binding.kind === 'jsonata' && !String(binding.expression ?? '').trim()) {
          return invalid(`JSONata mapping '${mapping.destination}' requires an expression.`);
        }
        if (!['path', 'handlebars', 'jsonata'].includes(binding.kind)) {
          return invalid(`Mapping '${mapping.destination}' has an unsupported binding type.`);
        }
      }
      if (!isPlainObject(config.oauth)) {
        return invalid('Missing ServiceNow Catalog OAuth configuration.');
      }
      if (config.oauth.enabled) {
        if (!config.oauth.url || !config.oauth.clientId || !config.oauth.clientSecret) {
          return invalid('OAuth is enabled but its URL, client ID, or client secret is missing.');
        }
        try {
          new URL(config.oauth.url);
        } catch {
          return invalid('ServiceNow OAuth URL configuration must be an absolute URL.');
        }
      }
      return null;
    }

    private mappingContext(source: unknown): unknown {
      if (isPlainObject(source)) {
        return {
          ...source,
          translationService: typeof TranslationService === 'undefined' ? undefined : TranslationService
        };
      }
      return source;
    }

    private registerOutcomeMapper(): void {
      if (!registerServiceNowOutcomeMapper()) {
        this.logger.warn('ServiceNow catalog: IntegrationAuditService outcome mapper registration was unavailable.');
      }
    }

    private interruptInFlight(): void {
      if (this.inFlight.size === 0) {
        return;
      }
      this.logger.warn(`ServiceNow catalog interrupting ${this.inFlight.size} in-flight submission(s) for shutdown.`);
      const fibers = [...this.inFlight];
      this.inFlight.clear();
      Effect.runFork(Effect.forEach(fibers, fiber => Fiber.interrupt(fiber), { discard: true }));
    }

    private fail(response: TriggerResponse, code: string, message: string): TriggerResponse {
      this.logger.error(message);
      response.code = code;
      response.status = false;
      response.success = false;
      response.message = message;
      return response;
    }
  }
}

export type ServicenowCatalogService = ReturnType<Services.ServicenowCatalog['exports']>;
export const ServicenowCatalogService: ServicenowCatalogService = new Services.ServicenowCatalog().exports();

module.exports = ServicenowCatalogService;
